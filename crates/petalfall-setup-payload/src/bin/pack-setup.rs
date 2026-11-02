//! 把引导程序壳和 NSIS 安装包拼成首装包：`壳 + 136 字节头 + NSIS 原样字节`。
//!
//! 用法：`pack-setup <壳.exe> <NSIS 安装包> <Petalfall.exe> <版本号> <输出路径>`
//!
//! 所有检查都是硬失败：CI 是 Linux，跑不了产物，拼错的包要等用户双击才露馅。
//! 外层代码签名必须在这一步之后做，签完再追加载荷，签名就失效了。

use std::env;
use std::ffi::OsString;
use std::fmt;
use std::fs;
use std::io::{self, Cursor};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use petalfall_setup_payload::{
    Error as FormatError, HEADER_LEN, Header, locate, overlay_start, sha256,
};

const USAGE: &str = "用法：pack-setup <壳.exe> <NSIS 安装包> <Petalfall.exe> <版本号> <输出路径>";

/// tauri 构建产物里的包类型占位符。bundler 打 NSIS 时只改它再装进包里，改完又把 target 下的文件恢复原样，
/// 所以手上的 `Petalfall.exe` 和用户机器上落盘的那份差这几个字节，核验用的长度和哈希要按改过的算。
const EXE_MARKER: &[u8] = b"__TAURI_BUNDLE_TYPE_VAR_UNK";
const EXE_MARKER_NSIS: &[u8] = b"__TAURI_BUNDLE_TYPE_VAR_NSS";
const _: () = assert!(EXE_MARKER.len() == EXE_MARKER_NSIS.len());

#[derive(Debug)]
enum PackError {
    Usage,
    Read {
        path: PathBuf,
        source: io::Error,
    },
    Write {
        path: PathBuf,
        source: io::Error,
    },
    Format {
        what: &'static str,
        source: FormatError,
    },
    /// 节末端之后还有内容：载荷会被拼到别的数据后面，引导程序定位不到。
    StubNotBare {
        section_end: u64,
        file_len: u64,
    },
    PayloadNotPe,
    ExeMarkerCount {
        count: usize,
    },
    /// 写出的文件读回来和预期不一致。
    OutputMismatch(String),
}

impl fmt::Display for PackError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PackError::Usage => f.write_str(USAGE),
            PackError::Read { path, source } => write!(f, "读 {} 失败：{source}", path.display()),
            PackError::Write { path, source } => write!(f, "写 {} 失败：{source}", path.display()),
            PackError::Format { what, source } => write!(f, "{what}：{source}"),
            PackError::StubNotBare {
                section_end,
                file_len,
            } => write!(
                f,
                "壳的节末端在 {section_end}，文件却有 {file_len} 字节，节之后不能有别的内容"
            ),
            PackError::PayloadNotPe => write!(f, "NSIS 安装包不是以 MZ 开头"),
            PackError::ExeMarkerCount { count } => write!(
                f,
                "exe 里的包类型标记出现 {count} 次，必须恰好 1 次，算不出安装后的哈希"
            ),
            PackError::OutputMismatch(what) => write!(f, "输出读回后不一致：{what}"),
        }
    }
}

fn format_error(what: &'static str) -> impl FnOnce(FormatError) -> PackError {
    move |source| PackError::Format { what, source }
}

/// 安装后 `Petalfall.exe` 的字节。bundler 只替换第一处标记，出现多次时无从判断哪一处才是真的，直接拒绝。
fn installed_exe(mut exe: Vec<u8>) -> Result<Vec<u8>, PackError> {
    let positions: Vec<usize> = exe
        .windows(EXE_MARKER.len())
        .enumerate()
        .filter_map(|(at, window)| (window == EXE_MARKER).then_some(at))
        .collect();
    let [at] = positions[..] else {
        return Err(PackError::ExeMarkerCount {
            count: positions.len(),
        });
    };
    exe[at..at + EXE_MARKER.len()].copy_from_slice(EXE_MARKER_NSIS);
    Ok(exe)
}

/// 检查输入并拼出首装包的完整字节。
fn compose(
    stub: &[u8],
    payload: &[u8],
    exe: Vec<u8>,
    version: &str,
) -> Result<(Header, Vec<u8>), PackError> {
    let section_end =
        overlay_start(&mut Cursor::new(stub)).map_err(format_error("壳不是可解析的 PE"))?;
    let file_len = stub.len() as u64;
    if section_end != file_len {
        return Err(PackError::StubNotBare {
            section_end,
            file_len,
        });
    }
    if !payload.starts_with(b"MZ") {
        return Err(PackError::PayloadNotPe);
    }
    let exe = installed_exe(exe)?;
    let header = Header::new(payload, &exe, version).map_err(format_error("版本号不可用"))?;
    let header_bytes = header.to_bytes().map_err(format_error("载荷头写不出来"))?;

    let mut bundle = Vec::with_capacity(stub.len() + HEADER_LEN + payload.len());
    bundle.extend_from_slice(stub);
    bundle.extend_from_slice(&header_bytes);
    bundle.extend_from_slice(payload);
    Ok((header, bundle))
}

/// 按引导程序启动时的走法重新定位一遍，再和输入比对。
///
/// CI 跑不了 Windows 程序，这是验证 PE 定位在真实链接器产物上成立的唯一一步。
fn verify(bundle: &[u8], header: &Header, stub_len: u64, payload: &[u8]) -> Result<(), PackError> {
    let located = locate(&mut Cursor::new(bundle)).map_err(format_error("输出定位不到载荷"))?;
    if located.header != *header {
        return Err(PackError::OutputMismatch("载荷头和写入时不同".to_owned()));
    }
    let expected_offset = stub_len + HEADER_LEN as u64;
    if located.payload_offset != expected_offset {
        return Err(PackError::OutputMismatch(format!(
            "载荷在第 {} 字节，应在第 {expected_offset} 字节",
            located.payload_offset
        )));
    }
    let expected_len = expected_offset + payload.len() as u64;
    if bundle.len() as u64 != expected_len {
        return Err(PackError::OutputMismatch(format!(
            "文件 {} 字节，应为 {expected_len} 字节",
            bundle.len()
        )));
    }
    let start = expected_offset as usize;
    if sha256(&bundle[start..]) != sha256(payload) {
        return Err(PackError::OutputMismatch(
            "载荷和 NSIS 文件的哈希不同".to_owned(),
        ));
    }
    Ok(())
}

fn read(path: &Path) -> Result<Vec<u8>, PackError> {
    fs::read(path).map_err(|source| PackError::Read {
        path: path.to_owned(),
        source,
    })
}

/// 写完校验过才改成正式文件名：后续步骤看到这个文件存在，就能确定它是完整且自检过的。
fn write_verified(
    out: &Path,
    bundle: &[u8],
    header: &Header,
    stub_len: u64,
    nsis: &Path,
) -> Result<(), PackError> {
    let mut partial = out.as_os_str().to_owned();
    partial.push(".partial");
    let partial = PathBuf::from(partial);

    let write_error = |path: &Path, source| PackError::Write {
        path: path.to_owned(),
        source,
    };
    fs::write(&partial, bundle).map_err(|source| write_error(&partial, source))?;
    // 比对的是磁盘上真要发布的字节，NSIS 也重读一遍，拼接期间被换掉时这里能发现
    verify(&read(&partial)?, header, stub_len, &read(nsis)?)?;
    fs::rename(&partial, out).map_err(|source| write_error(out, source))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn run(args: Vec<OsString>) -> Result<String, PackError> {
    let [stub, nsis, exe, version, out] =
        <[OsString; 5]>::try_from(args).map_err(|_| PackError::Usage)?;
    let (stub_path, nsis_path, exe_path, out_path) = (
        Path::new(&stub),
        Path::new(&nsis),
        Path::new(&exe),
        Path::new(&out),
    );
    let version = version
        .to_str()
        .ok_or(FormatError::VersionMalformed)
        .map_err(format_error("版本号不可用"))?;

    let stub_bytes = read(stub_path)?;
    let (header, bundle) = compose(&stub_bytes, &read(nsis_path)?, read(exe_path)?, version)?;
    write_verified(
        out_path,
        &bundle,
        &header,
        stub_bytes.len() as u64,
        nsis_path,
    )?;

    Ok(format!(
        "{}：{} 字节，版本 {}，载荷 {} 字节 sha256 {}，安装后 exe {} 字节 sha256 {}",
        out_path.display(),
        bundle.len(),
        header.version,
        header.payload_len,
        hex(&header.payload_sha256),
        header.exe_len,
        hex(&header.exe_sha256),
    ))
}

fn main() -> ExitCode {
    match run(env::args_os().skip(1).collect()) {
        Ok(summary) => {
            println!("{summary}");
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("pack-setup：{err}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 只有一个节的最小 PE，文件正好结束在节末端。
    fn stub() -> Vec<u8> {
        const PE_AT: usize = 0x80;
        const SECTION_TABLE_AT: usize = PE_AT + 24;
        const RAW_POINTER: u32 = 0x200;
        const RAW_SIZE: u32 = 0x200;
        let mut pe = vec![0u8; (RAW_POINTER + RAW_SIZE) as usize];
        pe[..2].copy_from_slice(b"MZ");
        pe[0x3C..0x40].copy_from_slice(&(PE_AT as u32).to_le_bytes());
        pe[PE_AT..PE_AT + 4].copy_from_slice(b"PE\0\0");
        pe[PE_AT + 6..PE_AT + 8].copy_from_slice(&1u16.to_le_bytes());
        pe[SECTION_TABLE_AT + 16..SECTION_TABLE_AT + 20].copy_from_slice(&RAW_SIZE.to_le_bytes());
        pe[SECTION_TABLE_AT + 20..SECTION_TABLE_AT + 24]
            .copy_from_slice(&RAW_POINTER.to_le_bytes());
        pe
    }

    fn composed() -> (Vec<u8>, Header, Vec<u8>, Vec<u8>) {
        let stub = stub();
        let payload = b"MZ nsis bytes".to_vec();
        let (header, bundle) =
            compose(&stub, &payload, EXE_MARKER.to_vec(), "0.2.0-dev.9").unwrap();
        (stub, header, payload, bundle)
    }

    #[test]
    fn verify_accepts_what_compose_wrote() {
        let (stub, header, payload, bundle) = composed();
        verify(&bundle, &header, stub.len() as u64, &payload).unwrap();
    }

    #[test]
    fn verify_catches_a_flipped_payload_byte() {
        let (stub, header, payload, mut bundle) = composed();
        let last = bundle.len() - 1;
        bundle[last] ^= 0xFF;
        assert!(matches!(
            verify(&bundle, &header, stub.len() as u64, &payload),
            Err(PackError::OutputMismatch(what)) if what.contains("哈希")
        ));
    }

    #[test]
    fn verify_catches_a_header_that_differs_from_the_one_written() {
        let (stub, mut header, payload, bundle) = composed();
        header.version = "0.2.0-dev.10".to_owned();
        assert!(matches!(
            verify(&bundle, &header, stub.len() as u64, &payload),
            Err(PackError::OutputMismatch(what)) if what.contains("载荷头")
        ));
    }

    #[test]
    fn verify_catches_a_payload_found_at_the_wrong_offset() {
        // 真实链接器的节表和假设不符时就是这个表现：定位成功，但偏移不是壳的长度
        let (stub, header, payload, bundle) = composed();
        assert!(matches!(
            verify(&bundle, &header, stub.len() as u64 + 1, &payload),
            Err(PackError::OutputMismatch(what)) if what.contains("载荷在第")
        ));
    }

    #[test]
    fn verify_catches_bytes_after_the_payload() {
        let (stub, header, payload, mut bundle) = composed();
        bundle.push(0);
        assert!(matches!(
            verify(&bundle, &header, stub.len() as u64, &payload),
            Err(PackError::OutputMismatch(what)) if what.contains("字节，应为")
        ));
    }

    #[test]
    fn output_keeps_its_partial_name_until_it_matches_the_nsis_file() {
        let dir = env::temp_dir().join(format!("pack-setup-unit-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let (stub, header, payload, bundle) = composed();
        let out = dir.join("out.exe");
        let nsis = dir.join("nsis.exe");

        // NSIS 文件在拼接之后被换掉了
        let mut replaced = payload.clone();
        replaced[2] ^= 0xFF;
        fs::write(&nsis, &replaced).unwrap();
        let refused = write_verified(&out, &bundle, &header, stub.len() as u64, &nsis);
        assert!(matches!(refused, Err(PackError::OutputMismatch(_))));
        assert!(!out.exists(), "没过自检不能出现在正式文件名下");

        fs::write(&nsis, &payload).unwrap();
        write_verified(&out, &bundle, &header, stub.len() as u64, &nsis).unwrap();
        assert_eq!(fs::read(&out).unwrap(), bundle);
        assert!(!dir.join("out.exe.partial").exists());

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn verify_reports_a_truncated_output() {
        let (stub, header, payload, bundle) = composed();
        assert!(matches!(
            verify(
                &bundle[..bundle.len() - 1],
                &header,
                stub.len() as u64,
                &payload
            ),
            Err(PackError::Format {
                source: FormatError::PayloadTruncated { .. },
                ..
            })
        ));
    }
}
