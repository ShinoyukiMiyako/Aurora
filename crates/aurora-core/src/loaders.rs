//! 加载器的可用版本、版本清单里每个游戏版本支持哪些加载器，以及新实例需要的 Java 与下载体积。
//!
//! 版本清单与加载器列表都是远端元数据，断网时新建实例页不该整页报错：每次拉取成功就把结果写进
//! `<缓存目录>/meta/`，拉取失败时退回上次的缓存，并把「用的是哪天的缓存、为什么没拉到」一并交给
//! 调用方展示。没有缓存可退时照常报错。
//!
//! 加载器支持的游戏版本：Fabric / Quilt 的 meta 有现成接口；Forge / NeoForge 只有 Maven 元数据，
//! 由 [`aurora_install::forge_versions`] 从构建版本号里推出游戏版本。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use aurora_install::{
    FORGE_MAVEN_METADATA, LoaderBuild, LoaderFlavor, LoaderInstaller,
    NEOFORGE_LEGACY_MAVEN_METADATA, NEOFORGE_MAVEN_METADATA, VanillaInstaller, builds_for,
    fetch_maven_versions, forge_builds, neoforge_builds,
};
use aurora_version::{RuntimeContext, VersionJson, VersionManifest, select_libraries};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::task::JoinSet;

use crate::error::Result;
use crate::facade::{Aurora, make_context};
use crate::install::LoaderChoice;
use crate::instances::LEGACY_JAVA_MAJOR;

/// 已查过的「游戏版本 -> 新建要求」。版本 JSON 发布后不再变，进程内记住即可。
static VERSION_REQUIREMENTS: LazyLock<Mutex<HashMap<String, VersionRequirements>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 新建某个游戏版本的实例前要知道的两件事。版本清单本身不带这些，要读该版本的 JSON。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VersionRequirements {
    /// 版本 JSON 的 `javaVersion`，没有则为 8。
    pub java_major: u32,
    /// 全新下载的字节数：客户端 jar、本机适用的库与 natives、资源索引与全部资源文件、日志配置。
    /// 不含 Java 运行时与加载器，也不扣除本地已有的文件；版本 JSON 有一项没标大小时为 `None`。
    pub download_bytes: Option<u64>,
}

/// 一个可选的加载器版本。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LoaderVersionInfo {
    pub version: String,
    /// 稳定版（版本号里没有 beta / alpha / rc / pre，Fabric 以 meta 给出的为准）。
    pub stable: bool,
}

/// 加载器元数据的地址。生产取各官方地址，测试指向本地 mock。
#[derive(Debug, Clone)]
pub struct LoaderEndpoints {
    pub fabric_base: String,
    pub quilt_base: String,
    pub forge_metadata: String,
    pub neoforge_metadata: String,
    pub neoforge_legacy_metadata: String,
}

/// 新建实例页要的版本清单：清单本身、每个游戏版本可装的加载器，以及离线时的说明。
#[derive(Debug, Clone, PartialEq)]
pub struct ManifestOverview {
    pub manifest: VersionManifest,
    /// 游戏版本 id -> 支持它的加载器（按 [`LoaderChoice::ALL`] 的顺序）。
    pub loaders: HashMap<String, Vec<LoaderChoice>>,
    /// 拉不到、也没有缓存的加载器及原因；这些加载器在 `loaders` 里一律缺席。
    pub loader_errors: Vec<(LoaderChoice, String)>,
    /// 有部分数据来自缓存时，其中最旧那份的写入时刻（Unix 毫秒）。
    pub stale_since: Option<u64>,
    /// 退回缓存的原因（第一处拉取失败的错误原文）。
    pub fetch_error: Option<String>,
}

/// 拉取结果：新鲜的，或退回的缓存。
struct Fetched<T> {
    data: T,
    stale: Option<(u64, String)>,
}

#[derive(Serialize, Deserialize)]
struct CacheEntry<T> {
    fetched_at: u64,
    data: T,
}

impl Aurora {
    /// 生产用的加载器元数据地址。
    pub fn loader_endpoints(&self) -> LoaderEndpoints {
        LoaderEndpoints {
            fabric_base: self.fabric_base().to_owned(),
            quilt_base: self.quilt_base().to_owned(),
            forge_metadata: FORGE_MAVEN_METADATA.to_owned(),
            neoforge_metadata: NEOFORGE_MAVEN_METADATA.to_owned(),
            neoforge_legacy_metadata: NEOFORGE_LEGACY_MAVEN_METADATA.to_owned(),
        }
    }

    /// 元数据缓存目录：配置了自定义缓存目录就用它，否则在数据目录下。
    pub fn meta_cache_dir(&self) -> PathBuf {
        self.config()
            .cache_directory
            .clone()
            .unwrap_or_else(|| self.data_dir().join("cache"))
            .join("meta")
    }

    /// 某加载器对某游戏版本的全部可用版本，新的在前。没有可用版本时为空列表。
    pub async fn list_loader_versions(
        &self,
        loader: LoaderChoice,
        mc_version: &str,
    ) -> Result<Vec<LoaderVersionInfo>> {
        self.list_loader_versions_at(&self.loader_endpoints(), loader, mc_version)
            .await
    }

    pub(crate) async fn list_loader_versions_at(
        &self,
        endpoints: &LoaderEndpoints,
        loader: LoaderChoice,
        mc_version: &str,
    ) -> Result<Vec<LoaderVersionInfo>> {
        match loader {
            LoaderChoice::Fabric | LoaderChoice::Quilt => {
                let name = cache_name(&format!("{}-loaders-{mc_version}", loader.key()));
                let fetched = self
                    .fetch_or_cached(name.as_deref(), async {
                        let layout = self.layout();
                        let pool = self.download_pool();
                        let policy = self.retry_policy();
                        let http = self.http();
                        let cx = make_context(
                            &http,
                            &pool,
                            &layout,
                            self.runtime(),
                            &policy,
                            self.cancel_token(),
                        );
                        let (flavor, base) = flavor_and_base(endpoints, loader);
                        let loaders = LoaderInstaller::with_flavor(cx, flavor)
                            .with_base_url(base)
                            .with_sources(self.source_plan(self.config().version_list_source))
                            .list_loaders(mc_version)
                            .await?;
                        Ok(loaders
                            .into_iter()
                            .map(|l| LoaderVersionInfo {
                                version: l.version,
                                stable: l.stable,
                            })
                            .collect::<Vec<_>>())
                    })
                    .await?;
                Ok(fetched.data)
            }
            LoaderChoice::Forge | LoaderChoice::NeoForge => {
                let builds = self.maven_builds(endpoints, loader).await?.data;
                Ok(builds_for(&builds, mc_version)
                    .into_iter()
                    .map(|build| LoaderVersionInfo {
                        stable: build.stable(),
                        version: build.version,
                    })
                    .collect())
            }
        }
    }

    /// 版本清单，附带每个游戏版本支持的加载器。清单与各加载器列表并行拉取，单个加载器失败不影响其余。
    pub async fn manifest_overview(&self) -> Result<ManifestOverview> {
        self.manifest_overview_at(&self.loader_endpoints()).await
    }

    pub(crate) async fn manifest_overview_at(
        &self,
        endpoints: &LoaderEndpoints,
    ) -> Result<ManifestOverview> {
        let mut set = JoinSet::new();
        for choice in LoaderChoice::ALL {
            let me = self.clone();
            let endpoints = endpoints.clone();
            set.spawn(
                async move { (choice, me.supported_game_versions(&endpoints, choice).await) },
            );
        }
        let manifest = self
            .fetch_or_cached(Some("version_manifest_v2"), async {
                self.list_manifest().await
            })
            .await?;

        let mut stale: Vec<(u64, String)> = manifest.stale.into_iter().collect();
        let mut per_loader: BTreeMap<usize, (LoaderChoice, Vec<String>)> = BTreeMap::new();
        let mut loader_errors = Vec::new();
        while let Some(joined) = set.join_next().await {
            let (choice, outcome) = joined?;
            match outcome {
                Ok(fetched) => {
                    stale.extend(fetched.stale);
                    let order = LoaderChoice::ALL
                        .iter()
                        .position(|c| *c == choice)
                        .expect("choice 来自 ALL");
                    per_loader.insert(order, (choice, fetched.data));
                }
                Err(err) if err.is_cancelled() => return Err(err),
                Err(err) => {
                    tracing::warn!(loader = choice.key(), error = %err, "加载器支持列表拉取失败");
                    loader_errors.push((choice, err.to_string()));
                }
            }
        }
        loader_errors.sort_by_key(|(choice, _)| choice.key());

        let mut loaders: HashMap<String, Vec<LoaderChoice>> = HashMap::new();
        for (choice, versions) in per_loader.into_values() {
            for version in versions {
                loaders.entry(version).or_default().push(choice);
            }
        }
        let oldest = stale.iter().min_by_key(|(at, _)| *at).cloned();
        Ok(ManifestOverview {
            manifest: manifest.data,
            loaders,
            loader_errors,
            stale_since: oldest.as_ref().map(|(at, _)| *at),
            fetch_error: stale.into_iter().next().map(|(_, error)| error),
        })
    }

    /// 新建这个游戏版本的实例需要的 Java 主版本（版本 JSON 的 `javaVersion`，没有则为 8）。
    pub async fn required_java(&self, mc_version: &str) -> Result<u32> {
        Ok(self.version_requirements(mc_version).await?.java_major)
    }

    /// 新建这个游戏版本的实例要的 Java 主版本与全新下载的体积。每个版本只取一次版本 JSON，
    /// 之后走进程内缓存；版本清单里没有这个版本报 `InstallerEntryMissing`。
    pub async fn version_requirements(&self, mc_version: &str) -> Result<VersionRequirements> {
        if let Some(known) = VERSION_REQUIREMENTS
            .lock()
            .expect("版本要求缓存的锁已中毒")
            .get(mc_version)
        {
            return Ok(*known);
        }
        let layout = self.layout();
        let pool = self.download_pool();
        let policy = self.retry_policy();
        let http = self.http();
        let cx = make_context(
            &http,
            &pool,
            &layout,
            self.runtime(),
            &policy,
            self.cancel_token(),
        );
        let installer = VanillaInstaller::new(cx)
            .with_manifest_url(self.manifest_url())
            .with_sources(self.source_plan(self.config().version_list_source));
        let entry = installer.find_entry(mc_version).await?;
        let json = installer.fetch_version_json(&entry).await?;
        let requirements = VersionRequirements {
            java_major: json
                .java_version
                .as_ref()
                .map_or(LEGACY_JAVA_MAJOR, |java| java.major_version),
            download_bytes: download_bytes(&json, self.runtime()),
        };
        VERSION_REQUIREMENTS
            .lock()
            .expect("版本要求缓存的锁已中毒")
            .insert(mc_version.to_owned(), requirements);
        Ok(requirements)
    }

    /// 某加载器支持的全部游戏版本。
    async fn supported_game_versions(
        &self,
        endpoints: &LoaderEndpoints,
        loader: LoaderChoice,
    ) -> Result<Fetched<Vec<String>>> {
        match loader {
            LoaderChoice::Fabric | LoaderChoice::Quilt => {
                let name = format!("{}-game-versions", loader.key());
                self.fetch_or_cached(Some(&name), async {
                    let layout = self.layout();
                    let pool = self.download_pool();
                    let policy = self.retry_policy();
                    let http = self.http();
                    let cx = make_context(
                        &http,
                        &pool,
                        &layout,
                        self.runtime(),
                        &policy,
                        self.cancel_token(),
                    );
                    let (flavor, base) = flavor_and_base(endpoints, loader);
                    let versions = LoaderInstaller::with_flavor(cx, flavor)
                        .with_base_url(base)
                        .with_sources(self.source_plan(self.config().version_list_source))
                        .list_game_versions()
                        .await?;
                    Ok(versions.into_iter().map(|v| v.version).collect())
                })
                .await
            }
            LoaderChoice::Forge | LoaderChoice::NeoForge => {
                let fetched = self.maven_builds(endpoints, loader).await?;
                let mut seen = HashSet::new();
                let versions = fetched
                    .data
                    .into_iter()
                    .filter_map(|build| {
                        seen.insert(build.mc_version.clone())
                            .then_some(build.mc_version)
                    })
                    .collect();
                Ok(Fetched {
                    data: versions,
                    stale: fetched.stale,
                })
            }
        }
    }

    /// Forge / NeoForge 的全部构建（从 Maven 元数据推出对应游戏版本）。
    async fn maven_builds(
        &self,
        endpoints: &LoaderEndpoints,
        loader: LoaderChoice,
    ) -> Result<Fetched<Vec<LoaderBuild>>> {
        let name = format!("{}-builds", loader.key());
        self.fetch_or_cached(Some(&name), async {
            let http = self.http();
            let policy = self.retry_policy();
            let sources = self.source_plan(self.config().version_list_source);
            let builds = match loader {
                LoaderChoice::Forge => {
                    let versions = fetch_maven_versions(
                        &http,
                        Some(&sources),
                        &endpoints.forge_metadata,
                        &policy,
                        self.cancel_token(),
                    )
                    .await?;
                    forge_builds(&versions)
                }
                _ => {
                    let modern = fetch_maven_versions(
                        &http,
                        Some(&sources),
                        &endpoints.neoforge_metadata,
                        &policy,
                        self.cancel_token(),
                    )
                    .await?;
                    let legacy = fetch_maven_versions(
                        &http,
                        Some(&sources),
                        &endpoints.neoforge_legacy_metadata,
                        &policy,
                        self.cancel_token(),
                    )
                    .await?;
                    neoforge_builds(&modern, &legacy)
                }
            };
            Ok(builds)
        })
        .await
    }

    /// 拉取成功写缓存；失败（取消除外）退回缓存，没有缓存时报原错误。`name` 为 `None` 时不缓存。
    async fn fetch_or_cached<T>(
        &self,
        name: Option<&str>,
        fetch: impl Future<Output = Result<T>>,
    ) -> Result<Fetched<T>>
    where
        T: Serialize + DeserializeOwned,
    {
        let Some(name) = name else {
            return Ok(Fetched {
                data: fetch.await?,
                stale: None,
            });
        };
        let path = self.meta_cache_dir().join(format!("{name}.json"));
        match fetch.await {
            Ok(data) => {
                let entry = CacheEntry {
                    fetched_at: now_millis(),
                    data,
                };
                // 缓存只是断网时的退路：写不进去不影响这次已经拿到的结果，记一笔日志即可。
                match serde_json::to_vec(&entry) {
                    Ok(bytes) => {
                        if let Err(err) = aurora_base::fs::atomic_write(&path, &bytes).await {
                            tracing::warn!(path = %path.display(), error = %err, "元数据缓存写入失败");
                        }
                    }
                    Err(err) => {
                        tracing::warn!(path = %path.display(), error = %err, "元数据缓存序列化失败")
                    }
                }
                Ok(Fetched {
                    data: entry.data,
                    stale: None,
                })
            }
            Err(err) if err.is_cancelled() => Err(err),
            Err(err) => match read_cache::<T>(&path).await {
                Ok(Some(cached)) => {
                    tracing::warn!(name, error = %err, fetched_at = cached.fetched_at, "元数据拉取失败，沿用缓存");
                    Ok(Fetched {
                        data: cached.data,
                        stale: Some((cached.fetched_at, err.to_string())),
                    })
                }
                Ok(None) => Err(err),
                Err(cache_err) => {
                    tracing::warn!(path = %path.display(), error = cache_err, "元数据缓存也读不出来");
                    Err(err)
                }
            },
        }
    }
}

fn flavor_and_base(endpoints: &LoaderEndpoints, loader: LoaderChoice) -> (LoaderFlavor, &str) {
    match loader {
        LoaderChoice::Quilt => (LoaderFlavor::Quilt, endpoints.quilt_base.as_str()),
        _ => (LoaderFlavor::Fabric, endpoints.fabric_base.as_str()),
    }
}

/// 原版版本 JSON 声明的全新下载体积；库只算本机生效的（规则求值、按坐标去重，与安装时同一口径），
/// 只给了 Maven 地址、没标大小的库让结果为 `None`，免得报一个偏小的数。
fn download_bytes(json: &VersionJson, ctx: &RuntimeContext) -> Option<u64> {
    let mut total = json.downloads.as_ref()?.client.as_ref()?.size;
    let index = json.asset_index.as_ref()?;
    total += index.size + index.total_size?;
    for library in select_libraries(json, ctx) {
        let downloads = library.downloads.as_ref()?;
        total += downloads
            .artifact
            .as_ref()
            .map_or(0, |artifact| artifact.size);
        total += library.native_artifact(ctx).map_or(0, |native| native.size);
    }
    if let Some(config) = json
        .logging
        .as_ref()
        .and_then(|logging| logging.client.as_ref())
    {
        total += config.file.size;
    }
    Some(total)
}

/// 游戏版本号来自前端，只有看起来像版本号（字母数字与 `.-_+`）时才拿来拼缓存文件名；否则不缓存。
fn cache_name(raw: &str) -> Option<String> {
    raw.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '+'))
        .then(|| raw.to_owned())
}

/// 读缓存。错误只用来记日志（调用方报的是拉取失败的原错误），故直接给出说明文字。
async fn read_cache<T: DeserializeOwned>(
    path: &std::path::Path,
) -> std::result::Result<Option<CacheEntry<T>>, String> {
    match tokio::fs::read(path).await {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|err| format!("缓存内容损坏：{err}")),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("读取缓存失败：{err}")),
    }
}

fn now_millis() -> u64 {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("系统时钟早于 1970-01-01");
    u64::try_from(elapsed.as_millis()).expect("毫秒数超出 u64")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::CoreError;
    use crate::instances::tests::aurora_at;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn endpoints(server: &MockServer) -> LoaderEndpoints {
        let base = server.uri();
        LoaderEndpoints {
            fabric_base: base.clone(),
            quilt_base: format!("{base}/quilt"),
            forge_metadata: format!("{base}/forge/maven-metadata.xml"),
            neoforge_metadata: format!("{base}/neoforge/maven-metadata.xml"),
            neoforge_legacy_metadata: format!("{base}/neoforge-legacy/maven-metadata.xml"),
        }
    }

    fn maven(versions: &[&str]) -> String {
        let body: String = versions
            .iter()
            .map(|v| format!("<version>{v}</version>"))
            .collect();
        format!("<metadata><versioning><versions>{body}</versions></versioning></metadata>")
    }

    async fn mount(server: &MockServer, route: &str, body: String) {
        Mock::given(method("GET"))
            .and(path(route.to_owned()))
            .respond_with(ResponseTemplate::new(200).set_body_string(body))
            .mount(server)
            .await;
    }

    async fn mount_all(server: &MockServer) {
        let base = server.uri();
        mount(
            server,
            "/manifest.json",
            format!(
                r#"{{"latest":{{"release":"1.21.1","snapshot":"1.21.1"}},"versions":[
                {{"id":"1.21.1","type":"release","url":"{base}/1.21.1.json","time":"t","releaseTime":"t"}},
                {{"id":"1.20.1","type":"release","url":"{base}/1.20.1.json","time":"t","releaseTime":"t"}},
                {{"id":"1.5.2","type":"release","url":"{base}/1.5.2.json","time":"t","releaseTime":"t"}}]}}"#
            ),
        )
        .await;
        mount(
            server,
            "/v2/versions/game",
            r#"[{"version":"1.21.1","stable":true},{"version":"1.20.1","stable":true}]"#.into(),
        )
        .await;
        mount(
            server,
            "/v2/versions/loader/1.21.1",
            r#"[{"loader":{"version":"0.16.10","stable":true}},{"loader":{"version":"0.16.9-beta","stable":false}}]"#
                .into(),
        )
        .await;
        mount(
            server,
            "/quilt/v3/versions/game",
            r#"[{"version":"1.21.1","stable":true}]"#.into(),
        )
        .await;
        mount(
            server,
            "/forge/maven-metadata.xml",
            maven(&["1.21.1-52.0.2", "1.20.1-47.3.0", "1.20.1-47.10.1"]),
        )
        .await;
        mount(
            server,
            "/neoforge/maven-metadata.xml",
            maven(&["21.1.9-beta", "21.1.77"]),
        )
        .await;
        mount(
            server,
            "/neoforge-legacy/maven-metadata.xml",
            maven(&["1.20.1-47.1.106"]),
        )
        .await;
        mount(
            server,
            "/1.21.1.json",
            crate::instances::tests::vanilla_json("1.21.1"),
        )
        .await;
        mount(
            server,
            "/1.5.2.json",
            r#"{"id":"1.5.2","type":"release","mainClass":"M"}"#.into(),
        )
        .await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn manifest_overview_lists_the_loaders_each_game_version_supports() {
        let server = MockServer::start().await;
        mount_all(&server).await;
        let tmp = tempfile::tempdir().unwrap();
        let aurora =
            aurora_at(tmp.path()).with_manifest_url(format!("{}/manifest.json", server.uri()));

        let overview = aurora
            .manifest_overview_at(&endpoints(&server))
            .await
            .unwrap();
        assert_eq!(overview.manifest.versions.len(), 3);
        assert_eq!(
            overview.loaders["1.21.1"],
            LoaderChoice::ALL.to_vec(),
            "四个加载器都支持 1.21.1，按固定顺序"
        );
        assert_eq!(
            overview.loaders["1.20.1"],
            vec![
                LoaderChoice::Fabric,
                LoaderChoice::Forge,
                LoaderChoice::NeoForge
            ]
        );
        assert!(!overview.loaders.contains_key("1.5.2"));
        assert!(overview.loader_errors.is_empty());
        assert_eq!(overview.stale_since, None);
        assert_eq!(overview.fetch_error, None);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn offline_overview_falls_back_to_the_cache_and_says_since_when() {
        let server = MockServer::start().await;
        mount_all(&server).await;
        let tmp = tempfile::tempdir().unwrap();
        let aurora =
            aurora_at(tmp.path()).with_manifest_url(format!("{}/manifest.json", server.uri()));
        let online = aurora
            .manifest_overview_at(&endpoints(&server))
            .await
            .unwrap();

        // 端点全部失效：清单与加载器列表都从缓存来。
        let dead = MockServer::start().await;
        let offline_aurora =
            aurora_at(tmp.path()).with_manifest_url(format!("{}/manifest.json", dead.uri()));
        let offline = offline_aurora
            .manifest_overview_at(&endpoints(&dead))
            .await
            .unwrap();
        assert_eq!(offline.manifest, online.manifest);
        assert_eq!(offline.loaders, online.loaders);
        assert!(offline.stale_since.is_some());
        assert!(offline.fetch_error.is_some());

        // 没有缓存可退时如实报错。
        let empty = tempfile::tempdir().unwrap();
        let err = aurora_at(empty.path())
            .with_manifest_url(format!("{}/manifest.json", dead.uri()))
            .manifest_overview_at(&endpoints(&dead))
            .await
            .unwrap_err();
        assert!(matches!(err, CoreError::Install(_)), "实际：{err:?}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn loader_versions_come_newest_first_with_stability() {
        let server = MockServer::start().await;
        mount_all(&server).await;
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora_at(tmp.path());
        let ep = endpoints(&server);

        let fabric = aurora
            .list_loader_versions_at(&ep, LoaderChoice::Fabric, "1.21.1")
            .await
            .unwrap();
        assert_eq!(
            fabric,
            vec![
                LoaderVersionInfo {
                    version: "0.16.10".into(),
                    stable: true
                },
                LoaderVersionInfo {
                    version: "0.16.9-beta".into(),
                    stable: false
                },
            ]
        );
        let forge = aurora
            .list_loader_versions_at(&ep, LoaderChoice::Forge, "1.20.1")
            .await
            .unwrap();
        let forge: Vec<&str> = forge.iter().map(|v| v.version.as_str()).collect();
        assert_eq!(forge, vec!["47.10.1", "47.3.0"], "按数字而不是字典序排");
        let neo = aurora
            .list_loader_versions_at(&ep, LoaderChoice::NeoForge, "1.21.1")
            .await
            .unwrap();
        assert_eq!(
            neo,
            vec![
                LoaderVersionInfo {
                    version: "21.1.77".into(),
                    stable: true
                },
                LoaderVersionInfo {
                    version: "21.1.9-beta".into(),
                    stable: false
                },
            ]
        );
        let legacy = aurora
            .list_loader_versions_at(&ep, LoaderChoice::NeoForge, "1.20.1")
            .await
            .unwrap();
        assert_eq!(legacy[0].version, "47.1.106");
        assert!(
            aurora
                .list_loader_versions_at(&ep, LoaderChoice::Forge, "1.5.2")
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn required_java_reads_the_version_json_and_defaults_to_8() {
        let server = MockServer::start().await;
        mount_all(&server).await;
        let tmp = tempfile::tempdir().unwrap();
        let aurora =
            aurora_at(tmp.path()).with_manifest_url(format!("{}/manifest.json", server.uri()));
        assert_eq!(aurora.required_java("1.21.1").await.unwrap(), 21);
        assert_eq!(
            aurora.required_java("1.5.2").await.unwrap(),
            LEGACY_JAVA_MAJOR
        );
        let err = aurora.required_java("9.9.9").await.unwrap_err();
        assert!(matches!(
            err,
            CoreError::Install(aurora_install::Error::InstallerEntryMissing { .. })
        ));
    }

    /// 体积按本机生效的库算：不适用于本系统的库与别的系统的 natives 不计；有库没标大小时给不出数。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn version_requirements_sum_what_a_fresh_install_downloads() {
        let server = MockServer::start().await;
        let base = server.uri();
        // 版本号取测试专用的，免得与别的用例共用进程内缓存。
        mount(
            &server,
            "/manifest.json",
            format!(
                r#"{{"latest":{{"release":"req-full","snapshot":"req-full"}},"versions":[
                {{"id":"req-full","type":"release","url":"{base}/req-full.json","time":"t","releaseTime":"t"}},
                {{"id":"req-maven","type":"release","url":"{base}/req-maven.json","time":"t","releaseTime":"t"}}]}}"#
            ),
        )
        .await;
        let tmp = tempfile::tempdir().unwrap();
        let aurora =
            aurora_at(tmp.path()).with_manifest_url(format!("{}/manifest.json", server.uri()));
        let os = aurora.runtime().os_name.as_mojang();
        let other_os = if os == "windows" { "osx" } else { "windows" };
        mount(
            &server,
            "/req-full.json",
            serde_json::json!({
                "id": "req-full", "type": "release", "mainClass": "M",
                "javaVersion": { "component": "java-runtime-delta", "majorVersion": 21 },
                "downloads": { "client": { "sha1": "c", "size": 1000, "url": "http://x/c.jar" } },
                "assetIndex": { "id": "17", "sha1": "i", "size": 300, "totalSize": 50_000, "url": "http://x/i.json" },
                "logging": { "client": {
                    "argument": "-Dlog4j.configurationFile=${path}",
                    "file": { "id": "client.xml", "sha1": "l", "size": 7, "url": "http://x/l.xml" },
                    "type": "log4j2-xml"
                } },
                "libraries": [
                    { "name": "a:common:1", "downloads": { "artifact": { "path": "a", "sha1": "1", "size": 20, "url": "http://x/a" } } },
                    // 同坐标第二次出现按去重只算一次。
                    { "name": "a:common:1", "downloads": { "artifact": { "path": "a", "sha1": "1", "size": 20, "url": "http://x/a" } } },
                    { "name": "a:elsewhere:1",
                      "rules": [{ "action": "allow", "os": { "name": other_os } }],
                      "downloads": { "artifact": { "path": "b", "sha1": "2", "size": 4000, "url": "http://x/b" } } },
                    { "name": "a:lwjgl:2",
                      "natives": { os: "natives-here", other_os: "natives-there" },
                      "downloads": {
                          "artifact": { "path": "c", "sha1": "3", "size": 3, "url": "http://x/c" },
                          "classifiers": {
                              "natives-here": { "path": "d", "sha1": "4", "size": 400, "url": "http://x/d" },
                              "natives-there": { "path": "e", "sha1": "5", "size": 90_000, "url": "http://x/e" }
                          }
                      } }
                ]
            })
            .to_string(),
        )
        .await;
        mount(
            &server,
            "/req-maven.json",
            r#"{"id":"req-maven","type":"release","mainClass":"M",
                "downloads":{"client":{"sha1":"c","size":1000,"url":"http://x/c.jar"}},
                "assetIndex":{"id":"17","sha1":"i","size":300,"totalSize":50000,"url":"http://x/i.json"},
                "libraries":[{"name":"a:maven-only:1","url":"https://maven.example/"}]}"#
                .into(),
        )
        .await;

        let full = aurora.version_requirements("req-full").await.unwrap();
        assert_eq!(full.java_major, 21);
        assert_eq!(
            full.download_bytes,
            Some(1000 + 300 + 50_000 + 7 + 20 + 3 + 400)
        );
        assert_eq!(aurora.required_java("req-full").await.unwrap(), 21);

        let maven = aurora.version_requirements("req-maven").await.unwrap();
        assert_eq!(maven.java_major, LEGACY_JAVA_MAJOR);
        assert_eq!(maven.download_bytes, None);
    }

    #[test]
    fn cache_names_only_accept_version_like_strings() {
        assert_eq!(
            cache_name("fabric-loaders-1.21.1").as_deref(),
            Some("fabric-loaders-1.21.1")
        );
        assert_eq!(cache_name("fabric-loaders-../x"), None);
        assert_eq!(cache_name("fabric-loaders-a b"), None);
    }

    /// 快照上的取消令牌一直传到加载器列表的元数据抓取（Fabric meta 经安装上下文，Forge 的 Maven
    /// 元数据直接传）：端点迟迟不回时 1 秒内以已取消返回，也不退回缓存冒充结果。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelling_a_loader_listing_returns_promptly_instead_of_the_cache() {
        use aurora_download::CancellationToken;
        use std::time::{Duration, Instant};

        let server = MockServer::start().await;
        mount_all(&server).await;
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora_at(tmp.path());
        let cases = [
            (LoaderChoice::Forge, "1.20.1"),
            (LoaderChoice::Fabric, "1.21.1"),
        ];
        // 先在线拉一遍，让缓存里有可退的数据。
        for (loader, mc) in cases {
            aurora
                .list_loader_versions_at(&endpoints(&server), loader, mc)
                .await
                .unwrap();
        }

        let stalled = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(10)))
            .mount(&stalled)
            .await;
        let stalled_endpoints = endpoints(&stalled);
        for (loader, mc) in cases {
            let token = CancellationToken::new();
            let snapshot = aurora.clone().with_cancel(token.clone());
            let listing = snapshot.list_loader_versions_at(&stalled_endpoints, loader, mc);
            tokio::pin!(listing);
            assert!(
                tokio::time::timeout(Duration::from_millis(300), &mut listing)
                    .await
                    .is_err(),
                "{loader:?}：端点没回应前不该结束"
            );
            let cancelled_at = Instant::now();
            token.cancel();
            let err = listing.await.unwrap_err();
            assert!(err.is_cancelled(), "{loader:?}：实际 {err:?}");
            assert!(
                cancelled_at.elapsed() < Duration::from_secs(1),
                "{loader:?}：取消后等了 {:?}",
                cancelled_at.elapsed()
            );
        }
    }
}
