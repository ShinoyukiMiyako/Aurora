//! 本地已装模组管理：扫描 `mods/` 目录、读取 jar 内元数据、启用/禁用切换。
//!
//! 支持四种元数据格式：Fabric 的 `fabric.mod.json`（jar 根）、Quilt 的 `quilt.mod.json`（jar 根）、
//! Forge 的 `META-INF/mods.toml`、NeoForge 的 `META-INF/neoforge.mods.toml`。启禁状态以文件名
//! `.disabled` 后缀表达。jar 即 zip，读取走 spawn_blocking 避免阻塞异步 worker。

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::model::ModLoader;

/// 元数据来源格式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MetadataFormat {
    /// Fabric 的 `fabric.mod.json`。
    Fabric,
    /// Quilt 的 `quilt.mod.json`。
    QuiltModJson,
    /// Forge 的 `META-INF/mods.toml`。
    ForgeToml,
    /// NeoForge 的 `META-INF/neoforge.mods.toml`。
    NeoForgeToml,
}

/// 从 jar 解析出的模组元数据。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModMetadata {
    /// 模组 id。
    pub mod_id: String,
    /// 展示名。
    pub name: Option<String>,
    /// 版本号（Forge/NeoForge 可能是 `${file.jarVersion}` 占位符，原样保留）。
    pub version: Option<String>,
    /// 描述。
    pub description: Option<String>,
    /// 作者列表。
    pub authors: Vec<String>,
    /// 声明的依赖 mod id 列表：Fabric 取 `depends` 的键，Forge/NeoForge 取
    /// `[[dependencies.<modid>]]` 中必需的项，Quilt 取 `quilt_loader.depends` 的非可选项。
    /// 含 `minecraft` / `fabricloader` / `java` 这类平台伪 mod——这里是依赖声明的原样索引，
    /// 要不要过滤由使用方按场景决定。
    #[serde(default)]
    pub depends: Vec<String>,
    /// 声明支持的 MC 版本约束原文（Fabric `depends.minecraft`、Forge/NeoForge 依赖里
    /// `minecraft` 的 `versionRange`、Quilt `minecraft` 依赖的 `versions`）；取不到为 `None`。
    #[serde(default)]
    pub minecraft_version: Option<String>,
    /// 所属加载器。
    pub loader: ModLoader,
    /// 元数据来源格式。
    pub format: MetadataFormat,
}

/// 一个已装模组条目。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InstalledMod {
    /// 磁盘路径。
    pub path: PathBuf,
    /// 磁盘上的文件名（可能带 `.disabled` 后缀）。
    pub file_name: String,
    /// 是否启用（无 `.disabled` 后缀）。
    pub enabled: bool,
    /// 解析出的元数据；无可识别描述文件或不是合法 jar 时为 `None`。
    pub metadata: Option<ModMetadata>,
}

const FABRIC_DESCRIPTOR: &str = "fabric.mod.json";
const QUILT_DESCRIPTOR: &str = "quilt.mod.json";
const FORGE_DESCRIPTOR: &str = "META-INF/mods.toml";
const NEOFORGE_DESCRIPTOR: &str = "META-INF/neoforge.mods.toml";
const DISABLED_SUFFIX: &str = ".disabled";
/// 各格式里表示「原版游戏本体」的依赖 id，用来抽出 MC 版本约束。
const MINECRAFT_DEPENDENCY_ID: &str = "minecraft";

/// 文件名是否是（启用或禁用态的）模组 jar。
fn is_mod_file(name: &str) -> bool {
    let base = name.strip_suffix(DISABLED_SUFFIX).unwrap_or(name);
    base.ends_with(".jar")
}

/// 文件名是否为禁用态（带 `.disabled` 后缀）。
pub fn is_disabled(name: &str) -> bool {
    name.ends_with(DISABLED_SUFFIX)
}

/// 扫描 `mods/` 目录，返回所有模组条目（按文件名排序，结果稳定）。
///
/// 单个 jar 元数据解析失败不会中断整轮扫描：记 `warn` 日志并把该条以「无元数据」列出——一个损坏
/// 模组不应让整份列表瞎掉。目录本身不可读才向上冒泡。
pub async fn scan_mods_dir(dir: impl AsRef<Path>) -> Result<Vec<InstalledMod>> {
    let dir = dir.as_ref();
    let mut read_dir = tokio::fs::read_dir(dir).await.map_err(|source| {
        Error::Base(aurora_base::Error::Io {
            path: dir.to_owned(),
            source,
        })
    })?;

    let mut mods = Vec::new();
    while let Some(entry) = read_dir.next_entry().await.map_err(|source| {
        Error::Base(aurora_base::Error::Io {
            path: dir.to_owned(),
            source,
        })
    })? {
        let file_type = entry.file_type().await.map_err(|source| {
            Error::Base(aurora_base::Error::Io {
                path: entry.path(),
                source,
            })
        })?;
        if !file_type.is_file() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if !is_mod_file(&file_name) {
            continue;
        }
        let path = entry.path();
        let enabled = !is_disabled(&file_name);
        let metadata = match parse_mod_metadata(&path).await {
            Ok(metadata) => metadata,
            Err(error) => {
                tracing::warn!(
                    path = %path.display(),
                    error = %error,
                    "解析模组元数据失败，按无元数据列出"
                );
                None
            }
        };
        mods.push(InstalledMod {
            path,
            file_name,
            enabled,
            metadata,
        });
    }

    mods.sort_by(|a, b| a.file_name.cmp(&b.file_name));
    Ok(mods)
}

/// 解析单个 jar 的模组元数据。无可识别描述文件或非合法 zip 返回 `Ok(None)`；描述文件存在但内容
/// 损坏返回 `Err`（不掩盖）。
pub async fn parse_mod_metadata(path: impl AsRef<Path>) -> Result<Option<ModMetadata>> {
    let path = path.as_ref().to_owned();
    tokio::task::spawn_blocking(move || extract_metadata_blocking(&path))
        .await
        .map_err(|source| Error::Base(aurora_base::Error::HashTaskJoin(source)))?
}

fn extract_metadata_blocking(path: &Path) -> Result<Option<ModMetadata>> {
    let file = std::fs::File::open(path).map_err(|source| {
        Error::Base(aurora_base::Error::Io {
            path: path.to_owned(),
            source,
        })
    })?;
    let mut archive = match zip::ZipArchive::new(file) {
        Ok(archive) => archive,
        // 不是合法 zip/jar（例如占位文件）：按「无元数据」处理，而非报错。
        Err(zip::result::ZipError::InvalidArchive(_)) => return Ok(None),
        Err(source) => {
            return Err(Error::Zip {
                path: path.to_owned(),
                source,
            });
        }
    };

    // 优先级：neoforge.mods.toml -> mods.toml -> quilt.mod.json -> fabric.mod.json。
    // quilt 排在 fabric 前是因为 Quilt 模组普遍额外附带一份 fabric.mod.json 兼容垫片（Quilt 加载器
    // 也能直接读 Fabric 描述文件），显式声明的 quilt.mod.json 才是这个 jar 的真实身份。
    if let Some(bytes) = read_entry(&mut archive, NEOFORGE_DESCRIPTOR, path)? {
        return parse_toml_metadata(
            &bytes,
            ModLoader::NeoForge,
            MetadataFormat::NeoForgeToml,
            path,
        );
    }
    if let Some(bytes) = read_entry(&mut archive, FORGE_DESCRIPTOR, path)? {
        return parse_toml_metadata(&bytes, ModLoader::Forge, MetadataFormat::ForgeToml, path);
    }
    if let Some(bytes) = read_entry(&mut archive, QUILT_DESCRIPTOR, path)? {
        return parse_quilt_metadata(&bytes, path);
    }
    if let Some(bytes) = read_entry(&mut archive, FABRIC_DESCRIPTOR, path)? {
        return parse_fabric_metadata(&bytes, path);
    }
    Ok(None)
}

/// 把 JSON 里的版本约束渲染成一句原文：字符串原样取；字符串数组按「或」语义用 ` || ` 连接
/// （Fabric 与 Quilt 的数组形态都是这个语义）。其余形态（Quilt 的 `{any:[...]}` 嵌套对象）
/// 无法压成一句话，返回 `None`——约束原文只用于展示，取不到就不展示，不编。
fn json_version_constraint(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(text) => Some(text.clone()),
        serde_json::Value::Array(items) => {
            let parts: Option<Vec<&str>> = items.iter().map(|item| item.as_str()).collect();
            let parts = parts?;
            if parts.is_empty() {
                None
            } else {
                Some(parts.join(" || "))
            }
        }
        _ => None,
    }
}

/// 从 zip 里读取指定条目的全部字节；条目不存在返回 `Ok(None)`。
fn read_entry(
    archive: &mut zip::ZipArchive<std::fs::File>,
    name: &str,
    path: &Path,
) -> Result<Option<Vec<u8>>> {
    match archive.by_name(name) {
        Ok(mut entry) => {
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf).map_err(|source| Error::Zip {
                path: path.to_owned(),
                source: zip::result::ZipError::Io(source),
            })?;
            Ok(Some(buf))
        }
        Err(zip::result::ZipError::FileNotFound) => Ok(None),
        Err(source) => Err(Error::Zip {
            path: path.to_owned(),
            source,
        }),
    }
}

/// `fabric.mod.json` 里作者可为字符串或 `{ "name": ... }` 对象。
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum FabricAuthor {
    Name(String),
    Detailed { name: String },
}

#[derive(Debug, Deserialize)]
struct FabricModJson {
    id: String,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    authors: Vec<FabricAuthor>,
    /// mod id -> 版本约束（字符串或字符串数组）。用 BTreeMap 而非 HashMap，让依赖列表按字典序
    /// 稳定输出，避免同一个 jar 每次扫描得到不同顺序。
    #[serde(default)]
    depends: BTreeMap<String, serde_json::Value>,
}

fn parse_fabric_metadata(bytes: &[u8], path: &Path) -> Result<Option<ModMetadata>> {
    let raw: FabricModJson = serde_json::from_slice(bytes).map_err(|source| Error::Json {
        context: format!("fabric.mod.json in {}", path.display()),
        source,
    })?;
    let authors = raw
        .authors
        .into_iter()
        .map(|author| match author {
            FabricAuthor::Name(name) => name,
            FabricAuthor::Detailed { name } => name,
        })
        .collect();
    let minecraft_version = raw
        .depends
        .get(MINECRAFT_DEPENDENCY_ID)
        .and_then(json_version_constraint);
    // Fabric 的 depends 全是硬依赖，可选项走独立的 recommends/suggests 字段，这里不收。
    let depends = raw.depends.into_keys().collect();
    Ok(Some(ModMetadata {
        mod_id: raw.id,
        name: raw.name,
        version: raw.version,
        description: raw.description,
        authors,
        depends,
        minecraft_version,
        loader: ModLoader::Fabric,
        format: MetadataFormat::Fabric,
    }))
}

#[derive(Debug, Deserialize)]
struct QuiltModJson {
    quilt_loader: QuiltLoader,
}

#[derive(Debug, Deserialize)]
struct QuiltLoader {
    id: String,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    metadata: Option<QuiltMetadata>,
    #[serde(default)]
    depends: Vec<QuiltDependency>,
}

#[derive(Debug, Deserialize)]
struct QuiltMetadata {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    /// 键是贡献者名，值是角色（字符串或字符串数组）。作者名只取键。
    #[serde(default)]
    contributors: BTreeMap<String, serde_json::Value>,
}

/// `quilt_loader.depends` 条目的三种合法形态：裸 id 串、详细对象、以及「任选其一」的嵌套数组。
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum QuiltDependency {
    Id(String),
    Detailed {
        id: String,
        #[serde(default)]
        versions: Option<serde_json::Value>,
        #[serde(default)]
        optional: bool,
    },
    Alternatives(Vec<QuiltDependency>),
}

impl QuiltDependency {
    /// 展平成 `(id, 版本约束)` 追加到 `out`。
    ///
    /// 「任选其一」的嵌套组同样被拉平收下：本字段是依赖声明的索引而非安装计划，列全比漏列有用。
    /// `optional: true` 的项跳过，与 Forge 只收必需依赖保持一致。
    fn collect_required(&self, out: &mut Vec<(String, Option<String>)>) {
        match self {
            QuiltDependency::Id(id) => out.push((id.clone(), None)),
            QuiltDependency::Detailed {
                id,
                versions,
                optional,
            } => {
                if !*optional {
                    out.push((
                        id.clone(),
                        versions.as_ref().and_then(json_version_constraint),
                    ));
                }
            }
            QuiltDependency::Alternatives(items) => {
                for item in items {
                    item.collect_required(out);
                }
            }
        }
    }
}

/// Quilt 的依赖 id 允许带 maven group 前缀（`group:id`），比对时只看末段。
fn quilt_dependency_tail(declared: &str) -> &str {
    match declared.rsplit_once(':') {
        Some((_, tail)) => tail,
        None => declared,
    }
}

fn parse_quilt_metadata(bytes: &[u8], path: &Path) -> Result<Option<ModMetadata>> {
    let raw: QuiltModJson = serde_json::from_slice(bytes).map_err(|source| Error::Json {
        context: format!("quilt.mod.json in {}", path.display()),
        source,
    })?;
    let loader = raw.quilt_loader;

    let mut declared: Vec<(String, Option<String>)> = Vec::new();
    for dependency in &loader.depends {
        dependency.collect_required(&mut declared);
    }
    let minecraft_version = declared
        .iter()
        .find(|(id, _)| quilt_dependency_tail(id) == MINECRAFT_DEPENDENCY_ID)
        .and_then(|(_, constraint)| constraint.clone());
    let depends = declared.into_iter().map(|(id, _)| id).collect();

    let (name, description, authors) = match loader.metadata {
        Some(metadata) => (
            metadata.name,
            metadata.description,
            metadata.contributors.into_keys().collect(),
        ),
        None => (None, None, Vec::new()),
    };

    Ok(Some(ModMetadata {
        mod_id: loader.id,
        name,
        version: loader.version,
        description,
        authors,
        depends,
        minecraft_version,
        loader: ModLoader::Quilt,
        format: MetadataFormat::QuiltModJson,
    }))
}

/// `mods.toml` 里 `authors` 的两种合法写法。
///
/// Forge 文档给的是逗号分隔的单字符串，但经 architectury 打包的模组会写成 TOML 数组
/// （DistantHorizons 的文件里甚至留了一句注释说明这是被 architectury 逼的），Forge 自己照读不误。
/// 这里必须两种都认：`toml::from_str` 是整份文件一起反序列化，单单一个 authors 字段类型对不上，
/// 整份 mods.toml 连同 modId / 版本 / 描述一起作废，模组在列表里会变成一条没名字的裸文件名。
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum TomlAuthors {
    One(String),
    Many(Vec<String>),
}

#[derive(Debug, Deserialize)]
struct ModsToml {
    #[serde(default)]
    mods: Vec<ModsTomlEntry>,
    /// 顶层作者（部分模组把 authors 写在顶层而非 `[[mods]]` 内）。
    #[serde(default)]
    authors: Option<TomlAuthors>,
    /// `[[dependencies.<modid>]]`：键是「声明这些依赖的那个 mod 的 id」，值是它的依赖数组。
    /// 一个 jar 里塞多个 mod 时会有多组。
    #[serde(default)]
    dependencies: BTreeMap<String, Vec<ModsTomlDependency>>,
}

#[derive(Debug, Deserialize)]
struct ModsTomlDependency {
    #[serde(rename = "modId")]
    mod_id: String,
    /// Forge 老写法。
    #[serde(default)]
    mandatory: Option<bool>,
    /// NeoForge 新写法：`required` / `optional` / `incompatible` / `discouraged`。
    #[serde(default, rename = "type")]
    kind: Option<String>,
    /// Maven 版本区间；NeoForge 侧默认空串表示「任意版本」。
    #[serde(default, rename = "versionRange")]
    version_range: Option<String>,
}

impl ModsTomlDependency {
    /// 是否必需依赖。
    ///
    /// NeoForge 的 `type` 优先（新写法，取值 required/optional/incompatible/discouraged），
    /// 回落到 Forge 的 `mandatory` 布尔；两者都没写时按 NeoForge 文档的默认值 `required` 处理——
    /// 该字段本就非必填，默认即必需。
    fn is_required(&self) -> bool {
        match self.kind.as_deref() {
            Some(kind) => kind.eq_ignore_ascii_case("required"),
            None => self.mandatory.unwrap_or(true),
        }
    }
}

#[derive(Debug, Deserialize)]
struct ModsTomlEntry {
    #[serde(rename = "modId")]
    mod_id: String,
    #[serde(default)]
    version: Option<String>,
    #[serde(default, rename = "displayName")]
    display_name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    authors: Option<TomlAuthors>,
}

fn parse_toml_metadata(
    bytes: &[u8],
    loader: ModLoader,
    format: MetadataFormat,
    path: &Path,
) -> Result<Option<ModMetadata>> {
    let text = std::str::from_utf8(bytes).map_err(|_| {
        Error::Base(aurora_base::Error::Io {
            path: path.to_owned(),
            source: std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "mods.toml 不是合法 UTF-8",
            ),
        })
    })?;
    let parsed: ModsToml = toml::from_str(text).map_err(|source| Error::Toml {
        context: format!("mods.toml in {}", path.display()),
        source,
    })?;

    // 取首个 [[mods]] 作为主模组。没有条目视为无可用元数据。
    let top_authors = parsed.authors;
    let dependencies = parsed.dependencies;
    let Some(entry) = parsed.mods.into_iter().next() else {
        return Ok(None);
    };
    let authors = split_authors(entry.authors.or(top_authors));

    // 依赖表以「声明方 mod id」为键。个别模组这里的大小写与 [[mods]] 的 modId 对不上（Forge 自身
    // 是精确匹配，这类文件在游戏里其实也不生效），我们放宽成大小写不敏感，尽量把依赖读出来。
    let declared: &[ModsTomlDependency] = match dependencies
        .iter()
        .find(|(owner, _)| owner.eq_ignore_ascii_case(&entry.mod_id))
    {
        Some((_, deps)) => deps,
        None => &[],
    };
    let minecraft_version = declared
        .iter()
        .find(|dep| dep.mod_id.eq_ignore_ascii_case(MINECRAFT_DEPENDENCY_ID))
        .and_then(|dep| dep.version_range.clone())
        // 空区间等于「任意版本」，等于没说，不如不给。
        .filter(|range| !range.trim().is_empty());
    let depends = declared
        .iter()
        .filter(|dep| dep.is_required())
        .map(|dep| dep.mod_id.clone())
        .collect();

    Ok(Some(ModMetadata {
        mod_id: entry.mod_id,
        name: entry.display_name,
        version: entry.version,
        description: entry.description,
        authors,
        depends,
        minecraft_version,
        loader,
        format,
    }))
}

/// 把 `"作者甲, 作者乙"` 或 `["作者甲", "作者乙"]` 归一成去空白、去空项的作者列表。
fn split_authors(raw: Option<TomlAuthors>) -> Vec<String> {
    let cleaned = |author: &str| -> Option<String> {
        let trimmed = author.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    };
    match raw {
        None => Vec::new(),
        // 字符串形态只能靠逗号猜分隔，作者名里真有逗号也就只能认了——这是这种写法自带的歧义。
        Some(TomlAuthors::One(value)) => value.split(',').filter_map(cleaned).collect(),
        // 数组形态作者已经自己分好了，不再二次切分：再切一刀会把 "Doe, John" 拆成两个人。
        Some(TomlAuthors::Many(list)) => list.iter().filter_map(|a| cleaned(a)).collect(),
    }
}

/// 切换模组启用/禁用状态，返回切换后的新路径。
///
/// 启用即去掉 `.disabled` 后缀，禁用即追加。若已处于目标状态则无操作返回原路径；若目标文件名已存在
/// （同名启用与禁用副本冲突）返回 [`Error::ModStateConflict`]，避免覆盖。
pub async fn set_mod_enabled(path: impl AsRef<Path>, enabled: bool) -> Result<PathBuf> {
    let path = path.as_ref();
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            Error::Base(aurora_base::Error::Io {
                path: path.to_owned(),
                source: std::io::Error::new(std::io::ErrorKind::InvalidInput, "路径缺少文件名"),
            })
        })?;

    let target_name = if enabled {
        name.strip_suffix(DISABLED_SUFFIX).unwrap_or(name).to_string()
    } else if is_disabled(name) {
        name.to_string()
    } else {
        format!("{name}{DISABLED_SUFFIX}")
    };

    // 已是目标状态：不动，返回原路径。
    if target_name == name {
        return Ok(path.to_owned());
    }

    let target_path = path.with_file_name(&target_name);
    let exists = tokio::fs::try_exists(&target_path).await.map_err(|source| {
        Error::Base(aurora_base::Error::Io {
            path: target_path.clone(),
            source,
        })
    })?;
    if exists {
        return Err(Error::ModStateConflict { path: target_path });
    }

    tokio::fs::rename(path, &target_path)
        .await
        .map_err(|source| {
            Error::Base(aurora_base::Error::Io {
                path: target_path.clone(),
                source,
            })
        })?;
    Ok(target_path)
}

/// 启用模组（去掉 `.disabled` 后缀）。
pub async fn enable_mod(path: impl AsRef<Path>) -> Result<PathBuf> {
    set_mod_enabled(path, true).await
}

/// 禁用模组（追加 `.disabled` 后缀）。
pub async fn disable_mod(path: impl AsRef<Path>) -> Result<PathBuf> {
    set_mod_enabled(path, false).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// 用给定条目写一个（deflate 压缩的）jar，读时会走真正的解压路径。
    fn build_jar(path: &Path, entries: &[(&str, &[u8])]) {
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, data) in entries {
            zip.start_file(*name, options).unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap();
    }

    #[tokio::test]
    async fn parses_fabric_mod_json() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("sodium.jar");
        // 原始 str + as_bytes：byte-string 字面量不允许非 ASCII，这里描述含中文。
        let descriptor = r#"{
            "schemaVersion": 1,
            "id": "sodium",
            "version": "0.5.3",
            "name": "Sodium",
            "description": "渲染优化",
            "authors": ["jellysquid3", {"name": "IMS"}],
            "depends": {
                "fabricloader": ">=0.14.0",
                "minecraft": "~1.20.1",
                "java": ">=17"
            }
        }"#
        .as_bytes();
        build_jar(&jar, &[("fabric.mod.json", descriptor)]);

        let meta = parse_mod_metadata(&jar).await.unwrap().expect("应有元数据");
        assert_eq!(meta.mod_id, "sodium");
        assert_eq!(meta.name.as_deref(), Some("Sodium"));
        assert_eq!(meta.version.as_deref(), Some("0.5.3"));
        assert_eq!(meta.authors, vec!["jellysquid3", "IMS"]);
        assert_eq!(meta.loader, ModLoader::Fabric);
        assert_eq!(meta.format, MetadataFormat::Fabric);
        // BTreeMap 保证字典序，扫描结果稳定。
        assert_eq!(meta.depends, vec!["fabricloader", "java", "minecraft"]);
        assert_eq!(meta.minecraft_version.as_deref(), Some("~1.20.1"));
    }

    #[tokio::test]
    async fn fabric_minecraft_constraint_array_joins_as_or() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("multi.jar");
        let descriptor = br#"{
            "id": "multi",
            "depends": {"minecraft": ["1.20.1", "1.20.2"]}
        }"#;
        build_jar(&jar, &[("fabric.mod.json", descriptor)]);

        let meta = parse_mod_metadata(&jar).await.unwrap().unwrap();
        assert_eq!(meta.minecraft_version.as_deref(), Some("1.20.1 || 1.20.2"));
        assert_eq!(meta.depends, vec!["minecraft"]);
    }

    #[tokio::test]
    async fn fabric_without_depends_yields_empty_declarations() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("bare.jar");
        build_jar(&jar, &[("fabric.mod.json", br#"{"id":"bare"}"#)]);

        let meta = parse_mod_metadata(&jar).await.unwrap().unwrap();
        assert!(meta.depends.is_empty());
        assert_eq!(meta.minecraft_version, None);
    }

    #[tokio::test]
    async fn parses_forge_mods_toml() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("jei.jar");
        let descriptor = r#"modLoader="javafml"
loaderVersion="[47,)"
license="MIT"

[[mods]]
modId="jei"
version="15.2.0.27"
displayName="Just Enough Items"
authors="mezz"
description="物品查看"

[[dependencies.jei]]
modId="forge"
mandatory=true
versionRange="[47,)"
ordering="NONE"
side="BOTH"

[[dependencies.jei]]
modId="minecraft"
mandatory=true
versionRange="[1.20.1,1.20.2)"

[[dependencies.jei]]
modId="patchouli"
mandatory=false
versionRange="[1.4,)"
"#
        .as_bytes();
        build_jar(&jar, &[("META-INF/mods.toml", descriptor)]);

        let meta = parse_mod_metadata(&jar).await.unwrap().expect("应有元数据");
        assert_eq!(meta.mod_id, "jei");
        assert_eq!(meta.name.as_deref(), Some("Just Enough Items"));
        assert_eq!(meta.version.as_deref(), Some("15.2.0.27"));
        assert_eq!(meta.authors, vec!["mezz"]);
        assert_eq!(meta.loader, ModLoader::Forge);
        assert_eq!(meta.format, MetadataFormat::ForgeToml);
        // mandatory=false 的 patchouli 不进依赖列表，声明顺序保持原样。
        assert_eq!(meta.depends, vec!["forge", "minecraft"]);
        assert_eq!(meta.minecraft_version.as_deref(), Some("[1.20.1,1.20.2)"));
    }

    #[tokio::test]
    async fn neoforge_dependency_type_supersedes_mandatory() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("modern.jar");
        let descriptor = br#"modLoader="javafml"
loaderVersion="[1,)"
license="MIT"

[[mods]]
modId="modern"
version="1.0.0"

[[dependencies.modern]]
modId="neoforge"
type="required"
versionRange="[21.1.0,)"

[[dependencies.modern]]
modId="minecraft"
type="required"
versionRange="[1.21.1,1.22)"

[[dependencies.modern]]
modId="jade"
type="optional"

[[dependencies.modern]]
modId="optifine"
type="incompatible"

[[dependencies.modern]]
modId="fallbackdep"
versionRange="[1,)"
"#;
        build_jar(&jar, &[("META-INF/neoforge.mods.toml", descriptor)]);

        let meta = parse_mod_metadata(&jar).await.unwrap().unwrap();
        assert_eq!(meta.loader, ModLoader::NeoForge);
        // type=optional / incompatible 都不算必需；两者都没写时按 NeoForge 默认值 required 收下。
        assert_eq!(meta.depends, vec!["neoforge", "minecraft", "fallbackdep"]);
        assert_eq!(meta.minecraft_version.as_deref(), Some("[1.21.1,1.22)"));
    }

    #[tokio::test]
    async fn toml_empty_version_range_is_not_reported_as_constraint() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("anyver.jar");
        let descriptor = br#"modLoader="javafml"
loaderVersion="[1,)"
license="MIT"

[[mods]]
modId="anyver"

[[dependencies.anyver]]
modId="minecraft"
type="required"
versionRange=""
"#;
        build_jar(&jar, &[("META-INF/neoforge.mods.toml", descriptor)]);

        let meta = parse_mod_metadata(&jar).await.unwrap().unwrap();
        assert_eq!(meta.depends, vec!["minecraft"]);
        // 空区间等于「任意版本」，不能当成一条真实约束报出去。
        assert_eq!(meta.minecraft_version, None);
    }

    #[tokio::test]
    async fn toml_dependencies_of_other_mods_are_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("twin.jar");
        // 一个 jar 里两个 mod：只有主 mod（首个 [[mods]]）的依赖组算数。
        // 含中文，用原始 str + as_bytes（byte-string 字面量不允许非 ASCII）。
        let descriptor = r#"modLoader="javafml"
loaderVersion="[1,)"
license="MIT"

[[mods]]
modId="primary"

[[mods]]
modId="secondary"

[[dependencies.primary]]
modId="forge"
mandatory=true
versionRange="[47,)"

[[dependencies.secondary]]
modId="不该被收进来"
mandatory=true
"#
        .as_bytes();
        build_jar(&jar, &[("META-INF/mods.toml", descriptor)]);

        let meta = parse_mod_metadata(&jar).await.unwrap().unwrap();
        assert_eq!(meta.mod_id, "primary");
        assert_eq!(meta.depends, vec!["forge"]);
    }

    /// authors 写成 TOML 数组的 Forge 模组（architectury 打包出来的都是这样，
    /// 整合包里的 DistantHorizons 就是真实样本）。
    ///
    /// 断言刻意不止看 authors：这个字段类型对不上时 serde 会让整份文件反序列化失败，
    /// 于是 modId / 版本 / 描述 / 依赖全部一起丢，模组在列表里只剩一个裸文件名。
    /// 把整份元数据都钉住，才是这条回归真正要守的东西。
    #[tokio::test]
    async fn parses_forge_mods_toml_with_array_authors() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("distanthorizons.jar");
        let descriptor = r#"modLoader = "javafml"
loaderVersion = "*"
license = "LGPL"

[[mods]]
    modId = "distanthorizons"
    version = "2.4.5-b"
    displayName = "Distant Horizons"
    authors = ["James Seibel", " Leonardo Amato ", "", "coolGi"]
    description = "远景渲染"

[[dependencies.distanthorizons]]
    modId = "forge"
    mandatory = true
    versionRange = "[0,)"

[[dependencies.distanthorizons]]
    modId = "minecraft"
    mandatory = true
    versionRange = "[1.20, 1.20.1,)"

[[dependencies.distanthorizons]]
    modId = "oculus"
    mandatory = false
    versionRange = "[1.8.0,)"
"#
        .as_bytes();
        build_jar(&jar, &[("META-INF/mods.toml", descriptor)]);

        let meta = parse_mod_metadata(&jar).await.unwrap().expect("应有元数据");
        assert_eq!(meta.mod_id, "distanthorizons");
        assert_eq!(meta.name.as_deref(), Some("Distant Horizons"));
        assert_eq!(meta.version.as_deref(), Some("2.4.5-b"));
        assert_eq!(meta.description.as_deref(), Some("远景渲染"));
        // 首尾空白剪掉、空串丢掉；已经分好的条目不再按逗号二次切分。
        assert_eq!(meta.authors, vec!["James Seibel", "Leonardo Amato", "coolGi"]);
        assert_eq!(meta.minecraft_version.as_deref(), Some("[1.20, 1.20.1,)"));
        // oculus 是 mandatory=false，不该进必需依赖。
        assert_eq!(meta.depends, vec!["forge", "minecraft"]);
        assert_eq!(meta.loader, ModLoader::Forge);
        assert_eq!(meta.format, MetadataFormat::ForgeToml);
    }

    /// 数组元素自带逗号时按一个人算，不再切开——与字符串形态的逗号语义刻意不同。
    #[tokio::test]
    async fn array_authors_keep_commas_inside_one_entry() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("comma.jar");
        let descriptor = br#"modLoader="javafml"
loaderVersion="*"

[[mods]]
modId="comma"
authors=["Doe, John", "Ada"]
"#;
        build_jar(&jar, &[("META-INF/mods.toml", descriptor)]);

        let meta = parse_mod_metadata(&jar).await.unwrap().expect("应有元数据");
        assert_eq!(meta.authors, vec!["Doe, John", "Ada"]);
    }

    #[tokio::test]
    async fn parses_neoforge_mods_toml_with_multiple_authors() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("jade.jar");
        let descriptor = br#"modLoader="javafml"
loaderVersion="[1,)"
license="MIT"

[[mods]]
modId="jade"
version="11.6.0"
displayName="Jade"
authors="Snownee, TrainGuys"
"#;
        build_jar(&jar, &[("META-INF/neoforge.mods.toml", descriptor)]);

        let meta = parse_mod_metadata(&jar).await.unwrap().expect("应有元数据");
        assert_eq!(meta.mod_id, "jade");
        assert_eq!(meta.name.as_deref(), Some("Jade"));
        assert_eq!(meta.version.as_deref(), Some("11.6.0"));
        assert_eq!(meta.authors, vec!["Snownee", "TrainGuys"]);
        assert_eq!(meta.loader, ModLoader::NeoForge);
        assert_eq!(meta.format, MetadataFormat::NeoForgeToml);
    }

    #[tokio::test]
    async fn parses_quilt_mod_json() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("quiltmod.jar");
        let descriptor = r#"{
            "schema_version": 1,
            "quilt_loader": {
                "group": "com.example",
                "id": "example_mod",
                "version": "1.2.3",
                "metadata": {
                    "name": "Example Mod",
                    "description": "示例模组",
                    "contributors": {"Alice": "Owner", "Bob": ["Author"]}
                },
                "depends": [
                    "quilt_base",
                    {"id": "quilt_loader", "versions": ">=0.17.0"},
                    {"id": "minecraft", "versions": ">=1.20.1"},
                    {"id": "jade", "versions": "*", "optional": true}
                ]
            }
        }"#
        .as_bytes();
        build_jar(&jar, &[("quilt.mod.json", descriptor)]);

        let meta = parse_mod_metadata(&jar).await.unwrap().expect("应有元数据");
        assert_eq!(meta.mod_id, "example_mod");
        assert_eq!(meta.name.as_deref(), Some("Example Mod"));
        assert_eq!(meta.version.as_deref(), Some("1.2.3"));
        assert_eq!(meta.description.as_deref(), Some("示例模组"));
        assert_eq!(meta.authors, vec!["Alice", "Bob"]);
        assert_eq!(meta.loader, ModLoader::Quilt);
        assert_eq!(meta.format, MetadataFormat::QuiltModJson);
        // optional 的 jade 被跳过，裸串与详细对象都收下。
        assert_eq!(
            meta.depends,
            vec!["quilt_base", "quilt_loader", "minecraft"]
        );
        assert_eq!(meta.minecraft_version.as_deref(), Some(">=1.20.1"));
    }

    #[tokio::test]
    async fn quilt_handles_group_prefixed_ids_and_nested_alternatives() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("nested.jar");
        let descriptor = br#"{
            "quilt_loader": {
                "group": "com.example",
                "id": "nested",
                "version": "0.1.0",
                "depends": [
                    [{"id": "org.quiltmc:quilt_base"}, "fabric"],
                    {"id": "com.mojang:minecraft", "versions": {"any": [">=1.20", "<1.21"]}}
                ]
            }
        }"#;
        build_jar(&jar, &[("quilt.mod.json", descriptor)]);

        let meta = parse_mod_metadata(&jar).await.unwrap().unwrap();
        // 嵌套「任选其一」组被拉平，id 原样保留（含 maven group 前缀）。
        assert_eq!(
            meta.depends,
            vec!["org.quiltmc:quilt_base", "fabric", "com.mojang:minecraft"]
        );
        // 带 group 前缀也能认出是 minecraft，但 {any:[...]} 对象压不成一句话，不编。
        assert_eq!(meta.minecraft_version, None);
        assert_eq!(meta.name, None);
        assert!(meta.authors.is_empty());
    }

    #[tokio::test]
    async fn quilt_descriptor_wins_over_fabric_compat_shim() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("dual.jar");
        build_jar(
            &jar,
            &[
                (
                    "fabric.mod.json",
                    br#"{"id":"dual_fabric","name":"Dual"}"# as &[u8],
                ),
                (
                    "quilt.mod.json",
                    br#"{"quilt_loader":{"group":"com.example","id":"dual","version":"1.0.0"}}"#,
                ),
            ],
        );

        let meta = parse_mod_metadata(&jar).await.unwrap().unwrap();
        assert_eq!(meta.mod_id, "dual");
        assert_eq!(meta.loader, ModLoader::Quilt);
        assert_eq!(meta.format, MetadataFormat::QuiltModJson);
    }

    #[test]
    fn old_metadata_json_without_new_fields_still_loads() {
        // 卷宗/缓存里可能躺着新增字段之前写下的数据，serde default 必须兜住。
        let legacy = serde_json::json!({
            "mod_id": "sodium",
            "name": "Sodium",
            "version": "0.5.3",
            "description": null,
            "authors": ["jellysquid3"],
            "loader": "fabric",
            "format": "fabric"
        });
        let meta: ModMetadata = serde_json::from_value(legacy).unwrap();
        assert_eq!(meta.mod_id, "sodium");
        assert!(meta.depends.is_empty());
        assert_eq!(meta.minecraft_version, None);
        assert_eq!(meta.format, MetadataFormat::Fabric);
    }

    #[tokio::test]
    async fn jar_without_descriptor_yields_none() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("nolib.jar");
        build_jar(&jar, &[("com/example/Lib.class", b"not-metadata")]);
        assert!(parse_mod_metadata(&jar).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn non_zip_file_yields_none() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("garbage.jar");
        tokio::fs::write(&jar, b"this is not a zip").await.unwrap();
        assert!(parse_mod_metadata(&jar).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn malformed_fabric_descriptor_errors() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("broken.jar");
        build_jar(&jar, &[("fabric.mod.json", b"{ this is not json ")]);
        let err = parse_mod_metadata(&jar).await.unwrap_err();
        assert!(matches!(err, Error::Json { .. }));
    }

    #[tokio::test]
    async fn scan_detects_enabled_and_disabled_and_skips_non_jar() {
        let dir = tempfile::tempdir().unwrap();
        let mods = dir.path();
        build_jar(
            &mods.join("sodium.jar"),
            &[("fabric.mod.json", br#"{"id":"sodium","name":"Sodium"}"#)],
        );
        build_jar(
            &mods.join("lithium.jar.disabled"),
            &[("fabric.mod.json", br#"{"id":"lithium","name":"Lithium"}"#)],
        );
        tokio::fs::write(mods.join("readme.txt"), b"hi").await.unwrap();

        let scanned = scan_mods_dir(mods).await.unwrap();
        assert_eq!(scanned.len(), 2);
        // 按文件名排序：lithium.jar.disabled 在 sodium.jar 前。
        assert_eq!(scanned[0].file_name, "lithium.jar.disabled");
        assert!(!scanned[0].enabled);
        assert_eq!(
            scanned[0].metadata.as_ref().unwrap().mod_id,
            "lithium"
        );
        assert_eq!(scanned[1].file_name, "sodium.jar");
        assert!(scanned[1].enabled);
    }

    #[tokio::test]
    async fn disable_then_enable_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("sodium.jar");
        build_jar(&jar, &[("fabric.mod.json", br#"{"id":"sodium"}"#)]);

        let disabled = disable_mod(&jar).await.unwrap();
        assert_eq!(disabled.file_name().unwrap(), "sodium.jar.disabled");
        assert!(!tokio::fs::try_exists(&jar).await.unwrap());
        assert!(tokio::fs::try_exists(&disabled).await.unwrap());

        let enabled = enable_mod(&disabled).await.unwrap();
        assert_eq!(enabled, jar);
        assert!(tokio::fs::try_exists(&jar).await.unwrap());
    }

    #[tokio::test]
    async fn enabling_already_enabled_is_noop() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("sodium.jar");
        build_jar(&jar, &[("fabric.mod.json", br#"{"id":"sodium"}"#)]);
        let same = enable_mod(&jar).await.unwrap();
        assert_eq!(same, jar);
    }

    #[tokio::test]
    async fn disable_conflict_when_target_exists() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("sodium.jar");
        let disabled = dir.path().join("sodium.jar.disabled");
        build_jar(&jar, &[("fabric.mod.json", br#"{"id":"sodium"}"#)]);
        build_jar(&disabled, &[("fabric.mod.json", br#"{"id":"sodium"}"#)]);

        let err = disable_mod(&jar).await.unwrap_err();
        match err {
            Error::ModStateConflict { path } => {
                assert_eq!(path.file_name().unwrap(), "sodium.jar.disabled")
            }
            other => panic!("期望 ModStateConflict，得到 {other:?}"),
        }
        // 原文件仍在（未被覆盖）。
        assert!(tokio::fs::try_exists(&jar).await.unwrap());
    }
}
