//! 资源索引（objects 索引文件）域模型与本地布局判定。
//!
//! 这是 assetIndex.url 指向的那份 JSON（含逐个资源对象），与版本 JSON 里的 assetIndex 引用不是一回事。
//! 三种布局：普通（按 hash 前两位分桶存 objects/）、virtual（旧版把资源铺进 virtual/<id>/ 真实文件名）、
//! map_to_resources（1.5 及更早铺进 .minecraft/resources/）。本 crate 只解析与算相对路径，不做落盘与下载。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// 资源本地存放布局。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssetLayout {
    /// 按 hash 前两位分桶：objects/ab/abcd...。
    Standard,
    /// 铺进 virtual/<index>/，用资源逻辑名作真实文件名。
    Virtual,
    /// 铺进游戏根的 resources/ 目录（1.5 及更早）。
    MapToResources,
}

/// objects 索引文件模型。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct AssetObjectsIndex {
    /// 逻辑名（如 `minecraft/sounds/...`）到资源对象的映射。
    #[serde(default)]
    pub objects: BTreeMap<String, AssetObject>,
    /// 是否铺进 resources/（旧版）。
    #[serde(rename = "map_to_resources", default)]
    pub map_to_resources: bool,
    /// 是否为虚拟布局（旧版）。
    #[serde(rename = "virtual", default)]
    pub is_virtual: bool,
}

impl AssetObjectsIndex {
    /// 从 JSON 字符串解析。
    pub fn from_json_str(s: &str) -> Result<Self> {
        serde_json::from_str(s).map_err(|source| Error::Json {
            context: "资源索引",
            source,
        })
    }

    /// 判定该索引的布局。map_to_resources 优先于 virtual。
    pub fn layout(&self) -> AssetLayout {
        if self.map_to_resources {
            AssetLayout::MapToResources
        } else if self.is_virtual {
            AssetLayout::Virtual
        } else {
            AssetLayout::Standard
        }
    }
}

/// 单个资源对象。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssetObject {
    /// 内容 sha1（小写十六进制）。
    pub hash: String,
    /// 字节大小。
    pub size: u64,
}

impl AssetObject {
    /// 普通布局下相对 objects/ 根的存放路径：`<hash前2位>/<hash>`。
    /// hash 短于 2 位时退化为整串（异常数据的兜底，不 panic）。
    pub fn object_path(&self) -> String {
        match self.hash.get(..2) {
            Some(prefix) => format!("{prefix}/{}", self.hash),
            None => self.hash.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_layout_and_object_path() {
        let json = r#"{
            "objects": {
                "minecraft/sounds/ambient/cave/cave1.ogg": {
                    "hash": "0d0b0e0f1234567890abcdef0123456789abcdef", "size": 12345
                }
            }
        }"#;
        let idx = AssetObjectsIndex::from_json_str(json).expect("资源索引应解析");
        assert_eq!(idx.layout(), AssetLayout::Standard);
        let obj = &idx.objects["minecraft/sounds/ambient/cave/cave1.ogg"];
        assert_eq!(obj.size, 12345);
        assert_eq!(
            obj.object_path(),
            "0d/0d0b0e0f1234567890abcdef0123456789abcdef"
        );
    }

    #[test]
    fn virtual_layout_flag() {
        let idx = AssetObjectsIndex::from_json_str(r#"{"virtual":true,"objects":{}}"#).unwrap();
        assert_eq!(idx.layout(), AssetLayout::Virtual);
    }

    #[test]
    fn map_to_resources_takes_priority() {
        let idx = AssetObjectsIndex::from_json_str(
            r#"{"map_to_resources":true,"virtual":true,"objects":{}}"#,
        )
        .unwrap();
        assert_eq!(idx.layout(), AssetLayout::MapToResources);
    }

    #[test]
    fn default_index_is_standard() {
        let idx = AssetObjectsIndex::from_json_str(r#"{"objects":{}}"#).unwrap();
        assert_eq!(idx.layout(), AssetLayout::Standard);
        assert!(idx.objects.is_empty());
    }
}
