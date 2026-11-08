//! 版本安装编排：原版补全 + 可选 Mod 加载器（Fabric / Quilt / Forge / NeoForge）。
//!
//! 门面把 petalfall-install 的原版安装器与加载器安装器串起来，按当前配置的下载源策略与并发跑批量下载，
//! 并在关键节点发出阶段事件。Fabric / Quilt 的 meta 服务直接合成版本 JSON，无需本地安装器；
//! Forge / NeoForge 则先读该版本要求的 Java 主版本、备妥运行时，再下载并执行官方 installer
//! （内含 processors 子进程），故这两者的分支多一步 Java 解析。

use petalfall_install::{
    ForgeInstaller, InstallContext, LoaderInstaller, LoaderSummary, VanillaInstaller,
    VanillaSummary, forge_installer_url, neoforge_installer_url,
};
use petalfall_version::VersionJson;

use crate::error::Result;
use crate::event::{CoreEvent, EventSink, emit};
use crate::facade::{Petalfall, make_context};

/// 可安装的 Mod 加载器选择。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoaderChoice {
    /// Fabric。
    Fabric,
    /// Quilt。
    Quilt,
    /// Forge。
    Forge,
    /// NeoForge。
    NeoForge,
}

impl LoaderChoice {
    /// 加载器显示名（专有名词保留原文）。
    pub fn display_name(self) -> &'static str {
        match self {
            LoaderChoice::Fabric => "Fabric",
            LoaderChoice::Quilt => "Quilt",
            LoaderChoice::Forge => "Forge",
            LoaderChoice::NeoForge => "NeoForge",
        }
    }

    /// IPC 参数与未完成标记里用的小写键。
    pub fn key(self) -> &'static str {
        match self {
            LoaderChoice::Fabric => "fabric",
            LoaderChoice::Quilt => "quilt",
            LoaderChoice::Forge => "forge",
            LoaderChoice::NeoForge => "neoforge",
        }
    }

    /// 由 [`LoaderChoice::key`] 的取值还原；不认识的键返回 `None`。
    pub fn from_key(key: &str) -> Option<Self> {
        LoaderChoice::ALL
            .into_iter()
            .find(|choice| choice.key() == key)
    }

    /// 全部可安装的加载器。
    pub const ALL: [LoaderChoice; 4] = [
        LoaderChoice::Fabric,
        LoaderChoice::Quilt,
        LoaderChoice::Forge,
        LoaderChoice::NeoForge,
    ];

    /// [`Petalfall::install`] 装这个加载器版本时在 `versions/` 下用的版本 id。
    ///
    /// 真正的 id 写在加载器的 profile 或安装器里，要装到那一步才读得到；要在安装开始前占住目录的调用方只能按
    /// 各加载器的写法算。早期 Forge 的 legacy 安装器不一定是这个形状，那时算出的名字不对应任何目录，占了也不碍事。
    pub fn natural_version_id(self, game_version: &str, loader_version: &str) -> String {
        match self {
            LoaderChoice::Fabric => format!("fabric-loader-{loader_version}-{game_version}"),
            LoaderChoice::Quilt => format!("quilt-loader-{loader_version}-{game_version}"),
            // 1.20.1 的 NeoForge 沿用 Forge 的坐标，版本 id 也同形。
            LoaderChoice::NeoForge if game_version != "1.20.1" => {
                format!("neoforge-{loader_version}")
            }
            LoaderChoice::Forge | LoaderChoice::NeoForge => {
                format!("{game_version}-forge-{loader_version}")
            }
        }
    }
}

/// 一次安装的结果：原版摘要 + 可选加载器摘要。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallOutcome {
    /// 原版安装摘要。
    pub vanilla: VanillaSummary,
    /// 加载器安装摘要（未装加载器时为 `None`）。
    pub loader: Option<LoaderSummary>,
}

impl Petalfall {
    /// 安装指定原版版本，并可选叠加一个 Mod 加载器。
    ///
    /// `loader_version` 仅在指定了 `loader` 时有意义，缺省取该加载器对该游戏版本的推荐版。
    pub async fn install(
        &self,
        id: &str,
        loader: Option<LoaderChoice>,
        loader_version: Option<&str>,
        events: Option<&EventSink>,
    ) -> Result<InstallOutcome> {
        self.prepare_sources().await?;
        let layout = self.layout();
        let pool = self.download_pool_reporting(events);
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

        emit(events, CoreEvent::stage(format!("开始安装原版 {id}")));
        let vanilla = VanillaInstaller::new(cx)
            .with_manifest_url(self.manifest_url())
            .with_sources(self.source_plan(self.config().version_list_source))
            .install(id)
            .await?;
        emit(
            events,
            CoreEvent::stage(format!(
                "原版 {} 安装完成：库 {} / 资源 {} / natives {}",
                vanilla.id, vanilla.libraries, vanilla.assets, vanilla.natives
            )),
        );

        let loader = match loader {
            Some(choice) => {
                emit(
                    events,
                    CoreEvent::stage(format!("开始安装 {} 加载器", choice.display_name())),
                );
                let summary = match choice {
                    LoaderChoice::Fabric => {
                        LoaderInstaller::fabric(cx)
                            .with_base_url(self.fabric_base())
                            .install(id, loader_version)
                            .await?
                    }
                    LoaderChoice::Quilt => {
                        LoaderInstaller::quilt(cx)
                            .with_base_url(self.quilt_base())
                            .install(id, loader_version)
                            .await?
                    }
                    // Forge/NeoForge 无「最新版」查询接口，版本必须由调用方显式给出。
                    LoaderChoice::Forge => {
                        let forge_version = require_loader_version(choice, id, loader_version)?;
                        let url = forge_installer_url(id, forge_version);
                        self.install_forge(id, choice, forge_version, &url, cx, events)
                            .await?
                    }
                    LoaderChoice::NeoForge => {
                        let neoforge_version = require_loader_version(choice, id, loader_version)?;
                        let url = neoforge_installer_url(neoforge_version);
                        self.install_forge(id, choice, neoforge_version, &url, cx, events)
                            .await?
                    }
                };
                emit(
                    events,
                    CoreEvent::stage(format!(
                        "{} 加载器安装完成：{}（loader {}）",
                        choice.display_name(),
                        summary.id,
                        summary.loader_version
                    )),
                );
                Some(summary)
            }
            None => None,
        };

        Ok(InstallOutcome { vanilla, loader })
    }

    /// 安装 Forge/NeoForge：先据原版版本 JSON 定 Java 主版本、备妥运行时，再下载并执行官方 installer。
    ///
    /// 与 Fabric/Quilt 不同，Forge/NeoForge 的 installer 内含需 Java 子进程执行的 processors，故本步依赖
    /// [`Petalfall::resolve_java`] 取得可执行 java。`installer_url` 由调用方按风味拼好（Forge 需 mc+loader
    /// 两段，NeoForge 只需 loader 一段），本方法只负责 Java 解析、执行与把 [`petalfall_install::ForgeSummary`]
    /// 收敛成 [`LoaderSummary`]。`processors` 计数在 [`LoaderSummary`] 中无对应字段，改由阶段事件保留。
    async fn install_forge(
        &self,
        id: &str,
        choice: LoaderChoice,
        loader_version: &str,
        installer_url: &str,
        cx: InstallContext<'_>,
        events: Option<&EventSink>,
    ) -> Result<LoaderSummary> {
        // 原版安装已把版本 JSON 落在 versions/<id>/<id>.json，读回它取该版本要求的 Java 主版本
        // （缺省回落 8，与 launch 路径一致）。processors 用它执行 Forge 安装逻辑。
        let json_path = cx.layout.version_json(id);
        let bytes =
            tokio::fs::read(&json_path)
                .await
                .map_err(|source| petalfall_base::Error::Io {
                    path: json_path.clone(),
                    source,
                })?;
        // 直接按字节解析：有损转换会把坏字节换成替换符，让损坏的 JSON 看起来能读。
        let version: VersionJson =
            serde_json::from_slice(&bytes).map_err(|source| petalfall_version::Error::Json {
                context: "版本 JSON",
                source,
            })?;
        let required_major = version
            .java_version
            .as_ref()
            .map(|j| j.major_version)
            .unwrap_or(8);

        emit(
            events,
            CoreEvent::stage(format!(
                "{} 安装器需要 Java {required_major}，开始解析运行时",
                choice.display_name()
            )),
        );
        let (_, java_path) = self.resolve_java(required_major, events).await?;

        emit(
            events,
            CoreEvent::stage(format!(
                "下载并执行 {} 安装器：{installer_url}",
                choice.display_name()
            )),
        );
        let summary = ForgeInstaller::new(cx, java_path)
            .with_sources(self.source_plan(self.config().download_source))
            .install(installer_url)
            .await?;
        emit(
            events,
            CoreEvent::stage(format!(
                "{} 安装器执行完成：库 {} / 处理器 {}",
                choice.display_name(),
                summary.libraries,
                summary.processors
            )),
        );

        Ok(LoaderSummary {
            id: summary.id,
            loader_version: loader_version.to_owned(),
            libraries: summary.libraries,
        })
    }
}

/// 取出 Forge/NeoForge 的显式 loader 版本；缺省即报错，绝不静默兜底一个版本。
///
/// Forge/NeoForge 的官方 maven 无 Fabric/Quilt 那样的「列出可用 loader」接口，无从推断推荐版，故要求
/// 调用方显式传入。复用 [`petalfall_install::Error::LoaderVersionNotFound`] 表达「没有可用 loader 版本」。
fn require_loader_version<'a>(
    choice: LoaderChoice,
    game_version: &str,
    loader_version: Option<&'a str>,
) -> Result<&'a str> {
    loader_version.ok_or_else(|| {
        petalfall_install::Error::LoaderVersionNotFound {
            loader: choice.display_name(),
            game_version: game_version.to_owned(),
        }
        .into()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::PetalfallConfig;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// 算出的 id 要与加载器自己写在版本 JSON 里的一致，否则导入前占的不是它真正写的目录。
    #[test]
    fn natural_version_ids_match_what_each_loader_writes() {
        for (choice, game, loader, id) in [
            (
                LoaderChoice::Fabric,
                "1.21",
                "0.15.11",
                "fabric-loader-0.15.11-1.21",
            ),
            (
                LoaderChoice::Quilt,
                "1.21",
                "0.26.0",
                "quilt-loader-0.26.0-1.21",
            ),
            (
                LoaderChoice::Forge,
                "1.20.1",
                "47.2.0",
                "1.20.1-forge-47.2.0",
            ),
            (
                LoaderChoice::NeoForge,
                "1.21",
                "21.0.167",
                "neoforge-21.0.167",
            ),
            (
                LoaderChoice::NeoForge,
                "1.20.1",
                "47.1.106",
                "1.20.1-forge-47.1.106",
            ),
        ] {
            assert_eq!(choice.natural_version_id(game, loader), id);
        }
    }

    /// 安装一个「空壳」原版：清单指向 mock，版本 JSON 无下载/资源/库，install 只落版本 JSON。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn install_vanilla_downloads_version_json_and_reports_zero_counts() {
        let server = MockServer::start().await;
        let base = server.uri();

        Mock::given(method("GET"))
            .and(path("/manifest.json"))
            .respond_with(ResponseTemplate::new(200).set_body_string(format!(
                r#"{{"latest":{{"release":"test","snapshot":"test"}},
                    "versions":[{{"id":"test","type":"release","url":"{base}/test.json",
                    "time":"t","releaseTime":"t"}}]}}"#
            )))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/test.json"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"{"id":"test","type":"release","mainClass":"net.minecraft.client.main.Main"}"#,
            ))
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path().to_path_buf();
        let petalfall = Petalfall::for_test(PetalfallConfig::default(), mc.clone(), mc.clone())
            .with_manifest_url(format!("{base}/manifest.json"));

        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let outcome = petalfall
            .install("test", None, None, Some(&tx))
            .await
            .unwrap();

        assert_eq!(outcome.vanilla.id, "test");
        assert_eq!(outcome.vanilla.libraries, 0);
        assert_eq!(outcome.vanilla.assets, 0);
        assert_eq!(outcome.vanilla.natives, 0);
        assert!(outcome.loader.is_none());

        // 版本 JSON 已落盘到 versions/test/test.json。
        let json_path = mc.join("versions").join("test").join("test.json");
        let on_disk = tokio::fs::read_to_string(&json_path).await.unwrap();
        assert!(on_disk.contains("net.minecraft.client.main.Main"));

        // 至少发出「开始」与「完成」两条阶段事件。
        drop(tx);
        let mut stages = Vec::new();
        while let Some(ev) = rx.recv().await {
            if let CoreEvent::Stage(s) = ev {
                stages.push(s);
            }
        }
        assert!(stages.iter().any(|s| s.contains("开始安装原版 test")));
        assert!(stages.iter().any(|s| s.contains("原版 test 安装完成")));
    }

    /// 自动档装版本：入口先测一轮速，版本清单与版本 JSON 都从实测排在前面的源取（镜像探不通，这里是官方，
    /// 与测不出时的镜像优先相反，证明顺序来自实测）；有效期内再装一次不再探测。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn auto_install_measures_once_and_fetches_metadata_from_the_measured_source() {
        use std::sync::Arc;
        use std::time::Duration;
        use wiremock::matchers::header;

        // 清单与版本 JSON 的官方地址用解析不了的域名，只经源计划落到两台 mock：接线断了也连不到真实网络。
        let manifest_path = "/mc/game/version_manifest_v2.json";
        let version_path = "/v1/packages/0123/test.json";
        let official = MockServer::start().await;
        let mirror = MockServer::start().await;
        for (server, probe_status) in [(&official, 206), (&mirror, 503)] {
            Mock::given(method("GET"))
                .and(path(manifest_path))
                .and(header("range", "bytes=0-0"))
                .respond_with(
                    ResponseTemplate::new(probe_status)
                        .insert_header("content-range", "bytes 0-0/100"),
                )
                .with_priority(1)
                .mount(server)
                .await;
            Mock::given(method("GET"))
                .and(path(manifest_path))
                .respond_with(ResponseTemplate::new(200).set_body_string(format!(
                    r#"{{"latest":{{"release":"test","snapshot":"test"}},
                    "versions":[{{"id":"test","type":"release","url":"https://meta.invalid{version_path}",
                    "time":"t","releaseTime":"t"}}]}}"#
                )))
                .mount(server)
                .await;
            Mock::given(method("GET"))
                .and(path(version_path))
                .respond_with(ResponseTemplate::new(200).set_body_string(
                    r#"{"id":"test","type":"release","mainClass":"net.minecraft.client.main.Main"}"#,
                ))
                .mount(server)
                .await;
        }

        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path().to_path_buf();
        let petalfall = Petalfall::for_test(PetalfallConfig::default(), mc.clone(), mc.clone())
            .with_manifest_url(format!("https://meta.invalid{manifest_path}"))
            .with_source_routes(
                Arc::new(crate::sources::tests::Routes {
                    official: official.uri(),
                    mirror: mirror.uri(),
                }),
                Duration::from_secs(600),
                Duration::from_secs(30),
            );

        petalfall.install("test", None, None, None).await.unwrap();
        petalfall.install("test", None, None, None).await.unwrap();

        // (探针, 清单, 版本 JSON) 各收到几次。
        let tally = |requests: Vec<wiremock::Request>| {
            let probes = requests
                .iter()
                .filter(|r| r.headers.contains_key("range"))
                .count();
            let plain = |p: &str| {
                requests
                    .iter()
                    .filter(|r| r.url.path() == p && !r.headers.contains_key("range"))
                    .count()
            };
            (probes, plain(manifest_path), plain(version_path))
        };
        assert_eq!(
            tally(official.received_requests().await.unwrap()),
            (1, 2, 2)
        );
        assert_eq!(tally(mirror.received_requests().await.unwrap()), (1, 0, 0));
        let json_path = mc.join("versions").join("test").join("test.json");
        assert!(
            tokio::fs::read_to_string(&json_path)
                .await
                .unwrap()
                .contains("net.minecraft.client.main.Main")
        );
    }

    /// 原版 + Fabric 加载器：门面先装空壳原版，再叠加 Fabric（profile JSON 落盘 + 下加载器库）。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn install_with_fabric_loader_wires_both_stages() {
        let server = MockServer::start().await;
        let base = server.uri();

        Mock::given(method("GET"))
            .and(path("/manifest.json"))
            .respond_with(ResponseTemplate::new(200).set_body_string(format!(
                r#"{{"latest":{{"release":"test","snapshot":"test"}},
                    "versions":[{{"id":"test","type":"release","url":"{base}/test.json",
                    "time":"t","releaseTime":"t"}}]}}"#
            )))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/test.json"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"{"id":"test","type":"release","mainClass":"net.minecraft.client.main.Main"}"#,
            ))
            .mount(&server)
            .await;
        // Fabric meta profile JSON：inheritsFrom test，含一个走 mock 仓库的加载器库。
        Mock::given(method("GET"))
            .and(path("/v2/versions/loader/test/0.15.0/profile/json"))
            .respond_with(ResponseTemplate::new(200).set_body_string(format!(
                r#"{{"id":"fabric-loader-0.15.0-test","inheritsFrom":"test",
                    "mainClass":"net.fabricmc.loader.impl.launch.knot.KnotClient",
                    "libraries":[{{"name":"net.example:loader:0.15.0","url":"{base}/"}}]}}"#
            )))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/net/example/loader/0.15.0/loader-0.15.0.jar"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"loader-jar".to_vec()))
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path().to_path_buf();
        let petalfall = Petalfall::for_test(PetalfallConfig::default(), mc.clone(), mc.clone())
            .with_manifest_url(format!("{base}/manifest.json"))
            .with_fabric_base(&base);

        let outcome = petalfall
            .install("test", Some(LoaderChoice::Fabric), Some("0.15.0"), None)
            .await
            .unwrap();

        assert_eq!(outcome.vanilla.id, "test");
        let loader = outcome.loader.expect("应装上 Fabric 加载器");
        assert_eq!(loader.id, "fabric-loader-0.15.0-test");
        assert_eq!(loader.loader_version, "0.15.0");
        assert_eq!(loader.libraries, 1);

        // 加载器 profile JSON 落盘、加载器库落到 libraries 下。
        let profile = mc
            .join("versions")
            .join("fabric-loader-0.15.0-test")
            .join("fabric-loader-0.15.0-test.json");
        assert!(profile.is_file());
        let lib = mc
            .join("libraries")
            .join("net")
            .join("example")
            .join("loader")
            .join("0.15.0")
            .join("loader-0.15.0.jar");
        assert_eq!(tokio::fs::read(&lib).await.unwrap(), b"loader-jar");
    }

    /// 版本 test：清单、声明了客户端 jar 的版本 JSON，客户端 jar 的响应由用例定。
    async fn mount_vanilla_with_client(server: &MockServer, client_jar: ResponseTemplate) {
        let base = server.uri();
        Mock::given(method("GET"))
            .and(path("/manifest.json"))
            .respond_with(ResponseTemplate::new(200).set_body_string(format!(
                r#"{{"latest":{{"release":"test","snapshot":"test"}},
                    "versions":[{{"id":"test","type":"release","url":"{base}/test.json",
                    "time":"t","releaseTime":"t"}}]}}"#
            )))
            .mount(server)
            .await;
        Mock::given(method("GET"))
            .and(path("/test.json"))
            .respond_with(ResponseTemplate::new(200).set_body_string(format!(
                r#"{{"id":"test","type":"release","mainClass":"net.minecraft.client.main.Main",
                    "downloads":{{"client":{{"sha1":"0000000000000000000000000000000000000000",
                    "size":6,"url":"{base}/client.jar"}}}}}}"#
            )))
            .mount(server)
            .await;
        Mock::given(method("GET"))
            .and(path("/client.jar"))
            .respond_with(client_jar)
            .mount(server)
            .await;
    }

    /// 客户端 jar 下不下来：原版没装上，版本列表里看不到它，也不多出一行损坏项。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_failed_install_is_not_listed_as_a_version() {
        let server = MockServer::start().await;
        mount_vanilla_with_client(&server, ResponseTemplate::new(404)).await;
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path().to_path_buf();
        let petalfall = Petalfall::for_test(PetalfallConfig::default(), mc.clone(), mc.clone())
            .with_manifest_url(format!("{}/manifest.json", server.uri()));

        petalfall
            .install("test", None, None, None)
            .await
            .expect_err("客户端 jar 下不下来");

        let scan = petalfall_instance::discover_versions(&mc).await.unwrap();
        assert_eq!(scan, petalfall_instance::VersionScan::default());
    }

    /// 取消发生在下客户端 jar 的途中：同样不留版本，门面按已取消返回。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_cancelled_install_is_not_listed_as_a_version() {
        let server = MockServer::start().await;
        let stalled = ResponseTemplate::new(200)
            .set_body_bytes(b"client".to_vec())
            .set_delay(std::time::Duration::from_secs(30));
        mount_vanilla_with_client(&server, stalled).await;
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path().to_path_buf();
        let token = petalfall_download::CancellationToken::new();
        let petalfall = Petalfall::for_test(PetalfallConfig::default(), mc.clone(), mc.clone())
            .with_manifest_url(format!("{}/manifest.json", server.uri()))
            .with_cancel(token.clone());
        let attempt = petalfall.install("test", None, None, None);
        tokio::pin!(attempt);

        let client_jar_requested = async {
            loop {
                let requests = server.received_requests().await.unwrap();
                if requests.iter().any(|r| r.url.path() == "/client.jar") {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        };
        tokio::select! {
            outcome = &mut attempt => panic!("客户端 jar 还没回来，安装不该结束：{outcome:?}"),
            () = client_jar_requested => {}
        }
        token.cancel();
        let err = attempt.await.unwrap_err();

        assert!(
            matches!(
                err,
                crate::error::CoreError::Install(petalfall_install::Error::Download(
                    petalfall_download::Error::Cancelled
                ))
            ),
            "实际：{err:?}"
        );
        let scan = petalfall_instance::discover_versions(&mc).await.unwrap();
        assert_eq!(scan, petalfall_instance::VersionScan::default());
    }

    /// 原版装好了、加载器库下不下来：原版是真的装好了，留着；加载器版本不出现。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_failed_loader_leaves_only_the_finished_vanilla() {
        let server = MockServer::start().await;
        let base = server.uri();
        Mock::given(method("GET"))
            .and(path("/manifest.json"))
            .respond_with(ResponseTemplate::new(200).set_body_string(format!(
                r#"{{"latest":{{"release":"test","snapshot":"test"}},
                    "versions":[{{"id":"test","type":"release","url":"{base}/test.json",
                    "time":"t","releaseTime":"t"}}]}}"#
            )))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/test.json"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"{"id":"test","type":"release","mainClass":"net.minecraft.client.main.Main"}"#,
            ))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v2/versions/loader/test/0.15.0/profile/json"))
            .respond_with(ResponseTemplate::new(200).set_body_string(format!(
                r#"{{"id":"fabric-loader-0.15.0-test","inheritsFrom":"test","mainClass":"Knot",
                    "libraries":[{{"name":"net.example:loader:0.15.0","url":"{base}/"}}]}}"#
            )))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/net/example/loader/0.15.0/loader-0.15.0.jar"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path().to_path_buf();
        let petalfall = Petalfall::for_test(PetalfallConfig::default(), mc.clone(), mc.clone())
            .with_manifest_url(format!("{base}/manifest.json"))
            .with_fabric_base(&base);

        petalfall
            .install("test", Some(LoaderChoice::Fabric), Some("0.15.0"), None)
            .await
            .expect_err("加载器库下不下来");

        let scan = petalfall_instance::discover_versions(&mc).await.unwrap();
        let ids: Vec<&str> = scan.versions.iter().map(|v| v.id.as_str()).collect();
        assert_eq!(ids, vec!["test"]);
        assert_eq!(scan.broken, Vec::new());
    }

    /// 传统布局的 Forge 与实例路径一样按下载源方案取 installer 的 `.sha1`：官方 maven 不通时才有镜像兜底，
    /// 否则缓存里的 installer 无法复用，下载时也没有校验值。冒充的 installer 不是 zip，流程停在读安装配置。
    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn legacy_forge_install_fetches_the_installer_sha1_through_the_source_plan() {
        const SHA1_PATH: &str =
            "/net/minecraftforge/forge/test-47.2.0/forge-test-47.2.0-installer.jar.sha1";
        let installer_path = SHA1_PATH.trim_end_matches(".sha1");
        let official = MockServer::start().await;
        let mirror = MockServer::start().await;
        let manifest_path = "/mc/game/version_manifest_v2.json";
        let base = "https://meta.invalid";
        for server in [&official, &mirror] {
            Mock::given(method("GET"))
                .and(path(manifest_path))
                .respond_with(ResponseTemplate::new(200).set_body_string(format!(
                    r#"{{"latest":{{"release":"test","snapshot":"test"}},
                        "versions":[{{"id":"test","type":"release","url":"{base}/test.json",
                        "time":"t","releaseTime":"t"}}]}}"#
                )))
                .mount(server)
                .await;
            Mock::given(method("GET"))
                .and(path("/test.json"))
                .respond_with(ResponseTemplate::new(200).set_body_string(
                    r#"{"id":"test","type":"release","mainClass":"net.minecraft.client.main.Main",
                        "javaVersion":{"component":"java-runtime-gamma","majorVersion":17}}"#,
                ))
                .mount(server)
                .await;
            Mock::given(method("GET"))
                .and(path(installer_path))
                .respond_with(ResponseTemplate::new(200).set_body_bytes(b"not a zip".to_vec()))
                .mount(server)
                .await;
        }
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        let payload = root.join("payload");
        std::fs::write(&payload, b"not a zip").unwrap();
        let sha1 = petalfall_base::fs::sha1_hex(&payload).await.unwrap();
        Mock::given(method("GET"))
            .and(path(SHA1_PATH))
            .respond_with(ResponseTemplate::new(404))
            .mount(&official)
            .await;
        Mock::given(method("GET"))
            .and(path(SHA1_PATH))
            .respond_with(ResponseTemplate::new(200).set_body_string(sha1))
            .mount(&mirror)
            .await;

        let java = root.join("fake-java-17.cmd");
        std::fs::write(
            &java,
            "@echo off\r\n>&2 echo openjdk version \"17.0.8\" 2023-07-18\r\nexit /b 0\r\n",
        )
        .unwrap();
        let config = PetalfallConfig {
            default_java: Some(java),
            ..PetalfallConfig::default()
        };
        let petalfall = Petalfall::for_test(config, root.clone(), root.clone())
            .with_manifest_url(format!("{base}{manifest_path}"))
            .with_source_routes(
                std::sync::Arc::new(crate::sources::tests::Routes {
                    official: official.uri(),
                    mirror: mirror.uri(),
                }),
                std::time::Duration::from_secs(600),
                std::time::Duration::from_secs(2),
            );

        petalfall
            .install("test", Some(LoaderChoice::Forge), Some("47.2.0"), None)
            .await
            .unwrap_err();

        let sha1_requests = mirror
            .received_requests()
            .await
            .unwrap()
            .iter()
            .filter(|request| request.url.path() == SHA1_PATH)
            .count();
        assert_eq!(sha1_requests, 1, "官方取不到时应换镜像取 .sha1");
    }

    /// 原版 JSON 声明 javaVersion.majorVersion，Forge 分支须读回它并据此解析 Java；这里给一个
    /// 不存在的主版本（999）且关闭自动下载，令 resolve_java 必然报 NoJava。断言：
    /// (1) 选择 Forge 走到了 Java 解析（Fabric/Quilt 分支不碰 Java），
    /// (2) java 主版本正是从原版 JSON 读出的 999（非硬编码 8），
    /// (3) 失败发生在下载 installer（硬编码 maven 地址）之前，故测试不触网。
    /// 删掉「读版本 JSON 定 Java 主版本 + resolve_java」逻辑，本断言即挂。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn install_forge_reads_java_major_before_installer_download() {
        let server = MockServer::start().await;
        let base = server.uri();

        Mock::given(method("GET"))
            .and(path("/manifest.json"))
            .respond_with(ResponseTemplate::new(200).set_body_string(format!(
                r#"{{"latest":{{"release":"test","snapshot":"test"}},
                    "versions":[{{"id":"test","type":"release","url":"{base}/test.json",
                    "time":"t","releaseTime":"t"}}]}}"#
            )))
            .mount(&server)
            .await;
        // 版本 JSON 携带 javaVersion.majorVersion=999（本机不可能装有 Java 999）。
        Mock::given(method("GET"))
            .and(path("/test.json"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"{"id":"test","type":"release","mainClass":"net.minecraft.client.main.Main",
                    "javaVersion":{"component":"jre-legacy","majorVersion":999}}"#,
            ))
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path().to_path_buf();
        let mut petalfall = Petalfall::for_test(PetalfallConfig::default(), mc.clone(), mc.clone())
            .with_manifest_url(format!("{base}/manifest.json"));
        // 关闭自动下载：无匹配 Java 时直接报 NoJava，而非去拉 Mojang 运行时（避免触网）。
        petalfall.set_auto_download_java(false);

        let err = petalfall
            .install("test", Some(LoaderChoice::Forge), Some("47.2.0"), None)
            .await
            .unwrap_err();
        assert!(
            matches!(err, crate::error::CoreError::NoJava { major: 999 }),
            "应因缺 Java 999 而在下载 installer 前失败，实际：{err:?}"
        );

        // 原版 JSON 确已落盘（Forge 分支正是读它取 Java 主版本）。
        let json_path = mc.join("versions").join("test").join("test.json");
        assert!(json_path.is_file());
    }

    /// Forge/NeoForge 无「最新版」查询，缺省 loader 版本必须显式报错，绝不静默兜底。
    /// 删掉 require_loader_version 的缺省校验（放任继续），错误类型将变（NoJava/下载失败），本断言即挂。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn install_forge_without_version_reports_loader_version_missing() {
        let server = MockServer::start().await;
        let base = server.uri();

        Mock::given(method("GET"))
            .and(path("/manifest.json"))
            .respond_with(ResponseTemplate::new(200).set_body_string(format!(
                r#"{{"latest":{{"release":"test","snapshot":"test"}},
                    "versions":[{{"id":"test","type":"release","url":"{base}/test.json",
                    "time":"t","releaseTime":"t"}}]}}"#
            )))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/test.json"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"{"id":"test","type":"release","mainClass":"net.minecraft.client.main.Main"}"#,
            ))
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path().to_path_buf();
        let petalfall = Petalfall::for_test(PetalfallConfig::default(), mc.clone(), mc)
            .with_manifest_url(format!("{base}/manifest.json"));

        // NeoForge 缺省版本 -> LoaderVersionNotFound（loader 名取自 display_name，game_version 为原版 id）。
        let err = petalfall
            .install("test", Some(LoaderChoice::NeoForge), None, None)
            .await
            .unwrap_err();
        match err {
            crate::error::CoreError::Install(petalfall_install::Error::LoaderVersionNotFound {
                loader,
                game_version,
            }) => {
                assert_eq!(loader, "NeoForge");
                assert_eq!(game_version, "test");
            }
            other => panic!("应报 LoaderVersionNotFound，实际：{other:?}"),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn install_unknown_version_bubbles_installer_error() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/manifest.json"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string(r#"{"latest":{"release":"a","snapshot":"a"},"versions":[]}"#),
            )
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path().to_path_buf();
        let petalfall = Petalfall::for_test(PetalfallConfig::default(), mc.clone(), mc)
            .with_manifest_url(format!("{}/manifest.json", server.uri()));

        let err = petalfall
            .install("nope", None, None, None)
            .await
            .unwrap_err();
        // 清单里没有该版本 -> 安装器报 InstallerEntryMissing，经门面冒泡为 Install 变体。
        assert!(matches!(err, crate::error::CoreError::Install(_)));
    }
}
