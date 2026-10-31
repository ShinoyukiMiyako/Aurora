//! 主页资讯：Mojang 官方启动器内容源的 Java 版条目，加上本启动器的 GitHub Releases。

use aurora_core::{CoreError, LauncherChannel, NewsFeed, NewsItem};
use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, State};

use crate::commands::error::{code, source_chain};
use crate::commands::CommandError;
use crate::facade::Facade;

/// 一次取资讯的结果。
#[derive(Debug, Serialize)]
pub struct NewsFeedDto {
    /// 两个来源合并，按发布时刻倒序。
    pub items: Vec<NewsItem>,
    /// 官方资讯这份内容取得的时刻（Unix 毫秒）。
    pub fetched_at: u64,
    /// 至少有一个来源本次给的是缓存。
    pub offline: bool,
    /// 启动器资讯取不到且没有缓存时，与命令错误同形状的错误；这时 `items` 里只有官方资讯。
    pub launcher_error: Option<CommandError>,
}

impl From<NewsFeed> for NewsFeedDto {
    fn from(feed: NewsFeed) -> Self {
        Self {
            items: feed.items,
            fetched_at: feed.fetched_at,
            offline: feed.offline,
            launcher_error: feed
                .launcher_error
                .map(|failure| launcher_error(&failure.error)),
        }
    }
}

/// 退避期内门面把同一次失败原样重报多次，错误由各次结果共享、拿不走所有权，而命令边界的通用转换要拿走
/// 错误本身。启动器资讯只会以请求失败或内容认不出告终，这里照通用转换的规则给出同形状的错误，
/// `shared_launcher_error_matches_command_boundary` 钉住两边逐字段一致。
fn launcher_error(err: &CoreError) -> CommandError {
    let (code, url) = match err {
        CoreError::Fetch { url, .. } => (code::NETWORK_FAILED, Some(url)),
        CoreError::FeedParse { url, .. } => (code::FEED_INVALID, Some(url)),
        // 门面给不出别的失败；真出现了就是程序缺陷，按 internal 报，原文与原因链照样带上。
        _ => (code::INTERNAL, None),
    };
    let message = err.to_string();
    let causes = source_chain(err);
    let mut detail = Map::new();
    if let Some(url) = url {
        detail.insert("url".to_owned(), json!(url));
    }
    if let Some(failure) = aurora_base::http::network_failure(err) {
        detail.insert("network".to_owned(), json!(failure.code()));
    }
    if !causes.is_empty() {
        detail.insert("causes".to_owned(), json!(causes));
    }
    tracing::warn!(code, %message, ?causes, "启动器资讯取不到");
    CommandError {
        code,
        message,
        detail: (!detail.is_empty()).then_some(Value::Object(detail)),
    }
}

/// 取资讯。官方资讯 6 小时内用磁盘缓存，联网失败时退回缓存并标 `offline: true`，
/// 连缓存都没有才让整条命令报错（network_failed 或 feed_invalid，detail.url 为出错的地址）。
/// 启动器资讯进程内缓存 1 小时，正在运行的是正式版时不含预发布；它取不到且没有缓存时
/// 命令照常成功，错误放在 `launcher_error`。启动器资讯取不到之后按 1、5、15、60 分钟退避，
/// 退避期内不请求、照样给上次的结果；`retry` 为 true（重试按钮、恢复联网后的重取）时不等退避期满。
#[tauri::command]
pub async fn list_news(
    retry: bool,
    app: AppHandle,
    facade: State<'_, Facade>,
) -> Result<NewsFeedDto, CommandError> {
    let version = &app.package_info().version;
    let channel = LauncherChannel::from_version(version.major, !version.pre.is_empty());
    let aurora = facade.snapshot().await;
    Ok(aurora.list_news(channel, retry).await?.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use aurora_base::brand::REPO_URL;
    use aurora_core::news::LauncherFailure;
    use aurora_core::NewsTag;

    // 前端 TS 引用不到 Rust 常量，仓库地址只能各写一份，由这条测试钉住两边相同。
    #[test]
    fn repo_url_matches_frontend() {
        let decl = format!("export const REPO_URL = \"{REPO_URL}\";");
        assert!(
            include_str!("../../../src/lib/app-info.ts").contains(&decl),
            "app-info.ts 缺少 {decl}"
        );
    }

    fn parse_error(url: &str) -> CoreError {
        CoreError::FeedParse {
            url: url.into(),
            source: serde_json::from_str::<serde_json::Value>("<html>").unwrap_err(),
        }
    }

    fn failure(error: CoreError) -> LauncherFailure {
        LauncherFailure {
            error: Arc::new(error),
            failed_at: 0,
            retry_at: 60_000,
        }
    }

    #[test]
    fn launcher_error_serializes_like_command_errors() {
        let item = NewsItem {
            id: "launcher-1".into(),
            title: "v1.0.0".into(),
            summary: String::new(),
            date: 0,
            tag: NewsTag::Launcher,
            thumbnail_url: None,
            game_version: None,
        };
        let ok = serde_json::to_value(NewsFeedDto::from(NewsFeed {
            items: vec![item],
            fetched_at: 42,
            offline: true,
            launcher_error: None,
        }))
        .unwrap();
        assert_eq!(
            ok,
            json!({
                "items": [{
                    "id": "launcher-1",
                    "title": "v1.0.0",
                    "summary": "",
                    "date": 0,
                    "tag": "launcher",
                    "thumbnail_url": null,
                    "game_version": null,
                }],
                "fetched_at": 42,
                "offline": true,
                "launcher_error": null,
            })
        );

        let failed = serde_json::to_value(NewsFeedDto::from(NewsFeed {
            items: Vec::new(),
            fetched_at: 0,
            offline: false,
            launcher_error: Some(failure(parse_error(
                "https://api.github.com/repos/o/r/releases",
            ))),
        }))
        .unwrap();
        let error = &failed["launcher_error"];
        assert_eq!(error["code"], json!(code::FEED_INVALID));
        assert_eq!(
            error["detail"]["url"],
            json!("https://api.github.com/repos/o/r/releases")
        );
        assert!(error["message"].as_str().is_some_and(|m| !m.is_empty()));
    }

    /// 连不上的端口：HTTP 客户端给出连接类错误，命令边界会在 detail.network 里标 connect。
    async fn connect_error() -> CoreError {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!(
            "http://127.0.0.1:{}/repos/o/r/releases",
            listener.local_addr().unwrap().port()
        );
        drop(listener);
        let source = aurora_base::http::build_client()
            .unwrap()
            .get(&url)
            .send()
            .await
            .unwrap_err();
        CoreError::Fetch { url, source }
    }

    /// 共享的失败与拿走所有权的通用转换逐字段一致：码、原文、url、network 与原因链。
    #[tokio::test]
    async fn shared_launcher_error_matches_command_boundary() {
        let unreachable = connect_error().await;
        let shared = launcher_error(&unreachable);
        assert_eq!(shared.detail.as_ref().unwrap()["network"], json!("connect"));
        assert_eq!(shared, CommandError::from(unreachable));

        let garbled = parse_error("https://api.github.com/repos/o/r/releases");
        assert_eq!(launcher_error(&garbled), CommandError::from(garbled));

        let internal = launcher_error(&CoreError::PlatformUnsupported);
        assert_eq!(internal.code, code::INTERNAL);
        assert_eq!(internal.detail, None);
    }
}
