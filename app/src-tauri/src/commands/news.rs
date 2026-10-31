//! 主页资讯：Mojang 官方启动器内容源的 Java 版条目，加上本启动器的 GitHub Releases。

use aurora_core::{LauncherChannel, NewsFeed, NewsItem};
use serde::Serialize;
use tauri::{AppHandle, State};

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
            launcher_error: feed.launcher_error.map(CommandError::from),
        }
    }
}

/// 取资讯。官方资讯 6 小时内用磁盘缓存，联网失败时退回缓存并标 `offline: true`，
/// 连缓存都没有才让整条命令报错（network_failed 或 feed_invalid，detail.url 为出错的地址）。
/// 启动器资讯进程内缓存 1 小时，正在运行的是正式版时不含预发布；它取不到且没有缓存时
/// 命令照常成功，错误放在 `launcher_error`。
#[tauri::command]
pub async fn list_news(
    app: AppHandle,
    facade: State<'_, Facade>,
) -> Result<NewsFeedDto, CommandError> {
    let version = &app.package_info().version;
    let channel = LauncherChannel::from_version(version.major, !version.pre.is_empty());
    let aurora = facade.snapshot().await;
    Ok(aurora.list_news(channel).await?.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use aurora_base::brand::REPO_URL;
    use aurora_core::{CoreError, NewsTag};
    use serde_json::json;

    use crate::commands::error::code;

    // 前端 TS 引用不到 Rust 常量，仓库地址只能各写一份，由这条测试钉住两边相同。
    #[test]
    fn repo_url_matches_frontend() {
        let decl = format!("export const REPO_URL = \"{REPO_URL}\";");
        assert!(
            include_str!("../../../src/lib/app-info.ts").contains(&decl),
            "app-info.ts 缺少 {decl}"
        );
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
            launcher_error: Some(CoreError::FeedParse {
                url: "https://api.github.com/repos/o/r/releases".into(),
                source: serde_json::from_str::<serde_json::Value>("<html>").unwrap_err(),
            }),
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
}
