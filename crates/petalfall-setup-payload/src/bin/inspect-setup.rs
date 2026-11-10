// Copyright (C) 2026 Shinoyuki_Miyako
// SPDX-License-Identifier: AGPL-3.0-only
// 本程序代码按 AGPL-3.0-only 授权，另附 AGPL 第 7 条的附加条款；两者见源代码根目录的 LICENSE 与 LICENSE-ADDITIONAL-TERMS.md。
// Licensed under AGPL-3.0-only with additional terms under section 7 of the AGPL; see LICENSE and LICENSE-ADDITIONAL-TERMS.md at the root of the source code.

//! 只读打印首装包载荷头里发布流水线要核对的四项，恰好一行、tab 分隔：
//! `<magic>\t<版本>\t<data_format>\t<caps>`，两个数都是十进制。
//!
//! 用法：`inspect-setup <引导程序路径>`
//!
//! `PFSETUP1` 的包早于数据格式号与能力位，这两项打成 0 与 0，即「包号 0、没有任何能力」。
//! 读不出头时 stdout 一个字节也不写、非零退出：后面的脚本按 tab 切这一行，半截输出会被当成字段读进去。

use std::env;
use std::ffi::OsString;
use std::fmt;
use std::fs::File;
use std::io;
use std::path::PathBuf;
use std::process::ExitCode;

use petalfall_setup_payload::{Error as FormatError, Header, MAGIC_V1, MAGIC_V2, locate};

const USAGE: &str = "用法：inspect-setup <引导程序路径>";

#[derive(Debug)]
enum InspectError {
    Usage,
    Open {
        path: PathBuf,
        source: io::Error,
    },
    Format {
        path: PathBuf,
        source: FormatError,
    },
    /// 数据格式号与能力位只有一项。格式库读出的头两项同有同无，只有一项时分不出是哪种头，不能猜。
    HalfFields {
        data_format: Option<u32>,
        caps: Option<u32>,
    },
    /// 版本号里有 tab 或换行：格式库只拒绝 0 字节，这几个字符会把一行四列拆乱。
    VersionBreaksLine {
        version: String,
    },
}

impl fmt::Display for InspectError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            InspectError::Usage => f.write_str(USAGE),
            InspectError::Open { path, source } => {
                write!(f, "打开 {} 失败：{source}", path.display())
            }
            InspectError::Format { path, source } => {
                write!(f, "{} 读不出载荷头：{source}", path.display())
            }
            InspectError::HalfFields { data_format, caps } => write!(
                f,
                "载荷头的数据格式号与能力位应当同有同无，读到的是 {data_format:?} 与 {caps:?}"
            ),
            InspectError::VersionBreaksLine { version } => write!(
                f,
                "载荷头的版本号 {version:?} 含制表符或换行，打不成一行四列"
            ),
        }
    }
}

fn magic_text(magic: &'static [u8; 8]) -> &'static str {
    std::str::from_utf8(magic).expect("magic 常量是 ASCII")
}

/// 四项拼成的一行，不带行尾。头没有直接记下 magic，按两项是否为 `None` 分辨是哪种头。
fn fields_line(header: &Header) -> Result<String, InspectError> {
    let (magic, data_format, caps) = match (header.data_format, header.caps) {
        (Some(data_format), Some(caps)) => (&MAGIC_V2, data_format, caps),
        (None, None) => (&MAGIC_V1, 0, 0),
        (data_format, caps) => return Err(InspectError::HalfFields { data_format, caps }),
    };
    if header.version.contains(['\t', '\n', '\r']) {
        return Err(InspectError::VersionBreaksLine {
            version: header.version.clone(),
        });
    }
    Ok(format!(
        "{}\t{}\t{data_format}\t{caps}",
        magic_text(magic),
        header.version
    ))
}

fn run(args: Vec<OsString>) -> Result<String, InspectError> {
    let [path] = <[OsString; 1]>::try_from(args).map_err(|_| InspectError::Usage)?;
    let path = PathBuf::from(path);
    let mut file = match File::open(&path) {
        Ok(file) => file,
        Err(source) => return Err(InspectError::Open { path, source }),
    };
    match locate(&mut file) {
        Ok(located) => fields_line(&located.header),
        Err(source) => Err(InspectError::Format { path, source }),
    }
}

fn main() -> ExitCode {
    match run(env::args_os().skip(1).collect()) {
        Ok(line) => {
            println!("{line}");
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("inspect-setup：{err}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(data_format: Option<u32>, caps: Option<u32>) -> Header {
        Header {
            data_format,
            caps,
            ..Header::new(b"payload", b"exe", "1.0.0-dev.42").unwrap()
        }
    }

    #[test]
    fn numbers_are_decimal_up_to_the_u32_limit() {
        // 能力位原样打印，读者不认得的高位也不丢
        assert_eq!(
            fields_line(&header(Some(u32::MAX), Some(u32::MAX))).unwrap(),
            "PFSETUP2\t1.0.0-dev.42\t4294967295\t4294967295"
        );
        assert_eq!(
            fields_line(&header(Some(1), Some(0))).unwrap(),
            "PFSETUP2\t1.0.0-dev.42\t1\t0"
        );
        assert_eq!(
            fields_line(&header(None, None)).unwrap(),
            "PFSETUP1\t1.0.0-dev.42\t0\t0"
        );
    }

    #[test]
    fn only_one_of_data_format_and_caps_is_refused_rather_than_guessed() {
        for (data_format, caps) in [(Some(1), None), (None, Some(1)), (None, Some(0))] {
            assert!(matches!(
                fields_line(&header(data_format, caps)),
                Err(InspectError::HalfFields { data_format: d, caps: c }) if d == data_format && c == caps
            ));
        }
    }
}
