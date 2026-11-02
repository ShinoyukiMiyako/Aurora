//! 允许经材质协议读取的原版文件，逐项列出。
//!
//! 界面里原版材质只出现在四个点缀位（实例方块、玩家皮肤、远程缩略图、标题全景），服务端只暴露
//! 这四类要用到的文件；其余一切（别的方块、物品、粒子、GUI 精灵）一律拒绝。名单逐项写死而不用宽泛
//! 的路径规则：规则写宽一点就等于开了任意读取的口子，而这里要的恰恰是「只能读这几张」。
//!
//! 前端 `ipc/art.ts` 有同一份名单（取 URL 前先校验），两边由一致性测试钉住。

/// 实例封面可选的方块：16 种侧面 + 草方块的顶面。
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

/// 名单内的路径（不含 `.png`）对应的类别；名单外为 None。比较是逐字节全等，不做任何规范化。
pub fn art_kind(path: &str) -> Option<ArtKind> {
    if BLOCK_TEXTURES.contains(&path) {
        Some(ArtKind::Block)
    } else if SKIN_TEXTURES.contains(&path) {
        Some(ArtKind::Skin)
    } else {
        None
    }
}

/// 名单内的全部路径，抽取时按这个顺序处理。
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
    fn only_listed_paths_are_accepted() {
        assert_eq!(art_kind("block/cherry_planks"), Some(ArtKind::Block));
        assert_eq!(art_kind("block/grass_block_top"), Some(ArtKind::Block));
        assert_eq!(art_kind("entity/player/slim/zuri"), Some(ArtKind::Skin));
        assert_eq!(art_kind("entity/alex"), Some(ArtKind::Skin));
        for rejected in [
            "block/dirt",
            "block/stone",
            "block/../x",
            "block/cherry_planks.png",
            "BLOCK/cherry_planks",
            "item/apple",
            "particle/cherry_0",
            "gui/widgets",
            "",
        ] {
            assert_eq!(art_kind(rejected), None, "{rejected} 不应在名单内");
        }
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
