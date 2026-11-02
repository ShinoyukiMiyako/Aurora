//! 全局配置：读取、按字段更新，以及游戏目录的并存、切换与检查。

use std::path::{Path, PathBuf};

use petalfall_core::config::UiLanguage;
use petalfall_core::folders::{
    default_game_dir, inspect_game_directory as inspect_dir, probe_dir, validate_game_dir,
};
use petalfall_core::{
    AfterLaunch, CoreError, DownloadSourcePolicy, GameDirProblem, GameDirectoryEntry,
    IsolationPolicy, MemorySettings, NamedDirectory, Petalfall, WorldBackupSettings,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, State};

use crate::commands::CommandError;
use crate::facade::Facade;

/// `default_java` 取这个值表示按版本自动选择。
pub const DEFAULT_JAVA_AUTO: &str = "auto";

/// 同时下载的文件数的取值范围（设置页滑杆 8-256，步进 8；后端只挡住会让下载池卡死或失控的值）。
const CONCURRENCY_RANGE: std::ops::RangeInclusive<usize> = 1..=256;

/// 最大堆的下限（MB），与设置页内存滑杆的最小值一致。
const MIN_MAX_MEMORY_MB: u32 = 1024;

/// 每个存档保留的自动备份份数。至少 1 份，否则刚备份完就被清掉；上限只挡住失控的值。
const KEEP_PER_WORLD_RANGE: std::ops::RangeInclusive<u32> = 1..=50;

/// 全部备份的总量上限（GB）。至少 1 GB；上限只挡住失控的值。
const MAX_TOTAL_GB_RANGE: std::ops::RangeInclusive<u32> = 1..=1000;

/// 全局配置 DTO。
///
/// 枚举在 petalfall-core 已 derive Serialize 且为 snake_case，直接内嵌即得稳定的 JSON 表示，
/// 且与 `update_config` 的入参同名。
#[derive(Debug, Serialize)]
pub struct ConfigDto {
    /// 当前游戏目录（`.minecraft`）绝对路径。
    pub game_dir: String,
    /// 数据目录下的默认游戏目录，「用回默认位置」用它。
    pub default_game_dir: String,
    /// 数据目录绝对路径。
    pub data_dir: String,
    /// 文件下载源策略。
    pub download_source: DownloadSourcePolicy,
    /// 版本列表源策略。
    pub version_list_source: DownloadSourcePolicy,
    /// 批量下载文件级并发上限。
    pub download_concurrency: usize,
    /// 内存分配设置（含是否自动分配）。
    pub memory: MemorySettings,
    /// 全局版本隔离档位。
    pub isolation_policy: IsolationPolicy,
    /// 是否填了自定义的微软登录 client_id（不回传 id 本身）。没填时用运行期环境变量或构建时内嵌的值。
    pub has_client_id: bool,
    /// 微软登录能不能用：配置、环境变量、构建时内嵌三处至少有一个 client_id。
    pub microsoft_login_available: bool,
    /// 找不到匹配 Java 时是否自动下载。
    pub auto_download_java: bool,
    /// 全局默认 Java：`"auto"` 或 java 可执行文件绝对路径。
    pub default_java: String,
    /// 游戏启动后启动器窗口的去留。
    pub after_launch: AfterLaunch,
    /// 是否自动检查启动器更新。
    pub check_updates: bool,
    /// 自定义缓存目录；未设置时为 null。
    pub cache_directory: Option<String>,
    /// 主页当前选中的实例 id；未选择时为 null。
    pub selected_version: Option<String>,
    /// 用户跳过的启动器版本。
    pub skipped_update_version: Option<String>,
    /// 自动检查已提示过的启动器版本。
    pub notified_update_version: Option<String>,
    /// 界面语言：`"zh-CN"` 或 `"en-US"`。
    pub language: UiLanguage,
    /// 手动添加的 java 可执行文件路径（java.exe），只经 add_java_path / remove_java_path 修改。
    pub extra_java_paths: Vec<String>,
    /// 启动前是否把这次用的 Java 设为 Windows 图形设置里的「高性能」。
    pub prefer_dedicated_gpu: bool,
    /// 启动前是否跳过游戏的首次无障碍引导。
    pub skip_accessibility_onboarding: bool,
    /// 存档自动备份：`{ auto, keep_per_world, max_total_gb }`。
    pub world_backup: WorldBackupSettings,
}

pub(crate) fn config_dto(petalfall: &Petalfall) -> ConfigDto {
    let config = petalfall.config();
    ConfigDto {
        game_dir: petalfall.game_dir().display().to_string(),
        default_game_dir: default_game_dir(petalfall.data_dir()).display().to_string(),
        data_dir: petalfall.data_dir().display().to_string(),
        download_source: config.download_source,
        version_list_source: config.version_list_source,
        download_concurrency: config.download_concurrency,
        memory: config.memory,
        isolation_policy: config.isolation_policy,
        has_client_id: config.msa_client_id.is_some(),
        microsoft_login_available: petalfall.microsoft_login_available(),
        auto_download_java: config.auto_download_java,
        default_java: match &config.default_java {
            Some(path) => path.display().to_string(),
            None => DEFAULT_JAVA_AUTO.to_owned(),
        },
        after_launch: config.after_launch,
        check_updates: config.check_updates,
        cache_directory: config
            .cache_directory
            .as_ref()
            .map(|dir| dir.display().to_string()),
        selected_version: config.selected_version.clone(),
        skipped_update_version: config.skipped_update_version.clone(),
        notified_update_version: config.notified_update_version.clone(),
        language: config.language,
        extra_java_paths: config
            .extra_java_paths
            .iter()
            .map(|path| path.display().to_string())
            .collect(),
        prefer_dedicated_gpu: config.prefer_dedicated_gpu,
        skip_accessibility_onboarding: config.skip_accessibility_onboarding,
        world_backup: config.world_backup,
    }
}

/// 只在内存里读，持读锁的时间只有一次结构体拷贝。
pub(crate) async fn read_config(facade: &Facade) -> ConfigDto {
    config_dto(&*facade.read().await)
}

/// 读取全局配置。
#[tauri::command]
pub async fn get_config(facade: State<'_, Facade>) -> Result<ConfigDto, CommandError> {
    Ok(read_config(&facade).await)
}

/// 内存设置入参：三个字段都必须给出。缺 `auto` 时若按默认值补上，界面上关掉的自动分配会被
/// 悄悄打开，所以不复用配置文件那套带默认值的反序列化。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MemoryInput {
    pub max_mb: u32,
    pub min_mb: Option<u32>,
    pub auto: bool,
}

/// 存档自动备份入参：三项都必须给出，理由与 [`MemoryInput`] 相同（缺 `auto` 时按默认值补上，界面上关掉的
/// 自动备份会被悄悄打开）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorldBackupInput {
    pub auto: bool,
    pub keep_per_world: u32,
    pub max_total_gb: u32,
}

/// 解析好的配置修改；`None` 的字段不动。
#[derive(Debug, Default, PartialEq)]
pub(crate) struct ConfigPatch {
    download_source: Option<DownloadSourcePolicy>,
    version_list_source: Option<DownloadSourcePolicy>,
    download_concurrency: Option<usize>,
    memory: Option<MemorySettings>,
    isolation_policy: Option<IsolationPolicy>,
    auto_download_java: Option<bool>,
    cache_directory: Option<PathBuf>,
    /// `Some(None)` 是清掉填过的 client_id。
    client_id: Option<Option<String>>,
    selected_version: Option<String>,
    after_launch: Option<AfterLaunch>,
    check_updates: Option<bool>,
    default_java: Option<Option<PathBuf>>,
    skipped_update_version: Option<String>,
    notified_update_version: Option<String>,
    language: Option<UiLanguage>,
    prefer_dedicated_gpu: Option<bool>,
    skip_accessibility_onboarding: Option<bool>,
    world_backup: Option<WorldBackupSettings>,
}

/// 未解析的配置修改，字段与 `update_config` 的入参一一对应。
#[derive(Debug, Default)]
pub(crate) struct RawConfigPatch {
    pub download_source: Option<String>,
    pub version_list_source: Option<String>,
    pub download_concurrency: Option<usize>,
    pub memory: Option<MemoryInput>,
    pub isolation_policy: Option<String>,
    pub auto_download_java: Option<bool>,
    pub cache_directory: Option<String>,
    pub client_id: Option<String>,
    pub clear_client_id: Option<bool>,
    pub selected_version: Option<String>,
    pub after_launch: Option<String>,
    pub check_updates: Option<bool>,
    pub default_java: Option<String>,
    pub skipped_update_version: Option<String>,
    pub notified_update_version: Option<String>,
    pub language: Option<String>,
    pub prefer_dedicated_gpu: Option<bool>,
    pub skip_accessibility_onboarding: Option<bool>,
    pub world_backup: Option<WorldBackupInput>,
}

/// 更新全局配置：字段全可选，未提供者不动。先把全部参数校验完再拿写锁：有一个非法就整体拒绝，
/// 不会改了一半才报错，也不落盘。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn update_config(
    download_source: Option<String>,
    version_list_source: Option<String>,
    download_concurrency: Option<usize>,
    memory: Option<MemoryInput>,
    isolation_policy: Option<String>,
    auto_download_java: Option<bool>,
    cache_directory: Option<String>,
    client_id: Option<String>,
    clear_client_id: Option<bool>,
    selected_version: Option<String>,
    after_launch: Option<String>,
    check_updates: Option<bool>,
    default_java: Option<String>,
    skipped_update_version: Option<String>,
    notified_update_version: Option<String>,
    language: Option<String>,
    prefer_dedicated_gpu: Option<bool>,
    skip_accessibility_onboarding: Option<bool>,
    world_backup: Option<WorldBackupInput>,
    facade: State<'_, Facade>,
) -> Result<(), CommandError> {
    let raw = RawConfigPatch {
        download_source,
        version_list_source,
        download_concurrency,
        memory,
        isolation_policy,
        auto_download_java,
        cache_directory,
        client_id,
        clear_client_id,
        selected_version,
        after_launch,
        check_updates,
        default_java,
        skipped_update_version,
        notified_update_version,
        language,
        prefer_dedicated_gpu,
        skip_accessibility_onboarding,
        world_backup,
    };
    update_config_with(&facade, raw).await
}

pub(crate) async fn update_config_with(
    facade: &Facade,
    raw: RawConfigPatch,
) -> Result<(), CommandError> {
    let patch = parse_patch(raw).await?;
    facade
        .update(|petalfall| apply_patch(petalfall, patch))
        .await
}

async fn parse_patch(raw: RawConfigPatch) -> Result<ConfigPatch, CommandError> {
    let default_java = match raw.default_java {
        Some(value) => Some(parse_default_java(&value).await?),
        None => None,
    };
    Ok(ConfigPatch {
        download_source: raw
            .download_source
            .as_deref()
            .map(parse_download_source_policy)
            .transpose()?,
        version_list_source: raw
            .version_list_source
            .as_deref()
            .map(parse_download_source_policy)
            .transpose()?,
        download_concurrency: raw
            .download_concurrency
            .map(validate_concurrency)
            .transpose()?,
        memory: raw.memory.map(validate_memory).transpose()?,
        isolation_policy: raw
            .isolation_policy
            .as_deref()
            .map(parse_isolation_policy)
            .transpose()?,
        auto_download_java: raw.auto_download_java,
        cache_directory: raw.cache_directory.map(PathBuf::from),
        client_id: parse_client_id(raw.client_id, raw.clear_client_id)?,
        selected_version: raw.selected_version,
        after_launch: raw
            .after_launch
            .as_deref()
            .map(parse_after_launch)
            .transpose()?,
        check_updates: raw.check_updates,
        default_java,
        skipped_update_version: raw.skipped_update_version,
        notified_update_version: raw.notified_update_version,
        language: raw.language.as_deref().map(parse_language).transpose()?,
        prefer_dedicated_gpu: raw.prefer_dedicated_gpu,
        skip_accessibility_onboarding: raw.skip_accessibility_onboarding,
        world_backup: raw.world_backup.map(validate_world_backup).transpose()?,
    })
}

fn apply_patch(petalfall: &mut Petalfall, patch: ConfigPatch) -> Result<(), CommandError> {
    if let Some(policy) = patch.download_source {
        petalfall.set_download_source(policy);
    }
    if let Some(policy) = patch.version_list_source {
        petalfall.set_version_list_source(policy);
    }
    if let Some(concurrency) = patch.download_concurrency {
        petalfall.set_download_concurrency(concurrency);
    }
    if let Some(memory) = patch.memory {
        petalfall.set_memory(memory);
    }
    if let Some(policy) = patch.isolation_policy {
        petalfall.set_isolation_policy(policy);
    }
    if let Some(enabled) = patch.auto_download_java {
        petalfall.set_auto_download_java(enabled);
    }
    if let Some(dir) = patch.cache_directory {
        petalfall.set_cache_directory(Some(dir));
    }
    match patch.client_id {
        Some(Some(id)) => petalfall.set_client_id(id),
        Some(None) => petalfall.clear_client_id(),
        None => {}
    }
    if let Some(id) = patch.selected_version {
        petalfall.set_selected_version(Some(id));
    }
    if let Some(after) = patch.after_launch {
        petalfall.set_after_launch(after);
    }
    if let Some(enabled) = patch.check_updates {
        petalfall.set_check_updates(enabled);
    }
    if let Some(java) = patch.default_java {
        petalfall.set_default_java(java);
    }
    if let Some(version) = patch.skipped_update_version {
        petalfall.set_skipped_update_version(Some(version));
    }
    if let Some(version) = patch.notified_update_version {
        petalfall.set_notified_update_version(Some(version));
    }
    if let Some(language) = patch.language {
        petalfall.set_language(language);
    }
    if let Some(enabled) = patch.prefer_dedicated_gpu {
        petalfall.set_prefer_dedicated_gpu(enabled);
    }
    if let Some(enabled) = patch.skip_accessibility_onboarding {
        petalfall.set_skip_accessibility_onboarding(enabled);
    }
    if let Some(settings) = patch.world_backup {
        petalfall.set_world_backup(settings);
    }
    Ok(())
}

// 字符串取值统一用核心类型 serde 的 snake_case 表示，与出参 DTO 同一套命名，round-trip 一致。
// 非法值报 invalid_argument，绝不静默兜底一个默认值。

fn parse_download_source_policy(name: &str) -> Result<DownloadSourcePolicy, CommandError> {
    match name {
        "auto" => Ok(DownloadSourcePolicy::Auto),
        "official_first" => Ok(DownloadSourcePolicy::OfficialFirst),
        "mirror_first" => Ok(DownloadSourcePolicy::MirrorFirst),
        other => Err(CommandError::invalid_argument(format!(
            "未知下载源策略 {other}（支持 auto/official_first/mirror_first）"
        ))),
    }
}

fn parse_isolation_policy(name: &str) -> Result<IsolationPolicy, CommandError> {
    match name {
        "disabled" => Ok(IsolationPolicy::Disabled),
        "mod_loaders_only" => Ok(IsolationPolicy::ModLoadersOnly),
        "non_release_only" => Ok(IsolationPolicy::NonReleaseOnly),
        "mod_loaders_and_non_release" => Ok(IsolationPolicy::ModLoadersAndNonRelease),
        "all" => Ok(IsolationPolicy::All),
        other => Err(CommandError::invalid_argument(format!(
            "未知隔离档位 {other}"
        ))),
    }
}

fn parse_after_launch(name: &str) -> Result<AfterLaunch, CommandError> {
    match name {
        "keep" => Ok(AfterLaunch::Keep),
        "minimize" => Ok(AfterLaunch::Minimize),
        "close" => Ok(AfterLaunch::Close),
        other => Err(CommandError::invalid_argument(format!(
            "未知的启动后行为 {other}（支持 keep/minimize/close）"
        ))),
    }
}

fn parse_language(name: &str) -> Result<UiLanguage, CommandError> {
    match name {
        "zh-CN" => Ok(UiLanguage::ZhCn),
        "en-US" => Ok(UiLanguage::EnUs),
        other => Err(CommandError::invalid_argument(format!(
            "未知的界面语言 {other}（支持 zh-CN/en-US）"
        ))),
    }
}

fn validate_concurrency(value: usize) -> Result<usize, CommandError> {
    if CONCURRENCY_RANGE.contains(&value) {
        Ok(value)
    } else {
        Err(CommandError::invalid_argument(format!(
            "同时下载的文件数须在 {} 到 {} 之间，收到 {value}",
            CONCURRENCY_RANGE.start(),
            CONCURRENCY_RANGE.end()
        )))
    }
}

fn validate_memory(input: MemoryInput) -> Result<MemorySettings, CommandError> {
    if input.max_mb < MIN_MAX_MEMORY_MB {
        return Err(CommandError::invalid_argument(format!(
            "最大内存不能低于 {MIN_MAX_MEMORY_MB} MB，收到 {}",
            input.max_mb
        )));
    }
    if let Some(min) = input.min_mb {
        if min == 0 || min > input.max_mb {
            return Err(CommandError::invalid_argument(format!(
                "最小内存须在 1 到最大内存 {} MB 之间，收到 {min}",
                input.max_mb
            )));
        }
    }
    Ok(MemorySettings {
        max_mb: input.max_mb,
        min_mb: input.min_mb,
        auto: input.auto,
    })
}

fn validate_world_backup(input: WorldBackupInput) -> Result<WorldBackupSettings, CommandError> {
    let out_of_range =
        |field: &str, label: &str, value: u32, range: &std::ops::RangeInclusive<u32>| {
            CommandError::invalid_argument(format!(
                "{label}须在 {} 到 {} 之间，收到 {value}",
                range.start(),
                range.end()
            ))
            .with_detail(json!({ "field": field, "value": value }))
        };
    if !KEEP_PER_WORLD_RANGE.contains(&input.keep_per_world) {
        return Err(out_of_range(
            "world_backup.keep_per_world",
            "每个存档保留的自动备份份数",
            input.keep_per_world,
            &KEEP_PER_WORLD_RANGE,
        ));
    }
    if !MAX_TOTAL_GB_RANGE.contains(&input.max_total_gb) {
        return Err(out_of_range(
            "world_backup.max_total_gb",
            "备份总量上限（GB）",
            input.max_total_gb,
            &MAX_TOTAL_GB_RANGE,
        ));
    }
    Ok(WorldBackupSettings {
        auto: input.auto,
        keep_per_world: input.keep_per_world,
        max_total_gb: input.max_total_gb,
    })
}

/// 填新值与清掉二选一；`clearClientId: false` 等于没给。
fn parse_client_id(
    client_id: Option<String>,
    clear: Option<bool>,
) -> Result<Option<Option<String>>, CommandError> {
    match (client_id, clear == Some(true)) {
        (Some(_), true) => Err(CommandError::invalid_argument(
            "clientId 与 clearClientId 不能同时给",
        )),
        (Some(id), false) => Ok(Some(Some(validate_client_id(id)?))),
        (None, true) => Ok(Some(None)),
        (None, false) => Ok(None),
    }
}

fn validate_client_id(id: String) -> Result<String, CommandError> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Err(CommandError::invalid_argument("client_id 不能为空"));
    }
    Ok(trimmed.to_owned())
}

/// `"auto"` 为自动选择；否则必须是存在的 java 可执行文件的绝对路径。
async fn parse_default_java(value: &str) -> Result<Option<PathBuf>, CommandError> {
    if value == DEFAULT_JAVA_AUTO {
        return Ok(None);
    }
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(CommandError::invalid_argument(format!(
            "默认 Java 须是 \"{DEFAULT_JAVA_AUTO}\" 或 java 可执行文件的绝对路径，收到 {value}"
        )));
    }
    let is_file = tokio::fs::metadata(&path)
        .await
        .is_ok_and(|meta| meta.is_file());
    if !is_file {
        return Err(CommandError::invalid_argument(format!(
            "默认 Java 指向的文件不存在：{value}"
        )));
    }
    Ok(Some(path))
}

// ---- 游戏目录 ----

/// 一条游戏目录记录。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GameDirectoryDto {
    pub name: String,
    pub path: String,
    /// 是否为当前正在使用的目录。
    pub is_current: bool,
    /// 此刻能否访问；为假时记录仍保留。
    pub available: bool,
    /// `versions/` 下的版本目录数，没有 `versions/` 算 0。不可达、探测超时或读取失败时为 null，不等于 0。
    pub version_count: Option<u32>,
}

/// 一条带名字的目录（探测结果与首次启动勾选项）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NamedDirectoryDto {
    pub name: String,
    pub path: String,
}

/// 候选目录的检查结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct GameDirectoryInspectionDto {
    pub exists: bool,
    /// 已有 `versions` 文件夹（会直接接管已有游戏文件）。
    pub has_versions: bool,
}

fn game_directory_dto(entry: GameDirectoryEntry) -> GameDirectoryDto {
    GameDirectoryDto {
        name: entry.name,
        path: entry.path.display().to_string(),
        is_current: entry.is_current,
        available: entry.available,
        version_count: entry.version_count,
    }
}

fn named_dto(dir: NamedDirectory) -> NamedDirectoryDto {
    NamedDirectoryDto {
        name: dir.name,
        path: dir.path.display().to_string(),
    }
}

/// 把界面传来的带名目录校验成核心类型：路径按游戏目录规则校验，名字去空白后不能为空。
pub(crate) fn parse_named_directory(
    dto: NamedDirectoryDto,
) -> Result<NamedDirectory, CommandError> {
    let path = validate_game_dir(&dto.path)?;
    let name = dto.name.trim();
    if name.is_empty() {
        return Err(CommandError::invalid_argument(format!(
            "目录 {} 的名字不能为空",
            path.display()
        )));
    }
    Ok(NamedDirectory {
        name: name.to_owned(),
        path,
    })
}

/// 列出全部已知游戏目录：当前目录在前，其余按记录顺序；各目录并发限时探测是否可达与版本数。
#[tauri::command]
pub async fn list_game_directories(
    facade: State<'_, Facade>,
) -> Result<Vec<GameDirectoryDto>, CommandError> {
    let petalfall = facade.snapshot().await;
    Ok(petalfall
        .game_directories()
        .await
        .into_iter()
        .map(game_directory_dto)
        .collect())
}

/// 探测这台机器上尚未记录的其它启动器的 `.minecraft`。只报告不写入。
#[tauri::command]
pub async fn discover_game_directories(
    facade: State<'_, Facade>,
) -> Result<Vec<NamedDirectoryDto>, CommandError> {
    let petalfall = facade.snapshot().await;
    Ok(petalfall
        .discover_game_directories()
        .await
        .into_iter()
        .map(named_dto)
        .collect())
}

/// 记下一个额外目录。同路径已记录时只更新名字；与当前目录相同时什么都不做。
#[tauri::command]
pub async fn add_game_directory(
    name: String,
    path: String,
    facade: State<'_, Facade>,
) -> Result<(), CommandError> {
    add_game_directory_with(&facade, &name, &path).await
}

pub(crate) async fn add_game_directory_with(
    facade: &Facade,
    name: &str,
    path: &str,
) -> Result<(), CommandError> {
    let dir = parse_named_directory(NamedDirectoryDto {
        name: name.to_owned(),
        path: path.to_owned(),
    })?;
    facade
        .update(|petalfall| {
            petalfall.add_game_directory(dir.name, dir.path);
            Ok::<_, CommandError>(())
        })
        .await
}

/// 移除一个额外目录的记录（不动磁盘文件）。返回是否真的移除了一条。
#[tauri::command]
pub async fn remove_game_directory(
    path: String,
    facade: State<'_, Facade>,
) -> Result<bool, CommandError> {
    Ok(facade
        .update_if_changed(|petalfall| petalfall.remove_game_directory(Path::new(path.trim())))
        .await?)
}

/// 切换当前游戏目录并落盘；原目录收进其它文件夹。目标必须是此刻可访问的目录。
#[tauri::command]
pub async fn set_game_directory(
    app: AppHandle,
    path: String,
    facade: State<'_, Facade>,
) -> Result<(), CommandError> {
    let outcome = set_game_directory_with(&facade, &path).await;
    crate::textures::refresh_on_success(&app, &outcome).await;
    outcome
}

pub(crate) async fn set_game_directory_with(
    facade: &Facade,
    raw: &str,
) -> Result<(), CommandError> {
    let target = validate_game_dir(raw)?;
    // 探测在拿写锁之前：挂起的网络盘最多卡住这一个命令，不连累其它读配置的命令。
    if !probe_dir(&target).await {
        return Err(CoreError::InvalidGameDirectory {
            path: target,
            problem: GameDirProblem::Unavailable,
        }
        .into());
    }
    let current = facade.snapshot().await.probe_current_game_dir().await;
    facade
        .update(|petalfall| {
            petalfall.switch_game_directory(target, &current);
            Ok::<_, CommandError>(())
        })
        .await
}

/// 检查一个候选目录：是否存在、是否已有游戏文件。路径须先通过游戏目录校验。
#[tauri::command]
pub async fn inspect_game_directory(
    path: String,
) -> Result<GameDirectoryInspectionDto, CommandError> {
    let path = validate_game_dir(&path)?;
    let inspection = inspect_dir(&path).await;
    Ok(GameDirectoryInspectionDto {
        exists: inspection.exists,
        has_versions: inspection.has_versions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::error::code;
    use petalfall_core::PetalfallConfig;

    fn facade_in(dir: &Path) -> Facade {
        let petalfall = Petalfall::open(
            PetalfallConfig::default(),
            dir.to_path_buf(),
            dir.join("config.json"),
        )
        .unwrap();
        Facade::new(petalfall)
    }

    #[test]
    fn enum_strings_roundtrip_with_serde_names() {
        for policy in [
            DownloadSourcePolicy::Auto,
            DownloadSourcePolicy::OfficialFirst,
            DownloadSourcePolicy::MirrorFirst,
        ] {
            let name = serde_json::to_value(policy).unwrap();
            assert_eq!(
                parse_download_source_policy(name.as_str().unwrap()).unwrap(),
                policy
            );
        }
        for policy in [
            IsolationPolicy::Disabled,
            IsolationPolicy::ModLoadersOnly,
            IsolationPolicy::NonReleaseOnly,
            IsolationPolicy::ModLoadersAndNonRelease,
            IsolationPolicy::All,
        ] {
            let name = serde_json::to_value(policy).unwrap();
            assert_eq!(
                parse_isolation_policy(name.as_str().unwrap()).unwrap(),
                policy
            );
        }
        for after in [AfterLaunch::Keep, AfterLaunch::Minimize, AfterLaunch::Close] {
            let name = serde_json::to_value(after).unwrap();
            assert_eq!(parse_after_launch(name.as_str().unwrap()).unwrap(), after);
        }
        for language in [UiLanguage::ZhCn, UiLanguage::EnUs] {
            let name = serde_json::to_value(language).unwrap();
            assert_eq!(parse_language(name.as_str().unwrap()).unwrap(), language);
        }
        for bad in ["zh-cn", "zh_CN", "en", "fr-FR", ""] {
            assert_eq!(
                parse_language(bad).unwrap_err().code,
                code::INVALID_ARGUMENT,
                "{bad}"
            );
        }
        assert_eq!(
            parse_download_source_policy("bmclapi").unwrap_err().code,
            code::INVALID_ARGUMENT
        );
        assert_eq!(
            parse_isolation_policy("Disabled").unwrap_err().code,
            code::INVALID_ARGUMENT
        );
        assert_eq!(
            parse_after_launch("Minimize").unwrap_err().code,
            code::INVALID_ARGUMENT
        );
    }

    #[test]
    fn concurrency_and_memory_bounds_are_enforced() {
        assert_eq!(validate_concurrency(1).unwrap(), 1);
        assert_eq!(validate_concurrency(256).unwrap(), 256);
        assert!(
            validate_concurrency(0).is_err(),
            "0 会让下载池永远拿不到许可"
        );
        assert!(validate_concurrency(257).is_err());

        let ok = MemoryInput {
            max_mb: 1024,
            min_mb: Some(1024),
            auto: false,
        };
        assert_eq!(
            validate_memory(ok).unwrap(),
            MemorySettings {
                max_mb: 1024,
                min_mb: Some(1024),
                auto: false
            }
        );
        for bad in [
            MemoryInput {
                max_mb: 1023,
                min_mb: None,
                auto: true,
            },
            MemoryInput {
                max_mb: 4096,
                min_mb: Some(4097),
                auto: false,
            },
            MemoryInput {
                max_mb: 4096,
                min_mb: Some(0),
                auto: false,
            },
        ] {
            assert_eq!(
                validate_memory(bad).unwrap_err().code,
                code::INVALID_ARGUMENT
            );
        }
    }

    #[test]
    fn memory_input_requires_every_field() {
        let missing_auto = serde_json::json!({"max_mb": 4096, "min_mb": null});
        assert!(serde_json::from_value::<MemoryInput>(missing_auto).is_err());
        let camel = serde_json::json!({"maxMb": 4096, "min_mb": null, "auto": true});
        assert!(serde_json::from_value::<MemoryInput>(camel).is_err());
        let full = serde_json::json!({"max_mb": 4096, "min_mb": null, "auto": false});
        assert!(!serde_json::from_value::<MemoryInput>(full).unwrap().auto);
    }

    /// 份数与总量上限按闭区间校验，越界报 invalid_argument 并在 detail.field 指出是哪一项。
    #[test]
    fn world_backup_bounds_are_enforced_per_field() {
        let input = |keep_per_world, max_total_gb| WorldBackupInput {
            auto: false,
            keep_per_world,
            max_total_gb,
        };
        for (keep, gb) in [(1, 1), (50, 1000), (5, 20)] {
            assert_eq!(
                validate_world_backup(input(keep, gb)).unwrap(),
                WorldBackupSettings {
                    auto: false,
                    keep_per_world: keep,
                    max_total_gb: gb,
                }
            );
        }
        for (keep, gb, field, value) in [
            (0, 20, "world_backup.keep_per_world", 0),
            (51, 20, "world_backup.keep_per_world", 51),
            (5, 0, "world_backup.max_total_gb", 0),
            (5, 1001, "world_backup.max_total_gb", 1001),
            (u32::MAX, 20, "world_backup.keep_per_world", u32::MAX),
        ] {
            let err = validate_world_backup(input(keep, gb)).unwrap_err();
            assert_eq!(err.code, code::INVALID_ARGUMENT, "{keep} {gb}");
            let detail = err.detail.unwrap();
            assert_eq!(detail["field"], field, "{keep} {gb}");
            assert_eq!(detail["value"], value, "{keep} {gb}");
        }
    }

    #[test]
    fn world_backup_input_requires_every_field() {
        for partial in [
            serde_json::json!({"keep_per_world": 5, "max_total_gb": 20}),
            serde_json::json!({"auto": true, "max_total_gb": 20}),
            serde_json::json!({"auto": true, "keep_per_world": 5}),
            serde_json::json!({"auto": true, "keepPerWorld": 5, "max_total_gb": 20}),
            serde_json::json!({"auto": true, "keep_per_world": 5, "max_total_gb": 20, "extra": 1}),
            serde_json::json!({"auto": true, "keep_per_world": -1, "max_total_gb": 20}),
        ] {
            assert!(
                serde_json::from_value::<WorldBackupInput>(partial.clone()).is_err(),
                "{partial}"
            );
        }
        let full = serde_json::json!({"auto": false, "keep_per_world": 10, "max_total_gb": 50});
        assert_eq!(
            serde_json::from_value::<WorldBackupInput>(full).unwrap(),
            WorldBackupInput {
                auto: false,
                keep_per_world: 10,
                max_total_gb: 50,
            }
        );
    }

    /// 自动备份设置三项一起写：出参与落盘都是写下的值；任一项越界整体拒绝，别的字段也不生效。
    #[tokio::test]
    async fn world_backup_patch_is_written_whole_and_rejected_whole() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_in(dir.path());
        let initial = serde_json::to_value(read_config(&facade).await).unwrap();
        assert_eq!(
            initial["world_backup"],
            serde_json::json!({ "auto": true, "keep_per_world": 5, "max_total_gb": 20 })
        );

        update_config_with(
            &facade,
            RawConfigPatch {
                world_backup: Some(WorldBackupInput {
                    auto: false,
                    keep_per_world: 10,
                    max_total_gb: 50,
                }),
                ..RawConfigPatch::default()
            },
        )
        .await
        .unwrap();
        let written = serde_json::to_value(read_config(&facade).await).unwrap();
        assert_eq!(
            written["world_backup"],
            serde_json::json!({ "auto": false, "keep_per_world": 10, "max_total_gb": 50 })
        );
        let reloaded = petalfall_core::ConfigStore::at(dir.path().join("config.json"))
            .load()
            .await
            .unwrap();
        assert_eq!(
            reloaded.world_backup,
            WorldBackupSettings {
                auto: false,
                keep_per_world: 10,
                max_total_gb: 50,
            }
        );

        let err = update_config_with(
            &facade,
            RawConfigPatch {
                check_updates: Some(false),
                world_backup: Some(WorldBackupInput {
                    auto: true,
                    keep_per_world: 3,
                    max_total_gb: 1001,
                }),
                ..RawConfigPatch::default()
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, code::INVALID_ARGUMENT);
        assert_eq!(err.detail.unwrap()["field"], "world_backup.max_total_gb");
        let after = read_config(&facade).await;
        assert!(after.check_updates, "同一补丁里合法的字段也不生效");
        assert_eq!(after.world_backup, reloaded.world_backup);
    }

    /// 没有 world_backup 的旧配置文件照常读入，取默认值（开、每个存档 5 份、总量 20 GB）。
    #[tokio::test]
    async fn config_without_world_backup_reads_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(
            &path,
            r#"{"check_updates": false, "download_concurrency": 16}"#,
        )
        .unwrap();
        let config = petalfall_core::ConfigStore::at(path).load().await.unwrap();
        assert!(!config.check_updates);
        assert_eq!(config.download_concurrency, 16);
        let petalfall = Petalfall::open(
            config,
            dir.path().to_path_buf(),
            dir.path().join("config.json"),
        )
        .unwrap();
        let dto = serde_json::to_value(config_dto(&petalfall)).unwrap();
        assert_eq!(
            dto["world_backup"],
            serde_json::json!({ "auto": true, "keep_per_world": 5, "max_total_gb": 20 })
        );
    }

    /// 填进 client_id 后微软登录即可用；填之前与清掉之后可不可用，取决于这台机器设没设环境变量、编译时有没有内嵌。
    #[tokio::test]
    async fn microsoft_login_follows_a_saved_then_cleared_client_id() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_in(dir.path());
        let before = read_config(&facade).await;
        assert!(!before.has_client_id);
        let has_fallback = option_env!("PETALFALL_MSA_CLIENT_ID")
            .is_some_and(|id| !id.trim().is_empty())
            || std::env::var(petalfall_core::MSA_CLIENT_ID_ENV)
                .is_ok_and(|id| !id.trim().is_empty());
        assert_eq!(before.microsoft_login_available, has_fallback);

        update_config_with(
            &facade,
            RawConfigPatch {
                client_id: Some(" my-azure-app ".into()),
                ..RawConfigPatch::default()
            },
        )
        .await
        .unwrap();

        let after = read_config(&facade).await;
        assert!(after.has_client_id);
        assert!(after.microsoft_login_available);

        update_config_with(
            &facade,
            RawConfigPatch {
                clear_client_id: Some(true),
                ..RawConfigPatch::default()
            },
        )
        .await
        .unwrap();

        let cleared = read_config(&facade).await;
        assert!(!cleared.has_client_id);
        // clearClientId 为 false 等于没给：单给它不动配置，和 clientId 一起给照常写入
        update_config_with(
            &facade,
            RawConfigPatch {
                clear_client_id: Some(false),
                ..RawConfigPatch::default()
            },
        )
        .await
        .unwrap();
        assert!(!read_config(&facade).await.has_client_id);
        update_config_with(
            &facade,
            RawConfigPatch {
                client_id: Some("another-app".into()),
                clear_client_id: Some(false),
                ..RawConfigPatch::default()
            },
        )
        .await
        .unwrap();
        assert!(read_config(&facade).await.has_client_id);
        update_config_with(
            &facade,
            RawConfigPatch {
                clear_client_id: Some(true),
                ..RawConfigPatch::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(cleared.microsoft_login_available, has_fallback);
        // 落盘的配置里也去掉了，重开启动器不会又冒出来
        let raw: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.path().join("config.json")).unwrap())
                .unwrap();
        assert!(raw["msa_client_id"].is_null(), "{raw}");
    }

    /// 出参能原样作入参回传：拿 get_config 的值写回去，配置不变。
    #[tokio::test]
    async fn dto_values_roundtrip_through_update_config() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_in(dir.path());
        let java = dir.path().join("jdk").join("bin").join("java.exe");
        std::fs::create_dir_all(java.parent().unwrap()).unwrap();
        std::fs::write(&java, b"stub").unwrap();

        update_config_with(
            &facade,
            RawConfigPatch {
                after_launch: Some("close".into()),
                check_updates: Some(false),
                default_java: Some(java.display().to_string()),
                memory: Some(MemoryInput {
                    max_mb: 6144,
                    min_mb: None,
                    auto: false,
                }),
                download_concurrency: Some(32),
                skipped_update_version: Some("0.2.0".into()),
                ..RawConfigPatch::default()
            },
        )
        .await
        .unwrap();
        let dto = read_config(&facade).await;
        assert_eq!(dto.after_launch, AfterLaunch::Close);
        assert!(!dto.check_updates);
        assert_eq!(dto.default_java, java.display().to_string());
        assert!(!dto.memory.auto);
        assert_eq!(dto.memory.max_mb, 6144);
        assert_eq!(dto.download_concurrency, 32);
        assert_eq!(dto.skipped_update_version.as_deref(), Some("0.2.0"));
        assert_eq!(
            dto.default_game_dir,
            dir.path().join(".minecraft").display().to_string()
        );

        let as_json = serde_json::to_value(&dto).unwrap();
        update_config_with(
            &facade,
            RawConfigPatch {
                after_launch: Some(as_json["after_launch"].as_str().unwrap().to_owned()),
                default_java: Some(as_json["default_java"].as_str().unwrap().to_owned()),
                download_source: Some(as_json["download_source"].as_str().unwrap().to_owned()),
                isolation_policy: Some(as_json["isolation_policy"].as_str().unwrap().to_owned()),
                memory: Some(serde_json::from_value(as_json["memory"].clone()).unwrap()),
                ..RawConfigPatch::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(
            serde_json::to_value(read_config(&facade).await).unwrap(),
            as_json
        );

        // 落了盘：重新载入得到同样的配置。
        let reloaded = petalfall_core::ConfigStore::at(dir.path().join("config.json"))
            .load()
            .await
            .unwrap();
        assert_eq!(reloaded.after_launch, AfterLaunch::Close);
        assert_eq!(reloaded.default_java.as_deref(), Some(java.as_path()));

        update_config_with(
            &facade,
            RawConfigPatch {
                default_java: Some(DEFAULT_JAVA_AUTO.into()),
                ..RawConfigPatch::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(read_config(&facade).await.default_java, DEFAULT_JAVA_AUTO);
    }

    /// 独显偏好默认关；update_config 带 preferDedicatedGpu 后 get_config 回读为开，并落了盘。
    #[tokio::test]
    async fn prefer_dedicated_gpu_patch_reads_back_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_in(dir.path());
        let initial = serde_json::to_value(read_config(&facade).await).unwrap();
        assert_eq!(initial["prefer_dedicated_gpu"], false);
        assert_eq!(initial["extra_java_paths"], serde_json::json!([]));

        update_config_with(
            &facade,
            RawConfigPatch {
                prefer_dedicated_gpu: Some(true),
                ..RawConfigPatch::default()
            },
        )
        .await
        .unwrap();
        assert!(read_config(&facade).await.prefer_dedicated_gpu);
        let reloaded = petalfall_core::ConfigStore::at(dir.path().join("config.json"))
            .load()
            .await
            .unwrap();
        assert!(reloaded.prefer_dedicated_gpu);

        // 不带这一项的补丁不动它。
        update_config_with(
            &facade,
            RawConfigPatch {
                check_updates: Some(false),
                ..RawConfigPatch::default()
            },
        )
        .await
        .unwrap();
        assert!(read_config(&facade).await.prefer_dedicated_gpu);

        update_config_with(
            &facade,
            RawConfigPatch {
                prefer_dedicated_gpu: Some(false),
                ..RawConfigPatch::default()
            },
        )
        .await
        .unwrap();
        assert!(!read_config(&facade).await.prefer_dedicated_gpu);
    }

    /// 跳过无障碍引导默认开；update_config 带 skipAccessibilityOnboarding 关掉后 get_config 回读为关，并落了盘。
    #[tokio::test]
    async fn skip_accessibility_onboarding_patch_reads_back_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_in(dir.path());
        let initial = serde_json::to_value(read_config(&facade).await).unwrap();
        assert_eq!(initial["skip_accessibility_onboarding"], true);

        update_config_with(
            &facade,
            RawConfigPatch {
                skip_accessibility_onboarding: Some(false),
                ..RawConfigPatch::default()
            },
        )
        .await
        .unwrap();
        let dto = serde_json::to_value(read_config(&facade).await).unwrap();
        assert_eq!(dto["skip_accessibility_onboarding"], false);
        let reloaded = petalfall_core::ConfigStore::at(dir.path().join("config.json"))
            .load()
            .await
            .unwrap();
        assert!(!reloaded.skip_accessibility_onboarding);

        // 不带这一项的补丁不动它。
        update_config_with(
            &facade,
            RawConfigPatch {
                check_updates: Some(false),
                ..RawConfigPatch::default()
            },
        )
        .await
        .unwrap();
        assert!(!read_config(&facade).await.skip_accessibility_onboarding);

        update_config_with(
            &facade,
            RawConfigPatch {
                skip_accessibility_onboarding: Some(true),
                ..RawConfigPatch::default()
            },
        )
        .await
        .unwrap();
        assert!(read_config(&facade).await.skip_accessibility_onboarding);
    }

    /// 老配置文件里没有这个键：读回按开着，改别的设置落盘后键按开着写进文件。
    #[tokio::test]
    async fn old_config_without_the_key_skips_onboarding() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, br#"{"download_concurrency": 12}"#).unwrap();
        let config = petalfall_core::ConfigStore::at(&path).load().await.unwrap();
        let petalfall = Petalfall::open(config, dir.path().to_path_buf(), path.clone()).unwrap();
        let facade = Facade::new(petalfall);

        let dto = serde_json::to_value(read_config(&facade).await).unwrap();
        assert_eq!(dto["skip_accessibility_onboarding"], true);
        assert_eq!(dto["download_concurrency"], 12);

        update_config_with(
            &facade,
            RawConfigPatch {
                check_updates: Some(false),
                ..RawConfigPatch::default()
            },
        )
        .await
        .unwrap();
        let raw: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(raw["skip_accessibility_onboarding"], true);
    }

    /// 任一字段非法整体拒绝：前面合法的字段也不生效，配置文件不写。
    #[tokio::test]
    async fn invalid_field_rejects_whole_patch_without_saving() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_in(dir.path());
        for raw in [
            RawConfigPatch {
                check_updates: Some(false),
                default_java: Some("relative/java.exe".into()),
                ..RawConfigPatch::default()
            },
            RawConfigPatch {
                check_updates: Some(false),
                default_java: Some(dir.path().join("missing.exe").display().to_string()),
                ..RawConfigPatch::default()
            },
            RawConfigPatch {
                check_updates: Some(false),
                client_id: Some("   ".into()),
                ..RawConfigPatch::default()
            },
            RawConfigPatch {
                check_updates: Some(false),
                client_id: Some("my-azure-app".into()),
                clear_client_id: Some(true),
                ..RawConfigPatch::default()
            },
            RawConfigPatch {
                check_updates: Some(false),
                download_concurrency: Some(0),
                ..RawConfigPatch::default()
            },
            RawConfigPatch {
                check_updates: Some(false),
                language: Some("english".into()),
                ..RawConfigPatch::default()
            },
        ] {
            let err = update_config_with(&facade, raw).await.unwrap_err();
            assert_eq!(err.code, code::INVALID_ARGUMENT);
        }
        assert!(read_config(&facade).await.check_updates);
        assert!(!dir.path().join("config.json").exists());
    }

    /// 前端 `ipc/config.ts` 里同样写着这几个语言标签（类型与取值表）；两边各写一份，改了一边这里就失败。
    #[test]
    fn front_end_language_tags_match_serde_names() {
        let ts = include_str!("../../../src/ipc/config.ts");
        let quoted: Vec<String> = [UiLanguage::ZhCn, UiLanguage::EnUs]
            .into_iter()
            .map(|language| serde_json::to_value(language).unwrap().to_string())
            .collect();
        let union = format!("export type UiLanguage = {};", quoted.join(" | "));
        assert!(ts.contains(&union), "ipc/config.ts 里应有：{union}");
        let table = format!(
            "export const UI_LANGUAGES: readonly UiLanguage[] = [{}];",
            quoted.join(", ")
        );
        assert!(ts.contains(&table), "ipc/config.ts 里应有：{table}");
    }

    /// 语言补丁：出参是语言标签，切换后落盘；非法值整体拒绝，已设的语言不动。
    #[tokio::test]
    async fn language_patch_switches_persists_and_rejects_unknown_tags() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_in(dir.path());
        let initial = serde_json::to_value(read_config(&facade).await).unwrap();
        assert_eq!(initial["language"], "zh-CN");

        update_config_with(
            &facade,
            RawConfigPatch {
                language: Some("en-US".into()),
                ..RawConfigPatch::default()
            },
        )
        .await
        .unwrap();
        let dto = read_config(&facade).await;
        assert_eq!(dto.language, UiLanguage::EnUs);
        assert_eq!(serde_json::to_value(&dto).unwrap()["language"], "en-US");
        let reloaded = petalfall_core::ConfigStore::at(dir.path().join("config.json"))
            .load()
            .await
            .unwrap();
        assert_eq!(reloaded.language, UiLanguage::EnUs);

        let err = update_config_with(
            &facade,
            RawConfigPatch {
                language: Some("fr-FR".into()),
                after_launch: Some("keep".into()),
                ..RawConfigPatch::default()
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, code::INVALID_ARGUMENT);
        assert!(err.message.contains("fr-FR"), "{}", err.message);
        let after = read_config(&facade).await;
        assert_eq!(after.language, UiLanguage::EnUs);
        assert_eq!(after.after_launch, AfterLaunch::Minimize);

        update_config_with(
            &facade,
            RawConfigPatch {
                language: Some("zh-CN".into()),
                ..RawConfigPatch::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(read_config(&facade).await.language, UiLanguage::ZhCn);
    }

    /// 存盘失败：命令报错，门面里的配置保持原值，下载源、并发这类后续命令马上要读的值不会悄悄生效。
    #[tokio::test]
    async fn failed_save_leaves_the_running_config_untouched() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("config.json")).unwrap();
        let facade = facade_in(dir.path());

        let err = update_config_with(
            &facade,
            RawConfigPatch {
                download_source: Some("mirror_first".into()),
                download_concurrency: Some(8),
                ..RawConfigPatch::default()
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, code::IO);
        let dto = read_config(&facade).await;
        assert_eq!(dto.download_source, DownloadSourcePolicy::Auto);
        assert_eq!(dto.download_concurrency, 64);

        let extra = dir.path().join("PCL2").join(".minecraft");
        let err = add_game_directory_with(&facade, "PCL2", &extra.display().to_string())
            .await
            .unwrap_err();
        assert_eq!(err.code, code::IO);
        assert_eq!(facade.snapshot().await.game_directories().await.len(), 1);
    }

    /// 时钟暂停：目录探测的阻塞任务做完之前时限不走，满载时任务排队不会被当成目录不可达。
    #[tokio::test(start_paused = true)]
    async fn set_game_directory_switches_and_rejects_bad_targets() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_in(dir.path());
        std::fs::create_dir_all(dir.path().join(".minecraft")).unwrap();
        let target = dir.path().join("Games").join(".minecraft");
        std::fs::create_dir_all(&target).unwrap();

        set_game_directory_with(&facade, &target.display().to_string())
            .await
            .unwrap();
        let dto = read_config(&facade).await;
        assert_eq!(dto.game_dir, target.display().to_string());
        let listed = facade.snapshot().await.game_directories().await;
        assert_eq!(listed.len(), 2, "原默认目录收进其它文件夹");
        assert!(listed[0].is_current);

        let missing = dir.path().join("nowhere");
        let err = set_game_directory_with(&facade, &missing.display().to_string())
            .await
            .unwrap_err();
        assert_eq!(err.code, code::INVALID_GAME_DIRECTORY);
        assert_eq!(err.detail.unwrap()["problem"], "unavailable");

        let bang = dir.path().join("a!b");
        let err = set_game_directory_with(&facade, &bang.display().to_string())
            .await
            .unwrap_err();
        assert_eq!(err.detail.unwrap()["problem"], "contains_bang");
        assert_eq!(
            read_config(&facade).await.game_dir,
            target.display().to_string()
        );
    }

    /// 版本数过 IPC 时 0 和 null 要分得开：null 是「不知道」，字段也得在，前端按 `number | null` 读。
    #[tokio::test(start_paused = true)]
    async fn game_directory_dto_tells_unknown_version_count_from_zero() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_in(dir.path());
        let current = dir.path().join(".minecraft").join("versions");
        std::fs::create_dir_all(current.join("1.21.1")).unwrap();
        std::fs::create_dir_all(current.join("生存")).unwrap();
        let empty = dir.path().join("PCL").join(".minecraft");
        std::fs::create_dir_all(&empty).unwrap();
        let unplugged = dir.path().join("unplugged").join(".minecraft");
        add_game_directory_with(&facade, "PCL", &empty.display().to_string())
            .await
            .unwrap();
        add_game_directory_with(&facade, "外置盘", &unplugged.display().to_string())
            .await
            .unwrap();

        let listed: Vec<serde_json::Value> = facade
            .snapshot()
            .await
            .game_directories()
            .await
            .into_iter()
            .map(|entry| serde_json::to_value(game_directory_dto(entry)).unwrap())
            .collect();

        assert_eq!(listed.len(), 3);
        assert_eq!(listed[0]["version_count"], 2);
        assert_eq!(listed[1]["version_count"], 0);
        assert_eq!(listed[2]["available"], false);
        assert_eq!(
            listed[2].get("version_count"),
            Some(&serde_json::Value::Null)
        );
    }

    #[test]
    fn named_directory_requires_name_and_valid_path() {
        let path = std::env::temp_dir()
            .join(".minecraft")
            .display()
            .to_string();
        let parsed = parse_named_directory(NamedDirectoryDto {
            name: " PCL2 ".into(),
            path: path.clone(),
        })
        .unwrap();
        assert_eq!(parsed.name, "PCL2");
        assert_eq!(
            parse_named_directory(NamedDirectoryDto {
                name: " ".into(),
                path,
            })
            .unwrap_err()
            .code,
            code::INVALID_ARGUMENT
        );
        assert_eq!(
            parse_named_directory(NamedDirectoryDto {
                name: "x".into(),
                path: "relative".into(),
            })
            .unwrap_err()
            .code,
            code::INVALID_GAME_DIRECTORY
        );
    }
}
