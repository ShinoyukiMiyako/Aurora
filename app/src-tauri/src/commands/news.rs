//! 主页资讯：Mojang 官方启动器内容源的 Java 版条目。

use aurora_core::NewsFeed;
use tauri::State;

use crate::commands::CommandError;
use crate::facade::Facade;

/// 取资讯：6 小时内用磁盘缓存；联网失败时退回缓存并标 `offline: true`；
/// 连缓存都没有才报错（network_failed 或 feed_invalid，detail.url 为出错的地址）。
#[tauri::command]
pub async fn list_news(facade: State<'_, Facade>) -> Result<NewsFeed, CommandError> {
    let aurora = facade.snapshot().await;
    Ok(aurora.list_news().await?)
}
