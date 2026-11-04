// 原版材质的取址规则：前端只能按这里允许的路径向材质协议取图。
// 只有两类：方块材质 block/<id>（实例封面方块的面、卡面的材质平铺、本机材质源里任意完整方块）与默认皮肤
// （新式 18 张、旧式 2 张）。物品、粒子、界面精灵等一律不在其列，原版材质因此只能出现在实例方块、卡面与皮肤上。
// 路径为材质根目录下去掉 .png 的相对路径，例如 block/cherry_planks。
// 16 种封面预设的面（17 张图）与默认皮肤在 ipc/art.ts 另有一份常量名单，与后端逐项一致，由一致性测试钉住。

export type Rgb = readonly [r: number, g: number, b: number];

/**
 * 原版物品栏里草方块顶面的默认染色（草地色图在温度 0.5、湿度 1.0 处的像素）。
 * 顶面材质本身是灰度，不染色就是一块灰板；侧面的草边在材质里已经带色，不染。
 */
const GRASS_TINT: Rgb = [124, 189, 107];

export interface CoverTexture {
  /** 封面预设 id：实例设置里保存的 cover 值。 */
  readonly id: string;
  /** HSL 色相：实例的色相底座、封面底纹与实例徽记都用它，保证与方块主色接近。 */
  readonly hue: number;
  readonly side: string;
  readonly top: string;
  /** 顶面乘色；只有草方块的灰度顶面需要。 */
  readonly topTint: Rgb | null;
}

const same = (id: string, hue: number): CoverTexture => ({ id, hue, side: `block/${id}`, top: `block/${id}`, topTint: null });

/**
 * 封面白名单，顺序固定：导入整合包时按序号取默认封面，改顺序会改变已有整合包实例的默认封面。
 * 全部是静态（没有动画帧）、四面相同或只分顶面与侧面的方块，1.20 起每个版本都有。
 */
export const COVER_TEXTURES: readonly CoverTexture[] = [
  same("cherry_planks", 345),
  same("cherry_leaves", 330),
  { id: "grass_block", hue: 118, side: "block/grass_block_side", top: "block/grass_block_top", topTint: GRASS_TINT },
  same("moss_block", 95),
  same("honeycomb_block", 38),
  same("amethyst_block", 275),
  same("copper_block", 24),
  same("prismarine_bricks", 175),
  same("deepslate_tiles", 210),
  same("purpur_block", 290),
  same("mossy_cobblestone", 100),
  same("red_wool", 355),
  same("blue_ice", 205),
  same("oxidized_copper", 165),
  same("netherrack", 352),
  same("end_stone_bricks", 55),
];

const COVER_BY_ID = new Map(COVER_TEXTURES.map((c) => [c.id, c]));

/** 白名单外（旧数据、手改配置）返回 undefined，调用方按「材质不存在」显示实例徽记。 */
export function coverTexture(id: string): CoverTexture | undefined {
  return COVER_BY_ID.get(id);
}

/** 1.19.3 起的九款默认皮肤，每款有宽、细两种体型。 */
export const DEFAULT_SKIN_NAMES = ["alex", "ari", "efe", "kai", "makena", "noor", "steve", "sunny", "zuri"] as const;

export const DEFAULT_SKIN_PATHS: readonly string[] = [
  ...DEFAULT_SKIN_NAMES.map((name) => `entity/player/wide/${name}`),
  ...DEFAULT_SKIN_NAMES.map((name) => `entity/player/slim/${name}`),
  // 1.19.3 以前的材质源只有这两张：steve 为宽体型，alex 为细体型
  "entity/steve",
  "entity/alex",
];

/** 16 种封面预设用到的全部面（17 张图）：材质源就绪后预加载它们。 */
export const PRESET_FACE_PATHS: readonly string[] = [...new Set(COVER_TEXTURES.flatMap((c) => [c.side, c.top]))];

/** 方块材质路径：与方块目录（mc/catalog）校验面路径的规则相同；不含子目录与扩展名，也就没有路径穿越的余地。 */
const BLOCK_PATH = /^block\/[a-z0-9_]{1,64}$/;

const SKIN_PATHS: ReadonlySet<string> = new Set(DEFAULT_SKIN_PATHS);

/** 协议允许读取的原版材质路径：任意方块材质与默认皮肤名单。比较逐字节进行，不做任何规范化。 */
export function isArtPath(path: string): boolean {
  return BLOCK_PATH.test(path) || SKIN_PATHS.has(path);
}
