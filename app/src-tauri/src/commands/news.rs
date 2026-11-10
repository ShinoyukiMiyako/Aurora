//! 主页资讯：Mojang 官方启动器内容源的 Java 版条目，加上本启动器的 GitHub Releases。

use petalfall_core::release::order::Channel;
use petalfall_core::{CoreError, LauncherChannel, NewsFeed, NewsItem, Petalfall};
use semver::Version;
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::commands::error::source_chain;
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

/// 退避期内门面把同一次失败原样重报多次，错误由各次结果共享、拿不走所有权，所以按借用转换；命令照常成功，
/// 日志写明是哪一路没取到，而不是「命令失败」。
fn launcher_error(err: &CoreError) -> CommandError {
    let error = CommandError::describe(err);
    tracing::warn!(code = error.code, message = %error.message, causes = ?source_chain(err), "启动器资讯取不到");
    error
}

/// 取资讯。官方资讯 6 小时内用磁盘缓存，联网失败时退回缓存并标 `offline: true`，
/// 连缓存都没有才让整条命令报错（network_failed 或 feed_invalid，detail.url 为出错的地址）。
/// 启动器资讯进程内缓存 1 小时，偏好的更新通道与安装包的通道都是正式版时不含预发布；它取不到且没有缓存时
/// 命令照常成功，错误放在 `launcher_error`。启动器资讯取不到之后按 1、5、15、60 分钟退避，
/// 退避期内不请求、照样给上次的结果；`retry` 为 true（重试按钮、恢复联网后的重取）时不等退避期满。
#[tauri::command]
pub async fn list_news(
    retry: bool,
    app: AppHandle,
    facade: State<'_, Facade>,
) -> Result<NewsFeedDto, CommandError> {
    let petalfall = facade.snapshot().await;
    let channel = launcher_channel(&petalfall, &app.package_info().version);
    Ok(petalfall.list_news(channel, retry).await?.into())
}

/// 偏好从随后取资讯的那份快照里读，不为它另拿一次门面锁；`package_version` 是正在运行的版本号。
fn launcher_channel(petalfall: &Petalfall, package_version: &Version) -> LauncherChannel {
    LauncherChannel::from_channels(
        petalfall.update_channel_preference(),
        Channel::of_version(package_version),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use petalfall_base::brand::REPO_URL;
    use petalfall_core::news::LauncherFailure;
    use petalfall_core::{NewsTag, PetalfallConfig};
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
        let source = petalfall_base::http::build_client()
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

        // 门面给不出的变体也照通用规则取码，不另起一套
        let unexpected = launcher_error(&CoreError::PlatformUnsupported);
        assert_eq!(unexpected.code, code::PLATFORM_UNSUPPORTED);
        assert_eq!(
            unexpected,
            CommandError::from(CoreError::PlatformUnsupported)
        );
    }

    fn facade_at(dir: &std::path::Path, update_channel: Option<&str>) -> Facade {
        let config = PetalfallConfig {
            update_channel: update_channel.map(|name| json!(name)),
            ..PetalfallConfig::default()
        };
        Facade::new(Petalfall::open(config, dir.to_path_buf(), dir.join("config.json")).unwrap())
    }

    /// 资讯含不含预发布由门面里存着的偏好与正在运行的版本号一起定（`Stable` 时滤掉预发布）。
    #[tokio::test]
    async fn prereleases_follow_the_stored_preference_and_the_package_channel() {
        use LauncherChannel::{Prerelease, Stable};
        for (update_channel, package, expected) in [
            // 偏好测试版的人经跟随装上了正式版，仍看测试版的发布
            (Some("beta"), "1.0.0", Prerelease),
            (Some("dev"), "1.0.0", Prerelease),
            (Some("stable"), "1.0.0", Stable),
            // 偏好缺省按包的通道
            (None, "1.0.0", Stable),
            (None, "1.0.0-dev.3", Prerelease),
            (None, "1.0.0-beta.2", Prerelease),
            // 偏好已改成正式版、还在等正式版追上来，跑的仍是预发布
            (Some("stable"), "1.0.0-beta.2", Prerelease),
            // 认不出的偏好值按缺省算，不因此多给预发布
            (Some("nightly"), "1.0.0", Stable),
            // 包的通道认不出时不是正式版
            (Some("stable"), "1.0.0-rc.1", Prerelease),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let facade = facade_at(dir.path(), update_channel);
            let snapshot = facade.snapshot().await;
            assert_eq!(
                launcher_channel(&snapshot, &Version::parse(package).unwrap()),
                expected,
                "update_channel={update_channel:?} package={package}"
            );
        }
    }
}
