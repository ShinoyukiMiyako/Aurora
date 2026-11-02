//! petalfall-auth（L1 账户体系）
//!
//! 三类登录方式的后端状态机：微软正版、离线、Authlib-Injector（Yggdrasil）。
//! 统一通行证（Nide8）依赖第三方商业服务，本轮不做。
//!
//! 模块划分：
//! - [`error`]：本 crate 独立错误枚举 [`AuthError`]，`#[from] petalfall_base::Error` 冒泡下层错误。
//! - [`account`]：账户模型（uuid/名称/类型/令牌引用）与多账户管理 [`AccountManager`]。
//! - [`offline`]：离线用户名合法性校验与稳定离线 UUID（与原版一致）。
//! - [`offline_store`]：离线账户的明文 JSON 持久化（不进 DPAPI 凭据库）。
//! - [`microsoft`]：微软设备码流全链（devicecode -> token -> XBL -> XSTS -> Minecraft -> profile）。
//! - [`yggdrasil`]：Authlib-Injector 的 Yggdrasil 客户端与 ALI 元数据预取。
//! - [`credential`]：凭据存储抽象 [`CredentialStore`]（跨平台缝）。
//! - `dpapi`（仅 Windows）：基于 DPAPI(CurrentUser) 的凭据加密落盘实现。
//!
//! 登录方式的“分派”按账户的 [`account::AccountType`] 进行，各方式对应本模块内独立的流程实现。
//! 令牌链细节遵循 minecraft.wiki 的 Microsoft authentication 文档与 authlib-injector 技术规范。

pub mod account;
pub mod credential;
pub mod error;
pub mod microsoft;
pub mod offline;
pub mod offline_store;
pub mod yggdrasil;

#[cfg(windows)]
pub mod dpapi;

pub use account::{
    Account, AccountCredentials, AccountDatabase, AccountManager, AccountStatus, AccountType,
    GameProfile, MicrosoftCredentials, SkinModel, SkinRef, YggdrasilCredentials, unix_millis,
};
pub use credential::CredentialStore;
pub use error::{AuthError, Result};
pub use microsoft::{DeviceCodeResponse, MicrosoftAuth, MicrosoftSession, MsaEndpoints, MsaToken};
pub use offline::{UsernameCheck, offline_account, offline_uuid, validate_username};
pub use offline_store::{OfflineAccountDb, OfflineAccountStore, OfflineEntry};
pub use yggdrasil::{
    AliMetadata, AuthenticateResponse, RefreshResponse, YggdrasilClient, YggdrasilMetadata,
};

#[cfg(windows)]
pub use dpapi::DpapiCredentialStore;
