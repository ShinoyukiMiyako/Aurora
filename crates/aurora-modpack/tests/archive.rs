use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use aurora_modpack::{
    Error, PackFormat, PathValidationError, RemoteFiles, extract_overrides, read_pack,
};
use zip::ZipWriter;
use zip::write::SimpleFileOptions;

const MRPACK_INDEX: &[u8] =
    include_bytes!("fixtures/fabulously-optimized-14.1.1.modrinth.index.json");
const CF_MANIFEST: &[u8] = include_bytes!("fixtures/fabulously-optimized-14.1.1.manifest.json");

enum Entry<'a> {
    File(&'a str, &'a [u8]),
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
        aurora_instance::AURORA_META_DIR.to_uppercase()
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
