// 实例库页面自己的文案。跨页面共用的（加载器名、启动入口、删除确认、通知目录）从 copy/flows 引用，这里不重复。

import { joinMixed, LOADER_NAME, PAGE_LABEL } from "../../copy/flows";
import { formatPlaytime } from "../../domain/format";
import type { LoaderKind } from "../../domain/types";
import type { SortKey } from "./model";

export const LIBRARY_COPY = {
  title: PAGE_LABEL.library,
  subtitle: (count: number, pinned: number, minutes: number | null) =>
    `共 ${count} 个实例 · ${pinned} 个固定在侧栏 · ${minutes === null ? "累计时长读不到" : `累计 ${formatPlaytime(minutes)}`}`,
  subtitleEmpty: "还没有实例",
  importModpack: "导入整合包",
  create: "新建实例",

  filterLabel: "按加载器筛选",
  filterAll: "全部",
  searchPlaceholder: "搜索实例或整合包",
  sortLabel: "排序方式",
  sort: { recent: "最近游玩", name: "名称", playtime: "游玩时长" } satisfies Readonly<Record<SortKey, string>>,

  repairTitle: (count: number) => `${count} 个实例需要修复`,
  repairBody: (names: readonly string[]) => `${names.map((n) => `「${n}」`).join("")}缺少游戏文件，补全后就能启动。`,
  repairOne: "立即修复",
  repairAll: "全部修复",

  current: "当前",
  openCard: (name: string) => `打开「${name}」`,
  moreLabel: (name: string) => `「${name}」的更多操作`,
  noDescription: "自建实例，还没写介绍",
  statsLabel: "游玩概况",
  lastPlayed: "上次游玩",
  playtime: "累计时长",
  playUnknown: "读不到",
  modCount: "Mod 数",
  worldCount: "存档数",

  pin: (name: string) => `把「${name}」固定到侧栏`,
  unpin: (name: string) => `从侧栏取消固定「${name}」`,
  pinned: (name: string) => `已把「${name}」固定到侧栏`,
  unpinned: (name: string) => `已从侧栏取消固定「${name}」`,

  menu: {
    open: "打开详情",
    select: "设为当前实例",
    selected: "已是当前实例",
    pin: "固定到侧栏",
    unpin: "从侧栏取消固定",
    pinFull: "侧栏最多固定 5 个实例",
    openFolder: "打开实例文件夹",
    mods: "Mod 管理",
    settings: "实例设置",
    logs: "日志与历史",
    crash: "崩溃诊断",
    crashActive: "上次崩溃",
    remove: "删除实例",
  },

  createTileTitle: "新建实例",
  createTileBody: "选版本、加载器和封面，装好后自动固定到侧栏",

  emptyTitle: "实例库还是空的",
  emptyBody: "新建一个实例，选好版本、加载器和封面；或者去发现页把整合包导入成实例。",
  emptyAction: "去发现导入整合包",

  noMatchTitle: "没有符合条件的实例",
  noMatchQuery: (query: string, loader: LoaderKind | null) =>
    loader === null ? `没有名字里带「${query}」的实例。` : `没有名字里带「${query}」${joinMixed("的", LOADER_NAME[loader], "实例。")}`,
  noMatchLoader: (loader: LoaderKind) => joinMixed("还没有", LOADER_NAME[loader], "实例。"),
  clearFilter: "清除筛选",

  loadErrorTitle: "读不到实例列表",
  retry: "重试",
  openGameDir: "打开游戏目录",

  gridLabel: "实例",
  loadingLabel: "正在读取实例列表",
} as const;
