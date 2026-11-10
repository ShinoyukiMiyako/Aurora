//! 引导程序前后端的接口契约：`app/src/setup/contract.ts` 是它的另一半，字段和取值必须逐一对应。
//!
//! 数字字段按 JS 的 number 传：字节数都远小于 2^53。
//!
//! 种类、通道、newer 的原因、安装模式与数据拦截由 `petalfall_release::install_policy` 判定，它用自己的类型；
//! 这里的同名类型只定怎么交给界面。文件末尾的转换逐个取值一一对应、不带通配分支：判定表加了取值，
//! 这里先编译不过，界面那一半也就不会漏掉。

use std::fmt;

use petalfall_release::data_format::TrustedWrittenBy;
use petalfall_release::{install_policy, order};
use serde::{Deserialize, Serialize};

/// 安装进度事件名，载荷是 [`Progress`]。
pub const PROGRESS_EVENT: &str = "setup://progress";

/// 发布通道：dev 是预览版，beta 是测试版，stable 是正式版。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Channel {
    Dev,
    Beta,
    Stable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExistingKind {
    Upgrade,
    Same,
    Newer,
    Broken,
    /// 已装的更新，安装包在严格更慢的通道上：用户在页面上确认、或启动器带换通道开关拉起时才能装回去。
    Switch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Existing {
    pub kind: ExistingKind,
    pub version: String,
    pub dir: String,
    /// 由 `version` 推出；认不出时（含解析不了、卸载项没有版本）为 `None`。
    pub channel: Option<Channel>,
}

/// 启动器的更新插件拉起时才有：命令行带了 `/UPDATE`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateLaunch {
    /// 带了 `/R`：装完替用户重新打开启动器。
    pub relaunch: bool,
}

/// 种类是 newer 时为什么不能装，界面按它挑说明，不拿两边的通道自己推。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NewerReason {
    /// 同一个通道上更早的包。
    SameChannel,
    /// 比已装的通道更快的通道上更早的包。
    FasterChannel,
    /// 更慢通道上更早的包，却由不带换通道开关的自动更新拉起。
    SlowerChannel,
    /// 任一侧的通道认不出。
    UnknownChannel,
}

/// 数据关拦下的两种情形。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DataProblem {
    /// 数据记着的格式号高于安装包认得的号：这份数据被更新的版本用过。
    TooNew,
    /// 记号读不懂。
    Unreadable,
}

/// 数据关拦下时的详情，探测结果与目录校验结果共用。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataBlock {
    pub problem: DataProblem,
    /// 挡下的那个记号文件。
    pub path: String,
    /// 记号里的号，读不懂时为 `None`。号只进日志，界面不显示。
    pub recorded: Option<u32>,
    /// 安装包认得的号。
    pub supported: u32,
    /// 读不懂的原因原文，太新时为 `None`。
    pub reason: Option<String>,
    /// 把号抬上去的版本。记号里的原文可能出自别人的机器，只有形状是落樱发过的版本号才有值，可以直接显示。
    pub written_by: Option<String>,
    /// `written_by` 所属的通道，与它同时有值。
    pub written_by_channel: Option<Channel>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub payload_version: String,
    /// 由 `payload_version` 推出，认不出时为 `None`。
    pub payload_channel: Option<Channel>,
    pub default_dir: String,
    pub required_bytes: u64,
    pub existing: Option<Existing>,
    pub interrupted: bool,
    pub elevated: bool,
    /// 交互启动时是 `None`。
    pub update: Option<UpdateLaunch>,
    /// 只在种类是 newer 时有值。
    pub newer_reason: Option<NewerReason>,
    /// 界面能发起的安装模式，为空时什么都不能装。
    pub allowed_modes: Vec<InstallMode>,
    /// 更新模式下不经页面直接装的模式，只会是 upgrade 或 switch；为 `None` 时走交互的页面。
    pub unattended: Option<InstallMode>,
    /// 用户在页面上确认安装时会写交接记录，启动器下次启动据它对上更新通道；界面据此用「换到」的说法。
    pub handoff: bool,
    /// 数据关拦下时有值，这时允许的模式为空。
    pub data_block: Option<DataBlock>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallMode {
    Fresh,
    Upgrade,
    Repair,
    /// 换到更慢的通道，装回较早的版本。
    Switch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPlan {
    pub mode: InstallMode,
    /// 只有首装带目录：升级、修复和换通道装回探测到的登记目录，不让界面换位置，换了原来那份就成孤儿。
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
    /// 被数据关拦下。只作标志，太新还是读不懂、谁写的，看 `DirCheck` 的 `data_block`。
    DataIncompatible,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirCheck {
    pub normalized: String,
    pub issue: Option<DirIssue>,
    pub has_config: bool,
    pub not_empty: bool,
    /// `not_empty` 时在 `normalized` 末尾追加了一层 `Petalfall`；目录本来就叫这个名字时不追加。
    pub appended: bool,
    pub free_bytes: u64,
    /// `issue` 是 `DataIncompatible` 时有值，其余为 `None`。
    pub data_block: Option<DataBlock>,
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

impl From<order::Channel> for Channel {
    fn from(channel: order::Channel) -> Self {
        match channel {
            order::Channel::Dev => Self::Dev,
            order::Channel::Beta => Self::Beta,
            order::Channel::Stable => Self::Stable,
        }
    }
}

impl From<install_policy::ExistingKind> for ExistingKind {
    fn from(kind: install_policy::ExistingKind) -> Self {
        match kind {
            install_policy::ExistingKind::Upgrade => Self::Upgrade,
            install_policy::ExistingKind::Same => Self::Same,
            install_policy::ExistingKind::Newer => Self::Newer,
            install_policy::ExistingKind::Broken => Self::Broken,
            install_policy::ExistingKind::Switch => Self::Switch,
        }
    }
}

impl From<install_policy::NewerReason> for NewerReason {
    fn from(reason: install_policy::NewerReason) -> Self {
        match reason {
            install_policy::NewerReason::SameChannel => Self::SameChannel,
            install_policy::NewerReason::FasterChannel => Self::FasterChannel,
            install_policy::NewerReason::SlowerChannel => Self::SlowerChannel,
            install_policy::NewerReason::UnknownChannel => Self::UnknownChannel,
        }
    }
}

impl From<install_policy::InstallMode> for InstallMode {
    fn from(mode: install_policy::InstallMode) -> Self {
        match mode {
            install_policy::InstallMode::Fresh => Self::Fresh,
            install_policy::InstallMode::Upgrade => Self::Upgrade,
            install_policy::InstallMode::Repair => Self::Repair,
            install_policy::InstallMode::Switch => Self::Switch,
        }
    }
}

impl DataBlock {
    /// 判定表只给出由记号定下的那部分；挡下的记号文件 `path` 与安装包认得的号 `supported` 由调用方补上。
    pub fn from_policy(block: install_policy::DataBlock, path: String, supported: u32) -> Self {
        match block {
            install_policy::DataBlock::TooNew {
                recorded,
                written_by,
            } => {
                let (written_by, written_by_channel) = match written_by {
                    Some(TrustedWrittenBy { version, channel }) => {
                        (Some(version.to_string()), Some(channel.into()))
                    }
                    None => (None, None),
                };
                Self {
                    problem: DataProblem::TooNew,
                    path,
                    recorded: Some(recorded),
                    supported,
                    reason: None,
                    written_by,
                    written_by_channel,
                }
            }
            install_policy::DataBlock::Unreadable { reason } => Self {
                problem: DataProblem::Unreadable,
                path,
                recorded: None,
                supported,
                reason: Some(reason),
                written_by: None,
                written_by_channel: None,
            },
        }
    }
}

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
            payload_channel: Some(Channel::Stable),
            default_dir: r"C:\Users\a\AppData\Local\Petalfall".into(),
            required_bytes: 41_943_040,
            existing: Some(Existing {
                kind: ExistingKind::Upgrade,
                version: "0.1.0".into(),
                dir: r"E:\Games\Petalfall".into(),
                channel: Some(Channel::Stable),
            }),
            interrupted: true,
            elevated: false,
            update: Some(UpdateLaunch { relaunch: true }),
            newer_reason: None,
            allowed_modes: vec![InstallMode::Upgrade],
            unattended: Some(InstallMode::Upgrade),
            handoff: false,
            data_block: None,
        };
        assert_eq!(
            serde_json::to_value(&probe).unwrap(),
            json!({
                "payloadVersion": "0.2.0",
                "payloadChannel": "stable",
                "defaultDir": r"C:\Users\a\AppData\Local\Petalfall",
                "requiredBytes": 41_943_040,
                "existing": {
                    "kind": "upgrade",
                    "version": "0.1.0",
                    "dir": r"E:\Games\Petalfall",
                    "channel": "stable",
                },
                "interrupted": true,
                "elevated": false,
                "update": { "relaunch": true },
                "newerReason": null,
                "allowedModes": ["upgrade"],
                "unattended": "upgrade",
                "handoff": false,
                "dataBlock": null,
            })
        );
    }

    #[test]
    fn probe_without_existing_install_or_update_sends_null() {
        let probe = Probe {
            payload_version: "0.2.0".into(),
            payload_channel: Some(Channel::Stable),
            default_dir: "C:".into(),
            required_bytes: 0,
            existing: None,
            interrupted: false,
            elevated: true,
            update: None,
            newer_reason: None,
            allowed_modes: vec![InstallMode::Fresh],
            unattended: None,
            handoff: false,
            data_block: None,
        };
        let value = serde_json::to_value(&probe).unwrap();
        assert_eq!(value["existing"], json!(null));
        assert_eq!(value["update"], json!(null));
        assert_eq!(value["newerReason"], json!(null));
        assert_eq!(value["unattended"], json!(null));
        assert_eq!(value["dataBlock"], json!(null));
    }

    #[test]
    fn a_switch_probe_names_both_channels_and_the_handoff() {
        let probe = Probe {
            payload_version: "1.0.0-beta.5".into(),
            payload_channel: Some(Channel::Beta),
            default_dir: r"C:\Users\a\AppData\Local\Petalfall".into(),
            required_bytes: 1,
            existing: Some(Existing {
                kind: ExistingKind::Switch,
                version: "1.1.0-dev.61".into(),
                dir: r"E:\Games\Petalfall".into(),
                channel: Some(Channel::Dev),
            }),
            interrupted: false,
            elevated: false,
            update: None,
            newer_reason: None,
            allowed_modes: vec![InstallMode::Switch],
            unattended: None,
            handoff: true,
            data_block: None,
        };
        let value = serde_json::to_value(&probe).unwrap();
        assert_eq!(value["payloadChannel"], json!("beta"));
        assert_eq!(
            value["existing"],
            json!({
                "kind": "switch",
                "version": "1.1.0-dev.61",
                "dir": r"E:\Games\Petalfall",
                "channel": "dev",
            })
        );
        assert_eq!(value["allowedModes"], json!(["switch"]));
        assert_eq!(value["handoff"], json!(true));
    }

    #[test]
    fn an_unknown_channel_is_sent_as_null() {
        let existing = Existing {
            kind: ExistingKind::Newer,
            version: "1.0.0-rc.1".into(),
            dir: r"E:\Games\Petalfall".into(),
            channel: None,
        };
        assert_eq!(
            serde_json::to_value(&existing).unwrap()["channel"],
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
            (ExistingKind::Switch, "switch"),
        ] {
            assert_eq!(serde_json::to_value(kind).unwrap(), json!(name));
        }
    }

    #[test]
    fn channels_use_the_frontend_names() {
        for (channel, name) in [
            (Channel::Dev, "dev"),
            (Channel::Beta, "beta"),
            (Channel::Stable, "stable"),
        ] {
            assert_eq!(serde_json::to_value(channel).unwrap(), json!(name));
        }
    }

    #[test]
    fn newer_reasons_use_the_frontend_names() {
        for (reason, name) in [
            (NewerReason::SameChannel, "same_channel"),
            (NewerReason::FasterChannel, "faster_channel"),
            (NewerReason::SlowerChannel, "slower_channel"),
            (NewerReason::UnknownChannel, "unknown_channel"),
        ] {
            assert_eq!(serde_json::to_value(reason).unwrap(), json!(name));
        }
    }

    #[test]
    fn install_modes_use_the_frontend_names() {
        for (mode, name) in [
            (InstallMode::Fresh, "fresh"),
            (InstallMode::Upgrade, "upgrade"),
            (InstallMode::Repair, "repair"),
            (InstallMode::Switch, "switch"),
        ] {
            assert_eq!(serde_json::to_value(mode).unwrap(), json!(name));
        }
    }

    #[test]
    fn data_blocks_serialize_with_camel_case_keys() {
        let too_new = DataBlock {
            problem: DataProblem::TooNew,
            path: r"C:\Users\a\AppData\Local\Petalfall\data-format.json".into(),
            recorded: Some(3),
            supported: 2,
            reason: None,
            written_by: Some("1.1.0-dev.57".into()),
            written_by_channel: Some(Channel::Dev),
        };
        assert_eq!(
            serde_json::to_value(&too_new).unwrap(),
            json!({
                "problem": "too_new",
                "path": r"C:\Users\a\AppData\Local\Petalfall\data-format.json",
                "recorded": 3,
                "supported": 2,
                "reason": null,
                "writtenBy": "1.1.0-dev.57",
                "writtenByChannel": "dev",
            })
        );

        let unreadable = DataBlock {
            problem: DataProblem::Unreadable,
            path: r"D:\Petalfall\data-format.json".into(),
            recorded: None,
            supported: 2,
            reason: Some("data_format 不是正整数".into()),
            written_by: None,
            written_by_channel: None,
        };
        assert_eq!(
            serde_json::to_value(&unreadable).unwrap(),
            json!({
                "problem": "unreadable",
                "path": r"D:\Petalfall\data-format.json",
                "recorded": null,
                "supported": 2,
                "reason": "data_format 不是正整数",
                "writtenBy": null,
                "writtenByChannel": null,
            })
        );
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

        let switch: InstallPlan = serde_json::from_value(
            json!({ "mode": "switch", "dir": null, "desktopShortcut": false }),
        )
        .unwrap();
        assert_eq!(switch.mode, InstallMode::Switch);
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
            (DirIssue::DataIncompatible, "data_incompatible"),
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
            appended: true,
            free_bytes: 1024,
            data_block: None,
        };
        assert_eq!(
            serde_json::to_value(&check).unwrap(),
            json!({
                "normalized": r"D:\Petalfall",
                "issue": "no_space",
                "hasConfig": true,
                "notEmpty": true,
                "appended": true,
                "freeBytes": 1024,
                "dataBlock": null,
            })
        );
    }

    #[test]
    fn a_data_incompatible_dir_check_carries_the_data_block() {
        let check = DirCheck {
            normalized: r"D:\Games\Petalfall".into(),
            issue: Some(DirIssue::DataIncompatible),
            has_config: true,
            not_empty: false,
            appended: false,
            free_bytes: 1024,
            data_block: Some(DataBlock {
                problem: DataProblem::Unreadable,
                path: r"D:\Games\Petalfall\data-format.json".into(),
                recorded: None,
                supported: 1,
                reason: Some("不是 JSON".to_owned()),
                written_by: None,
                written_by_channel: None,
            }),
        };
        let value = serde_json::to_value(&check).unwrap();
        assert_eq!(value["issue"], json!("data_incompatible"));
        assert_eq!(value["dataBlock"]["problem"], json!("unreadable"));
        assert_eq!(
            value["dataBlock"]["path"],
            json!(r"D:\Games\Petalfall\data-format.json")
        );
        assert_eq!(value["dataBlock"]["reason"], json!("不是 JSON"));
    }

    #[test]
    fn data_problems_use_the_frontend_names() {
        for (problem, name) in [
            (DataProblem::TooNew, "too_new"),
            (DataProblem::Unreadable, "unreadable"),
        ] {
            assert_eq!(serde_json::to_value(problem).unwrap(), json!(name));
        }
    }

    /// 两边的通道名各定一处：契约给界面的名字要与启动器落盘、交接记录用的名字相同。
    #[test]
    fn release_channels_map_one_to_one_and_keep_their_names() {
        for (release, channel) in [
            (order::Channel::Dev, Channel::Dev),
            (order::Channel::Beta, Channel::Beta),
            (order::Channel::Stable, Channel::Stable),
        ] {
            assert_eq!(Channel::from(release), channel);
            assert_eq!(
                serde_json::to_value(channel).unwrap(),
                json!(release.as_str())
            );
        }
    }

    #[test]
    fn policy_kinds_map_one_to_one() {
        for (policy, kind) in [
            (install_policy::ExistingKind::Upgrade, ExistingKind::Upgrade),
            (install_policy::ExistingKind::Same, ExistingKind::Same),
            (install_policy::ExistingKind::Newer, ExistingKind::Newer),
            (install_policy::ExistingKind::Broken, ExistingKind::Broken),
            (install_policy::ExistingKind::Switch, ExistingKind::Switch),
        ] {
            assert_eq!(ExistingKind::from(policy), kind);
        }
    }

    #[test]
    fn policy_newer_reasons_map_one_to_one() {
        for (policy, reason) in [
            (
                install_policy::NewerReason::SameChannel,
                NewerReason::SameChannel,
            ),
            (
                install_policy::NewerReason::FasterChannel,
                NewerReason::FasterChannel,
            ),
            (
                install_policy::NewerReason::SlowerChannel,
                NewerReason::SlowerChannel,
            ),
            (
                install_policy::NewerReason::UnknownChannel,
                NewerReason::UnknownChannel,
            ),
        ] {
            assert_eq!(NewerReason::from(policy), reason);
        }
    }

    #[test]
    fn policy_install_modes_map_one_to_one() {
        for (policy, mode) in [
            (install_policy::InstallMode::Fresh, InstallMode::Fresh),
            (install_policy::InstallMode::Upgrade, InstallMode::Upgrade),
            (install_policy::InstallMode::Repair, InstallMode::Repair),
            (install_policy::InstallMode::Switch, InstallMode::Switch),
        ] {
            assert_eq!(InstallMode::from(policy), mode);
        }
    }

    const STAMP: &str = r"C:\Users\a\AppData\Local\Petalfall\data-format.json";

    #[test]
    fn a_too_new_block_keeps_the_trusted_writer_and_its_channel() {
        let written_by = petalfall_release::data_format::trusted_written_by("1.1.0-dev.57");
        let block = install_policy::DataBlock::TooNew {
            recorded: 3,
            written_by,
        };

        assert_eq!(
            DataBlock::from_policy(block, STAMP.to_owned(), 2),
            DataBlock {
                problem: DataProblem::TooNew,
                path: STAMP.to_owned(),
                recorded: Some(3),
                supported: 2,
                reason: None,
                written_by: Some("1.1.0-dev.57".to_owned()),
                written_by_channel: Some(Channel::Dev),
            }
        );
    }

    #[test]
    fn a_too_new_block_without_a_trusted_writer_names_nobody() {
        let block = install_policy::DataBlock::TooNew {
            recorded: u32::MAX,
            written_by: None,
        };

        assert_eq!(
            DataBlock::from_policy(block, STAMP.to_owned(), 1),
            DataBlock {
                problem: DataProblem::TooNew,
                path: STAMP.to_owned(),
                recorded: Some(u32::MAX),
                supported: 1,
                reason: None,
                written_by: None,
                written_by_channel: None,
            }
        );
    }

    #[test]
    fn an_unreadable_block_keeps_the_reason_and_has_no_number() {
        let block = install_policy::DataBlock::Unreadable {
            reason: "data_format 不是正整数".to_owned(),
        };

        assert_eq!(
            DataBlock::from_policy(block, STAMP.to_owned(), 2),
            DataBlock {
                problem: DataProblem::Unreadable,
                path: STAMP.to_owned(),
                recorded: None,
                supported: 2,
                reason: Some("data_format 不是正整数".to_owned()),
                written_by: None,
                written_by_channel: None,
            }
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
