//! 门面结构 [`Aurora`]：持有全局配置、共享 HTTP 客户端与运行环境，组合下层 crate 对外提供粗粒度
//! 异步 API。目标是让 Tauri 外壳与 CLI 只依赖本 crate。
//!
//! 各操作（版本清单、安装、登录、启动、搜索）分散在同名子模块的 `impl Aurora` 块里，本文件只负责
//! 结构定义、构造与共享的内部辅助（目录布局、下载池、并发上下文装配）。远端端点基址以字段持有，
//! 生产走各官方/镜像默认，单元测试用 `with_*` 注入本地 mock。
//!
//! 门面可廉价克隆（HTTP 客户端内部是 `Arc`，其余是配置与路径）。上层把它放在读写锁里，长任务
//! 先克隆一份快照再放锁，网络等待期间不占锁；快照上可挂取消令牌（[`Aurora::with_cancel`]），
//! 经它装配的下载池与 Java 下载都会响应取消。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use aurora_auth::MsaEndpoints;
use aurora_base::retry::RetryPolicy;
use aurora_download::{
    CancellationToken, DownloadConfig, DownloadPool, DownloadProgress, Downloader, MirrorResolver,
    SourceHealth, SourceResolver, SourceSpeedCache,
};
use aurora_install::{GameLayout, InstallContext, VERSION_MANIFEST_V2};
use aurora_instance::IsolationPolicy;
use aurora_java::JavaRuntimeInstaller;
use aurora_version::RuntimeContext;
use tokio::sync::watch;

use crate::appearance::{Appearance, AppearancePatch};
use crate::config::{AfterLaunch, AuroraConfig, DownloadSourcePolicy, MemorySettings};
use crate::error::Result;
use crate::event::{CoreEvent, EventSink};
use crate::gpu::{GpuPreferenceStore, RegistryGpuPreferences};

/// 下载进度事件的最小间隔。采样器每 100 ms 推一次快照，逐文件完成时还会额外推一次；
/// 上千个小文件的资源批次若逐条转发，事件通道与前端 IPC 都会被灌满，按此间隔只留最新快照。
pub(crate) const PROGRESS_EVENT_INTERVAL: Duration = Duration::from_millis(100);

/// 门面：组合下层 crate 的统一入口。
#[derive(Clone)]
pub struct Aurora {
    config: AuroraConfig,
    http: reqwest::Client,
    /// 不自动跟随跳转的客户端，只给带下载凭据的任务用：自动跟随会把凭据头原样带到下一跳的主机，
    /// 由下载引擎逐跳决定带不带。
    http_manual: reqwest::Client,
    runtime: RuntimeContext,
    data_dir: PathBuf,
    game_dir: PathBuf,
    config_path: PathBuf,
    // 远端端点基址：生产默认，测试注入 mock。
    /// 版本清单的官方地址；在官方与镜像之间选源交给源计划。
    manifest_url: String,
    modrinth_base: String,
    curseforge_base: String,
    fabric_base: String,
    quilt_base: String,
    java_runtime_url: String,
    msa_endpoints: MsaEndpoints,
    /// 长任务快照上挂的取消令牌；常驻门面上恒为 `None`。
    cancel: Option<CancellationToken>,
    /// 工程版本列表的短时缓存。放在门面上而不是进程全局：快照克隆的是同一个句柄，跨命令复用；
    /// 各自新建的门面（含测试）互不串用。
    pub(crate) mod_versions: crate::modversions::SharedVersionCache,
    /// 下载源测速结论。放在门面上随快照共享：各长任务生成下载计划时共用一份未过期的结论，
    /// TTL 内不重复探测。
    pub(crate) source_speed: Arc<SourceSpeedCache>,
    /// 把官方地址改写到各下载源的解析器；生产为镜像改写表，测试把两个源钉到不同的本地 mock。
    pub(crate) source_resolver: Arc<dyn SourceResolver>,
    /// 下载源健康表。跨池、跨任务共享：一个任务刚证明某个源不通，紧接着的任务不必把同一轮重试再赔一遍。
    source_health: Arc<SourceHealth>,
    /// Windows 图形设置里按程序显卡偏好的读写；测试注入替身，不碰真实注册表。
    gpu_preferences: Arc<dyn GpuPreferenceStore>,
    /// 各账户最近一次账户类启动失败，以离线方式进单人时据此放行。与工程版本缓存一样放在门面上：快照
    /// 克隆共享同一个句柄，重开门面即清空。
    pub(crate) account_failures: crate::launch::AccountFailures,
    /// 测试注入的 CurseForge key：生产只认运行期环境变量与构建时内嵌的 key，测试改不了进程环境，
    /// 有了它 CurseForge 路径上的门面级行为才写得出端到端测试。
    #[cfg(test)]
    curseforge_key: Option<String>,
    /// 测试把 CurseForge 下载凭据的作用域换成本地 mock：生产作用域只认 https 的 forgecdn.net。
    #[cfg(test)]
    curseforge_cdn_scope: Option<aurora_download::CredentialScope>,
    /// 测试注入的下载地址改写：往返测试要让导入侧把清单里的正式 CDN 地址下到本地 mock，又不能放松导入
    /// 对清单地址的白名单校验，只能在下载池这一层改写。
    #[cfg(test)]
    download_resolver: Option<std::sync::Arc<dyn aurora_download::SourceResolver>>,
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

    /// 同 [`Aurora::load`]，但配置文件损坏时不报错：坏文件改名留存、按默认配置构造，并交回经过；
    /// 只是个别枚举取值不认识时文件不动，交回退回默认的那几项。
    /// 给桌面应用启动用：那时还没有窗口能显示错误，报错等于一声不响地打不开。
    pub async fn load_recovering() -> Result<(Self, Option<crate::config::ConfigRecovery>)> {
        let data_dir = aurora_base::fs::data_dir()?;
        let config_path = data_dir.join("config.json");
        let (config, recovery) = crate::config::ConfigStore::at(&config_path)
            .load_or_preserve()
            .await?;
        Ok((Self::open(config, data_dir, config_path)?, recovery))
    }

    /// 用显式配置与数据目录构造（供 CLI 应用命令行覆盖后调用，或测试注入）。
    pub fn open(config: AuroraConfig, data_dir: PathBuf, config_path: PathBuf) -> Result<Self> {
        let http = aurora_base::http::build_client()?;
        let http_manual = aurora_base::http::build_manual_redirect_client()?;
        let game_dir = config
            .game_directory
            .clone()
            .unwrap_or_else(|| data_dir.join(aurora_instance::MINECRAFT_DIR_NAME));
        Ok(Self {
            config,
            http,
            http_manual,
            runtime: RuntimeContext::current(),
            data_dir,
            game_dir,
            config_path,
            manifest_url: VERSION_MANIFEST_V2.to_owned(),
            modrinth_base: aurora_modplatform::MODRINTH_BASE.to_owned(),
            curseforge_base: aurora_modplatform::CURSEFORGE_BASE.to_owned(),
            fabric_base: "https://meta.fabricmc.net".to_owned(),
            quilt_base: "https://meta.quiltmc.org".to_owned(),
            java_runtime_url: aurora_java::MOJANG_JAVA_RUNTIME_ALL.to_owned(),
            msa_endpoints: MsaEndpoints::default(),
            cancel: None,
            mod_versions: Default::default(),
            source_speed: Arc::new(SourceSpeedCache::new(VERSION_MANIFEST_V2)),
            source_resolver: Arc::new(MirrorResolver),
            source_health: Arc::new(SourceHealth::new()),
            gpu_preferences: Arc::new(RegistryGpuPreferences),
            account_failures: Default::default(),
            #[cfg(test)]
            curseforge_key: None,
            #[cfg(test)]
            curseforge_cdn_scope: None,
            #[cfg(test)]
            download_resolver: None,
        })
    }

    /// 覆盖版本清单地址（默认官方地址）。用于本地 mock 与集成测试。
    pub fn with_manifest_url(mut self, url: impl Into<String>) -> Self {
        self.manifest_url = url.into();
        self
    }

    /// 覆盖微软登录链的端点表（默认生产地址）。用于本地 mock 与集成测试。
    pub fn with_msa_endpoints(mut self, endpoints: MsaEndpoints) -> Self {
        self.msa_endpoints = endpoints;
        self
    }

    /// 覆盖 Modrinth 与 CurseForge 的 API 根地址（默认官方地址）。用于本地 mock 与集成测试。
    pub fn with_platform_bases(
        mut self,
        modrinth: impl Into<String>,
        curseforge: impl Into<String>,
    ) -> Self {
        self.modrinth_base = modrinth.into();
        self.curseforge_base = curseforge.into();
        self
    }

    /// 给这份门面挂上取消令牌，返回挂好的门面。
    ///
    /// 用在长任务的快照上：之后经它装配的下载池（安装、装 Mod）与 Java 运行时下载都会在文件粒度
    /// 检查令牌，触发后以「已取消」返回并清掉临时文件。常驻门面不应挂令牌。
    pub fn with_cancel(mut self, token: CancellationToken) -> Self {
        self.cancel = Some(token);
        self
    }

    /// 挂着的取消令牌是否已触发；常驻门面上恒为 `false`。供不经下载池、却必须在某一点前响应取消的
    /// 流程（如启动在拉起进程前的最后检查）使用。
    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancel
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
    }

    /// 当前外观偏好。
    pub fn appearance(&self) -> Appearance {
        self.config.appearance
    }

    /// 合并一次外观修改并返回合并后的完整偏好；落盘仍需调用 [`Aurora::save_config`]。
    pub fn set_appearance(&mut self, patch: AppearancePatch) -> Appearance {
        self.config.appearance.apply(patch);
        self.config.appearance
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

    /// 设置版本列表源策略（下次取版本清单即生效：清单地址恒为官方地址，选源在取的时候按源计划做）。
    pub fn set_version_list_source(&mut self, policy: DownloadSourcePolicy) {
        self.config.version_list_source = policy;
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

    /// 设置侧栏固定的实例列表。不做校验：校验要扫盘，由 [`Aurora::validate_sidebar_pins`] 在快照上做完再写。
    pub fn set_sidebar_pins(&mut self, pins: Vec<String>) {
        self.config.sidebar_pins = pins;
    }

    /// 设置游戏启动后启动器窗口的去留。
    pub fn set_after_launch(&mut self, after: AfterLaunch) {
        self.config.after_launch = after;
    }

    /// 设置是否自动检查启动器更新。
    pub fn set_check_updates(&mut self, enabled: bool) {
        self.config.check_updates = enabled;
    }

    /// 设置全局默认 Java：`None` 为按版本自动选择，否则固定为这个 java 可执行文件。
    pub fn set_default_java(&mut self, java: Option<PathBuf>) {
        self.config.default_java = java;
    }

    /// 设置启动前是否把这次用的 Java 设为 Windows 图形设置里的「高性能」。
    ///
    /// 关掉时不撤销已经写进 Windows 的值：那里分不出是谁写的，可能是用户自己在系统设置里改的。
    pub fn set_prefer_dedicated_gpu(&mut self, enabled: bool) {
        self.config.prefer_dedicated_gpu = enabled;
    }

    /// 记下用户跳过的启动器版本。
    pub fn set_skipped_update_version(&mut self, version: Option<String>) {
        self.config.skipped_update_version = version;
    }

    /// 记下自动检查已经提示过的启动器版本。
    pub fn set_notified_update_version(&mut self, version: Option<String>) {
        self.config.notified_update_version = version;
    }

    /// 可变访问配置，供本 crate 内按领域分文件的操作（固定服务器、游戏目录、首次启动）改写各自的字段。
    pub(crate) fn config_mut(&mut self) -> &mut AuroraConfig {
        &mut self.config
    }

    // ---- 内部共享装配 ----

    /// 共享 HTTP 客户端（克隆廉价：内部 `Arc`）。
    pub(crate) fn http(&self) -> reqwest::Client {
        self.http.clone()
    }

    /// 不自动跳转的客户端，带下载凭据的请求由调用方逐跳跟随（克隆廉价：内部 `Arc`）。
    pub(crate) fn http_manual(&self) -> reqwest::Client {
        self.http_manual.clone()
    }

    /// 运行环境快照。
    pub(crate) fn runtime(&self) -> &RuntimeContext {
        &self.runtime
    }

    /// 当前游戏目录的路径布局。
    pub(crate) fn layout(&self) -> GameLayout {
        GameLayout::new(&self.game_dir)
    }

    /// 按文件下载源策略生成的单文件引擎配置。只读测速缓存，不发请求：自动档要先经
    /// [`prepare_sources`](Self::prepare_sources) 测过，顺序才是实测的。
    pub(crate) fn download_config(&self) -> DownloadConfig {
        DownloadConfig {
            sources: self.source_plan(self.config.download_source),
            ..DownloadConfig::default()
        }
    }

    /// 按当前配置的下载源策略与并发上限装配一个批量下载池；门面挂了取消令牌时池也挂上。
    pub(crate) fn download_pool(&self) -> DownloadPool {
        let config = self.download_config();
        #[cfg(test)]
        let config = match &self.download_resolver {
            Some(resolver) => DownloadConfig {
                sources: aurora_download::SourcePlan::with_resolver(
                    config.sources.sources.clone(),
                    resolver.clone(),
                ),
                ..config
            },
            None => config,
        };
        let downloader =
            Downloader::with_health(self.http.clone(), config, self.source_health().clone())
                .with_manual_redirect_client(self.http_manual.clone());
        let pool = DownloadPool::new(downloader, self.config.download_concurrency);
        match &self.cancel {
            Some(token) => pool.with_cancel(token.clone()),
            None => pool,
        }
    }

    /// 同 [`download_pool`](Self::download_pool)，并把池里每一批的进度快照节流成
    /// [`CoreEvent::Download`] 投进 `events`。`events` 为 `None` 时与 `download_pool` 相同。
    ///
    /// 转发任务在池被丢弃（watch 发送端全部释放）后发出最后一份快照再结束，因此调用方等事件
    /// 通道排空时会等到它。
    pub(crate) fn download_pool_reporting(&self, events: Option<&EventSink>) -> DownloadPool {
        let pool = self.download_pool();
        let Some(sink) = events.cloned() else {
            return pool;
        };
        let (tx, mut rx) = watch::channel(DownloadProgress::default());
        tokio::spawn(async move {
            while rx.changed().await.is_ok() {
                let snapshot = *rx.borrow_and_update();
                if sink.send(CoreEvent::Download(snapshot)).is_err() {
                    // 接收端已走（命令已返回），再转发没有意义。
                    break;
                }
                tokio::time::sleep(PROGRESS_EVENT_INTERVAL).await;
            }
        });
        pool.with_progress(tx)
    }

    /// 按当前下载源策略装配 Java 运行时安装器；门面挂了取消令牌时安装器也挂上。
    pub(crate) fn java_installer(&self, manifest_url: &str) -> JavaRuntimeInstaller {
        let installer = JavaRuntimeInstaller::new(self.http())
            .with_manifest_url(manifest_url)
            .with_source(self.preferred_source(self.config().download_source));
        match &self.cancel {
            Some(token) => installer.with_cancel(token.clone()),
            None => installer,
        }
    }

    /// 微软登录链的端点表。
    pub(crate) fn msa_endpoints(&self) -> &MsaEndpoints {
        &self.msa_endpoints
    }

    /// 快照上挂的取消令牌（常驻门面为 `None`）；不走下载池的长流程（设备码登录、在阻塞线程里解压
    /// 整合包）据此响应取消。
    pub(crate) fn cancel_token(&self) -> Option<&CancellationToken> {
        self.cancel.as_ref()
    }

    /// 元数据抓取的退避重试策略。
    pub(crate) fn retry_policy(&self) -> RetryPolicy {
        RetryPolicy::default()
    }

    /// 门面共享的下载源健康表。
    pub(crate) fn source_health(&self) -> &Arc<SourceHealth> {
        &self.source_health
    }

    /// 版本清单的官方地址（测试里是注入的 mock 地址）；具体请求哪个源由源计划改写得出。
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

    /// 按程序显卡偏好的写入器（克隆廉价：`Arc`）。
    pub(crate) fn gpu_preferences(&self) -> Arc<dyn GpuPreferenceStore> {
        self.gpu_preferences.clone()
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
        let http_manual =
            aurora_base::http::build_manual_redirect_client().expect("构建测试 HTTP 客户端");
        Self {
            config,
            http,
            http_manual,
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
            msa_endpoints: MsaEndpoints::default(),
            cancel: None,
            mod_versions: Default::default(),
            // 默认测速指向一个不会应答的本机地址且 1 毫秒即超时：走到生成下载计划的既有测试不连真实网络，
            // 也不吃 Windows 上连接被拒要等秒级的延迟；探针全超时即按兜底顺序、不写缓存。
            source_speed: Arc::new(SourceSpeedCache::with_probe(
                VERSION_MANIFEST_V2,
                Arc::new(UnansweredProbe),
                Duration::from_secs(10 * 60),
                Duration::from_millis(1),
            )),
            source_resolver: Arc::new(MirrorResolver),
            source_health: Arc::new(SourceHealth::new()),
            gpu_preferences: Arc::new(crate::gpu::testing::UnsetGpuPreferences),
            account_failures: Default::default(),
            curseforge_key: None,
            curseforge_cdn_scope: None,
            download_resolver: None,
        }
    }

    /// 换掉下载源解析器与测速缓存（两者用同一个解析器），把官方与镜像钉到不同的本地 mock；健康表换新。
    pub(crate) fn with_source_routes(
        mut self,
        resolver: Arc<dyn SourceResolver>,
        ttl: Duration,
        probe_timeout: Duration,
    ) -> Self {
        self.source_speed = Arc::new(SourceSpeedCache::with_probe(
            VERSION_MANIFEST_V2,
            resolver.clone(),
            ttl,
            probe_timeout,
        ));
        self.source_resolver = resolver;
        self.source_health = Arc::new(SourceHealth::new());
        self
    }

    /// 换上显卡偏好写入器的替身。
    pub(crate) fn with_gpu_preference_store(mut self, store: Arc<dyn GpuPreferenceStore>) -> Self {
        self.gpu_preferences = store;
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

    /// 让 CurseForge 客户端用这个 key，不读进程环境。
    pub(crate) fn with_curseforge_key(mut self, key: impl Into<String>) -> Self {
        self.curseforge_key = Some(key.into());
        self
    }

    pub(crate) fn injected_curseforge_key(&self) -> Option<&str> {
        self.curseforge_key.as_deref()
    }

    /// 让 CurseForge 下载凭据只发往这个作用域（测试里指到某一个 wiremock 服务器）。
    pub(crate) fn with_curseforge_cdn_scope(
        mut self,
        scope: aurora_download::CredentialScope,
    ) -> Self {
        self.curseforge_cdn_scope = Some(scope);
        self
    }

    pub(crate) fn injected_curseforge_cdn_scope(
        &self,
    ) -> Option<&aurora_download::CredentialScope> {
        self.curseforge_cdn_scope.as_ref()
    }

    /// 下载池里每个地址先经这个解析器改写。
    pub(crate) fn with_download_resolver(
        mut self,
        resolver: std::sync::Arc<dyn aurora_download::SourceResolver>,
    ) -> Self {
        self.download_resolver = Some(resolver);
        self
    }
}

/// 测试门面默认的测速解析器：所有源都解析到同一个没人应答的本机地址。
#[cfg(test)]
struct UnansweredProbe;

#[cfg(test)]
impl SourceResolver for UnansweredProbe {
    fn resolve(
        &self,
        _url: &str,
        _source: aurora_download::MirrorSource,
    ) -> aurora_download::Result<String> {
        Ok("http://127.0.0.1:9/probe".to_owned())
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
            auto: false,
        });
        aurora.set_isolation_policy(IsolationPolicy::All);

        let cfg = aurora.config();
        assert_eq!(cfg.download_source, DownloadSourcePolicy::MirrorFirst);
        assert_eq!(cfg.download_concurrency, 16);
        assert!(!cfg.auto_download_java);
        assert_eq!(cfg.memory.max_mb, 8192);
        assert_eq!(cfg.memory.min_mb, Some(1024));
        assert!(!cfg.memory.auto);
        assert_eq!(cfg.isolation_policy, IsolationPolicy::All);
    }

    #[test]
    fn system_setters_write_through() {
        let mut aurora = test_aurora();
        aurora.set_after_launch(AfterLaunch::Keep);
        aurora.set_check_updates(false);
        aurora.set_default_java(Some(PathBuf::from("C:/jdk/bin/java.exe")));
        aurora.set_skipped_update_version(Some("0.3.0".to_owned()));
        aurora.set_notified_update_version(Some("0.3.1".to_owned()));

        let cfg = aurora.config();
        assert_eq!(cfg.after_launch, AfterLaunch::Keep);
        assert!(!cfg.check_updates);
        assert_eq!(
            cfg.default_java.as_deref(),
            Some(Path::new("C:/jdk/bin/java.exe"))
        );
        assert_eq!(cfg.skipped_update_version.as_deref(), Some("0.3.0"));
        assert_eq!(cfg.notified_update_version.as_deref(), Some("0.3.1"));

        aurora.set_default_java(None);
        assert!(aurora.config().default_java.is_none());

        assert!(!aurora.config().prefer_dedicated_gpu);
        aurora.set_prefer_dedicated_gpu(true);
        assert!(aurora.config().prefer_dedicated_gpu);
        aurora.set_prefer_dedicated_gpu(false);
        assert!(!aurora.config().prefer_dedicated_gpu);
    }

    /// 改版本列表源只写配置：清单地址仍是官方地址，镜像优先体现在源计划给出的首个候选上。
    #[test]
    fn set_version_list_source_keeps_official_manifest_and_reorders_plan() {
        let mut aurora = test_aurora();
        aurora.set_version_list_source(DownloadSourcePolicy::MirrorFirst);
        assert_eq!(
            aurora.config().version_list_source,
            DownloadSourcePolicy::MirrorFirst
        );
        assert_eq!(aurora.manifest_url(), VERSION_MANIFEST_V2);
        let candidates = aurora
            .source_plan(aurora.config().version_list_source)
            .candidates(aurora.manifest_url())
            .unwrap();
        assert_eq!(
            candidates,
            vec![
                "https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json".to_owned(),
                VERSION_MANIFEST_V2.to_owned(),
            ]
        );

        aurora.set_version_list_source(DownloadSourcePolicy::OfficialFirst);
        let first = aurora
            .source_plan(aurora.config().version_list_source)
            .candidates(aurora.manifest_url())
            .unwrap()
            .remove(0);
        assert_eq!(first, VERSION_MANIFEST_V2);
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
    fn set_appearance_merges_patch_into_config() {
        let mut aurora = test_aurora();
        let merged = aurora.set_appearance(AppearancePatch {
            accent: Some(crate::appearance::AccentColor::Moss),
            panorama: Some(true),
            ..AppearancePatch::default()
        });
        assert_eq!(merged.accent, crate::appearance::AccentColor::Moss);
        assert!(merged.panorama);
        // 未改的字段保持默认，且写进了配置本身。
        assert!(merged.petals);
        assert_eq!(aurora.config().appearance, merged);
        assert_eq!(aurora.appearance(), merged);
    }

    /// 快照挂令牌后装配的下载池会响应取消；常驻门面不受影响。
    #[tokio::test]
    async fn snapshot_with_cancel_propagates_to_download_pool() {
        let aurora = test_aurora();
        let token = CancellationToken::new();
        let snapshot = aurora.clone().with_cancel(token.clone());
        token.cancel();

        let dir = tempfile::tempdir().unwrap();
        let task = aurora_download::DownloadTask::new(
            "http://127.0.0.1:9/never.jar",
            dir.path().join("never.jar"),
        );
        let err = snapshot
            .download_pool()
            .download_all(vec![task], None)
            .await
            .unwrap_err();
        assert!(err.is_cancelled(), "实际：{err:?}");
        assert!(aurora.cancel.is_none(), "常驻门面不应被快照的令牌影响");
    }

    /// 进度转发：池里一批下载的快照被节流成 Download 事件，最后一条是完成态且带总字节数；
    /// 池被丢弃后转发任务释放事件通道，接收端能读到结束。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn download_pool_reporting_forwards_final_snapshot() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        for (route, body) in [("/a", "aaaa"), ("/b", "bbbbbb")] {
            Mock::given(method("GET"))
                .and(path(route))
                .respond_with(ResponseTemplate::new(200).set_body_string(body))
                .mount(&server)
                .await;
        }
        let dir = tempfile::tempdir().unwrap();
        let tasks = vec![
            aurora_download::DownloadTask::new(format!("{}/a", server.uri()), dir.path().join("a"))
                .with_size(4),
            aurora_download::DownloadTask::new(format!("{}/b", server.uri()), dir.path().join("b"))
                .with_size(6),
        ];

        let aurora = test_aurora();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let pool = aurora.download_pool_reporting(Some(&tx));
        let report = pool.download_all(tasks, None).await.unwrap();
        assert!(report.is_success());
        drop(pool);
        drop(tx);

        let mut downloads = Vec::new();
        while let Some(event) = rx.recv().await {
            if let CoreEvent::Download(progress) = event {
                downloads.push(progress);
            }
        }
        let last = downloads.last().expect("至少应转发一条下载进度");
        assert_eq!(last.total, 2);
        assert_eq!(last.finished, 2);
        assert_eq!(last.total_bytes, Some(10));
        assert_eq!(last.bytes, 10);
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
