//! 账户注入：把 [`aurora_auth::Account`] 摊平成启动占位符要用的鉴权值，以及 Authlib-Injector 的
//! javaagent 参数拼装。
//!
//! 鉴权值对应游戏参数里的 `${auth_player_name}` / `${auth_uuid}` / `${auth_access_token}` /
//! `${user_type}` / `${auth_xuid}` / `${clientid}` / `${user_properties}` 系列占位符。Authlib-Injector
//! 走 `-javaagent:<jar>=<api_root>` 让第三方 Yggdrasil 服务器接管验证，配合预取的服务器元数据
//! （Base64）免去启动时的一次元数据请求。

use std::path::{Path, PathBuf};

use aurora_auth::{Account, AccountCredentials, YggdrasilCredentials};

use crate::error::{LaunchError, Result};

/// 离线账户占位用的访问令牌。离线无需真实令牌，用一个非空常量占位（部分 Mod 会读取该字段，空串可能出错）。
pub const OFFLINE_ACCESS_TOKEN: &str = "0";

/// 启动时注入的鉴权值集合。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthValues {
    /// 角色名（`${auth_player_name}`）。
    pub player_name: String,
    /// 32 位无连字符 UUID（`${auth_uuid}`）。
    pub uuid: String,
    /// 访问令牌（`${auth_access_token}`）。
    pub access_token: String,
    /// 账户类型（`${user_type}`）：微软走 `msa`，离线走 `legacy`。
    pub user_type: String,
    /// Xbox 用户 id（`${auth_xuid}`）。微软账户取登录链给出的值；离线、外置账户与登录链没给出时
    /// 为空值：版本模板里 `--xuid` 后面必须跟一个参数位，游戏侧把空值当作「没有 Xbox 身份」。
    pub xuid: String,
    /// 启动器 client id（`${clientid}`）。默认空串，可由调用方补。
    pub client_id: String,
    /// 旧式用户属性（`${user_properties}`），1.7.x~1.12 需要，值为一个 JSON 对象串，默认空对象 `{}`。
    pub user_properties: String,
}

impl AuthValues {
    /// 直接构造离线鉴权值。
    pub fn offline(player_name: impl Into<String>, uuid: impl Into<String>) -> Self {
        Self {
            player_name: player_name.into(),
            uuid: uuid.into(),
            access_token: OFFLINE_ACCESS_TOKEN.to_owned(),
            user_type: "legacy".to_owned(),
            xuid: String::new(),
            client_id: String::new(),
            user_properties: "{}".to_owned(),
        }
    }

    /// 从账户记录摊平出鉴权值。
    ///
    /// 微软账户要求已缓存 Minecraft 访问令牌（`minecraft_token`）；未缓存说明还没登录或令牌已被清理，
    /// 直接报 [`LaunchError::MissingAccessToken`]，让启动前检查/上层去刷新，而不是拿空令牌硬启动。
    pub fn from_account(account: &Account) -> Result<Self> {
        let (access_token, user_type) = match &account.credentials {
            AccountCredentials::Microsoft(creds) => {
                let token = creds.minecraft_token.clone().ok_or_else(|| {
                    LaunchError::MissingAccessToken {
                        name: account.name.clone(),
                    }
                })?;
                (token, "msa".to_owned())
            }
            AccountCredentials::Offline => (OFFLINE_ACCESS_TOKEN.to_owned(), "legacy".to_owned()),
            // 第三方 Yggdrasil 也用 msa 类型（游戏侧仅用于皮肤/多人握手分支，不做真实校验）。
            AccountCredentials::AuthlibInjector(creds) => (creds.access_token.clone(), "msa".to_owned()),
        };

        Ok(Self {
            player_name: account.name.clone(),
            uuid: account.uuid.clone(),
            access_token,
            user_type,
            xuid: match &account.xuid {
                Some(xuid) => xuid.clone(),
                None => String::new(),
            },
            client_id: String::new(),
            user_properties: "{}".to_owned(),
        })
    }

    /// 链式补充 Xbox 用户 id。
    pub fn with_xuid(mut self, xuid: impl Into<String>) -> Self {
        self.xuid = xuid.into();
        self
    }

    /// 链式补充启动器 client id。
    pub fn with_client_id(mut self, client_id: impl Into<String>) -> Self {
        self.client_id = client_id.into();
        self
    }
}

/// Authlib-Injector 的 javaagent 拼装信息。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthlibInjector {
    /// authlib-injector agent jar 的本地路径。
    pub agent_jar: PathBuf,
    /// 认证服务器 API 根地址（透传给 agent 作为其参数）。
    pub api_root: String,
    /// 预取的服务器元数据（Base64），有则注入 `-Dauthlibinjector.yggdrasil.prefetched`，省一次网络往返。
    pub prefetched: Option<String>,
}

impl AuthlibInjector {
    /// 用 agent jar 与 API 根地址构造。
    pub fn new(agent_jar: impl Into<PathBuf>, api_root: impl Into<String>) -> Self {
        Self {
            agent_jar: agent_jar.into(),
            api_root: api_root.into(),
            prefetched: None,
        }
    }

    /// 从 Yggdrasil 凭据（持有 api_root）与 agent jar 构造。
    pub fn from_credentials(agent_jar: impl Into<PathBuf>, credentials: &YggdrasilCredentials) -> Self {
        Self::new(agent_jar, credentials.api_root.clone())
    }

    /// 链式设置预取元数据（Base64）。
    pub fn with_prefetched(mut self, prefetched: impl Into<String>) -> Self {
        self.prefetched = Some(prefetched.into());
        self
    }

    /// 产出注入所需的 JVM 参数。
    pub fn jvm_args(&self) -> Vec<String> {
        let mut args = vec![format!(
            "-javaagent:{}={}",
            self.agent_jar.display(),
            self.api_root
        )];
        if let Some(prefetched) = &self.prefetched {
            args.push(format!("-Dauthlibinjector.yggdrasil.prefetched={prefetched}"));
        }
        args
    }

    /// agent jar 路径的只读视图。
    pub fn agent_jar(&self) -> &Path {
        &self.agent_jar
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aurora_auth::{AccountCredentials, MicrosoftCredentials};

    #[test]
    fn offline_values_use_placeholder_token_and_legacy_type() {
        let account = Account::new("uuidoffline", "Steve", AccountCredentials::Offline);
        let values = AuthValues::from_account(&account).unwrap();
        assert_eq!(values.player_name, "Steve");
        assert_eq!(values.uuid, "uuidoffline");
        assert_eq!(values.access_token, "0");
        assert_eq!(values.user_type, "legacy");
        assert_eq!(values.user_properties, "{}");
    }

    #[test]
    fn microsoft_with_token_is_msa() {
        let account = Account::new(
            "uuidms",
            "Alex",
            AccountCredentials::Microsoft(MicrosoftCredentials {
                refresh_token: "r".into(),
                minecraft_token: Some("mc-token".into()),
                minecraft_expires_at: Some(9999),
            }),
        );
        let values = AuthValues::from_account(&account).unwrap();
        assert_eq!(values.access_token, "mc-token");
        assert_eq!(values.user_type, "msa");
        // 登录链没给出 Xbox id：参数位留空值。
        assert_eq!(values.xuid, "");

        let with_xuid = Account {
            xuid: Some("2535400000000001".into()),
            ..account
        };
        let values = AuthValues::from_account(&with_xuid).unwrap();
        assert_eq!(values.xuid, "2535400000000001");
    }

    #[test]
    fn microsoft_without_token_errors() {
        let account = Account::new(
            "uuidms",
            "Alex",
            AccountCredentials::Microsoft(MicrosoftCredentials {
                refresh_token: "r".into(),
                minecraft_token: None,
                minecraft_expires_at: None,
            }),
        );
        let err = AuthValues::from_account(&account).unwrap_err();
        assert!(matches!(err, LaunchError::MissingAccessToken { name } if name == "Alex"));
    }

    #[test]
    fn authlib_injector_jvm_args_with_and_without_prefetch() {
        let injector = AuthlibInjector::new(PathBuf::from("D:/aurora/authlib-injector.jar"), "https://skin.example/api");
        assert_eq!(
            injector.jvm_args(),
            vec!["-javaagent:D:/aurora/authlib-injector.jar=https://skin.example/api"]
        );

        let with_prefetch = injector.with_prefetched("eyJtZXRhIjoie319fQ==");
        assert_eq!(
            with_prefetch.jvm_args(),
            vec![
                "-javaagent:D:/aurora/authlib-injector.jar=https://skin.example/api".to_string(),
                "-Dauthlibinjector.yggdrasil.prefetched=eyJtZXRhIjoie319fQ==".to_string(),
            ]
        );
    }

    #[test]
    fn authlib_injector_from_credentials_takes_api_root() {
        let creds = YggdrasilCredentials {
            api_root: "https://ali.example/api/".into(),
            access_token: "at".into(),
            client_token: "ct".into(),
        };
        let injector = AuthlibInjector::from_credentials(PathBuf::from("agent.jar"), &creds);
        assert_eq!(injector.api_root, "https://ali.example/api/");
    }
}
