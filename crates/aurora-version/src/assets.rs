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
    /// 逻辑名（如 `minecraft/sounds/...`）到资源对象的映射。读入时拒掉能走出资源目录的逻辑名。
    #[serde(default, deserialize_with = "safe_object_names")]
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
    /// 内容 sha1（十六进制）。读入时只认 40 位十六进制。
    #[serde(deserialize_with = "sha1_hex")]
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

// 逻辑名在旧版布局里原样拼进 virtual/<id>/ 或 resources/ 当文件名，hash 拼进 objects/ 当落点。两者都来自
// 远端索引（版本列表源可以是第三方镜像），sha1 也由同一份索引给出，下载校验拦不住；所以读入时就拒掉能
// 走出资源目录的值，整份索引按解析失败报错，不悄悄跳过。

fn safe_object_names<'de, D>(
    deserializer: D,
) -> std::result::Result<BTreeMap<String, AssetObject>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let objects = BTreeMap::<String, AssetObject>::deserialize(deserializer)?;
    if let Some(name) = objects.keys().find(|name| !is_safe_object_name(name)) {
        return Err(serde::de::Error::custom(format!(
            "资源逻辑名 {name:?} 会落到资源目录之外（为空、是绝对路径，或含 . / .. 段、盘符、反斜杠）"
        )));
    }
    Ok(objects)
}

fn is_safe_object_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('/')
        && !name.contains(['\\', ':'])
        && name
            .split('/')
            .all(|segment| segment != "." && segment != "..")
}

fn sha1_hex<'de, D>(deserializer: D) -> std::result::Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let hash = String::deserialize(deserializer)?;
    if hash.len() == 40 && hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(hash)
    } else {
        Err(serde::de::Error::custom(format!(
            "资源对象的 hash {hash:?} 不是 40 位十六进制的 sha1"
        )))
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

    const GOOD_HASH: &str = "0d0b0e0f1234567890abcdef0123456789abcdef";

    fn index_with(name: &str, hash: &str) -> String {
        serde_json::json!({ "virtual": true, "objects": { name: { "hash": hash, "size": 1 } } })
            .to_string()
    }

    /// hash 直接拼进 objects/ 下的落点：不是 40 位十六进制的（如 `../../x`）能把文件写到资源目录之外。
    #[test]
    fn object_hash_that_is_not_a_sha1_is_rejected() {
        for hash in [
            "../../../../evil",
            "..\\..\\evil",
            "0d0b0e0f1234567890abcdef0123456789abcde",
            "0d0b0e0f1234567890abcdef0123456789abcdef0",
            "zz0b0e0f1234567890abcdef0123456789abcdef",
            "",
        ] {
            let parsed = AssetObjectsIndex::from_json_str(&index_with("pack.mcmeta", hash));
            assert!(
                matches!(parsed, Err(Error::Json { .. })),
                "hash {hash:?} 应被拒：{parsed:?}"
            );
        }
        let upper = GOOD_HASH.to_ascii_uppercase();
        let parsed = AssetObjectsIndex::from_json_str(&index_with("pack.mcmeta", &upper)).unwrap();
        assert_eq!(parsed.objects["pack.mcmeta"].hash, upper);
    }

    /// 旧版布局按逻辑名铺进 virtual/<id>/ 或 resources/：带 `..`、盘符、反斜杠或绝对路径的名字会落到外面。
    #[test]
    fn object_names_escaping_the_asset_dir_are_rejected() {
        for name in [
            "../outside.txt",
            "minecraft/../../outside.txt",
            "./pack.mcmeta",
            "minecraft\\..\\..\\outside.txt",
            "C:/Windows/evil.dll",
            "C:evil.dll",
            "/abs/evil.txt",
            "sounds/a.ogg:stream",
            "",
        ] {
            let parsed = AssetObjectsIndex::from_json_str(&index_with(name, GOOD_HASH));
            assert!(
                matches!(parsed, Err(Error::Json { .. })),
                "逻辑名 {name:?} 应被拒：{parsed:?}"
            );
        }
        for name in [
            "minecraft/sounds/ambient/cave/cave1.ogg",
            "READ_ME_I_AM_VERY_IMPORTANT.txt",
            "sound3/random/old explode.ogg",
            "icons/icon_16x16.png",
        ] {
            let parsed = AssetObjectsIndex::from_json_str(&index_with(name, GOOD_HASH))
                .unwrap_or_else(|err| panic!("逻辑名 {name:?} 应能解析：{err:?}"));
            assert_eq!(parsed.objects[name].hash, GOOD_HASH);
        }
    }

    #[test]
    fn default_index_is_standard() {
        let idx = AssetObjectsIndex::from_json_str(r#"{"objects":{}}"#).unwrap();
        assert_eq!(idx.layout(), AssetLayout::Standard);
        assert!(idx.objects.is_empty());
    }
}
