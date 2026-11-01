//! 下载凭据：只发给指定主机的请求头。
//!
//! CurseForge 的 CDN 下载要带与 API 相同的 `x-api-key`。这个 key 一旦随跳转或镜像改写落到别的主机上，
//! 就等于交给了第三方，所以凭据自带作用域：引擎对每一跳、每个候选源各自判定，只有作用域内的请求才带头。

use std::fmt;

use reqwest::Url;
use reqwest::header::{HeaderName, HeaderValue};

use crate::error::{Error, Result};

/// 凭据属于哪个平台。命令层按它挑错误码与提示文案。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CredentialRealm {
    CurseForge,
}

impl CredentialRealm {
    /// 给用户看的平台名。
    pub fn display_name(self) -> &'static str {
        match self {
            CredentialRealm::CurseForge => "CurseForge",
        }
    }

    /// 交给前端的稳定名字。
    pub fn code(self) -> &'static str {
        match self {
            CredentialRealm::CurseForge => "curseforge",
        }
    }
}

/// 一条主机规则。主机一律存小写。
#[derive(Debug, Clone, PartialEq, Eq)]
enum HostRule {
    /// 主机精确匹配，端口不限。
    Host(String),
    /// 主机与端口都精确匹配；端口按协议默认值补齐后比较。
    HostPort(String, u16),
    /// 该域本身及其全部子域。存的是去掉前导点的域名。
    Suffix(String),
}

impl HostRule {
    fn parse(rule: &str) -> Self {
        let rule = rule.trim().to_ascii_lowercase();
        if let Some(domain) = rule.strip_prefix('.') {
            return HostRule::Suffix(domain.to_owned());
        }
        if let Some((host, port)) = rule.rsplit_once(':')
            && let Ok(port) = port.parse::<u16>()
            && is_host_part(host)
        {
            return HostRule::HostPort(host.to_owned(), port);
        }
        HostRule::Host(rule)
    }

    fn matches(&self, host: &str, port: Option<u16>) -> bool {
        match self {
            HostRule::Host(expected) => host.eq_ignore_ascii_case(expected),
            HostRule::HostPort(expected, expected_port) => {
                host.eq_ignore_ascii_case(expected) && port == Some(*expected_port)
            }
            // 空域名的后缀规则什么都不认：否则以点结尾的主机名都会被它放行。
            HostRule::Suffix(domain) if domain.is_empty() => false,
            HostRule::Suffix(domain) => {
                let host = host.to_ascii_lowercase();
                host == *domain
                    || host
                        .strip_suffix(domain.as_str())
                        .is_some_and(|rest| rest.ends_with('.'))
            }
        }
    }
}

/// `host:port` 里冒号前那段能不能当主机：IPv6 字面量必须带方括号，否则冒号是地址的一部分。
fn is_host_part(host: &str) -> bool {
    !host.is_empty() && (!host.contains(':') || (host.starts_with('[') && host.ends_with(']')))
}

/// 凭据可以发往哪些地址。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialScope {
    rules: Vec<HostRule>,
    https_only: bool,
}

impl CredentialScope {
    /// forgecdn.net 本身及其全部子域，只认 https。edge.forgecdn.net 与它 302 去的
    /// mediafilez.forgecdn.net 都在里面。
    pub fn curseforge_cdn() -> Self {
        Self::new([".forgecdn.net"], true)
    }

    /// 规则串三种写法：`host`（主机精确匹配、端口不限）、`host:port`（主机与端口都精确）、
    /// `.suffix`（该域本身及全部子域）。主机比较不分大小写。
    pub fn new<I, S>(rules: I, https_only: bool) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            rules: rules
                .into_iter()
                .map(|rule| HostRule::parse(&rule.into()))
                .collect(),
            https_only,
        }
    }

    /// 这个地址在不在作用域内。
    pub fn allows(&self, url: &Url) -> bool {
        if self.https_only && url.scheme() != "https" {
            return false;
        }
        let Some(host) = url.host_str() else {
            return false;
        };
        let port = url.port_or_known_default();
        self.rules.iter().any(|rule| rule.matches(host, port))
    }
}

/// 一份下载凭据：请求头、它的值与作用域。
#[derive(Clone, PartialEq, Eq)]
pub struct DownloadCredential {
    realm: CredentialRealm,
    header: HeaderName,
    value: HeaderValue,
    scope: CredentialScope,
}

impl DownloadCredential {
    /// CurseForge CDN 的下载密钥：头名 `x-api-key`，作用域 [`CredentialScope::curseforge_cdn`]。
    ///
    /// key 去掉首尾空白后为空，或含不能放进请求头的字符，报 [`Error::InvalidCredential`]。
    pub fn curseforge(api_key: &str) -> Result<Self> {
        let realm = CredentialRealm::CurseForge;
        let key = api_key.trim();
        if key.is_empty() {
            return Err(Error::InvalidCredential { realm });
        }
        // InvalidHeaderValue 不带任何信息，换成带平台的错误不丢线索，也不会把 key 带进错误链。
        let mut value =
            HeaderValue::from_str(key).map_err(|_| Error::InvalidCredential { realm })?;
        // 标成敏感后，reqwest 与 http 的 Debug 输出只写 Sensitive。
        value.set_sensitive(true);
        Ok(Self {
            realm,
            header: HeaderName::from_static("x-api-key"),
            value,
            scope: CredentialScope::curseforge_cdn(),
        })
    }

    /// 换一个作用域。测试用它把凭据限定到本地 mock 服务器上。
    pub fn with_scope(mut self, scope: CredentialScope) -> Self {
        self.scope = scope;
        self
    }

    pub fn realm(&self) -> CredentialRealm {
        self.realm
    }

    pub fn header_name(&self) -> &HeaderName {
        &self.header
    }

    /// 这个地址的请求该不该带上凭据。
    pub fn applies_to(&self, url: &Url) -> bool {
        self.scope.allows(url)
    }

    pub(crate) fn header_value(&self) -> &HeaderValue {
        &self.value
    }
}

/// 任务的 Debug 会进日志，密钥绝不能出现在里面。
impl fmt::Debug for DownloadCredential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DownloadCredential")
            .field("realm", &self.realm)
            .field("value", &"<redacted>")
            .field("scope", &self.scope)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(raw: &str) -> Url {
        Url::parse(raw).unwrap()
    }

    #[test]
    fn curseforge_cdn_scope_covers_forgecdn_and_its_subdomains_over_https_only() {
        let scope = CredentialScope::curseforge_cdn();
        for allowed in [
            "https://edge.forgecdn.net/files/3040/523/jei.jar",
            "https://mediafilez.forgecdn.net/files/3040/523/jei.jar",
            "https://forgecdn.net/x",
            "https://EDGE.ForgeCDN.net/x",
            "https://a.b.forgecdn.net:8443/x",
        ] {
            assert!(scope.allows(&url(allowed)), "{allowed} 应在作用域内");
        }
        for denied in [
            "http://edge.forgecdn.net/files/3040/523/jei.jar",
            "https://evilforgecdn.net/x",
            "https://forgecdn.net.evil.com/x",
            "https://cdn.modrinth.com/data/a.jar",
            "https://bmclapi2.bangbang93.com/maven/a.jar",
            "https://api.curseforge.com/v1/mods/1",
        ] {
            assert!(!scope.allows(&url(denied)), "{denied} 不应在作用域内");
        }
    }

    #[test]
    fn host_rules_match_exact_host_with_or_without_port() {
        let any_port = CredentialScope::new(["Example.COM"], false);
        assert!(any_port.allows(&url("http://example.com/a")));
        assert!(any_port.allows(&url("https://example.com:9000/a")));
        assert!(!any_port.allows(&url("https://sub.example.com/a")));

        let pinned = CredentialScope::new(["127.0.0.1:4100"], false);
        assert!(pinned.allows(&url("http://127.0.0.1:4100/file")));
        assert!(!pinned.allows(&url("http://127.0.0.1:4101/file")));
        assert!(!pinned.allows(&url("http://127.0.0.2:4100/file")));

        // 端口按协议默认值补齐后比较。
        let default_port = CredentialScope::new(["edge.forgecdn.net:443"], true);
        assert!(default_port.allows(&url("https://edge.forgecdn.net/a")));
        assert!(!default_port.allows(&url("https://edge.forgecdn.net:444/a")));

        let ipv6 = CredentialScope::new(["[::1]:8080"], false);
        assert!(ipv6.allows(&url("http://[::1]:8080/a")));
        assert!(!ipv6.allows(&url("http://[::1]:8081/a")));
    }

    #[test]
    fn degenerate_rules_match_nothing() {
        let scope = CredentialScope::new(["", ".", "host:notaport"], false);
        for raw in [
            "http://host/a",
            "http://example.com./a",
            "http://127.0.0.1:80/a",
        ] {
            assert!(!scope.allows(&url(raw)), "{raw}");
        }
        assert!(!CredentialScope::new(Vec::<String>::new(), false).allows(&url("http://a/b")));
    }

    #[test]
    fn curseforge_credential_trims_the_key_and_targets_the_cdn() {
        let credential = DownloadCredential::curseforge("  key-123  ").unwrap();
        assert_eq!(credential.realm(), CredentialRealm::CurseForge);
        assert_eq!(credential.header_name().as_str(), "x-api-key");
        assert_eq!(credential.header_value().as_bytes(), b"key-123");
        assert!(credential.header_value().is_sensitive());
        assert!(credential.applies_to(&url("https://edge.forgecdn.net/files/1/2/a.jar")));
        assert!(!credential.applies_to(&url("https://cdn.modrinth.com/a.jar")));

        let rescoped = credential.with_scope(CredentialScope::new(["127.0.0.1:9"], false));
        assert!(rescoped.applies_to(&url("http://127.0.0.1:9/a")));
        assert!(!rescoped.applies_to(&url("https://edge.forgecdn.net/a")));
    }

    #[test]
    fn blank_or_unsendable_keys_are_rejected() {
        for bad in ["", "   ", "\t\n", "abc\ndef", "abc\u{7f}def"] {
            let err = DownloadCredential::curseforge(bad).unwrap_err();
            assert!(
                matches!(
                    err,
                    Error::InvalidCredential {
                        realm: CredentialRealm::CurseForge
                    }
                ),
                "{bad:?} 实际：{err:?}"
            );
        }
    }

    #[test]
    fn debug_output_never_contains_the_key() {
        let secret = "$2a$10$verySecretKeyMaterial0123456789";
        let credential = DownloadCredential::curseforge(secret).unwrap();
        let printed = format!("{credential:?}");
        assert!(!printed.contains(secret), "{printed}");
        assert!(!printed.contains("verySecret"), "{printed}");
        assert!(printed.contains("<redacted>"), "{printed}");
        assert!(printed.contains("CurseForge"), "{printed}");

        let task = crate::DownloadTask::new("https://edge.forgecdn.net/a.jar", "a.jar")
            .with_credential(credential);
        let printed = format!("{task:?}");
        assert!(!printed.contains("verySecret"), "{printed}");
        assert!(printed.contains("<redacted>"), "{printed}");
    }

    #[test]
    fn realm_names_are_stable() {
        assert_eq!(CredentialRealm::CurseForge.display_name(), "CurseForge");
        assert_eq!(CredentialRealm::CurseForge.code(), "curseforge");
    }
}
