//! 门面结构 [`Aurora`]：持有全局配置、共享 HTTP 客户端与运行环境，组合下层 crate 对外提供粗粒度
//! 异步 API。目标是让 iced 前端与 CLI 只依赖本 crate。
//!
//! 各操作（版本清单、安装、登录、启动、搜索）分散在同名子模块的 `impl Aurora` 块里，本文件只负责
//! 结构定义、构造与共享的内部辅助（目录布局、下载池、并发上下文装配）。远端端点基址以字段持有，
//! 生产走各官方/镜像默认，单元测试用 `with_*` 注入本地 mock。

use std::path::{Path, PathBuf};

use aurora_base::retry::RetryPolicy;
use aurora_download::{DownloadConfig, DownloadPool, Downloader};
use aurora_install::{GameLayout, InstallContext, VERSION_MANIFEST_V2};
use aurora_instance::IsolationPolicy;
use aurora_version::RuntimeContext;

use crate::config::{AuroraConfig, DownloadSourcePolicy, MemorySettings};
use crate::error::Result;

/// 门面：组合下层 crate 的统一入口。
pub struct Aurora {
    config: AuroraConfig,
    http: reqwest::Client,
    runtime: RuntimeContext,
    data_dir: PathBuf,
    game_dir: PathBuf,
    config_path: PathBuf,
    // 远端端点基址：生产默认，测试注入 mock。
    manifest_url: String,
    modrinth_base: String,
    curseforge_base: String,
    fabric_base: String,
    quilt_base: String,
    java_runtime_url: String,
}

impl Aurora {
    /// 以默认数据目录构造：从 `<数据目录>/config.json` 载入配置，构建共享 HTTP 客户端。
    ///
    /// 游戏目录取配置的 `game_directory`，缺省为 `<数据目录>/.minecraft`。
    pub async fn load() -> Result<Self> {
        let data_dir = aurora_base::fs::data_dir()?;
        let config_path = data_dir.join("config.json");
        let config = crate::config::ConfigStore::at(&config_path).load().await?;
        Self::open(config, data_dir, config_path)
    }

    /// 用显式配置与数据目录构造（供 CLI 应用命令行覆盖后调用，或测试注入）。
    pub fn open(config: AuroraConfig, data_dir: PathBuf, config_path: PathBuf) -> Result<Self> {
        let http = aurora_base::http::build_client()?;
        let game_dir = config
            .game_directory
            .clone()
            .unwrap_or_else(|| data_dir.join(aurora_instance::MINECRAFT_DIR_NAME));
        // 版本清单地址随「版本列表源」策略选官方或镜像。
        let manifest_url = config
            .version_list_source
            .rewrite_primary(VERSION_MANIFEST_V2)?;
        Ok(Self {
            config,
            http,
            runtime: RuntimeContext::current(),
            data_dir,
            game_dir,
            config_path,
            manifest_url,
            modrinth_base: aurora_modplatform::MODRINTH_BASE.to_owned(),
            curseforge_base: aurora_modplatform::CURSEFORGE_BASE.to_owned(),
            fabric_base: "https://meta.fabricmc.net".to_owned(),
            quilt_base: "https://meta.quiltmc.org".to_owned(),
            java_runtime_url: aurora_java::MOJANG_JAVA_RUNTIME_ALL.to_owned(),
        })
    }

    /// 只读访问当前配置。
    pub fn config(&self) -> &AuroraConfig {
        &self.config
    }

    /// 当前游戏目录（`.minecraft`）。
    pub fn game_dir(&self) -> &Path {
        &self.game_dir
    }

    /// 数据目录（`%LOCALAPPDATA%\Petalfall`）。
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// 覆盖游戏目录（CLI `--game-dir`）。
    pub fn set_game_dir(&mut self, game_dir: impl Into<PathBuf>) {
        self.game_dir = game_dir.into();
    }

    /// 覆盖微软登录 client_id（CLI `--client-id`）。
    pub fn set_client_id(&mut self, client_id: impl Into<String>) {
        self.config.msa_client_id = Some(client_id.into());
    }

    /// 把当前配置写回配置文件。
    pub async fn save_config(&self) -> Result<()> {
        crate::config::ConfigStore::at(&self.config_path)
            .save(&self.config)
            .await
    }

    /// 设置文件下载源策略（下次装配下载池即生效）。
    pub fn set_download_source(&mut self, policy: DownloadSourcePolicy) {
        self.config.download_source = policy;
    }

    /// 设置版本列表源策略，并据此重算版本清单地址。
    ///
    /// 清单地址在构造时按此策略一次性改写为官方或镜像；只改配置字段不会生效，故这里同步重算。
    pub fn set_version_list_source(&mut self, policy: DownloadSourcePolicy) -> Result<()> {
        self.manifest_url = policy.rewrite_primary(VERSION_MANIFEST_V2)?;
        self.config.version_list_source = policy;
        Ok(())
    }

    /// 设置批量下载的文件级并发上限。
    pub fn set_download_concurrency(&mut self, concurrency: usize) {
        self.config.download_concurrency = concurrency;
    }

    /// 设置内存分配（-Xmx / -Xms）。
    pub fn set_memory(&mut self, memory: MemorySettings) {
        self.config.memory = memory;
    }

    /// 设置全局版本隔离档位。
    pub fn set_isolation_policy(&mut self, policy: IsolationPolicy) {
        self.config.isolation_policy = policy;
    }

    /// 设置找不到匹配 Java 时是否自动下载。
    pub fn set_auto_download_java(&mut self, enabled: bool) {
        self.config.auto_download_java = enabled;
    }

    /// 设置缓存目录（None 表示回落默认位置）。
    pub fn set_cache_directory(&mut self, dir: Option<PathBuf>) {
        self.config.cache_directory = dir;
    }

    /// 设置游戏目录并写入配置（区别于仅改运行期字段的 [`Aurora::set_game_dir`]）。
    ///
    /// 同时更新运行期 `game_dir` 与 `config.game_directory`，`save_config` 落盘后下次 `load` 生效；
    /// 而 `set_game_dir` 只改运行期字段，供 CLI 的临时覆盖使用。
    pub fn set_game_directory(&mut self, game_dir: impl Into<PathBuf>) {
        let dir = game_dir.into();
        self.config.game_directory = Some(dir.clone());
        self.game_dir = dir;
    }

    /// 设置当前启动版本 id（`None` 表示清空选择，主页回落到扫描首项）。
    pub fn set_selected_version(&mut self, id: Option<String>) {
        self.config.selected_version = id;
    }

    // ---- 内部共享装配 ----

    /// 共享 HTTP 客户端（克隆廉价：内部 `Arc`）。
    pub(crate) fn http(&self) -> reqwest::Client {
        self.http.clone()
    }

    /// 运行环境快照。
    pub(crate) fn runtime(&self) -> &RuntimeContext {
        &self.runtime
    }

    /// 当前游戏目录的路径布局。
    pub(crate) fn layout(&self) -> GameLayout {
        GameLayout::new(&self.game_dir)
    }

    /// 按当前配置的下载源策略与并发上限装配一个批量下载池。
    pub(crate) fn download_pool(&self) -> DownloadPool {
        let config = DownloadConfig {
            sources: self.config.download_source.source_plan(),
            ..DownloadConfig::default()
        };
        let downloader = Downloader::new(self.http.clone(), config);
        DownloadPool::new(downloader, self.config.download_concurrency)
    }

    /// 元数据抓取的退避重试策略。
    pub(crate) fn retry_policy(&self) -> RetryPolicy {
        RetryPolicy::default()
    }

    /// 版本清单地址（已按版本列表源策略改写）。
    pub(crate) fn manifest_url(&self) -> &str {
        &self.manifest_url
    }

    pub(crate) fn modrinth_base(&self) -> &str {
        &self.modrinth_base
    }

    pub(crate) fn curseforge_base(&self) -> &str {
        &self.curseforge_base
    }

    pub(crate) fn fabric_base(&self) -> &str {
        &self.fabric_base
    }

    pub(crate) fn quilt_base(&self) -> &str {
        &self.quilt_base
    }

    pub(crate) fn java_runtime_url(&self) -> &str {
        &self.java_runtime_url
    }
}

/// 装配一个安装上下文所需的一束借用（生命周期绑定到传入的各组件）。
///
/// 安装/补全类操作先建 `layout`/`pool`/`policy` 局部变量，再借此函数打成 [`InstallContext`]，避免每处
/// 重复五参数样板。
pub(crate) fn make_context<'a>(
    http: &'a reqwest::Client,
    pool: &'a DownloadPool,
    layout: &'a GameLayout,
    runtime: &'a RuntimeContext,
    policy: &'a RetryPolicy,
) -> InstallContext<'a> {
    InstallContext::new(http, pool, layout, runtime, policy)
}

#[cfg(test)]
impl Aurora {
    /// 测试构造：以显式配置、数据目录、游戏目录建门面，端点基址随后用 `with_*` 注入。
    pub(crate) fn for_test(config: AuroraConfig, data_dir: PathBuf, game_dir: PathBuf) -> Self {
        let http = aurora_base::http::build_client().expect("构建测试 HTTP 客户端");
        Self {
            config,
            http,
            runtime: RuntimeContext::new(aurora_version::OsName::Windows, "x86_64", 64),
            data_dir,
            config_path: game_dir.join("config.json"),
            game_dir,
            manifest_url: VERSION_MANIFEST_V2.to_owned(),
            modrinth_base: aurora_modplatform::MODRINTH_BASE.to_owned(),
            curseforge_base: aurora_modplatform::CURSEFORGE_BASE.to_owned(),
            fabric_base: "https://meta.fabricmc.net".to_owned(),
            quilt_base: "https://meta.quiltmc.org".to_owned(),
            java_runtime_url: aurora_java::MOJANG_JAVA_RUNTIME_ALL.to_owned(),
        }
    }

    pub(crate) fn with_manifest_url(mut self, url: impl Into<String>) -> Self {
        self.manifest_url = url.into();
        self
    }

    pub(crate) fn with_modrinth_base(mut self, url: impl Into<String>) -> Self {
        self.modrinth_base = url.into();
        self
    }

    pub(crate) fn with_fabric_base(mut self, url: impl Into<String>) -> Self {
        self.fabric_base = url.into();
        self
    }

    pub(crate) fn with_curseforge_base(mut self, url: impl Into<String>) -> Self {
        self.curseforge_base = url.into();
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_aurora() -> Aurora {
        Aurora::for_test(
            AuroraConfig::default(),
            PathBuf::from("/data"),
            PathBuf::from("/data/.minecraft"),
        )
    }

    #[test]
    fn config_setters_write_through() {
        let mut aurora = test_aurora();
        aurora.set_download_source(DownloadSourcePolicy::MirrorFirst);
        aurora.set_download_concurrency(16);
        aurora.set_auto_download_java(false);
        aurora.set_memory(MemorySettings {
            max_mb: 8192,
            min_mb: Some(1024),
        });
        aurora.set_isolation_policy(IsolationPolicy::All);

        let cfg = aurora.config();
        assert_eq!(cfg.download_source, DownloadSourcePolicy::MirrorFirst);
        assert_eq!(cfg.download_concurrency, 16);
        assert!(!cfg.auto_download_java);
        assert_eq!(cfg.memory.max_mb, 8192);
        assert_eq!(cfg.memory.min_mb, Some(1024));
        assert_eq!(cfg.isolation_policy, IsolationPolicy::All);
    }

    #[test]
    fn set_version_list_source_rederives_manifest_url() {
        let mut aurora = test_aurora();
        aurora
            .set_version_list_source(DownloadSourcePolicy::MirrorFirst)
            .expect("改写清单地址");
        assert_eq!(
            aurora.config().version_list_source,
            DownloadSourcePolicy::MirrorFirst
        );
        // 清单地址应等于按新策略改写的结果；删掉 setter 里的重算行会退回默认地址，此断言即挂。
        let expected = DownloadSourcePolicy::MirrorFirst
            .rewrite_primary(VERSION_MANIFEST_V2)
            .expect("镜像改写");
        assert_eq!(aurora.manifest_url(), expected);
    }

    #[test]
    fn set_game_directory_syncs_runtime_and_config() {
        let mut aurora = test_aurora();
        aurora.set_game_directory(PathBuf::from("/games/mc"));
        assert_eq!(aurora.game_dir(), Path::new("/games/mc"));
        assert_eq!(
            aurora.config().game_directory.as_deref(),
            Some(Path::new("/games/mc"))
        );
    }

    #[test]
    fn set_selected_version_updates_config() {
        let mut aurora = test_aurora();
        assert!(aurora.config().selected_version.is_none());
        aurora.set_selected_version(Some("1.20.1-Forge_47.4.20".to_owned()));
        assert_eq!(
            aurora.config().selected_version.as_deref(),
            Some("1.20.1-Forge_47.4.20")
        );
        // 传 None 清空选择；删掉 setter 里的赋值这两条断言即挂。
        aurora.set_selected_version(None);
        assert!(aurora.config().selected_version.is_none());
    }
}
