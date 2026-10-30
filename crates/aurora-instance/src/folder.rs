//! 官方启动器的游戏目录位置。

use std::path::PathBuf;

use crate::MINECRAFT_DIR_NAME;

/// 官方启动器的 `.minecraft` 目录：`%APPDATA%\.minecraft`。缺少 APPDATA（含非 Windows）时返回 `None`。
pub fn official_minecraft_dir() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|base| PathBuf::from(base).join(MINECRAFT_DIR_NAME))
}
