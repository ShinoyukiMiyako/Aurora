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

use std::error::Error as StdError;

use aurora_core::{
    AuthError, BaseError, CoreError, DownloadError, InstallError, InstanceError, JavaError,
    LaunchError, ModPlatformError, VersionError,
};
use serde::Serialize;
use serde_json::{json, Map, Value};

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
    /// 启动链路失败（命令拼装、进程拉起）。
    pub const LAUNCH_FAILED: &str = "launch_failed";
    /// 未配置 CurseForge API 密钥。
    pub const CURSEFORGE_KEY_MISSING: &str = "curseforge_key_missing";
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
    /// 缺少微软登录 client_id。
    pub const MISSING_CLIENT_ID: &str = "missing_client_id";
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

impl From<CoreError> for CommandError {
    fn from(err: CoreError) -> Self {
        if err.is_cancelled() {
            return Self::cancelled();
        }
        let code = core_code(&err);
        let message = err.to_string();
        let causes = source_chain(&err);
        let mut detail = core_detail(&err);
        if !causes.is_empty() {
            detail.insert("causes".to_owned(), json!(causes));
        }
        // 命令边界是错误离开后端的最后一站，在这里留一条日志，排查时与前端提示对得上。
        tracing::warn!(code, %message, ?causes, "命令失败");
        Self {
            code,
            message,
            detail: (!detail.is_empty()).then_some(Value::Object(detail)),
        }
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
fn source_chain(err: &dyn StdError) -> Vec<String> {
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
        CoreError::Download(_) => code::DOWNLOAD_FAILED,
        CoreError::Install(e) => install_code(e),
        CoreError::Instance(_) => code::INSTANCE_FAILED,
        CoreError::Java(_) => code::JAVA_FAILED,
        CoreError::Auth(e) => auth_code(e),
        CoreError::Launch(_) => code::LAUNCH_FAILED,
        CoreError::ModPlatform(e) => mod_platform_code(e),
        CoreError::ConfigIo { .. } => code::CONFIG_IO,
        CoreError::ConfigParse { .. } => code::CONFIG_INVALID,
        CoreError::ConfigSerialize(_) => code::CONFIG_SERIALIZE,
        CoreError::MissingClientId => code::MISSING_CLIENT_ID,
        CoreError::VersionNotInstalled { .. } => code::VERSION_NOT_INSTALLED,
        CoreError::ModVersionNotFound { .. } => code::MOD_VERSION_NOT_FOUND,
        CoreError::NoJava { .. } => code::JAVA_MISSING,
        CoreError::PrecheckFailed(_) => code::PRECHECK_FAILED,
        CoreError::TaskJoin(_) => code::INTERNAL,
        CoreError::PlatformUnsupported => code::PLATFORM_UNSUPPORTED,
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

fn core_detail(err: &CoreError) -> Map<String, Value> {
    let mut detail = Map::new();
    match err {
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
                _ => {}
            }
        }
        CoreError::VersionNotInstalled { id } => {
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
        CoreError::ConfigIo { path, .. } | CoreError::ConfigParse { path, .. } => {
            detail.insert("path".to_owned(), json!(path.display().to_string()));
        }
        CoreError::Base(BaseError::Io { path, .. }) => {
            detail.insert("path".to_owned(), json!(path.display().to_string()));
        }
        _ => {}
    }
    detail
}

#[cfg(test)]
mod tests {
    use super::*;
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
