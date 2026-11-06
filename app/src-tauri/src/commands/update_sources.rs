//! 更新包的多源下载：从清单扩展字段解析候选源，判定单个源失败后换不换源，汇总全部已试源的失败。
//!
//! 清单本身不签名，扩展字段谁都能改，所以这里只信它给的下载地址候选与大小上限，大小上限还要再压到与清单无关的
//! [`MAX_PACKAGE_SIZE`] 以内：签名与签名版本仍由插件按清单标准字段校验，绝不从扩展字段取，包的完整性全靠这道验签。
//! 真去下载的每个地址都过同一道校验（[`check_source_url`]）：https、主机在白名单里、不带端口与用户信息，github.com
//! 上的还得是本仓库 Releases 的附件。`x-sources` 的每一条如此，清单没给出可用候选时退回的插件选中的标准 `url`
//! 也如此，插件自己只校验清单端点、不校验下载地址，这道校验替它补上。
//! 除 github.com 外只比主机不比路径，白名单主机回的跳转照跟（插件的客户端开了 https_only，只跟到 https 地址），
//! 完整性靠插件验签：白名单只限住清单能把客户端直接
//! 引到哪些主机，字节对不上签名照样被插件拒掉。github.com 上谁都能发附件，只比主机的话，改得了清单就能让客户端
//! 把任意仓库的大文件整份读进内存，所以那里多钉一层仓库路径。
//!
//! 插件和旧客户端都忽略多余的键，扩展字段放在平台条目里不影响它们：旧客户端只认标准的 `url`。

use petalfall_base::http::NetworkFailure;
use petalfall_core::SourceRegion;
use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::Url;
use tauri_plugin_updater::Error as UpdaterError;

use crate::commands::error::{code, source_chain, CommandError};

/// GitHub 的主机。它上面的地址除了主机还要过 [`in_repo_releases`]。
const GITHUB_HOST: &str = "github.com";

/// 候选源允许的主机。编译进客户端：`x-sources` 里写的主机不在这里就不用那一条，退回的插件选中地址不在这里就不下载；
/// CI 生成清单的脚本（`.github/scripts/dev-distribution.mjs`）也按同一张表校验，用例逐一比对两边。
pub(crate) const ALLOWED_SOURCE_HOSTS: [&str; 4] = [
    concat!(
        petalfall_base::app_slug!(),
        "-dl-cn.oss-cn-hangzhou.aliyuncs.com"
    ),
    concat!(
        petalfall_base::app_slug!(),
        "-dl.oss-cn-hongkong.aliyuncs.com"
    ),
    concat!("dl.", petalfall_base::app_slug!(), ".org"),
    GITHUB_HOST,
];

/// 认得的源名与所在地区，先后与 [`ALLOWED_SOURCE_HOSTS`] 一一对应：第几个源名的包就放在第几个主机上。客户端只按
/// 源名定地区、不核对源名与主机配不配对，配对由 CI 生成清单时校验；两边配得不一样，自动档就会把海外的主机当国内的排，
/// 所以用例把这张表连同主机与 CI 的源表逐一比对。
const SOURCE_REGIONS: [(&str, SourceRegion); 4] = [
    ("cn", SourceRegion::Domestic),
    ("hk", SourceRegion::Domestic),
    ("global", SourceRegion::Overseas),
    ("github", SourceRegion::Overseas),
];

/// 清单最多列几个候选源，更靠后的不看。认得的源名只有四个，这个上限只防伪造清单塞进超长的列表。
pub(crate) const MAX_SOURCES: usize = 6;

/// 更新包大小的硬上限，与清单无关。插件把整个包读进内存，清单又不签名：x-size 缺失或写成天文数字时照单全收的话，
/// 改得了清单就能让每次点击下载都读进几个 GiB。现在的包约 22 MB，256 MiB 留足了余量；包真涨到这个量级，这里要与
/// CI、服务器的同一个取值一起调大。
pub(crate) const MAX_PACKAGE_SIZE: u64 = 256 * 1024 * 1024;

/// 平台条目里的候选源列表。
const SOURCES_KEY: &str = "x-sources";

/// 平台条目里的安装包字节数。
const SIZE_KEY: &str = "x-size";

/// 清单没给出可用的候选源时，插件选中的地址就是唯一的源。
const DEFAULT_SOURCE_NAME: &str = "default";

/// 卡死时的原文与第一批单源下载一致，前端照旧按网络超时提示。
const STALLED_MESSAGE: &str = "下载长时间没有进展，已中止";

/// 一个下载源。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PackageSource {
    pub name: String,
    pub url: Url,
    pub region: SourceRegion,
}

/// 这次更新包从哪些源下、最多下多少字节。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PackagePlan {
    pub sources: Vec<PackageSource>,
    /// [`package_plan`] 给出的总有值，不超过 [`MAX_PACKAGE_SIZE`]；留成 `Option` 是因为下载循环的大小上限按
    /// 「可以不设限」写的，这里不再给它不设限的机会。
    pub size: Option<u64>,
}

/// 在 raw_json.platforms 里找 url 与 signature 都等于插件选中值的条目，读 x-sources 与 x-size；
/// 不合法的候选逐条跳过并打 warn。x-sources 整段缺失、不是数组、一条都不剩，或在 platforms 里找不到这个条目时，
/// 退回 [{name:"default", url: chosen_url, region: Domestic}]。大小取 x-size，缺失、不合法或超过
/// [`MAX_PACKAGE_SIZE`] 时按 [`MAX_PACKAGE_SIZE`] 截断并打 warn，找不到条目时同样按它。
///
/// 退回的 chosen_url 与 x-sources 的每一条过同一道 [`check_source_url`]。过不了就一个源都不试，直接返回
/// [`sources_failed`] 汇总的 update_download_failed，detail.sources 是一条
/// `{ source: "default", failure: "other", message }`，message 写明是哪个地址、为什么被拒。
pub(crate) fn package_plan(
    raw_json: &Value,
    chosen_url: &Url,
    signature: &str,
) -> Result<PackagePlan, CommandError> {
    // 按插件选中的地址与签名反查，而不是按平台键：Update.target 只是操作系统名 windows，插件按
    // windows-x86_64-nsis、windows-x86_64 依次查；只有地址与签名能确定扩展字段与插件要校验的是同一个包。
    let Some(entry) = platform_entry(raw_json, chosen_url, signature) else {
        tracing::warn!(
            url = %chosen_url,
            max = MAX_PACKAGE_SIZE,
            "清单里找不到插件选中的平台条目，只用插件给的地址，大小按硬上限截断"
        );
        return Ok(PackagePlan {
            sources: vec![default_source(chosen_url)?],
            size: Some(MAX_PACKAGE_SIZE),
        });
    };
    let mut sources = listed_sources(entry);
    if sources.is_empty() {
        sources.push(default_source(chosen_url)?);
    }
    Ok(PackagePlan {
        sources,
        size: Some(package_size(entry)),
    })
}

fn platform_entry<'a>(
    raw_json: &'a Value,
    chosen_url: &Url,
    signature: &str,
) -> Option<&'a Map<String, Value>> {
    raw_json
        .get("platforms")?
        .as_object()?
        .values()
        .filter_map(Value::as_object)
        .find(|entry| {
            entry.get("signature").and_then(Value::as_str) == Some(signature)
                && entry
                    .get("url")
                    .and_then(Value::as_str)
                    .and_then(|url| Url::parse(url).ok())
                    .as_ref()
                    == Some(chosen_url)
        })
}

/// 插件选中的地址作唯一的源；它同样来自不签名的清单，过不了 [`check_source_url`] 就不下载，立即报下载失败。
fn default_source(chosen_url: &Url) -> Result<PackageSource, CommandError> {
    if let Err(reason) = check_source_url(chosen_url) {
        tracing::warn!(url = %chosen_url, reason, "插件选中的下载地址没有通过校验，不下载");
        return Err(sources_failed(vec![SourceFailure {
            source: DEFAULT_SOURCE_NAME.to_owned(),
            failure: FailureKind::Other,
            verdict: Verdict::Stop,
            message: format!("清单给的下载地址 {chosen_url} 没有通过校验：{reason}"),
            causes: Vec::new(),
        }]));
    }
    Ok(PackageSource {
        name: DEFAULT_SOURCE_NAME.to_owned(),
        url: chosen_url.clone(),
        // 只有这一个源，不参与排序，地区只是占位。
        region: SourceRegion::Domestic,
    })
}

/// 清单列出的候选源里合法的那些，保持清单里的先后。
fn listed_sources(entry: &Map<String, Value>) -> Vec<PackageSource> {
    let listed = match entry.get(SOURCES_KEY) {
        // 扩展字段上线前发的清单没有这一项，不算异常。
        None => {
            tracing::info!("清单没有列出候选下载源，只用插件给的地址");
            return Vec::new();
        }
        Some(Value::Array(listed)) => listed,
        Some(other) => {
            tracing::warn!(value = %other, "清单的候选下载源不是数组，只用插件给的地址");
            return Vec::new();
        }
    };
    if listed.len() > MAX_SOURCES {
        tracing::warn!(
            listed = listed.len(),
            max = MAX_SOURCES,
            "清单列出的候选下载源超过上限，多出的不用"
        );
    }
    let mut sources: Vec<PackageSource> = Vec::new();
    for (index, item) in listed.iter().take(MAX_SOURCES).enumerate() {
        match listed_source(item, &sources) {
            Ok(source) => sources.push(source),
            Err(reason) => {
                tracing::warn!(index, source = %item, reason, "清单里的候选下载源不合法，跳过")
            }
        }
    }
    if sources.is_empty() {
        tracing::warn!("清单列出的候选下载源一个都不能用，只用插件给的地址");
    }
    sources
}

/// 校验一条候选源；不合法时给出原因进日志。
fn listed_source(item: &Value, accepted: &[PackageSource]) -> Result<PackageSource, &'static str> {
    let name = item.get("name").and_then(Value::as_str).ok_or("没有源名")?;
    let region = region_of(name).ok_or("源名不在认得的四个之列")?;
    let raw_url = item.get("url").and_then(Value::as_str).ok_or("没有地址")?;
    let url = Url::parse(raw_url).map_err(|_| "地址不是合法的 URL")?;
    check_source_url(&url)?;
    // 同一个源不重试：重名或同一地址再列一次，只会把同一次失败再等一遍。
    if accepted.iter().any(|source| source.name == name) {
        return Err("与前面的源重名");
    }
    if accepted.iter().any(|source| source.url == url) {
        return Err("与前面的源地址相同");
    }
    Ok(PackageSource {
        name: name.to_owned(),
        url,
        region,
    })
}

/// 一个下载地址能不能用：x-sources 的每一条与退回的插件选中地址共用这一道。除 github.com 外只比主机不比路径，
/// 白名单主机回的跳转照跟（GitHub 的下载地址本来就会跳到别的主机），包的完整性靠插件验签。不能用时给出原因。
fn check_source_url(url: &Url) -> Result<(), &'static str> {
    if url.scheme() != "https" {
        return Err("地址不是 https");
    }
    if !allowed_host(url) {
        return Err("主机不在白名单里");
    }
    // 端口会把请求引到同一主机上的另一个服务，用户信息会被当作凭据发出去；CI 生成清单时同样拒收这两样。
    // 写明默认端口 443 的地址解析后等于没写，照收。
    if url.port().is_some() {
        return Err("地址带了端口");
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("地址带了用户信息");
    }
    if is_github(url) && !in_repo_releases(url) {
        return Err("GitHub 上的地址不是本仓库 Releases 的附件");
    }
    Ok(())
}

fn is_github(url: &Url) -> bool {
    url.host_str()
        .is_some_and(|host| host.eq_ignore_ascii_case(GITHUB_HOST))
}

/// 本仓库 Releases 附件的路径前缀，从 [`dev_endpoint`](crate::commands::updater::dev_endpoint) 用的同一个
/// [`REPO_URL`](petalfall_base::brand::REPO_URL) 推出来：清单与更新包必须出自同一个仓库。
fn release_asset_prefix() -> String {
    let repo =
        Url::parse(petalfall_base::brand::REPO_URL).expect("编译进来的仓库地址必须是合法 URL");
    format!("{}/releases/download/", repo.path())
}

/// 路径以本仓库 Releases 附件的前缀开头。`Url` 解析时已经消掉了 `..`（含 `%2e%2e`），比的是规范化之后的路径，
/// 写成「前缀 + 一串 `..`」也绕不到别的仓库去。
fn in_repo_releases(url: &Url) -> bool {
    url.path().starts_with(&release_asset_prefix())
}

fn region_of(name: &str) -> Option<SourceRegion> {
    SOURCE_REGIONS
        .iter()
        .find(|(known, _)| *known == name)
        .map(|(_, region)| *region)
}

fn allowed_host(url: &Url) -> bool {
    url.host_str().is_some_and(|host| {
        ALLOWED_SOURCE_HOSTS
            .iter()
            .any(|allowed| host.eq_ignore_ascii_case(allowed))
    })
}

/// 清单声明的安装包大小，压在 [`MAX_PACKAGE_SIZE`] 以内。
fn package_size(entry: &Map<String, Value>) -> u64 {
    let Some(value) = entry.get(SIZE_KEY) else {
        tracing::warn!(
            max = MAX_PACKAGE_SIZE,
            "清单没有给出安装包大小，按硬上限截断"
        );
        return MAX_PACKAGE_SIZE;
    };
    match value.as_u64() {
        Some(size) if size <= MAX_PACKAGE_SIZE => size,
        Some(size) => {
            tracing::warn!(
                size,
                max = MAX_PACKAGE_SIZE,
                "清单里的安装包大小超过硬上限，按硬上限截断"
            );
            MAX_PACKAGE_SIZE
        }
        None => {
            tracing::warn!(
                value = %value,
                max = MAX_PACKAGE_SIZE,
                "清单里的安装包大小不是非负整数，按硬上限截断"
            );
            MAX_PACKAGE_SIZE
        }
    }
}

/// 一个源为什么失败，交给前端的稳定名字。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum FailureKind {
    /// 连不上（DNS、拒绝连接、TLS 握手失败）。
    Connect,
    /// 等不到数据：读取超时，或正文长时间没有进展。
    Timeout,
    /// 拿到了响应但不能用：非 2xx，或正文传到一半出错。
    Http,
    /// 包被拒：字节对不上签名，或签名本身不合规。
    Signature,
    /// 下载的数据超过了清单声明的大小，或超过了 [`MAX_PACKAGE_SIZE`]。
    TooLarge,
    /// 本机这边的问题、清单给的下载地址没过校验、源的地址或它回的跳转建不成请求，或插件新增的失败。
    Other,
}

/// 一个已试源的失败，除判定外原样进 detail.sources。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct SourceFailure {
    pub source: String,
    pub failure: FailureKind,
    /// 这次失败之后换不换源：下载循环据此决定试不试下一个，[`sources_failed`] 据此定错误码；不进 detail.sources。
    #[serde(skip)]
    pub verdict: Verdict,
    pub message: String,
    /// 插件错误 source 链上的各层（DNS、TCP、TLS 那几层的原文），复制错误信息时靠它看出底层原因。
    /// 与 detail.causes 一样，没有原因链就不写这个键。
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub causes: Vec<String>,
}

/// 一个源失败之后怎么办。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Verdict {
    NextSource,
    Stop,
}

/// 单个源的一次失败。取消与「清单已变」不经过这里，由调用方直接处理。
#[derive(Debug)]
pub(crate) enum AttemptError {
    Stalled,
    TooLarge { limit: u64 },
    Plugin(tauri_plugin_updater::Error),
}

/// 判定一个源的失败：记成哪一类，换不换下一个源（[`SourceFailure::verdict`]）。
pub(crate) fn judge(source: &PackageSource, err: AttemptError) -> SourceFailure {
    let (failure, verdict, message, causes) = match err {
        AttemptError::Stalled => (
            FailureKind::Timeout,
            Verdict::NextSource,
            STALLED_MESSAGE.to_owned(),
            Vec::new(),
        ),
        AttemptError::TooLarge { limit } => (
            FailureKind::TooLarge,
            Verdict::NextSource,
            // 上限压在硬上限上时，清单可能根本没声明大小，不能说成清单声明的。
            if limit >= MAX_PACKAGE_SIZE {
                format!("下载的数据超过了更新包大小的硬上限 {limit} 字节，已中止")
            } else {
                format!("下载的数据超过了清单声明的 {limit} 字节，已中止")
            },
            Vec::new(),
        ),
        AttemptError::Plugin(err) => {
            let (failure, verdict) = plugin_verdict(&err);
            if matches!(
                err,
                UpdaterError::Minisign(minisign_verify::Error::InvalidSignature)
            ) {
                // 签名来自清单、各源共用，单单这个源的字节对不上时，多半是这个源上的文件被换过或已损坏，
                // 单独留一条记下是哪个源，便于事后去查。其余 Minisign 失败与源无关，点名源只会误导排查。
                tracing::warn!(
                    source = %source.name,
                    url = %source.url,
                    error = %err,
                    "这个源下来的更新包与签名对不上，换下一个源"
                );
            }
            (failure, verdict, err.to_string(), source_chain(&err))
        }
    };
    match verdict {
        // 判了立即停的失败换哪个源都一样（签名本身、内置公钥、本机建不起请求），点名这个源会把排查引向它。
        Verdict::Stop => tracing::warn!(
            ?failure,
            ?verdict,
            %message,
            ?causes,
            "更新包下载失败，与下载源无关，不再换源"
        ),
        Verdict::NextSource => tracing::warn!(
            source = %source.name,
            url = %source.url,
            ?failure,
            ?verdict,
            %message,
            ?causes,
            "更新包下载源失败"
        ),
    }
    SourceFailure {
        source: source.name.clone(),
        failure,
        verdict,
        message,
        causes,
    }
}

fn plugin_verdict(err: &UpdaterError) -> (FailureKind, Verdict) {
    match err {
        // 字节对不上签名只说明这一个源的文件不对，别的源可能是好的。盖住可信注释的全局签名不过也是这个变体，
        // 那是清单的问题、与源无关却分不出来；多试几个源也只是多下几遍，最后照样全是 signature、报签名无效。
        UpdaterError::Minisign(minisign_verify::Error::InvalidSignature) => {
            (FailureKind::Signature, Verdict::NextSource)
        }
        // 签名或公钥解不开、签名用的不是内置公钥那把钥匙、算法不认得：出在清单的签名或客户端自己的公钥，
        // 与哪个源无关，换源只会对着同一个签名再失败一次。
        UpdaterError::Minisign(_) => (FailureKind::Signature, Verdict::Stop),
        // 签名串本身不合规、签名版本与清单版本对不上、签名没带版本：问题出在清单，换哪个源都是同一个签名。
        UpdaterError::Base64(_)
        | UpdaterError::SignatureUtf8(_)
        | UpdaterError::SignedVersionMismatch { .. }
        | UpdaterError::MissingSignedVersion => (FailureKind::Signature, Verdict::Stop),
        // 不带地址的构建错误出在客户端本身（TLS 后端、代理配置），是本机这边的问题，换源也一样。
        UpdaterError::Reqwest(http) if http.is_builder() && http.url().is_none() => {
            (FailureKind::Other, Verdict::Stop)
        }
        // 带地址的构建错误出在这个源的地址或它回的跳转上：跳到 http、https 以外的协议，或地址超出 http::Uri 的长度
        // 上限。换一个源就可能好，判停的话重试时排序不变，次次卡在这个源上。
        UpdaterError::Reqwest(http) if http.is_builder() => {
            (FailureKind::Other, Verdict::NextSource)
        }
        // 插件的 Reqwest 变体是 transparent，顺着它的 source 链找不到 reqwest 错误本身，只能直接拿来判断。
        // 不在网络层的（回了响应头之后正文传到一半断掉之类）说明连得上这个源，算它的 HTTP 层失败。
        UpdaterError::Reqwest(http) => (
            network_or(
                petalfall_base::http::network_failure(http),
                FailureKind::Http,
            ),
            Verdict::NextSource,
        ),
        UpdaterError::Http(_)
        | UpdaterError::InvalidHeaderValue(_)
        | UpdaterError::InvalidHeaderName(_) => (FailureKind::Other, Verdict::Stop),
        UpdaterError::Network(_) => (FailureKind::Http, Verdict::NextSource),
        // 下载时不会出现的既有变体与插件将来新增的变体：说不清是不是这个源的问题，换源总比直接放弃强。
        other => (
            network_or(
                petalfall_base::http::network_failure(other),
                FailureKind::Other,
            ),
            Verdict::NextSource,
        ),
    }
}

/// 网络层失败按种类归类，不在网络层的归为 `otherwise`。
fn network_or(network: Option<NetworkFailure>, otherwise: FailureKind) -> FailureKind {
    match network {
        Some(NetworkFailure::Connect) => FailureKind::Connect,
        Some(NetworkFailure::Timeout) => FailureKind::Timeout,
        None => otherwise,
    }
}

/// 汇总全部已试源的失败；failures 至少一条。
///
/// 报签名无效（update_signature_invalid）的两种情形：已试的源全是 signature；或最后一个源判的是
/// (signature, 立即停)，即签名本身出了与源无关的问题，前面的源败在哪都不改变「包被拒」的结论。其余报下载失败
/// （update_download_failed）。全都败在网络层时标 detail.network，前端据此提示检查网络。
/// 只试了一个源时 message 就是那个源的原文、原因链提到 detail.causes，与多源下载上线前的形状一致。
pub(crate) fn sources_failed(failures: Vec<SourceFailure>) -> CommandError {
    assert!(!failures.is_empty(), "汇总下载源失败时至少要有一个已试的源");
    let signature = |failure: &SourceFailure| failure.failure == FailureKind::Signature;
    // 立即停的失败必定是最后一条：判了停就不再试下一个源。
    let stopped_on_signature = failures
        .last()
        .is_some_and(|last| signature(last) && last.verdict == Verdict::Stop);
    let code = if failures.iter().all(signature) || stopped_on_signature {
        code::UPDATE_SIGNATURE_INVALID
    } else {
        code::UPDATE_DOWNLOAD_FAILED
    };
    let message = match failures.as_slice() {
        [only] => only.message.clone(),
        many => many
            .iter()
            .map(|failure| format!("{}：{}", failure.source, failure.message))
            .collect::<Vec<_>>()
            .join("\n"),
    };
    let mut detail = Map::new();
    if let Some(network) = network_layer(&failures) {
        detail.insert("network".to_owned(), json!(network.code()));
    }
    // 前端「复制错误信息」把 detail.causes 逐行写成「原因：…」；多个源时原因链各自留在 detail.sources 里。
    if let [only] = failures.as_slice() {
        if !only.causes.is_empty() {
            detail.insert("causes".to_owned(), json!(only.causes));
        }
    }
    detail.insert("sources".to_owned(), json!(failures));
    tracing::warn!(code, tried = failures.len(), %message, "更新包下载失败");
    CommandError {
        code,
        message,
        detail: Some(Value::Object(detail)),
    }
}

/// 全部失败都在网络层时是哪一种：全是超时才算超时，混着连不上就算连不上。
fn network_layer(failures: &[SourceFailure]) -> Option<NetworkFailure> {
    let mut all_timeout = true;
    for failure in failures {
        match failure.failure {
            FailureKind::Timeout => {}
            FailureKind::Connect => all_timeout = false,
            _ => return None,
        }
    }
    Some(if all_timeout {
        NetworkFailure::Timeout
    } else {
        NetworkFailure::Connect
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    use petalfall_base::brand::APP_SLUG;

    const SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ=";
    const TARGET: &str = "windows-x86_64";
    const SIZE: u64 = 22_846_361;

    fn package_url(host: &str) -> String {
        format!("https://{host}/dev/0.1.0-dev.36-1/pkg-0.1.0-dev.36-x64.exe")
    }

    fn cn_url() -> String {
        package_url(ALLOWED_SOURCE_HOSTS[0])
    }

    fn hk_url() -> String {
        package_url(ALLOWED_SOURCE_HOSTS[1])
    }

    fn global_url() -> String {
        package_url(ALLOWED_SOURCE_HOSTS[2])
    }

    /// 前缀写成字面量，不从 [`release_asset_prefix`] 拼：这是与 CI、服务器约定的取值，推导出错时这里要挂。
    fn github_url() -> String {
        format!(
            "https://{}/ShinoyukiMiyako/Petalfall/releases/download/dev-build/pkg-0.1.0-dev.36-x64.exe",
            ALLOWED_SOURCE_HOSTS[3]
        )
    }

    fn url(raw: &str) -> Url {
        Url::parse(raw).unwrap()
    }

    fn listed(name: &str, raw_url: &str) -> Value {
        json!({ "name": name, "url": raw_url })
    }

    fn source(name: &str, raw_url: &str, region: SourceRegion) -> PackageSource {
        PackageSource {
            name: name.to_owned(),
            url: url(raw_url),
            region,
        }
    }

    /// 插件选中的平台条目：标准的 url 与 signature，再并上 `extra` 里的扩展字段。
    fn entry(extra: Value) -> Value {
        entry_at(&cn_url(), extra)
    }

    /// 同 [`entry`]，插件选中的地址是 `chosen`。
    fn entry_at(chosen: &str, extra: Value) -> Value {
        let mut entry = json!({ "signature": SIGNATURE, "url": chosen });
        entry
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        entry
    }

    fn manifest(platforms: Value) -> Value {
        json!({
            "version": "0.1.0-dev.36",
            "notes": "dev build",
            "pub_date": "2026-11-04T08:00:00Z",
            "platforms": platforms,
        })
    }

    fn manifest_with(extra: Value) -> Value {
        manifest(json!({ TARGET: entry(extra) }))
    }

    fn plan_of(raw: &Value) -> PackagePlan {
        package_plan(raw, &url(&cn_url()), SIGNATURE).expect("白名单主机上的回退地址被拒了")
    }

    fn names(plan: &PackagePlan) -> Vec<&str> {
        plan.sources
            .iter()
            .map(|source| source.name.as_str())
            .collect()
    }

    fn fallback() -> Vec<PackageSource> {
        vec![source("default", &cn_url(), SourceRegion::Domestic)]
    }

    fn full_list() -> Value {
        json!([
            listed("cn", &cn_url()),
            listed("hk", &hk_url()),
            listed("global", &global_url()),
            listed("github", &github_url()),
        ])
    }

    /// 白名单就是批准的四个主机：多一个、少一个、拼错一个都要挂，服务器脚本按同一张表校验。
    #[test]
    fn allowed_hosts_are_the_approved_four() {
        assert_eq!(
            ALLOWED_SOURCE_HOSTS.map(str::to_owned),
            [
                format!("{APP_SLUG}-dl-cn.oss-cn-hangzhou.aliyuncs.com"),
                format!("{APP_SLUG}-dl.oss-cn-hongkong.aliyuncs.com"),
                format!("dl.{APP_SLUG}.org"),
                "github.com".to_owned(),
            ]
        );
        assert_eq!(MAX_SOURCES, 6);
    }

    /// `lines` 里从 `opening` 那一行之后、到第一个 `closing` 行之前的那几行。找不到就挂：脚本改了写法时不能按空表放过。
    fn js_block<'a>(lines: &[&'a str], opening: &str, closing: &str) -> Vec<&'a str> {
        let start = lines
            .iter()
            .position(|line| *line == opening)
            .unwrap_or_else(|| panic!("CI 脚本里找不到 {opening}"));
        let rest = &lines[start + 1..];
        let end = rest
            .iter()
            .position(|line| *line == closing)
            .unwrap_or_else(|| panic!("CI 脚本里 {opening} 之后找不到收尾的 {closing}"));
        rest[..end].to_vec()
    }

    /// `key: "value",` 这样一行里的 value。
    fn js_string<'a>(line: &'a str, key: &str) -> Option<&'a str> {
        line.strip_prefix(key)?
            .strip_prefix(": \"")?
            .strip_suffix("\",")
    }

    /// CI 生成清单的脚本里的源表，按出现先后：MIRRORS 每一项的 name 与 host，再加 SOURCE_HOSTS 里在 MIRRORS 之外
    /// 单列的那几项（现在只有 github）。
    fn ci_source_hosts() -> Vec<(String, String)> {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../.github/scripts/dev-distribution.mjs"
        );
        let text = std::fs::read_to_string(path).unwrap_or_else(|err| panic!("{path}: {err}"));
        // 只看真正执行的行：注释里写着同样的键值的话，删掉真正的那一行照样能过。
        let lines: Vec<&str> = text
            .lines()
            .map(str::trim)
            .filter(|line| !line.starts_with("//"))
            .collect();

        let mirrors = js_block(&lines, "const MIRRORS = Object.freeze([", "]);");
        let entries = mirrors.iter().filter(|line| **line == "{").count();
        let names: Vec<&str> = mirrors
            .iter()
            .filter_map(|line| js_string(line, "name"))
            .collect();
        let hosts: Vec<&str> = mirrors
            .iter()
            .filter_map(|line| js_string(line, "host"))
            .collect();
        assert!(entries > 0, "MIRRORS 一项都没认出来：{mirrors:?}");
        // 有一项的 name 或 host 换了写法认不出来时，配对会整体错开，不能靠 zip 截掉了事
        assert_eq!(
            (names.len(), hosts.len()),
            (entries, entries),
            "MIRRORS 每一项都要有一行 name、一行 host：{mirrors:?}"
        );
        let mut table: Vec<(String, String)> = names
            .into_iter()
            .zip(hosts)
            .map(|(name, host)| (name.to_owned(), host.to_owned()))
            .collect();

        let source_hosts = js_block(&lines, "export const SOURCE_HOSTS = Object.freeze({", "});");
        let spread = "...Object.fromEntries(MIRRORS.map(({ name, host }) => [name, host])),";
        assert!(
            source_hosts.contains(&spread),
            "SOURCE_HOSTS 不再由 MIRRORS 展开：{source_hosts:?}"
        );
        for line in source_hosts.into_iter().filter(|line| *line != spread) {
            let (name, _) = line
                .split_once(':')
                .unwrap_or_else(|| panic!("SOURCE_HOSTS 里认不出的一行：{line}"));
            let host = js_string(line, name)
                .unwrap_or_else(|| panic!("SOURCE_HOSTS 里认不出的一行：{line}"));
            table.push((name.to_owned(), host.to_owned()));
        }
        table
    }

    /// 源表三处各写一份：客户端这里、CI 生成清单的脚本、香港机的 put-manifest。CI 改了源名或主机而客户端没跟上时，
    /// 两边各自的用例都照过，客户端却只打一条 warn 就悄悄少一个源；这里把客户端的源名、主机、两者的配对与地区划分
    /// 和 CI 的源表逐一比对。put-manifest 不在这个仓库里，比不到。
    #[test]
    fn the_source_table_matches_the_ci_script() {
        let mut ci = ci_source_hosts();
        let mut client: Vec<(String, String)> = SOURCE_REGIONS
            .iter()
            .zip(ALLOWED_SOURCE_HOSTS)
            .map(|((name, _), host)| ((*name).to_owned(), host.to_owned()))
            .collect();
        // CI 里的先后就是 x-sources 的先后，客户端排序只认源名不看它，所以只比配对、不比先后
        ci.sort();
        client.sort();
        assert_eq!(ci, client);

        // 地区划分是产品上定的，写成字面量：国内 cn、hk，海外 global、github
        for (name, host) in &ci {
            let expected = match name.as_str() {
                "cn" | "hk" => SourceRegion::Domestic,
                "global" | "github" => SourceRegion::Overseas,
                other => panic!("CI 多了一个没定地区的源 {other}（{host}）"),
            };
            assert_eq!(region_of(name), Some(expected), "{name}");
        }
    }

    /// GitHub 源只认本仓库 Releases 的附件，前缀是与 CI、服务器约定的那个；开发版在 GitHub 上的清单也在这个前缀下，
    /// 清单与更新包出自同一个仓库。
    #[test]
    fn github_sources_are_pinned_to_this_repository() {
        assert_eq!(
            release_asset_prefix(),
            "/ShinoyukiMiyako/Petalfall/releases/download/"
        );
        let manifest = url(&crate::commands::updater::dev_endpoint());
        assert_eq!(manifest.host_str(), Some(GITHUB_HOST));
        assert!(
            manifest.path().starts_with(&release_asset_prefix()),
            "{manifest}"
        );
    }

    #[test]
    fn manifest_without_extensions_uses_the_chosen_url_alone() {
        let plan = plan_of(&manifest_with(json!({})));
        assert_eq!(plan.sources, fallback());
        assert_eq!(plan.size, Some(MAX_PACKAGE_SIZE));
    }

    #[test]
    fn listed_sources_keep_the_manifest_order_and_regions() {
        let plan = plan_of(&manifest_with(
            json!({ "x-size": SIZE, "x-sources": full_list() }),
        ));
        assert_eq!(
            plan.sources,
            vec![
                source("cn", &cn_url(), SourceRegion::Domestic),
                source("hk", &hk_url(), SourceRegion::Domestic),
                source("global", &global_url(), SourceRegion::Overseas),
                source("github", &github_url(), SourceRegion::Overseas),
            ]
        );
        assert_eq!(plan.size, Some(SIZE));
    }

    /// 旧客户端与插件读的是同一份清单：带上扩展字段之后，插件照样解析，选中的地址与签名一个字节都不变。
    #[test]
    fn the_plugin_still_reads_the_standard_fields_of_an_extended_manifest() {
        let raw = manifest_with(json!({ "x-size": SIZE, "x-sources": full_list() }));
        let release: tauri_plugin_updater::RemoteRelease =
            serde_json::from_value(raw.clone()).unwrap();
        assert_eq!(release.version.to_string(), "0.1.0-dev.36");
        assert_eq!(release.download_url(TARGET).unwrap().as_str(), cn_url());
        assert_eq!(release.signature(TARGET).unwrap(), SIGNATURE);
        // 插件交给我们的正是这对值，反查得到同一个条目
        let plan = package_plan(&raw, release.download_url(TARGET).unwrap(), SIGNATURE).unwrap();
        assert_eq!(names(&plan), ["cn", "hk", "global", "github"]);
    }

    #[test]
    fn sources_that_are_not_https_are_skipped() {
        let plain = hk_url().replacen("https://", "http://", 1);
        let plan = plan_of(&manifest_with(json!({ "x-sources": [
            listed("cn", &cn_url()),
            listed("hk", &plain),
            listed("global", &global_url()),
        ] })));
        assert_eq!(names(&plan), ["cn", "global"]);
    }

    /// 主机按白名单整串比，子域、后缀拼接、带尾点都不算，只有大小写不论。
    #[test]
    fn sources_off_the_host_whitelist_are_skipped() {
        let github = ALLOWED_SOURCE_HOSTS[3];
        let rejected = [
            package_url("downloads.example.com"),
            package_url(&format!("cdn.{github}")),
            package_url(&format!("{github}.example.com")),
            package_url(&format!("{github}.")),
            "https://127.0.0.1/pkg.exe".to_owned(),
        ];
        for raw in &rejected {
            let plan = plan_of(&manifest_with(json!({ "x-sources": [
                listed("github", raw),
                listed("cn", &cn_url()),
            ] })));
            assert_eq!(names(&plan), ["cn"], "{raw}");
        }

        let shouting = package_url(&ALLOWED_SOURCE_HOSTS[2].to_ascii_uppercase());
        let plan = plan_of(&manifest_with(
            json!({ "x-sources": [listed("global", &shouting)] }),
        ));
        assert_eq!(
            plan.sources,
            vec![source("global", &global_url(), SourceRegion::Overseas)]
        );
    }

    /// 白名单主机上带端口或用户信息的地址也跳过，与 CI 生成清单时的校验一致；写明默认端口 443 等于没写，照收。
    #[test]
    fn sources_with_a_port_or_credentials_are_skipped() {
        let cn = ALLOWED_SOURCE_HOSTS[0];
        let path = "dev/0.1.0-dev.36-1/pkg-0.1.0-dev.36-x64.exe";
        for raw in [
            format!("https://{cn}:8443/{path}"),
            format!("https://{cn}:1/{path}"),
            format!("https://mirror@{cn}/{path}"),
            format!("https://mirror:secret@{cn}/{path}"),
            format!("https://:secret@{cn}/{path}"),
        ] {
            let plan = plan_of(&manifest_with(json!({ "x-sources": [
                listed("cn", &raw),
                listed("hk", &hk_url()),
            ] })));
            assert_eq!(
                plan.sources,
                vec![source("hk", &hk_url(), SourceRegion::Domestic)],
                "{raw}"
            );
        }

        let default_port = format!("https://{cn}:443/{path}");
        let plan = plan_of(&manifest_with(
            json!({ "x-sources": [listed("cn", &default_port)] }),
        ));
        assert_eq!(
            plan.sources,
            vec![source("cn", &cn_url(), SourceRegion::Domestic)]
        );
    }

    /// github.com 上谁都能发附件：不是本仓库 Releases 附件的地址跳过，仓库名多一截、用 `..`（含百分号编码的）
    /// 绕到别的仓库都不行。按主机认，不按源名认：别的源名写成 github.com 的地址也一样。
    #[test]
    fn github_sources_outside_this_repository_releases_are_skipped() {
        let github = ALLOWED_SOURCE_HOSTS[3];
        let file = "dev-build/pkg-0.1.0-dev.36-x64.exe";
        let ours = "ShinoyukiMiyako/Petalfall/releases/download";
        for raw in [
            format!("https://{github}/attacker/repo/releases/download/{file}"),
            format!("https://{github}/ShinoyukiMiyako/Petalfall-fork/releases/download/{file}"),
            format!("https://{github}/ShinoyukiMiyako/Petalfall/archive/refs/heads/main.zip"),
            format!("https://{github}/ShinoyukiMiyako/Petalfall/releases/download"),
            format!("https://{github}/{ours}/../../../../attacker/repo/releases/download/{file}"),
            format!(
                "https://{github}/{ours}/%2e%2e/%2E%2E/%2e%2E/%2E%2e/attacker/repo/releases/download/{file}"
            ),
            format!("https://{github}/"),
        ] {
            let plan = plan_of(&manifest_with(json!({ "x-sources": [
                listed("github", &raw),
                listed("cn", &cn_url()),
            ] })));
            assert_eq!(names(&plan), ["cn"], "{raw}");

            let plan = plan_of(&manifest_with(json!({ "x-sources": [
                listed("hk", &raw),
                listed("cn", &cn_url()),
            ] })));
            assert_eq!(names(&plan), ["cn"], "{raw}");
        }

        let plan = plan_of(&manifest_with(
            json!({ "x-sources": [listed("github", &github_url())] }),
        ));
        assert_eq!(
            plan.sources,
            vec![source("github", &github_url(), SourceRegion::Overseas)]
        );
    }

    /// 源名只认四个，大小写不同、与兜底源同名都不行；条目缺名、缺地址、地址不合法、根本不是对象也跳过。
    #[test]
    fn unknown_or_malformed_sources_are_skipped() {
        let plan = plan_of(&manifest_with(json!({ "x-sources": [
            listed("us", &global_url()),
            listed("CN", &cn_url()),
            listed("default", &cn_url()),
            { "url": hk_url() },
            { "name": "hk" },
            { "name": "hk", "url": 42 },
        ] })));
        assert_eq!(plan.sources, fallback());

        let plan = plan_of(&manifest_with(json!({ "x-sources": [
            listed("hk", "not a url"),
            "github",
            listed("github", &github_url()),
        ] })));
        assert_eq!(
            plan.sources,
            vec![source("github", &github_url(), SourceRegion::Overseas)]
        );
    }

    /// 同名或同地址只留第一次出现的那条：同一个源不重试。
    #[test]
    fn repeated_sources_keep_the_first_listing() {
        let other_cn = format!("https://{}/dev/other/pkg.exe", ALLOWED_SOURCE_HOSTS[0]);
        let plan = plan_of(&manifest_with(json!({ "x-sources": [
            listed("cn", &cn_url()),
            listed("cn", &other_cn),
            listed("hk", &cn_url()),
            listed("hk", &hk_url()),
        ] })));
        assert_eq!(
            plan.sources,
            vec![
                source("cn", &cn_url(), SourceRegion::Domestic),
                source("hk", &hk_url(), SourceRegion::Domestic),
            ]
        );
    }

    /// 只看前六条，不论前面有没有被跳过：第六条照收，第七条再合法也不看。
    #[test]
    fn only_the_first_six_listings_are_considered() {
        let padded = |last: Value| {
            json!({ "x-sources": [
                listed("cn", &cn_url()),
                listed("cn", &hk_url()),
                listed("hk", &hk_url()),
                listed("hk", &global_url()),
                listed("global", &global_url()),
                last,
            ] })
        };
        let sixth = plan_of(&manifest_with(padded(listed("github", &github_url()))));
        assert_eq!(names(&sixth), ["cn", "hk", "global", "github"]);

        let mut seventh = padded(listed("global", &github_url()));
        seventh["x-sources"]
            .as_array_mut()
            .unwrap()
            .push(listed("github", &github_url()));
        assert_eq!(
            seventh["x-sources"].as_array().unwrap().len(),
            MAX_SOURCES + 1
        );
        let plan = plan_of(&manifest_with(seventh));
        assert_eq!(names(&plan), ["cn", "hk", "global"]);
    }

    /// 列表不是数组、是空的、或一条都不合法：退回插件选中的地址，大小照读。
    #[test]
    fn sources_that_are_not_a_usable_list_fall_back_to_the_chosen_url() {
        for mut extra in [
            json!({ "x-sources": "cn" }),
            json!({ "x-sources": { "name": "cn", "url": cn_url() } }),
            json!({ "x-sources": null }),
            json!({ "x-sources": [] }),
            json!({ "x-sources": [listed("us", &cn_url()), listed("cn", "ftp://x/pkg.exe")] }),
        ] {
            extra["x-size"] = json!(SIZE);
            let plan = plan_of(&manifest_with(extra.clone()));
            assert_eq!(plan.sources, fallback(), "{extra}");
            assert_eq!(plan.size, Some(SIZE), "{extra}");
        }
    }

    /// 大小只认不超过硬上限的非负整数，0 与硬上限本身照收；超过硬上限的、别的写法、没写的，一律按硬上限截断，
    /// 候选源不受影响。硬上限是与 CI、服务器约定的 256 MiB。
    #[test]
    fn size_must_be_a_non_negative_integer_within_the_cap() {
        assert_eq!(MAX_PACKAGE_SIZE, 268_435_456);
        for (raw, expected) in [
            (json!(0), 0),
            (json!(1), 1),
            (json!(SIZE), SIZE),
            (json!(MAX_PACKAGE_SIZE - 1), MAX_PACKAGE_SIZE - 1),
            (json!(MAX_PACKAGE_SIZE), MAX_PACKAGE_SIZE),
            (json!(MAX_PACKAGE_SIZE + 1), MAX_PACKAGE_SIZE),
            (json!(i64::MAX), MAX_PACKAGE_SIZE),
            (json!(u64::MAX), MAX_PACKAGE_SIZE),
            (json!(SIZE.to_string()), MAX_PACKAGE_SIZE),
            (json!(-1), MAX_PACKAGE_SIZE),
            (json!(1.5), MAX_PACKAGE_SIZE),
            (json!(null), MAX_PACKAGE_SIZE),
            (json!([SIZE]), MAX_PACKAGE_SIZE),
        ] {
            let plan = plan_of(&manifest_with(
                json!({ "x-size": raw, "x-sources": full_list() }),
            ));
            assert_eq!(plan.size, Some(expected), "{raw}");
            assert_eq!(names(&plan), ["cn", "hk", "global", "github"], "{raw}");
        }

        let plan = plan_of(&manifest_with(json!({ "x-sources": full_list() })));
        assert_eq!(plan.size, Some(MAX_PACKAGE_SIZE), "没写 x-size");

        // 随机大小：硬上限两侧都抽到，结果总是两者中较小的那个
        let mut rng = fastrand::Rng::with_seed(0x51_2e_ca_95);
        for _ in 0..500 {
            let size = if rng.bool() {
                rng.u64(..=MAX_PACKAGE_SIZE * 2)
            } else {
                rng.u64(..)
            };
            let plan = plan_of(&manifest_with(json!({ "x-size": size })));
            assert_eq!(plan.size, Some(size.min(MAX_PACKAGE_SIZE)), "{size}");
        }
    }

    /// 平台条目按插件选中的地址与签名反查，不看平台键：地址或签名有一样对不上就不用那条的扩展字段。
    #[test]
    fn the_platform_entry_is_found_by_url_and_signature() {
        let other_signature = json!({
            "signature": "b3RoZXI=",
            "url": cn_url(),
            "x-size": SIZE,
            "x-sources": full_list(),
        });
        let other_url = json!({
            "signature": SIGNATURE,
            "url": hk_url(),
            "x-size": SIZE,
            "x-sources": full_list(),
        });
        for platforms in [
            json!({ TARGET: other_signature }),
            json!({ TARGET: other_url }),
            json!({}),
        ] {
            let plan = plan_of(&manifest(platforms.clone()));
            assert_eq!(plan.sources, fallback(), "{platforms}");
            assert_eq!(plan.size, Some(MAX_PACKAGE_SIZE), "{platforms}");
        }
        assert_eq!(
            plan_of(&json!({ "version": "0.1.0-dev.36" })).sources,
            fallback()
        );

        // 插件按回退键选中了条目：照样找得到，平台键上那条不相干的不会被拿来用
        let plan = plan_of(&manifest(json!({
            TARGET: {
                "signature": "b3RoZXI=",
                "url": hk_url(),
                "x-size": 1,
                "x-sources": [listed("hk", &hk_url())],
            },
            "windows-x86_64-nsis": entry(json!({ "x-size": SIZE, "x-sources": full_list() })),
        })));
        assert_eq!(names(&plan), ["cn", "hk", "global", "github"]);
        assert_eq!(plan.size, Some(SIZE));
    }

    /// 会退回插件选中地址 `chosen` 的四种清单：找不到这个平台条目、条目没有 x-sources、x-sources 不是数组、
    /// x-sources 一条都不能用。
    fn fallback_manifests(chosen: &str) -> Vec<Value> {
        vec![
            manifest(json!({})),
            manifest(json!({ TARGET: entry_at(chosen, json!({})) })),
            manifest(json!({ TARGET: entry_at(chosen, json!({ "x-sources": "cn" })) })),
            manifest(json!({ TARGET: entry_at(
                chosen,
                json!({ "x-sources": [listed("us", &cn_url()), listed("cn", "ftp://x/pkg.exe")] }),
            ) })),
        ]
    }

    /// 退回的地址过的是与 x-sources 每条相同的校验：不是 https、主机不在白名单、带端口、带用户信息、github.com 上不是
    /// 本仓库的附件都被拒，四条退回的路上哪一条都一样。被拒时一个源都不试，报下载失败，detail.sources 只有一条
    /// default，原文写明地址与原因。
    #[test]
    fn a_fallback_url_failing_the_source_checks_is_refused() {
        let github = ALLOWED_SOURCE_HOSTS[3];
        let path = "owner/repo/releases/download/dev-build/pkg-0.1.0-dev.36-x64.exe";
        for (chosen, reason) in [
            (
                format!("https://{github}/{path}"),
                "GitHub 上的地址不是本仓库 Releases 的附件",
            ),
            (format!("http://{github}/{path}"), "地址不是 https"),
            (
                format!("https://downloads.example.com/{path}"),
                "主机不在白名单里",
            ),
            (format!("https://{github}:8443/{path}"), "地址带了端口"),
            (
                format!("https://mirror@{github}/{path}"),
                "地址带了用户信息",
            ),
        ] {
            for raw in fallback_manifests(&chosen) {
                let err = package_plan(&raw, &url(&chosen), SIGNATURE)
                    .expect_err(&format!("{chosen} 没被拒：{raw}"));
                let message = format!("清单给的下载地址 {chosen} 没有通过校验：{reason}");
                assert_eq!(err.code, code::UPDATE_DOWNLOAD_FAILED, "{chosen}");
                assert_eq!(err.message, message, "{raw}");
                assert_eq!(
                    err.detail,
                    Some(json!({
                        "sources": [{ "source": "default", "failure": "other", "message": message }],
                    })),
                    "{raw}"
                );
            }
        }
    }

    /// github.com 在白名单里：退回到它照常下载，四条退回的路上都一样。
    #[test]
    fn a_fallback_url_on_github_is_accepted() {
        let chosen = github_url();
        for raw in fallback_manifests(&chosen) {
            let plan = package_plan(&raw, &url(&chosen), SIGNATURE)
                .unwrap_or_else(|err| panic!("{raw} 被拒：{err:?}"));
            assert_eq!(
                plan.sources,
                vec![source("default", &chosen, SourceRegion::Domestic)],
                "{raw}"
            );
        }
    }

    /// x-sources 有能用的源时根本不用插件选中的地址，它过不过校验都不影响这次下载。
    #[test]
    fn a_refused_chosen_url_does_not_matter_when_listed_sources_are_usable() {
        let chosen = hk_url().replacen("https://", "http://", 1);
        let raw = manifest(json!({ TARGET: entry_at(
            &chosen,
            json!({ "x-sources": [listed("hk", &hk_url())] }),
        ) }));
        let plan = package_plan(&raw, &url(&chosen), SIGNATURE).unwrap();
        assert_eq!(
            plan.sources,
            vec![source("hk", &hk_url(), SourceRegion::Domestic)]
        );
    }

    fn cn_source() -> PackageSource {
        source("cn", &cn_url(), SourceRegion::Domestic)
    }

    fn judged(err: AttemptError) -> (FailureKind, Verdict, String) {
        let failure = judge(&cn_source(), err);
        assert_eq!(failure.source, "cn");
        (failure.failure, failure.verdict, failure.message)
    }

    fn plugin(err: UpdaterError) -> (FailureKind, Verdict, String) {
        judged(AttemptError::Plugin(err))
    }

    /// 本地端口刚释放，连接被拒。
    async fn refused() -> UpdaterError {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/pkg.exe", listener.local_addr().unwrap());
        drop(listener);
        let err = petalfall_base::http::build_client()
            .unwrap()
            .get(&url)
            .send()
            .await
            .unwrap_err();
        UpdaterError::Reqwest(err)
    }

    /// 监听着但从不接受连接：内核的等待队列替它完成握手，请求发出去后等不到响应头。
    async fn timed_out() -> UpdaterError {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/pkg.exe", listener.local_addr().unwrap());
        let err = petalfall_base::http::build_client()
            .unwrap()
            .get(&url)
            .timeout(Duration::from_millis(300))
            .send()
            .await
            .unwrap_err();
        drop(listener);
        UpdaterError::Reqwest(err)
    }

    /// 只接一个连接的本地服务：读完请求头，原样写回 `reply`，随即关掉连接。返回请求地址与服务线程。
    fn serve_once(reply: Vec<u8>) -> (String, std::thread::JoinHandle<()>) {
        use std::io::{Read, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/pkg.exe", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut head = Vec::new();
            let mut byte = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).unwrap();
                head.push(byte[0]);
            }
            stream.write_all(&reply).unwrap();
        });
        (url, server)
    }

    /// 回了 200 和声明的长度，正文送了一部分就关掉连接。
    async fn cut_mid_body() -> UpdaterError {
        let mut reply = b"HTTP/1.1 200 OK\r\nContent-Length: 4096\r\n\r\n".to_vec();
        reply.extend_from_slice(&[7u8; 512]);
        let (url, server) = serve_once(reply);
        let response = petalfall_base::http::build_client()
            .unwrap()
            .get(&url)
            .send()
            .await
            .expect("响应头阶段就失败了，与被测的正文中途断开无关");
        let err = response.bytes().await.unwrap_err();
        server.join().unwrap();
        UpdaterError::Reqwest(err)
    }

    /// 地址解析不出来，reqwest 还没拿到地址就报构建错误：错误不带地址。
    async fn builder_failure() -> UpdaterError {
        let err = petalfall_base::http::build_client()
            .unwrap()
            .get("not a url")
            .send()
            .await
            .unwrap_err();
        assert!(err.is_builder(), "{err:?}");
        assert!(err.url().is_none(), "{err:?}");
        UpdaterError::Reqwest(err)
    }

    /// 源回 302 跳到 ftp：reqwest 不跟 http、https 以外的跳转，报带着跳转目标的构建错误。
    async fn redirected_off_http() -> UpdaterError {
        let (url, server) = serve_once(
            b"HTTP/1.1 302 Found\r\nLocation: ftp://x/\r\nContent-Length: 0\r\n\r\n".to_vec(),
        );
        let err = petalfall_base::http::build_client()
            .unwrap()
            .get(&url)
            .send()
            .await
            .unwrap_err();
        server.join().unwrap();
        assert!(err.is_builder(), "{err:?}");
        assert_eq!(
            err.url().map(|url| url.as_str()),
            Some("ftp://x/"),
            "{err:?}"
        );
        UpdaterError::Reqwest(err)
    }

    /// 地址长过 http::Uri 的上限（65534 字节）：解析成 `Url` 没问题，转成请求用的 Uri 时报带着这个地址的构建错误，
    /// 请求根本没发出去。
    async fn overlong_url() -> UpdaterError {
        let raw = format!("http://127.0.0.1/{}", "a".repeat(70_000));
        let err = petalfall_base::http::build_client()
            .unwrap()
            .get(&raw)
            .send()
            .await
            .unwrap_err();
        assert!(err.is_builder(), "{err:?}");
        assert_eq!(err.url().map(|url| url.as_str()), Some(raw.as_str()));
        UpdaterError::Reqwest(err)
    }

    #[test]
    fn a_stalled_source_is_a_timeout_and_the_next_source_is_tried() {
        assert_eq!(
            judged(AttemptError::Stalled),
            (
                FailureKind::Timeout,
                Verdict::NextSource,
                "下载长时间没有进展，已中止".to_owned()
            )
        );
    }

    /// 超过清单声明的大小与超过硬上限都换下一个源；压在硬上限上的不说成清单声明的，清单可能根本没写大小。
    #[test]
    fn an_oversized_download_moves_on_to_the_next_source() {
        for (limit, expected) in [
            (SIZE, "下载的数据超过了清单声明的 22846361 字节，已中止"),
            (
                MAX_PACKAGE_SIZE - 1,
                "下载的数据超过了清单声明的 268435455 字节，已中止",
            ),
            (
                MAX_PACKAGE_SIZE,
                "下载的数据超过了更新包大小的硬上限 268435456 字节，已中止",
            ),
        ] {
            let (failure, verdict, message) = judged(AttemptError::TooLarge { limit });
            assert_eq!(
                (failure, verdict),
                (FailureKind::TooLarge, Verdict::NextSource)
            );
            assert_eq!(message, expected);
        }
    }

    /// 连不上、等不到、正文中途断开、回了错误状态码，都只是这一个源的问题，换下一个源；原文留在 message。
    #[tokio::test]
    async fn transport_failures_move_on_to_the_next_source() {
        let connect = refused().await;
        let raw = connect.to_string();
        assert_eq!(
            plugin(connect),
            (FailureKind::Connect, Verdict::NextSource, raw)
        );

        let timeout = timed_out().await;
        let raw = timeout.to_string();
        assert_eq!(
            plugin(timeout),
            (FailureKind::Timeout, Verdict::NextSource, raw)
        );

        let body = cut_mid_body().await;
        let raw = body.to_string();
        assert_eq!(plugin(body), (FailureKind::Http, Verdict::NextSource, raw));

        assert_eq!(
            plugin(UpdaterError::Network(
                "Download request failed with status: 503 Service Unavailable".into()
            )),
            (
                FailureKind::Http,
                Verdict::NextSource,
                "`Download request failed with status: 503 Service Unavailable`".to_owned()
            )
        );
    }

    /// 清单的签名串不是合法 base64 时插件报的错：插件验签时用的就是标准字母表的这个引擎。
    fn undecodable_signature() -> UpdaterError {
        use base64::Engine;

        let truncated = &SIGNATURE[..SIGNATURE.len() - 3];
        let err = base64::engine::general_purpose::STANDARD
            .decode(format!("{truncated}@"))
            .unwrap_err();
        UpdaterError::Base64(err)
    }

    /// 签名串本身、签名版本出了问题，换哪个源都是同一个签名：立即停，记成签名失败。
    #[test]
    fn signature_problems_in_the_manifest_stop_at_once() {
        for err in [
            undecodable_signature(),
            UpdaterError::SignatureUtf8("bad".into()),
            UpdaterError::SignedVersionMismatch {
                signed: "0.1.0-dev.12".into(),
                announced: "0.1.0-dev.40".into(),
            },
            UpdaterError::MissingSignedVersion,
        ] {
            let raw = err.to_string();
            assert_eq!(
                plugin(err),
                (FailureKind::Signature, Verdict::Stop, raw.clone()),
                "{raw}"
            );
        }
    }

    /// 只有字节对不上签名（InvalidSignature）说明这个源上的文件不对：记成签名失败，换下一个源。
    #[test]
    fn bytes_failing_the_signature_move_on_to_the_next_source() {
        assert_eq!(
            plugin(UpdaterError::Minisign(
                minisign_verify::Error::InvalidSignature
            )),
            (
                FailureKind::Signature,
                Verdict::NextSource,
                "The signature verification failed".to_owned()
            )
        );
    }

    /// 其余 Minisign 失败出在清单的签名或内置公钥上，与哪个源无关：签名换了钥匙、解不开、算法不认得，都立即停。
    #[test]
    fn minisign_failures_unrelated_to_the_source_stop_at_once() {
        assert_eq!(
            plugin(UpdaterError::Minisign(
                minisign_verify::Error::UnexpectedKeyId
            )),
            (
                FailureKind::Signature,
                Verdict::Stop,
                "The signature was created with a different key than the one provided".to_owned()
            )
        );
        for err in [
            minisign_verify::Error::InvalidEncoding,
            minisign_verify::Error::UnexpectedAlgorithm,
            minisign_verify::Error::UnsupportedAlgorithm,
            minisign_verify::Error::UnsupportedLegacyMode,
            minisign_verify::Error::IoError(std::io::Error::other("unreadable key")),
        ] {
            let err = UpdaterError::Minisign(err);
            let raw = err.to_string();
            assert_eq!(
                plugin(err),
                (FailureKind::Signature, Verdict::Stop, raw.clone()),
                "{raw}"
            );
        }
    }

    /// 带地址的构建错误出在这个源的地址或它回的跳转上，不是本机的问题：记成 other，换下一个源。
    #[tokio::test]
    async fn construction_failures_tied_to_the_source_url_move_on_to_the_next_source() {
        for err in [redirected_off_http().await, overlong_url().await] {
            let raw = err.to_string();
            assert_eq!(
                plugin(err),
                (FailureKind::Other, Verdict::NextSource, raw.clone()),
                "{raw}"
            );
        }
    }

    /// 本机建不起请求（构建错误不带地址），换源也一样：立即停。
    #[tokio::test]
    async fn request_construction_failures_stop_at_once() {
        let builder = builder_failure().await;
        let raw = builder.to_string();
        assert_eq!(plugin(builder), (FailureKind::Other, Verdict::Stop, raw));

        let http = tauri::http::Response::builder()
            .status(1000u16)
            .body(())
            .unwrap_err();
        let value = tauri::http::HeaderValue::from_str("a\nb").unwrap_err();
        let name = tauri::http::HeaderName::from_bytes(b"bad name").unwrap_err();
        for err in [
            UpdaterError::Http(http),
            UpdaterError::InvalidHeaderValue(value),
            UpdaterError::InvalidHeaderName(name),
        ] {
            let raw = err.to_string();
            assert_eq!(
                plugin(err),
                (FailureKind::Other, Verdict::Stop, raw.clone()),
                "{raw}"
            );
        }
    }

    /// 下载时本不该出现的变体（代表插件将来新增的）：说不清是不是源的问题，换下一个源。
    #[test]
    fn unexpected_plugin_failures_move_on_to_the_next_source() {
        for err in [
            UpdaterError::Io(std::io::Error::other("disk full")),
            UpdaterError::ReleaseNotFound,
            UpdaterError::TargetNotFound(TARGET.into()),
        ] {
            let raw = err.to_string();
            assert_eq!(
                plugin(err),
                (FailureKind::Other, Verdict::NextSource, raw.clone()),
                "{raw}"
            );
        }
    }

    /// 判了换下一个源的一次失败。
    fn failed(source: &str, failure: FailureKind, message: &str) -> SourceFailure {
        SourceFailure {
            source: source.to_owned(),
            failure,
            verdict: Verdict::NextSource,
            message: message.to_owned(),
            causes: Vec::new(),
        }
    }

    /// 判了立即停的一次失败。
    fn stopped(source: &str, failure: FailureKind, message: &str) -> SourceFailure {
        SourceFailure {
            verdict: Verdict::Stop,
            ..failed(source, failure, message)
        }
    }

    fn sources_json(failures: &[SourceFailure]) -> Value {
        Value::Array(
            failures
                .iter()
                .map(|failure| {
                    json!({
                        "source": failure.source,
                        "failure": serde_json::to_value(failure.failure).unwrap(),
                        "message": failure.message,
                    })
                })
                .collect(),
        )
    }

    #[test]
    fn failure_kinds_serialize_to_their_stable_names() {
        let names: Vec<Value> = [
            FailureKind::Connect,
            FailureKind::Timeout,
            FailureKind::Http,
            FailureKind::Signature,
            FailureKind::TooLarge,
            FailureKind::Other,
        ]
        .iter()
        .map(|kind| serde_json::to_value(kind).unwrap())
        .collect();
        assert_eq!(
            names,
            [
                "connect",
                "timeout",
                "http",
                "signature",
                "too_large",
                "other"
            ]
        );
    }

    /// 所有已试源都是包被拒，才说签名无效；message 逐行写明是哪个源。
    #[test]
    fn every_source_rejected_by_signature_is_a_signature_failure() {
        let failures = vec![
            failed("cn", FailureKind::Signature, "Invalid signature"),
            failed("hk", FailureKind::Signature, "Invalid signature"),
        ];
        let err = sources_failed(failures.clone());
        assert_eq!(err.code, code::UPDATE_SIGNATURE_INVALID);
        assert_eq!(err.message, "cn：Invalid signature\nhk：Invalid signature");
        assert_eq!(
            err.detail,
            Some(json!({ "sources": sources_json(&failures) }))
        );
    }

    /// 最后一个源判的是 (signature, 立即停)：签名本身出了与源无关的问题，前面的源败在哪都照样报签名无效，
    /// 前面全败在网络层也不标 detail.network；判定不进 detail.sources。
    #[test]
    fn a_signature_failure_that_stopped_the_download_is_a_signature_failure() {
        for failures in [
            vec![
                failed("cn", FailureKind::Http, "503"),
                stopped("hk", FailureKind::Signature, "signed for 0.1.0-dev.12"),
            ],
            vec![
                failed("cn", FailureKind::Connect, "refused"),
                failed("hk", FailureKind::Timeout, "timed out"),
                stopped("global", FailureKind::Signature, "different key"),
            ],
            vec![stopped("cn", FailureKind::Signature, "different key")],
        ] {
            let err = sources_failed(failures.clone());
            assert_eq!(err.code, code::UPDATE_SIGNATURE_INVALID, "{failures:?}");
            assert_eq!(
                err.detail,
                Some(json!({ "sources": sources_json(&failures) })),
                "{failures:?}"
            );
        }
    }

    /// 立即停的不是签名失败（本机建不起请求），或签名失败判的是换源：照旧看是不是全是 signature。
    #[test]
    fn stopping_on_anything_but_the_signature_is_a_download_failure() {
        for failures in [
            vec![
                failed("cn", FailureKind::Signature, "Invalid signature"),
                stopped("hk", FailureKind::Other, "builder error"),
            ],
            vec![stopped("default", FailureKind::Other, "refused url")],
            vec![
                failed("cn", FailureKind::Http, "503"),
                failed("hk", FailureKind::Signature, "Invalid signature"),
            ],
        ] {
            let err = sources_failed(failures.clone());
            assert_eq!(err.code, code::UPDATE_DOWNLOAD_FAILED, "{failures:?}");
        }
    }

    /// 随机的失败序列（只有最后一条可能判了停）：全是 signature，或最后一条是 (signature, 立即停)，才报签名无效。
    #[test]
    fn signature_code_follows_every_source_or_the_one_that_stopped() {
        const KINDS: [FailureKind; 6] = [
            FailureKind::Connect,
            FailureKind::Timeout,
            FailureKind::Http,
            FailureKind::Signature,
            FailureKind::TooLarge,
            FailureKind::Other,
        ];
        let mut rng = fastrand::Rng::with_seed(0x51_6e_ed);
        for _ in 0..500 {
            let tried = rng.usize(1..=MAX_SOURCES);
            // 一半的轮次只取 signature 与另一种，否则全随机时几乎抽不到全是 signature 的组合
            let pool = if rng.bool() {
                vec![FailureKind::Signature, KINDS[rng.usize(..KINDS.len())]]
            } else {
                KINDS.to_vec()
            };
            let mut failures: Vec<SourceFailure> = (0..tried)
                .map(|index| failed(&format!("s{index}"), pool[rng.usize(..pool.len())], "x"))
                .collect();
            if rng.bool() {
                failures.last_mut().unwrap().verdict = Verdict::Stop;
            }
            let last = failures.last().unwrap();
            let expected = if failures
                .iter()
                .all(|failure| failure.failure == FailureKind::Signature)
                || (last.failure == FailureKind::Signature && last.verdict == Verdict::Stop)
            {
                code::UPDATE_SIGNATURE_INVALID
            } else {
                code::UPDATE_DOWNLOAD_FAILED
            };
            assert_eq!(
                sources_failed(failures.clone()).code,
                expected,
                "{failures:?}"
            );
        }
    }

    /// 混着别的失败就是下载失败；有一个不在网络层就不标 detail.network。
    #[test]
    fn mixed_failures_are_a_download_failure() {
        for failures in [
            vec![
                failed("cn", FailureKind::Connect, "refused"),
                failed("hk", FailureKind::Signature, "Invalid signature"),
            ],
            vec![
                failed("cn", FailureKind::Signature, "Invalid signature"),
                failed("hk", FailureKind::Timeout, "timed out"),
                failed("global", FailureKind::TooLarge, "too large"),
            ],
            vec![
                failed("cn", FailureKind::Timeout, "timed out"),
                failed("hk", FailureKind::Http, "503"),
            ],
            vec![
                failed("cn", FailureKind::Connect, "refused"),
                failed("hk", FailureKind::Other, "header"),
            ],
        ] {
            let err = sources_failed(failures.clone());
            assert_eq!(err.code, code::UPDATE_DOWNLOAD_FAILED, "{failures:?}");
            let lines: Vec<String> = failures
                .iter()
                .map(|failure| format!("{}：{}", failure.source, failure.message))
                .collect();
            assert_eq!(err.message, lines.join("\n"));
            assert_eq!(
                err.detail,
                Some(json!({ "sources": sources_json(&failures) })),
                "{failures:?}"
            );
        }
    }

    /// 全部败在网络层：全是超时才标 timeout，混着连不上就标 connect。
    #[test]
    fn all_network_failures_mark_the_network_kind() {
        let cases = [
            (
                vec![
                    failed("cn", FailureKind::Timeout, "a"),
                    failed("hk", FailureKind::Timeout, "b"),
                ],
                "timeout",
            ),
            (
                vec![
                    failed("cn", FailureKind::Timeout, "a"),
                    failed("global", FailureKind::Connect, "b"),
                    failed("github", FailureKind::Timeout, "c"),
                ],
                "connect",
            ),
            (
                vec![
                    failed("cn", FailureKind::Connect, "a"),
                    failed("hk", FailureKind::Connect, "b"),
                ],
                "connect",
            ),
        ];
        for (failures, network) in cases {
            let err = sources_failed(failures.clone());
            assert_eq!(err.code, code::UPDATE_DOWNLOAD_FAILED);
            assert_eq!(
                err.detail,
                Some(json!({ "network": network, "sources": sources_json(&failures) })),
                "{failures:?}"
            );
        }
    }

    /// 随机组合的失败种类：只有全是 connect、timeout 时才标网络层，且全是 timeout 才标 timeout。
    #[test]
    fn network_kind_follows_every_tried_source() {
        const KINDS: [FailureKind; 6] = [
            FailureKind::Connect,
            FailureKind::Timeout,
            FailureKind::Http,
            FailureKind::Signature,
            FailureKind::TooLarge,
            FailureKind::Other,
        ];
        let mut rng = fastrand::Rng::with_seed(0x5eed_50c5);
        for _ in 0..500 {
            let tried = rng.usize(1..=MAX_SOURCES);
            // 一半的轮次只从网络层两种里取，否则全随机时几乎抽不到全是网络层的组合
            let pool = if rng.bool() { &KINDS[..2] } else { &KINDS[..] };
            let kinds: Vec<FailureKind> =
                (0..tried).map(|_| pool[rng.usize(..pool.len())]).collect();
            let failures: Vec<SourceFailure> = kinds
                .iter()
                .enumerate()
                .map(|(index, kind)| failed(&format!("s{index}"), *kind, "x"))
                .collect();
            let network = sources_failed(failures)
                .detail
                .unwrap()
                .get("network")
                .cloned();
            let off_network = [
                FailureKind::Http,
                FailureKind::Signature,
                FailureKind::TooLarge,
                FailureKind::Other,
            ];
            let expected = if kinds.iter().any(|kind| off_network.contains(kind)) {
                None
            } else if kinds.contains(&FailureKind::Connect) {
                Some(json!("connect"))
            } else {
                Some(json!("timeout"))
            };
            assert_eq!(network, expected, "{kinds:?}");
        }
    }

    /// 只试了一个源时，code、message、detail.network 与 detail.causes 和多源下载上线前一模一样，只多了 detail.sources。
    #[tokio::test]
    async fn a_single_source_reads_like_the_single_source_download() {
        let connect = refused().await;
        let raw = connect.to_string();
        let causes = source_chain(&connect);
        assert!(!causes.is_empty(), "连接被拒应带着底层原因：{raw}");
        let failure = judge(&cn_source(), AttemptError::Plugin(connect));
        let err = sources_failed(vec![failure]);
        assert_eq!(err.code, code::UPDATE_DOWNLOAD_FAILED);
        assert_eq!(err.message, raw);
        assert_eq!(
            err.detail,
            Some(json!({
                "network": "connect",
                "causes": causes,
                "sources": [{
                    "source": "cn",
                    "failure": "connect",
                    "message": raw,
                    "causes": causes,
                }],
            }))
        );

        let failure = judge(&cn_source(), AttemptError::Stalled);
        let err = sources_failed(vec![failure.clone()]);
        assert_eq!(err.code, code::UPDATE_DOWNLOAD_FAILED);
        assert_eq!(err.message, "下载长时间没有进展，已中止");
        assert_eq!(
            err.detail,
            Some(json!({ "network": "timeout", "sources": sources_json(&[failure]) }))
        );

        for rejected in [
            undecodable_signature(),
            UpdaterError::SignatureUtf8("bad".into()),
        ] {
            let raw = rejected.to_string();
            let failure = judge(&cn_source(), AttemptError::Plugin(rejected));
            assert_eq!(failure.verdict, Verdict::Stop, "{raw}");
            let err = sources_failed(vec![failure.clone()]);
            assert_eq!(err.code, code::UPDATE_SIGNATURE_INVALID, "{raw}");
            assert_eq!(err.message, raw);
            assert_eq!(
                err.detail,
                Some(json!({ "sources": sources_json(&[failure]) })),
                "{raw}"
            );
        }

        let status = UpdaterError::Network(
            "Download request failed with status: 503 Service Unavailable".into(),
        );
        let failure = judge(&cn_source(), AttemptError::Plugin(status));
        let err = sources_failed(vec![failure]);
        assert_eq!(err.code, code::UPDATE_DOWNLOAD_FAILED);
        assert_eq!(
            err.message,
            "`Download request failed with status: 503 Service Unavailable`"
        );
        assert!(err.detail.unwrap().get("network").is_none());
    }

    /// 试了多个源时原因链各自跟着自己的源，不提到 detail.causes：混在一起就分不清是哪个源的底层原因。
    /// 没有原因链的源不写 causes 键。
    #[tokio::test]
    async fn several_sources_keep_their_own_causes() {
        let connect = refused().await;
        let raw = connect.to_string();
        let causes = source_chain(&connect);
        assert!(!causes.is_empty(), "连接被拒应带着底层原因：{raw}");
        let first = judge(&cn_source(), AttemptError::Plugin(connect));
        let hk = source("hk", &hk_url(), SourceRegion::Domestic);
        let second = judge(&hk, AttemptError::Stalled);
        let err = sources_failed(vec![first, second]);
        assert_eq!(err.code, code::UPDATE_DOWNLOAD_FAILED);
        assert_eq!(
            err.message,
            format!("cn：{raw}\nhk：下载长时间没有进展，已中止")
        );
        assert_eq!(
            err.detail,
            Some(json!({
                "network": "connect",
                "sources": [
                    { "source": "cn", "failure": "connect", "message": raw, "causes": causes },
                    { "source": "hk", "failure": "timeout", "message": "下载长时间没有进展，已中止" },
                ],
            }))
        );
    }

    #[test]
    #[should_panic(expected = "至少要有一个已试的源")]
    fn summarising_no_tried_source_is_a_bug() {
        sources_failed(Vec::new());
    }

    /// 判了立即停的失败与源无关：通用的失败日志不写源名与地址，写明与下载源无关，免得排查的人去查那个源。
    /// 换源的失败照旧点名源与地址。
    #[tokio::test]
    async fn failures_unrelated_to_the_source_are_logged_without_naming_it() {
        let captured = crate::tests::Captured::new();
        let writer = captured.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_writer(move || writer.clone())
            .finish();
        let _guard = tracing::subscriber::set_default(subscriber);
        let log_of = |err: AttemptError| {
            captured.0.lock().unwrap().clear();
            let verdict = judge(&cn_source(), err).verdict;
            (
                verdict,
                String::from_utf8(captured.0.lock().unwrap().clone()).unwrap(),
            )
        };

        let unrelated = [
            UpdaterError::Minisign(minisign_verify::Error::UnexpectedKeyId),
            undecodable_signature(),
            UpdaterError::SignedVersionMismatch {
                signed: "0.1.0-dev.12".into(),
                announced: "0.1.0-dev.40".into(),
            },
            builder_failure().await,
        ];
        for err in unrelated {
            let raw = err.to_string();
            let (verdict, log) = log_of(AttemptError::Plugin(err));
            assert_eq!(verdict, Verdict::Stop, "{raw}");
            assert!(log.contains("WARN"), "{log}");
            assert!(log.contains("与下载源无关"), "{log}");
            assert!(log.contains(&raw), "{log}");
            assert!(!log.contains("source="), "{log}");
            assert!(!log.contains(ALLOWED_SOURCE_HOSTS[0]), "{log}");
        }

        for err in [
            AttemptError::Plugin(UpdaterError::Minisign(
                minisign_verify::Error::InvalidSignature,
            )),
            AttemptError::Stalled,
            AttemptError::Plugin(redirected_off_http().await),
        ] {
            let (verdict, log) = log_of(err);
            assert_eq!(verdict, Verdict::NextSource, "{log}");
            assert!(log.contains("更新包下载源失败"), "{log}");
            assert!(log.contains("source=cn"), "{log}");
            assert!(log.contains(&cn_url()), "{log}");
            assert!(!log.contains("与下载源无关"), "{log}");
        }
    }
}
