//! 按版本 JSON 的 `javaVersion.majorVersion` 从候选里挑选最合适的 Java。
//!
//! 匹配规则（architecture.md aurora-java 小节）：主版本号必须正确，其次偏好 64 位，
//! JDK/JRE 不作区分；同等条件下版本号高者优先。本 crate 与 aurora-version 同层，
//! 不能反向依赖它，故这里只接受一个 `required_major: u32`（由上层从版本 JSON 取出）。
//!
//! 缺运行时文件的候选（[`JavaInstallation::is_complete`] 为假）一律不参与：它能答出版本，
//! 但拿它启动游戏会在加载核心类库时失败，宁可落到下一个候选或自动下载。

use crate::detect::JavaInstallation;

/// 从候选中挑出匹配 `required_major` 的最佳完整 Java；无匹配返回 `None`（上层据此决定是否自动下载）。
pub fn select_for_major(
    candidates: &[JavaInstallation],
    required_major: u32,
) -> Option<&JavaInstallation> {
    candidates
        .iter()
        .filter(|java| is_eligible(java, required_major))
        .max_by(|a, b| rank_key(a).cmp(&rank_key(b)))
}

/// 返回全部匹配 `required_major` 的完整候选，按「最佳在前」排序，供 UI 列出可选项。
pub fn rank_for_major(
    candidates: &[JavaInstallation],
    required_major: u32,
) -> Vec<&JavaInstallation> {
    let mut matched: Vec<&JavaInstallation> = candidates
        .iter()
        .filter(|java| is_eligible(java, required_major))
        .collect();
    // 降序：先按是否 64 位，再按版本号，最佳排在前面。
    matched.sort_by(|a, b| rank_key(b).cmp(&rank_key(a)));
    matched
}

fn is_eligible(java: &JavaInstallation, required_major: u32) -> bool {
    java.version.major == required_major && java.is_complete()
}

/// 排序键：`(是否 64 位, 版本号)`。`true > false` 使 64 位优先，其后版本号高者优先。
fn rank_key(java: &JavaInstallation) -> (bool, &crate::version::JavaVersion) {
    (java.is_64bit, &java.version)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::detect::{DetectSource, JavaInstallation};
    use crate::version::JavaVersion;
    use std::path::PathBuf;

    fn make(path: &str, version: &str, is_64bit: bool) -> JavaInstallation {
        JavaInstallation {
            path: PathBuf::from(path),
            version: JavaVersion::parse(version).unwrap(),
            is_64bit,
            vendor: "OpenJDK".to_owned(),
            source: DetectSource::CommonDir,
            missing_files: Vec::new(),
        }
    }

    fn incomplete(path: &str, version: &str) -> JavaInstallation {
        JavaInstallation {
            missing_files: vec!["release".to_owned(), "lib/modules".to_owned()],
            ..make(path, version, true)
        }
    }

    #[test]
    fn picks_exact_major_only() {
        let candidates = vec![
            make("a", "1.8.0_402", true),
            make("b", "21.0.3", true),
            make("c", "17.0.1", true),
        ];
        let chosen = select_for_major(&candidates, 17).unwrap();
        assert_eq!(chosen.path, PathBuf::from("c"));
    }

    #[test]
    fn prefers_64bit_over_32bit_same_major() {
        let candidates = vec![make("x86", "17.0.9", false), make("x64", "17.0.1", true)];
        // 即便 32 位版本号更高，也应选 64 位。
        let chosen = select_for_major(&candidates, 17).unwrap();
        assert_eq!(chosen.path, PathBuf::from("x64"));
        assert!(chosen.is_64bit);
    }

    #[test]
    fn prefers_higher_version_when_bitness_equal() {
        let candidates = vec![
            make("old", "17.0.1+12", true),
            make("new", "17.0.9+7", true),
        ];
        let chosen = select_for_major(&candidates, 17).unwrap();
        assert_eq!(chosen.path, PathBuf::from("new"));
    }

    #[test]
    fn no_match_returns_none() {
        let candidates = vec![make("a", "17.0.1", true), make("b", "21.0.3", true)];
        assert!(select_for_major(&candidates, 8).is_none());
        assert!(select_for_major(&[], 17).is_none());
    }

    /// 同主版本一完整一不完整：即使不完整的版本更高、在列表前面，也选完整的那个。
    #[test]
    fn complete_runtime_beats_newer_incomplete_one() {
        let candidates = vec![incomplete("broken", "17.0.12"), make("ok", "17.0.1", true)];
        let chosen = select_for_major(&candidates, 17).unwrap();
        assert_eq!(chosen.path, PathBuf::from("ok"));
    }

    /// 32 位的完整 Java 也胜过 64 位的不完整 Java：完整性是门槛，不是排序权重。
    #[test]
    fn completeness_is_a_gate_before_bitness() {
        let candidates = vec![
            incomplete("x64-broken", "21.0.3"),
            make("x86", "21.0.1", false),
        ];
        let chosen = select_for_major(&candidates, 21).unwrap();
        assert_eq!(chosen.path, PathBuf::from("x86"));
    }

    #[test]
    fn only_incomplete_runtimes_select_none() {
        let candidates = vec![incomplete("a", "21.0.3"), incomplete("b", "21.0.5")];
        assert!(select_for_major(&candidates, 21).is_none());
        assert!(rank_for_major(&candidates, 21).is_empty());
    }

    #[test]
    fn rank_orders_best_first() {
        let candidates = vec![
            make("a", "17.0.1", false),
            make("b", "17.0.9", true),
            make("c", "17.0.5", true),
            make("d", "21.0.0", true),
            incomplete("e", "17.0.12"),
        ];
        let ranked = rank_for_major(&candidates, 17);
        let paths: Vec<_> = ranked
            .iter()
            .map(|j| j.path.to_string_lossy().into_owned())
            .collect();
        // 64 位优先（b、c 在前，按版本降序 b>c），32 位垫底（a）；21 与不完整的 e 不入选。
        assert_eq!(paths, vec!["b", "c", "a"]);
    }
}
