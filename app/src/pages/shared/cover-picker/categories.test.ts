import { describe, expect, it } from "vitest";
import type { CatalogBlock } from "../../../art/iso/catalog";
import { blockPages, blockVariant, categoryOf, DYE_COLORS, pagesInOrder, searchBlocks, type BlockCategory } from "./categories";

function block(id: string, names: [string, string] | null = null, front: string | null = null): CatalogBlock {
  return {
    id,
    top: `block/${id}`,
    side: `block/${id}`,
    front,
    topTint: null,
    sideTint: null,
    hue: 0,
    nameEn: names === null ? null : names[0],
    nameZh: names === null ? null : names[1],
  };
}

/** 固定种子的洗牌：排序结果不能依赖输入顺序。 */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const ids = (blocks: readonly CatalogBlock[]) => blocks.map((b) => b.id);

function pageOf(category: BlockCategory, list: readonly string[], seed: number, fronts: readonly string[] = []): string[] {
  const blocks = shuffled(list, seed).map((id) => block(id, null, fronts.includes(id) ? `block/${id}_front` : null));
  return ids(blockPages(blocks)[category]);
}

describe("分页", () => {
  it.each([
    ["white_wool", "colored"],
    ["light_gray_glazed_terracotta", "colored"],
    ["black_concrete_powder", "colored"],
    ["pink_stained_glass", "colored"],
    ["terracotta", "colored"],
    ["glass", "colored"],
    ["tinted_glass", "building"],
    ["grass_block", "natural"],
    ["deepslate_diamond_ore", "natural"],
    ["nether_quartz_ore", "natural"],
    ["ancient_debris", "natural"],
    ["raw_copper_block", "natural"],
    ["cherry_leaves", "natural"],
    ["dead_tube_coral_block", "natural"],
    ["red_mushroom_block", "natural"],
    ["ochre_froglight", "natural"],
    ["budding_amethyst", "natural"],
    ["sculk", "natural"],
    ["netherrack", "natural"],
    ["end_stone", "natural"],
    ["crafting_table", "functional"],
    ["tnt", "functional"],
    ["redstone_block", "functional"],
    ["bee_nest", "functional"],
    ["waxed_exposed_copper_bulb", "functional"],
    ["stone", "building"],
    ["polished_deepslate", "building"],
    ["oak_log", "building"],
    ["end_stone_bricks", "building"],
    ["copper_block", "building"],
    ["honeycomb_block", "building"],
    ["mystery_block", "building"],
  ] as const)("%s 进%s页", (id, category) => {
    expect(categoryOf(block(id))).toBe(category);
  });

  it("有正面的方块进功能页，同一个 id 没有正面时不算功能", () => {
    expect(categoryOf(block("carved_pumpkin", null, "block/carved_pumpkin"))).toBe("functional");
    expect(categoryOf(block("carved_pumpkin"))).toBe("building");
  });

  it("彩色先于功能与自然认：染色方块即使带正面也在彩色页", () => {
    expect(categoryOf(block("magenta_glazed_terracotta", null, "block/magenta_glazed_terracotta"))).toBe("colored");
  });

  it("每块方块恰好落在一页，四页首尾相接按建筑、彩色、自然、功能", () => {
    const all = ["oak_log", "red_wool", "dirt", "furnace", "stone", "white_concrete", "iron_ore", "tnt"];
    const pages = blockPages(shuffled(all, 7).map((id) => block(id, null, id === "furnace" ? "block/furnace_front" : null)));
    expect(ids(pagesInOrder(pages))).toEqual(["oak_log", "stone", "red_wool", "white_concrete", "dirt", "iron_ore", "furnace", "tnt"]);
  });
});

describe("页内排序", () => {
  it("彩色页按族分段，族内本色在前，再按原版 16 色顺序", () => {
    const list = [
      "pink_wool",
      "white_wool",
      "red_wool",
      "gray_wool",
      "light_gray_wool",
      "white_terracotta",
      "terracotta",
      "black_concrete",
      "orange_concrete_powder",
      "white_glazed_terracotta",
      "white_stained_glass",
      "glass",
    ];
    expect(pageOf("colored", list, 3)).toEqual([
      "white_wool",
      "light_gray_wool",
      "gray_wool",
      "red_wool",
      "pink_wool",
      "terracotta",
      "white_terracotta",
      "black_concrete",
      "orange_concrete_powder",
      "white_glazed_terracotta",
      "glass",
      "white_stained_glass",
    ]);
  });

  it("16 种羊毛排成白、淡灰、灰、黑、棕、红、橙、黄、黄绿、绿、青、淡蓝、蓝、紫、品红、粉红", () => {
    const wool = DYE_COLORS.map((c) => `${c}_wool`);
    expect(pageOf("colored", wool, 11)).toEqual([
      "white_wool",
      "light_gray_wool",
      "gray_wool",
      "black_wool",
      "brown_wool",
      "red_wool",
      "orange_wool",
      "yellow_wool",
      "lime_wool",
      "green_wool",
      "cyan_wool",
      "light_blue_wool",
      "blue_wool",
      "purple_wool",
      "magenta_wool",
      "pink_wool",
    ]);
  });

  it("建筑页同族放一起：族按原版先后，族内本体在前、加工层数少的在前，涂蜡与虫蚀在族末，不认识的族排最后", () => {
    const list = [
      "waxed_copper_block",
      "exposed_copper",
      "cut_copper",
      "copper_block",
      "mystery_block",
      "iron_block",
      "prismarine_bricks",
      "dark_prismarine",
      "prismarine",
      "deepslate_tiles",
      "cobbled_deepslate",
      "deepslate",
      "infested_stone",
      "chiseled_stone_bricks",
      "stone_bricks",
      "smooth_stone",
      "stone",
      "spruce_log",
      "stripped_oak_wood",
      "stripped_oak_log",
      "oak_wood",
      "oak_planks",
      "oak_log",
      "amber_bricks",
    ];
    expect(pageOf("building", list, 5)).toEqual([
      "oak_log",
      "oak_planks",
      "oak_wood",
      "stripped_oak_log",
      "stripped_oak_wood",
      "spruce_log",
      "stone",
      "smooth_stone",
      "stone_bricks",
      "chiseled_stone_bricks",
      "infested_stone",
      "deepslate",
      "cobbled_deepslate",
      "deepslate_tiles",
      "prismarine",
      "dark_prismarine",
      "prismarine_bricks",
      "iron_block",
      "copper_block",
      "cut_copper",
      "exposed_copper",
      "waxed_copper_block",
      "amber_bricks",
      "mystery_block",
    ]);
  });

  it("自然页按规则表先后；矿石按矿物配对（本体在前，深层与下界在后），树叶、珊瑚块按材质", () => {
    const list = [
      "deepslate_iron_ore",
      "iron_ore",
      "coal_ore",
      "oak_leaves",
      "birch_leaves",
      "end_stone",
      "netherrack",
      "dead_brain_coral_block",
      "brain_coral_block",
      "raw_iron_block",
      "ancient_debris",
      "nether_gold_ore",
      "gold_ore",
      "dirt",
      "grass_block",
    ];
    expect(pageOf("natural", list, 9)).toEqual([
      "grass_block",
      "dirt",
      "coal_ore",
      "gold_ore",
      "nether_gold_ore",
      "iron_ore",
      "deepslate_iron_ore",
      "ancient_debris",
      "raw_iron_block",
      "birch_leaves",
      "oak_leaves",
      "brain_coral_block",
      "dead_brain_coral_block",
      "netherrack",
      "end_stone",
    ]);
  });

  it("功能页按规则表先后，铜灯按氧化程度、涂蜡在后；只因有正面进来的排在表后", () => {
    const list = ["jack_o_lantern", "tnt", "oxidized_copper_bulb", "waxed_copper_bulb", "copper_bulb", "carved_pumpkin", "furnace", "crafting_table"];
    expect(pageOf("functional", list, 13, ["jack_o_lantern", "carved_pumpkin", "furnace"])).toEqual([
      "crafting_table",
      "furnace",
      "tnt",
      "copper_bulb",
      "oxidized_copper_bulb",
      "waxed_copper_bulb",
      "carved_pumpkin",
      "jack_o_lantern",
    ]);
  });
});

describe("材质族与变体", () => {
  it.each([
    ["polished_blackstone_bricks", { family: "blackstone", replica: false, oxidation: 0, depth: 2 }],
    ["cracked_polished_blackstone_bricks", { family: "blackstone", replica: false, oxidation: 0, depth: 3 }],
    ["waxed_weathered_cut_copper", { family: "copper", replica: true, oxidation: 2, depth: 1 }],
    ["oxidized_copper", { family: "copper", replica: false, oxidation: 3, depth: 0 }],
    ["deepslate_coal_ore", { family: "coal", replica: false, oxidation: 0, depth: 1 }],
    ["deepslate_bricks", { family: "deepslate", replica: false, oxidation: 0, depth: 1 }],
    ["nether_bricks", { family: "nether", replica: false, oxidation: 0, depth: 1 }],
    ["netherite_block", { family: "netherite", replica: false, oxidation: 0, depth: 0 }],
    ["dark_oak_log", { family: "dark_oak", replica: false, oxidation: 0, depth: 0 }],
    ["stripped_bamboo_block", { family: "bamboo", replica: false, oxidation: 0, depth: 1 }],
    ["crimson_hyphae", { family: "crimson", replica: false, oxidation: 0, depth: 1 }],
    ["chiseled_quartz_block", { family: "quartz", replica: false, oxidation: 0, depth: 1 }],
    ["sea_lantern", { family: "prismarine", replica: false, oxidation: 0, depth: 1 }],
    ["bricks", { family: "bricks", replica: false, oxidation: 0, depth: 0 }],
    ["stone", { family: "stone", replica: false, oxidation: 0, depth: 0 }],
  ] as const)("%s", (id, variant) => {
    expect(blockVariant(id)).toEqual(variant);
  });

  it("前缀只在后面还有内容时才剥：smooth_ 本身不会被剥成空族", () => {
    expect(blockVariant("smooth_").family).toBe("smooth_");
  });
});

describe("搜索", () => {
  const ordered = [
    block("oak_log", ["Oak Log", "橡木原木"]),
    block("stripped_oak_log", ["Stripped Oak Log", "去皮橡木原木"]),
    block("oak_planks", ["Oak Planks", "橡木木板"]),
    block("red_wool", ["Red Wool", "红色羊毛"]),
    block("redstone_block", ["Block of Redstone", "红石块"]),
    block("mystery_block"),
  ];

  it("中文名：以查询开头的在前，名称中间含有的在后", () => {
    expect(ids(searchBlocks(ordered, "橡木"))).toEqual(["oak_log", "oak_planks", "stripped_oak_log"]);
  });

  it("英文名不分大小写，多余空白不影响", () => {
    expect(ids(searchBlocks(ordered, "  OAK   log "))).toEqual(["oak_log", "stripped_oak_log"]);
  });

  it("id 原样与下划线换成空格都能搜到", () => {
    expect(ids(searchBlocks(ordered, "oak_log"))).toEqual(["oak_log", "stripped_oak_log"]);
    expect(ids(searchBlocks(ordered, "stone block"))).toEqual(["redstone_block"]);
  });

  it("名称或 id 任一以查询开头就算前排，两段内保持原顺序", () => {
    expect(ids(searchBlocks(ordered, "red"))).toEqual(["red_wool", "redstone_block"]);
    expect(ids(searchBlocks(ordered, "红"))).toEqual(["red_wool", "redstone_block"]);
  });

  it("没有名称的方块按 id 搜", () => {
    expect(ids(searchBlocks(ordered, "myst"))).toEqual(["mystery_block"]);
  });

  it("查询为空时原样给出全部，搜不到时为空", () => {
    expect(ids(searchBlocks(ordered, "   "))).toEqual(ids(ordered));
    expect(searchBlocks(ordered, "不存在的方块")).toEqual([]);
  });
});
