//! 安装引导程序的判定表：手里这个安装包，能以哪些方式装到这台电脑现有的安装上。
//!
//! 只做判断，不碰注册表、磁盘和窗口：引导程序把查到的事实传进来，按交回的结论行事。放在共用包里，
//! 判定表的每一格才能在 CI 上穷举。
//!
//! 判定分三步，先后不能换：先过数据格式关，再看版本与通道，最后看是谁发起的（[`Initiation`]）。
//! 拆成两个函数，中间由引导程序做半装恢复（上次没装完时把种类改成 broken 或首装）：
//! - [`judge_kind`]：看版本、通道与发起方式，定下种类、两边通道的关系与 newer 的原因；
//! - [`judge_modes`]：拿半装恢复之后的种类、两边通道的关系与数据关的结论，定下允许的模式、无人值守的模式、
//!   要不要写交接记录（[`crate::handoff`]）。数据关一票否决：数据记着的格式号高于安装包认得的号、或记号读不懂时，
//!   什么都不装，看起来是升级也一样。
//!
//! 记号：Vi、Ci 是已装的版本与通道，Vp、Cp 是安装包的版本与通道；版本按 [`compare_lenient`] 比，
//! 通道按 [`channel_of`] 认。数据关放行时：
//!
//! | 行 | 版本 | 两边的通道 | 交互 | 更新 | 更新并带换通道开关 |
//! |---|---|---|---|---|---|
//! | 1 | Vi < Vp | 相同，或任一侧认不出 | upgrade | 无人值守 upgrade | 同「更新」 |
//! | 2a | Vi < Vp | 安装包更快 | upgrade，写交接记录 | 无人值守 upgrade | 同「更新」 |
//! | 2b | Vi < Vp | 安装包更慢 | upgrade | 无人值守 upgrade | 同「更新」 |
//! | 3 | Vi = Vp | 不看 | same：repair | same：repair，不无人值守 | 同「更新」 |
//! | 4 | Vi > Vp | 相同 | newer | newer | newer |
//! | 5 | Vi > Vp | 安装包严格更慢 | switch，写交接记录 | newer | 无人值守 switch |
//! | 6 | Vi > Vp | 安装包更快 | newer | newer | newer |
//! | 7 | Vi > Vp | 任一侧认不出 | newer | newer | newer |
//! | 8 | 程序文件缺失或没有版本 | 不看 | broken：repair | broken：repair，不无人值守 | 同「更新」 |
//! | 9 | 没有安装 | 不看 | fresh | fresh，不无人值守 | 同「更新」 |
//!
//! newer 什么都不能装。装回较早的版本只有第 5 行这一格：
//! - 只认安装包的通道严格更慢。启动器只会往更慢的通道换过去；想换到更快的通道，装它最新的包就是第 2a 行的
//!   升级，更快通道的旧包在任何发起方式下都没有正当用途。这条规则随每个安装包发出去，放宽了就收不回，所以从严。
//!   任一侧通道认不出时同样不放行。
//! - 不带开关的自动更新遇到它判 newer：自动更新只收严格新于当前版本的包，自动路径上不会合法地出现更旧的包，
//!   不能让一次没人发起的安装去讨换通道的同意。

use std::cmp::Ordering;

use semver::Version;

use crate::data_format::{StampVerdict, TrustedWrittenBy, trusted_written_by};
use crate::order::{Channel, compare_versions};

/// 带容错的版本先后，比卸载项里的 DisplayVersion 与安装包的版本用：两侧都能解析时按 [`compare_versions`] 比，
/// 构建元数据不参与；一侧解析不了时能解析的那一侧更大；两侧都解析不了算相等。
///
/// 容错与 NSIS 模板的 SemverCompare 一致。DisplayVersion 可能被手改或写坏，这样写坏的安装仍能被升级，
/// 而版本解析不了的安装包永远装不到版本能解析的安装上。
pub fn compare_lenient(left: &str, right: &str) -> Ordering {
    match (Version::parse(left), Version::parse(right)) {
        (Ok(left), Ok(right)) => compare_versions(&left, &right),
        (Ok(_), Err(_)) => Ordering::Greater,
        (Err(_), Ok(_)) => Ordering::Less,
        (Err(_), Err(_)) => Ordering::Equal,
    }
}

/// 版本文本所属的通道，规则同 [`Channel::of_version`]；解析不了的文本也是认不出（`None`）。
///
/// 判定里的 Ci、Cp 都由它算；探测结果里给界面看的两个通道也该用它，界面说的才与判定一致。
pub fn channel_of(version: &str) -> Option<Channel> {
    Version::parse(version)
        .ok()
        .and_then(|version| Channel::of_version(&version))
}

/// 这次安装是谁发起的。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Initiation {
    /// 用户自己打开安装包：命令行没有 `/UPDATE`。
    Interactive,
    /// 启动器自动更新拉起：带 `/UPDATE`，不带 `/CHANNELSWITCH`。
    Update,
    /// 启动器为换通道拉起：带 `/UPDATE` 与 `/CHANNELSWITCH`。
    UpdateWithSwitch,
}

/// 卸载项登记的一份现有安装。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Installed<'a> {
    /// 卸载项里的 DisplayVersion；没写或为空时是 `None`。
    pub version: Option<&'a str>,
    /// 程序文件完好。
    pub program_intact: bool,
}

/// 现有安装相对这个安装包的种类，取名与安装引导程序的界面契约一致。没有安装不在其中，判定里用 `None` 表示。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ExistingKind {
    /// 已装的更旧：第 1、2a、2b 行。
    Upgrade,
    /// 版本相同：第 3 行。
    Same,
    /// 已装的更新，又不是能装回去的那一格：第 4、6、7 行，以及不带开关的更新遇到的第 5 行。原因见 [`NewerReason`]。
    Newer,
    /// 程序文件缺失或卸载项没有版本：第 8 行。半装恢复也会改成它。
    Broken,
    /// 换到严格更慢的通道、装回较早的版本：交互或带开关时的第 5 行。
    Switch,
}

/// 种类是 [`ExistingKind::Newer`] 时为什么不能装，界面按它挑说明。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum NewerReason {
    /// 同一个通道上更早的包：第 4 行。
    SameChannel,
    /// 比已装的通道更快的通道上更早的包：第 6 行。
    FasterChannel,
    /// 更慢通道上更早的包，却由不带换通道开关的自动更新拉起：第 5 行。
    SlowerChannel,
    /// 任一侧的通道认不出：第 7 行。
    UnknownChannel,
}

/// 安装包的通道 Cp 相对已装的通道 Ci。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ChannelRelation {
    /// 同一个通道。
    Same,
    /// 安装包的通道更快。
    PayloadFaster,
    /// 安装包的通道更慢。
    PayloadSlower,
    /// 任一侧认不出，包括没有安装、卸载项没有版本。
    Unknown,
}

impl ChannelRelation {
    /// 两边的通道比快慢，`None` 是认不出。
    pub fn between(installed: Option<Channel>, payload: Option<Channel>) -> Self {
        let (Some(installed), Some(payload)) = (installed, payload) else {
            return Self::Unknown;
        };
        if payload.is_faster_than(installed) {
            Self::PayloadFaster
        } else if payload.is_slower_than(installed) {
            Self::PayloadSlower
        } else {
            Self::Same
        }
    }
}

/// [`judge_kind`] 的结论。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KindJudgment {
    /// 种类；没有安装时为 `None`。
    pub kind: Option<ExistingKind>,
    /// 两边通道的关系，交给 [`judge_modes`] 分出第 2a、2b 行。
    pub relation: ChannelRelation,
    /// 只在种类是 [`ExistingKind::Newer`] 时有值。
    pub newer_reason: Option<NewerReason>,
}

/// 看版本、通道与发起方式定种类：模块说明里那张表的前三列与种类。`installed` 为 `None` 表示没有安装，
/// `payload_version` 是安装包自己的版本。
///
/// 半装恢复在这之后由引导程序做，可能把种类改成 [`ExistingKind::Broken`] 或没有安装；
/// [`ExistingKind::Newer`] 与 [`ExistingKind::Switch`] 要原样保留，否则「重新安装」就绕过了不让装旧包的判定与
/// 换通道的确认。
pub fn judge_kind(
    installed: Option<Installed<'_>>,
    payload_version: &str,
    initiation: Initiation,
) -> KindJudgment {
    let payload_channel = channel_of(payload_version);
    let Some(installed) = installed else {
        return KindJudgment {
            kind: None,
            relation: ChannelRelation::between(None, payload_channel),
            newer_reason: None,
        };
    };
    let relation =
        ChannelRelation::between(installed.version.and_then(channel_of), payload_channel);
    let (kind, newer_reason) = match installed.version.filter(|_| installed.program_intact) {
        None => (ExistingKind::Broken, None),
        Some(version) => match compare_lenient(version, payload_version) {
            Ordering::Less => (ExistingKind::Upgrade, None),
            Ordering::Equal => (ExistingKind::Same, None),
            Ordering::Greater => older_payload(relation, initiation),
        },
    };
    KindJudgment {
        kind: Some(kind),
        relation,
        newer_reason,
    }
}

/// 安装包比已装的旧：第 4 到 7 行。
fn older_payload(
    relation: ChannelRelation,
    initiation: Initiation,
) -> (ExistingKind, Option<NewerReason>) {
    match (relation, initiation) {
        (
            ChannelRelation::PayloadSlower,
            Initiation::Interactive | Initiation::UpdateWithSwitch,
        ) => (ExistingKind::Switch, None),
        (ChannelRelation::PayloadSlower, Initiation::Update) => {
            (ExistingKind::Newer, Some(NewerReason::SlowerChannel))
        }
        (ChannelRelation::Same, _) => (ExistingKind::Newer, Some(NewerReason::SameChannel)),
        (ChannelRelation::PayloadFaster, _) => {
            (ExistingKind::Newer, Some(NewerReason::FasterChannel))
        }
        (ChannelRelation::Unknown, _) => (ExistingKind::Newer, Some(NewerReason::UnknownChannel)),
    }
}

/// 安装引导程序能用的安装模式，取名与界面契约一致。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum InstallMode {
    /// 首装。
    Fresh,
    /// 升级。
    Upgrade,
    /// 修复：同版本重装，或补全残缺的安装。
    Repair,
    /// 换到更慢的通道，装回较早的版本。
    Switch,
}

/// 数据关拦下的原因。界面契约里的挡下的文件路径与安装包认得的号由调用方补上，这里只给由记号定下的部分。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DataBlock {
    /// 数据记着的号高于安装包认得的号：这份数据被更新的版本用过。
    TooNew {
        /// 记号里的号。
        recorded: u32,
        /// 把号抬上去的那个版本，已经过 [`trusted_written_by`]：不合格的当作没有，可以直接拿给用户看。
        written_by: Option<TrustedWrittenBy>,
    },
    /// 记号读不懂。
    Unreadable {
        /// 读不懂的原因原文，不含路径。
        reason: String,
    },
}

impl DataBlock {
    /// 数据关的结论：放行时为 `None`。安装引导程序从不写记号，记号低于安装包的号与相等一样放行。
    ///
    /// 选目录时检查目标目录的记号也用它，与探测时拦下的说法一致。
    pub fn from_verdict(verdict: &StampVerdict) -> Option<Self> {
        match verdict {
            StampVerdict::Pass | StampVerdict::Raise => None,
            StampVerdict::TooNew { found, written_by } => Some(DataBlock::TooNew {
                recorded: *found,
                written_by: written_by.as_deref().and_then(trusted_written_by),
            }),
            StampVerdict::Unreadable { reason } => Some(DataBlock::Unreadable {
                reason: reason.clone(),
            }),
        }
    }
}

/// [`judge_modes`] 的结论。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModeJudgment {
    /// 允许的模式，至多一个；为空时什么都不能装。
    pub allowed_modes: Vec<InstallMode>,
    /// 更新模式下不经页面直接装的模式，只会是 upgrade 或 switch；为 `None` 时退回交互的页面。
    pub unattended: Option<InstallMode>,
    /// 用户在页面上确认安装时要不要写交接记录，记下安装包的通道与版本。
    pub handoff: bool,
    /// 数据关拦下时的原因；有值时允许的模式一定为空。
    pub data_block: Option<DataBlock>,
}

/// 定下能用哪些模式装：模块说明里那张表的后三列，再加数据关的一票否决。
///
/// - `kind` 是半装恢复之后的种类，`None` 表示没有安装；
/// - `relation` 原样取 [`judge_kind`] 交回的；
/// - `data` 是数据根的记号与安装包认得的号比出来的结论（[`crate::data_format::judge_stamp`]）。没有安装时是要装进去的
///   那个目录的结论；探测时目录还没定，交 [`StampVerdict::Pass`] 即可，交回的只有 fresh，目标目录的数据关由选目录
///   与安装前的复核在最终目录上做；
/// - `initiation` 与交给 [`judge_kind`] 的相同。
///
/// 交接记录只在用户亲手换到另一个通道时写，也就是交互的第 2a、5 行，并且半装恢复之后仍是升级或换通道：
/// 启动器下次启动据它把更新通道对上，不然存着的较慢偏好会让刚换到更快通道的用户一直等较慢的通道追上来。
/// 第 2b 行的版本多半是启动器跟着更新本来就会送来的（例如测试版用户收到同号的正式版），装它不等于换通道，
/// 不改偏好。更新模式一律不写：自动跟随由启动器自己记偏好，带开关拉起之前启动器已经把偏好改成了目标通道。
///
/// # Panics
///
/// `kind` 是 [`ExistingKind::Switch`]，而 `relation` 不是 [`ChannelRelation::PayloadSlower`]、或 `initiation` 是
/// [`Initiation::Update`] 时：[`judge_kind`] 不会交出这种组合，收到它说明调用方把两步的输入接错了，
/// 照着算下去可能放行一次不该有的降级。
pub fn judge_modes(
    kind: Option<ExistingKind>,
    relation: ChannelRelation,
    data: &StampVerdict,
    initiation: Initiation,
) -> ModeJudgment {
    if kind == Some(ExistingKind::Switch) {
        assert!(
            relation == ChannelRelation::PayloadSlower && initiation != Initiation::Update,
            "switch 只出自安装包通道严格更慢、交互或带开关的判定，收到的是 {relation:?} 与 {initiation:?}"
        );
    }
    if let Some(block) = DataBlock::from_verdict(data) {
        return ModeJudgment {
            allowed_modes: Vec::new(),
            unattended: None,
            handoff: false,
            data_block: Some(block),
        };
    }
    let interactive = initiation == Initiation::Interactive;
    // 同版本、残缺、没有安装都不是自动更新该遇到的情形：不替用户装，退回交互的页面让他看清再定。
    let (mode, unattended, handoff) = match kind {
        None => (Some(InstallMode::Fresh), None, false),
        Some(ExistingKind::Upgrade) => (
            Some(InstallMode::Upgrade),
            (!interactive).then_some(InstallMode::Upgrade),
            interactive && relation == ChannelRelation::PayloadFaster,
        ),
        Some(ExistingKind::Same | ExistingKind::Broken) => (Some(InstallMode::Repair), None, false),
        Some(ExistingKind::Switch) => (
            Some(InstallMode::Switch),
            (initiation == Initiation::UpdateWithSwitch).then_some(InstallMode::Switch),
            interactive,
        ),
        Some(ExistingKind::Newer) => (None, None, false),
    };
    ModeJudgment {
        allowed_modes: mode.into_iter().collect(),
        unattended,
        handoff,
        data_block: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::collections::HashSet;

    use crate::data_format::{
        DATA_FORMAT, Stamp, StampFile, StampRead, WrittenBy, judge_stamp, parse_stamp,
    };

    use super::ExistingKind as K;
    use super::InstallMode as M;
    use super::NewerReason as R;

    /// 什么模式都不允许。
    const NOTHING: [InstallMode; 0] = [];

    const INITIATIONS: [Initiation; 3] = [
        Initiation::Interactive,
        Initiation::Update,
        Initiation::UpdateWithSwitch,
    ];

    /// 2^53 + 1：JS 的 Number 从这里起分不清相邻的整数。
    const TWO_POW_53_PLUS_1: u128 = (1 << 53) + 1;

    /// 解析不了的版本串：空串、少一段、带前缀、前导零、空的预发布段或构建段、两端带空格、不是版本号的文字。
    const UNPARSEABLE: [&str; 12] = [
        "",
        "not-a-version",
        "1.2",
        "v1.0.0",
        "01.0.0",
        "1.0.0-dev.01",
        "1.0.0-",
        " 1.0.0",
        "1.0.0 ",
        "1.0.0-dev..1",
        "1.0.0+",
        "不是版本",
    ];

    fn intact(version: &str) -> Installed<'_> {
        Installed {
            version: Some(version),
            program_intact: true,
        }
    }

    fn program_missing(version: &str) -> Installed<'_> {
        Installed {
            version: Some(version),
            program_intact: false,
        }
    }

    const fn without_version(program_intact: bool) -> Installed<'static> {
        Installed {
            version: None,
            program_intact,
        }
    }

    /// 越快越小。测试自己的快慢次序，不借被测模块与通道模块的比较。
    fn speed(channel: Channel) -> u8 {
        match channel {
            Channel::Dev => 0,
            Channel::Beta => 1,
            Channel::Stable => 2,
        }
    }

    fn judge(
        installed: Option<Installed<'_>>,
        payload: &str,
        data: &StampVerdict,
        initiation: Initiation,
    ) -> (KindJudgment, ModeJudgment) {
        let kind = judge_kind(installed, payload, initiation);
        let modes = judge_modes(kind.kind, kind.relation, data, initiation);
        (kind, modes)
    }

    fn goes_back(modes: &ModeJudgment) -> bool {
        modes.allowed_modes.contains(&M::Switch) || modes.unattended == Some(M::Switch)
    }

    fn trusted(version: &str, channel: Channel) -> TrustedWrittenBy {
        TrustedWrittenBy {
            version: Version::parse(version).unwrap(),
            channel,
        }
    }

    // ---- 带容错的版本比较 ----

    #[test]
    fn unparseable_versions_follow_the_nsis_tolerance() {
        assert_eq!(compare_lenient("not-a-version", "0.2.0"), Ordering::Less);
        assert_eq!(compare_lenient("0.2.0", "not-a-version"), Ordering::Greater);
        assert_eq!(compare_lenient("garbage", "not-a-version"), Ordering::Equal);
        assert_eq!(compare_lenient("", "0.2.0"), Ordering::Less);
        assert_eq!(compare_lenient("1.2", "0.0.1"), Ordering::Less);
        for text in UNPARSEABLE {
            assert!(Version::parse(text).is_err(), "{text:?} 竟然能解析");
            assert_eq!(compare_lenient(text, "0.0.0"), Ordering::Less, "{text:?}");
            assert_eq!(
                compare_lenient("0.0.0", text),
                Ordering::Greater,
                "{text:?}"
            );
            for other in UNPARSEABLE {
                assert_eq!(
                    compare_lenient(text, other),
                    Ordering::Equal,
                    "{text:?} 对 {other:?}"
                );
            }
        }
    }

    #[test]
    fn parseable_versions_compare_by_semver_precedence_without_build_metadata() {
        let cases = [
            ("0.2.0-dev.9", "0.2.0-dev.12", Ordering::Less),
            ("0.2.0-dev.12", "0.2.0", Ordering::Less),
            ("1.0.0-beta.999", "1.0.0-dev.1", Ordering::Less),
            ("1.1.0-dev.61", "1.0.0-beta.5", Ordering::Greater),
            ("1.0.0", "1.0.0", Ordering::Equal),
            ("0.2.0+b", "0.2.0+a", Ordering::Equal),
            ("1.0.0-beta.1+zzz", "1.0.0-dev.1", Ordering::Less),
        ];
        for (left, right, expected) in cases {
            assert_eq!(compare_lenient(left, right), expected, "{left} 对 {right}");
            assert_eq!(
                compare_lenient(right, left),
                expected.reverse(),
                "{right} 对 {left}"
            );
        }
    }

    #[test]
    fn channel_of_text_is_unknown_when_it_does_not_parse() {
        let cases = [
            ("1.0.0-dev.42", Some(Channel::Dev)),
            ("1.0.0-beta.3", Some(Channel::Beta)),
            ("1.0.0", Some(Channel::Stable)),
            ("1.0.0+build.5", Some(Channel::Stable)),
            ("1.0.0-BETA.2", Some(Channel::Beta)),
            ("1.0.0-rc.1", None),
        ];
        for (text, expected) in cases {
            assert_eq!(channel_of(text), expected, "{text}");
        }
        for text in UNPARSEABLE {
            assert_eq!(channel_of(text), None, "{text:?}");
        }
    }

    #[test]
    fn channel_relation_compares_the_payload_against_the_installed_channel() {
        let channels = [
            Some(Channel::Dev),
            Some(Channel::Beta),
            Some(Channel::Stable),
            None,
        ];
        for installed in channels {
            for payload in channels {
                let expected = match (installed, payload) {
                    (Some(i), Some(p)) if speed(p) < speed(i) => ChannelRelation::PayloadFaster,
                    (Some(i), Some(p)) if speed(p) > speed(i) => ChannelRelation::PayloadSlower,
                    (Some(_), Some(_)) => ChannelRelation::Same,
                    _ => ChannelRelation::Unknown,
                };
                assert_eq!(
                    ChannelRelation::between(installed, payload),
                    expected,
                    "{installed:?} 对 {payload:?}"
                );
            }
        }
    }

    // ---- 判定表逐格 ----

    /// 判定表的行，与模块说明里那张表一一对应。
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
    enum Row {
        One,
        TwoA,
        TwoB,
        Three,
        Four,
        Five,
        Six,
        Seven,
        Eight,
        Nine,
    }

    /// 数据关的三种结论。
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
    enum DataClass {
        Pass,
        TooNew,
        Unreadable,
    }

    /// 数据关放行时一格的期望。
    #[derive(Debug, Clone, Copy)]
    struct Cell {
        kind: Option<ExistingKind>,
        reason: Option<NewerReason>,
        allowed: &'static [InstallMode],
        unattended: Option<InstallMode>,
        handoff: bool,
    }

    const fn cell(
        kind: Option<ExistingKind>,
        reason: Option<NewerReason>,
        allowed: &'static [InstallMode],
        unattended: Option<InstallMode>,
        handoff: bool,
    ) -> Cell {
        Cell {
            kind,
            reason,
            allowed,
            unattended,
            handoff,
        }
    }

    /// 数据关放行时，每一行在交互、更新、更新并带开关三种发起方式下的期望，照模块说明里的表逐格抄下，
    /// 不用被测函数推算。数据关拦下时，任何一行的结论都是什么都不装、不无人值守、不写交接记录。
    fn table(row: Row) -> [Cell; 3] {
        let upgrade_by_hand = cell(Some(K::Upgrade), None, &[M::Upgrade], None, false);
        let upgrade_alone = cell(
            Some(K::Upgrade),
            None,
            &[M::Upgrade],
            Some(M::Upgrade),
            false,
        );
        match row {
            Row::One | Row::TwoB => [upgrade_by_hand, upgrade_alone, upgrade_alone],
            Row::TwoA => [
                cell(Some(K::Upgrade), None, &[M::Upgrade], None, true),
                upgrade_alone,
                upgrade_alone,
            ],
            Row::Three => [cell(Some(K::Same), None, &[M::Repair], None, false); 3],
            Row::Four => [cell(Some(K::Newer), Some(R::SameChannel), &[], None, false); 3],
            Row::Five => [
                cell(Some(K::Switch), None, &[M::Switch], None, true),
                cell(Some(K::Newer), Some(R::SlowerChannel), &[], None, false),
                cell(Some(K::Switch), None, &[M::Switch], Some(M::Switch), false),
            ],
            Row::Six => [cell(Some(K::Newer), Some(R::FasterChannel), &[], None, false); 3],
            Row::Seven => [cell(Some(K::Newer), Some(R::UnknownChannel), &[], None, false); 3],
            Row::Eight => [cell(Some(K::Broken), None, &[M::Repair], None, false); 3],
            Row::Nine => [cell(None, None, &[M::Fresh], None, false); 3],
        }
    }

    /// 每行的代表：版本与通道都照那一行的条件挑，一行可以有几个，期望的通道关系写在最后。
    #[rustfmt::skip]
    fn table_samples() -> Vec<(Row, Option<Installed<'static>>, &'static str, ChannelRelation)> {
        use ChannelRelation::{PayloadFaster, PayloadSlower, Same, Unknown};
        vec![
            (Row::One,   Some(intact("1.0.0-dev.40")),          "1.0.0-dev.41",   Same),
            (Row::One,   Some(intact("1.0.0-beta.2")),          "1.0.0-beta.3",   Same),
            (Row::One,   Some(intact("1.0.0")),                 "1.0.1",          Same),
            (Row::One,   Some(intact("1.0.0-rc.1")),            "1.0.0",          Unknown),
            (Row::One,   Some(intact("0.9.0")),                 "1.0.0-rc.2",     Unknown),
            (Row::One,   Some(intact("不是版本")),              "1.0.0-dev.41",   Unknown),
            (Row::TwoA,  Some(intact("1.0.0-beta.3")),          "1.0.0-dev.60",   PayloadFaster),
            (Row::TwoA,  Some(intact("1.0.0")),                 "1.1.0-beta.1",   PayloadFaster),
            (Row::TwoA,  Some(intact("1.0.0")),                 "1.1.0-dev.1",    PayloadFaster),
            (Row::TwoB,  Some(intact("1.0.0-beta.4")),          "1.0.0",          PayloadSlower),
            (Row::TwoB,  Some(intact("1.0.0-dev.60")),          "1.0.0",          PayloadSlower),
            (Row::TwoB,  Some(intact("0.1.0-dev.41")),          "1.0.0-beta.2",   PayloadSlower),
            (Row::Three, Some(intact("1.0.0-dev.60")),          "1.0.0-dev.60",   Same),
            (Row::Three, Some(intact("1.0.0+a")),               "1.0.0+b",        Same),
            (Row::Three, Some(intact("garbage")),               "not-a-version",  Unknown),
            (Row::Four,  Some(intact("1.0.0-dev.60")),          "1.0.0-dev.55",   Same),
            (Row::Four,  Some(intact("1.0.1")),                 "1.0.0",          Same),
            (Row::Four,  Some(intact("1.0.0-beta.4")),          "1.0.0-beta.3",   Same),
            (Row::Five,  Some(intact("1.1.0-dev.61")),          "1.0.0-beta.5",   PayloadSlower),
            (Row::Five,  Some(intact("1.0.0-dev.1")),           "1.0.0-beta.999", PayloadSlower),
            (Row::Five,  Some(intact("1.1.0-beta.1")),          "1.0.0",          PayloadSlower),
            (Row::Five,  Some(intact("1.1.0-dev.1")),           "1.0.1",          PayloadSlower),
            (Row::Six,   Some(intact("1.0.0")),                 "1.0.0-beta.4",   PayloadFaster),
            (Row::Six,   Some(intact("1.1.0-beta.1")),          "1.0.0-dev.60",   PayloadFaster),
            (Row::Six,   Some(intact("1.0.0")),                 "1.0.0-dev.60",   PayloadFaster),
            (Row::Seven, Some(intact("1.1.0-rc.1")),            "1.0.0-beta.5",   Unknown),
            (Row::Seven, Some(intact("1.0.0")),                 "1.0.0-rc.1",     Unknown),
            (Row::Seven, Some(intact("1.0.0-dev.1")),           "不是版本",       Unknown),
            (Row::Eight, Some(program_missing("1.0.0-dev.60")), "1.0.0-dev.41",   Same),
            (Row::Eight, Some(program_missing("1.1.0-dev.61")), "1.0.0-beta.5",   PayloadSlower),
            (Row::Eight, Some(program_missing("1.0.0-beta.3")), "1.0.0-dev.60",   PayloadFaster),
            (Row::Eight, Some(without_version(true)),           "1.0.0-dev.41",   Unknown),
            (Row::Eight, Some(without_version(false)),          "1.0.0-dev.41",   Unknown),
            (Row::Nine,  None,                                  "1.0.0-dev.41",   Unknown),
            (Row::Nine,  None,                                  "1.0.0",          Unknown),
        ]
    }

    /// 数据关的结论连同拦下时应交出的原因。放行一栏用两种：记号等于安装包的号，和记号更低（引导程序不写记号，同样放行）。
    fn data_cases() -> Vec<(DataClass, StampVerdict, Option<DataBlock>)> {
        let reason = "不是 JSON：expected value at line 1 column 1".to_owned();
        vec![
            (DataClass::Pass, StampVerdict::Pass, None),
            (DataClass::Pass, StampVerdict::Raise, None),
            (
                DataClass::TooNew,
                StampVerdict::TooNew {
                    found: 2,
                    written_by: Some("1.1.0-dev.57".to_owned()),
                },
                Some(DataBlock::TooNew {
                    recorded: 2,
                    written_by: Some(trusted("1.1.0-dev.57", Channel::Dev)),
                }),
            ),
            (
                DataClass::Unreadable,
                StampVerdict::Unreadable {
                    reason: reason.clone(),
                },
                Some(DataBlock::Unreadable { reason }),
            ),
        ]
    }

    #[test]
    fn every_cell_of_the_table_gives_its_kind_modes_and_handoff() {
        let data = data_cases();
        let mut covered = HashSet::new();
        for (row, installed, payload, relation) in table_samples() {
            let cells = table(row);
            for (initiation, want) in INITIATIONS.into_iter().zip(cells) {
                let context = format!("{row:?} {installed:?} 装 {payload} {initiation:?}");
                let kind = judge_kind(installed, payload, initiation);
                assert_eq!(
                    kind,
                    KindJudgment {
                        kind: want.kind,
                        relation,
                        newer_reason: want.reason,
                    },
                    "{context}"
                );
                for (class, verdict, block) in &data {
                    let expected = match block {
                        None => ModeJudgment {
                            allowed_modes: want.allowed.to_vec(),
                            unattended: want.unattended,
                            handoff: want.handoff,
                            data_block: None,
                        },
                        Some(block) => ModeJudgment {
                            allowed_modes: Vec::new(),
                            unattended: None,
                            handoff: false,
                            data_block: Some(block.clone()),
                        },
                    };
                    assert_eq!(
                        judge_modes(kind.kind, kind.relation, verdict, initiation),
                        expected,
                        "{context} 数据 {verdict:?}"
                    );
                    covered.insert((row, initiation, *class));
                }
            }
        }
        assert_eq!(
            covered.len(),
            10 * 3 * 3,
            "没有走遍十行、三种发起方式、三种数据结论"
        );
    }

    // ---- 重点钉死 ----

    /// 已装的在 1.1.0 这个基础号上、安装包在 1.0.0 上，不论什么通道已装的都更新；四条线两两配对。
    #[test]
    fn going_back_needs_a_strictly_slower_channel_and_a_hand_or_the_switch_flag() {
        let lines = [
            (Some(Channel::Dev), "-dev.5"),
            (Some(Channel::Beta), "-beta.5"),
            (Some(Channel::Stable), ""),
            (None, "-rc.5"),
        ];
        let mut went_back = 0;
        for (installed_channel, installed_tag) in lines {
            for (payload_channel, payload_tag) in lines {
                let installed = format!("1.1.0{installed_tag}");
                let payload = format!("1.0.0{payload_tag}");
                let strictly_slower = matches!(
                    (installed_channel, payload_channel),
                    (Some(i), Some(p)) if speed(p) > speed(i)
                );
                for initiation in INITIATIONS {
                    let (kind, modes) = judge(
                        Some(intact(&installed)),
                        &payload,
                        &StampVerdict::Pass,
                        initiation,
                    );
                    let allowed = strictly_slower && initiation != Initiation::Update;
                    let context = format!("{installed} 装 {payload} {initiation:?}");
                    assert_eq!(goes_back(&modes), allowed, "{context}");
                    if allowed {
                        went_back += 1;
                        assert_eq!(kind.kind, Some(K::Switch), "{context}");
                        assert_eq!(modes.allowed_modes, [M::Switch], "{context}");
                    } else {
                        // 不能换过去时什么都不能装，不会退成升级或修复
                        assert_eq!(kind.kind, Some(K::Newer), "{context}");
                        assert_eq!(modes.allowed_modes, NOTHING, "{context}");
                        assert_eq!(modes.unattended, None, "{context}");
                    }
                }
            }
        }
        // 三对严格更慢的通道，各有交互与带开关两种
        assert_eq!(went_back, 3 * 2);
    }

    #[test]
    fn an_older_package_on_the_same_channel_is_newer_even_with_the_switch_flag() {
        for (installed, payload) in [
            ("1.0.0-dev.60", "1.0.0-dev.55"),
            ("1.0.0-beta.4", "1.0.0-beta.3"),
            ("1.0.1", "1.0.0"),
            ("1.1.0-dev.1", "1.0.0-dev.9007199254740993"),
        ] {
            for initiation in INITIATIONS {
                let (kind, modes) = judge(
                    Some(intact(installed)),
                    payload,
                    &StampVerdict::Pass,
                    initiation,
                );
                let context = format!("{installed} 装 {payload} {initiation:?}");
                assert_eq!(kind.kind, Some(K::Newer), "{context}");
                assert_eq!(kind.newer_reason, Some(R::SameChannel), "{context}");
                assert_eq!(modes.allowed_modes, NOTHING, "{context}");
                assert_eq!(modes.unattended, None, "{context}");
                assert!(!modes.handoff, "{context}");
            }
        }
    }

    #[test]
    fn an_older_package_on_a_faster_channel_is_newer_however_it_is_launched() {
        for (installed, payload) in [
            ("1.0.0", "1.0.0-beta.4"),
            ("1.0.0", "1.0.0-dev.60"),
            ("1.1.0-beta.1", "1.0.0-dev.60"),
            ("2.0.0", "1.9.0-dev.1"),
        ] {
            for initiation in INITIATIONS {
                let (kind, modes) = judge(
                    Some(intact(installed)),
                    payload,
                    &StampVerdict::Pass,
                    initiation,
                );
                let context = format!("{installed} 装 {payload} {initiation:?}");
                assert_eq!(kind.kind, Some(K::Newer), "{context}");
                assert_eq!(kind.newer_reason, Some(R::FasterChannel), "{context}");
                assert_eq!(modes.allowed_modes, NOTHING, "{context}");
                assert_eq!(modes.unattended, None, "{context}");
            }
        }
    }

    /// 数据关用真实的记号读法与判定：安装包认得的是本版号，记号高一号或读不懂。
    #[test]
    fn data_newer_than_the_package_or_unreadable_allows_no_mode_even_for_an_upgrade() {
        let too_new_stamp = format!(
            r#"{{"data_format":{},"written_by":"9.9.9"}}"#,
            DATA_FORMAT + 1
        );
        let too_new = judge_stamp(
            &parse_stamp(StampFile::Contents(too_new_stamp.as_bytes())),
            DATA_FORMAT,
        );
        let unreadable = judge_stamp(
            &parse_stamp(StampFile::Contents(b"{\"data_format\":0}")),
            DATA_FORMAT,
        );
        let StampVerdict::Unreadable { reason } = &unreadable else {
            panic!("号为 0 的记号应当读不懂，实际是 {unreadable:?}");
        };
        let cases = [
            (Some(intact("1.0.0-dev.40")), "1.0.0-dev.41"),
            (Some(intact("1.0.0-beta.3")), "1.0.0-dev.60"),
            (Some(intact("1.0.0-beta.4")), "1.0.0"),
            (Some(intact("1.1.0-dev.61")), "1.0.0-beta.5"),
            (Some(intact("1.0.0-dev.60")), "1.0.0-dev.60"),
            (Some(program_missing("1.0.0-dev.60")), "1.0.0-dev.60"),
            (None, "1.0.0-dev.41"),
        ];
        for (installed, payload) in cases {
            for initiation in INITIATIONS {
                let context = format!("{installed:?} 装 {payload} {initiation:?}");
                let (_, modes) = judge(installed, payload, &too_new, initiation);
                assert_eq!(
                    modes,
                    ModeJudgment {
                        allowed_modes: Vec::new(),
                        unattended: None,
                        handoff: false,
                        data_block: Some(DataBlock::TooNew {
                            recorded: DATA_FORMAT + 1,
                            written_by: Some(trusted("9.9.9", Channel::Stable)),
                        }),
                    },
                    "{context}"
                );
                let (_, modes) = judge(installed, payload, &unreadable, initiation);
                assert_eq!(
                    modes,
                    ModeJudgment {
                        allowed_modes: Vec::new(),
                        unattended: None,
                        handoff: false,
                        data_block: Some(DataBlock::Unreadable {
                            reason: reason.clone(),
                        }),
                    },
                    "{context}"
                );
            }
        }
    }

    #[test]
    fn handoff_only_for_interactive_upgrade_to_a_faster_channel_or_switch() {
        let data = data_cases();
        let mut written = HashSet::new();
        for (row, installed, payload, _) in table_samples() {
            for initiation in INITIATIONS {
                for (class, verdict, _) in &data {
                    let (_, modes) = judge(installed, payload, verdict, initiation);
                    let expected = matches!(row, Row::TwoA | Row::Five)
                        && initiation == Initiation::Interactive
                        && *class == DataClass::Pass;
                    assert_eq!(
                        modes.handoff, expected,
                        "{row:?} {installed:?} 装 {payload} {initiation:?} {verdict:?}"
                    );
                    if modes.handoff {
                        written.insert(row);
                    }
                }
            }
        }
        assert_eq!(written, HashSet::from([Row::TwoA, Row::Five]));
    }

    /// 半装恢复把第 2a 行的升级改成修复或首装之后，界面显示的是「重新安装」或首装，不再写交接记录；
    /// 换通道的种类恢复时保持不变，照旧写。
    #[test]
    fn handoff_follows_the_kind_left_after_interrupted_install_recovery() {
        let interactive = Initiation::Interactive;
        let pass = StampVerdict::Pass;
        let faster = judge_kind(Some(intact("1.0.0-beta.3")), "1.0.0-dev.60", interactive);
        assert_eq!(faster.kind, Some(K::Upgrade));
        assert!(judge_modes(faster.kind, faster.relation, &pass, interactive).handoff);
        assert_eq!(
            judge_modes(Some(K::Broken), faster.relation, &pass, interactive),
            ModeJudgment {
                allowed_modes: vec![M::Repair],
                unattended: None,
                handoff: false,
                data_block: None,
            }
        );
        assert_eq!(
            judge_modes(None, faster.relation, &pass, interactive),
            ModeJudgment {
                allowed_modes: vec![M::Fresh],
                unattended: None,
                handoff: false,
                data_block: None,
            }
        );

        let slower = judge_kind(Some(intact("1.1.0-dev.61")), "1.0.0-beta.5", interactive);
        assert_eq!(slower.kind, Some(K::Switch));
        assert_eq!(
            judge_modes(slower.kind, slower.relation, &pass, interactive),
            ModeJudgment {
                allowed_modes: vec![M::Switch],
                unattended: None,
                handoff: true,
                data_block: None,
            }
        );
    }

    #[test]
    #[should_panic(expected = "switch")]
    fn a_switch_kind_under_a_plain_update_is_refused_loudly() {
        judge_modes(
            Some(K::Switch),
            ChannelRelation::PayloadSlower,
            &StampVerdict::Pass,
            Initiation::Update,
        );
    }

    #[test]
    #[should_panic(expected = "switch")]
    fn a_switch_kind_without_a_slower_payload_channel_is_refused_loudly() {
        judge_modes(
            Some(K::Switch),
            ChannelRelation::Same,
            &StampVerdict::TooNew {
                found: 9,
                written_by: None,
            },
            Initiation::UpdateWithSwitch,
        );
    }

    #[test]
    fn a_data_block_carries_only_a_written_by_fit_to_show() {
        let too_new = |written_by: Option<&str>| StampVerdict::TooNew {
            found: 3,
            written_by: written_by.map(str::to_owned),
        };
        let cases = [
            (None, None),
            (
                Some("1.1.0-dev.57"),
                Some(trusted("1.1.0-dev.57", Channel::Dev)),
            ),
            (
                Some("1.0.0-beta.3"),
                Some(trusted("1.0.0-beta.3", Channel::Beta)),
            ),
            (Some("1.0.0"), Some(trusted("1.0.0", Channel::Stable))),
            (Some("1.0.0-rc.1"), None),
            (Some("1.0.0-dev.01"), None),
            (Some("1.0.0+build"), None),
            (Some("请到 example.com 下载 1.0.0"), None),
        ];
        for (written_by, expected) in cases {
            assert_eq!(
                DataBlock::from_verdict(&too_new(written_by)),
                Some(DataBlock::TooNew {
                    recorded: 3,
                    written_by: expected,
                }),
                "{written_by:?}"
            );
        }
        assert_eq!(DataBlock::from_verdict(&StampVerdict::Pass), None);
        assert_eq!(DataBlock::from_verdict(&StampVerdict::Raise), None);
    }

    // ---- 随机不变量 ----

    /// 随机版本串连同它在模型里的排序键与通道。键按 semver 的结果写死：同一核心号下 beta、dev、rc 依次排在
    /// 正式版前面（预发布标识按 ASCII 比），序号按数比；解析不了的串键为 `None`，比任何能解析的都小、彼此相等，
    /// 同 NSIS 的容错。
    #[derive(Debug, Clone)]
    struct Drawn {
        text: String,
        key: Option<(u64, u64, u64, u8, u128)>,
        channel: Option<Channel>,
    }

    fn pre_release(
        rng: &mut fastrand::Rng,
        (major, minor): (u64, u64),
        tag: &str,
        line: u8,
        channel: Option<Channel>,
    ) -> Drawn {
        let prefix = format!("{major}.{minor}.0-{tag}.");
        let seq = match rng.u8(..4) {
            0 => [0, 1, TWO_POW_53_PLUS_1][rng.usize(..3)],
            // 序号补到整个版本串正好 48 字节，载荷头装得下的最长版本；rc 的前缀短，补满会超出 u128，只取小序号
            1 if tag != "rc" => {
                let digits = 48 - prefix.len() as u32;
                let lowest = 10u128.pow(digits - 1);
                lowest + rng.u128(..9 * lowest)
            }
            _ => rng.u128(..100),
        };
        Drawn {
            text: format!("{prefix}{seq}"),
            key: Some((major, minor, 0, line, seq)),
            channel,
        }
    }

    fn draw_version(rng: &mut fastrand::Rng) -> Drawn {
        let base = (rng.u64(..4), rng.u64(..4));
        match rng.u8(..10) {
            0 => Drawn {
                text: UNPARSEABLE[rng.usize(..UNPARSEABLE.len())].to_owned(),
                key: None,
                channel: None,
            },
            1 => pre_release(rng, base, "rc", 2, None),
            2 | 3 => {
                let patch = rng.u64(..3);
                Drawn {
                    text: format!("{}.{}.{patch}", base.0, base.1),
                    key: Some((base.0, base.1, patch, 3, 0)),
                    channel: Some(Channel::Stable),
                }
            }
            4..=6 => pre_release(rng, base, "beta", 0, Some(Channel::Beta)),
            _ => pre_release(rng, base, "dev", 1, Some(Channel::Dev)),
        }
    }

    /// 数据记着的号相对安装包认得的号。
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
    enum Tier {
        Below,
        Equal,
        Above,
        Unreadable,
    }

    /// 半装恢复对种类做了什么。已装的比安装包新（newer、switch）时保持原判。
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
    enum Recovery {
        Kept,
        ToBroken,
        ToFresh,
    }

    fn recover(
        kind: Option<ExistingKind>,
        rng: &mut fastrand::Rng,
    ) -> (Option<ExistingKind>, Recovery) {
        match kind {
            Some(K::Upgrade | K::Same | K::Broken) => match rng.u8(..4) {
                0 => (Some(K::Broken), Recovery::ToBroken),
                1 => (None, Recovery::ToFresh),
                _ => (kind, Recovery::Kept),
            },
            _ => (kind, Recovery::Kept),
        }
    }

    #[test]
    fn random_installs_keep_the_seven_invariants() {
        let written_bys = [
            (WrittenBy::Absent, None),
            (
                WrittenBy::Text("1.1.0-dev.57".to_owned()),
                Some(("1.1.0-dev.57", Channel::Dev)),
            ),
            (
                WrittenBy::Text("1.0.0-beta.3".to_owned()),
                Some(("1.0.0-beta.3", Channel::Beta)),
            ),
            (
                WrittenBy::Text("1.0.0".to_owned()),
                Some(("1.0.0", Channel::Stable)),
            ),
            (WrittenBy::Text("1.0.0-rc.1".to_owned()), None),
            (WrittenBy::Text("请到 example.com 下载".to_owned()), None),
            (WrittenBy::NotText("3".to_owned()), None),
        ];
        let mut rng = fastrand::Rng::with_seed(0x1257_a11e);
        let mut tiers = HashSet::new();
        let mut recoveries = HashSet::new();
        let mut reasons = HashSet::new();
        let mut kinds = HashSet::new();
        let (mut went_back, mut handoffs_on_upgrade, mut handoffs_on_switch) = (0, 0, 0);
        let mut drawn_texts = Vec::new();

        for _ in 0..20_000 {
            let initiation = INITIATIONS[rng.usize(..3)];
            let installed_drawn = draw_version(&mut rng);
            let (installed_version, program_intact) = match rng.u8(..10) {
                0 => (None, None),
                1 => (None, Some(rng.bool())),
                2 => (Some(installed_drawn.clone()), Some(false)),
                _ => (Some(installed_drawn.clone()), Some(true)),
            };
            let payload = match &installed_version {
                Some(drawn) if rng.u8(..8) == 0 => drawn.clone(),
                _ => draw_version(&mut rng),
            };
            let installed = program_intact.map(|program_intact| Installed {
                version: installed_version.as_ref().map(|drawn| drawn.text.as_str()),
                program_intact,
            });

            let own = rng.u32(2..6);
            let tier = [Tier::Below, Tier::Equal, Tier::Above, Tier::Unreadable][rng.usize(..4)];
            let (written_by, shown) = written_bys[rng.usize(..written_bys.len())].clone();
            let recorded = match tier {
                Tier::Below => rng.u32(1..own),
                Tier::Equal => own,
                Tier::Above => match rng.u8(..3) {
                    0 => own + 1,
                    1 => u32::MAX,
                    _ => rng.u32(own + 1..),
                },
                Tier::Unreadable => 0,
            };
            let read = match tier {
                Tier::Unreadable => StampRead::Unreadable {
                    reason: "data_format 不是 1 到 4294967295 之间的整数：0".to_owned(),
                },
                _ => StampRead::Valid(Stamp {
                    data_format: recorded,
                    written_by,
                }),
            };
            let verdict = judge_stamp(&read, own);

            let judged = judge_kind(installed, &payload.text, initiation);
            let (kind, recovery) = recover(judged.kind, &mut rng);
            let modes = judge_modes(kind, judged.relation, &verdict, initiation);

            // 模型里的事实，不经被测函数
            let installed_channel = installed_version.as_ref().and_then(|drawn| drawn.channel);
            let intact_install = installed_version.is_some() && program_intact == Some(true);
            let order = installed_version
                .as_ref()
                .map(|drawn| drawn.key.cmp(&payload.key));
            let older_payload = intact_install && order == Some(Ordering::Greater);
            let newer_payload = intact_install && order == Some(Ordering::Less);
            let relation = match (installed_channel, payload.channel) {
                (Some(i), Some(p)) if speed(p) < speed(i) => ChannelRelation::PayloadFaster,
                (Some(i), Some(p)) if speed(p) > speed(i) => ChannelRelation::PayloadSlower,
                (Some(_), Some(_)) => ChannelRelation::Same,
                _ => ChannelRelation::Unknown,
            };
            let data_passes = matches!(tier, Tier::Below | Tier::Equal);
            let context = format!(
                "{installed:?} 装 {} {initiation:?}，数据 {tier:?}（{recorded} 对 {own}），恢复 {recovery:?}",
                payload.text
            );
            assert_eq!(judged.relation, relation, "{context}");

            // 1. 装回较早的版本，当且仅当已装的更新、安装包通道严格更慢、数据关放行、交互或带开关
            let back = goes_back(&modes);
            assert_eq!(
                back,
                older_payload
                    && relation == ChannelRelation::PayloadSlower
                    && data_passes
                    && initiation != Initiation::Update,
                "{context}"
            );
            // 2. 数据关拦下时什么都不装、不无人值守、不写交接记录，并带出拦下的原因
            if !data_passes {
                assert_eq!(modes.allowed_modes, NOTHING, "{context}");
                assert_eq!(modes.unattended, None, "{context}");
                assert!(!modes.handoff, "{context}");
                let expected = match &read {
                    StampRead::Unreadable { reason } => DataBlock::Unreadable {
                        reason: reason.clone(),
                    },
                    StampRead::Valid(_) => DataBlock::TooNew {
                        recorded,
                        written_by: shown.map(|(version, channel)| trusted(version, channel)),
                    },
                };
                assert_eq!(modes.data_block, Some(expected), "{context}");
            } else {
                assert_eq!(modes.data_block, None, "{context}");
            }
            // 3. 同通道的旧包任何方式都不能装
            if older_payload && relation == ChannelRelation::Same {
                assert_eq!(modes.allowed_modes, NOTHING, "{context}");
                assert_eq!(modes.unattended, None, "{context}");
            }
            // 4. 不带开关的更新永远不出 switch
            if initiation == Initiation::Update {
                assert!(!back, "{context}");
                assert_ne!(kind, Some(K::Switch), "{context}");
            }
            // 5. 交接记录只在交互、数据关放行时的第 2a 行（恢复之后仍是升级）与第 5 行写
            let upgrade_to_faster = newer_payload
                && recovery == Recovery::Kept
                && relation == ChannelRelation::PayloadFaster;
            let switch = older_payload && relation == ChannelRelation::PayloadSlower;
            assert_eq!(
                modes.handoff,
                initiation == Initiation::Interactive
                    && data_passes
                    && (upgrade_to_faster || switch),
                "{context}"
            );
            // 6. 更快通道的旧包三种方式都是 newer
            if older_payload && relation == ChannelRelation::PayloadFaster {
                assert_eq!(kind, Some(K::Newer), "{context}");
            }
            // 7. newer 的原因只跟着 newer 出现，并与两边通道的关系一致；newer 恰是已装的更新、又不是换通道的那一格
            assert_eq!(
                kind == Some(K::Newer),
                older_payload
                    && !(relation == ChannelRelation::PayloadSlower
                        && initiation != Initiation::Update),
                "{context}"
            );
            assert_eq!(
                judged.newer_reason.is_some(),
                kind == Some(K::Newer),
                "{context}"
            );
            if let Some(reason) = judged.newer_reason {
                let expected = match relation {
                    ChannelRelation::Same => R::SameChannel,
                    ChannelRelation::PayloadFaster => R::FasterChannel,
                    ChannelRelation::PayloadSlower => R::SlowerChannel,
                    ChannelRelation::Unknown => R::UnknownChannel,
                };
                assert_eq!(reason, expected, "{context}");
                if reason == R::SlowerChannel {
                    assert_eq!(initiation, Initiation::Update, "{context}");
                }
                reasons.insert(reason);
            }

            tiers.insert(tier);
            recoveries.insert(recovery);
            kinds.insert(kind);
            went_back += usize::from(back);
            handoffs_on_upgrade += usize::from(modes.handoff && kind == Some(K::Upgrade));
            handoffs_on_switch += usize::from(modes.handoff && kind == Some(K::Switch));
            drawn_texts.push(payload);
            if let Some(drawn) = installed_version {
                drawn_texts.push(drawn);
            }
        }

        // 随机数据确实走到了每一种情形，不变量才不是空转
        assert_eq!(tiers.len(), 4);
        assert_eq!(recoveries.len(), 3);
        assert_eq!(reasons.len(), 4);
        assert_eq!(kinds.len(), 6, "{kinds:?}");
        assert!(went_back > 0 && handoffs_on_upgrade > 0 && handoffs_on_switch > 0);
        for seq in [0, 1, TWO_POW_53_PLUS_1] {
            assert!(
                drawn_texts
                    .iter()
                    .any(|drawn| drawn.key.is_some_and(|key| key.3 < 3 && key.4 == seq)),
                "没抽到序号 {seq}"
            );
        }
        assert!(
            drawn_texts.iter().any(|drawn| drawn.text.len() == 48),
            "没抽到 48 字节的版本串"
        );
        assert!(
            drawn_texts.iter().any(|drawn| drawn.key.is_none()),
            "没抽到解析不了的串"
        );
        assert!(
            drawn_texts
                .iter()
                .any(|drawn| drawn.key.is_some_and(|key| key.3 == 2)),
            "没抽到 rc"
        );
    }
}
