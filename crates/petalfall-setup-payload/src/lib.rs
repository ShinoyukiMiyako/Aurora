// Copyright (C) 2026 Shinoyuki_Miyako
// SPDX-License-Identifier: AGPL-3.0-only
// 本程序代码按 AGPL-3.0-only 授权，另附 AGPL 第 7 条的附加条款；两者见源代码根目录的 LICENSE 与 LICENSE-ADDITIONAL-TERMS.md。
// Licensed under AGPL-3.0-only with additional terms under section 7 of the AGPL; see LICENSE and LICENSE-ADDITIONAL-TERMS.md at the root of the source code.

//! 引导程序的载荷格式：可执行文件节末端之后依次是载荷头和 NSIS 原样字节。
//!
//! 头放在节末端而不是文件末尾：外层代码签名会在文件尾补零并追加证书表，文件尾的位置签名后就变了，
//! 节表末端不受影响。magic 的末位数字兼作格式版本，读的时候先看 magic 再定头长。只写 144 字节的
//! `PFSETUP2`；136 字节的 `PFSETUP1` 出自更早的包，只读。字段（小端）：
//!
//! | 偏移 | 长度 | 内容 |
//! |---|---|---|
//! | 0 | 8 | magic `PFSETUP2`（旧包为 `PFSETUP1`） |
//! | 8 | 8 | payload_len |
//! | 16 | 32 | payload_sha256 |
//! | 48 | 8 | exe_len |
//! | 56 | 32 | exe_sha256 |
//! | 88 | 48 | version，UTF-8，尾补 0。`PFSETUP1` 到此为止 |
//! | 136 | 4 | data_format，u32，不小于 1：这个安装包认得的数据格式号 |
//! | 140 | 4 | caps，u32，能力位，含义见 [`CAP_CHANNEL_SWITCH`]。未定义的位写 0，读者忽略 |
//!
//! `PFSETUP1` 的包早于数据格式号与换通道，读出时后两项为 `None`，调用方按「包号 0、没有任何能力」处理。
//! `PFSETUP2` 里的 data_format 为 0 按头损坏处理：0 是留给旧包的含义，新头里出现只能是打包出错或字节坏了。
//!
//! 头里的哈希只防损坏不防篡改：未签名时攻击者可以连头一起改，防篡改要靠外层签名。

use std::fmt;
use std::io::{self, Read, Seek, SeekFrom};

use petalfall_release::data_format::DATA_FORMAT;
use sha2::{Digest, Sha256};

pub const MAGIC_V1: [u8; 8] = *b"PFSETUP1";
pub const MAGIC_V2: [u8; 8] = *b"PFSETUP2";
pub const HEADER_LEN_V1: usize = 136;
pub const HEADER_LEN_V2: usize = 144;
pub const VERSION_FIELD_LEN: usize = 48;

/// 能力位第 0 位：认得 `/CHANNELSWITCH`，按跨通道的安装判定表执行，并在安装前做数据格式关。
/// 启动器只凭这一位决定能不能把这个包当作换通道的目标，所以含义一经发出就不能改。
pub const CAP_CHANNEL_SWITCH: u32 = 1;
/// 本版本的安装包写进头里的全部能力位，也是本版本认得的全部能力位。
pub const SHIPPED_CAPS: u32 = CAP_CHANNEL_SWITCH;

const MAGIC_LEN: usize = 8;
const PAYLOAD_LEN_AT: usize = 8;
const PAYLOAD_SHA_AT: usize = 16;
const EXE_LEN_AT: usize = 48;
const EXE_SHA_AT: usize = 56;
const VERSION_AT: usize = 88;
const DATA_FORMAT_AT: usize = 136;
const CAPS_AT: usize = 140;

// 新字段只能接在旧头之后：旧头的 136 字节已经占满，偏移一经发出就改不了
const _: () = assert!(VERSION_AT + VERSION_FIELD_LEN == HEADER_LEN_V1);
const _: () = assert!(DATA_FORMAT_AT == HEADER_LEN_V1);
const _: () = assert!(CAPS_AT + 4 == HEADER_LEN_V2);

const DOS_HEADER_LEN: usize = 64;
const DOS_LFANEW_AT: usize = 0x3C;
const COFF_HEADER_LEN: usize = 20;
const COFF_SECTION_COUNT_AT: usize = 2;
const COFF_OPTIONAL_LEN_AT: usize = 16;
const SECTION_HEADER_LEN: usize = 40;
const SECTION_RAW_SIZE_AT: usize = 16;
const SECTION_RAW_POINTER_AT: usize = 20;

#[derive(Debug)]
pub enum Error {
    /// 头不完整。`expected` 是按 magic 认出的头长；连 magic 都不够 8 字节时取最短的头长 136。
    HeaderTooShort {
        len: usize,
        expected: usize,
    },
    /// magic 既不是 `PFSETUP1` 也不是 `PFSETUP2`。
    BadMagic,
    /// `PFSETUP2` 头里的数据格式号是 0。
    DataFormatZero,
    /// 要写出的头缺数据格式号或能力位：只写 `PFSETUP2`，从 `PFSETUP1` 读出的头写不回去。
    FieldMissing(&'static str),
    /// 要写出的能力位里有本版本没定义的位。
    UndefinedCaps {
        caps: u32,
    },
    VersionEmpty,
    VersionTooLong {
        len: usize,
    },
    /// 版本字段不是合法 UTF-8，或者补零区里混了别的字节。
    VersionMalformed,
    /// 文件在节末端就结束了：这是没有拼过载荷的壳。
    NoOverlay,
    /// 头说的长度超出了文件实际长度，多半是下载被截断。
    PayloadTruncated {
        end: u64,
        file_len: u64,
    },
    /// 不是能解析的 PE 文件。
    NotPe(&'static str),
    Io(io::Error),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::HeaderTooShort { len, expected } => {
                write!(f, "载荷头只有 {len} 字节，应为 {expected}")
            }
            Error::BadMagic => write!(f, "载荷头的 magic 不对"),
            Error::DataFormatZero => write!(f, "PFSETUP2 载荷头里的数据格式号是 0"),
            Error::FieldMissing(field) => {
                write!(f, "载荷头缺 {field}，只能写出带齐全部字段的 PFSETUP2")
            }
            Error::UndefinedCaps { caps } => {
                write!(f, "载荷头能力位 {caps:#x} 含未定义的位，未定义的位必须写 0")
            }
            Error::VersionEmpty => write!(f, "载荷版本号为空"),
            Error::VersionTooLong { len } => {
                write!(f, "载荷版本号 {len} 字节，超过上限 {VERSION_FIELD_LEN}")
            }
            Error::VersionMalformed => write!(f, "载荷版本号不是合法的 UTF-8 尾补 0 字段"),
            Error::NoOverlay => write!(f, "文件里没有载荷"),
            Error::PayloadTruncated { end, file_len } => {
                write!(f, "载荷应到第 {end} 字节，文件只有 {file_len} 字节")
            }
            Error::NotPe(what) => write!(f, "不是有效的 PE 文件：{what}"),
            Error::Io(err) => write!(f, "读取失败：{err}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Io(err) => Some(err),
            _ => None,
        }
    }
}

impl From<io::Error> for Error {
    fn from(err: io::Error) -> Self {
        Error::Io(err)
    }
}

/// 算内容的 SHA-256。打包和核验用同一个算法入口，免得两边各写一份。
pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Header {
    pub payload_len: u64,
    pub payload_sha256: [u8; 32],
    /// 安装后 `Petalfall.exe` 的期望长度和哈希：NSIS 落盘的 exe 与构建产物差一段包类型标记，不能拿载荷里的字节直接比。
    pub exe_len: u64,
    pub exe_sha256: [u8; 32],
    pub version: String,
    /// 这个安装包认得的数据格式号，读出的 `PFSETUP2` 头里不小于 1。`PFSETUP1` 的包没有这一项。
    pub data_format: Option<u32>,
    /// 能力位，原样保留，读者只看自己认得的位。`PFSETUP1` 的包没有这一项。
    pub caps: Option<u32>,
}

impl Header {
    /// 由载荷和安装后 exe 的字节算出头，数据格式号与能力位填本版本的。版本号在这里就校验，不留到写出时才失败。
    pub fn new(payload: &[u8], exe: &[u8], version: &str) -> Result<Self, Error> {
        check_version(version)?;
        Ok(Self {
            payload_len: payload.len() as u64,
            payload_sha256: sha256(payload),
            exe_len: exe.len() as u64,
            exe_sha256: sha256(exe),
            version: version.to_owned(),
            data_format: Some(DATA_FORMAT),
            caps: Some(SHIPPED_CAPS),
        })
    }

    /// 只写 `PFSETUP2`。
    pub fn to_bytes(&self) -> Result<[u8; HEADER_LEN_V2], Error> {
        check_version(&self.version)?;
        let data_format = self.data_format.ok_or(Error::FieldMissing("data_format"))?;
        if data_format == 0 {
            return Err(Error::DataFormatZero);
        }
        let caps = self.caps.ok_or(Error::FieldMissing("caps"))?;
        if caps & !SHIPPED_CAPS != 0 {
            return Err(Error::UndefinedCaps { caps });
        }
        let mut out = [0u8; HEADER_LEN_V2];
        out[..MAGIC_LEN].copy_from_slice(&MAGIC_V2);
        out[PAYLOAD_LEN_AT..PAYLOAD_SHA_AT].copy_from_slice(&self.payload_len.to_le_bytes());
        out[PAYLOAD_SHA_AT..EXE_LEN_AT].copy_from_slice(&self.payload_sha256);
        out[EXE_LEN_AT..EXE_SHA_AT].copy_from_slice(&self.exe_len.to_le_bytes());
        out[EXE_SHA_AT..VERSION_AT].copy_from_slice(&self.exe_sha256);
        out[VERSION_AT..VERSION_AT + self.version.len()].copy_from_slice(self.version.as_bytes());
        out[DATA_FORMAT_AT..CAPS_AT].copy_from_slice(&data_format.to_le_bytes());
        out[CAPS_AT..HEADER_LEN_V2].copy_from_slice(&caps.to_le_bytes());
        Ok(out)
    }

    /// 先看 magic 再定头长，只读头这一段，后面多出来的不看：调用方可以直接把 overlay 整段传进来。
    pub fn parse(bytes: &[u8]) -> Result<Self, Error> {
        let format = Format::of(bytes)?;
        let expected = format.header_len();
        if bytes.len() < expected {
            return Err(Error::HeaderTooShort {
                len: bytes.len(),
                expected,
            });
        }
        let version = parse_version(&bytes[VERSION_AT..VERSION_AT + VERSION_FIELD_LEN])?;
        let (data_format, caps) = match format {
            Format::V1 => (None, None),
            Format::V2 => {
                let data_format = u32_at(bytes, DATA_FORMAT_AT);
                if data_format == 0 {
                    return Err(Error::DataFormatZero);
                }
                (Some(data_format), Some(u32_at(bytes, CAPS_AT)))
            }
        };
        Ok(Self {
            payload_len: u64_at(bytes, PAYLOAD_LEN_AT),
            payload_sha256: digest_at(bytes, PAYLOAD_SHA_AT),
            exe_len: u64_at(bytes, EXE_LEN_AT),
            exe_sha256: digest_at(bytes, EXE_SHA_AT),
            version,
            data_format,
            caps,
        })
    }
}

/// 头的两种格式，由 magic 的末位数字区分。
#[derive(Debug, Clone, Copy)]
enum Format {
    V1,
    V2,
}

impl Format {
    fn of(bytes: &[u8]) -> Result<Self, Error> {
        // 不够 8 字节就认不出是哪种头，按最短的头报不完整
        let Some(magic) = bytes.get(..MAGIC_LEN) else {
            return Err(Error::HeaderTooShort {
                len: bytes.len(),
                expected: HEADER_LEN_V1,
            });
        };
        if *magic == MAGIC_V2 {
            Ok(Format::V2)
        } else if *magic == MAGIC_V1 {
            Ok(Format::V1)
        } else {
            Err(Error::BadMagic)
        }
    }

    fn header_len(self) -> usize {
        match self {
            Format::V1 => HEADER_LEN_V1,
            Format::V2 => HEADER_LEN_V2,
        }
    }
}

fn u64_at(bytes: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(bytes[at..at + 8].try_into().expect("调用方已确认长度足够"))
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().expect("调用方已确认长度足够"))
}

fn digest_at(bytes: &[u8], at: usize) -> [u8; 32] {
    bytes[at..at + 32].try_into().expect("调用方已确认长度足够")
}

fn check_version(version: &str) -> Result<(), Error> {
    if version.is_empty() {
        return Err(Error::VersionEmpty);
    }
    if version.len() > VERSION_FIELD_LEN {
        return Err(Error::VersionTooLong { len: version.len() });
    }
    // 0 是字段的结束符，版本里带 0 读回来就成了另一个版本
    if version.as_bytes().contains(&0) {
        return Err(Error::VersionMalformed);
    }
    Ok(())
}

fn parse_version(field: &[u8]) -> Result<String, Error> {
    let end = field.iter().position(|&b| b == 0).unwrap_or(field.len());
    if field[end..].iter().any(|&b| b != 0) {
        return Err(Error::VersionMalformed);
    }
    let version = std::str::from_utf8(&field[..end]).map_err(|_| Error::VersionMalformed)?;
    if version.is_empty() {
        return Err(Error::VersionEmpty);
    }
    Ok(version.to_owned())
}

fn read_at<R: Read + Seek>(image: &mut R, at: u64, buf: &mut [u8]) -> Result<(), Error> {
    image.seek(SeekFrom::Start(at))?;
    image.read_exact(buf).map_err(|err| match err.kind() {
        io::ErrorKind::UnexpectedEof => Error::NotPe("文件在头部结束前就截断了"),
        _ => Error::Io(err),
    })
}

/// overlay 起点：各节 `PointerToRawData + SizeOfRawData` 的最大值。
///
/// 只读 PE 头和节表，不把整个文件读进内存：引导程序要定位的是一个十几 MB 的自身。
pub fn overlay_start<R: Read + Seek>(image: &mut R) -> Result<u64, Error> {
    let mut dos = [0u8; DOS_HEADER_LEN];
    read_at(image, 0, &mut dos)?;
    if dos[..2] != *b"MZ" {
        return Err(Error::NotPe("没有 MZ 头"));
    }
    let lfanew_bytes: [u8; 4] = dos[DOS_LFANEW_AT..DOS_LFANEW_AT + 4]
        .try_into()
        .expect("DOS 头的长度是常量");
    let pe_at = u64::from(u32::from_le_bytes(lfanew_bytes));

    let mut signature = [0u8; 4];
    read_at(image, pe_at, &mut signature)?;
    if signature != *b"PE\0\0" {
        return Err(Error::NotPe("没有 PE 签名"));
    }

    let mut coff = [0u8; COFF_HEADER_LEN];
    read_at(image, pe_at + 4, &mut coff)?;
    let section_count =
        u16::from_le_bytes([coff[COFF_SECTION_COUNT_AT], coff[COFF_SECTION_COUNT_AT + 1]]);
    let optional_len =
        u16::from_le_bytes([coff[COFF_OPTIONAL_LEN_AT], coff[COFF_OPTIONAL_LEN_AT + 1]]);
    if section_count == 0 {
        return Err(Error::NotPe("节表为空"));
    }

    let table_at = pe_at + 4 + COFF_HEADER_LEN as u64 + u64::from(optional_len);
    let mut end = 0u64;
    for index in 0..u64::from(section_count) {
        let mut section = [0u8; SECTION_HEADER_LEN];
        read_at(
            image,
            table_at + index * SECTION_HEADER_LEN as u64,
            &mut section,
        )?;
        let size = u32::from_le_bytes(
            section[SECTION_RAW_SIZE_AT..SECTION_RAW_SIZE_AT + 4]
                .try_into()
                .expect("节头的长度是常量"),
        );
        let pointer = u32::from_le_bytes(
            section[SECTION_RAW_POINTER_AT..SECTION_RAW_POINTER_AT + 4]
                .try_into()
                .expect("节头的长度是常量"),
        );
        end = end.max(u64::from(pointer) + u64::from(size));
    }
    Ok(end)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Located {
    pub header: Header,
    /// 载荷第一个字节在文件里的偏移。
    pub payload_offset: u64,
}

/// 定位并读出头，确认载荷整段都在文件里。两种头都认，头长与载荷偏移按 magic 定。
/// 载荷的内容哈希不在这里算：这一步要在启动时瞬间做完。
pub fn locate<R: Read + Seek>(image: &mut R) -> Result<Located, Error> {
    let start = overlay_start(image)?;
    let file_len = image.seek(SeekFrom::End(0))?;
    if file_len <= start {
        return Err(Error::NoOverlay);
    }
    // 连 magic 都放不下就认不出是哪种头，按最短的头报截断
    if file_len < start + MAGIC_LEN as u64 {
        return Err(Error::PayloadTruncated {
            end: start + HEADER_LEN_V1 as u64,
            file_len,
        });
    }

    let mut buf = [0u8; HEADER_LEN_V2];
    image.seek(SeekFrom::Start(start))?;
    image.read_exact(&mut buf[..MAGIC_LEN])?;
    let header_len = Format::of(&buf[..MAGIC_LEN])?.header_len();
    let payload_offset = start + header_len as u64;
    if file_len < payload_offset {
        return Err(Error::PayloadTruncated {
            end: payload_offset,
            file_len,
        });
    }
    image.read_exact(&mut buf[MAGIC_LEN..header_len])?;
    let header = Header::parse(&buf[..header_len])?;

    // 长度字段来自文件本身，损坏时可能接近 u64 上限
    let end = payload_offset
        .checked_add(header.payload_len)
        .ok_or(Error::PayloadTruncated {
            end: u64::MAX,
            file_len,
        })?;
    // 用小于等于：签名会在载荷之后再补零和证书表
    if end > file_len {
        return Err(Error::PayloadTruncated { end, file_len });
    }
    Ok(Located {
        header,
        payload_offset,
    })
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    const OPTIONAL_LEN: usize = 240;
    const PE_AT: usize = 0x80;

    /// 按节头手工拼出的最小 PE：`sections` 是 (PointerToRawData, SizeOfRawData)，文件长度取节末端。
    fn minimal_pe(sections: &[(u32, u32)]) -> Vec<u8> {
        let table_at = PE_AT + 4 + COFF_HEADER_LEN + OPTIONAL_LEN;
        let headers_end = table_at + sections.len() * SECTION_HEADER_LEN;
        let end = sections
            .iter()
            .map(|&(pointer, size)| pointer as usize + size as usize)
            .max()
            .unwrap_or(0)
            .max(headers_end);
        let mut pe = vec![0u8; end];
        pe[..2].copy_from_slice(b"MZ");
        pe[DOS_LFANEW_AT..DOS_LFANEW_AT + 4].copy_from_slice(&(PE_AT as u32).to_le_bytes());
        pe[PE_AT..PE_AT + 4].copy_from_slice(b"PE\0\0");
        let coff = PE_AT + 4;
        pe[coff + COFF_SECTION_COUNT_AT..coff + COFF_SECTION_COUNT_AT + 2]
            .copy_from_slice(&(sections.len() as u16).to_le_bytes());
        pe[coff + COFF_OPTIONAL_LEN_AT..coff + COFF_OPTIONAL_LEN_AT + 2]
            .copy_from_slice(&(OPTIONAL_LEN as u16).to_le_bytes());
        for (index, &(pointer, size)) in sections.iter().enumerate() {
            let at = table_at + index * SECTION_HEADER_LEN;
            pe[at + SECTION_RAW_SIZE_AT..at + SECTION_RAW_SIZE_AT + 4]
                .copy_from_slice(&size.to_le_bytes());
            pe[at + SECTION_RAW_POINTER_AT..at + SECTION_RAW_POINTER_AT + 4]
                .copy_from_slice(&pointer.to_le_bytes());
        }
        pe
    }

    /// 不引入随机数依赖：固定种子的 xorshift，失败时可复现。
    fn noise(seed: u64, len: usize) -> Vec<u8> {
        let mut state = seed | 1;
        (0..len)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                state as u8
            })
            .collect()
    }

    fn sample_header() -> Header {
        Header::new(b"payload", b"exe bytes", "0.1.0-dev.42").unwrap()
    }

    fn bundle(stub: &[u8], header: &Header, payload: &[u8]) -> Vec<u8> {
        let mut out = stub.to_vec();
        out.extend_from_slice(&header.to_bytes().unwrap());
        out.extend_from_slice(payload);
        out
    }

    /// 旧包的 136 字节头：按旧格式逐字段现场拼，不经过本库的写出函数，本库也已经写不出这种头。
    fn v1_bytes(header: &Header) -> Vec<u8> {
        let mut out = vec![0u8; 136];
        out[0..8].copy_from_slice(b"PFSETUP1");
        out[8..16].copy_from_slice(&header.payload_len.to_le_bytes());
        out[16..48].copy_from_slice(&header.payload_sha256);
        out[48..56].copy_from_slice(&header.exe_len.to_le_bytes());
        out[56..88].copy_from_slice(&header.exe_sha256);
        out[88..88 + header.version.len()].copy_from_slice(header.version.as_bytes());
        out
    }

    fn v1_bundle(stub: &[u8], header: &Header, payload: &[u8]) -> Vec<u8> {
        let mut out = stub.to_vec();
        out.extend_from_slice(&v1_bytes(header));
        out.extend_from_slice(payload);
        out
    }

    #[test]
    fn header_fields_sit_at_the_documented_offsets() {
        let header = Header {
            payload_len: 0x0102_0304_0506_0708,
            payload_sha256: [0xAA; 32],
            exe_len: 0x1112_1314_1516_1718,
            exe_sha256: [0xBB; 32],
            version: "1.2.3".to_owned(),
            data_format: Some(0x2122_2324),
            caps: Some(CAP_CHANNEL_SWITCH),
        };
        let bytes = header.to_bytes().unwrap();
        assert_eq!(bytes.len(), 144);
        assert_eq!(&bytes[0..8], b"PFSETUP2");
        assert_eq!(&bytes[8..16], &[8, 7, 6, 5, 4, 3, 2, 1]);
        assert_eq!(&bytes[16..48], &[0xAA; 32]);
        assert_eq!(
            &bytes[48..56],
            &[0x18, 0x17, 0x16, 0x15, 0x14, 0x13, 0x12, 0x11]
        );
        assert_eq!(&bytes[56..88], &[0xBB; 32]);
        assert_eq!(&bytes[88..93], b"1.2.3");
        assert_eq!(&bytes[93..136], &[0u8; 43]);
        assert_eq!(&bytes[136..140], &[0x24, 0x23, 0x22, 0x21]);
        assert_eq!(&bytes[140..144], &[1, 0, 0, 0]);
    }

    #[test]
    fn digests_are_the_sha256_of_the_content() {
        // 空输入的 SHA-256 是公开的固定值
        let header = Header::new(b"", b"abc", "1.0.0").unwrap();
        assert_eq!(header.payload_len, 0);
        assert_eq!(header.exe_len, 3);
        assert_eq!(header.payload_sha256[..4], [0xE3, 0xB0, 0xC4, 0x42]);
        assert_eq!(header.exe_sha256[..4], [0xBA, 0x78, 0x16, 0xBF]);
    }

    #[test]
    fn new_header_carries_this_builds_data_format_and_the_channel_switch_bit() {
        // 第 0 位的含义已经随包发出，换了位置旧启动器就会把不认开关的包当成目标
        assert_eq!(CAP_CHANNEL_SWITCH, 1);
        assert_eq!(SHIPPED_CAPS, 1);
        let header = sample_header();
        assert_eq!(header.data_format, Some(DATA_FORMAT));
        assert_eq!(header.caps, Some(1));
        let bytes = header.to_bytes().unwrap();
        assert_eq!(&bytes[136..140], &DATA_FORMAT.to_le_bytes());
        assert_eq!(&bytes[140..144], &[1, 0, 0, 0]);
    }

    #[test]
    fn random_headers_round_trip() {
        for seed in 1..64u64 {
            let payload = noise(seed, (seed as usize) * 37 % 512);
            let exe = noise(seed.wrapping_mul(31), (seed as usize) * 11 % 256);
            let version_len = 1 + (seed as usize) * 7 % VERSION_FIELD_LEN;
            let version = "9".repeat(version_len);
            let mut header = Header::new(&payload, &exe, &version).unwrap();
            let data_format = match seed {
                1 => 1,
                2 => u32::MAX,
                _ => u32::from_le_bytes(noise(seed ^ 0x5A5A, 4).try_into().unwrap()).max(1),
            };
            header.data_format = Some(data_format);
            header.caps = Some(if seed % 2 == 0 { 0 } else { CAP_CHANNEL_SWITCH });
            assert_eq!(Header::parse(&header.to_bytes().unwrap()).unwrap(), header);
        }
    }

    #[test]
    fn version_of_exactly_48_bytes_fits_and_49_is_rejected() {
        let exact = "1".repeat(VERSION_FIELD_LEN);
        let header = Header::new(b"p", b"e", &exact).unwrap();
        let bytes = header.to_bytes().unwrap();
        assert_eq!(Header::parse(&bytes).unwrap().version, exact);

        let over = "1".repeat(VERSION_FIELD_LEN + 1);
        assert!(matches!(
            Header::new(b"p", b"e", &over),
            Err(Error::VersionTooLong { len: 49 })
        ));
        let mut direct = header;
        direct.version = over;
        assert!(matches!(
            direct.to_bytes(),
            Err(Error::VersionTooLong { len: 49 })
        ));
    }

    #[test]
    fn version_length_counts_bytes_and_cjk_round_trips() {
        // 16 个汉字正好 48 字节；再加一个 ASCII 就超了
        let exact = "版".repeat(16);
        let header = Header::new(b"p", b"e", &exact).unwrap();
        assert_eq!(
            Header::parse(&header.to_bytes().unwrap()).unwrap().version,
            exact
        );
        let over = format!("{exact}1");
        assert!(matches!(
            Header::new(b"p", b"e", &over),
            Err(Error::VersionTooLong { len: 49 })
        ));
    }

    #[test]
    fn empty_version_and_embedded_nul_are_rejected() {
        assert!(matches!(
            Header::new(b"p", b"e", ""),
            Err(Error::VersionEmpty)
        ));
        assert!(matches!(
            Header::new(b"p", b"e", "1\0.0"),
            Err(Error::VersionMalformed)
        ));
    }

    #[test]
    fn short_header_reports_its_length_against_the_length_its_magic_needs() {
        let v2 = sample_header().to_bytes().unwrap();
        assert!(matches!(
            Header::parse(&v2[..143]),
            Err(Error::HeaderTooShort {
                len: 143,
                expected: 144
            })
        ));
        // 136 字节对旧头刚好够，对新头还差 8 字节
        assert!(matches!(
            Header::parse(&v2[..136]),
            Err(Error::HeaderTooShort {
                len: 136,
                expected: 144
            })
        ));
        let v1 = v1_bytes(&sample_header());
        assert!(matches!(
            Header::parse(&v1[..135]),
            Err(Error::HeaderTooShort {
                len: 135,
                expected: 136
            })
        ));
        assert!(matches!(
            Header::parse(&v2[..7]),
            Err(Error::HeaderTooShort {
                len: 7,
                expected: 136
            })
        ));
        assert!(matches!(
            Header::parse(&[]),
            Err(Error::HeaderTooShort {
                len: 0,
                expected: 136
            })
        ));
    }

    #[test]
    fn unknown_magic_is_rejected() {
        for last in [b'0', b'3', b'9', 0] {
            let mut bytes = sample_header().to_bytes().unwrap();
            bytes[7] = last;
            assert!(matches!(Header::parse(&bytes), Err(Error::BadMagic)));
        }
        let mut lowercase = sample_header().to_bytes().unwrap();
        lowercase[0] = b'p';
        assert!(matches!(Header::parse(&lowercase), Err(Error::BadMagic)));
    }

    #[test]
    fn v1_header_reads_without_data_format_and_caps() {
        let expected = Header {
            data_format: None,
            caps: None,
            ..sample_header()
        };
        // 旧头之后紧跟的就是载荷，不能被当成号与能力位读进来
        let mut bytes = v1_bytes(&expected);
        bytes.extend_from_slice(&[7, 0, 0, 0, 1, 0, 0, 0]);
        assert_eq!(Header::parse(&bytes).unwrap(), expected);
        assert_eq!(Header::parse(&bytes[..136]).unwrap(), expected);
    }

    #[test]
    fn v2_data_format_zero_is_rejected_on_read_and_write() {
        let mut bytes = sample_header().to_bytes().unwrap();
        bytes[136..140].fill(0);
        assert!(matches!(Header::parse(&bytes), Err(Error::DataFormatZero)));

        // 四个字节按小端合起来判断：只看首字节会把它误判成 0
        bytes[139] = 1;
        assert_eq!(
            Header::parse(&bytes).unwrap().data_format,
            Some(0x0100_0000)
        );

        let mut header = sample_header();
        header.data_format = Some(0);
        assert!(matches!(header.to_bytes(), Err(Error::DataFormatZero)));
    }

    #[test]
    fn caps_bits_the_reader_does_not_know_are_kept_but_not_rejected() {
        let mut bytes = sample_header().to_bytes().unwrap();
        bytes[140..144].copy_from_slice(&0xFFFF_FFFEu32.to_le_bytes());
        let header = Header::parse(&bytes).unwrap();
        assert_eq!(header.caps, Some(0xFFFF_FFFE));
        assert_eq!(header.caps.unwrap() & CAP_CHANNEL_SWITCH, 0);
    }

    #[test]
    fn only_complete_v2_headers_can_be_written() {
        let v1 = Header::parse(&v1_bytes(&sample_header())).unwrap();
        assert!(matches!(
            v1.to_bytes(),
            Err(Error::FieldMissing("data_format"))
        ));

        let mut no_caps = sample_header();
        no_caps.caps = None;
        assert!(matches!(
            no_caps.to_bytes(),
            Err(Error::FieldMissing("caps"))
        ));

        let mut undefined = sample_header();
        undefined.caps = Some(CAP_CHANNEL_SWITCH | 0b10);
        assert!(matches!(
            undefined.to_bytes(),
            Err(Error::UndefinedCaps { caps: 0b11 })
        ));
    }

    #[test]
    fn corrupt_version_field_is_rejected() {
        let good = sample_header().to_bytes().unwrap();

        let mut empty = good;
        empty[VERSION_AT..VERSION_AT + VERSION_FIELD_LEN].fill(0);
        assert!(matches!(Header::parse(&empty), Err(Error::VersionEmpty)));

        let mut junk_after_end = good;
        junk_after_end[VERSION_AT + VERSION_FIELD_LEN - 1] = b'x';
        assert!(matches!(
            Header::parse(&junk_after_end),
            Err(Error::VersionMalformed)
        ));

        let mut invalid_utf8 = good;
        invalid_utf8[VERSION_AT] = 0xFF;
        assert!(matches!(
            Header::parse(&invalid_utf8),
            Err(Error::VersionMalformed)
        ));
    }

    #[test]
    fn overlay_start_is_the_largest_section_end_in_any_order() {
        let pe = minimal_pe(&[(0x400, 0x1000), (0x3000, 0x200), (0x1400, 0x1C00)]);
        assert_eq!(overlay_start(&mut Cursor::new(&pe)).unwrap(), 0x3200);
    }

    #[test]
    fn uninitialized_sections_do_not_move_the_overlay_start() {
        // .bss 这类节 PointerToRawData 和 SizeOfRawData 都是 0
        let pe = minimal_pe(&[(0x400, 0x200), (0, 0)]);
        assert_eq!(overlay_start(&mut Cursor::new(&pe)).unwrap(), 0x600);
    }

    #[test]
    fn non_pe_input_names_the_reason() {
        let too_short = vec![b'M', b'Z'];
        assert!(matches!(
            overlay_start(&mut Cursor::new(&too_short)),
            Err(Error::NotPe(_))
        ));

        let mut no_mz = minimal_pe(&[(0x400, 0x200)]);
        no_mz[0] = b'X';
        assert!(matches!(
            overlay_start(&mut Cursor::new(&no_mz)),
            Err(Error::NotPe("没有 MZ 头"))
        ));

        let mut no_signature = minimal_pe(&[(0x400, 0x200)]);
        no_signature[PE_AT] = b'X';
        assert!(matches!(
            overlay_start(&mut Cursor::new(&no_signature)),
            Err(Error::NotPe("没有 PE 签名"))
        ));

        let no_sections = minimal_pe(&[]);
        assert!(matches!(
            overlay_start(&mut Cursor::new(&no_sections)),
            Err(Error::NotPe("节表为空"))
        ));
    }

    #[test]
    fn truncated_section_table_is_an_error() {
        let pe = minimal_pe(&[(0x400, 0x200), (0x600, 0x200)]);
        let table_at = PE_AT + 4 + COFF_HEADER_LEN + OPTIONAL_LEN;
        let cut = &pe[..table_at + SECTION_HEADER_LEN + 8];
        assert!(matches!(
            overlay_start(&mut Cursor::new(cut)),
            Err(Error::NotPe(_))
        ));
    }

    #[test]
    fn locates_header_and_payload_in_a_bundle() {
        let stub = minimal_pe(&[(0x400, 0x200)]);
        let payload = noise(7, 300);
        let header = Header::new(&payload, b"exe", "0.2.0").unwrap();
        let file = bundle(&stub, &header, &payload);

        let located = locate(&mut Cursor::new(&file)).unwrap();
        assert_eq!(located.header, header);
        assert_eq!(located.payload_offset, 0x600 + 144);
        let start = located.payload_offset as usize;
        assert_eq!(&file[start..start + payload.len()], &payload[..]);
    }

    #[test]
    fn locates_an_older_v1_bundle_with_the_payload_right_after_136_bytes() {
        let stub = minimal_pe(&[(0x400, 0x200)]);
        let payload = noise(29, 300);
        let header = Header::new(&payload, b"exe", "0.1.0-dev.41").unwrap();
        let file = v1_bundle(&stub, &header, &payload);

        let located = locate(&mut Cursor::new(&file)).unwrap();
        assert_eq!(located.payload_offset, 0x600 + 136);
        assert_eq!(located.header.version, "0.1.0-dev.41");
        assert_eq!(located.header.payload_len, 300);
        assert_eq!(located.header.payload_sha256, sha256(&payload));
        assert_eq!(located.header.data_format, None);
        assert_eq!(located.header.caps, None);
        let start = located.payload_offset as usize;
        assert_eq!(&file[start..], &payload[..]);
    }

    #[test]
    fn v1_bundle_with_an_empty_payload_ends_right_after_its_136_byte_header() {
        // 文件只比旧头多 0 字节：按新头的 144 字节去读就会误报截断
        let stub = minimal_pe(&[(0x400, 0x200)]);
        let header = Header::new(b"", b"exe", "1.0.0-beta.2").unwrap();
        let file = v1_bundle(&stub, &header, b"");
        assert_eq!(file.len(), 0x600 + 136);

        let located = locate(&mut Cursor::new(&file)).unwrap();
        assert_eq!(located.payload_offset, 0x600 + 136);
        assert_eq!(located.header.payload_len, 0);
        assert_eq!(located.header.data_format, None);
    }

    #[test]
    fn locate_rejects_a_v2_header_whose_data_format_is_zero() {
        let stub = minimal_pe(&[(0x400, 0x200)]);
        let payload = noise(31, 64);
        let header = Header::new(&payload, b"exe", "1.0.0").unwrap();
        let mut file = bundle(&stub, &header, &payload);
        file[0x600 + 136..0x600 + 140].fill(0);
        assert!(matches!(
            locate(&mut Cursor::new(&file)),
            Err(Error::DataFormatZero)
        ));
    }

    #[test]
    fn signature_padding_after_the_payload_is_tolerated() {
        let stub = minimal_pe(&[(0x400, 0x200)]);
        let payload = noise(11, 64);
        let header = Header::new(&payload, b"exe", "0.2.0").unwrap();
        let mut file = bundle(&stub, &header, &payload);
        file.extend_from_slice(&[0, 0]);
        file.extend_from_slice(&noise(13, 2048));
        assert_eq!(locate(&mut Cursor::new(&file)).unwrap().header, header);
    }

    #[test]
    fn payload_one_byte_short_is_truncated() {
        let stub = minimal_pe(&[(0x400, 0x200)]);
        let payload = noise(17, 128);
        let header = Header::new(&payload, b"exe", "0.2.0").unwrap();
        let file = bundle(&stub, &header, &payload);
        assert!(locate(&mut Cursor::new(&file)).is_ok());

        let cut = &file[..file.len() - 1];
        let expected_end = (0x600 + 144 + 128) as u64;
        assert!(matches!(
            locate(&mut Cursor::new(cut)),
            Err(Error::PayloadTruncated { end, file_len }) if end == expected_end && file_len == expected_end - 1
        ));
    }

    #[test]
    fn cut_inside_the_header_is_truncated_at_the_length_its_magic_needs() {
        let stub = minimal_pe(&[(0x400, 0x200)]);
        let header = sample_header();
        let v2 = bundle(&stub, &header, b"payload");
        assert!(matches!(
            locate(&mut Cursor::new(&v2[..0x600 + 100])),
            Err(Error::PayloadTruncated {
                end: 0x690,
                file_len: 0x664
            })
        ));
        // 旧头已经完整、新头还差 4 字节的位置
        assert!(matches!(
            locate(&mut Cursor::new(&v2[..0x600 + 140])),
            Err(Error::PayloadTruncated {
                end: 0x690,
                file_len: 0x68C
            })
        ));

        let v1 = v1_bundle(&stub, &header, b"payload");
        assert!(matches!(
            locate(&mut Cursor::new(&v1[..0x600 + 100])),
            Err(Error::PayloadTruncated {
                end: 0x688,
                file_len: 0x664
            })
        ));
    }

    #[test]
    fn overlay_too_short_for_a_magic_is_truncated_at_the_shortest_header() {
        let stub = minimal_pe(&[(0x400, 0x200)]);
        let file = bundle(&stub, &sample_header(), b"payload");
        assert!(matches!(
            locate(&mut Cursor::new(&file[..0x600 + 7])),
            Err(Error::PayloadTruncated {
                end: 0x688,
                file_len: 0x607
            })
        ));
    }

    #[test]
    fn huge_payload_len_does_not_overflow() {
        let stub = minimal_pe(&[(0x400, 0x200)]);
        let mut header = sample_header();
        header.payload_len = u64::MAX;
        let file = bundle(&stub, &header, b"payload");
        assert!(matches!(
            locate(&mut Cursor::new(&file)),
            Err(Error::PayloadTruncated { end: u64::MAX, .. })
        ));
    }

    #[test]
    fn bare_stub_reports_no_overlay() {
        let stub = minimal_pe(&[(0x400, 0x200)]);
        assert!(matches!(
            locate(&mut Cursor::new(&stub)),
            Err(Error::NoOverlay)
        ));
    }

    #[test]
    fn garbage_after_the_sections_is_bad_magic() {
        let mut file = minimal_pe(&[(0x400, 0x200)]);
        file.extend_from_slice(&noise(23, HEADER_LEN_V2 + 16));
        assert!(matches!(
            locate(&mut Cursor::new(&file)),
            Err(Error::BadMagic)
        ));
        // 认不出 magic 就不再谈截断：不够一个头长的垃圾同样是 BadMagic
        let short = &file[..0x600 + 20];
        assert!(matches!(
            locate(&mut Cursor::new(short)),
            Err(Error::BadMagic)
        ));
    }
}
