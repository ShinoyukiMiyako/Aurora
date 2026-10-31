//! `.minecraft` 目录布局。
//!
//! 安装器把「选定版本」落到一个游戏根目录（`.minecraft`）下的固定子结构：`versions/<id>/`、
//! `libraries/<maven 路径>`、`assets/{indexes,objects,virtual}`。本模块只做路径拼装（纯字符串/
//! `PathBuf` 运算，不碰文件系统），让下载与解压层拿到确定的落点。目录本身在写文件时由
//! [`aurora_base::fs::atomic_write`] 或下载引擎按需创建。

use std::path::{Path, PathBuf};

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

    /// 把一个相对仓库根的 maven 路径（正斜杠分隔）落到 `libraries/` 下。
    pub fn library_path(&self, relative: &str) -> PathBuf {
        self.libraries_dir().join(rel_to_path(relative))
    }

    /// 由 maven 坐标算出其在 `libraries/` 下的落点；坐标非法时 `None`。
    pub fn library_path_for_coordinate(&self, coordinate: &str) -> Option<PathBuf> {
        maven::artifact_path(coordinate).map(|rel| self.library_path(&rel))
    }

    /// `assets/` 根目录。
    pub fn assets_dir(&self) -> PathBuf {
        self.root.join("assets")
    }

    /// `assets/indexes/<id>.json`。
    pub fn asset_index_json(&self, id: &str) -> PathBuf {
        self.assets_dir().join("indexes").join(format!("{id}.json"))
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

    /// virtual 布局的展开目录 `assets/virtual/<index_id>`。
    pub fn asset_virtual_dir(&self, index_id: &str) -> PathBuf {
        self.assets_dir().join("virtual").join(index_id)
    }

    /// map_to_resources 布局的展开目录 `<root>/resources`（1.5 及更早）。
    pub fn resources_dir(&self) -> PathBuf {
        self.root.join("resources")
    }
}

/// 把以 `/` 分隔的相对路径转成本平台 `PathBuf`。
pub(crate) fn rel_to_path(relative: &str) -> PathBuf {
    relative.split('/').filter(|s| !s.is_empty()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

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
            l.asset_index_json("17"),
            PathBuf::from("D:/mc/.minecraft/assets/indexes/17.json")
        );
    }

    #[test]
    fn rel_to_path_ignores_empty_segments() {
        assert_eq!(
            rel_to_path("a//b/c"),
            PathBuf::from("a").join("b").join("c")
        );
    }
}
