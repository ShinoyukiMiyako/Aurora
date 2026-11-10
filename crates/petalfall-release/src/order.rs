//! 版本先后与发布通道。

use serde::{Deserialize, Serialize};

/// 发布通道。落盘与跨进程一律用小写名 `dev`、`beta`、`stable`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    /// 预览版：dev 分支的 CI 构建，版本号形如 `1.0.0-dev.12`。
    Dev,
    /// 测试版：beta 分支的 CI 构建，版本号形如 `1.0.0-beta.3`。
    Beta,
    /// 正式版：不带预发布标识，版本号形如 `1.0.0`。
    Stable,
}
