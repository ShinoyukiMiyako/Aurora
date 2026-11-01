//! 资源搜索与工程详情：Modrinth + CurseForge 双源。
//!
//! Modrinth 无需鉴权直连；CurseForge 需 API key（运行期环境变量或构建期内嵌，见
//! [`CurseForgeClient::from_env`]）。没有 key 时 CurseForge 不参与，并在结果的 `skipped` 里如实报出
//! 「未配置密钥」，而不是悄悄只剩 Modrinth。聚合、合并、翻页逻辑在 aurora-modplatform，门面只负责
//! 按配置构建两个客户端并转调。

use aurora_modplatform::{
    AggregateResult, CurseForgeClient, CurseForgeSource, ModrinthClient, Platform, ProjectDetail,
    SearchCursor, SearchQuery, SkipReason, aggregate_search, curseforge_detail, modrinth_detail,
};

use crate::error::{CoreError, Result};
use crate::facade::Aurora;

impl Aurora {
    /// 聚合搜索第一页，两个平台都参与（CurseForge 仍受密钥与分类换算约束）。
    pub async fn search(&self, query: &SearchQuery) -> Result<AggregateResult> {
        self.search_page(query, None, None).await
    }

    /// 聚合搜索一页。`only` 为 `Some` 时只搜该平台；`cursor` 为上一页返回的游标，首页传 `None`。
    ///
    /// 单平台失败不影响另一平台（失败记在 [`AggregateResult::errors`]）；没有参与的平台及原因记在
    /// [`AggregateResult::skipped`]。
    pub async fn search_page(
        &self,
        query: &SearchQuery,
        only: Option<Platform>,
        cursor: Option<&SearchCursor>,
    ) -> Result<AggregateResult> {
        let modrinth = ModrinthClient::new(self.http()).with_base_url(self.modrinth_base());
        let curseforge = if only == Some(Platform::Modrinth) {
            None
        } else {
            Some(self.configured_curseforge_client()?)
        };
        let curseforge_source = match &curseforge {
            None => CurseForgeSource::Skipped(SkipReason::Filtered),
            Some(None) => CurseForgeSource::Skipped(SkipReason::KeyMissing),
            Some(Some(client)) => CurseForgeSource::Enabled(client),
        };
        let modrinth = (only != Some(Platform::CurseForge)).then_some(&modrinth);
        Ok(aggregate_search(modrinth, curseforge_source, query, cursor).await)
    }

    /// 取工程详情。CurseForge 的工程 id 必须是十进制数字。
    pub async fn project_detail(
        &self,
        platform: Platform,
        project_id: &str,
    ) -> Result<ProjectDetail> {
        match platform {
            Platform::Modrinth => {
                let client = ModrinthClient::new(self.http()).with_base_url(self.modrinth_base());
                Ok(modrinth_detail(&client, project_id).await?)
            }
            Platform::CurseForge => {
                let mod_id: u32 = project_id
                    .parse()
                    .map_err(|_| CoreError::InvalidProjectId {
                        platform: Platform::CurseForge.display_name(),
                        project_id: project_id.to_owned(),
                    })?;
                let client = self.curseforge_client()?;
                Ok(curseforge_detail(&client, mod_id).await?)
            }
        }
    }

    /// 搜索用的 CurseForge 客户端：没有可用 key 返回 `Ok(None)`，由搜索结果报 `key_missing`；
    /// 其余构建失败照常冒泡。安装、详情等必须用到 CurseForge 的路径走 `curseforge_client`，缺 key 即报错。
    pub(crate) fn configured_curseforge_client(&self) -> Result<Option<CurseForgeClient>> {
        match CurseForgeClient::from_env(self.http()) {
            Ok(client) => Ok(Some(client.with_base_url(self.curseforge_base()))),
            Err(aurora_modplatform::Error::CurseForgeKeyMissing) => {
                tracing::info!("没有可用的 CurseForge API key，CurseForge 不参与");
                Ok(None)
            }
            Err(other) => Err(other.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::config::AuroraConfig;
    use crate::facade::Aurora;
    use aurora_modplatform::{Platform, SearchQuery, SkipReason};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn modrinth_search_body() -> &'static str {
        r#"{"hits":[{"project_id":"AABBCC","slug":"sodium","title":"Sodium",
            "description":"性能优化","project_type":"mod","downloads":123456,"follows":10,
            "author":"jellysquid","date_modified":"2026-01-01T00:00:00Z"}],
            "offset":0,"limit":20,"total_hits":1}"#
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn search_returns_modrinth_hits_and_reports_curseforge_state() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/search"))
            .respond_with(ResponseTemplate::new(200).set_body_string(modrinth_search_body()))
            .mount(&server)
            .await;
        // 把 CurseForge 端点也指向 mock：若测试环境恰好有 API key，也不会打到生产端点。
        Mock::given(method("GET"))
            .and(path("/v1/mods/search"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"{"data":[],"pagination":{"index":0,"pageSize":20,"resultCount":0,"totalCount":0}}"#,
            ))
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        let aurora = Aurora::for_test(
            AuroraConfig::default(),
            tmp.path().to_path_buf(),
            tmp.path().to_path_buf(),
        )
        .with_modrinth_base(server.uri())
        .with_curseforge_base(server.uri());

        let result = aurora.search(&SearchQuery::new("sodium")).await.unwrap();

        let hit = result
            .hits
            .iter()
            .find(|h| h.slug.as_deref() == Some("sodium"))
            .unwrap();
        assert_eq!(hit.platform, Platform::Modrinth);
        assert_eq!(hit.downloads, 123456);
        assert_eq!(hit.title, "Sodium");
        // 有没有 key 取决于运行环境；两种情况都必须有明确交代：要么 CurseForge 参与，要么报未配置。
        let curseforge_configured = aurora.configured_curseforge_client().unwrap().is_some();
        let reported_missing = result
            .skipped
            .iter()
            .any(|s| s.platform == Platform::CurseForge && s.reason == SkipReason::KeyMissing);
        assert_eq!(reported_missing, !curseforge_configured);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn only_modrinth_filters_curseforge_out() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/search"))
            .respond_with(ResponseTemplate::new(200).set_body_string(modrinth_search_body()))
            .mount(&server)
            .await;
        let tmp = tempfile::tempdir().unwrap();
        let aurora = Aurora::for_test(
            AuroraConfig::default(),
            tmp.path().to_path_buf(),
            tmp.path().to_path_buf(),
        )
        .with_modrinth_base(server.uri())
        .with_curseforge_base(server.uri());

        let result = aurora
            .search_page(&SearchQuery::new("sodium"), Some(Platform::Modrinth), None)
            .await
            .unwrap();
        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.skipped.len(), 1);
        assert_eq!(result.skipped[0].platform, Platform::CurseForge);
        assert_eq!(result.skipped[0].reason, SkipReason::Filtered);
        assert!(result.is_complete());
    }

    #[tokio::test]
    async fn curseforge_detail_rejects_non_numeric_id_before_network() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = Aurora::for_test(
            AuroraConfig::default(),
            tmp.path().to_path_buf(),
            tmp.path().to_path_buf(),
        );
        let err = aurora
            .project_detail(Platform::CurseForge, "jei")
            .await
            .unwrap_err();
        assert!(
            matches!(&err, crate::error::CoreError::InvalidProjectId { project_id, .. } if project_id == "jei"),
            "实际：{err:?}"
        );
    }
}
