//! Forge 与 NeoForge 的可用版本。
//!
//! 两者都没有 Fabric meta 那样「按游戏版本列出 loader」的接口，只有 Maven 仓库的 `maven-metadata.xml`：
//! 一份列出该构件的全部版本号。游戏版本要从版本号里推出来：
//! - Forge：`<游戏版本>-<Forge 版本>[-分支]`，如 `1.20.1-47.2.0`、`1.11-13.19.0.2129-1.11.x`。
//! - NeoForge（`net.neoforged:neoforge`）：1.20.2 到 1.21.x 用三段式 `<次版本>.<修订>.<构建>`，
//!   `21.1.77` 对应 1.21.1、`21.0.x` 对应 1.21；26 年起游戏改用年份版本号，NeoForge 跟着用四段式
//!   `<年>.<版本>.<修订>.<构建>`，`26.1.2.125` 对应 26.1.2、`26.3.0.85` 对应 26.3，
//!   快照与预发布构建在 `+` 后标明对应的游戏快照，如 `26.1.0.0-alpha.1+snapshot-1` 对应 26.1-snapshot-1。
//! - NeoForge 的 1.20.1 沿用 Forge 的坐标与版本号（`net.neoforged:forge`，`1.20.1-47.1.106`）。

use std::cmp::Ordering;

use aurora_base::retry::RetryPolicy;
use aurora_download::{CancellationToken, SourcePlan};
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::fabric::{is_prerelease, prerelease_at};
use crate::net;

/// Forge 的版本列表。
pub const FORGE_MAVEN_METADATA: &str =
    "https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml";
/// NeoForge（1.20.2 起）的版本列表。
pub const NEOFORGE_MAVEN_METADATA: &str =
    "https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml";
/// NeoForge 1.20.1 的版本列表（沿用 Forge 坐标）。
pub const NEOFORGE_LEGACY_MAVEN_METADATA: &str =
    "https://maven.neoforged.net/releases/net/neoforged/forge/maven-metadata.xml";

/// NeoForge 1.20.1 构建的版本号前缀（Forge 47 分支）。现代 NeoForge 的版本号不会以 47 开头。
pub(crate) const NEOFORGE_LEGACY_PREFIX: &str = "47.";

/// 一个可安装的加载器构建。可序列化，供上层把列表缓存到磁盘、离线时沿用。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LoaderBuild {
    /// 对应的游戏版本，与版本清单里的 id 同形。
    pub mc_version: String,
    /// 加载器版本号，即安装时传给 installer 地址拼接函数的那一段。
    pub version: String,
}

impl LoaderBuild {
    /// 是否为稳定版：版本号里没有 beta / alpha / rc / pre 之类的预发布标记。
    pub fn stable(&self) -> bool {
        !is_prerelease(&self.version)
    }
}

/// 取出 `maven-metadata.xml` 里全部 `<version>` 的内容，保持原顺序。
pub fn parse_maven_versions(xml: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find("<version>") {
        rest = &rest[start + "<version>".len()..];
        let Some(end) = rest.find("</version>") else {
            break;
        };
        let value = rest[..end].trim();
        if !value.is_empty() {
            out.push(value.to_owned());
        }
        rest = &rest[end..];
    }
    out
}

/// 由 Forge 的 Maven 版本号推出构建列表；没有 `-` 的条目（不带游戏版本）跳过。
pub fn forge_builds(maven_versions: &[String]) -> Vec<LoaderBuild> {
    maven_versions
        .iter()
        .filter_map(|v| {
            let (mc, forge) = v.split_once('-')?;
            (!mc.is_empty() && !forge.is_empty()).then(|| LoaderBuild {
                mc_version: mc.to_owned(),
                version: forge.to_owned(),
            })
        })
        .collect()
}

/// 由现代 NeoForge 的版本号推出对应的游戏版本；认不出的格式返回 `None`。
pub fn neoforge_mc_version(version: &str) -> Option<String> {
    let (base, snapshot) = match version.split_once('+') {
        Some((base, tag)) => (base, Some(tag)),
        None => (version, None),
    };
    let numeric = base.split('-').next()?;
    // 愚人节特别版：`0.25w14craftmine.3` 对应游戏版本 25w14craftmine。
    if let Some(rest) = numeric.strip_prefix("0.") {
        return rest
            .split('.')
            .next()
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
    }
    let parts: Vec<u32> = numeric
        .split('.')
        .map(str::parse)
        .collect::<std::result::Result<_, _>>()
        .ok()?;
    let release = match parts.as_slice() {
        [major, minor, _build] => {
            if *minor == 0 {
                format!("1.{major}")
            } else {
                format!("1.{major}.{minor}")
            }
        }
        [year, drop, patch, _build] => {
            if *patch == 0 {
                format!("{year}.{drop}")
            } else {
                format!("{year}.{drop}.{patch}")
            }
        }
        _ => return None,
    };
    Some(match snapshot {
        Some(tag) => format!("{release}-{tag}"),
        None => release,
    })
}

/// 合并现代 NeoForge 与 1.20.1 旧坐标的构建列表。
pub fn neoforge_builds(modern: &[String], legacy: &[String]) -> Vec<LoaderBuild> {
    let mut builds: Vec<LoaderBuild> = modern
        .iter()
        .filter_map(|v| {
            neoforge_mc_version(v).map(|mc| LoaderBuild {
                mc_version: mc,
                version: v.clone(),
            })
        })
        .collect();
    builds.extend(
        forge_builds(legacy)
            .into_iter()
            .filter(|b| b.version.starts_with(NEOFORGE_LEGACY_PREFIX)),
    );
    builds
}

/// 版本号比较：先按预发布标记之前的数字逐段比，相同时不带预发布标记的更新，再比标记后面的序号。
/// 序号不能混进前面一起比：`0.30.2-beta.1` 是 `0.30.2` 发布之前的版本，不是它的第四段。
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    fn numbers(v: &str) -> Vec<u64> {
        v.split(|c: char| !c.is_ascii_digit())
            .filter(|s| !s.is_empty())
            .map(|s| s.parse().unwrap_or(u64::MAX))
            .collect()
    }
    fn split(v: &str) -> (&str, &str) {
        v.split_at(prerelease_at(v).unwrap_or(v.len()))
    }
    let (release_a, tail_a) = split(a);
    let (release_b, tail_b) = split(b);
    numbers(release_a)
        .cmp(&numbers(release_b))
        .then_with(|| is_prerelease(b).cmp(&is_prerelease(a)))
        .then_with(|| numbers(tail_a).cmp(&numbers(tail_b)))
        .then_with(|| a.cmp(b))
}

/// 某游戏版本的构建，新的在前。
pub fn builds_for(builds: &[LoaderBuild], mc_version: &str) -> Vec<LoaderBuild> {
    let mut matching: Vec<LoaderBuild> = builds
        .iter()
        .filter(|b| b.mc_version == mc_version)
        .cloned()
        .collect();
    matching.sort_by(|a, b| compare_versions(&b.version, &a.version));
    matching
}

/// 抓取并解析一份 `maven-metadata.xml`；`cancel` 触发即以已取消返回。
pub async fn fetch_maven_versions(
    client: &reqwest::Client,
    sources: Option<&SourcePlan>,
    url: &str,
    policy: &RetryPolicy,
    cancel: Option<&CancellationToken>,
) -> Result<Vec<String>> {
    net::get_decoded_from(
        client,
        sources,
        url,
        policy,
        cancel,
        "maven-metadata",
        |bytes| {
            let xml = String::from_utf8(bytes).map_err(|err| Error::UnsupportedInstallProfile {
                reason: format!("{url} 不是 UTF-8 文本：{err}"),
            })?;
            // 读不出版本的多半是镜像回的错误页，不能当成空列表：调用方会把它写进缓存，盖掉上次的好列表。
            let versions = parse_maven_versions(&xml);
            if versions.is_empty() {
                return Err(Error::UnsupportedInstallProfile {
                    reason: format!("{url} 里没有版本号"),
                });
            }
            Ok(versions)
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_owned()).collect()
    }

    /// 第一个源回 200 的错误页读不出版本：换下一个源。空列表交出去的话，调用方还会把它写进缓存，
    /// 把上次的好列表盖掉；每个源都读不出版本时要报错。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_garbled_metadata_page_moves_on_to_the_next_source() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/garbled"))
            .respond_with(ResponseTemplate::new(200).set_body_string("<html>维护中</html>"))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/clean"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                "<metadata><versioning><versions><version>1.20.1-47.2.0</version></versions></versioning></metadata>",
            ))
            .mount(&server)
            .await;
        let client = aurora_base::http::build_client().unwrap();
        let policy = RetryPolicy {
            max_attempts: 1,
            initial_delay: std::time::Duration::from_millis(1),
            max_delay: std::time::Duration::from_millis(1),
            multiplier: 1.0,
            jitter: false,
        };
        let url = "https://maven.invalid/maven-metadata.xml";

        let plan = crate::net::tests::plan_between(&server, "/garbled", "/clean");
        let versions = fetch_maven_versions(&client, Some(&plan), url, &policy, None)
            .await
            .unwrap();
        assert_eq!(versions, strings(&["1.20.1-47.2.0"]));

        let plan = crate::net::tests::plan_between(&server, "/garbled", "/garbled");
        let err = fetch_maven_versions(&client, Some(&plan), url, &policy, None)
            .await
            .unwrap_err();
        assert!(
            matches!(&err, Error::UnsupportedInstallProfile { reason } if reason.contains("没有版本号")),
            "实际：{err:?}"
        );
    }

    #[test]
    fn maven_metadata_versions_are_extracted_in_order() {
        let xml = "<metadata><versioning><latest>2</latest><versions>\n  <version>1.21-51.0.33</version>\n  <version> 1.20.1-47.2.0 </version>\n<version></version></versions></versioning></metadata>";
        assert_eq!(
            parse_maven_versions(xml),
            strings(&["1.21-51.0.33", "1.20.1-47.2.0"])
        );
    }

    #[test]
    fn forge_versions_split_at_the_first_dash() {
        let builds = forge_builds(&strings(&[
            "1.20.1-47.2.0",
            "1.11-13.19.0.2129-1.11.x",
            "weird",
            "26.3-66.1.2",
        ]));
        assert_eq!(
            builds,
            vec![
                LoaderBuild {
                    mc_version: "1.20.1".into(),
                    version: "47.2.0".into()
                },
                LoaderBuild {
                    mc_version: "1.11".into(),
                    version: "13.19.0.2129-1.11.x".into()
                },
                LoaderBuild {
                    mc_version: "26.3".into(),
                    version: "66.1.2".into()
                },
            ]
        );
    }

    #[test]
    fn neoforge_versions_map_to_game_versions() {
        let cases = [
            ("20.2.3-beta", Some("1.20.2")),
            ("20.4.80-beta", Some("1.20.4")),
            ("21.0.167", Some("1.21")),
            ("21.1.77", Some("1.21.1")),
            ("21.11.4", Some("1.21.11")),
            ("26.1.2.125", Some("26.1.2")),
            ("26.3.0.85", Some("26.3")),
            ("26.1.0.0-alpha.1+snapshot-1", Some("26.1-snapshot-1")),
            ("26.1.0.0-alpha.15+pre-3", Some("26.1-pre-3")),
            ("0.25w14craftmine.3", Some("25w14craftmine")),
            ("21.1", None),
            ("abc", None),
        ];
        for (version, mc) in cases {
            assert_eq!(neoforge_mc_version(version).as_deref(), mc, "{version}");
        }
    }

    #[test]
    fn neoforge_builds_include_the_legacy_1_20_1_line_only() {
        let builds = neoforge_builds(
            &strings(&["21.1.77", "garbage"]),
            &strings(&["1.20.1-47.1.106", "1.20.1-47.1.3"]),
        );
        let pairs: Vec<(&str, &str)> = builds
            .iter()
            .map(|b| (b.mc_version.as_str(), b.version.as_str()))
            .collect();
        assert_eq!(
            pairs,
            vec![
                ("1.21.1", "21.1.77"),
                ("1.20.1", "47.1.106"),
                ("1.20.1", "47.1.3")
            ]
        );
    }

    #[test]
    fn builds_for_sorts_numerically_newest_first_with_releases_above_betas() {
        let builds = vec![
            LoaderBuild {
                mc_version: "1.20.4".into(),
                version: "20.4.9-beta".into(),
            },
            LoaderBuild {
                mc_version: "1.20.4".into(),
                version: "20.4.80-beta".into(),
            },
            LoaderBuild {
                mc_version: "1.20.4".into(),
                version: "20.4.80".into(),
            },
            LoaderBuild {
                mc_version: "1.20.4".into(),
                version: "20.4.237".into(),
            },
            LoaderBuild {
                mc_version: "1.21".into(),
                version: "21.0.1".into(),
            },
        ];
        let sorted: Vec<String> = builds_for(&builds, "1.20.4")
            .into_iter()
            .map(|b| b.version)
            .collect();
        assert_eq!(
            sorted,
            strings(&["20.4.237", "20.4.80", "20.4.80-beta", "20.4.9-beta"])
        );
        assert!(builds_for(&builds, "1.19").is_empty());
        assert!(!builds[0].stable());
        assert!(builds[2].stable());
    }

    /// 预发布序号不是第四段版本号：`0.30.2-beta.1` 是 `0.30.2` 发布之前的版本。
    #[test]
    fn prerelease_counters_rank_inside_their_release() {
        assert_eq!(compare_versions("0.30.2-beta.1", "0.30.2"), Ordering::Less);
        assert_eq!(
            compare_versions("0.20.0-beta.9", "0.20.0-beta.10"),
            Ordering::Less
        );
        assert_eq!(
            compare_versions("0.31.0-beta.1", "0.30.2"),
            Ordering::Greater
        );
        assert_eq!(
            compare_versions("1.20.1-47.3.0", "1.20.1-47.2.20"),
            Ordering::Greater
        );
    }
}
