// 原版材质服务：材质源状态、方块目录、下载材质、账户皮肤、远程缩略图登记。
// 图片本身不走命令而走自定义协议（WebView 的 HTTP 缓存才用得上），拼协议地址的代码只在材质目录里；
// 这里只回答「有没有、用哪个键去取」，并给出允许读取的原版文件名单。

import { invoke, listen, type UnlistenFn } from "./bridge";

/** 材质源或全景可用性变化时推送，负载为 ArtStatusDto。收到后清空位图缓存并重绘点缀位。 */
export const ART_CHANGED_EVENT = "petalfall://art-changed";

export interface ArtSourceDto {
  version_id: string;
}

export interface ArtStatusDto {
  /** 为 null 时不发任何材质请求，所有点缀位画回落件。 */
  source: ArtSourceDto | null;
  /** 全景对象是否可用。 */
  panorama: boolean;
}

export type SkinModel = "wide" | "slim";

/**
 * 远程皮肤就绪：sha1 是协议里皮肤路径的键，hat 表示头像要不要叠帽子层。
 * 离线账户：它进游戏后显示的原版默认皮肤，path 在下面的默认皮肤名单里，从本机游戏文件读。
 */
export type SkinInfoDto =
  | { kind: "remote"; sha1: string; model: SkinModel; hat: boolean }
  | { kind: "default"; path: SkinTexture; model: SkinModel };

// 下面两份名单与后端逐项一致（后端测试读本文件比对），名单外的路径后端一律以 400 拒绝。

/** 实例封面可选的方块：16 种侧面 + 草方块的顶面。 */
export const BLOCK_TEXTURES = [
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
] as const;

/** 原版默认皮肤：1.19.3 起的 9 款 × 宽臂 / 细臂，加上更早版本只有的两张。 */
export const SKIN_TEXTURES = [
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
] as const;

export type BlockTexture = (typeof BLOCK_TEXTURES)[number];
export type SkinTexture = (typeof SKIN_TEXTURES)[number];
export type ArtPath = BlockTexture | SkinTexture;

const ART_PATHS: ReadonlySet<string> = new Set<string>([...BLOCK_TEXTURES, ...SKIN_TEXTURES]);

/** 逐字节全等比较，不做任何规范化：与后端判定一致。 */
export function isArtPath(path: string): path is ArtPath {
  return ART_PATHS.has(path);
}

/** thumb_register 只接受这几个图片域名（精确匹配主机名，不含子域）。 */
export const THUMB_HOSTS = ["cdn.modrinth.com", "media.forgecdn.net", "launchercontent.mojang.com"] as const;

/** 方块目录里的一个完整立方体方块；材质路径都在 block/ 下，取图仍经 /art/ 路径。 */
export interface CatalogBlockDto {
  id: string;
  /** 顶面材质路径，如 block/oak_log_top。 */
  top: string;
  side: string;
  /** 正面（熔炉、发射器这类有朝向的方块），画在等距方块的左面；没有为 null。 */
  front: string | null;
  /** 顶面乘色 [r, g, b]（草方块顶、树叶）；不用染色为 null。 */
  top_tint: [number, number, number] | null;
  /** 侧面与正面乘色（树叶四面都染）；不用染色为 null。 */
  side_tint: [number, number, number] | null;
  /** 侧面平均色的 HSL 色相（0-359）。 */
  hue: number;
  /** 英文名来自 jar 里的 en_us，中文名来自资源索引里的 zh_cn；读不到为 null。 */
  name_en: string | null;
  name_zh: string | null;
}

export interface BlockCatalogDto {
  version_id: string;
  blocks: CatalogBlockDto[];
}

/** 下载材质的进度，负载见 ArtDownloadProgressDto。 */
export const ART_DOWNLOAD_EVENT = "petalfall://art-download";

export interface ArtDownloadProgressDto {
  /** manifest 查版本清单，client 下客户端 jar，names 下中文语言文件，extract 抽取进缓存。 */
  stage: "manifest" | "client" | "names" | "extract";
  /** 本阶段已下载的字节；manifest 与 extract 阶段为 0。 */
  downloaded: number;
  /** 本阶段的总字节；不知道时为 null。 */
  total: number | null;
}

/** 只读内存。应先订阅 onArtChanged 再调用，避免漏掉启动时那次刷新带来的变化。 */
export const artStatus = (): Promise<ArtStatusDto> => invoke<ArtStatusDto>("art_status");

/** 账户当前皮肤；离线账户给默认皮肤，正版与外置账户档案没有皮肤或下载失败时为 null（画剪影）。账户不存在报 AccountNotFound。 */
export const skinInfo = (accountUuid: string): Promise<SkinInfoDto | null> =>
  invoke<SkinInfoDto | null>("skin_info", { accountUuid });

/** 当前材质源的方块目录；没有材质源时为 null。只读内存。 */
export const artBlocks = (): Promise<BlockCatalogDto | null> => invoke<BlockCatalogDto | null>("art_blocks");

/**
 * 本机没有原版游戏时，从官方源（按文件下载源设置，镜像回退）下载最新正式版的客户端 jar，只抽方块材质、
 * 方块状态与模型、英文名进缓存，再下中文语言文件，然后删掉 jar。完成后重选材质源并推送 art-changed，
 * 返回新状态。上一次还没下完时再调用报 task_conflict；网络失败、校验不符报 download_failed。
 */
export const artDownload = (): Promise<ArtStatusDto> => invoke<ArtStatusDto>("art_download");

export const onArtDownload = (handler: (progress: ArtDownloadProgressDto) => void): Promise<UnlistenFn> =>
  listen<ArtDownloadProgressDto>(ART_DOWNLOAD_EVENT, handler);

/** 下载并缓存一张远程缩略图，返回取图键（40 位小写十六进制）。主机不在名单内报 invalid_argument。 */
export const thumbRegister = (url: string): Promise<string> => invoke<string>("thumb_register", { url });

export const onArtChanged = (handler: (status: ArtStatusDto) => void): Promise<UnlistenFn> =>
  listen<ArtStatusDto>(ART_CHANGED_EVENT, handler);
