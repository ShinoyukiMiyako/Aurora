//! 移动实例时要补到目标游戏目录的共用文件：库、资源、日志配置、加载器处理器产物与继承链上的基底版本。
//!
//! 清单与启动时的文件计划同一套规则：继承链合并后按运行环境筛出的库（含 natives）、启动解压 natives 时读的
//! jar、日志配置、资源索引与索引里的对象。只看存在不看大小与哈希：目标里已有的文件可能正被那边的别的实例
//! 使用，一律不碰；源里的文件按原样带过去，坏了的由目标那边启动时的校验补下载。
//!
//! 1.20.4 之前的 Forge 补丁 jar 与反混淆产物是安装时处理器在本地生成的，不在库清单里，也下载不回来，只能按
//! 合并后版本 JSON 的 `--fml.*` 启动参数推出产物所在的库目录，整目录带上。旧版资源布局的展开目录不带：启动时
//! 由资源对象重新展开。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use petalfall_install::GameLayout;
use petalfall_install::natives::native_jar_relpath;
use petalfall_install::plan::{asset_object_tasks, library_tasks, logging_task};
use petalfall_instance::is_safe_instance_id;
use petalfall_version::loader::{arg_tokens, flag_value};
use petalfall_version::{
    RuntimeContext, VersionJson, check_path_segment, resolve, select_libraries,
};
use serde_json::Value;

use crate::InstanceError;
use crate::error::{CoreError, Result};
use crate::launch::read_asset_index;
use crate::modfs::try_exists;
use crate::workdir::read_version_json;

/// 继承链的长度上限，与 `instances.rs` 里给实例锁取链的上限相同：两边取到的基底要一致。
const MAX_INHERIT_DEPTH: usize = 16;

/// 启动参数没写 `--fml.forgeGroup` 时 FML 按这个组找自己的库，处理器产物也落在这个组下。
const DEFAULT_FORGE_GROUP: &str = "net.minecraftforge";

/// 一个要补到目标的文件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DependencyFile {
    pub src: PathBuf,
    pub dst: PathBuf,
    pub size: u64,
}

/// 一个要带到目标的基底版本：版本 JSON，以及源里有的客户端 jar。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BaseVersionCopy {
    pub id: String,
    pub files: Vec<DependencyFile>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct DependencyPlan {
    /// 目标里没有、源里有的共用文件，去重。
    pub files: Vec<DependencyFile>,
    /// 目标里没有、要带过去的基底版本（只带版本 JSON 与客户端 jar），由近及远。
    pub bases: Vec<BaseVersionCopy>,
    /// 目标里已有、可以当成同一个基底复用的基底版本（判法见 [`same_base`]）。
    pub reused_bases: Vec<String>,
    /// 目标里已有同名目录、不能复用（或缺版本 JSON、版本 JSON 坏了）的基底版本。
    pub conflicting_bases: Vec<String>,
    /// 源里也缺的共用文件数。
    pub missing_in_source: u64,
}

impl DependencyPlan {
    /// 要写到目标的全部字节：共用文件加基底版本的文件。
    pub(crate) fn total_bytes(&self) -> u64 {
        self.files
            .iter()
            .chain(self.bases.iter().flat_map(|base| &base.files))
            .map(|file| file.size)
            .sum()
    }

    /// 共用文件的个数，不含基底版本的文件。
    pub(crate) fn file_count(&self) -> u64 {
        self.files.len() as u64
    }
}

/// 算出实例 `id` 从 `source_game_dir` 移到 `target_game_dir` 时目标缺的共用文件与基底版本。只读，不写盘。
pub(crate) async fn plan_dependencies(
    source_game_dir: &Path,
    target_game_dir: &Path,
    id: &str,
    runtime: &RuntimeContext,
) -> Result<DependencyPlan> {
    let source = GameLayout::new(source_game_dir);
    let target = GameLayout::new(target_game_dir);
    let chain = read_chain(&source, id).await?;
    let merged = resolve(&chain.root, &chain.provider)?;

    let mut listed: Vec<PathBuf> = library_tasks(&merged, runtime, &source)?
        .into_iter()
        .map(|task| task.dest)
        .collect();
    listed.extend(native_jars(&merged, runtime, &source)?);
    if let Some(task) = logging_task(&merged, &source)? {
        listed.push(task.dest);
    }
    if let Some(index) = &merged.asset_index {
        let index_path = source.asset_index_json(&index.id)?;
        // 源里没有索引时它自己算一个缺失；对象无从知道，就不列。
        if try_exists(&index_path).await? {
            let objects = read_asset_index(&source, &index.id).await?;
            listed.extend(
                asset_object_tasks(&objects, &source)?
                    .into_iter()
                    .map(|task| task.dest),
            );
        }
        listed.push(index_path);
    }
    let processor_dirs = processor_output_dirs(&merged, &source)?;

    let source_root = source.root().to_path_buf();
    let target_root = target.root().to_path_buf();
    // 资源对象几千个，逐个查存在放在一个阻塞任务里一口气做完。
    let (files, missing_in_source) = tokio::task::spawn_blocking(move || {
        collect_files(&source_root, &target_root, listed, &processor_dirs)
    })
    .await??;

    let mut plan = DependencyPlan {
        files,
        missing_in_source,
        ..DependencyPlan::default()
    };
    for base in &chain.bases {
        classify_base(&source, &target, base, &mut plan).await?;
    }
    Ok(plan)
}

/// 源里的继承链：实例自己的版本 JSON、按 `inheritsFrom` 原文索引的祖先（交给 [`resolve`] 合并），以及祖先 id，
/// 由近及远。
struct Chain {
    root: VersionJson,
    provider: HashMap<String, VersionJson>,
    bases: Vec<String>,
}

/// 沿 `inheritsFrom` 在源 `versions/` 里读继承链，口径同 [`crate::Petalfall::inheritance_chain`]：不分大小写判环、
/// 空白的 `inheritsFrom` 当作没有、上限 [`MAX_INHERIT_DEPTH`] 层。那边链断了就停，这里要合并出完整的版本 JSON
/// 才算得出库，所以缺环、坏 JSON、环、超长都照实报错。
async fn read_chain(source: &GameLayout, id: &str) -> Result<Chain> {
    if !is_safe_instance_id(id) {
        return Err(InstanceError::InvalidId { id: id.to_owned() }.into());
    }
    let versions_dir = source.versions_dir();
    let root = read_version_json(&versions_dir, id)
        .await?
        .map(without_blank_parent)
        .ok_or_else(|| CoreError::VersionNotInstalled { id: id.to_owned() })?;

    // 实例锁与 Windows 的目录名都不分大小写，判环也不分。
    let mut seen = HashSet::from([id.to_lowercase()]);
    let mut provider = HashMap::new();
    let mut bases: Vec<String> = Vec::new();
    let mut child = id.to_owned();
    let mut next = root.inherits_from.clone();
    while let Some(parent) = next.take() {
        if bases.len() == MAX_INHERIT_DEPTH {
            return Err(InstanceError::Broken {
                id: id.to_owned(),
                reason: format!("继承链超过 {MAX_INHERIT_DEPTH} 层"),
            }
            .into());
        }
        check_path_segment(&parent).map_err(|problem| petalfall_install::Error::UnsafePath {
            entry: format!("版本 {child} 的 inheritsFrom"),
            path: parent.clone(),
            problem,
        })?;
        if !seen.insert(parent.to_lowercase()) {
            let mut cycle = vec![id.to_owned()];
            cycle.extend(bases);
            cycle.push(parent);
            return Err(petalfall_version::Error::InheritCycle { chain: cycle }.into());
        }
        let json = read_version_json(&versions_dir, &parent)
            .await?
            .map(without_blank_parent)
            .ok_or_else(|| petalfall_version::Error::MissingInherited {
                id: parent.clone(),
                referenced_by: child.clone(),
            })?;
        next = json.inherits_from.clone();
        provider.insert(parent.clone(), json);
        bases.push(parent.clone());
        child = parent;
    }
    Ok(Chain {
        root,
        provider,
        bases,
    })
}

/// 空白的 `inheritsFrom` 按没有处理（同 `inheritance_chain`），不留给 [`resolve`] 当成一个缺失的前置。
fn without_blank_parent(mut json: VersionJson) -> VersionJson {
    if json
        .inherits_from
        .as_deref()
        .is_some_and(|parent| parent.trim().is_empty())
    {
        json.inherits_from = None;
    }
    json
}

/// 启动解压 natives 时读的 jar，口径同 `petalfall_install::natives::extract_all_natives`。旧式 natives 库只写了
/// `natives` 映射、没有 `downloads.classifiers` 时下载计划不给它排任务，解压却按坐标拼出 jar 去读：漏带了，目标
/// 那边启动卡在解压本地库，补全也补不回来。
fn native_jars(
    merged: &VersionJson,
    runtime: &RuntimeContext,
    layout: &GameLayout,
) -> Result<Vec<PathBuf>> {
    let mut jars = Vec::new();
    for lib in select_libraries(merged, runtime) {
        if !merged.extracts_native(lib) {
            continue;
        }
        if let Some(relative) = native_jar_relpath(lib, runtime)? {
            jars.push(layout.checked_library_path(&lib.name, &relative)?);
        }
    }
    Ok(jars)
}

/// 加载器处理器产物所在的库目录，按合并后版本 JSON 的 `--fml.*` 启动参数推出。处理器的产物按 `[坐标]` 落到
/// 坐标对应的库路径（见 forge.rs 的 `resolve_outputs`），Forge 的补丁 jar 是 `<组>:forge:<mc>-<forge>:client`，
/// NeoForge 的是 `net.neoforged:neoforge:<版本>:client`，反混淆产物是 `net.minecraft:client:<mc>-<mcp 或 neoform>:*`。
/// 不是 Forge 系的版本没有这些参数，得到空表。
fn processor_output_dirs(merged: &VersionJson, layout: &GameLayout) -> Result<Vec<PathBuf>> {
    let tokens = arg_tokens(merged);
    let mc = fml_arg(&tokens, "--fml.mcVersion")?;
    let mut dirs = Vec::new();
    if let (Some(mc), Some(forge)) = (&mc, fml_arg(&tokens, "--fml.forgeVersion")?) {
        let group =
            fml_arg(&tokens, "--fml.forgeGroup")?.unwrap_or_else(|| DEFAULT_FORGE_GROUP.to_owned());
        dirs.push(library_dir(
            layout,
            &group,
            "forge",
            &format!("{mc}-{forge}"),
        )?);
    }
    if let (Some(mc), Some(mcp)) = (&mc, fml_arg(&tokens, "--fml.mcpVersion")?) {
        dirs.push(library_dir(
            layout,
            "net.minecraft",
            "client",
            &format!("{mc}-{mcp}"),
        )?);
    }
    if let Some(neoforge) = fml_arg(&tokens, "--fml.neoForgeVersion")? {
        dirs.push(library_dir(layout, "net.neoforged", "neoforge", &neoforge)?);
    }
    if let (Some(mc), Some(neoform)) = (&mc, fml_arg(&tokens, "--fml.neoFormVersion")?) {
        dirs.push(library_dir(
            layout,
            "net.minecraft",
            "client",
            &format!("{mc}-{neoform}"),
        )?);
    }
    Ok(dirs)
}

/// 一个 `--fml.*` 参数的取值。它要拼进库目录的路径：拼成 `<mc>-<版本>` 之后 `..` 就不再是一个点段，查不出来，
/// 所以拼之前逐个按单个路径段检查。
fn fml_arg(tokens: &[String], flag: &str) -> Result<Option<String>> {
    let Some(value) = flag_value(tokens, flag) else {
        return Ok(None);
    };
    check_path_segment(&value).map_err(|problem| petalfall_install::Error::UnsafePath {
        entry: format!("启动参数 {flag}"),
        path: value.clone(),
        problem,
    })?;
    Ok(Some(value))
}

/// maven 坐标 `group:artifact:version` 的目录 `libraries/<group 路径>/<artifact>/<version>`。
fn library_dir(layout: &GameLayout, group: &str, artifact: &str, version: &str) -> Result<PathBuf> {
    let relative = format!("{}/{artifact}/{version}", group.replace('.', "/"));
    Ok(layout.checked_library_path(&format!("{group}:{artifact}:{version}"), &relative)?)
}

/// 把清单里的文件与处理器产物目录下的文件落到目标，去掉目标已有的。清单里源也缺的计数；产物目录在源里不存在
/// 就跳过，不算缺失：老 Forge 与非 Forge 本来就没有。阻塞函数。
fn collect_files(
    source_root: &Path,
    target_root: &Path,
    listed: Vec<PathBuf>,
    processor_dirs: &[PathBuf],
) -> Result<(Vec<DependencyFile>, u64)> {
    let mut seen = HashSet::new();
    let mut files = Vec::new();
    let mut missing = 0;
    for src in listed {
        if !seen.insert(src.clone()) {
            continue;
        }
        let dst = rebase(&src, source_root, target_root);
        if exists(&dst)? {
            continue;
        }
        match file_size(&src)? {
            Some(size) => files.push(DependencyFile { src, dst, size }),
            None => missing += 1,
        }
    }
    for dir in processor_dirs {
        for (src, size) in files_under(dir)? {
            if !seen.insert(src.clone()) {
                continue;
            }
            let dst = rebase(&src, source_root, target_root);
            if exists(&dst)? {
                continue;
            }
            files.push(DependencyFile { src, dst, size });
        }
    }
    Ok((files, missing))
}

/// 源游戏目录下的路径换到目标游戏目录下的同一位置。
fn rebase(path: &Path, source_root: &Path, target_root: &Path) -> PathBuf {
    let relative = path
        .strip_prefix(source_root)
        .expect("落点都由源游戏目录的布局算出");
    target_root.join(relative)
}

fn exists(path: &Path) -> Result<bool> {
    path.try_exists().map_err(|source| {
        petalfall_base::Error::Io {
            path: path.to_path_buf(),
            source,
        }
        .into()
    })
}

/// 源里的文件大小；不存在或不是文件时为 `None`。
fn file_size(path: &Path) -> Result<Option<u64>> {
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_file() => Ok(Some(meta.len())),
        Ok(_) => Ok(None),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(petalfall_base::Error::Io {
            path: path.to_path_buf(),
            source,
        }
        .into()),
    }
}

/// 目录下（递归）的全部文件与大小；目录不存在时为空。不顺着符号链接与目录联接走：走进去可能绕回自己，或出了
/// 库目录。
fn files_under(dir: &Path) -> Result<Vec<(PathBuf, u64)>> {
    let io = |path: &Path, source: std::io::Error| -> CoreError {
        petalfall_base::Error::Io {
            path: path.to_path_buf(),
            source,
        }
        .into()
    };
    match std::fs::symlink_metadata(dir) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => return Ok(Vec::new()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(source) => return Err(io(dir, source)),
    }
    let mut files = Vec::new();
    let mut pending = vec![dir.to_path_buf()];
    while let Some(current) = pending.pop() {
        let entries = std::fs::read_dir(&current).map_err(|source| io(&current, source))?;
        for entry in entries {
            let entry = entry.map_err(|source| io(&current, source))?;
            let path = entry.path();
            let file_type = entry.file_type().map_err(|source| io(&path, source))?;
            if file_type.is_dir() {
                pending.push(path);
            } else if file_type.is_file() {
                let size = entry.metadata().map_err(|source| io(&path, source))?.len();
                files.push((path, size));
            }
        }
    }
    files.sort();
    Ok(files)
}

/// 一个基底版本在目标里的处境：没有就带过去，有同名目录时按 [`same_base`] 比较两份版本 JSON。
async fn classify_base(
    source: &GameLayout,
    target: &GameLayout,
    id: &str,
    plan: &mut DependencyPlan,
) -> Result<()> {
    let source_json = source.version_json(id);
    if try_exists(&target.version_dir(id)).await? {
        let same = match target_json_value(&target.version_json(id)).await? {
            Some(theirs) => same_base(theirs, source_json_value(&source_json).await?),
            None => false,
        };
        if same {
            plan.reused_bases.push(id.to_owned());
        } else {
            plan.conflicting_bases.push(id.to_owned());
        }
        return Ok(());
    }
    let mut files = Vec::new();
    for src in [source_json, source.version_jar(id)] {
        if let Some(size) = async_file_size(&src).await? {
            files.push(DependencyFile {
                dst: rebase(&src, source.root(), target.root()),
                src,
                size,
            });
        }
    }
    plan.bases.push(BaseVersionCopy {
        id: id.to_owned(),
        files,
    });
    Ok(())
}

/// 目标里的同名基底能不能当成源里的那个复用。同一个原版 id 的 JSON Mojang 会重发（2021-12 的 log4j 修补改了
/// logging 与 time），两个目录在不同时期装的同一原版整份比一定不同，玩家又解不开这个冲突：链根两边都声明了
/// 客户端 jar 的 sha1 时，按它认是不是同一个游戏本体。其余情况（加载器基底、没声明 sha1 的链根）比较去掉顶层
/// `time` 与 `releaseTime` 后的整份：这两个键只记录发布与安装的时间，别的启动器装的时候常常重写。
fn same_base(theirs: Value, ours: Value) -> bool {
    if let (Some(theirs), Some(ours)) = (root_client_sha1(&theirs), root_client_sha1(&ours)) {
        return theirs == ours;
    }
    without_times(theirs) == without_times(ours)
}

/// 链根（没有 `inheritsFrom`，空白的同 [`without_blank_parent`] 算没有）声明的客户端 jar sha1。
fn root_client_sha1(json: &Value) -> Option<&str> {
    let root = match json.get("inheritsFrom") {
        None | Some(Value::Null) => true,
        Some(Value::String(parent)) => parent.trim().is_empty(),
        Some(_) => false,
    };
    if !root {
        return None;
    }
    json.pointer("/downloads/client/sha1")?.as_str()
}

fn without_times(mut json: Value) -> Value {
    if let Some(object) = json.as_object_mut() {
        object.remove("time");
        object.remove("releaseTime");
    }
    json
}

/// 目标里同名基底的版本 JSON 解析成的值；文件不存在或解析不了时为 `None`。解析不了的那份已经坏了，和缺了一样
/// 不能拿来复用，也不能覆盖（它属于目标里的别的实例），按冲突交给玩家处理。
async fn target_json_value(path: &Path) -> Result<Option<Value>> {
    match tokio::fs::read(path).await {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes).ok()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(petalfall_base::Error::Io {
            path: path.to_path_buf(),
            source,
        }
        .into()),
    }
}

/// 源里基底的版本 JSON 解析成的值。读继承链时已经解析过一次，这里再出错照实报。比较解析后的值而不是字节：
/// 别的启动器重写版本 JSON 时缩进与键序常常不同，内容一样就能复用。
async fn source_json_value(path: &Path) -> Result<Value> {
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|source| petalfall_base::Error::Io {
            path: path.to_path_buf(),
            source,
        })?;
    serde_json::from_slice(&bytes).map_err(|source| {
        petalfall_version::Error::Json {
            context: "版本 JSON",
            source,
        }
        .into()
    })
}

async fn async_file_size(path: &Path) -> Result<Option<u64>> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || file_size(&path)).await?
}

#[cfg(test)]
mod tests {
    use super::*;
    use petalfall_version::{OsName, UnsafePath};
    use serde_json::json;

    fn runtime() -> RuntimeContext {
        RuntimeContext::new(OsName::Windows, "x86_64", 64)
    }

    fn put(path: &Path, bytes: &[u8]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }

    /// 游戏目录下以 `/` 分隔的相对路径。
    fn at(game: &Path, relative: &str) -> PathBuf {
        relative
            .split('/')
            .fold(game.to_path_buf(), |p, s| p.join(s))
    }

    fn put_version(game: &Path, id: &str, json: &str) {
        put(
            &at(game, &format!("versions/{id}/{id}.json")),
            json.as_bytes(),
        );
    }

    async fn plan_between(source: &Path, target: &Path, id: &str) -> DependencyPlan {
        plan_dependencies(source, target, id, &runtime())
            .await
            .unwrap()
    }

    /// 文件清单换成目标下的相对路径与大小，按路径排序；同时核对源与目标是同一个相对位置。
    fn relative(files: &[DependencyFile], source: &Path, target: &Path) -> Vec<(String, u64)> {
        let mut out: Vec<(String, u64)> = files
            .iter()
            .map(|file| {
                let rel = file.dst.strip_prefix(target).unwrap();
                assert_eq!(file.src, source.join(rel), "源与目标的相对位置要一致");
                let rel = rel
                    .components()
                    .map(|c| c.as_os_str().to_str().unwrap())
                    .collect::<Vec<_>>()
                    .join("/");
                (rel, file.size)
            })
            .collect();
        out.sort();
        out
    }

    fn game_dirs() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("源");
        let target = tmp.path().join("目标");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&target).unwrap();
        (tmp, source, target)
    }

    fn hash(digit: char) -> String {
        std::iter::repeat_n(digit, 40).collect()
    }

    fn forge_args(args: &[&str]) -> Value {
        let mut game = vec![
            "--username",
            "${auth_player_name}",
            "--launchTarget",
            "forgeclient",
        ];
        game.extend_from_slice(args);
        json!({ "game": game, "jvm": [] })
    }

    fn artifact(name: &str, path: &str) -> Value {
        json!({
            "name": name,
            "downloads": {"artifact": {
                "path": path, "sha1": "0", "size": 1, "url": "https://example.invalid/x.jar"
            }}
        })
    }

    /// 落樱自己装的实例：版本 JSON 已合并、没有 inheritsFrom。库、natives、日志配置、资源索引与对象都列出来，
    /// 目标已有的跳过，同一个对象只列一次，源里也缺的计数；实例目录里的文件不列。
    #[tokio::test]
    async fn a_merged_fabric_instance_lists_libraries_assets_and_logging() {
        let (_tmp, source, target) = game_dirs();
        let (a, b, c) = (hash('a'), hash('b'), hash('c'));
        let index = json!({"objects": {
            "minecraft/lang/zh_cn.json": {"hash": a, "size": 3},
            "minecraft/lang/zh_tw.json": {"hash": a, "size": 3},
            "minecraft/sounds/rain.ogg": {"hash": b, "size": 4},
            "minecraft/textures/sky.png": {"hash": c, "size": 5}
        }})
        .to_string();
        let instance = json!({
            "id": "周末生存",
            "mainClass": "net.fabricmc.loader.impl.launch.knot.KnotClient",
            "assetIndex": {"id": "17", "sha1": "0", "size": 1, "url": "https://example.invalid/17.json"},
            "logging": {"client": {
                "argument": "-Dlog4j.configurationFile=${path}", "type": "log4j2-xml",
                "file": {"id": "client-1.12.xml", "sha1": "0", "size": 1, "url": "https://example.invalid/l.xml"}
            }},
            "libraries": [
                {"name": "net.fabricmc:fabric-loader:0.16.10", "url": "https://maven.fabricmc.net/"},
                {"name": "net.fabricmc:intermediary:1.21.1", "url": "https://maven.fabricmc.net/"},
                artifact("com.google.code.gson:gson:2.11.0", "com/google/code/gson/gson/2.11.0/gson-2.11.0.jar"),
                artifact(
                    "org.lwjgl:lwjgl:3.3.3:natives-windows",
                    "org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar"
                )
            ]
        });
        put_version(&source, "周末生存", &instance.to_string());
        put(&at(&source, "versions/周末生存/周末生存.jar"), b"client");
        let loader = "libraries/net/fabricmc/fabric-loader/0.16.10/fabric-loader-0.16.10.jar";
        let intermediary = "libraries/net/fabricmc/intermediary/1.21.1/intermediary-1.21.1.jar";
        let natives = "libraries/org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar";
        put(&at(&source, loader), b"loader");
        put(&at(&source, intermediary), b"inter");
        put(&at(&target, intermediary), b"other");
        put(&at(&source, natives), b"natives!");
        put(&at(&source, "assets/indexes/17.json"), index.as_bytes());
        put(&at(&source, &format!("assets/objects/aa/{a}")), b"aaa");
        put(&at(&source, &format!("assets/objects/bb/{b}")), b"bbbb");
        put(&at(&target, &format!("assets/objects/bb/{b}")), b"bbbb");
        put(
            &at(&source, "assets/log_configs/client-1.12.xml"),
            b"<xml/>",
        );

        let plan = plan_between(&source, &target, "周末生存").await;

        assert_eq!(
            relative(&plan.files, &source, &target),
            vec![
                ("assets/indexes/17.json".to_owned(), index.len() as u64),
                ("assets/log_configs/client-1.12.xml".to_owned(), 6),
                (format!("assets/objects/aa/{a}"), 3),
                (loader.to_owned(), 6),
                (natives.to_owned(), 8),
            ]
        );
        assert_eq!(
            plan.missing_in_source, 2,
            "gson 与 sky.png 的对象源里也没有"
        );
        assert_eq!(plan.file_count(), 5);
        assert_eq!(plan.total_bytes(), index.len() as u64 + 6 + 3 + 6 + 8);
        assert!(plan.bases.is_empty() && plan.reused_bases.is_empty());
        assert!(plan.conflicting_bases.is_empty());

        // 源里没有资源索引：索引算一个缺失，对象无从知道。
        let no_index = json!({
            "id": "缺索引",
            "assetIndex": {"id": "99", "sha1": "0", "size": 1, "url": "https://example.invalid/99.json"}
        });
        put_version(&source, "缺索引", &no_index.to_string());
        let plan = plan_between(&source, &target, "缺索引").await;
        assert!(plan.files.is_empty());
        assert_eq!(plan.missing_in_source, 1);
        assert_eq!(plan.total_bytes(), 0);
    }

    /// 1.20.4 之前的 Forge：补丁 jar 与反混淆产物不在库清单里，按 `--fml.*` 参数推出的两个目录整个带上（递归），
    /// 库清单里也有的 universal jar 只列一次，目标已有的跳过。没写 `--fml.forgeGroup` 时按 net.minecraftforge。
    #[tokio::test]
    async fn forge_1_20_1_brings_the_processor_output_dirs() {
        let (_tmp, source, target) = game_dirs();
        let instance = json!({
            "id": "机械动力",
            "mainClass": "cpw.mods.bootstraplauncher.BootstrapLauncher",
            "arguments": forge_args(&[
                "--fml.forgeVersion", "47.3.33", "--fml.mcVersion", "1.20.1",
                "--fml.mcpVersion", "20230612.114412"
            ]),
            "libraries": [
                artifact(
                    "net.minecraftforge:fmlloader:1.20.1-47.3.33",
                    "net/minecraftforge/fmlloader/1.20.1-47.3.33/fmlloader-1.20.1-47.3.33.jar"
                ),
                artifact(
                    "net.minecraftforge:forge:1.20.1-47.3.33:universal",
                    "net/minecraftforge/forge/1.20.1-47.3.33/forge-1.20.1-47.3.33-universal.jar"
                )
            ]
        });
        put_version(&source, "机械动力", &instance.to_string());
        let forge = "libraries/net/minecraftforge/forge/1.20.1-47.3.33";
        let client = "libraries/net/minecraft/client/1.20.1-20230612.114412";
        let fmlloader =
            "libraries/net/minecraftforge/fmlloader/1.20.1-47.3.33/fmlloader-1.20.1-47.3.33.jar";
        let srg = format!("{client}/client-1.20.1-20230612.114412-srg.jar");
        let extra = format!("{client}/client-1.20.1-20230612.114412-extra.jar");
        let slim = format!("{client}/client-1.20.1-20230612.114412-slim.jar");
        let mappings = format!("{client}/client-1.20.1-20230612.114412-mappings.txt");
        let nested = format!("{client}/nested/deep.bin");
        let patched = format!("{forge}/forge-1.20.1-47.3.33-client.jar");
        let universal = format!("{forge}/forge-1.20.1-47.3.33-universal.jar");
        put(&at(&source, fmlloader), b"fmlld");
        put(&at(&source, &patched), b"patched");
        put(&at(&source, &universal), b"universal");
        put(&at(&source, &srg), b"srg");
        put(&at(&source, &extra), b"extra");
        put(&at(&source, &slim), b"slim");
        put(&at(&target, &slim), b"slim");
        put(&at(&source, &mappings), b"map");
        put(&at(&source, &nested), b"deep");

        let plan = plan_between(&source, &target, "机械动力").await;

        assert_eq!(
            relative(&plan.files, &source, &target),
            vec![
                (extra, 5),
                (mappings, 3),
                (srg, 3),
                (nested, 4),
                (fmlloader.to_owned(), 5),
                (patched, 7),
                (universal, 9),
            ]
        );
        assert_eq!(plan.missing_in_source, 0);
        assert_eq!(plan.total_bytes(), 5 + 3 + 3 + 4 + 7 + 9 + 5);

        // 1.20.1 的 NeoForge 沿用 Forge 的参数、组名换成 net.neoforged；推出来的目录源里没有就跳过，不算缺失。
        let fork = json!({
            "id": "新森林",
            "arguments": forge_args(&[
                "--fml.forgeVersion", "47.1.106", "--fml.mcVersion", "1.20.1",
                "--fml.forgeGroup", "net.neoforged", "--fml.mcpVersion", "20230612.999999"
            ])
        });
        put_version(&source, "新森林", &fork.to_string());
        let fork_jar =
            "libraries/net/neoforged/forge/1.20.1-47.1.106/forge-1.20.1-47.1.106-client.jar";
        put(&at(&source, fork_jar), b"fork");
        let plan = plan_between(&source, &target, "新森林").await;
        assert_eq!(
            relative(&plan.files, &source, &target),
            vec![(fork_jar.to_owned(), 4)]
        );
        assert_eq!(plan.missing_in_source, 0);
    }

    /// NeoForge：`--fml.neoForgeVersion` 与 `--fml.neoFormVersion` 推出 neoforge 与 client 两个目录。
    #[tokio::test]
    async fn neoforge_brings_the_processor_output_dirs() {
        let (_tmp, source, target) = game_dirs();
        let instance = json!({
            "id": "樱花谷",
            "mainClass": "cpw.mods.bootstraplauncher.BootstrapLauncher",
            "arguments": forge_args(&[
                "--fml.neoForgeVersion", "21.1.77", "--fml.fmlVersion", "4.0.31",
                "--fml.mcVersion", "1.21.1", "--fml.neoFormVersion", "20240808.144430"
            ]),
            "libraries": [artifact(
                "net.neoforged:neoforge:21.1.77:universal",
                "net/neoforged/neoforge/21.1.77/neoforge-21.1.77-universal.jar"
            )]
        });
        put_version(&source, "樱花谷", &instance.to_string());
        let neoforge = "libraries/net/neoforged/neoforge/21.1.77";
        let client = "libraries/net/minecraft/client/1.21.1-20240808.144430";
        let patched = format!("{neoforge}/neoforge-21.1.77-client.jar");
        let universal = format!("{neoforge}/neoforge-21.1.77-universal.jar");
        let srg = format!("{client}/client-1.21.1-20240808.144430-srg.jar");
        let mappings = format!("{client}/client-1.21.1-20240808.144430-mappings.txt");
        put(&at(&source, &patched), b"neo-client");
        put(&at(&source, &universal), b"neo-universal");
        put(&at(&source, &srg), b"srg!");
        put(&at(&source, &mappings), b"mappings");
        // 不在推出来的目录里的同组文件不带。
        put(
            &at(
                &source,
                "libraries/net/neoforged/neoforge/21.0.1/neoforge-21.0.1-client.jar",
            ),
            b"old",
        );

        let plan = plan_between(&source, &target, "樱花谷").await;

        assert_eq!(
            relative(&plan.files, &source, &target),
            vec![(mappings, 8), (srg, 4), (patched, 10), (universal, 13)]
        );
        assert_eq!(plan.missing_in_source, 0);
        assert_eq!(plan.file_count(), 4);
    }

    const VANILLA: &str = r#"{"id":"1.20.1","type":"release","mainClass":"net.minecraft.client.main.Main","libraries":[{"name":"com.mojang:brigadier:1.1.8","downloads":{"artifact":{"path":"com/mojang/brigadier/1.1.8/brigadier-1.1.8.jar","sha1":"0","size":1,"url":"https://libraries.minecraft.net/b.jar"}}}]}"#;
    /// 同一份原版 JSON 换了键序与缩进。
    const VANILLA_REWRITTEN: &str = r#"{
  "type": "release",
  "libraries": [{"downloads": {"artifact": {"url": "https://libraries.minecraft.net/b.jar", "size": 1, "sha1": "0", "path": "com/mojang/brigadier/1.1.8/brigadier-1.1.8.jar"}}, "name": "com.mojang:brigadier:1.1.8"}],
  "mainClass": "net.minecraft.client.main.Main",
  "id": "1.20.1"
}"#;
    const FORGE: &str = r#"{"id":"1.20.1-forge-47.3.33","inheritsFrom":"1.20.1","libraries":[{"name":"net.minecraftforge:fmlloader:1.20.1-47.3.33","downloads":{"artifact":{"path":"net/minecraftforge/fmlloader/1.20.1-47.3.33/fmlloader-1.20.1-47.3.33.jar","sha1":"0","size":1,"url":"https://maven.minecraftforge.net/f.jar"}}}]}"#;
    const FORGE_ID: &str = "1.20.1-forge-47.3.33";

    /// 别的启动器装的实例经 inheritsFrom 叠在加载器版本与原版上：库按合并后的整条链算；基底版本在目标里没有时
    /// 带 JSON 与（有的话）jar，内容相同的复用，不同或缺 JSON 的算冲突，都按由近及远排。
    #[tokio::test]
    async fn bases_along_the_chain_are_copied_reused_or_conflicting() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("源");
        put_version(&source, "1.20.1", VANILLA);
        put(&at(&source, "versions/1.20.1/1.20.1.jar"), b"client-jar");
        put_version(&source, FORGE_ID, FORGE);
        put_version(
            &source,
            "整合包",
            &format!(r#"{{"id":"整合包","inheritsFrom":"{FORGE_ID}"}}"#),
        );
        let brigadier = "libraries/com/mojang/brigadier/1.1.8/brigadier-1.1.8.jar";
        let fmlloader =
            "libraries/net/minecraftforge/fmlloader/1.20.1-47.3.33/fmlloader-1.20.1-47.3.33.jar";
        put(&at(&source, brigadier), b"brig");
        put(&at(&source, fmlloader), b"fmlld");

        // 目标里一个基底都没有。
        let empty = tmp.path().join("空目标");
        std::fs::create_dir_all(&empty).unwrap();
        let plan = plan_between(&source, &empty, "整合包").await;
        assert_eq!(
            relative(&plan.files, &source, &empty),
            vec![(brigadier.to_owned(), 4), (fmlloader.to_owned(), 5)],
            "父版本的库也在：库按合并后的整条链算"
        );
        let copied: Vec<(&str, Vec<(String, u64)>)> = plan
            .bases
            .iter()
            .map(|base| (base.id.as_str(), relative(&base.files, &source, &empty)))
            .collect();
        assert_eq!(
            copied,
            vec![
                (
                    FORGE_ID,
                    vec![(
                        format!("versions/{FORGE_ID}/{FORGE_ID}.json"),
                        FORGE.len() as u64
                    )]
                ),
                (
                    "1.20.1",
                    vec![
                        ("versions/1.20.1/1.20.1.jar".to_owned(), 10),
                        (
                            "versions/1.20.1/1.20.1.json".to_owned(),
                            VANILLA.len() as u64
                        ),
                    ]
                ),
            ]
        );
        assert!(plan.reused_bases.is_empty() && plan.conflicting_bases.is_empty());
        assert_eq!(plan.file_count(), 2);
        assert_eq!(
            plan.total_bytes(),
            4 + 5 + FORGE.len() as u64 + 10 + VANILLA.len() as u64
        );

        // 目标里两个基底都有、内容相同（原版那份换了键序与缩进）：都复用，不带。
        let same = tmp.path().join("同样的目标");
        put_version(&same, "1.20.1", VANILLA_REWRITTEN);
        put_version(&same, FORGE_ID, FORGE);
        let plan = plan_between(&source, &same, "整合包").await;
        assert_eq!(
            plan.reused_bases,
            vec![FORGE_ID.to_owned(), "1.20.1".to_owned()]
        );
        assert!(plan.bases.is_empty() && plan.conflicting_bases.is_empty());

        // 加载器版本相同、原版内容不同：前者复用，后者冲突。
        let differs = tmp.path().join("不同的目标");
        put_version(&differs, FORGE_ID, FORGE);
        put_version(&differs, "1.20.1", &VANILLA.replace("release", "snapshot"));
        let plan = plan_between(&source, &differs, "整合包").await;
        assert_eq!(plan.reused_bases, vec![FORGE_ID.to_owned()]);
        assert_eq!(plan.conflicting_bases, vec!["1.20.1".to_owned()]);
        assert!(plan.bases.is_empty());

        // 加载器版本只有空目录（缺 JSON）：算冲突；原版没有就照常带。
        let broken = tmp.path().join("缺 JSON 的目标");
        std::fs::create_dir_all(at(&broken, &format!("versions/{FORGE_ID}"))).unwrap();
        let plan = plan_between(&source, &broken, "整合包").await;
        assert_eq!(plan.conflicting_bases, vec![FORGE_ID.to_owned()]);
        assert_eq!(
            plan.bases.iter().map(|b| b.id.as_str()).collect::<Vec<_>>(),
            vec!["1.20.1"]
        );
        // 目标里的原版 JSON 坏了：同样算冲突，不覆盖它。
        put_version(&broken, "1.20.1", "{ not json");
        let plan = plan_between(&source, &broken, "整合包").await;
        assert_eq!(
            plan.conflicting_bases,
            vec![FORGE_ID.to_owned(), "1.20.1".to_owned()]
        );
        assert!(plan.bases.is_empty() && plan.reused_bases.is_empty());
    }

    /// 1.12.2 的原版 JSON：日志配置与 time 随 Mojang 重发而变，releaseTime 与客户端 jar 不变。
    fn vanilla_1_12_2(client_sha1: &str, logging_sha1: &str, time: &str) -> Value {
        json!({
            "id": "1.12.2",
            "type": "release",
            "time": time,
            "releaseTime": "2017-09-18T08:39:46+00:00",
            "mainClass": "net.minecraft.client.main.Main",
            "minecraftArguments": "--username ${auth_player_name} --version ${version_name}",
            "downloads": {"client": {
                "sha1": client_sha1, "size": 10180113,
                "url": format!("https://example.invalid/{client_sha1}/client.jar")
            }},
            "logging": {"client": {
                "argument": "-Dlog4j.configurationFile=${path}", "type": "log4j2-xml",
                "file": {
                    "id": "client-1.12.xml", "sha1": logging_sha1, "size": 888,
                    "url": format!("https://example.invalid/{logging_sha1}/client-1.12.xml")
                }
            }}
        })
    }

    /// Mojang 在 2021-12 为 log4j 漏洞重发过一批原版 JSON（改了 logging 与 time）：两个目录在不同时期装的同一个
    /// 原版，JSON 不再一样。链根两边都声明了客户端 jar 的 sha1 时按它判同；sha1 不同是另一个游戏本体，仍算冲突；
    /// 目标那份带了 inheritsFrom 就不是链根，不走 sha1，整份比较不同即冲突。
    #[tokio::test]
    async fn a_reissued_vanilla_json_is_reused_when_the_client_jar_matches() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("源");
        let client = hash('c');
        let patched = vanilla_1_12_2(&client, &hash('b'), "2021-12-15T15:44:15+00:00");
        put_version(&source, "1.12.2", &patched.to_string());
        put_version(&source, "空岛", r#"{"id":"空岛","inheritsFrom":"1.12.2"}"#);
        let classify = async |target: &Path| {
            let plan = plan_between(&source, target, "空岛").await;
            assert!(plan.bases.is_empty());
            (plan.reused_bases, plan.conflicting_bases)
        };
        let reused = || (vec!["1.12.2".to_owned()], Vec::<String>::new());
        let conflicting = || (Vec::<String>::new(), vec!["1.12.2".to_owned()]);

        let old = tmp.path().join("2021 年前装的");
        put_version(
            &old,
            "1.12.2",
            &vanilla_1_12_2(&client, &hash('e'), "2017-09-18T08:39:46+00:00").to_string(),
        );
        assert_eq!(classify(&old).await, reused());

        let other_client = tmp.path().join("另一个本体");
        put_version(
            &other_client,
            "1.12.2",
            &vanilla_1_12_2(&hash('d'), &hash('b'), "2021-12-15T15:44:15+00:00").to_string(),
        );
        assert_eq!(classify(&other_client).await, conflicting());

        let not_root = tmp.path().join("目标那份不是链根");
        let mut inheriting = patched.clone();
        inheriting["inheritsFrom"] = json!("1.12");
        put_version(&not_root, "1.12.2", &inheriting.to_string());
        assert_eq!(classify(&not_root).await, conflicting());
    }

    /// 加载器基底没有客户端 jar 可比：去掉顶层 time 与 releaseTime 再比，装的时候写进去的时间不同（或一边没写）
    /// 不算不同；别的字段不同仍算冲突。链根两边都没声明客户端 sha1 时同样这么比。
    #[tokio::test]
    async fn a_loader_base_differing_only_in_times_is_reused() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("源");
        let forge_id = "1.12.2-forge-14.23.5.2860";
        let forge = |time: Option<&str>, tweak: &str| {
            let mut json = json!({
                "id": forge_id,
                "inheritsFrom": "1.12.2",
                "releaseTime": "1960-01-01T00:00:00-0700",
                "mainClass": "net.minecraft.launchwrapper.Launch",
                "minecraftArguments": format!("--username ${{auth_player_name}} --tweakClass {tweak}"),
                "libraries": [{"name": "net.minecraftforge:forge:1.12.2-14.23.5.2860"}]
            });
            if let Some(time) = time {
                json["time"] = json!(time);
            }
            json.to_string()
        };
        let fml = "net.minecraftforge.fml.common.launcher.FMLTweaker";
        // 链根两边都没有 downloads.client：也按去掉时间后的整份比。
        let bare_vanilla = |time: &str| {
            json!({"id": "1.12.2", "type": "release", "time": time, "releaseTime": time})
                .to_string()
        };
        put_version(
            &source,
            "1.12.2",
            &bare_vanilla("2021-12-15T15:44:15+00:00"),
        );
        put_version(
            &source,
            forge_id,
            &forge(Some("2024-05-01T10:00:00+08:00"), fml),
        );
        put_version(
            &source,
            "格雷科技",
            &format!(r#"{{"id":"格雷科技","inheritsFrom":"{forge_id}"}}"#),
        );

        let same = tmp.path().join("只差时间");
        put_version(&same, "1.12.2", &bare_vanilla("2017-09-18T08:39:46+00:00"));
        put_version(
            &same,
            forge_id,
            &forge(Some("2019-02-03T04:05:06+08:00"), fml),
        );
        let plan = plan_between(&source, &same, "格雷科技").await;
        assert_eq!(
            plan.reused_bases,
            vec![forge_id.to_owned(), "1.12.2".to_owned()]
        );
        assert!(plan.conflicting_bases.is_empty() && plan.bases.is_empty());

        let untimed = tmp.path().join("没写 time");
        put_version(
            &untimed,
            "1.12.2",
            &bare_vanilla("2017-09-18T08:39:46+00:00"),
        );
        put_version(&untimed, forge_id, &forge(None, fml));
        let plan = plan_between(&source, &untimed, "格雷科技").await;
        assert_eq!(
            plan.reused_bases,
            vec![forge_id.to_owned(), "1.12.2".to_owned()]
        );

        let differs = tmp.path().join("参数不同");
        put_version(
            &differs,
            "1.12.2",
            &bare_vanilla("2017-09-18T08:39:46+00:00"),
        );
        put_version(
            &differs,
            forge_id,
            &forge(
                Some("2024-05-01T10:00:00+08:00"),
                "optifine.OptiFineTweaker",
            ),
        );
        let plan = plan_between(&source, &differs, "格雷科技").await;
        assert_eq!(plan.reused_bases, vec!["1.12.2".to_owned()]);
        assert_eq!(plan.conflicting_bases, vec![forge_id.to_owned()]);
    }

    /// 只给别的平台的库按规则筛掉，源里有文件也不列。
    #[tokio::test]
    async fn libraries_ruled_out_for_this_platform_are_not_listed() {
        let (_tmp, source, target) = game_dirs();
        let mut osx_only = artifact(
            "org.lwjgl:lwjgl-osx:3.3.3",
            "org/lwjgl/lwjgl-osx/3.3.3/lwjgl-osx-3.3.3.jar",
        );
        osx_only["rules"] = json!([{"action": "allow", "os": {"name": "osx"}}]);
        let mut not_windows = artifact(
            "org.lwjgl:lwjgl-unix:3.3.3",
            "org/lwjgl/lwjgl-unix/3.3.3/lwjgl-unix-3.3.3.jar",
        );
        not_windows["rules"] =
            json!([{"action": "allow"}, {"action": "disallow", "os": {"name": "windows"}}]);
        let everywhere = artifact(
            "org.lwjgl:lwjgl:3.3.3",
            "org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3.jar",
        );
        let instance = json!({"id": "原版", "libraries": [osx_only, not_windows, everywhere]});
        put_version(&source, "原版", &instance.to_string());
        let lwjgl = "libraries/org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3.jar";
        put(
            &at(
                &source,
                "libraries/org/lwjgl/lwjgl-osx/3.3.3/lwjgl-osx-3.3.3.jar",
            ),
            b"osx",
        );
        put(
            &at(
                &source,
                "libraries/org/lwjgl/lwjgl-unix/3.3.3/lwjgl-unix-3.3.3.jar",
            ),
            b"unix",
        );
        put(&at(&source, lwjgl), b"lwjgl");

        let plan = plan_between(&source, &target, "原版").await;

        assert_eq!(
            relative(&plan.files, &source, &target),
            vec![(lwjgl.to_owned(), 5)]
        );
        assert_eq!(plan.missing_in_source, 0);
    }

    /// 旧版 Forge 等版本 JSON 里的旧式 natives 库只写了 `natives` 映射、没有 `downloads.classifiers`：下载计划不给
    /// 它排任务，启动解压却按坐标拼出 natives jar 去读。按解压的口径带上：源里有就带，目标已有就跳过，源里也缺的
    /// 计数；`${arch}` 换成位数；当前平台没有映射的、规则筛掉的不列；带 classifiers 的照旧只列一次。
    #[tokio::test]
    async fn old_style_natives_without_classifiers_follow_the_extraction_paths() {
        use std::collections::hash_map::RandomState;
        use std::hash::BuildHasher;

        let (_tmp, source, target) = game_dirs();
        let instance = json!({
            "id": "1.7.10-Forge",
            "libraries": [
                {"name": "org.lwjgl.lwjgl:lwjgl-platform:2.9.1", "natives": {"windows": "natives-windows"}},
                {"name": "net.java.jinput:jinput-platform:2.0.5", "natives": {"windows": "natives-windows"}},
                {"name": "tv.twitch:twitch-platform:5.16", "natives": {"windows": "natives-windows-${arch}"}},
                {"name": "ca.weblite:java-objc-bridge:1.0.0", "natives": {"osx": "natives-osx"}},
                {
                    "name": "org.lwjgl.lwjgl:lwjgl-platform:2.9.1-nightly-20130708-debug3",
                    "natives": {"windows": "natives-windows"},
                    "rules": [{"action": "allow", "os": {"name": "osx"}}]
                },
                {
                    "name": "org.lwjgl:lwjgl:3.2.2",
                    "natives": {"windows": "natives-windows"},
                    "downloads": {"classifiers": {"natives-windows": {
                        "path": "org/lwjgl/lwjgl/3.2.2/lwjgl-3.2.2-natives-windows.jar",
                        "sha1": "0", "size": 1, "url": "https://example.invalid/n.jar"
                    }}}
                }
            ]
        });
        put_version(&source, "1.7.10-Forge", &instance.to_string());
        let lwjgl2 = "libraries/org/lwjgl/lwjgl/lwjgl-platform/2.9.1/lwjgl-platform-2.9.1-natives-windows.jar";
        let jinput = "libraries/net/java/jinput/jinput-platform/2.0.5/jinput-platform-2.0.5-natives-windows.jar";
        let lwjgl3 = "libraries/org/lwjgl/lwjgl/3.2.2/lwjgl-3.2.2-natives-windows.jar";
        // 大小随机，免得清单碰巧对上一个写死的数。
        let size = RandomState::new().hash_one("natives") % 4096 + 1;
        put(&at(&source, lwjgl2), &vec![7u8; size as usize]);
        put(&at(&source, jinput), b"jinput");
        put(&at(&target, jinput), b"theirs");
        put(&at(&source, lwjgl3), b"lwjgl3");
        put(
            &at(
                &source,
                "libraries/org/lwjgl/lwjgl/lwjgl-platform/2.9.1-nightly-20130708-debug3/\
                 lwjgl-platform-2.9.1-nightly-20130708-debug3-natives-windows.jar",
            ),
            b"osx only",
        );
        put(
            &at(
                &source,
                "libraries/ca/weblite/java-objc-bridge/1.0.0/java-objc-bridge-1.0.0-natives-osx.jar",
            ),
            b"osx",
        );

        let plan = plan_between(&source, &target, "1.7.10-Forge").await;

        assert_eq!(
            relative(&plan.files, &source, &target),
            vec![(lwjgl3.to_owned(), 6), (lwjgl2.to_owned(), size)]
        );
        assert_eq!(
            plan.missing_in_source, 1,
            "twitch 的 natives-windows-64 源里也没有"
        );
        assert_eq!(plan.total_bytes(), 6 + size);
    }

    /// `--fml.*` 的取值要拼进库目录：带 `..`、分隔符或盘符的照实报错，指认是哪个参数。
    #[tokio::test]
    async fn unsafe_fml_values_are_rejected() {
        let (_tmp, source, target) = game_dirs();
        let cases: [(&[&str], &str, &str, UnsafePath); 4] = [
            (
                &[
                    "--fml.forgeVersion",
                    "47.3.33",
                    "--fml.mcVersion",
                    "1.20.1",
                    "--fml.mcpVersion",
                    "..",
                ],
                "--fml.mcpVersion",
                "..",
                UnsafePath::DotSegment,
            ),
            (
                &["--fml.forgeVersion", "..", "--fml.mcVersion", "1.20.1"],
                "--fml.forgeVersion",
                "..",
                UnsafePath::DotSegment,
            ),
            (
                &["--fml.neoForgeVersion", "../../evil"],
                "--fml.neoForgeVersion",
                "../../evil",
                UnsafePath::Separator,
            ),
            (
                &["--fml.forgeVersion", "47.3.33", "--fml.mcVersion", "C:"],
                "--fml.mcVersion",
                "C:",
                UnsafePath::Colon,
            ),
        ];
        for (args, flag, value, problem) in cases {
            let instance = json!({"id": "越界", "arguments": forge_args(args)});
            put_version(&source, "越界", &instance.to_string());
            let err = plan_dependencies(&source, &target, "越界", &runtime())
                .await
                .unwrap_err();
            match err {
                CoreError::Install(petalfall_install::Error::UnsafePath {
                    entry,
                    path,
                    problem: got,
                }) => {
                    assert_eq!(entry, format!("启动参数 {flag}"));
                    assert_eq!(path, value);
                    assert_eq!(got, problem, "{flag} {value}");
                }
                other => panic!("{flag} {value} 应报路径越界，实际：{other:?}"),
            }
        }
    }

    /// 合并不出完整的版本 JSON 就算不出库：链上缺环、JSON 坏了、成环、越界都照实报错。
    #[tokio::test]
    async fn a_chain_that_cannot_be_merged_is_an_error() {
        let (_tmp, source, target) = game_dirs();
        let fail = async |id: &str| {
            plan_dependencies(&source, &target, id, &runtime())
                .await
                .unwrap_err()
        };

        assert!(matches!(
            fail("没有这个").await,
            CoreError::VersionNotInstalled { id } if id == "没有这个"
        ));

        put_version(&source, "孤儿", r#"{"id":"孤儿","inheritsFrom":"1.19.4"}"#);
        assert!(matches!(
            fail("孤儿").await,
            CoreError::Version(petalfall_version::Error::MissingInherited { id, referenced_by })
                if id == "1.19.4" && referenced_by == "孤儿"
        ));

        put_version(&source, "坏父", "{ not json");
        put_version(&source, "坏子", r#"{"id":"坏子","inheritsFrom":"坏父"}"#);
        assert!(matches!(
            fail("坏子").await,
            CoreError::Version(petalfall_version::Error::Json { .. })
        ));

        put_version(&source, "环A", r#"{"id":"环A","inheritsFrom":"环B"}"#);
        put_version(&source, "环B", r#"{"id":"环B","inheritsFrom":"环A"}"#);
        assert!(matches!(
            fail("环A").await,
            CoreError::Version(petalfall_version::Error::InheritCycle { chain })
                if chain == ["环A", "环B", "环A"]
        ));

        put_version(
            &source,
            "越界",
            r#"{"id":"越界","inheritsFrom":"../../secret"}"#,
        );
        assert!(matches!(
            fail("越界").await,
            CoreError::Install(petalfall_install::Error::UnsafePath {
                entry,
                path,
                problem: UnsafePath::Separator,
            }) if entry == "版本 越界 的 inheritsFrom" && path == "../../secret"
        ));

        // 空白的 inheritsFrom 按没有处理，同实例锁取链的口径。
        put_version(&source, "空白", r#"{"id":"空白","inheritsFrom":"  "}"#);
        let plan = plan_between(&source, &target, "空白").await;
        assert!(plan.bases.is_empty() && plan.files.is_empty());
    }
}
