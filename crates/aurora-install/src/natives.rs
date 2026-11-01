//! natives 解压。
//!
//! 版本 JSON 里被判定为 native 的库（旧式带 `natives` 映射的 classifier 件，或 1.19+ 独立的
//! `natives-<os>` 条目）下载下来是 jar，启动前须把其中的动态库解压到版本隔离的 natives 目录。
//! 解压尊重库自带的 `extract.exclude` 前缀规则（Mojang 通常排除 `META-INF/`）。zip 读取是同步、
//! CPU/IO 混合操作，故整段解压丢进 `spawn_blocking`，不阻塞异步 worker。
//!
//! 每次补全都会走到这里。解压完在 natives 目录里留一份戳记：参与解压的 jar（以版本 JSON 声明的
//! sha1 标识，没有声明时用文件大小与修改时间）与解出的文件清单。下次戳记一致、清单里的文件都还在，
//! 就不再重新解压。

use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use aurora_version::{Library, RuntimeContext, VersionJson, select_libraries};
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result, io_err, zip_err};
use crate::layout::{GameLayout, coordinate_path};

/// 无显式 exclude 时的默认排除前缀：签名/清单目录不属于运行时动态库。
const DEFAULT_EXCLUDES: &[&str] = &["META-INF/"];

/// natives 目录里的解压戳记文件名。点开头、带产品 slug，不会与 jar 里的动态库重名。
const STAMP_FILE: &str = concat!(".", aurora_base::app_slug!(), "-natives.json");

/// 判断一个归档条目是否应被解压：目录一律跳过，命中任一 exclude 前缀也跳过。
fn should_extract(entry_name: &str, excludes: &[String]) -> bool {
    if entry_name.ends_with('/') {
        return false;
    }
    !excludes
        .iter()
        .any(|prefix| entry_name.starts_with(prefix.as_str()))
}

/// 一个待解压的 native jar。
struct NativeJob {
    jar: PathBuf,
    excludes: Vec<String>,
    /// 版本 JSON 为这个 jar 声明的 sha1；maven 简写式的库没有。
    sha1: Option<String>,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Stamp {
    fingerprint: Vec<String>,
    files: Vec<String>,
}

/// 把版本里当前平台适用的全部 natives 解压到 `versions/<target_id>/<target_id>-natives`。
///
/// `target_id` 是 natives 的落点版本（原版安装即版本自身；加载器版本则复用其原版的 natives 目录）。
/// 返回 natives 目录里由本函数管理的文件数。任一 native jar 缺失或损坏都会冒泡（natives 缺失会
/// 直接导致游戏崩溃，不容静默跳过）。
pub async fn extract_all_natives(
    version: &VersionJson,
    ctx: &RuntimeContext,
    layout: &GameLayout,
    target_id: &str,
) -> Result<u32> {
    // 先在异步上下文里把「哪些 jar、排除什么、解到哪」算清楚，再把纯同步解压交给阻塞线程池。
    let dest = layout.natives_dir(target_id);
    let mut jobs: Vec<NativeJob> = Vec::new();
    for lib in select_libraries(version, ctx) {
        if !lib.is_native() {
            continue;
        }
        let Some(rel) = native_jar_relpath(lib, ctx)? else {
            continue;
        };
        jobs.push(NativeJob {
            jar: layout.checked_library_path(&lib.name, &rel)?,
            excludes: effective_excludes(lib),
            sha1: native_jar_sha1(lib, ctx),
        });
    }
    if jobs.is_empty() {
        return Ok(0);
    }

    tokio::task::spawn_blocking(move || extract_with_stamp(&jobs, &dest))
        .await
        .map_err(|join| {
            io_err(
                PathBuf::from("<natives>"),
                io::Error::other(format!("natives 解压任务异常终止: {join}")),
            )
        })?
}

/// 戳记一致且解出的文件都在时直接沿用，否则重新解压并刷新戳记。
fn extract_with_stamp(jobs: &[NativeJob], dest: &Path) -> Result<u32> {
    let fingerprint = fingerprint(jobs)?;
    let stamp_path = dest.join(STAMP_FILE);
    if let Some(stamp) = read_stamp(&stamp_path)?
        && stamp.fingerprint == fingerprint
        && stamp.files.iter().all(|f| dest.join(f).is_file())
    {
        return Ok(stamp.files.len() as u32);
    }

    let mut files = Vec::new();
    for job in jobs {
        for rel in extract_jar(&job.jar, dest, &job.excludes)? {
            files.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
    let stamp = Stamp { fingerprint, files };
    let bytes = serde_json::to_vec(&stamp).map_err(|source| Error::Json {
        context: "natives 戳记".to_owned(),
        source,
    })?;
    std::fs::create_dir_all(dest).map_err(|source| io_err(dest, source))?;
    std::fs::write(&stamp_path, bytes).map_err(|source| io_err(&stamp_path, source))?;
    Ok(stamp.files.len() as u32)
}

/// 戳记是可重建的缓存：不存在或读不懂都按「没有戳记」处理，重新解压一遍即可恢复。
fn read_stamp(path: &Path) -> Result<Option<Stamp>> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes).ok()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(io_err(path, source)),
    }
}

/// 每个 jar 一行：路径、标识（声明的 sha1，或文件大小与修改时间）、exclude 规则。
fn fingerprint(jobs: &[NativeJob]) -> Result<Vec<String>> {
    jobs.iter()
        .map(|job| {
            let identity = match &job.sha1 {
                Some(sha1) => format!("sha1:{sha1}"),
                None => {
                    let meta =
                        std::fs::metadata(&job.jar).map_err(|source| io_err(&job.jar, source))?;
                    let modified = meta
                        .modified()
                        .map_err(|source| io_err(&job.jar, source))?
                        .duration_since(UNIX_EPOCH)
                        .map_or(0, |d| d.as_nanos());
                    format!("meta:{}:{modified}", meta.len())
                }
            };
            Ok(format!(
                "{}|{identity}|{}",
                job.jar.display(),
                job.excludes.join(",")
            ))
        })
        .collect()
}

/// 版本 JSON 为某 native 库当前平台 jar 声明的 sha1。
fn native_jar_sha1(lib: &Library, ctx: &RuntimeContext) -> Option<String> {
    if lib.natives.is_some() {
        return lib.native_artifact(ctx).map(|a| a.sha1.clone());
    }
    lib.downloads
        .as_ref()
        .and_then(|d| d.artifact.as_ref())
        .map(|a| a.sha1.clone())
}

/// 某 native 库当前平台对应 jar 的相对仓库路径；当前平台没有对应 classifier 时为 `None`。
///
/// 坐标兜底与下载计划用同一份逐段校验：缺段报坐标非法、越界报路径越界，与下载时一致，
/// 不再悄悄跳过（natives 缺了游戏会直接崩）。
fn native_jar_relpath(lib: &Library, ctx: &RuntimeContext) -> Result<Option<String>> {
    if lib.natives.is_some() {
        // 旧式：从 classifiers 里挑当前平台件。
        if let Some(artifact) = lib.native_artifact(ctx)
            && let Some(path) = &artifact.path
        {
            return Ok(Some(path.clone()));
        }
        let Some(classifier) = lib.native_classifier(ctx) else {
            return Ok(None);
        };
        return coordinate_path(&format!("{}:{classifier}", lib.name)).map(Some);
    }
    // 新式：classifier 已在 name 里，直接用主件路径或坐标。
    if let Some(path) = lib
        .downloads
        .as_ref()
        .and_then(|d| d.artifact.as_ref())
        .and_then(|a| a.path.clone())
    {
        return Ok(Some(path));
    }
    coordinate_path(&lib.name).map(Some)
}

/// 库的有效 exclude 前缀：优先用其 `extract.exclude`，未声明则用默认（排除 META-INF）。
fn effective_excludes(lib: &Library) -> Vec<String> {
    match &lib.extract {
        Some(extract) if !extract.exclude.is_empty() => extract.exclude.clone(),
        _ => DEFAULT_EXCLUDES.iter().map(|s| s.to_string()).collect(),
    }
}

/// 同步解压单个 jar 里未被排除的条目到 `dest`，保留其内部相对结构（用 enclosed_name 防目录穿越）。
/// 返回解出文件相对 `dest` 的路径。
fn extract_jar(jar: &Path, dest: &Path, excludes: &[String]) -> Result<Vec<PathBuf>> {
    let file = File::open(jar).map_err(|source| io_err(jar, source))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|source| zip_err(jar, source))?;

    let mut extracted = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|source| zip_err(jar, source))?;
        if entry.is_dir() || !should_extract(entry.name(), excludes) {
            continue;
        }
        // enclosed_name 拒绝绝对路径与 `..`，None 说明条目名不安全，跳过。
        let Some(rel) = entry.enclosed_name() else {
            continue;
        };
        let target = dest.join(&rel);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|source| io_err(parent, source))?;
        }
        let mut out = File::create(&target).map_err(|source| io_err(&target, source))?;
        io::copy(&mut entry, &mut out).map_err(|source| io_err(&target, source))?;
        extracted.push(rel);
    }
    Ok(extracted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use aurora_version::OsName;
    use std::io::Write;

    #[test]
    fn should_extract_skips_dirs_and_excluded_prefixes() {
        let excludes = vec!["META-INF/".to_string()];
        assert!(should_extract("lwjgl.dll", &excludes));
        assert!(should_extract("windows/x64/OpenAL.dll", &excludes));
        assert!(!should_extract("META-INF/MANIFEST.MF", &excludes));
        assert!(!should_extract("natives/", &excludes)); // 目录
    }

    #[test]
    fn should_extract_honors_custom_excludes() {
        let excludes = vec!["binary/".to_string(), "readme.txt".to_string()];
        assert!(!should_extract("binary/foo.so", &excludes));
        assert!(!should_extract("readme.txt", &excludes));
        assert!(should_extract("libglfw.so", &excludes));
    }

    #[test]
    fn effective_excludes_defaults_to_meta_inf() {
        let lib = Library {
            name: "g:a:1".into(),
            downloads: None,
            ..Default::default()
        };
        assert_eq!(effective_excludes(&lib), vec!["META-INF/".to_string()]);
    }

    /// 现场造一个含一个 dll、一个 META-INF 的 jar，验证解压只落 dll。
    fn build_test_jar(path: &Path) {
        let file = File::create(path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let opts: zip::write::FileOptions<'_, ()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
        writer.start_file("lwjgl.dll", opts).unwrap();
        writer.write_all(b"fake-dll-bytes").unwrap();
        writer.start_file("META-INF/MANIFEST.MF", opts).unwrap();
        writer.write_all(b"Manifest-Version: 1.0\n").unwrap();
        writer.finish().unwrap();
    }

    #[test]
    fn extract_jar_writes_only_non_excluded_files() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("natives.jar");
        build_test_jar(&jar);
        let dest = dir.path().join("out-natives");

        let extracted = extract_jar(&jar, &dest, &["META-INF/".to_string()]).unwrap();
        assert_eq!(extracted, vec![PathBuf::from("lwjgl.dll")], "只应解压 dll");
        assert_eq!(
            std::fs::read(dest.join("lwjgl.dll")).unwrap(),
            b"fake-dll-bytes"
        );
        assert!(!dest.join("META-INF").exists(), "META-INF 应被排除");
    }

    fn new_style_version(sha1: &str) -> VersionJson {
        VersionJson::from_json_str(&format!(
            r#"{{"id":"1.21","libraries":[
                {{"name":"org.lwjgl:lwjgl:3.3.3:natives-windows",
                 "downloads":{{"artifact":{{"path":"org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar","sha1":"{sha1}","size":1,"url":"u"}}}}}}
            ]}}"#
        ))
        .unwrap()
    }

    fn put_native_jar(layout: &GameLayout) {
        let jar_path = layout.library_path("org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar");
        std::fs::create_dir_all(jar_path.parent().unwrap()).unwrap();
        build_test_jar(&jar_path);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn extract_all_natives_pulls_from_new_style_library() {
        let dir = tempfile::tempdir().unwrap();
        let layout = GameLayout::new(dir.path());
        put_native_jar(&layout);
        let ctx = RuntimeContext::new(OsName::Windows, "x86_64", 64);

        let count = extract_all_natives(&new_style_version("x"), &ctx, &layout, "1.21")
            .await
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(
            std::fs::read(layout.natives_dir("1.21").join("lwjgl.dll")).unwrap(),
            b"fake-dll-bytes"
        );
    }

    /// 1.13 到 1.18 的孪生条目：主件那条排在前面，也要从带 natives 映射的那条解压。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn extract_all_natives_finds_the_twin_behind_a_plain_entry() {
        let dir = tempfile::tempdir().unwrap();
        let layout = GameLayout::new(dir.path());
        let jar_path = layout.library_path("org/lwjgl/lwjgl/3.2.2/lwjgl-3.2.2-natives-windows.jar");
        std::fs::create_dir_all(jar_path.parent().unwrap()).unwrap();
        build_test_jar(&jar_path);
        let version = VersionJson::from_json_str(
            r#"{"id":"1.18.2","libraries":[
                {"name":"org.lwjgl:lwjgl:3.2.2",
                 "downloads":{"artifact":{"path":"org/lwjgl/lwjgl/3.2.2/lwjgl-3.2.2.jar","sha1":"m","size":1,"url":"u"}}},
                {"name":"org.lwjgl:lwjgl:3.2.2",
                 "natives":{"windows":"natives-windows"},
                 "downloads":{
                    "artifact":{"path":"org/lwjgl/lwjgl/3.2.2/lwjgl-3.2.2.jar","sha1":"m","size":1,"url":"u"},
                    "classifiers":{"natives-windows":{"path":"org/lwjgl/lwjgl/3.2.2/lwjgl-3.2.2-natives-windows.jar","sha1":"w","size":1,"url":"u"}}}}
            ]}"#,
        )
        .unwrap();
        let ctx = RuntimeContext::new(OsName::Windows, "x86_64", 64);

        let count = extract_all_natives(&version, &ctx, &layout, "1.18.2")
            .await
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(
            std::fs::read(layout.natives_dir("1.18.2").join("lwjgl.dll")).unwrap(),
            b"fake-dll-bytes"
        );
    }

    /// natives jar 的路径（直给的或由坐标算出的）能走出库目录时报路径越界，不去读库目录外的文件；
    /// 坐标缺段报坐标非法，不再悄悄跳过这个 native。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn native_jar_paths_escaping_the_libraries_dir_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let layout = GameLayout::new(dir.path());
        // 库目录外放一个真能解出 dll 的 jar：校验漏掉时它会被解进 natives 目录。
        build_test_jar(&dir.path().join("escaped.jar"));
        let ctx = RuntimeContext::new(OsName::Windows, "x86_64", 64);
        let cases = [
            r#"{"name":"org.lwjgl:lwjgl:3.3.3:natives-windows","downloads":{"artifact":{"path":"../escaped.jar","sha1":"x","size":1,"url":"u"}}}"#,
            r#"{"name":"org.lwjgl:lwjgl-platform:2.9.4","natives":{"windows":"natives-windows"},"downloads":{"classifiers":{"natives-windows":{"path":"../escaped.jar","sha1":"x","size":1,"url":"u"}}}}"#,
            r#"{"name":"evil:x:1/../../../escaped:natives-windows"}"#,
            r#"{"name":"org.lwjgl:lwjgl-platform:2.9.4","natives":{"windows":"../../natives-windows"}}"#,
        ];
        for lib in cases {
            let version =
                VersionJson::from_json_str(&format!(r#"{{"id":"1.21","libraries":[{lib}]}}"#))
                    .unwrap();
            let err = extract_all_natives(&version, &ctx, &layout, "1.21")
                .await
                .unwrap_err();
            assert!(
                matches!(err, Error::UnsafePath { .. }),
                "{lib}：实际 {err:?}"
            );
            assert!(
                !layout.natives_dir("1.21").exists(),
                "{lib}：不该解出任何文件"
            );
        }

        let malformed = VersionJson::from_json_str(
            r#"{"id":"1.21","libraries":[{"name":"lwjgl-platform","natives":{"windows":"natives-windows"}}]}"#,
        )
        .unwrap();
        let err = extract_all_natives(&malformed, &ctx, &layout, "1.21")
            .await
            .unwrap_err();
        assert!(
            matches!(&err, Error::InvalidLibraryCoordinate { name } if name == "lwjgl-platform:natives-windows"),
            "实际 {err:?}"
        );
    }

    /// 第二次补全命中戳记：被改写的 dll 不会被覆盖回 jar 里的内容；jar 的 sha1 变了、
    /// 或解出的文件被删，就重新解压。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stamp_skips_re_extraction_until_jar_or_files_change() {
        let dir = tempfile::tempdir().unwrap();
        let layout = GameLayout::new(dir.path());
        put_native_jar(&layout);
        let ctx = RuntimeContext::new(OsName::Windows, "x86_64", 64);
        let dll = layout.natives_dir("1.21").join("lwjgl.dll");
        let (ctx, layout) = (&ctx, &layout);
        let run = |sha1: &'static str| async move {
            extract_all_natives(&new_style_version(sha1), ctx, layout, "1.21")
                .await
                .unwrap()
        };

        assert_eq!(run("aaa").await, 1);
        std::fs::write(&dll, b"touched").unwrap();
        assert_eq!(run("aaa").await, 1);
        assert_eq!(
            std::fs::read(&dll).unwrap(),
            b"touched",
            "戳记一致时不应重新解压"
        );

        assert_eq!(run("bbb").await, 1);
        assert_eq!(
            std::fs::read(&dll).unwrap(),
            b"fake-dll-bytes",
            "jar 变了应重新解压"
        );

        std::fs::remove_file(&dll).unwrap();
        assert_eq!(run("bbb").await, 1);
        assert_eq!(
            std::fs::read(&dll).unwrap(),
            b"fake-dll-bytes",
            "解出的文件缺了应重新解压"
        );
    }
}
