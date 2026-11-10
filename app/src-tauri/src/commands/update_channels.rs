//! 更新通道的纯判定：按偏好该问哪几个通道、每个通道用哪把公钥验、各通道的结果怎么合成一个结论。
//!
//! 这里不发请求、不读配置、不碰槽位，输入输出都是值；取清单、核验清单头、写配置都在调用方。一次检查这样用：
//! 1. [`endpoint_groups`] 按生效的偏好（[`effective_preference`]）列出要问的通道，每个通道带上它的端点与公钥；
//! 2. 通道内按先后逐个问端点，问到 [`EndpointOutcome::Verified`] 为止。端点给出签名与形状都验过的清单头时，
//!    用 [`head_outcome`] 对照本机记下的这个通道的最高版本，其余情形照 [`EndpointOutcome`] 记下；
//!    [`channel_outcome`] 把一个通道各端点的结果合成这个通道的结果；
//! 3. [`conclude`] 把各通道的结果合成整次检查的结论。挑出的候选要先写下偏好时（[`must_save_preference`]），
//!    写不进去就把它记进被拒的版本，再挑一次。

use std::cmp::Ordering;

use petalfall_core::release::order::{compare_versions, Channel};
use semver::Version;

use super::updater::{ChannelHeadState, ChannelRelation};

/// 预览版的更新公钥：minisign 公钥文本再整体 base64 一层，正是更新插件 `pubkey` 要的格式；与 CI 给预览版注入
/// 插件配置的是同一个文件。
const DEV_UPDATER_PUBKEY: &str = include_str!("../../../../.github/dev-updater.pub");

/// 测试版与正式版共用的发布公钥，格式同 [`DEV_UPDATER_PUBKEY`]；与 CI 给测试版注入插件配置的是同一个文件。
const RELEASE_UPDATER_PUBKEY: &str = include_str!("../../../../.github/release-updater.pub");

/// 通道 `channel` 的清单签名与安装包用哪把公钥验：预览版用预览版的钥，测试版与正式版用发布钥。
///
/// 两把钥无条件编进所有构建，不看构建开关：本机与 fork 构建照样有这张表，只是插件配置里没注入落樱的公钥，
/// 判不成支持自更新。检查器要显式用这里给的钥，不能沿用插件配置里注入的那一把：那一把只属于本包的通道，
/// 跟随别的通道时拿它验必然对不上。
///
/// 文件末尾带换行，CI 注入插件配置前 `trim()` 过；这里同样去掉首尾空白，与注入的公钥才逐字相等。
pub(crate) fn channel_pubkey(channel: Channel) -> &'static str {
    match channel {
        Channel::Dev => DEV_UPDATER_PUBKEY.trim(),
        Channel::Beta | Channel::Stable => RELEASE_UPDATER_PUBKEY.trim(),
    }
}

/// 偏好 `preference` 生效时要问的通道：偏好本身与所有比它慢的，从快到慢，第一个就是偏好通道。
///
/// 比偏好快的通道一律不问：偏好是用户要的最快那条线，更快通道的版本不该自己找上门来。更慢的通道都问：正式版
/// 发布时测试版用户要能拿到它，快通道停发或被撤回、慢通道有更高的版本时也要能跟过去。
pub(crate) fn followed_channels(preference: Channel) -> &'static [Channel] {
    match preference {
        Channel::Dev => &[Channel::Dev, Channel::Beta, Channel::Stable],
        Channel::Beta => &[Channel::Beta, Channel::Stable],
        Channel::Stable => &[Channel::Stable],
    }
}

/// 要问的一个通道：它的清单端点与验它用的公钥。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ChannelEndpoints {
    pub(crate) channel: Channel,
    /// [`channel_pubkey`] 给这个通道的那把钥。
    pub(crate) pubkey: &'static str,
    /// 按先后逐个问，前一个没给出可用的清单头才问下一个。
    pub(crate) endpoints: Vec<String>,
}

/// 偏好 `preference` 生效时的端点组，通道顺序同 [`followed_channels`]。`endpoints_of` 给出一个通道的端点，
/// 顺序就是通道内问的先后。每组的钥只按这一组的通道取：一个通道的清单不会拿另一条线的钥去验。
pub(crate) fn endpoint_groups(
    preference: Channel,
    endpoints_of: impl Fn(Channel) -> Vec<String>,
) -> Vec<ChannelEndpoints> {
    followed_channels(preference)
        .iter()
        .map(|&channel| ChannelEndpoints {
            channel,
            pubkey: channel_pubkey(channel),
            endpoints: endpoints_of(channel),
        })
        .collect()
}

/// 生效的通道偏好：存过且认得出就是存的值；没存过、或存的值认不出（`stored` 为 `None`）时就是本包的通道
/// `package`。认不出的值多半是更新的版本写下的新通道名，按本包的通道走最保守。
pub(crate) fn effective_preference(stored: Option<Channel>, package: Channel) -> Channel {
    stored.unwrap_or(package)
}

/// 生效的偏好 `preference` 与本包通道 `package` 的关系。
pub(crate) fn channel_relation(preference: Channel, package: Channel) -> ChannelRelation {
    if preference.is_slower_than(package) {
        ChannelRelation::Waiting
    } else if preference.is_faster_than(package) {
        ChannelRelation::Following
    } else {
        ChannelRelation::Same
    }
}

/// 一个清单端点问下来的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum EndpointOutcome {
    /// 给出了签名与形状都验过的清单头，且不低于本机记下的这个通道的最高版本。问到它，这个通道后面的端点就不必再问。
    Verified(Version),
    /// 给出了签名与形状都验过的清单头，但低于本机记下的这个通道的最高版本，多半是回放的旧清单；接着问下一个端点。
    Stale(Version),
    /// 再问一次状态码，确认是 404：这个端点上还没有这个通道的清单。
    Missing,
    /// 其余一切：连不上、超时、404 以外的非 2xx、回了 204、正文坏、没有本平台的条目、清单头的形状或签名不对。
    Failed,
}

/// 签名与形状都验过的清单头 `head`，对照本机记下的这个通道的最高版本 `seen`。低于记录的按旧清单处理：回放旧清单
/// 压不低本机记录，也就引不到更旧的版本。等于记录的照常可用，那就是上次见过的同一版。
pub(crate) fn head_outcome(head: Version, seen: Option<&Version>) -> EndpointOutcome {
    match seen {
        Some(seen) if compare_versions(&head, seen) == Ordering::Less => {
            EndpointOutcome::Stale(head)
        }
        _ => EndpointOutcome::Verified(head),
    }
}

/// 一个通道这次检查的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ChannelOutcome {
    /// 第 `endpoint` 个端点（按问的先后从 0 数）最先给出了可用的清单头 `version`。
    Published { endpoint: usize, version: Version },
    /// 所有端点都确认 404：这个通道还没有发布。正式版首发之前就是这样，不算失败。
    NotPublished,
    /// 每个端点都给出了清单头，且全都低于本机记录；`offered` 按端点先后列出各自给的版本。
    Stale { offered: Vec<Version> },
    /// 其余情形。有端点失败或 404、其余端点低于本机记录的也算这里：没给出清单的那个端点上说不定有更新的版本，
    /// 断定不了是整个更新源在回放旧清单。
    Failed,
}

impl ChannelOutcome {
    /// 界面上显示的这个通道的状态。
    pub(crate) fn head_state(&self) -> ChannelHeadState {
        match self {
            ChannelOutcome::Published { .. } => ChannelHeadState::Published,
            ChannelOutcome::NotPublished => ChannelHeadState::NotPublished,
            ChannelOutcome::Stale { .. } => ChannelHeadState::Stale,
            ChannelOutcome::Failed => ChannelHeadState::Failed,
        }
    }
}

/// 把一个通道各端点的结果（按问的先后）合成这个通道的结果。端点只问到第一个 [`EndpointOutcome::Verified`] 为止，
/// 之后没问的不用传。
pub(crate) fn channel_outcome(endpoints: Vec<EndpointOutcome>) -> ChannelOutcome {
    assert!(!endpoints.is_empty(), "一个通道至少要问一个清单端点");
    if endpoints
        .iter()
        .all(|outcome| *outcome == EndpointOutcome::Missing)
    {
        return ChannelOutcome::NotPublished;
    }
    let mut offered = Vec::with_capacity(endpoints.len());
    let mut every_endpoint_stale = true;
    for (endpoint, outcome) in endpoints.into_iter().enumerate() {
        match outcome {
            EndpointOutcome::Verified(version) => {
                return ChannelOutcome::Published { endpoint, version };
            }
            EndpointOutcome::Stale(version) => offered.push(version),
            EndpointOutcome::Missing | EndpointOutcome::Failed => every_endpoint_stale = false,
        }
    }
    if every_endpoint_stale {
        ChannelOutcome::Stale { offered }
    } else {
        ChannelOutcome::Failed
    }
}

/// 一个要问的通道这次的结果，连同判定时要用的本机记录。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ChannelReport {
    pub(crate) channel: Channel,
    /// 本机记下的这个通道验过的最高版本；没记过或记录作废时为 `None`。
    pub(crate) seen: Option<Version>,
    pub(crate) outcome: ChannelOutcome,
}

/// 挑出的可装版本与它所属的通道。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Candidate {
    pub(crate) channel: Channel,
    pub(crate) version: Version,
}

/// 整次检查的结论。前两种是整次失败，说的都是偏好通道。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Conclusion {
    /// 偏好通道的清单取不到或异常：报 `update_check_failed`。
    CheckFailed,
    /// 偏好通道每个端点给的清单头都低于本机记录：报 `update_source_stale`。
    SourceStale,
    /// 有可装的更新。
    Available(Candidate),
    /// 偏好通道有清单，但没有可装的更新。
    UpToDate,
    /// 偏好通道还没有发布，更慢的通道里也没有可装的更新。
    NotPublished,
}

/// 把各通道的结果合成整次检查的结论。
///
/// `current` 是正在运行的版本，`package` 是由它判出的通道，`preference` 是生效的偏好；`reports` 按
/// [`followed_channels`] 的顺序逐个给出要问的通道，第一个就是偏好通道；`refused` 是本次会话里不再当作候选的
/// （通道，版本）。
///
/// 偏好通道失败或旧于本机记录时整次失败，不看更慢的通道：偏好通道的清单被挡住时拿慢通道的结果顶上，挡清单的人
/// 就能把用户带去慢通道。更慢通道失败或旧于记录只记日志，那个通道这次没有候选。
///
/// 其余情形在有清单的通道里挑候选，每个都要严格新于当前版本、不低于本机记下的那个通道的最高版本、跨到更慢的通道
/// 时满足跟随规则（`follow_allowed`）、不在 `refused` 里，余下里取版本最大的那个；不同通道的版本号形状不同，
/// 不会并列。挑不出时，偏好通道有清单为已是最新，否则为还没有发布。
pub(crate) fn conclude(
    current: &Version,
    package: Channel,
    preference: Channel,
    reports: &[ChannelReport],
    refused: &[(Channel, Version)],
) -> Conclusion {
    assert_eq!(
        Channel::of_version(current),
        Some(package),
        "本包的通道要由当前版本 {current} 判出"
    );
    let asked: Vec<Channel> = reports.iter().map(|report| report.channel).collect();
    assert_eq!(
        asked,
        followed_channels(preference),
        "偏好 {} 该问的通道要逐个给出结果",
        preference.as_str()
    );
    let (preferred, slower) = reports.split_first().expect("该问的通道至少有偏好通道自己");
    let preferred_published = match preferred.outcome {
        ChannelOutcome::Published { .. } => true,
        ChannelOutcome::NotPublished => false,
        ChannelOutcome::Stale { .. } => return Conclusion::SourceStale,
        ChannelOutcome::Failed => return Conclusion::CheckFailed,
    };
    for report in slower {
        match report.outcome {
            ChannelOutcome::Stale { .. } => tracing::warn!(
                channel = report.channel.as_str(),
                "更慢通道的清单都低于本机记录，这个通道这次没有候选"
            ),
            ChannelOutcome::Failed => tracing::warn!(
                channel = report.channel.as_str(),
                "更慢通道的清单没取到，这个通道这次没有候选"
            ),
            ChannelOutcome::Published { .. } | ChannelOutcome::NotPublished => {}
        }
    }
    let relation = channel_relation(preference, package);
    let candidate = reports
        .iter()
        .filter_map(|report| match &report.outcome {
            ChannelOutcome::Published { version, .. }
                if is_candidate(current, package, relation, report, version, refused) =>
            {
                Some(Candidate {
                    channel: report.channel,
                    version: version.clone(),
                })
            }
            _ => None,
        })
        .max_by(|a, b| compare_versions(&a.version, &b.version));
    match candidate {
        Some(candidate) => Conclusion::Available(candidate),
        None if preferred_published => Conclusion::UpToDate,
        None => Conclusion::NotPublished,
    }
}

/// 通道 `report.channel` 有清单、给的是 `head` 时，它能不能当候选。前两条调用方已经保证过（检查器只收严格新于
/// 当前的版本，低于记录的清单头不算这个通道的结果），这里再判一遍，结论不依赖调用方怎么取清单。
fn is_candidate(
    current: &Version,
    package: Channel,
    relation: ChannelRelation,
    report: &ChannelReport,
    head: &Version,
    refused: &[(Channel, Version)],
) -> bool {
    if compare_versions(head, current) != Ordering::Greater {
        return false;
    }
    if report
        .seen
        .as_ref()
        .is_some_and(|seen| compare_versions(head, seen) == Ordering::Less)
    {
        return false;
    }
    if !follow_allowed(current, package, relation, report.channel, head) {
        tracing::warn!(
            channel = report.channel.as_str(),
            version = %head,
            current = %current,
            "跨到更慢通道的版本核心号没有前进，不当作候选"
        );
        return false;
    }
    !refused.iter().any(|(channel, version)| {
        *channel == report.channel && compare_versions(version, head) == Ordering::Equal
    })
}

/// 跟随须核心号前进：偏好不比本包的通道慢（关系是相同或跟随）、而版本来自比本包更慢的通道 `channel` 时，它的
/// 核心号（去掉预发布段的 X.Y.Z）必须大于当前版本的核心号。同一基础号下正式版按 semver 最大，没有这一条，预览版
/// 清单被冻住、或发版漏了先抬基础号时，偏好预览版的用户会被「升级」到核心号相同、内容却更旧的正式版。
///
/// 两种情形不受约束：
/// - 等它追上来（偏好比本包的通道慢）：用户已选了接受慢通道的内容，同号正式版正是他在等的那一版；
/// - 测试版跟随同号正式版：正式版与本基础号最后一个测试版的源码相同，跟过去拿到的是同一份内容。
fn follow_allowed(
    current: &Version,
    package: Channel,
    relation: ChannelRelation,
    channel: Channel,
    head: &Version,
) -> bool {
    let bound = relation != ChannelRelation::Waiting && channel.is_slower_than(package);
    let same_source = package == Channel::Beta && channel == Channel::Stable;
    !bound || same_source || compare_versions(&core(head), &core(current)) == Ordering::Greater
}

/// 去掉预发布段与构建元数据，只留 X.Y.Z。
fn core(version: &Version) -> Version {
    Version::new(version.major, version.minor, version.patch)
}

/// 挑出的候选来自通道 `candidate`、本包的通道是 `package`、存着的偏好是 `stored`（缺省或认不出为 `None`）时，
/// 报「有更新」之前要不要先把偏好写成本包的通道。
///
/// 不写的话，测试版用户跟随装上正式版之后本包的通道变成正式版，缺省的偏好跟着变，他会悄悄成为正式版用户，再也
/// 收不到下一班测试版。写不进去时调用方把这个候选记进被拒的版本，再用 [`conclude`] 挑一次；同一次检查里不再重写，
/// 之后挑出的跨通道候选同样记进被拒的版本，最后挑出的要么来自本包的通道，要么没有候选。
pub(crate) fn must_save_preference(
    candidate: Channel,
    package: Channel,
    stored: Option<Channel>,
) -> bool {
    candidate != package && stored.is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::collections::HashSet;
    use std::mem::discriminant;

    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    use petalfall_core::release::order::Channel::{Beta, Dev, Stable};

    /// 预览版钥的密钥号：公钥里第 2 到 9 字节的小写十六进制，与流水线契约测试钉的是同一种写法。
    const DEV_KEY_NUMBER: &str = "a85c28a4343f0962";

    /// 发布钥的密钥号，写法同 [`DEV_KEY_NUMBER`]。
    const RELEASE_KEY_NUMBER: &str = "aeeab33bdc36d624";

    const ALL: [Channel; 3] = [Dev, Beta, Stable];

    /// 2^53 + 1：JS 的 Number 从这里起分不清相邻的整数，流水线那边的序号要按大整数比。
    const TWO_POW_53_PLUS_1: u64 = (1 << 53) + 1;

    /// 随机版本号里序号的边界。
    const BOUNDARY_SEQS: [u64; 4] = [0, 1, 2, TWO_POW_53_PLUS_1];

    fn v(text: &str) -> Version {
        Version::parse(text).unwrap_or_else(|err| panic!("{text} 不是合法版本号：{err}"))
    }

    fn published(version: &str) -> ChannelOutcome {
        ChannelOutcome::Published {
            endpoint: 0,
            version: v(version),
        }
    }

    fn report(channel: Channel, seen: Option<&str>, outcome: ChannelOutcome) -> ChannelReport {
        ChannelReport {
            channel,
            seen: seen.map(v),
            outcome,
        }
    }

    fn available(channel: Channel, version: &str) -> Conclusion {
        Conclusion::Available(Candidate {
            channel,
            version: v(version),
        })
    }

    /// 公钥文本的密钥号。外层 base64 解开是 minisign 的公钥文件：第一行是不受信的注释，第二行再 base64 解开是
    /// 两字节算法标记 `Ed`、8 字节密钥号、32 字节 Ed25519 公钥。注释里那串大写十六进制是字节反过来写的，不拿它比。
    fn key_number(pubkey: &str) -> String {
        let text = STANDARD
            .decode(pubkey)
            .unwrap_or_else(|err| panic!("公钥不是 base64：{err}"));
        let text = String::from_utf8(text).expect("公钥解开后不是 UTF-8 文本");
        let line = text.lines().nth(1).expect("公钥文件少于两行");
        let bytes = STANDARD
            .decode(line)
            .unwrap_or_else(|err| panic!("公钥第二行不是 base64：{err}"));
        assert_eq!(bytes.len(), 42, "minisign 公钥是 2 + 8 + 32 字节");
        assert_eq!(&bytes[..2], b"Ed", "算法标记");
        bytes[2..10]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    #[test]
    fn each_channel_gets_the_key_of_its_own_line() {
        assert_eq!(key_number(channel_pubkey(Channel::Dev)), DEV_KEY_NUMBER);
        assert_eq!(
            key_number(channel_pubkey(Channel::Beta)),
            RELEASE_KEY_NUMBER
        );
        assert_eq!(
            key_number(channel_pubkey(Channel::Stable)),
            RELEASE_KEY_NUMBER
        );
    }

    #[test]
    fn beta_and_stable_share_the_release_key_that_preview_never_uses() {
        assert_eq!(
            channel_pubkey(Channel::Beta),
            channel_pubkey(Channel::Stable)
        );
        assert_ne!(channel_pubkey(Channel::Dev), channel_pubkey(Channel::Beta));
        assert_ne!(
            channel_pubkey(Channel::Dev),
            channel_pubkey(Channel::Stable)
        );
    }

    #[test]
    fn channel_keys_are_trimmed_like_the_injected_ones() {
        for channel in [Channel::Dev, Channel::Beta, Channel::Stable] {
            let key = channel_pubkey(channel);
            assert_eq!(key, key.trim(), "{channel:?}");
        }
    }

    #[test]
    fn a_preference_asks_itself_and_every_slower_channel_but_never_a_faster_one() {
        assert_eq!(followed_channels(Dev), [Dev, Beta, Stable]);
        assert_eq!(followed_channels(Beta), [Beta, Stable]);
        assert_eq!(followed_channels(Stable), [Stable]);
        for preference in ALL {
            let followed = followed_channels(preference);
            assert_eq!(followed[0], preference);
            for channel in ALL {
                assert_eq!(
                    followed.contains(&channel),
                    !channel.is_faster_than(preference),
                    "偏好 {preference:?} 问不问 {channel:?}"
                );
            }
        }
    }

    /// 与外壳实际的端点同形：预览版两个（香港机在前，GitHub 在后），测试版与正式版各一个香港机。
    fn endpoints_like_the_shell(channel: Channel) -> Vec<String> {
        let names: &[&str] = match channel {
            Dev => &["hk/dev", "github/dev"],
            Beta => &["hk/beta"],
            Stable => &["hk/stable"],
        };
        names.iter().map(|name| (*name).to_owned()).collect()
    }

    /// 问到的一个端点：（所属通道，端点，验它的钥的密钥号）。
    type AskedEndpoint = (Channel, &'static str, &'static str);

    #[test]
    fn each_endpoint_is_asked_with_the_key_of_its_own_channel() {
        let cases: [(Channel, &[AskedEndpoint]); 3] = [
            (
                Dev,
                &[
                    (Dev, "hk/dev", DEV_KEY_NUMBER),
                    (Dev, "github/dev", DEV_KEY_NUMBER),
                    (Beta, "hk/beta", RELEASE_KEY_NUMBER),
                    (Stable, "hk/stable", RELEASE_KEY_NUMBER),
                ],
            ),
            (
                Beta,
                &[
                    (Beta, "hk/beta", RELEASE_KEY_NUMBER),
                    (Stable, "hk/stable", RELEASE_KEY_NUMBER),
                ],
            ),
            (Stable, &[(Stable, "hk/stable", RELEASE_KEY_NUMBER)]),
        ];
        for (preference, expected) in cases {
            let asked: Vec<(Channel, String, String)> =
                endpoint_groups(preference, endpoints_like_the_shell)
                    .into_iter()
                    .flat_map(|group| {
                        let key = key_number(group.pubkey);
                        group
                            .endpoints
                            .into_iter()
                            .map(move |endpoint| (group.channel, endpoint, key.clone()))
                    })
                    .collect();
            let expected: Vec<(Channel, String, String)> = expected
                .iter()
                .map(|(channel, endpoint, key)| {
                    (*channel, (*endpoint).to_owned(), (*key).to_owned())
                })
                .collect();
            assert_eq!(asked, expected, "偏好 {preference:?}");
        }
    }

    #[test]
    fn relation_compares_the_preference_with_the_package_channel() {
        use ChannelRelation::{Following, Same, Waiting};
        // （偏好，本包的通道，关系）
        let table = [
            (Dev, Dev, Same),
            (Dev, Beta, Following),
            (Dev, Stable, Following),
            (Beta, Dev, Waiting),
            (Beta, Beta, Same),
            (Beta, Stable, Following),
            (Stable, Dev, Waiting),
            (Stable, Beta, Waiting),
            (Stable, Stable, Same),
        ];
        for (preference, package, relation) in table {
            assert_eq!(
                channel_relation(preference, package),
                relation,
                "偏好 {preference:?}，本包 {package:?}"
            );
        }
    }

    #[test]
    fn an_unset_preference_falls_back_to_the_package_channel() {
        for package in ALL {
            assert_eq!(effective_preference(None, package), package);
            for stored in ALL {
                assert_eq!(effective_preference(Some(stored), package), stored);
            }
        }
    }

    #[test]
    fn a_head_below_the_record_is_stale_and_one_at_or_above_it_is_usable() {
        let seen = v("1.1.0-dev.61");
        assert_eq!(
            head_outcome(v("1.1.0-dev.55"), Some(&seen)),
            EndpointOutcome::Stale(v("1.1.0-dev.55"))
        );
        assert_eq!(
            head_outcome(v("1.1.0-dev.61"), Some(&seen)),
            EndpointOutcome::Verified(v("1.1.0-dev.61"))
        );
        assert_eq!(
            head_outcome(v("1.1.0-dev.62"), Some(&seen)),
            EndpointOutcome::Verified(v("1.1.0-dev.62"))
        );
        assert_eq!(
            head_outcome(v("1.0.0-dev.1"), None),
            EndpointOutcome::Verified(v("1.0.0-dev.1"))
        );
        // 序号按数值比：dev.9 低于 dev.10；2^53 + 1 也照样比得出先后。
        assert_eq!(
            head_outcome(v("1.0.0-dev.9"), Some(&v("1.0.0-dev.10"))),
            EndpointOutcome::Stale(v("1.0.0-dev.9"))
        );
        assert_eq!(
            head_outcome(
                v("1.0.0-dev.9007199254740992"),
                Some(&v(&format!("1.0.0-dev.{TWO_POW_53_PLUS_1}")))
            ),
            EndpointOutcome::Stale(v("1.0.0-dev.9007199254740992"))
        );
        // 只差构建元数据的是同一版，不算旧。
        assert_eq!(
            head_outcome(v("1.0.0-dev.10+rebuild"), Some(&v("1.0.0-dev.10"))),
            EndpointOutcome::Verified(v("1.0.0-dev.10+rebuild"))
        );
    }

    /// 端点结果的种类，合成用例按它穷举。
    #[derive(Debug, Clone, Copy)]
    enum Asked {
        Verified,
        Stale,
        Missing,
        Failed,
    }

    /// 第 `index` 个端点给出这种结果。不同端点给的版本不同，看得出合成时取的是哪一个。
    fn asked(kind: Asked, index: usize) -> EndpointOutcome {
        match kind {
            Asked::Verified => EndpointOutcome::Verified(v(&format!("1.1.0-dev.{}", 62 + index))),
            Asked::Stale => EndpointOutcome::Stale(v(&format!("1.1.0-dev.{}", 55 + index))),
            Asked::Missing => EndpointOutcome::Missing,
            Asked::Failed => EndpointOutcome::Failed,
        }
    }

    #[test]
    fn a_channel_takes_its_first_usable_head_and_is_stale_only_when_every_endpoint_is() {
        let first_usable = |endpoint: usize| ChannelOutcome::Published {
            endpoint,
            version: v(&format!("1.1.0-dev.{}", 62 + endpoint)),
        };
        let single = [
            (Asked::Verified, first_usable(0)),
            (
                Asked::Stale,
                ChannelOutcome::Stale {
                    offered: vec![v("1.1.0-dev.55")],
                },
            ),
            (Asked::Missing, ChannelOutcome::NotPublished),
            (Asked::Failed, ChannelOutcome::Failed),
        ];
        for (kind, expected) in single {
            assert_eq!(channel_outcome(vec![asked(kind, 0)]), expected, "{kind:?}");
        }
        let pairs = [
            ([Asked::Verified, Asked::Verified], first_usable(0)),
            ([Asked::Verified, Asked::Stale], first_usable(0)),
            ([Asked::Verified, Asked::Missing], first_usable(0)),
            ([Asked::Verified, Asked::Failed], first_usable(0)),
            ([Asked::Stale, Asked::Verified], first_usable(1)),
            ([Asked::Missing, Asked::Verified], first_usable(1)),
            ([Asked::Failed, Asked::Verified], first_usable(1)),
            (
                [Asked::Stale, Asked::Stale],
                ChannelOutcome::Stale {
                    offered: vec![v("1.1.0-dev.55"), v("1.1.0-dev.56")],
                },
            ),
            (
                [Asked::Missing, Asked::Missing],
                ChannelOutcome::NotPublished,
            ),
            ([Asked::Stale, Asked::Missing], ChannelOutcome::Failed),
            ([Asked::Stale, Asked::Failed], ChannelOutcome::Failed),
            ([Asked::Missing, Asked::Stale], ChannelOutcome::Failed),
            ([Asked::Missing, Asked::Failed], ChannelOutcome::Failed),
            ([Asked::Failed, Asked::Stale], ChannelOutcome::Failed),
            ([Asked::Failed, Asked::Missing], ChannelOutcome::Failed),
            ([Asked::Failed, Asked::Failed], ChannelOutcome::Failed),
        ];
        assert_eq!(pairs.len(), 16, "两个端点各四种结果");
        for (kinds, expected) in pairs {
            let endpoints = kinds
                .iter()
                .enumerate()
                .map(|(index, kind)| asked(*kind, index))
                .collect();
            assert_eq!(channel_outcome(endpoints), expected, "{kinds:?}");
        }
    }

    #[test]
    fn channel_outcomes_map_onto_the_states_shown_in_the_ui() {
        assert_eq!(published("1.0.0").head_state(), ChannelHeadState::Published);
        assert_eq!(
            ChannelOutcome::NotPublished.head_state(),
            ChannelHeadState::NotPublished
        );
        assert_eq!(
            ChannelOutcome::Stale {
                offered: vec![v("1.0.0")]
            }
            .head_state(),
            ChannelHeadState::Stale
        );
        assert_eq!(
            ChannelOutcome::Failed.head_state(),
            ChannelHeadState::Failed
        );
    }

    /// 香港机的预览版清单被回放成旧的、GitHub 上那份是新的：接着问 GitHub，以它为准。
    #[test]
    fn a_replayed_hong_kong_preview_manifest_falls_through_to_github() {
        let seen = v("1.1.0-dev.61");
        let hong_kong = head_outcome(v("1.1.0-dev.55"), Some(&seen));
        assert_eq!(hong_kong, EndpointOutcome::Stale(v("1.1.0-dev.55")));
        let github = head_outcome(v("1.1.0-dev.62"), Some(&seen));
        let dev = channel_outcome(vec![hong_kong, github]);
        assert_eq!(
            dev,
            ChannelOutcome::Published {
                endpoint: 1,
                version: v("1.1.0-dev.62")
            }
        );
        let reports = [
            report(Dev, Some("1.1.0-dev.61"), dev),
            report(Beta, None, published("1.0.0-beta.4")),
            report(Stable, None, published("1.0.0")),
        ];
        assert_eq!(
            conclude(&v("1.1.0-dev.61"), Dev, Dev, &reports, &[]),
            available(Dev, "1.1.0-dev.62")
        );
    }

    /// 两处预览版清单都低于本机记录时整次失败，测试版、正式版上可装的更高版本也不跟过去；有一处没给出清单、另一处
    /// 低于记录时是检查失败，同样不拿更慢的通道顶上。
    #[test]
    fn preview_manifests_older_than_the_record_fail_the_check_without_falling_back() {
        let current = v("1.1.0-dev.61");
        let seen = v("1.1.0-dev.61");
        let replayed = || head_outcome(v("1.1.0-dev.55"), Some(&seen));
        let conclude_with = |dev: ChannelOutcome| {
            let reports = [
                report(Dev, Some("1.1.0-dev.61"), dev),
                report(Beta, None, published("1.2.0-beta.1")),
                report(Stable, None, published("1.2.0")),
            ];
            conclude(&current, Dev, Dev, &reports, &[])
        };

        // 对照：偏好通道还没发布时，更慢通道里的 1.2.0 是可装的。
        assert_eq!(
            conclude_with(ChannelOutcome::NotPublished),
            available(Stable, "1.2.0")
        );

        let both_replayed = channel_outcome(vec![replayed(), replayed()]);
        assert_eq!(
            both_replayed,
            ChannelOutcome::Stale {
                offered: vec![v("1.1.0-dev.55"); 2]
            }
        );
        assert_eq!(conclude_with(both_replayed), Conclusion::SourceStale);

        for other in [EndpointOutcome::Failed, EndpointOutcome::Missing] {
            let mixed = channel_outcome(vec![replayed(), other.clone()]);
            assert_eq!(mixed, ChannelOutcome::Failed, "{other:?}");
            assert_eq!(conclude_with(mixed), Conclusion::CheckFailed, "{other:?}");
        }
    }

    /// 偏好与本包都是预览版：跨到测试版、正式版要核心号前进，同号的正式版不跟。
    #[test]
    fn a_preview_user_crosses_to_slower_channels_only_for_a_newer_core_version() {
        let current = v("1.0.0-dev.60");
        let pick = |beta: ChannelOutcome, stable: ChannelOutcome| {
            let reports = [
                report(Dev, None, published("1.0.0-dev.60")),
                report(Beta, None, beta),
                report(Stable, None, stable),
            ];
            conclude(&current, Dev, Dev, &reports, &[])
        };
        assert_eq!(
            pick(ChannelOutcome::NotPublished, published("1.0.0")),
            Conclusion::UpToDate
        );
        // 构建元数据不算核心号，带了也还是同号。
        assert_eq!(
            pick(ChannelOutcome::NotPublished, published("1.0.0+rebuild")),
            Conclusion::UpToDate
        );
        assert_eq!(
            pick(ChannelOutcome::NotPublished, published("1.0.1")),
            available(Stable, "1.0.1")
        );
        assert_eq!(
            pick(published("1.0.1-beta.1"), ChannelOutcome::NotPublished),
            available(Beta, "1.0.1-beta.1")
        );
    }

    /// 测试版的包跟随同号正式版：偏好是测试版本身，还是更快的预览版，都一样。
    #[test]
    fn a_beta_package_follows_the_stable_release_of_its_own_core_version() {
        let current = v("1.0.0-beta.4");
        let same = [
            report(Beta, None, published("1.0.0-beta.4")),
            report(Stable, None, published("1.0.0")),
        ];
        assert_eq!(
            conclude(&current, Beta, Beta, &same, &[]),
            available(Stable, "1.0.0")
        );
        let following = [
            report(Dev, None, ChannelOutcome::NotPublished),
            report(Beta, None, published("1.0.0-beta.4")),
            report(Stable, None, published("1.0.0")),
        ];
        assert_eq!(
            conclude(&current, Beta, Dev, &following, &[]),
            available(Stable, "1.0.0")
        );
    }

    /// 等它追上来时不受核心号的约束：在等的正是同号正式版。
    #[test]
    fn waiting_for_a_slower_channel_takes_the_release_of_the_same_core_version() {
        let current = v("1.0.0-dev.60");
        let for_beta = [
            report(Beta, None, published("1.0.0-beta.4")),
            report(Stable, None, published("1.0.0")),
        ];
        assert_eq!(
            conclude(&current, Dev, Beta, &for_beta, &[]),
            available(Stable, "1.0.0")
        );
        let for_stable = [report(Stable, None, published("1.0.0"))];
        assert_eq!(
            conclude(&current, Dev, Stable, &for_stable, &[]),
            available(Stable, "1.0.0")
        );
    }

    /// 低于本机记录的清单头本该在端点那一步就判成旧清单；合并时再挡一次，调用方漏了那一步也装不上。
    /// 等于记录的照常可装。
    #[test]
    fn a_published_head_below_the_record_is_never_a_candidate() {
        let current = v("1.0.0-dev.10");
        let with_seen = |seen: &str| {
            let reports = [
                report(Dev, Some(seen), published("1.0.0-dev.60")),
                report(Beta, None, ChannelOutcome::NotPublished),
                report(Stable, None, ChannelOutcome::NotPublished),
            ];
            conclude(&current, Dev, Dev, &reports, &[])
        };
        assert_eq!(with_seen("1.0.0-dev.70"), Conclusion::UpToDate);
        assert_eq!(with_seen("1.0.0-dev.60"), available(Dev, "1.0.0-dev.60"));
    }

    /// 本次会话被拒过的版本让给余下里最大的那个；被拒只认同一通道的同一版。
    #[test]
    fn refused_versions_give_way_to_the_next_largest() {
        let current = v("1.0.0-dev.55");
        let reports = [
            report(Dev, None, published("1.0.0-dev.60")),
            report(Beta, None, published("1.1.0-beta.1")),
            report(Stable, None, published("1.1.0")),
        ];
        let pick = |refused: &[(Channel, Version)]| conclude(&current, Dev, Dev, &reports, refused);
        assert_eq!(pick(&[]), available(Stable, "1.1.0"));
        assert_eq!(
            pick(&[(Stable, v("1.1.0"))]),
            available(Beta, "1.1.0-beta.1")
        );
        assert_eq!(
            pick(&[(Stable, v("1.1.0")), (Beta, v("1.1.0-beta.1"))]),
            available(Dev, "1.0.0-dev.60")
        );
        assert_eq!(
            pick(&[
                (Stable, v("1.1.0")),
                (Beta, v("1.1.0-beta.1")),
                (Dev, v("1.0.0-dev.60"))
            ]),
            Conclusion::UpToDate
        );
        // 只差构建元数据的是同一版；别的版本被拒不牵连它。
        assert_eq!(
            pick(&[(Stable, v("1.1.0+rebuild"))]),
            available(Beta, "1.1.0-beta.1")
        );
        assert_eq!(pick(&[(Stable, v("1.0.9"))]), available(Stable, "1.1.0"));
    }

    #[test]
    fn the_preference_is_written_down_only_for_another_channel_while_it_is_unset() {
        // （候选的通道，本包的通道，存着的偏好，要不要先写偏好）
        let table = [
            (Stable, Beta, None, true),
            (Beta, Dev, None, true),
            (Stable, Dev, None, true),
            (Stable, Beta, Some(Beta), false),
            (Stable, Dev, Some(Dev), false),
            (Dev, Beta, Some(Dev), false),
            (Dev, Dev, None, false),
            (Beta, Beta, None, false),
            (Stable, Stable, None, false),
        ];
        for (candidate, package, stored, expected) in table {
            assert_eq!(
                must_save_preference(candidate, package, stored),
                expected,
                "候选 {candidate:?}，本包 {package:?}，存着 {stored:?}"
            );
        }
    }

    /// 偏好写不进去时，跨通道的候选逐个记进被拒的版本再挑，最后挑出本包通道的候选。
    #[test]
    fn an_unsaved_preference_leaves_the_candidate_of_the_package_channel() {
        let current = v("1.0.0-dev.55");
        let reports = [
            report(Dev, None, published("1.0.0-dev.60")),
            report(Beta, None, published("1.1.0-beta.1")),
            report(Stable, None, published("1.1.0")),
        ];
        let mut refused = Vec::new();
        let picked = loop {
            match conclude(&current, Dev, Dev, &reports, &refused) {
                Conclusion::Available(candidate)
                    if must_save_preference(candidate.channel, Dev, None) =>
                {
                    refused.push((candidate.channel, candidate.version));
                }
                other => break other,
            }
        };
        assert_eq!(picked, available(Dev, "1.0.0-dev.60"));
        assert_eq!(refused, [(Stable, v("1.1.0")), (Beta, v("1.1.0-beta.1"))]);
    }

    // 下面 11 条照同一组背景：预览版清单是 1.0.0-dev.60，测试版是 1.0.0-beta.4，正式版还没发布；之后正式版
    // 1.0.0 发布，那时预览版已抬到 1.1.0-dev.61。

    /// 按例子的写法检查一次：当前版本、存着的偏好（`None` 为缺省），以及要问的各通道的结果（从快到慢）；本机没有
    /// 记录，也没有被拒的版本。
    fn check(current: &str, stored: Option<Channel>, outcomes: Vec<ChannelOutcome>) -> Conclusion {
        let current = v(current);
        let package = Channel::of_version(&current).expect("例子里的版本都认得出通道");
        let preference = effective_preference(stored, package);
        let channels = followed_channels(preference);
        assert_eq!(
            channels.len(),
            outcomes.len(),
            "偏好 {preference:?} 要问 {channels:?}"
        );
        let reports: Vec<ChannelReport> = channels
            .iter()
            .zip(outcomes)
            .map(|(&channel, outcome)| ChannelReport {
                channel,
                seen: None,
                outcome,
            })
            .collect();
        conclude(&current, package, preference, &reports, &[])
    }

    #[test]
    fn example_a_preview_user_takes_the_newer_preview() {
        assert_eq!(
            check(
                "1.0.0-dev.55",
                Some(Dev),
                vec![
                    published("1.0.0-dev.60"),
                    published("1.0.0-beta.4"),
                    ChannelOutcome::NotPublished
                ]
            ),
            available(Dev, "1.0.0-dev.60")
        );
    }

    #[test]
    fn example_a_preview_package_waiting_for_beta_has_nothing_to_install_yet() {
        assert_eq!(channel_relation(Beta, Dev), ChannelRelation::Waiting);
        assert_eq!(
            check(
                "1.0.0-dev.60",
                Some(Beta),
                vec![published("1.0.0-beta.4"), ChannelOutcome::NotPublished]
            ),
            Conclusion::UpToDate
        );
    }

    #[test]
    fn example_a_beta_package_preferring_preview_upgrades_to_it() {
        assert_eq!(
            check(
                "1.0.0-beta.4",
                Some(Dev),
                vec![
                    published("1.0.0-dev.60"),
                    published("1.0.0-beta.4"),
                    ChannelOutcome::NotPublished
                ]
            ),
            available(Dev, "1.0.0-dev.60")
        );
    }

    #[test]
    fn example_a_beta_package_preferring_an_unreleased_stable_sees_nothing_published() {
        assert_eq!(
            check(
                "1.0.0-beta.4",
                Some(Stable),
                vec![ChannelOutcome::NotPublished]
            ),
            Conclusion::NotPublished
        );
    }

    #[test]
    fn example_a_beta_package_without_a_preference_follows_stable_and_writes_beta_down() {
        assert_eq!(
            check(
                "1.0.0-beta.4",
                None,
                vec![published("1.0.0-beta.4"), published("1.0.0")]
            ),
            available(Stable, "1.0.0")
        );
        assert!(must_save_preference(Stable, Beta, None));
    }

    #[test]
    fn example_a_stable_package_following_beta_is_up_to_date() {
        assert_eq!(channel_relation(Beta, Stable), ChannelRelation::Following);
        assert_eq!(
            check(
                "1.0.0",
                Some(Beta),
                vec![published("1.0.0-beta.4"), published("1.0.0")]
            ),
            Conclusion::UpToDate
        );
    }

    #[test]
    fn example_a_preview_package_waiting_for_beta_takes_stable_and_keeps_waiting_once_it_is_refused(
    ) {
        assert_eq!(
            check(
                "1.0.0-dev.60",
                Some(Beta),
                vec![published("1.0.0-beta.4"), published("1.0.0")]
            ),
            available(Stable, "1.0.0")
        );
        // 下载验签后包认得的数据格式太旧时，这一版记进被拒的版本，之后的检查接着等。
        let reports = [
            report(Beta, None, published("1.0.0-beta.4")),
            report(Stable, None, published("1.0.0")),
        ];
        assert_eq!(
            conclude(
                &v("1.0.0-dev.60"),
                Dev,
                Beta,
                &reports,
                &[(Stable, v("1.0.0"))]
            ),
            Conclusion::UpToDate
        );
    }

    #[test]
    fn example_a_preview_after_the_base_bump_is_up_to_date() {
        assert_eq!(
            check(
                "1.1.0-dev.61",
                Some(Dev),
                vec![
                    published("1.1.0-dev.61"),
                    published("1.0.0-beta.4"),
                    published("1.0.0")
                ]
            ),
            Conclusion::UpToDate
        );
    }

    #[test]
    fn example_a_preview_package_waiting_for_stable_waits_for_the_next_release() {
        assert_eq!(
            check("1.1.0-dev.61", Some(Stable), vec![published("1.0.0")]),
            Conclusion::UpToDate
        );
    }

    #[test]
    fn example_a_frozen_preview_manifest_does_not_pull_preview_users_onto_stable() {
        assert_eq!(
            check(
                "1.0.0-dev.60",
                Some(Dev),
                vec![
                    published("1.0.0-dev.60"),
                    published("1.0.0-beta.4"),
                    published("1.0.0")
                ]
            ),
            Conclusion::UpToDate
        );
    }

    #[test]
    fn example_replayed_preview_manifests_fail_without_looking_at_slower_channels() {
        let seen = v("1.1.0-dev.61");
        let dev = channel_outcome(vec![
            head_outcome(v("1.1.0-dev.55"), Some(&seen)),
            head_outcome(v("1.1.0-dev.55"), Some(&seen)),
        ]);
        let reports = [
            report(Dev, Some("1.1.0-dev.61"), dev),
            report(Beta, None, published("1.0.0-beta.4")),
            report(Stable, None, published("1.0.0")),
        ];
        assert_eq!(
            conclude(&v("1.1.0-dev.61"), Dev, Dev, &reports, &[]),
            Conclusion::SourceStale
        );
    }

    /// 一个通道这次结果的种类，穷举用。
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Kind {
        Published,
        NotPublished,
        Stale,
        Failed,
    }

    const KINDS: [Kind; 4] = [
        Kind::Published,
        Kind::NotPublished,
        Kind::Stale,
        Kind::Failed,
    ];

    /// 一组穷举用的场景。
    struct Fixture {
        name: &'static str,
        current: &'static str,
        preference: Channel,
        /// 手写的要问的通道，从快到慢，第一个是偏好通道；不取自被测函数。
        channels: &'static [FixtureChannel],
        refused: &'static [(Channel, &'static str)],
    }

    struct FixtureChannel {
        channel: Channel,
        /// 这个通道有清单时给的清单头。
        head: &'static str,
        seen: Option<&'static str>,
        /// 手工标注：有清单时，这个清单头单独看能不能当候选（严格新于当前、不低于记录、跨到更慢的通道时核心号
        /// 前进或属于两种例外、没被拒）。
        eligible: bool,
    }

    const fn fc(
        channel: Channel,
        head: &'static str,
        seen: Option<&'static str>,
        eligible: bool,
    ) -> FixtureChannel {
        FixtureChannel {
            channel,
            head,
            seen,
            eligible,
        }
    }

    const FIXTURES: [Fixture; 12] = [
        Fixture {
            name: "预览版用户，三个通道的清单头都可装",
            current: "1.0.0-dev.55",
            preference: Dev,
            channels: &[
                fc(Dev, "1.0.0-dev.60", None, true),
                fc(Beta, "1.1.0-beta.1", None, true),
                fc(Stable, "1.1.0", None, true),
            ],
            refused: &[],
        },
        Fixture {
            name: "预览版清单被冻住：不比当前新，或同号不跟",
            current: "1.0.0-dev.60",
            preference: Dev,
            channels: &[
                fc(Dev, "1.0.0-dev.60", None, false),
                fc(Beta, "1.0.0-beta.4", None, false),
                fc(Stable, "1.0.0", None, false),
            ],
            refused: &[],
        },
        Fixture {
            name: "测试版的包偏好预览版：正式版走同号例外",
            current: "1.0.0-beta.4",
            preference: Dev,
            channels: &[
                fc(Dev, "1.0.0-dev.60", None, true),
                fc(Beta, "1.0.0-beta.5", None, true),
                fc(Stable, "1.0.0", None, true),
            ],
            refused: &[],
        },
        Fixture {
            name: "低于本机记录与被拒各挡一个",
            current: "1.0.0-dev.10",
            preference: Dev,
            channels: &[
                fc(Dev, "1.0.0-dev.60", Some("1.0.0-dev.70"), false),
                fc(Beta, "1.1.0-beta.2", None, false),
                fc(Stable, "1.2.0", Some("1.1.0"), true),
            ],
            refused: &[(Beta, "1.1.0-beta.2")],
        },
        Fixture {
            name: "最大的那个被拒，让给次大的",
            current: "1.0.0-dev.55",
            preference: Dev,
            channels: &[
                fc(Dev, "1.0.0-dev.60", None, true),
                fc(Beta, "1.1.0-beta.1", None, true),
                fc(Stable, "1.1.0", None, false),
            ],
            refused: &[(Stable, "1.1.0")],
        },
        Fixture {
            name: "抬过基础号的预览版，记录与清单头相等",
            current: "1.1.0-dev.61",
            preference: Dev,
            channels: &[
                fc(Dev, "1.1.0-dev.63", Some("1.1.0-dev.63"), true),
                fc(Beta, "1.0.0-beta.4", None, false),
                fc(Stable, "1.0.0", None, false),
            ],
            refused: &[],
        },
        Fixture {
            name: "预览版的包在等测试版",
            current: "1.0.0-dev.60",
            preference: Beta,
            channels: &[
                fc(Beta, "1.0.0-beta.4", None, false),
                fc(Stable, "1.0.0", None, true),
            ],
            refused: &[],
        },
        Fixture {
            name: "测试版用户",
            current: "1.0.0-beta.4",
            preference: Beta,
            channels: &[
                fc(Beta, "1.0.0-beta.5", None, true),
                fc(Stable, "1.0.0", None, true),
            ],
            refused: &[],
        },
        Fixture {
            name: "跟随装上正式版的测试版用户",
            current: "1.0.0",
            preference: Beta,
            channels: &[
                fc(Beta, "1.0.0-beta.4", None, false),
                fc(Stable, "1.0.1", None, true),
            ],
            refused: &[],
        },
        Fixture {
            name: "预览版的包在等正式版，正式版还旧",
            current: "1.1.0-dev.61",
            preference: Stable,
            channels: &[fc(Stable, "1.0.0", None, false)],
            refused: &[],
        },
        Fixture {
            name: "测试版的包在等正式版",
            current: "1.0.0-beta.4",
            preference: Stable,
            channels: &[fc(Stable, "1.0.0", None, true)],
            refused: &[],
        },
        Fixture {
            name: "正式版用户，清单头低于记录",
            current: "1.0.0",
            preference: Stable,
            channels: &[fc(Stable, "1.0.1", Some("1.0.2"), false)],
            refused: &[],
        },
    ];

    /// 结论表直译：偏好通道失败或旧于记录时整次失败；否则在有清单、手工标注为可当候选的通道里取版本最大的；挑不出
    /// 时看偏好通道有没有清单。
    fn table_conclusion(fixture: &Fixture, kinds: &[Kind]) -> Conclusion {
        match kinds[0] {
            Kind::Failed => return Conclusion::CheckFailed,
            Kind::Stale => return Conclusion::SourceStale,
            Kind::Published | Kind::NotPublished => {}
        }
        let best = fixture
            .channels
            .iter()
            .zip(kinds)
            .filter(|(channel, kind)| **kind == Kind::Published && channel.eligible)
            .map(|(channel, _)| Candidate {
                channel: channel.channel,
                version: v(channel.head),
            })
            .max_by(|a, b| compare_versions(&a.version, &b.version));
        match best {
            Some(candidate) => Conclusion::Available(candidate),
            None if kinds[0] == Kind::Published => Conclusion::UpToDate,
            None => Conclusion::NotPublished,
        }
    }

    /// `len` 个通道各取四种结果的全部组合。
    fn combinations(len: usize) -> Vec<Vec<Kind>> {
        let mut all = vec![Vec::new()];
        for _ in 0..len {
            all = all
                .into_iter()
                .flat_map(|prefix: Vec<Kind>| {
                    KINDS.iter().map(move |kind| {
                        let mut next = prefix.clone();
                        next.push(*kind);
                        next
                    })
                })
                .collect();
        }
        all
    }

    fn fixture_outcome(channel: &FixtureChannel, kind: Kind) -> ChannelOutcome {
        match kind {
            Kind::Published => published(channel.head),
            Kind::NotPublished => ChannelOutcome::NotPublished,
            // 合并只看结果的种类，旧清单给的是哪一版不影响结论。
            Kind::Stale => ChannelOutcome::Stale {
                offered: vec![v(channel.head)],
            },
            Kind::Failed => ChannelOutcome::Failed,
        }
    }

    #[test]
    fn every_combination_of_channel_outcomes_follows_the_conclusion_table() {
        let mut three_channel_combinations = 0;
        let mut conclusions = HashSet::new();
        for fixture in &FIXTURES {
            let current = v(fixture.current);
            let package = Channel::of_version(&current).expect("场景里的版本都认得出通道");
            let refused: Vec<(Channel, Version)> = fixture
                .refused
                .iter()
                .map(|(channel, version)| (*channel, v(version)))
                .collect();
            let all = combinations(fixture.channels.len());
            assert_eq!(all.len(), 4_usize.pow(fixture.channels.len() as u32));
            for kinds in all {
                let reports: Vec<ChannelReport> = fixture
                    .channels
                    .iter()
                    .zip(&kinds)
                    .map(|(channel, kind)| ChannelReport {
                        channel: channel.channel,
                        seen: channel.seen.map(v),
                        outcome: fixture_outcome(channel, *kind),
                    })
                    .collect();
                let got = conclude(&current, package, fixture.preference, &reports, &refused);
                assert_eq!(
                    got,
                    table_conclusion(fixture, &kinds),
                    "{}：{kinds:?}",
                    fixture.name
                );
                if let Conclusion::Available(candidate) = &got {
                    assert_eq!(
                        compare_versions(&candidate.version, &current),
                        Ordering::Greater,
                        "{}：{kinds:?}",
                        fixture.name
                    );
                    let seen = fixture
                        .channels
                        .iter()
                        .find(|channel| channel.channel == candidate.channel)
                        .and_then(|channel| channel.seen);
                    if let Some(seen) = seen {
                        assert_ne!(
                            compare_versions(&candidate.version, &v(seen)),
                            Ordering::Less,
                            "{}：{kinds:?}",
                            fixture.name
                        );
                    }
                }
                conclusions.insert(discriminant(&got));
                if fixture.channels.len() == 3 {
                    three_channel_combinations += 1;
                }
            }
        }
        assert_eq!(
            three_channel_combinations,
            64 * 6,
            "偏好预览版的六组场景各 64 种组合"
        );
        assert_eq!(conclusions.len(), 5, "五种结论都出现过");
    }

    /// 手写的要问的通道表，不调被测函数。
    fn oracle_followed(preference: Channel) -> &'static [Channel] {
        match preference {
            Dev => &[Dev, Beta, Stable],
            Beta => &[Beta, Stable],
            Stable => &[Stable],
        }
    }

    /// 手写的「更慢」表：`channel` 是否比 `than` 慢，不调通道的快慢方法。
    fn oracle_slower(channel: Channel, than: Channel) -> bool {
        matches!(
            (than, channel),
            (Dev, Beta) | (Dev, Stable) | (Beta, Stable)
        )
    }

    /// 照规则逐条直译：严格新于当前、不低于记录、跟随须核心号前进（等它追上来与测试版跟随正式版除外）、没被拒。
    fn oracle_candidate(
        current: &Version,
        package: Channel,
        preference: Channel,
        report: &ChannelReport,
        head: &Version,
        refused: &[(Channel, Version)],
    ) -> bool {
        let newer = compare_versions(head, current) == Ordering::Greater;
        let not_below_record = report
            .seen
            .as_ref()
            .is_none_or(|seen| compare_versions(head, seen) != Ordering::Less);
        let waiting = oracle_slower(preference, package);
        let into_slower = oracle_slower(report.channel, package);
        let beta_to_stable = package == Beta && report.channel == Stable;
        let core_advanced = compare_versions(
            &Version::new(head.major, head.minor, head.patch),
            &Version::new(current.major, current.minor, current.patch),
        ) == Ordering::Greater;
        let follows = waiting || !into_slower || beta_to_stable || core_advanced;
        let not_refused = refused.iter().all(|(channel, version)| {
            *channel != report.channel || compare_versions(version, head) != Ordering::Equal
        });
        newer && not_below_record && follows && not_refused
    }

    fn oracle_conclusion(
        current: &Version,
        package: Channel,
        preference: Channel,
        reports: &[ChannelReport],
        refused: &[(Channel, Version)],
    ) -> Conclusion {
        let preferred_published = match reports[0].outcome {
            ChannelOutcome::Failed => return Conclusion::CheckFailed,
            ChannelOutcome::Stale { .. } => return Conclusion::SourceStale,
            ChannelOutcome::Published { .. } => true,
            ChannelOutcome::NotPublished => false,
        };
        let mut best: Option<Candidate> = None;
        for report in reports {
            let ChannelOutcome::Published { version, .. } = &report.outcome else {
                continue;
            };
            if !oracle_candidate(current, package, preference, report, version, refused) {
                continue;
            }
            if best
                .as_ref()
                .is_none_or(|best| compare_versions(version, &best.version) == Ordering::Greater)
            {
                best = Some(Candidate {
                    channel: report.channel,
                    version: version.clone(),
                });
            }
        }
        match best {
            Some(candidate) => Conclusion::Available(candidate),
            None if preferred_published => Conclusion::UpToDate,
            None => Conclusion::NotPublished,
        }
    }

    /// 通道 `channel` 形状的随机版本号：基础号取值范围小，好让核心号经常相同；序号一半取边界。
    fn random_version(rng: &mut fastrand::Rng, channel: Channel) -> Version {
        let (major, minor, patch) = (rng.u64(0..=2), rng.u64(0..=2), rng.u64(0..=1));
        let seq = if rng.bool() {
            BOUNDARY_SEQS[rng.usize(..BOUNDARY_SEQS.len())]
        } else {
            rng.u64(3..80)
        };
        let text = match channel {
            Dev => format!("{major}.{minor}.{patch}-dev.{seq}"),
            Beta => format!("{major}.{minor}.{patch}-beta.{seq}"),
            Stable => format!("{major}.{minor}.{patch}"),
        };
        v(&text)
    }

    #[test]
    fn random_checks_agree_with_a_rule_by_rule_reading() {
        let mut rng = fastrand::Rng::with_seed(0x5eed_c4a7);
        let mut conclusions = HashSet::new();
        for _ in 0..4000 {
            let package = ALL[rng.usize(..ALL.len())];
            let current = random_version(&mut rng, package);
            let preference = if rng.bool() {
                package
            } else {
                ALL[rng.usize(..ALL.len())]
            };
            let mut refused = Vec::new();
            let mut reports = Vec::new();
            for &channel in oracle_followed(preference) {
                let head = random_version(&mut rng, channel);
                let seen = rng.bool().then(|| random_version(&mut rng, channel));
                if rng.u8(..4) == 0 {
                    refused.push((channel, head.clone()));
                }
                if rng.u8(..8) == 0 {
                    refused.push((channel, random_version(&mut rng, channel)));
                }
                let outcome = match rng.u8(..4) {
                    0 => ChannelOutcome::Published {
                        endpoint: rng.usize(..2),
                        version: head,
                    },
                    1 => ChannelOutcome::NotPublished,
                    2 => ChannelOutcome::Stale {
                        offered: vec![head],
                    },
                    _ => ChannelOutcome::Failed,
                };
                reports.push(ChannelReport {
                    channel,
                    seen,
                    outcome,
                });
            }
            let got = conclude(&current, package, preference, &reports, &refused);
            assert_eq!(
                got,
                oracle_conclusion(&current, package, preference, &reports, &refused),
                "当前 {current}，偏好 {preference:?}，各通道 {reports:?}，被拒 {refused:?}"
            );
            if let Conclusion::Available(candidate) = &got {
                assert_eq!(
                    compare_versions(&candidate.version, &current),
                    Ordering::Greater
                );
                let report = reports
                    .iter()
                    .find(|report| report.channel == candidate.channel)
                    .expect("候选来自要问的通道");
                if let Some(seen) = &report.seen {
                    assert_ne!(compare_versions(&candidate.version, seen), Ordering::Less);
                }
            }
            conclusions.insert(discriminant(&got));
        }
        assert_eq!(conclusions.len(), 5, "五种结论都出现过");
    }
}
