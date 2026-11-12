//! 门面结构 [`Petalfall`]：持有全局配置、共享 HTTP 客户端与运行环境，组合下层 crate 对外提供粗粒度
//! 异步 API。目标是让 Tauri 外壳与 CLI 只依赖本 crate。
//!
//! 各操作（版本清单、安装、登录、启动、搜索）分散在同名子模块的 `impl Petalfall` 块里，本文件只负责
//! 结构定义、构造与共享的内部辅助（目录布局、下载池、并发上下文装配）。远端端点基址以字段持有，
//! 生产走各官方/镜像默认，单元测试用 `with_*` 注入本地 mock。
//!
//! 门面可廉价克隆（HTTP 客户端内部是 `Arc`，其余是配置与路径）。上层把它放在读写锁里，长任务
//! 先克隆一份快照再放锁，网络等待期间不占锁；快照上可挂取消令牌（[`Petalfall::with_cancel`]），
//! 经它装配的下载池与 Java 下载都会响应取消。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use petalfall_auth::MsaEndpoints;
use petalfall_base::fs::DataDirResolution;
use petalfall_base::retry::RetryPolicy;
use petalfall_download::{
    CancellationToken, DownloadConfig, DownloadPool, DownloadProgress, Downloader, MirrorResolver,
    SourceHealth, SourceResolver, SourceSpeedCache,
};
use petalfall_install::{GameLayout, InstallContext, VERSION_MANIFEST_V2};
use petalfall_instance::IsolationPolicy;
use petalfall_java::JavaRuntimeInstaller;
use petalfall_version::RuntimeContext;
use tokio::sync::watch;

use crate::appearance::{Appearance, AppearancePatch};
use crate::config::{AfterLaunch, DownloadSourcePolicy, MemorySettings, PetalfallConfig};
use crate::data_format::{DATA_FORMAT, check_data_root};
use crate::error::Result;
use crate::event::{CoreEvent, EventSink};
use crate::gpu::{GpuPreferenceStore, RegistryGpuPreferences};

/// 下载进度事件的最小间隔。采样器每 100 ms 推一次快照，逐文件完成时还会额外推一次；
/// 上千个小文件的资源批次若逐条转发，事件通道与前端 IPC 都会被灌满，按此间隔只留最新快照。
pub(crate) const PROGRESS_EVENT_INTERVAL: Duration = Duration::from_millis(100);

/// 门面：组合下层 crate 的统一入口。
#[derive(Clone)]
pub struct Petalfall {
    config: PetalfallConfig,
    http: reqwest::Client,
    /// 不自动跟随跳转的客户端，只给带下载凭据的任务用：自动跟随会把凭据头原样带到下一跳的主机，
    /// 由下载引擎逐跳决定带不带。
    http_manual: reqwest::Client,
    /// 跳转只跟到 https 的客户端，只给自更新的请求用（给更新包下载源测速）：明文那一跳会泄露在下哪个版本，
    /// 还能被中间人替源站作答。其余请求的下载源可能合法地跳到 http，不跟着收紧。
    http_update: reqwest::Client,
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
    /// 配置之外的微软登录 client_id（运行期环境变量或构建时内嵌），构造时取一次，见
    /// [`crate::auth::fallback_msa_client_id`]；测试门面为 `None`。
    msa_fallback_client_id: Option<String>,
    /// 长任务快照上挂的取消令牌；常驻门面上恒为 `None`。
    cancel: Option<CancellationToken>,
    /// 应用版本，写数据格式记号时记成「是哪个版本写的」。只有桌面应用经 [`Petalfall::with_app_version`]
    /// 给得出；命令行与测试的门面为 `None`，写出的记号不带这一项。
    pub(crate) app_version: Option<String>,
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
    /// 读系统显示语言；测试注入替身，断言才不随本机语言漂移。
    system_language: fn() -> Option<String>,
    /// 各账户最近一次账户类启动失败，以离线方式进单人时据此放行。与工程版本缓存一样放在门面上：快照
    /// 克隆共享同一个句柄，重开门面即清空。
    pub(crate) account_failures: crate::launch::AccountFailures,
    /// 外置令牌轮换的闸，退出前关上并等进行中的落盘（见 [`crate::auth::RotationGate`]）。随快照共享：轮换多半开在
    /// 命令的快照上。
    pub(crate) rotations: crate::auth::RotationGate,
    /// 测试注入的 CurseForge key：生产只认运行期环境变量与构建时内嵌的 key，测试改不了进程环境，
    /// 有了它 CurseForge 路径上的门面级行为才写得出端到端测试。
    #[cfg(test)]
    curseforge_key: Option<String>,
    /// 测试把 CurseForge 下载凭据的作用域换成本地 mock：生产作用域只认 https 的 forgecdn.net。
    #[cfg(test)]
    curseforge_cdn_scope: Option<petalfall_download::CredentialScope>,
    /// 测试注入的下载地址改写：往返测试要让导入侧把清单里的正式 CDN 地址下到本地 mock，又不能放松导入
    /// 对清单地址的白名单校验，只能在下载池这一层改写。
    #[cfg(test)]
    download_resolver: Option<std::sync::Arc<dyn petalfall_download::SourceResolver>>,
    /// 测试注入的 authlib-injector 构建信息地址：生产地址是写死的常量，测不到启动时这一步。
    #[cfg(test)]
    authlib_latest_url: Option<String>,
}

impl Petalfall {
    /// 以默认数据目录构造：从 `<数据目录>/config.json` 载入配置，构建共享 HTTP 客户端。
    ///
    /// 游戏目录取配置的 `game_directory`，缺省为 `<数据目录>/.minecraft`。读配置之前先核对数据目录的数据格式
    /// 记号（[`check_data_root`]），不放行时报 [`crate::error::CoreError::DataRootRefused`]。
    pub async fn load() -> Result<Self> {
        Self::load_with(&petalfall_base::fs::resolve_data_dir()?, DATA_FORMAT).await
    }

    /// 同 [`Petalfall::load`]，但配置文件损坏时不报错：坏文件改名留存、按默认配置构造，并交回经过；
    /// 只是个别枚举取值不认识时文件不动，交回退回默认的那几项。
    /// 给桌面应用启动用：那时还没有窗口能显示错误，报错等于一声不响地打不开。
    pub async fn load_recovering() -> Result<(Self, Option<crate::config::ConfigRecovery>)> {
        Self::load_recovering_with(&petalfall_base::fs::resolve_data_dir()?, DATA_FORMAT).await
    }

    /// [`Petalfall::load`] 的实现：数据目录的定位结果与这一版的数据格式号从参数进来，测试才指得到临时目录、
    /// 换得了号。
    ///
    /// 门面构造时还不知道应用版本，记号要抬号时写出的不带 `written_by`；桌面应用在这之前已经带着版本过了
    /// 同一道关卡，走到这里时记号已是这一版的号，什么都不写。
    async fn load_with(resolution: &DataDirResolution, own: u32) -> Result<Self> {
        check_data_root(resolution, own, None).await?;
        let data_dir = resolution.path.clone();
        let config_path = data_dir.join("config.json");
        let config = crate::config::ConfigStore::at(&config_path).load().await?;
        Self::open(config, data_dir, config_path)
    }

    /// [`Petalfall::load_recovering`] 的实现，参数同 [`Petalfall::load_with`]。
    ///
    /// 关卡必须在读配置之前：读不懂的配置在这里会被改名、按默认重置，而更新的版本写的配置在这一版可能正是
    /// 读不懂的，号比这一版大时一个字节都不能碰。
    async fn load_recovering_with(
        resolution: &DataDirResolution,
        own: u32,
    ) -> Result<(Self, Option<crate::config::ConfigRecovery>)> {
        check_data_root(resolution, own, None).await?;
        let data_dir = resolution.path.clone();
        let config_path = data_dir.join("config.json");
        let (config, recovery) = crate::config::ConfigStore::at(&config_path)
            .load_or_preserve()
            .await?;
        Ok((Self::open(config, data_dir, config_path)?, recovery))
    }

    /// 用显式配置与数据目录构造（供 CLI 应用命令行覆盖后调用，或测试注入）。
    pub fn open(config: PetalfallConfig, data_dir: PathBuf, config_path: PathBuf) -> Result<Self> {
        let http = petalfall_base::http::build_client()?;
        let http_manual = petalfall_base::http::build_manual_redirect_client()?;
        let http_update = petalfall_base::http::build_https_redirect_client()?;
        let game_dir = config
            .game_directory
            .clone()
            .unwrap_or_else(|| data_dir.join(petalfall_instance::MINECRAFT_DIR_NAME));
        Ok(Self {
            config,
            http,
            http_manual,
            http_update,
            runtime: RuntimeContext::current(),
            data_dir,
            game_dir,
            config_path,
            manifest_url: VERSION_MANIFEST_V2.to_owned(),
            modrinth_base: petalfall_modplatform::MODRINTH_BASE.to_owned(),
            curseforge_base: petalfall_modplatform::CURSEFORGE_BASE.to_owned(),
            fabric_base: "https://meta.fabricmc.net".to_owned(),
            quilt_base: "https://meta.quiltmc.org".to_owned(),
            java_runtime_url: petalfall_java::MOJANG_JAVA_RUNTIME_ALL.to_owned(),
            msa_endpoints: MsaEndpoints::default(),
            msa_fallback_client_id: crate::auth::fallback_msa_client_id(),
            cancel: None,
            app_version: None,
            mod_versions: Default::default(),
            source_speed: Arc::new(SourceSpeedCache::new(VERSION_MANIFEST_V2)),
            source_resolver: Arc::new(MirrorResolver),
            source_health: Arc::new(SourceHealth::new()),
            gpu_preferences: Arc::new(RegistryGpuPreferences),
            system_language: sys_locale::get_locale,
            account_failures: Default::default(),
            rotations: Default::default(),
            #[cfg(test)]
            curseforge_key: None,
            #[cfg(test)]
            curseforge_cdn_scope: None,
            #[cfg(test)]
            download_resolver: None,
            #[cfg(test)]
            authlib_latest_url: None,
        })
    }

    /// 以带应用版本的 User-Agent（`Petalfall/<应用版本>`）重建三个共享 HTTP 客户端。
    ///
    /// 构造时的客户端用的是 petalfall-base 自己的 crate 版本，发版只改应用版本时它不会跟着变；镜像站按 UA
    /// 统计与限流，一个永远不变的版本号让对方分不出新旧客户端。不自动跳转的与跳转只跟 https 的也得重建：带凭据的
    /// 下载与更新源测速分别走它们，漏掉的话同一个应用会发出两种 UA。桌面应用在构造门面后、任何请求之前调用。
    ///
    /// 版本同时记在门面上（随快照克隆），游戏目录的数据格式记号抬号时记成是哪个版本写的。
    pub fn with_app_version(mut self, version: &str) -> Result<Self> {
        let config = petalfall_base::http::HttpConfig::for_app_version(version);
        self.http = petalfall_base::http::build_client_with(&config)?;
        self.http_manual = petalfall_base::http::build_manual_redirect_client_with(&config)?;
        self.http_update = petalfall_base::http::build_https_redirect_client_with(&config)?;
        self.app_version = Some(version.to_owned());
        Ok(self)
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

    /// 合并一次外观修改并返回合并后的完整偏好；落盘仍需调用 [`Petalfall::save_config`]。
    pub fn set_appearance(&mut self, patch: AppearancePatch) -> Appearance {
        self.config.appearance.apply(patch);
        self.config.appearance
    }

    /// 只读访问当前配置。
    pub fn config(&self) -> &PetalfallConfig {
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

    /// 去掉填过的 client_id，回到运行期环境变量或构建时内嵌的值。
    pub fn clear_client_id(&mut self) {
        self.config.msa_client_id = None;
    }

    /// 把当前配置写回配置文件。
    ///
    /// 要可变借用：取值不认识、暂用默认值的枚举字段，没改过时写回原值；改成别的取值写进文件之后，
    /// 原值随之作废，这份记录得跟着门面走，后面改回默认时才按默认写。
    pub async fn save_config(&mut self) -> Result<()> {
        crate::config::ConfigStore::at(&self.config_path)
            .save_settling(&mut self.config)
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

    /// 设置游戏目录并写入配置（区别于仅改运行期字段的 [`Petalfall::set_game_dir`]）。
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

    /// 设置侧栏固定的实例列表。不做校验：校验要扫盘，由 [`Petalfall::validate_sidebar_pins`] 在快照上做完再写。
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

    /// 设置启动前是否跳过游戏的首次无障碍引导。
    ///
    /// 只决定缺这一项的 options.txt 补不补；已经写进文件的值不跟着改，分不出它是启动器写的还是玩家留下的。
    pub fn set_skip_accessibility_onboarding(&mut self, enabled: bool) {
        self.config.skip_accessibility_onboarding = enabled;
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
    pub(crate) fn config_mut(&mut self) -> &mut PetalfallConfig {
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

    /// 跳转只跟到 https 的客户端，只给自更新的请求用（克隆廉价：内部 `Arc`）。
    pub(crate) fn http_update(&self) -> reqwest::Client {
        self.http_update.clone()
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
                sources: petalfall_download::SourcePlan::with_resolver(
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
        let health = self.source_health().clone();
        let installer = JavaRuntimeInstaller::new(self.http())
            .with_manifest_url(manifest_url)
            .with_source(self.preferred_source(self.config().download_source))
            .with_candidate_order(Arc::new(move |candidates| health.prioritize(candidates)));
        match &self.cancel {
            Some(token) => installer.with_cancel(token.clone()),
            None => installer,
        }
    }

    /// 配置之外的微软登录 client_id（运行期环境变量或构建时内嵌）。
    pub(crate) fn msa_fallback_client_id(&self) -> Option<&str> {
        self.msa_fallback_client_id.as_deref()
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

    /// 系统显示语言的 BCP 47 标签（如 `zh-CN`）；读不出来时为 `None`。
    pub(crate) fn system_language(&self) -> Option<String> {
        (self.system_language)()
    }
}

/// 装配一个安装上下文所需的一束借用（生命周期绑定到传入的各组件）。
///
/// 安装/补全类操作先建 `layout`/`pool`/`policy` 局部变量，再借此函数打成 [`InstallContext`]，避免每处
/// 重复五参数样板。`cancel` 传门面快照上的令牌（[`Petalfall::cancel_token`]）：元数据抓取与 Forge
/// 处理器不经过下载池，只从上下文里看取消；必填是为了让每个造上下文的地方都想到它。
pub(crate) fn make_context<'a>(
    http: &'a reqwest::Client,
    pool: &'a DownloadPool,
    layout: &'a GameLayout,
    runtime: &'a RuntimeContext,
    policy: &'a RetryPolicy,
    cancel: Option<&'a CancellationToken>,
) -> InstallContext<'a> {
    InstallContext::new(http, pool, layout, runtime, policy).with_cancel(cancel)
}

#[cfg(test)]
impl Petalfall {
    /// 测试构造：以显式配置、数据目录、游戏目录建门面，端点基址随后用 `with_*` 注入。
    pub(crate) fn for_test(config: PetalfallConfig, data_dir: PathBuf, game_dir: PathBuf) -> Self {
        let http = petalfall_base::http::build_client().expect("构建测试 HTTP 客户端");
        let http_manual =
            petalfall_base::http::build_manual_redirect_client().expect("构建测试 HTTP 客户端");
        let http_update =
            petalfall_base::http::build_https_redirect_client().expect("构建测试 HTTP 客户端");
        Self {
            config,
            http,
            http_manual,
            http_update,
            runtime: RuntimeContext::new(petalfall_version::OsName::Windows, "x86_64", 64),
            data_dir,
            config_path: game_dir.join("config.json"),
            game_dir,
            manifest_url: VERSION_MANIFEST_V2.to_owned(),
            modrinth_base: petalfall_modplatform::MODRINTH_BASE.to_owned(),
            curseforge_base: petalfall_modplatform::CURSEFORGE_BASE.to_owned(),
            fabric_base: "https://meta.fabricmc.net".to_owned(),
            quilt_base: "https://meta.quiltmc.org".to_owned(),
            java_runtime_url: petalfall_java::MOJANG_JAVA_RUNTIME_ALL.to_owned(),
            msa_endpoints: MsaEndpoints::default(),
            msa_fallback_client_id: None,
            cancel: None,
            app_version: None,
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
            system_language: || None,
            account_failures: Default::default(),
            rotations: Default::default(),
            curseforge_key: None,
            curseforge_cdn_scope: None,
            download_resolver: None,
            authlib_latest_url: None,
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

    /// 换上系统语言的替身。
    pub(crate) fn with_system_language(mut self, read: fn() -> Option<String>) -> Self {
        self.system_language = read;
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

    /// 装上配置之外的微软登录 client_id，相当于运行期设了环境变量或构建时内嵌了它。
    pub(crate) fn with_msa_fallback_client_id(mut self, id: impl Into<String>) -> Self {
        self.msa_fallback_client_id = Some(id.into());
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
        scope: petalfall_download::CredentialScope,
    ) -> Self {
        self.curseforge_cdn_scope = Some(scope);
        self
    }

    pub(crate) fn injected_curseforge_cdn_scope(
        &self,
    ) -> Option<&petalfall_download::CredentialScope> {
        self.curseforge_cdn_scope.as_ref()
    }

    /// 启动时查 authlib-injector 最新构建改查这个地址。
    pub(crate) fn with_authlib_latest_url(mut self, url: String) -> Self {
        self.authlib_latest_url = Some(url);
        self
    }

    pub(crate) fn injected_authlib_latest_url(&self) -> Option<&str> {
        self.authlib_latest_url.as_deref()
    }

    /// 下载池里每个地址先经这个解析器改写。
    pub(crate) fn with_download_resolver(
        mut self,
        resolver: std::sync::Arc<dyn petalfall_download::SourceResolver>,
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
        _source: petalfall_download::MirrorSource,
    ) -> petalfall_download::Result<String> {
        Ok("http://127.0.0.1:9/probe".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet};
    use std::ffi::OsString;

    use petalfall_instance::PETALFALL_META_DIR;

    use super::*;
    use crate::config::ConfigRecovery;
    use crate::data_format::testing::{GuardFixture, with_fixture};
    use crate::data_format::{DataRootRefusal, GameDirCheck, GuardMode, STAMP_FILE};
    use crate::error::CoreError;

    fn test_petalfall() -> Petalfall {
        Petalfall::for_test(
            PetalfallConfig::default(),
            PathBuf::from("/data"),
            PathBuf::from("/data/.minecraft"),
        )
    }

    #[test]
    fn config_setters_write_through() {
        let mut petalfall = test_petalfall();
        petalfall.set_download_source(DownloadSourcePolicy::MirrorFirst);
        petalfall.set_download_concurrency(16);
        petalfall.set_auto_download_java(false);
        petalfall.set_memory(MemorySettings {
            max_mb: 8192,
            min_mb: Some(1024),
            auto: false,
        });
        petalfall.set_isolation_policy(IsolationPolicy::All);

        let cfg = petalfall.config();
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
        let mut petalfall = test_petalfall();
        petalfall.set_after_launch(AfterLaunch::Keep);
        petalfall.set_check_updates(false);
        petalfall.set_default_java(Some(PathBuf::from("C:/jdk/bin/java.exe")));
        petalfall.set_skipped_update_version(Some("0.3.0".to_owned()));
        petalfall.set_notified_update_version(Some("0.3.1".to_owned()));

        let cfg = petalfall.config();
        assert_eq!(cfg.after_launch, AfterLaunch::Keep);
        assert!(!cfg.check_updates);
        assert_eq!(
            cfg.default_java.as_deref(),
            Some(Path::new("C:/jdk/bin/java.exe"))
        );
        assert_eq!(cfg.skipped_update_version.as_deref(), Some("0.3.0"));
        assert_eq!(cfg.notified_update_version.as_deref(), Some("0.3.1"));

        petalfall.set_default_java(None);
        assert!(petalfall.config().default_java.is_none());

        assert!(!petalfall.config().prefer_dedicated_gpu);
        petalfall.set_prefer_dedicated_gpu(true);
        assert!(petalfall.config().prefer_dedicated_gpu);
        petalfall.set_prefer_dedicated_gpu(false);
        assert!(!petalfall.config().prefer_dedicated_gpu);

        assert!(petalfall.config().skip_accessibility_onboarding);
        petalfall.set_skip_accessibility_onboarding(false);
        assert!(!petalfall.config().skip_accessibility_onboarding);
        petalfall.set_skip_accessibility_onboarding(true);
        assert!(petalfall.config().skip_accessibility_onboarding);
    }

    /// 改版本列表源只写配置：清单地址仍是官方地址，镜像优先体现在源计划给出的首个候选上。
    #[test]
    fn set_version_list_source_keeps_official_manifest_and_reorders_plan() {
        let mut petalfall = test_petalfall();
        petalfall.set_version_list_source(DownloadSourcePolicy::MirrorFirst);
        assert_eq!(
            petalfall.config().version_list_source,
            DownloadSourcePolicy::MirrorFirst
        );
        assert_eq!(petalfall.manifest_url(), VERSION_MANIFEST_V2);
        let candidates = petalfall
            .source_plan(petalfall.config().version_list_source)
            .candidates(petalfall.manifest_url())
            .unwrap();
        assert_eq!(
            candidates,
            vec![
                "https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json".to_owned(),
                VERSION_MANIFEST_V2.to_owned(),
            ]
        );

        petalfall.set_version_list_source(DownloadSourcePolicy::OfficialFirst);
        let first = petalfall
            .source_plan(petalfall.config().version_list_source)
            .candidates(petalfall.manifest_url())
            .unwrap()
            .remove(0);
        assert_eq!(first, VERSION_MANIFEST_V2);
    }

    #[test]
    fn set_game_directory_syncs_runtime_and_config() {
        let mut petalfall = test_petalfall();
        petalfall.set_game_directory(PathBuf::from("/games/mc"));
        assert_eq!(petalfall.game_dir(), Path::new("/games/mc"));
        assert_eq!(
            petalfall.config().game_directory.as_deref(),
            Some(Path::new("/games/mc"))
        );
    }

    #[test]
    fn set_appearance_merges_patch_into_config() {
        let mut petalfall = test_petalfall();
        let merged = petalfall.set_appearance(AppearancePatch {
            accent: Some(crate::appearance::AccentColor::Moss),
            panorama: Some(true),
            ..AppearancePatch::default()
        });
        assert_eq!(merged.accent, crate::appearance::AccentColor::Moss);
        assert!(merged.panorama);
        // 未改的字段保持默认，且写进了配置本身。
        assert!(merged.petals);
        assert_eq!(petalfall.config().appearance, merged);
        assert_eq!(petalfall.appearance(), merged);
    }

    /// 快照挂令牌后装配的下载池会响应取消；常驻门面不受影响。
    #[tokio::test]
    async fn snapshot_with_cancel_propagates_to_download_pool() {
        let petalfall = test_petalfall();
        let token = CancellationToken::new();
        let snapshot = petalfall.clone().with_cancel(token.clone());
        token.cancel();

        let dir = tempfile::tempdir().unwrap();
        let task = petalfall_download::DownloadTask::new(
            "http://127.0.0.1:9/never.jar",
            dir.path().join("never.jar"),
        );
        let err = snapshot
            .download_pool()
            .download_all(vec![task], None)
            .await
            .unwrap_err();
        assert!(err.is_cancelled(), "实际：{err:?}");
        assert!(petalfall.cancel.is_none(), "常驻门面不应被快照的令牌影响");
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
            petalfall_download::DownloadTask::new(
                format!("{}/a", server.uri()),
                dir.path().join("a"),
            )
            .with_size(4),
            petalfall_download::DownloadTask::new(
                format!("{}/b", server.uri()),
                dir.path().join("b"),
            )
            .with_size(6),
        ];

        let petalfall = test_petalfall();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let pool = petalfall.download_pool_reporting(Some(&tx));
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
        assert_eq!(last.transferred, 10);
    }

    /// 门面发出的请求带应用版本的 User-Agent，不自动跳转的与跳转只跟 https 的客户端也一样；快照（克隆）共用
    /// 同样的客户端，同样带着。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn requests_carry_the_app_version_in_user_agent() {
        use wiremock::matchers::{header, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/ua"))
            .and(header("user-agent", "Petalfall/2.3.0-beta.1"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        let petalfall = test_petalfall().with_app_version("2.3.0-beta.1").unwrap();
        let snapshot = petalfall.clone();
        for facade in [&petalfall, &snapshot] {
            for client in [facade.http(), facade.http_manual(), facade.http_update()] {
                let status = client
                    .get(format!("{}/ua", server.uri()))
                    .send()
                    .await
                    .unwrap()
                    .status();
                assert_eq!(status.as_u16(), 204, "UA 不是应用版本时 mock 回 404");
            }
        }
        let default = test_petalfall()
            .http()
            .get(format!("{}/ua", server.uri()))
            .send()
            .await
            .unwrap()
            .status();
        assert_eq!(default.as_u16(), 404);
    }

    #[test]
    fn set_selected_version_updates_config() {
        let mut petalfall = test_petalfall();
        assert!(petalfall.config().selected_version.is_none());
        petalfall.set_selected_version(Some("1.20.1-Forge_47.4.20".to_owned()));
        assert_eq!(
            petalfall.config().selected_version.as_deref(),
            Some("1.20.1-Forge_47.4.20")
        );
        // 传 None 清空选择；删掉 setter 里的赋值这两条断言即挂。
        petalfall.set_selected_version(None);
        assert!(petalfall.config().selected_version.is_none());
    }

    // ---- 构造时的数据格式关卡 ----

    /// 被更新的预览版抬到 3 的数据目录记号。
    const STAMP_3: &str = r#"{"data_format":3,"written_by":"1.1.0-dev.57"}"#;
    /// 读得进来的配置。并发上限不是默认值，门面读的是不是这一份一看便知。
    const CONFIG: &[u8] = br#"{"download_concurrency":16}"#;
    /// 不是合法 JSON 的配置：恢复式构造会把它改名留存。
    const BROKEN_CONFIG: &[u8] = b"{ broken";

    /// 门面的两个构造。
    #[derive(Debug, Clone, Copy)]
    enum Load {
        Plain,
        Recovering,
    }

    impl Load {
        /// 在数据目录 `root` 上以本版号 `own` 构造；普通构造没有处置经过，交回 `None`。
        async fn run(self, root: &Path, own: u32) -> Result<(Petalfall, Option<ConfigRecovery>)> {
            let resolution = resolution(root);
            match self {
                Load::Plain => Ok((Petalfall::load_with(&resolution, own).await?, None)),
                Load::Recovering => Petalfall::load_recovering_with(&resolution, own).await,
            }
        }

        /// 同 [`Load::run`]，但应当被拒绝：交回错误，放行了就当场失败。
        async fn refused(self, root: &Path, own: u32) -> CoreError {
            match self.run(root, own).await {
                Ok(_) => panic!("{self:?}：应拒绝，实际放行"),
                Err(err) => err,
            }
        }
    }

    fn resolution(root: &Path) -> DataDirResolution {
        DataDirResolution {
            path: root.to_owned(),
            portable: true,
            fallback_reason: None,
            write_failure: None,
            elapsed: Duration::ZERO,
        }
    }

    /// 放着 `config` 与（可有可无的）记号的临时数据目录。
    fn data_root(config: &[u8], stamp: Option<&str>) -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("config.json"), config).unwrap();
        if let Some(stamp) = stamp {
            std::fs::write(tmp.path().join(STAMP_FILE), stamp).unwrap();
        }
        tmp
    }

    /// 目录下每个条目的名字与文件字节（文件夹记 `None`）。前后各拍一次，比对出有没有改动、改名、多出或少了文件。
    fn entries(dir: &Path) -> BTreeMap<OsString, Option<Vec<u8>>> {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| {
                let entry = entry.unwrap();
                let path = entry.path();
                let bytes = path.is_file().then(|| std::fs::read(&path).unwrap());
                (entry.file_name(), bytes)
            })
            .collect()
    }

    #[tokio::test]
    async fn a_newer_data_root_is_refused_and_nothing_in_it_changes() {
        for load in [Load::Plain, Load::Recovering] {
            let tmp = data_root(CONFIG, Some(STAMP_3));
            let root = tmp.path();
            let before = entries(root);

            match load.refused(root, 2).await {
                CoreError::DataRootRefused(DataRootRefusal::TooNew {
                    path,
                    found,
                    supported,
                    written_by,
                }) => {
                    assert_eq!(path, root.join(STAMP_FILE), "{load:?}");
                    assert_eq!((found, supported), (3, 2), "{load:?}");
                    assert_eq!(written_by.as_deref(), Some("1.1.0-dev.57"), "{load:?}");
                }
                other => panic!("{load:?}：应判为数据比这一版新，实际是 {other:?}"),
            }
            assert_eq!(
                std::fs::read(root.join("config.json")).unwrap(),
                CONFIG,
                "{load:?}"
            );
            // 没有 .broken 留存，也没有任何新文件。
            assert_eq!(entries(root), before, "{load:?}");
        }
    }

    #[tokio::test]
    async fn an_unreadable_data_root_stamp_is_refused_and_nothing_is_written() {
        for load in [Load::Plain, Load::Recovering] {
            for stamp in ["not json", r#"{"data_format":"2"}"#] {
                let tmp = data_root(CONFIG, Some(stamp));
                let root = tmp.path();
                let before = entries(root);

                match load.refused(root, 2).await {
                    CoreError::DataRootRefused(DataRootRefusal::Unreadable { path, .. }) => {
                        assert_eq!(path, root.join(STAMP_FILE), "{load:?} {stamp}");
                    }
                    other => panic!("{load:?} {stamp}：应判为读不懂，实际是 {other:?}"),
                }
                assert_eq!(entries(root), before, "{load:?} {stamp}");
            }
        }
    }

    #[tokio::test]
    async fn format_one_builds_from_the_config_without_writing_anything() {
        for load in [Load::Plain, Load::Recovering] {
            let tmp = data_root(CONFIG, None);
            let root = tmp.path();
            let before = entries(root);

            let (petalfall, recovery) = load.run(root, 1).await.unwrap();

            assert_eq!(petalfall.data_dir(), root, "{load:?}");
            assert_eq!(petalfall.game_dir(), root.join(".minecraft"), "{load:?}");
            assert_eq!(petalfall.config().download_concurrency, 16, "{load:?}");
            assert_eq!(recovery, None, "{load:?}");
            assert_eq!(entries(root), before, "{load:?}");
        }
    }

    #[tokio::test]
    async fn format_two_raises_a_missing_stamp_without_written_by() {
        for load in [Load::Plain, Load::Recovering] {
            let tmp = data_root(CONFIG, None);
            let root = tmp.path();

            let (petalfall, recovery) = load.run(root, 2).await.unwrap();

            assert_eq!(petalfall.config().download_concurrency, 16, "{load:?}");
            assert_eq!(recovery, None, "{load:?}");
            // 门面构造时不知道应用版本，记号里没有 written_by。
            assert_eq!(
                std::fs::read_to_string(root.join(STAMP_FILE)).unwrap(),
                r#"{"data_format":2}"#,
                "{load:?}"
            );
            assert_eq!(
                std::fs::read(root.join("config.json")).unwrap(),
                CONFIG,
                "{load:?}"
            );
            // 原子写的临时文件也不留下。
            assert_eq!(
                entries(root).into_keys().collect::<BTreeSet<_>>(),
                BTreeSet::from([OsString::from("config.json"), OsString::from(STAMP_FILE)]),
                "{load:?}"
            );
        }
    }

    /// 坏配置与太新的记号同在时，先被关卡拒绝，坏配置原样留着：关卡排在读配置之后的话，恢复式构造会先把它
    /// 改名。末尾把记号换成这一版的号再走一遍，证明这份配置确实会被改名，前面原样留着不是因为它没坏。
    #[tokio::test]
    async fn a_newer_data_root_is_refused_before_a_broken_config_is_renamed() {
        for load in [Load::Plain, Load::Recovering] {
            let tmp = data_root(BROKEN_CONFIG, Some(STAMP_3));
            let root = tmp.path();
            let before = entries(root);

            match load.refused(root, 2).await {
                CoreError::DataRootRefused(DataRootRefusal::TooNew {
                    found: 3,
                    supported: 2,
                    ..
                }) => {}
                other => panic!("{load:?}：应先被数据目录的关卡拒绝，实际是 {other:?}"),
            }
            assert_eq!(entries(root), before, "{load:?}");
        }

        let tmp = data_root(BROKEN_CONFIG, Some(r#"{"data_format":2}"#));
        let root = tmp.path();
        match Load::Plain.refused(root, 2).await {
            CoreError::ConfigParse { path, .. } => assert_eq!(path, root.join("config.json")),
            other => panic!("关卡放行后应报配置读不出来，实际是 {other:?}"),
        }
        let (_, recovery) = Load::Recovering.run(root, 2).await.unwrap();
        match recovery {
            Some(ConfigRecovery::Reset { preserved, .. }) => {
                assert_eq!(std::fs::read(&preserved).unwrap(), BROKEN_CONFIG);
            }
            other => panic!("关卡放行后坏配置应被改名留存，实际是 {other:?}"),
        }
        assert!(!root.join("config.json").exists());
    }

    /// 上面的用例走的是可注入的两个实现。生产入口是否经过它们、传的是否是这一版的号，钉住源码；关卡是否在读
    /// 配置之前也钉住：配置读得进来时，把关卡挪到读配置之后，「太新」与「读不懂」的用例照样过。
    #[test]
    fn constructors_check_the_data_root_before_reading_the_config() {
        for (entry, inner) in [
            ("    pub async fn load() ", "Self::load_with("),
            (
                "    pub async fn load_recovering() ",
                "Self::load_recovering_with(",
            ),
        ] {
            let body = method_source(entry);
            for call in [
                inner,
                "petalfall_base::fs::resolve_data_dir()?",
                "DATA_FORMAT",
            ] {
                assert!(body.contains(call), "{call}\n{body}");
            }
        }
        for signature in [
            "    async fn load_with(",
            "    async fn load_recovering_with(",
        ] {
            let body = method_source(signature);
            let gate = body
                .find("check_data_root(resolution, own, None).await?")
                .unwrap_or_else(|| panic!("没有过数据目录的关卡\n{body}"));
            let config = body
                .find("ConfigStore::at(")
                .unwrap_or_else(|| panic!("不再读配置\n{body}"));
            assert!(gate < config, "关卡应在读配置之前\n{body}");
        }
    }

    /// 本文件里签名行以 `signature` 开头的方法（`impl` 块里缩进四格），从签名行到同一缩进的收尾 `}`。
    fn method_source(signature: &str) -> String {
        let source = include_str!("facade.rs");
        let starts = |line: &&str| line.starts_with(signature);
        assert_eq!(source.lines().filter(starts).count(), 1, "{signature}");
        let mut body = Vec::new();
        for line in source.lines().skip_while(|line| !starts(line)) {
            body.push(line);
            if line.trim_end() == "    }" {
                break;
            }
        }
        body.join("\n")
    }

    #[test]
    fn with_app_version_is_recorded_on_the_facade_and_its_snapshots() {
        assert_eq!(test_petalfall().app_version, None);
        let petalfall = test_petalfall().with_app_version("1.2.3").unwrap();
        let snapshot = petalfall.clone();
        assert_eq!(petalfall.app_version.as_deref(), Some("1.2.3"));
        assert_eq!(snapshot.app_version.as_deref(), Some("1.2.3"));
    }

    /// 抬号写游戏目录的记号时，`written_by` 取 `with_app_version` 记下的版本；没调用过时不写这一项。
    #[tokio::test]
    async fn a_game_dir_stamp_names_the_version_given_to_with_app_version() {
        for (app_version, expected) in [
            (Some("1.2.3"), r#"{"data_format":2,"written_by":"1.2.3"}"#),
            (None, r#"{"data_format":2}"#),
        ] {
            let tmp = tempfile::tempdir().unwrap();
            let game_dir = tmp.path().join(".minecraft");
            std::fs::create_dir(&game_dir).unwrap();
            let mut petalfall = Petalfall::for_test(
                PetalfallConfig::default(),
                tmp.path().to_owned(),
                game_dir.clone(),
            );
            if let Some(version) = app_version {
                petalfall = petalfall.with_app_version(version).unwrap();
            }
            // 命令都在快照上跑，记号也由快照写。
            let snapshot = petalfall.clone();

            let check = with_fixture(
                GuardFixture { own: 2, look: None },
                snapshot.guard_game_dir(GuardMode::Use),
            )
            .await
            .unwrap();

            assert_eq!(check, GameDirCheck::Ready, "{app_version:?}");
            assert_eq!(
                std::fs::read_to_string(game_dir.join(PETALFALL_META_DIR).join(STAMP_FILE))
                    .unwrap(),
                expected,
                "{app_version:?}"
            );
        }
    }
}
