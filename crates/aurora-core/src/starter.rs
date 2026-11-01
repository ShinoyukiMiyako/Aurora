//! 新实例的开局 Mod 组合：每个加载器一张小表，列前置 API 与常用的性能优化 Mod。
//!
//! 表里只记 Modrinth 工程 id，不记版本号：能装哪个版本按实例的 MC 版本现查，表不会随着这些 Mod
//! 发新版而过时。查不到适配版本的项单独列出原因，界面据此说明「还没有适配」，而不是悄悄少装一个。

use aurora_modplatform::{ModLoader, ModVersionInfo, Platform, ReleaseChannel};
use serde::Serialize;

use crate::compat::{Compatibility, classify};
use crate::error::{CoreError, Result};
use crate::facade::Aurora;
use crate::modfs::bounded_map;

/// 同时在途的版本查询数。表最长 5 项，再多只是在平台的令牌桶前排队。
const STARTER_CONCURRENCY: usize = 4;

/// 表项的用途。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StarterGroup {
    /// 前置 API：大多数 Mod 都依赖它。
    Api,
    /// 性能优化。
    Performance,
}

/// 开局表的一项。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StarterEntry {
    pub group: StarterGroup,
    /// Modrinth 工程 id。
    pub project_id: &'static str,
    /// 展示名（工程标题）。
    pub name: &'static str,
}

const fn api(project_id: &'static str, name: &'static str) -> StarterEntry {
    StarterEntry {
        group: StarterGroup::Api,
        project_id,
        name,
    }
}

const fn performance(project_id: &'static str, name: &'static str) -> StarterEntry {
    StarterEntry {
        group: StarterGroup::Performance,
        project_id,
        name,
    }
}

// 工程 id 与工程级的 loaders 于 2026-10-31 经 Modrinth API 核对：
// GET https://api.modrinth.com/v2/projects?ids=["fabric-api","qsl","sodium","lithium","ferrite-core","modernfix"]
// （带 User-Agent，返回 200）。结果：
// - Fabric API = P7dR8mSH，loaders [fabric]
// - QFAPI/QSL = qvIfYCYJ，loaders [quilt]
// - Sodium = AANobbMI，loaders [fabric, neoforge, quilt]
// - Lithium = gvQqBUqZ，loaders [fabric, neoforge, quilt]
// - FerriteCore = uXXizFIs，loaders [fabric, forge, neoforge, quilt]
// - ModernFix = nmDcB62a，loaders [fabric, forge, neoforge]
// 某个加载器只收工程级 loaders 里写了它的项：ModernFix 没有 quilt，Sodium 与 Lithium 没有 forge。
// Forge 上第三方移植的 Sodium、Lithium 不收：维护者不同、版本节奏不同，出了问题玩家找不到正主。
const SODIUM: StarterEntry = performance("AANobbMI", "Sodium");
const LITHIUM: StarterEntry = performance("gvQqBUqZ", "Lithium");
const FERRITE_CORE: StarterEntry = performance("uXXizFIs", "FerriteCore");
const MODERN_FIX: StarterEntry = performance("nmDcB62a", "ModernFix");

const FABRIC: &[StarterEntry] = &[
    api("P7dR8mSH", "Fabric API"),
    SODIUM,
    LITHIUM,
    FERRITE_CORE,
    MODERN_FIX,
];
const QUILT: &[StarterEntry] = &[api("qvIfYCYJ", "QFAPI"), SODIUM, LITHIUM, FERRITE_CORE];
const NEOFORGE: &[StarterEntry] = &[SODIUM, LITHIUM, FERRITE_CORE, MODERN_FIX];
const FORGE: &[StarterEntry] = &[FERRITE_CORE, MODERN_FIX];

/// 某加载器的开局表，前置 API（若有）排在最前。LiteLoader 没有可列的项。
pub fn starter_table(loader: ModLoader) -> &'static [StarterEntry] {
    match loader {
        ModLoader::Fabric => FABRIC,
        ModLoader::Quilt => QUILT,
        ModLoader::NeoForge => NEOFORGE,
        ModLoader::Forge => FORGE,
        ModLoader::LiteLoader => &[],
    }
}

/// 表项装不上的原因。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StarterMissingReason {
    /// 工程在，但没有适配这个 MC 版本与加载器的版本。
    NoVersion,
    /// 平台上没有这个工程（内置表过时了）。
    NotFound,
}

/// 一项能装的开局 Mod 与挑中的版本。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StarterMod {
    pub entry: StarterEntry,
    pub version: ModVersionInfo,
}

/// 一项装不上的开局 Mod。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StarterMissing {
    pub entry: StarterEntry,
    pub reason: StarterMissingReason,
}

/// 开局表的查询结果，两张表都按开局表的顺序。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StarterMods {
    pub available: Vec<StarterMod>,
    pub missing: Vec<StarterMissing>,
}

/// 一项的查询结果。版本对象有几百字节，装箱后缺项不必占那么大的槽位。
enum Pick {
    Found(Box<ModVersionInfo>),
    Missing(StarterMissingReason),
}

impl Aurora {
    /// 按开局表逐项查 Modrinth 上适配 `mc_version` 与 `loader` 的版本。
    ///
    /// 版本列表复用 5 分钟的版本缓存。只收兼容判定为确凿匹配的版本，与发现页同一口径：Quilt 实例不收
    /// 只标了 fabric 的版本。发布通道按正式版、测试版、内测版的顺序挑，取最好那个通道里最新的一个。
    /// 平台对某个工程回 404 时记为缺项；其他失败（断网、超时、重试用完的 5xx）让整个调用失败，
    /// 不交回半张表——半张表在界面上与「这几项没有适配」分不出来。
    pub async fn starter_mods(&self, loader: ModLoader, mc_version: &str) -> Result<StarterMods> {
        let entries = starter_table(loader).to_vec();
        let picks = bounded_map(entries.clone(), STARTER_CONCURRENCY, |entry| {
            let aurora = self.clone();
            let mc = mc_version.to_owned();
            async move { aurora.pick_starter(entry, loader, &mc).await }
        })
        .await?;
        let mut result = StarterMods {
            available: Vec::new(),
            missing: Vec::new(),
        };
        for (entry, pick) in entries.into_iter().zip(picks) {
            match pick {
                Pick::Found(version) => result.available.push(StarterMod {
                    entry,
                    version: *version,
                }),
                Pick::Missing(reason) => result.missing.push(StarterMissing { entry, reason }),
            }
        }
        Ok(result)
    }

    async fn pick_starter(&self, entry: StarterEntry, loader: ModLoader, mc: &str) -> Result<Pick> {
        let listed = self
            .mod_version_list(
                Platform::Modrinth,
                entry.project_id,
                &[mc.to_owned()],
                &[loader],
            )
            .await;
        let versions = match listed {
            Ok(list) => list.versions,
            Err(CoreError::ModPlatform(aurora_modplatform::Error::Status {
                status: 404, ..
            })) => {
                tracing::warn!(
                    project_id = entry.project_id,
                    name = entry.name,
                    "开局 Mod 的工程在 Modrinth 上不存在，内置的开局表过时了"
                );
                return Ok(Pick::Missing(StarterMissingReason::NotFound));
            }
            Err(err) => return Err(err),
        };
        let instance_loaders = [loader.modrinth_facet().to_owned()];
        let matching: Vec<&ModVersionInfo> = versions
            .iter()
            .filter(|v| {
                matches!(
                    classify(v, Some(mc), &instance_loaders),
                    Compatibility::Match
                )
            })
            .collect();
        // 列表已按发布时间倒序，每个通道里第一个就是最新的。
        for channel in [
            ReleaseChannel::Release,
            ReleaseChannel::Beta,
            ReleaseChannel::Alpha,
        ] {
            if let Some(version) = matching.iter().find(|v| v.release_channel == channel) {
                return Ok(Pick::Found(Box::new((*version).clone())));
            }
        }
        Ok(Pick::Missing(StarterMissingReason::NoVersion))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AuroraConfig;
    use std::collections::HashSet;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn aurora(server: &MockServer) -> Aurora {
        let tmp = std::env::temp_dir().join("petalfall-starter-tests");
        Aurora::for_test(AuroraConfig::default(), tmp.clone(), tmp)
            .with_modrinth_base(format!("{}/v2", server.uri()))
    }

    fn table_ids(loader: ModLoader) -> Vec<(StarterGroup, &'static str, &'static str)> {
        starter_table(loader)
            .iter()
            .map(|e| (e.group, e.project_id, e.name))
            .collect()
    }

    #[test]
    fn tables_match_the_verified_project_list() {
        use StarterGroup::{Api, Performance};
        assert_eq!(
            table_ids(ModLoader::Fabric),
            vec![
                (Api, "P7dR8mSH", "Fabric API"),
                (Performance, "AANobbMI", "Sodium"),
                (Performance, "gvQqBUqZ", "Lithium"),
                (Performance, "uXXizFIs", "FerriteCore"),
                (Performance, "nmDcB62a", "ModernFix"),
            ]
        );
        assert_eq!(
            table_ids(ModLoader::Quilt),
            vec![
                (Api, "qvIfYCYJ", "QFAPI"),
                (Performance, "AANobbMI", "Sodium"),
                (Performance, "gvQqBUqZ", "Lithium"),
                (Performance, "uXXizFIs", "FerriteCore"),
            ]
        );
        assert_eq!(
            table_ids(ModLoader::NeoForge),
            vec![
                (Performance, "AANobbMI", "Sodium"),
                (Performance, "gvQqBUqZ", "Lithium"),
                (Performance, "uXXizFIs", "FerriteCore"),
                (Performance, "nmDcB62a", "ModernFix"),
            ]
        );
        assert_eq!(
            table_ids(ModLoader::Forge),
            vec![
                (Performance, "uXXizFIs", "FerriteCore"),
                (Performance, "nmDcB62a", "ModernFix"),
            ]
        );
        assert!(starter_table(ModLoader::LiteLoader).is_empty());
    }

    #[test]
    fn each_table_has_at_most_one_api_first_and_no_duplicates() {
        for loader in [
            ModLoader::Fabric,
            ModLoader::Quilt,
            ModLoader::Forge,
            ModLoader::NeoForge,
            ModLoader::LiteLoader,
        ] {
            let table = starter_table(loader);
            let apis: Vec<usize> = table
                .iter()
                .enumerate()
                .filter(|(_, e)| e.group == StarterGroup::Api)
                .map(|(i, _)| i)
                .collect();
            assert!(apis.len() <= 1, "{loader:?}");
            assert!(
                apis.iter().all(|&i| i == 0),
                "{loader:?} 的前置 API 应排在最前"
            );
            let ids: HashSet<&str> = table.iter().map(|e| e.project_id).collect();
            assert_eq!(ids.len(), table.len(), "{loader:?} 的工程 id 重复");
        }
    }

    /// 一个 Modrinth 版本对象，只留归一要读的字段。
    fn version(
        id: &str,
        project: &str,
        number: &str,
        channel: &str,
        date: &str,
        loaders: &[&str],
    ) -> serde_json::Value {
        serde_json::json!({
            "id": id, "project_id": project, "name": number, "version_number": number,
            "version_type": channel, "date_published": date,
            "game_versions": ["1.21.1"], "loaders": loaders, "dependencies": [],
            "files": [{
                "hashes": {"sha1": "00"}, "url": format!("https://cdn.modrinth.com/{id}.jar"),
                "filename": format!("{id}.jar"), "primary": true, "size": 1024
            }]
        })
    }

    async fn mount_versions(
        server: &MockServer,
        project: &str,
        loader: &str,
        body: serde_json::Value,
    ) {
        Mock::given(method("GET"))
            .and(path(format!("/v2/project/{project}/version")))
            .and(query_param("loaders", format!(r#"["{loader}"]"#)))
            .and(query_param("game_versions", r#"["1.21.1"]"#))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .expect(1)
            .mount(server)
            .await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn fabric_1_21_1_lists_installable_mods_and_the_missing_one() {
        let server = MockServer::start().await;
        let at = "2026-08-01T00:00:00Z";
        mount_versions(
            &server,
            "P7dR8mSH",
            "fabric",
            serde_json::json!([version(
                "fapi",
                "P7dR8mSH",
                "0.116.17+1.21.1",
                "release",
                at,
                &["fabric"]
            )]),
        )
        .await;
        mount_versions(
            &server,
            "AANobbMI",
            "fabric",
            serde_json::json!([version(
                "sodium",
                "AANobbMI",
                "mc1.21.1-0.8.13-fabric",
                "release",
                at,
                &["fabric"]
            )]),
        )
        .await;
        // 最新的那个只标了 quilt：Fabric 实例不收，挑下一个。
        mount_versions(
            &server,
            "gvQqBUqZ",
            "fabric",
            serde_json::json!([
                version(
                    "lithium-q",
                    "gvQqBUqZ",
                    "0.15.1-quilt",
                    "release",
                    "2026-09-01T00:00:00Z",
                    &["quilt"]
                ),
                version(
                    "lithium",
                    "gvQqBUqZ",
                    "0.15.0",
                    "release",
                    at,
                    &["fabric", "quilt"]
                ),
            ]),
        )
        .await;
        mount_versions(
            &server,
            "uXXizFIs",
            "fabric",
            serde_json::json!([version(
                "ferrite",
                "uXXizFIs",
                "7.0.2-fabric",
                "release",
                at,
                &["fabric"]
            )]),
        )
        .await;
        mount_versions(&server, "nmDcB62a", "fabric", serde_json::json!([])).await;
        let aurora = aurora(&server);

        let mods = aurora
            .starter_mods(ModLoader::Fabric, "1.21.1")
            .await
            .unwrap();
        let available: Vec<(&str, &str)> = mods
            .available
            .iter()
            .map(|m| (m.entry.name, m.version.version_id.as_str()))
            .collect();
        assert_eq!(
            available,
            vec![
                ("Fabric API", "fapi"),
                ("Sodium", "sodium"),
                ("Lithium", "lithium"),
                ("FerriteCore", "ferrite"),
            ]
        );
        assert_eq!(mods.available[0].entry.group, StarterGroup::Api);
        assert_eq!(mods.available[0].version.version_number, "0.116.17+1.21.1");
        assert_eq!(mods.available[1].version.file_size, Some(1024));
        assert_eq!(
            mods.missing,
            vec![StarterMissing {
                entry: MODERN_FIX,
                reason: StarterMissingReason::NoVersion,
            }]
        );
        assert_eq!(server.received_requests().await.unwrap().len(), 5);

        // 缓存期内再问一次：结果相同，一个请求都不多。
        assert_eq!(
            aurora
                .starter_mods(ModLoader::Fabric, "1.21.1")
                .await
                .unwrap(),
            mods
        );
        assert_eq!(server.received_requests().await.unwrap().len(), 5);
    }

    /// 正式版压过更新的测试版；只有内测版时取内测版。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn release_beats_newer_beta_and_alpha_is_the_last_resort() {
        let server = MockServer::start().await;
        mount_versions(
            &server,
            "uXXizFIs",
            "forge",
            serde_json::json!([
                version(
                    "ferrite-beta",
                    "uXXizFIs",
                    "7.1.0-beta",
                    "beta",
                    "2026-10-01T00:00:00Z",
                    &["forge"]
                ),
                version(
                    "ferrite-old",
                    "uXXizFIs",
                    "7.0.0",
                    "release",
                    "2026-01-01T00:00:00Z",
                    &["forge"]
                ),
                version(
                    "ferrite-older",
                    "uXXizFIs",
                    "6.9.0",
                    "release",
                    "2025-06-01T00:00:00Z",
                    &["forge"]
                ),
            ]),
        )
        .await;
        mount_versions(
            &server,
            "nmDcB62a",
            "forge",
            serde_json::json!([
                version(
                    "modernfix-a2",
                    "nmDcB62a",
                    "5.20-alpha2",
                    "alpha",
                    "2026-10-02T00:00:00Z",
                    &["forge"]
                ),
                version(
                    "modernfix-a1",
                    "nmDcB62a",
                    "5.20-alpha1",
                    "alpha",
                    "2026-09-02T00:00:00Z",
                    &["forge"]
                ),
            ]),
        )
        .await;

        let mods = aurora(&server)
            .starter_mods(ModLoader::Forge, "1.21.1")
            .await
            .unwrap();
        let picked: Vec<(&str, ReleaseChannel)> = mods
            .available
            .iter()
            .map(|m| (m.version.version_id.as_str(), m.version.release_channel))
            .collect();
        assert_eq!(
            picked,
            vec![
                ("ferrite-old", ReleaseChannel::Release),
                ("modernfix-a2", ReleaseChannel::Alpha),
            ]
        );
        assert!(mods.missing.is_empty());
    }

    /// 404 记为缺项、原因是工程不存在；Quilt 实例不收只标了 fabric 的版本。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn missing_project_is_not_found_and_quilt_rejects_fabric_only_versions() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v2/project/qvIfYCYJ/version"))
            .respond_with(ResponseTemplate::new(404))
            .expect(1)
            .mount(&server)
            .await;
        let at = "2026-08-01T00:00:00Z";
        mount_versions(
            &server,
            "AANobbMI",
            "quilt",
            serde_json::json!([version(
                "sodium",
                "AANobbMI",
                "0.8.13",
                "release",
                at,
                &["fabric"]
            )]),
        )
        .await;
        mount_versions(
            &server,
            "gvQqBUqZ",
            "quilt",
            serde_json::json!([version(
                "lithium",
                "gvQqBUqZ",
                "0.15.0",
                "release",
                at,
                &["fabric", "quilt"]
            )]),
        )
        .await;
        mount_versions(&server, "uXXizFIs", "quilt", serde_json::json!([])).await;

        let mods = aurora(&server)
            .starter_mods(ModLoader::Quilt, "1.21.1")
            .await
            .unwrap();
        assert_eq!(
            mods.available
                .iter()
                .map(|m| m.entry.name)
                .collect::<Vec<_>>(),
            vec!["Lithium"]
        );
        let missing: Vec<(&str, StarterMissingReason)> = mods
            .missing
            .iter()
            .map(|m| (m.entry.name, m.reason))
            .collect();
        assert_eq!(
            missing,
            vec![
                ("QFAPI", StarterMissingReason::NotFound),
                ("Sodium", StarterMissingReason::NoVersion),
                ("FerriteCore", StarterMissingReason::NoVersion),
            ]
        );
    }

    /// 404 以外的失败让整个调用失败，不交回半张表。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn server_error_fails_the_whole_call() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v2/project/nmDcB62a/version"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        // 不约定请求次数：调用在第一个失败处短路，同批的查询可能还没发出就被丢弃，到没到都合法。
        Mock::given(method("GET"))
            .and(path("/v2/project/uXXizFIs/version"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!([version(
                    "ferrite",
                    "uXXizFIs",
                    "7.0.0",
                    "release",
                    "2026-01-01T00:00:00Z",
                    &["forge"]
                )])),
            )
            .mount(&server)
            .await;

        let err = aurora(&server)
            .starter_mods(ModLoader::Forge, "1.21.1")
            .await
            .unwrap_err();
        assert!(
            matches!(
                err,
                CoreError::ModPlatform(aurora_modplatform::Error::Status { status: 500, .. })
            ),
            "{err:?}"
        );
    }

    #[tokio::test]
    async fn liteloader_has_nothing_to_query() {
        let server = MockServer::start().await;
        let mods = aurora(&server)
            .starter_mods(ModLoader::LiteLoader, "1.12.2")
            .await
            .unwrap();
        assert!(mods.available.is_empty() && mods.missing.is_empty());
        assert!(server.received_requests().await.unwrap().is_empty());
    }
}
