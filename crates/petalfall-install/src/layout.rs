//! `.minecraft` 目录布局。
//!
//! 安装器把「选定版本」落到一个游戏根目录（`.minecraft`）下的固定子结构：`versions/<id>/`、
//! `libraries/<maven 路径>`、`assets/{indexes,objects,virtual}`。本模块只做路径拼装（纯字符串/
//! `PathBuf` 运算，不碰文件系统），让下载与解压层拿到确定的落点。目录本身在写文件时由
//! [`petalfall_base::fs::atomic_write`] 或下载引擎按需创建。
//!
//! 版本 JSON、加载器 profile、资源索引里的路径与 id 来自远端，落点一律经带 `checked` / 返回 `Result`
//! 的入口算出：能走出游戏目录的值报 [`Error::UnsafePath`]，指认原始条目，不悄悄丢段。

use std::path::{Path, PathBuf};

use petalfall_version::{check_path_segment, check_relative_path};

use crate::error::{Error, Result};
use crate::maven;

/// assets 对象的官方分发根（BMCLAPI 改写为 `/assets`，由下载源调度层负责）。
pub const ASSET_OBJECTS_BASE: &str = "https://resources.download.minecraft.net";

/// 一个游戏根目录（`.minecraft`）下的路径布局。
#[derive(Debug, Clone)]
pub struct GameLayout {
    root: PathBuf,
}

impl GameLayout {
    /// 以给定游戏根目录构造。
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// 游戏根目录（`.minecraft`）。
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// `versions/` 目录。
    pub fn versions_dir(&self) -> PathBuf {
        self.root.join("versions")
    }

    /// `versions/<id>/` 目录。
    pub fn version_dir(&self, id: &str) -> PathBuf {
        self.versions_dir().join(id)
    }

    /// `versions/<id>/<id>.json`。
    pub fn version_json(&self, id: &str) -> PathBuf {
        self.version_dir(id).join(format!("{id}.json"))
    }

    /// `versions/<id>/<id>.jar`（客户端主 jar）。
    pub fn version_jar(&self, id: &str) -> PathBuf {
        self.version_dir(id).join(format!("{id}.jar"))
    }

    /// natives 解压目录 `versions/<id>/<id>-natives`（与 PCL 约定一致，随版本隔离）。
    pub fn natives_dir(&self, id: &str) -> PathBuf {
        self.version_dir(id).join(format!("{id}-natives"))
    }

    /// `libraries/` 根目录。
    pub fn libraries_dir(&self) -> PathBuf {
        self.root.join("libraries")
    }

    /// 把一个相对仓库根的 maven 路径（正斜杠分隔）落到 `libraries/` 下，不做校验。
    ///
    /// 只给本地常量与已校验过的路径用；版本 JSON、加载器 profile 里来的路径走
    /// [`checked_library_path`](Self::checked_library_path)。
    pub fn library_path(&self, relative: &str) -> PathBuf {
        self.libraries_dir().join(
            relative
                .split('/')
                .filter(|s| !s.is_empty())
                .collect::<PathBuf>(),
        )
    }

    /// 把版本 JSON 给出的库路径（`downloads.*.path`，或由坐标算出的路径）落到 `libraries/` 下。
    /// 能走出库目录的路径报 [`Error::UnsafePath`]；`library` 是声明它的库坐标，报错时指认条目。
    pub fn checked_library_path(&self, library: &str, relative: &str) -> Result<PathBuf> {
        let rel = rel_to_path(relative, || format!("库 {library}"))?;
        Ok(self.libraries_dir().join(rel))
    }

    /// 由 maven 坐标算出其在 `libraries/` 下的落点；坐标缺段、或有能走出库目录的段时 `None`，
    /// 由调用方冒泡成坐标非法错误。要区分是哪一种时用 [`coordinate_path`]。
    pub fn library_path_for_coordinate(&self, coordinate: &str) -> Option<PathBuf> {
        let rel = coordinate_path(coordinate).ok()?;
        Some(self.library_path(&rel))
    }

    /// 由 maven 坐标算出其在 `libraries/` 下的落点，错误按 [`coordinate_path`] 区分：缺段报坐标非法，
    /// 有能走出库目录的段报 [`Error::UnsafePath`]。
    pub fn checked_coordinate_path(&self, coordinate: &str) -> Result<PathBuf> {
        Ok(self.library_path(&coordinate_path(coordinate)?))
    }

    /// `assets/` 根目录。
    pub fn assets_dir(&self) -> PathBuf {
        self.root.join("assets")
    }

    /// `assets/indexes/<id>.json`。id 取自版本 JSON 的 assetIndex，不是单个安全路径段时报
    /// [`Error::UnsafePath`]。
    pub fn asset_index_json(&self, id: &str) -> Result<PathBuf> {
        checked_segment(id, || "资源索引 id".to_owned())?;
        Ok(self.assets_dir().join("indexes").join(format!("{id}.json")))
    }

    /// `assets/objects/` 根目录。
    pub fn asset_objects_dir(&self) -> PathBuf {
        self.assets_dir().join("objects")
    }

    /// 单个资源对象的落点 `assets/objects/<hash 前两位>/<hash>`。
    pub fn asset_object_path(&self, hash: &str) -> PathBuf {
        let bucket = hash.get(..2).unwrap_or(hash);
        self.asset_objects_dir().join(bucket).join(hash)
    }

    /// virtual 布局的展开目录 `assets/virtual/<index_id>`。index_id 取自版本 JSON，不是单个安全路径段时
    /// 报 [`Error::UnsafePath`]。
    pub fn asset_virtual_dir(&self, index_id: &str) -> Result<PathBuf> {
        checked_segment(index_id, || "资源索引 id".to_owned())?;
        Ok(self.assets_dir().join("virtual").join(index_id))
    }

    /// map_to_resources 布局的展开目录 `<root>/resources`（1.5 及更早）。
    pub fn resources_dir(&self) -> PathBuf {
        self.root.join("resources")
    }
}

/// 由 maven 坐标算出相对仓库根的路径（正斜杠分隔），并逐段校验：group 的每一节、artifact、version、
/// classifier 与扩展名都得是能安全落盘的单个路径段。坐标缺段报 [`Error::InvalidLibraryCoordinate`]，
/// 有能走出库目录的段报 [`Error::UnsafePath`]。
pub fn coordinate_path(coordinate: &str) -> Result<String> {
    let rel = maven::artifact_path(coordinate).ok_or_else(|| Error::InvalidLibraryCoordinate {
        name: coordinate.to_owned(),
    })?;
    let (fields, extension) = match coordinate.split_once('@') {
        Some((fields, extension)) => (fields, Some(extension)),
        None => (coordinate, None),
    };
    let (group, rest) = fields
        .split_once(':')
        .expect("artifact_path 已保证坐标至少有三段");
    let problem = group
        .split('.')
        .chain(rest.split(':'))
        .chain(extension)
        .find_map(|segment| check_path_segment(segment).err());
    match problem {
        Some(problem) => Err(Error::UnsafePath {
            entry: format!("库 {coordinate}"),
            path: rel,
            problem,
        }),
        None => Ok(rel),
    }
}

/// 旧版资源布局（virtual / map_to_resources）里，资源逻辑名在展开目录下的落点。能走出展开目录的逻辑名报
/// [`Error::UnsafePath`]。
pub fn materialized_asset_path(target_dir: &Path, logical: &str) -> Result<PathBuf> {
    Ok(target_dir.join(rel_to_path(logical, || "资源逻辑名".to_owned())?))
}

/// 把以 `/` 分隔的相对路径转成本平台 `PathBuf`；能走出目标目录的报 [`Error::UnsafePath`]，`entry` 给出
/// 报错时指认的条目（只在出错时求值）。
pub(crate) fn rel_to_path(relative: &str, entry: impl FnOnce() -> String) -> Result<PathBuf> {
    check_relative_path(relative).map_err(|problem| Error::UnsafePath {
        entry: entry(),
        path: relative.to_owned(),
        problem,
    })?;
    Ok(relative.split('/').collect())
}

/// 要原样当作单个目录名或文件名的值（索引 id、资源 hash、日志配置名、版本 id）不能带分隔符或 `..`。
pub(crate) fn checked_segment(segment: &str, entry: impl FnOnce() -> String) -> Result<()> {
    check_path_segment(segment).map_err(|problem| Error::UnsafePath {
        entry: entry(),
        path: segment.to_owned(),
        problem,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use petalfall_version::UnsafePath;

    fn layout() -> GameLayout {
        GameLayout::new(PathBuf::from("D:/mc/.minecraft"))
    }

    #[test]
    fn version_paths() {
        let l = layout();
        assert_eq!(
            l.version_json("1.21"),
            PathBuf::from("D:/mc/.minecraft/versions/1.21/1.21.json")
        );
        assert_eq!(
            l.version_jar("1.21"),
            PathBuf::from("D:/mc/.minecraft/versions/1.21/1.21.jar")
        );
        assert_eq!(
            l.natives_dir("1.21"),
            PathBuf::from("D:/mc/.minecraft/versions/1.21/1.21-natives")
        );
    }

    #[test]
    fn library_path_from_coordinate() {
        let l = layout();
        assert_eq!(
            l.library_path_for_coordinate("org.lwjgl:lwjgl:3.3.3:natives-windows")
                .unwrap(),
            PathBuf::from(
                "D:/mc/.minecraft/libraries/org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar"
            )
        );
    }

    #[test]
    fn asset_object_bucketing() {
        let l = layout();
        assert_eq!(
            l.asset_object_path("e3a1b2c3d4e5f6000000000000000000000000ff"),
            PathBuf::from(
                "D:/mc/.minecraft/assets/objects/e3/e3a1b2c3d4e5f6000000000000000000000000ff"
            )
        );
        assert_eq!(
            l.asset_index_json("17").unwrap(),
            PathBuf::from("D:/mc/.minecraft/assets/indexes/17.json")
        );
    }

    #[test]
    fn rel_to_path_splits_safe_paths() {
        assert_eq!(
            rel_to_path("a/b/c.jar", String::new).unwrap(),
            PathBuf::from("a").join("b").join("c.jar")
        );
    }

    fn unsafe_problem(result: Result<impl std::fmt::Debug>) -> UnsafePath {
        match result {
            Err(Error::UnsafePath { problem, .. }) => problem,
            other => panic!("应报路径越界，实际：{other:?}"),
        }
    }

    /// 版本 JSON 的库路径能把带合法 sha1 的文件写到库目录之外：每种越界形态都报错，并指认库与原始路径。
    #[test]
    fn library_paths_escaping_the_libraries_dir_are_rejected() {
        let l = layout();
        for (path, problem) in [
            ("../../evil.jar", UnsafePath::DotSegment),
            ("org/../../../evil.jar", UnsafePath::DotSegment),
            ("/abs/evil.jar", UnsafePath::Absolute),
            ("C:/Windows/evil.dll", UnsafePath::Colon),
            ("C:evil.dll", UnsafePath::Colon),
            ("org\\..\\..\\evil.jar", UnsafePath::Backslash),
            ("org/evil.jar:stream", UnsafePath::Colon),
            ("org//evil.jar", UnsafePath::EmptySegment),
            ("", UnsafePath::Empty),
        ] {
            let err = l.checked_library_path("g:a:1", path).unwrap_err();
            assert_eq!(
                err.to_string(),
                format!("库 g:a:1：路径「{path}」会落到游戏目录之外，已拒绝写入"),
                "{path:?}"
            );
            assert_eq!(
                unsafe_problem(l.checked_library_path("g:a:1", path)),
                problem,
                "{path:?}"
            );
        }
        assert_eq!(
            l.checked_library_path("g:a:1", "org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3.jar")
                .unwrap(),
            PathBuf::from("D:/mc/.minecraft/libraries/org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3.jar")
        );
    }

    /// maven 坐标的每一段都会拼进落点：group 的每一节、artifact、version、classifier、扩展名逐段校验。
    #[test]
    fn coordinate_segments_escaping_the_libraries_dir_are_rejected() {
        for (coordinate, problem) in [
            ("evil:..:1", UnsafePath::DotSegment),
            ("evil:a:..", UnsafePath::DotSegment),
            ("evil:a:1:..", UnsafePath::DotSegment),
            ("evil:a:1@..", UnsafePath::DotSegment),
            ("evil:../../x:1", UnsafePath::Separator),
            ("/abs:a:1", UnsafePath::Separator),
            ("evil:a:1@C:x", UnsafePath::Colon),
            ("evil:a:1@jar:stream", UnsafePath::Colon),
            ("evil:..\\..\\x:1", UnsafePath::Backslash),
            ("evil:a:1:natives\\..\\x", UnsafePath::Backslash),
            ("org..evil:a:1", UnsafePath::EmptySegment),
            (".evil:a:1", UnsafePath::EmptySegment),
            ("evil:a:1.", UnsafePath::TrailingDotOrSpace),
        ] {
            assert_eq!(
                unsafe_problem(coordinate_path(coordinate)),
                problem,
                "{coordinate}"
            );
            assert!(
                layout().library_path_for_coordinate(coordinate).is_none(),
                "{coordinate}"
            );
        }
        let err = coordinate_path("evil:..:1").unwrap_err();
        assert_eq!(
            err.to_string(),
            "库 evil:..:1：路径「evil/../1/..-1.jar」会落到游戏目录之外，已拒绝写入"
        );
        assert!(matches!(
            coordinate_path("only:two"),
            Err(Error::InvalidLibraryCoordinate { name }) if name == "only:two"
        ));
    }

    #[test]
    fn real_coordinates_keep_their_paths() {
        for (coordinate, path) in [
            (
                "org.lwjgl:lwjgl:3.3.3:natives-windows",
                "org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar",
            ),
            (
                "de.oceanlabs.mcp:mcp_config:1.20.1-20230612.114412@zip",
                "de/oceanlabs/mcp/mcp_config/1.20.1-20230612.114412/mcp_config-1.20.1-20230612.114412.zip",
            ),
            (
                "net.minecraft:client:1.20.1-20230612.114412:mappings@txt",
                "net/minecraft/client/1.20.1-20230612.114412/client-1.20.1-20230612.114412-mappings.txt",
            ),
            (
                "net.md-5:SpecialSource:1.11.0",
                "net/md-5/SpecialSource/1.11.0/SpecialSource-1.11.0.jar",
            ),
            (
                "net.minecraftforge:forge:1.7.10-10.13.4.1614-1.7.10",
                "net/minecraftforge/forge/1.7.10-10.13.4.1614-1.7.10/forge-1.7.10-10.13.4.1614-1.7.10.jar",
            ),
        ] {
            assert_eq!(coordinate_path(coordinate).unwrap(), path, "{coordinate}");
        }
    }

    #[test]
    fn asset_ids_and_logical_names_must_stay_inside_the_assets_dir() {
        let l = layout();
        assert_eq!(
            unsafe_problem(l.asset_index_json("../../evil")),
            UnsafePath::Separator
        );
        assert_eq!(
            unsafe_problem(l.asset_index_json("..")),
            UnsafePath::DotSegment
        );
        assert_eq!(
            unsafe_problem(l.asset_virtual_dir("C:evil")),
            UnsafePath::Colon
        );
        assert_eq!(
            l.asset_virtual_dir("pre-1.6").unwrap(),
            PathBuf::from("D:/mc/.minecraft/assets/virtual/pre-1.6")
        );

        let target = l.resources_dir();
        assert_eq!(
            unsafe_problem(materialized_asset_path(&target, "sounds/../../evil.txt")),
            UnsafePath::DotSegment
        );
        assert_eq!(
            materialized_asset_path(&target, "sound3/random/old explode.ogg").unwrap(),
            target.join("sound3").join("random").join("old explode.ogg")
        );
    }
}
