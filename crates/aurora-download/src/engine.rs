//! 单文件下载引擎：探测、分块/单流下载、断点续传、合并、校验、退避重试与换源。
//!
//! [`Downloader::download`] 的一次调用完整覆盖：
//! 1. 若目标已存在且 sha1/大小校验通过则直接跳过（可重入、幂等安装）。
//! 2. 把官方 URL 经 [`SourcePlan`] 展开为候选源列表，已被 [`SourceHealth`] 判定不通的主机沉底，
//!    逐源尝试。
//! 3. 每个源用 [`retry_async`] 做指数退避重试；耗尽后切换下一个源（即「n 次后切换镜像」），
//!    成败记回健康表，后面的文件不再为同一个坏源重复付出整轮重试。
//! 4. 已知大小且达阈值的大文件走 Range 分块并发下载，分片落 `.petalfall-partN`；网络中断保留已完成
//!    分片供下次断点续传，损坏（哈希不符）则清分片重下。
//! 5. 合并到同目录临时文件，校验大小与 sha1，最后原子 rename 覆盖目标。
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
            // 每个源独立退避重试：op 每次生成新 future，携带当前源的 URL。
            let attempt = || self.attempt(url, task, progress, cancel);
            let result = match cancel {
                // 退避等待里观察到取消即视为取消；进行中的尝试自己在网络等待点上响应。
                Some(token) => retry_async_until(&self.config.retry, token.cancelled(), attempt)
                    .await
                    .unwrap_or(Err(Error::Cancelled)),
                None => retry_async(&self.config.retry, attempt).await,
            };
            match result {
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
        Err(Error::AllSourcesExhausted {
            url: task.url.clone(),
            last: Box::new(last_err.expect("候选源列表非空，循环必产生至少一个错误")),
        })
    }

    /// 针对一个具体 URL 的一次完整下载尝试：下载 -> 合并临时文件 -> 校验 -> 原子落位。
    async fn attempt(
        &self,
        url: &str,
        task: &DownloadTask,
        progress: Option<&ProgressReporter>,
        cancel: Option<&CancellationToken>,
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
        let want_chunk = self.config.chunk.enabled
            && task
                .size
                .is_some_and(|size| size >= self.config.chunk.min_split_size)
            && !self.config.chunk.is_host_excluded(url);

        let parts = if want_chunk {
            self.download_chunked(url, task, &temp, progress, cancel)
                .await?
        } else {
            self.download_stream(url, &temp, progress, cancel).await?;
            Vec::new()
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

    /// 分块并发下载。返回本次涉及的分片文件列表（供合并后清理）；整体返回时临时文件已是完整合并结果。
    async fn download_chunked(
        &self,
        url: &str,
        task: &DownloadTask,
        temp: &Path,
        progress: Option<&ProgressReporter>,
        cancel: Option<&CancellationToken>,
    ) -> Result<Vec<PathBuf>> {
        let total = task.size.expect("分块下载路径要求已知文件大小");
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
        for chunk in plan.chunks.iter().skip(1).copied() {
            let part = part_path(&task.dest, chunk.index);
            if part_complete(&part, chunk.byte_len()).await {
                continue;
            }
            let permit = semaphore
                .clone()
                .acquire_owned()
                .await
                .expect("分块信号量未关闭");
            let client = self.client.clone();
            let url = url.to_owned();
            let prog = owned_progress.clone();
            let token = owned_cancel.clone();
            set.spawn(async move {
                let _permit = permit;
                download_one_chunk(&client, &url, chunk, &part, prog.as_ref(), token.as_ref()).await
            });
        }

        let mut first_err: Option<Error> = None;
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
                        first_err = Some(Error::ChunkTaskJoin(join));
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
        if let Some(total) = task.size {
            let plan = ChunkPlan::compute(
                total,
                self.config.chunk.chunk_size,
                self.config.chunk.max_chunks,
            );
            for chunk in &plan.chunks {
                remove_if_present(&part_path(&task.dest, chunk.index)).await;
            }
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
/// 不让清理失败盖过「已取消」这个结果。
async fn remove_if_present(path: &Path) {
    match tokio::fs::remove_file(path).await {
        Ok(()) => tracing::debug!(path = %path.display(), "已清理取消下载的中间文件"),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => {
            tracing::warn!(path = %path.display(), error = %err, "清理取消下载的中间文件失败")
        }
    }
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
