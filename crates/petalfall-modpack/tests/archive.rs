use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use petalfall_modpack::{
    Error, PackFormat, PathValidationError, RemoteFiles, extract_overrides, read_pack,
};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

const MRPACK_INDEX: &[u8] =
    include_bytes!("fixtures/fabulously-optimized-14.1.1.modrinth.index.json");
const CF_MANIFEST: &[u8] = include_bytes!("fixtures/fabulously-optimized-14.1.1.manifest.json");

enum Entry<'a> {
    File(&'a str, &'a [u8]),
    Compressed(&'a str, &'a [u8], CompressionMethod),
    Dir(&'a str),
    Symlink(&'a str, &'a str),
}

fn write_zip(path: &Path, entries: &[Entry<'_>]) {
    let mut writer = ZipWriter::new(fs::File::create(path).unwrap());
    let options = SimpleFileOptions::default();
    for entry in entries {
        match entry {
            Entry::File(name, bytes) => {
                writer.start_file(*name, options).unwrap();
                writer.write_all(bytes).unwrap();
            }
            Entry::Compressed(name, bytes, method) => {
                writer
                    .start_file(*name, options.compression_method(*method))
                    .unwrap();
                writer.write_all(bytes).unwrap();
            }
            Entry::Dir(name) => writer.add_directory(*name, options).unwrap(),
            Entry::Symlink(name, target) => writer.add_symlink(*name, *target, options).unwrap(),
        }
    }
    writer.finish().unwrap();
}

fn pack(dir: &Path, file_name: &str, entries: &[Entry<'_>]) -> PathBuf {
    let path = dir.join(file_name);
    write_zip(&path, entries);
    path
}

fn never() -> bool {
    false
}

#[test]
fn mrpack_layers_client_overrides_over_overrides_and_ignores_server_overrides() {
    let tmp = tempfile::tempdir().unwrap();
    let path = pack(
        tmp.path(),
        "fo.mrpack",
        &[
            Entry::File("modrinth.index.json", MRPACK_INDEX),
            Entry::Dir("overrides/"),
            Entry::Dir("overrides/config/"),
            Entry::File("overrides/config/sodium.json", b"base"),
            Entry::File("overrides/options.txt", b"fov:70"),
            Entry::File("client-overrides/config/Sodium.json", b"client"),
            Entry::File("server-overrides/server.properties", b"motd=x"),
            Entry::File("README.md", b"not an override"),
        ],
    );

    let archive = read_pack(&path).unwrap();
    assert_eq!(archive.manifest.format, PackFormat::Modrinth);
    assert_eq!(archive.manifest.minecraft, "26.2");
    assert_eq!(archive.manifest.remote.len(), 3);
    let landed: Vec<_> = archive
        .overrides
        .iter()
        .map(|e| (e.path.as_str(), e.size))
        .collect();
    // 只差大小写的两条按 Windows 视为同一个文件，client-overrides 那份胜出。
    assert_eq!(landed, vec![("options.txt", 6), ("config/Sodium.json", 6)]);
    assert_eq!(archive.overrides_bytes, 12);

    let dest = tmp.path().join("instance");
    fs::create_dir(&dest).unwrap();
    let written = extract_overrides(&path, &archive.overrides, &dest, &never).unwrap();
    assert_eq!(written, 2);
    assert_eq!(fs::read(dest.join("options.txt")).unwrap(), b"fov:70");
    assert_eq!(
        fs::read(dest.join("config").join("Sodium.json")).unwrap(),
        b"client"
    );
    assert!(!dest.join("server.properties").exists());
    assert!(!dest.join("README.md").exists());
}

#[test]
fn curseforge_zip_uses_manifest_overrides_dir_and_overwrites_existing_files() {
    let tmp = tempfile::tempdir().unwrap();
    let path = pack(
        tmp.path(),
        "fo-cf.zip",
        &[
            Entry::File("manifest.json", CF_MANIFEST),
            Entry::File("modlist.html", b"<ul></ul>"),
            Entry::File("overrides/mods/bundled.jar", b"jar-bytes"),
            Entry::File("overrides/saves/Map/level.dat", b"level"),
        ],
    );

    let archive = read_pack(&path).unwrap();
    assert_eq!(archive.manifest.format, PackFormat::CurseForge);
    let RemoteFiles::CurseForge(files) = &archive.manifest.remote else {
        panic!("应为 CurseForge 文件");
    };
    assert_eq!(files.len(), 3);
    let paths: Vec<_> = archive.overrides.iter().map(|e| e.path.as_str()).collect();
    assert_eq!(paths, vec!["mods/bundled.jar", "saves/Map/level.dat"]);

    let dest = tmp.path().join("instance");
    fs::create_dir_all(dest.join("mods")).unwrap();
    fs::write(dest.join("mods").join("bundled.jar"), b"downloaded-earlier").unwrap();
    extract_overrides(&path, &archive.overrides, &dest, &never).unwrap();
    assert_eq!(
        fs::read(dest.join("mods").join("bundled.jar")).unwrap(),
        b"jar-bytes"
    );
    assert_eq!(
        fs::read(dest.join("saves").join("Map").join("level.dat")).unwrap(),
        b"level"
    );
}

#[test]
fn format_follows_content_not_extension() {
    let tmp = tempfile::tempdir().unwrap();
    let renamed = pack(
        tmp.path(),
        "renamed.ZIP",
        &[Entry::File("modrinth.index.json", MRPACK_INDEX)],
    );
    assert_eq!(
        read_pack(&renamed).unwrap().manifest.format,
        PackFormat::Modrinth
    );
}

#[test]
fn rejects_wrong_extension_missing_manifest_and_non_zip() {
    let tmp = tempfile::tempdir().unwrap();
    let jar = pack(
        tmp.path(),
        "pack.jar",
        &[Entry::File("modrinth.index.json", MRPACK_INDEX)],
    );
    assert!(matches!(
        read_pack(&jar),
        Err(Error::UnsupportedExtension { path }) if path == jar
    ));

    let empty = pack(
        tmp.path(),
        "empty.mrpack",
        &[Entry::File("overrides/a.txt", b"a")],
    );
    assert!(matches!(
        read_pack(&empty),
        Err(Error::ManifestMissing { path }) if path == empty
    ));

    // 清单不在根目录也不算：格式约定只认根目录。
    let nested = pack(
        tmp.path(),
        "nested.zip",
        &[Entry::File("pack/manifest.json", CF_MANIFEST)],
    );
    assert!(matches!(
        read_pack(&nested),
        Err(Error::ManifestMissing { .. })
    ));

    let garbage = tmp.path().join("garbage.zip");
    fs::write(&garbage, b"this is not a zip archive at all").unwrap();
    assert!(matches!(read_pack(&garbage), Err(Error::Corrupt { .. })));

    let missing = tmp.path().join("missing.mrpack");
    assert!(matches!(read_pack(&missing), Err(Error::Io { path, .. }) if path == missing));
}

#[test]
fn rejects_overrides_escaping_instance_or_entering_launcher_metadata() {
    let tmp = tempfile::tempdir().unwrap();
    let traversal = pack(
        tmp.path(),
        "traversal.mrpack",
        &[
            Entry::File("modrinth.index.json", MRPACK_INDEX),
            Entry::File("overrides/../../evil.txt", b"x"),
        ],
    );
    assert!(matches!(
        read_pack(&traversal),
        Err(Error::UnsafePath {
            source: PathValidationError::ParentTraversal,
            ..
        })
    ));

    let meta_entry = format!(
        "overrides/{}/modpack.json",
        petalfall_instance::PETALFALL_META_DIR.to_uppercase()
    );
    let meta = pack(
        tmp.path(),
        "meta.mrpack",
        &[
            Entry::File("modrinth.index.json", MRPACK_INDEX),
            Entry::File(&meta_entry, b"{}"),
        ],
    );
    assert!(matches!(
        read_pack(&meta),
        Err(Error::UnsafePath { source: PathValidationError::ProtectedTopLevel { .. }, path })
            if path == meta_entry
    ));

    let device = pack(
        tmp.path(),
        "device.zip",
        &[
            Entry::File("manifest.json", CF_MANIFEST),
            Entry::File("overrides/config/CON.txt", b"x"),
        ],
    );
    assert!(matches!(
        read_pack(&device),
        Err(Error::UnsafePath {
            source: PathValidationError::ReservedName { .. },
            ..
        })
    ));
}

#[test]
fn rejects_symlink_entries_and_same_layer_case_duplicates() {
    let tmp = tempfile::tempdir().unwrap();
    let link = pack(
        tmp.path(),
        "link.mrpack",
        &[
            Entry::File("modrinth.index.json", MRPACK_INDEX),
            Entry::Symlink("overrides/config", "C:/Windows/System32"),
        ],
    );
    assert!(matches!(
        read_pack(&link),
        Err(Error::SymlinkEntry { path }) if path == "overrides/config"
    ));

    let duplicate = pack(
        tmp.path(),
        "dup.mrpack",
        &[
            Entry::File("modrinth.index.json", MRPACK_INDEX),
            Entry::File("overrides/options.txt", b"a"),
            Entry::File("overrides/OPTIONS.txt", b"b"),
        ],
    );
    assert!(matches!(
        read_pack(&duplicate),
        Err(Error::DuplicatePath { path }) if path == "overrides/OPTIONS.txt"
    ));
}

#[test]
fn rejects_oversized_manifest() {
    let tmp = tempfile::tempdir().unwrap();
    // 有效 JSON 后面跟 17 MiB 空白：语法上合法，靠大小上限拦下。
    let mut bloated = MRPACK_INDEX.to_vec();
    bloated.extend(std::iter::repeat_n(b' ', 17 * 1024 * 1024));
    let path = pack(
        tmp.path(),
        "bloated.mrpack",
        &[Entry::File("modrinth.index.json", &bloated)],
    );
    assert!(matches!(
        read_pack(&path),
        Err(Error::ManifestInvalid { document: "modrinth.index.json", reason }) if reason.contains("16 MiB")
    ));
}

#[test]
fn extraction_stops_when_cancelled_and_detects_a_swapped_pack() {
    let tmp = tempfile::tempdir().unwrap();
    let path = pack(
        tmp.path(),
        "pack.mrpack",
        &[
            Entry::File("modrinth.index.json", MRPACK_INDEX),
            Entry::File("overrides/a.txt", b"a"),
            Entry::File("overrides/b.txt", b"b"),
            Entry::File("overrides/c.txt", b"c"),
        ],
    );
    let archive = read_pack(&path).unwrap();
    let dest = tmp.path().join("instance");
    fs::create_dir(&dest).unwrap();

    let calls = std::cell::Cell::new(0);
    let cancel_after_two = || {
        calls.set(calls.get() + 1);
        calls.get() > 2
    };
    assert!(matches!(
        extract_overrides(&path, &archive.overrides, &dest, &cancel_after_two),
        Err(Error::Cancelled)
    ));
    assert!(dest.join("a.txt").exists());
    assert!(dest.join("b.txt").exists());
    assert!(!dest.join("c.txt").exists());

    // 读完清单后文件被换成条目顺序不同的另一个包：按序号取到的不是原来那条，必须报错而不是解错文件。
    write_zip(
        &path,
        &[
            Entry::File("modrinth.index.json", MRPACK_INDEX),
            Entry::File("overrides/c.txt", b"c"),
            Entry::File("overrides/b.txt", b"b"),
            Entry::File("overrides/a.txt", b"a"),
        ],
    );
    assert!(matches!(
        extract_overrides(&path, &archive.overrides, &dest, &never),
        Err(Error::Corrupt { .. })
    ));
}

/// 取消宽限期满时任务的 future 被丢弃，解压线程却还在跑；一个大文件解到底才停的话，它会一直往调用方
/// 正在清理的目录里写。
#[test]
fn extraction_stops_inside_a_single_large_entry() {
    let tmp = tempfile::tempdir().unwrap();
    let body = sample_bytes(4 * 1024 * 1024, 7);
    let path = pack(
        tmp.path(),
        "big.mrpack",
        &[
            Entry::File("modrinth.index.json", MRPACK_INDEX),
            Entry::File("overrides/saves/世界 一/region.bin", &body),
        ],
    );
    let archive = read_pack(&path).unwrap();
    let dest = tmp.path().join("实例 目录");
    fs::create_dir(&dest).unwrap();

    let calls = std::cell::Cell::new(0);
    let cancel_once_started = || {
        calls.set(calls.get() + 1);
        calls.get() > 1
    };
    assert!(matches!(
        extract_overrides(&path, &archive.overrides, &dest, &cancel_once_started),
        Err(Error::Cancelled)
    ));
    let written = fs::metadata(dest.join("saves").join("世界 一").join("region.bin"))
        .unwrap()
        .len();
    assert!(written < body.len() as u64, "写出了 {written} 字节");

    // 不取消时大文件逐字节解全。
    extract_overrides(&path, &archive.overrides, &dest, &never).unwrap();
    assert_eq!(
        fs::read(dest.join("saves").join("世界 一").join("region.bin")).unwrap(),
        body
    );
}

#[test]
fn extracts_a_thousand_entries_promptly() {
    let tmp = tempfile::tempdir().unwrap();
    let names: Vec<String> = (0..1000)
        .map(|i| format!("overrides/config/group{:02}/sub/file{i:04}.json", i % 40))
        .collect();
    let bodies: Vec<String> = (0..1000).map(|i| format!("{{\"n\":{i}}}")).collect();
    let mut entries = vec![Entry::File("modrinth.index.json", MRPACK_INDEX)];
    for (name, body) in names.iter().zip(&bodies) {
        entries.push(Entry::File(name, body.as_bytes()));
    }
    let path = pack(tmp.path(), "big.mrpack", &entries);

    let archive = read_pack(&path).unwrap();
    assert_eq!(archive.overrides.len(), 1000);
    let dest = tmp.path().join("instance");
    fs::create_dir(&dest).unwrap();

    let started = Instant::now();
    let written = extract_overrides(&path, &archive.overrides, &dest, &never).unwrap();
    let elapsed = started.elapsed();
    eprintln!("1000 个覆盖文件解压耗时 {elapsed:?}");
    assert_eq!(written, 1000);
    assert_eq!(
        fs::read_to_string(
            dest.join("config")
                .join("group07")
                .join("sub")
                .join("file0847.json")
        )
        .unwrap(),
        "{\"n\":847}"
    );
    // 上限放得很宽，只拦每个条目都去逐级检查祖先目录那种量级的退化。
    assert!(elapsed < Duration::from_secs(20), "{elapsed:?}");
}

/// 把名为 `name` 的条目在本地头与中央目录里的压缩方法编号改成 `method`，模拟启动器解不了的压缩方式。
/// 数据本身按 Stored 写入，只改编号。
fn patch_method(path: &Path, name: &str, method: u16) {
    let mut bytes = fs::read(path).unwrap();
    let name = name.as_bytes();
    let mut patched = 0;
    for i in 0..bytes.len().saturating_sub(46) {
        // 本地头：方法在 +8，名字长度在 +26，名字从 +30 开始；中央目录：方法 +10，名字长度 +28，名字 +46。
        let (method_at, len_at, name_at) = match &bytes[i..i + 4] {
            b"PK\x03\x04" => (8, 26, 30),
            b"PK\x01\x02" => (10, 28, 46),
            _ => continue,
        };
        let len = u16::from_le_bytes([bytes[i + len_at], bytes[i + len_at + 1]]) as usize;
        if bytes.get(i + name_at..i + name_at + len) == Some(name) {
            bytes[i + method_at..i + method_at + 2].copy_from_slice(&method.to_le_bytes());
            patched += 1;
        }
    }
    assert_eq!(patched, 2, "本地头与中央目录各一处");
    fs::write(path, bytes).unwrap();
}

/// 把条目名里的 ASCII 占位字节原样换成 `raw`（长度相同，本地头与中央目录各一处）。占位名是 ASCII，
/// zip 写入时不设 UTF-8 标志，换完就是不带标志、名字为任意字节的条目。
fn patch_name(path: &Path, placeholder: &str, raw: &[u8]) {
    assert_eq!(placeholder.len(), raw.len());
    let mut bytes = fs::read(path).unwrap();
    let needle = placeholder.as_bytes();
    let mut patched = 0;
    let mut i = 0;
    while i + needle.len() <= bytes.len() {
        if &bytes[i..i + needle.len()] == needle {
            bytes[i..i + needle.len()].copy_from_slice(raw);
            patched += 1;
            i += needle.len();
        } else {
            i += 1;
        }
    }
    assert_eq!(patched, 2, "本地头与中央目录各一处");
    fs::write(path, bytes).unwrap();
}

/// 固定种子的伪随机字节，与重复内容交替，让各压缩方式都有东西可压。
fn sample_bytes(len: usize, seed: u64) -> Vec<u8> {
    let mut state = seed | 1;
    (0..len)
        .map(|i| {
            if (i / 4096) % 2 == 0 {
                b"petal "[i % 6]
            } else {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                state as u8
            }
        })
        .collect()
}

/// zip 自己解出的条目名与压缩方式。
fn raw_entries(path: &Path) -> Vec<(String, CompressionMethod)> {
    let mut archive = ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
    (0..archive.len())
        .map(|i| {
            let file = archive.by_index_raw(i).unwrap();
            (file.name().to_owned(), file.compression())
        })
        .collect()
}

#[test]
fn bzip2_xz_and_ppmd_overrides_extract_byte_for_byte() {
    let tmp = tempfile::tempdir().unwrap();
    // 跨过解压循环 64 KiB 缓冲区的大文件、空文件、1 字节文件都要有。
    let big = sample_bytes(300 * 1024 + 7, 0x51);
    let medium = sample_bytes(70_000, 0x52);
    let small = sample_bytes(1, 0x53);
    let path = pack(
        tmp.path(),
        "methods.zip",
        &[
            Entry::File("manifest.json", CF_MANIFEST),
            Entry::Compressed("overrides/config/big.bin", &big, CompressionMethod::Bzip2),
            Entry::Compressed("overrides/empty.txt", b"", CompressionMethod::Bzip2),
            Entry::Compressed(
                "overrides/config/medium.bin",
                &medium,
                CompressionMethod::Xz,
            ),
            Entry::Compressed("overrides/one.bin", &small, CompressionMethod::Ppmd),
        ],
    );
    // 确认写进去的真是这几种方法，不是写入端悄悄退回了 Stored。
    let methods: Vec<_> = raw_entries(&path).into_iter().map(|(_, m)| m).collect();
    assert_eq!(
        methods[1..],
        [
            CompressionMethod::Bzip2,
            CompressionMethod::Bzip2,
            CompressionMethod::Xz,
            CompressionMethod::Ppmd
        ]
    );

    let archive = read_pack(&path).unwrap();
    let listed: Vec<_> = archive
        .overrides
        .iter()
        .map(|e| (e.path.as_str(), e.size))
        .collect();
    assert_eq!(
        listed,
        vec![
            ("config/big.bin", big.len() as u64),
            ("empty.txt", 0),
            ("config/medium.bin", medium.len() as u64),
            ("one.bin", 1),
        ]
    );
    assert_eq!(
        archive.overrides_bytes,
        (big.len() + medium.len() + 1) as u64
    );

    let dest = tmp.path().join("instance");
    fs::create_dir(&dest).unwrap();
    assert_eq!(
        extract_overrides(&path, &archive.overrides, &dest, &never).unwrap(),
        4
    );
    assert_eq!(fs::read(dest.join("config").join("big.bin")).unwrap(), big);
    assert_eq!(fs::read(dest.join("empty.txt")).unwrap(), b"");
    assert_eq!(
        fs::read(dest.join("config").join("medium.bin")).unwrap(),
        medium
    );
    assert_eq!(fs::read(dest.join("one.bin")).unwrap(), small);
}

#[test]
fn zstd_override_is_reported_as_unsupported_compression_with_method_and_entry() {
    let tmp = tempfile::tempdir().unwrap();
    let entries = [
        Entry::File("manifest.json", CF_MANIFEST),
        Entry::File("overrides/options.txt", b"fov:70"),
        Entry::Compressed(
            "overrides/config/fast.txt",
            b"zstd-bytes",
            CompressionMethod::Stored,
        ),
    ];
    let path = pack(tmp.path(), "zstd.zip", &entries);
    patch_method(&path, "overrides/config/fast.txt", 93);
    let err = read_pack(&path).unwrap_err();
    assert!(
        matches!(
            &err,
            Error::UnsupportedCompression { path: p, entry, method: 93 }
                if *p == path && entry == "overrides/config/fast.txt"
        ),
        "{err:?}"
    );
    assert_eq!(
        err.to_string(),
        "整合包用了不支持的压缩方式（方法编号 93）：overrides/config/fast.txt"
    );

    // 读包之后才被换成 Zstd 条目的，解压时同样按不支持的压缩方式报，而不是算包损坏。
    let swapped = pack(tmp.path(), "swapped.zip", &entries);
    let archive = read_pack(&swapped).unwrap();
    patch_method(&swapped, "overrides/config/fast.txt", 93);
    let dest = tmp.path().join("instance");
    fs::create_dir(&dest).unwrap();
    assert!(matches!(
        extract_overrides(&swapped, &archive.overrides, &dest, &never),
        Err(Error::UnsupportedCompression { method: 93, entry, .. })
            if entry == "overrides/config/fast.txt"
    ));

    // 清单本身解不了，报清单的条目名；不认识的方法编号也走同一条路。
    let manifest = pack(
        tmp.path(),
        "manifest.mrpack",
        &[Entry::Compressed(
            "modrinth.index.json",
            MRPACK_INDEX,
            CompressionMethod::Stored,
        )],
    );
    patch_method(&manifest, "modrinth.index.json", 77);
    assert!(matches!(
        read_pack(&manifest),
        Err(Error::UnsupportedCompression { method: 77, entry, .. }) if entry == "modrinth.index.json"
    ));
}

#[test]
fn unsupported_entries_that_are_never_extracted_do_not_reject_the_pack() {
    let tmp = tempfile::tempdir().unwrap();
    let path = pack(
        tmp.path(),
        "shadowed.mrpack",
        &[
            Entry::File("modrinth.index.json", MRPACK_INDEX),
            Entry::Compressed("README.md", b"readme", CompressionMethod::Stored),
            Entry::Compressed("overrides/options.txt", b"base", CompressionMethod::Stored),
            Entry::File("client-overrides/options.txt", b"client"),
        ],
    );
    // 不在覆盖层里的条目、被上层盖掉的条目都不会被解压，用了什么压缩方式与安装无关。
    patch_method(&path, "README.md", 93);
    patch_method(&path, "overrides/options.txt", 93);
    let archive = read_pack(&path).unwrap();
    let names: Vec<_> = archive
        .overrides
        .iter()
        .map(|e| e.entry_name.as_str())
        .collect();
    assert_eq!(names, vec!["client-overrides/options.txt"]);
    let dest = tmp.path().join("instance");
    fs::create_dir(&dest).unwrap();
    extract_overrides(&path, &archive.overrides, &dest, &never).unwrap();
    assert_eq!(fs::read(dest.join("options.txt")).unwrap(), b"client");
}

/// 「配置/中文.txt」的 GBK 字节。
const GBK_CONFIG_NAME: &[u8] = &[
    0xC5, 0xE4, 0xD6, 0xC3, b'/', 0xD6, 0xD0, 0xCE, 0xC4, b'.', b't', b'x', b't',
];

#[test]
fn entry_names_decode_as_utf8_then_gbk_then_cp437() {
    let tmp = tempfile::tempdir().unwrap();
    let path = pack(
        tmp.path(),
        "names.zip",
        &[
            Entry::File("manifest.json", CF_MANIFEST),
            Entry::File("overrides/QQQQ/WWWW.txt", b"gbk"),
            Entry::File("overrides/mods/UUUUUU.jar", b"utf8"),
            Entry::File("overrides/cp/legacy#.txt", b"cp437"),
        ],
    );
    patch_name(&path, "QQQQ/WWWW.txt", GBK_CONFIG_NAME);
    // 不设 UTF-8 标志却直接写 UTF-8 字节（不少 Java 打包器如此）。
    patch_name(&path, "UUUUUU", "中文".as_bytes());
    // 0xFF 既不是合法 UTF-8 也不是 GBK 的首字节，只能按 CP437 解（U+00A0）。
    patch_name(&path, "legacy#", b"legacy\xFF");

    // zip 自己按 CP437 解，前两个都是乱码：这正是要修的问题。
    let zip_names: Vec<_> = raw_entries(&path).into_iter().map(|(n, _)| n).collect();
    assert!(
        !zip_names.iter().any(|n| n.contains("中文")),
        "{zip_names:?}"
    );

    let archive = read_pack(&path).unwrap();
    let listed: Vec<_> = archive
        .overrides
        .iter()
        .map(|e| (e.entry_name.as_str(), e.path.as_str()))
        .collect();
    assert_eq!(
        listed,
        vec![
            ("overrides/配置/中文.txt", "配置/中文.txt"),
            ("overrides/mods/中文.jar", "mods/中文.jar"),
            ("overrides/cp/legacy\u{a0}.txt", "cp/legacy\u{a0}.txt"),
        ]
    );

    let dest = tmp.path().join("instance");
    fs::create_dir(&dest).unwrap();
    assert_eq!(
        extract_overrides(&path, &archive.overrides, &dest, &never).unwrap(),
        3
    );
    assert_eq!(
        fs::read(dest.join("配置").join("中文.txt")).unwrap(),
        b"gbk"
    );
    assert_eq!(
        fs::read(dest.join("mods").join("中文.jar")).unwrap(),
        b"utf8"
    );
    assert_eq!(
        fs::read(dest.join("cp").join("legacy\u{a0}.txt")).unwrap(),
        b"cp437"
    );
}

#[test]
fn utf8_and_gbk_spellings_of_the_same_name_in_one_layer_are_duplicates() {
    let tmp = tempfile::tempdir().unwrap();
    let path = pack(
        tmp.path(),
        "dup-names.zip",
        &[
            Entry::File("manifest.json", CF_MANIFEST),
            // 非 ASCII 名字，zip 写入时设 UTF-8 标志。
            Entry::File("overrides/中文.txt", b"utf8"),
            Entry::File("overrides/QQQQ.txt", b"gbk"),
        ],
    );
    patch_name(&path, "QQQQ", &GBK_CONFIG_NAME[5..9]);
    // zip 眼里这是两个不同的名字。
    let zip_names: Vec<_> = raw_entries(&path).into_iter().map(|(n, _)| n).collect();
    assert_eq!(zip_names.len(), 3);
    assert_ne!(zip_names[1], zip_names[2]);

    assert!(matches!(
        read_pack(&path),
        Err(Error::DuplicatePath { path }) if path == "overrides/中文.txt"
    ));
}
