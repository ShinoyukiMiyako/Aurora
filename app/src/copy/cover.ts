// 实例卡面自定义的文案：封面方块选择框与「下载原版材质」部件。预设方块的中文名在 flows 的 coverLabel。
// 插值一律经 domain/format 格式化。

import { formatBytes } from "../domain/format";
import type { ArtDownloadProgressDto } from "../ipc/art";

export const BLOCK_PICKER_COPY = {
  title: "选择封面方块",
  tabsLabel: "方块分类",
  tab: {
    recommended: "推荐",
    building: "建筑",
    colored: "彩色",
    natural: "自然",
    functional: "功能",
    search: "搜索",
    image: "我的图片",
  },
  /** 网格（选项列表）的可访问名称。 */
  gridLabel: {
    recommended: "推荐方块",
    building: "建筑方块",
    colored: "彩色方块",
    natural: "自然方块",
    functional: "功能方块",
    search: "搜索结果",
  },
  searchLabel: "搜索方块",
  searchPlaceholder: "按中文名、英文名或 id 搜索",
  noMatch: (query: string) => `没有找到「${query}」`,
  noMatchBody: "换个说法试试，中文名、英文名和方块 id 都能搜",
  image: {
    title: "用你自己的图片当方块",
    /** 方块正在用玩家图片时的标题。 */
    currentTitle: "正在用你的图片",
    body: "支持 PNG、JPEG 与 WebP，不超过 20 MB。图片居中裁成正方形，缩成 16×16，三个面都画这一张；只存在这个实例里，导出整合包时不带上。",
    /** 方块正在用玩家图片时排在说明之前。 */
    currentBody: "在其他页选一个方块，就换回方块材质。",
    pick: "选一张图片",
    replace: "换一张图片",
  },
} as const;

export const ART_DOWNLOAD_COPY = {
  title: "本机还没有原版材质",
  body: "下载后可以从全部完整方块里挑。按「设置 → 下载」里的文件下载源从 Mojang 官方源或镜像下载，整包约 20 到 40 MB，下完只留方块相关的几 MB。",
  compactBody: "从 Mojang 官方源或镜像下载原版材质，整包约 20 到 40 MB，下完只留几 MB。",
  download: "下载原版材质",
  retry: "重试",
  failedNote: "上次没下完",
  /** 失败通知的标题，正文是错误原文。 */
  failed: "没能下载原版材质",
  /** 进度事件到来之前。 */
  starting: "正在准备下载",
  stage: {
    manifest: "正在查询版本清单",
    client: "正在下载客户端",
    names: "正在下载中文名称",
    extract: "正在抽取方块材质",
  } satisfies Readonly<Record<ArtDownloadProgressDto["stage"], string>>,
  bytes: (downloaded: number, total: number | null) =>
    total === null ? `已下载 ${formatBytes(downloaded)}` : `已下载 ${formatBytes(downloaded)}，共 ${formatBytes(total)}`,
  /** 下载完成、方块目录还没载入的那一会儿。 */
  finishing: "正在载入材质…",
  progressLabel: "原版材质下载进度",
} as const;
