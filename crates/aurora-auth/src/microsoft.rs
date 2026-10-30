//! 微软正版登录链（OAuth2 设备码流）。
//!
//! 令牌链：`devicecode` -> 轮询 `token` -> XBL（user.auth.xboxlive.com）->
//! XSTS（xsts.auth.xboxlive.com，RelyingParty `rp://api.minecraftservices.com/`）->
//! `login_with_xbox`（api.minecraftservices.com）-> `minecraft/profile`。
//!
//! - `client_id` 由上层注入（默认值与环境变量覆盖的取舍归上层）。
//! - 各端点 URL 通过 [`MsaEndpoints`] 可注入，便于本地 mock 测试；默认指向微软生产地址。
//! - XSTS 六个错误码逐一映射为带中文说明的错误变体（见 [`map_xerr`]）。
//! - 令牌刷新失败区分“需重登”（[`AuthError::ReloginRequired`]，`invalid_grant`）与瞬时网络失败
//!   （[`AuthError::Http`]，交由 `retry_async` 重试）。
//! - 挂上取消令牌（[`MicrosoftAuth::with_cancel`]）后，设备码请求、轮询与令牌链任一步都会在令牌
//!   触发时立刻以 [`AuthError::Cancelled`] 返回；设备码有效期长达十几分钟，用户关掉登录弹窗时
//!   不能让后台继续轮询到过期。

use std::time::{Duration, Instant};

use aurora_base::retry::{RetryPolicy, retry_async};
use reqwest::StatusCode;
use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio_util::sync::CancellationToken;

use crate::account::{GameProfile, SkinModel, SkinRef};
use crate::error::{AuthError, Result};

/// 设备码流请求的 OAuth scope。
const SCOPE: &str = "XboxLive.signin offline_access";
/// 设备码授权的 grant_type。
const DEVICE_CODE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";
/// 轮询间隔下限。服务端给 0 时若照办，循环会退化成不停打令牌端点的紧循环。
const MIN_POLL_INTERVAL: Duration = Duration::from_secs(1);

/// 微软登录链各端点地址。默认指向生产环境；测试可整体替换为本地 mock 服务。
#[derive(Debug, Clone)]
pub struct MsaEndpoints {
    /// OAuth 基址，其下拼接 `/devicecode` 与 `/token`。
    pub oauth_base: String,
    /// Xbox Live 用户认证端点（完整 URL）。
    pub xbl_authenticate: String,
    /// XSTS 授权端点（完整 URL）。
    pub xsts_authorize: String,
    /// Minecraft 服务基址，其下拼接 `/authentication/login_with_xbox` 与 `/minecraft/profile`。
    pub minecraft_base: String,
}

impl Default for MsaEndpoints {
    fn default() -> Self {
        Self {
            oauth_base: "https://login.microsoftonline.com/consumers/oauth2/v2.0".into(),
            xbl_authenticate: "https://user.auth.xboxlive.com/user/authenticate".into(),
            xsts_authorize: "https://xsts.auth.xboxlive.com/xsts/authorize".into(),
            minecraft_base: "https://api.minecraftservices.com".into(),
        }
    }
}

/// 微软登录客户端：持有 HTTP 客户端、注入的 `client_id`、端点表与重试策略。
pub struct MicrosoftAuth {
    client: reqwest::Client,
    client_id: String,
    endpoints: MsaEndpoints,
    retry: RetryPolicy,
    cancel: Option<CancellationToken>,
}

/// 设备码请求响应（供 UI 展示 user_code / 验证网址）。
#[derive(Debug, Clone, serde::Deserialize)]
pub struct DeviceCodeResponse {
    /// 后台轮询用的设备码（不展示给用户）。
    pub device_code: String,
    /// 展示给用户在验证网页输入的短码。
    pub user_code: String,
    /// 用户需打开的验证网址。
    pub verification_uri: String,
    /// 设备码有效期（秒）。
    pub expires_in: u64,
    /// 轮询间隔（秒）。
    pub interval: u64,
    /// 面向用户的完整提示文案。
    #[serde(default)]
    pub message: String,
}

/// 微软 OAuth 令牌（access + 轮换后的 refresh）。
#[derive(Debug, Clone)]
pub struct MsaToken {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: u64,
}

/// 完成整条令牌链后得到的会话：游戏档案 + Minecraft 短期令牌 + 轮换后的 refresh token。
#[derive(Debug, Clone)]
pub struct MicrosoftSession {
    pub profile: GameProfile,
    pub minecraft_token: String,
    /// Minecraft 令牌到期的 Unix 秒。
    pub minecraft_expires_at: u64,
    /// 轮换后的 refresh token（须回写覆盖旧值）。
    pub refresh_token: String,
    /// 档案里当前启用的皮肤；档案没有可识别的启用皮肤时为 None。
    pub skin: Option<SkinRef>,
    /// XSTS 声明里的 Xbox 用户 id（`xid`）；响应没带时为 None。
    pub xuid: Option<String>,
}

/// 单次轮询设备码令牌的结果。
enum PollOutcome {
    /// 用户已授权，拿到令牌。
    Token(MsaToken),
    /// 用户尚未完成授权，按 interval 继续等待。
    Pending,
    /// 服务端要求放缓轮询频率。
    SlowDown,
}

impl MicrosoftAuth {
    /// 用注入的 `client_id` 构造（端点与重试取默认）。
    pub fn new(client: reqwest::Client, client_id: impl Into<String>) -> Self {
        Self {
            client,
            client_id: client_id.into(),
            endpoints: MsaEndpoints::default(),
            retry: RetryPolicy::default(),
            cancel: None,
        }
    }

    /// 挂上取消令牌：之后的每个联网步骤都会在令牌触发时立刻以 [`AuthError::Cancelled`] 返回。
    pub fn with_cancel(mut self, token: CancellationToken) -> Self {
        self.cancel = Some(token);
        self
    }

    /// 覆盖端点表（测试注入 mock 地址）。
    pub fn with_endpoints(mut self, endpoints: MsaEndpoints) -> Self {
        self.endpoints = endpoints;
        self
    }

    /// 覆盖重试策略（测试可关重试以求确定与快速）。
    pub fn with_retry(mut self, retry: RetryPolicy) -> Self {
        self.retry = retry;
        self
    }

    /// 在取消令牌之下运行一步：令牌触发时丢弃这一步的 future 并报取消。
    ///
    /// 被丢弃的只有 HTTP 请求与计时等待，它们没有落盘副作用，半途丢弃是安全的。
    async fn cancellable<T>(&self, step: impl Future<Output = Result<T>>) -> Result<T> {
        match &self.cancel {
            None => step.await,
            Some(token) => match token.run_until_cancelled(step).await {
                Some(result) => result,
                None => Err(AuthError::Cancelled),
            },
        }
    }

    /// 发起设备码请求（第一步，返回 user_code 等供 UI 展示）。
    pub async fn begin_device_code(&self) -> Result<DeviceCodeResponse> {
        self.cancellable(self.begin_device_code_inner()).await
    }

    async fn begin_device_code_inner(&self) -> Result<DeviceCodeResponse> {
        let url = format!("{}/devicecode", self.endpoints.oauth_base);
        let params = [("client_id", self.client_id.as_str()), ("scope", SCOPE)];
        retry_async(&self.retry, || async {
            let (status, text) = self.send_form(&url, &params, "请求设备码").await?;
            if !status.is_success() {
                let err: OAuthErrorBody = parse(&text, "请求设备码")?;
                return Err(AuthError::OAuth {
                    error: err.error,
                    description: err.error_description,
                });
            }
            parse::<DeviceCodeResponse>(&text, "请求设备码")
        })
        .await
    }

    /// 轮询令牌端点直至用户完成授权、拒绝、设备码过期或被取消。
    ///
    /// 循环自身按 `interval` 计时（下限 [`MIN_POLL_INTERVAL`]）；仅瞬时网络故障交由 `retry_async`
    /// 重试，`authorization_pending` 属正常等待（非错误），不触发退避。
    pub async fn poll_device_code(&self, device: &DeviceCodeResponse) -> Result<MsaToken> {
        self.cancellable(self.poll_device_code_inner(device)).await
    }

    async fn poll_device_code_inner(&self, device: &DeviceCodeResponse) -> Result<MsaToken> {
        let deadline = Instant::now() + Duration::from_secs(device.expires_in);
        let mut interval = Duration::from_secs(device.interval).max(MIN_POLL_INTERVAL);
        loop {
            if Instant::now() >= deadline {
                return Err(AuthError::DeviceCodeExpired);
            }
            match retry_async(&self.retry, || self.poll_once(&device.device_code)).await? {
                PollOutcome::Token(token) => return Ok(token),
                PollOutcome::Pending => tokio::time::sleep(interval).await,
                PollOutcome::SlowDown => {
                    // 规范要求收到 slow_down 后将间隔增加 5 秒。
                    interval = interval.saturating_add(Duration::from_secs(5));
                    tokio::time::sleep(interval).await;
                }
            }
        }
    }

    async fn poll_once(&self, device_code: &str) -> Result<PollOutcome> {
        let url = format!("{}/token", self.endpoints.oauth_base);
        let params = [
            ("client_id", self.client_id.as_str()),
            ("device_code", device_code),
            ("grant_type", DEVICE_CODE_GRANT),
        ];
        let (status, text) = self.send_form(&url, &params, "轮询设备码令牌").await?;
        if status.is_success() {
            let body: MsaTokenBody = parse(&text, "轮询设备码令牌")?;
            return Ok(PollOutcome::Token(body.into()));
        }
        let err: OAuthErrorBody = parse(&text, "轮询设备码令牌")?;
        match err.error.as_str() {
            "authorization_pending" => Ok(PollOutcome::Pending),
            "slow_down" => Ok(PollOutcome::SlowDown),
            "authorization_declined" => Err(AuthError::AuthorizationDeclined),
            "expired_token" => Err(AuthError::DeviceCodeExpired),
            _ => Err(AuthError::OAuth {
                error: err.error,
                description: err.error_description,
            }),
        }
    }

    /// 用 refresh token 换取新令牌（轮换）。`invalid_grant` 判定为需重登。
    pub async fn refresh(&self, refresh_token: &str) -> Result<MsaToken> {
        self.cancellable(self.refresh_inner(refresh_token)).await
    }

    async fn refresh_inner(&self, refresh_token: &str) -> Result<MsaToken> {
        let url = format!("{}/token", self.endpoints.oauth_base);
        let params = [
            ("client_id", self.client_id.as_str()),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
            ("scope", SCOPE),
        ];
        retry_async(&self.retry, || async {
            let (status, text) = self.send_form(&url, &params, "刷新令牌").await?;
            if status.is_success() {
                let body: MsaTokenBody = parse(&text, "刷新令牌")?;
                return Ok(body.into());
            }
            let err: OAuthErrorBody = parse(&text, "刷新令牌")?;
            if err.error == "invalid_grant" {
                // refresh token 已失效/被撤销：必须重新走完整登录，区别于可重试的网络失败。
                return Err(AuthError::ReloginRequired);
            }
            Err(AuthError::OAuth {
                error: err.error,
                description: err.error_description,
            })
        })
        .await
    }

    /// 从微软 OAuth 令牌走完 XBL/XSTS/Minecraft/profile，得到完整会话。
    pub async fn complete_login(&self, msa: &MsaToken) -> Result<MicrosoftSession> {
        self.cancellable(self.complete_login_inner(msa)).await
    }

    async fn complete_login_inner(&self, msa: &MsaToken) -> Result<MicrosoftSession> {
        let xbl = retry_async(&self.retry, || self.xbl_authenticate(&msa.access_token)).await?;
        let xsts = retry_async(&self.retry, || self.xsts_authorize(&xbl.token)).await?;
        let minecraft =
            retry_async(&self.retry, || self.login_with_xbox(&xsts.uhs, &xsts.token)).await?;
        let (profile, skin) =
            retry_async(&self.retry, || self.fetch_profile(&minecraft.access_token)).await?;
        Ok(MicrosoftSession {
            profile,
            minecraft_expires_at: now_unix().saturating_add(minecraft.expires_in),
            minecraft_token: minecraft.access_token,
            refresh_token: msa.refresh_token.clone(),
            skin,
            xuid: xsts.xid,
        })
    }

    /// 刷新令牌并走完令牌链，得到可直接启动的会话（含轮换后的 refresh token）。
    pub async fn refresh_session(&self, refresh_token: &str) -> Result<MicrosoftSession> {
        self.cancellable(async {
            let msa = self.refresh_inner(refresh_token).await?;
            self.complete_login_inner(&msa).await
        })
        .await
    }

    async fn xbl_authenticate(&self, msa_access_token: &str) -> Result<XblToken> {
        let body = XblRequest {
            properties: XblProperties {
                auth_method: "RPS".into(),
                site_name: "user.auth.xboxlive.com".into(),
                rps_ticket: format!("d={msa_access_token}"),
            },
            relying_party: "http://auth.xboxlive.com".into(),
            token_type: "JWT".into(),
        };
        let (status, text) = self
            .send_json(&self.endpoints.xbl_authenticate, &body, "XBL 认证")
            .await?;
        if !status.is_success() {
            return Err(AuthError::Response {
                context: "XBL 认证",
                detail: format!("HTTP {status}"),
            });
        }
        // XBL 响应也含 uhs，但权威 uhs 取自后续 XSTS 响应，这里只需 token。
        let parsed: XboxAuthResponse = parse(&text, "XBL 认证")?;
        Ok(XblToken {
            token: parsed.token,
        })
    }

    async fn xsts_authorize(&self, xbl_token: &str) -> Result<XstsToken> {
        let body = XstsRequest {
            properties: XstsProperties {
                sandbox_id: "RETAIL".into(),
                user_tokens: vec![xbl_token.to_owned()],
            },
            relying_party: "rp://api.minecraftservices.com/".into(),
            token_type: "JWT".into(),
        };
        let (status, text) = self
            .send_json(&self.endpoints.xsts_authorize, &body, "XSTS 授权")
            .await?;
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            let err: XstsErrorBody = parse(&text, "XSTS 授权")?;
            return Err(map_xerr(err.xerr));
        }
        if !status.is_success() {
            return Err(AuthError::Response {
                context: "XSTS 授权",
                detail: format!("HTTP {status}"),
            });
        }
        let parsed: XboxAuthResponse = parse(&text, "XSTS 授权")?;
        let uhs = parsed.first_uhs("XSTS 授权")?;
        let xid = parsed
            .display_claims
            .xui
            .first()
            .and_then(|x| x.xid.clone());
        Ok(XstsToken {
            token: parsed.token,
            uhs,
            xid,
        })
    }

    async fn login_with_xbox(&self, uhs: &str, xsts_token: &str) -> Result<MinecraftToken> {
        let url = format!("{}/authentication/login_with_xbox", self.endpoints.minecraft_base);
        let body = LoginWithXboxRequest {
            identity_token: format!("XBL3.0 x={uhs};{xsts_token}"),
        };
        let (status, text) = self.send_json(&url, &body, "Minecraft 登录").await?;
        if !status.is_success() {
            return Err(AuthError::Response {
                context: "Minecraft 登录",
                detail: format!("HTTP {status}"),
            });
        }
        let body: MinecraftTokenBody = parse(&text, "Minecraft 登录")?;
        Ok(MinecraftToken {
            access_token: body.access_token,
            expires_in: body.expires_in,
        })
    }

    async fn fetch_profile(&self, minecraft_token: &str) -> Result<(GameProfile, Option<SkinRef>)> {
        let url = format!("{}/minecraft/profile", self.endpoints.minecraft_base);
        let resp = self
            .client
            .get(url)
            .bearer_auth(minecraft_token)
            .send()
            .await
            .map_err(|source| AuthError::Http {
                context: "获取游戏档案",
                source,
            })?;
        let status = resp.status();
        // 无档案：账户未拥有 Minecraft（未购买或未创建档案）。
        if status == StatusCode::NOT_FOUND {
            return Err(AuthError::MinecraftProfileNotFound);
        }
        let text = resp.text().await.map_err(|source| AuthError::Http {
            context: "获取游戏档案",
            source,
        })?;
        if !status.is_success() {
            return Err(AuthError::Response {
                context: "获取游戏档案",
                detail: format!("HTTP {status}"),
            });
        }
        let body: ProfileBody = parse(&text, "获取游戏档案")?;
        let skin = active_skin(&body.skins);
        Ok((
            GameProfile {
                id: body.id,
                name: body.name,
            },
            skin,
        ))
    }

    async fn send_form(
        &self,
        url: &str,
        params: &[(&str, &str)],
        context: &'static str,
    ) -> Result<(StatusCode, String)> {
        let resp = self
            .client
            .post(url)
            .form(params)
            .send()
            .await
            .map_err(|source| AuthError::Http { context, source })?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|source| AuthError::Http { context, source })?;
        Ok((status, text))
    }

    async fn send_json<B: Serialize>(
        &self,
        url: &str,
        body: &B,
        context: &'static str,
    ) -> Result<(StatusCode, String)> {
        let resp = self
            .client
            .post(url)
            .json(body)
            .send()
            .await
            .map_err(|source| AuthError::Http { context, source })?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|source| AuthError::Http { context, source })?;
        Ok((status, text))
    }
}

/// 把 XSTS 的 XErr 错误码映射为带中文说明的错误变体。
fn map_xerr(xerr: i64) -> AuthError {
    match xerr {
        2148916227 => AuthError::XstsBanned,
        2148916233 => AuthError::XstsNoXboxAccount,
        2148916235 => AuthError::XstsRegionUnavailable,
        2148916236 | 2148916237 => AuthError::XstsAdultVerificationRequired(xerr),
        2148916238 => AuthError::XstsChildAccount,
        other => AuthError::XstsUnknown(other),
    }
}

/// 从档案皮肤列表里取当前启用（`state == "ACTIVE"`）的一张。
///
/// 模型名只认 `CLASSIC` 与 `SLIM`；认不出的模型按「没有可用皮肤」处理并记 warn，
/// 界面随之回落，而不是猜一个体型画错。
fn active_skin(skins: &[SkinBody]) -> Option<SkinRef> {
    let active = skins.iter().find(|s| s.state == "ACTIVE")?;
    let model = match active.variant.as_deref() {
        Some(v) if v.eq_ignore_ascii_case("CLASSIC") => SkinModel::Wide,
        Some(v) if v.eq_ignore_ascii_case("SLIM") => SkinModel::Slim,
        other => {
            tracing::warn!(variant = ?other, url = %active.url, "档案皮肤的模型名无法识别，不使用这张皮肤");
            return None;
        }
    };
    Some(SkinRef {
        url: active.url.clone(),
        model,
    })
}

/// 当前 Unix 秒。
fn now_unix() -> u64 {
    // duration_since 仅在系统时钟早于 1970 时出错（不可能场景）；退化为 0 会使令牌被视为已过期，
    // 触发一次无害的刷新，属安全兜底而非掩盖业务错误。
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn parse<T: DeserializeOwned>(text: &str, context: &'static str) -> Result<T> {
    serde_json::from_str(text).map_err(|source| AuthError::Parse { context, source })
}

// --- 令牌链中间产物 ---

struct XblToken {
    token: String,
}

struct XstsToken {
    token: String,
    uhs: String,
    xid: Option<String>,
}

struct MinecraftToken {
    access_token: String,
    expires_in: u64,
}

// --- 请求/响应 serde 结构（字段只保留实际读取的部分，未知字段默认忽略）---

#[derive(Serialize)]
#[serde(rename_all = "PascalCase")]
struct XblRequest {
    properties: XblProperties,
    relying_party: String,
    token_type: String,
}

#[derive(Serialize)]
#[serde(rename_all = "PascalCase")]
struct XblProperties {
    auth_method: String,
    site_name: String,
    rps_ticket: String,
}

#[derive(Serialize)]
#[serde(rename_all = "PascalCase")]
struct XstsRequest {
    properties: XstsProperties,
    relying_party: String,
    token_type: String,
}

#[derive(Serialize)]
#[serde(rename_all = "PascalCase")]
struct XstsProperties {
    sandbox_id: String,
    user_tokens: Vec<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "PascalCase")]
struct XboxAuthResponse {
    token: String,
    display_claims: DisplayClaims,
}

impl XboxAuthResponse {
    fn first_uhs(&self, context: &'static str) -> Result<String> {
        self.display_claims
            .xui
            .first()
            .map(|x| x.uhs.clone())
            .ok_or(AuthError::Response {
                context,
                detail: "响应缺少 uhs 声明".into(),
            })
    }
}

#[derive(serde::Deserialize)]
struct DisplayClaims {
    xui: Vec<Xui>,
}

#[derive(serde::Deserialize)]
struct Xui {
    uhs: String,
    #[serde(default)]
    xid: Option<String>,
}

#[derive(serde::Deserialize)]
struct XstsErrorBody {
    #[serde(rename = "XErr")]
    xerr: i64,
}

#[derive(Serialize)]
struct LoginWithXboxRequest {
    #[serde(rename = "identityToken")]
    identity_token: String,
}

#[derive(serde::Deserialize)]
struct MinecraftTokenBody {
    access_token: String,
    expires_in: u64,
}

#[derive(serde::Deserialize)]
struct ProfileBody {
    id: String,
    name: String,
    #[serde(default)]
    skins: Vec<SkinBody>,
}

#[derive(serde::Deserialize)]
struct SkinBody {
    state: String,
    url: String,
    #[serde(default)]
    variant: Option<String>,
}

#[derive(serde::Deserialize)]
struct MsaTokenBody {
    access_token: String,
    refresh_token: String,
    expires_in: u64,
}

impl From<MsaTokenBody> for MsaToken {
    fn from(body: MsaTokenBody) -> Self {
        Self {
            access_token: body.access_token,
            refresh_token: body.refresh_token,
            expires_in: body.expires_in,
        }
    }
}

#[derive(serde::Deserialize)]
struct OAuthErrorBody {
    error: String,
    #[serde(default)]
    error_description: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use aurora_base::retry::RetryableError;
    use serde_json::json;
    use wiremock::matchers::{body_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn no_retry() -> RetryPolicy {
        RetryPolicy {
            max_attempts: 1,
            initial_delay: Duration::from_millis(1),
            max_delay: Duration::from_millis(1),
            multiplier: 1.0,
            jitter: false,
        }
    }

    fn auth_for(server: &MockServer) -> MicrosoftAuth {
        let client = aurora_base::http::build_client().expect("构建客户端");
        let endpoints = MsaEndpoints {
            oauth_base: server.uri(),
            xbl_authenticate: format!("{}/xbl", server.uri()),
            xsts_authorize: format!("{}/xsts", server.uri()),
            minecraft_base: server.uri(),
        };
        MicrosoftAuth::new(client, "test-client-id")
            .with_endpoints(endpoints)
            .with_retry(no_retry())
    }

    fn device(expires_in: u64, interval: u64) -> DeviceCodeResponse {
        DeviceCodeResponse {
            device_code: "DEV-CODE".into(),
            user_code: "ABCD-1234".into(),
            verification_uri: "https://microsoft.com/link".into(),
            expires_in,
            interval,
            message: String::new(),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn begin_device_code_parses_fields() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/devicecode"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "device_code": "DEV-CODE",
                "user_code": "WXYZ-9999",
                "verification_uri": "https://microsoft.com/link",
                "expires_in": 900,
                "interval": 5,
                "message": "去网页输入 WXYZ-9999"
            })))
            .mount(&server)
            .await;

        let dc = auth_for(&server).begin_device_code().await.unwrap();
        assert_eq!(dc.user_code, "WXYZ-9999");
        assert_eq!(dc.interval, 5);
        assert_eq!(dc.expires_in, 900);
        assert!(dc.message.contains("WXYZ-9999"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn poll_returns_token_after_pending() {
        let server = MockServer::start().await;
        // wiremock 按挂载顺序取第一个仍能匹配的 mock：限一次的 pending 先挂，成功响应后挂作兜底，
        // 于是第一次轮询得 pending、第二次得令牌。
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(400).set_body_json(json!({
                "error": "authorization_pending",
                "error_description": "等待用户授权"
            })))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "access_token": "AT",
                "refresh_token": "RT",
                "expires_in": 3600
            })))
            .mount(&server)
            .await;

        // interval=0：间隔按下限 1 s 计，pending 之后至少等满 1 s 才发第二次轮询，
        // 不会退化成紧循环。删掉下限，这里的耗时断言即挂。
        let started = Instant::now();
        let token = auth_for(&server)
            .poll_device_code(&device(900, 0))
            .await
            .unwrap();
        assert!(
            started.elapsed() >= MIN_POLL_INTERVAL,
            "两次轮询之间只隔了 {:?}",
            started.elapsed()
        );
        assert_eq!(token.access_token, "AT");
        assert_eq!(token.refresh_token, "RT");
        assert_eq!(token.expires_in, 3600);
        assert_eq!(server.received_requests().await.unwrap().len(), 2);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancel_during_polling_returns_cancelled_promptly() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(400).set_body_json(json!({
                "error": "authorization_pending",
                "error_description": "等待用户授权"
            })))
            .mount(&server)
            .await;

        let token = CancellationToken::new();
        let auth = auth_for(&server).with_cancel(token.clone());
        let trigger = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            trigger.cancel();
        });

        // 间隔 5 s：若取消没有打断等待，至少要 5 s 才会返回。
        let started = Instant::now();
        let err = auth.poll_device_code(&device(900, 5)).await.unwrap_err();
        assert!(matches!(err, AuthError::Cancelled), "得到 {err:?}");
        assert!(
            started.elapsed() < Duration::from_millis(1000),
            "取消后过了 {:?} 才返回",
            started.elapsed()
        );

        // 已取消的令牌：后续任何一步都不再发请求。
        let before = server.received_requests().await.unwrap().len();
        let err = auth.begin_device_code().await.unwrap_err();
        assert!(matches!(err, AuthError::Cancelled));
        assert_eq!(server.received_requests().await.unwrap().len(), before);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn poll_maps_declined_and_expired() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(400).set_body_json(json!({
                "error": "authorization_declined",
                "error_description": "用户拒绝"
            })))
            .mount(&server)
            .await;
        let err = auth_for(&server)
            .poll_device_code(&device(900, 0))
            .await
            .unwrap_err();
        assert!(matches!(err, AuthError::AuthorizationDeclined));

        let server2 = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(400).set_body_json(json!({
                "error": "expired_token",
                "error_description": "设备码过期"
            })))
            .mount(&server2)
            .await;
        let err = auth_for(&server2)
            .poll_device_code(&device(900, 0))
            .await
            .unwrap_err();
        assert!(matches!(err, AuthError::DeviceCodeExpired));
    }

    /// 挂上 XBL/XSTS/login/profile 四段 mock；login 用 body_json 断言 identityToken 由
    /// XSTS 的 uhs + token 正确拼装，从而验证整条链的字段传递。
    async fn mount_full_chain(server: &MockServer, uhs: &str, xsts_token: &str) {
        Mock::given(method("POST"))
            .and(path("/xbl"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "Token": "xbl-token",
                "DisplayClaims": { "xui": [ { "uhs": uhs } ] }
            })))
            .mount(server)
            .await;
        Mock::given(method("POST"))
            .and(path("/xsts"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "Token": xsts_token,
                "DisplayClaims": { "xui": [ { "uhs": uhs } ] }
            })))
            .mount(server)
            .await;
        Mock::given(method("POST"))
            .and(path("/authentication/login_with_xbox"))
            .and(body_json(json!({
                "identityToken": format!("XBL3.0 x={uhs};{xsts_token}")
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "access_token": "MC-TOKEN",
                "expires_in": 86400
            })))
            .mount(server)
            .await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn complete_login_walks_full_chain() {
        let server = MockServer::start().await;
        mount_full_chain(&server, "theuserhash", "xsts-tok").await;
        Mock::given(method("GET"))
            .and(path("/minecraft/profile"))
            .and(header("authorization", "Bearer MC-TOKEN"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "0123456789abcdef0123456789abcdef",
                "name": "AuroraPlayer",
                "skins": [
                    { "id": "old", "state": "INACTIVE", "url": "http://textures.minecraft.net/texture/old", "variant": "CLASSIC" },
                    { "id": "new", "state": "ACTIVE", "url": "http://textures.minecraft.net/texture/new", "variant": "SLIM" }
                ],
                "capes": []
            })))
            .mount(&server)
            .await;

        let msa = MsaToken {
            access_token: "msa-access".into(),
            refresh_token: "rotated-refresh".into(),
            expires_in: 3600,
        };
        let session = auth_for(&server).complete_login(&msa).await.unwrap();
        assert_eq!(session.profile.id, "0123456789abcdef0123456789abcdef");
        assert_eq!(session.profile.name, "AuroraPlayer");
        assert_eq!(session.minecraft_token, "MC-TOKEN");
        assert_eq!(session.refresh_token, "rotated-refresh");
        // 到期时间应落在未来（now + 86400 附近）。
        assert!(session.minecraft_expires_at >= now_unix() + 86000);
        // 只取启用中的那张皮肤，模型 SLIM 映射为细臂。
        assert_eq!(
            session.skin,
            Some(SkinRef {
                url: "http://textures.minecraft.net/texture/new".into(),
                model: SkinModel::Slim,
            })
        );
        // 这个 XSTS 响应没有 xid：xuid 如实为 None，而不是空串。
        assert_eq!(session.xuid, None);
    }

    #[test]
    fn active_skin_maps_models_and_rejects_unknown_variants() {
        let skin = |state: &str, variant: Option<&str>| SkinBody {
            state: state.into(),
            url: format!("http://t/{state}"),
            variant: variant.map(Into::into),
        };
        assert_eq!(
            active_skin(&[skin("ACTIVE", Some("CLASSIC"))])
                .unwrap()
                .model,
            SkinModel::Wide
        );
        assert_eq!(
            active_skin(&[skin("ACTIVE", Some("slim"))]).unwrap().model,
            SkinModel::Slim
        );
        assert_eq!(active_skin(&[skin("INACTIVE", Some("SLIM"))]), None);
        assert_eq!(active_skin(&[skin("ACTIVE", Some("GIANT"))]), None);
        assert_eq!(active_skin(&[skin("ACTIVE", None)]), None);
        assert_eq!(active_skin(&[]), None);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn xsts_xid_is_carried_into_the_session() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/xbl"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "Token": "xbl-token",
                "DisplayClaims": { "xui": [ { "uhs": "uhs" } ] }
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/xsts"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "Token": "xsts-tok",
                "DisplayClaims": { "xui": [ { "uhs": "uhs", "xid": "2535400000000001" } ] }
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/authentication/login_with_xbox"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "access_token": "MC-TOKEN",
                "expires_in": 86400
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/minecraft/profile"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "0123456789abcdef0123456789abcdef",
                "name": "AuroraPlayer"
            })))
            .mount(&server)
            .await;

        let msa = MsaToken {
            access_token: "a".into(),
            refresh_token: "r".into(),
            expires_in: 3600,
        };
        let session = auth_for(&server).complete_login(&msa).await.unwrap();
        assert_eq!(session.xuid.as_deref(), Some("2535400000000001"));
        // 档案没有 skins 字段：没有皮肤，不报错。
        assert_eq!(session.skin, None);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn xsts_error_codes_map_to_variants() {
        for (code, want_child) in [(2148916233_i64, false), (2148916238_i64, true)] {
            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .and(path("/xbl"))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                    "Token": "xbl-token",
                    "DisplayClaims": { "xui": [ { "uhs": "uhs" } ] }
                })))
                .mount(&server)
                .await;
            Mock::given(method("POST"))
                .and(path("/xsts"))
                .respond_with(ResponseTemplate::new(401).set_body_json(json!({
                    "Identity": "0",
                    "XErr": code,
                    "Message": ""
                })))
                .mount(&server)
                .await;

            let msa = MsaToken {
                access_token: "a".into(),
                refresh_token: "r".into(),
                expires_in: 3600,
            };
            let err = auth_for(&server).complete_login(&msa).await.unwrap_err();
            if want_child {
                assert!(matches!(err, AuthError::XstsChildAccount));
            } else {
                assert!(matches!(err, AuthError::XstsNoXboxAccount));
            }
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn missing_minecraft_profile_maps_to_not_found() {
        let server = MockServer::start().await;
        mount_full_chain(&server, "uhs", "xsts-tok").await;
        Mock::given(method("GET"))
            .and(path("/minecraft/profile"))
            .respond_with(ResponseTemplate::new(404).set_body_json(json!({
                "path": "/minecraft/profile",
                "error": "NOT_FOUND"
            })))
            .mount(&server)
            .await;

        let msa = MsaToken {
            access_token: "a".into(),
            refresh_token: "r".into(),
            expires_in: 3600,
        };
        let err = auth_for(&server).complete_login(&msa).await.unwrap_err();
        assert!(matches!(err, AuthError::MinecraftProfileNotFound));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn refresh_rotates_token() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "access_token": "new-access",
                "refresh_token": "new-refresh",
                "expires_in": 3600
            })))
            .mount(&server)
            .await;

        let token = auth_for(&server).refresh("old-refresh").await.unwrap();
        assert_eq!(token.access_token, "new-access");
        assert_eq!(token.refresh_token, "new-refresh");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn refresh_invalid_grant_requires_relogin() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(400).set_body_json(json!({
                "error": "invalid_grant",
                "error_description": "refresh token 已失效"
            })))
            .mount(&server)
            .await;

        let err = auth_for(&server).refresh("dead-refresh").await.unwrap_err();
        // 需重登，而非网络失败：明确区分。
        assert!(matches!(err, AuthError::ReloginRequired));
        assert!(!err.is_retryable());
    }

    #[test]
    fn xerr_table_covers_all_six_codes() {
        assert!(matches!(map_xerr(2148916227), AuthError::XstsBanned));
        assert!(matches!(map_xerr(2148916233), AuthError::XstsNoXboxAccount));
        assert!(matches!(
            map_xerr(2148916235),
            AuthError::XstsRegionUnavailable
        ));
        assert!(matches!(
            map_xerr(2148916236),
            AuthError::XstsAdultVerificationRequired(2148916236)
        ));
        assert!(matches!(
            map_xerr(2148916237),
            AuthError::XstsAdultVerificationRequired(2148916237)
        ));
        assert!(matches!(map_xerr(2148916238), AuthError::XstsChildAccount));
        assert!(matches!(map_xerr(1), AuthError::XstsUnknown(1)));
    }
}
