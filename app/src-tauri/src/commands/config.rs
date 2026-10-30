//! 全局配置：读取、按字段更新与切换游戏目录。

use std::path::PathBuf;

use aurora_core::{Aurora, DownloadSourcePolicy, IsolationPolicy, MemorySettings};
use serde::Serialize;
use tauri::State;

use crate::commands::CommandError;
use crate::facade::Facade;

/// 全局配置 DTO（设置页与主页需要读取的安全字段）。
///
/// 这些枚举在 aurora-core 已 derive Serialize 且为 snake_case，直接内嵌即得稳定的 JSON 表示。
#[derive(Debug, Serialize)]
pub struct ConfigDto {
    /// 当前游戏目录（`.minecraft`）绝对路径。
    pub game_dir: String,
    /// 数据目录绝对路径。
    pub data_dir: String,
    /// 文件下载源策略。
    pub download_source: DownloadSourcePolicy,
    /// 版本列表源策略。
    pub version_list_source: DownloadSourcePolicy,
    /// 批量下载文件级并发上限。
    pub download_concurrency: usize,
    /// 内存分配设置。
    pub memory: MemorySettings,
    /// 全局版本隔离档位。
    pub isolation_policy: IsolationPolicy,
    /// 是否已配置微软登录 client_id（不回传 id 本身，前端只需知道能否走正版登录）。
    pub has_client_id: bool,
    /// 找不到匹配 Java 时是否自动下载。
    pub auto_download_java: bool,
    /// 当前选中的实例 id；未选择时为 null。
    pub selected_version: Option<String>,
}

pub(crate) fn config_dto(aurora: &Aurora) -> ConfigDto {
    let config = aurora.config();
    ConfigDto {
        game_dir: aurora.game_dir().display().to_string(),
        data_dir: aurora.data_dir().display().to_string(),
        download_source: config.download_source,
        version_list_source: config.version_list_source,
        download_concurrency: config.download_concurrency,
        memory: config.memory,
        isolation_policy: config.isolation_policy,
        has_client_id: config.msa_client_id.is_some(),
        auto_download_java: config.auto_download_java,
        selected_version: config.selected_version.clone(),
    }
}

/// 只在内存里读，持读锁的时间只有一次结构体拷贝。
pub(crate) async fn read_config(facade: &Facade) -> ConfigDto {
    config_dto(&*facade.read().await)
}

/// 读取全局配置（含游戏目录、内存、下载源策略、是否已配 client_id 等）。
#[tauri::command]
pub async fn get_config(facade: State<'_, Facade>) -> Result<ConfigDto, CommandError> {
    Ok(read_config(&facade).await)
}

/// 更新全局配置：每个给出的字段调对应 setter，最后落盘。字段全可选，未提供者不动。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn update_config(
    download_source: Option<String>,
    version_list_source: Option<String>,
    download_concurrency: Option<usize>,
    memory: Option<MemorySettings>,
    isolation_policy: Option<String>,
    auto_download_java: Option<bool>,
    cache_directory: Option<String>,
    client_id: Option<String>,
    selected_version: Option<String>,
    facade: State<'_, Facade>,
) -> Result<(), CommandError> {
    // 先把全部字符串参数解析完再拿写锁：有一个非法就整体拒绝，不会改了一半才报错。
    let download_source = download_source
        .as_deref()
        .map(parse_download_source_policy)
        .transpose()?;
    let version_list_source = version_list_source
        .as_deref()
        .map(parse_download_source_policy)
        .transpose()?;
    let isolation_policy = isolation_policy
        .as_deref()
        .map(parse_isolation_policy)
        .transpose()?;

    let mut aurora = facade.write().await;
    if let Some(policy) = download_source {
        aurora.set_download_source(policy);
    }
    if let Some(policy) = version_list_source {
        aurora.set_version_list_source(policy)?;
    }
    if let Some(concurrency) = download_concurrency {
        aurora.set_download_concurrency(concurrency);
    }
    if let Some(memory) = memory {
        aurora.set_memory(memory);
    }
    if let Some(policy) = isolation_policy {
        aurora.set_isolation_policy(policy);
    }
    if let Some(enabled) = auto_download_java {
        aurora.set_auto_download_java(enabled);
    }
    if let Some(dir) = cache_directory {
        aurora.set_cache_directory(Some(PathBuf::from(dir)));
    }
    if let Some(id) = client_id {
        aurora.set_client_id(id);
    }
    if let Some(id) = selected_version {
        aurora.set_selected_version(Some(id));
    }
    aurora.save_config().await?;
    Ok(())
}

/// 设置游戏目录（`.minecraft`）并落盘。
#[tauri::command]
pub async fn set_game_directory(
    path: String,
    facade: State<'_, Facade>,
) -> Result<(), CommandError> {
    let mut aurora = facade.write().await;
    aurora.set_game_directory(PathBuf::from(path));
    aurora.save_config().await?;
    Ok(())
}

// 字符串取值统一用核心类型 serde 的 snake_case 表示，与出参 DTO 同一套命名，round-trip 一致。
// 非法值报 invalid_argument，绝不静默兜底一个默认值。

fn parse_download_source_policy(name: &str) -> Result<DownloadSourcePolicy, CommandError> {
    match name {
        "auto" => Ok(DownloadSourcePolicy::Auto),
        "official_first" => Ok(DownloadSourcePolicy::OfficialFirst),
        "mirror_first" => Ok(DownloadSourcePolicy::MirrorFirst),
        other => Err(CommandError::invalid_argument(format!(
            "未知下载源策略 {other}（支持 auto/official_first/mirror_first）"
        ))),
    }
}

fn parse_isolation_policy(name: &str) -> Result<IsolationPolicy, CommandError> {
    match name {
        "disabled" => Ok(IsolationPolicy::Disabled),
        "mod_loaders_only" => Ok(IsolationPolicy::ModLoadersOnly),
        "non_release_only" => Ok(IsolationPolicy::NonReleaseOnly),
        "mod_loaders_and_non_release" => Ok(IsolationPolicy::ModLoadersAndNonRelease),
        "all" => Ok(IsolationPolicy::All),
        other => Err(CommandError::invalid_argument(format!(
            "未知隔离档位 {other}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::error::code;

    #[test]
    fn policy_strings_roundtrip_with_serde_names() {
        for policy in [
            DownloadSourcePolicy::Auto,
            DownloadSourcePolicy::OfficialFirst,
            DownloadSourcePolicy::MirrorFirst,
        ] {
            let name = serde_json::to_value(policy).unwrap();
            assert_eq!(
                parse_download_source_policy(name.as_str().unwrap()).unwrap(),
                policy
            );
        }
        for policy in [
            IsolationPolicy::Disabled,
            IsolationPolicy::ModLoadersOnly,
            IsolationPolicy::NonReleaseOnly,
            IsolationPolicy::ModLoadersAndNonRelease,
            IsolationPolicy::All,
        ] {
            let name = serde_json::to_value(policy).unwrap();
            assert_eq!(
                parse_isolation_policy(name.as_str().unwrap()).unwrap(),
                policy
            );
        }
        assert_eq!(
            parse_download_source_policy("bmclapi").unwrap_err().code,
            code::INVALID_ARGUMENT
        );
        assert_eq!(
            parse_isolation_policy("Disabled").unwrap_err().code,
            code::INVALID_ARGUMENT
        );
    }
}
