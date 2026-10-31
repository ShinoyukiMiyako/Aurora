//! 工程详情：资源详情弹窗要的全部字段，两个平台各取各的接口后归一到 [`ProjectDetail`]。
//!
//! 一次详情要拼几样东西：工程本体、作者、全部版本（取最新版本与文件大小）、最新版本的必需前置
//! （前置的名称、图标、作者、版本号）。能批量的请求都批量发（Modrinth 的 `/projects`、`/teams`、
//! `/versions`，CurseForge 的 `POST /v1/mods`），一次详情的请求数是常数，不随前置个数增长。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::curseforge::{CurseForgeClient, CurseForgeMod};
use crate::error::Result;
use crate::model::{DependencyKind, ModLoader, Platform, ResourceType, hue_from_rgb};
use crate::modrinth::{ModrinthClient, primary_author, split_modrinth_tags};
use crate::version::{ModVersionInfo, ReleaseChannel, parse_loader_name};

/// 介绍正文的格式：Modrinth 给 Markdown，CurseForge 只给 HTML。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BodyFormat {
    /// Markdown。
    Markdown,
    /// HTML。
    Html,
}

/// 一个必需前置。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DependencyProject {
    /// 平台（与被依赖的工程同平台）。
    pub platform: Platform,
    /// 工程 id。
    pub project_id: String,
    /// 名称。
    pub title: String,
    /// 图标。
    pub icon_url: Option<String>,
    /// 作者。
    pub author: Option<String>,
    /// 版本标签：依赖指定了版本时为该版本，否则为前置自己的最新版本；平台给不出为 `None`。
    pub latest_version: Option<String>,
}

/// 工程详情的跨平台统一视图。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectDetail {
    /// 平台。
    pub platform: Platform,
    /// 工程 id。
    pub project_id: String,
    /// slug。
    pub slug: Option<String>,
    /// 名称。
    pub title: String,
    /// 一句话简介。
    pub summary: String,
    /// 介绍正文原文。
    pub body: String,
    /// 正文格式。
    pub body_format: BodyFormat,
    /// 作者。
    pub author: Option<String>,
    /// 下载量。
    pub downloads: u64,
    /// 关注数（CurseForge 没有）。
    pub follows: Option<u64>,
    /// 图标。
    pub icon_url: Option<String>,
    /// 图库图片，平台给出的顺序（精选在前）。
    pub gallery: Vec<String>,
    /// 色相。
    pub hue: Option<u16>,
    /// 分类标签。
    pub categories: Vec<String>,
    /// 资源类型。
    pub resource_type: ResourceType,
    /// 支持的加载器。
    pub loaders: Vec<ModLoader>,
    /// 支持的 MC 版本。
    pub game_versions: Vec<String>,
    /// 首次发布时间。
    pub date_published: Option<String>,
    /// 最近更新时间。
    pub date_modified: Option<String>,
    /// 平台详情页。
    pub page_url: Option<String>,
    /// 源码地址。
    pub source_url: Option<String>,
    /// 问题反馈地址。
    pub issues_url: Option<String>,
    /// 维基地址。
    pub wiki_url: Option<String>,
    /// 最新版本：有正式版取最新正式版，否则取最新的任意通道版本；一个可装的版本都没有为 `None`。
    pub latest_version: Option<ModVersionInfo>,
    /// 最新版本的必需前置。
    pub dependencies: Vec<DependencyProject>,
    /// 平台是否允许启动器直接下载文件。CurseForge 作者可以关掉第三方分发，此时只能去网页手动下载。
    pub distribution_allowed: bool,
}

/// 取最新版本：正式版优先，同通道按发布时间取最新。
fn pick_latest(versions: Vec<ModVersionInfo>) -> Option<ModVersionInfo> {
    let newest = |list: Vec<ModVersionInfo>| {
        list.into_iter()
            .max_by(|a, b| a.date_published.cmp(&b.date_published))
    };
    let (releases, others): (Vec<_>, Vec<_>) = versions
        .into_iter()
        .partition(|v| v.release_channel == ReleaseChannel::Release);
    newest(releases).or_else(|| newest(others))
}

/// 必需前置的工程 id 与指定版本 id（去重，保持出现顺序）。
fn required_dependencies(latest: Option<&ModVersionInfo>) -> Vec<(Option<String>, Option<String>)> {
    let mut out: Vec<(Option<String>, Option<String>)> = Vec::new();
    for dep in latest
        .map(|v| v.dependencies.as_slice())
        .unwrap_or_default()
    {
        if dep.kind != DependencyKind::Required {
            continue;
        }
        let pair = (dep.project_id.clone(), dep.version_id.clone());
        if !out.contains(&pair) {
            out.push(pair);
        }
    }
    out
}

/// Modrinth 工程详情。
pub async fn modrinth_detail(client: &ModrinthClient, id_or_slug: &str) -> Result<ProjectDetail> {
    let (project, members, versions) = tokio::join!(
        client.project(id_or_slug),
        client.project_members(id_or_slug),
        client.versions(id_or_slug, &[], &[]),
    );
    let project = project?;
    let author = primary_author(&members?);
    let latest = pick_latest(
        versions?
            .iter()
            .filter_map(|v| v.to_version_info())
            .collect(),
    );

    let deps = required_dependencies(latest.as_ref());
    // 依赖可能只指定了版本、没给工程 id；先按版本 id 取回版本，补出工程 id 与版本号。
    let pinned: Vec<String> = deps.iter().filter_map(|(_, v)| v.clone()).collect();
    let pinned_versions = client.versions_by_ids(&pinned).await?;
    let version_of: HashMap<&str, (&str, &str)> = pinned_versions
        .iter()
        .map(|v| {
            (
                v.id.as_str(),
                (v.project_id.as_str(), v.version_number.as_str()),
            )
        })
        .collect();
    let mut dep_refs: Vec<(String, Option<String>)> = Vec::new();
    for (project_id, version_id) in &deps {
        let pinned = version_id.as_deref().and_then(|v| version_of.get(v));
        let Some(project_id) = project_id
            .clone()
            .or_else(|| pinned.map(|(p, _)| (*p).to_owned()))
        else {
            // 只给了版本 id、而该版本已从平台下架：无从知道是哪个工程，不能编一个前置出来。
            tracing::warn!(?version_id, "Modrinth 依赖既无工程 id、版本也取不到，跳过");
            continue;
        };
        if dep_refs.iter().any(|(p, _)| *p == project_id) {
            continue;
        }
        dep_refs.push((project_id, pinned.map(|(_, number)| (*number).to_owned())));
    }

    let dep_ids: Vec<String> = dep_refs.iter().map(|(p, _)| p.clone()).collect();
    let dep_projects = client.projects(&dep_ids).await?;
    let team_ids: Vec<String> = dep_projects.iter().filter_map(|p| p.team.clone()).collect();
    let teams = client.teams(&team_ids).await?;
    let author_of_team: HashMap<String, String> = teams
        .iter()
        .filter_map(|members| {
            let team = members.first()?.team_id.clone();
            Some((team, primary_author(members)?))
        })
        .collect();
    let dependencies = dep_refs
        .iter()
        .filter_map(|(project_id, version)| {
            let dep = dep_projects
                .iter()
                .find(|p| p.id == *project_id || p.slug.as_deref() == Some(project_id))?;
            Some(DependencyProject {
                platform: Platform::Modrinth,
                project_id: dep.id.clone(),
                title: dep.title.clone(),
                icon_url: dep.icon_url.clone(),
                author: dep
                    .team
                    .as_ref()
                    .and_then(|t| author_of_team.get(t).cloned()),
                latest_version: version.clone(),
            })
        })
        .collect();

    let resource_type = project.resource_type();
    let (_, categories) = split_modrinth_tags(&project.categories);
    let mut gallery: Vec<&crate::modrinth::ModrinthGalleryImage> = project.gallery.iter().collect();
    gallery.sort_by_key(|g| !g.featured);
    Ok(ProjectDetail {
        platform: Platform::Modrinth,
        project_id: project.id.clone(),
        slug: project.slug.clone(),
        title: project.title.clone(),
        summary: project.description.clone(),
        body: project.body.clone().unwrap_or_default(),
        body_format: BodyFormat::Markdown,
        author,
        downloads: project.downloads,
        follows: Some(project.followers),
        icon_url: project.icon_url.clone(),
        gallery: gallery.into_iter().map(|g| g.url.clone()).collect(),
        hue: project.color.and_then(hue_from_rgb),
        categories,
        resource_type,
        loaders: project
            .loaders
            .iter()
            .filter_map(|l| parse_loader_name(l))
            .collect(),
        game_versions: project.game_versions.clone(),
        date_published: project.published.clone(),
        date_modified: project.updated.clone(),
        page_url: project.slug.as_ref().map(|slug| {
            format!(
                "https://modrinth.com/{}/{}",
                resource_type.modrinth_project_type(),
                slug
            )
        }),
        source_url: project.source_url.clone(),
        issues_url: project.issues_url.clone(),
        wiki_url: project.wiki_url.clone(),
        latest_version: latest,
        dependencies,
        distribution_allowed: true,
    })
}

/// CurseForge 工程详情。
pub async fn curseforge_detail(client: &CurseForgeClient, mod_id: u32) -> Result<ProjectDetail> {
    let (item, body) = tokio::join!(client.get_mod(mod_id), client.mod_description(mod_id));
    let item = item?;
    let body = body?;
    let latest = pick_latest(
        item.latest_files
            .iter()
            .map(|f| f.to_version_info())
            .collect(),
    );

    let dep_ids: Vec<u32> = required_dependencies(latest.as_ref())
        .into_iter()
        .filter_map(|(project, _)| project?.parse().ok())
        .collect();
    let dep_mods = client.get_mods(&dep_ids).await?;
    let dependencies = dep_ids
        .iter()
        .filter_map(|id| dep_mods.iter().find(|m| m.id == *id))
        .map(|dep| DependencyProject {
            platform: Platform::CurseForge,
            project_id: dep.id.to_string(),
            title: dep.name.clone(),
            icon_url: dep.logo.as_ref().map(|l| l.url.clone()),
            author: dep.authors.first().map(|a| a.name.clone()),
            latest_version: newest_file_label(dep),
        })
        .collect();

    Ok(ProjectDetail {
        platform: Platform::CurseForge,
        project_id: item.id.to_string(),
        slug: Some(item.slug.clone()),
        title: item.name.clone(),
        summary: item.summary.clone(),
        body,
        body_format: BodyFormat::Html,
        author: item.authors.first().map(|a| a.name.clone()),
        downloads: item.download_count,
        follows: None,
        icon_url: item.logo.as_ref().map(|l| l.url.clone()),
        gallery: item.screenshots.iter().map(|s| s.url.clone()).collect(),
        hue: None,
        categories: item.categories.iter().map(|c| c.name.clone()).collect(),
        resource_type: ResourceType::from_curseforge_class_id(item.class_id),
        loaders: item.loaders(),
        game_versions: item.game_versions(),
        date_published: item.date_created.clone(),
        date_modified: item.date_modified.clone(),
        page_url: item.links.as_ref().and_then(|l| l.website_url.clone()),
        source_url: item.links.as_ref().and_then(|l| l.source_url.clone()),
        issues_url: item.links.as_ref().and_then(|l| l.issues_url.clone()),
        wiki_url: item.links.as_ref().and_then(|l| l.wiki_url.clone()),
        latest_version: latest,
        dependencies,
        // 字段缺失视为允许：老数据没有这个字段，而它们的文件都带下载地址。
        distribution_allowed: item.allow_mod_distribution != Some(false),
    })
}

/// CurseForge 工程最新文件的展示名（文件模型没有独立版本号，展示名是给人看的那一个）。
fn newest_file_label(item: &CurseForgeMod) -> Option<String> {
    item.latest_files
        .iter()
        .max_by(|a, b| a.file_date.cmp(&b.file_date))
        .map(|f| f.display_name.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use aurora_base::retry::RetryPolicy;
    use wiremock::matchers::{body_json, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn no_retry() -> RetryPolicy {
        RetryPolicy {
            max_attempts: 1,
            ..RetryPolicy::default()
        }
    }

    fn version_json(
        id: &str,
        number: &str,
        channel: &str,
        date: &str,
        deps: serde_json::Value,
    ) -> serde_json::Value {
        serde_json::json!({
            "id": id, "project_id": "AANobbMI", "name": number, "version_number": number,
            "version_type": channel, "date_published": date, "loaders": ["fabric"],
            "game_versions": ["1.21.1"], "dependencies": deps,
            "files": [{"hashes": {"sha1": "aa"}, "url": format!("https://cdn/{id}.jar"),
                       "filename": format!("{id}.jar"), "primary": true, "size": 2048}]
        })
    }

    /// Modrinth 详情：最新正式版压过更新的测试版；必需前置补出名称、作者与指定版本号，
    /// 可选前置不出现；数据包工程按加载器认成数据包。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn modrinth_detail_assembles_latest_release_and_required_dependencies() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/project/sodium"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "AANobbMI", "slug": "sodium", "title": "Sodium", "description": "快",
                "body": "# Sodium\n正文", "categories": ["optimization", "fabric"],
                "project_type": "mod", "downloads": 100, "followers": 7,
                "loaders": ["fabric", "neoforge", "quilt"], "game_versions": ["1.21", "1.21.1"],
                "team": "team-s", "color": 0x00ff00, "published": "2020-01-01T00:00:00Z",
                "updated": "2026-10-01T00:00:00Z",
                "gallery": [
                    {"url": "https://cdn/g-plain.webp", "featured": false},
                    {"url": "https://cdn/g-featured.webp", "featured": true}
                ]
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/project/sodium/members"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                {"team_id": "team-s", "user": {"username": "helper"}, "role": "Member", "ordering": 1},
                {"team_id": "team-s", "user": {"username": "jellysquid3"}, "role": "Owner", "ordering": 2}
            ])))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/project/sodium/version"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                version_json(
                    "beta2",
                    "0.7.0-beta",
                    "beta",
                    "2026-10-02T00:00:00Z",
                    serde_json::json!([])
                ),
                version_json(
                    "rel1",
                    "0.6.13",
                    "release",
                    "2026-09-01T00:00:00Z",
                    serde_json::json!([
                        {"project_id": "P7dR8mSH", "dependency_type": "required"},
                        {"version_id": "indium-v", "dependency_type": "required"},
                        {"project_id": "optional-one", "dependency_type": "optional"},
                        {"project_id": "P7dR8mSH", "dependency_type": "required"}
                    ])
                ),
                version_json(
                    "rel0",
                    "0.6.12",
                    "release",
                    "2026-08-01T00:00:00Z",
                    serde_json::json!([])
                )
            ])))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/versions"))
            .and(query_param("ids", r#"["indium-v"]"#))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                {"id": "indium-v", "project_id": "Orvt0mRa", "name": "Indium", "version_number": "1.0.36",
                 "version_type": "release", "date_published": "2026-01-01T00:00:00Z", "files": []}
            ])))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/projects"))
            .and(query_param("ids", r#"["P7dR8mSH","Orvt0mRa"]"#))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                {"id": "Orvt0mRa", "slug": "indium", "title": "Indium", "description": "",
                 "project_type": "mod", "downloads": 1, "team": "team-i", "icon_url": "https://cdn/indium.png"},
                {"id": "P7dR8mSH", "slug": "fabric-api", "title": "Fabric API", "description": "",
                 "project_type": "mod", "downloads": 1, "team": "team-f"}
            ])))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/teams"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                [{"team_id": "team-i", "user": {"username": "comp500"}, "role": "Owner", "ordering": 0}],
                [{"team_id": "team-f", "user": {"username": "modmuss50"}, "role": "Member", "ordering": 0}]
            ])))
            .mount(&server)
            .await;

        let http = aurora_base::http::build_client().unwrap();
        let client = ModrinthClient::new(http)
            .with_base_url(server.uri())
            .with_retry(no_retry());
        let detail = modrinth_detail(&client, "sodium").await.unwrap();

        assert_eq!(detail.author.as_deref(), Some("jellysquid3"));
        assert_eq!(detail.body_format, BodyFormat::Markdown);
        assert_eq!(detail.body, "# Sodium\n正文");
        assert_eq!(detail.follows, Some(7));
        assert_eq!(detail.hue, Some(120));
        assert_eq!(detail.categories, vec!["optimization".to_string()]);
        assert_eq!(
            detail.loaders,
            vec![ModLoader::Fabric, ModLoader::NeoForge, ModLoader::Quilt]
        );
        assert_eq!(
            detail.gallery,
            vec![
                "https://cdn/g-featured.webp".to_string(),
                "https://cdn/g-plain.webp".to_string()
            ]
        );
        let latest = detail.latest_version.as_ref().unwrap();
        assert_eq!(latest.version_id, "rel1", "正式版优先于更新的测试版");
        assert_eq!(latest.file_size, Some(2048));
        assert_eq!(
            detail.dependencies.len(),
            2,
            "可选前置不算，重复的必需前置只算一次"
        );
        assert_eq!(detail.dependencies[0].title, "Fabric API");
        assert_eq!(detail.dependencies[0].author.as_deref(), Some("modmuss50"));
        assert_eq!(detail.dependencies[0].latest_version, None);
        assert_eq!(detail.dependencies[1].project_id, "Orvt0mRa");
        assert_eq!(detail.dependencies[1].author.as_deref(), Some("comp500"));
        assert_eq!(
            detail.dependencies[1].latest_version.as_deref(),
            Some("1.0.36")
        );
        assert_eq!(
            detail.page_url.as_deref(),
            Some("https://modrinth.com/mod/sodium")
        );
        assert!(detail.distribution_allowed);
    }

    /// CurseForge 详情：正文是 HTML；加载器与版本取自文件索引；前置一次批量取回；
    /// 作者关掉第三方分发时如实标出。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn curseforge_detail_uses_html_body_batch_dependencies_and_distribution_flag() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/mods/238222"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"data": {
                "id": 238222, "name": "JEI", "slug": "jei", "summary": "查配方",
                "downloadCount": 500, "classId": 6, "allowModDistribution": false,
                "authors": [{"id": 1, "name": "mezz"}],
                "categories": [{"id": 421, "name": "API and Library"}],
                "screenshots": [{"url": "https://cf/s1.png"}],
                "links": {"websiteUrl": "https://www.curseforge.com/minecraft/mc-mods/jei",
                          "sourceUrl": "https://github.com/mezz/JustEnoughItems"},
                "latestFilesIndexes": [{"gameVersion": "1.21.1", "fileId": 2, "modLoader": 6}],
                "latestFiles": [
                    {"id": 1, "modId": 238222, "displayName": "jei 19.0", "fileName": "jei-19.0.jar",
                     "releaseType": 1, "fileDate": "2026-01-01T00:00:00Z", "fileLength": 900,
                     "gameVersions": ["1.21.1", "NeoForge"],
                     "dependencies": [{"modId": 306612, "relationType": 3}, {"modId": 999, "relationType": 2}]},
                    {"id": 2, "modId": 238222, "displayName": "jei 19.1 beta", "fileName": "jei-19.1.jar",
                     "releaseType": 2, "fileDate": "2026-02-01T00:00:00Z", "gameVersions": ["1.21.1"]}
                ]
            }})))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/mods/238222/description"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"data": "<p>Just Enough Items</p>"})),
            )
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/mods"))
            .and(body_json(serde_json::json!({"modIds": [306612]})))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"data": [
                {"id": 306612, "name": "Fabric API", "slug": "fabric-api", "summary": "",
                 "authors": [{"id": 2, "name": "modmuss50"}], "logo": {"url": "https://cf/fapi.png"},
                 "latestFiles": [
                     {"id": 5, "modId": 306612, "displayName": "0.100.0", "fileName": "a.jar", "fileDate": "2026-01-01T00:00:00Z"},
                     {"id": 6, "modId": 306612, "displayName": "0.102.0", "fileName": "b.jar", "fileDate": "2026-03-01T00:00:00Z"}
                 ]}
            ]})))
            .mount(&server)
            .await;

        let http = aurora_base::http::build_client().unwrap();
        let client = CurseForgeClient::new(http, "k")
            .with_base_url(server.uri())
            .with_retry(no_retry());
        let detail = curseforge_detail(&client, 238222).await.unwrap();

        assert_eq!(detail.body_format, BodyFormat::Html);
        assert_eq!(detail.body, "<p>Just Enough Items</p>");
        assert_eq!(detail.follows, None);
        assert_eq!(detail.loaders, vec![ModLoader::NeoForge]);
        assert_eq!(detail.game_versions, vec!["1.21.1".to_string()]);
        assert_eq!(detail.gallery, vec!["https://cf/s1.png".to_string()]);
        assert_eq!(detail.latest_version.as_ref().unwrap().version_id, "1");
        assert_eq!(detail.dependencies.len(), 1);
        assert_eq!(detail.dependencies[0].title, "Fabric API");
        assert_eq!(
            detail.dependencies[0].latest_version.as_deref(),
            Some("0.102.0")
        );
        assert_eq!(
            detail.dependencies[0].icon_url.as_deref(),
            Some("https://cf/fapi.png")
        );
        assert!(!detail.distribution_allowed);
        assert_eq!(
            detail.source_url.as_deref(),
            Some("https://github.com/mezz/JustEnoughItems")
        );
    }

    #[test]
    fn latest_falls_back_to_newest_prerelease_when_no_release_exists() {
        let v = |id: &str, channel: ReleaseChannel, date: &str| ModVersionInfo {
            version_id: id.into(),
            project_id: "p".into(),
            platform: Platform::Modrinth,
            name: id.into(),
            version_number: id.into(),
            release_channel: channel,
            game_versions: vec![],
            loaders: vec![],
            file_name: format!("{id}.jar"),
            file_size: None,
            sha1: None,
            download_url: None,
            date_published: date.into(),
            dependencies: vec![],
        };
        let picked = pick_latest(vec![
            v("a1", ReleaseChannel::Alpha, "2026-01-01"),
            v("b1", ReleaseChannel::Beta, "2026-03-01"),
            v("b0", ReleaseChannel::Beta, "2025-12-01"),
        ]);
        assert_eq!(picked.unwrap().version_id, "b1");
        assert!(pick_latest(Vec::new()).is_none());
    }
}
