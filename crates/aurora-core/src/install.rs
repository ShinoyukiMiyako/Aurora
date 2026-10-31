//! 版本安装编排：原版补全 + 可选 Mod 加载器（Fabric / Quilt / Forge / NeoForge）。
//!
//! 门面把 aurora-install 的原版安装器与加载器安装器串起来，按当前配置的下载源策略与并发跑批量下载，
//! 并在关键节点发出阶段事件。Fabric / Quilt 的 meta 服务直接合成版本 JSON，无需本地安装器；
//! Forge / NeoForge 则先读该版本要求的 Java 主版本、备妥运行时，再下载并执行官方 installer
//! （内含 processors 子进程），故这两者的分支多一步 Java 解析。

use aurora_install::{
    ForgeInstaller, InstallContext, LoaderInstaller, LoaderSummary, VanillaInstaller,
    VanillaSummary, forge_installer_url, neoforge_installer_url,
};
use aurora_version::VersionJson;

use crate::error::Result;
use crate::event::{CoreEvent, EventSink, emit};
use crate::facade::{Aurora, make_context};

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
}

/// 一次安装的结果：原版摘要 + 可选加载器摘要。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallOutcome {
    /// 原版安装摘要。
    pub vanilla: VanillaSummary,
    /// 加载器安装摘要（未装加载器时为 `None`）。
    pub loader: Option<LoaderSummary>,
}

impl Aurora {
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
        let layout = self.layout();
        let pool = self.download_pool_reporting(events);
        let policy = self.retry_policy();
        let http = self.http();
        let cx = make_context(&http, &pool, &layout, self.runtime(), &policy);

        emit(events, CoreEvent::stage(format!("开始安装原版 {id}")));
        let vanilla = VanillaInstaller::new(cx)
            .with_manifest_url(self.manifest_url())
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
    /// [`Aurora::resolve_java`] 取得可执行 java。`installer_url` 由调用方按风味拼好（Forge 需 mc+loader
    /// 两段，NeoForge 只需 loader 一段），本方法只负责 Java 解析、执行与把 [`aurora_install::ForgeSummary`]
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
        let bytes = tokio::fs::read(&json_path)
            .await
            .map_err(|source| aurora_base::Error::Io {
                path: json_path.clone(),
                source,
            })?;
        // 直接按字节解析：有损转换会把坏字节换成替换符，让损坏的 JSON 看起来能读。
        let version: VersionJson =
            serde_json::from_slice(&bytes).map_err(|source| aurora_version::Error::Json {
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
        let mut forge = ForgeInstaller::new(cx, java_path);
        if let Some(token) = self.cancel_token() {
            forge = forge.with_cancel(token.clone());
        }
        let summary = forge.install(installer_url).await?;
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
/// 调用方显式传入。复用 [`aurora_install::Error::LoaderVersionNotFound`] 表达「没有可用 loader 版本」。
fn require_loader_version<'a>(
    choice: LoaderChoice,
    game_version: &str,
    loader_version: Option<&'a str>,
) -> Result<&'a str> {
    loader_version.ok_or_else(|| {
        aurora_install::Error::LoaderVersionNotFound {
            loader: choice.display_name(),
            game_version: game_version.to_owned(),
        }
        .into()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AuroraConfig;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

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
        let aurora = Aurora::for_test(AuroraConfig::default(), mc.clone(), mc.clone())
            .with_manifest_url(format!("{base}/manifest.json"));

        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let outcome = aurora.install("test", None, None, Some(&tx)).await.unwrap();

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
        let aurora = Aurora::for_test(AuroraConfig::default(), mc.clone(), mc.clone())
            .with_manifest_url(format!("{base}/manifest.json"))
            .with_fabric_base(&base);

        let outcome = aurora
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
        let mut aurora = Aurora::for_test(AuroraConfig::default(), mc.clone(), mc.clone())
            .with_manifest_url(format!("{base}/manifest.json"));
        // 关闭自动下载：无匹配 Java 时直接报 NoJava，而非去拉 Mojang 运行时（避免触网）。
        aurora.set_auto_download_java(false);

        let err = aurora
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
        let aurora = Aurora::for_test(AuroraConfig::default(), mc.clone(), mc)
            .with_manifest_url(format!("{base}/manifest.json"));

        // NeoForge 缺省版本 -> LoaderVersionNotFound（loader 名取自 display_name，game_version 为原版 id）。
        let err = aurora
            .install("test", Some(LoaderChoice::NeoForge), None, None)
            .await
            .unwrap_err();
        match err {
            crate::error::CoreError::Install(aurora_install::Error::LoaderVersionNotFound {
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
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"{"latest":{"release":"a","snapshot":"a"},"versions":[]}"#,
            ))
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path().to_path_buf();
        let aurora = Aurora::for_test(AuroraConfig::default(), mc.clone(), mc)
            .with_manifest_url(format!("{}/manifest.json", server.uri()));

        let err = aurora.install("nope", None, None, None).await.unwrap_err();
        // 清单里没有该版本 -> 安装器报 InstallerEntryMissing，经门面冒泡为 Install 变体。
        assert!(matches!(err, crate::error::CoreError::Install(_)));
    }
}
