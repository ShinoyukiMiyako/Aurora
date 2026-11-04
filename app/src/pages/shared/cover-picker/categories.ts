// 方块选择框的分页、页内排序与搜索。原版创造模式物品栏的分类写在游戏代码里、不在 jar 里，材质源只给得出
// 方块 id，所以按 id 的规则分页：先认彩色，再认功能（另看有没有正面），再认自然，其余都进建筑。
// 新版本加的方块按同一套规则落页，不需要逐个登记。
//
// 页内排序：
// - 彩色：按材质族（羊毛、陶瓦、混凝土、混凝土粉末、带釉陶瓦、染色玻璃）分段，族内不染色的本色方块在前，
//   其后按原版彩色方块页的 16 色顺序。
// - 自然、功能：按规则表的先后；同一条规则命中多块时（树叶、矿石、珊瑚块）按材质族、再按加工层数。
//   功能页里只因有正面才进来的方块排在规则表之后。
// - 建筑：同一材质族放一起（磨制、錾制、裂纹、砖、瓦、去皮、木板等都算本体的加工变体），
//   族按原版建筑页的先后（木材、石材、矿物块），不认识的族排在后面、按族名字母序。
// 族内一律：先本体与普通变体，涂蜡与虫蚀这类外观相同的复制品在后；铜按氧化程度；再按加工层数，最后按 id。

import type { CatalogBlock } from "../../../art/iso/catalog";

export type BlockCategory = "building" | "colored" | "natural" | "functional";

/** 分页顺序，也是搜索结果的排列顺序。 */
export const BLOCK_CATEGORIES: readonly BlockCategory[] = ["building", "colored", "natural", "functional"];

/** 原版彩色方块页的 16 色顺序：先白、灰、黑、棕，再沿色环从红到粉。 */
export const DYE_COLORS = [
  "white",
  "light_gray",
  "gray",
  "black",
  "brown",
  "red",
  "orange",
  "yellow",
  "lime",
  "green",
  "cyan",
  "light_blue",
  "blue",
  "purple",
  "magenta",
  "pink",
] as const;

/** 彩色页的材质族，按原版彩色方块页的先后。 */
const COLORED_FAMILIES = ["wool", "terracotta", "concrete", "concrete_powder", "glazed_terracotta", "stained_glass"] as const;
type ColoredFamily = (typeof COLORED_FAMILIES)[number];

/** 不染色的本色方块，排在它那一族的 16 色之前。 */
const UNDYED: Readonly<Record<string, ColoredFamily>> = { terracotta: "terracotta", glass: "stained_glass" };

const DYED = new RegExp(`^(${DYE_COLORS.join("|")})_(${COLORED_FAMILIES.join("|")})$`);

type Rule = string | RegExp;

/**
 * 功能页：工作方块、容器、红石元件与几种技术方块。另外凡是有正面（熔炉、发射器这类有朝向）的方块也进功能页，
 * 排在这张表之后。
 */
const FUNCTIONAL_RULES: readonly Rule[] = [
  "crafting_table",
  "crafter",
  "furnace",
  "smoker",
  "blast_furnace",
  "loom",
  "cartography_table",
  "fletching_table",
  "smithing_table",
  "barrel",
  "bookshelf",
  "chiseled_bookshelf",
  "jukebox",
  "note_block",
  "beehive",
  "bee_nest",
  "lodestone",
  "respawn_anchor",
  "dispenser",
  "dropper",
  "observer",
  "piston",
  "sticky_piston",
  "target",
  "tnt",
  "redstone_lamp",
  "redstone_block",
  /(^|_)copper_bulb$/,
  "slime_block",
  "honey_block",
  "command_block",
  "chain_command_block",
  "repeating_command_block",
  "structure_block",
  "jigsaw",
];

/**
 * 自然页：地表、矿石、植物、冰雪、下界与末地的天然方块。有加工变体的石材（石头、深板岩、凝灰岩等）整族留在建筑页，
 * 免得一族被拆到两页；下界与末地的天然方块（下界岩、玄武岩、黑石、末地石）按天然形态归这里，加工后的进建筑。
 */
const NATURAL_RULES: readonly Rule[] = [
  "grass_block",
  "podzol",
  "mycelium",
  "dirt",
  "coarse_dirt",
  "rooted_dirt",
  "mud",
  "muddy_mangrove_roots",
  "clay",
  "gravel",
  "suspicious_gravel",
  "sand",
  "suspicious_sand",
  "red_sand",
  "ice",
  "packed_ice",
  "blue_ice",
  "snow_block",
  "powder_snow",
  "moss_block",
  "pale_moss_block",
  "calcite",
  "dripstone_block",
  "budding_amethyst",
  "amethyst_block",
  "sculk",
  "sculk_catalyst",
  /_ore$/,
  "ancient_debris",
  /^raw_[a-z_]+_block$/,
  /_leaves$/,
  "mushroom_stem",
  /_mushroom_block$/,
  "pumpkin",
  "melon",
  "hay_block",
  "dried_kelp_block",
  "sponge",
  "wet_sponge",
  "bone_block",
  /_coral_block$/,
  "netherrack",
  "crimson_nylium",
  "warped_nylium",
  "soul_sand",
  "soul_soil",
  "basalt",
  "blackstone",
  "magma_block",
  "glowstone",
  "shroomlight",
  "nether_wart_block",
  "warped_wart_block",
  /_froglight$/,
  "obsidian",
  "crying_obsidian",
  "end_stone",
  "bedrock",
];

/** 建筑页的材质族顺序，仿原版建筑页：木材、石材、矿物块。 */
const BUILDING_FAMILIES: readonly string[] = [
  "oak",
  "spruce",
  "birch",
  "jungle",
  "acacia",
  "dark_oak",
  "mangrove",
  "cherry",
  "pale_oak",
  "bamboo",
  "crimson",
  "warped",
  "stone",
  "cobblestone",
  "granite",
  "diorite",
  "andesite",
  "deepslate",
  "tuff",
  "bricks",
  "mud",
  "resin",
  "sandstone",
  "red_sandstone",
  "prismarine",
  "nether",
  "red_nether",
  "basalt",
  "blackstone",
  "end_stone",
  "purpur",
  "coal",
  "iron",
  "gold",
  "emerald",
  "lapis",
  "diamond",
  "netherite",
  "quartz",
  "copper",
];

// ---------------------------------------------------------------- 材质族与变体

/** 与本体外观相同的复制品（涂蜡的铜、虫蚀的石头）。 */
const REPLICA_PREFIXES = ["waxed_", "infested_"];
/** 铜的氧化阶段，下标 + 1 即氧化程度。 */
const OXIDATION_PREFIXES = ["exposed_", "weathered_", "oxidized_"];
/** 加工变体的前缀，每剥一个加工层数加 1。 */
const VARIANT_PREFIXES = ["stripped_", "polished_", "chiseled_", "cracked_", "cut_", "smooth_", "mossy_", "cobbled_", "gilded_", "reinforced_", "packed_", "dead_"];
/** 只在矿石上出现的前缀（深层、下界矿石）。 */
const ORE_PREFIXES = ["deepslate_", "nether_"];
/** 加工变体的后缀，每剥一个加工层数加 1。 */
const VARIANT_SUFFIXES = ["_bricks", "_tiles", "_pillar", "_planks", "_wood", "_hyphae", "_mosaic", "_grate"];
/** 只是本体命名的后缀（铁块、橡木原木、绯红菌柄、煤矿石），不算加工。 */
const BASE_SUFFIXES = ["_block", "_log", "_stem", "_ore"];
/** 名字看不出族的方块，归到原版里与它们挨着的那一族，算加工一层。 */
const FAMILY_ALIAS: Readonly<Record<string, string>> = { dark_prismarine: "prismarine", sea_lantern: "prismarine" };

export interface BlockVariant {
  /** 材质族：剥掉加工前后缀后的本体，polished_deepslate、deepslate_tiles 都是 deepslate。 */
  family: string;
  /** 涂蜡、虫蚀这类外观与本体相同的复制品。 */
  replica: boolean;
  /** 铜的氧化程度 0-3。 */
  oxidation: number;
  /** 加工层数：本体为 0，每多一道加工前缀或后缀加 1。 */
  depth: number;
}

function stripPrefix(rest: string, prefixes: readonly string[]): { rest: string; index: number } | null {
  const index = prefixes.findIndex((p) => rest.startsWith(p) && rest.length > p.length);
  return index < 0 ? null : { rest: rest.slice(prefixes[index].length), index };
}

function stripSuffix(rest: string, suffixes: readonly string[]): string | null {
  const found = suffixes.find((s) => rest.endsWith(s) && rest.length > s.length);
  return found === undefined ? null : rest.slice(0, -found.length);
}

export function blockVariant(id: string): BlockVariant {
  let rest = id;
  let replica = false;
  let oxidation = 0;
  let depth = 0;
  for (;;) {
    const r = stripPrefix(rest, REPLICA_PREFIXES);
    if (r !== null) {
      rest = r.rest;
      replica = true;
      continue;
    }
    const o = stripPrefix(rest, OXIDATION_PREFIXES);
    if (o !== null) {
      rest = o.rest;
      oxidation = o.index + 1;
      continue;
    }
    const v = stripPrefix(rest, VARIANT_PREFIXES) ?? (rest.endsWith("_ore") ? stripPrefix(rest, ORE_PREFIXES) : null);
    if (v !== null) {
      rest = v.rest;
      depth++;
      continue;
    }
    break;
  }
  for (;;) {
    const v = stripSuffix(rest, VARIANT_SUFFIXES);
    if (v !== null) {
      rest = v;
      depth++;
      continue;
    }
    const b = stripSuffix(rest, BASE_SUFFIXES);
    if (b !== null) {
      rest = b;
      continue;
    }
    break;
  }
  const alias = FAMILY_ALIAS[id];
  return alias === undefined ? { family: rest, replica, oxidation, depth } : { family: alias, replica, oxidation, depth: depth + 1 };
}

// ---------------------------------------------------------------- 分页

function ruleIndex(rules: readonly Rule[], id: string): number {
  return rules.findIndex((rule) => (typeof rule === "string" ? rule === id : rule.test(id)));
}

/** 彩色方块在彩色页的位置：[材质族序号, 颜色序号]，本色方块的颜色序号为 -1；不是彩色方块为 null。 */
function coloredRank(id: string): [number, number] | null {
  const undyed = UNDYED[id];
  if (undyed !== undefined) return [COLORED_FAMILIES.indexOf(undyed), -1];
  const m = DYED.exec(id);
  if (m === null) return null;
  return [COLORED_FAMILIES.indexOf(m[2] as ColoredFamily), DYE_COLORS.indexOf(m[1] as (typeof DYE_COLORS)[number])];
}

export function categoryOf(block: Pick<CatalogBlock, "id" | "front">): BlockCategory {
  if (coloredRank(block.id) !== null) return "colored";
  if (block.front !== null || ruleIndex(FUNCTIONAL_RULES, block.id) >= 0) return "functional";
  if (ruleIndex(NATURAL_RULES, block.id) >= 0) return "natural";
  return "building";
}

type SortKey = readonly (number | string)[];

function compareKeys(a: SortKey, b: SortKey): number {
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

function variantKey(id: string): SortKey {
  const v = blockVariant(id);
  return [v.family, v.replica ? 1 : 0, v.oxidation, v.depth, id];
}

function sortKey(category: BlockCategory, block: Pick<CatalogBlock, "id">): SortKey {
  const id = block.id;
  switch (category) {
    case "colored": {
      const rank = coloredRank(id);
      if (rank === null) throw new Error(`${id} 不是彩色方块`);
      return [...rank, id];
    }
    case "building": {
      const family = blockVariant(id).family;
      const known = BUILDING_FAMILIES.indexOf(family);
      return [known < 0 ? BUILDING_FAMILIES.length : known, ...variantKey(id)];
    }
    case "natural":
    case "functional": {
      const rules = category === "natural" ? NATURAL_RULES : FUNCTIONAL_RULES;
      const at = ruleIndex(rules, id);
      return [at < 0 ? rules.length : at, ...variantKey(id)];
    }
  }
}

export type BlockPages = Readonly<Record<BlockCategory, readonly CatalogBlock[]>>;

/** 把目录分到四页并排好序；每块方块恰好落在一页。 */
export function blockPages(blocks: readonly CatalogBlock[]): BlockPages {
  const keyed: Record<BlockCategory, { block: CatalogBlock; key: SortKey }[]> = { building: [], colored: [], natural: [], functional: [] };
  for (const block of blocks) {
    const category = categoryOf(block);
    keyed[category].push({ block, key: sortKey(category, block) });
  }
  const sorted = (category: BlockCategory) => keyed[category].sort((a, b) => compareKeys(a.key, b.key)).map((e) => e.block);
  return { building: sorted("building"), colored: sorted("colored"), natural: sorted("natural"), functional: sorted("functional") };
}

/** 四页按分页顺序首尾相接：搜索框为空时的「全部」，也是搜索结果的基准顺序。 */
export function pagesInOrder(pages: BlockPages): CatalogBlock[] {
  return BLOCK_CATEGORIES.flatMap((category) => pages[category]);
}

// ---------------------------------------------------------------- 搜索

const normalize = (text: string) => text.trim().toLocaleLowerCase().replace(/\s+/g, " ");

/**
 * 按中文名、英文名或 id 找方块：不分大小写，id 里的下划线当空格也能搜到（oak log 搜得到 oak_log）。
 * 某个名称或 id 以查询开头的排在前面，其余包含查询的在后，两段内各保持 ordered 的顺序。查询为空时原样返回。
 */
export function searchBlocks(ordered: readonly CatalogBlock[], query: string): CatalogBlock[] {
  const q = normalize(query);
  if (q === "") return [...ordered];
  const leading: CatalogBlock[] = [];
  const inner: CatalogBlock[] = [];
  for (const block of ordered) {
    const fields = [block.nameZh, block.nameEn, block.id, block.id.replace(/_/g, " ")].filter((f): f is string => f !== null).map(normalize);
    if (fields.some((f) => f.startsWith(q))) leading.push(block);
    else if (fields.some((f) => f.includes(q))) inner.push(block);
  }
  return [...leading, ...inner];
}
