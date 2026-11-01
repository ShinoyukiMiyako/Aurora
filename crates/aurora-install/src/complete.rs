//! 完整性检查与缺失补全（`ensure_complete`）。
//!
//! 任何版本启动前都要确认「本体 jar / 库 / 资源 / natives」齐备。得益于 aurora-download 引擎的
//! 幂等语义（目标已存在且 sha1/大小吻合即跳过），补全逻辑与全新安装是同一套：把该版本的完整文件
//! 计划重跑一遍，缺什么下什么、坏什么重下什么，已就绪的文件零成本略过。这也是原版安装
//! ([`crate::vanilla`]) 的公共下半段。
//!
//! `target_id` 把「客户端 jar 与 natives 的落点版本」与「被检查的版本 JSON 的 id」解耦：原版安装
//! 时两者相同；加载器版本（已合并解析）则复用其原版的 jar 与 natives 目录，故传原版 id；按实例名
//! 安装的实例则落到实例自己的目录。
//!
//! 加载器安装器自带的库（版本 JSON 里地址留空）没有地方可以重下：盘上那份齐全就不进下载批次，缺了或坏了
//! 报 [`Error::LoaderLibraryMissing`]，交给玩家重装加载器。

use std::path::{Path, PathBuf};

use aurora_download::DownloadTask;
use aurora_version::{AssetLayout, AssetObjectsIndex, VersionJson};

use crate::context::InstallContext;
use crate::dir_lock::lock_dir;
use crate::error::{Error, Result, io_err};
use crate::layout::{GameLayout, checked_segment, materialized_asset_path};
use crate::natives;
use crate::net;
use crate::plan;

/// 一次补全的结果计数。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletionReport {
    /// 是否确保了客户端主 jar（版本 JSON 声明了 downloads.client 才有）。
    pub client_jar: bool,
    /// 确保就绪的库文件数。
    pub libraries: usize,
    /// 确保就绪的资源对象数。
    pub assets: usize,
    /// natives 目录里的文件数（本次解压出的，或上次解压且 jar 未变时沿用的）。
    pub natives: u32,
}

/// 确保 `version` 描述的版本在本地齐备，缺失即补全。
///
/// 前提：`version` 已是「合并解析后」的自洽版本 JSON（无 inheritsFrom）。
pub async fn ensure_complete(
    cx: InstallContext<'_>,
    version: &VersionJson,
    target_id: &str,
) -> Result<CompletionReport> {
    // 原版安装时 target_id 就是远端版本 JSON 里的 id，客户端 jar 与 natives 目录都按它落盘。
    checked_segment(target_id, || "版本 id".to_owned())?;

    // 第一批：库 + 日志配置 + 客户端 jar + assetIndex（都并入一池）。
    let library_tasks = plan::library_tasks(version, cx.runtime, cx.layout)?;
    let libraries = library_tasks.len();
    let library_tasks = settle_bundled_libraries(library_tasks).await?;
    let mut primary = skip_present_unverifiable(library_tasks).await?;

    let client_jar =
        if let Some(client) = version.downloads.as_ref().and_then(|d| d.client.as_ref()) {
            primary.push(
                DownloadTask::new(client.url.clone(), cx.layout.version_jar(target_id))
                    .with_sha1(client.sha1.clone())
                    .with_size(client.size),
            );
            true
        } else {
            false
        };

    if let Some(log) = plan::logging_task(version, cx.layout)? {
        primary.push(log);
    }
    let has_assets = version.asset_index.is_some();
    if has_assets {
        primary.push(plan::asset_index_task(version, cx.layout)?);
    }
    cx.run_batch(primary, "补全本体与库", None).await?;

    // 第二批：资源对象全量补全（仅当版本带 assetIndex）。
    let assets = if has_assets {
        let index = read_asset_index(cx, version).await?;
        let object_tasks = plan::asset_object_tasks(&index, cx.layout)?;
        let count = object_tasks.len();
        cx.run_batch(object_tasks, "补全资源", None).await?;
        materialize_assets(cx, version, &index).await?;
        count
    } else {
        0
    };

    // natives 解压到 target 版本的 natives 目录。
    let natives =
        natives::extract_all_natives(version, cx.runtime, cx.layout, target_id, cx.cancel).await?;

    Ok(CompletionReport {
        client_jar,
        libraries,
        assets,
        natives,
    })
}

/// 去掉落点上已有文件、却既无 sha1 也无大小可比的任务。
///
/// 只有坐标和仓库地址的库（Fabric 与旧版 Forge 的条目、外部安装器写进来的 OptiFine）没有任何校验信息，
/// 下载引擎认不出它们已经就绪，每次都会重下；其中有的在声明的仓库里根本没有（旧版 Forge 的通用 jar
/// 由安装器从 installer 里解出，按坐标去拉是 404），重下只会让整批失败。官方启动器对这类库也是在盘上
/// 即用，启动前的缺失检查同样如此。
pub(crate) async fn skip_present_unverifiable(
    tasks: Vec<DownloadTask>,
) -> Result<Vec<DownloadTask>> {
    let mut kept = Vec::with_capacity(tasks.len());
    for task in tasks {
        if task.sha1.is_none() && task.size.is_none() {
            match tokio::fs::metadata(&task.dest).await {
                Ok(meta) if meta.is_file() => continue,
                Ok(_) => {}
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(source) => return Err(io_err(&task.dest, source)),
            }
        }
        kept.push(task);
    }
    Ok(kept)
}

/// 加载器安装器自带的库：版本 JSON 声明了下载件、地址却留空（Forge 1.13 起的 installer 把它们放在
/// `maven/` 下，安装时解出或由处理器生成）。下载引擎拿空地址只会报地址解析失败，所以在这里先认：盘上那份
/// 的大小与 sha1 都对得上（与下载引擎认「已就绪」同一套判据）就从批次里拿掉，缺失或对不上时报
/// [`Error::LoaderLibraryMissing`]。
pub(crate) async fn settle_bundled_libraries(
    tasks: Vec<DownloadTask>,
) -> Result<Vec<DownloadTask>> {
    let mut kept = Vec::with_capacity(tasks.len());
    for task in tasks {
        if !task.url.is_empty() {
            kept.push(task);
            continue;
        }
        if !bundled_library_ready(&task).await? {
            return Err(Error::LoaderLibraryMissing { path: task.dest });
        }
    }
    Ok(kept)
}

/// 即将交给下载引擎的任务里有地址为空的，就是加载器自带、已经缺失的库：报
/// [`Error::LoaderLibraryMissing`]，而不是让下载引擎报地址解析失败。供只比对存在与大小、不校验 sha1 的
/// 启动前检查在挑出缺失文件后调用。
pub fn reject_missing_bundled(missing: &[DownloadTask]) -> Result<()> {
    match missing.iter().find(|task| task.url.is_empty()) {
        Some(task) => Err(Error::LoaderLibraryMissing {
            path: task.dest.clone(),
        }),
        None => Ok(()),
    }
}

async fn bundled_library_ready(task: &DownloadTask) -> Result<bool> {
    let len = match tokio::fs::metadata(&task.dest).await {
        Ok(meta) if meta.is_file() => meta.len(),
        Ok(_) => return Ok(false),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(source) => return Err(io_err(&task.dest, source)),
    };
    if task.size.is_some_and(|size| size != len) {
        return Ok(false);
    }
    match task.sha1.as_deref() {
        Some(sha1) if !sha1.is_empty() => {
            match aurora_base::fs::verify_sha1(&task.dest, sha1).await {
                Ok(()) => Ok(true),
                Err(aurora_base::Error::HashMismatch { .. }) => Ok(false),
                Err(err) => Err(err.into()),
            }
        }
        _ => Ok(true),
    }
}

/// 从磁盘读回并解析已下载的 assetIndex。
async fn read_asset_index(
    cx: InstallContext<'_>,
    version: &VersionJson,
) -> Result<AssetObjectsIndex> {
    let index_id = version
        .asset_index
        .as_ref()
        .ok_or_else(|| Error::MissingAssetIndex {
            version: version.id.clone(),
        })?
        .id
        .clone();
    let path = cx.layout.asset_index_json(&index_id)?;
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|source| io_err(&path, source))?;
    net::parse_json(&bytes, "资源索引")
}

/// 对 virtual / map_to_resources 布局，把 objects 里的对象按逻辑名物化到展开目录。
///
/// 这两种布局只出现在 1.7.2 及更早的版本，一份索引几百到上千个对象，每次补全都会走到这里；
/// 目标已存在且大小与索引一致的直接跳过，整段放到阻塞线程池里用同步 IO 做完。展开目录按资源索引共用，
/// 同一目录上的展开一个接一个来（见 [`crate::dir_lock`]）。
async fn materialize_assets(
    cx: InstallContext<'_>,
    version: &VersionJson,
    index: &AssetObjectsIndex,
) -> Result<()> {
    let target_dir = match index.layout() {
        AssetLayout::Standard => return Ok(()),
        AssetLayout::Virtual => {
            let index_id = version
                .asset_index
                .as_ref()
                .map(|a| a.id.clone())
                .or_else(|| version.assets.clone())
                .ok_or_else(|| Error::MissingAssetIndex {
                    version: version.id.clone(),
                })?;
            cx.layout.asset_virtual_dir(&index_id)?
        }
        AssetLayout::MapToResources => cx.layout.resources_dir(),
    };
    materialize_objects(cx.layout, index, &target_dir).await
}

/// 把索引里的对象按逻辑名铺到 `target_dir`。对象必须已在 `assets/objects` 里，缺了报错。
pub async fn materialize_objects(
    layout: &GameLayout,
    index: &AssetObjectsIndex,
    target_dir: &Path,
) -> Result<()> {
    let jobs: Vec<(PathBuf, PathBuf, u64)> = index
        .objects
        .iter()
        .map(|(logical, object)| {
            Ok((
                layout.asset_object_path(&object.hash),
                materialized_asset_path(target_dir, logical)?,
                object.size,
            ))
        })
        .collect::<Result<_>>()?;
    let turn = lock_dir(&target_dir, cx.cancel).await?;
    tokio::task::spawn_blocking(move || {
        let _turn = turn;
        copy_missing(&jobs)
    })
    .await
    .map_err(|join| {
        io_err(
            PathBuf::from("<assets>"),
            std::io::Error::other(format!("资源物化任务异常终止: {join}")),
        )
    })?
}

/// 逐个把对象拷到展开目录；目标已存在且大小相符的跳过。
fn copy_missing(jobs: &[(PathBuf, PathBuf, u64)]) -> Result<()> {
    for (source, dest, size) in jobs {
        if already_materialized(dest, *size)? {
            continue;
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|src| io_err(parent, src))?;
        }
        std::fs::copy(source, dest).map_err(|src| io_err(dest, src))?;
    }
    Ok(())
}

fn already_materialized(dest: &Path, size: u64) -> Result<bool> {
    match std::fs::metadata(dest) {
        Ok(meta) => Ok(meta.is_file() && meta.len() == size),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(source) => Err(io_err(dest, source)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aurora_base::retry::RetryPolicy;
    use aurora_download::{DownloadPool, Downloader};
    use aurora_version::{OsName, RuntimeContext};

    fn version_with(asset_index: Option<&str>, assets: Option<&str>) -> VersionJson {
        let mut json = serde_json::json!({ "id": "1.6.4" });
        if let Some(id) = asset_index {
            json["assetIndex"] =
                serde_json::json!({ "id": id, "sha1": "s", "size": 1, "url": "u" });
        }
        if let Some(assets) = assets {
            json["assets"] = serde_json::json!(assets);
        }
        serde_json::from_value(json).unwrap()
    }

    fn virtual_index(objects: &[(&str, &str, u64)]) -> AssetObjectsIndex {
        let mut index = AssetObjectsIndex {
            is_virtual: true,
            ..Default::default()
        };
        for (name, hash, size) in objects {
            index.objects.insert(
                (*name).to_owned(),
                aurora_version::AssetObject {
                    hash: (*hash).to_owned(),
                    size: *size,
                },
            );
        }
        index
    }

    /// 已物化且大小一致的对象不再拷贝：把目标改成同大小的其它内容，物化后内容不变即证明跳过了；
    /// 大小不同的则被覆盖回正确内容。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn materialize_skips_existing_objects_of_matching_size() {
        let dir = tempfile::tempdir().unwrap();
        let layout = crate::layout::GameLayout::new(dir.path());
        let client = aurora_base::http::build_client().unwrap();
        let pool = DownloadPool::new(Downloader::with_defaults(client.clone()), 2);
        let runtime = RuntimeContext::new(OsName::Windows, "x86_64", 64);
        let policy = RetryPolicy::default();
        let cx = InstallContext::new(&client, &pool, &layout, &runtime, &policy);

        let (a_hash, b_hash) = ("aa11", "bb22");
        for (hash, body) in [(a_hash, b"AAAA".as_slice()), (b_hash, b"BBBBBB".as_slice())] {
            let p = layout.asset_object_path(hash);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, body).unwrap();
        }
        let index = virtual_index(&[("a.txt", a_hash, 4), ("sub/b.txt", b_hash, 6)]);
        let version = version_with(Some("pre-1.6"), None);
        let target = layout.asset_virtual_dir("pre-1.6").unwrap();

        std::fs::create_dir_all(target.join("sub")).unwrap();
        std::fs::write(target.join("a.txt"), b"zzzz").unwrap();
        std::fs::write(target.join("sub").join("b.txt"), b"short").unwrap();

        materialize_assets(cx, &version, &index).await.unwrap();
        assert_eq!(std::fs::read(target.join("a.txt")).unwrap(), b"zzzz");
        assert_eq!(
            std::fs::read(target.join("sub").join("b.txt")).unwrap(),
            b"BBBBBB"
        );
    }

    /// 两个任务同时展开同一份旧版资源，后到的一方在先到的一方拷到一半时开始：展开目录是共享的，后到的一方不能
    /// 把拷到一半的文件当成已就绪提前返回，也不能撞上它报错，要等它拷完。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_later_materialization_waits_for_the_file_being_copied() {
        const OBJECT_LEN: usize = 256 * 1024 * 1024;
        let dir = tempfile::tempdir().unwrap();
        let layout = crate::layout::GameLayout::new(dir.path());
        let client = aurora_base::http::build_client().unwrap();
        let pool = DownloadPool::new(Downloader::with_defaults(client.clone()), 2);
        let runtime = RuntimeContext::new(OsName::Windows, "x86_64", 64);
        let policy = RetryPolicy::default();
        let cx = InstallContext::new(&client, &pool, &layout, &runtime, &policy);

        let path = layout.asset_object_path("aa11");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, vec![b'x'; OBJECT_LEN]).unwrap();
        let index = virtual_index(&[("big.bin", "aa11", OBJECT_LEN as u64)]);
        let version = version_with(Some("pre-1.6"), None);
        let dest = layout.asset_virtual_dir("pre-1.6").unwrap().join("big.bin");

        let first_done = std::sync::atomic::AtomicBool::new(false);
        let first = async {
            materialize_assets(cx, &version, &index).await.unwrap();
            first_done.store(true, std::sync::atomic::Ordering::SeqCst);
        };
        let second = async {
            while !dest.exists() {
                tokio::task::yield_now().await;
            }
            materialize_assets(cx, &version, &index).await.unwrap();
            assert!(
                first_done.load(std::sync::atomic::Ordering::SeqCst),
                "后到的一方在文件拷完之前就返回了"
            );
        };
        tokio::join!(first, second);
        assert_eq!(std::fs::metadata(&dest).unwrap().len(), OBJECT_LEN as u64);
    }

    /// 只有坐标和仓库地址的库在盘上就算就绪，补全不再按坐标重拉（旧版 Forge 的通用 jar 在仓库里是
    /// 404）；缺的照常下载，带 sha1 的照常校验。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn present_libraries_without_checksums_are_not_fetched_again() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/net/minecraftforge/forge/1.8.9-11.15.1.2318-1.8.9/forge-1.8.9-11.15.1.2318-1.8.9.jar"))
            .respond_with(ResponseTemplate::new(404))
            .expect(0)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path(
                "/org/scala-lang/scala-library/2.11.1/scala-library-2.11.1.jar",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"scala".to_vec()))
            .expect(1)
            .mount(&server)
            .await;
        let base = format!("{}/", server.uri());
        let version: VersionJson = serde_json::from_value(serde_json::json!({
            "id": "1.8.9-forge",
            "libraries": [
                {"name": "net.minecraftforge:forge:1.8.9-11.15.1.2318-1.8.9", "url": base},
                {"name": "org.scala-lang:scala-library:2.11.1", "url": base}
            ]
        }))
        .unwrap();

        let dir = tempfile::tempdir().unwrap();
        let layout = crate::layout::GameLayout::new(dir.path());
        let universal = layout
            .library_path_for_coordinate("net.minecraftforge:forge:1.8.9-11.15.1.2318-1.8.9")
            .unwrap();
        std::fs::create_dir_all(universal.parent().unwrap()).unwrap();
        std::fs::write(&universal, b"universal").unwrap();
        let client = aurora_base::http::build_client().unwrap();
        let pool = DownloadPool::new(Downloader::with_defaults(client.clone()), 2);
        let runtime = RuntimeContext::new(OsName::Windows, "x86_64", 64);
        let policy = RetryPolicy::default();
        let cx = InstallContext::new(&client, &pool, &layout, &runtime, &policy);

        let report = ensure_complete(cx, &version, "1.8.9-forge").await.unwrap();

        assert_eq!(report.libraries, 2, "两个库都算确保就绪");
        assert_eq!(std::fs::read(&universal).unwrap(), b"universal");
        let scala = layout
            .library_path_for_coordinate("org.scala-lang:scala-library:2.11.1")
            .unwrap();
        assert_eq!(std::fs::read(scala).unwrap(), b"scala");
    }

    /// Fabric meta 的库条目在顶层写了 sha1 与大小：盘上那份损坏时补全按校验值认出来并重下，不当成
    /// 「只有坐标、在盘即用」的条目跳过。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_corrupt_library_with_a_declared_sha1_is_fetched_again() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        const BODY: &[u8] = b"loader-jar";
        const BODY_SHA1: &str = "159aa9fb9ff44707d319d307019efa372dac582c";
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(
                "/net/fabricmc/fabric-loader/0.16.9/fabric-loader-0.16.9.jar",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(BODY.to_vec()))
            .expect(1)
            .mount(&server)
            .await;
        let version: VersionJson = serde_json::from_value(serde_json::json!({
            "id": "fabric-loader-0.16.9-1.20.1",
            "libraries": [{
                "name": "net.fabricmc:fabric-loader:0.16.9",
                "url": format!("{}/", server.uri()),
                "sha1": BODY_SHA1,
                "size": BODY.len()
            }]
        }))
        .unwrap();

        let dir = tempfile::tempdir().unwrap();
        let layout = crate::layout::GameLayout::new(dir.path());
        let jar = layout
            .library_path_for_coordinate("net.fabricmc:fabric-loader:0.16.9")
            .unwrap();
        std::fs::create_dir_all(jar.parent().unwrap()).unwrap();
        std::fs::write(&jar, b"truncated").unwrap();
        let client = aurora_base::http::build_client().unwrap();
        let pool = DownloadPool::new(Downloader::with_defaults(client.clone()), 2);
        let runtime = RuntimeContext::new(OsName::Windows, "x86_64", 64);
        let policy = RetryPolicy::default();
        let cx = InstallContext::new(&client, &pool, &layout, &runtime, &policy);

        ensure_complete(cx, &version, "fabric-loader-0.16.9-1.20.1")
            .await
            .unwrap();

        assert_eq!(std::fs::read(&jar).unwrap(), BODY);
    }

    /// virtual 布局却既没有 assetIndex 也没有 assets 字段：报缺少资源索引，而不是物化到
    /// `assets/virtual/` 根目录下。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn virtual_layout_without_index_id_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let layout = crate::layout::GameLayout::new(dir.path());
        let client = aurora_base::http::build_client().unwrap();
        let pool = DownloadPool::new(Downloader::with_defaults(client.clone()), 2);
        let runtime = RuntimeContext::new(OsName::Windows, "x86_64", 64);
        let policy = RetryPolicy::default();
        let cx = InstallContext::new(&client, &pool, &layout, &runtime, &policy);

        let index = virtual_index(&[("a.txt", "aa11", 4)]);
        let err = materialize_assets(cx, &version_with(None, None), &index)
            .await
            .unwrap_err();
        assert!(matches!(err, Error::MissingAssetIndex { ref version } if version == "1.6.4"));
        assert!(!layout.assets_dir().join("virtual").exists());
    }

    fn sha1_of(bytes: &[u8]) -> String {
        use sha1::{Digest, Sha1};
        base16ct::lower::encode_string(&Sha1::digest(bytes))
    }

    /// 递归列出目录下的全部文件。
    fn files_under(dir: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(current) = stack.pop() {
            for entry in std::fs::read_dir(&current).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    stack.push(path);
                } else {
                    out.push(path);
                }
            }
        }
        out
    }

    struct Sandbox {
        // 整个测试只碰这个临时目录：游戏目录在它下面两层，越界写入会落在临时目录里、被 files_under 看到。
        tmp: tempfile::TempDir,
        layout: crate::layout::GameLayout,
        client: reqwest::Client,
        pool: DownloadPool,
        runtime: RuntimeContext,
        policy: RetryPolicy,
    }

    impl Sandbox {
        fn new() -> Self {
            let tmp = tempfile::tempdir().unwrap();
            let root = tmp.path().join("sandbox").join("game");
            std::fs::create_dir_all(&root).unwrap();
            let client = aurora_base::http::build_client().unwrap();
            Self {
                layout: crate::layout::GameLayout::new(root),
                pool: DownloadPool::new(Downloader::with_defaults(client.clone()), 2),
                client,
                tmp,
                runtime: RuntimeContext::new(OsName::Windows, "x86_64", 64),
                policy: RetryPolicy::default(),
            }
        }

        fn cx(&self) -> InstallContext<'_> {
            InstallContext::new(
                &self.client,
                &self.pool,
                &self.layout,
                &self.runtime,
                &self.policy,
            )
        }
    }

    /// 远端版本 JSON 的库路径或坐标带着 `..`：补全在算落点时就拒掉，一个请求都不发，临时目录里一个文件都
    /// 不落（修复前这份带合法 sha1 的文件会写到游戏目录之外的 `<临时目录>/escaped.jar`）。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn escaping_library_entries_write_nothing_anywhere() {
        use wiremock::matchers::method;
        use wiremock::{Mock, MockServer, ResponseTemplate};

        const BODY: &[u8] = b"payload";
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(BODY.to_vec()))
            .expect(0)
            .mount(&server)
            .await;
        let base = format!("{}/", server.uri());
        let entries = [
            serde_json::json!({
                "name": "com.example:evil:1.0",
                "downloads": {"artifact": {
                    "path": "../../../escaped.jar",
                    "sha1": sha1_of(BODY), "size": BODY.len(),
                    "url": format!("{base}escaped.jar")
                }}
            }),
            serde_json::json!({
                "name": "evil:x:1/../../../../escaped",
                "url": base,
                "sha1": sha1_of(BODY), "size": BODY.len()
            }),
        ];
        for library in entries {
            let sandbox = Sandbox::new();
            let version: VersionJson = serde_json::from_value(serde_json::json!({
                "id": "evil", "libraries": [library.clone()]
            }))
            .unwrap();

            let err = ensure_complete(sandbox.cx(), &version, "evil")
                .await
                .unwrap_err();

            assert!(
                matches!(&err, Error::UnsafePath { entry, .. } if entry.starts_with("库 ")),
                "{library}: {err:?}"
            );
            assert_eq!(files_under(sandbox.tmp.path()), Vec::<PathBuf>::new());
        }
    }

    /// 补全的落点版本 id 来自远端版本 JSON（原版安装）：带分隔符或 `..` 的 id 直接拒掉。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_escaping_target_id_is_rejected_before_anything_is_written() {
        let sandbox = Sandbox::new();
        let version: VersionJson = serde_json::from_value(serde_json::json!({
            "id": "../../escaped",
            "downloads": {"client": {"sha1": "s", "size": 1, "url": "https://example.com/c.jar"}}
        }))
        .unwrap();

        let err = ensure_complete(sandbox.cx(), &version, "../../escaped")
            .await
            .unwrap_err();

        assert!(matches!(
            &err,
            Error::UnsafePath { entry, path, problem: aurora_version::UnsafePath::Separator }
                if entry == "版本 id" && path == "../../escaped"
        ));
        assert_eq!(files_under(sandbox.tmp.path()), Vec::<PathBuf>::new());
    }

    fn forge_with_bundled(sha1: &str, size: usize) -> VersionJson {
        serde_json::from_value(serde_json::json!({
            "id": "1.16.5-forge-36.2.39",
            "libraries": [{
                "name": "net.minecraftforge:forge:1.16.5-36.2.39",
                "downloads": {"artifact": {
                    "path": "net/minecraftforge/forge/1.16.5-36.2.39/forge-1.16.5-36.2.39.jar",
                    "url": "", "sha1": sha1, "size": size
                }}
            }]
        }))
        .unwrap()
    }

    /// 加载器安装器自带的库被删掉后补全：报只能重装加载器，而不是把空地址交给下载引擎报地址解析失败。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_deleted_bundled_loader_library_reports_loader_library_missing() {
        const SHIM: &[u8] = b"forge-shim";
        let sandbox = Sandbox::new();
        let version = forge_with_bundled(&sha1_of(SHIM), SHIM.len());
        let jar = sandbox
            .layout
            .library_path("net/minecraftforge/forge/1.16.5-36.2.39/forge-1.16.5-36.2.39.jar");

        let err = ensure_complete(sandbox.cx(), &version, "1.16.5-forge-36.2.39")
            .await
            .unwrap_err();

        assert!(
            matches!(&err, Error::LoaderLibraryMissing { path } if *path == jar),
            "{err:?}"
        );
        assert_eq!(
            err.to_string(),
            "加载器自带的库 forge-1.16.5-36.2.39.jar 缺失或已损坏，它只能由加载器安装器生成，需要重新安装加载器"
        );
        assert!(!jar.exists());
    }

    /// 盘上那份对得上就照常补全；被改坏（大小相同、内容不同）同样报缺失，不留着坏文件当已就绪。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_bundled_loader_library_on_disk_is_checked_by_sha1() {
        const SHIM: &[u8] = b"forge-shim";
        let sandbox = Sandbox::new();
        let version = forge_with_bundled(&sha1_of(SHIM), SHIM.len());
        let jar = sandbox
            .layout
            .library_path("net/minecraftforge/forge/1.16.5-36.2.39/forge-1.16.5-36.2.39.jar");
        std::fs::create_dir_all(jar.parent().unwrap()).unwrap();
        std::fs::write(&jar, SHIM).unwrap();

        let report = ensure_complete(sandbox.cx(), &version, "1.16.5-forge-36.2.39")
            .await
            .unwrap();
        assert_eq!(report.libraries, 1);
        assert_eq!(std::fs::read(&jar).unwrap(), SHIM);

        std::fs::write(&jar, b"forge-shiM").unwrap();
        let err = ensure_complete(sandbox.cx(), &version, "1.16.5-forge-36.2.39")
            .await
            .unwrap_err();
        assert!(matches!(&err, Error::LoaderLibraryMissing { path } if *path == jar));
    }

    #[test]
    fn missing_tasks_without_an_address_are_reported_as_loader_libraries() {
        let fetchable = DownloadTask::new("https://libraries.minecraft.net/a.jar", "/mc/a.jar");
        let bundled = DownloadTask::new("", "/mc/libraries/forge.jar").with_sha1("aa");
        assert!(reject_missing_bundled(std::slice::from_ref(&fetchable)).is_ok());
        assert!(matches!(
            reject_missing_bundled(&[fetchable, bundled]),
            Err(Error::LoaderLibraryMissing { path }) if path == Path::new("/mc/libraries/forge.jar")
        ));
    }
}
