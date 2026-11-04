import type { ArtDownloadProgressDto, ArtStatusDto, BlockCatalogDto, CatalogBlockDto, SkinInfoDto } from "../../art";
import { IpcError } from "../../errors";
import { emitMockEvent } from "../events";
import type { MockHandlers } from "../types";
import { hasMockAccount, isMockOfflineAccount } from "./accounts";

// ipc/ 只能以类型方式引用别的模块，事件名与名单在这里按后端各写一份。
const ART_CHANGED_EVENT = "petalfall://art-changed";
const ART_DOWNLOAD_EVENT = "petalfall://art-download";
const THUMB_HOSTS: readonly string[] = ["cdn.modrinth.com", "media.forgecdn.net", "launchercontent.mojang.com"];

// 浏览器里起步没有材质源：界面全部画回落件，不发任何材质请求。art_download 之后才有源；
// 浏览器里没有材质协议，有源时取图照样失败，方块回落成实例徽记，这是预期。
const INITIAL: ArtStatusDto = { source: null, panorama: false };

let status: ArtStatusDto = { ...INITIAL };
let downloading = false;

/** 给测试与预览用：模拟后端换了材质源，状态有变化就推送变更事件（与后端 refresh 一致）。 */
export function setMockArtStatus(next: ArtStatusDto): void {
  const changed = JSON.stringify(next) !== JSON.stringify(status);
  status = next;
  if (changed) emitMockEvent(ART_CHANGED_EVENT, next);
}

// 原版客户端默认皮肤数组的顺序（先 9 套细臂、后 9 套宽臂）与 Java 的 UUID.hashCode 加 Math.floorMod，与后端同一规则。
const DEFAULT_SKIN_NAMES = ["alex", "ari", "efe", "kai", "makena", "noor", "steve", "sunny", "zuri"] as const;

/** 导出给测试逐个核对：mock 生成的离线 UUID 只落在少数下标上，经 skin_info 覆盖不到全部 18 套。 */
export function defaultSkin(uuid: string): Extract<SkinInfoDto, { kind: "default" }> {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new IpcError("internal", `离线账户的 UUID 不是 32 位十六进制：${uuid}`);
  const hash = [0, 8, 16, 24].reduce((acc, at) => acc ^ Number.parseInt(hex.slice(at, at + 8), 16), 0) | 0;
  const count = DEFAULT_SKIN_NAMES.length * 2;
  const index = ((hash % count) + count) % count;
  const slim = index < DEFAULT_SKIN_NAMES.length;
  const name = DEFAULT_SKIN_NAMES[slim ? index : index - DEFAULT_SKIN_NAMES.length];
  return slim ? { kind: "default", path: `entity/player/slim/${name}`, model: "slim" } : { kind: "default", path: `entity/player/wide/${name}`, model: "wide" };
}

async function sha1Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------- 方块目录

const GRASS_TINT: [number, number, number] = [124, 189, 107];

type Names = readonly [en: string, zh: string];

/** 四面同一张图的方块。 */
const cube = (id: string, hue: number, [en, zh]: Names): CatalogBlockDto => ({
  id,
  top: `block/${id}`,
  side: `block/${id}`,
  front: null,
  top_tint: null,
  side_tint: null,
  hue,
  name_en: en,
  name_zh: zh,
});

/** 原木：侧面是树皮，顶面是年轮。 */
const log = (id: string, hue: number, names: Names): CatalogBlockDto => ({ ...cube(id, hue, names), top: `block/${id}_top` });

/** 树叶：灰度材质，四面按树叶色图的默认色染。 */
const leaves = (id: string, hue: number, tint: [number, number, number], names: Names): CatalogBlockDto => ({
  ...cube(id, hue, names),
  top_tint: tint,
  side_tint: tint,
});

/**
 * 合成的方块目录：16 种封面预设、几种原木、两种要染色的树叶、一个有正面的熔炉与几种纯色方块，
 * 覆盖选择框与等距方块要处理的全部形状。按 id 排序，与后端一致。
 */
const MOCK_BLOCKS: readonly CatalogBlockDto[] = [
  cube("cherry_planks", 345, ["Cherry Planks", "樱花木板"]),
  cube("cherry_leaves", 330, ["Cherry Leaves", "樱花树叶"]),
  { ...cube("grass_block", 118, ["Grass Block", "草方块"]), top: "block/grass_block_top", side: "block/grass_block_side", top_tint: GRASS_TINT },
  cube("moss_block", 95, ["Moss Block", "苔藓块"]),
  cube("honeycomb_block", 38, ["Honeycomb Block", "蜜脾块"]),
  cube("amethyst_block", 275, ["Block of Amethyst", "紫水晶块"]),
  cube("copper_block", 24, ["Block of Copper", "铜块"]),
  cube("prismarine_bricks", 175, ["Prismarine Bricks", "海晶石砖"]),
  cube("deepslate_tiles", 210, ["Deepslate Tiles", "深板岩瓦"]),
  cube("purpur_block", 290, ["Purpur Block", "紫珀块"]),
  cube("mossy_cobblestone", 100, ["Mossy Cobblestone", "苔石"]),
  cube("red_wool", 355, ["Red Wool", "红色羊毛"]),
  cube("blue_ice", 205, ["Blue Ice", "蓝冰"]),
  cube("oxidized_copper", 165, ["Oxidized Copper", "氧化的铜"]),
  cube("netherrack", 352, ["Netherrack", "下界岩"]),
  cube("end_stone_bricks", 55, ["End Stone Bricks", "末地石砖"]),
  log("oak_log", 33, ["Oak Log", "橡木原木"]),
  log("birch_log", 50, ["Birch Log", "白桦原木"]),
  log("spruce_log", 25, ["Spruce Log", "云杉原木"]),
  log("cherry_log", 340, ["Cherry Log", "樱花原木"]),
  leaves("oak_leaves", 101, [72, 181, 24], ["Oak Leaves", "橡树树叶"]),
  leaves("birch_leaves", 89, [128, 167, 85], ["Birch Leaves", "白桦树叶"]),
  { ...cube("furnace", 0, ["Furnace", "熔炉"]), top: "block/furnace_top", side: "block/furnace_side", front: "block/furnace_front" },
  cube("white_concrete", 186, ["White Concrete", "白色混凝土"]),
  cube("lime_concrete", 89, ["Lime Concrete", "黄绿色混凝土"]),
  cube("light_blue_wool", 196, ["Light Blue Wool", "淡蓝色羊毛"]),
  cube("orange_terracotta", 22, ["Orange Terracotta", "橙色陶瓦"]),
  cube("pink_concrete", 338, ["Pink Concrete", "粉红色混凝土"]),
].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

function blockCatalog(): BlockCatalogDto | null {
  if (status.source === null) return null;
  return { version_id: status.source.version_id, blocks: MOCK_BLOCKS.map((b) => ({ ...b })) };
}

// ---------------------------------------------------------------- 下载原版材质

/** 模拟下到的最新正式版。 */
export const MOCK_DOWNLOADED_VERSION = "1.21.4";

const DOWNLOAD_STEP_MS = 120;
const CLIENT_BYTES = 27_350_016;
const NAMES_BYTES = 684_032;

/** 与后端同一顺序：查版本清单、下客户端 jar、下中文语言文件、抽进缓存。 */
const DOWNLOAD_STEPS: readonly ArtDownloadProgressDto[] = [
  { stage: "manifest", downloaded: 0, total: null },
  ...[1, 2, 3, 4].map((i): ArtDownloadProgressDto => ({ stage: "client", downloaded: Math.round((CLIENT_BYTES * i) / 4), total: CLIENT_BYTES })),
  ...[1, 2].map((i): ArtDownloadProgressDto => ({ stage: "names", downloaded: Math.round((NAMES_BYTES * i) / 2), total: NAMES_BYTES })),
  { stage: "extract", downloaded: 0, total: null },
];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 逐步推进度，下完把材质源换成下到的版本（推 art-changed），返回新状态；同一时刻只允许一次。 */
async function artDownload(): Promise<ArtStatusDto> {
  if (downloading) throw new IpcError("task_conflict", "原版材质正在下载");
  downloading = true;
  try {
    for (const step of DOWNLOAD_STEPS) {
      await sleep(DOWNLOAD_STEP_MS);
      emitMockEvent(ART_DOWNLOAD_EVENT, step);
    }
    setMockArtStatus({ source: { version_id: MOCK_DOWNLOADED_VERSION }, panorama: status.panorama });
    return status;
  } finally {
    downloading = false;
  }
}

export const handlers: MockHandlers = {
  art_status: () => status,

  art_blocks: () => blockCatalog(),

  art_download: () => artDownload(),

  // 浏览器里没有远程皮肤缓存：正版与外置账户回 null（画剪影）；离线账户与后端一样给它的默认皮肤；
  // 不存在的账户与后端一样报 AccountNotFound。
  skin_info: (args) => {
    const uuid = args.accountUuid;
    if (typeof uuid !== "string") throw new IpcError("unknown", "invalid args `accountUuid` for command `skin_info`: missing required key accountUuid");
    if (!hasMockAccount(uuid)) throw new IpcError("AccountNotFound", `账户不存在: ${uuid}`, { uuid });
    return isMockOfflineAccount(uuid) ? defaultSkin(uuid) : null;
  },

  // 只做后端同样的地址与主机校验并给出同样的键（地址的 SHA-1），不下载任何东西。
  thumb_register: async (args) => {
    const raw = args.url;
    if (typeof raw !== "string") throw new IpcError("unknown", "invalid args `url` for command `thumb_register`: missing required key url");
    let url: URL;
    try {
      url = new URL(raw);
    } catch (e) {
      throw new IpcError("invalid_argument", `缩略图地址不合法：${raw}：${String(e)}`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new IpcError("invalid_argument", `缩略图地址不合法：${raw}：只支持 http / https`);
    if (!THUMB_HOSTS.includes(url.hostname)) {
      throw new IpcError("invalid_argument", `缩略图主机 ${url.hostname} 不在允许名单内`, { host: url.hostname });
    }
    return sha1Hex(raw);
  },
};

export function reset(): void {
  status = { ...INITIAL };
  downloading = false;
}
