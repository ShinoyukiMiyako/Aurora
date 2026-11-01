//! 引导程序前后端的接口契约：`app/src/setup/contract.ts` 是它的另一半，字段和取值必须逐一对应。
//!
//! 数字字段按 JS 的 number 传：字节数都远小于 2^53。

use std::fmt;

use serde::{Deserialize, Serialize};

/// 安装进度事件名，载荷是 [`Progress`]。
pub const PROGRESS_EVENT: &str = "setup://progress";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExistingKind {
    Upgrade,
    Same,
    Newer,
    Broken,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Existing {
    pub kind: ExistingKind,
    pub version: String,
    pub dir: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub payload_version: String,
    pub default_dir: String,
    pub required_bytes: u64,
    pub existing: Option<Existing>,
    pub interrupted: bool,
    pub elevated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallMode {
    Fresh,
    Upgrade,
    Repair,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPlan {
    pub mode: InstallMode,
    /// 只有首装带目录：升级和修复时目录由 NSIS 从注册表还原，传了反而会覆盖原位置。
    pub dir: Option<String>,
    pub desktop_shortcut: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DirIssue {
    Empty,
    Relative,
    Bang,
    Forbidden,
    Minecraft,
    Network,
    Unwritable,
    NoSpace,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirCheck {
    pub normalized: String,
    pub issue: Option<DirIssue>,
    pub has_config: bool,
    pub not_empty: bool,
    pub free_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Unpack,
    Write,
    Verify,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub phase: Phase,
    /// 0 到 100，只增不减。
    pub percent: f64,
    pub slow: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureCode {
    DirUnwritable,
    DiskFull,
    ExtractFailed,
    PayloadExit,
    VerifyFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub code: FailureCode,
    /// payload_exit 时是十进制退出码，界面要把它拼进说明；其余是给日志和反馈看的原文。
    pub detail: String,
}

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.code, self.detail)
    }
}

impl std::error::Error for Failure {}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn progress_event_name_matches_the_frontend() {
        assert_eq!(PROGRESS_EVENT, "setup://progress");
    }

    #[test]
    fn probe_serializes_with_camel_case_keys() {
        let probe = Probe {
            payload_version: "0.2.0".into(),
            default_dir: r"C:\Users\a\AppData\Local\Petalfall".into(),
            required_bytes: 41_943_040,
            existing: Some(Existing {
                kind: ExistingKind::Upgrade,
                version: "0.1.0".into(),
                dir: r"E:\Games\Petalfall".into(),
            }),
            interrupted: true,
            elevated: false,
        };
        assert_eq!(
            serde_json::to_value(&probe).unwrap(),
            json!({
                "payloadVersion": "0.2.0",
                "defaultDir": r"C:\Users\a\AppData\Local\Petalfall",
                "requiredBytes": 41_943_040,
                "existing": { "kind": "upgrade", "version": "0.1.0", "dir": r"E:\Games\Petalfall" },
                "interrupted": true,
                "elevated": false,
            })
        );
    }

    #[test]
    fn probe_without_existing_install_sends_null() {
        let probe = Probe {
            payload_version: "0.2.0".into(),
            default_dir: "C:".into(),
            required_bytes: 0,
            existing: None,
            interrupted: false,
            elevated: true,
        };
        assert_eq!(
            serde_json::to_value(&probe).unwrap()["existing"],
            json!(null)
        );
    }

    #[test]
    fn existing_kinds_use_the_frontend_names() {
        for (kind, name) in [
            (ExistingKind::Upgrade, "upgrade"),
            (ExistingKind::Same, "same"),
            (ExistingKind::Newer, "newer"),
            (ExistingKind::Broken, "broken"),
        ] {
            assert_eq!(serde_json::to_value(kind).unwrap(), json!(name));
        }
    }

    #[test]
    fn install_plan_reads_what_the_frontend_sends() {
        let fresh: InstallPlan = serde_json::from_value(json!({
            "mode": "fresh",
            "dir": r"D:\游戏 目录\Petalfall",
            "desktopShortcut": false,
        }))
        .unwrap();
        assert_eq!(
            fresh,
            InstallPlan {
                mode: InstallMode::Fresh,
                dir: Some(r"D:\游戏 目录\Petalfall".into()),
                desktop_shortcut: false,
            }
        );

        let upgrade: InstallPlan = serde_json::from_value(json!({
            "mode": "upgrade",
            "dir": null,
            "desktopShortcut": true,
        }))
        .unwrap();
        assert_eq!(upgrade.mode, InstallMode::Upgrade);
        assert_eq!(upgrade.dir, None);

        let repair: InstallPlan = serde_json::from_value(
            json!({ "mode": "repair", "dir": null, "desktopShortcut": true }),
        )
        .unwrap();
        assert_eq!(repair.mode, InstallMode::Repair);
    }

    #[test]
    fn dir_issues_use_the_frontend_names() {
        for (issue, name) in [
            (DirIssue::Empty, "empty"),
            (DirIssue::Relative, "relative"),
            (DirIssue::Bang, "bang"),
            (DirIssue::Forbidden, "forbidden"),
            (DirIssue::Minecraft, "minecraft"),
            (DirIssue::Network, "network"),
            (DirIssue::Unwritable, "unwritable"),
            (DirIssue::NoSpace, "no_space"),
        ] {
            assert_eq!(serde_json::to_value(issue).unwrap(), json!(name));
        }
    }

    #[test]
    fn dir_check_serializes_with_camel_case_keys() {
        let check = DirCheck {
            normalized: r"D:\Petalfall".into(),
            issue: Some(DirIssue::NoSpace),
            has_config: true,
            not_empty: true,
            free_bytes: 1024,
        };
        assert_eq!(
            serde_json::to_value(&check).unwrap(),
            json!({
                "normalized": r"D:\Petalfall",
                "issue": "no_space",
                "hasConfig": true,
                "notEmpty": true,
                "freeBytes": 1024,
            })
        );
    }

    #[test]
    fn progress_serializes_with_phase_name_and_percent() {
        let progress = Progress {
            phase: Phase::Write,
            percent: 42.5,
            slow: true,
        };
        assert_eq!(
            serde_json::to_value(&progress).unwrap(),
            json!({ "phase": "write", "percent": 42.5, "slow": true })
        );
        assert_eq!(
            serde_json::to_value(Phase::Unpack).unwrap(),
            json!("unpack")
        );
        assert_eq!(
            serde_json::to_value(Phase::Verify).unwrap(),
            json!("verify")
        );
    }

    #[test]
    fn failure_codes_use_the_frontend_names() {
        for (code, name) in [
            (FailureCode::DirUnwritable, "dir_unwritable"),
            (FailureCode::DiskFull, "disk_full"),
            (FailureCode::ExtractFailed, "extract_failed"),
            (FailureCode::PayloadExit, "payload_exit"),
            (FailureCode::VerifyFailed, "verify_failed"),
        ] {
            let failure = Failure {
                code,
                detail: "2".into(),
            };
            assert_eq!(
                serde_json::to_value(&failure).unwrap(),
                json!({ "code": name, "detail": "2" })
            );
        }
    }

    #[test]
    fn failure_display_keeps_the_detail() {
        let failure = Failure {
            code: FailureCode::VerifyFailed,
            detail: "DisplayVersion 是 0.1.0".into(),
        };
        assert_eq!(failure.to_string(), "VerifyFailed: DisplayVersion 是 0.1.0");
    }
}
