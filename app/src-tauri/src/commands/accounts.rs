//! 账户：离线账户、微软设备码登录、外置登录与多账户读写。
//!
//! 绝不把含令牌的 [`Account`] 整体过 IPC，一律摘成只含 uuid / 名字 / 类型的 [`AccountDto`]。
//! 账户库的加密落盘只有 Windows（DPAPI）实现：非 Windows 下读操作返回空，写与登录报
//! `platform_unsupported`，保证跨平台可编译又不假装成功。

use aurora_core::{Account, AccountType, Aurora, DeviceCodeResponse};
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::commands::CommandError;
use crate::events::{self, CoreEventForwarder, DEVICE_CODE_EVENT};
use crate::facade::Facade;

/// 账户 DTO：只暴露 uuid / name / account_type，绝不含任何 access/refresh 令牌。
#[derive(Debug, Serialize)]
pub struct AccountDto {
    pub uuid: String,
    pub name: String,
    pub account_type: AccountType,
}

pub(crate) fn account_dto(account: &Account) -> AccountDto {
    AccountDto {
        uuid: account.uuid.clone(),
        name: account.name.clone(),
        account_type: account.account_type,
    }
}

/// 微软设备码 DTO：经 [`DEVICE_CODE_EVENT`] 推给前端，展示待输入短码与验证网址。
#[derive(Debug, Serialize, Clone)]
pub struct DeviceCodeDto {
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
    pub message: String,
}

impl From<&DeviceCodeResponse> for DeviceCodeDto {
    fn from(device: &DeviceCodeResponse) -> Self {
        DeviceCodeDto {
            user_code: device.user_code.clone(),
            verification_uri: device.verification_uri.clone(),
            expires_in: device.expires_in,
            interval: device.interval,
            message: device.message.clone(),
        }
    }
}

/// 读取当前选中账户（可能没有）。
#[tauri::command]
pub async fn current_account(
    facade: State<'_, Facade>,
) -> Result<Option<AccountDto>, CommandError> {
    let aurora = facade.read().await;
    read_current_account(&aurora)
}

/// 创建一个离线账户（不落库，供离线启动即用即弃）。用户名的软性告警经 core-event 推送。
#[tauri::command]
pub async fn create_offline_account(
    app: AppHandle,
    name: String,
    facade: State<'_, Facade>,
) -> Result<AccountDto, CommandError> {
    let events = CoreEventForwarder::to_app(&app, None);
    let account = {
        let aurora = facade.read().await;
        aurora.create_offline_account(&name, Some(events.sink()))
    };
    events.finish().await;
    Ok(account_dto(&account?))
}

/// 微软设备码登录（两段式）：拿到设备码时经 [`DEVICE_CODE_EVENT`] 推给前端，随后轮询直至令牌换取
/// 完成、账户落库，返回登录到的账户。
///
/// 轮询最长可达设备码有效期（十几分钟），全程在门面快照上进行、不持门面锁，期间其余命令照常响应。
#[tauri::command]
pub async fn microsoft_login(
    app: AppHandle,
    facade: State<'_, Facade>,
) -> Result<AccountDto, CommandError> {
    microsoft_login_with(&facade, move |device| {
        events::emit(&app, DEVICE_CODE_EVENT, DeviceCodeDto::from(device))
    })
    .await
}

#[cfg(windows)]
pub(crate) async fn microsoft_login_with(
    facade: &Facade,
    on_code: impl FnOnce(&DeviceCodeResponse) + Send,
) -> Result<AccountDto, CommandError> {
    let aurora = facade.snapshot().await;
    let account = aurora.microsoft_login(on_code).await?;
    Ok(account_dto(&account))
}

#[cfg(not(windows))]
pub(crate) async fn microsoft_login_with(
    _facade: &Facade,
    _on_code: impl FnOnce(&DeviceCodeResponse) + Send,
) -> Result<AccountDto, CommandError> {
    Err(aurora_core::CoreError::PlatformUnsupported.into())
}

/// Authlib-Injector（第三方验证服务器）用户名密码登录，成功后账户落库并返回。
#[tauri::command]
pub async fn authlib_login(
    server_url: String,
    username: String,
    password: String,
    facade: State<'_, Facade>,
) -> Result<AccountDto, CommandError> {
    let aurora = facade.snapshot().await;
    authlib_login_impl(&aurora, &server_url, &username, &password).await
}

#[cfg(windows)]
async fn authlib_login_impl(
    aurora: &Aurora,
    server_url: &str,
    username: &str,
    password: &str,
) -> Result<AccountDto, CommandError> {
    let account = aurora.authlib_login(server_url, username, password).await?;
    Ok(account_dto(&account))
}

#[cfg(not(windows))]
async fn authlib_login_impl(
    _aurora: &Aurora,
    _server_url: &str,
    _username: &str,
    _password: &str,
) -> Result<AccountDto, CommandError> {
    Err(aurora_core::CoreError::PlatformUnsupported.into())
}

/// 读取账户库中的全部账户（只含 uuid/name/type，无任何令牌）。
#[tauri::command]
pub async fn list_accounts(facade: State<'_, Facade>) -> Result<Vec<AccountDto>, CommandError> {
    let aurora = facade.read().await;
    list_accounts_impl(&aurora)
}

/// 切换当前选中账户。
#[tauri::command]
pub async fn set_current_account(
    uuid: String,
    facade: State<'_, Facade>,
) -> Result<(), CommandError> {
    let aurora = facade.read().await;
    set_current_account_impl(&aurora, &uuid)
}

/// 删除账户。
#[tauri::command]
pub async fn remove_account(uuid: String, facade: State<'_, Facade>) -> Result<(), CommandError> {
    let aurora = facade.read().await;
    remove_account_impl(&aurora, &uuid)
}

// ---- 账户库访问（凭据加密仅 Windows）----

#[cfg(windows)]
fn read_current_account(aurora: &Aurora) -> Result<Option<AccountDto>, CommandError> {
    Ok(aurora.current_account()?.as_ref().map(account_dto))
}

#[cfg(not(windows))]
fn read_current_account(_aurora: &Aurora) -> Result<Option<AccountDto>, CommandError> {
    Ok(None)
}

#[cfg(windows)]
fn list_accounts_impl(aurora: &Aurora) -> Result<Vec<AccountDto>, CommandError> {
    Ok(aurora.accounts()?.iter().map(account_dto).collect())
}

#[cfg(not(windows))]
fn list_accounts_impl(_aurora: &Aurora) -> Result<Vec<AccountDto>, CommandError> {
    Ok(Vec::new())
}

#[cfg(windows)]
fn set_current_account_impl(aurora: &Aurora, uuid: &str) -> Result<(), CommandError> {
    Ok(aurora.set_current_account(uuid)?)
}

#[cfg(not(windows))]
fn set_current_account_impl(_aurora: &Aurora, _uuid: &str) -> Result<(), CommandError> {
    Err(aurora_core::CoreError::PlatformUnsupported.into())
}

#[cfg(windows)]
fn remove_account_impl(aurora: &Aurora, uuid: &str) -> Result<(), CommandError> {
    Ok(aurora.remove_account(uuid)?)
}

#[cfg(not(windows))]
fn remove_account_impl(_aurora: &Aurora, _uuid: &str) -> Result<(), CommandError> {
    Err(aurora_core::CoreError::PlatformUnsupported.into())
}

/// 按 uuid 取出完整账户（含令牌，仅供启动时注入命令行，绝不过 IPC）。
#[cfg(windows)]
pub(crate) fn find_account(aurora: &Aurora, uuid: &str) -> Result<Account, CommandError> {
    aurora
        .accounts()?
        .into_iter()
        .find(|a| a.uuid == uuid)
        .ok_or_else(|| aurora_core::AuthError::AccountNotFound(uuid.to_owned()).into())
}

#[cfg(not(windows))]
pub(crate) fn find_account(_aurora: &Aurora, _uuid: &str) -> Result<Account, CommandError> {
    Err(aurora_core::CoreError::PlatformUnsupported.into())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use aurora_core::{AuroraConfig, MsaEndpoints};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// 设备码轮询期间门面不被占用：读命令 50 ms 内返回，写锁也能立即拿到。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn device_code_polling_does_not_hold_the_facade() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/devicecode"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"{"device_code":"DEV","user_code":"WXYZ-1234",
                    "verification_uri":"https://microsoft.com/link","expires_in":900,"interval":1,
                    "message":"输入 WXYZ-1234"}"#,
            ))
            .mount(&server)
            .await;
        // 用户一直没去网页上授权：令牌端点永远回 authorization_pending。
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(400).set_body_string(
                r#"{"error":"authorization_pending","error_description":"waiting"}"#,
            ))
            .mount(&server)
            .await;

        let dir = tempfile::tempdir().unwrap();
        let config = AuroraConfig {
            msa_client_id: Some("test-client".into()),
            game_directory: Some(dir.path().join(".minecraft")),
            ..AuroraConfig::default()
        };
        let aurora = Aurora::open(
            config,
            dir.path().to_path_buf(),
            dir.path().join("config.json"),
        )
        .unwrap()
        .with_msa_endpoints(MsaEndpoints {
            oauth_base: server.uri(),
            xbl_authenticate: format!("{}/xbl", server.uri()),
            xsts_authorize: format!("{}/xsts", server.uri()),
            minecraft_base: server.uri(),
        });
        let facade = Arc::new(Facade::new(aurora));

        let (code_tx, code_rx) = tokio::sync::oneshot::channel();
        let login_facade = facade.clone();
        let login = tokio::spawn(async move {
            microsoft_login_with(&login_facade, move |device| {
                let _ = code_tx.send(device.user_code.clone());
            })
            .await
        });

        let user_code = tokio::time::timeout(Duration::from_secs(5), code_rx)
            .await
            .expect("5 s 内应拿到设备码")
            .unwrap();
        assert_eq!(user_code, "WXYZ-1234");
        // 让轮询进入「回 pending 后按间隔等待」的状态。
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!login.is_finished(), "此刻应仍在轮询");

        let started = Instant::now();
        let config = crate::commands::config::read_config(&facade).await;
        let elapsed = started.elapsed();
        assert!(
            elapsed < Duration::from_millis(50),
            "读命令耗时 {elapsed:?}"
        );
        assert!(config.has_client_id);
        assert!(facade.is_unlocked(), "轮询期间不应有人持有门面锁");

        login.abort();
    }
}
