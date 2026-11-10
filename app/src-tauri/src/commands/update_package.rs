//! 下好并验过签的更新包：读它尾部的载荷头，决定能不能交给安装程序。
//!
//! 包就是引导程序本身，载荷头在更新签名的覆盖范围里，插件验过签之后头里写的东西可信。有两种情形挡下一个包：
//!
//! - 头读不出，或头里的版本不是清单给的那一版：包本身不对，按签名无效报。不记进被拒的版本：字节已验过签，
//!   换个源下到的也是同一份，重试没有意义。
//! - 包认得的数据格式号比本机的小（不带这个号的旧包按 0 算）：装上读不了现有数据，报 `update_data_too_new`，
//!   丢掉字节，本次会话把这一版记作被拒，之后的检查不再把它当候选。
//!
//! 两种都要在交给安装程序之前判：交出去之后插件会拉起引导程序并结束启动器，引导程序再拦下，用户回到落樱，
//! 下一轮检查又是同一版，绕成一个圈。
//!
//! 判定是不发请求、不碰槽位的纯函数（[`judge_package`]）；[`vet_download`] 把判定落到槽位与命令错误上，
//! 下载流程在插件验签之后、收包进槽位之前调它。

use petalfall_core::data_format::{package_info, PackageHeaderError, PackageInfo};
use semver::Version;
use serde_json::json;

use crate::commands::error::{code, source_chain, CommandError};
use crate::commands::update_slot::{Candidate, Generation, ReleaseVersion, UpdateSlot};
use crate::commands::updater::RefusalReason;

/// 看过载荷头之后对一个更新包的结论。
#[derive(Debug)]
pub(crate) enum PackageVerdict {
    /// 可以交给安装程序。带出头里读到的版本、数据格式号与能力位。
    Installable(PackageInfo),
    /// 包不对：头读不出，或这不是清单给的那一版。
    Wrong(WrongPackage),
    /// 包认得的数据格式号 `package` 比本机的 `own` 小，装上读不了现有数据。
    DataTooNew { package: u32, own: u32 },
}

/// 包不对的两种情形。
#[derive(Debug)]
pub(crate) enum WrongPackage {
    /// 载荷头读不出：不是 PE、两种 magic 都不是、头或载荷被截断，或新格式的头里数据格式号为 0。
    Unreadable(PackageHeaderError),
    /// 头里的版本 `header` 不是清单给的 `manifest`。
    VersionMismatch { header: String, manifest: String },
}

/// 看验过签的更新包 `bytes` 能不能交给安装程序。`manifest_version` 是清单给的版本（插件已核对签名里的版本与它
/// 一致），`own` 是本机的数据格式号，生产传 `DATA_FORMAT`。
///
/// 先认版本再看号：版本对不上时头里的号说的不是要装的这一版，拿它判数据格式没有意义。
pub(crate) fn judge_package(bytes: &[u8], manifest_version: &str, own: u32) -> PackageVerdict {
    let info = match package_info(bytes) {
        Ok(info) => info,
        Err(err) => return PackageVerdict::Wrong(WrongPackage::Unreadable(err)),
    };
    if !same_version(&info.version, manifest_version) {
        return PackageVerdict::Wrong(WrongPackage::VersionMismatch {
            header: info.version,
            manifest: manifest_version.to_owned(),
        });
    }
    if info.data_format < own {
        return PackageVerdict::DataTooNew {
            package: info.data_format,
            own,
        };
    }
    PackageVerdict::Installable(info)
}

/// 头里的版本与清单版本是不是同一版。规则照更新插件核对签名里的版本：去掉开头的 `v` 后两边都是合法 semver
/// 就按 semver 比，否则逐字比。签名、清单、载荷头三处的版本按同一种规则认，不会出现签名对得上、头却因为拼法
/// 不同被拒的情形。
fn same_version(header: &str, manifest: &str) -> bool {
    match (
        Version::parse(header.trim_start_matches('v')),
        Version::parse(manifest.trim_start_matches('v')),
    ) {
        (Ok(header), Ok(manifest)) => header == manifest,
        _ => header == manifest,
    }
}

/// 把 [`judge_package`] 的结论落到槽位与命令错误上。下载流程在插件验签之后、收包进槽位之前调它：能装时原样
/// 交回字节，由调用方收进槽位；不能装时字节在这里丢掉，调用方拿不到可存的东西。`own` 同 [`judge_package`]。
///
/// - 包不对：报 `update_signature_invalid`，槽位不动，这一版不记作被拒。
/// - 认不得现有数据：本次会话把 `candidate` 这一版记作被拒（原因 `data_too_new`，[`UpdateSlot::refuse_update`]），
///   报 `update_data_too_new`，detail 是 `{ version, channel }`，界面据此说是哪一版、哪个通道被拒。记的是候选的
///   版本原文而不是头里的：槽位按版本原文认是不是同一版，头里的拼法可以不同（[`same_version`]）。`ticket` 是下载
///   开始时取的号，号变了这一版不记，照槽位的规则报 `update_superseded`。
pub(crate) fn vet_download<U: ReleaseVersion>(
    slot: &mut UpdateSlot<U>,
    ticket: Generation,
    candidate: &Candidate<U>,
    bytes: Vec<u8>,
    own: u32,
) -> Result<Vec<u8>, CommandError> {
    let version = candidate.update.release_version();
    let channel = candidate.channel;
    match judge_package(&bytes, version, own) {
        PackageVerdict::Installable(info) => {
            tracing::info!(
                version,
                ?channel,
                data_format = info.data_format,
                caps = ?info.caps,
                "更新包的载荷头核对通过"
            );
            Ok(bytes)
        }
        PackageVerdict::Wrong(wrong) => {
            let (message, causes) = match &wrong {
                WrongPackage::Unreadable(err) => {
                    (format!("更新包的载荷头读不出：{err}"), source_chain(err))
                }
                WrongPackage::VersionMismatch { header, manifest } => (
                    format!("更新包载荷头里的版本是 {header}，清单给的是 {manifest}"),
                    Vec::new(),
                ),
            };
            tracing::warn!(
                version,
                ?channel,
                %message,
                ?causes,
                "更新包不是清单给的那一个，丢弃，不交给安装程序"
            );
            Err(CommandError {
                code: code::UPDATE_SIGNATURE_INVALID,
                message,
                detail: (!causes.is_empty()).then(|| json!({ "causes": causes })),
            })
        }
        PackageVerdict::DataTooNew { package, own } => {
            tracing::warn!(
                version,
                ?channel,
                package,
                own,
                "更新包认得的数据格式比本机的旧，丢弃，不交给安装程序"
            );
            slot.refuse_update(
                ticket,
                version.to_owned(),
                channel,
                RefusalReason::DataTooNew,
            )?;
            Err(CommandError::new(
                code::UPDATE_DATA_TOO_NEW,
                format!(
                    "{version} 认得的数据格式（{package}）比这台电脑上的数据（{own}）旧，装上读不了现有数据，已丢弃"
                ),
            )
            .with_detail(json!({ "version": version, "channel": channel })))
        }
    }
}

#[cfg(test)]
mod tests {
    use petalfall_core::data_format::DATA_FORMAT;
    use petalfall_core::release::order::Channel;

    use super::*;
    use crate::commands::update_slot::tests::Fake;
    use crate::commands::update_slot::{CheckConclusion, SlotError};
    use crate::commands::updater::{RefusedUpdateDto, UpdateIntent};

    const VERSION: &str = "1.1.0-dev.57";
    const PAYLOAD: &[u8] = b"nsis payload";
    /// 能力位第 0 位：认得换通道安装。这里只看它原样带出。
    const CAPS: u32 = 1;

    /// 最小的 PE：DOS 头指向 0x80 处的 PE 签名，一个节、没有可选头，节占 0x200 到 0x400，载荷头从 0x400 起。
    fn bare_pe() -> Vec<u8> {
        let mut pe = vec![0u8; 0x400];
        pe[..2].copy_from_slice(b"MZ");
        pe[0x3C..0x40].copy_from_slice(&0x80u32.to_le_bytes());
        pe[0x80..0x84].copy_from_slice(b"PE\0\0");
        // COFF 头紧跟签名：+2 是节数；+16 是可选头长度，留 0，节表紧跟 COFF 头。
        pe[0x86..0x88].copy_from_slice(&1u16.to_le_bytes());
        let section = 0x84 + 20;
        pe[section + 16..section + 20].copy_from_slice(&0x200u32.to_le_bytes());
        pe[section + 20..section + 24].copy_from_slice(&0x200u32.to_le_bytes());
        pe
    }

    /// 按载荷头的字节布局逐字段拼前 136 字节，`tail` 接在后面：外壳不直接依赖载荷格式的包，借不到它写头的函数。
    /// 读头时不核对两个哈希，留 0。
    fn header(magic: &[u8; 8], version: &str, tail: &[u8]) -> Vec<u8> {
        let mut out = vec![0u8; 136];
        out[0..8].copy_from_slice(magic);
        out[8..16].copy_from_slice(&(PAYLOAD.len() as u64).to_le_bytes());
        out[48..56].copy_from_slice(&3u64.to_le_bytes());
        out[88..88 + version.len()].copy_from_slice(version.as_bytes());
        out.extend_from_slice(tail);
        out
    }

    /// 144 字节的新格式头：136 字节之后是数据格式号与能力位，各 4 字节小端。
    fn v2_header(version: &str, data_format: u32) -> Vec<u8> {
        let mut tail = data_format.to_le_bytes().to_vec();
        tail.extend_from_slice(&CAPS.to_le_bytes());
        header(b"PFSETUP2", version, &tail)
    }

    fn package(header: &[u8], payload: &[u8]) -> Vec<u8> {
        let mut bytes = bare_pe();
        bytes.extend_from_slice(header);
        bytes.extend_from_slice(payload);
        bytes
    }

    fn v2_package(version: &str, data_format: u32) -> Vec<u8> {
        package(&v2_header(version, data_format), PAYLOAD)
    }

    /// 136 字节的旧格式头，没有数据格式号与能力位。
    fn v1_package(version: &str) -> Vec<u8> {
        package(&header(b"PFSETUP1", version, &[]), PAYLOAD)
    }

    /// 号为 0 只能出自旧格式的头：新格式的头里写 0 算头坏了。
    fn package_with_format(data_format: u32) -> Vec<u8> {
        if data_format == 0 {
            v1_package(VERSION)
        } else {
            v2_package(VERSION, data_format)
        }
    }

    fn candidate() -> Candidate<Fake> {
        Candidate {
            update: Fake(VERSION),
            channel: Channel::Dev,
        }
    }

    /// 检查挑出了 [`candidate`] 的槽位。
    fn slot_with_candidate() -> UpdateSlot<Fake> {
        let mut slot = UpdateSlot::default();
        let ticket = slot.generation();
        slot.settle_check(ticket, Vec::new(), CheckConclusion::Found(candidate()))
            .unwrap();
        slot
    }

    /// 照下载流程接上的样子走完下载的最后两步：核对载荷头，过了才收进槽位。
    fn finish_download(
        slot: &mut UpdateSlot<Fake>,
        bytes: Vec<u8>,
        own: u32,
    ) -> Result<(), CommandError> {
        let ticket = slot.generation();
        let candidate = candidate();
        let bytes = vet_download(slot, ticket, &candidate, bytes, own)?;
        slot.store_download(ticket, candidate, bytes)?;
        Ok(())
    }

    fn available(slot: &UpdateSlot<Fake>) -> Option<(&'static str, Channel)> {
        slot.available
            .as_ref()
            .map(|candidate| (candidate.update.0, candidate.channel))
    }

    fn refused_for_data() -> Vec<RefusedUpdateDto> {
        vec![RefusedUpdateDto {
            version: VERSION.to_owned(),
            channel: Channel::Dev,
            reason: RefusalReason::DataTooNew,
            intent: UpdateIntent::Update,
        }]
    }

    /// 新格式的头里号比本机小：报 `update_data_too_new`，detail 说是哪一版、哪个通道；包没进槽位；这一版记作
    /// 被拒（原因 `data_too_new`，用意 `update`），也不再是记着的候选。
    #[test]
    fn a_package_older_than_local_data_is_refused_for_the_session() {
        let mut slot = slot_with_candidate();

        let err = finish_download(&mut slot, v2_package(VERSION, 2), 3).unwrap_err();

        assert_eq!(err.code, code::UPDATE_DATA_TOO_NEW);
        assert_eq!(
            err.detail,
            Some(json!({ "version": "1.1.0-dev.57", "channel": "dev" }))
        );
        assert_eq!(slot.ready().err(), Some(SlotError::NotReady));
        assert_eq!(slot.refused().to_vec(), refused_for_data());
        assert_eq!(available(&slot), None);
        assert!(matches!(
            judge_package(&v2_package(VERSION, 2), VERSION, 3),
            PackageVerdict::DataTooNew { package: 2, own: 3 }
        ));
    }

    /// 旧格式的头没有数据格式号，按 0 算：对本版的号同样报 `update_data_too_new` 并记作被拒。
    #[test]
    fn a_v1_package_counts_as_format_zero() {
        let mut slot = slot_with_candidate();

        let err = finish_download(&mut slot, v1_package(VERSION), DATA_FORMAT).unwrap_err();

        assert_eq!(err.code, code::UPDATE_DATA_TOO_NEW);
        assert_eq!(slot.ready().err(), Some(SlotError::NotReady));
        assert_eq!(slot.refused().to_vec(), refused_for_data());
        assert!(matches!(
            judge_package(&v1_package(VERSION), VERSION, DATA_FORMAT),
            PackageVerdict::DataTooNew { package: 0, own } if own == DATA_FORMAT
        ));
    }

    /// 头读不出或头里不是这一版：报签名无效，包没进槽位，这一版不记作被拒，记着的候选也不动。本机号取 9，
    /// 能读出的头也都过不了数据格式：先认版本再看号，所以报的仍是签名无效。
    #[test]
    fn a_wrong_package_is_a_signature_failure_and_not_refused() {
        let mut wrong_magic = v2_header(VERSION, 9);
        wrong_magic[..8].copy_from_slice(b"PFSETUP9");
        let full = v2_header(VERSION, 9);
        let cases: [(&str, Vec<u8>); 8] = [
            ("不是 PE", b"not a portable executable".to_vec()),
            ("两种 magic 都不是", package(&wrong_magic, PAYLOAD)),
            ("头被截断", package(&full[..140], &[])),
            ("载荷被截断", package(&full, &PAYLOAD[..PAYLOAD.len() - 1])),
            ("新格式的头里号为 0", v2_package(VERSION, 0)),
            ("头里是上一版", v2_package("1.1.0-dev.56", 1)),
            ("头里是同号的测试版", v2_package("1.1.0-beta.57", 1)),
            ("旧格式的头里是上一版", v1_package("1.1.0-dev.56")),
        ];
        for (case, bytes) in cases {
            let mut slot = slot_with_candidate();

            let err = finish_download(&mut slot, bytes, 9).unwrap_err();

            assert_eq!(err.code, code::UPDATE_SIGNATURE_INVALID, "{case}");
            assert_eq!(slot.ready().err(), Some(SlotError::NotReady), "{case}");
            assert!(slot.refused().is_empty(), "{case}");
            assert_eq!(available(&slot), Some((VERSION, Channel::Dev)), "{case}");
        }
    }

    /// 包不对时判定说清是哪一种：头读不出带着读头的错误，版本不符带着两边的版本。
    #[test]
    fn a_wrong_package_says_what_is_wrong() {
        let full = v2_header(VERSION, 2);
        let unreadable = |bytes: &[u8]| match judge_package(bytes, VERSION, 1) {
            PackageVerdict::Wrong(WrongPackage::Unreadable(err)) => err,
            other => panic!("应判头读不出，实际 {other:?}"),
        };
        assert!(matches!(
            unreadable(b"not a portable executable"),
            PackageHeaderError::NotPe(_)
        ));
        let mut wrong_magic = full.clone();
        wrong_magic[..8].copy_from_slice(b"PFSETUP9");
        assert!(matches!(
            unreadable(&package(&wrong_magic, PAYLOAD)),
            PackageHeaderError::BadMagic
        ));
        assert!(matches!(
            unreadable(&package(&full[..140], &[])),
            PackageHeaderError::PayloadTruncated { .. }
        ));
        assert!(matches!(
            unreadable(&v2_package(VERSION, 0)),
            PackageHeaderError::DataFormatZero
        ));

        match judge_package(&v2_package("1.1.0-dev.56", 2), VERSION, 1) {
            PackageVerdict::Wrong(WrongPackage::VersionMismatch { header, manifest }) => {
                assert_eq!(
                    (header.as_str(), manifest.as_str()),
                    ("1.1.0-dev.56", VERSION)
                );
            }
            other => panic!("应判版本不符，实际 {other:?}"),
        }
    }

    /// 版本不符的错误把两边的版本写进说明；头读不出的错误说明里带着读头失败的原因。
    #[test]
    fn signature_failures_explain_themselves() {
        let mut slot = slot_with_candidate();
        let err = finish_download(&mut slot, v2_package("1.1.0-dev.56", 1), 1).unwrap_err();
        assert_eq!(
            err.message,
            "更新包载荷头里的版本是 1.1.0-dev.56，清单给的是 1.1.0-dev.57"
        );
        assert_eq!(err.detail, None);

        let err = finish_download(&mut slot, v2_package(VERSION, 0), 1).unwrap_err();
        assert_eq!(
            err.message,
            "更新包的载荷头读不出：PFSETUP2 载荷头里的数据格式号是 0"
        );
    }

    /// 包号不小于本机号：放行，字节原样收进槽位，判定带出头里的版本、号与能力位，没有被拒的版本。
    #[test]
    fn a_package_that_reads_local_data_goes_to_the_slot() {
        for (data_format, own) in [(2, 2), (5, 2), (1, DATA_FORMAT)] {
            let mut slot = slot_with_candidate();
            let bytes = v2_package(VERSION, data_format);

            finish_download(&mut slot, bytes.clone(), own).unwrap();

            let ready = slot.ready().unwrap();
            assert_eq!(ready.bytes, bytes, "包号 {data_format}，本机 {own}");
            assert_eq!(
                (ready.update.0, ready.channel, ready.intent),
                (VERSION, Channel::Dev, UpdateIntent::Update)
            );
            assert!(slot.refused().is_empty());
            match judge_package(&bytes, VERSION, own) {
                PackageVerdict::Installable(info) => assert_eq!(
                    info,
                    PackageInfo {
                        version: VERSION.to_owned(),
                        data_format,
                        caps: Some(CAPS),
                    }
                ),
                other => panic!("包号 {data_format}，本机 {own} 应放行，实际 {other:?}"),
            }
        }
    }

    /// 固定种子随机的（包号, 本机号），含 0、1、u32 最大值附近的边界与相等、差一的组合：拒绝当且仅当包号小于本机号；
    /// 拒绝时这一版记作被拒、包不进槽位，放行时包进槽位、没有被拒的版本。
    #[test]
    fn refused_exactly_when_the_package_format_is_below_own() {
        const EDGES: [u32; 6] = [0, 1, 2, u32::MAX - 1, u32::MAX, 1 << 31];
        let mut rng = fastrand::Rng::with_seed(0x5ea1_da7a);
        let mut pairs: Vec<(u32, u32)> = EDGES
            .iter()
            .flat_map(|&package| EDGES.iter().map(move |&own| (package, own)))
            .collect();
        for _ in 0..1000 {
            let package = match rng.u8(..3) {
                0 => EDGES[rng.usize(..EDGES.len())],
                1 => rng.u32(..8),
                _ => rng.u32(..),
            };
            let own = match rng.u8(..4) {
                0 => package,
                1 => package.saturating_add(1),
                2 => package.saturating_sub(1),
                _ => rng.u32(..),
            };
            pairs.push((package, own));
        }

        let mut refusals = 0;
        for (package, own) in pairs {
            let bytes = package_with_format(package);
            let refuse = package < own;
            refusals += usize::from(refuse);

            match judge_package(&bytes, VERSION, own) {
                PackageVerdict::DataTooNew {
                    package: found,
                    own: local,
                } => {
                    assert!(refuse, "包号 {package}，本机 {own} 不该拒绝");
                    assert_eq!((found, local), (package, own));
                }
                PackageVerdict::Installable(info) => {
                    assert!(!refuse, "包号 {package}，本机 {own} 该拒绝");
                    assert_eq!(info.data_format, package);
                }
                PackageVerdict::Wrong(wrong) => {
                    panic!("包号 {package}，本机 {own} 的包读不出：{wrong:?}")
                }
            }

            let mut slot = slot_with_candidate();
            let outcome = finish_download(&mut slot, bytes, own);
            if refuse {
                assert_eq!(
                    outcome.map_err(|err| err.code),
                    Err(code::UPDATE_DATA_TOO_NEW),
                    "包号 {package}，本机 {own}"
                );
                assert_eq!(slot.ready().err(), Some(SlotError::NotReady));
                assert_eq!(slot.refused().to_vec(), refused_for_data());
            } else {
                assert_eq!(outcome, Ok(()), "包号 {package}，本机 {own}");
                assert!(slot.ready().is_ok());
                assert!(slot.refused().is_empty());
            }
        }
        // 两边都要真跑到：随机数换了也不至于全落在一边。
        assert!(refusals > 100, "拒绝的组合只有 {refusals} 个");
    }

    /// 头里的版本按更新插件核对签名里的版本的规则认：去掉开头的 `v` 后按 semver 比，构建元数据不同算两版，
    /// 不是合法 semver 时逐字比。
    #[test]
    fn header_versions_match_like_signed_versions() {
        assert!(same_version("1.1.0-dev.57", "1.1.0-dev.57"));
        assert!(same_version("v1.1.0-dev.57", "1.1.0-dev.57"));
        assert!(!same_version("1.1.0-dev.57+ci.3", "1.1.0-dev.57"));
        assert!(!same_version("1.1.0-dev.56", "1.1.0-dev.57"));
        assert!(!same_version("1.1.0", "1.1.0-dev.57"));
        // 前导零不是合法 semver，逐字比也不等。
        assert!(!same_version("1.1.0-dev.057", "1.1.0-dev.57"));
        assert!(same_version("nightly", "nightly"));

        let mut slot = slot_with_candidate();
        finish_download(&mut slot, v2_package("v1.1.0-dev.57", 1), 1).unwrap();
        assert_eq!(slot.downloaded_version().as_deref(), Some(VERSION));
    }

    /// 下载期间改了偏好：下载开始时取的号对不上，这一版不记作被拒，照槽位的规则报 `update_superseded`。
    #[test]
    fn a_refusal_from_before_a_preference_change_does_not_land() {
        let mut slot = slot_with_candidate();
        let ticket = slot.generation();
        slot.reset_for_new_preference();

        let err =
            vet_download(&mut slot, ticket, &candidate(), v2_package(VERSION, 1), 2).unwrap_err();

        assert_eq!(err.code, code::UPDATE_SUPERSEDED);
        assert!(slot.refused().is_empty());
    }
}
