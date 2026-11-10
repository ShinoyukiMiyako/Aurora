//! 清单头核验：不下载安装包，先确认清单说的版本确实由这个通道的钥签发过。
//!
//! 清单本身不签名，但清单里本平台条目的 `signature` 是安装包的 minisign 签名。签名里有一段「全局签名」，
//! 盖住 64 字节的文件签名与可信注释（trusted comment），只凭公钥就能验，用不着安装包；tauri 签名时把版本号
//! 写进可信注释。所以每次取到清单都能当场确认「清单说的这一版确实由这把钥签过」：伪造的高版本号进不了界面，
//! 也记不进见过的版本。核验分两步，任何一步不过，这个端点就算没给出可信的清单：
//!
//! - 形状：清单版本按通道规则判出的通道必须就是所问的通道。别的通道的合法包放进这份清单（测试版与正式版
//!   共用一把钥，单靠签名分不出来）也认不得。
//! - 签名：签名串不超过长度上限（[`MAX_SIGNATURE_LEN`]），签名行的密钥号等于这个通道公钥的密钥号，全局签名
//!   验得过，验过之后可信注释里恰好一个 `version` 字段，且等于清单版本。
//!
//! config.json 里记下的见过的最高版本，读的时候逐项按同样两步重验：本机程序只能把记录删掉或改低，改不高。
//!
//! 公钥文本与签名串都是两层 base64：外层是 tauri 的格式，把整个 `.pub` / `.sig` 文本再编一次；里面的公钥行、
//! 签名行、全局签名行又各是一段 base64，是 minisign 的格式。解析规则照更新插件验签所用的 minisign-verify，
//! 这里放过的签名串，插件下载后验签时同样认。
//!
//! 全是纯函数：公钥文本、签名串、版本与所问的通道都由调用方传入，这里不发请求、不读配置。

use std::fmt;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use petalfall_core::release::order::Channel;
use ring::signature::{UnparsedPublicKey, ED25519};
use semver::Version;
use serde_json::{Map, Value};

/// 签名串第 3 行的前缀。全局签名盖的是去掉它之后的文本，带着前缀去验永远不过。
const TRUSTED_COMMENT_PREFIX: &str = "trusted comment: ";

/// minisign 的两种算法标记：`Ed` 直接签文件，`ED` 先对文件做 BLAKE2b-512 再签。两者只在文件签名上有差别，
/// 全局签名都盖「文件签名加可信注释」，所以这里两种都认；更新插件下载后验签也两种都认。
const ALGORITHMS: [[u8; 2]; 2] = [*b"Ed", *b"ED"];

/// 公钥行：算法标记 2 字节、密钥号 8 字节、Ed25519 公钥 32 字节。
const PUBLIC_KEY_LEN: usize = 42;
/// 签名行：算法标记 2 字节、密钥号 8 字节、文件签名 64 字节。
const SIGNATURE_LINE_LEN: usize = 74;
/// 全局签名行与文件签名都是 64 字节的 Ed25519 签名。
const ED25519_SIGNATURE_LEN: usize = 64;

/// 签名串（清单里 `signature` 的原样内容）最多多少字节。
///
/// 第 1 行的不可信注释与第 4 行之后的内容都不受签名保护：控制清单端点的人拿一份合法清单往里填几 MB，核验照样
/// 通过，这串内容却要原样记进 config.json 的见过的版本，之后每次读写配置都带着它，启动器越来越慢。tauri 签出的
/// 签名串约 450 字节（外层 base64 包着不可信注释、签名行、带时间戳文件名与版本号的可信注释、全局签名四行），
/// 版本号三段与序号全取 u64 上限也不到 700 字节；取 4 KiB 留足余量，又远小于值得拿来填充的大小。
const MAX_SIGNATURE_LEN: usize = 4096;

/// 可信注释里版本字段的前缀。tauri 把可信注释写成 tab 分隔的 `键:值`。
const VERSION_FIELD_PREFIX: &str = "version:";

/// 见过的版本里每一项的两个字段名，写入一方必须用同样的名字。
const SEEN_VERSION_FIELD: &str = "version";
const SEEN_SIGNATURE_FIELD: &str = "signature";

/// minisign 的密钥号：公钥行与签名行里算法标记之后的 8 个字节。
///
/// 显示成按字节顺序的小写十六进制，与 CI 脚本打印、契约测试钉住的写法相同；`.pub` 文件里不可信注释写的是
/// 倒过来的大写形式，不要拿它比。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct KeyId([u8; 8]);

impl fmt::Display for KeyId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.iter().try_for_each(|byte| write!(f, "{byte:02x}"))
    }
}

/// 公钥文本或签名串在验签之前就解不开：格式层面的毛病。行号从 1 数。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum MalformedText {
    /// 整段不是标准 base64（带填充）。
    NotBase64(base64::DecodeError),
    /// 外层解出来的字节不是 UTF-8。
    NotUtf8,
    /// 行数不够：公钥要 2 行，签名串要 4 行。
    TooFewLines { expected: usize, found: usize },
    /// 这一行不是标准 base64。
    LineNotBase64 {
        line: usize,
        source: base64::DecodeError,
    },
    /// 这一行解出的字节数不对。
    LineLength {
        line: usize,
        expected: usize,
        found: usize,
    },
    /// 这一行没有约定的前缀。
    LinePrefix { line: usize, expected: &'static str },
    /// 算法标记既不是 `Ed` 也不是 `ED`。
    UnsupportedAlgorithm([u8; 2]),
}

impl fmt::Display for MalformedText {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotBase64(err) => write!(f, "不是标准 base64：{err}"),
            Self::NotUtf8 => f.write_str("解出来的内容不是 UTF-8"),
            Self::TooFewLines { expected, found } => {
                write!(f, "应至少有 {expected} 行，只有 {found} 行")
            }
            Self::LineNotBase64 { line, source } => {
                write!(f, "第 {line} 行不是标准 base64：{source}")
            }
            Self::LineLength {
                line,
                expected,
                found,
            } => write!(f, "第 {line} 行解出 {found} 字节，应为 {expected} 字节"),
            Self::LinePrefix { line, expected } => {
                write!(f, "第 {line} 行不以「{expected}」开头")
            }
            Self::UnsupportedAlgorithm(algorithm) => write!(
                f,
                "算法标记是 {}，既不是 Ed 也不是 ED",
                algorithm.escape_ascii()
            ),
        }
    }
}

/// 清单头没通过核验的原因。每一种都说明这个端点没给出可信的清单。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum HeadError {
    /// 形状：清单版本按通道规则判出的通道不是所问的通道。`found` 为 `None` 是认不出通道的预发布标识
    /// （rc、alpha 之类）。
    WrongChannel {
        version: Version,
        asked: Channel,
        found: Option<Channel>,
    },
    /// 通道公钥的文本解不开。公钥编在程序里，出现这一种说明钥表本身坏了，换个端点也一样。
    PublicKey(MalformedText),
    /// 签名串超过长度上限（[`MAX_SIGNATURE_LEN`]），多半被填充过：不解，不记。
    SignatureTooLong { found: usize, limit: usize },
    /// 清单里的签名串解不开。
    Signature(MalformedText),
    /// 签名行的密钥号不是这个通道公钥的：别的钥签的包，例如预览版的包放进了测试版的清单。
    KeyIdMismatch { signed: KeyId, expected: KeyId },
    /// 全局签名验不过：可信注释或文件签名被改过，或者签名用的私钥不是这把公钥那一把（密钥号可以照抄）。
    GlobalSignatureInvalid,
    /// 可信注释里的 `version` 字段不是恰好一个。插件遇到重复的只认第一个，别处可能认别的，所以只收恰好一个。
    VersionFieldCount { found: usize },
    /// 签名里的版本与清单版本不同：例如把旧版本的合法包配上新版本号。
    VersionMismatch { signed: String, manifest: Version },
}

impl fmt::Display for HeadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::WrongChannel {
                version,
                asked,
                found: Some(found),
            } => write!(
                f,
                "清单版本 {version} 属于 {} 通道，不是所问的 {}",
                found.as_str(),
                asked.as_str()
            ),
            Self::WrongChannel {
                version,
                asked,
                found: None,
            } => write!(
                f,
                "清单版本 {version} 认不出通道，所问的是 {}",
                asked.as_str()
            ),
            Self::PublicKey(err) => write!(f, "通道公钥解不开：{err}"),
            Self::SignatureTooLong { found, limit } => {
                write!(f, "签名串有 {found} 字节，超过上限 {limit} 字节")
            }
            Self::Signature(err) => write!(f, "签名串解不开：{err}"),
            Self::KeyIdMismatch { signed, expected } => {
                write!(f, "签名的密钥号是 {signed}，通道公钥的是 {expected}")
            }
            Self::GlobalSignatureInvalid => f.write_str("全局签名验证失败"),
            Self::VersionFieldCount { found } => {
                write!(f, "可信注释里应有恰好一个 version 字段，实际有 {found} 个")
            }
            Self::VersionMismatch { signed, manifest } => {
                write!(f, "签名里的版本是 {signed}，清单写的是 {manifest}")
            }
        }
    }
}

/// 通过核验的清单头：这一版确实由这个通道的钥签过，形状也属于这个通道。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct VerifiedHead {
    pub channel: Channel,
    pub version: Version,
    /// 清单里原样的签名串。记进见过的版本时连它一起存，读的时候拿它重验。
    pub signature: String,
}

/// 核验一个通道的清单头：先看形状，再看签名，任何一步不过就交回原因。
///
/// `public_key` 是这个通道那把公钥的文本，即 `.pub` 文件内容去掉首尾空白，与交给更新插件的那一份相同。
/// `signature` 是清单里本平台条目 `signature` 的原样内容，这里不做任何修剪：插件下载后验签时也是原样解码，
/// 修剪过才放行的签名串，到插件那里还是通不过。
pub(crate) fn verify_head(
    channel: Channel,
    version: &Version,
    signature: &str,
    public_key: &str,
) -> Result<VerifiedHead, HeadError> {
    check_shape(channel, version)?;
    check_signature(version, signature, public_key)?;
    Ok(VerifiedHead {
        channel,
        version: version.clone(),
        signature: signature.to_owned(),
    })
}

/// 公钥文本的密钥号。
#[cfg(test)]
pub(crate) fn public_key_id(public_key: &str) -> Result<KeyId, MalformedText> {
    decode_public_key(public_key).map(|key| key.id)
}

fn check_shape(channel: Channel, version: &Version) -> Result<(), HeadError> {
    let found = Channel::of_version(version);
    if found == Some(channel) {
        Ok(())
    } else {
        Err(HeadError::WrongChannel {
            version: version.clone(),
            asked: channel,
            found,
        })
    }
}

fn check_signature(version: &Version, signature: &str, public_key: &str) -> Result<(), HeadError> {
    if signature.len() > MAX_SIGNATURE_LEN {
        return Err(HeadError::SignatureTooLong {
            found: signature.len(),
            limit: MAX_SIGNATURE_LEN,
        });
    }
    let key = decode_public_key(public_key).map_err(HeadError::PublicKey)?;
    let signature = decode_signature(signature).map_err(HeadError::Signature)?;
    if signature.key_id != key.id {
        return Err(HeadError::KeyIdMismatch {
            signed: signature.key_id,
            expected: key.id,
        });
    }
    let comment = signature.trusted_comment.as_bytes();
    let mut message = Vec::with_capacity(ED25519_SIGNATURE_LEN + comment.len());
    message.extend_from_slice(&signature.file_signature);
    message.extend_from_slice(comment);
    // ring 的验签错误不带任何信息，验不过就只有这一个原因。
    UnparsedPublicKey::new(&ED25519, key.key)
        .verify(&message, &signature.global_signature)
        .map_err(|_| HeadError::GlobalSignatureInvalid)?;
    // 全局签名验过之后可信注释才可信，版本只能在这之后读。
    let signed = only_version_field(&signature.trusted_comment)?;
    if signed_version_matches(signed, version) {
        Ok(())
    } else {
        Err(HeadError::VersionMismatch {
            signed: signed.to_owned(),
            manifest: version.clone(),
        })
    }
}

fn only_version_field(trusted_comment: &str) -> Result<&str, HeadError> {
    let values: Vec<&str> = trusted_comment
        .split('\t')
        .filter_map(|field| field.strip_prefix(VERSION_FIELD_PREFIX))
        .collect();
    match values.as_slice() {
        [only] => Ok(*only),
        _ => Err(HeadError::VersionFieldCount {
            found: values.len(),
        }),
    }
}

/// 照插件的比法：去掉开头的 `v` 按 semver 解析，要求完全相等，构建元数据也算。按优先级比会放过只差
/// 构建元数据的一对，这一版到下载验签时又会被插件拒掉。
fn signed_version_matches(signed: &str, manifest: &Version) -> bool {
    Version::parse(signed.trim_start_matches('v')).is_ok_and(|signed| signed == *manifest)
}

struct PublicKey {
    id: KeyId,
    key: [u8; 32],
}

struct DecodedSignature {
    key_id: KeyId,
    file_signature: [u8; ED25519_SIGNATURE_LEN],
    /// 去掉前缀之后的可信注释。
    trusted_comment: String,
    global_signature: [u8; ED25519_SIGNATURE_LEN],
}

fn decode_public_key(text: &str) -> Result<PublicKey, MalformedText> {
    let text = unwrap_outer(text)?;
    let lines = take_lines(&text, 2)?;
    let bytes: [u8; PUBLIC_KEY_LEN] = decode_line(lines[1], 2)?;
    check_algorithm([bytes[0], bytes[1]])?;
    let mut id = [0; 8];
    id.copy_from_slice(&bytes[2..10]);
    let mut key = [0; 32];
    key.copy_from_slice(&bytes[10..]);
    Ok(PublicKey { id: KeyId(id), key })
}

/// 第 1 行是不可信注释，不读；第 2 行是签名行；第 3 行是可信注释；第 4 行是全局签名。
fn decode_signature(text: &str) -> Result<DecodedSignature, MalformedText> {
    let text = unwrap_outer(text)?;
    let lines = take_lines(&text, 4)?;
    let bytes: [u8; SIGNATURE_LINE_LEN] = decode_line(lines[1], 2)?;
    check_algorithm([bytes[0], bytes[1]])?;
    let trusted_comment =
        lines[2]
            .strip_prefix(TRUSTED_COMMENT_PREFIX)
            .ok_or(MalformedText::LinePrefix {
                line: 3,
                expected: TRUSTED_COMMENT_PREFIX,
            })?;
    let global_signature: [u8; ED25519_SIGNATURE_LEN] = decode_line(lines[3], 4)?;
    let mut key_id = [0; 8];
    key_id.copy_from_slice(&bytes[2..10]);
    let mut file_signature = [0; ED25519_SIGNATURE_LEN];
    file_signature.copy_from_slice(&bytes[10..]);
    Ok(DecodedSignature {
        key_id: KeyId(key_id),
        file_signature,
        trusted_comment: trusted_comment.to_owned(),
        global_signature,
    })
}

/// 外层：整个 `.pub` / `.sig` 文本的 base64。插件解它用的也是带填充的标准字母表。
fn unwrap_outer(text: &str) -> Result<String, MalformedText> {
    let bytes = STANDARD.decode(text).map_err(MalformedText::NotBase64)?;
    String::from_utf8(bytes).map_err(|_| MalformedText::NotUtf8)
}

/// 按 `str::lines` 分行，与 minisign-verify 一致：`\n` 与 `\r\n` 都算换行，多出来的行不管。
fn take_lines(text: &str, expected: usize) -> Result<Vec<&str>, MalformedText> {
    let lines: Vec<&str> = text.lines().collect();
    if lines.len() < expected {
        return Err(MalformedText::TooFewLines {
            expected,
            found: lines.len(),
        });
    }
    Ok(lines)
}

/// 内层：第 `line` 行本身又是一段 base64，解出来必须正好 `N` 字节。minisign-verify 解这几行同样要求
/// 带填充、末尾不留多余的位，与这里用的标准引擎一样严。
fn decode_line<const N: usize>(text: &str, line: usize) -> Result<[u8; N], MalformedText> {
    let bytes = STANDARD
        .decode(text)
        .map_err(|source| MalformedText::LineNotBase64 { line, source })?;
    <[u8; N]>::try_from(bytes).map_err(|bytes| MalformedText::LineLength {
        line,
        expected: N,
        found: bytes.len(),
    })
}

fn check_algorithm(algorithm: [u8; 2]) -> Result<(), MalformedText> {
    if ALGORITHMS.contains(&algorithm) {
        Ok(())
    } else {
        Err(MalformedText::UnsupportedAlgorithm(algorithm))
    }
}

/// 见过的版本里一项作废的原因。这一项当作这个通道没有记录，下次写入时覆盖。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SeenEntryError {
    /// 这一项不是对象。`found` 是实际的 JSON 类型。
    NotAnObject { found: &'static str },
    /// 缺少这个字段。
    MissingField(&'static str),
    /// 这个字段不是字符串。
    FieldNotString {
        field: &'static str,
        found: &'static str,
    },
    /// `version` 不是合法的版本号。记录由程序按 semver 写出，不带 `v` 前缀，这里不放宽。
    BadVersion { version: String, reason: String },
    /// 记下的版本与签名重验不过。
    Head(HeadError),
}

impl fmt::Display for SeenEntryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotAnObject { found } => write!(f, "这一项应为对象，实际是{found}"),
            Self::MissingField(field) => write!(f, "缺少 {field} 字段"),
            Self::FieldNotString { field, found } => {
                write!(f, "{field} 应为字符串，实际是{found}")
            }
            Self::BadVersion { version, reason } => {
                write!(f, "version 不是合法版本号 {version}：{reason}")
            }
            Self::Head(err) => write!(f, "重验不过：{err}"),
        }
    }
}

/// 解析并重验见过的版本里一个通道的一项：`{"version": ..., "signature": ...}`，多出来的字段不管。
///
/// `raw` 是配置里按原样存的 JSON 值，`public_key` 同 [`verify_head`]。
pub(crate) fn read_seen_entry(
    channel: Channel,
    raw: &Value,
    public_key: &str,
) -> Result<VerifiedHead, SeenEntryError> {
    let entry = raw.as_object().ok_or(SeenEntryError::NotAnObject {
        found: json_kind(raw),
    })?;
    let version_text = string_field(entry, SEEN_VERSION_FIELD)?;
    let signature = string_field(entry, SEEN_SIGNATURE_FIELD)?;
    let version = Version::parse(version_text).map_err(|err| SeenEntryError::BadVersion {
        version: version_text.to_owned(),
        reason: err.to_string(),
    })?;
    verify_head(channel, &version, signature, public_key).map_err(SeenEntryError::Head)
}

fn string_field<'a>(
    entry: &'a Map<String, Value>,
    field: &'static str,
) -> Result<&'a str, SeenEntryError> {
    let value = entry
        .get(field)
        .ok_or(SeenEntryError::MissingField(field))?;
    value.as_str().ok_or(SeenEntryError::FieldNotString {
        field,
        found: json_kind(value),
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    use base64::DecodeError;
    use serde_json::json;
    use Channel::{Beta, Dev, Stable};

    // 签名夹具：三把一次性 Ed25519 测试钥，离线按 tauri signer 的格式拼出 `.pub` 与 `.sig`，外层再包一层
    // base64，与仓库里的 `.pub` 文件、清单里的 `signature` 字段同形。私钥只在生成时留在内存里，没有落盘，
    // 这里只有公钥、被签内容与签名串。DEV_KEY 充当预览版的钥，RELEASE_KEY 充当测试版与正式版共用的钥；
    // 第三把钥只签了 IMPOSTOR，用不着它的公钥。

    struct Fixture {
        /// 可信注释，不含 `trusted comment: ` 前缀。
        comment: &'static str,
        /// 清单里 `signature` 字段的原样内容。
        signature: &'static str,
    }

    const DEV_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDk3REU3MDA5QThGM0FGNzEKUldSeHIvT29DWERlbDE4R1lXem5sRHRQUjJWN08vejFJWW5mb0JlMi9vMUt5dkNkM1FxTWpHdEMK";
    const DEV_KEY_ID: &str = "71aff3a80970de97";
    const RELEASE_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDY1ODU4QTgxRDRENUI1QTQKUldTa3RkWFVnWXFGWmV2bGNhTGVtaU9qSllwa0FwZ3RXNjlmSVZpQ09hSGNaQk5md05Wcmhza2kK";
    const RELEASE_KEY_ID: &str = "a4b5d5d4818a8565";
    /// 文件签名签的内容。全局签名不盖它，核验用不到；留着是为了拿插件自己的验签库把夹具整包验一遍。
    const PAYLOAD: &[u8] = b"petalfall update-head fixture payload";

    /// DEV_KEY 签的 1.0.0-dev.7，算法 ED。
    const DEV_7: Fixture = Fixture {
        comment: "timestamp:1762761600\tfile:Petalfall-Installer-1.0.0-dev.7-x64.exe\tversion:1.0.0-dev.7",
        signature: "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSeHIvT29DWERlbDF6S0xmazViOGtGVCtFTkxyYmF3ZndHTWNodS9mSTY5WG9yWGJnY3QwdjBVN3ZvNzVSQzExb1hKbGIvMUQyNnhYbDNEZW5GYy9VUHZ4ODdzYi9uaFFJPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzYyNzYxNjAwCWZpbGU6UGV0YWxmYWxsLUluc3RhbGxlci0xLjAuMC1kZXYuNy14NjQuZXhlCXZlcnNpb246MS4wLjAtZGV2LjcKcFNTKzFXZnhHQmh3NmlIdXRJbzdicEYwS294OURSZklrd01xbWZDbUVHb2FaV01VNWwxbEt2aHF1UGtoZEdtS3Z6dEttSDhvaU5QWWZtNkxwaE4xRGc9PQo=",
    };
    /// DEV_KEY 签的 1.0.0-dev.6，算法 Ed：直接签文件，不先做摘要。
    const DEV_6_LEGACY: Fixture = Fixture {
        comment: "timestamp:1762761600\tfile:Petalfall-Installer-1.0.0-dev.6-x64.exe\tversion:1.0.0-dev.6",
        signature: "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUldSeHIvT29DWERlbDdzRVYxaWUyNnRHcXhkZk16QVR6UHNGcFkwQnJjSmpGZHR1TXJZbVBGRGdnQXhuU3U0bHNYbHhxeUFFR0VoSFFFYnpVeWY4UktkVlBhdVJvaVoxQWdvPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzYyNzYxNjAwCWZpbGU6UGV0YWxmYWxsLUluc3RhbGxlci0xLjAuMC1kZXYuNi14NjQuZXhlCXZlcnNpb246MS4wLjAtZGV2LjYKaFBrcGlaNHhacEJ1cGUydysrZm5IWmRRNk5NQ2VKMVRwWlh1T1ZkTTU1REUyZ2ZzcU9hWlRhRmE2WFB0RnI4RFQrU3VMc24rVjRHc1FLck9zRlJKQkE9PQo=",
    };
    /// RELEASE_KEY 签的 1.0.0-beta.3。
    const BETA_3: Fixture = Fixture {
        comment: "timestamp:1762761600\tfile:Petalfall-Installer-1.0.0-beta.3-x64.exe\tversion:1.0.0-beta.3",
        signature: "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTa3RkWFVnWXFGWllpUzVTeEppUmhGRXVIQ0JnZjdGUFF4R0xVZkNFU0pmRGFPUDB6ZXVNWVRSdVRIaUNoamhQME1LcytvM3Zwalc4SERBalY0YlhKUUd6RzFPOWxBc0FrPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzYyNzYxNjAwCWZpbGU6UGV0YWxmYWxsLUluc3RhbGxlci0xLjAuMC1iZXRhLjMteDY0LmV4ZQl2ZXJzaW9uOjEuMC4wLWJldGEuMwpKd2U3NzVoZXkwaHk4U05oMHpoNkcxaFYrcTlIYWJVcWxPTUV6YmR0L2JiWXpZM2djMG1PUFY2UjE5cmtIcUpxbWlBNkYzODJuMU5kYmxJSEdDeGxDUT09Cg==",
    };
    /// RELEASE_KEY 签的 1.0.0。
    const STABLE_1: Fixture = Fixture {
        comment: "timestamp:1762761600\tfile:Petalfall-Installer-1.0.0-x64.exe\tversion:1.0.0",
        signature: "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTa3RkWFVnWXFGWllpUzVTeEppUmhGRXVIQ0JnZjdGUFF4R0xVZkNFU0pmRGFPUDB6ZXVNWVRSdVRIaUNoamhQME1LcytvM3Zwalc4SERBalY0YlhKUUd6RzFPOWxBc0FrPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzYyNzYxNjAwCWZpbGU6UGV0YWxmYWxsLUluc3RhbGxlci0xLjAuMC14NjQuZXhlCXZlcnNpb246MS4wLjAKdXEwZXJsbzdJTkFaejVZSERRZ0I0UkhONnpIeEFPQmFUOTRwejJUZVpzaWRZVURYU2JLcXRTSm8rMFgxaENyWGJOcFlJcnFHZzdUaGsvQW1qTTJFQUE9PQo=",
    };
    /// DEV_KEY 签的，可信注释里没有 version 字段。
    const NO_VERSION: Fixture = Fixture {
        comment: "timestamp:1762761600\tfile:Petalfall-Installer-1.0.0-dev.7-x64.exe",
        signature: "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSeHIvT29DWERlbDF6S0xmazViOGtGVCtFTkxyYmF3ZndHTWNodS9mSTY5WG9yWGJnY3QwdjBVN3ZvNzVSQzExb1hKbGIvMUQyNnhYbDNEZW5GYy9VUHZ4ODdzYi9uaFFJPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzYyNzYxNjAwCWZpbGU6UGV0YWxmYWxsLUluc3RhbGxlci0xLjAuMC1kZXYuNy14NjQuZXhlCkZHMXY0V3B2bXc4dXlXTGd2Qm1xd3BWMHVDYWt3b0hzaXRqS21yNUxCQ3I2V1A0d3hLZ0wrRkVzZ0JJb0VEUlVsVFVCZmIzaUE3SHgzdDdZQytVTENRPT0K",
    };
    /// DEV_KEY 签的，可信注释里有两个 version 字段。
    const TWO_VERSIONS: Fixture = Fixture {
        comment: "timestamp:1762761600\tfile:Petalfall-Installer-1.0.0-dev.7-x64.exe\tversion:1.0.0-dev.7\tversion:9.9.9-dev.1",
        signature: "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSeHIvT29DWERlbDF6S0xmazViOGtGVCtFTkxyYmF3ZndHTWNodS9mSTY5WG9yWGJnY3QwdjBVN3ZvNzVSQzExb1hKbGIvMUQyNnhYbDNEZW5GYy9VUHZ4ODdzYi9uaFFJPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzYyNzYxNjAwCWZpbGU6UGV0YWxmYWxsLUluc3RhbGxlci0xLjAuMC1kZXYuNy14NjQuZXhlCXZlcnNpb246MS4wLjAtZGV2LjcJdmVyc2lvbjo5LjkuOS1kZXYuMQoyODUzWDMvUzNWbGVvREFpUUtIK2ovUmhoVzhkdCttZzFwdUhRQVYrczNyVUZ4blBuRXpHT09ZQ2Y0TVozTW9XNTZmby9aMldvM1VkaXFodXZSZFpDUT09Cg==",
    };
    /// DEV_KEY 签的，版本写成 v1.0.0-dev.7。
    const V_PREFIX: Fixture = Fixture {
        comment: "timestamp:1762761600\tfile:Petalfall-Installer-1.0.0-dev.7-x64.exe\tversion:v1.0.0-dev.7",
        signature: "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSeHIvT29DWERlbDF6S0xmazViOGtGVCtFTkxyYmF3ZndHTWNodS9mSTY5WG9yWGJnY3QwdjBVN3ZvNzVSQzExb1hKbGIvMUQyNnhYbDNEZW5GYy9VUHZ4ODdzYi9uaFFJPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzYyNzYxNjAwCWZpbGU6UGV0YWxmYWxsLUluc3RhbGxlci0xLjAuMC1kZXYuNy14NjQuZXhlCXZlcnNpb246djEuMC4wLWRldi43ClRqMzV6SXk3SWFCR0FyTnpDa1FIaXNrVzhjMW9qbTljTVo5eUd2TWRjbUxsS2N3NXdUNHBxcWZBZVUzbjNVRlpvWURBS0xTK1NDTHcyUHhPT09qdUNRPT0K",
    };
    /// DEV_KEY 签的，版本带构建元数据：1.0.0-dev.7+ci.42。
    const BUILD_META: Fixture = Fixture {
        comment: "timestamp:1762761600\tfile:Petalfall-Installer-1.0.0-dev.7-x64.exe\tversion:1.0.0-dev.7+ci.42",
        signature: "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSeHIvT29DWERlbDF6S0xmazViOGtGVCtFTkxyYmF3ZndHTWNodS9mSTY5WG9yWGJnY3QwdjBVN3ZvNzVSQzExb1hKbGIvMUQyNnhYbDNEZW5GYy9VUHZ4ODdzYi9uaFFJPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzYyNzYxNjAwCWZpbGU6UGV0YWxmYWxsLUluc3RhbGxlci0xLjAuMC1kZXYuNy14NjQuZXhlCXZlcnNpb246MS4wLjAtZGV2LjcrY2kuNDIKR1BXc3RGNjl0QlZtSzFzSGVDRm5JL21ld3ptcVVVdndZOUtER0JtRHMxZFBzN3IrR0xKUmd4RTF2MXUvUktTV29WNk1aOGNZc3lqYktzcHdjUE5jRGc9PQo=",
    };
    /// 第三把钥签的 9.9.9-dev.1，签名行里照抄了 DEV_KEY 的密钥号：没有私钥的人伪造高版本时只能做到这一步。
    const IMPOSTOR: Fixture = Fixture {
        comment: "timestamp:1762761600\tfile:Petalfall-Installer-9.9.9-dev.1-x64.exe\tversion:9.9.9-dev.1",
        signature: "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSeHIvT29DWERlbCtiN1IxY2ZxZS9wT0JPbXZ1clBKWG5VeERoK29STHVQODBVa0RPM01lbnAySUY4MmJtZkJza0VEWHhUQVJkK1N0SG14dUkyNE8xWktWa0gwcjRMdEFBPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzYyNzYxNjAwCWZpbGU6UGV0YWxmYWxsLUluc3RhbGxlci05LjkuOS1kZXYuMS14NjQuZXhlCXZlcnNpb246OS45LjktZGV2LjEKUEw5d3N4eXMwYUpBNUVHNTUxdkdIZVM4ZlRBYUtTYXN4eFFYUTUrNjRVb2YxZkxrc29DYjhiL2pCYm1jaHY0ZWQ3OGM2aVhDNDJVcXFiWXQ4TTdJQ1E9PQo=",
    };

    fn version(text: &str) -> Version {
        Version::parse(text).unwrap_or_else(|err| panic!("{text} 不是合法版本号：{err}"))
    }

    /// 仓库钥表的形状：预览版一把，测试版与正式版共用一把。
    fn key_of(channel: Channel) -> &'static str {
        match channel {
            Dev => DEV_KEY,
            Beta | Stable => RELEASE_KEY,
        }
    }

    fn id_of(public_key: &str) -> KeyId {
        public_key_id(public_key).unwrap_or_else(|err| panic!("公钥解不开：{err}"))
    }

    fn head(channel: Channel, text: &str, signature: &str) -> VerifiedHead {
        VerifiedHead {
            channel,
            version: version(text),
            signature: signature.to_owned(),
        }
    }

    fn check(
        channel: Channel,
        text: &str,
        signature: &str,
        public_key: &str,
    ) -> Result<VerifiedHead, HeadError> {
        verify_head(channel, &version(text), signature, public_key)
    }

    fn malformed(err: MalformedText) -> Result<VerifiedHead, HeadError> {
        Err(HeadError::Signature(err))
    }

    /// 解开外层 base64，得到 `.sig` / `.pub` 的原文。
    fn unwrap(text: &str) -> String {
        let bytes = STANDARD
            .decode(text)
            .unwrap_or_else(|err| panic!("外层不是 base64：{err}"));
        String::from_utf8(bytes).unwrap_or_else(|err| panic!("外层解出的不是 UTF-8：{err}"))
    }

    /// 按行改写 `.sig` / `.pub` 原文再包回外层；每行以 `\n` 结尾，与夹具相同。
    fn edit_lines(text: &str, edit: impl FnOnce(&mut Vec<String>)) -> String {
        let mut lines: Vec<String> = unwrap(text).lines().map(str::to_owned).collect();
        edit(&mut lines);
        STANDARD.encode(
            lines
                .iter()
                .map(|line| format!("{line}\n"))
                .collect::<String>(),
        )
    }

    /// 改写第 `line` 行（从 1 数）base64 解出的字节，再编回去。
    fn edit_line_bytes(text: &str, line: usize, edit: impl FnOnce(&mut Vec<u8>)) -> String {
        edit_lines(text, |lines| {
            let mut bytes = STANDARD
                .decode(&lines[line - 1])
                .unwrap_or_else(|err| panic!("第 {line} 行不是 base64：{err}"));
            edit(&mut bytes);
            lines[line - 1] = STANDARD.encode(bytes);
        })
    }

    #[test]
    fn fixtures_are_signatures_the_updater_plugin_accepts() {
        let decode_key = |text: &str| {
            minisign_verify::PublicKey::decode(&unwrap(text))
                .unwrap_or_else(|err| panic!("插件解不开测试钥：{err}"))
        };
        let decode_signature = |fixture: &Fixture| {
            minisign_verify::Signature::decode(&unwrap(fixture.signature))
                .unwrap_or_else(|err| panic!("插件解不开 {}：{err}", fixture.comment))
        };
        let (dev, release) = (decode_key(DEV_KEY), decode_key(RELEASE_KEY));
        let signed = [
            (&dev, &DEV_7),
            (&dev, &DEV_6_LEGACY),
            (&release, &BETA_3),
            (&release, &STABLE_1),
            (&dev, &NO_VERSION),
            (&dev, &TWO_VERSIONS),
            (&dev, &V_PREFIX),
            (&dev, &BUILD_META),
        ];
        for (key, fixture) in signed {
            let signature = decode_signature(fixture);
            assert_eq!(signature.trusted_comment(), fixture.comment);
            key.verify(PAYLOAD, &signature, true)
                .unwrap_or_else(|err| panic!("插件验不过 {}：{err}", fixture.comment));
        }
        let impostor = decode_signature(&IMPOSTOR);
        assert_eq!(impostor.trusted_comment(), IMPOSTOR.comment);
        assert!(matches!(
            dev.verify(PAYLOAD, &impostor, true),
            Err(minisign_verify::Error::InvalidSignature)
        ));
    }

    #[test]
    fn key_ids_of_the_shipped_and_test_public_keys() {
        // 钥表交来的是去掉首尾空白的文件内容。
        let dev = include_str!("../../../../.github/dev-updater.pub").trim();
        let release = include_str!("../../../../.github/release-updater.pub").trim();
        assert_eq!(id_of(dev).to_string(), "a85c28a4343f0962");
        assert_eq!(id_of(release).to_string(), "aeeab33bdc36d624");
        assert_eq!(id_of(DEV_KEY).to_string(), DEV_KEY_ID);
        assert_eq!(id_of(RELEASE_KEY).to_string(), RELEASE_KEY_ID);
    }

    #[test]
    fn heads_signed_with_their_channel_key_pass() {
        let cases = [
            (Dev, "1.0.0-dev.7", &DEV_7),
            (Dev, "1.0.0-dev.6", &DEV_6_LEGACY),
            (Beta, "1.0.0-beta.3", &BETA_3),
            (Stable, "1.0.0", &STABLE_1),
        ];
        for (channel, text, fixture) in cases {
            assert_eq!(
                check(channel, text, fixture.signature, key_of(channel)),
                Ok(head(channel, text, fixture.signature)),
                "{text}"
            );
        }
        // 原文换成 \r\n 换行照样认：minisign-verify 按 str::lines 分行，插件也认。
        let crlf = STANDARD.encode(unwrap(DEV_7.signature).replace('\n', "\r\n"));
        assert_eq!(
            check(Dev, "1.0.0-dev.7", &crlf, DEV_KEY),
            Ok(head(Dev, "1.0.0-dev.7", &crlf))
        );
    }

    #[test]
    fn signed_version_is_compared_the_way_the_plugin_compares_it() {
        assert_eq!(
            check(Dev, "1.0.0-dev.7", V_PREFIX.signature, DEV_KEY),
            Ok(head(Dev, "1.0.0-dev.7", V_PREFIX.signature))
        );
        assert_eq!(
            check(Dev, "1.0.0-dev.7", BUILD_META.signature, DEV_KEY),
            Err(HeadError::VersionMismatch {
                signed: "1.0.0-dev.7+ci.42".to_owned(),
                manifest: version("1.0.0-dev.7"),
            })
        );
        assert_eq!(
            check(Dev, "1.0.0-dev.7+ci.42", BUILD_META.signature, DEV_KEY),
            Ok(head(Dev, "1.0.0-dev.7+ci.42", BUILD_META.signature))
        );
    }

    #[test]
    fn shape_takes_only_versions_of_the_asked_channel() {
        let mut cases: Vec<(String, Option<Channel>)> = Vec::new();
        // 序号含边界：0、1、2^53+1（JS 从这里起分不清相邻整数）、u64 的上限。
        for seq in [0u64, 1, 2, 10, (1 << 53) + 1, u64::MAX] {
            cases.push((format!("1.0.0-dev.{seq}"), Some(Dev)));
            cases.push((format!("2.3.0-beta.{seq}"), Some(Beta)));
        }
        let fixed = [
            ("1.0.0", Some(Stable)),
            ("0.1.0", Some(Stable)),
            ("1.0.5", Some(Stable)),
            ("1.0.0+ci.3", Some(Stable)),
            ("1.0.0-rc.1", None),
            ("1.0.0-alpha.2", None),
            ("1.0.0-dev-1", None),
        ];
        cases.extend(fixed.map(|(text, channel)| (text.to_owned(), channel)));
        for (text, belongs) in cases {
            let parsed = version(&text);
            for asked in [Dev, Beta, Stable] {
                let expected = if belongs == Some(asked) {
                    Ok(())
                } else {
                    Err(HeadError::WrongChannel {
                        version: parsed.clone(),
                        asked,
                        found: belongs,
                    })
                };
                assert_eq!(
                    check_shape(asked, &parsed),
                    expected,
                    "{text} 问 {}",
                    asked.as_str()
                );
            }
        }
    }

    #[test]
    fn another_channels_package_is_refused_by_shape_even_when_its_signature_holds() {
        // 测试版与正式版共用一把钥，签名分不开这两个通道的包，只有形状分得开。
        assert_eq!(
            check(Stable, "1.0.0-beta.3", BETA_3.signature, RELEASE_KEY),
            Err(HeadError::WrongChannel {
                version: version("1.0.0-beta.3"),
                asked: Stable,
                found: Some(Beta),
            })
        );
        assert_eq!(
            check(Beta, "1.0.0", STABLE_1.signature, RELEASE_KEY),
            Err(HeadError::WrongChannel {
                version: version("1.0.0"),
                asked: Beta,
                found: Some(Stable),
            })
        );
        // 正式版端点上出现测试版形状的版本号：先判形状，签名串再坏也轮不到它。
        assert_eq!(
            check(Stable, "1.0.0-beta.9", "@@@@", RELEASE_KEY),
            Err(HeadError::WrongChannel {
                version: version("1.0.0-beta.9"),
                asked: Stable,
                found: Some(Beta),
            })
        );
    }

    #[test]
    fn signature_by_another_key_is_refused_by_key_id() {
        assert_eq!(
            check(Dev, "1.0.0-dev.7", DEV_7.signature, RELEASE_KEY),
            Err(HeadError::KeyIdMismatch {
                signed: id_of(DEV_KEY),
                expected: id_of(RELEASE_KEY),
            })
        );
        assert_eq!(
            check(Beta, "1.0.0-beta.3", BETA_3.signature, DEV_KEY),
            Err(HeadError::KeyIdMismatch {
                signed: id_of(RELEASE_KEY),
                expected: id_of(DEV_KEY),
            })
        );
        let flipped = edit_line_bytes(DEV_7.signature, 2, |bytes| bytes[9] ^= 0x01);
        let mut signed = id_of(DEV_KEY);
        signed.0[7] ^= 0x01;
        assert_eq!(
            check(Dev, "1.0.0-dev.7", &flipped, DEV_KEY),
            Err(HeadError::KeyIdMismatch {
                signed,
                expected: id_of(DEV_KEY),
            })
        );
    }

    #[test]
    fn copied_key_id_without_the_private_key_fails_the_global_signature() {
        assert_eq!(
            check(Dev, "9.9.9-dev.1", IMPOSTOR.signature, DEV_KEY),
            Err(HeadError::GlobalSignatureInvalid)
        );
    }

    #[test]
    fn edited_trusted_comment_fails_the_global_signature() {
        // 可信注释与清单都改成 dev.8，全局签名盖的仍是 dev.7。
        let raised = edit_lines(DEV_7.signature, |lines| {
            lines[2] = lines[2].replace("dev.7", "dev.8");
        });
        assert_eq!(
            check(Dev, "1.0.0-dev.8", &raised, DEV_KEY),
            Err(HeadError::GlobalSignatureInvalid)
        );
        let appended = edit_lines(DEV_7.signature, |lines| lines[2].push_str("\tchannel:dev"));
        assert_eq!(
            check(Dev, "1.0.0-dev.7", &appended, DEV_KEY),
            Err(HeadError::GlobalSignatureInvalid)
        );
    }

    #[test]
    fn any_edit_to_the_signed_bytes_fails_the_global_signature() {
        #[derive(Debug, Clone, Copy)]
        enum Edit {
            Comment(usize),
            FileSignature(usize),
            GlobalSignature(usize),
        }

        let comment_len = DEV_7.comment.len();
        let last = ED25519_SIGNATURE_LEN - 1;
        let mut rng = fastrand::Rng::with_seed(0x5eed_4ead);
        // 头尾两个位置必测，其余随机。
        let mut edits = vec![
            Edit::Comment(0),
            Edit::Comment(comment_len - 1),
            Edit::FileSignature(0),
            Edit::FileSignature(last),
            Edit::GlobalSignature(0),
            Edit::GlobalSignature(last),
        ];
        for _ in 0..300 {
            edits.push(match rng.u8(0..3) {
                0 => Edit::Comment(rng.usize(0..comment_len)),
                1 => Edit::FileSignature(rng.usize(0..ED25519_SIGNATURE_LEN)),
                _ => Edit::GlobalSignature(rng.usize(0..ED25519_SIGNATURE_LEN)),
            });
        }
        for edit in edits {
            let bit = 1u8 << rng.u8(0..8);
            let signature = match edit {
                Edit::Comment(at) => {
                    // 换成另一个可见的 ASCII 字符：不碰 tab 与换行，行结构不变，只有被签的字节变了。
                    let mut comment = DEV_7.comment.as_bytes().to_vec();
                    let original = comment[at];
                    comment[at] = loop {
                        let candidate = rng.u8(b'!'..=b'~');
                        if candidate != original {
                            break candidate;
                        }
                    };
                    let comment = String::from_utf8(comment).expect("可见 ASCII 一定是 UTF-8");
                    edit_lines(DEV_7.signature, |lines| {
                        lines[2] = format!("{TRUSTED_COMMENT_PREFIX}{comment}");
                    })
                }
                Edit::FileSignature(at) => {
                    edit_line_bytes(DEV_7.signature, 2, |bytes| bytes[10 + at] ^= bit)
                }
                Edit::GlobalSignature(at) => {
                    edit_line_bytes(DEV_7.signature, 4, |bytes| bytes[at] ^= bit)
                }
            };
            assert_eq!(
                check(Dev, "1.0.0-dev.7", &signature, DEV_KEY),
                Err(HeadError::GlobalSignatureInvalid),
                "{edit:?}"
            );
        }
    }

    #[test]
    fn trusted_comment_needs_exactly_one_version_field() {
        assert_eq!(
            check(Dev, "1.0.0-dev.7", NO_VERSION.signature, DEV_KEY),
            Err(HeadError::VersionFieldCount { found: 0 })
        );
        // 不管清单写的是两个里的哪一个都不收。
        for text in ["1.0.0-dev.7", "9.9.9-dev.1"] {
            assert_eq!(
                check(Dev, text, TWO_VERSIONS.signature, DEV_KEY),
                Err(HeadError::VersionFieldCount { found: 2 }),
                "{text}"
            );
        }
    }

    #[test]
    fn signed_version_must_equal_the_manifest_version() {
        // 旧版本的合法包配上更高或更低的版本号。
        for text in ["1.0.0-dev.8", "9.9.9-dev.1", "1.0.0-dev.6"] {
            assert_eq!(
                check(Dev, text, DEV_7.signature, DEV_KEY),
                Err(HeadError::VersionMismatch {
                    signed: "1.0.0-dev.7".to_owned(),
                    manifest: version(text),
                }),
                "{text}"
            );
        }
    }

    #[test]
    fn signature_text_that_is_not_base64_is_refused() {
        assert_eq!(
            check(Dev, "1.0.0-dev.7", "@@@@", DEV_KEY),
            malformed(MalformedText::NotBase64(DecodeError::InvalidByte(0, b'@')))
        );
        // 不修剪：插件原样解码，带着换行的签名串到插件那里同样通不过。
        let with_newline = format!("{}\n", DEV_7.signature);
        assert!(matches!(
            check(Dev, "1.0.0-dev.7", &with_newline, DEV_KEY),
            Err(HeadError::Signature(MalformedText::NotBase64(_)))
        ));
        assert_eq!(
            check(
                Dev,
                "1.0.0-dev.7",
                &STANDARD.encode([0xff, 0xfe, b'\n']),
                DEV_KEY
            ),
            malformed(MalformedText::NotUtf8)
        );
        for line in [2, 4] {
            let signature = edit_lines(DEV_7.signature, |lines| lines[line - 1] = "!".repeat(88));
            assert_eq!(
                check(Dev, "1.0.0-dev.7", &signature, DEV_KEY),
                malformed(MalformedText::LineNotBase64 {
                    line,
                    source: DecodeError::InvalidByte(0, b'!'),
                }),
                "第 {line} 行"
            );
        }
    }

    #[test]
    fn signature_text_with_too_few_lines_is_refused() {
        for keep in 0..4 {
            let signature = edit_lines(DEV_7.signature, |lines| lines.truncate(keep));
            assert_eq!(
                check(Dev, "1.0.0-dev.7", &signature, DEV_KEY),
                malformed(MalformedText::TooFewLines {
                    expected: 4,
                    found: keep,
                }),
                "留 {keep} 行"
            );
        }
    }

    /// 往第 1 行不可信注释后面补字符，把签名串填到外层正好 `len` 字节。外层 base64 每 3 字节编成 4 个字符，
    /// `len` 须是 4 的倍数。
    fn padded_to(signature: &str, len: usize) -> String {
        let fill = len / 4 * 3 - unwrap(signature).len();
        let padded = edit_lines(signature, |lines| lines[0].push_str(&"x".repeat(fill)));
        assert_eq!(padded.len(), len);
        padded
    }

    /// 签名串超过上限时不解、不验，按清单异常拒绝。第 1 行的不可信注释与第 4 行之后的内容都不受签名保护：填充过的
    /// 签名串插件照样解得开、验得过，不拦的话这串内容会原样记进见过的版本。记进配置里的超长串读回时同样作废那一项。
    /// 正好在上限上的照常通过。
    #[test]
    fn signature_text_longer_than_the_limit_is_refused() {
        let at_limit = padded_to(DEV_7.signature, MAX_SIGNATURE_LEN);
        assert_eq!(
            check(Dev, "1.0.0-dev.7", &at_limit, DEV_KEY),
            Ok(head(Dev, "1.0.0-dev.7", &at_limit))
        );

        let dev_key = minisign_verify::PublicKey::decode(&unwrap(DEV_KEY)).unwrap();
        let padded = padded_to(DEV_7.signature, MAX_SIGNATURE_LEN + 4);
        let appended = edit_lines(DEV_7.signature, |lines| {
            lines.extend(std::iter::repeat_n("x".repeat(100), 40));
        });
        for signature in [padded, appended] {
            let decoded = minisign_verify::Signature::decode(&unwrap(&signature))
                .unwrap_or_else(|err| panic!("插件解不开填充过的签名串：{err}"));
            dev_key
                .verify(PAYLOAD, &decoded, true)
                .unwrap_or_else(|err| panic!("插件验不过填充过的签名串：{err}"));
            let too_long = HeadError::SignatureTooLong {
                found: signature.len(),
                limit: MAX_SIGNATURE_LEN,
            };
            assert!(signature.len() > MAX_SIGNATURE_LEN);
            assert_eq!(
                check(Dev, "1.0.0-dev.7", &signature, DEV_KEY),
                Err(too_long.clone())
            );
            assert_eq!(
                read_seen_entry(Dev, &entry("1.0.0-dev.7", &signature), DEV_KEY),
                Err(SeenEntryError::Head(too_long))
            );
        }
        assert_eq!(
            HeadError::SignatureTooLong {
                found: 4100,
                limit: 4096
            }
            .to_string(),
            "签名串有 4100 字节，超过上限 4096 字节"
        );
    }

    #[test]
    fn algorithm_must_be_ed_or_prehashed_ed() {
        // 全局签名不盖算法标记，ED 改成 Ed 照样验得过；两种只在文件签名上有差别。
        let legacy = edit_line_bytes(DEV_7.signature, 2, |bytes| {
            bytes[..2].copy_from_slice(b"Ed");
        });
        assert_eq!(
            check(Dev, "1.0.0-dev.7", &legacy, DEV_KEY),
            Ok(head(Dev, "1.0.0-dev.7", &legacy))
        );
        for algorithm in [*b"ed", *b"EE", *b"Ex", [0, 0], [b'E', 0xff]] {
            let signature = edit_line_bytes(DEV_7.signature, 2, |bytes| {
                bytes[..2].copy_from_slice(&algorithm);
            });
            assert_eq!(
                check(Dev, "1.0.0-dev.7", &signature, DEV_KEY),
                malformed(MalformedText::UnsupportedAlgorithm(algorithm)),
                "{algorithm:?}"
            );
        }
    }

    #[test]
    fn lines_of_the_wrong_length_are_refused() {
        for len in [0, 1, 63, 65, 128] {
            let signature = edit_line_bytes(DEV_7.signature, 4, |bytes| bytes.resize(len, 0));
            assert_eq!(
                check(Dev, "1.0.0-dev.7", &signature, DEV_KEY),
                malformed(MalformedText::LineLength {
                    line: 4,
                    expected: 64,
                    found: len,
                }),
                "全局签名 {len} 字节"
            );
        }
        for len in [0, 73, 75] {
            let signature = edit_line_bytes(DEV_7.signature, 2, |bytes| bytes.resize(len, 0));
            assert_eq!(
                check(Dev, "1.0.0-dev.7", &signature, DEV_KEY),
                malformed(MalformedText::LineLength {
                    line: 2,
                    expected: 74,
                    found: len,
                }),
                "签名行 {len} 字节"
            );
        }
    }

    #[test]
    fn trusted_comment_line_needs_its_prefix() {
        let rewritten = [
            DEV_7.comment.to_owned(),
            format!("Trusted comment: {}", DEV_7.comment),
            format!("trusted comment:{}", DEV_7.comment),
        ];
        for line in rewritten {
            let signature = edit_lines(DEV_7.signature, |lines| lines[2] = line.clone());
            assert_eq!(
                check(Dev, "1.0.0-dev.7", &signature, DEV_KEY),
                malformed(MalformedText::LinePrefix {
                    line: 3,
                    expected: "trusted comment: ",
                }),
                "{line}"
            );
        }
    }

    #[test]
    fn broken_public_key_is_reported_as_the_keys_fault() {
        let cases = [
            (
                "@@@@".to_owned(),
                MalformedText::NotBase64(DecodeError::InvalidByte(0, b'@')),
            ),
            (
                String::new(),
                MalformedText::TooFewLines {
                    expected: 2,
                    found: 0,
                },
            ),
            (
                edit_lines(DEV_KEY, |lines| lines.truncate(1)),
                MalformedText::TooFewLines {
                    expected: 2,
                    found: 1,
                },
            ),
            (
                edit_line_bytes(DEV_KEY, 2, |bytes| {
                    bytes.pop();
                }),
                MalformedText::LineLength {
                    line: 2,
                    expected: 42,
                    found: 41,
                },
            ),
            (
                edit_line_bytes(DEV_KEY, 2, |bytes| bytes[..2].copy_from_slice(b"Ex")),
                MalformedText::UnsupportedAlgorithm(*b"Ex"),
            ),
        ];
        for (key, err) in cases {
            assert_eq!(public_key_id(&key), Err(err.clone()));
            assert_eq!(
                check(Dev, "1.0.0-dev.7", DEV_7.signature, &key),
                Err(HeadError::PublicKey(err))
            );
        }
        // 与插件所用的 minisign-verify 一样，公钥的算法标记 Ed、ED 都认。
        let prehashed = edit_line_bytes(DEV_KEY, 2, |bytes| bytes[..2].copy_from_slice(b"ED"));
        assert_eq!(public_key_id(&prehashed), Ok(id_of(DEV_KEY)));
    }

    fn entry(text: &str, signature: &str) -> Value {
        json!({ "version": text, "signature": signature })
    }

    #[test]
    fn seen_entries_that_recheck_are_read_back() {
        for (channel, text, signature) in [
            (Dev, "1.0.0-dev.7", DEV_7.signature),
            (Beta, "1.0.0-beta.3", BETA_3.signature),
            (Stable, "1.0.0", STABLE_1.signature),
        ] {
            assert_eq!(
                read_seen_entry(channel, &entry(text, signature), key_of(channel)),
                Ok(head(channel, text, signature))
            );
        }
        // 多出来的字段不管。
        let mut extra = entry("1.0.0-dev.7", DEV_7.signature);
        extra["seen_at"] = json!(1_762_761_600);
        assert_eq!(
            read_seen_entry(Dev, &extra, DEV_KEY),
            Ok(head(Dev, "1.0.0-dev.7", DEV_7.signature))
        );
    }

    #[test]
    fn a_broken_seen_entry_is_refused_with_its_reason() {
        let tampered = edit_lines(BETA_3.signature, |lines| {
            lines[2] = lines[2].replace("beta.3", "beta.4");
        });
        let bad_version = Version::parse("v1.0.0")
            .expect_err("带 v 前缀的不是合法 semver")
            .to_string();
        let cases = [
            // 本机程序把记录改高：签名仍是 beta.3 的。
            (
                Beta,
                entry("1.0.0-beta.99", BETA_3.signature),
                SeenEntryError::Head(HeadError::VersionMismatch {
                    signed: "1.0.0-beta.3".to_owned(),
                    manifest: version("1.0.0-beta.99"),
                }),
            ),
            (
                Beta,
                entry("1.0.0-beta.4", &tampered),
                SeenEntryError::Head(HeadError::GlobalSignatureInvalid),
            ),
            // 伪造的高版本记不进来。
            (
                Dev,
                entry("9.9.9-dev.1", IMPOSTOR.signature),
                SeenEntryError::Head(HeadError::GlobalSignatureInvalid),
            ),
            // 测试版的记录挪到正式版名下：钥相同，只有形状挡得住。
            (
                Stable,
                entry("1.0.0-beta.3", BETA_3.signature),
                SeenEntryError::Head(HeadError::WrongChannel {
                    version: version("1.0.0-beta.3"),
                    asked: Stable,
                    found: Some(Beta),
                }),
            ),
            (
                Dev,
                json!("1.0.0-dev.7"),
                SeenEntryError::NotAnObject { found: "字符串" },
            ),
            // 记录配上了另一把钥签的签名串：按这个通道的钥重验，密钥号就对不上。
            (
                Dev,
                entry("1.0.0-dev.7", BETA_3.signature),
                SeenEntryError::Head(HeadError::KeyIdMismatch {
                    signed: id_of(RELEASE_KEY),
                    expected: id_of(DEV_KEY),
                }),
            ),
            (
                Dev,
                json!(["1.0.0-dev.7", DEV_7.signature]),
                SeenEntryError::NotAnObject { found: "数组" },
            ),
            (
                Beta,
                json!(true),
                SeenEntryError::NotAnObject { found: "布尔值" },
            ),
            (
                Beta,
                json!({ "signature": BETA_3.signature }),
                SeenEntryError::MissingField("version"),
            ),
            (
                Beta,
                json!({ "version": "1.0.0-beta.3" }),
                SeenEntryError::MissingField("signature"),
            ),
            (
                Stable,
                json!({ "version": 1, "signature": STABLE_1.signature }),
                SeenEntryError::FieldNotString {
                    field: "version",
                    found: "数字",
                },
            ),
            (
                Stable,
                json!({ "version": "1.0.0", "signature": null }),
                SeenEntryError::FieldNotString {
                    field: "signature",
                    found: "null",
                },
            ),
            (
                Stable,
                entry("v1.0.0", STABLE_1.signature),
                SeenEntryError::BadVersion {
                    version: "v1.0.0".to_owned(),
                    reason: bad_version,
                },
            ),
        ];
        for (channel, broken, error) in cases {
            assert_eq!(
                read_seen_entry(channel, &broken, key_of(channel)),
                Err(error),
                "{broken}"
            );
        }
    }
}
