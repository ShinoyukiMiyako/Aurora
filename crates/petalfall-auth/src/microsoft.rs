//! 微软正版登录链（OAuth2 设备码流）。
//!
//! 令牌链：`devicecode` -> 轮询 `token` -> XBL（user.auth.xboxlive.com）->
//! XSTS（xsts.auth.xboxlive.com，RelyingParty `rp://api.minecraftservices.com/`）->
//! `login_with_xbox`（api.minecraftservices.com）-> `minecraft/profile`。
//!
//! - `client_id` 由上层注入（默认值与环境变量覆盖的取舍归上层）。
//! - 各端点 URL 通过 [`MsaEndpoints`] 可注入，便于本地 mock 测试；默认指向微软生产地址。
//! - XSTS 六个错误码逐一映射为带中文说明的错误变体（见 [`map_xerr`]）。
//! - 令牌刷新失败区分“需重登”（[`AuthError::ReloginRequired`]，见 `REFRESH_NEEDS_RELOGIN`）与瞬时网络失败
//!   （[`AuthError::Http`]，交由 `retry_async` 重试）。
//! - 任一步收到 5xx 或 429 都报 [`AuthError::ServiceUnavailable`]（可重试），且在解析响应体之前判定：
//!   故障页多半是 HTML，先解析只会得到误导性的解析错误，把微软的故障说成启动器的问题。
//!   令牌端点回 `temporarily_unavailable` 时同样报它，不论状态码。
//! - 挂上取消令牌（[`MicrosoftAuth::with_cancel`]）后，设备码请求、轮询与令牌链任一步都会在令牌
//!   触发时立刻以 [`AuthError::Cancelled`] 返回；设备码有效期长达十几分钟，用户关掉登录弹窗时
//!   不能让后台继续轮询到过期。

use std::time::{Duration, Instant};

use petalfall_base::error_with_causes;
use petalfall_base::retry::{RetryPolicy, retry_async, retry_async_notify};
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
/// 刷新时只能靠重新登录补救的 OAuth 错误。微软令牌端点对 `interaction_required`（要补一步验证）
/// 与 `consent_required`（要重新同意）给的处理办法都是把用户送回授权页，refresh token 自己换不出令牌。
const REFRESH_NEEDS_RELOGIN: [&str; 3] =
    ["invalid_grant", "interaction_required", "consent_required"];
/// OAuth 端点表示「服务器暂时太忙」的错误名，官方给的处理办法是稍等后重试。
const OAUTH_TEMPORARILY_UNAVAILABLE: &str = "temporarily_unavailable";

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
            if let Some(err) = service_unavailable(status, "请求设备码") {
                return Err(err);
            }
            if !status.is_success() {
                let err: OAuthErrorBody = parse(&text, "请求设备码")?;
                return Err(err.into_error(status, "请求设备码"));
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
        if let Some(err) = service_unavailable(status, "轮询设备码令牌") {
            return Err(err);
        }
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
            _ => Err(err.into_error(status, "轮询设备码令牌")),
        }
    }

    /// 用 refresh token 换取新令牌（轮换）。`REFRESH_NEEDS_RELOGIN` 里的错误判定为需重登。
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
        self.chain_step("刷新令牌", || async {
            let (status, text) = self.send_form(&url, &params, "刷新令牌").await?;
            // invalid_grant 走的是 400，不会落进这里，仍归「需重登」。
            if let Some(err) = service_unavailable(status, "刷新令牌") {
                return Err(err);
            }
            if status.is_success() {
                let body: MsaTokenBody = parse(&text, "刷新令牌")?;
                return Ok(body.into());
            }
            let err: OAuthErrorBody = parse(&text, "刷新令牌")?;
            if REFRESH_NEEDS_RELOGIN.contains(&err.error.as_str()) {
                // refresh token 已失效/被撤销，或要求用户回授权页补验证：必须重新走完整登录，
                // 区别于可重试的网络失败。
                return Err(AuthError::ReloginRequired);
            }
            Err(err.into_error(status, "刷新令牌"))
        })
        .await
    }

    /// 从微软 OAuth 令牌走完 XBL/XSTS/Minecraft/profile，得到完整会话。
    pub async fn complete_login(&self, msa: &MsaToken) -> Result<MicrosoftSession> {
        self.cancellable(self.complete_login_inner(msa)).await
    }

    async fn complete_login_inner(&self, msa: &MsaToken) -> Result<MicrosoftSession> {
        let xbl = self
            .chain_step("XBL 认证", || self.xbl_authenticate(&msa.access_token))
            .await?;
        let xsts = self
            .chain_step("XSTS 授权", || self.xsts_authorize(&xbl.token))
            .await?;
        let minecraft = self
            .chain_step("Minecraft 登录", || {
                self.login_with_xbox(&xsts.uhs, &xsts.token)
            })
            .await?;
        let (profile, skin) = self
            .chain_step("获取游戏档案", || {
                self.fetch_profile(&minecraft.access_token)
            })
            .await?;
        Ok(MicrosoftSession {
            profile,
            minecraft_expires_at: now_unix().saturating_add(minecraft.expires_in),
            minecraft_token: minecraft.access_token,
            refresh_token: msa.refresh_token.clone(),
            skin,
            xuid: xsts.xid,
        })
    }

    /// 按重试策略跑令牌链的一步：要退避重试的失败记 warn，走完记这一步的用时与尝试次数。
    ///
    /// 令牌链是串行的几次 HTTPS 往返，网络慢时启动开局的几秒都耗在这里，只有逐步的记录才分得清
    /// 是哪一步慢、是慢还是在重试。`retry_async` 自己的重试日志是 debug，下载等处也共用它，不能在那里
    /// 统一提级。要不要重试由重试机制回调告知，这里不另判。日志里只有步骤名、次数、用时与错误说明，不含令牌。
    async fn chain_step<T, Fut>(&self, step: &'static str, mut op: impl FnMut() -> Fut) -> Result<T>
    where
        Fut: Future<Output = Result<T>>,
    {
        let started = Instant::now();
        let mut attempts = 0u32;
        let result = retry_async_notify(
            &self.retry,
            || {
                attempts += 1;
                op()
            },
            |err, notice| {
                tracing::warn!(
                    step,
                    attempt = notice.attempt,
                    max = notice.max,
                    delay_ms = notice.delay.as_millis() as u64,
                    error = %error_with_causes(err),
                    "令牌链这一步失败，退避后重试"
                );
            },
        )
        .await;
        let elapsed_ms = started.elapsed().as_millis() as u64;
        match &result {
            Ok(_) => tracing::info!(step, attempts, elapsed_ms, "令牌链这一步完成"),
            Err(err) => tracing::warn!(
                step,
                attempts,
                elapsed_ms,
                error = %error_with_causes(err),
                "令牌链这一步失败"
            ),
        }
        result
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
        if let Some(err) = service_unavailable(status, "XBL 认证") {
            return Err(err);
        }
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
        if let Some(err) = service_unavailable(status, "XSTS 授权") {
            return Err(err);
        }
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
        let url = format!(
            "{}/authentication/login_with_xbox",
            self.endpoints.minecraft_base
        );
        let body = LoginWithXboxRequest {
            identity_token: format!("XBL3.0 x={uhs};{xsts_token}"),
        };
        let (status, text) = self.send_json(&url, &body, "Minecraft 登录").await?;
        if let Some(err) = service_unavailable(status, "Minecraft 登录") {
            return Err(err);
        }
        // 官方没有公开这个拒绝的响应体结构，只按原文子串认，不依赖 JSON 字段名。
        if status == StatusCode::FORBIDDEN
            && text
                .to_ascii_lowercase()
                .contains("invalid app registration")
        {
            return Err(AuthError::AppNotApproved);
        }
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
        if let Some(err) = service_unavailable(status, "获取游戏档案") {
            return Err(err);
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

/// 5xx 与 429 判为服务端故障。各端点在故障或限流时的响应体没有文档，只能按状态码类别认。
/// Yggdrasil 客户端同样用它：皮肤站故障时回的多半也是 HTML 故障页。
pub(crate) fn service_unavailable(status: StatusCode, step: &'static str) -> Option<AuthError> {
    (status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS).then(|| {
        AuthError::ServiceUnavailable {
            step,
            status: status.as_u16(),
        }
    })
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

impl OAuthErrorBody {
    /// 翻成错误。`temporarily_unavailable` 是令牌端点在说自己太忙，与 5xx 是一回事，只是可能走 4xx，
    /// 只能认错误名；退避用完仍是它时要报服务故障，落成 OAuth 的话续期给不出对应的失败码。
    fn into_error(self, status: StatusCode, step: &'static str) -> AuthError {
        if self.error == OAUTH_TEMPORARILY_UNAVAILABLE {
            return AuthError::ServiceUnavailable {
                step,
                status: status.as_u16(),
            };
        }
        AuthError::OAuth {
            error: self.error,
            description: self.error_description,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use petalfall_base::retry::RetryableError;
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
        let client = petalfall_base::http::build_client().expect("构建客户端");
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
        let interval = Duration::from_secs(5);
        let started = Instant::now();
        let err = auth
            .poll_device_code(&device(900, interval.as_secs()))
            .await
            .unwrap_err();
        assert!(matches!(err, AuthError::Cancelled), "得到 {err:?}");
        assert!(
            started.elapsed() < interval,
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
                "name": "PetalfallPlayer",
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
        assert_eq!(session.profile.name, "PetalfallPlayer");
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
                "name": "PetalfallPlayer"
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

    /// 令牌端点要求用户回到授权页（补一步验证、重新同意）时，refresh token 本身再也换不出令牌，
    /// 补救办法与 invalid_grant 相同：只能重新登录。别的 OAuth 错误不是凭据失效，照旧原样上报。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn refresh_rejections_that_need_user_interaction_require_relogin() {
        for error in ["interaction_required", "consent_required"] {
            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .and(path("/token"))
                .respond_with(ResponseTemplate::new(400).set_body_json(json!({
                    "error": error,
                    "error_description": "AADSTS50076: 需要额外的验证"
                })))
                .mount(&server)
                .await;
            let err = auth_for(&server)
                .refresh("stale-refresh")
                .await
                .unwrap_err();
            assert!(
                matches!(err, AuthError::ReloginRequired),
                "{error} 应判为需重登，得到 {err:?}"
            );
        }

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(400).set_body_json(json!({
                "error": "invalid_scope",
                "error_description": "AADSTS70011"
            })))
            .mount(&server)
            .await;
        let err = auth_for(&server).refresh("r").await.unwrap_err();
        assert!(
            matches!(&err, AuthError::OAuth { error, .. } if error == "invalid_scope"),
            "得到 {err:?}"
        );
    }

    fn three_attempts() -> RetryPolicy {
        RetryPolicy {
            max_attempts: 3,
            initial_delay: Duration::from_millis(1),
            max_delay: Duration::from_millis(1),
            multiplier: 1.0,
            jitter: false,
        }
    }

    fn msa() -> MsaToken {
        MsaToken {
            access_token: "a".into(),
            refresh_token: "r".into(),
            expires_in: 3600,
        }
    }

    async fn hits(server: &MockServer, at: &str) -> usize {
        server
            .received_requests()
            .await
            .unwrap()
            .iter()
            .filter(|r| r.url.path() == at)
            .count()
    }

    async fn mount_xbl_ok(server: &MockServer) {
        Mock::given(method("POST"))
            .and(path("/xbl"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "Token": "xbl-token",
                "DisplayClaims": { "xui": [ { "uhs": "uhs" } ] }
            })))
            .mount(server)
            .await;
    }

    async fn mount_xsts_ok(server: &MockServer) {
        Mock::given(method("POST"))
            .and(path("/xsts"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "Token": "xsts-tok",
                "DisplayClaims": { "xui": [ { "uhs": "uhs" } ] }
            })))
            .mount(server)
            .await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn xsts_outage_is_retried_then_reported_as_service_unavailable() {
        let server = MockServer::start().await;
        mount_xbl_ok(&server).await;
        Mock::given(method("POST"))
            .and(path("/xsts"))
            .respond_with(ResponseTemplate::new(503).set_body_string("Service Unavailable"))
            .mount(&server)
            .await;

        let err = auth_for(&server)
            .with_retry(three_attempts())
            .complete_login(&msa())
            .await
            .unwrap_err();
        assert!(
            matches!(
                err,
                AuthError::ServiceUnavailable {
                    step: "XSTS 授权",
                    status: 503
                }
            ),
            "得到 {err:?}"
        );
        assert!(err.is_retryable());
        // 按退避把三次机会用满；不可重试的话这里只有 1 次。
        assert_eq!(hits(&server, "/xsts").await, 3);
        // XBL 第一次就成功，不应被连带重试。
        assert_eq!(hits(&server, "/xbl").await, 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn refresh_outage_html_page_is_service_unavailable_not_parse() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(
                ResponseTemplate::new(503)
                    .insert_header("content-type", "text/html; charset=utf-8")
                    .set_body_string("<html><body><h1>Service Unavailable</h1></body></html>"),
            )
            .mount(&server)
            .await;

        let err = auth_for(&server).refresh("old-refresh").await.unwrap_err();
        assert!(!matches!(err, AuthError::Parse { .. }), "得到 {err:?}");
        assert!(
            matches!(
                err,
                AuthError::ServiceUnavailable {
                    step: "刷新令牌",
                    status: 503
                }
            ),
            "得到 {err:?}"
        );
    }

    /// 令牌端点忙（`temporarily_unavailable`）是瞬时状况，微软给的处理办法是稍等后重试：
    /// 刷新与设备码轮询都该按退避策略再来一次，而不是把一次服务端抖动报成登录失败。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn temporarily_unavailable_token_endpoint_is_retried() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(503).set_body_json(json!({
                "error": "temporarily_unavailable",
                "error_description": "AADSTS90033: 服务暂时不可用"
            })))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "access_token": "AT", "refresh_token": "RT2", "expires_in": 3600
            })))
            .mount(&server)
            .await;
        let two_attempts = RetryPolicy {
            max_attempts: 2,
            ..no_retry()
        };

        let token = auth_for(&server)
            .with_retry(two_attempts.clone())
            .refresh("r")
            .await
            .unwrap();
        assert_eq!(token.refresh_token, "RT2");

        // 轮询途中撞上一次同样的抖动，登录照常完成。
        server.reset().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(503).set_body_json(json!({
                "error": "temporarily_unavailable",
                "error_description": "AADSTS90033"
            })))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "access_token": "AT", "refresh_token": "RT3", "expires_in": 3600
            })))
            .mount(&server)
            .await;
        let token = auth_for(&server)
            .with_retry(two_attempts)
            .poll_device_code(&device(900, 1))
            .await
            .unwrap();
        assert_eq!(token.refresh_token, "RT3");
        assert_eq!(server.received_requests().await.unwrap().len(), 2);
    }

    /// 503 在解析响应体之前就判成了服务故障；令牌端点用 4xx 回 `temporarily_unavailable` 时认的是错误名，
    /// 同样要按退避再来一次，不能落成一次性的 OAuth 失败。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn busy_token_endpoint_below_5xx_is_retried_by_its_error_name() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(400).set_body_json(json!({
                "error": "temporarily_unavailable",
                "error_description": "AADSTS90033"
            })))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "access_token": "AT", "refresh_token": "RT2", "expires_in": 3600
            })))
            .mount(&server)
            .await;

        let token = auth_for(&server)
            .with_retry(three_attempts())
            .refresh("r")
            .await
            .unwrap();
        assert_eq!(token.refresh_token, "RT2");
        assert_eq!(hits(&server, "/token").await, 2);
    }

    /// 退避用完还在忙就是服务故障：启动续期靠这个错误落成 account_service_down，失败卡才给得出
    /// 「以离线方式进单人」；落成 OAuth 的话账户失败记录里没有它，只剩一句原文。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn token_endpoint_that_stays_busy_is_a_service_outage() {
        let server = MockServer::start().await;
        let busy = ResponseTemplate::new(400).set_body_json(json!({
            "error": "temporarily_unavailable",
            "error_description": "AADSTS90033"
        }));
        for endpoint in ["/token", "/devicecode"] {
            Mock::given(method("POST"))
                .and(path(endpoint))
                .respond_with(busy.clone())
                .mount(&server)
                .await;
        }
        let auth = auth_for(&server).with_retry(three_attempts());

        let refresh = auth.refresh("r").await.unwrap_err();
        assert!(
            matches!(
                refresh,
                AuthError::ServiceUnavailable {
                    step: "刷新令牌",
                    status: 400
                }
            ),
            "得到 {refresh:?}"
        );
        assert_eq!(hits(&server, "/token").await, 3);

        let poll = auth.poll_device_code(&device(900, 1)).await.unwrap_err();
        assert!(
            matches!(
                poll,
                AuthError::ServiceUnavailable {
                    step: "轮询设备码令牌",
                    status: 400
                }
            ),
            "得到 {poll:?}"
        );

        let begin = auth.begin_device_code().await.unwrap_err();
        assert!(
            matches!(
                begin,
                AuthError::ServiceUnavailable {
                    step: "请求设备码",
                    status: 400
                }
            ),
            "得到 {begin:?}"
        );
        assert_eq!(hits(&server, "/devicecode").await, 3);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn device_code_outage_is_service_unavailable() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/devicecode"))
            .respond_with(
                ResponseTemplate::new(502)
                    .insert_header("content-type", "text/html")
                    .set_body_string("<html>Bad Gateway</html>"),
            )
            .mount(&server)
            .await;

        let err = auth_for(&server).begin_device_code().await.unwrap_err();
        assert!(
            matches!(
                err,
                AuthError::ServiceUnavailable {
                    step: "请求设备码",
                    status: 502
                }
            ),
            "得到 {err:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn polling_outage_is_retried_then_reported_not_waited_out() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(
                ResponseTemplate::new(503)
                    .insert_header("content-type", "application/json")
                    .set_body_json(json!({
                        "error": "temporarily_unavailable",
                        "error_description": "AADSTS90033"
                    })),
            )
            .mount(&server)
            .await;

        let err = auth_for(&server)
            .with_retry(three_attempts())
            .poll_device_code(&device(900, 0))
            .await
            .unwrap_err();
        assert!(
            matches!(
                err,
                AuthError::ServiceUnavailable {
                    step: "轮询设备码令牌",
                    status: 503
                }
            ),
            "得到 {err:?}"
        );
        assert_eq!(hits(&server, "/token").await, 3);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn xbl_status_boundaries_split_outage_from_rejection() {
        // 499 与 403 是客户端一侧的拒绝，重试无益，仍按协议错误报；500 与 599 是服务端故障。
        for status in [403_u16, 499, 500, 599] {
            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .and(path("/xbl"))
                .respond_with(ResponseTemplate::new(status).set_body_string("{}"))
                .mount(&server)
                .await;

            let err = auth_for(&server)
                .with_retry(three_attempts())
                .complete_login(&msa())
                .await
                .unwrap_err();
            let attempts = hits(&server, "/xbl").await;
            if status >= 500 {
                assert!(
                    matches!(err, AuthError::ServiceUnavailable { step: "XBL 认证", status: s } if s == status),
                    "HTTP {status} 得到 {err:?}"
                );
                assert_eq!(attempts, 3, "HTTP {status}");
            } else {
                assert!(
                    matches!(&err, AuthError::Response { context: "XBL 认证", detail } if detail.contains(&status.to_string())),
                    "HTTP {status} 得到 {err:?}"
                );
                assert_eq!(attempts, 1, "HTTP {status}");
            }
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn profile_throttling_is_service_unavailable_but_neighbours_are_not() {
        for (status, want_outage) in [(429_u16, true), (428, false), (430, false)] {
            let server = MockServer::start().await;
            mount_full_chain(&server, "uhs", "xsts-tok").await;
            Mock::given(method("GET"))
                .and(path("/minecraft/profile"))
                .respond_with(ResponseTemplate::new(status).set_body_string("Too Many Requests"))
                .mount(&server)
                .await;

            let err = auth_for(&server).complete_login(&msa()).await.unwrap_err();
            if want_outage {
                assert!(
                    matches!(
                        err,
                        AuthError::ServiceUnavailable {
                            step: "获取游戏档案",
                            status: 429
                        }
                    ),
                    "HTTP {status} 得到 {err:?}"
                );
            } else {
                assert!(
                    matches!(
                        err,
                        AuthError::Response {
                            context: "获取游戏档案",
                            ..
                        }
                    ),
                    "HTTP {status} 得到 {err:?}"
                );
            }
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn minecraft_login_server_error_is_service_unavailable() {
        let server = MockServer::start().await;
        mount_xbl_ok(&server).await;
        mount_xsts_ok(&server).await;
        Mock::given(method("POST"))
            .and(path("/authentication/login_with_xbox"))
            .respond_with(ResponseTemplate::new(500).set_body_string("Internal Server Error"))
            .mount(&server)
            .await;

        let err = auth_for(&server).complete_login(&msa()).await.unwrap_err();
        assert!(
            matches!(
                err,
                AuthError::ServiceUnavailable {
                    step: "Minecraft 登录",
                    status: 500
                }
            ),
            "得到 {err:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn invalid_grant_and_missing_profile_keep_their_meaning() {
        // 服务端故障判定不能吞掉这两个确定性结论。
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(400).set_body_json(json!({
                "error": "invalid_grant",
                "error_description": "AADSTS70000"
            })))
            .mount(&server)
            .await;
        let err = auth_for(&server)
            .with_retry(three_attempts())
            .refresh("dead")
            .await
            .unwrap_err();
        assert!(matches!(err, AuthError::ReloginRequired), "得到 {err:?}");
        assert_eq!(hits(&server, "/token").await, 1);

        let server = MockServer::start().await;
        mount_full_chain(&server, "uhs", "xsts-tok").await;
        Mock::given(method("GET"))
            .and(path("/minecraft/profile"))
            .respond_with(ResponseTemplate::new(404).set_body_string("<html>Not Found</html>"))
            .mount(&server)
            .await;
        let err = auth_for(&server).complete_login(&msa()).await.unwrap_err();
        assert!(
            matches!(err, AuthError::MinecraftProfileNotFound),
            "得到 {err:?}"
        );
    }

    /// 挂上 XBL/XSTS 成功，login_with_xbox 按给定状态与响应体回应。
    async fn mount_login_rejection(server: &MockServer, status: u16, body: &str) {
        mount_xbl_ok(server).await;
        mount_xsts_ok(server).await;
        Mock::given(method("POST"))
            .and(path("/authentication/login_with_xbox"))
            .respond_with(ResponseTemplate::new(status).set_body_string(body.to_owned()))
            .mount(server)
            .await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn invalid_app_registration_is_app_not_approved_and_not_retried() {
        let server = MockServer::start().await;
        mount_login_rejection(
            &server,
            403,
            r#"{"path":"/authentication/login_with_xbox","errorMessage":"Invalid app registration, see https://aka.ms/AppRegInfo for more information"}"#,
        )
        .await;

        let err = auth_for(&server)
            .with_retry(three_attempts())
            .complete_login(&msa())
            .await
            .unwrap_err();
        assert!(matches!(err, AuthError::AppNotApproved), "得到 {err:?}");
        assert!(!err.is_retryable());
        assert_eq!(hits(&server, "/authentication/login_with_xbox").await, 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn invalid_app_registration_is_matched_case_insensitively_in_plain_text() {
        let server = MockServer::start().await;
        mount_login_rejection(&server, 403, "Forbidden: INVALID APP REGISTRATION").await;

        let err = auth_for(&server).complete_login(&msa()).await.unwrap_err();
        assert!(matches!(err, AuthError::AppNotApproved), "得到 {err:?}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn other_login_rejections_stay_response_errors() {
        // 403 但不是应用审批问题；400 带同样字样也不算，只有 403 才是这个拒绝。
        for (status, body) in [
            (
                403_u16,
                r#"{"path":"/authentication/login_with_xbox","errorMessage":"Forbidden"}"#,
            ),
            (400, "Invalid app registration"),
        ] {
            let server = MockServer::start().await;
            mount_login_rejection(&server, status, body).await;

            let err = auth_for(&server)
                .with_retry(three_attempts())
                .complete_login(&msa())
                .await
                .unwrap_err();
            assert!(
                matches!(&err, AuthError::Response { context: "Minecraft 登录", detail } if detail.contains(&status.to_string())),
                "HTTP {status} 得到 {err:?}"
            );
            assert_eq!(hits(&server, "/authentication/login_with_xbox").await, 1);
        }
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

    /// 收下当前线程上打出的日志（不带颜色）。用例跑在单线程运行时上，令牌链的日志都出在这条线程。
    #[derive(Clone, Default)]
    struct Captured(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    impl std::io::Write for Captured {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Captured {
        fn install(&self) -> tracing::subscriber::DefaultGuard {
            let writer = self.clone();
            tracing::subscriber::set_default(
                tracing_subscriber::fmt()
                    .with_ansi(false)
                    .with_max_level(tracing::Level::INFO)
                    .with_writer(move || writer.clone())
                    .finish(),
            )
        }

        fn lines_with(&self, needle: &str) -> Vec<String> {
            String::from_utf8(self.0.lock().unwrap().clone())
                .unwrap()
                .lines()
                .filter(|line| line.contains(needle))
                .map(str::to_owned)
                .collect()
        }

        fn text(&self) -> String {
            String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
        }
    }

    const RETRYING: &str = "令牌链这一步失败，退避后重试";
    const STEP_DONE: &str = "令牌链这一步完成";
    const STEP_FAILED: &str = "令牌链这一步失败";

    #[tokio::test]
    async fn chain_steps_log_their_duration_and_warn_before_each_retry() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "access_token": "SECRET-MSA-ACCESS",
                "refresh_token": "SECRET-ROTATED-REFRESH",
                "expires_in": 3600
            })))
            .mount(&server)
            .await;
        // XBL 第一次回 503，第二次才放行。
        Mock::given(method("POST"))
            .and(path("/xbl"))
            .respond_with(ResponseTemplate::new(503).set_body_string("Service Unavailable"))
            .up_to_n_times(1)
            .with_priority(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/xbl"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "Token": "SECRET-XBL-TOKEN",
                "DisplayClaims": { "xui": [ { "uhs": "uhs" } ] }
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/xsts"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "Token": "SECRET-XSTS-TOKEN",
                "DisplayClaims": { "xui": [ { "uhs": "uhs" } ] }
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/authentication/login_with_xbox"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "access_token": "SECRET-MC-TOKEN",
                "expires_in": 86400
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/minecraft/profile"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "0123456789abcdef0123456789abcdef",
                "name": "PetalfallPlayer"
            })))
            .mount(&server)
            .await;
        let auth = auth_for(&server).with_retry(three_attempts());
        let captured = Captured::default();
        let _guard = captured.install();

        let msa = auth.refresh("SECRET-OLD-REFRESH").await.unwrap();
        auth.complete_login(&msa).await.unwrap();

        // 重试前的 warn 只有 XBL 那一次，写明是第几次、最多几次。
        let retries = captured.lines_with(RETRYING);
        assert_eq!(retries.len(), 1, "{retries:?}");
        assert!(retries[0].contains("WARN"), "{}", retries[0]);
        // 认的是 step 字段本身：错误原文里也带着步骤名，只查子串的话删掉 step 字段照样过。
        assert!(retries[0].contains(r#"step="XBL 认证""#), "{}", retries[0]);
        assert!(retries[0].contains("attempt=1"), "{}", retries[0]);
        assert!(retries[0].contains("max=3"), "{}", retries[0]);
        assert!(retries[0].contains("HTTP 503"), "{}", retries[0]);

        // 五步各有一行完成记录，带用时；XBL 那一步试了两次。
        let done = captured.lines_with(STEP_DONE);
        assert_eq!(done.len(), 5, "{done:?}");
        for (line, step) in done.iter().zip([
            "刷新令牌",
            "XBL 认证",
            "XSTS 授权",
            "Minecraft 登录",
            "获取游戏档案",
        ]) {
            assert!(line.contains("INFO"), "{line}");
            assert!(line.contains(&format!("step=\"{step}\"")), "{line}");
            assert!(line.contains("elapsed_ms="), "{line}");
            let attempts = if step == "XBL 认证" { 2 } else { 1 };
            assert!(line.contains(&format!("attempts={attempts}")), "{line}");
        }
        assert!(!captured.text().contains("SECRET-"), "日志里不该出现令牌");
    }

    #[tokio::test]
    async fn step_that_cannot_be_retried_logs_one_failure_and_no_retry() {
        let server = MockServer::start().await;
        mount_xbl_ok(&server).await;
        Mock::given(method("POST"))
            .and(path("/xsts"))
            .respond_with(ResponseTemplate::new(401).set_body_json(json!({
                "Identity": "0",
                "XErr": 2148916233u64,
                "Message": ""
            })))
            .mount(&server)
            .await;
        let auth = auth_for(&server).with_retry(three_attempts());
        let captured = Captured::default();
        let _guard = captured.install();

        let err = auth.complete_login(&msa()).await.unwrap_err();
        assert!(matches!(err, AuthError::XstsNoXboxAccount), "{err:?}");
        assert_eq!(hits(&server, "/xsts").await, 1);
        assert!(captured.lines_with(RETRYING).is_empty());
        let failed: Vec<String> = captured
            .lines_with(STEP_FAILED)
            .into_iter()
            .filter(|line| !line.contains(RETRYING))
            .collect();
        assert_eq!(failed.len(), 1, "{failed:?}");
        assert!(failed[0].contains("WARN"), "{}", failed[0]);
        assert!(failed[0].contains(r#"step="XSTS 授权""#), "{}", failed[0]);
        assert!(failed[0].contains("attempts=1"), "{}", failed[0]);
        assert_eq!(captured.lines_with(STEP_DONE).len(), 1, "XBL 那一步走完了");
    }
}
