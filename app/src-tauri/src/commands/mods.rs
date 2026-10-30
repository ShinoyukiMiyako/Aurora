//! 实例内已装 Mod：列出与启停。

use aurora_core::InstalledMod;
use tauri::State;

use crate::commands::CommandError;
use crate::facade::Facade;

/// 列出指定实例已装 Mod（含禁用态与解析出的元数据）。扫盘与解 jar 在快照上进行。
///
/// [`InstalledMod`] 已 derive Serialize 且不含任何令牌，直接透传。
#[tauri::command]
pub async fn list_mods(
    version_id: String,
    facade: State<'_, Facade>,
) -> Result<Vec<InstalledMod>, CommandError> {
    let aurora = facade.snapshot().await;
    Ok(aurora.list_mods(&version_id).await?)
}

/// 启用/禁用指定实例里的某个 Mod，返回切换后的磁盘路径。
#[tauri::command]
pub async fn set_mod_enabled(
    version_id: String,
    file_name: String,
    enabled: bool,
    facade: State<'_, Facade>,
) -> Result<String, CommandError> {
    let aurora = facade.snapshot().await;
    let path = aurora
        .set_mod_enabled(&version_id, &file_name, enabled)
        .await?;
    Ok(path.display().to_string())
}
