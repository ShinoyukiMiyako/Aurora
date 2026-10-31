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

use std::path::{Path, PathBuf};

use aurora_download::DownloadTask;
use aurora_version::{AssetLayout, AssetObjectsIndex, VersionJson};

use crate::context::InstallContext;
use crate::error::{Error, Result, io_err};
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
    // 第一批：库 + 日志配置 + 客户端 jar + assetIndex（都并入一池）。
    let library_tasks = plan::library_tasks(version, cx.runtime, cx.layout)?;
    let libraries = library_tasks.len();
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

    if let Some(log) = plan::logging_task(version, cx.layout) {
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
        let object_tasks = plan::asset_object_tasks(&index, cx.layout);
        let count = object_tasks.len();
        cx.run_batch(object_tasks, "补全资源", None).await?;
        materialize_assets(cx, version, &index).await?;
        count
    } else {
        0
    };

    // natives 解压到 target 版本的 natives 目录。
    let natives = natives::extract_all_natives(version, cx.runtime, cx.layout, target_id).await?;

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
    let path = cx.layout.asset_index_json(&index_id);
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|source| io_err(&path, source))?;
    net::parse_json(&bytes, "资源索引")
}

/// 对 virtual / map_to_resources 布局，把 objects 里的对象按逻辑名物化到展开目录。
///
/// 这两种布局只出现在 1.7.2 及更早的版本，一份索引几百到上千个对象，每次补全都会走到这里；
/// 目标已存在且大小与索引一致的直接跳过，整段放到阻塞线程池里用同步 IO 做完。
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
            cx.layout.asset_virtual_dir(&index_id)
        }
        AssetLayout::MapToResources => cx.layout.resources_dir(),
    };

    let jobs: Vec<(PathBuf, PathBuf, u64)> = index
        .objects
        .iter()
        .map(|(logical, object)| {
            (
                cx.layout.asset_object_path(&object.hash),
                target_dir.join(crate::layout::rel_to_path(logical)),
                object.size,
            )
        })
        .collect();
    tokio::task::spawn_blocking(move || copy_missing(&jobs))
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
        let target = layout.asset_virtual_dir("pre-1.6");

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
}
