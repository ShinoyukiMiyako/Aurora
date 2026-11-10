//! 按发布流水线的调用方式跑 inspect-setup：先用 pack-setup 真打一个包，再起进程读它，看 stdout 那一行、退出码和错误输出。

use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};

use petalfall_release::data_format::DATA_FORMAT;
use petalfall_setup_payload::{Header, SHIPPED_CAPS, VERSION_FIELD_LEN, locate};

const MARKER: &[u8] = b"__TAURI_BUNDLE_TYPE_VAR_UNK";
const VERSION: &str = "1.0.0-beta.3";

/// 放在 cargo 给集成测试的目录里，不碰系统临时目录。
struct Workspace {
    dir: PathBuf,
}

impl Workspace {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!(
            "inspect-setup-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        Self { dir }
    }

    fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.dir.join(name);
        fs::write(&path, bytes).unwrap();
        path
    }

    /// 照 CI 的五个参数跑 pack-setup，返回打出的首装包。
    fn pack(&self, version: &str) -> PathBuf {
        let out = self.dir.join("Petalfall-Installer-x64.exe");
        let output = Command::new(env!("CARGO_BIN_EXE_pack-setup"))
            .arg(self.file("stub.exe", &stub()))
            .arg(self.file("nsis.exe", &nsis()))
            .arg(self.file("Petalfall.exe", &exe()))
            .arg(version)
            .arg(&out)
            .output()
            .unwrap();
        assert!(output.status.success(), "{}", stderr(&output));
        out
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// 固定种子的 xorshift，失败时可复现；不引入随机数依赖。
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

/// 只有一个节的最小 PE，文件正好结束在节末端。
fn stub() -> Vec<u8> {
    const PE_AT: usize = 0x80;
    const SECTION_TABLE_AT: usize = PE_AT + 24;
    const RAW_POINTER: u32 = 0x400;
    const RAW_SIZE: u32 = 0x600;
    let mut pe = noise(3, (RAW_POINTER + RAW_SIZE) as usize);
    pe[..0x400].fill(0);
    pe[..2].copy_from_slice(b"MZ");
    pe[0x3C..0x40].copy_from_slice(&(PE_AT as u32).to_le_bytes());
    pe[PE_AT..PE_AT + 4].copy_from_slice(b"PE\0\0");
    pe[PE_AT + 6..PE_AT + 8].copy_from_slice(&1u16.to_le_bytes());
    pe[SECTION_TABLE_AT + 16..SECTION_TABLE_AT + 20].copy_from_slice(&RAW_SIZE.to_le_bytes());
    pe[SECTION_TABLE_AT + 20..SECTION_TABLE_AT + 24].copy_from_slice(&RAW_POINTER.to_le_bytes());
    pe
}

fn nsis() -> Vec<u8> {
    let mut bytes = b"MZ".to_vec();
    bytes.extend(noise(5, 4096));
    bytes
}

fn exe() -> Vec<u8> {
    let mut bytes = noise(7, 8192);
    bytes[1000..1000 + MARKER.len()].copy_from_slice(MARKER);
    bytes
}

/// 旧包的 136 字节头：按旧格式逐字段现场拼，pack-setup 已经不写这种头。
fn v1_header(header: &Header) -> Vec<u8> {
    let mut out = vec![0u8; 136];
    out[0..8].copy_from_slice(b"PFSETUP1");
    out[8..16].copy_from_slice(&header.payload_len.to_le_bytes());
    out[16..48].copy_from_slice(&header.payload_sha256);
    out[48..56].copy_from_slice(&header.exe_len.to_le_bytes());
    out[56..88].copy_from_slice(&header.exe_sha256);
    out[88..88 + header.version.len()].copy_from_slice(header.version.as_bytes());
    out
}

fn inspect(path: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_inspect-setup"))
        .arg(path)
        .output()
        .unwrap()
}

fn stdout(output: &Output) -> String {
    String::from_utf8(output.stdout.clone()).unwrap()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

/// 成功时退出码 0、stderr 不说话、stdout 恰好一行四列且行尾一个换行；返回四列。
fn columns(output: &Output) -> [String; 4] {
    assert_eq!(output.status.code(), Some(0), "{}", stderr(output));
    assert_eq!(stderr(output), "");
    let text = stdout(output);
    let line = text
        .strip_suffix('\n')
        .unwrap_or_else(|| panic!("行尾应是一个换行：{text:?}"));
    assert!(!line.contains(['\n', '\r']), "只能有一行：{text:?}");
    let columns: Vec<String> = line.split('\t').map(str::to_owned).collect();
    columns
        .try_into()
        .unwrap_or_else(|columns| panic!("应是四列：{columns:?}"))
}

/// 失败时退出码 1、stdout 一个字节也没有、stderr 带工具名和原因。
fn assert_refused(output: &Output, reason: &str) {
    assert_eq!(output.status.code(), Some(1), "应该失败：{output:?}");
    assert!(
        output.stdout.is_empty(),
        "失败时 stdout 不能有输出：{:?}",
        String::from_utf8_lossy(&output.stdout)
    );
    let stderr = stderr(output);
    assert!(stderr.starts_with("inspect-setup："), "{stderr}");
    assert!(stderr.contains(reason), "{stderr}");
}

#[test]
fn prints_the_four_fields_pack_setup_wrote() {
    let workspace = Workspace::new();
    let bundle = workspace.pack(VERSION);
    let before = fs::read(&bundle).unwrap();
    let written = locate(&mut Cursor::new(&before)).unwrap().header;

    let output = inspect(&bundle);
    assert_eq!(
        stdout(&output),
        format!("PFSETUP2\t{VERSION}\t{DATA_FORMAT}\t{SHIPPED_CAPS}\n")
    );
    let [magic, version, data_format, caps] = columns(&output);
    assert_eq!(magic, "PFSETUP2");
    assert_eq!(version, VERSION);
    let data_format: u32 = data_format.parse().unwrap();
    assert_eq!(data_format, DATA_FORMAT);
    assert_eq!(Some(data_format), written.data_format);
    let caps: u32 = caps.parse().unwrap();
    assert_eq!(caps & 1, 1, "第 0 位必须置上");
    assert_eq!(Some(caps), written.caps);

    assert_eq!(fs::read(&bundle).unwrap(), before, "只读，不能改动包");
}

#[test]
fn v1_bundle_prints_zero_data_format_and_zero_caps() {
    let workspace = Workspace::new();
    let packed = fs::read(workspace.pack(VERSION)).unwrap();
    let header = locate(&mut Cursor::new(&packed)).unwrap().header;
    // 旧头之后紧跟的是 NSIS 的 MZ 与随机字节，按新头读就会把它们当成号与能力位
    let nsis = nsis();
    assert_ne!(&nsis[..8], &[0u8; 8]);
    let old = [&stub()[..], &v1_header(&header), &nsis].concat();
    let path = workspace.file("Petalfall-Installer-v1.exe", &old);

    let output = inspect(&path);
    assert_eq!(stdout(&output), format!("PFSETUP1\t{VERSION}\t0\t0\n"));
    assert_eq!(columns(&output), ["PFSETUP1", VERSION, "0", "0"]);
}

#[test]
fn versions_read_back_verbatim_from_one_byte_to_the_full_field() {
    let prefix = "1.0.0-dev.";
    let longest = format!("{prefix}{}", "9".repeat(VERSION_FIELD_LEN - prefix.len()));
    assert_eq!(longest.len(), 48);
    let mut versions = vec![
        "1".to_owned(),
        "1.0.0".to_owned(),
        "1.0.0-dev.42".to_owned(),
        longest,
    ];
    versions.extend((1..=3u64).map(|seed| {
        let n = noise(seed, 4);
        format!("{}.{}.{}-beta.{}", n[0], n[1], n[2], u32::from(n[3]) * 1000)
    }));

    for version in versions {
        let workspace = Workspace::new();
        let output = inspect(&workspace.pack(&version));
        assert_eq!(
            stdout(&output),
            format!("PFSETUP2\t{version}\t{DATA_FORMAT}\t{SHIPPED_CAPS}\n")
        );
        assert_eq!(columns(&output)[1], version);
    }
}

#[test]
fn wrong_argument_count_prints_usage() {
    let workspace = Workspace::new();
    let bundle = workspace.pack(VERSION);
    // 多给一个参数时，哪怕第一个是好包也不打印
    for args in [vec![], vec![bundle.clone(), bundle]] {
        let output = Command::new(env!("CARGO_BIN_EXE_inspect-setup"))
            .args(&args)
            .output()
            .unwrap();
        assert_refused(&output, "用法：inspect-setup <引导程序路径>");
    }
}

#[test]
fn missing_file_names_the_path() {
    let workspace = Workspace::new();
    let output = inspect(&workspace.dir.join("no-such-setup.exe"));
    assert_refused(&output, "no-such-setup.exe");
    assert!(stderr(&output).contains("打开"), "{}", stderr(&output));
}

#[test]
fn files_without_a_payload_header_are_refused() {
    let workspace = Workspace::new();
    for (name, bytes, reason) in [
        ("stub.exe", stub(), "文件里没有载荷"),
        ("noise.bin", noise(17, 512), "不是有效的 PE 文件"),
        ("empty.exe", Vec::new(), "不是有效的 PE 文件"),
    ] {
        let path = workspace.file(name, &bytes);
        let output = inspect(&path);
        assert_refused(&output, reason);
        let stderr = stderr(&output);
        assert!(stderr.contains("读不出载荷头"), "{stderr}");
        assert!(stderr.contains(name), "{stderr}");
    }
}

#[test]
fn unknown_magic_is_refused() {
    let workspace = Workspace::new();
    let mut bundle = fs::read(workspace.pack(VERSION)).unwrap();
    let at = stub().len();
    assert_eq!(&bundle[at..at + 8], b"PFSETUP2");
    for magic in [b"PFSETUP3", b"PFSETUP0"] {
        bundle[at..at + 8].copy_from_slice(magic);
        let path = workspace.file("unknown-magic.exe", &bundle);
        assert_refused(&inspect(&path), "magic 不对");
    }
}

#[test]
fn truncated_bundle_is_refused() {
    let workspace = Workspace::new();
    let bundle = fs::read(workspace.pack(VERSION)).unwrap();
    // 载荷少最后一个字节；头本身断在中间；只剩不到一个 magic
    let stub_len = stub().len();
    for len in [bundle.len() - 1, stub_len + 140, stub_len + 7] {
        let path = workspace.file("cut.exe", &bundle[..len]);
        assert_refused(&inspect(&path), &format!("文件只有 {len} 字节"));
    }
}

#[test]
fn version_that_would_break_the_line_is_refused() {
    let workspace = Workspace::new();
    let nsis = nsis();
    for version in ["1.0.0\t2", "1.0.0-dev.42\n", "1.0.0\r"] {
        let header = Header::new(&nsis, b"exe", version).unwrap();
        let file = [&stub()[..], &header.to_bytes().unwrap(), &nsis].concat();
        let path = workspace.file("odd-version.exe", &file);
        assert_refused(&inspect(&path), "含制表符或换行");
    }
}
