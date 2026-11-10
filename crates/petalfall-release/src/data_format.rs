//! 数据格式号：启动器写进数据目录与游戏目录的文件是第几号格式。
//!
//! 较新的版本改了落盘格式之后，旧版本再去读写同一份数据会读错或写坏。每个版本带一个号，数据上留一个记号，
//! 记号比程序的号大就说明这份数据被更新的版本用过，程序拒绝打开而不是硬读。
//!
//! 这里只放规则，不碰磁盘：记号文件读到的东西算第几号（[`parse_stamp`]），读到之后放行、抬号还是拒绝
//! （[`judge_stamp`]），抬号时写什么（[`stamp_contents`]），记号里的 `written_by` 哪些能拿给用户看
//! （[`trusted_written_by`]），以及安装引导程序要看几个数据根时怎么合成一个结论（[`merge_roots`]）。
//! 读写文件由启动器与引导程序各自做，把读到的情况交进来，两边才判得一样。

use std::cmp::Ordering;

use semver::Version;
use serde::Serialize;
use serde_json::Value;

use crate::order::Channel;

/// 本版本读写的数据格式号。做了旧版本读不了的落盘改动就把它加一，并在 [`FORMAT_HISTORY`] 末尾登记一行。
///
/// 发布流水线按行匹配下面这一行的写法取号，改写法要同步改流水线。
pub const DATA_FORMAT: u32 = 1;

/// 记号文件名。数据目录根下一份，每个游戏目录的启动器元数据目录下各一份。
pub const STAMP_FILE: &str = "data-format.json";

/// 数据格式号的登记表：一个号一行，从 1 起按号连续排到 [`DATA_FORMAT`]。加号时在末尾追加一行。
pub const FORMAT_HISTORY: &[FormatChange] = &[FormatChange {
    format: 1,
    change: "基线：第一个带数据格式号的版本写出的数据形态。",
    reason: "基线，没有更低的号可比。",
}];

/// [`FORMAT_HISTORY`] 的一行。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FormatChange {
    /// 数据格式号。
    pub format: u32,
    /// 这个号的数据与上一个号相比改了什么。
    pub change: &'static str,
    /// 号更低的版本读这个号的数据会出什么问题，也就是为什么非加号不可。
    pub reason: &'static str,
}

/// 记号文件这一次读到的情况，由读盘的一方交给 [`parse_stamp`]。
///
/// 数据所在的目录本身不存在时算哪一种由调用方定：启动器遇到不存在的游戏目录直接放行、不读记号；
/// 安装引导程序读的数据根不存在时按 [`StampFile::Missing`] 交进来。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StampFile<'a> {
    /// 读到了文件，这是它的全部字节。
    Contents(&'a [u8]),
    /// 文件不存在。
    Missing,
    /// 读文件出错（不存在以外的 IO 错误），带出错的原因。
    ReadFailed(String),
}

/// 读出来的有效记号。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stamp {
    /// 这份数据被打开过的最大号，不小于 1。
    pub data_format: u32,
    /// 记号里的 `written_by`。
    pub written_by: WrittenBy,
}

/// 记号里的 `written_by`：把号抬到这个值的那个落樱的版本号，只用来提示用户该装哪一版。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WrittenBy {
    /// 没有这个键，或者文件不存在。
    Absent,
    /// 字符串原文。游戏目录可能在共用盘上，这段文字可能出自别人的机器：拿给用户看之前一律经
    /// [`trusted_written_by`]，原文只转义后进日志。
    Text(String),
    /// 有这个键但值不是字符串（含 `null`）：当作没有，记号照常有效。带出值的 JSON 写法，供调用方记警告。
    NotText(String),
}

impl WrittenBy {
    /// 字符串原文；没有这个键、或值不是字符串时为 `None`。
    pub fn text(&self) -> Option<&str> {
        match self {
            WrittenBy::Text(text) => Some(text),
            WrittenBy::Absent | WrittenBy::NotText(_) => None,
        }
    }
}

/// [`parse_stamp`] 的结论。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StampRead {
    /// 有效记号。
    Valid(Stamp),
    /// 记号读不懂。不当作缺失，也不当作 1：无从知道数据是哪一版写的，放行可能读错。
    /// `reason` 只写原因，不含路径，路径由调用方补上。
    Unreadable { reason: String },
}

/// 读记号的结论：
/// - 文件不存在算 1：号为 1 的版本一个记号都不写，没有记号的数据就是 1 号的形态；
/// - 是 JSON 对象，`data_format` 是 1 到 `u32::MAX` 之间的 JSON 整数，就取它；不认识的键不管，以后的版本
///   可以加键；`written_by` 不是字符串时当作没有，记号照常有效；
/// - 读文件出错、不是 JSON、不是对象、缺 `data_format`、`data_format` 不是 1 到 `u32::MAX` 之间的整数
///   （0、负数、小数、超出 u32、别的类型），一律读不懂。
///
/// 读不懂的原因只描述出了什么错，不照抄文件里的字符串：原因会显示在界面上，而文件可能出自别人的机器。
/// 同一个键出现两次时按 serde_json 的做法取后一个；只有这里读记号，不会有别的读法与它不一致。
pub fn parse_stamp(file: StampFile<'_>) -> StampRead {
    let contents = match file {
        StampFile::Contents(contents) => contents,
        StampFile::Missing => {
            return StampRead::Valid(Stamp {
                data_format: 1,
                written_by: WrittenBy::Absent,
            });
        }
        StampFile::ReadFailed(reason) => return unreadable(format!("读文件出错：{reason}")),
    };
    let mut fields = match serde_json::from_slice::<Value>(contents) {
        Ok(Value::Object(fields)) => fields,
        Ok(other) => return unreadable(format!("不是 JSON 对象，而是{}", json_kind(&other))),
        Err(err) => return unreadable(format!("不是 JSON：{err}")),
    };
    let Some(number) = fields.remove("data_format") else {
        return unreadable("缺 data_format".to_owned());
    };
    let data_format = match stamp_number(&number) {
        Ok(data_format) => data_format,
        Err(reason) => return unreadable(reason),
    };
    let written_by = match fields.remove("written_by") {
        None => WrittenBy::Absent,
        Some(Value::String(text)) => WrittenBy::Text(text),
        Some(other) => WrittenBy::NotText(other.to_string()),
    };
    StampRead::Valid(Stamp {
        data_format,
        written_by,
    })
}

fn unreadable(reason: String) -> StampRead {
    StampRead::Unreadable { reason }
}

/// `data_format` 只认 JSON 整数写法的 1 到 `u32::MAX`：写的一方只写这种，`2.0` 这类写法不是它写的。
fn stamp_number(value: &Value) -> Result<u32, String> {
    let Value::Number(number) = value else {
        return Err(format!("data_format 是{}，不是整数", json_kind(value)));
    };
    number
        .as_u64()
        .and_then(|wide| u32::try_from(wide).ok())
        .filter(|&data_format| data_format >= 1)
        .ok_or_else(|| format!("data_format 不是 1 到 {} 之间的整数：{number}", u32::MAX))
}

fn json_kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "布尔值",
        Value::Number(_) => "数字",
        Value::String(_) => "字符串",
        Value::Array(_) => "数组",
        Value::Object(_) => "对象",
    }
}

/// [`judge_stamp`] 的结论。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StampVerdict {
    /// 有效记号等于本版号：放行，什么都不写。
    Pass,
    /// 有效记号低于本版号：把 [`stamp_contents`] 生成的本版号记号原子写进去，号只升不降。
    /// 写不进去怎么办由调用方按场合定；安装引导程序从不写记号，对它来说这一种也是放行。
    Raise,
    /// 有效记号高于本版号：数据被更新的版本用过，拒绝。
    TooNew {
        /// 记号里的号。
        found: u32,
        /// 记号里 `written_by` 的原文，没有或不是字符串时为 `None`。拿给用户看之前经 [`trusted_written_by`]。
        written_by: Option<String>,
    },
    /// 记号读不懂：拒绝，带出原因。
    Unreadable { reason: String },
}

/// 拿读到的记号与本版号 `own` 比。`own` 显式传入：生产代码传 [`DATA_FORMAT`]，安装引导程序传自己安装包的号。
///
/// 读不懂时不看 `own`：号再高的程序也不知道这份数据是哪一版写的。
pub fn judge_stamp(read: &StampRead, own: u32) -> StampVerdict {
    match read {
        StampRead::Unreadable { reason } => StampVerdict::Unreadable {
            reason: reason.clone(),
        },
        StampRead::Valid(stamp) => match stamp.data_format.cmp(&own) {
            Ordering::Less => StampVerdict::Raise,
            Ordering::Equal => StampVerdict::Pass,
            Ordering::Greater => StampVerdict::TooNew {
                found: stamp.data_format,
                written_by: stamp.written_by.text().map(str::to_owned),
            },
        },
    }
}

/// 文件里的样子。`written_by` 没有时不写这个键，读回来仍是「没有」，而不是 `null` 或空串。
#[derive(Serialize)]
struct StoredStamp<'a> {
    data_format: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    written_by: Option<&'a str>,
}

/// 要写进记号文件的内容，例如 `{"data_format":2,"written_by":"1.1.0-dev.57"}`。
/// `written_by` 是写记号的落樱自己的版本号，没有应用版本时（调试命令行、测试里的门面）传 `None`。
/// 交给 [`parse_stamp`] 读回，号与 `written_by` 都与传入的相同。
///
/// # Panics
///
/// `data_format` 为 0 时：号从 1 起，写进去的 0 读回来只会是读不懂。
pub fn stamp_contents(data_format: u32, written_by: Option<&str>) -> String {
    assert!(
        data_format >= 1,
        "数据格式号从 1 起，写 0 的记号读回来是读不懂"
    );
    serde_json::to_string(&StoredStamp {
        data_format,
        written_by,
    })
    .expect("记号只含一个整数与一个字符串，序列化不会失败")
}

/// 与安装包载荷头里版本字段同宽：比它长的不可能是落樱发出过的版本号。
const WRITTEN_BY_MAX_LEN: usize = 48;

/// 经 [`trusted_written_by`] 认可的 `written_by`：版本与它所属的通道。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustedWrittenBy {
    /// 版本号，按 `to_string` 写回与原文逐字相同。
    pub version: Version,
    /// 按 [`Channel::of_version`] 推出的通道。
    pub channel: Channel,
}

/// 记号里的 `written_by` 能不能拿给用户看。只有下面几条全部满足才交回版本与通道，否则交回 `None`，
/// 界面改说「更新的落樱」：
/// - 形状恰好是 `X.Y.Z`、`X.Y.Z-dev.N`、`X.Y.Z-beta.N` 之一，标识只认小写；
/// - 每个数字段不带前导零（单独的 `0` 可以），不带构建元数据；
/// - 不超过 48 字节。
///
/// 这段文字可能出自别人的机器，只放行落樱自己发过的版本号的形状：网址、控制字符、夹带的话一概进不了界面。
pub fn trusted_written_by(raw: &str) -> Option<TrustedWrittenBy> {
    if raw.len() > WRITTEN_BY_MAX_LEN || !has_release_shape(raw) {
        return None;
    }
    // 形状对了还可能解析失败：核心号超出 u64。这样的版本号同样不是发过的。
    let version = Version::parse(raw).ok()?;
    let channel = Channel::of_version(&version)?;
    Some(TrustedWrittenBy { version, channel })
}

/// 是不是 `X.Y.Z`、`X.Y.Z-dev.N`、`X.Y.Z-beta.N` 之一，每个数字段都不带前导零。
fn has_release_shape(text: &str) -> bool {
    let (core, pre_release) = match text.split_once('-') {
        Some((core, pre_release)) => (core, Some(pre_release)),
        None => (text, None),
    };
    let mut numbers = core.split('.');
    let core_ok =
        (0..3).all(|_| numbers.next().is_some_and(is_plain_number)) && numbers.next().is_none();
    core_ok
        && pre_release.is_none_or(|pre_release| {
            matches!(
                pre_release.split_once('.'),
                Some(("dev" | "beta", seq)) if is_plain_number(seq)
            )
        })
}

/// 非空的 ASCII 数字串，不带前导零。
fn is_plain_number(text: &str) -> bool {
    !text.is_empty()
        && text.bytes().all(|byte| byte.is_ascii_digit())
        && (text == "0" || !text.starts_with('0'))
}

/// 安装引导程序要看不止一个数据根时，把各根的读取结论合成一个，交回定结论的那一个根连同它的结论：
/// - 任一个读不懂，就交回（按传入顺序）第一个读不懂的：读不懂的那一份可能是任何号，比别的根高也说不定，
///   所以它压过一切读得懂的根；
/// - 否则交回号最大的那一个，号相同时取靠前的，带出的 `written_by` 也是它的。
///
/// `root` 原样带回，调用方好写明挡下的是哪个文件。拿交回的结论与安装包的号去 [`judge_stamp`]。
/// 传入为空时交回 `None`。
pub fn merge_roots<K>(reads: impl IntoIterator<Item = (K, StampRead)>) -> Option<(K, StampRead)> {
    let mut decisive: Option<(K, StampRead)> = None;
    for (root, read) in reads {
        let takes_over = match (&decisive, &read) {
            (None, _) => true,
            (Some((_, StampRead::Unreadable { .. })), _) => false,
            (Some(_), StampRead::Unreadable { .. }) => true,
            (Some((_, StampRead::Valid(kept))), StampRead::Valid(next)) => {
                next.data_format > kept.data_format
            }
        };
        if takes_over {
            decisive = Some((root, read));
        }
    }
    decisive
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 号的边界：最小的 1、第一次加号后的 2、u32 的上限与它下面那个。
    const BOUNDARY_FORMATS: [u32; 5] = [1, 2, 3, u32::MAX - 1, u32::MAX];

    fn valid(data_format: u32, written_by: WrittenBy) -> StampRead {
        StampRead::Valid(Stamp {
            data_format,
            written_by,
        })
    }

    fn text(written_by: &str) -> WrittenBy {
        WrittenBy::Text(written_by.to_owned())
    }

    fn read(contents: &str) -> StampRead {
        parse_stamp(StampFile::Contents(contents.as_bytes()))
    }

    fn reason_of(contents: &[u8]) -> String {
        match parse_stamp(StampFile::Contents(contents)) {
            StampRead::Unreadable { reason } => reason,
            other => panic!(
                "{:?} 应判为读不懂，实际是 {other:?}",
                String::from_utf8_lossy(contents)
            ),
        }
    }

    /// 已发出的版本按这个名字找记号，改名等于让它们再也看不见更新的版本留下的记号。
    #[test]
    fn stamp_file_name_is_fixed() {
        assert_eq!(STAMP_FILE, "data-format.json");
    }

    #[test]
    fn a_well_formed_stamp_is_taken_as_is() {
        assert_eq!(
            read(r#"{"data_format":3,"written_by":"1.1.0-dev.57"}"#),
            valid(3, text("1.1.0-dev.57"))
        );
        // 带空白与 CRLF、键序颠倒、多出不认识的键：以后的版本可能多写几项。
        assert_eq!(
            read(
                "{\r\n  \"written_by\": \"1.0.0\",\r\n  \"extra\": {\"a\": [1]},\r\n  \"data_format\": 2\r\n}\r\n"
            ),
            valid(2, text("1.0.0"))
        );
        assert_eq!(
            read(r#"{"data_format":2,"written_by":"1.0.0","data_format":3}"#),
            valid(3, text("1.0.0"))
        );
        for boundary in BOUNDARY_FORMATS {
            assert_eq!(
                read(&format!(r#"{{"data_format":{boundary}}}"#)),
                valid(boundary, WrittenBy::Absent)
            );
        }
    }

    #[test]
    fn written_by_may_be_absent() {
        assert_eq!(read(r#"{"data_format":2}"#), valid(2, WrittenBy::Absent));
    }

    #[test]
    fn written_by_that_is_not_text_is_dropped_and_the_stamp_still_counts() {
        for value in [
            "42",
            "1.5",
            "null",
            "true",
            r#"["1.0.0"]"#,
            r#"{"v":"1.0.0"}"#,
        ] {
            let stamp = read(&format!(r#"{{"data_format":4,"written_by":{value}}}"#));
            assert_eq!(
                stamp,
                valid(4, WrittenBy::NotText(value.to_owned())),
                "{value}"
            );
            assert_eq!(
                judge_stamp(&stamp, 3),
                StampVerdict::TooNew {
                    found: 4,
                    written_by: None
                },
                "{value}"
            );
        }
    }

    #[test]
    fn a_missing_file_counts_as_format_one() {
        let missing = parse_stamp(StampFile::Missing);
        assert_eq!(missing, valid(1, WrittenBy::Absent));
        // 号为 1 的版本对没有记号的数据放行、不写；号更高的版本要抬号。
        assert_eq!(judge_stamp(&missing, 1), StampVerdict::Pass);
        assert_eq!(judge_stamp(&missing, 2), StampVerdict::Raise);
    }

    #[test]
    fn a_read_error_is_unreadable_and_carries_its_cause() {
        let failed = parse_stamp(StampFile::ReadFailed("拒绝访问。 (os error 5)".to_owned()));
        let reason = "读文件出错：拒绝访问。 (os error 5)".to_owned();
        assert_eq!(
            failed,
            StampRead::Unreadable {
                reason: reason.clone()
            }
        );
        for own in BOUNDARY_FORMATS {
            assert_eq!(
                judge_stamp(&failed, own),
                StampVerdict::Unreadable {
                    reason: reason.clone()
                }
            );
        }
    }

    #[test]
    fn bytes_that_are_not_json_are_unreadable() {
        for contents in [
            &b""[..],
            b"   ",
            b"{",
            b"data_format=2",
            b"{\"data_format\":2",
            b"{\"data_format\":2,}",
            b"{\"data_format\":2} {}",
            b"{'data_format':2}",
            b"\xff\xfe{\"data_format\":2}",
            b"{\"data_format\":2,\"written_by\":\"\xff\"}",
        ] {
            let reason = reason_of(contents);
            assert!(reason.starts_with("不是 JSON："), "{reason}");
        }
    }

    #[test]
    fn json_that_is_not_an_object_is_unreadable() {
        for (contents, kind) in [
            ("3", "数字"),
            (r#""3""#, "字符串"),
            ("[3]", "数组"),
            (r#"[{"data_format":3}]"#, "数组"),
            ("null", "null"),
            ("true", "布尔值"),
        ] {
            assert_eq!(
                reason_of(contents.as_bytes()),
                format!("不是 JSON 对象，而是{kind}"),
                "{contents}"
            );
        }
    }

    #[test]
    fn an_object_without_data_format_is_unreadable() {
        for contents in [
            "{}",
            r#"{"written_by":"1.0.0"}"#,
            r#"{"Data_Format":2}"#,
            r#"{"dataFormat":2}"#,
            r#"{"data":{"data_format":2}}"#,
        ] {
            assert_eq!(
                reason_of(contents.as_bytes()),
                "缺 data_format",
                "{contents}"
            );
        }
    }

    #[test]
    fn data_format_must_be_an_integer_from_one_to_u32_max() {
        let out_of_range =
            |shown: &str| format!("data_format 不是 1 到 {} 之间的整数：{shown}", u32::MAX);
        for value in [
            "0",
            "-1",
            "-4294967295",
            "4294967296",
            "18446744073709551615",
        ] {
            assert_eq!(
                reason_of(format!(r#"{{"data_format":{value}}}"#).as_bytes()),
                out_of_range(value),
                "{value}"
            );
        }
        // 小数与指数写法、超出 u64 的整数：serde_json 按浮点数收，原因里的数字写法随它，只核对归类。
        for value in [
            "1.5",
            "2.0",
            "0.0",
            "-0",
            "1e0",
            "1E2",
            "18446744073709551616",
        ] {
            let reason = reason_of(format!(r#"{{"data_format":{value}}}"#).as_bytes());
            assert!(reason.starts_with(&out_of_range("")), "{value}：{reason}");
        }
        for (value, kind) in [
            (r#""2""#, "字符串"),
            ("null", "null"),
            ("true", "布尔值"),
            ("[2]", "数组"),
            (r#"{"n":2}"#, "对象"),
        ] {
            assert_eq!(
                reason_of(format!(r#"{{"data_format":{value}}}"#).as_bytes()),
                format!("data_format 是{kind}，不是整数"),
                "{value}"
            );
        }
    }

    #[test]
    fn the_verdict_compares_the_stamp_with_this_builds_format() {
        let stamped = |data_format| valid(data_format, text("1.1.0-dev.57"));
        assert_eq!(judge_stamp(&stamped(2), 2), StampVerdict::Pass);
        assert_eq!(judge_stamp(&stamped(1), 2), StampVerdict::Raise);
        assert_eq!(
            judge_stamp(&stamped(3), 2),
            StampVerdict::TooNew {
                found: 3,
                written_by: Some("1.1.0-dev.57".to_owned())
            }
        );
        assert_eq!(
            judge_stamp(&valid(3, WrittenBy::Absent), 2),
            StampVerdict::TooNew {
                found: 3,
                written_by: None
            }
        );
        assert_eq!(
            judge_stamp(&stamped(u32::MAX), u32::MAX - 1),
            StampVerdict::TooNew {
                found: u32::MAX,
                written_by: Some("1.1.0-dev.57".to_owned())
            }
        );
        assert_eq!(judge_stamp(&stamped(1), u32::MAX), StampVerdict::Raise);
        assert_eq!(
            judge_stamp(&stamped(u32::MAX), u32::MAX),
            StampVerdict::Pass
        );
    }

    #[test]
    fn stamp_contents_write_exactly_the_two_keys() {
        assert_eq!(
            stamp_contents(2, Some("1.1.0-dev.57")),
            r#"{"data_format":2,"written_by":"1.1.0-dev.57"}"#
        );
        assert_eq!(stamp_contents(3, None), r#"{"data_format":3}"#);
        assert_eq!(
            stamp_contents(u32::MAX, Some("")),
            r#"{"data_format":4294967295,"written_by":""}"#
        );
    }

    #[test]
    #[should_panic(expected = "数据格式号从 1 起")]
    fn stamp_contents_refuse_format_zero() {
        stamp_contents(0, Some("1.0.0"));
    }

    #[test]
    fn stamp_contents_read_back_unchanged() {
        let long = "x".repeat(10_000);
        for written_by in [
            None,
            Some(""),
            Some("\""),
            Some("\\"),
            Some("a\"b\\c/d"),
            Some("\n\r\t\u{0}\u{1f}\u{7f}"),
            Some("落樱 1.0.0"),
            Some("\u{202e}1.0.0"),
            Some("https://example.com/download"),
            Some(long.as_str()),
        ] {
            for data_format in BOUNDARY_FORMATS {
                let contents = stamp_contents(data_format, written_by);
                assert_eq!(
                    read(&contents),
                    valid(data_format, written_by.map_or(WrittenBy::Absent, text)),
                    "{contents}"
                );
            }
        }
    }

    fn random_format(rng: &mut fastrand::Rng) -> u32 {
        match rng.u8(..3) {
            0 => BOUNDARY_FORMATS[rng.usize(..BOUNDARY_FORMATS.len())],
            // 小号抽得密，记号与本版号相等的情形才抽得到。
            1 => rng.u32(1..=4),
            _ => rng.u32(1..),
        }
    }

    fn random_written_by(rng: &mut fastrand::Rng) -> Option<String> {
        match rng.u8(..4) {
            0 => None,
            1 => Some(format!(
                "{}.{}.0-dev.{}",
                rng.u8(..3),
                rng.u8(..20),
                rng.u64(..)
            )),
            2 => Some(format!("{}.{}.{}", rng.u8(..3), rng.u8(..20), rng.u8(..5))),
            // 任意字符，含引号、反斜杠、控制字符与多字节字符：读回必须逐字相同。
            _ => Some((0..rng.usize(..12)).map(|_| rng.char(..)).collect()),
        }
    }

    /// 固定种子随机抽 (记号, 本版号)：拒绝当且仅当记号大于本版号；相等时不写；抬号后生成的内容读回等于本版号，
    /// 再判一次就是放行。
    #[test]
    fn random_stamps_against_random_builds() {
        let mut rng = fastrand::Rng::with_seed(0xda7a_f0e7);
        let (mut passed, mut raised, mut refused) = (0, 0, 0);
        for _ in 0..3000 {
            let (stamped, own) = (random_format(&mut rng), random_format(&mut rng));
            let written_by = random_written_by(&mut rng);
            let contents = stamp_contents(stamped, written_by.as_deref());
            // 号为 1、不带 written_by 的记号与没有记号是同一种数据，两种读法都要走到。
            let found = if stamped == 1 && written_by.is_none() && rng.bool() {
                parse_stamp(StampFile::Missing)
            } else {
                parse_stamp(StampFile::Contents(contents.as_bytes()))
            };
            assert_eq!(
                found,
                valid(
                    stamped,
                    written_by
                        .clone()
                        .map_or(WrittenBy::Absent, WrittenBy::Text)
                ),
                "{contents}"
            );

            let verdict = judge_stamp(&found, own);
            assert_eq!(
                matches!(verdict, StampVerdict::TooNew { .. }),
                stamped > own,
                "记号 {stamped}，本版号 {own}"
            );
            match verdict {
                StampVerdict::Pass => {
                    assert_eq!(stamped, own);
                    passed += 1;
                }
                StampVerdict::Raise => {
                    assert!(stamped < own, "记号 {stamped}，本版号 {own}");
                    let app_version = format!("1.{}.0-dev.{}", rng.u8(..), rng.u64(..));
                    let raised_contents = stamp_contents(own, Some(&app_version));
                    let reread = read(&raised_contents);
                    assert_eq!(reread, valid(own, WrittenBy::Text(app_version)));
                    assert_eq!(judge_stamp(&reread, own), StampVerdict::Pass);
                    raised += 1;
                }
                StampVerdict::TooNew {
                    found: shown,
                    written_by: shown_by,
                } => {
                    assert_eq!(shown, stamped);
                    assert_eq!(shown_by, written_by);
                    refused += 1;
                }
                StampVerdict::Unreadable { reason } => {
                    panic!("合法记号判成了读不懂：{reason}（{contents}）")
                }
            }
        }
        assert!(
            passed > 100 && raised > 100 && refused > 100,
            "放行 {passed}，抬号 {raised}，拒绝 {refused}"
        );
    }

    #[test]
    fn the_three_release_shapes_are_trusted_with_their_channel() {
        for (raw, channel) in [
            ("1.0.0", Channel::Stable),
            ("0.1.0", Channel::Stable),
            ("0.0.0", Channel::Stable),
            ("10.20.30", Channel::Stable),
            ("1.1.0-dev.57", Channel::Dev),
            ("1.0.0-dev.0", Channel::Dev),
            ("0.1.0-dev.41", Channel::Dev),
            ("1.0.0-beta.3", Channel::Beta),
            ("1.0.0-beta.0", Channel::Beta),
            ("2.0.0-beta.9007199254740993", Channel::Beta),
        ] {
            let trusted = trusted_written_by(raw).unwrap_or_else(|| panic!("{raw} 应当可信"));
            assert_eq!(trusted.channel, channel, "{raw}");
            assert_eq!(trusted.version.to_string(), raw);
        }
    }

    #[test]
    fn written_by_is_trusted_up_to_48_bytes() {
        for (at_limit, over_limit, channel) in [
            (
                format!("1.0.0-dev.{}", "1".repeat(38)),
                format!("1.0.0-dev.{}", "1".repeat(39)),
                Channel::Dev,
            ),
            (
                format!("1.0.0-beta.{}", "9".repeat(37)),
                format!("1.0.0-beta.{}", "9".repeat(38)),
                Channel::Beta,
            ),
            (
                "1234567890123456.123456789012345.123456789012345".to_owned(),
                "12345678901234567.123456789012345.123456789012345".to_owned(),
                Channel::Stable,
            ),
        ] {
            assert_eq!((at_limit.len(), over_limit.len()), (48, 49));
            assert_eq!(
                trusted_written_by(&at_limit).map(|trusted| trusted.channel),
                Some(channel),
                "{at_limit}"
            );
            assert_eq!(trusted_written_by(&over_limit), None, "{over_limit}");
        }
    }

    #[test]
    fn anything_else_is_not_trusted() {
        for raw in [
            // 构建元数据
            "1.0.0+build.5",
            "1.0.0-dev.1+abc",
            "1.0.0-beta.2+",
            // 前导零
            "01.0.0",
            "1.00.0",
            "1.0.01",
            "1.0.0-dev.01",
            "1.0.0-beta.00",
            // 别的预发布标识与写法
            "1.0.0-rc.1",
            "1.0.0-alpha.1",
            "1.0.0-dev-1",
            "1.0.0-beta-1",
            "1.0.0-dev",
            "1.0.0-beta",
            "1.0.0-dev1",
            "1.0.0-DEV.1",
            "1.0.0-Beta.1",
            "1.0.0-dev.1.2",
            "1.0.0-dev.",
            "1.0.0-dev.x",
            "1.0.0-dev.-1",
            "1.0.0-",
            // 核心号的段数与字符
            "",
            "1",
            "1.0",
            "1.0.0.0",
            "1..0",
            ".1.0.0",
            "v1.0.0",
            "-1.0.0",
            "1.0.x",
            "\u{ff11}.0.0",
            // 空白与控制字符
            " 1.0.0",
            "1.0.0 ",
            "1.0.0\n",
            "1.0.0\r\n",
            "1.0.0\t",
            "1.0.0\u{0}",
            "1.0.0-dev.1\u{7}",
            "\u{1b}[31m1.0.0",
            "1.0.0\u{7f}",
            "1.0.0\u{202e}",
            "1.0.0\u{200b}",
            // 网址与夹带的文字
            "https://example.com/1.0.0",
            "1.0.0 https://example.com",
            "1.0.0-dev.1 请到 example.com 下载",
            "file:///C:/1.0.0",
            // 核心号超出 u64
            "18446744073709551616.0.0",
        ] {
            assert_eq!(trusted_written_by(raw), None, "{raw:?}");
        }
    }

    /// 固定种子随机生成三种合法形状，都可信并推出对应通道；每个样本再只坏一处（构建元数据、前导零、
    /// 控制字符、超过 48 字节），就不可信。
    #[test]
    fn random_release_versions_are_trusted_and_any_one_flaw_is_not() {
        const CONTROLS: [char; 6] = ['\u{0}', '\n', '\r', '\t', '\u{1b}', '\u{7f}'];
        let mut rng = fastrand::Rng::with_seed(0x7e57_b0d1);
        for _ in 0..1000 {
            let mut numbers = vec![rng.u64(..1000), rng.u64(..1000), rng.u64(..100)];
            let (tag, channel) = match rng.u8(..3) {
                0 => (Some("dev"), Channel::Dev),
                1 => (Some("beta"), Channel::Beta),
                _ => (None, Channel::Stable),
            };
            if tag.is_some() {
                numbers.push(rng.u64(..));
            }
            let render = |zero_padded: Option<usize>| -> String {
                let shown: Vec<String> = numbers
                    .iter()
                    .enumerate()
                    .map(|(index, number)| {
                        let pad = if zero_padded == Some(index) { "0" } else { "" };
                        format!("{pad}{number}")
                    })
                    .collect();
                match tag {
                    Some(tag) => {
                        format!("{}.{}.{}-{tag}.{}", shown[0], shown[1], shown[2], shown[3])
                    }
                    None => format!("{}.{}.{}", shown[0], shown[1], shown[2]),
                }
            };
            let raw = render(None);
            let trusted = trusted_written_by(&raw).unwrap_or_else(|| panic!("{raw} 应当可信"));
            assert_eq!(trusted.channel, channel, "{raw}");
            assert_eq!(trusted.version.to_string(), raw);

            let flawed = match rng.u8(..4) {
                0 => format!("{raw}+{}", rng.alphanumeric()),
                1 => render(Some(rng.usize(..numbers.len()))),
                2 => {
                    let mut flawed = raw.clone();
                    let control = CONTROLS[rng.usize(..CONTROLS.len())];
                    flawed.insert(rng.usize(..=raw.len()), control);
                    flawed
                }
                _ => {
                    let prefix = format!("1.0.0-{}.", tag.unwrap_or("dev"));
                    let digits = 49 - prefix.len();
                    format!("{prefix}1{}", "0".repeat(digits - 1))
                }
            };
            assert_eq!(trusted_written_by(&flawed), None, "{flawed:?}");
        }
    }

    #[test]
    fn merging_roots_takes_the_highest_format() {
        assert_eq!(
            merge_roots([
                ("登记目录", valid(1, WrittenBy::Absent)),
                ("本地应用数据", valid(3, text("1.1.0-dev.57"))),
            ]),
            Some(("本地应用数据", valid(3, text("1.1.0-dev.57"))))
        );
        assert_eq!(
            merge_roots([
                ("登记目录", valid(4, text("1.2.0-beta.1"))),
                ("本地应用数据", valid(2, WrittenBy::Absent)),
            ]),
            Some(("登记目录", valid(4, text("1.2.0-beta.1"))))
        );
        // 号相同取靠前的，带出的 written_by 也是它的。
        assert_eq!(
            merge_roots([
                ("a", valid(2, text("1.0.0-dev.1"))),
                ("b", valid(2, text("1.0.0-dev.2"))),
            ]),
            Some(("a", valid(2, text("1.0.0-dev.1"))))
        );
        assert_eq!(
            merge_roots([("a", valid(5, WrittenBy::Absent))]),
            Some(("a", valid(5, WrittenBy::Absent)))
        );
        assert_eq!(merge_roots(Vec::<(&str, StampRead)>::new()), None);
    }

    #[test]
    fn any_unreadable_root_blocks_even_beside_a_higher_one() {
        let unreadable = |reason: &str| StampRead::Unreadable {
            reason: reason.to_owned(),
        };
        for (reads, root, reason) in [
            (
                vec![
                    ("a", unreadable("缺 data_format")),
                    ("b", valid(9, WrittenBy::Absent)),
                ],
                "a",
                "缺 data_format",
            ),
            (
                vec![
                    ("a", valid(9, WrittenBy::Absent)),
                    ("b", unreadable("缺 data_format")),
                ],
                "b",
                "缺 data_format",
            ),
            (
                vec![
                    ("a", valid(1, WrittenBy::Absent)),
                    ("b", unreadable("读文件出错：x")),
                    ("c", unreadable("缺 data_format")),
                ],
                "b",
                "读文件出错：x",
            ),
        ] {
            let (merged_root, merged) = merge_roots(reads).expect("传入不为空");
            assert_eq!((merged_root, &merged), (root, &unreadable(reason)));
            // 安装包的号再高也拦。
            assert_eq!(
                judge_stamp(&merged, u32::MAX),
                StampVerdict::Unreadable {
                    reason: reason.to_owned()
                }
            );
        }
    }

    /// 固定种子随机生成一到四个根，与逐个比对的结果一致；拿合并的结论去判安装包的号，拦下当且仅当
    /// 有一个根读不懂、或最大的号高于安装包的号。
    #[test]
    fn random_root_sets_merge_to_the_first_unreadable_or_the_first_highest() {
        let mut rng = fastrand::Rng::with_seed(0x2007_5e75);
        for _ in 0..2000 {
            let reads: Vec<(usize, StampRead)> = (0..rng.usize(1..=4))
                .map(|index| {
                    let read = if rng.u8(..6) == 0 {
                        StampRead::Unreadable {
                            reason: format!("第 {index} 个根读不懂"),
                        }
                    } else {
                        let written_by =
                            random_written_by(&mut rng).map_or(WrittenBy::Absent, WrittenBy::Text);
                        valid(random_format(&mut rng), written_by)
                    };
                    (index, read)
                })
                .collect();
            let first_unreadable = reads
                .iter()
                .find(|(_, read)| matches!(read, StampRead::Unreadable { .. }));
            let expected = first_unreadable.cloned().unwrap_or_else(|| {
                let highest = reads
                    .iter()
                    .map(|(_, read)| match read {
                        StampRead::Valid(stamp) => stamp.data_format,
                        StampRead::Unreadable { .. } => unreachable!("上面已经找过读不懂的"),
                    })
                    .max()
                    .expect("至少一个根");
                reads
                    .iter()
                    .find(|(_, read)| {
                        matches!(read, StampRead::Valid(stamp) if stamp.data_format == highest)
                    })
                    .cloned()
                    .expect("最大的号出自某个根")
            });
            let merged = merge_roots(reads.clone()).expect("传入不为空");
            assert_eq!(merged, expected, "{reads:?}");

            let package = random_format(&mut rng);
            let blocked = !matches!(
                judge_stamp(&merged.1, package),
                StampVerdict::Pass | StampVerdict::Raise
            );
            let should_block = reads.iter().any(|(_, read)| match read {
                StampRead::Unreadable { .. } => true,
                StampRead::Valid(stamp) => stamp.data_format > package,
            });
            assert_eq!(blocked, should_block, "安装包 {package}：{reads:?}");
        }
    }

    /// 号不能跳，也不能悄悄变小：登记表恰好从 1 排到当前的号，每一行都写了改了什么、为什么加号。
    #[test]
    fn format_history_lists_every_format_from_one_to_the_current_one() {
        let formats: Vec<u32> = FORMAT_HISTORY.iter().map(|entry| entry.format).collect();
        assert_eq!(formats, (1..=DATA_FORMAT).collect::<Vec<u32>>());
        for entry in FORMAT_HISTORY {
            assert!(
                !entry.change.trim().is_empty() && !entry.reason.trim().is_empty(),
                "第 {} 号没写说明",
                entry.format
            );
        }
    }

    /// 发布流水线逐行找 `^pub const DATA_FORMAT: u32 = ([1-9][0-9]*);$` 取号。这里照同一条规则数本文件的行：
    /// 恰好一行命中，取出的号等于常量本身。
    #[test]
    fn the_pipeline_finds_exactly_one_data_format_line() {
        let source = include_str!("data_format.rs");
        let found: Vec<&str> = source.lines().filter_map(pipeline_number).collect();
        assert_eq!(found, [DATA_FORMAT.to_string().as_str()]);
    }

    fn pipeline_number(line: &str) -> Option<&str> {
        let digits = line
            .strip_prefix("pub const DATA_FORMAT: u32 = ")?
            .strip_suffix(';')?;
        let mut bytes = digits.bytes();
        let shaped = bytes
            .next()
            .is_some_and(|first| (b'1'..=b'9').contains(&first))
            && bytes.all(|byte| byte.is_ascii_digit());
        shaped.then_some(digits)
    }
}
