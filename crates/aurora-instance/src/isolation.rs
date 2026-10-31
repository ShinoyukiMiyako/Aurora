//! 版本隔离（PathIndie）：全局档位策略 + 版本级覆盖 + 已有 mods/saves 强制隔离，产出运行工作目录。
//!
//! 隔离即让某版本使用「自己的」游戏工作目录（`versions/<id>/`）而非共享的 `.minecraft` 根，从而各版本
//! 的 mods/saves/配置互不污染。判定优先级（自高而低）：
//!
//! 1. 版本目录内已存在 `mods/` 或 `saves/` —— 强制隔离。共享根会无视这些本地数据，放任不隔离会造成
//!    「装了却不生效」的困惑，故最高优先级强制开启。
//! 2. 版本级覆盖 [`IsolationOverride`]（开启 / 关闭 / 跟随全局）。
//! 3. 全局档位 [`IsolationPolicy`]（对应 PCL2 的五档：关闭 / 仅 Mod 版本 / 仅非正式版 / 两者 / 全部）。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::VERSIONS_DIR;
use crate::error::{Error, Result};

/// 全局版本隔离档位，五档与 PCL2 设置里的选项一一对应。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IsolationPolicy {
    /// 关闭：一律不隔离（仍受「已有 mods/saves 强制隔离」约束）。
    Disabled,
    /// 仅隔离可安装 Mod 的版本（探测到任一加载器）。
    ModLoadersOnly,
    /// 仅隔离非正式版（快照 / 远古测试版等，`type != release`）。
    NonReleaseOnly,
    /// 隔离 Mod 版本与非正式版（上面两者的并集）。
    ///
    /// 作为推荐默认：既挡住加载器版本的 mods 互串，也隔开快照，避免跨版本污染共享 saves/mods。
    #[default]
    ModLoadersAndNonRelease,
    /// 全部隔离。
    All,
}

impl IsolationPolicy {
    /// 档位的中文显示名。
    pub fn display_name(self) -> &'static str {
        match self {
            IsolationPolicy::Disabled => "关闭",
            IsolationPolicy::ModLoadersOnly => "仅隔离可安装 Mod 的版本",
            IsolationPolicy::NonReleaseOnly => "仅隔离非正式版",
            IsolationPolicy::ModLoadersAndNonRelease => "隔离 Mod 版本与非正式版",
            IsolationPolicy::All => "全部隔离",
        }
    }
}

/// 版本级隔离覆盖：让单个版本无视全局档位强制开/关，或跟随全局。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IsolationOverride {
    /// 跟随全局档位。
    #[default]
    FollowGlobal,
    /// 强制隔离。
    Enabled,
    /// 强制不隔离。
    Disabled,
}

impl IsolationOverride {
    /// 是否为「跟随全局」（供设置序列化时省略默认值）。
    pub fn is_follow_global(&self) -> bool {
        matches!(self, IsolationOverride::FollowGlobal)
    }
}

/// 判定隔离所需的三项事实。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IsolationFacts {
    /// 是否探测到任一 Mod 加载器。
    pub has_mod_loader: bool,
    /// 是否为正式版（`type == release`）。
    pub is_release: bool,
    /// 版本目录内是否已存在 `mods/` 或 `saves/`（触发强制隔离）。
    pub has_existing_mods_or_saves: bool,
}

/// 综合档位、版本级覆盖与事实，判定某版本是否隔离。
///
/// 优先级：已有 mods/saves 强制隔离 > 版本级覆盖 > 全局档位。
pub fn is_isolated(
    policy: IsolationPolicy,
    over: IsolationOverride,
    facts: IsolationFacts,
) -> bool {
    if facts.has_existing_mods_or_saves {
        return true;
    }
    match over {
        IsolationOverride::Enabled => true,
        IsolationOverride::Disabled => false,
        IsolationOverride::FollowGlobal => policy_isolates(policy, facts),
    }
}

/// 仅按全局档位（不含覆盖与强制）判定是否隔离。
fn policy_isolates(policy: IsolationPolicy, facts: IsolationFacts) -> bool {
    match policy {
        IsolationPolicy::Disabled => false,
        IsolationPolicy::ModLoadersOnly => facts.has_mod_loader,
        IsolationPolicy::NonReleaseOnly => !facts.is_release,
        IsolationPolicy::ModLoadersAndNonRelease => facts.has_mod_loader || !facts.is_release,
        IsolationPolicy::All => true,
    }
}

/// 根据是否隔离，产出该版本运行时的游戏工作目录（gameDir）。
/// 隔离 -> `versions/<id>/`；不隔离 -> `.minecraft` 根。
pub fn game_working_dir(mc_dir: &Path, version_id: &str, isolated: bool) -> PathBuf {
    if isolated {
        mc_dir.join(VERSIONS_DIR).join(version_id)
    } else {
        mc_dir.to_path_buf()
    }
}

/// 探测版本目录下是否已存在 `mods/` 或 `saves/` 目录（同名普通文件不算）。
pub async fn has_existing_mods_or_saves(version_dir: &Path) -> Result<bool> {
    for sub in ["mods", "saves"] {
        let candidate = version_dir.join(sub);
        match tokio::fs::metadata(&candidate).await {
            Ok(meta) if meta.is_dir() => return Ok(true),
            Ok(_) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(source) => {
                return Err(Error::Io {
                    path: candidate,
                    source,
                });
            }
        }
    }
    Ok(false)
}

/// 一次隔离判定的完整结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedIsolation {
    /// 最终是否隔离。
    pub isolated: bool,
    /// 该版本运行时的游戏工作目录。
    pub working_dir: PathBuf,
    /// 是否由「已有 mods/saves」强制触发（供 UI 解释为何被强制隔离）。
    pub forced_by_local_data: bool,
}

/// 端到端判定：探测磁盘上的 mods/saves，结合传入的加载器/版本类型事实与策略，产出工作目录。
///
/// `version_id` 对应 `mc_dir/versions/<id>`；`has_mod_loader` 与 `is_release` 由版本发现阶段
/// （[`crate::discovery`]）提供。
pub async fn resolve_isolation(
    mc_dir: &Path,
    version_id: &str,
    policy: IsolationPolicy,
    over: IsolationOverride,
    has_mod_loader: bool,
    is_release: bool,
) -> Result<ResolvedIsolation> {
    let version_dir = mc_dir.join(VERSIONS_DIR).join(version_id);
    let forced = has_existing_mods_or_saves(&version_dir).await?;
    let facts = IsolationFacts {
        has_mod_loader,
        is_release,
        has_existing_mods_or_saves: forced,
    };
    let isolated = is_isolated(policy, over, facts);
    Ok(ResolvedIsolation {
        isolated,
        working_dir: game_working_dir(mc_dir, version_id, isolated),
        forced_by_local_data: forced,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 决策真值表：手工给出每行的期望，覆盖全部档位 × 覆盖项 × 事实组合的代表点与边界。
    #[test]
    fn isolation_decision_table() {
        use IsolationOverride as O;
        use IsolationPolicy as P;
        // (policy, override, has_mod_loader, is_release, forced, expected)
        let cases: &[(IsolationPolicy, IsolationOverride, bool, bool, bool, bool)] = &[
            // 强制隔离：无视一切（连档位关闭 + 版本级关闭也照隔离）。
            (P::Disabled, O::Disabled, false, true, true, true),
            (P::All, O::Enabled, true, false, true, true),
            // 版本级覆盖优先于全局档位（非强制）。
            (P::Disabled, O::Enabled, false, true, false, true),
            (P::All, O::Disabled, true, false, false, false),
            // 跟随全局 + 档位「关闭」：永不隔离。
            (P::Disabled, O::FollowGlobal, true, false, false, false),
            (P::Disabled, O::FollowGlobal, false, true, false, false),
            // 跟随全局 + 仅 Mod 版本：看 has_mod_loader。
            (P::ModLoadersOnly, O::FollowGlobal, true, true, false, true),
            (
                P::ModLoadersOnly,
                O::FollowGlobal,
                false,
                false,
                false,
                false,
            ),
            // 跟随全局 + 仅非正式版：看 !is_release。
            (
                P::NonReleaseOnly,
                O::FollowGlobal,
                false,
                true,
                false,
                false,
            ),
            (
                P::NonReleaseOnly,
                O::FollowGlobal,
                false,
                false,
                false,
                true,
            ),
            (P::NonReleaseOnly, O::FollowGlobal, true, true, false, false),
            // 跟随全局 + 两者：并集。
            (
                P::ModLoadersAndNonRelease,
                O::FollowGlobal,
                true,
                true,
                false,
                true,
            ),
            (
                P::ModLoadersAndNonRelease,
                O::FollowGlobal,
                false,
                true,
                false,
                false,
            ),
            (
                P::ModLoadersAndNonRelease,
                O::FollowGlobal,
                false,
                false,
                false,
                true,
            ),
            (
                P::ModLoadersAndNonRelease,
                O::FollowGlobal,
                true,
                false,
                false,
                true,
            ),
            // 跟随全局 + 全部：永远隔离。
            (P::All, O::FollowGlobal, false, true, false, true),
            (P::All, O::FollowGlobal, true, false, false, true),
        ];

        for &(policy, over, has_mod, is_release, forced, expected) in cases {
            let facts = IsolationFacts {
                has_mod_loader: has_mod,
                is_release,
                has_existing_mods_or_saves: forced,
            };
            assert_eq!(
                is_isolated(policy, over, facts),
                expected,
                "policy={policy:?} over={over:?} mod={has_mod} release={is_release} forced={forced}"
            );
        }
    }

    #[test]
    fn working_dir_isolated_points_into_version_folder() {
        let mc = Path::new("D:\\mc");
        let isolated = game_working_dir(mc, "1.21", true);
        assert_eq!(isolated, Path::new("D:\\mc").join("versions").join("1.21"));

        let shared = game_working_dir(mc, "1.21", false);
        assert_eq!(shared, mc);
    }

    #[tokio::test]
    async fn existing_mods_dir_triggers_force_and_yields_version_workdir() {
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path();
        let version_dir = mc.join("versions").join("1.21");
        // 造出 versions/1.21/mods/ 触发强制隔离。
        tokio::fs::create_dir_all(version_dir.join("mods"))
            .await
            .unwrap();

        // 即使全局关闭、版本级关闭，仍应被强制隔离到版本目录。
        let resolved = resolve_isolation(
            mc,
            "1.21",
            IsolationPolicy::Disabled,
            IsolationOverride::Disabled,
            false,
            true,
        )
        .await
        .unwrap();

        assert!(resolved.isolated);
        assert!(resolved.forced_by_local_data);
        assert_eq!(resolved.working_dir, version_dir);
    }

    #[tokio::test]
    async fn no_local_data_follows_policy_and_yields_shared_root() {
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path();
        tokio::fs::create_dir_all(mc.join("versions").join("1.21"))
            .await
            .unwrap();

        // 正式原版 + 关闭档位 + 跟随全局 -> 不隔离 -> 工作目录为 .minecraft 根。
        let resolved = resolve_isolation(
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
        assert!(!resolved.forced_by_local_data);
        assert_eq!(resolved.working_dir, mc);
    }

    #[tokio::test]
    async fn plain_file_named_mods_does_not_force_isolation() {
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path();
        let version_dir = mc.join("versions").join("weird");
        tokio::fs::create_dir_all(&version_dir).await.unwrap();
        // 一个名为 mods 的普通文件，不应被当作 mods 目录。
        tokio::fs::write(version_dir.join("mods"), b"not a dir")
            .await
            .unwrap();

        assert!(!has_existing_mods_or_saves(&version_dir).await.unwrap());
    }
}
