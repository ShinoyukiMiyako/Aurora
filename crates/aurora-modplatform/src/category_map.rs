//! 发现页分类条件的跨平台对照：Modrinth 分类键 -> CurseForge 分类 id。
//!
//! 发现页的分类胶囊以 Modrinth 分类键为唯一输入（Modrinth 的分类是一套扁平的英文键，CurseForge
//! 则是按 class 分树的数字 id），这里给每个「资源类型 + 分类键」一行，值为对应的 CurseForge 分类 id，
//! 没有同义分类时显式写 `None`。值为 `None` 的组合在搜索时不发往 CurseForge，结果只来自 Modrinth。
//!
//! 取值依据 CurseForge `GET /v1/categories?gameId=432` 的真实响应（存为测试夹具，测试逐行核对 id、
//! 所属 class 与 slug）。只收语义相同的分类：CurseForge 有而意思只是接近的（如资源包的
//! Traditional、Mod 的 Cosmetic）一律不对，宁可只搜 Modrinth，也不把用户带去不相干的结果。

use crate::model::ResourceType;

/// 对照表的一行。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CategoryRow {
    /// 资源类型。
    pub resource_type: ResourceType,
    /// Modrinth 分类键。
    pub modrinth_key: &'static str,
    /// 对应的 CurseForge 分类：`(分类 id, 分类 slug)`；没有同义分类为 `None`。slug 只用于核对夹具。
    pub curseforge: Option<(u32, &'static str)>,
}

const fn row(
    resource_type: ResourceType,
    modrinth_key: &'static str,
    curseforge: Option<(u32, &'static str)>,
) -> CategoryRow {
    CategoryRow {
        resource_type,
        modrinth_key,
        curseforge,
    }
}

/// 全表。「全部」类型没有独立的行：它按所含各类型分别查表，见 [`curseforge_categories`]。
pub const CATEGORY_TABLE: &[CategoryRow] = &[
    // Mod（CurseForge classId 6）。
    row(
        ResourceType::Mod,
        "optimization",
        Some((6814, "performance")),
    ),
    row(ResourceType::Mod, "technology", Some((412, "technology"))),
    row(ResourceType::Mod, "magic", Some((419, "magic"))),
    row(ResourceType::Mod, "adventure", Some((422, "adventure-rpg"))),
    // CurseForge 的 Mod 没有「装饰方块」类；Cosmetic 指玩家外观，不是一回事。
    row(ResourceType::Mod, "decoration", None),
    row(ResourceType::Mod, "utility", Some((5191, "utility-qol"))),
    row(ResourceType::Mod, "worldgen", Some((406, "world-gen"))),
    // 数据包（classId 6945）。Modrinth 的数据包沿用 Mod 的分类键。
    row(ResourceType::DataPack, "optimization", None),
    row(ResourceType::DataPack, "technology", Some((6951, "tech"))),
    row(ResourceType::DataPack, "magic", Some((6952, "magic"))),
    row(
        ResourceType::DataPack,
        "adventure",
        Some((6948, "adventure")),
    ),
    row(ResourceType::DataPack, "decoration", None),
    row(ResourceType::DataPack, "utility", Some((6953, "utility"))),
    row(ResourceType::DataPack, "worldgen", None),
    // 整合包（classId 4471）。
    row(
        ResourceType::Modpack,
        "adventure",
        Some((4475, "adventure-and-rpg")),
    ),
    row(ResourceType::Modpack, "technology", Some((4472, "tech"))),
    row(ResourceType::Modpack, "magic", Some((4473, "magic"))),
    row(
        ResourceType::Modpack,
        "lightweight",
        Some((4481, "small-light")),
    ),
    row(ResourceType::Modpack, "quests", Some((4478, "quests"))),
    row(
        ResourceType::Modpack,
        "multiplayer",
        Some((4484, "multiplayer")),
    ),
    // CurseForge 整合包没有「优化」类；Vanilla+ 是玩法取向，不等于性能优化。
    row(ResourceType::Modpack, "optimization", None),
    // 资源包（classId 12）。CurseForge 资源包按分辨率与题材分，风格类大多无对应。
    row(ResourceType::ResourcePack, "vanilla-like", None),
    row(ResourceType::ResourcePack, "simplistic", None),
    row(
        ResourceType::ResourcePack,
        "realistic",
        Some((400, "photo-realistic")),
    ),
    row(ResourceType::ResourcePack, "themed", None),
    row(ResourceType::ResourcePack, "gui", None),
    row(
        ResourceType::ResourcePack,
        "fonts",
        Some((5244, "font-packs")),
    ),
    row(ResourceType::ResourcePack, "audio", None),
    // 光影（classId 6552）。CurseForge 光影只有三类。
    row(
        ResourceType::Shader,
        "vanilla-like",
        Some((6555, "vanilla")),
    ),
    row(ResourceType::Shader, "realistic", Some((6553, "realistic"))),
    row(ResourceType::Shader, "semi-realistic", None),
    row(ResourceType::Shader, "cartoon", None),
    row(ResourceType::Shader, "fantasy", Some((6554, "fantasy"))),
    row(ResourceType::Shader, "potato", None),
    row(ResourceType::Shader, "screenshot", None),
];

/// 查某类型下某分类键的那一行；表里没有这一行返回 `None`（与「有行但值为 None」不同）。
pub fn lookup(resource_type: ResourceType, modrinth_key: &str) -> Option<&'static CategoryRow> {
    CATEGORY_TABLE
        .iter()
        .find(|r| r.resource_type == resource_type && r.modrinth_key == modrinth_key)
}

/// 一组类型下某分类键对应的全部 CurseForge 分类 id（按类型顺序、去重）。
///
/// 多类型（含「全部」）搜索时 CurseForge 侧用这组 id 一起过滤：每个 id 只属于一个 class，
/// 合起来恰好覆盖「这些类型里有同义分类的那部分」。返回空表示该次搜索不发往 CurseForge。
pub fn curseforge_categories(types: &[ResourceType], modrinth_key: &str) -> Vec<u32> {
    let mut ids = Vec::new();
    for t in types {
        if let Some((id, _)) = lookup(*t, modrinth_key).and_then(|r| r.curseforge)
            && !ids.contains(&id)
        {
            ids.push(id);
        }
    }
    ids
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// 发现页每种类型固定展示的分类键。「全部」用 Mod 的一组。
    const SPEC_KEYS: &[(ResourceType, [&str; 7])] = &[
        (
            ResourceType::Mod,
            [
                "optimization",
                "technology",
                "magic",
                "adventure",
                "decoration",
                "utility",
                "worldgen",
            ],
        ),
        (
            ResourceType::DataPack,
            [
                "optimization",
                "technology",
                "magic",
                "adventure",
                "decoration",
                "utility",
                "worldgen",
            ],
        ),
        (
            ResourceType::Modpack,
            [
                "adventure",
                "technology",
                "magic",
                "lightweight",
                "quests",
                "multiplayer",
                "optimization",
            ],
        ),
        (
            ResourceType::ResourcePack,
            [
                "vanilla-like",
                "simplistic",
                "realistic",
                "themed",
                "gui",
                "fonts",
                "audio",
            ],
        ),
        (
            ResourceType::Shader,
            [
                "vanilla-like",
                "realistic",
                "semi-realistic",
                "cartoon",
                "fantasy",
                "potato",
                "screenshot",
            ],
        ),
    ];

    fn curseforge_fixture() -> Vec<serde_json::Value> {
        let raw = include_str!("../tests/fixtures/curseforge-categories-432.json");
        let doc: serde_json::Value = serde_json::from_str(raw).unwrap();
        doc["data"].as_array().unwrap().clone()
    }

    #[test]
    fn every_spec_key_has_exactly_one_row() {
        for (resource_type, keys) in SPEC_KEYS {
            for key in keys {
                let rows = CATEGORY_TABLE
                    .iter()
                    .filter(|r| r.resource_type == *resource_type && r.modrinth_key == *key)
                    .count();
                assert_eq!(rows, 1, "{resource_type:?} / {key} 应恰有一行");
            }
        }
        // 表里也不能多出发现页不展示的键：多余的行没人测，迟早与平台脱节。
        let spec_total: usize = SPEC_KEYS.iter().map(|(_, keys)| keys.len()).sum();
        assert_eq!(CATEGORY_TABLE.len(), spec_total);
    }

    #[test]
    fn mapped_ids_exist_in_the_real_response_under_the_right_class() {
        let categories = curseforge_fixture();
        let mut mapped = 0;
        for r in CATEGORY_TABLE {
            let Some((id, slug)) = r.curseforge else {
                continue;
            };
            mapped += 1;
            let entry = categories
                .iter()
                .find(|c| c["id"] == serde_json::json!(id))
                .unwrap_or_else(|| {
                    panic!(
                        "夹具里没有分类 id {id}（{:?} / {}）",
                        r.resource_type, r.modrinth_key
                    )
                });
            assert_eq!(
                entry["classId"],
                serde_json::json!(r.resource_type.curseforge_class_id()),
                "分类 {id} 不属于 {:?} 的 class",
                r.resource_type
            );
            assert_eq!(entry["slug"], serde_json::json!(slug), "分类 {id} 的 slug");
        }
        assert_eq!(mapped, 21, "已对上的分类数变了，核对表与夹具");
    }

    #[test]
    fn keys_exist_in_modrinth_tag_list() {
        let raw = include_str!("../tests/fixtures/modrinth-tag-category.json");
        let tags: Vec<serde_json::Value> = serde_json::from_str(raw).unwrap();
        let known: HashSet<(String, String)> = tags
            .iter()
            .map(|t| {
                (
                    t["project_type"].as_str().unwrap().to_owned(),
                    t["name"].as_str().unwrap().to_owned(),
                )
            })
            .collect();
        for r in CATEGORY_TABLE {
            // Modrinth 的数据包工程在标签表里归在 mod 名下。
            let project_type = match r.resource_type {
                ResourceType::DataPack => "mod",
                other => other.modrinth_project_type(),
            };
            assert!(
                known.contains(&(project_type.to_owned(), r.modrinth_key.to_owned())),
                "Modrinth 标签表里没有 {project_type} / {}",
                r.modrinth_key
            );
        }
    }

    #[test]
    fn lookup_distinguishes_missing_row_from_unmapped_row() {
        assert_eq!(
            lookup(ResourceType::Mod, "optimization").and_then(|r| r.curseforge),
            Some((6814, "performance"))
        );
        let unmapped = lookup(ResourceType::Shader, "potato").expect("potato 有行");
        assert_eq!(unmapped.curseforge, None);
        assert!(lookup(ResourceType::Shader, "technology").is_none());
        assert!(lookup(ResourceType::Mod, "no-such-key").is_none());
    }

    #[test]
    fn multi_type_lookup_unions_ids_per_class() {
        let all = ResourceType::DISCOVERABLE;
        // technology：Mod 412、整合包 4472、数据包 6951；资源包与光影没有这一行。
        assert_eq!(
            curseforge_categories(&all, "technology"),
            vec![412, 4472, 6951]
        );
        // optimization 只有 Mod 对得上。
        assert_eq!(curseforge_categories(&all, "optimization"), vec![6814]);
        // decoration 哪个类型都对不上：该次搜索不发往 CurseForge。
        assert!(curseforge_categories(&all, "decoration").is_empty());
        assert_eq!(
            curseforge_categories(&[ResourceType::Shader], "vanilla-like"),
            vec![6555]
        );
        assert!(curseforge_categories(&[], "magic").is_empty());
    }
}
