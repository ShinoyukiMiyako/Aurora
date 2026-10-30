//! Mod 平台模块的基础类型系统。
//!
//! 这里定义跨平台通用的枚举与查询/结果模型：资源类型、来源平台、Mod 加载器、排序字段、依赖关系，
//! 以及聚合搜索用的统一命中模型 [`SearchHit`]。各平台客户端（[`crate::modrinth`] / [`crate::curseforge`]）
//! 只依赖这里的枚举，把自家 API 的裸串/数字编码翻译为这套通用类型；反向的裸编码映射也集中在这里，
//! 避免散落在各处。

use serde::{Deserialize, Serialize};

/// 资源来源平台。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    /// Modrinth（api.modrinth.com/v2）。
    Modrinth,
    /// CurseForge（api.curseforge.com/v1，需 API key）。
    CurseForge,
}

impl Platform {
    /// 面向 UI 的展示名。
    pub fn display_name(self) -> &'static str {
        match self {
            Platform::Modrinth => "Modrinth",
            Platform::CurseForge => "CurseForge",
        }
    }
}

/// 资源类型。整个资源管理模块的基础分类维度。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceType {
    /// 模组（默认）。
    #[default]
    Mod,
    /// 整合包。
    Modpack,
    /// 资源包（材质包）。
    ResourcePack,
    /// 光影包。
    Shader,
    /// 数据包。
    DataPack,
    /// 服务端插件。
    Plugin,
}

impl ResourceType {
    /// Modrinth `project_type` facet 取值（见 `/v2/tag/project_type`）。
    pub fn modrinth_project_type(self) -> &'static str {
        match self {
            ResourceType::Mod => "mod",
            ResourceType::Modpack => "modpack",
            ResourceType::ResourcePack => "resourcepack",
            ResourceType::Shader => "shader",
            ResourceType::DataPack => "datapack",
            ResourceType::Plugin => "plugin",
        }
    }

    /// CurseForge Minecraft（gameId 432）分类 classId。数值为 CurseForge 侧固定常量。
    pub fn curseforge_class_id(self) -> u32 {
        match self {
            ResourceType::Mod => 6,
            ResourceType::Modpack => 4471,
            ResourceType::ResourcePack => 12,
            ResourceType::Shader => 6552,
            ResourceType::DataPack => 6945,
            ResourceType::Plugin => 5,
        }
    }

    /// 由 Modrinth `project_type` 字符串还原资源类型；未知值回落到 [`ResourceType::Mod`]。
    pub fn from_modrinth_project_type(value: &str) -> Self {
        match value {
            "modpack" => ResourceType::Modpack,
            "resourcepack" => ResourceType::ResourcePack,
            "shader" => ResourceType::Shader,
            "datapack" => ResourceType::DataPack,
            "plugin" => ResourceType::Plugin,
            _ => ResourceType::Mod,
        }
    }

    /// 由 CurseForge classId 还原资源类型；未知/缺失回落到 [`ResourceType::Mod`]。
    pub fn from_curseforge_class_id(class_id: Option<u32>) -> Self {
        match class_id {
            Some(4471) => ResourceType::Modpack,
            Some(12) => ResourceType::ResourcePack,
            Some(6552) => ResourceType::Shader,
            Some(6945) => ResourceType::DataPack,
            Some(5) => ResourceType::Plugin,
            _ => ResourceType::Mod,
        }
    }
}

/// Mod 加载器。
///
/// 序列化名与 IPC 入参、Modrinth facet 用同一套小写连写名（neoforge / liteloader）：snake_case
/// 默认会把 NeoForge 写成 neo_forge，前端拿出参原样回传搜索或安装时就会被拒。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModLoader {
    /// Fabric。
    Fabric,
    /// Quilt。
    Quilt,
    /// Forge。
    Forge,
    /// NeoForge。
    #[serde(rename = "neoforge")]
    NeoForge,
    /// LiteLoader（远古加载器）。
    #[serde(rename = "liteloader")]
    LiteLoader,
}

impl ModLoader {
    /// Modrinth 搜索里加载器归入 `categories` facet（见搜索文档 "loaders are lumped in with
    /// categories"），此处返回该 facet 取值。
    pub fn modrinth_facet(self) -> &'static str {
        match self {
            ModLoader::Fabric => "fabric",
            ModLoader::Quilt => "quilt",
            ModLoader::Forge => "forge",
            ModLoader::NeoForge => "neoforge",
            ModLoader::LiteLoader => "liteloader",
        }
    }

    /// CurseForge `modLoaderType` 数值编码（0 Any / 1 Forge / 3 LiteLoader / 4 Fabric / 5 Quilt / 6 NeoForge）。
    pub fn curseforge_loader_type(self) -> u8 {
        match self {
            ModLoader::Forge => 1,
            ModLoader::LiteLoader => 3,
            ModLoader::Fabric => 4,
            ModLoader::Quilt => 5,
            ModLoader::NeoForge => 6,
        }
    }
}

/// 搜索排序字段。各平台以不同编码表达，映射集中在方法里。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SortField {
    /// 相关度（默认）。
    #[default]
    Relevance,
    /// 下载量。
    Downloads,
    /// 关注数。
    Follows,
    /// 最新发布。
    Newest,
    /// 最近更新。
    Updated,
}

impl SortField {
    /// Modrinth `index` 取值。
    pub fn modrinth_index(self) -> &'static str {
        match self {
            SortField::Relevance => "relevance",
            SortField::Downloads => "downloads",
            SortField::Follows => "follows",
            SortField::Newest => "newest",
            SortField::Updated => "updated",
        }
    }

    /// CurseForge `sortField` 数值编码。CurseForge 无「相关度/关注」概念，就近映射到 Popularity；
    /// 「最新发布」映射到 ReleasedDate，「最近更新」映射到 LastUpdated。
    pub fn curseforge_sort_field(self) -> u8 {
        match self {
            SortField::Relevance | SortField::Follows => 2, // Popularity
            SortField::Downloads => 6,                      // TotalDownloads
            SortField::Newest => 11,                        // ReleasedDate
            SortField::Updated => 3,                        // LastUpdated
        }
    }
}

/// 依赖关系类型（统一模型）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DependencyKind {
    /// 必需前置。
    Required,
    /// 可选前置。
    Optional,
    /// 不兼容。
    Incompatible,
    /// 内嵌（已打包在内，无需单独安装）。
    Embedded,
    /// 工具类关联（CurseForge 专有）。
    Tool,
}

impl DependencyKind {
    /// 由 Modrinth `dependency_type` 字符串解析；未知值返回 `None`。
    pub fn from_modrinth(value: &str) -> Option<Self> {
        match value {
            "required" => Some(DependencyKind::Required),
            "optional" => Some(DependencyKind::Optional),
            "incompatible" => Some(DependencyKind::Incompatible),
            "embedded" => Some(DependencyKind::Embedded),
            _ => None,
        }
    }

    /// 由 CurseForge `relationType` 数值解析（1 内嵌库 / 2 可选 / 3 必需 / 4 工具 / 5 不兼容 / 6 包含）；
    /// 未知值返回 `None`。
    pub fn from_curseforge(relation_type: u8) -> Option<Self> {
        match relation_type {
            1 | 6 => Some(DependencyKind::Embedded),
            2 => Some(DependencyKind::Optional),
            3 => Some(DependencyKind::Required),
            4 => Some(DependencyKind::Tool),
            5 => Some(DependencyKind::Incompatible),
            _ => None,
        }
    }
}

/// 统一搜索查询。同一份查询会被两个平台各自翻译成其原生参数。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchQuery {
    /// 关键词。`None` 表示不带关键词（按排序浏览）。
    pub query: Option<String>,
    /// 资源类型。
    pub resource_type: ResourceType,
    /// 目标加载器过滤。多个之间为「或」；CurseForge 单次仅支持一个加载器，取列表首个。
    pub loaders: Vec<ModLoader>,
    /// 目标游戏版本过滤。多个之间为「或」；CurseForge 单次仅支持一个版本，取列表首个。
    pub game_versions: Vec<String>,
    /// 排序字段。
    pub sort: SortField,
    /// 每页条数。
    pub limit: u32,
    /// 结果偏移（分页游标）。
    pub offset: u32,
}

impl Default for SearchQuery {
    fn default() -> Self {
        Self {
            query: None,
            resource_type: ResourceType::Mod,
            loaders: Vec::new(),
            game_versions: Vec::new(),
            sort: SortField::Relevance,
            limit: 20,
            offset: 0,
        }
    }
}

impl SearchQuery {
    /// 便捷构造：仅带关键词，其余取默认。
    pub fn new(query: impl Into<String>) -> Self {
        Self {
            query: Some(query.into()),
            ..Self::default()
        }
    }

    /// 链式设置资源类型。
    pub fn with_resource_type(mut self, resource_type: ResourceType) -> Self {
        self.resource_type = resource_type;
        self
    }

    /// 链式追加一个加载器过滤。
    pub fn with_loader(mut self, loader: ModLoader) -> Self {
        self.loaders.push(loader);
        self
    }

    /// 链式追加一个游戏版本过滤。
    pub fn with_game_version(mut self, version: impl Into<String>) -> Self {
        self.game_versions.push(version.into());
        self
    }

    /// 链式设置排序字段。
    pub fn with_sort(mut self, sort: SortField) -> Self {
        self.sort = sort;
        self
    }

    /// 链式设置分页。
    pub fn with_paging(mut self, limit: u32, offset: u32) -> Self {
        self.limit = limit;
        self.offset = offset;
        self
    }
}

/// 聚合搜索的统一命中模型。两个平台的搜索结果都归一到这里，供 UI 一致渲染。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SearchHit {
    /// 来源平台。
    pub platform: Platform,
    /// 平台内工程标识（Modrinth 为 project_id，CurseForge 为数字 mod id 的字符串形式）。
    pub project_id: String,
    /// 工程 slug（URL 短名），用于跨平台去重匹配。
    pub slug: Option<String>,
    /// 标题/名称。
    pub title: String,
    /// 简介。
    pub description: String,
    /// 作者名（取主要作者）。
    pub author: Option<String>,
    /// 下载量。
    pub downloads: u64,
    /// 关注数（CurseForge 无此概念，为 `None`）。
    pub follows: Option<u64>,
    /// 图标 URL。
    pub icon_url: Option<String>,
    /// 分类标签。
    pub categories: Vec<String>,
    /// 资源类型。
    pub resource_type: ResourceType,
    /// 最近更新时间（ISO-8601 原样字符串）。
    pub date_modified: Option<String>,
    /// 工程详情页 URL（若可得）。
    pub page_url: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_type_maps_both_platforms() {
        assert_eq!(ResourceType::Mod.modrinth_project_type(), "mod");
        assert_eq!(ResourceType::Mod.curseforge_class_id(), 6);
        assert_eq!(ResourceType::Shader.modrinth_project_type(), "shader");
        assert_eq!(ResourceType::Shader.curseforge_class_id(), 6552);
        assert_eq!(ResourceType::DataPack.curseforge_class_id(), 6945);
        assert_eq!(ResourceType::Plugin.curseforge_class_id(), 5);
    }

    #[test]
    fn resource_type_roundtrip_from_platform_codes() {
        assert_eq!(
            ResourceType::from_modrinth_project_type("resourcepack"),
            ResourceType::ResourcePack
        );
        assert_eq!(
            ResourceType::from_modrinth_project_type("不认识"),
            ResourceType::Mod
        );
        assert_eq!(
            ResourceType::from_curseforge_class_id(Some(6552)),
            ResourceType::Shader
        );
        assert_eq!(
            ResourceType::from_curseforge_class_id(None),
            ResourceType::Mod
        );
    }

    #[test]
    fn loader_maps_both_platforms() {
        assert_eq!(ModLoader::Fabric.modrinth_facet(), "fabric");
        assert_eq!(ModLoader::Fabric.curseforge_loader_type(), 4);
        assert_eq!(ModLoader::NeoForge.modrinth_facet(), "neoforge");
        assert_eq!(ModLoader::NeoForge.curseforge_loader_type(), 6);
        assert_eq!(ModLoader::Forge.curseforge_loader_type(), 1);
        assert_eq!(ModLoader::Quilt.curseforge_loader_type(), 5);
    }

    #[test]
    fn loader_serde_names_match_modrinth_facets() {
        for (loader, name) in [
            (ModLoader::Fabric, "fabric"),
            (ModLoader::Quilt, "quilt"),
            (ModLoader::Forge, "forge"),
            (ModLoader::NeoForge, "neoforge"),
            (ModLoader::LiteLoader, "liteloader"),
        ] {
            assert_eq!(serde_json::to_value(loader).unwrap(), name);
            assert_eq!(loader.modrinth_facet(), name);
            assert_eq!(
                serde_json::from_value::<ModLoader>(serde_json::json!(name)).unwrap(),
                loader
            );
        }
        assert!(serde_json::from_value::<ModLoader>(serde_json::json!("neo_forge")).is_err());
    }

    #[test]
    fn sort_field_maps_both_platforms() {
        assert_eq!(SortField::Downloads.modrinth_index(), "downloads");
        assert_eq!(SortField::Downloads.curseforge_sort_field(), 6);
        assert_eq!(SortField::Updated.modrinth_index(), "updated");
        assert_eq!(SortField::Updated.curseforge_sort_field(), 3);
        assert_eq!(SortField::Relevance.curseforge_sort_field(), 2);
    }

    #[test]
    fn dependency_kind_parses_both_platforms() {
        assert_eq!(
            DependencyKind::from_modrinth("required"),
            Some(DependencyKind::Required)
        );
        assert_eq!(DependencyKind::from_modrinth("weird"), None);
        assert_eq!(
            DependencyKind::from_curseforge(3),
            Some(DependencyKind::Required)
        );
        assert_eq!(
            DependencyKind::from_curseforge(6),
            Some(DependencyKind::Embedded)
        );
        assert_eq!(DependencyKind::from_curseforge(99), None);
    }

    #[test]
    fn search_query_builder_accumulates_filters() {
        let q = SearchQuery::new("sodium")
            .with_resource_type(ResourceType::Mod)
            .with_loader(ModLoader::Fabric)
            .with_game_version("1.20.1")
            .with_sort(SortField::Downloads)
            .with_paging(50, 100);
        assert_eq!(q.query.as_deref(), Some("sodium"));
        assert_eq!(q.loaders, vec![ModLoader::Fabric]);
        assert_eq!(q.game_versions, vec!["1.20.1".to_string()]);
        assert_eq!(q.sort, SortField::Downloads);
        assert_eq!(q.limit, 50);
        assert_eq!(q.offset, 100);
    }
}
