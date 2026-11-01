//! crate 统一错误类型 [`AuthError`]。
//!
//! 每个变体携带足够定位现场的上下文（HTTP 上下文、OAuth/Yggdrasil 的 error 字段、XSTS 错误码）。
//! 令牌刷新失败明确区分“需重登”（[`AuthError::ReloginRequired`]）与瞬时“网络失败”
//! （[`AuthError::Http`]，实现 [`RetryableError`] 后可被上层 `retry_async` 重试）。

use aurora_base::retry::RetryableError;

/// aurora-auth 对外统一错误。
#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    /// 下层 aurora-base 错误（文件、哈希、镜像改写等）冒泡。
    #[error(transparent)]
    Base(#[from] aurora_base::Error),

    /// HTTP 请求发送或读取响应体失败（瞬时网络故障，可重试）。
    #[error("HTTP 请求失败（{context}）")]
    Http {
        context: &'static str,
        #[source]
        source: reqwest::Error,
    },

    /// 响应体 JSON 解析失败（字段缺失或结构不符）。
    #[error("响应解析失败（{context}）")]
    Parse {
        context: &'static str,
        #[source]
        source: serde_json::Error,
    },

    /// 响应结构不符合协议约定（缺少必需字段、头部畸形等）。
    #[error("响应不符合协议约定（{context}）: {detail}")]
    Response {
        context: &'static str,
        detail: String,
    },

    /// 设备码在用户完成授权前已过期，需重新发起登录。
    #[error("设备码已过期，请重新发起登录")]
    DeviceCodeExpired,

    /// 用户在浏览器中拒绝了本次登录授权。
    #[error("用户拒绝了本次登录授权")]
    AuthorizationDeclined,

    /// 微软 OAuth 端点返回的其它错误（非 pending/declined/expired）。
    #[error("微软登录失败: {error} - {description}")]
    OAuth { error: String, description: String },

    /// XSTS：该 Xbox 账户已被封禁。错误码 2148916227。
    #[error("该 Xbox 账户已被封禁，无法登录（XErr 2148916227）")]
    XstsBanned,

    /// XSTS：该微软账户未创建 Xbox 账户。错误码 2148916233。
    #[error("该微软账户尚未创建 Xbox 账户，请先在浏览器登录一次 Xbox（XErr 2148916233）")]
    XstsNoXboxAccount,

    /// XSTS：账户所在国家/地区不支持 Xbox Live。错误码 2148916235。
    #[error("当前账户所在国家或地区不支持 Xbox Live 服务（XErr 2148916235）")]
    XstsRegionUnavailable,

    /// XSTS：需要成人身份验证（韩国地区）。错误码 2148916236 / 2148916237。
    #[error("该账户需要完成成人身份验证后才能使用（XErr {0}）")]
    XstsAdultVerificationRequired(i64),

    /// XSTS：未成年账户，需由家庭组管理员将其加入家庭组。错误码 2148916238。
    #[error("该账户为未成年账户，需先由家庭组管理员将其加入家庭组（XErr 2148916238）")]
    XstsChildAccount,

    /// XSTS：未在已知表内的错误码。
    #[error("XSTS 授权失败，未识别的错误码 XErr {0}")]
    XstsUnknown(i64),

    /// 该账户未拥有 Minecraft（未购买正版或未设置游戏档案）。
    #[error("该账户未拥有 Minecraft（未购买正版或未创建游戏档案）")]
    MinecraftProfileNotFound,

    /// 令牌刷新判定为凭据失效，必须重新走完整登录流程（区别于网络故障）。
    #[error("登录凭据已失效，需要重新登录")]
    ReloginRequired,

    /// 微软登录链或 Yggdrasil 外置登录某一步遇到服务端故障：5xx、429，或返回的是故障页。可重试。
    /// 原文不写是哪家的服务：微软与外置登录共用这个变体，`step` 已经说明是哪一步。
    #[error("登录服务暂时不可用（{step}：HTTP {status}）")]
    ServiceUnavailable { step: &'static str, status: u16 },

    /// Minecraft 服务拒绝了启动器所用的微软应用：login_with_xbox 返回 403，且响应体含 Invalid app registration。
    #[error(
        "{} 使用的微软应用未获准访问 Minecraft 服务（Invalid app registration）",
        aurora_base::brand::APP_NAME
    )]
    AppNotApproved,

    /// 离线用户名不合法（空、含引号、超长）。
    #[error("离线用户名不合法: {0}")]
    InvalidUsername(String),

    /// Yggdrasil（Authlib-Injector）认证服务器返回的业务错误。
    #[error("第三方认证失败: {error} - {error_message}")]
    Yggdrasil {
        error: String,
        error_message: String,
    },

    /// 目标账户不存在（多账户管理的选择/删除）。
    #[error("账户不存在: {0}")]
    AccountNotFound(String),

    /// 凭据缓存序列化失败。
    #[error("凭据序列化失败")]
    CredentialSerialize(#[source] serde_json::Error),

    /// 凭据缓存反序列化失败（文件损坏或格式不兼容）。
    #[error("凭据反序列化失败（凭据文件可能已损坏）")]
    CredentialDeserialize(#[source] serde_json::Error),

    /// Windows DPAPI 加解密失败。message 为格式化后的系统错误，避免 error 层引入平台类型。
    #[error("Windows DPAPI {operation}失败: {message}")]
    Dpapi {
        operation: &'static str,
        message: String,
    },

    /// 登录在完成前被取消（用户关掉了登录弹窗，或新的一次登录顶替了它）。
    #[error("登录已取消")]
    Cancelled,

    /// 外置登录认证成功，但这个账户下一个游戏角色都没有，无从组装档案。
    #[error("这个账户下还没有游戏角色，请先在验证服务器的网站上创建一个")]
    YggdrasilNoProfile,

    /// 填写的地址能连上，但返回的不是 Yggdrasil 验证服务器的元数据。
    #[error("{url} 不是外置登录验证服务器：{detail}")]
    NotYggdrasilServer { url: String, detail: String },

    /// 离线账户库序列化失败。
    #[error("离线账户库序列化失败")]
    OfflineStoreSerialize(#[source] serde_json::Error),

    /// 离线账户库文件存在但解析不了（被别的程序写坏或手改成了非法 JSON）。
    #[error("离线账户库 {} 解析失败（文件可能已损坏）", path.display())]
    OfflineStoreDeserialize {
        path: std::path::PathBuf,
        #[source]
        source: serde_json::Error,
    },
}

/// [`AuthError::Dpapi`] 的操作名：加密。
pub(crate) const DPAPI_ENCRYPT: &str = "加密";

/// [`AuthError::Dpapi`] 的操作名：解密。
pub(crate) const DPAPI_DECRYPT: &str = "解密";

impl AuthError {
    /// 是否由取消令牌引起。
    pub fn is_cancelled(&self) -> bool {
        matches!(self, AuthError::Cancelled)
    }

    /// 凭据库文件读到了、却还原不出账户库：解密不了（数据目录搬到了另一台机器或另一个 Windows 用户下、
    /// 文件被改坏），或解出来的不是账户库。
    ///
    /// 读文件本身失败（被占用、没有权限）不算：那时文件未必坏，当成坏文件处置的话，下一次写入会盖掉
    /// 里面还好好的账户。
    pub fn is_unreadable_credentials(&self) -> bool {
        matches!(
            self,
            AuthError::CredentialDeserialize(_)
                | AuthError::Dpapi {
                    operation: DPAPI_DECRYPT,
                    ..
                }
        )
    }
}

/// crate 级 `Result` 别名。
pub type Result<T> = std::result::Result<T, AuthError>;

impl RetryableError for AuthError {
    fn is_retryable(&self) -> bool {
        match self {
            // 下层错误的可重试性交给 aurora-base 判定（瞬时 IO、哈希不符等）。
            AuthError::Base(inner) => inner.is_retryable(),
            // 连接建立、读取超时与读到一半断开都是瞬时网络故障，值得重试。读响应体失败 reqwest 报 decode
            // 类；响应解析不走这里，读不懂的 JSON 是 Parse。
            AuthError::Http { source, .. } => {
                source.is_timeout()
                    || source.is_connect()
                    || source.is_request()
                    || source.is_body()
                    || source.is_decode()
            }
            // 服务端故障多为短时过载或发布中的抖动，按退避重试有望恢复。
            AuthError::ServiceUnavailable { .. } => true,
            // 其余均为确定性的业务/协议/凭据错误，重试是同样结果。
            AuthError::Parse { .. }
            | AuthError::Response { .. }
            | AuthError::DeviceCodeExpired
            | AuthError::AuthorizationDeclined
            // 令牌端点说自己忙时报的是 ServiceUnavailable，走到这个变体的都是确定性的拒绝。
            | AuthError::OAuth { .. }
            | AuthError::XstsBanned
            | AuthError::XstsNoXboxAccount
            | AuthError::XstsRegionUnavailable
            | AuthError::XstsAdultVerificationRequired(_)
            | AuthError::XstsChildAccount
            | AuthError::XstsUnknown(_)
            | AuthError::MinecraftProfileNotFound
            | AuthError::ReloginRequired
            // 同一个 client_id 再请求一次只会得到同样的拒绝。
            | AuthError::AppNotApproved
            | AuthError::InvalidUsername(_)
            | AuthError::Yggdrasil { .. }
            | AuthError::AccountNotFound(_)
            | AuthError::CredentialSerialize(_)
            | AuthError::CredentialDeserialize(_)
            | AuthError::Dpapi { .. }
            | AuthError::Cancelled
            | AuthError::YggdrasilNoProfile
            | AuthError::NotYggdrasilServer { .. }
            | AuthError::OfflineStoreSerialize(_)
            | AuthError::OfflineStoreDeserialize { .. } => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 响应体读到一半连接断开时 reqwest 报 decode 类错误，登录链的 JSON 解析另走 [`AuthError::Parse`]，
    /// 所以这里的 decode 只会是传输故障，再试一次有望成功。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_body_cut_off_midway_is_retryable() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/token", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut head = Vec::new();
            let mut byte = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).unwrap();
                head.push(byte[0]);
            }
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 64\r\nConnection: close\r\n\r\n{")
                .unwrap();
        });
        let client = aurora_base::http::build_client().unwrap();
        let response = client.get(&url).send().await.unwrap();

        let source = response.text().await.unwrap_err();

        assert!(source.is_decode(), "{source:?}");
        assert!(
            AuthError::Http {
                context: "测试",
                source,
            }
            .is_retryable()
        );
    }

    #[test]
    fn relogin_required_is_terminal_not_retryable() {
        // “需重登”是确定性失效，绝不能被当作瞬时网络故障重试。
        assert!(!AuthError::ReloginRequired.is_retryable());
    }

    #[test]
    fn cancellation_is_recognised_and_never_retried() {
        assert!(AuthError::Cancelled.is_cancelled());
        assert!(!AuthError::Cancelled.is_retryable());
        assert!(!AuthError::ReloginRequired.is_cancelled());
        assert!(!AuthError::DeviceCodeExpired.is_cancelled());
    }

    #[test]
    fn oauth_rejections_are_not_retried() {
        let oauth = |error: &str| AuthError::OAuth {
            error: error.into(),
            description: String::new(),
        };
        for error in [
            "invalid_request",
            "invalid_client",
            "unauthorized_client",
            "",
        ] {
            assert!(!oauth(error).is_retryable(), "{error} 不该被重试");
        }
    }

    /// 只有「读到了却还原不出来」算坏凭据库；读文件失败、加密失败都不算，否则好文件会被当成坏文件挪走。
    #[test]
    fn only_decrypt_and_parse_failures_mean_unreadable_credentials() {
        let dpapi = |operation| AuthError::Dpapi {
            operation,
            message: "该项不适于在指定状态下使用。 (0x8009000B)".into(),
        };
        let parse = serde_json::from_slice::<serde_json::Value>(b"{").unwrap_err();
        assert!(dpapi(DPAPI_DECRYPT).is_unreadable_credentials());
        assert!(AuthError::CredentialDeserialize(parse).is_unreadable_credentials());

        let io = aurora_base::Error::Io {
            path: "credentials.bin".into(),
            source: std::io::Error::from(std::io::ErrorKind::PermissionDenied),
        };
        let serialize = serde_json::from_slice::<serde_json::Value>(b"]").unwrap_err();
        for err in [
            dpapi(DPAPI_ENCRYPT),
            AuthError::Base(io),
            AuthError::CredentialSerialize(serialize),
            AuthError::AccountNotFound("0000".into()),
            AuthError::ReloginRequired,
        ] {
            assert!(
                !err.is_unreadable_credentials(),
                "{err:?} 不该被当成坏凭据库"
            );
        }
    }

    #[test]
    fn base_error_delegates_retryability() {
        // 下层可重试错误（哈希不符）经包装后仍可重试。
        let base = aurora_base::Error::HashMismatch {
            algorithm: "SHA-1",
            expected: "aa".into(),
            actual: "bb".into(),
        };
        assert!(AuthError::Base(base).is_retryable());
    }

    #[test]
    fn xsts_child_account_message_carries_code() {
        assert!(
            AuthError::XstsChildAccount
                .to_string()
                .contains("2148916238")
        );
        assert!(
            AuthError::XstsAdultVerificationRequired(2148916236)
                .to_string()
                .contains("2148916236")
        );
    }

    #[test]
    fn service_unavailable_is_retryable_and_names_step_and_status() {
        let err = AuthError::ServiceUnavailable {
            step: "XSTS 授权",
            status: 503,
        };
        assert!(err.is_retryable());
        assert!(!err.is_cancelled());
        let text = err.to_string();
        assert!(text.contains("XSTS 授权"), "{text}");
        assert!(text.contains("HTTP 503"), "{text}");

        let throttled = AuthError::ServiceUnavailable {
            step: "获取游戏档案",
            status: 429,
        };
        assert!(throttled.is_retryable());
        assert!(throttled.to_string().contains("获取游戏档案：HTTP 429"));
    }

    #[test]
    fn app_not_approved_is_terminal_and_names_the_app() {
        let err = AuthError::AppNotApproved;
        assert!(!err.is_retryable());
        let text = err.to_string();
        assert!(text.starts_with(aurora_base::brand::APP_NAME), "{text}");
        assert!(text.contains("Invalid app registration"), "{text}");
    }

    #[test]
    fn yggdrasil_error_surfaces_server_fields() {
        let err = AuthError::Yggdrasil {
            error: "ForbiddenOperationException".into(),
            error_message: "Invalid credentials.".into(),
        };
        let text = err.to_string();
        assert!(text.contains("ForbiddenOperationException"));
        assert!(text.contains("Invalid credentials."));
    }
}
