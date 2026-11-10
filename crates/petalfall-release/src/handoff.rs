//! 安装引导程序交给启动器的换通道记录。
//!
//! 用户在引导程序里确认换到另一个通道之后，新装上的启动器要把「更新通道」跟着改过去。引导程序改不了
//! 启动器的配置（它不认配置的格式，数据目录也可能不在它能写的地方），所以留一份记录，由启动器启动时读。
//! 写的一方和读的一方用这里的同一份定义。
//!
//! 启动器只采用版本与自己相同的那份记录：装失败、或者用户后来又装了别的版本，记录里的版本对不上，自然作废。
//! 文件位置与 `channel`、`version`、`written_at` 三个键随已发出的引导程序固定下来，以后的启动器都要认得。
//! 这里只管文件内容与路径名，不碰磁盘：写盘是引导程序的事，读、删是启动器的事。

use std::error::Error;
use std::fmt;

use semver::Version;
use serde::de::value::MapAccessDeserializer;
use serde::de::{MapAccess, Visitor};
use serde::{Deserialize, Serialize};

use crate::order::Channel;

/// `%LOCALAPPDATA%` 下安装引导程序自己的目录，交接记录、半装记录与引导程序日志都在这里。
///
/// 必须与引导程序 `app/src-tauri-setup/src/log.rs` 的 `SETUP_DIR` 相同：记录由引导程序写、由启动器读，
/// 两边各自拼路径，名字不一致时启动器永远找不到记录。
pub const SETUP_DIR: &str = "Petalfall-Setup";

/// 交接记录的文件名，放在 [`SETUP_DIR`] 下。
pub const HANDOFF_FILE: &str = "channel-handoff.json";

/// 一份交接记录。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelHandoff {
    /// 用户换到的通道，即刚装上的安装包的通道。
    pub channel: Channel,
    /// 刚装上的安装包的版本。启动器只在它与自己的版本相同时采用这份记录。
    pub version: Version,
    /// 写下记录的时刻，Unix 时间戳，单位秒。只写进日志，不参与判断。
    pub written_at: u64,
}

/// 文件里的样子，写和读用同一个结构，两边的键不会各写各的。版本号按字符串落盘、读回再解析，
/// 好把「不是合法版本号」与「不是 JSON」分开报。
#[derive(Serialize, Deserialize)]
struct Stored {
    channel: String,
    version: String,
    written_at: u64,
}

/// 只从 JSON 对象读 [`Stored`]。derive 出来的结构体反序列化也收按字段顺序排的数组，
/// `["beta","1.0.0-beta.5",0]` 会被当成合法记录；引导程序从不这样写，这种文件是形状不对。
struct StoredObject;

impl<'de> Visitor<'de> for StoredObject {
    type Value = Stored;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("JSON 对象")
    }

    fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Stored, A::Error> {
        // 键的读法仍交给 derive 出来的那份：缺键、同一个键写两次、值的类型不对照旧报出。
        Stored::deserialize(MapAccessDeserializer::new(map))
    }
}

impl ChannelHandoff {
    /// 写进文件的内容，例如 `{"channel":"beta","version":"1.0.0-beta.5","written_at":1794000000}`。
    pub fn to_json(&self) -> String {
        let stored = Stored {
            channel: self.channel.as_str().to_owned(),
            version: self.version.to_string(),
            written_at: self.written_at,
        };
        // 两个字符串加一个整数写进内存：serde_json 只在映射的键不是字符串或写出端出错时失败，这里都不会发生。
        serde_json::to_string(&stored).expect("交接记录只含字符串与整数，序列化不会失败")
    }

    /// 从文件内容读回记录。收字节而不是字符串：文件不是 UTF-8 也算读不懂，在这里一并报出，
    /// 不让调用方把它和读文件出错混在一起。
    ///
    /// 记录里多出来的键不管：以后的引导程序可能多写几项，读到这种记录的启动器照样按版本判断要不要，
    /// 不必当成读不懂。同一个键写了两次算读不懂。
    pub fn from_json(contents: &[u8]) -> Result<Self, HandoffError> {
        let mut deserializer = serde_json::Deserializer::from_slice(contents);
        let stored = serde::Deserializer::deserialize_map(&mut deserializer, StoredObject)
            .and_then(|stored| deserializer.end().map(|()| stored))
            .map_err(HandoffError::Malformed)?;
        let Some(channel) = Channel::from_name(&stored.channel) else {
            return Err(HandoffError::UnknownChannel(stored.channel));
        };
        let version = match Version::parse(&stored.version) {
            Ok(version) => version,
            Err(source) => {
                return Err(HandoffError::InvalidVersion {
                    text: stored.version,
                    source,
                });
            }
        };
        Ok(Self {
            channel,
            version,
            written_at: stored.written_at,
        })
    }
}

/// 交接记录读不懂的原因。
#[derive(Debug)]
pub enum HandoffError {
    /// 不是 UTF-8 的 JSON，或者形状不对：不是对象、缺键、同一个键出现两次、值的类型不对
    /// （例如 `written_at` 不是非负整数）。
    Malformed(serde_json::Error),
    /// `channel` 不是 `dev`、`beta`、`stable` 之一，带出原值。
    UnknownChannel(String),
    /// `version` 不是合法的 semver 版本号，带出原值。
    InvalidVersion { text: String, source: semver::Error },
}

impl fmt::Display for HandoffError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            HandoffError::Malformed(err) => write!(f, "交接记录不是约定形状的 JSON：{err}"),
            HandoffError::UnknownChannel(name) => {
                write!(f, "交接记录的通道 {name:?} 不是 dev、beta、stable 之一")
            }
            HandoffError::InvalidVersion { text, source } => {
                write!(f, "交接记录的版本号 {text:?} 不合法：{source}")
            }
        }
    }
}

impl Error for HandoffError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            HandoffError::Malformed(err) => Some(err),
            HandoffError::UnknownChannel(_) => None,
            HandoffError::InvalidVersion { source, .. } => Some(source),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(channel: Channel, version: &str, written_at: u64) -> ChannelHandoff {
        ChannelHandoff {
            channel,
            version: Version::parse(version).unwrap(),
            written_at,
        }
    }

    fn malformed(contents: &[u8]) -> serde_json::Error {
        match ChannelHandoff::from_json(contents) {
            Err(HandoffError::Malformed(err)) => err,
            other => panic!(
                "{:?} 应判为形状不对，实际是 {other:?}",
                String::from_utf8_lossy(contents)
            ),
        }
    }

    /// 文件位置随已发出的引导程序固定，改名等于让新启动器再也找不到旧引导程序写的记录。
    #[test]
    fn file_location_is_fixed() {
        assert_eq!(SETUP_DIR, "Petalfall-Setup");
        assert_eq!(HANDOFF_FILE, "channel-handoff.json");
    }

    #[test]
    fn writes_exactly_the_three_keys() {
        assert_eq!(
            record(Channel::Beta, "1.0.0-beta.5", 1_794_000_000).to_json(),
            r#"{"channel":"beta","version":"1.0.0-beta.5","written_at":1794000000}"#
        );
        assert_eq!(
            record(Channel::Dev, "1.0.0-dev.60", 0).to_json(),
            r#"{"channel":"dev","version":"1.0.0-dev.60","written_at":0}"#
        );
        assert_eq!(
            record(Channel::Stable, "1.0.0", u64::MAX).to_json(),
            r#"{"channel":"stable","version":"1.0.0","written_at":18446744073709551615}"#
        );
    }

    #[test]
    fn reads_back_what_it_writes() {
        let mut rng = fastrand::Rng::with_seed(0x4a2d_0ff1);
        let fixed = [
            record(Channel::Dev, "1.0.0-dev.0", 0),
            record(Channel::Dev, "1.0.0-dev.9007199254740993", 1),
            record(Channel::Beta, "1.0.0-beta.1", u64::MAX),
            record(Channel::Stable, "0.1.0", 1_794_000_000),
        ];
        let random = (0..300).map(|_| {
            let (major, minor) = (rng.u64(..5), rng.u64(..20));
            let (channel, version) = match rng.u8(..3) {
                0 => (
                    Channel::Dev,
                    format!("{major}.{minor}.0-dev.{}", rng.u64(..)),
                ),
                1 => (
                    Channel::Beta,
                    format!("{major}.{minor}.0-beta.{}", rng.u64(..)),
                ),
                _ => (Channel::Stable, format!("{major}.{minor}.{}", rng.u64(..3))),
            };
            record(channel, &version, rng.u64(..))
        });
        for original in fixed.into_iter().chain(random) {
            let json = original.to_json();
            assert_eq!(
                ChannelHandoff::from_json(json.as_bytes()).unwrap(),
                original,
                "{json}"
            );
        }
    }

    /// 键的顺序、空白与换行都不影响读。
    #[test]
    fn reads_records_laid_out_differently() {
        let expected = record(Channel::Beta, "1.0.0-beta.5", 1_794_000_000);
        for text in [
            r#"{"channel": "beta", "version": "1.0.0-beta.5", "written_at": 1794000000}"#,
            "{\r\n  \"written_at\": 1794000000,\r\n  \"version\": \"1.0.0-beta.5\",\r\n  \"channel\": \"beta\"\r\n}\r\n",
        ] {
            assert_eq!(
                ChannelHandoff::from_json(text.as_bytes()).unwrap(),
                expected,
                "{text}"
            );
        }
    }

    /// 以后的引导程序多写的键不影响读出这三项，交给启动器按版本判断。
    #[test]
    fn extra_keys_are_ignored() {
        let text = r#"{"channel":"dev","version":"1.1.0-dev.61","written_at":5,"reason":"switch","extra":{"a":[1,2]}}"#;
        assert_eq!(
            ChannelHandoff::from_json(text.as_bytes()).unwrap(),
            record(Channel::Dev, "1.1.0-dev.61", 5)
        );
    }

    #[test]
    fn not_json_is_malformed() {
        for contents in [
            &b""[..],
            b"   ",
            b"garbage",
            b"{",
            b"{\"channel\":\"dev\",",
            b"\xff\xfe{}",
            "\u{feff}{\"channel\":\"dev\",\"version\":\"1.0.0-dev.1\",\"written_at\":1}".as_bytes(),
        ] {
            malformed(contents);
        }
    }

    /// 标量与数组都报类型不对，并点明要的是对象。
    #[test]
    fn json_that_is_not_an_object_is_malformed() {
        for (text, kind) in [
            ("null", "null"),
            ("1794000000", "integer `1794000000`"),
            ("-1", "integer `-1`"),
            ("1.5", "floating point `1.5`"),
            ("\"dev\"", "string \"dev\""),
            ("true", "boolean `true`"),
            ("[]", "sequence"),
            (" \r\n[\"dev\"]", "sequence"),
        ] {
            let err = malformed(text.as_bytes());
            assert!(
                err.to_string()
                    .starts_with(&format!("invalid type: {kind}, expected JSON 对象")),
                "{text}：{err}"
            );
        }
    }

    /// 三个值按字段顺序排成数组，类型也都对得上，仍是形状不对：引导程序只写对象。
    #[test]
    fn an_array_in_field_order_is_malformed() {
        for text in [
            r#"["beta","1.0.0-beta.5",0]"#,
            r#"["dev","1.0.0-dev.60",1794000000]"#,
            r#"["stable","1.0.0",18446744073709551615]"#,
            r#"["beta","1.0.0-beta.5",0,"extra"]"#,
            r#"[{"channel":"beta","version":"1.0.0-beta.5","written_at":0}]"#,
        ] {
            let err = malformed(text.as_bytes());
            assert!(
                err.to_string()
                    .starts_with("invalid type: sequence, expected JSON 对象"),
                "{text}：{err}"
            );
        }
    }

    /// 对象之后还有别的内容，整份不算一份记录。
    #[test]
    fn content_after_the_object_is_malformed() {
        for text in [
            r#"{"channel":"beta","version":"1.0.0-beta.5","written_at":0} x"#,
            r#"{"channel":"beta","version":"1.0.0-beta.5","written_at":0}{}"#,
            r#"{"channel":"beta","version":"1.0.0-beta.5","written_at":0}[]"#,
        ] {
            let err = malformed(text.as_bytes());
            assert!(
                err.to_string().starts_with("trailing characters"),
                "{text}：{err}"
            );
        }
    }

    #[test]
    fn a_missing_key_is_malformed_and_named() {
        for (text, key) in [
            (r#"{"version":"1.0.0-dev.1","written_at":1}"#, "channel"),
            (r#"{"channel":"dev","written_at":1}"#, "version"),
            (r#"{"channel":"dev","version":"1.0.0-dev.1"}"#, "written_at"),
            ("{}", "channel"),
        ] {
            let err = malformed(text.as_bytes());
            assert!(
                err.to_string()
                    .starts_with(&format!("missing field `{key}`")),
                "{err}"
            );
        }
    }

    #[test]
    fn a_repeated_key_is_malformed() {
        let err = malformed(
            br#"{"channel":"dev","channel":"beta","version":"1.0.0-dev.1","written_at":1}"#,
        );
        assert!(
            err.to_string().starts_with("duplicate field `channel`"),
            "{err}"
        );
    }

    /// 值的类型不对时整份读不懂：null 不当缺省，字符串里的数字不当时间，负数与小数也不收。
    #[test]
    fn wrongly_typed_values_are_malformed() {
        for text in [
            r#"{"channel":null,"version":"1.0.0-dev.1","written_at":1}"#,
            r#"{"channel":1,"version":"1.0.0-dev.1","written_at":1}"#,
            r#"{"channel":"dev","version":null,"written_at":1}"#,
            r#"{"channel":"dev","version":100,"written_at":1}"#,
            r#"{"channel":"dev","version":"1.0.0-dev.1","written_at":null}"#,
            r#"{"channel":"dev","version":"1.0.0-dev.1","written_at":"1794000000"}"#,
            r#"{"channel":"dev","version":"1.0.0-dev.1","written_at":-1}"#,
            r#"{"channel":"dev","version":"1.0.0-dev.1","written_at":1.5}"#,
            r#"{"channel":"dev","version":"1.0.0-dev.1","written_at":18446744073709551616}"#,
        ] {
            malformed(text.as_bytes());
        }
    }

    /// 通道名只认程序写出的三个小写名，大小写不同、旧叫法、空串都不猜。
    #[test]
    fn an_unknown_channel_name_is_reported_with_its_value() {
        for name in [
            "", "DEV", "Beta", "preview", "release", "nightly", "local", " dev",
        ] {
            let text = format!(r#"{{"channel":{name:?},"version":"1.0.0-dev.1","written_at":1}}"#);
            let err = ChannelHandoff::from_json(text.as_bytes()).expect_err(&text);
            let HandoffError::UnknownChannel(got) = &err else {
                panic!("{text} 应判为通道认不出，实际是 {err:?}");
            };
            assert_eq!(got, name);
            assert!(err.to_string().contains(&format!("{name:?}")), "{err}");
            assert!(err.source().is_none(), "{err}");
        }
    }

    #[test]
    fn an_invalid_version_is_reported_with_its_value() {
        for version in [
            "",
            "1.0",
            "v1.0.0",
            "1.0.0-dev.01",
            "1.0.0-",
            "latest",
            "1.0.0 ",
        ] {
            let text = format!(r#"{{"channel":"dev","version":{version:?},"written_at":1}}"#);
            let err = ChannelHandoff::from_json(text.as_bytes()).expect_err(&text);
            let HandoffError::InvalidVersion { text: got, source } = &err else {
                panic!("{text} 应判为版本号不合法，实际是 {err:?}");
            };
            assert_eq!(got, version);
            let reason = Version::parse(version).unwrap_err().to_string();
            assert_eq!(source.to_string(), reason);
            assert_eq!(
                err.source().map(ToString::to_string).as_deref(),
                Some(reason.as_str())
            );
            assert!(err.to_string().contains(&format!("{version:?}")), "{err}");
        }
    }
}
