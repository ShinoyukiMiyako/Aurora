//! 允许经材质协议读取的原版文件。
//!
//! 界面里原版材质只出现在几个点缀位：实例方块与卡面的材质平铺、玩家皮肤、远程缩略图、标题全景。
//! 实例方块除了预设的 16 种，也可以是本机材质源里任意一种完整立方体方块，所以方块面按形状放行：
//! `block/` 下单层、只含小写字母数字与下划线的名字；某张图到底有没有，由材质缓存的清单决定，缓存里
//! 只有方块目录引用到的面与预设名单。皮肤仍逐项写死。其余一切（物品、粒子、GUI 精灵、子目录里的
//! 文件）一律拒绝：请求只能落在缓存里抽好的这几类文件上，碰不到游戏目录与 jar 里的别的东西。
//!
//! 前端 `ipc/art.ts` 有同一份预设名单与皮肤名单（取 URL 前先校验），两边由一致性测试钉住。

/// 预设封面方块的面：16 种侧面 + 草方块的顶面。不论方块目录推出什么，抽取时这些都必抽。
pub const BLOCK_TEXTURES: [&str; 17] = [
    "block/cherry_planks",
    "block/cherry_leaves",
    "block/grass_block_side",
    "block/grass_block_top",
    "block/moss_block",
    "block/honeycomb_block",
    "block/amethyst_block",
    "block/copper_block",
    "block/prismarine_bricks",
    "block/deepslate_tiles",
    "block/purpur_block",
    "block/mossy_cobblestone",
    "block/red_wool",
    "block/blue_ice",
    "block/oxidized_copper",
    "block/netherrack",
    "block/end_stone_bricks",
];

/// 原版默认皮肤：1.19.3 起的 9 款 × 宽臂 / 细臂两种模型，加上更早版本只有的两张。
pub const SKIN_TEXTURES: [&str; 20] = [
    "entity/player/wide/alex",
    "entity/player/wide/ari",
    "entity/player/wide/efe",
    "entity/player/wide/kai",
    "entity/player/wide/makena",
    "entity/player/wide/noor",
    "entity/player/wide/steve",
    "entity/player/wide/sunny",
    "entity/player/wide/zuri",
    "entity/player/slim/alex",
    "entity/player/slim/ari",
    "entity/player/slim/efe",
    "entity/player/slim/kai",
    "entity/player/slim/makena",
    "entity/player/slim/noor",
    "entity/player/slim/steve",
    "entity/player/slim/sunny",
    "entity/player/slim/zuri",
    "entity/steve",
    "entity/alex",
];

/// 1.20 材质集的标志文件：材质源里有它，封面名单就全部可用。
pub const FULL_SET_MARKER: &str = "block/cherry_planks";

/// 降级材质源的标志文件：1.13 扁平化之后的方块路径。
pub const DEGRADED_SET_MARKER: &str = "block/stone";

/// 一个允许读取的原版文件属于哪一类，决定抽取时的校验方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtKind {
    Block,
    Skin,
}

/// 路径（不含 `.png`）对应的类别：方块面按形状认，皮肤按名单认；都不是为 None。不做任何规范化。
pub fn art_kind(path: &str) -> Option<ArtKind> {
    if is_block_texture(path) {
        Some(ArtKind::Block)
    } else if SKIN_TEXTURES.contains(&path) {
        Some(ArtKind::Skin)
    } else {
        None
    }
}

/// 方块面的路径形状：`block/<方块名>`，方块名见 [`is_block_name`]。
pub fn is_block_texture(path: &str) -> bool {
    path.strip_prefix("block/").is_some_and(is_block_name)
}

/// 方块名（方块 id 或材质文件名）：1 到 64 个小写字母、数字或下划线。与前端校验目录的规则一致。
pub fn is_block_name(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// 预设必抽的全部路径（预设方块面 + 默认皮肤）。
pub fn all_art_paths() -> impl Iterator<Item = (&'static str, ArtKind)> {
    BLOCK_TEXTURES
        .iter()
        .map(|p| (*p, ArtKind::Block))
        .chain(SKIN_TEXTURES.iter().map(|p| (*p, ArtKind::Skin)))
}

/// 材质在客户端 jar 里的条目名。
pub fn jar_entry(path: &str) -> String {
    format!("assets/minecraft/textures/{path}.png")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn block_faces_are_accepted_by_shape_and_skins_by_list() {
        assert_eq!(art_kind("block/cherry_planks"), Some(ArtKind::Block));
        assert_eq!(art_kind("block/grass_block_top"), Some(ArtKind::Block));
        // 预设名单外的方块面也按形状放行，有没有由缓存清单决定。
        assert_eq!(art_kind("block/dirt"), Some(ArtKind::Block));
        assert_eq!(art_kind("block/oak_log_top"), Some(ArtKind::Block));
        assert_eq!(art_kind("block/a"), Some(ArtKind::Block));
        let longest = format!("block/{}", "a".repeat(64));
        assert_eq!(art_kind(&longest), Some(ArtKind::Block));
        assert_eq!(art_kind("entity/player/slim/zuri"), Some(ArtKind::Skin));
        assert_eq!(art_kind("entity/alex"), Some(ArtKind::Skin));
        let too_long = format!("block/{}", "a".repeat(65));
        for rejected in [
            "block/",
            too_long.as_str(),
            "block/../x",
            "block/cherry_planks.png",
            "block/Cherry_planks",
            "block/oak-log",
            "block/sub/dir",
            "block/ oak",
            "BLOCK/cherry_planks",
            "blocks/dirt",
            "item/apple",
            "particle/cherry_0",
            "gui/widgets",
            "entity/player/wide/herobrine",
            "entity/pig/pig",
            "",
        ] {
            assert_eq!(art_kind(rejected), None, "{rejected} 不应放行");
        }
    }

    #[test]
    fn block_names_follow_the_frontend_rule() {
        assert!(is_block_name("oak_log"));
        assert!(is_block_name("0"));
        assert!(!is_block_name(""));
        assert!(!is_block_name(&"x".repeat(65)));
        assert!(!is_block_name("oak.log"));
        assert!(!is_block_name("Oak"));
    }

    #[test]
    fn whitelist_has_no_duplicates_and_expected_size() {
        let all: Vec<_> = all_art_paths().map(|(p, _)| p).collect();
        let mut unique = all.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(all.len(), 37);
        assert_eq!(unique.len(), all.len());
        assert_eq!(
            jar_entry("block/cherry_planks"),
            "assets/minecraft/textures/block/cherry_planks.png"
        );
    }
}
