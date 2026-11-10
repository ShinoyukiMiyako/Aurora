//! 按 CI 的调用方式跑 pack-setup：真实进程、真实文件、看退出码和错误输出。

use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};

use petalfall_release::data_format::DATA_FORMAT;
use petalfall_setup_payload::{
    CAP_CHANNEL_SWITCH, HEADER_LEN_V2, Header, SHIPPED_CAPS, VERSION_FIELD_LEN, locate, sha256,
};

const MARKER: &[u8] = b"__TAURI_BUNDLE_TYPE_VAR_UNK";
const MARKER_NSIS: &[u8] = b"__TAURI_BUNDLE_TYPE_VAR_NSS";
const VERSION: &str = "0.2.0-dev.42";

/// 放在 cargo 给集成测试的目录里，不碰系统临时目录。
struct Workspace {
    dir: PathBuf,
}

impl Workspace {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!(
            "pack-setup-{}-{}",
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

    fn out(&self) -> PathBuf {
        self.dir.join("Petalfall-Installer-x64.exe")
    }

    fn pack(&self, stub: &[u8], nsis: &[u8], exe: &[u8], version: &str) -> Output {
        Command::new(env!("CARGO_BIN_EXE_pack-setup"))
            .arg(self.file("stub.exe", stub))
            .arg(self.file("nsis.exe", nsis))
            .arg(self.file("Petalfall.exe", exe))
            .arg(version)
            .arg(self.out())
            .output()
            .unwrap()
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn assert_rejected(output: &Output, workspace: &Workspace, reason: &str) {
    assert!(!output.status.success(), "应该失败：{output:?}");
    assert!(stderr(output).contains(reason), "{}", stderr(output));
    assert!(!workspace.out().exists(), "失败时不能留下首装包");
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

fn exe_with_marker(seed: u64, len: usize, at: usize) -> Vec<u8> {
    let mut bytes = noise(seed, len);
    bytes[at..at + MARKER.len()].copy_from_slice(MARKER);
    bytes
}

fn exe() -> Vec<u8> {
    exe_with_marker(7, 8192, 1000)
}

#[test]
fn bundle_is_stub_then_header_then_nsis_bytes() {
    let workspace = Workspace::new();
    let (stub, nsis, exe) = (stub(), nsis(), exe());
    let output = workspace.pack(&stub, &nsis, &exe, VERSION);
    assert!(output.status.success(), "{}", stderr(&output));

    let bundle = fs::read(workspace.out()).unwrap();
    assert_eq!(HEADER_LEN_V2, 144);
    assert_eq!(bundle.len(), stub.len() + 144 + nsis.len());
    assert_eq!(&bundle[..stub.len()], &stub[..]);
    assert_eq!(&bundle[stub.len() + 144..], &nsis[..]);

    let header = Header::parse(&bundle[stub.len()..]).unwrap();
    assert_eq!(header.payload_len, nsis.len() as u64);
    assert_eq!(header.payload_sha256, sha256(&nsis));
    assert_eq!(header.version, VERSION);
    assert_eq!(header.data_format, Some(DATA_FORMAT));
    assert_eq!(header.caps, Some(SHIPPED_CAPS));

    let located = locate(&mut Cursor::new(&bundle)).unwrap();
    assert_eq!(located.payload_offset, (stub.len() + 144) as u64);
    assert_eq!(located.header, header);
    assert!(
        !workspace
            .dir
            .join("Petalfall-Installer-x64.exe.partial")
            .exists(),
        "成功后不留中间文件"
    );
}

#[test]
fn header_carries_this_builds_data_format_and_the_channel_switch_bit_at_fixed_offsets() {
    let workspace = Workspace::new();
    let stub = stub();
    let output = workspace.pack(&stub, &nsis(), &exe(), VERSION);
    assert!(output.status.success(), "{}", stderr(&output));

    let bundle = fs::read(workspace.out()).unwrap();
    let raw = &bundle[stub.len()..stub.len() + 144];
    assert_eq!(&raw[0..8], b"PFSETUP2");
    assert_eq!(&raw[136..140], &DATA_FORMAT.to_le_bytes());
    let caps = u32::from_le_bytes(raw[140..144].try_into().unwrap());
    assert_eq!(caps & 1, 1, "第 0 位必须置上");
    assert_eq!(CAP_CHANNEL_SWITCH, 1);
    assert_eq!(caps, SHIPPED_CAPS);

    let summary = String::from_utf8_lossy(&output.stdout);
    assert!(
        summary.contains(&format!("数据格式号 {DATA_FORMAT}，能力位 {SHIPPED_CAPS}")),
        "{summary}"
    );
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

#[test]
fn older_v1_bundles_still_locate_with_no_data_format_and_no_caps() {
    let workspace = Workspace::new();
    let (stub, nsis) = (stub(), nsis());
    let output = workspace.pack(&stub, &nsis, &exe(), VERSION);
    assert!(output.status.success(), "{}", stderr(&output));
    let packed = locate(&mut Cursor::new(fs::read(workspace.out()).unwrap()))
        .unwrap()
        .header;

    let old = [&stub[..], &v1_header(&packed), &nsis].concat();
    let located = locate(&mut Cursor::new(&old)).unwrap();
    assert_eq!(located.payload_offset, (stub.len() + 136) as u64);
    assert_eq!(&old[located.payload_offset as usize..], &nsis[..]);
    assert_eq!(located.header.version, VERSION);
    assert_eq!(located.header.payload_sha256, sha256(&nsis));
    assert_eq!(located.header.exe_sha256, packed.exe_sha256);
    assert_eq!(located.header.data_format, None);
    assert_eq!(located.header.caps, None);
}

#[test]
fn exe_expectation_is_the_bytes_nsis_will_install_not_the_build_output() {
    let len = 2048;
    // 标记贴着开头、贴着结尾和落在随机位置都要命中
    let mut positions = vec![0, len - MARKER.len()];
    positions.extend(
        noise(11, 16)
            .iter()
            .map(|byte| usize::from(*byte) * 7 % (len - MARKER.len())),
    );
    for (seed, at) in positions.into_iter().enumerate() {
        let workspace = Workspace::new();
        let exe = exe_with_marker(seed as u64 + 13, len, at);
        let mut installed = exe.clone();
        installed[at..at + MARKER.len()].copy_from_slice(MARKER_NSIS);

        let output = workspace.pack(&stub(), &nsis(), &exe, VERSION);
        assert!(output.status.success(), "{}", stderr(&output));

        let bundle = fs::read(workspace.out()).unwrap();
        let header = locate(&mut Cursor::new(&bundle)).unwrap().header;
        assert_eq!(header.exe_len, len as u64);
        assert_eq!(header.exe_sha256, sha256(&installed));
        assert_ne!(header.exe_sha256, sha256(&exe));
    }
}

#[test]
fn stub_with_anything_after_its_sections_is_rejected() {
    let mut one_extra_byte = stub();
    one_extra_byte.push(0);
    let workspace = Workspace::new();
    assert_rejected(
        &workspace.pack(&one_extra_byte, &nsis(), &exe(), VERSION),
        &workspace,
        "节末端",
    );
}

#[test]
fn packing_an_already_packed_stub_is_rejected() {
    let first = Workspace::new();
    let output = first.pack(&stub(), &nsis(), &exe(), VERSION);
    assert!(output.status.success(), "{}", stderr(&output));
    let packed = fs::read(first.out()).unwrap();

    let second = Workspace::new();
    assert_rejected(
        &second.pack(&packed, &nsis(), &exe(), VERSION),
        &second,
        "节末端",
    );
}

#[test]
fn stub_that_is_not_a_pe_is_rejected() {
    let workspace = Workspace::new();
    assert_rejected(
        &workspace.pack(&noise(17, 512), &nsis(), &exe(), VERSION),
        &workspace,
        "PE",
    );
}

#[test]
fn payload_must_start_with_mz() {
    let mut not_pe = nsis();
    not_pe[1] = b'X';
    for payload in [not_pe, b"M".to_vec(), Vec::new()] {
        let workspace = Workspace::new();
        assert_rejected(
            &workspace.pack(&stub(), &payload, &exe(), VERSION),
            &workspace,
            "MZ",
        );
    }
}

#[test]
fn version_of_exactly_48_bytes_fits() {
    let workspace = Workspace::new();
    let version = "1".repeat(VERSION_FIELD_LEN);
    let output = workspace.pack(&stub(), &nsis(), &exe(), &version);
    assert!(output.status.success(), "{}", stderr(&output));
    let bundle = fs::read(workspace.out()).unwrap();
    assert_eq!(
        locate(&mut Cursor::new(&bundle)).unwrap().header.version,
        version
    );
}

#[test]
fn version_over_48_bytes_is_rejected() {
    let workspace = Workspace::new();
    assert_rejected(
        &workspace.pack(&stub(), &nsis(), &exe(), &"1".repeat(VERSION_FIELD_LEN + 1)),
        &workspace,
        "超过上限",
    );
}

#[test]
fn empty_version_is_rejected() {
    let workspace = Workspace::new();
    assert_rejected(
        &workspace.pack(&stub(), &nsis(), &exe(), ""),
        &workspace,
        "为空",
    );
}

#[test]
fn exe_without_the_marker_is_rejected() {
    let workspace = Workspace::new();
    assert_rejected(
        &workspace.pack(&stub(), &nsis(), &noise(19, 4096), VERSION),
        &workspace,
        "出现 0 次",
    );
}

#[test]
fn exe_already_patched_by_the_bundler_is_rejected() {
    // 没有占位符说明取错了文件，算出来的长度和哈希不能当真
    let mut patched = exe();
    patched[1000..1000 + MARKER.len()].copy_from_slice(MARKER_NSIS);
    let workspace = Workspace::new();
    assert_rejected(
        &workspace.pack(&stub(), &nsis(), &patched, VERSION),
        &workspace,
        "出现 0 次",
    );
}

#[test]
fn exe_with_two_markers_is_rejected() {
    let mut twice = exe();
    twice[5000..5000 + MARKER.len()].copy_from_slice(MARKER);
    let workspace = Workspace::new();
    assert_rejected(
        &workspace.pack(&stub(), &nsis(), &twice, VERSION),
        &workspace,
        "出现 2 次",
    );
}

#[test]
fn failed_run_keeps_the_previous_bundle_untouched() {
    let workspace = Workspace::new();
    workspace.file("Petalfall-Installer-x64.exe", b"previous");
    let output = workspace.pack(&stub(), &noise(23, 64), &exe(), VERSION);
    assert!(!output.status.success());
    assert_eq!(fs::read(workspace.out()).unwrap(), b"previous");
}

#[test]
fn missing_input_names_the_file() {
    let workspace = Workspace::new();
    let missing = workspace.dir.join("no-such-nsis.exe");
    let output = Command::new(env!("CARGO_BIN_EXE_pack-setup"))
        .arg(workspace.file("stub.exe", &stub()))
        .arg(&missing)
        .arg(workspace.file("Petalfall.exe", &exe()))
        .arg(VERSION)
        .arg(workspace.out())
        .output()
        .unwrap();
    assert_rejected(&output, &workspace, "no-such-nsis.exe");
}

#[test]
fn wrong_argument_count_prints_usage() {
    let workspace = Workspace::new();
    let output = Command::new(env!("CARGO_BIN_EXE_pack-setup"))
        .arg(workspace.file("stub.exe", &stub()))
        .output()
        .unwrap();
    assert_rejected(&output, &workspace, "用法");
}
