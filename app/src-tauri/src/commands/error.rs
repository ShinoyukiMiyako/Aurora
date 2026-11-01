//! 命令边界的统一错误形状 `{ code, message, detail? }`。
//!
//! 前端按 `code` 分支（取消、登录失败的具体原因、参数非法……），`message` 原样进提示正文，
//! `detail` 放分支需要的结构化参数与完整的原因链，供「复制错误原文」与排查使用。
//!
//! 取码规则：
//! - 取消一律是 [`code::CANCELLED`]，无论它从哪一层冒上来。
//! - 账户与登录错误取 aurora-auth 错误枚举的变体名（如 `DeviceCodeExpired`、`XstsChildAccount`），
//!   XSTS 的 XErr 数值放进 `detail.xerr`。
//! - 其余取 snake_case 码，见 [`code`]；同一来源的不同失败只在前端需要区别对待时才拆码。
//! - 原因链上有网络层失败（连不上、等不到响应）时，不论码是什么，`detail.network` 标明是哪一种
//!   （`connect` / `timeout`）：前端据此判断要不要做一次连通性探测，而不必认识每一个可能联网的错误码。

use std::error::Error as StdError;

use aurora_core::{
    AuthError, BaseError, CoreError, CredentialRealm, DownloadError, InstallError, InstanceError,
    JavaError, LaunchError, ModPlatformError, ModpackError, VersionError, TEMPLATE_FILES,
};
use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::commands::modpack::BlockedFileDto;

/// 命令层与门面错误映射用到的全部错误码（账户错误码见 [`auth_code`]）。
pub mod code {
    /// 任务被取消（cancel_task，或长任务在取消后才失败）。
    pub const CANCELLED: &str = "cancelled";
    /// 前端传入的参数不合法（未知枚举字符串、空任务 id 等）。
    pub const INVALID_ARGUMENT: &str = "invalid_argument";
    /// 同一个任务 id 已在运行。
    pub const TASK_CONFLICT: &str = "task_conflict";
    /// 任务日志文件损坏或版本不符。
    pub const TASK_JOURNAL_INVALID: &str = "task_journal_invalid";
    /// 文件读写失败。
    pub const IO: &str = "io";
    /// 下载内容校验不通过。
    pub const HASH_MISMATCH: &str = "hash_mismatch";
    /// 定位不到数据目录。
    pub const DATA_DIR_MISSING: &str = "data_dir_missing";
    /// aurora-base 的其余失败（HTTP 客户端构建、URL 改写）。
    pub const BASE: &str = "base";
    /// 版本 JSON 非法或继承链有误。
    pub const VERSION_JSON_INVALID: &str = "version_json_invalid";
    /// 文件下载失败（重试与换源后仍失败）。
    pub const DOWNLOAD_FAILED: &str = "download_failed";
    /// 加载器没有可用版本（含 Forge / NeoForge 未给版本号）。
    pub const LOADER_VERSION_NOT_FOUND: &str = "loader_version_not_found";
    /// 安装失败（原版补全、加载器安装器、处理器）。
    pub const INSTALL_FAILED: &str = "install_failed";
    /// 实例目录、版本发现或隔离解析失败。
    pub const INSTANCE_FAILED: &str = "instance_failed";
    /// Java 探测或运行时下载失败。
    pub const JAVA_FAILED: &str = "java_failed";
    /// 手动添加的 Java 路径不能用。detail：`{ path, reason }`，reason 为 not_absolute / not_java_executable /
    /// not_found / probe_failed / probe_timeout。
    pub const JAVA_PATH_INVALID: &str = "java_path_invalid";
    /// 手动添加的 Java 缺少运行时文件。detail：`{ path, missing }`，missing 相对 Java 根目录、以 `/` 分隔。
    pub const JAVA_RUNTIME_INCOMPLETE: &str = "java_runtime_incomplete";
    /// 读不到本机显卡信息（DXGI 枚举失败）。detail：`{ hresult: "0x%08X", causes }`。
    pub const GPU_QUERY_FAILED: &str = "gpu_query_failed";
    /// 启动链路失败（命令拼装、进程拉起）。
    pub const LAUNCH_FAILED: &str = "launch_failed";
    /// 未配置 CurseForge API 密钥。
    pub const CURSEFORGE_KEY_MISSING: &str = "curseforge_key_missing";
    /// CurseForge 的下载服务器拒绝了下载密钥（HTTP 401），换源与重试都没用，只能换一个可用的密钥。
    /// detail：`{ realm: "curseforge", url, status }`，url 为被拒的那一跳。
    pub const CURSEFORGE_KEY_REJECTED: &str = "curseforge_key_rejected";
    /// 启停 Mod 时启用与禁用两份文件同时存在。
    pub const MOD_STATE_CONFLICT: &str = "mod_state_conflict";
    /// 资源平台请求或本地 Mod 扫描的其余失败。
    pub const MOD_PLATFORM_FAILED: &str = "mod_platform_failed";
    /// 读配置文件失败。
    pub const CONFIG_IO: &str = "config_io";
    /// 配置文件内容非法（含外观的未知枚举值）。
    pub const CONFIG_INVALID: &str = "config_invalid";
    /// 配置序列化失败。
    pub const CONFIG_SERIALIZE: &str = "config_serialize";
    /// 目标版本本地未安装。
    pub const VERSION_NOT_INSTALLED: &str = "version_not_installed";
    /// 平台上找不到请求的 Mod 版本。
    pub const MOD_VERSION_NOT_FOUND: &str = "mod_version_not_found";
    /// 找不到匹配主版本的 Java 且未开自动下载。
    pub const JAVA_MISSING: &str = "java_missing";
    /// 启动前检查有阻断项。
    pub const PRECHECK_FAILED: &str = "precheck_failed";
    /// 当前平台不支持该操作（账户凭据加密仅限 Windows）。
    pub const PLATFORM_UNSUPPORTED: &str = "platform_unsupported";
    /// 后台任务异常结束，属于程序缺陷。
    pub const INTERNAL: &str = "internal";
    /// 数据包要装进的存档不存在（detail.version_id、world）。
    pub const WORLD_NOT_FOUND: &str = "world_not_found";
    /// 平台给出的文件名不能安全落盘（detail.platform、file_name）。
    pub const UNSAFE_FILE_NAME: &str = "unsafe_file_name";
    /// CurseForge 作者禁止第三方分发，文件只能去网页手动下载。detail.files 为对象数组，每项
    /// `{ project_id, file_id, file_name, web_url, destination, sha1, fingerprint, size }`。
    pub const DISTRIBUTION_BLOCKED: &str = "distribution_blocked";
    /// 选的文件扩展名既不是 .mrpack 也不是 .zip（detail.path）。
    pub const MODPACK_UNSUPPORTED_EXTENSION: &str = "modpack_unsupported_extension";
    /// 压缩包根目录没有整合包清单（detail.path）。
    pub const MODPACK_MANIFEST_MISSING: &str = "modpack_manifest_missing";
    /// 整合包清单读不懂或有重复落点（detail.document、reason，或 detail.path）。
    pub const MODPACK_MANIFEST_INVALID: &str = "modpack_manifest_invalid";
    /// 整合包文件不完整或已损坏（detail.path）。
    pub const MODPACK_CORRUPT: &str = "modpack_corrupt";
    /// 整合包里有条目用了不支持的压缩方式（detail.path、entry、method）。
    pub const MODPACK_UNSUPPORTED_COMPRESSION: &str = "modpack_unsupported_compression";
    /// 整合包里有越出实例目录、写进启动器元数据目录或符号链接的条目（detail.path）。
    pub const MODPACK_UNSAFE_PATH: &str = "modpack_unsafe_path";
    /// 新实例名不可用（detail.name、rule：empty / too_long / illegal_char / reserved / duplicate）。
    pub const INSTANCE_NAME_INVALID: &str = "instance_name_invalid";
    /// 启动器写在实例里的 JSON 文件读不懂（detail.path）。
    pub const JSON_FILE_INVALID: &str = "json_file_invalid";
    /// 系统时钟早于 1970 年。
    pub const SYSTEM_CLOCK: &str = "system_clock";
    /// 请求远端内容源（资讯）失败，detail.url 为请求地址。
    pub const NETWORK_FAILED: &str = "network_failed";
    /// 远端内容源返回的内容解析不了，detail.url 为请求地址。
    pub const FEED_INVALID: &str = "feed_invalid";
    /// 只读远端整合包的清单时读不下去（服务器不支持范围读取、不是可读的 zip、缺清单），detail.url、detail.reason。
    pub const REMOTE_PACK_UNREADABLE: &str = "remote_pack_unreadable";
    /// 游戏目录不能用，detail.path 与 detail.problem（empty / not_absolute / contains_bang / unavailable）。
    pub const INVALID_GAME_DIRECTORY: &str = "invalid_game_directory";
    /// 读不到本机物理内存信息。
    pub const MEMORY_UNAVAILABLE: &str = "memory_unavailable";
    /// 当前环境没有自更新能力，detail.reason 为 debug_build / missing_pubkey。
    pub const UPDATER_UNSUPPORTED: &str = "updater_unsupported";
    /// 检查更新失败（连不上更新源、清单不合法）。
    pub const UPDATE_CHECK_FAILED: &str = "update_check_failed";
    /// 还没有检查到可用更新就要求下载。
    pub const UPDATE_NOT_AVAILABLE: &str = "update_not_available";
    /// 更新包下载失败。
    pub const UPDATE_DOWNLOAD_FAILED: &str = "update_download_failed";
    /// 更新包签名校验不通过，已丢弃。
    pub const UPDATE_SIGNATURE_INVALID: &str = "update_signature_invalid";
    /// 更新包还没下好就要求安装。
    pub const UPDATE_NOT_READY: &str = "update_not_ready";
    /// 启动安装程序失败。
    pub const UPDATE_INSTALL_FAILED: &str = "update_install_failed";
    /// 已有游戏在加载或运行，同一时间只跑一个游戏。detail：`{ version_id, phase: loading | running }`。
    pub const BUSY: &str = "busy";
    /// 实例正在安装、补全、改名、删除、启动或运行，暂时不能做这件事。detail：`{ id, activity }`。
    pub const INSTANCE_BUSY: &str = "instance_busy";
    /// 有别的实例经 inheritsFrom 依赖它，不能改名或删除。detail：`{ id, dependents }`。
    pub const INSTANCE_HAS_DEPENDENTS: &str = "instance_has_dependents";
    /// 系统没能打开文件夹。detail：`{ path }`。
    pub const OPEN_FAILED: &str = "open_failed";
    /// 要改动的 Mod 文件正被占用（游戏运行中）。detail：`{ path }`，为被占用的文件。
    pub const MOD_FILE_BUSY: &str = "mod_file_busy";
    /// 这个实例写不成 Modrinth 整合包。detail：`{ id, reason, loader? }`，reason 为 version_unknown /
    /// loader_unsupported / loader_version_unknown / multiple_loaders / incomplete，loader 只在加载器
    /// 不受支持时给出。
    pub const MODPACK_EXPORT_UNSUPPORTED: &str = "modpack_export_unsupported";
    /// 导出的整合包没通过回读校验，产物已删除。detail：`{ path, reason }`。
    pub const MODPACK_EXPORT_CHECK_FAILED: &str = "modpack_export_check_failed";
    /// 改名或删除已经完成（目录、侧栏固定与当前选中都已改好），只是游玩记录没能跟着改。前端照成功处理再
    /// 提示；没改成的记录由门面记着，之后读写游玩记录时补上。detail：`{ id, renamed_to? }` 与原因链。
    pub const PLAY_RECORDS_FAILED: &str = "play_records_failed";
    /// 实例工作目录里没有可保存的设置文件。detail：`{ id, files }`，files 为白名单。
    pub const TEMPLATE_SOURCE_EMPTY: &str = "template_source_empty";
    /// 要恢复或删除的存档备份不在备份列表里，或文件已经不在盘上。detail：`{ id, world, file }`。
    pub const WORLD_BACKUP_NOT_FOUND: &str = "world_backup_not_found";
    /// 存档备份读不出来、有越界或符号链接条目、或解出来没有可读的 level.dat；现在的存档没有动。
    /// detail：`{ path, reason, entry? }`，entry 为不合格的条目名。
    pub const WORLD_BACKUP_CORRUPT: &str = "world_backup_corrupt";
    /// 存档正被游戏打开（session.lock 被占着）。detail：`{ path }`。
    pub const WORLD_IN_USE: &str = "world_in_use";
    /// 恢复时原存档已移进回收站，恢复出的副本却没能放到位。detail：`{ path, staged }`，path 是存档原来的
    /// 位置，staged 是恢复出的副本，那是这份备份唯一解出来的拷贝，不会被删掉。
    pub const WORLD_RESTORE_INCOMPLETE: &str = "world_restore_incomplete";
    /// 改名已经完成（目录、引用、游玩记录都已改好），只是存档备份没能跟着挪。前端照成功处理再提示。
    /// detail：`{ id, renamed_to, path }` 与原因链，path 是留在旧名下的备份目录。
    pub const WORLD_BACKUPS_NOT_MOVED: &str = "world_backups_not_moved";
    /// 要改的服务器不在固定列表里。detail：`{ address }`。
    pub const SERVER_NOT_PINNED: &str = "server_not_pinned";
    /// 实例的版本不支持这种直达方式。detail：`{ version_id, mode: "singleplayer" | "multiplayer" }`。
    pub const QUICK_PLAY_UNSUPPORTED: &str = "quick_play_unsupported";
}

/// 序列化给前端的命令错误。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CommandError {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<Value>,
}

impl CommandError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            detail: None,
        }
    }

    /// 附带结构化细节（应为 JSON 对象）。
    pub fn with_detail(mut self, detail: Value) -> Self {
        self.detail = Some(detail);
        self
    }

    pub fn cancelled() -> Self {
        Self::new(code::CANCELLED, "已取消")
    }

    pub fn invalid_argument(message: impl Into<String>) -> Self {
        Self::new(code::INVALID_ARGUMENT, message)
    }

    pub fn is_cancelled(&self) -> bool {
        self.code == code::CANCELLED
    }
}

impl CommandError {
    /// 门面错误到命令错误的映射，不记日志。借用的错误也走这里（例如启动器资讯退避期内多次重报、由各次结果
    /// 共享的同一次失败），与拿走所有权的 `From<CoreError>` 得到同一个形状。
    pub(crate) fn describe(err: &CoreError) -> Self {
        if err.is_cancelled() {
            return Self::cancelled();
        }
        let causes = source_chain(err);
        let mut detail = core_detail(err);
        if let Some(failure) = aurora_base::http::network_failure(err) {
            detail.insert("network".to_owned(), json!(failure.code()));
        }
        if !causes.is_empty() {
            detail.insert("causes".to_owned(), json!(causes));
        }
        Self {
            code: core_code(err),
            message: err.to_string(),
            detail: (!detail.is_empty()).then_some(Value::Object(detail)),
        }
    }
}

impl From<CoreError> for CommandError {
    fn from(err: CoreError) -> Self {
        if err.is_cancelled() {
            return Self::cancelled();
        }
        let error = Self::describe(&err);
        // 命令边界是错误离开后端的最后一站，在这里留一条日志，排查时与前端提示对得上。
        tracing::warn!(code = error.code, message = %error.message, causes = ?source_chain(&err), "命令失败");
        error
    }
}

/// 各下层 crate 的错误先并入门面错误再映射，保证同一种失败无论从哪条路径来都得到同一个码。
macro_rules! via_core_error {
    ($($source:ty),+ $(,)?) => {
        $(
            impl From<$source> for CommandError {
                fn from(err: $source) -> Self {
                    CoreError::from(err).into()
                }
            }
        )+
    };
}

via_core_error!(
    AuthError,
    BaseError,
    DownloadError,
    InstallError,
    InstanceError,
    JavaError,
    LaunchError,
    ModPlatformError,
    VersionError,
);

/// `source()` 链上每一层的描述（不含顶层，顶层已在 `message` 里）。
pub(crate) fn source_chain(err: &dyn StdError) -> Vec<String> {
    let mut causes = Vec::new();
    let mut current = err.source();
    while let Some(cause) = current {
        causes.push(cause.to_string());
        current = cause.source();
    }
    causes
}

fn core_code(err: &CoreError) -> &'static str {
    match err {
        CoreError::Base(e) => base_code(e),
        CoreError::Version(_) => code::VERSION_JSON_INVALID,
        CoreError::Download(e) | CoreError::Install(InstallError::Download(e))
            if e.credential_rejection() == Some(CredentialRealm::CurseForge) =>
        {
            code::CURSEFORGE_KEY_REJECTED
        }
        CoreError::Download(_) => code::DOWNLOAD_FAILED,
        CoreError::Install(e) => install_code(e),
        CoreError::Instance(e) => instance_code(e),
        CoreError::Java(_) => code::JAVA_FAILED,
        CoreError::Auth(e) => auth_code(e),
        CoreError::Launch(LaunchError::QuickPlayUnsupported { .. }) => code::QUICK_PLAY_UNSUPPORTED,
        CoreError::Launch(_) => code::LAUNCH_FAILED,
        CoreError::ModPlatform(e) => mod_platform_code(e),
        CoreError::ConfigIo { .. } => code::CONFIG_IO,
        CoreError::ConfigParse { .. } => code::CONFIG_INVALID,
        CoreError::ConfigSerialize(_) => code::CONFIG_SERIALIZE,
        CoreError::VersionNotInstalled { .. } => code::VERSION_NOT_INSTALLED,
        CoreError::ModVersionNotFound { .. } => code::MOD_VERSION_NOT_FOUND,
        CoreError::NoJava { .. } => code::JAVA_MISSING,
        CoreError::PrecheckFailed(_) => code::PRECHECK_FAILED,
        CoreError::TaskJoin(_) => code::INTERNAL,
        CoreError::PlatformUnsupported => code::PLATFORM_UNSUPPORTED,
        CoreError::InvalidProjectId { .. } => code::INVALID_ARGUMENT,
        CoreError::InvalidResourceTarget(_) => code::INVALID_ARGUMENT,
        CoreError::WorldNotFound { .. } => code::WORLD_NOT_FOUND,
        CoreError::WorldBackupNotFound { .. } => code::WORLD_BACKUP_NOT_FOUND,
        CoreError::UnsafeFileName { .. } => code::UNSAFE_FILE_NAME,
        CoreError::FileDistributionBlocked { .. } => code::DISTRIBUTION_BLOCKED,
        CoreError::ClaimFolderInvalid { .. } => code::IO,
        CoreError::Modpack(e) => modpack_code(e),
        CoreError::InstanceNameInvalid { .. } => code::INSTANCE_NAME_INVALID,
        CoreError::JsonFileInvalid { .. } => code::JSON_FILE_INVALID,
        CoreError::JsonSerialize(_) => code::INTERNAL,
        CoreError::SystemClock(_) => code::SYSTEM_CLOCK,
        CoreError::Fetch { .. } => code::NETWORK_FAILED,
        CoreError::FeedParse { .. } => code::FEED_INVALID,
        CoreError::RemotePack { .. } => code::REMOTE_PACK_UNREADABLE,
        CoreError::InvalidServerAddress { .. } => code::INVALID_ARGUMENT,
        CoreError::ServerNotPinned { .. } => code::SERVER_NOT_PINNED,
        CoreError::InvalidGameDirectory { .. } => code::INVALID_GAME_DIRECTORY,
        CoreError::MemoryUnavailable => code::MEMORY_UNAVAILABLE,
        CoreError::JavaPathInvalid { .. } => code::JAVA_PATH_INVALID,
        CoreError::JavaRuntimeIncomplete { .. } => code::JAVA_RUNTIME_INCOMPLETE,
        // 写注册表失败本质是一次读写失败；它只在启动链路里转成警告，到了命令边界与其余读写失败同码。
        CoreError::GpuPreferenceWrite { .. } => code::IO,
        CoreError::TemplateSourceEmpty { .. } => code::TEMPLATE_SOURCE_EMPTY,
        // 降级被拒说明这次传入的 offlineFallback 不成立，按参数错误报；拒绝原因放在 detail 里供前端分支。
        CoreError::OfflineFallbackRefused { .. } => code::INVALID_ARGUMENT,
        CoreError::ModpackExportUnsupported { .. } => code::MODPACK_EXPORT_UNSUPPORTED,
    }
}

/// 实例 id、名称、设置与侧栏固定的问题是调用方传错了参数，不论从哪个命令冒上来都报 invalid_argument：
/// 崩溃诊断、启动日志、Mod 与历史这些命令不经实例领域自己的映射。
///
/// 存档备份的几种失败前端要分别处理（备份坏了、存档开着、恢复只做了一半），各自成码；备份索引读不懂与
/// 实例里别的启动器 JSON 读不懂是同一类问题，沿用 json_file_invalid。
fn instance_code(err: &InstanceError) -> &'static str {
    match err {
        InstanceError::InvalidId { .. }
        | InstanceError::InvalidName { .. }
        | InstanceError::InvalidSettings { .. }
        | InstanceError::InvalidPins { .. }
        | InstanceError::InvalidBackupArgument { .. } => code::INVALID_ARGUMENT,
        InstanceError::BackupArchive { .. }
        | InstanceError::BackupEntryUnsafe { .. }
        | InstanceError::BackupLevelUnreadable { .. } => code::WORLD_BACKUP_CORRUPT,
        InstanceError::BackupIndexInvalid { .. } => code::JSON_FILE_INVALID,
        InstanceError::WorldInUse { .. } => code::WORLD_IN_USE,
        InstanceError::RestoreNotPlaced { .. } => code::WORLD_RESTORE_INCOMPLETE,
        InstanceError::Cancelled => code::CANCELLED,
        _ => code::INSTANCE_FAILED,
    }
}

fn modpack_code(err: &ModpackError) -> &'static str {
    match err {
        ModpackError::UnsupportedExtension { .. } => code::MODPACK_UNSUPPORTED_EXTENSION,
        ModpackError::ManifestMissing { .. } => code::MODPACK_MANIFEST_MISSING,
        ModpackError::ManifestInvalid { .. } | ModpackError::DuplicatePath { .. } => {
            code::MODPACK_MANIFEST_INVALID
        }
        ModpackError::Corrupt { .. } => code::MODPACK_CORRUPT,
        ModpackError::UnsupportedCompression { .. } => code::MODPACK_UNSUPPORTED_COMPRESSION,
        ModpackError::NotOptional { .. } => code::INVALID_ARGUMENT,
        ModpackError::UnsafePath { .. } | ModpackError::SymlinkEntry { .. } => {
            code::MODPACK_UNSAFE_PATH
        }
        ModpackError::Io { .. } => code::IO,
        ModpackError::Cancelled => code::CANCELLED,
        ModpackError::ExportCheckFailed { .. } => code::MODPACK_EXPORT_CHECK_FAILED,
    }
}

fn base_code(err: &BaseError) -> &'static str {
    match err {
        BaseError::Io { .. } => code::IO,
        BaseError::HashMismatch { .. } => code::HASH_MISMATCH,
        BaseError::MissingLocalAppData => code::DATA_DIR_MISSING,
        BaseError::HttpClientBuild(_)
        | BaseError::UrlParse { .. }
        | BaseError::UrlMissingHost(_)
        | BaseError::HashTaskJoin(_) => code::BASE,
    }
}

fn install_code(err: &InstallError) -> &'static str {
    match err {
        InstallError::LoaderVersionNotFound { .. } => code::LOADER_VERSION_NOT_FOUND,
        InstallError::Download(_) => code::DOWNLOAD_FAILED,
        _ => code::INSTALL_FAILED,
    }
}

fn mod_platform_code(err: &ModPlatformError) -> &'static str {
    match err {
        ModPlatformError::CurseForgeKeyMissing => code::CURSEFORGE_KEY_MISSING,
        ModPlatformError::ModStateConflict { .. } => code::MOD_STATE_CONFLICT,
        _ => code::MOD_PLATFORM_FAILED,
    }
}

/// 账户错误码：取 aurora-auth 错误枚举的变体名，前端按它决定登录弹窗的失败态与文案。
pub fn auth_code(err: &AuthError) -> &'static str {
    match err {
        AuthError::Base(_) => "Base",
        AuthError::Http { .. } => "Http",
        AuthError::Parse { .. } => "Parse",
        AuthError::Response { .. } => "Response",
        AuthError::DeviceCodeExpired => "DeviceCodeExpired",
        AuthError::AuthorizationDeclined => "AuthorizationDeclined",
        AuthError::OAuth { .. } => "OAuth",
        AuthError::XstsBanned => "XstsBanned",
        AuthError::XstsNoXboxAccount => "XstsNoXboxAccount",
        AuthError::XstsRegionUnavailable => "XstsRegionUnavailable",
        AuthError::XstsAdultVerificationRequired(_) => "XstsAdultVerificationRequired",
        AuthError::XstsChildAccount => "XstsChildAccount",
        AuthError::XstsUnknown(_) => "XstsUnknown",
        AuthError::MinecraftProfileNotFound => "MinecraftProfileNotFound",
        AuthError::ReloginRequired => "ReloginRequired",
        AuthError::ServiceUnavailable { .. } => "ServiceUnavailable",
        AuthError::AppNotApproved => "AppNotApproved",
        AuthError::InvalidUsername(_) => "InvalidUsername",
        AuthError::Yggdrasil { .. } => "Yggdrasil",
        AuthError::AccountNotFound(_) => "AccountNotFound",
        AuthError::CredentialSerialize(_) => "CredentialSerialize",
        AuthError::CredentialDeserialize(_) => "CredentialDeserialize",
        AuthError::Dpapi { .. } => "Dpapi",
        // 取消在 From<CoreError> 里已先行转成 cancelled，这里与之保持一致。
        AuthError::Cancelled => code::CANCELLED,
        AuthError::YggdrasilNoProfile => "YggdrasilNoProfile",
        AuthError::NotYggdrasilServer { .. } => "NotYggdrasilServer",
        AuthError::OfflineStoreSerialize(_) => "OfflineStoreSerialize",
        AuthError::OfflineStoreDeserialize { .. } => "OfflineStoreDeserialize",
    }
}

/// XSTS 拒绝时微软返回的 XErr 码。固定码的变体在 aurora-auth 里按码分出，这里还原成数值。
fn xerr(err: &AuthError) -> Option<i64> {
    match err {
        AuthError::XstsBanned => Some(2_148_916_227),
        AuthError::XstsNoXboxAccount => Some(2_148_916_233),
        AuthError::XstsRegionUnavailable => Some(2_148_916_235),
        AuthError::XstsAdultVerificationRequired(code) | AuthError::XstsUnknown(code) => {
            Some(*code)
        }
        AuthError::XstsChildAccount => Some(2_148_916_238),
        _ => None,
    }
}

/// 错误链上被拒绝的那次下载：平台、那一跳的地址与状态码。组合错误（多源耗尽、分片回退）里包着的也找出来。
fn credential_rejected(err: &DownloadError) -> Option<(CredentialRealm, &str, u16)> {
    match err {
        DownloadError::CredentialRejected { realm, url, status } => {
            Some((*realm, url.as_str(), *status))
        }
        DownloadError::AllSourcesExhausted { last, .. } => credential_rejected(last),
        DownloadError::ChunkedFallbackFailed {
            chunked, fallback, ..
        } => credential_rejected(fallback).or_else(|| credential_rejected(chunked)),
        _ => None,
    }
}

fn core_detail(err: &CoreError) -> Map<String, Value> {
    let mut detail = Map::new();
    match err {
        CoreError::Download(e) | CoreError::Install(InstallError::Download(e)) => {
            if let Some((realm, url, status)) = credential_rejected(e) {
                detail.insert("realm".to_owned(), json!(realm.code()));
                detail.insert("url".to_owned(), json!(url));
                detail.insert("status".to_owned(), json!(status));
            }
        }
        CoreError::Auth(auth) => {
            if let Some(code) = xerr(auth) {
                detail.insert("xerr".to_owned(), json!(code));
            }
            match auth {
                AuthError::OAuth { error, description } => {
                    detail.insert("error".to_owned(), json!(error));
                    detail.insert("description".to_owned(), json!(description));
                }
                AuthError::Yggdrasil {
                    error,
                    error_message,
                } => {
                    detail.insert("error".to_owned(), json!(error));
                    detail.insert("error_message".to_owned(), json!(error_message));
                }
                AuthError::AccountNotFound(uuid) => {
                    detail.insert("uuid".to_owned(), json!(uuid));
                }
                AuthError::NotYggdrasilServer { url, .. } => {
                    detail.insert("url".to_owned(), json!(url));
                }
                AuthError::OfflineStoreDeserialize { path, .. } => {
                    detail.insert("path".to_owned(), json!(path.display().to_string()));
                }
                // 原因链上没有 reqwest 错误，因而不会带 detail.network：服务故障不是本机连不上网，
                // 不该触发前端的连通性探测。
                AuthError::ServiceUnavailable { step, status } => {
                    detail.insert("step".to_owned(), json!(step));
                    detail.insert("status".to_owned(), json!(status));
                }
                _ => {}
            }
        }
        CoreError::OfflineFallbackRefused { account, reason } => {
            detail.insert("field".to_owned(), json!("offlineFallback"));
            detail.insert("reason".to_owned(), json!(reason.as_str()));
            detail.insert("account".to_owned(), json!(account));
        }
        CoreError::VersionNotInstalled { id } => {
            detail.insert("id".to_owned(), json!(id));
        }
        CoreError::Instance(InstanceError::InvalidId { id }) => {
            detail.insert("field".to_owned(), json!("id"));
            detail.insert("reason".to_owned(), json!("unsafe_id"));
            detail.insert("id".to_owned(), json!(id));
        }
        CoreError::Instance(InstanceError::InvalidName { name, violation }) => {
            detail.insert("field".to_owned(), json!("name"));
            detail.insert("rule".to_owned(), json!(violation.code()));
            detail.insert("name".to_owned(), json!(name));
        }
        CoreError::Instance(
            InstanceError::InvalidSettings { field, reason }
            | InstanceError::InvalidBackupArgument { field, reason },
        ) => {
            detail.insert("field".to_owned(), json!(field));
            detail.insert("reason".to_owned(), json!(reason));
        }
        CoreError::Instance(InstanceError::InvalidPins { reason, id }) => {
            detail.insert("field".to_owned(), json!("pins"));
            detail.insert("reason".to_owned(), json!(reason.code()));
            detail.insert("id".to_owned(), json!(id));
        }
        CoreError::NoJava { major } => {
            detail.insert("major".to_owned(), json!(major));
        }
        CoreError::ModVersionNotFound {
            platform,
            project_id,
            version_id,
        } => {
            detail.insert("platform".to_owned(), json!(platform));
            detail.insert("project_id".to_owned(), json!(project_id));
            detail.insert("version_id".to_owned(), json!(version_id));
        }
        CoreError::InvalidProjectId {
            platform,
            project_id,
        } => {
            detail.insert("platform".to_owned(), json!(platform));
            detail.insert("project_id".to_owned(), json!(project_id));
        }
        CoreError::WorldNotFound { version_id, world } => {
            detail.insert("version_id".to_owned(), json!(version_id));
            detail.insert("world".to_owned(), json!(world));
        }
        CoreError::WorldBackupNotFound {
            version_id,
            world,
            file,
        } => {
            detail.insert("id".to_owned(), json!(version_id));
            detail.insert("world".to_owned(), json!(world));
            detail.insert("file".to_owned(), json!(file));
        }
        CoreError::Instance(
            InstanceError::BackupArchive { path, reason }
            | InstanceError::BackupLevelUnreadable { path, reason },
        ) => {
            detail.insert("path".to_owned(), json!(path.display().to_string()));
            detail.insert("reason".to_owned(), json!(reason));
        }
        CoreError::Instance(InstanceError::BackupEntryUnsafe {
            path,
            entry,
            reason,
        }) => {
            detail.insert("path".to_owned(), json!(path.display().to_string()));
            detail.insert("entry".to_owned(), json!(entry));
            detail.insert("reason".to_owned(), json!(reason));
        }
        CoreError::Instance(
            InstanceError::BackupIndexInvalid { path, .. } | InstanceError::WorldInUse { path },
        ) => {
            detail.insert("path".to_owned(), json!(path.display().to_string()));
        }
        CoreError::Instance(InstanceError::RestoreNotPlaced { world_dir, staged }) => {
            detail.insert("path".to_owned(), json!(world_dir.display().to_string()));
            detail.insert("staged".to_owned(), json!(staged.display().to_string()));
        }
        CoreError::UnsafeFileName {
            platform,
            file_name,
        } => {
            detail.insert("platform".to_owned(), json!(platform));
            detail.insert("file_name".to_owned(), json!(file_name));
        }
        CoreError::FileDistributionBlocked { files } => {
            let files: Vec<BlockedFileDto> = files.iter().map(BlockedFileDto::from).collect();
            detail.insert("files".to_owned(), json!(files));
        }
        CoreError::ClaimFolderInvalid { path, .. } => {
            detail.insert("path".to_owned(), json!(path.display().to_string()));
        }
        CoreError::InstanceNameInvalid { name, rule } => {
            detail.insert("name".to_owned(), json!(name));
            detail.insert("rule".to_owned(), json!(rule));
        }
        CoreError::JsonFileInvalid { path, .. } => {
            detail.insert("path".to_owned(), json!(path.display().to_string()));
        }
        CoreError::Modpack(modpack) => match modpack {
            ModpackError::UnsupportedExtension { path }
            | ModpackError::ManifestMissing { path }
            | ModpackError::Corrupt { path, .. }
            | ModpackError::Io { path, .. } => {
                detail.insert("path".to_owned(), json!(path.display().to_string()));
            }
            ModpackError::ManifestInvalid { document, reason } => {
                detail.insert("document".to_owned(), json!(document));
                detail.insert("reason".to_owned(), json!(reason));
            }
            ModpackError::UnsafePath { path, .. }
            | ModpackError::SymlinkEntry { path }
            | ModpackError::DuplicatePath { path }
            | ModpackError::NotOptional { path } => {
                detail.insert("path".to_owned(), json!(path));
            }
            ModpackError::UnsupportedCompression {
                path,
                entry,
                method,
            } => {
                detail.insert("path".to_owned(), json!(path.display().to_string()));
                detail.insert("entry".to_owned(), json!(entry));
                detail.insert("method".to_owned(), json!(method));
            }
            ModpackError::ExportCheckFailed { path, reason } => {
                detail.insert("path".to_owned(), json!(path.display().to_string()));
                detail.insert("reason".to_owned(), json!(reason));
            }
            ModpackError::Cancelled => {}
        },
        CoreError::ModpackExportUnsupported { id, reason, loader } => {
            detail.insert("id".to_owned(), json!(id));
            detail.insert("reason".to_owned(), json!(reason));
            if let Some(loader) = loader {
                detail.insert("loader".to_owned(), json!(loader));
            }
        }
        CoreError::ConfigIo { path, .. } | CoreError::ConfigParse { path, .. } => {
            detail.insert("path".to_owned(), json!(path.display().to_string()));
        }
        CoreError::Base(BaseError::Io { path, .. })
        | CoreError::GpuPreferenceWrite { path, .. } => {
            detail.insert("path".to_owned(), json!(path.display().to_string()));
        }
        CoreError::Fetch { url, .. } | CoreError::FeedParse { url, .. } => {
            detail.insert("url".to_owned(), json!(url));
        }
        CoreError::RemotePack { url, reason } => {
            detail.insert("url".to_owned(), json!(url));
            detail.insert("reason".to_owned(), json!(reason));
        }
        CoreError::InvalidServerAddress { address, reason } => {
            detail.insert("address".to_owned(), json!(address));
            detail.insert("reason".to_owned(), json!(reason));
        }
        CoreError::ServerNotPinned { address } => {
            detail.insert("address".to_owned(), json!(address));
        }
        CoreError::Launch(LaunchError::QuickPlayUnsupported { version, mode }) => {
            detail.insert("version_id".to_owned(), json!(version));
            detail.insert("mode".to_owned(), json!(mode.as_str()));
        }
        CoreError::InvalidGameDirectory { path, problem } => {
            detail.insert("path".to_owned(), json!(path.display().to_string()));
            detail.insert("problem".to_owned(), json!(problem.code()));
        }
        CoreError::JavaPathInvalid { path, reason, .. } => {
            detail.insert("path".to_owned(), json!(path.display().to_string()));
            detail.insert("reason".to_owned(), json!(reason.code()));
        }
        CoreError::JavaRuntimeIncomplete { path, missing } => {
            detail.insert("path".to_owned(), json!(path.display().to_string()));
            detail.insert("missing".to_owned(), json!(missing));
        }
        CoreError::TemplateSourceEmpty { id } => {
            detail.insert("id".to_owned(), json!(id));
            detail.insert("files".to_owned(), json!(TEMPLATE_FILES));
        }
        _ => {}
    }
    detail
}

#[cfg(test)]
mod tests {
    use super::*;
    use aurora_core::OfflineFallbackRefusal;
    use std::path::PathBuf;

    #[test]
    fn serializes_as_object_and_omits_absent_detail() {
        let err = CommandError::invalid_argument("未知加载器 rift");
        assert_eq!(
            serde_json::to_value(&err).unwrap(),
            json!({ "code": "invalid_argument", "message": "未知加载器 rift" })
        );
    }

    #[test]
    fn cancellation_from_any_layer_maps_to_cancelled() {
        let from_install: CommandError = InstallError::Download(DownloadError::Cancelled).into();
        assert_eq!(from_install.code, code::CANCELLED);
        assert!(from_install.detail.is_none());

        let from_java: CommandError = JavaError::Cancelled.into();
        assert!(from_java.is_cancelled());

        // 借用转换同样先认取消，不把取消报成下载失败
        let borrowed = CommandError::describe(&CoreError::from(InstallError::Download(
            DownloadError::Cancelled,
        )));
        assert_eq!(borrowed, CommandError::cancelled());
    }

    #[test]
    fn auth_errors_use_variant_names_and_carry_xerr() {
        let err: CommandError = AuthError::XstsChildAccount.into();
        assert_eq!(err.code, "XstsChildAccount");
        assert_eq!(
            err.detail.as_ref().unwrap()["xerr"],
            json!(2_148_916_238_i64)
        );

        let unknown: CommandError = AuthError::XstsUnknown(2_148_916_299).into();
        assert_eq!(unknown.code, "XstsUnknown");
        assert_eq!(unknown.detail.unwrap()["xerr"], json!(2_148_916_299_i64));

        let expired: CommandError = AuthError::DeviceCodeExpired.into();
        assert_eq!(expired.code, "DeviceCodeExpired");
        assert!(expired.detail.is_none(), "无 XErr、无原因链时不带 detail");

        let oauth: CommandError = AuthError::OAuth {
            error: "invalid_client".into(),
            description: "AADSTS700016".into(),
        }
        .into();
        assert_eq!(oauth.code, "OAuth");
        assert_eq!(oauth.detail.unwrap()["description"], json!("AADSTS700016"));
    }

    #[test]
    fn new_auth_variants_map_to_variant_names_with_parameters() {
        let cancelled: CommandError = AuthError::Cancelled.into();
        assert_eq!(cancelled.code, code::CANCELLED);
        assert_eq!(auth_code(&AuthError::Cancelled), code::CANCELLED);

        let no_profile: CommandError = AuthError::YggdrasilNoProfile.into();
        assert_eq!(no_profile.code, "YggdrasilNoProfile");

        let not_server: CommandError = AuthError::NotYggdrasilServer {
            url: "https://example.com/".into(),
            detail: "缺少 meta".into(),
        }
        .into();
        assert_eq!(not_server.code, "NotYggdrasilServer");
        assert_eq!(
            not_server.detail.unwrap()["url"],
            json!("https://example.com/")
        );

        let broken: CommandError = AuthError::OfflineStoreDeserialize {
            path: PathBuf::from("C:/data/offline_accounts.json"),
            source: serde_json::from_str::<Value>("{").unwrap_err(),
        }
        .into();
        assert_eq!(broken.code, "OfflineStoreDeserialize");
        let detail = broken.detail.unwrap();
        assert_eq!(detail["path"], json!("C:/data/offline_accounts.json"));
        assert_eq!(detail["causes"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn login_outage_and_unapproved_app_map_to_their_own_codes() {
        let outage: CommandError = AuthError::ServiceUnavailable {
            step: "XSTS 授权",
            status: 503,
        }
        .into();
        assert_eq!(outage.code, "ServiceUnavailable");
        assert_eq!(outage.message, "登录服务暂时不可用（XSTS 授权：HTTP 503）");
        let detail = outage.detail.unwrap();
        assert_eq!(detail, json!({ "step": "XSTS 授权", "status": 503 }));
        // 不是本机网络问题：不带 network，前端不去探测连通性。
        assert!(detail.get("network").is_none());

        let throttled: CommandError = AuthError::ServiceUnavailable {
            step: "获取游戏档案",
            status: 429,
        }
        .into();
        assert_eq!(throttled.detail.unwrap()["status"], json!(429));

        let unapproved: CommandError = AuthError::AppNotApproved.into();
        assert_eq!(unapproved.code, "AppNotApproved");
        assert!(unapproved.detail.is_none());
        assert!(unapproved.message.contains("Invalid app registration"));
    }

    #[test]
    fn refused_offline_fallback_is_an_invalid_argument_naming_the_reason() {
        for (reason, wire) in [
            (OfflineFallbackRefusal::OfflineAccount, "offline_account"),
            (OfflineFallbackRefusal::ReloginRequired, "relogin_required"),
            (OfflineFallbackRefusal::NoRecentFailure, "no_recent_failure"),
        ] {
            let err: CommandError = CoreError::OfflineFallbackRefused {
                account: "PetalPlayer".into(),
                reason,
            }
            .into();
            assert_eq!(err.code, code::INVALID_ARGUMENT);
            assert!(err
                .message
                .starts_with("PetalPlayer 不能以离线方式进单人："));
            assert_eq!(
                err.detail.unwrap(),
                json!({ "field": "offlineFallback", "reason": wire, "account": "PetalPlayer" })
            );
        }
    }

    #[test]
    fn core_variants_map_to_stable_codes_with_parameters() {
        let no_java: CommandError = CoreError::NoJava { major: 21 }.into();
        assert_eq!(no_java.code, code::JAVA_MISSING);
        assert_eq!(no_java.detail.unwrap()["major"], json!(21));

        let missing: CommandError = CoreError::VersionNotInstalled {
            id: "1.20.1-Forge".into(),
        }
        .into();
        assert_eq!(missing.code, code::VERSION_NOT_INSTALLED);
        assert_eq!(missing.detail.unwrap()["id"], json!("1.20.1-Forge"));

        let loader: CommandError = InstallError::LoaderVersionNotFound {
            loader: "NeoForge",
            game_version: "1.21".into(),
        }
        .into();
        assert_eq!(loader.code, code::LOADER_VERSION_NOT_FOUND);
    }

    #[test]
    fn discover_errors_map_to_codes_with_parameters() {
        let world: CommandError = CoreError::WorldNotFound {
            version_id: "生存".into(),
            world: "新的世界".into(),
        }
        .into();
        assert_eq!(world.code, code::WORLD_NOT_FOUND);
        let detail = world.detail.unwrap();
        assert_eq!(detail["version_id"], json!("生存"));
        assert_eq!(detail["world"], json!("新的世界"));

        let blocked: CommandError = CoreError::FileDistributionBlocked {
            files: vec![
                aurora_core::BlockedFile {
                    project_id: 900_001,
                    file_id: 5_000_001,
                    file_name: "a.jar".into(),
                    web_url: "https://www.curseforge.com/minecraft/mc-mods/a/files/5000001".into(),
                    destination: "mods/a.jar".into(),
                    sha1: Some("0f4a890d07402280686a518579fa9fa02309e315".into()),
                    fingerprint: 0,
                    size: Some(1024),
                },
                aurora_core::BlockedFile {
                    project_id: 900_002,
                    file_id: 5_000_002,
                    file_name: "b.jar".into(),
                    web_url: "https://www.curseforge.com/minecraft/texture-packs/b/files/5000002"
                        .into(),
                    destination: "resourcepacks/b.jar".into(),
                    sha1: None,
                    fingerprint: 4_294_967_295,
                    size: None,
                },
            ],
        }
        .into();
        assert_eq!(blocked.code, code::DISTRIBUTION_BLOCKED);
        assert_eq!(
            blocked.message,
            "这些文件的作者不允许启动器直接下载，需要到 CurseForge 网页手动下载：a.jar、b.jar"
        );
        assert_eq!(
            blocked.detail.unwrap()["files"],
            json!([
                {
                    "project_id": 900_001, "file_id": 5_000_001, "file_name": "a.jar",
                    "web_url": "https://www.curseforge.com/minecraft/mc-mods/a/files/5000001",
                    "destination": "mods/a.jar",
                    "sha1": "0f4a890d07402280686a518579fa9fa02309e315",
                    "fingerprint": 0, "size": 1024
                },
                {
                    "project_id": 900_002, "file_id": 5_000_002, "file_name": "b.jar",
                    "web_url": "https://www.curseforge.com/minecraft/texture-packs/b/files/5000002",
                    "destination": "resourcepacks/b.jar",
                    "sha1": null, "fingerprint": 4_294_967_295_u64, "size": null
                }
            ])
        );

        let unsafe_name: CommandError = CoreError::UnsafeFileName {
            platform: "Modrinth",
            file_name: "../x.jar".into(),
        }
        .into();
        assert_eq!(unsafe_name.code, code::UNSAFE_FILE_NAME);
        assert_eq!(unsafe_name.detail.unwrap()["file_name"], json!("../x.jar"));

        let target: CommandError =
            CoreError::InvalidResourceTarget("数据包要指明存档".into()).into();
        assert_eq!(target.code, code::INVALID_ARGUMENT);

        let project: CommandError = CoreError::InvalidProjectId {
            platform: "CurseForge",
            project_id: "jei".into(),
        }
        .into();
        assert_eq!(project.code, code::INVALID_ARGUMENT);
        assert_eq!(project.detail.unwrap()["project_id"], json!("jei"));
    }

    #[test]
    fn modpack_errors_map_to_codes_with_parameters() {
        let name: CommandError = CoreError::InstanceNameInvalid {
            name: "CON".into(),
            rule: aurora_core::InstanceNameRule::Reserved,
        }
        .into();
        assert_eq!(name.code, code::INSTANCE_NAME_INVALID);
        let detail = name.detail.unwrap();
        assert_eq!(detail["name"], json!("CON"));
        assert_eq!(detail["rule"], json!("reserved"));

        let unsafe_path: CommandError = CoreError::from(ModpackError::UnsafePath {
            path: "overrides/../evil.txt".into(),
            source: aurora_core::PathValidationError::ParentTraversal,
        })
        .into();
        assert_eq!(unsafe_path.code, code::MODPACK_UNSAFE_PATH);
        let detail = unsafe_path.detail.unwrap();
        assert_eq!(detail["path"], json!("overrides/../evil.txt"));
        assert_eq!(detail["causes"], json!(["路径含父目录组件 '..'"]));

        let invalid: CommandError = CoreError::from(ModpackError::ManifestInvalid {
            document: "manifest.json",
            reason: "加载器 rift-1.0 不支持".into(),
        })
        .into();
        assert_eq!(invalid.code, code::MODPACK_MANIFEST_INVALID);
        assert_eq!(invalid.detail.unwrap()["document"], json!("manifest.json"));

        let duplicate: CommandError = CoreError::from(ModpackError::DuplicatePath {
            path: "mods/a.jar".into(),
        })
        .into();
        assert_eq!(duplicate.code, code::MODPACK_MANIFEST_INVALID);

        let link: CommandError = CoreError::from(ModpackError::SymlinkEntry {
            path: "overrides/config".into(),
        })
        .into();
        assert_eq!(link.code, code::MODPACK_UNSAFE_PATH);

        let missing: CommandError = CoreError::from(ModpackError::ManifestMissing {
            path: PathBuf::from("D:/a.zip"),
        })
        .into();
        assert_eq!(missing.code, code::MODPACK_MANIFEST_MISSING);
        assert_eq!(missing.detail.unwrap()["path"], json!("D:/a.zip"));

        let cancelled: CommandError = CoreError::from(ModpackError::Cancelled).into();
        assert!(cancelled.is_cancelled());

        let compression: CommandError = CoreError::from(ModpackError::UnsupportedCompression {
            path: PathBuf::from("D:/包.zip"),
            entry: "overrides/mods/模组.jar".into(),
            method: 93,
        })
        .into();
        assert_eq!(compression.code, code::MODPACK_UNSUPPORTED_COMPRESSION);
        assert_eq!(
            compression.detail,
            Some(json!({ "path": "D:/包.zip", "entry": "overrides/mods/模组.jar", "method": 93 }))
        );

        let not_optional: CommandError = CoreError::from(ModpackError::NotOptional {
            path: "mods/core.jar".into(),
        })
        .into();
        assert_eq!(not_optional.code, code::INVALID_ARGUMENT);
        assert_eq!(
            not_optional.detail,
            Some(json!({ "path": "mods/core.jar" }))
        );

        let folder: CommandError = CoreError::ClaimFolderInvalid {
            path: PathBuf::from("C:/Users/Player/Downloads"),
            reason: "选的文件夹不存在".into(),
        }
        .into();
        assert_eq!(folder.code, code::IO);
        assert_eq!(folder.message, "选的文件夹不存在");
        assert_eq!(
            folder.detail,
            Some(json!({ "path": "C:/Users/Player/Downloads" }))
        );
    }

    /// CurseForge 拒绝下载密钥：不论直接冒上来、包在多源耗尽或分片回退里、还是从安装器的下载里来，码都是
    /// curseforge_key_rejected，detail 带平台、被拒那一跳的地址与状态码；没带密钥的 401 仍是普通下载失败。
    #[test]
    fn rejected_download_keys_map_to_their_own_code() {
        let cdn = "https://mediafilez.forgecdn.net/files/3040/523/jei.jar";
        let rejected = || DownloadError::CredentialRejected {
            realm: CredentialRealm::CurseForge,
            url: cdn.into(),
            status: 401,
        };
        let expected = json!({ "realm": "curseforge", "url": cdn, "status": 401 });
        for (label, err) in [
            ("直接", CoreError::Download(rejected())),
            (
                "多源耗尽",
                CoreError::Download(DownloadError::AllSourcesExhausted {
                    url: "https://edge.forgecdn.net/files/3040/523/jei.jar".into(),
                    last: Box::new(rejected()),
                }),
            ),
            (
                "分片回退",
                CoreError::Download(DownloadError::ChunkedFallbackFailed {
                    url: cdn.into(),
                    chunked: Box::new(DownloadError::Status {
                        url: cdn.into(),
                        status: 404,
                    }),
                    fallback: Box::new(rejected()),
                }),
            ),
            (
                "安装器",
                CoreError::Install(InstallError::Download(rejected())),
            ),
        ] {
            let mapped = CommandError::describe(&err);
            assert_eq!(mapped.code, code::CURSEFORGE_KEY_REJECTED, "{label}");
            assert_eq!(mapped.message, err.to_string(), "{label}");
            let detail = mapped.detail.unwrap();
            for key in ["realm", "url", "status"] {
                assert_eq!(detail[key], expected[key], "{label}：{key}");
            }
        }
        assert_eq!(
            CommandError::describe(&CoreError::Download(rejected())).message,
            format!("CurseForge 拒绝了下载密钥（HTTP 401）：{cdn}")
        );

        let plain: CommandError = DownloadError::Status {
            url: cdn.into(),
            status: 401,
        }
        .into();
        assert_eq!(plain.code, code::DOWNLOAD_FAILED);
        assert!(plain.detail.is_none_or(|d| d.get("realm").is_none()));

        for other in [
            DownloadError::InvalidCredential {
                realm: CredentialRealm::CurseForge,
            },
            DownloadError::TooManyRedirects { url: cdn.into() },
        ] {
            let mapped: CommandError = other.into();
            assert_eq!(mapped.code, code::DOWNLOAD_FAILED);
        }
    }

    #[test]
    fn modpack_export_errors_map_to_codes_with_parameters() {
        let unsupported: CommandError = CoreError::ModpackExportUnsupported {
            id: "光影版".into(),
            reason: aurora_core::ExportBlock::LoaderUnsupported,
            loader: Some("OptiFine".into()),
        }
        .into();
        assert_eq!(unsupported.code, code::MODPACK_EXPORT_UNSUPPORTED);
        assert_eq!(
            unsupported.message,
            "整合包格式不支持 OptiFine，只支持 Fabric、Quilt、Forge、NeoForge"
        );
        assert_eq!(
            unsupported.detail,
            Some(json!({ "id": "光影版", "reason": "loader_unsupported", "loader": "OptiFine" }))
        );

        for (reason, wire) in [
            (aurora_core::ExportBlock::VersionUnknown, "version_unknown"),
            (
                aurora_core::ExportBlock::LoaderVersionUnknown,
                "loader_version_unknown",
            ),
            (
                aurora_core::ExportBlock::MultipleLoaders,
                "multiple_loaders",
            ),
            (aurora_core::ExportBlock::Incomplete, "incomplete"),
        ] {
            let err: CommandError = CoreError::ModpackExportUnsupported {
                id: "生存".into(),
                reason,
                loader: None,
            }
            .into();
            assert_eq!(err.code, code::MODPACK_EXPORT_UNSUPPORTED);
            assert_eq!(
                err.detail,
                Some(json!({ "id": "生存", "reason": wire })),
                "{wire}"
            );
        }

        let check: CommandError = CoreError::from(ModpackError::ExportCheckFailed {
            path: PathBuf::from("D:/导出/樱花林.part.mrpack"),
            reason: "清单里有 2 个文件，要写的是 3 个".into(),
        })
        .into();
        assert_eq!(check.code, code::MODPACK_EXPORT_CHECK_FAILED);
        assert_eq!(
            check.message,
            "导出的整合包没通过回读校验：清单里有 2 个文件，要写的是 3 个"
        );
        assert_eq!(
            check.detail,
            Some(json!({
                "path": "D:/导出/樱花林.part.mrpack",
                "reason": "清单里有 2 个文件，要写的是 3 个"
            }))
        );
    }

    #[test]
    fn system_variants_map_to_codes_with_parameters() {
        let dir: CommandError = CoreError::InvalidGameDirectory {
            path: PathBuf::from("D:/a!b/.minecraft"),
            problem: aurora_core::GameDirProblem::ContainsBang,
        }
        .into();
        assert_eq!(dir.code, code::INVALID_GAME_DIRECTORY);
        let detail = dir.detail.unwrap();
        assert_eq!(detail["problem"], json!("contains_bang"));
        assert_eq!(detail["path"], json!("D:/a!b/.minecraft"));

        let address: CommandError = CoreError::InvalidServerAddress {
            address: "h:0".into(),
            reason: "端口须是 1 到 65535 的整数",
        }
        .into();
        assert_eq!(address.code, code::INVALID_ARGUMENT);
        assert_eq!(address.detail.unwrap()["address"], json!("h:0"));

        let not_pinned: CommandError = CoreError::ServerNotPinned {
            address: "play.example.cn:25566".into(),
        }
        .into();
        assert_eq!(not_pinned.code, "server_not_pinned");
        assert_eq!(
            not_pinned.message,
            "服务器「play.example.cn:25566」没有固定"
        );
        assert_eq!(
            not_pinned.detail,
            Some(json!({ "address": "play.example.cn:25566" }))
        );

        for (mode, name, message) in [
            (
                aurora_core::QuickPlayMode::Singleplayer,
                "singleplayer",
                "版本 1.12.2 不支持直接进入存档（1.20 之前的版本没有 Quick Play）",
            ),
            (
                aurora_core::QuickPlayMode::Multiplayer,
                "multiplayer",
                "版本 1.12.2 不支持直接加入服务器",
            ),
        ] {
            let unsupported: CommandError = LaunchError::QuickPlayUnsupported {
                version: "1.12.2".into(),
                mode,
            }
            .into();
            assert_eq!(unsupported.code, "quick_play_unsupported");
            assert_eq!(unsupported.message, message);
            assert_eq!(
                unsupported.detail,
                Some(json!({ "version_id": "1.12.2", "mode": name }))
            );
        }
        // 启动链路的其余失败仍是 launch_failed。
        let other: CommandError = LaunchError::MissingMainClass {
            version: "x".into(),
        }
        .into();
        assert_eq!(other.code, code::LAUNCH_FAILED);

        let memory: CommandError = CoreError::MemoryUnavailable.into();
        assert_eq!(memory.code, code::MEMORY_UNAVAILABLE);

        let feed: CommandError = CoreError::FeedParse {
            url: "https://x/news.json".into(),
            source: serde_json::from_str::<serde_json::Value>("{").unwrap_err(),
        }
        .into();
        assert_eq!(feed.code, code::FEED_INVALID);
        assert_eq!(feed.detail.unwrap()["url"], json!("https://x/news.json"));

        let pack: CommandError = CoreError::RemotePack {
            url: "https://cdn/pack.mrpack".into(),
            reason: "服务器不支持按范围读取".into(),
        }
        .into();
        assert_eq!(pack.code, code::REMOTE_PACK_UNREADABLE);
        let detail = pack.detail.unwrap();
        assert_eq!(detail["url"], json!("https://cdn/pack.mrpack"));
        assert_eq!(detail["reason"], json!("服务器不支持按范围读取"));

        let template: CommandError = CoreError::TemplateSourceEmpty {
            id: "樱花生存".into(),
        }
        .into();
        assert_eq!(template.code, code::TEMPLATE_SOURCE_EMPTY);
        assert_eq!(
            template.message,
            "实例 樱花生存 的游戏目录里还没有 options.txt 或服务器列表，进一次游戏后再保存"
        );
        assert_eq!(
            template.detail.unwrap(),
            json!({
                "id": "樱花生存",
                "files": ["options.txt", "servers.dat", "optionsof.txt", "optionsshaders.txt"],
            })
        );
    }

    /// 联网失败不论从哪个领域冒上来都带 detail.network；与网络无关的错误不带。
    #[tokio::test]
    async fn network_layer_failures_are_marked_in_detail() {
        let dir = tempfile::tempdir().unwrap();
        let aurora = aurora_core::Aurora::open(
            aurora_core::AuroraConfig::default(),
            dir.path().to_path_buf(),
            dir.path().join("config.json"),
        )
        .unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        let refused: CommandError = aurora
            .probe_auth_server(&format!("http://127.0.0.1:{port}/api/yggdrasil/"))
            .await
            .unwrap_err()
            .into();
        assert_eq!(refused.detail.unwrap()["network"], json!("connect"));

        let local: CommandError = BaseError::Io {
            path: PathBuf::from("C:/data/tasks.json"),
            source: std::io::Error::new(std::io::ErrorKind::TimedOut, "磁盘超时"),
        }
        .into();
        assert!(local.detail.unwrap().get("network").is_none());
    }

    /// 实例参数类问题不论从哪个命令冒上来都是 invalid_argument，detail 指出字段与取值：崩溃诊断、启动日志、
    /// Mod 与历史这些命令不经实例领域自己的映射，直接走通用转换。
    #[tokio::test]
    async fn instance_argument_errors_are_invalid_argument_on_every_path() {
        let dir = tempfile::tempdir().unwrap();
        let aurora = aurora_core::Aurora::open(
            aurora_core::AuroraConfig::default(),
            dir.path().to_path_buf(),
            dir.path().join("config.json"),
        )
        .unwrap();
        for id in [r"..\outside", "../outside", ".hidden", "a/b"] {
            let crash: CommandError = aurora.last_crash(id).await.unwrap_err().into();
            let log: CommandError = aurora.last_launch_log(id).await.unwrap_err().into();
            for err in [crash, log] {
                assert_eq!(err.code, code::INVALID_ARGUMENT, "{id}");
                assert_eq!(
                    err.detail,
                    Some(json!({ "field": "id", "reason": "unsafe_id", "id": id })),
                    "{id}"
                );
            }
        }

        let name: CommandError = InstanceError::InvalidName {
            name: "CON".into(),
            violation: aurora_core::NameViolation::ReservedByWindows,
        }
        .into();
        assert_eq!(name.code, code::INVALID_ARGUMENT);
        assert_eq!(
            name.detail,
            Some(json!({ "field": "name", "rule": "reserved", "name": "CON" }))
        );

        let settings: CommandError = InstanceError::InvalidSettings {
            field: "memory_mb",
            reason: "不能小于 512".into(),
        }
        .into();
        assert_eq!(settings.code, code::INVALID_ARGUMENT);
        assert_eq!(
            settings.detail,
            Some(json!({ "field": "memory_mb", "reason": "不能小于 512" }))
        );

        let pins: CommandError = InstanceError::InvalidPins {
            reason: aurora_core::PinsViolation::NotFound,
            id: Some("ghost".into()),
        }
        .into();
        assert_eq!(pins.code, code::INVALID_ARGUMENT);
        assert_eq!(
            pins.detail,
            Some(json!({ "field": "pins", "reason": "not_found", "id": "ghost" }))
        );
        let too_many: CommandError = InstanceError::InvalidPins {
            reason: aurora_core::PinsViolation::TooMany,
            id: None,
        }
        .into();
        assert_eq!(
            too_many.detail,
            Some(json!({ "field": "pins", "reason": "too_many", "id": null }))
        );

        // 数据本身的问题仍是 instance_failed：不是调用方传错了参数。
        let broken: CommandError = InstanceError::Broken {
            id: "1.21".into(),
            reason: "缺少版本 JSON".into(),
        }
        .into();
        assert_eq!(broken.code, code::INSTANCE_FAILED);
    }

    /// 安装批次把单文件失败收成计数错误，原因链上挂的那条连不上时同样带 detail.network。
    #[tokio::test]
    async fn install_batch_failures_caused_by_the_network_are_marked() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!(
            "http://127.0.0.1:{}/a.jar",
            listener.local_addr().unwrap().port()
        );
        drop(listener);
        let refused = aurora_base::http::build_client()
            .unwrap()
            .get(&url)
            .send()
            .await
            .unwrap_err();
        let batch = |cause: DownloadError| InstallError::BatchIncomplete {
            stage: "库",
            total: 40,
            failed: 3,
            cause: Box::new(cause),
        };

        let offline: CommandError = batch(DownloadError::AllSourcesExhausted {
            url: url.clone(),
            last: Box::new(DownloadError::Request {
                url: url.clone(),
                source: refused,
            }),
        })
        .into();
        assert_eq!(offline.code, code::INSTALL_FAILED);
        assert_eq!(offline.message, "库 阶段有 3/40 个文件下载失败");
        let detail = offline.detail.unwrap();
        assert_eq!(detail["network"], json!("connect"));
        assert_eq!(
            detail["causes"][0],
            json!(format!("所有下载源均失败: {url}"))
        );

        let rejected: CommandError = batch(DownloadError::Status {
            url: url.clone(),
            status: 404,
        })
        .into();
        assert_eq!(rejected.code, code::INSTALL_FAILED);
        let detail = rejected.detail.unwrap();
        assert!(detail.get("network").is_none(), "{detail}");
        assert_eq!(detail["causes"], json!([format!("HTTP 状态码 404: {url}")]));
    }

    /// 存档备份的失败各自成码，detail 带前端分支与「打开文件夹」要的路径；取消从实例层冒上来也是 cancelled。
    #[test]
    fn world_backup_errors_map_to_codes_with_parameters() {
        let missing: CommandError = CoreError::WorldBackupNotFound {
            version_id: "生存".into(),
            world: "新的世界".into(),
            file: "1761900000000-auto.zip".into(),
        }
        .into();
        assert_eq!(missing.code, code::WORLD_BACKUP_NOT_FOUND);
        assert_eq!(
            missing.detail,
            Some(json!({ "id": "生存", "world": "新的世界", "file": "1761900000000-auto.zip" }))
        );

        let zip = PathBuf::from("D:/g/.petalfall/backups/instances/a/w/1-manual.zip");
        let archive: CommandError = InstanceError::BackupArchive {
            path: zip.clone(),
            reason: "中央目录读不出".into(),
        }
        .into();
        assert_eq!(archive.code, code::WORLD_BACKUP_CORRUPT);
        let detail = archive.detail.unwrap();
        assert_eq!(detail["path"], json!(zip.display().to_string()));
        assert_eq!(detail["reason"], json!("中央目录读不出"));
        assert!(detail.get("entry").is_none());

        let traversal: CommandError = InstanceError::BackupEntryUnsafe {
            path: zip.clone(),
            entry: "w/../../evil.txt".into(),
            reason: "parent_traversal",
        }
        .into();
        assert_eq!(traversal.code, code::WORLD_BACKUP_CORRUPT);
        let detail = traversal.detail.unwrap();
        assert_eq!(detail["entry"], json!("w/../../evil.txt"));
        assert_eq!(detail["reason"], json!("parent_traversal"));
        assert_eq!(detail["path"], json!(zip.display().to_string()));

        let level: CommandError = InstanceError::BackupLevelUnreadable {
            path: PathBuf::from("D:/g/saves/w.petalfall-restore/level.dat"),
            reason: "不是 gzip".into(),
        }
        .into();
        assert_eq!(level.code, code::WORLD_BACKUP_CORRUPT);
        assert_eq!(level.detail.unwrap()["reason"], json!("不是 gzip"));

        let index: CommandError = InstanceError::BackupIndexInvalid {
            path: PathBuf::from("D:/g/.petalfall/backups/shared/w/index.json"),
            reason: "expected value at line 1".into(),
        }
        .into();
        assert_eq!(index.code, code::JSON_FILE_INVALID);
        assert_eq!(
            index.detail.unwrap()["path"],
            json!("D:/g/.petalfall/backups/shared/w/index.json")
        );

        let in_use: CommandError = InstanceError::WorldInUse {
            path: PathBuf::from("D:/g/saves/w"),
        }
        .into();
        assert_eq!(in_use.code, code::WORLD_IN_USE);
        assert_eq!(in_use.detail.unwrap()["path"], json!("D:/g/saves/w"));

        let incomplete: CommandError = InstanceError::RestoreNotPlaced {
            world_dir: PathBuf::from("D:/g/saves/w"),
            staged: PathBuf::from("D:/g/saves/w.petalfall-restore"),
        }
        .into();
        assert_eq!(incomplete.code, code::WORLD_RESTORE_INCOMPLETE);
        let detail = incomplete.detail.unwrap();
        assert_eq!(detail["path"], json!("D:/g/saves/w"));
        assert_eq!(detail["staged"], json!("D:/g/saves/w.petalfall-restore"));

        let dest: CommandError = InstanceError::InvalidBackupArgument {
            field: "dest",
            reason: "导出位置不能在存档文件夹里面".into(),
        }
        .into();
        assert_eq!(dest.code, code::INVALID_ARGUMENT);
        assert_eq!(
            dest.detail,
            Some(json!({ "field": "dest", "reason": "导出位置不能在存档文件夹里面" }))
        );

        let cancelled: CommandError = InstanceError::Cancelled.into();
        assert_eq!(cancelled, CommandError::cancelled());
    }

    #[test]
    fn manual_java_errors_map_to_codes_with_reason_and_missing_files() {
        for (reason, name) in [
            (aurora_core::JavaPathProblem::NotAbsolute, "not_absolute"),
            (
                aurora_core::JavaPathProblem::NotJavaExecutable,
                "not_java_executable",
            ),
            (aurora_core::JavaPathProblem::NotFound, "not_found"),
            (aurora_core::JavaPathProblem::ProbeFailed, "probe_failed"),
            (aurora_core::JavaPathProblem::ProbeTimeout, "probe_timeout"),
        ] {
            let err: CommandError = CoreError::JavaPathInvalid {
                path: PathBuf::from("D:/jdk/bin/java.exe"),
                reason,
                source: None,
            }
            .into();
            assert_eq!(err.code, code::JAVA_PATH_INVALID);
            assert_eq!(
                err.detail,
                Some(json!({ "path": "D:/jdk/bin/java.exe", "reason": name })),
                "{name}"
            );
        }

        // 识别超时：原错误进原因链。
        let timeout: CommandError = CoreError::JavaPathInvalid {
            path: PathBuf::from("D:/jdk/bin/java.exe"),
            reason: aurora_core::JavaPathProblem::ProbeTimeout,
            source: Some(JavaError::JavaProbeTimeout {
                path: PathBuf::from("D:/jdk/bin/java.exe"),
                timeout_secs: 10,
            }),
        }
        .into();
        assert_eq!(
            timeout.message,
            "这个 Java 10 秒内没有给出版本信息，已放弃：D:/jdk/bin/java.exe"
        );
        let detail = timeout.detail.unwrap();
        assert_eq!(detail["reason"], json!("probe_timeout"));
        assert_eq!(detail["causes"].as_array().unwrap().len(), 1);

        let incomplete: CommandError = CoreError::JavaRuntimeIncomplete {
            path: PathBuf::from("D:/jdk/bin/java.exe"),
            missing: vec!["release".into(), "lib/modules".into()],
        }
        .into();
        assert_eq!(incomplete.code, code::JAVA_RUNTIME_INCOMPLETE);
        assert_eq!(
            incomplete.message,
            "这个 Java 缺少 release、lib/modules，可能没装完整：D:/jdk/bin/java.exe"
        );
        assert_eq!(
            incomplete.detail,
            Some(json!({ "path": "D:/jdk/bin/java.exe", "missing": ["release", "lib/modules"] }))
        );

        // 启动链路等别处的识别超时仍是 java_failed。
        let elsewhere: CommandError = JavaError::JavaProbeTimeout {
            path: PathBuf::from("D:/jdk/bin/java.exe"),
            timeout_secs: 10,
        }
        .into();
        assert_eq!(elsewhere.code, code::JAVA_FAILED);
    }

    #[test]
    fn gpu_preference_write_maps_to_io_with_the_program_path() {
        let err: CommandError = CoreError::GpuPreferenceWrite {
            path: PathBuf::from("D:/jdk-17/bin/java.exe"),
            source: std::io::Error::new(std::io::ErrorKind::PermissionDenied, "拒绝访问"),
        }
        .into();
        assert_eq!(err.code, code::IO);
        assert_eq!(
            err.detail,
            Some(json!({ "path": "D:/jdk-17/bin/java.exe", "causes": ["拒绝访问"] }))
        );
    }

    #[test]
    fn io_errors_keep_path_and_cause_chain() {
        let err: CommandError = BaseError::Io {
            path: PathBuf::from("C:/data/tasks.json"),
            source: std::io::Error::new(std::io::ErrorKind::PermissionDenied, "拒绝访问"),
        }
        .into();
        assert_eq!(err.code, code::IO);
        let detail = err.detail.unwrap();
        assert_eq!(detail["path"], json!("C:/data/tasks.json"));
        assert_eq!(detail["causes"], json!(["拒绝访问"]));
    }
}
