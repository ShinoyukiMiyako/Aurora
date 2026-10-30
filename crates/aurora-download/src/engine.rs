//! 单文件下载引擎：探测、分块/单流下载、断点续传、合并、校验、退避重试与换源。
//!
//! [`Downloader::download`] 的一次调用完整覆盖：
//! 1. 若目标已存在且 sha1/大小校验通过则直接跳过（可重入、幂等安装）。
//! 2. 把官方 URL 经 [`SourcePlan`] 展开为候选源列表，已被 [`SourceHealth`] 判定不通的主机沉底，
//!    逐源尝试。
//! 3. 每个源用 [`retry_async`] 做指数退避重试；耗尽后切换下一个源（即「n 次后切换镜像」），
//!    成败记回健康表，后面的文件不再为同一个坏源重复付出整轮重试。
//! 4. 已知大小且达阈值的大文件走 Range 分块并发下载：先用 [`probe_final_url`] 把跳转解到终点，
//!    再对终点地址发 Range，分片落 `.petalfall-partN`；网络中断保留已完成分片供下次断点续传，
//!    损坏（哈希不符）则清分片重下；没有 sha1 的任务换源前先清掉本源残留分片。
//! 5. 分片路径在某个源上彻底失败后自动回退为整文件单请求，宁可失去并行加速也要把文件装上。
//! 6. 合并到同目录临时文件，校验大小与 sha1，最后原子 rename 覆盖目标。
//!
//! 取消是协作式的：令牌只在文件开始前、网络等待点（发请求、读响应体）与退避等待里被观察，
//! 观察到就让当前尝试正常返回 [`Error::Cancelled`]，再由 [`Downloader::run`] 统一清掉该文件的
//! 临时文件与分片。不在落盘中途丢弃 future，否则进行中的阻塞文件操作会在清理之后才落地。

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use aurora_base::retry::{RetryPolicy, retry_async, retry_async_until};
use tokio::io::AsyncWriteExt;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use crate::chunk::{Chunk, ChunkConfig, ChunkPlan};
use crate::error::{Error, Result};
use crate::health::{SourceHealth, is_host_fault};
use crate::progress::ProgressReporter;
use crate::source::SourcePlan;
use crate::task::DownloadTask;

/// 下载引擎的运行参数。
#[derive(Clone, Default)]
pub struct DownloadConfig {
    /// 分块下载参数。
    pub chunk: ChunkConfig,
    /// 单个源上的退避重试策略；其 `max_attempts` 即「切换镜像前在同一源上的尝试次数」。
    pub retry: RetryPolicy,
    /// 下载源优先级方案。
    pub sources: SourcePlan,
}

/// 单文件下载引擎。可廉价克隆（内部 `reqwest::Client` 与配置均为 `Arc` 共享），供并发池分发。
#[derive(Clone)]
pub struct Downloader {
    client: reqwest::Client,
    config: Arc<DownloadConfig>,
    /// 跨任务共享的源健康表：克隆出的引擎共用同一份，一个文件学到的教训整批受用。
    health: Arc<SourceHealth>,
}

impl Downloader {
    /// 用给定客户端与配置构造。客户端应由 [`aurora_base::http::build_client`] 统一构建。
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
            config: Arc::new(config),
            health,
        }
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
        if self.already_complete(task).await? {
            tracing::debug!(dest = %task.dest.display(), "目标文件已存在且校验通过，跳过下载");
            return Ok(());
        }

        // 已被判定不通的主机沉底再试：几千个小文件时，每个文件各自重新发现「这个源不通」的
        // 重试与退避能浪费十几分钟。
        let candidates = self
            .health
            .prioritize(self.config.sources.candidates(&task.url)?);
        let mut last_err: Option<Error> = None;
        for (index, url) in candidates.iter().enumerate() {
            match self.fetch_from(url, task, progress, cancel).await {
                Ok(()) => {
                    self.health.record_success(url);
                    return Ok(());
                }
                Err(Error::Cancelled) => {
                    // 尝试已完整返回，此刻没有进行中的文件操作，清理不会与落盘赛跑。
                    // 取消是调用方的决定，不说明源的好坏，不记账。
                    self.discard_leftovers(task).await;
                    return Err(Error::Cancelled);
                }
                Err(err) => {
                    // 4xx 只说明「这个源没有这个文件」，换源即可，不能记在主机头上。
                    self.health
                        .record_failure(url, is_host_fault(err.http_status()));
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
                        error = %err,
                        "该下载源尝试耗尽，切换下一个源"
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
    async fn fetch_from(
        &self,
        url: &str,
        task: &DownloadTask,
        progress: Option<&ProgressReporter>,
        cancel: Option<&CancellationToken>,
    ) -> Result<()> {
        let transfer = transfer_for(&self.config.chunk, url, task.size);
        if transfer == Transfer::Whole {
            return self.retry_on(url, task, progress, cancel, transfer).await;
        }
        let chunk_err = match self.retry_on(url, task, progress, cancel, transfer).await {
            Ok(()) => return Ok(()),
            Err(err) if err.is_cancelled() => return Err(err),
            Err(err) => err,
        };
        tracing::info!(
            file = %task.dest.display(),
            %url,
            error = %chunk_err,
            "分片路径失败，回退整文件单请求重下"
        );
        match self
            .retry_on(url, task, progress, cancel, Transfer::Whole)
            .await
        {
            Ok(()) => {
                // 分片路径已放弃，残留分片不会再被续传复用，留着只是长期占盘。
                self.remove_parts(task).await;
                Ok(())
            }
            Err(err) if err.is_cancelled() => Err(err),
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
        progress: Option<&ProgressReporter>,
        cancel: Option<&CancellationToken>,
        transfer: Transfer,
    ) -> Result<()> {
        let attempt = || self.attempt(url, task, progress, cancel, transfer);
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
    async fn attempt(
        &self,
        url: &str,
        task: &DownloadTask,
        progress: Option<&ProgressReporter>,
        cancel: Option<&CancellationToken>,
        transfer: Transfer,
    ) -> Result<()> {
        if cancel.is_some_and(CancellationToken::is_cancelled) {
            return Err(Error::Cancelled);
        }
        if let Some(parent) = task.dest.parent()
            && !parent.as_os_str().is_empty()
        {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|source| io_error(parent, source))?;
        }

        let temp = temp_path(&task.dest);
        let parts = match transfer {
            Transfer::Chunked { total } => {
                self.download_chunked(url, task, total, &temp, progress, cancel)
                    .await?
            }
            Transfer::Whole => {
                self.download_stream(url, &temp, progress, cancel).await?;
                Vec::new()
            }
        };

        self.finalize(&temp, task, &parts).await
    }

    /// 单流下载：一次 GET 流式落到临时文件。用于小文件或大小未知的文件。
    async fn download_stream(
        &self,
        url: &str,
        temp: &Path,
        progress: Option<&ProgressReporter>,
        cancel: Option<&CancellationToken>,
    ) -> Result<()> {
        let resp = until_cancelled(cancel, self.client.get(url).send())
            .await?
            .map_err(|source| Error::Request {
                url: url.to_owned(),
                source,
            })?;
        let status = resp.status();
        if !status.is_success() {
            return Err(Error::Status {
                url: url.to_owned(),
                status: status.as_u16(),
            });
        }
        if let Err(err) = stream_to_file(resp, temp, progress, cancel).await {
            // 单流不做续传，失败即清掉半截临时文件，下次从头再来。
            let _ = tokio::fs::remove_file(temp).await;
            return Err(err);
        }
        Ok(())
    }

    /// 分块下载的入口：先把跳转解干净，再对最终地址发 Range，失败按阶段落日志。
    async fn download_chunked(
        &self,
        url: &str,
        task: &DownloadTask,
        total: u64,
        temp: &Path,
        progress: Option<&ProgressReporter>,
        cancel: Option<&CancellationToken>,
    ) -> Result<Vec<PathBuf>> {
        let final_url = match probe_final_url(&self.client, url, cancel).await {
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

        let result = self
            .fetch_chunks(&final_url, task, total, temp, progress, cancel)
            .await;
        if let Err(err) = &result
            && !err.is_cancelled()
        {
            tracing::warn!(
                stage = "chunk",
                file = %task.dest.display(),
                %url,
                %final_url,
                http_status = ?err.http_status(),
                error = %err,
                "分片下载失败"
            );
        }
        result
    }

    /// 分块并发下载。返回本次涉及的分片文件列表（供合并后清理）；整体返回时临时文件已是完整合并结果。
    ///
    /// `url` 必须是 [`probe_final_url`] 解出的最终地址：所有 Range 请求都直接打在源站上，
    /// 不再经过任何跳转。
    async fn fetch_chunks(
        &self,
        url: &str,
        task: &DownloadTask,
        total: u64,
        temp: &Path,
        progress: Option<&ProgressReporter>,
        cancel: Option<&CancellationToken>,
    ) -> Result<Vec<PathBuf>> {
        let plan = ChunkPlan::compute(
            total,
            self.config.chunk.chunk_size,
            self.config.chunk.max_chunks,
        );
        let first = plan.chunks[0];

        // 首块兼任「探测该源是否支持 Range」之责。
        let resp0 = ranged_get(&self.client, url, first.start, first.end, cancel).await?;
        if resp0.status() == reqwest::StatusCode::OK {
            // 服务器忽略了 Range、返回整体 200：此响应即完整文件，直接落到合并临时文件。
            if let Err(err) = stream_to_file(resp0, temp, progress, cancel).await {
                let _ = tokio::fs::remove_file(temp).await;
                return Err(err);
            }
            return Ok(Vec::new());
        }

        // 206：写首片。首片每次尝试都重下（一个块尺寸，代价可忽略），确保 Range 支持性判定可靠。
        let part0 = part_path(&task.dest, first.index);
        let written0 = stream_to_file(resp0, &part0, progress, cancel).await?;
        if written0 != first.byte_len() {
            let _ = tokio::fs::remove_file(&part0).await;
            return Err(Error::IncompleteBody {
                url: url.to_owned(),
                expected: first.byte_len(),
                actual: written0,
            });
        }

        // 其余分片并发下载，已完成的分片（尺寸吻合）跳过——这是断点续传的落点。
        let semaphore = Arc::new(Semaphore::new(self.config.chunk.chunk_concurrency.max(1)));
        let owned_progress = progress.cloned();
        let owned_cancel = cancel.cloned();
        let mut set: JoinSet<Result<()>> = JoinSet::new();
        let mut first_err: Option<Error> = None;
        for chunk in plan.chunks.iter().skip(1).copied() {
            let part = part_path(&task.dest, chunk.index);
            if part_complete(&part, chunk.byte_len()).await {
                continue;
            }
            // 信号量从不关闭；真关了也不能直接返回，已派出的分片要等它们写完再交给外层清理。
            let Ok(permit) = semaphore.clone().acquire_owned().await else {
                first_err = Some(Error::Internal {
                    what: "分块信号量已关闭",
                });
                break;
            };
            let client = self.client.clone();
            let url = url.to_owned();
            let prog = owned_progress.clone();
            let token = owned_cancel.clone();
            set.spawn(async move {
                let _permit = permit;
                download_one_chunk(&client, &url, chunk, &part, prog.as_ref(), token.as_ref()).await
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

        concat_parts(&plan, &task.dest, temp).await?;
        Ok(plan
            .chunks
            .iter()
            .map(|chunk| part_path(&task.dest, chunk.index))
            .collect())
    }

    /// 合并后校验并原子落位。大小/哈希不符视为损坏：清掉临时文件与分片，让外层重下。
    async fn finalize(&self, temp: &Path, task: &DownloadTask, parts: &[PathBuf]) -> Result<()> {
        if let Some(expected) = task.size {
            let meta = tokio::fs::metadata(temp)
                .await
                .map_err(|source| io_error(temp, source))?;
            if meta.len() != expected {
                cleanup(temp, parts).await;
                return Err(Error::SizeMismatch {
                    url: task.url.clone(),
                    expected,
                    actual: meta.len(),
                });
            }
        }
        if let Some(sha1) = &task.sha1
            && let Err(err) = aurora_base::fs::verify_sha1(temp, sha1).await
        {
            // 哈希不符 -> 分片产出了错误内容，必须删除分片，否则续传会一直复用坏数据。
            cleanup(temp, parts).await;
            return Err(err.into());
        }
        tokio::fs::rename(temp, &task.dest)
            .await
            .map_err(|source| io_error(&task.dest, source))?;
        for part in parts {
            let _ = tokio::fs::remove_file(part).await;
        }
        Ok(())
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

    /// 目标是否已存在且满足完整性契约（有 sha1 校 sha1，否则有大小校大小，都没有则不认为完整）。
    async fn already_complete(&self, task: &DownloadTask) -> Result<bool> {
        match tokio::fs::metadata(&task.dest).await {
            Ok(meta) => {
                if let Some(sha1) = &task.sha1 {
                    match aurora_base::fs::verify_sha1(&task.dest, sha1).await {
                        Ok(()) => Ok(true),
                        Err(aurora_base::Error::HashMismatch { .. }) => Ok(false),
                        Err(err) => Err(err.into()),
                    }
                } else if let Some(size) = task.size {
                    Ok(meta.len() == size)
                } else {
                    Ok(false)
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(source) => Err(io_error(&task.dest, source)),
        }
    }
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
    client: &reqwest::Client,
    url: &str,
    cancel: Option<&CancellationToken>,
) -> Result<String> {
    let resp = until_cancelled(cancel, client.get(url).send())
        .await?
        .map_err(|source| Error::Request {
            url: url.to_owned(),
            source,
        })?;
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
    client: &reqwest::Client,
    url: &str,
    start: u64,
    end: u64,
    cancel: Option<&CancellationToken>,
) -> Result<reqwest::Response> {
    let value = format!("bytes={start}-{end}");
    let send = client.get(url).header(reqwest::header::RANGE, value).send();
    let resp = until_cancelled(cancel, send)
        .await?
        .map_err(|source| Error::Request {
            url: url.to_owned(),
            source,
        })?;
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

/// 下载单个非首分片到其分片文件，并校验落盘字节数与区间长度一致。
async fn download_one_chunk(
    client: &reqwest::Client,
    url: &str,
    chunk: Chunk,
    part: &Path,
    progress: Option<&ProgressReporter>,
    cancel: Option<&CancellationToken>,
) -> Result<()> {
    let resp = ranged_get(client, url, chunk.start, chunk.end, cancel).await?;
    if resp.status() != reqwest::StatusCode::PARTIAL_CONTENT {
        // 非零起始的分片却收到 200，意味着该源不支持 Range：上抛以触发换源，而非把整文件塞进某一分片。
        return Err(Error::RangeUnsupported {
            url: url.to_owned(),
        });
    }
    let written = stream_to_file(resp, part, progress, cancel).await?;
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

/// 流式把响应体写入文件（覆盖），逐段累加进度，写完 fsync。返回写入字节数。
///
/// 取消只在读下一段响应体时观察：写盘那一步总是完整等完，返回 [`Error::Cancelled`] 时
/// 文件句柄随之关闭，半截文件交给 [`Downloader::run`] 统一清理。
async fn stream_to_file(
    mut resp: reqwest::Response,
    path: &Path,
    progress: Option<&ProgressReporter>,
    cancel: Option<&CancellationToken>,
) -> Result<u64> {
    let url = resp.url().as_str().to_owned();
    let mut file = tokio::fs::File::create(path)
        .await
        .map_err(|source| io_error(path, source))?;
    let mut written = 0u64;
    loop {
        match until_cancelled(cancel, resp.chunk()).await? {
            Ok(Some(bytes)) => {
                file.write_all(&bytes)
                    .await
                    .map_err(|source| io_error(path, source))?;
                written += bytes.len() as u64;
                if let Some(reporter) = progress {
                    reporter.add_bytes(bytes.len() as u64);
                }
            }
            Ok(None) => break,
            Err(source) => return Err(Error::Request { url, source }),
        }
    }
    file.sync_all()
        .await
        .map_err(|source| io_error(path, source))?;
    Ok(written)
}

/// 按序号顺序把分片拼接进合并临时文件，写完 fsync。
async fn concat_parts(plan: &ChunkPlan, dest: &Path, temp: &Path) -> Result<()> {
    let mut out = tokio::fs::File::create(temp)
        .await
        .map_err(|source| io_error(temp, source))?;
    for chunk in &plan.chunks {
        let part = part_path(dest, chunk.index);
        let mut input = tokio::fs::File::open(&part)
            .await
            .map_err(|source| io_error(&part, source))?;
        tokio::io::copy(&mut input, &mut out)
            .await
            .map_err(|source| io_error(&part, source))?;
    }
    out.sync_all()
        .await
        .map_err(|source| io_error(temp, source))?;
    Ok(())
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
    Error::Base(aurora_base::Error::Io {
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
    append_suffix(dest, concat!(".", aurora_base::app_slug!(), "-tmp"))
}

/// 分片文件路径：`<dest>.petalfall-partN`（确定性命名，供断点续传定位）。
fn part_path(dest: &Path, index: usize) -> PathBuf {
    append_suffix(
        dest,
        &format!(".{}-part{index}", aurora_base::brand::APP_SLUG),
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
