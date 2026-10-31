//! classpath 组装：按「合并后 libraries 顺序」拼出 `-cp` 的条目，客户端主 jar 垫最后。
//!
//! 库的本地落点必须与 [`aurora_install`](../../aurora_install) 下载时写入的路径逐字一致，否则 classpath
//! 指向的 jar 不存在。为此这里的 maven 坐标 -> 相对路径算法与 `aurora_install::maven::artifact_path`
//! 保持一致（本 crate 不依赖 install，故独立实现一份；纯字符串运算）。选库复用 aurora-version 的
//! [`select_libraries`]：它已按 rules 过滤并按 `group:artifact[:classifier]` 去重、保留先出现者
//! （合并继承链时加载器库在前，从而压过原版同名库）。

use std::path::{Path, PathBuf};

use aurora_version::{Library, OsName, RuntimeContext, VersionJson, select_libraries};

use crate::error::{LaunchError, Result};

/// classpath 分隔符：Windows 用 `;`，类 Unix 用 `:`。
pub fn classpath_separator(os: OsName) -> char {
    match os {
        OsName::Windows => ';',
        OsName::Osx | OsName::Linux => ':',
    }
}

/// 把一个 maven 坐标转成相对 `libraries/` 根的路径（正斜杠分隔）。
///
/// 坐标形如 `group:artifact:version[:classifier][@ext]`，缺段/空段返回 `None`（交调用方冒泡成坐标非法）。
/// 与 `aurora_install::maven::artifact_path` 同构，保证下载落点与 classpath 引用一致。
pub fn maven_artifact_path(coordinate: &str) -> Option<String> {
    let (coord, extension) = match coordinate.split_once('@') {
        Some((left, ext)) if !ext.is_empty() => (left, ext),
        Some(_) => return None,
        None => (coordinate, "jar"),
    };

    let mut parts = coord.split(':');
    let group = parts.next()?;
    let artifact = parts.next()?;
    let version = parts.next()?;
    let classifier = parts.next();
    if parts.next().is_some() {
        return None;
    }
    if group.is_empty() || artifact.is_empty() || version.is_empty() {
        return None;
    }
    if classifier.is_some_and(str::is_empty) {
        return None;
    }

    let group_path = group.replace('.', "/");
    let file_stem = match classifier {
        Some(cl) => format!("{artifact}-{version}-{cl}"),
        None => format!("{artifact}-{version}"),
    };
    Some(format!(
        "{group_path}/{artifact}/{version}/{file_stem}.{extension}"
    ))
}

/// 某库在 `libraries/` 下的相对路径：优先用 Mojang 全量式的 `downloads.artifact.path`，
/// 否则由 maven 坐标推导（Fabric/Forge 的简写库、Forge 本地产出的通用 jar 都走这条）。
pub fn library_relative_path(lib: &Library) -> Option<String> {
    if let Some(path) = lib
        .downloads
        .as_ref()
        .and_then(|d| d.artifact.as_ref())
        .and_then(|a| a.path.clone())
    {
        return Some(path);
    }
    maven_artifact_path(&lib.name)
}

/// 组装该版本的 classpath 条目（绝对路径），顺序 = 合并后生效库的顺序，客户端主 jar 垫最后。
///
/// 只收非 natives 库：带 natives 映射或 classifier 以 `natives-` 开头的条目只提供解压用的本地库，
/// 不进 classpath（其解压由 aurora-install 完成）。坐标无法解析的非 natives 库直接冒泡成错误，
/// 不静默跳过——否则会导致运行期 `ClassNotFoundException`，问题被推迟到更难定位的地方。
pub fn classpath_entries(
    version: &VersionJson,
    ctx: &RuntimeContext,
    libraries_dir: &Path,
    client_jar: &Path,
) -> Result<Vec<PathBuf>> {
    let mut entries = Vec::new();
    for lib in select_libraries(version, ctx) {
        if lib.is_native() {
            continue;
        }
        let relative =
            library_relative_path(lib).ok_or_else(|| LaunchError::InvalidLibraryCoordinate {
                name: lib.name.clone(),
            })?;
        entries.push(libraries_dir.join(rel_to_path(&relative)));
    }
    entries.push(client_jar.to_path_buf());
    Ok(entries)
}

/// 把 classpath 条目用分隔符拼成 `-cp` 的值。
pub fn classpath_string(entries: &[PathBuf], separator: char) -> String {
    let sep = separator.to_string();
    entries
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(&sep)
}

/// 把以 `/` 分隔的相对路径转成本平台 `PathBuf`（忽略空段）。
fn rel_to_path(relative: &str) -> PathBuf {
    relative.split('/').filter(|s| !s.is_empty()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn win64() -> RuntimeContext {
        RuntimeContext::new(OsName::Windows, "x86_64", 64)
    }

    #[test]
    fn separator_is_semicolon_on_windows() {
        assert_eq!(classpath_separator(OsName::Windows), ';');
        assert_eq!(classpath_separator(OsName::Linux), ':');
        assert_eq!(classpath_separator(OsName::Osx), ':');
    }

    #[test]
    fn maven_path_matches_install_layout() {
        assert_eq!(
            maven_artifact_path("com.google.code.gson:gson:2.10.1").unwrap(),
            "com/google/code/gson/gson/2.10.1/gson-2.10.1.jar"
        );
        assert_eq!(
            maven_artifact_path("org.lwjgl:lwjgl:3.3.3:natives-windows").unwrap(),
            "org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar"
        );
        assert!(maven_artifact_path("only:two").is_none());
        assert!(maven_artifact_path("a:b:1:c:extra").is_none());
    }

    #[test]
    fn relative_path_prefers_artifact_path_then_coordinate() {
        let with_download = Library {
            name: "net.fabricmc:tiny-mappings-parser:0.3.0".into(),
            downloads: Some(aurora_version::LibraryDownloads {
                artifact: Some(aurora_version::Artifact {
                    path: Some("custom/put/here.jar".into()),
                    sha1: "x".into(),
                    size: 1,
                    url: "u".into(),
                }),
                classifiers: None,
            }),
            ..Default::default()
        };
        assert_eq!(
            library_relative_path(&with_download).as_deref(),
            Some("custom/put/here.jar")
        );

        let shorthand = Library {
            name: "net.fabricmc:fabric-loader:0.15.11".into(),
            downloads: None,
            url: Some("https://maven.fabricmc.net/".into()),
            ..Default::default()
        };
        assert_eq!(
            library_relative_path(&shorthand).as_deref(),
            Some("net/fabricmc/fabric-loader/0.15.11/fabric-loader-0.15.11.jar")
        );
    }

    #[test]
    fn classpath_skips_natives_keeps_order_and_appends_client_jar() {
        // asm 去重保留 9.6；lwjgl 主件进 classpath；lwjgl natives 条目被排除。
        let version = VersionJson::from_json_str(
            r#"{
                "id":"1.21",
                "libraries":[
                    {"name":"org.ow2.asm:asm:9.6",
                     "downloads":{"artifact":{"path":"org/ow2/asm/asm/9.6/asm-9.6.jar","sha1":"a","size":1,"url":"u"}}},
                    {"name":"org.lwjgl:lwjgl:3.3.3",
                     "downloads":{"artifact":{"path":"org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3.jar","sha1":"b","size":1,"url":"u"}}},
                    {"name":"org.lwjgl:lwjgl:3.3.3:natives-windows",
                     "downloads":{"artifact":{"path":"org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar","sha1":"c","size":1,"url":"u"}}}
                ]
            }"#,
        )
        .unwrap();
        let libraries_dir = Path::new("D:/mc/.minecraft/libraries");
        let client_jar = Path::new("D:/mc/.minecraft/versions/1.21/1.21.jar");
        let entries = classpath_entries(&version, &win64(), libraries_dir, client_jar).unwrap();

        assert_eq!(
            entries.len(),
            3,
            "asm + lwjgl 主件 + client jar，natives 不计"
        );
        assert_eq!(
            entries[0],
            libraries_dir.join("org/ow2/asm/asm/9.6/asm-9.6.jar")
        );
        assert_eq!(
            entries[1],
            libraries_dir.join("org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3.jar")
        );
        assert_eq!(entries[2], client_jar);

        let joined = classpath_string(&entries, ';');
        assert_eq!(joined.matches(';').count(), 2, "3 条目 2 个分隔符");
        assert!(joined.ends_with("1.21.jar"));
    }

    #[test]
    fn invalid_non_native_coordinate_errors() {
        let version =
            VersionJson::from_json_str(r#"{"id":"x","libraries":[{"name":"broken-coordinate"}]}"#)
                .unwrap();
        let err = classpath_entries(&version, &win64(), Path::new("/libs"), Path::new("/c.jar"))
            .unwrap_err();
        assert!(
            matches!(err, LaunchError::InvalidLibraryCoordinate { name } if name == "broken-coordinate")
        );
    }
}
