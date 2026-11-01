//! classpath 组装：按「合并后 libraries 顺序」拼出 `-cp` 的条目，客户端主 jar 垫最后。
//!
//! 库的本地落点必须与 [`aurora_install`](../../aurora_install) 下载时写入的路径逐字一致，否则 classpath
//! 指向的 jar 不存在。为此这里的 maven 坐标 -> 相对路径算法与 `aurora_install::maven::artifact_path`
//! 保持一致（本 crate 不依赖 install，故独立实现一份；纯字符串运算）。选库复用 aurora-version 的
//! [`select_libraries`]：它已按 rules 过滤并按 `group:artifact[:classifier]` 去重、保留先出现者
//! （合并继承链时加载器库在前，从而压过原版同名库）。

use std::path::{Path, PathBuf};

use aurora_version::{
    Library, OsName, RuntimeContext, VersionJson, check_path_segment, check_relative_path,
    select_libraries,
};

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
///
/// 判据与补全时的下载计划一致：坐标缺段报坐标非法；路径或坐标的某一段能走出库目录时报
/// [`LaunchError::UnsafePath`]。classpath 只读不写，但判据不一致时同一份版本 JSON 补全报错、拼 classpath
/// 却悄悄改了路径，两边指的就不是同一个文件。
pub fn library_relative_path(lib: &Library) -> Result<String> {
    let unsafe_path = |path: &str, problem| LaunchError::UnsafePath {
        entry: format!("库 {}", lib.name),
        path: path.to_owned(),
        problem,
    };
    if let Some(path) = lib
        .downloads
        .as_ref()
        .and_then(|d| d.artifact.as_ref())
        .and_then(|a| a.path.as_deref())
    {
        check_relative_path(path).map_err(|problem| unsafe_path(path, problem))?;
        return Ok(path.to_owned());
    }
    let path =
        maven_artifact_path(&lib.name).ok_or_else(|| LaunchError::InvalidLibraryCoordinate {
            name: lib.name.clone(),
        })?;
    let (fields, extension) = match lib.name.split_once('@') {
        Some((fields, extension)) => (fields, Some(extension)),
        None => (lib.name.as_str(), None),
    };
    let (group, rest) = fields
        .split_once(':')
        .expect("maven_artifact_path 已保证坐标至少有三段");
    match group
        .split('.')
        .chain(rest.split(':'))
        .chain(extension)
        .find_map(|segment| check_path_segment(segment).err())
    {
        Some(problem) => Err(unsafe_path(&path, problem)),
        None => Ok(path),
    }
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
        let relative = library_relative_path(lib)?;
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

/// 把已经校验过的、以 `/` 分隔的相对路径转成本平台 `PathBuf`。
fn rel_to_path(relative: &str) -> PathBuf {
    relative.split('/').collect()
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
            library_relative_path(&with_download).unwrap(),
            "custom/put/here.jar"
        );

        let shorthand = Library {
            name: "net.fabricmc:fabric-loader:0.15.11".into(),
            downloads: None,
            url: Some("https://maven.fabricmc.net/".into()),
            ..Default::default()
        };
        assert_eq!(
            library_relative_path(&shorthand).unwrap(),
            "net/fabricmc/fabric-loader/0.15.11/fabric-loader-0.15.11.jar"
        );
    }

    /// 同坐标的主件条目与 natives 条目（1.13 到 1.18 的写法）：主件只进一次类路径。
    #[test]
    fn classpath_lists_a_twin_entry_once() {
        let version = VersionJson::from_json_str(
            r#"{
                "id":"1.16.5",
                "libraries":[
                    {"name":"org.lwjgl:lwjgl:3.2.2",
                     "downloads":{"artifact":{"path":"org/lwjgl/lwjgl/3.2.2/lwjgl-3.2.2.jar","sha1":"a","size":1,"url":"u"}}},
                    {"name":"org.lwjgl:lwjgl:3.2.2",
                     "natives":{"windows":"natives-windows"},
                     "downloads":{"artifact":{"path":"org/lwjgl/lwjgl/3.2.2/lwjgl-3.2.2.jar","sha1":"a","size":1,"url":"u"},
                        "classifiers":{"natives-windows":{"path":"org/lwjgl/lwjgl/3.2.2/lwjgl-3.2.2-natives-windows.jar","sha1":"b","size":1,"url":"u"}}}}
                ]
            }"#,
        )
        .unwrap();
        let libraries_dir = Path::new("D:/mc/libraries");
        let client_jar = Path::new("D:/mc/versions/x/x.jar");
        let entries = classpath_entries(&version, &win64(), libraries_dir, client_jar).unwrap();
        assert_eq!(
            entries,
            vec![
                libraries_dir.join("org/lwjgl/lwjgl/3.2.2/lwjgl-3.2.2.jar"),
                client_jar.to_path_buf()
            ]
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

    /// 库路径与由坐标算出的路径按补全时下载计划的同一判据校验：空段、`..`、反斜杠一律报路径越界，
    /// 不把 `org//x.jar` 悄悄拼成 `org/x.jar`。
    #[test]
    fn unsafe_library_paths_are_rejected_like_the_download_plan() {
        let cases = [
            (
                r#"{"name":"a:b:1","downloads":{"artifact":{"path":"org//x.jar","sha1":"a","size":1,"url":"u"}}}"#,
                "库 a:b:1",
                "org//x.jar",
                aurora_version::UnsafePath::EmptySegment,
            ),
            (
                r#"{"name":"a:b:1","downloads":{"artifact":{"path":"org/../../x.jar","sha1":"a","size":1,"url":"u"}}}"#,
                "库 a:b:1",
                "org/../../x.jar",
                aurora_version::UnsafePath::DotSegment,
            ),
            (
                r#"{"name":"evil:..:1"}"#,
                "库 evil:..:1",
                "evil/../1/..-1.jar",
                aurora_version::UnsafePath::DotSegment,
            ),
            (
                r#"{"name":"a:b\\..\\..:1"}"#,
                r"库 a:b\..\..:1",
                r"a/b\..\../1/b\..\..-1.jar",
                aurora_version::UnsafePath::Backslash,
            ),
            (
                r#"{"name":"a:b/c:1"}"#,
                "库 a:b/c:1",
                "a/b/c/1/b/c-1.jar",
                aurora_version::UnsafePath::Separator,
            ),
        ];
        for (library, entry, path, problem) in cases {
            let version =
                VersionJson::from_json_str(&format!(r#"{{"id":"x","libraries":[{library}]}}"#))
                    .unwrap();
            let err =
                classpath_entries(&version, &win64(), Path::new("/libs"), Path::new("/c.jar"))
                    .unwrap_err();
            match err {
                LaunchError::UnsafePath {
                    entry: got_entry,
                    path: got_path,
                    problem: got_problem,
                } => {
                    assert_eq!(got_entry, entry);
                    assert_eq!(got_path, path);
                    assert_eq!(got_problem, problem, "{library}");
                }
                other => panic!("{library} 应报路径越界，实际：{other:?}"),
            }
        }
    }

    /// 路径校验不能误伤真实版本：摘自 Forge、NeoForge、Fabric、OptiFine 与旧版原版 JSON 的写法，含构建号里的
    /// `+`、下划线、`@zip` 扩展名、分类器，以及 Forge 自己产出的通用 jar 这种下载地址为空的条目。
    #[test]
    fn real_library_forms_pass_the_path_check() {
        for (name, expected) in [
            (
                "net.fabricmc:sponge-mixin:0.12.5+mixin.0.8.5",
                "net/fabricmc/sponge-mixin/0.12.5+mixin.0.8.5/sponge-mixin-0.12.5+mixin.0.8.5.jar",
            ),
            (
                "net.fabricmc:intermediary:1.20.1",
                "net/fabricmc/intermediary/1.20.1/intermediary-1.20.1.jar",
            ),
            (
                "optifine:OptiFine:1.20.1_HD_U_I5",
                "optifine/OptiFine/1.20.1_HD_U_I5/OptiFine-1.20.1_HD_U_I5.jar",
            ),
            (
                "net.minecraftforge:forge:1.20.1-47.3.0:client",
                "net/minecraftforge/forge/1.20.1-47.3.0/forge-1.20.1-47.3.0-client.jar",
            ),
            (
                "net.neoforged:neoforge:21.1.77:client",
                "net/neoforged/neoforge/21.1.77/neoforge-21.1.77-client.jar",
            ),
            (
                "de.oceanlabs.mcp:mcp_config:1.20.1-20230612.114412@zip",
                "de/oceanlabs/mcp/mcp_config/1.20.1-20230612.114412/mcp_config-1.20.1-20230612.114412.zip",
            ),
            (
                "org.scala-lang.plugins:scala-continuations-library_2.11:1.0.2",
                "org/scala-lang/plugins/scala-continuations-library_2.11/1.0.2/scala-continuations-library_2.11-1.0.2.jar",
            ),
            (
                "com.mumfrey:liteloader:1.12.2-SNAPSHOT",
                "com/mumfrey/liteloader/1.12.2-SNAPSHOT/liteloader-1.12.2-SNAPSHOT.jar",
            ),
        ] {
            let shorthand = Library {
                name: name.into(),
                ..Default::default()
            };
            assert_eq!(library_relative_path(&shorthand).unwrap(), expected);

            let declared = Library {
                name: name.into(),
                downloads: Some(aurora_version::LibraryDownloads {
                    artifact: Some(aurora_version::Artifact {
                        path: Some(expected.into()),
                        sha1: "x".into(),
                        size: 1,
                        url: String::new(),
                    }),
                    classifiers: None,
                }),
                ..Default::default()
            };
            assert_eq!(library_relative_path(&declared).unwrap(), expected);
        }
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
