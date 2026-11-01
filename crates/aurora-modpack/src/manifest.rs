//! 两种整合包清单归一到 [`PackManifest`]。
//!
//! - Modrinth `modrinth.index.json`：`formatVersion` 1、`game` 为 `minecraft`，`files` 每项给出
//!   落点路径、sha1/sha512、可选的端侧要求 `env`、下载地址与大小，`dependencies` 给出 MC 与加载器版本；
//!   覆盖文件在 `overrides/`，客户端专用的 `client-overrides/` 叠在其上。
//! - CurseForge `manifest.json`：`manifestType` 为 `minecraftModpack`，`minecraft.modLoaders` 的 id 形如
//!   `forge-47.2.0`，`files` 只给工程与文件 id，覆盖文件目录名由 `overrides` 字段给出。
//!
//! 清单里任何一处越出约定都整体拒收并带上原因，不猜、不跳过半个清单去装一个不完整的实例。

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::path::SafeRelativePath;

pub(crate) const MODRINTH_DOCUMENT: &str = "modrinth.index.json";
pub(crate) const CURSEFORGE_DOCUMENT: &str = "manifest.json";

/// Modrinth 格式约定的下载主机：Modrinth 上架的整合包只会出现这四个。清单来自本地文件时地址是任意的，
/// 不设白名单就等于让一个文件指挥启动器去请求任意主机（含内网地址）。
pub(crate) const MODRINTH_PLATFORM_HOSTS: &[&str] = &[
    "cdn.modrinth.com",
    "github.com",
    "raw.githubusercontent.com",
    "gitlab.com",
];

/// CurseForge 的文件分发主机。其他启动器导出 .mrpack 时会把 CurseForge 上的 Mod 写成它们，读包时认，
/// 导出时不写：这类地址不在格式约定的白名单里，别的启动器与 Modrinth 都可能拒收。
const CURSEFORGE_CDN_HOSTS: &[&str] = &["edge.forgecdn.net", "mediafilez.forgecdn.net"];

/// 读包时认的下载主机：格式约定的四个，加上 CurseForge 的分发主机。
const READ_ALLOWED_HOSTS: &[&[&str]] = &[MODRINTH_PLATFORM_HOSTS, CURSEFORGE_CDN_HOSTS];

/// 四种能写进 Modrinth 清单的加载器。
const PACK_LOADER_KINDS: [PackLoaderKind; 4] = [
    PackLoaderKind::Fabric,
    PackLoaderKind::Quilt,
    PackLoaderKind::Forge,
    PackLoaderKind::NeoForge,
];

/// 整合包格式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PackFormat {
    /// Modrinth `.mrpack`。
    Modrinth,
    /// CurseForge 导出的 `.zip`。
    #[serde(rename = "curseforge")]
    CurseForge,
}

/// 整合包要求的加载器。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PackLoaderKind {
    /// Fabric。
    Fabric,
    /// Quilt。
    Quilt,
    /// Forge。
    Forge,
    /// NeoForge。
    #[serde(rename = "neoforge")]
    NeoForge,
}

/// 加载器与版本。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackLoader {
    /// 加载器。
    pub kind: PackLoaderKind,
    /// 加载器版本（Forge / NeoForge 为不含 MC 前缀的版本号）。
    pub version: String,
}

/// Modrinth 清单里要下载的一个文件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModrinthFile {
    /// 相对实例目录的落点。
    pub path: SafeRelativePath,
    /// 下载地址（按顺序尝试）。
    pub urls: Vec<String>,
    /// 小写 sha1。
    pub sha1: String,
    /// 字节数。
    pub size: u64,
    /// 客户端可选（`env.client` 为 `optional`）。默认照装，调用方可以用
    /// [`RemoteFiles::exclude_optional`] 去掉不要的。
    pub optional: bool,
}

/// CurseForge 清单里要下载的一个文件：只有 id，下载地址要向 CurseForge 接口换。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CurseForgeFileRef {
    /// 工程 id。
    pub project_id: u32,
    /// 文件 id。
    pub file_id: u32,
}

/// 要下载的远程文件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteFiles {
    /// Modrinth：地址、哈希、大小都在清单里。
    Modrinth(Vec<ModrinthFile>),
    /// CurseForge：只有 id。
    CurseForge(Vec<CurseForgeFileRef>),
}

impl RemoteFiles {
    /// 远程文件个数。
    pub fn len(&self) -> usize {
        match self {
            RemoteFiles::Modrinth(files) => files.len(),
            RemoteFiles::CurseForge(files) => files.len(),
        }
    }

    /// 是否没有远程文件。
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// 去掉调用方选择跳过的 Modrinth 可选文件，返回去掉的个数。路径按落点比较（Windows 下不区分
    /// 大小写），同一个文件写了两遍只算一次。
    ///
    /// 某个路径不是本包里 `optional` 为真的 Modrinth 文件，或包是 CurseForge 格式而 `paths` 非空，报
    /// [`Error::NotOptional`]。先全部核对再动清单，出错时清单原样不变。
    pub fn exclude_optional(&mut self, paths: &[String]) -> Result<usize> {
        let files = match self {
            RemoteFiles::Modrinth(files) => files,
            // CurseForge 清单没有可选文件：作者停用的项（required 为 false）解析时已经去掉了。
            RemoteFiles::CurseForge(_) => {
                return match paths.first() {
                    Some(path) => Err(Error::NotOptional { path: path.clone() }),
                    None => Ok(0),
                };
            }
        };
        let optional: HashSet<String> = files
            .iter()
            .filter(|f| f.optional)
            .map(|f| f.path.comparison_key())
            .collect();
        let mut skipped = HashSet::with_capacity(paths.len());
        for path in paths {
            // 过不了路径校验的不可能是包里的文件，与「不在可选清单里」同一个结论。
            let key = SafeRelativePath::new(path.as_str())
                .ok()
                .map(|p| p.comparison_key())
                .filter(|key| optional.contains(key))
                .ok_or_else(|| Error::NotOptional { path: path.clone() })?;
            skipped.insert(key);
        }
        let before = files.len();
        files.retain(|f| !skipped.contains(&f.path.comparison_key()));
        Ok(before - files.len())
    }
}

/// 归一后的整合包清单。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackManifest {
    /// 格式。
    pub format: PackFormat,
    /// 整合包名。
    pub name: String,
    /// 整合包版本；CurseForge 清单可以不写。
    pub version: Option<String>,
    /// 简介（仅 Modrinth 有）。
    pub summary: Option<String>,
    /// 作者（仅 CurseForge 有）。
    pub author: Option<String>,
    /// MC 版本。
    pub minecraft: String,
    /// 加载器；原版整合包为 `None`。
    pub loader: Option<PackLoader>,
    /// 要下载的远程文件。
    pub remote: RemoteFiles,
    /// 覆盖文件所在的目录前缀（含结尾 `/`），按叠加顺序：后面的覆盖前面的。
    pub override_layers: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawIndex {
    format_version: u32,
    game: String,
    version_id: String,
    name: String,
    #[serde(default)]
    summary: Option<String>,
    files: Vec<RawIndexFile>,
    dependencies: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawIndexFile {
    path: String,
    hashes: RawHashes,
    #[serde(default)]
    env: Option<RawEnv>,
    downloads: Vec<String>,
    file_size: u64,
}

#[derive(Deserialize)]
struct RawHashes {
    sha1: String,
}

#[derive(Deserialize)]
struct RawEnv {
    client: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCurseForge {
    minecraft: RawCurseForgeMinecraft,
    manifest_type: String,
    manifest_version: u32,
    name: String,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    author: Option<String>,
    files: Vec<RawCurseForgeFile>,
    #[serde(default)]
    overrides: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCurseForgeMinecraft {
    version: String,
    #[serde(default)]
    mod_loaders: Vec<RawCurseForgeLoader>,
}

#[derive(Deserialize)]
struct RawCurseForgeLoader {
    id: String,
    #[serde(default)]
    primary: bool,
}

#[derive(Deserialize)]
struct RawCurseForgeFile {
    #[serde(rename = "projectID")]
    project_id: u32,
    #[serde(rename = "fileID")]
    file_id: u32,
    #[serde(default = "default_required")]
    required: bool,
}

fn default_required() -> bool {
    true
}

impl PackManifest {
    /// 解析 Modrinth `modrinth.index.json`。
    pub fn parse_modrinth(bytes: &[u8]) -> Result<Self> {
        let raw: RawIndex = serde_json::from_slice(bytes)
            .map_err(|err| Error::invalid(MODRINTH_DOCUMENT, err.to_string()))?;
        if raw.format_version != 1 {
            return Err(Error::invalid(
                MODRINTH_DOCUMENT,
                format!("formatVersion 为 {}，只认 1", raw.format_version),
            ));
        }
        if raw.game != "minecraft" {
            return Err(Error::invalid(
                MODRINTH_DOCUMENT,
                format!("game 为 {}，只认 minecraft", raw.game),
            ));
        }
        let name = required_text(MODRINTH_DOCUMENT, "name", &raw.name)?;
        let version = required_text(MODRINTH_DOCUMENT, "versionId", &raw.version_id)?;
        let minecraft = raw
            .dependencies
            .get("minecraft")
            .map(|v| required_text(MODRINTH_DOCUMENT, "dependencies.minecraft", v))
            .transpose()?
            .ok_or_else(|| Error::invalid(MODRINTH_DOCUMENT, "dependencies 里没有 minecraft"))?;
        let loader = modrinth_loader(&raw.dependencies)?;

        let mut seen = HashSet::new();
        let mut files = Vec::with_capacity(raw.files.len());
        for file in raw.files {
            let optional = match file.env.as_ref().map(|e| e.client.as_str()) {
                None | Some("required") => false,
                Some("optional") => true,
                // 只给服务端用的文件不进客户端实例。
                Some("unsupported") => continue,
                Some(other) => {
                    return Err(Error::invalid(
                        MODRINTH_DOCUMENT,
                        format!("{} 的 env.client 取值 {other} 不认识", file.path),
                    ));
                }
            };
            let path =
                SafeRelativePath::new(file.path.clone()).map_err(|source| Error::UnsafePath {
                    path: file.path.clone(),
                    source,
                })?;
            if !seen.insert(path.comparison_key()) {
                return Err(Error::DuplicatePath { path: file.path });
            }
            if file.downloads.is_empty() {
                return Err(Error::invalid(
                    MODRINTH_DOCUMENT,
                    format!("{} 没有下载地址", file.path),
                ));
            }
            for url in &file.downloads {
                check_download_url(url, READ_ALLOWED_HOSTS).map_err(|reason| {
                    Error::invalid(
                        MODRINTH_DOCUMENT,
                        format!("{} 的下载地址 {url} {reason}", file.path),
                    )
                })?;
            }
            let sha1 = file.hashes.sha1.to_ascii_lowercase();
            if sha1.len() != 40 || !sha1.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(Error::invalid(
                    MODRINTH_DOCUMENT,
                    format!("{} 的 sha1 不是 40 位十六进制", file.path),
                ));
            }
            files.push(ModrinthFile {
                path,
                urls: file.downloads,
                sha1,
                size: file.file_size,
                optional,
            });
        }

        Ok(PackManifest {
            format: PackFormat::Modrinth,
            name,
            version: Some(version),
            summary: raw.summary.filter(|s| !s.trim().is_empty()),
            author: None,
            minecraft,
            loader,
            remote: RemoteFiles::Modrinth(files),
            override_layers: vec!["overrides/".to_owned(), "client-overrides/".to_owned()],
        })
    }

    /// 解析 CurseForge `manifest.json`。
    pub fn parse_curseforge(bytes: &[u8]) -> Result<Self> {
        let raw: RawCurseForge = serde_json::from_slice(bytes)
            .map_err(|err| Error::invalid(CURSEFORGE_DOCUMENT, err.to_string()))?;
        if raw.manifest_type != "minecraftModpack" {
            return Err(Error::invalid(
                CURSEFORGE_DOCUMENT,
                format!(
                    "manifestType 为 {}，只认 minecraftModpack",
                    raw.manifest_type
                ),
            ));
        }
        if raw.manifest_version != 1 {
            return Err(Error::invalid(
                CURSEFORGE_DOCUMENT,
                format!("manifestVersion 为 {}，只认 1", raw.manifest_version),
            ));
        }
        let name = required_text(CURSEFORGE_DOCUMENT, "name", &raw.name)?;
        let minecraft = required_text(
            CURSEFORGE_DOCUMENT,
            "minecraft.version",
            &raw.minecraft.version,
        )?;
        let loader = raw
            .minecraft
            .mod_loaders
            .iter()
            .find(|l| l.primary)
            .or_else(|| raw.minecraft.mod_loaders.first())
            .map(|l| curseforge_loader(&l.id))
            .transpose()?;

        // 非必需的文件在 CurseForge 里是作者停用的项，不装；同一文件写了两遍只装一次。
        let mut seen = HashSet::new();
        let files = raw
            .files
            .iter()
            .filter(|f| f.required)
            .filter(|f| seen.insert(f.file_id))
            .map(|f| CurseForgeFileRef {
                project_id: f.project_id,
                file_id: f.file_id,
            })
            .collect();

        let overrides = raw.overrides.unwrap_or_else(|| "overrides".to_owned());
        let dir = SafeRelativePath::new(overrides.clone()).map_err(|source| Error::UnsafePath {
            path: overrides.clone(),
            source,
        })?;

        Ok(PackManifest {
            format: PackFormat::CurseForge,
            name,
            version: raw.version.filter(|v| !v.trim().is_empty()),
            summary: None,
            author: raw.author.filter(|a| !a.trim().is_empty()),
            minecraft,
            loader,
            remote: RemoteFiles::CurseForge(files),
            override_layers: vec![format!("{}/", dir.as_str())],
        })
    }
}

fn required_text(document: &'static str, field: &str, value: &str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(Error::invalid(document, format!("{field} 为空")));
    }
    Ok(trimmed.to_owned())
}

/// 加载器版本号会原样拼进安装器的下载地址、缓存文件名与版本 id，必须是单个安全的路径段。
fn loader_version(document: &'static str, field: &str, value: &str) -> Result<String> {
    let version = required_text(document, field, value)?;
    aurora_version::check_path_segment(&version).map_err(|problem| {
        Error::invalid(
            document,
            format!("{field} 的加载器版本号「{version}」不能用：{problem}"),
        )
    })?;
    Ok(version)
}

/// Modrinth 的加载器依赖：至多一个。新出现的依赖 id 按格式约定可能随时增加，不认识的只记日志。
fn modrinth_loader(dependencies: &BTreeMap<String, String>) -> Result<Option<PackLoader>> {
    let mut found = Vec::new();
    for (key, value) in dependencies {
        if key == "minecraft" {
            continue;
        }
        let Some(kind) = PACK_LOADER_KINDS
            .into_iter()
            .find(|kind| loader_dependency_key(*kind) == key)
        else {
            tracing::warn!(dependency = %key, version = %value, "Modrinth 整合包依赖里有不认识的项，忽略");
            continue;
        };
        found.push(PackLoader {
            kind,
            version: loader_version(MODRINTH_DOCUMENT, &format!("dependencies.{key}"), value)?,
        });
    }
    match found.len() {
        0 => Ok(None),
        1 => Ok(found.pop()),
        _ => Err(Error::invalid(
            MODRINTH_DOCUMENT,
            "dependencies 里同时要求了多个加载器",
        )),
    }
}

/// 加载器在 Modrinth 清单 `dependencies` 里的键。读包与写包共用，两边对同一个加载器不会认出两种写法。
pub(crate) fn loader_dependency_key(kind: PackLoaderKind) -> &'static str {
    match kind {
        PackLoaderKind::Fabric => "fabric-loader",
        PackLoaderKind::Quilt => "quilt-loader",
        PackLoaderKind::Forge => "forge",
        PackLoaderKind::NeoForge => "neoforge",
    }
}

/// CurseForge 的加载器 id：`<加载器>-<版本>`，如 `forge-47.2.0`、`neoforge-21.1.42`、`fabric-0.15.0`。
fn curseforge_loader(id: &str) -> Result<PackLoader> {
    let (kind, version) = id
        .split_once('-')
        .ok_or_else(|| Error::invalid(CURSEFORGE_DOCUMENT, format!("加载器 id {id} 缺少版本")))?;
    let kind = match kind.to_ascii_lowercase().as_str() {
        "fabric" => PackLoaderKind::Fabric,
        "quilt" => PackLoaderKind::Quilt,
        "forge" => PackLoaderKind::Forge,
        "neoforge" => PackLoaderKind::NeoForge,
        _ => {
            return Err(Error::invalid(
                CURSEFORGE_DOCUMENT,
                format!("加载器 {id} 不支持"),
            ));
        }
    };
    Ok(PackLoader {
        kind,
        version: loader_version(CURSEFORGE_DOCUMENT, "minecraft.modLoaders[].id", version)?,
    })
}

/// 下载地址只收 https、不带用户凭据、主机在 `allowed` 的某一张表里；返回拒收原因。读包与导出共用这一套
/// 判定，只是认的主机表不同。
pub(crate) fn check_download_url(
    raw: &str,
    allowed: &[&[&str]],
) -> std::result::Result<(), &'static str> {
    let url = url::Url::parse(raw).map_err(|_| "不是合法地址")?;
    if url.scheme() != "https" {
        return Err("不是 https");
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("带有用户凭据");
    }
    let host = url.host_str().ok_or("没有主机名")?;
    if !allowed.iter().any(|hosts| hosts.contains(&host)) {
        return Err("的主机不在允许范围内");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index(files: serde_json::Value, dependencies: serde_json::Value) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "formatVersion": 1, "game": "minecraft", "versionId": "1.0.0", "name": "测试包",
            "files": files, "dependencies": dependencies
        }))
        .unwrap()
    }

    fn file(path: &str, client: Option<&str>, url: &str) -> serde_json::Value {
        let mut value = serde_json::json!({
            "path": path,
            "hashes": {"sha1": "0F4A890D07402280686A518579FA9FA02309E315", "sha512": "x"},
            "downloads": [url],
            "fileSize": 10
        });
        if let Some(client) = client {
            value["env"] = serde_json::json!({"client": client, "server": "required"});
        }
        value
    }

    const CDN: &str = "https://cdn.modrinth.com/data/a/versions/b/a.jar";

    #[test]
    fn parses_real_modrinth_index_excerpt() {
        let bytes =
            include_bytes!("../tests/fixtures/fabulously-optimized-14.1.1.modrinth.index.json");
        let pack = PackManifest::parse_modrinth(bytes).unwrap();
        assert_eq!(pack.format, PackFormat::Modrinth);
        assert_eq!(pack.name, "Fabulously Optimized");
        assert_eq!(pack.version.as_deref(), Some("14.1.1"));
        assert_eq!(pack.minecraft, "26.2");
        assert_eq!(
            pack.loader,
            Some(PackLoader {
                kind: PackLoaderKind::Fabric,
                version: "0.19.5".into()
            })
        );
        let RemoteFiles::Modrinth(files) = &pack.remote else {
            panic!("应为 Modrinth 文件");
        };
        assert_eq!(files.len(), 3);
        assert_eq!(
            files[0].path.as_str(),
            "mods/BetterGrassify-1.8.7+fabric.26.2.jar"
        );
        assert_eq!(files[0].sha1, "0f4a890d07402280686a518579fa9fa02309e315");
        assert_eq!(files[0].size, 88858);
        assert!(!files[0].optional);
        assert_eq!(
            pack.override_layers,
            vec!["overrides/", "client-overrides/"]
        );
    }

    #[test]
    fn parses_real_curseforge_manifest_excerpt() {
        let bytes = include_bytes!("../tests/fixtures/fabulously-optimized-14.1.1.manifest.json");
        let pack = PackManifest::parse_curseforge(bytes).unwrap();
        assert_eq!(pack.format, PackFormat::CurseForge);
        assert_eq!(pack.name, "Fabulously Optimized");
        assert_eq!(pack.version.as_deref(), Some("14.1.1"));
        assert_eq!(pack.author.as_deref(), Some("robotkoer"));
        assert_eq!(pack.minecraft, "26.2");
        assert_eq!(pack.loader.as_ref().unwrap().kind, PackLoaderKind::Fabric);
        assert_eq!(pack.loader.as_ref().unwrap().version, "0.19.5");
        assert_eq!(
            pack.remote,
            RemoteFiles::CurseForge(vec![
                CurseForgeFileRef {
                    project_id: 844662,
                    file_id: 9064962
                },
                CurseForgeFileRef {
                    project_id: 308702,
                    file_id: 8966634
                },
                CurseForgeFileRef {
                    project_id: 1367508,
                    file_id: 8973656
                },
            ])
        );
        assert_eq!(pack.override_layers, vec!["overrides/"]);
    }

    #[test]
    fn modrinth_env_skips_server_only_and_marks_optional() {
        let pack = PackManifest::parse_modrinth(&index(
            serde_json::json!([
                file("mods/a.jar", Some("required"), CDN),
                file("mods/b.jar", Some("optional"), CDN),
                file("mods/server-only.jar", Some("unsupported"), CDN),
                file("mods/c.jar", None, CDN)
            ]),
            serde_json::json!({"minecraft": "1.21.1"}),
        ))
        .unwrap();
        let RemoteFiles::Modrinth(files) = pack.remote else {
            panic!()
        };
        let paths: Vec<_> = files
            .iter()
            .map(|f| (f.path.as_str().to_owned(), f.optional))
            .collect();
        assert_eq!(
            paths,
            vec![
                ("mods/a.jar".to_owned(), false),
                ("mods/b.jar".to_owned(), true),
                ("mods/c.jar".to_owned(), false)
            ]
        );
        assert_eq!(pack.loader, None, "只有 minecraft 依赖即原版整合包");
    }

    fn optional_pack() -> RemoteFiles {
        PackManifest::parse_modrinth(&index(
            serde_json::json!([
                file("mods/required.jar", Some("required"), CDN),
                file("mods/Helper.jar", Some("optional"), CDN),
                file("resourcepacks/extra.zip", Some("optional"), CDN),
                file("mods/plain.jar", None, CDN)
            ]),
            serde_json::json!({"minecraft": "1.21.1"}),
        ))
        .unwrap()
        .remote
    }

    fn remaining(remote: &RemoteFiles) -> Vec<String> {
        let RemoteFiles::Modrinth(files) = remote else {
            panic!("应为 Modrinth 文件")
        };
        files.iter().map(|f| f.path.as_str().to_owned()).collect()
    }

    #[test]
    fn exclude_optional_drops_only_the_chosen_optional_files() {
        let mut remote = optional_pack();
        assert_eq!(remote.len(), 4);
        assert_eq!(remote.exclude_optional(&[]).unwrap(), 0);
        assert_eq!(remote.len(), 4);

        assert_eq!(
            remote
                .exclude_optional(&["resourcepacks/extra.zip".into()])
                .unwrap(),
            1
        );
        assert_eq!(remote.len(), 3);
        assert_eq!(
            remaining(&remote),
            vec!["mods/required.jar", "mods/Helper.jar", "mods/plain.jar"]
        );

        // 落点按 Windows 规则比较；同一个文件写两遍只去掉一次。
        assert_eq!(
            remote
                .exclude_optional(&["MODS/helper.JAR".into(), "mods/Helper.jar".into()])
                .unwrap(),
            1
        );
        assert_eq!(
            remaining(&remote),
            vec!["mods/required.jar", "mods/plain.jar"]
        );
    }

    #[test]
    fn exclude_optional_rejects_paths_that_are_not_optional_and_leaves_list_intact() {
        for bad in [
            "mods/required.jar",
            "mods/plain.jar",
            "mods/not-in-pack.jar",
            "../mods/Helper.jar",
            "",
        ] {
            let mut remote = optional_pack();
            // 合法的那一项排在前面：出错时也不能先把它去掉。
            let err = remote
                .exclude_optional(&["mods/Helper.jar".into(), bad.into()])
                .unwrap_err();
            assert!(
                matches!(&err, Error::NotOptional { path } if path == bad),
                "{bad}: {err:?}"
            );
            assert_eq!(remote.len(), 4, "{bad}");
        }
    }

    #[test]
    fn exclude_optional_on_curseforge_only_accepts_an_empty_list() {
        let mut remote = RemoteFiles::CurseForge(vec![CurseForgeFileRef {
            project_id: 1,
            file_id: 10,
        }]);
        assert_eq!(remote.exclude_optional(&[]).unwrap(), 0);
        let err = remote.exclude_optional(&["mods/a.jar".into()]).unwrap_err();
        assert!(matches!(&err, Error::NotOptional { path } if path == "mods/a.jar"));
        assert_eq!(remote.len(), 1);
    }

    #[test]
    fn exclude_optional_random_subsets_shrink_by_exactly_the_subset() {
        // 固定种子的 xorshift：每轮随机挑一组可选文件跳过，可复现。
        let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        for round in 0..32 {
            let total = (next() % 40) as usize + 1;
            let files: Vec<_> = (0..total)
                .map(|i| {
                    let client = if next() % 2 == 0 {
                        "optional"
                    } else {
                        "required"
                    };
                    file(&format!("mods/m{i:02}.jar"), Some(client), CDN)
                })
                .collect();
            let mut remote = PackManifest::parse_modrinth(&index(
                serde_json::Value::Array(files),
                serde_json::json!({"minecraft": "1.21.1"}),
            ))
            .unwrap()
            .remote;
            let RemoteFiles::Modrinth(parsed) = &remote else {
                panic!()
            };
            let mut chosen = Vec::new();
            for f in parsed.iter().filter(|f| f.optional) {
                match next() % 3 {
                    0 => {}
                    1 => chosen.push(f.path.as_str().to_owned()),
                    _ => chosen.push(f.path.as_str().to_uppercase()),
                }
            }
            let removed = remote.exclude_optional(&chosen).unwrap();
            assert_eq!(removed, chosen.len(), "round {round}");
            assert_eq!(remote.len(), total - chosen.len(), "round {round}");
            let left: HashSet<String> = remaining(&remote)
                .into_iter()
                .map(|p| p.to_lowercase())
                .collect();
            assert!(
                chosen.iter().all(|c| !left.contains(&c.to_lowercase())),
                "round {round}"
            );
        }
    }

    #[test]
    fn modrinth_loader_dependency_maps_each_kind_and_rejects_two() {
        for (key, kind) in [
            ("fabric-loader", PackLoaderKind::Fabric),
            ("quilt-loader", PackLoaderKind::Quilt),
            ("forge", PackLoaderKind::Forge),
            ("neoforge", PackLoaderKind::NeoForge),
        ] {
            let pack = PackManifest::parse_modrinth(&index(
                serde_json::json!([]),
                serde_json::json!({"minecraft": "1.21.1", key: "1.2.3", "some-future-thing": "9"}),
            ))
            .unwrap();
            assert_eq!(
                pack.loader.unwrap(),
                PackLoader {
                    kind,
                    version: "1.2.3".into()
                }
            );
        }
        let err = PackManifest::parse_modrinth(&index(
            serde_json::json!([]),
            serde_json::json!({"minecraft": "1.21.1", "forge": "1", "fabric-loader": "2"}),
        ))
        .unwrap_err();
        assert!(matches!(err, Error::ManifestInvalid { .. }), "{err:?}");
    }

    /// 加载器版本号会拼进安装器的下载地址、缓存文件名与版本 id：带分隔符、`..` 或盘符的取值在读清单时就
    /// 拒掉，预览与导入都报清单不合法，不等到安装时才出问题。
    #[test]
    fn loader_versions_that_are_not_a_single_path_segment_are_rejected() {
        for version in [r"47.2.0\..\..\x", "47.2.0/../x", "..", "C:47", "47.2.0."] {
            let err = PackManifest::parse_modrinth(&index(
                serde_json::json!([]),
                serde_json::json!({"minecraft": "1.20.1", "forge": version}),
            ))
            .unwrap_err();
            assert!(
                matches!(
                    &err,
                    Error::ManifestInvalid { document, reason }
                        if *document == MODRINTH_DOCUMENT
                            && reason.contains("dependencies.forge")
                            && reason.contains(version)
                ),
                "{version}：{err:?}"
            );

            let err = PackManifest::parse_curseforge(&curseforge(
                serde_json::json!([{"id": format!("forge-{version}"), "primary": true}]),
                serde_json::json!([]),
            ))
            .unwrap_err();
            assert!(
                matches!(
                    &err,
                    Error::ManifestInvalid { document, reason }
                        if *document == CURSEFORGE_DOCUMENT && reason.contains(version)
                ),
                "{version}：{err:?}"
            );
        }
    }

    #[test]
    fn modrinth_rejects_format_game_and_missing_minecraft() {
        let mut bad_format: serde_json::Value = serde_json::from_slice(&index(
            serde_json::json!([]),
            serde_json::json!({"minecraft": "1.21.1"}),
        ))
        .unwrap();
        bad_format["formatVersion"] = 2.into();
        let err =
            PackManifest::parse_modrinth(&serde_json::to_vec(&bad_format).unwrap()).unwrap_err();
        assert!(matches!(&err, Error::ManifestInvalid { reason, .. } if reason.contains('2')));

        let mut bad_game = bad_format.clone();
        bad_game["formatVersion"] = 1.into();
        bad_game["game"] = "terraria".into();
        assert!(PackManifest::parse_modrinth(&serde_json::to_vec(&bad_game).unwrap()).is_err());

        let err =
            PackManifest::parse_modrinth(&index(serde_json::json!([]), serde_json::json!({})))
                .unwrap_err();
        assert!(
            matches!(&err, Error::ManifestInvalid { reason, .. } if reason.contains("minecraft"))
        );

        let err = PackManifest::parse_modrinth(b"{not json").unwrap_err();
        assert!(matches!(
            err,
            Error::ManifestInvalid {
                document: "modrinth.index.json",
                ..
            }
        ));
    }

    #[test]
    fn modrinth_rejects_unsafe_paths_hosts_hashes_and_duplicates() {
        let deps = serde_json::json!({"minecraft": "1.21.1"});
        let traversal = PackManifest::parse_modrinth(&index(
            serde_json::json!([file("mods/../../evil.jar", None, CDN)]),
            deps.clone(),
        ))
        .unwrap_err();
        assert!(matches!(traversal, Error::UnsafePath { .. }));

        let meta = format!("{}/modpack.json", aurora_instance::AURORA_META_DIR);
        let into_meta = PackManifest::parse_modrinth(&index(
            serde_json::json!([file(&meta, None, CDN)]),
            deps.clone(),
        ))
        .unwrap_err();
        assert!(matches!(into_meta, Error::UnsafePath { .. }));

        for url in [
            "http://cdn.modrinth.com/a.jar",
            "https://192.168.1.2/a.jar",
            "https://evil.example.com/a.jar",
            "https://user:pw@cdn.modrinth.com/a.jar",
            "not a url",
        ] {
            let err = PackManifest::parse_modrinth(&index(
                serde_json::json!([file("mods/a.jar", None, url)]),
                deps.clone(),
            ))
            .unwrap_err();
            assert!(
                matches!(err, Error::ManifestInvalid { .. }),
                "{url}: {err:?}"
            );
        }
        assert!(
            PackManifest::parse_modrinth(&index(
                serde_json::json!([file(
                    "mods/a.jar",
                    None,
                    "https://edge.forgecdn.net/files/1/2/a.jar"
                )]),
                deps.clone(),
            ))
            .is_ok()
        );

        let mut bad_hash = file("mods/a.jar", None, CDN);
        bad_hash["hashes"]["sha1"] = "abc".into();
        assert!(matches!(
            PackManifest::parse_modrinth(&index(serde_json::json!([bad_hash]), deps.clone())),
            Err(Error::ManifestInvalid { .. })
        ));

        let duplicate = PackManifest::parse_modrinth(&index(
            serde_json::json!([file("mods/A.jar", None, CDN), file("mods/a.jar", None, CDN)]),
            deps,
        ))
        .unwrap_err();
        assert!(matches!(duplicate, Error::DuplicatePath { path } if path == "mods/a.jar"));
    }

    fn curseforge(loaders: serde_json::Value, files: serde_json::Value) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "minecraft": {"version": "1.20.1", "modLoaders": loaders},
            "manifestType": "minecraftModpack", "manifestVersion": 1,
            "name": "Pack", "version": "2.0", "author": "someone", "files": files,
            "overrides": "overrides"
        }))
        .unwrap()
    }

    #[test]
    fn curseforge_loader_ids_parse_and_primary_wins() {
        for (id, kind, version) in [
            ("forge-47.2.0", PackLoaderKind::Forge, "47.2.0"),
            ("neoforge-21.1.42", PackLoaderKind::NeoForge, "21.1.42"),
            ("fabric-0.15.11", PackLoaderKind::Fabric, "0.15.11"),
            (
                "quilt-0.26.0-beta.1",
                PackLoaderKind::Quilt,
                "0.26.0-beta.1",
            ),
        ] {
            let pack = PackManifest::parse_curseforge(&curseforge(
                serde_json::json!([{"id": id, "primary": true}]),
                serde_json::json!([]),
            ))
            .unwrap();
            assert_eq!(
                pack.loader.unwrap(),
                PackLoader {
                    kind,
                    version: version.into()
                }
            );
        }
        let pack = PackManifest::parse_curseforge(&curseforge(
            serde_json::json!([{"id": "forge-1", "primary": false}, {"id": "neoforge-2", "primary": true}]),
            serde_json::json!([]),
        ))
        .unwrap();
        assert_eq!(pack.loader.unwrap().kind, PackLoaderKind::NeoForge);
        for bad in ["rift-1.0", "forge", "forge-"] {
            let err = PackManifest::parse_curseforge(&curseforge(
                serde_json::json!([{"id": bad, "primary": true}]),
                serde_json::json!([]),
            ))
            .unwrap_err();
            assert!(matches!(err, Error::ManifestInvalid { .. }), "{bad}");
        }
        let vanilla = PackManifest::parse_curseforge(&curseforge(
            serde_json::json!([]),
            serde_json::json!([]),
        ))
        .unwrap();
        assert_eq!(vanilla.loader, None);
    }

    #[test]
    fn curseforge_drops_unrequired_and_duplicate_files() {
        let pack = PackManifest::parse_curseforge(&curseforge(
            serde_json::json!([{"id": "forge-47.2.0", "primary": true}]),
            serde_json::json!([
                {"projectID": 1, "fileID": 10, "required": true},
                {"projectID": 2, "fileID": 20, "required": false},
                {"projectID": 1, "fileID": 10, "required": true},
                {"projectID": 3, "fileID": 30}
            ]),
        ))
        .unwrap();
        assert_eq!(
            pack.remote,
            RemoteFiles::CurseForge(vec![
                CurseForgeFileRef {
                    project_id: 1,
                    file_id: 10
                },
                CurseForgeFileRef {
                    project_id: 3,
                    file_id: 30
                },
            ])
        );
        assert_eq!(pack.remote.len(), 2);
    }

    #[test]
    fn curseforge_rejects_wrong_type_and_unsafe_overrides_dir() {
        let mut doc: serde_json::Value =
            serde_json::from_slice(&curseforge(serde_json::json!([]), serde_json::json!([])))
                .unwrap();
        doc["manifestType"] = "minecraftServer".into();
        assert!(matches!(
            PackManifest::parse_curseforge(&serde_json::to_vec(&doc).unwrap()),
            Err(Error::ManifestInvalid { .. })
        ));
        doc["manifestType"] = "minecraftModpack".into();
        doc["overrides"] = "../outside".into();
        assert!(matches!(
            PackManifest::parse_curseforge(&serde_json::to_vec(&doc).unwrap()),
            Err(Error::UnsafePath { .. })
        ));
        doc["overrides"] = "custom-overrides".into();
        let pack = PackManifest::parse_curseforge(&serde_json::to_vec(&doc).unwrap()).unwrap();
        assert_eq!(pack.override_layers, vec!["custom-overrides/"]);
    }
}
