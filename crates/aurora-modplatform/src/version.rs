//! 跨平台统一版本模型。
//!
//! Modrinth 的 `version` 与 CurseForge 的 `file` 是两套形状完全不同的 JSON：前者版本号、加载器、
//! 游戏版本各占一个干净字段，后者把加载器名和 MC 版本号混在同一个 `gameVersions` 数组里。上层
//! （依赖解析、兼容判定、更新检查、UI）不该为此各写一遍分支，这里定义两边共同归一到的
//! [`ModVersionInfo`]，翻译动作放在各平台模块（[`crate::modrinth`] / [`crate::curseforge`]）里。

use serde::{Deserialize, Serialize};

use crate::model::{DependencyKind, ModLoader, Platform};

/// 发布通道。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReleaseChannel {
    /// 正式版。
    Release,
    /// 测试版。
    Beta,
    /// 内测版。
    Alpha,
}

impl ReleaseChannel {
    /// 由 Modrinth `version_type` 解析；未知取值返回 `None`。
    pub fn from_modrinth(value: &str) -> Option<Self> {
        match value {
            "release" => Some(ReleaseChannel::Release),
            "beta" => Some(ReleaseChannel::Beta),
            "alpha" => Some(ReleaseChannel::Alpha),
            _ => None,
        }
    }

    /// 由 CurseForge `releaseType` 数值解析（1 Release / 2 Beta / 3 Alpha）；未知返回 `None`。
    pub fn from_curseforge(release_type: u8) -> Option<Self> {
        match release_type {
            1 => Some(ReleaseChannel::Release),
            2 => Some(ReleaseChannel::Beta),
            3 => Some(ReleaseChannel::Alpha),
            _ => None,
        }
    }
}

/// 由平台给的加载器名解析枚举；识别不出返回 `None`。
///
/// 大小写不敏感，并抹掉空格/连字符/下划线——同一个加载器在两边可能写成 `NeoForge` / `neoforge` /
/// `Neo Forge` 三种样子。认不出的名字（Modrinth 的 `rift`、`bukkit`，CurseForge 的 `Client`）由调用方
/// 丢弃：编一个加载器出来比少一个更危险，会把不兼容的 Mod 判成可装。
pub fn parse_loader_name(name: &str) -> Option<ModLoader> {
    let normalized: String = name
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-' && *c != '_')
        .flat_map(|c| c.to_lowercase())
        .collect();
    match normalized.as_str() {
        "fabric" => Some(ModLoader::Fabric),
        "quilt" => Some(ModLoader::Quilt),
        "forge" => Some(ModLoader::Forge),
        "neoforge" => Some(ModLoader::NeoForge),
        "liteloader" => Some(ModLoader::LiteLoader),
        _ => None,
    }
}

/// 一个工程版本的跨平台统一视图。Modrinth 的 version 与 CurseForge 的 file 都归一到它。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModVersionInfo {
    /// 安装时回传给 install 的版本标识：Modrinth 为版本 id，CurseForge 为 fileId 的十进制字符串。
    pub version_id: String,
    /// 所属工程标识：Modrinth 为 project_id，CurseForge 为 modId 十进制字符串。
    pub project_id: String,
    /// 来源平台。
    pub platform: Platform,
    /// 版本展示名。
    pub name: String,
    /// 版本号（技术串）。
    pub version_number: String,
    /// 发布通道。
    pub release_channel: ReleaseChannel,
    /// 支持的 MC 版本，已剥离加载器名。
    pub game_versions: Vec<String>,
    /// 支持的加载器，认不出的名字已丢弃。
    pub loaders: Vec<ModLoader>,
    /// 主文件名（与磁盘上的 jar 同名，是与卷宗 join 的键）。
    pub file_name: String,
    /// 文件字节数；平台没给为 `None`。
    pub file_size: Option<u64>,
    /// 文件 SHA-1；平台没给为 `None`。
    pub sha1: Option<String>,
    /// ISO 8601 字符串，缺失为空串。
    pub date_published: String,
    /// 依赖列表，类型识别不了的项已丢弃。
    pub dependencies: Vec<ModDependency>,
}

/// 跨平台依赖项。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModDependency {
    /// Modrinth 为 project_id；CurseForge 为 modId 十进制字符串。缺失为 `None`。
    pub project_id: Option<String>,
    /// 指定了精确版本时给出，否则 `None`（由依赖解析自行择优）。
    pub version_id: Option<String>,
    /// 依赖关系类型。
    pub kind: DependencyKind,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_channel_parses_modrinth_strings() {
        assert_eq!(
            ReleaseChannel::from_modrinth("release"),
            Some(ReleaseChannel::Release)
        );
        assert_eq!(
            ReleaseChannel::from_modrinth("beta"),
            Some(ReleaseChannel::Beta)
        );
        assert_eq!(
            ReleaseChannel::from_modrinth("alpha"),
            Some(ReleaseChannel::Alpha)
        );
        assert_eq!(ReleaseChannel::from_modrinth("Release"), None);
        assert_eq!(ReleaseChannel::from_modrinth(""), None);
    }

    #[test]
    fn release_channel_parses_curseforge_codes() {
        assert_eq!(
            ReleaseChannel::from_curseforge(1),
            Some(ReleaseChannel::Release)
        );
        assert_eq!(
            ReleaseChannel::from_curseforge(2),
            Some(ReleaseChannel::Beta)
        );
        assert_eq!(
            ReleaseChannel::from_curseforge(3),
            Some(ReleaseChannel::Alpha)
        );
        assert_eq!(ReleaseChannel::from_curseforge(0), None);
        assert_eq!(ReleaseChannel::from_curseforge(9), None);
    }

    #[test]
    fn loader_name_parsing_is_case_and_separator_insensitive() {
        assert_eq!(parse_loader_name("Forge"), Some(ModLoader::Forge));
        assert_eq!(parse_loader_name("forge"), Some(ModLoader::Forge));
        assert_eq!(parse_loader_name("NeoForge"), Some(ModLoader::NeoForge));
        assert_eq!(parse_loader_name("neoforge"), Some(ModLoader::NeoForge));
        assert_eq!(parse_loader_name("Neo Forge"), Some(ModLoader::NeoForge));
        assert_eq!(parse_loader_name("neo-forge"), Some(ModLoader::NeoForge));
        assert_eq!(parse_loader_name("neo_forge"), Some(ModLoader::NeoForge));
        assert_eq!(parse_loader_name("Fabric"), Some(ModLoader::Fabric));
        assert_eq!(parse_loader_name("Quilt"), Some(ModLoader::Quilt));
        assert_eq!(parse_loader_name("LiteLoader"), Some(ModLoader::LiteLoader));
    }

    #[test]
    fn loader_name_parsing_rejects_non_loader_tags() {
        // CurseForge gameVersions 里的杂物与 Modrinth 的冷门加载器都必须被拒。
        assert_eq!(parse_loader_name("Client"), None);
        assert_eq!(parse_loader_name("Server"), None);
        assert_eq!(parse_loader_name("Java 17"), None);
        assert_eq!(parse_loader_name("1.20.1"), None);
        assert_eq!(parse_loader_name("rift"), None);
        assert_eq!(parse_loader_name(""), None);
        assert_eq!(parse_loader_name("   "), None);
        // 只是包含加载器名不算，必须整体匹配。
        assert_eq!(parse_loader_name("forge-1.20.1"), None);
    }

    #[test]
    fn version_info_serializes_with_ipc_field_names() {
        let info = ModVersionInfo {
            version_id: "IZskiJmZ".to_string(),
            project_id: "AANobbMI".to_string(),
            platform: Platform::Modrinth,
            name: "Sodium 0.5.3".to_string(),
            version_number: "mc1.20.1-0.5.3".to_string(),
            release_channel: ReleaseChannel::Beta,
            game_versions: vec!["1.20.1".to_string()],
            loaders: vec![ModLoader::Fabric, ModLoader::NeoForge],
            file_name: "sodium.jar".to_string(),
            file_size: Some(204_800),
            sha1: Some("ddeeff".to_string()),
            date_published: "2026-01-02T03:04:05Z".to_string(),
            dependencies: vec![ModDependency {
                project_id: Some("P7dR8mSH".to_string()),
                version_id: None,
                kind: DependencyKind::Required,
            }],
        };
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["version_id"], "IZskiJmZ");
        assert_eq!(json["platform"], "modrinth");
        assert_eq!(json["release_channel"], "beta");
        assert_eq!(json["game_versions"][0], "1.20.1");
        // 加载器的序列化名与搜索、安装的入参同名（neoforge 连写），前端原样回传不会被拒。
        assert_eq!(json["loaders"][0], "fabric");
        assert_eq!(json["loaders"][1], "neoforge");
        assert_eq!(json["file_size"], 204_800);
        assert_eq!(json["dependencies"][0]["kind"], "required");
        assert_eq!(
            json["dependencies"][0]["version_id"],
            serde_json::Value::Null
        );

        // 回环：DTO 同时用于读回本地缓存，序列化必须是无损的。
        let back: ModVersionInfo = serde_json::from_value(json).unwrap();
        assert_eq!(back, info);
    }
}
