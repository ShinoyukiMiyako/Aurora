//! 单文件下载引擎：探测、分块/单流下载、断点续传、合并、校验、退避重试与换源。
//!
//! [`Downloader::download`] 的一次调用完整覆盖：
//! 1. 若目标已存在且大小、sha1 校验通过则直接跳过（可重入、幂等安装）；大小不符时不再算哈希。
//! 2. 把官方 URL 经 [`SourcePlan`] 展开为候选源列表，已被 [`SourceHealth`] 判定不通的主机沉底，
//!    逐源尝试。
//! 3. 每个源用 [`retry_async`] 做指数退避重试；耗尽后切换下一个源（即「n 次后切换镜像」），
//!    成败记回健康表，后面的文件不再为同一个坏源重复付出整轮重试。
//! 4. 已知大小且达阈值的大文件走 Range 分块并发下载：先用 [`probe_final_url`] 把跳转解到终点，
//!    再对终点地址发 Range，分片落 `.petalfall-partN`；网络中断保留已完成分片供下次断点续传，
//!    损坏（哈希不符）则清分片重下；没有 sha1 的任务换源前先清掉本源残留分片。
//! 5. 分片路径在某个源上彻底失败后自动回退为整文件单请求，宁可失去并行加速也要把文件装上。
//! 6. 合并到同目录临时文件，校验大小与 sha1，最后原子 rename 覆盖目标。sha1 在写盘的同时算好，
//!    不把刚写完的文件再读一遍；落盘是否 fsync 见 [`Landing`]。
//! 7. 大文件的网络传输段由吞吐看门狗盯着（见 [`crate::watchdog`]）：终点慢到窗口平均低于阈值、
//!    且不是带宽被大家分走，就向原地址重新取一个终点，已完整的分片保留、只续传没下完的；取不到
//!    新终点或这个源的换终点额度用完即换源；已是最后一个源时关掉看门狗在当前终点上续传，后面的源
//!    都失败时回到先前判慢的源关掉看门狗下完，慢也装上。合并、校验、落位不计时。
//!
//! 同一个目标路径的下载在进程内串行（[`lock_dest`]）：两次安装同时落同一个共享文件时，后到的一方
//! 等前一方落位后再做第 1 步，通常直接跳过。
//!
//! 取消是协作式的：令牌只在文件开始前、网络等待点（发请求、读响应体）与退避等待里被观察，
//! 观察到就让当前尝试正常返回 [`Error::Cancelled`]，再由 [`Downloader::run`] 统一清掉该文件的
//! 临时文件与分片。不在落盘中途丢弃 future，否则进行中的阻塞文件操作会在清理之后才落地。
//!
//! 带凭据的任务（[`DownloadTask::credential`]）换用不自动跳转的客户端，跳转由引擎逐跳跟随，
//! 每一跳各自按凭据作用域决定带不带头（见 [`follow_redirects`]）；带了凭据的那一跳回 401 时，
//! 不重试、不换源、不回退整文件，直接以 [`Error::CredentialRejected`] 结束。

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use petalfall_base::PathLocks;
use petalfall_base::fs::Sha1Hasher;
use petalfall_base::retry::{RetryPolicy, retry_async, retry_async_until};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufWriter};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use crate::chunk::{Chunk, ChunkConfig, ChunkPlan};
use crate::credential::DownloadCredential;
use crate::error::{Error, Result};
use crate::health::SourceHealth;
use crate::progress::{FileProgress, ProgressReporter};
use crate::source::SourcePlan;
use crate::task::DownloadTask;
use crate::watchdog::{Armed, Slow, WatchdogConfig};

/// 下载引擎的运行参数。
#[derive(Clone, Default)]
pub struct DownloadConfig {
    /// 分块下载参数。
    pub chunk: ChunkConfig,
    /// 单个源上的退避重试策略；其 `max_attempts` 即「切换镜像前在同一源上的尝试次数」。
    pub retry: RetryPolicy,
    /// 下载源优先级方案。
    pub sources: SourcePlan,
    /// 大文件的吞吐看门狗。
    pub watchdog: WatchdogConfig,
}

/// 单文件下载引擎。可廉价克隆（内部 `reqwest::Client` 与配置均为 `Arc` 共享），供并发池分发。
#[derive(Clone)]
pub struct Downloader {
    client: reqwest::Client,
    /// 不自动跟随跳转的客户端，带凭据的任务全靠它发请求；没装时带凭据的任务直接报错。
    manual_client: Option<reqwest::Client>,
    config: Arc<DownloadConfig>,
    /// 跨任务共享的源健康表：克隆出的引擎共用同一份，一个文件学到的教训整批受用。
    health: Arc<SourceHealth>,
}

impl Downloader {
    /// 用给定客户端与配置构造。客户端应由 [`petalfall_base::http::build_client`] 统一构建。
    pub fn new(client: reqwest::Client, config: DownloadConfig) -> Self {
        Self::with_health(client, config, Arc::new(SourceHealth::new()))
    }

    /// 复用外部的源健康表构造。多个引擎实例（如一次安装里先后装配的几个池）想共享同一份
    /// 「哪个源不通」的结论时用它。
    pub fn with_health(
        client: reqwest::Client,
        config: DownloadConfig,
        health: Arc<SourceHealth>,
    ) -> Self {
        Self {
            client,
            manual_client: None,
            config: Arc::new(config),
            health,
        }
    }

    /// 装上不自动跟随跳转的客户端，应由 [`petalfall_base::http::build_manual_redirect_client`] 构建。
    /// 共享客户端跟随跳转时会把自定义头原样带到下一跳，带凭据的任务因此只能走这个客户端。
    pub fn with_manual_redirect_client(mut self, client: reqwest::Client) -> Self {
        self.manual_client = Some(client);
        self
    }

    /// 只读访问源健康表。
    pub fn health(&self) -> &Arc<SourceHealth> {
        &self.health
    }

    /// 用默认配置构造。
    pub fn with_defaults(client: reqwest::Client) -> Self {
        Self::new(client, DownloadConfig::default())
    }

    /// 只读访问运行参数。
    pub fn config(&self) -> &DownloadConfig {
        &self.config
    }

    /// 下载单个文件（无进度上报）。完成即目标文件已就绪并通过完整性校验。
    pub async fn download(&self, task: &DownloadTask) -> Result<()> {
        self.run(task, None, None).await
    }

    /// 下载单个文件，可选挂接进度累加器与取消令牌。这是引擎的总入口，负责换源编排。
    pub(crate) async fn run(
        &self,
        task: &DownloadTask,
        progress: Option<&ProgressReporter>,
        cancel: Option<&CancellationToken>,
    ) -> Result<()> {
        // 文件粒度的取消检查：还没开始的文件直接放弃，不碰磁盘。
        if cancel.is_some_and(CancellationToken::is_cancelled) {
            return Err(Error::Cancelled);
        }
        // 装配缺陷在碰磁盘、发请求之前就报出来：拖到请求时才发现，会在重试与换源里打转，
        // 还会被记成源的故障。
        self.route_for(task)?;
        let _dest = lock_dest(&task.dest, cancel).await?;
        let file = FileProgress::on_link(progress, self.health.link().clone());
        if let Some(len) = self.already_complete(task).await? {
            tracing::debug!(dest = %task.dest.display(), "目标文件已存在且校验通过，跳过下载");
            // 本就完整的文件也是这一批里已就绪的字节，不计入的话补全类批次的进度会停在 0。
            file.settle(len);
            return Ok(());
        }
        let result = self.fetch(task, &file, cancel).await;
        // 落定该文件对进度的贡献：成功按实际大小，失败（含取消）清零。
        match &result {
            Ok(len) => file.settle(*len),
            Err(_) => file.settle(0),
        }
        result.map(|_| ())
    }

    /// 逐源下载，返回落盘文件的实际大小。
    async fn fetch(
        &self,
        task: &DownloadTask,
        file: &FileProgress,
        cancel: Option<&CancellationToken>,
    ) -> Result<u64> {
        // 已被判定不通的主机沉底再试：几千个小文件时，每个文件各自重新发现「这个源不通」的
        // 重试与退避能浪费十几分钟。
        let candidates = self
            .health
            .prioritize(self.config.sources.candidates(&task.url)?);
        let mut last_err: Option<Error> = None;
        // 第一个因为慢而让给后面的源。后面的源若全都失败（镜像还没同步到的新文件回 404 就是这样），
        // 它是唯一真在送数据的源，要回到它关掉看门狗下完：慢也比装不上强。
        let mut slow_left: Option<&String> = None;
        for (index, url) in candidates.iter().enumerate() {
            // 换终点额度按源计：重试与分片回退都还是这个源，各记各的话一回退就清零，
            // 一个源上要白等多少个窗口就没了准数。
            let switches = AtomicU32::new(0);
            let mut outcome = self
                .fetch_from(url, task, file, cancel, Watch::On(&switches))
                .await;
            if index + 1 == candidates.len() && matches!(outcome, Err(Error::SlowEndpoint { .. })) {
                // 没有别的源可换了：慢也比装不上强。不记失败，已完整的分片在续传里复用。
                tracing::warn!(
                    file = %task.dest.display(),
                    %url,
                    "已是最后一个下载源，关掉看门狗在当前终点上续传"
                );
                outcome = self.fetch_from(url, task, file, cancel, Watch::Off).await;
            }
            match outcome {
                Ok(len) => {
                    self.health.record_success(url);
                    return Ok(len);
                }
                Err(Error::Cancelled) => {
                    // 尝试已完整返回，此刻没有进行中的文件操作，清理不会与落盘赛跑。
                    // 取消是调用方的决定，不说明源的好坏，不记账。
                    self.discard_leftovers(task).await;
                    return Err(Error::Cancelled);
                }
                Err(err @ Error::CredentialRejected { .. }) => {
                    // 密钥失效只能由用户换密钥解决：换源只会把这条明确的结论淹没在「所有源均失败」里。
                    // 这也不是源的毛病，不记健康账。
                    tracing::warn!(
                        source_index = index,
                        file = %task.dest.display(),
                        %url,
                        error = %err,
                        "下载密钥被拒，不再尝试其余下载源"
                    );
                    return Err(err);
                }
                Err(err) => {
                    if slow_left.is_none() && matches!(err, Error::SlowEndpoint { .. }) {
                        slow_left = Some(url);
                    }
                    // 4xx 只说明「这个源没有这个文件」，换源即可，不能记在主机头上；
                    // 链路带不动同样怪不到主机，见 [`Error::is_host_fault`]。
                    self.health.record_failure(url, err.is_host_fault());
                    // 换源前的分片纪律：分片只按「字节数吻合」判定已完成，与是哪个源写的无关。
                    // 带 sha1 的任务即使跨源拼出坏文件也会在 finalize 被抓住并连分片一起清掉；
                    // 没有 sha1 的任务只校验总大小，那层兜底不存在，必须在换源前清掉本源残留的
                    // 分片，否则下一个源会把上一个源写的字节当成已完成直接拼进去。
                    // 只在还有下一个源时清：最后一个源上留着分片，是给下次重跑用的断点。
                    if task.sha1.is_none() && index + 1 < candidates.len() {
                        self.remove_parts(task).await;
                    }
                    tracing::warn!(
                        source_index = index,
                        file = %task.dest.display(),
                        %url,
                        http_status = ?err.http_status(),
                        host_fault = err.is_host_fault(),
                        error = %err,
                        "该下载源尝试耗尽，切换下一个源"
                    );
                    last_err = Some(err);
                }
            }
        }
        // 最后一个源判慢时已在循环里关掉看门狗续传过，留在这里的只可能是更早的源。
        if let Some(url) = slow_left {
            tracing::warn!(
                file = %task.dest.display(),
                %url,
                "其余下载源都失败，回到慢的那个源关掉看门狗下完"
            );
            // 同换源前的分片纪律：没有 sha1 兜底时，最后一个源留下的分片不能拼进这个源的文件。
            if task.sha1.is_none() {
                self.remove_parts(task).await;
            }
            match self.fetch_from(url, task, file, cancel, Watch::Off).await {
                Ok(len) => {
                    self.health.record_success(url);
                    return Ok(len);
                }
                Err(Error::Cancelled) => {
                    self.discard_leftovers(task).await;
                    return Err(Error::Cancelled);
                }
                Err(err @ Error::CredentialRejected { .. }) => return Err(err),
                Err(err) => {
                    self.health.record_failure(url, err.is_host_fault());
                    tracing::warn!(
                        file = %task.dest.display(),
                        %url,
                        http_status = ?err.http_status(),
                        error = %err,
                        "回到慢源关掉看门狗后仍失败"
                    );
                    last_err = Some(err);
                }
            }
        }
        // 候选列表由 SourcePlan::candidates 保证非空，走到这里说明那条保证被破坏了。
        let last = last_err.ok_or(Error::Internal {
            what: "候选下载源列表为空",
        })?;
        Err(Error::AllSourcesExhausted {
            url: task.url.clone(),
            last: Box::new(last),
        })
    }

    /// 在一个源上完成下载。分片路径在本源上彻底失败时，退回整文件单请求再试一轮：分片依赖
    /// Range，而 Range 恰是最容易被 CDN 前端搞坏的一环（见 [`probe_final_url`]），宁可失去并行
    /// 加速，也不能因此判定文件装不上。
    ///
    /// 慢终点不走这条回退：整文件回退是给 Range 故障的，换成单请求照样打在慢终点上。
    async fn fetch_from(
        &self,
        url: &str,
        task: &DownloadTask,
        file: &FileProgress,
        cancel: Option<&CancellationToken>,
        watch: Watch<'_>,
    ) -> Result<u64> {
        let transfer = transfer_for(&self.config.chunk, url, task.size);
        if transfer == Transfer::Whole {
            return self
                .retry_on(url, task, file, cancel, transfer, watch)
                .await;
        }
        let chunk_err = match self
            .retry_on(url, task, file, cancel, transfer, watch)
            .await
        {
            Ok(len) => return Ok(len),
            Err(err) if ends_the_download(&err) || matches!(err, Error::SlowEndpoint { .. }) => {
                return Err(err);
            }
            Err(err) => err,
        };
        tracing::info!(
            file = %task.dest.display(),
            %url,
            error = %chunk_err,
            "分片路径失败，回退整文件单请求重下"
        );
        match self
            .retry_on(url, task, file, cancel, Transfer::Whole, watch)
            .await
        {
            Ok(len) => {
                // 分片路径已放弃，残留分片不会再被续传复用，留着只是长期占盘。
                self.remove_parts(task).await;
                Ok(len)
            }
            // 回退阶段判慢要原样交给换源编排：包进双失败里，最后一个源就认不出该关看门狗续传了。
            // 分片阶段为什么失败已在上面那条日志里。
            Err(err) if ends_the_download(&err) || matches!(err, Error::SlowEndpoint { .. }) => {
                Err(err)
            }
            Err(fallback_err) => {
                tracing::warn!(
                    stage = "fallback",
                    file = %task.dest.display(),
                    %url,
                    http_status = ?fallback_err.http_status(),
                    // 两个阶段的拒绝理由往往不同（典型是分片 404、回退 503），单列一格免得看丢。
                    chunked_status = ?chunk_err.http_status(),
                    error = %fallback_err,
                    "整文件回退同样失败"
                );
                Err(Error::ChunkedFallbackFailed {
                    url: url.to_owned(),
                    chunked: Box::new(chunk_err),
                    fallback: Box::new(fallback_err),
                })
            }
        }
    }

    /// 在一个源上按指定传输方式做指数退避重试：op 每次生成新 future，携带当前源的 URL。
    async fn retry_on(
        &self,
        url: &str,
        task: &DownloadTask,
        file: &FileProgress,
        cancel: Option<&CancellationToken>,
        transfer: Transfer,
        watch: Watch<'_>,
    ) -> Result<u64> {
        let attempt = || self.attempt(url, task, file, cancel, transfer, watch);
        match cancel {
            // 退避等待里观察到取消即视为取消；进行中的尝试自己在网络等待点上响应。
            Some(token) => retry_async_until(&self.config.retry, token.cancelled(), attempt)
                .await
                .unwrap_or(Err(Error::Cancelled)),
            None => retry_async(&self.config.retry, attempt).await,
        }
    }

    /// 针对一个具体 URL 的一次完整下载尝试：下载 -> 合并临时文件 -> 校验 -> 原子落位。
    ///
    /// 传输方式由调用方决定而非此处推导：回退路径要在同一个 URL 上强制走整文件单请求。
    /// 成功时返回落盘文件的实际大小。
    async fn attempt(
        &self,
        url: &str,
        task: &DownloadTask,
        file: &FileProgress,
        cancel: Option<&CancellationToken>,
        transfer: Transfer,
        watch: Watch<'_>,
    ) -> Result<u64> {
        if cancel.is_some_and(CancellationToken::is_cancelled) {
            return Err(Error::Cancelled);
        }
        // 上一次尝试（重试、回退或换源前那一轮）写下的字节都作废：本次复用的分片会重新计入。
        file.reset();
        if let Some(parent) = task.dest.parent()
            && !parent.as_os_str().is_empty()
        {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|source| io_error(parent, source))?;
        }

        // 每次尝试从空摘要开始：上一次尝试喂进去的字节已作废。
        let mut landing = Landing::for_task(task);
        let job = Job {
            task,
            file,
            cancel,
            watchdog: match watch {
                Watch::On(switches) if self.config.watchdog.applies_to(task.size) => {
                    Some(Watched {
                        config: self.config.watchdog,
                        switches,
                    })
                }
                _ => None,
            },
        };
        let assembled = match transfer {
            Transfer::Chunked { total } => {
                self.download_chunked(url, job, total, &mut landing).await?
            }
            Transfer::Whole => Assembled {
                len: self.download_stream(url, job, &mut landing).await?,
                parts: Vec::new(),
            },
        };

        self.finalize(task, assembled, landing).await
    }

    /// 单流下载：一次 GET 流式落到临时文件，返回写入字节数。用于小文件或大小未知的文件。
    ///
    /// 看门狗判慢时向原地址重新取终点，在新终点上从头重下：单流没有续传，半截临时文件已在失败时删掉。
    async fn download_stream<'a>(
        &self,
        url: &str,
        job: Job<'a>,
        landing: &mut Landing<'a>,
    ) -> Result<u64> {
        let temp = temp_path(&job.task.dest);
        let route = self.route_for(job.task)?;
        let durable = landing.durable();
        let mut target = url.to_owned();
        loop {
            let armed = job.arm();
            let net = armed.as_ref().map(Armed::token).or(job.cancel);
            // 跟随跳转之后真正送数据的终点，响应头到了才知道；之前按请求地址算。
            let mut endpoint = target.clone();
            let result: Result<u64> = async {
                let resp = route.get(&target, None, net).await?;
                endpoint = resp.url().as_str().to_owned();
                let status = resp.status();
                if !status.is_success() {
                    return Err(Error::Status {
                        url: target.clone(),
                        status: status.as_u16(),
                    });
                }
                match stream_to_file(resp, &temp, job.file, net, landing.hasher(), durable).await {
                    Ok(len) => Ok(len),
                    Err(err) => {
                        // 单流不做续传，失败即清掉半截临时文件，下次从头再来。
                        let _ = tokio::fs::remove_file(&temp).await;
                        Err(err)
                    }
                }
            }
            .await;
            let fired = armed.and_then(Armed::disarm);
            let err = match result {
                Ok(len) => return Ok(len),
                Err(err) => err,
            };
            if job.user_cancelled() {
                return Err(Error::Cancelled);
            }
            let (Some(verdict), Some(watched)) = (fired, job.watchdog) else {
                return Err(err);
            };
            target = self
                .next_endpoint(url, &endpoint, job, watched, verdict)
                .await?;
            // 新终点上从头重下：摘要与已计入的字节都作废。
            *landing = Landing::for_task(job.task);
            job.file.reset();
        }
    }

    /// 分块下载的入口：先把跳转解干净，再对最终地址发 Range，失败按阶段落日志。
    ///
    /// 看门狗判慢时等在途分片都停下，向原地址重新取终点，在新终点上续传：已完整的分片一律保留，
    /// 只对没下完的发 Range。分片全部收齐才合并，合并不计时：大文件合并的磁盘时间不能被当成慢。
    async fn download_chunked<'a>(
        &self,
        url: &str,
        job: Job<'a>,
        total: u64,
        landing: &mut Landing<'a>,
    ) -> Result<Assembled> {
        let task = job.task;
        let route = self.route_for(task)?;
        let final_url = match probe_final_url(&route, url, job.cancel).await {
            Ok(resolved) => resolved,
            Err(err) => {
                if !err.is_cancelled() {
                    tracing::warn!(
                        stage = "probe",
                        file = %task.dest.display(),
                        %url,
                        http_status = ?err.http_status(),
                        error = %err,
                        "探测最终下载地址失败"
                    );
                }
                return Err(err);
            }
        };
        if final_url != url {
            tracing::debug!(
                file = %task.dest.display(),
                %url,
                %final_url,
                "下载地址存在跳转，分片请求改打最终地址"
            );
        }

        let mut endpoint = final_url;
        let mut resume = false;
        let fetched = loop {
            let armed = job.arm();
            let net = armed.as_ref().map(Armed::token).or(job.cancel);
            let result = self
                .fetch_chunks(&endpoint, job, net, total, landing, resume)
                .await;
            let fired = armed.and_then(Armed::disarm);
            let err = match result {
                Ok(fetched) => break fetched,
                Err(err) => err,
            };
            if job.user_cancelled() {
                return Err(Error::Cancelled);
            }
            if let (Some(verdict), Some(watched)) = (fired, job.watchdog) {
                endpoint = self
                    .next_endpoint(url, &endpoint, job, watched, verdict)
                    .await?;
                resume = true;
                // 在途分片都已停下，此刻退回不会与分片记账赛跑；续传时完整的分片重新计入。
                job.file.reset();
                // 忽略 Range 的整体 200 会边写合并临时文件边算摘要，换终点后两者都作废。
                *landing = Landing::for_task(task);
                remove_if_present(&temp_path(&task.dest)).await;
                continue;
            }
            if !err.is_cancelled() {
                tracing::warn!(
                    stage = "chunk",
                    file = %task.dest.display(),
                    %url,
                    final_url = %endpoint,
                    http_status = ?err.http_status(),
                    error = %err,
                    "分片下载失败"
                );
            }
            return Err(err);
        };

        match fetched {
            Fetched::Whole(len) => Ok(Assembled {
                len,
                parts: Vec::new(),
            }),
            Fetched::Parts(plan) => {
                let temp = temp_path(&task.dest);
                let durable = landing.durable();
                let len = concat_parts(&plan, &task.dest, &temp, landing.hasher(), durable).await?;
                Ok(Assembled {
                    len,
                    parts: plan
                        .chunks
                        .iter()
                        .map(|chunk| part_path(&task.dest, chunk.index))
                        .collect(),
                })
            }
        }
    }

    /// 在一个终点上把分片收齐，不合并。
    ///
    /// `url` 必须是 [`probe_final_url`] 解出的最终地址：所有 Range 请求都直接打在源站上，
    /// 不再经过任何跳转。`cancel` 是网络操作观察的令牌，武装看门狗时是它的子令牌。
    ///
    /// 首次进入时首片每次都重下，兼任 Range 支持探测。`resume`（换终点续传）时首片与其余分片一视同仁：
    /// 完整的跳过，没完整的一律要求 206，新终点支不支持 Range 由它回的第一个 206 证明。
    async fn fetch_chunks(
        &self,
        url: &str,
        job: Job<'_>,
        cancel: Option<&CancellationToken>,
        total: u64,
        landing: &mut Landing<'_>,
        resume: bool,
    ) -> Result<Fetched> {
        let task = job.task;
        let file = job.file;
        let temp = temp_path(&task.dest);
        let durable = landing.durable();
        let plan = ChunkPlan::compute(
            total,
            self.config.chunk.chunk_size,
            self.config.chunk.max_chunks,
        );
        let route = self.route_for(task)?;

        let rest_from = if resume {
            0
        } else {
            let first = plan.chunks[0];
            // 首块兼任「探测该源是否支持 Range」之责。
            let resp0 = ranged_get(&route, url, first.start, first.end, cancel).await?;
            if resp0.status() == reqwest::StatusCode::OK {
                // 服务器忽略了 Range、返回整体 200：此响应即完整文件，直接落到合并临时文件。
                return match stream_to_file(resp0, &temp, file, cancel, landing.hasher(), durable)
                    .await
                {
                    Ok(len) => Ok(Fetched::Whole(len)),
                    Err(err) => {
                        let _ = tokio::fs::remove_file(&temp).await;
                        Err(err)
                    }
                };
            }

            // 206：写首片。首片每次尝试都重下（一个块尺寸，代价可忽略），确保 Range 支持性判定可靠。
            // 分片不算摘要：合并时按序读回来一次性算，乱序到达的分片没法边写边算。
            let part0 = part_path(&task.dest, first.index);
            let written0 = stream_to_file(resp0, &part0, file, cancel, None, durable).await?;
            if written0 != first.byte_len() {
                let _ = tokio::fs::remove_file(&part0).await;
                return Err(Error::IncompleteBody {
                    url: url.to_owned(),
                    expected: first.byte_len(),
                    actual: written0,
                });
            }
            1
        };

        // 其余分片并发下载，已完成的分片（尺寸吻合）跳过——这是断点续传的落点。
        let semaphore = Arc::new(Semaphore::new(self.config.chunk.chunk_concurrency.max(1)));
        let owned_cancel = cancel.cloned();
        let mut set: JoinSet<Result<()>> = JoinSet::new();
        let mut first_err: Option<Error> = None;
        for chunk in plan.chunks.iter().skip(rest_from).copied() {
            let part = part_path(&task.dest, chunk.index);
            if part_complete(&part, chunk.byte_len()).await {
                file.reused(chunk.byte_len());
                continue;
            }
            // 信号量从不关闭；真关了也不能直接返回，已派出的分片要等它们写完再交给外层清理。
            let Ok(permit) = semaphore.clone().acquire_owned().await else {
                first_err = Some(Error::Internal {
                    what: "分块信号量已关闭",
                });
                break;
            };
            let route = route.clone();
            let url = url.to_owned();
            let chunk_file = file.clone();
            let token = owned_cancel.clone();
            set.spawn(async move {
                let _permit = permit;
                download_one_chunk(
                    &route,
                    &url,
                    chunk,
                    &part,
                    &chunk_file,
                    token.as_ref(),
                    durable,
                )
                .await
            });
        }

        while let Some(joined) = set.join_next().await {
            match joined {
                Ok(Ok(())) => {}
                Ok(Err(err)) => {
                    if first_err.is_none() {
                        first_err = Some(err);
                    }
                }
                Err(join) => {
                    if first_err.is_none() {
                        first_err = Some(Error::TaskJoin(join));
                    }
                }
            }
        }
        if let Some(err) = first_err {
            // 网络类失败：保留已完成分片，交由外层重试断点续传，不在此清理。
            return Err(err);
        }
        Ok(Fetched::Parts(plan))
    }

    /// 看门狗判慢后向原地址重新取终点。BMCLAPI 这类分发入口每次请求都可能跳到不同节点，再问一次
    /// 往往就能换到快的；节点地址带签名与过期参数，只在这一次尝试里用，不跨文件留存。
    ///
    /// 换出了新终点就返回它。原地址仍跳回同一个节点（见 [`same_node`]；没有跳转的源就是这样）
    /// 或换终点次数已用尽，返回 [`Error::SlowEndpoint`] 交给换源；重新取终点本身失败，原样返回那个错误。
    async fn next_endpoint(
        &self,
        origin: &str,
        slow: &str,
        job: Job<'_>,
        watched: Watched<'_>,
        verdict: Slow,
    ) -> Result<String> {
        let Watched { config, switches } = watched;
        let Slow {
            bytes_per_sec,
            cause,
        } = verdict;
        let dest = job.task.dest.display();
        let window_secs = config.window.as_secs();
        tracing::warn!(
            file = %dest,
            endpoint = %slow,
            bytes_per_sec,
            window_secs,
            ?cause,
            "下载终点吞吐过低，放弃该终点"
        );
        let slow_endpoint = || Error::SlowEndpoint {
            url: slow.to_owned(),
            bytes_per_sec,
            threshold: config.min_bytes_per_sec,
            window_secs,
            cause,
        };
        let used = switches.load(Ordering::Relaxed);
        if used >= config.max_endpoint_switches {
            tracing::warn!(
                file = %dest,
                url = %origin,
                switches = used,
                "换终点次数已用尽，换下一个下载源"
            );
            return Err(slow_endpoint());
        }
        let route = self.route_for(job.task)?;
        let next = match probe_final_url(&route, origin, job.cancel).await {
            Ok(next) => next,
            Err(err) => {
                if !err.is_cancelled() {
                    tracing::warn!(
                        stage = "probe",
                        file = %dest,
                        url = %origin,
                        http_status = ?err.http_status(),
                        error = %err,
                        "探测最终下载地址失败"
                    );
                }
                return Err(err);
            }
        };
        if same_node(&next, slow) {
            tracing::warn!(
                file = %dest,
                url = %origin,
                endpoint = %slow,
                "原地址没有换出新终点，换下一个下载源"
            );
            return Err(slow_endpoint());
        }
        switches.store(used + 1, Ordering::Relaxed);
        tracing::info!(
            file = %dest,
            from = %slow,
            to = %next,
            switches = used + 1,
            "向原地址重新取到新终点，接着续传"
        );
        Ok(next)
    }

    /// 合并后校验并原子落位，返回文件实际大小。大小/哈希不符视为损坏：清掉临时文件与分片，
    /// 让外层重下。
    async fn finalize(
        &self,
        task: &DownloadTask,
        assembled: Assembled,
        landing: Landing<'_>,
    ) -> Result<u64> {
        let temp = temp_path(&task.dest);
        let Assembled { len, parts } = assembled;
        if let Some(expected) = task.size
            && len != expected
        {
            cleanup(&temp, &parts).await;
            return Err(Error::SizeMismatch {
                url: task.url.clone(),
                expected,
                actual: len,
            });
        }
        if let Err(err) = landing.verify() {
            // 哈希不符 -> 分片产出了错误内容，必须删除分片，否则续传会一直复用坏数据。
            cleanup(&temp, &parts).await;
            return Err(err.into());
        }
        tokio::fs::rename(&temp, &task.dest)
            .await
            .map_err(|source| io_error(&task.dest, source))?;
        for part in &parts {
            let _ = tokio::fs::remove_file(part).await;
        }
        Ok(len)
    }

    /// 取消后清掉该文件的全部中间产物：合并临时文件与按分块计划能推出的所有分片。
    ///
    /// 分片计划由「大小 + 分块配置」确定性算出，无需记账即可定位每个分片；大小未知的任务
    /// 从不走分块，只有临时文件。取消意味着放弃，断点续传用的分片也一并删掉。
    async fn discard_leftovers(&self, task: &DownloadTask) {
        remove_if_present(&temp_path(&task.dest)).await;
        self.remove_parts(task).await;
    }

    /// 删掉该任务按分块计划能推出的全部分片。用于取消、放弃分片路径与换源前的清理。
    async fn remove_parts(&self, task: &DownloadTask) {
        let Some(total) = task.size else {
            return;
        };
        let plan = ChunkPlan::compute(
            total,
            self.config.chunk.chunk_size,
            self.config.chunk.max_chunks,
        );
        for chunk in &plan.chunks {
            remove_if_present(&part_path(&task.dest, chunk.index)).await;
        }
    }

    /// 这个任务的请求怎么发：不带凭据走共享客户端，带凭据走不自动跳转的客户端。
    fn route_for(&self, task: &DownloadTask) -> Result<Route> {
        match &task.credential {
            None => Ok(Route::Auto(self.client.clone())),
            Some(credential) => {
                let client = self.manual_client.clone().ok_or(Error::Internal {
                    what: "带下载凭据的任务需要不自动跳转的客户端",
                })?;
                Ok(Route::Credentialed {
                    client,
                    credential: credential.clone(),
                })
            }
        }
    }

    /// 目标是否已存在且满足完整性契约：声明了大小先比大小，有 sha1 再校 sha1，两者都没有则不认为
    /// 完整。完整时返回文件大小，供进度计入。
    ///
    /// 先比大小是为了省哈希：补全与修复要对成千个已存在的资源对象逐个判定，大小不符的必然不完整，
    /// 不必再把它整份读一遍。
    async fn already_complete(&self, task: &DownloadTask) -> Result<Option<u64>> {
        let len = match tokio::fs::metadata(&task.dest).await {
            Ok(meta) => meta.len(),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(source) => return Err(io_error(&task.dest, source)),
        };
        if task.size.is_some_and(|size| size != len) {
            return Ok(None);
        }
        match &task.sha1 {
            Some(sha1) => match petalfall_base::fs::verify_sha1(&task.dest, sha1).await {
                Ok(()) => Ok(Some(len)),
                Err(petalfall_base::Error::HashMismatch { .. }) => Ok(None),
                Err(err) => Err(err.into()),
            },
            None => Ok(task.size.map(|_| len)),
        }
    }
}

/// 本次调用是否让吞吐看门狗盯着大文件。
#[derive(Debug, Clone, Copy)]
enum Watch<'a> {
    /// 盯着，带上这个源已用掉的换终点次数。用原子量只为让跨 await 的下载 future 能 Send，
    /// 同一个文件的换终点永远一个接一个发生。
    On(&'a AtomicU32),
    /// 已是最后一个源时用：没有别的源可换，慢也得装上。
    Off,
}

/// 看门狗盯着一次尝试时用到的东西。
#[derive(Clone, Copy)]
struct Watched<'a> {
    config: WatchdogConfig,
    switches: &'a AtomicU32,
}

/// 一个文件在一次尝试里不变的几样东西。
#[derive(Clone, Copy)]
struct Job<'a> {
    task: &'a DownloadTask,
    file: &'a FileProgress,
    /// 用户的取消令牌。
    cancel: Option<&'a CancellationToken>,
    /// 本次尝试要武装的看门狗；不盯时为 `None`。
    watchdog: Option<Watched<'a>>,
}

impl Job<'_> {
    /// 为一个终点武装看门狗，每个终点各开一个新窗口；不盯时为 `None`，网络操作直接观察用户令牌。
    fn arm(&self) -> Option<Armed> {
        self.watchdog
            .map(|watched| Armed::arm(watched.config, self.file, self.cancel))
    }

    /// 用户是否已取消。看门狗的令牌是用户令牌的子令牌，两者都会让网络操作返回取消，
    /// 先看这里才分得清是谁停的。
    fn user_cancelled(&self) -> bool {
        self.cancel.is_some_and(CancellationToken::is_cancelled)
    }
}

/// 一个终点上把分片收齐的结果。
enum Fetched {
    /// 服务器忽略 Range 回了整体 200，合并临时文件已是完整文件，值为其字节数。
    Whole(u64),
    /// 各分片都已完整落盘，待合并。
    Parts(ChunkPlan),
}

/// 一次尝试落到临时文件的结果。
struct Assembled {
    /// 临时文件的字节数（写入时计数，不再回头 stat）。
    len: u64,
    /// 本次涉及的分片，落位后清理；整文件路径为空。
    parts: Vec<PathBuf>,
}

/// 一次尝试的落盘约定，由任务有没有 sha1 决定。
///
/// 带 sha1：边写边算摘要，合并后直接比对，不再把刚写完的文件整份读回来；也不 fsync——掉电后
/// 留下的残缺文件会在下次 `already_complete` 的 sha1 校验里被识破并重下，不依赖掉电一致性。
/// 没有 sha1：只能靠大小判定完整，掉电留下「大小对、内容是空洞」的文件识别不出来，必须 fsync。
/// SSD 上实测逐个 fsync 每个小文件多约 0.28 ms，资源对象几千个时累计接近一秒。
struct Landing<'a> {
    sha1: Option<(&'a str, Sha1Hasher)>,
}

impl<'a> Landing<'a> {
    fn for_task(task: &'a DownloadTask) -> Self {
        Self {
            sha1: task
                .sha1
                .as_deref()
                .map(|expected| (expected, Sha1Hasher::new())),
        }
    }

    /// 落盘后是否需要 fsync。
    fn durable(&self) -> bool {
        self.sha1.is_none()
    }

    /// 写入临时文件的字节要喂给的摘要；任务没有 sha1 时为 `None`。
    fn hasher(&mut self) -> Option<&mut Sha1Hasher> {
        self.sha1.as_mut().map(|(_, hasher)| hasher)
    }

    /// 比对摘要；任务没有 sha1 时无可比对。
    fn verify(self) -> petalfall_base::Result<()> {
        match self.sha1 {
            Some((expected, hasher)) => hasher.verify(expected),
            None => Ok(()),
        }
    }
}

/// 两个下载地址是否落在同一个节点上：比协议、主机与端口，不比路径和查询串。
///
/// BMCLAPI 每次跳转都给节点地址签上新的签名与过期时间，同一个节点两次跳出来的完整地址也不一样，
/// 逐字比较认不出「节点没换」，会在同一个慢节点上再白等一个窗口。解析不了的地址只能逐字比。
fn same_node(a: &str, b: &str) -> bool {
    match (reqwest::Url::parse(a), reqwest::Url::parse(b)) {
        (Ok(a), Ok(b)) => a.origin() == b.origin(),
        _ => a == b,
    }
}

/// 换源、回退都救不回来的失败：取消是调用方的决定，密钥被拒只能换密钥。
fn ends_the_download(err: &Error) -> bool {
    err.is_cancelled() || matches!(err, Error::CredentialRejected { .. })
}

/// 带凭据时引擎最多跟随的跳数，与 reqwest 默认跳转策略的上限相同。
const MAX_REDIRECTS: usize = 10;

/// 一个任务的请求怎么发。克隆只是增加引用计数，分片任务各持一份。
#[derive(Clone)]
enum Route {
    /// 共享客户端，跳转由 reqwest 自动跟随。
    Auto(reqwest::Client),
    /// 不自动跳转的客户端加凭据：跳转由引擎逐跳跟随，见 [`follow_redirects`]。
    Credentialed {
        client: reqwest::Client,
        credential: DownloadCredential,
    },
}

impl Route {
    /// 发一次 GET，返回跳转链末端的响应；状态码交给调用方判定。`range` 每一跳都带同一个值。
    async fn get(
        &self,
        url: &str,
        range: Option<&str>,
        cancel: Option<&CancellationToken>,
    ) -> Result<reqwest::Response> {
        match self {
            Route::Auto(client) => {
                let mut request = client.get(url);
                if let Some(range) = range {
                    request = request.header(reqwest::header::RANGE, range);
                }
                until_cancelled(cancel, request.send())
                    .await?
                    .map_err(|source| Error::Request {
                        url: url.to_owned(),
                        source,
                    })
            }
            Route::Credentialed { client, credential } => {
                follow_redirects(client, credential, url, range, cancel).await
            }
        }
    }
}

/// 逐跳跟随跳转：每一跳各自按 `credential` 的作用域决定带不带头，最多跟 [`MAX_REDIRECTS`] 跳。
///
/// 为什么不让客户端自己跟：reqwest 跨主机跳转时只摘掉 Authorization、Cookie 等标准敏感头，
/// 自定义的 `x-api-key` 会被原样带到下一跳。CurseForge 的 edge.forgecdn.net 302 到
/// mediafilez.forgecdn.net，两者都在作用域内；但跳转一旦指向作用域外的主机，密钥就不能跟过去。
///
/// 带了凭据的那一跳回 401，报 [`Error::CredentialRejected`]；没带凭据的那一跳回 401 照常交回调用方，
/// 按普通状态码处理。
async fn follow_redirects(
    client: &reqwest::Client,
    credential: &DownloadCredential,
    url: &str,
    range: Option<&str>,
    cancel: Option<&CancellationToken>,
) -> Result<reqwest::Response> {
    let mut hop = reqwest::Url::parse(url).map_err(|source| {
        Error::Base(petalfall_base::Error::UrlParse {
            url: url.to_owned(),
            source,
        })
    })?;
    let mut followed = 0usize;
    loop {
        let carries = credential.applies_to(&hop);
        let mut request = client.get(hop.clone());
        if carries {
            request = request.header(
                credential.header_name().clone(),
                credential.header_value().clone(),
            );
        }
        if let Some(range) = range {
            request = request.header(reqwest::header::RANGE, range);
        }
        let resp = until_cancelled(cancel, request.send())
            .await?
            .map_err(|source| Error::Request {
                url: hop.as_str().to_owned(),
                source,
            })?;
        let status = resp.status();
        if is_followed_redirect(status) {
            if followed == MAX_REDIRECTS {
                tracing::warn!(%url, last_hop = %hop, "下载跳转超过上限");
                return Err(Error::TooManyRedirects {
                    url: url.to_owned(),
                });
            }
            let next = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .and_then(|location| hop.join(location).ok());
            let Some(next) = next else {
                return Err(Error::Status {
                    url: hop.as_str().to_owned(),
                    status: status.as_u16(),
                });
            };
            tracing::debug!(
                from = %hop,
                to = %next,
                credential_sent = credential.applies_to(&next),
                "逐跳跟随下载跳转"
            );
            hop = next;
            followed += 1;
            continue;
        }
        if carries && status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(Error::CredentialRejected {
                realm: credential.realm(),
                url: hop.as_str().to_owned(),
                status: status.as_u16(),
            });
        }
        return Ok(resp);
    }
}

/// 引擎之外的少量带凭据读取（如整合包摘要按范围读包尾）用的单次 GET：与下载任务同一套逐跳规则，
/// 每一跳按作用域决定带不带密钥，`range` 每一跳都带同一个值，带了密钥的那一跳回 401 报
/// [`Error::CredentialRejected`]。`client` 必须是不自动跳转的客户端
/// （`petalfall_base::http::build_manual_redirect_client`），否则 reqwest 会把密钥原样带到跳转的下一跳。
/// 返回跳转链末端的响应，状态码交给调用方判定。
pub async fn credentialed_get(
    client: &reqwest::Client,
    credential: &DownloadCredential,
    url: &str,
    range: Option<&str>,
) -> Result<reqwest::Response> {
    follow_redirects(client, credential, url, range, None).await
}

/// 引擎替客户端跟随的跳转状态码。300（多选）与 304（未修改）不是跳转到别处的指令，原样交回。
fn is_followed_redirect(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308)
}

/// 在取消令牌下等待一个网络 future：令牌先触发即返回 [`Error::Cancelled`]。
///
/// 只用于发请求、读响应体这类无落盘副作用的等待，丢弃它们不会留下半截文件。
async fn until_cancelled<F: Future>(
    cancel: Option<&CancellationToken>,
    fut: F,
) -> Result<F::Output> {
    match cancel {
        Some(token) => token.run_until_cancelled(fut).await.ok_or(Error::Cancelled),
        None => Ok(fut.await),
    }
}

/// 正在下载或排队的目标路径。表里只留进行中的目标，几千个资源对象下完也不会堆积。
static DESTINATIONS: PathLocks = PathLocks::new();

/// 占住一个目标路径，同一路径上的下载在进程内一个接一个来。
///
/// 临时文件与分片按目标路径确定性命名（断点续传靠它找回分片）。两次安装同时落同一个共享文件——
/// 两个实例同时装同一游戏版本或同一加载器，库与资源对象就是这样——会往同一批临时文件里交错写入，
/// 拼出坏文件，或在改名落位时互相踩踏。等待期间照样响应取消。
async fn lock_dest(
    dest: &Path,
    cancel: Option<&CancellationToken>,
) -> Result<tokio::sync::OwnedMutexGuard<()>> {
    until_cancelled(cancel, DESTINATIONS.slot(dest).lock_owned()).await
}

/// 删除一个可能不存在的中间文件。不存在是常态（该分片还没开始）；其余失败记日志，
/// 不让清理失败盖过本来要返回的结果（已取消、换源、回退成功）。
async fn remove_if_present(path: &Path) {
    match tokio::fs::remove_file(path).await {
        Ok(()) => tracing::debug!(path = %path.display(), "已清理下载中间文件"),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => {
            tracing::warn!(path = %path.display(), error = %err, "清理下载中间文件失败")
        }
    }
}

/// 一次下载尝试的传输方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Transfer {
    /// 整文件单请求。
    Whole,
    /// Range 分片并发，`total` 为声明的文件大小。
    Chunked { total: u64 },
}

/// 该 URL 上的这个任务走哪种传输：分块总开关打开、大小已知且达到拆分阈值、host 不在禁用名单里，
/// 三者齐备才分片。
fn transfer_for(config: &ChunkConfig, url: &str, size: Option<u64>) -> Transfer {
    match size {
        Some(total)
            if config.enabled
                && total >= config.min_split_size
                && !config.is_host_excluded(url) =>
        {
            Transfer::Chunked { total }
        }
        _ => Transfer::Whole,
    }
}

/// 探测最终下载地址：发一次不带 Range 的 GET，跟随重定向后取响应的最终 URL。
///
/// 为什么必须先探测：CurseForge 的 `edge.forgecdn.net` 把请求 302 到真正存放文件的
/// `mediafilez.forgecdn.net`；跟着这条 302 走的 Range 请求会拿到 404，而直接对终点发 Range
/// 却是正常的 206。坏的是「跟随跳转的 Range 请求」这个组合，因此先把跳转解干净、让所有分片
/// 都打在终点上。多一次往返，换来对任何会跳转的 CDN 都成立。
///
/// 为什么探测本身不带 Range：探测的职责是走通跳转链，而 Range 恰是会在跳转上出事的那个头。
/// 若某台 CDN 只对带 Range 的请求跳转，探测解出的就是原地址、分片仍会撞上跳转——那一路由
/// 整文件回退兜住（见 `Downloader::fetch_from`），文件照样装得上。
///
/// 为什么不会把整个文件拉下来：响应体是惰性流，`send()` 返回时只读完了状态行与响应头；
/// 取到最终 URL 后立即丢弃响应，底层传输随之取消。不用 HEAD 是因为部分 CDN 对 HEAD 直接回
/// 403/405，会把好源误判成坏源。
async fn probe_final_url(
    route: &Route,
    url: &str,
    cancel: Option<&CancellationToken>,
) -> Result<String> {
    let resp = route.get(url, None, cancel).await?;
    let status = resp.status();
    let final_url = resp.url().as_str().to_owned();
    drop(resp);
    if !status.is_success() {
        // 报最终地址而非原地址：跳转链末端才是真正拒绝请求的那一台。
        return Err(Error::Status {
            url: final_url,
            status: status.as_u16(),
        });
    }
    Ok(final_url)
}

/// 发起一次 Range 请求。仅放行 206（分块命中）与 200（服务器忽略 Range 的整体响应）两种成功形态。
async fn ranged_get(
    route: &Route,
    url: &str,
    start: u64,
    end: u64,
    cancel: Option<&CancellationToken>,
) -> Result<reqwest::Response> {
    let value = format!("bytes={start}-{end}");
    let resp = route.get(url, Some(&value), cancel).await?;
    let status = resp.status();
    if status == reqwest::StatusCode::PARTIAL_CONTENT || status == reqwest::StatusCode::OK {
        Ok(resp)
    } else {
        Err(Error::Status {
            url: url.to_owned(),
            status: status.as_u16(),
        })
    }
}

/// 下载单个分片到其分片文件（首片只在换终点续传时走这里），并校验落盘字节数与区间长度一致。
async fn download_one_chunk(
    route: &Route,
    url: &str,
    chunk: Chunk,
    part: &Path,
    file: &FileProgress,
    cancel: Option<&CancellationToken>,
    durable: bool,
) -> Result<()> {
    let resp = ranged_get(route, url, chunk.start, chunk.end, cancel).await?;
    if resp.status() != reqwest::StatusCode::PARTIAL_CONTENT {
        // 分片却收到 200，意味着该源不支持 Range：上抛以触发换源，而非把整文件塞进某一分片。
        return Err(Error::RangeUnsupported {
            url: url.to_owned(),
        });
    }
    let written = stream_to_file(resp, part, file, cancel, None, durable).await?;
    if written != chunk.byte_len() {
        let _ = tokio::fs::remove_file(part).await;
        return Err(Error::IncompleteBody {
            url: url.to_owned(),
            expected: chunk.byte_len(),
            actual: written,
        });
    }
    Ok(())
}

/// 每个写入流前面的缓冲。tokio 的 File 每次写都要交给阻塞线程池走一趟，响应体按十几 KiB 一段到达，
/// 不攒一攒的话一个百来 KiB 的资源对象就是十来趟；攒满再写，多数资源对象一趟落盘。
const WRITE_BUFFER: usize = 128 * 1024;

/// 流式把响应体写入文件（覆盖），逐段累加进度；`hasher` 提供时同时喂给摘要，`durable` 时写完 fsync。
/// 返回写入字节数。
///
/// 取消只在读下一段响应体时观察；返回任何错误前都先等在途的写完成，半截文件交给调用方清理时
/// 不会与那次写赛跑。
async fn stream_to_file(
    mut resp: reqwest::Response,
    path: &Path,
    progress: &FileProgress,
    cancel: Option<&CancellationToken>,
    mut hasher: Option<&mut Sha1Hasher>,
    durable: bool,
) -> Result<u64> {
    let url = resp.url().as_str().to_owned();
    let file = tokio::fs::File::create(path)
        .await
        .map_err(|source| io_error(path, source))?;
    let mut writer = BufWriter::with_capacity(WRITE_BUFFER, file);
    let mut written = 0u64;
    let pumped: Result<()> = async {
        // 落盘时的 fsync 不占带宽，这条连接只算到响应体读完。
        let _reading = progress.open_stream();
        loop {
            match until_cancelled(cancel, resp.chunk()).await? {
                Ok(Some(bytes)) => {
                    writer
                        .write_all(&bytes)
                        .await
                        .map_err(|source| io_error(path, source))?;
                    if let Some(hasher) = &mut hasher {
                        hasher.update(&bytes);
                    }
                    written += bytes.len() as u64;
                    progress.transferred(bytes.len() as u64);
                }
                Ok(None) => break,
                Err(source) => {
                    return Err(Error::Request {
                        url: url.clone(),
                        source,
                    });
                }
            }
        }
        flush_all(&mut writer, path).await
    }
    .await;
    if let Err(err) = pumped {
        abandon(writer).await;
        return Err(err);
    }
    if durable {
        sync_to_disk(writer.get_ref(), path).await?;
    }
    Ok(written)
}

/// 按序号顺序把分片拼接进合并临时文件，同时喂给摘要；`durable` 时写完 fsync。返回合并后的字节数。
async fn concat_parts(
    plan: &ChunkPlan,
    dest: &Path,
    temp: &Path,
    mut hasher: Option<&mut Sha1Hasher>,
    durable: bool,
) -> Result<u64> {
    let out = tokio::fs::File::create(temp)
        .await
        .map_err(|source| io_error(temp, source))?;
    let mut writer = BufWriter::with_capacity(WRITE_BUFFER, out);
    let mut buf = vec![0u8; WRITE_BUFFER];
    let mut written = 0u64;
    let copied: Result<()> = async {
        for chunk in &plan.chunks {
            let part = part_path(dest, chunk.index);
            let mut input = tokio::fs::File::open(&part)
                .await
                .map_err(|source| io_error(&part, source))?;
            loop {
                let read = input
                    .read(&mut buf)
                    .await
                    .map_err(|source| io_error(&part, source))?;
                if read == 0 {
                    break;
                }
                writer
                    .write_all(&buf[..read])
                    .await
                    .map_err(|source| io_error(temp, source))?;
                if let Some(hasher) = &mut hasher {
                    hasher.update(&buf[..read]);
                }
                written += read as u64;
            }
        }
        flush_all(&mut writer, temp).await
    }
    .await;
    if let Err(err) = copied {
        abandon(writer).await;
        return Err(err);
    }
    if durable {
        sync_to_disk(writer.get_ref(), temp).await?;
    }
    Ok(written)
}

/// 把缓冲写下去并等在途的写完成。tokio 的 File 把最后一次写的错误推迟到 flush 才报，
/// 不 flush 就关闭会把磁盘写满之类的失败吞掉。
async fn flush_all(writer: &mut BufWriter<tokio::fs::File>, path: &Path) -> Result<()> {
    writer
        .flush()
        .await
        .map_err(|source| io_error(path, source))
}

/// fsync：让 rename 之前数据已真正落盘。
async fn sync_to_disk(file: &tokio::fs::File, path: &Path) -> Result<()> {
    file.sync_all()
        .await
        .map_err(|source| io_error(path, source))
}

/// 放弃写了一半的文件：丢掉缓冲里还没写下去的数据，只等在途的那次写结束。
///
/// tokio 的 File 把写交给阻塞线程池，不等它结束就去删文件，删除会与那次写赛跑。
async fn abandon(writer: BufWriter<tokio::fs::File>) {
    let mut file = writer.into_inner();
    // 文件随即被删除或覆盖，在途写成功与否都不改变结果，这里只需要它结束。
    let _ = file.flush().await;
}

/// 分片是否已完整下载：文件存在且尺寸恰等于该分块应有长度。
async fn part_complete(path: &Path, expected: u64) -> bool {
    matches!(tokio::fs::metadata(path).await, Ok(meta) if meta.len() == expected)
}

/// 删除合并临时文件与全部分片（用于损坏后彻底重下）。
async fn cleanup(temp: &Path, parts: &[PathBuf]) {
    let _ = tokio::fs::remove_file(temp).await;
    for part in parts {
        let _ = tokio::fs::remove_file(part).await;
    }
}

/// 把 IO 错误包成携带路径的 crate 错误。
fn io_error(path: &Path, source: std::io::Error) -> Error {
    Error::Base(petalfall_base::Error::Io {
        path: path.to_owned(),
        source,
    })
}

/// 在目标路径尾部追加后缀，得到同目录的辅助文件路径（保证 rename 同卷原子）。
fn append_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut raw = path.as_os_str().to_os_string();
    raw.push(suffix);
    PathBuf::from(raw)
}

/// 合并临时文件路径：`<dest>.petalfall-tmp`。
fn temp_path(dest: &Path) -> PathBuf {
    append_suffix(dest, concat!(".", petalfall_base::app_slug!(), "-tmp"))
}

/// 分片文件路径：`<dest>.petalfall-partN`（确定性命名，供断点续传定位）。
fn part_path(dest: &Path, index: usize) -> PathBuf {
    append_suffix(
        dest,
        &format!(".{}-part{index}", petalfall_base::brand::APP_SLUG),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 取消后的清理按分块计划推出每个分片：已完成的分片（续传用）与临时文件一并删掉，
    /// 计划之外的同目录文件不受影响。
    #[tokio::test]
    async fn discard_leftovers_removes_temp_and_every_planned_part() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("big.jar");
        let config = DownloadConfig {
            chunk: ChunkConfig {
                enabled: true,
                min_split_size: 10,
                chunk_size: 100,
                max_chunks: 4,
                chunk_concurrency: 2,
                excluded_hosts: Vec::new(),
            },
            ..DownloadConfig::default()
        };
        let downloader = Downloader::new(reqwest::Client::new(), config);
        let task = DownloadTask::new("http://127.0.0.1/big.jar", &dest).with_size(350);
        // 350 字节按 100 一块切成 4 块：part0..part3。
        tokio::fs::write(temp_path(&dest), b"partial")
            .await
            .unwrap();
        for index in [0usize, 1, 3] {
            tokio::fs::write(part_path(&dest, index), b"chunk")
                .await
                .unwrap();
        }
        let bystander = dir.path().join("other.jar");
        tokio::fs::write(&bystander, b"keep").await.unwrap();

        downloader.discard_leftovers(&task).await;

        assert!(!temp_path(&dest).exists());
        for index in 0..4 {
            assert!(!part_path(&dest, index).exists(), "part{index} 应被清理");
        }
        assert_eq!(tokio::fs::read(&bystander).await.unwrap(), b"keep");
    }

    /// 同一目标的下载一个接一个：排在后面的在前一个落位前一直等着，取消照样能让它马上放弃；
    /// 前一个放手后它才拿得到。
    #[tokio::test]
    async fn downloads_of_the_same_destination_take_turns() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("shared.jar");
        let other = dir.path().join("other.jar");
        let held = lock_dest(&dest, None).await.unwrap();

        let token = CancellationToken::new();
        let waiter = {
            let (dest, token) = (dest.clone(), token.clone());
            tokio::spawn(async move { lock_dest(&dest, Some(&token)).await.map(|_| ()) })
        };
        // 别的目标不受影响。
        drop(lock_dest(&other, None).await.unwrap());
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(!waiter.is_finished(), "前一个还没放手时不该拿到");
        token.cancel();
        let err = waiter.await.unwrap().unwrap_err();
        assert!(err.is_cancelled(), "实际：{err:?}");

        let next = {
            let dest = dest.clone();
            tokio::spawn(async move { lock_dest(&dest, None).await.map(|_| ()) })
        };
        drop(held);
        next.await.unwrap().unwrap();
    }

    /// 已取消的令牌在文件开始前就挡住：不发请求、不建任何文件。
    #[tokio::test]
    async fn run_with_cancelled_token_touches_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("never.jar");
        let downloader = Downloader::with_defaults(reqwest::Client::new());
        let task = DownloadTask::new("http://127.0.0.1:9/never.jar", &dest);
        let token = CancellationToken::new();
        token.cancel();

        let err = downloader.run(&task, None, Some(&token)).await.unwrap_err();
        assert!(err.is_cancelled(), "实际：{err:?}");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    /// 完整性判定：大小不符直接判不完整（即便 sha1 对得上，说明没有走到哈希那一步），
    /// 大小对上才看 sha1；只有大小时以大小为准，两者都没有则不认。
    #[tokio::test]
    async fn already_complete_rejects_size_mismatch_before_hashing() {
        const ABC_SHA1: &str = "a9993e364706816aba3e25717850c26c9cd0d89d";
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("abc.bin");
        tokio::fs::write(&dest, b"abc").await.unwrap();
        let downloader = Downloader::with_defaults(reqwest::Client::new());
        let task = |size: Option<u64>, sha1: Option<&str>| {
            let mut task = DownloadTask::new("http://127.0.0.1:9/abc.bin", &dest);
            task.size = size;
            task.sha1 = sha1.map(str::to_owned);
            task
        };
        let check = |task: DownloadTask| {
            let downloader = downloader.clone();
            async move { downloader.already_complete(&task).await.unwrap() }
        };

        assert_eq!(check(task(Some(5), Some(ABC_SHA1))).await, None);
        assert_eq!(check(task(Some(2), None)).await, None);
        assert_eq!(check(task(Some(3), Some(ABC_SHA1))).await, Some(3));
        assert_eq!(check(task(None, Some(ABC_SHA1))).await, Some(3));
        assert_eq!(check(task(Some(3), Some(&"0".repeat(40)))).await, None);
        assert_eq!(check(task(Some(3), None)).await, Some(3));
        assert_eq!(check(task(None, None)).await, None);

        let missing = DownloadTask::new("http://127.0.0.1:9/x", dir.path().join("missing.bin"))
            .with_size(3)
            .with_sha1(ABC_SHA1);
        assert_eq!(check(missing).await, None);
    }

    fn split_config() -> ChunkConfig {
        ChunkConfig {
            enabled: true,
            min_split_size: 1024,
            ..ChunkConfig::default()
        }
    }

    #[test]
    fn chunking_requires_known_size_at_or_above_threshold() {
        let config = split_config();
        let url = "https://edge.forgecdn.net/files/1/2/big.jar";
        assert_eq!(transfer_for(&config, url, None), Transfer::Whole);
        // 差 1 字节到阈值不切；恰好达到阈值就切。
        assert_eq!(transfer_for(&config, url, Some(1023)), Transfer::Whole);
        assert_eq!(
            transfer_for(&config, url, Some(1024)),
            Transfer::Chunked { total: 1024 }
        );
    }

    #[test]
    fn chunking_respects_switch_and_host_exclusion() {
        let disabled = ChunkConfig {
            enabled: false,
            ..split_config()
        };
        assert_eq!(
            transfer_for(&disabled, "https://cdn.modrinth.com/a.jar", Some(1 << 20)),
            Transfer::Whole
        );

        let excluded = ChunkConfig {
            excluded_hosts: vec!["edge.forgecdn.net".into()],
            ..split_config()
        };
        assert_eq!(
            transfer_for(&excluded, "https://edge.forgecdn.net/b.jar", Some(1 << 20)),
            Transfer::Whole
        );
        assert_eq!(
            transfer_for(&excluded, "https://cdn.modrinth.com/a.jar", Some(1 << 20)),
            Transfer::Chunked { total: 1 << 20 }
        );
    }

    #[test]
    fn same_node_compares_scheme_host_and_port_only() {
        let node = "https://bmclapi1.sakura.sld.tw/maven/a.jar?s=first&e=100";
        assert!(
            same_node(
                node,
                "https://bmclapi1.sakura.sld.tw/maven/a.jar?s=second&e=200"
            ),
            "重签的地址仍是同一个节点"
        );
        assert!(
            same_node(node, "https://bmclapi1.sakura.sld.tw:443/other/b.jar"),
            "默认端口写不写都一样，路径不同也是同一个节点"
        );
        assert!(!same_node(
            node,
            "https://bmclapi3.hurtmc.com/maven/a.jar?s=first&e=100"
        ));
        assert!(!same_node(
            node,
            "https://bmclapi1.sakura.sld.tw:4000/maven/a.jar"
        ));
        assert!(!same_node(
            node,
            "http://bmclapi1.sakura.sld.tw/maven/a.jar"
        ));
        assert!(same_node("not a url", "not a url"), "解析不了时逐字比");
        assert!(!same_node("not a url", "not a url?s=2"));
    }

    #[test]
    fn part_and_temp_paths_are_siblings_of_dest() {
        let dest = Path::new("C:/data/lib.jar");
        assert_eq!(
            temp_path(dest),
            PathBuf::from("C:/data/lib.jar.petalfall-tmp")
        );
        assert_eq!(
            part_path(dest, 3),
            PathBuf::from("C:/data/lib.jar.petalfall-part3")
        );
    }
}
