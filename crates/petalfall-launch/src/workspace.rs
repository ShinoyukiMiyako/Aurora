//! 游戏工作目录解析：把版本隔离判定收敛成一次调用，产出该次启动应使用的工作目录。
//!
//! 隔离规则本身住在 [`aurora_instance::isolation`]（全局档位 + 版本级覆盖 + 已有 mods/saves 强制隔离），
//! 这里只做一层便捷封装，让启动侧一步拿到 [`ResolvedIsolation`]（其 `working_dir` 直接喂给
//! [`crate::command::CommandBuilder`] 的 `game_dir`）。

use std::path::Path;

use aurora_instance::{IsolationOverride, IsolationPolicy, ResolvedIsolation, resolve_isolation};

use crate::error::Result;

/// 解析某版本此次启动的游戏工作目录（含隔离判定）。
///
/// 参数语义同 [`aurora_instance::resolve_isolation`]：`has_mod_loader` / `is_release` 由版本发现阶段提供，
/// 目录内已有 `mods/` 或 `saves/` 会强制隔离。
pub async fn resolve_game_directory(
    minecraft_dir: &Path,
    version_id: &str,
    policy: IsolationPolicy,
    over: IsolationOverride,
    has_mod_loader: bool,
    is_release: bool,
) -> Result<ResolvedIsolation> {
    let resolved = resolve_isolation(
        minecraft_dir,
        version_id,
        policy,
        over,
        has_mod_loader,
        is_release,
    )
    .await?;
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn isolated_working_dir_points_into_version_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path();
        tokio::fs::create_dir_all(mc.join("versions").join("1.21"))
            .await
            .unwrap();

        // 全部隔离档位 -> 工作目录进版本文件夹。
        let resolved = resolve_game_directory(
            mc,
            "1.21",
            IsolationPolicy::All,
            IsolationOverride::FollowGlobal,
            false,
            true,
        )
        .await
        .unwrap();
        assert!(resolved.isolated);
        assert_eq!(resolved.working_dir, mc.join("versions").join("1.21"));
    }

    #[tokio::test]
    async fn shared_working_dir_is_minecraft_root() {
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path();
        tokio::fs::create_dir_all(mc.join("versions").join("1.21"))
            .await
            .unwrap();

        let resolved = resolve_game_directory(
            mc,
            "1.21",
            IsolationPolicy::Disabled,
            IsolationOverride::FollowGlobal,
            false,
            true,
        )
        .await
        .unwrap();
        assert!(!resolved.isolated);
        assert_eq!(resolved.working_dir, mc);
    }
}
