//! 下载原版客户端：本机没有原版游戏时，玩家手动点「下载原版材质」走这里。
//!
//! 取版本清单里的最新正式版，按它的版本 JSON 下客户端 jar（SHA-1 与大小校验），再按资源索引下中文语言
//! 文件，都落进调用方给的暂存目录；抽取进缓存由 `TextureService::adopt_download` 负责。版本清单按
//! 「版本列表源」、文件按「文件下载源」在官方与镜像之间回退，与安装游戏走同一套链路。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use petalfall_download::{BatchReport, DownloadPool, DownloadProgress, DownloadTask};
use petalfall_install::{ASSET_OBJECTS_BASE, GameLayout, VanillaInstaller};
use petalfall_version::{AssetObjectsIndex, VersionJson, check_path_segment};
use serde::Serialize;
use tokio::sync::watch;

use super::DownloadedClient;
use crate::error::Result;
use crate::facade::{Petalfall, make_context};

/// 资源索引里中文语言文件的逻辑名。
const ZH_CN_OBJECT: &str = "minecraft/lang/zh_cn.json";
/// 中文语言文件在暂存目录里的文件名。
const ZH_CN_FILE: &str = "zh_cn.json";
/// 版本 JSON 与资源索引在暂存目录里的文件名：只是中转，读完即删。
const VERSION_JSON_FILE: &str = "version.json";
const ASSET_INDEX_FILE: &str = "asset-index.json";

/// 下载原版材质的阶段，按先后排。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtDownloadStage {
    /// 取版本清单与最新正式版的版本 JSON。
    Manifest,
    /// 下客户端 jar。
    Client,
    /// 取资源索引、下中文语言文件。
    Names,
    /// 从 jar 抽取进缓存，由抽取的一方报。
    Extract,
}

/// 下载原版材质的一次进度。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ArtDownloadProgress {
    pub stage: ArtDownloadStage,
    /// 本阶段已就绪的字节，重传不重复计；manifest 与 extract 阶段为 0。
    pub downloaded: u64,
    /// 本阶段的总字节；还不知道时为 None。
    pub total: Option<u64>,
}

impl ArtDownloadProgress {
    fn begin(stage: ArtDownloadStage, total: Option<u64>) -> Self {
        Self {
            stage,
            downloaded: 0,
            total,
        }
    }
}

impl Petalfall {
    /// 把最新正式版的客户端 jar 与中文语言文件下到 `dest`（暂存目录，没有时建出），返回交给抽取的描述。
    ///
    /// 中文语言文件只关系到方块名有没有中文：资源索引或它本身下不到、校验不过时记 warn，`zh_cn` 为 None，
    /// 整体照常返回。其余失败按原错误冒泡，取消在哪一步都冒泡为取消。`progress` 在本任务里同步调用。
    ///
    /// 失败时 `dest` 里可能留下的东西（暂存目录由调用方整个删掉）：
    /// - 校验不符（SHA-1 或大小）：引擎已删掉合并临时文件与分片，不留 jar；
    /// - 网络失败：大文件分片下载时已收齐的分片 `<jar>.petalfall-partN` 留着，同一路径再下时续传复用；
    ///   合并分片途中磁盘出错时还可能留下 `<jar>.petalfall-tmp`；
    /// - 取消：进行中那个文件的临时文件与分片都清掉，已经下完的 jar 留着。
    ///
    /// 版本 JSON 与资源索引读完即删，不论成败。
    pub async fn download_art_client(
        &self,
        dest: &Path,
        progress: &(dyn Fn(ArtDownloadProgress) + Send + Sync),
    ) -> Result<DownloadedClient> {
        progress(ArtDownloadProgress::begin(ArtDownloadStage::Manifest, None));
        self.prepare_sources().await?;
        let staging = GameLayout::new(dest);
        let pool = Arc::new(self.download_pool());
        let policy = self.retry_policy();
        let http = self.http();
        let cx = make_context(
            &http,
            &pool,
            &staging,
            self.runtime(),
            &policy,
            self.cancel_token(),
        );
        let installer = VanillaInstaller::new(cx)
            .with_manifest_url(self.manifest_url())
            .with_sources(self.source_plan(self.config().version_list_source));
        let manifest = installer.fetch_manifest().await?;
        let entry = manifest.latest_release().cloned().ok_or_else(|| {
            petalfall_install::Error::InstallerEntryMissing {
                entry: format!("版本清单中的 {}", manifest.latest.release),
            }
        })?;
        // 清单可能来自镜像，id 原样拼进 jar 的文件名。
        check_path_segment(&entry.id).map_err(|problem| petalfall_install::Error::UnsafePath {
            entry: "版本清单里的版本 id".to_owned(),
            path: entry.id.clone(),
            problem,
        })?;

        let json_path = dest.join(VERSION_JSON_FILE);
        let version = installer.download_version_json(&entry, &json_path).await;
        discard(&json_path).await;
        let version = version?;
        if version.id != entry.id {
            return Err(petalfall_install::Error::VersionIdMismatch {
                expected: entry.id,
                actual: version.id,
            }
            .into());
        }
        let client = version
            .downloads
            .as_ref()
            .and_then(|downloads| downloads.client.as_ref())
            .ok_or_else(|| petalfall_install::Error::MissingClientDownload {
                version: version.id.clone(),
            })?;
        let jar = dest.join(format!("{}.jar", entry.id));
        let task = DownloadTask::new(client.url.clone(), &jar)
            .with_sha1(client.sha1.clone())
            .with_size(client.size);
        fetch_file(&pool, task, Some(ArtDownloadStage::Client), progress).await?;

        progress(ArtDownloadProgress::begin(ArtDownloadStage::Names, None));
        let zh_cn = match fetch_zh_cn(&pool, &version, dest, progress).await {
            Ok(Some(path)) => Some(path),
            Ok(None) => {
                tracing::warn!(version = %entry.id, "资源索引里没有中文语言文件，方块名只有英文");
                None
            }
            Err(err) if err.is_cancelled() => return Err(err),
            Err(err) => {
                tracing::warn!(version = %entry.id, error = %err, cause = ?std::error::Error::source(&err), "下载中文语言文件失败，方块名只有英文");
                None
            }
        };
        tracing::info!(version = %entry.id, zh_cn = zh_cn.is_some(), "原版客户端已下载");
        Ok(DownloadedClient {
            jar_sha1: client.sha1.to_ascii_lowercase(),
            version_id: entry.id,
            jar,
            zh_cn,
        })
    }
}

/// 取资源索引、下中文语言文件；索引里没有这个文件时为 `Ok(None)`。
async fn fetch_zh_cn(
    pool: &Arc<DownloadPool>,
    version: &VersionJson,
    dest: &Path,
    progress: &(dyn Fn(ArtDownloadProgress) + Send + Sync),
) -> Result<Option<PathBuf>> {
    let index = version.asset_index.as_ref().ok_or_else(|| {
        petalfall_install::Error::MissingAssetIndex {
            version: version.id.clone(),
        }
    })?;
    let index_path = dest.join(ASSET_INDEX_FILE);
    let task = DownloadTask::new(index.url.clone(), &index_path)
        .with_sha1(index.sha1.clone())
        .with_size(index.size);
    fetch_file(pool, task, None, progress).await?;
    let read = tokio::fs::read(&index_path).await;
    discard(&index_path).await;
    let bytes = read.map_err(|source| petalfall_base::Error::Io {
        path: index_path,
        source,
    })?;
    // 直接按字节解析：有损转换会把坏字节换成替换符，让损坏的索引看起来能读。
    let index: AssetObjectsIndex =
        serde_json::from_slice(&bytes).map_err(|source| petalfall_version::Error::Json {
            context: "资源索引",
            source,
        })?;
    let Some(object) = index.objects.get(ZH_CN_OBJECT) else {
        return Ok(None);
    };
    let path = dest.join(ZH_CN_FILE);
    // 与安装器补全资源对象同一种拼法，换到镜像时由下载源方案改写。
    let task = DownloadTask::new(
        format!("{ASSET_OBJECTS_BASE}/{}", object.object_path()),
        &path,
    )
    .with_sha1(object.hash.clone())
    .with_size(object.size);
    fetch_file(pool, task, Some(ArtDownloadStage::Names), progress).await?;
    Ok(Some(path))
}

/// 用下载池下一个文件；给了 `stage` 时把池的进度快照逐份转成这一阶段的进度。
///
/// 报进度时下载放进单独的任务、这里只管转发：回调是借来的，进不了后台任务；下载 future 也不该在落盘
/// 途中被丢下（引擎靠取消令牌收拾临时文件与分片），调用方中途放弃时它照样跑完。
async fn fetch_file(
    pool: &Arc<DownloadPool>,
    task: DownloadTask,
    stage: Option<ArtDownloadStage>,
    progress: &(dyn Fn(ArtDownloadProgress) + Send + Sync),
) -> Result<()> {
    let Some(stage) = stage else {
        return single_outcome(pool.download_all(vec![task], None).await?);
    };
    // 池的第一份快照可能被紧接着的快照盖掉，阶段切换要确定地先报出去。
    progress(ArtDownloadProgress::begin(stage, task.size));
    let (sender, mut snapshots) = watch::channel(DownloadProgress::default());
    let job = {
        let pool = pool.clone();
        tokio::spawn(async move { pool.download_all(vec![task], Some(sender)).await })
    };
    // 池返回后发送端随之释放；最后一份没读过的快照照样读得到，之后循环才结束。
    while snapshots.changed().await.is_ok() {
        let snapshot = *snapshots.borrow_and_update();
        progress(ArtDownloadProgress {
            stage,
            downloaded: snapshot.bytes,
            total: snapshot.total_bytes,
        });
    }
    single_outcome(job.await??)
}

/// 单文件批次的结果。失败就是这一个文件的错误，原样冒泡，不收成批次计数错误：命令层据此报下载失败。
fn single_outcome(mut report: BatchReport) -> Result<()> {
    match report.failures.pop() {
        Some(failure) => Err(failure.error.into()),
        None => Ok(()),
    }
}

/// 删掉中转文件。这时要么已经读到内容，要么已有一个错误要报，删不掉只记日志：它在暂存目录里，
/// 调用方随目录一起删。
async fn discard(path: &Path) {
    if let Err(err) = tokio::fs::remove_file(path).await
        && err.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!(path = %path.display(), %err, "删除下载中转文件失败");
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::time::Duration;

    use serde_json::json;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::*;
    use crate::art::remote::sha1_hex;
    use crate::config::{DownloadSourcePolicy, PetalfallConfig};
    use crate::error::CoreError;
    use crate::sources::tests::Routes;

    const MANIFEST_PATH: &str = "/mc/game/version_manifest_v2.json";
    const SNAPSHOT_PATH: &str = "/v1/packages/1111111111111111111111111111111111111111/26w45a.json";

    fn random_bytes(len: usize) -> Vec<u8> {
        let mut bytes = vec![0u8; len];
        fastrand::fill(&mut bytes);
        bytes
    }

    /// 末字节翻转的一份：长度对得上，只有哈希不符。
    fn tampered(bytes: &[u8]) -> Vec<u8> {
        let mut out = bytes.to_vec();
        let last = out.len() - 1;
        out[last] ^= 0xff;
        out
    }

    /// 远端的一套文件：jar 与 zh_cn 内容随机、长度从 1 字节起；版本 JSON 里 jar 的 SHA-1 写成大写。
    struct Remote {
        jar: Vec<u8>,
        zh_cn: Vec<u8>,
        index: String,
        version: String,
        manifest: String,
    }

    impl Remote {
        fn new(list_zh_cn: bool) -> Self {
            Self::with_latest("26.3", list_zh_cn)
        }

        fn with_latest(latest: &str, list_zh_cn: bool) -> Self {
            let jar = random_bytes(fastrand::usize(1..=8192));
            let zh_cn = random_bytes(fastrand::usize(1..=4096));
            let mut objects = serde_json::Map::new();
            objects.insert(
                "minecraft/sounds/ambient/cave/cave1.ogg".to_owned(),
                json!({"hash": sha1_hex(b"cave"), "size": 4}),
            );
            if list_zh_cn {
                objects.insert(
                    ZH_CN_OBJECT.to_owned(),
                    json!({"hash": sha1_hex(&zh_cn), "size": zh_cn.len()}),
                );
            }
            let index = json!({ "objects": objects }).to_string();
            let index_sha1 = sha1_hex(index.as_bytes());
            let jar_sha1 = sha1_hex(&jar);
            let version = json!({
                "id": "26.3",
                "type": "release",
                "mainClass": "net.minecraft.client.main.Main",
                "downloads": {"client": {
                    "sha1": jar_sha1.to_ascii_uppercase(),
                    "size": jar.len(),
                    "url": format!("https://piston-data.mojang.com/v1/objects/{jar_sha1}/client.jar"),
                }},
                "assetIndex": {
                    "id": "29",
                    "sha1": index_sha1,
                    "size": index.len(),
                    "totalSize": 4 + zh_cn.len(),
                    "url": format!("https://piston-meta.mojang.com/v1/packages/{index_sha1}/29.json"),
                },
            })
            .to_string();
            let version_sha1 = sha1_hex(version.as_bytes());
            // 快照排在最前、更旧的正式版排在后面：取第一条或取最后一条都会被测出来。
            let manifest = json!({
                "latest": {"release": latest, "snapshot": "26w45a"},
                "versions": [
                    {"id": "26w45a", "type": "snapshot",
                     "url": format!("https://piston-meta.mojang.com{SNAPSHOT_PATH}"),
                     "time": "t", "releaseTime": "t", "sha1": "1111111111111111111111111111111111111111"},
                    {"id": "26.3", "type": "release",
                     "url": format!("https://piston-meta.mojang.com/v1/packages/{version_sha1}/26.3.json"),
                     "time": "t", "releaseTime": "t", "sha1": version_sha1},
                    {"id": "26.2", "type": "release",
                     "url": "https://piston-meta.mojang.com/v1/packages/2222222222222222222222222222222222222222/26.2.json",
                     "time": "t", "releaseTime": "t", "sha1": "2222222222222222222222222222222222222222"},
                ],
            })
            .to_string();
            Self {
                jar,
                zh_cn,
                index,
                version,
                manifest,
            }
        }

        fn version_path(&self) -> String {
            format!(
                "/v1/packages/{}/26.3.json",
                sha1_hex(self.version.as_bytes())
            )
        }

        fn index_path(&self) -> String {
            format!("/v1/packages/{}/29.json", sha1_hex(self.index.as_bytes()))
        }

        fn jar_path(&self) -> String {
            format!("/v1/objects/{}/client.jar", sha1_hex(&self.jar))
        }

        fn zh_cn_path(&self) -> String {
            let hash = sha1_hex(&self.zh_cn);
            format!("/{}/{hash}", &hash[..2])
        }

        /// 清单、版本 JSON 与资源索引。
        async fn mount_metadata(&self, server: &MockServer) {
            for (at, body) in [
                (MANIFEST_PATH.to_owned(), &self.manifest),
                (self.version_path(), &self.version),
                (self.index_path(), &self.index),
            ] {
                Mock::given(method("GET"))
                    .and(path(at))
                    .respond_with(ResponseTemplate::new(200).set_body_string(body.clone()))
                    .mount(server)
                    .await;
            }
        }

        async fn mount_jar(&self, server: &MockServer, body: Vec<u8>) {
            serve(server, self.jar_path(), body).await;
        }

        async fn mount_zh_cn(&self, server: &MockServer, body: Vec<u8>) {
            serve(server, self.zh_cn_path(), body).await;
        }

        async fn mount_all(&self, server: &MockServer) {
            self.mount_metadata(server).await;
            self.mount_jar(server, self.jar.clone()).await;
            self.mount_zh_cn(server, self.zh_cn.clone()).await;
        }
    }

    async fn serve(server: &MockServer, at: String, body: Vec<u8>) {
        Mock::given(method("GET"))
            .and(path(at))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(body))
            .mount(server)
            .await;
    }

    /// 官方与镜像钉到两台 mock，两项源策略取同一档。清单的官方地址用解析不了的域名：源计划没生效、
    /// 直接请求它时测试当场失败，不会连到真实网络。
    fn petalfall(
        official: &MockServer,
        mirror: &MockServer,
        policy: DownloadSourcePolicy,
        data_dir: &Path,
    ) -> Petalfall {
        let config = PetalfallConfig {
            download_source: policy,
            version_list_source: policy,
            ..PetalfallConfig::default()
        };
        Petalfall::for_test(config, data_dir.to_path_buf(), data_dir.join(".minecraft"))
            .with_source_routes(
                Arc::new(Routes {
                    official: official.uri(),
                    mirror: mirror.uri(),
                }),
                Duration::from_secs(600),
                Duration::from_secs(2),
            )
            .with_manifest_url(format!("https://meta.invalid{MANIFEST_PATH}"))
    }

    #[derive(Default)]
    struct Recorder(Mutex<Vec<ArtDownloadProgress>>);

    impl Recorder {
        fn record(&self, progress: ArtDownloadProgress) {
            self.0.lock().unwrap().push(progress);
        }

        fn events(&self) -> Vec<ArtDownloadProgress> {
            self.0.lock().unwrap().clone()
        }
    }

    async fn requested(server: &MockServer) -> Vec<String> {
        server
            .received_requests()
            .await
            .expect("mock 应记录请求")
            .iter()
            .map(|request| request.url.path().to_owned())
            .collect()
    }

    fn listing(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    /// 清单里快照排第一、旧正式版排最后：下的是 latest.release 指向的 26.3，jar 与中文语言文件落进暂存目录，
    /// SHA-1 转成小写，中转文件不留。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn downloads_the_latest_release_into_the_staging_dir() {
        let official = MockServer::start().await;
        let mirror = MockServer::start().await;
        let remote = Remote::new(true);
        remote.mount_all(&official).await;
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("staging");

        let client = petalfall(
            &official,
            &mirror,
            DownloadSourcePolicy::OfficialFirst,
            tmp.path(),
        )
        .download_art_client(&dest, &|_| {})
        .await
        .unwrap();

        assert_eq!(
            client,
            DownloadedClient {
                version_id: "26.3".to_owned(),
                jar: dest.join("26.3.jar"),
                jar_sha1: sha1_hex(&remote.jar),
                zh_cn: Some(dest.join("zh_cn.json")),
            }
        );
        assert_eq!(std::fs::read(&client.jar).unwrap(), remote.jar);
        assert_eq!(
            std::fs::read(dest.join("zh_cn.json")).unwrap(),
            remote.zh_cn
        );
        assert_eq!(listing(&dest), ["26.3.jar", "zh_cn.json"]);
        assert_eq!(
            requested(&official).await,
            [
                MANIFEST_PATH.to_owned(),
                remote.version_path(),
                remote.jar_path(),
                remote.index_path(),
                remote.zh_cn_path(),
            ]
        );
        assert!(requested(&mirror).await.is_empty());
    }

    /// 阶段按 manifest、client、names 的顺序报，client 从 0 报到 jar 的字节数，names 先报一次总量未知，
    /// 再从 0 报到中文语言文件的字节数；抽取阶段不由这里报。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn progress_walks_the_stages_in_order_with_exact_byte_counts() {
        let official = MockServer::start().await;
        let mirror = MockServer::start().await;
        let remote = Remote::new(true);
        remote.mount_all(&official).await;
        let tmp = tempfile::tempdir().unwrap();
        let recorder = Recorder::default();

        petalfall(
            &official,
            &mirror,
            DownloadSourcePolicy::OfficialFirst,
            tmp.path(),
        )
        .download_art_client(&tmp.path().join("staging"), &|p| recorder.record(p))
        .await
        .unwrap();

        let events = recorder.events();
        let jar_len = remote.jar.len() as u64;
        let zh_len = remote.zh_cn.len() as u64;
        let mut stages: Vec<ArtDownloadStage> = events.iter().map(|p| p.stage).collect();
        stages.dedup();
        assert_eq!(
            stages,
            [
                ArtDownloadStage::Manifest,
                ArtDownloadStage::Client,
                ArtDownloadStage::Names
            ]
        );
        assert_eq!(
            events[0],
            ArtDownloadProgress::begin(ArtDownloadStage::Manifest, None)
        );
        assert_eq!(
            events
                .iter()
                .filter(|p| p.stage == ArtDownloadStage::Manifest)
                .count(),
            1
        );

        let client: Vec<_> = events
            .iter()
            .filter(|p| p.stage == ArtDownloadStage::Client)
            .collect();
        assert_eq!(
            *client[0],
            ArtDownloadProgress::begin(ArtDownloadStage::Client, Some(jar_len))
        );
        assert_eq!(
            **client.last().unwrap(),
            ArtDownloadProgress {
                stage: ArtDownloadStage::Client,
                downloaded: jar_len,
                total: Some(jar_len),
            }
        );
        assert!(
            client.iter().all(|p| p.total == Some(jar_len)),
            "{client:?}"
        );
        assert!(
            client
                .windows(2)
                .all(|w| w[0].downloaded <= w[1].downloaded),
            "{client:?}"
        );

        let names: Vec<_> = events
            .iter()
            .filter(|p| p.stage == ArtDownloadStage::Names)
            .collect();
        assert_eq!(
            *names[0],
            ArtDownloadProgress::begin(ArtDownloadStage::Names, None)
        );
        assert_eq!(
            *names[1],
            ArtDownloadProgress::begin(ArtDownloadStage::Names, Some(zh_len))
        );
        assert_eq!(
            **names.last().unwrap(),
            ArtDownloadProgress {
                stage: ArtDownloadStage::Names,
                downloaded: zh_len,
                total: Some(zh_len),
            }
        );
        assert!(
            names[1..].iter().all(|p| p.total == Some(zh_len)),
            "{names:?}"
        );
    }

    /// 官方没有这个 jar（404 立即换源），镜像给的字节被改过：报 SHA-1 不符，暂存目录里什么都不留，
    /// 也不再往下取资源索引。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_tampered_client_jar_fails_and_leaves_nothing_behind() {
        let official = MockServer::start().await;
        let mirror = MockServer::start().await;
        let remote = Remote::new(true);
        remote.mount_metadata(&official).await;
        let bad = tampered(&remote.jar);
        remote.mount_jar(&mirror, bad.clone()).await;
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("staging");
        let recorder = Recorder::default();

        let err = petalfall(
            &official,
            &mirror,
            DownloadSourcePolicy::OfficialFirst,
            tmp.path(),
        )
        .download_art_client(&dest, &|p| recorder.record(p))
        .await
        .unwrap_err();

        let CoreError::Download(petalfall_download::Error::AllSourcesExhausted { last, .. }) = &err
        else {
            panic!("应为所有源都失败，实际：{err:?}");
        };
        match &**last {
            petalfall_download::Error::Base(petalfall_base::Error::HashMismatch {
                expected,
                actual,
                ..
            }) => {
                assert_eq!(expected.to_ascii_lowercase(), sha1_hex(&remote.jar));
                assert_eq!(*actual, sha1_hex(&bad));
            }
            other => panic!("镜像上的失败应是哈希不符，实际：{other:?}"),
        }
        assert!(listing(&dest).is_empty(), "{:?}", listing(&dest));
        assert!(!requested(&official).await.contains(&remote.index_path()));
        assert!(
            recorder
                .events()
                .iter()
                .all(|p| p.stage != ArtDownloadStage::Names)
        );
    }

    /// 资源索引里没有 zh_cn：照常返回 jar，zh_cn 为 None，不发资源对象请求。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_index_without_zh_cn_still_returns_the_jar() {
        let official = MockServer::start().await;
        let mirror = MockServer::start().await;
        let remote = Remote::new(false);
        remote.mount_all(&official).await;
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("staging");

        let client = petalfall(
            &official,
            &mirror,
            DownloadSourcePolicy::OfficialFirst,
            tmp.path(),
        )
        .download_art_client(&dest, &|_| {})
        .await
        .unwrap();

        assert_eq!(client.zh_cn, None);
        assert_eq!(std::fs::read(&client.jar).unwrap(), remote.jar);
        assert_eq!(listing(&dest), ["26.3.jar"]);
        assert!(!requested(&official).await.contains(&remote.zh_cn_path()));
    }

    /// 中文语言文件官方 404、镜像上被改过：只丢中文名，jar 照常返回，坏文件不落盘。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_tampered_zh_cn_only_drops_the_chinese_names() {
        let official = MockServer::start().await;
        let mirror = MockServer::start().await;
        let remote = Remote::new(true);
        remote.mount_metadata(&official).await;
        remote.mount_jar(&official, remote.jar.clone()).await;
        remote.mount_zh_cn(&mirror, tampered(&remote.zh_cn)).await;
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("staging");

        let client = petalfall(
            &official,
            &mirror,
            DownloadSourcePolicy::OfficialFirst,
            tmp.path(),
        )
        .download_art_client(&dest, &|_| {})
        .await
        .unwrap();

        assert_eq!(client.version_id, "26.3");
        assert_eq!(client.zh_cn, None);
        assert_eq!(std::fs::read(&client.jar).unwrap(), remote.jar);
        assert_eq!(listing(&dest), ["26.3.jar"]);
        assert!(requested(&mirror).await.contains(&remote.zh_cn_path()));
    }

    /// 下载源设成尽量镜像：清单、版本 JSON、jar、资源索引与中文语言文件全从镜像取，官方一次都不碰。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn mirror_first_fetches_everything_from_the_mirror() {
        let official = MockServer::start().await;
        let mirror = MockServer::start().await;
        let remote = Remote::new(true);
        remote.mount_all(&mirror).await;
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("staging");

        let client = petalfall(
            &official,
            &mirror,
            DownloadSourcePolicy::MirrorFirst,
            tmp.path(),
        )
        .download_art_client(&dest, &|_| {})
        .await
        .unwrap();

        assert_eq!(std::fs::read(&client.jar).unwrap(), remote.jar);
        assert_eq!(
            std::fs::read(dest.join("zh_cn.json")).unwrap(),
            remote.zh_cn
        );
        assert!(requested(&official).await.is_empty());
        assert_eq!(
            requested(&mirror).await,
            [
                MANIFEST_PATH.to_owned(),
                remote.version_path(),
                remote.jar_path(),
                remote.index_path(),
                remote.zh_cn_path(),
            ]
        );
    }

    /// 尽量官方、官方上没有这个 jar：换到镜像下到，其余文件仍从官方取。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_jar_missing_on_official_falls_back_to_the_mirror() {
        let official = MockServer::start().await;
        let mirror = MockServer::start().await;
        let remote = Remote::new(true);
        remote.mount_metadata(&official).await;
        remote.mount_zh_cn(&official, remote.zh_cn.clone()).await;
        remote.mount_jar(&mirror, remote.jar.clone()).await;
        let tmp = tempfile::tempdir().unwrap();

        let client = petalfall(
            &official,
            &mirror,
            DownloadSourcePolicy::OfficialFirst,
            tmp.path(),
        )
        .download_art_client(&tmp.path().join("staging"), &|_| {})
        .await
        .unwrap();

        assert_eq!(std::fs::read(&client.jar).unwrap(), remote.jar);
        assert!(client.zh_cn.is_some());
        assert_eq!(requested(&mirror).await, [remote.jar_path()]);
        assert!(requested(&official).await.contains(&remote.jar_path()));
    }

    /// latest.release 指向清单里没有的版本：报条目缺失，不去下任何版本 JSON。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_latest_release_absent_from_the_list_is_an_error() {
        let official = MockServer::start().await;
        let mirror = MockServer::start().await;
        let remote = Remote::with_latest("26.4", true);
        remote.mount_all(&official).await;
        let tmp = tempfile::tempdir().unwrap();

        let err = petalfall(
            &official,
            &mirror,
            DownloadSourcePolicy::OfficialFirst,
            tmp.path(),
        )
        .download_art_client(&tmp.path().join("staging"), &|_| {})
        .await
        .unwrap_err();

        assert!(
            matches!(
                &err,
                CoreError::Install(petalfall_install::Error::InstallerEntryMissing { entry })
                    if entry == "版本清单中的 26.4"
            ),
            "实际：{err:?}"
        );
        assert_eq!(requested(&official).await, [MANIFEST_PATH.to_owned()]);
    }

    /// 取中文名这一步被取消：冒泡为取消，不当成「没有中文名」照常返回；已下完的 jar 留在暂存目录里。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelling_during_names_is_not_mistaken_for_missing_names() {
        let official = MockServer::start().await;
        let mirror = MockServer::start().await;
        let remote = Remote::new(true);
        remote.mount_all(&official).await;
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("staging");
        let token = petalfall_download::CancellationToken::new();
        let cancel_on_names = |p: ArtDownloadProgress| {
            if p.stage == ArtDownloadStage::Names {
                token.cancel();
            }
        };

        let err = petalfall(
            &official,
            &mirror,
            DownloadSourcePolicy::OfficialFirst,
            tmp.path(),
        )
        .with_cancel(token.clone())
        .download_art_client(&dest, &cancel_on_names)
        .await
        .unwrap_err();

        assert!(err.is_cancelled(), "实际：{err:?}");
        assert_eq!(listing(&dest), ["26.3.jar"]);
        let paths = requested(&official).await;
        assert!(!paths.contains(&remote.index_path()), "{paths:?}");
        assert!(!paths.contains(&remote.zh_cn_path()), "{paths:?}");
    }

    /// 序列化形状与前端的 ArtDownloadProgressDto 一致：阶段是小写下划线，总量未知时为 null。
    #[test]
    fn progress_serializes_like_the_frontend_dto() {
        let cases = [
            (ArtDownloadStage::Manifest, "manifest"),
            (ArtDownloadStage::Client, "client"),
            (ArtDownloadStage::Names, "names"),
            (ArtDownloadStage::Extract, "extract"),
        ];
        for (stage, key) in cases {
            assert_eq!(serde_json::to_value(stage).unwrap(), json!(key));
        }
        assert_eq!(
            serde_json::to_value(ArtDownloadProgress {
                stage: ArtDownloadStage::Client,
                downloaded: 41_483_720,
                total: Some(41_483_720),
            })
            .unwrap(),
            json!({"stage": "client", "downloaded": 41_483_720u64, "total": 41_483_720u64})
        );
        assert_eq!(
            serde_json::to_value(ArtDownloadProgress::begin(ArtDownloadStage::Names, None))
                .unwrap(),
            json!({"stage": "names", "downloaded": 0, "total": null})
        );
    }
}
