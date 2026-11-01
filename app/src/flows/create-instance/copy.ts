// 新建实例流程的文案。加载器名、名称校验错误、通知标题这类跨处共用的从 copy/flows 引用。

import { joinMixed, LOADER_NAME } from "../../copy/flows";
import type { ReleaseType } from "../../domain/adapt";
import { formatBytes, formatRelative } from "../../domain/format";
import type { LoaderKind } from "../../domain/types";
import type { StepId } from "./model";

export const STEP_LABEL: Readonly<Record<StepId, string>> = {
  name: "名称",
  version: "游戏版本",
  loader: "加载器",
  loaderVersion: "加载器版本",
  cover: "外观",
  confirm: "确认",
};

export const RELEASE_TYPE_LABEL: Readonly<Record<ReleaseType, string>> = {
  release: "正式版",
  snapshot: "快照",
  old: "远古",
};

export const LOADER_DESCRIPTION: Readonly<Record<LoaderKind, string>> = {
  vanilla: "不装加载器，纯净的原版体验",
  fabric: "轻量、跟版本快，性能优化类 Mod 最多",
  quilt: "Fabric 的分支，能装大部分 Fabric Mod",
  forge: "历史最久，老版本与大型整合包的首选",
  neoforge: "Forge 的继任者，新版本大型模组的主力",
};

const listNames = (loaders: readonly LoaderKind[]) => loaders.map((k) => LOADER_NAME[k]).join("、");

export const CREATE_COPY = {
  title: "新建实例",
  subtitle: (index: number, total: number, step: StepId) => `第 ${index} 步，共 ${total} 步 · ${STEP_LABEL[step]}`,
  stepsLabel: "新建步骤",
  untitled: "未命名实例",
  skippedValue: "原版无需选择",
  previewMeta: (mcVersion: string, loader: LoaderKind, loaderVersion: string | null) =>
    loaderVersion === null ? `${mcVersion} · ${LOADER_NAME[loader]}` : `${mcVersion} · ${LOADER_NAME[loader]} ${loaderVersion}`,

  hintEnter: "按",
  hintEnterAfter: "继续",
  hintEsc: "Esc 可随时关闭，已填的内容不会保存",
  cancel: "取消",
  back: "上一步",
  next: "下一步",
  create: "创建并开始安装",
  creating: "正在创建",

  name: {
    title: "给实例起个名字",
    body: "名称会显示在侧栏和实例库里，也会用作实例文件夹的名字。",
    label: "实例名称",
    placeholder: "例如：周末生存",
    hint: "之后可以在实例详情里随时改名",
    ideasLabel: "没想好？试试",
    ideas: ["周末生存", "建筑创造", "和朋友联机", "模组尝鲜", "空岛挑战"],
    roadmap: "接下来依次选择游戏版本、加载器和封面，左侧随时能跳回已经走过的步骤。",
  },

  version: {
    title: "选择游戏版本",
    body: "正式版最稳定；快照是下个版本的抢先预览，可能损坏存档。",
    search: "搜索版本号",
    snapshots: "显示快照",
    old: "显示远古版本",
    count: (n: number) => `共 ${n} 个版本`,
    stale: (since: number, now: number) => `离线中，显示的是 ${formatRelative(since, now)}缓存的版本列表`,
    latest: "最新",
    released: (at: number, now: number) => `${formatRelative(at, now)}发布`,
    java: (major: number) => `需要 Java ${major}`,
    onlyVanilla: "仅原版",
    supports: (loaders: readonly LoaderKind[]) => `支持 ${listNames(loaders)}`,
    listLabel: "游戏版本",
    noMatch: (query: string) => `没有叫「${query}」的版本`,
    loadError: "拉不到版本列表",
    loadingLabel: "正在读取版本列表",
  },

  loader: {
    title: "选择加载器",
    body: (mcVersion: string, count: number) => `${mcVersion} 可以用 ${count} 种。想装 Mod 就选一个加载器，只想玩原版就选「原版」。`,
    listLabel: "加载器",
    missing: (mcVersion: string, loaders: readonly LoaderKind[]) => joinMixed(`${mcVersion} 没有`, listNames(loaders), "可用，换个游戏版本就能看到。"),
    unavailable: (loader: LoaderKind, message: string) => joinMixed("暂时拉不到", LOADER_NAME[loader], `的版本信息：${message}`),
  },

  loaderVersion: {
    title: (loader: LoaderKind) => joinMixed("选择", LOADER_NAME[loader], "版本"),
    body: "默认选最新的稳定版；遇到个别 Mod 不兼容时再换旧一点的版本。",
    item: (loader: LoaderKind, version: string) => `${LOADER_NAME[loader]} ${version}`,
    recommended: "推荐",
    beta: "测试版",
    newest: "最新发布",
    betaNote: "抢先体验，可能不稳定",
    older: "较早的稳定版",
    listLabel: (loader: LoaderKind) => joinMixed(LOADER_NAME[loader], "版本"),
    loadError: (loader: LoaderKind) => joinMixed("拉不到", LOADER_NAME[loader], "的版本列表"),
    empty: (loader: LoaderKind, mcVersion: string) => joinMixed(LOADER_NAME[loader], `还没有适配 ${mcVersion} 的版本`),
    emptyBody: "换个游戏版本或加载器试试。",
    loadingLabel: "正在读取加载器版本",
  },

  cover: {
    title: "挑一块封面方块",
    body: "封面会用在实例卡片、侧栏图标和主页的大卡上。",
    shuffle: "随机一块",
    listLabel: "封面方块",
  },

  confirm: {
    title: "确认一下",
    body: "确认后开始下载游戏文件，进度会出现在侧栏的实例图标和下载任务里。",
    name: "名称",
    version: "游戏版本",
    versionValue: (mcVersion: string, type: ReleaseType) => `${mcVersion} · ${RELEASE_TYPE_LABEL[type]}`,
    loader: "加载器",
    vanilla: "原版（不装加载器）",
    cover: "封面",
    java: "Java",
    javaInstalled: (major: number, vendor: string) => `Java ${major} · 已安装（${vendor}）`,
    javaAuto: (major: number) => `需要 Java ${major}，会自动下载`,
    javaManual: (major: number) => `需要 Java ${major}，自动下载已关闭，启动前要先装好`,
    javaUnknown: (reason: string) => `没能确认需要的 Java：${reason}`,
    javaPinnedMismatch: (pinned: number, required: number) => `会用固定的 Java ${pinned}，这个版本需要 Java ${required}`,
    javaPinnedMissing: "会用固定的默认 Java，但它已经找不到了",
    pinnedLower: (pinned: number) => `设置里固定的 Java ${pinned} 低于要求，这个实例启动时会失败。`,
    pinnedHigher: (pinned: number) => `设置里固定的 Java ${pinned} 比要求的新，旧版 Forge 与部分 Mod 会直接报错。`,
    pinnedGone: "设置里固定的默认 Java 已经找不到了，这个实例启动时会失败。",
    // 新实例的「自动选择」跟随全局固定的 Java，改它没用；要绕开只能给这个实例单独指定一个
    pinnedFix: (required: number) => `创建后可以在实例设置里给它单独指定 Java ${required}。`,
    pinnedFixDownload: (required: number) => `先在设置里下载 Java ${required}，创建后到实例设置里给它单独指定。`,
    download: "预计下载",
    downloadValue: (bytes: number) => `约 ${formatBytes(bytes)}`,
    downloadNoLoader: " · 不含加载器",
    path: "存放位置",
    snapshotWarning: "快照版本可能有严重问题，别在里面放重要存档。",
    openAfter: "创建后打开实例详情",
    autoPin: "新实例会自动固定到侧栏",
    pinFull: "侧栏已固定 5 个实例，新实例不会自动固定",
    failed: "没能创建实例",
  },

  started: (name: string) => `开始安装「${name}」`,
  startedBody: "进度显示在侧栏图标和下载任务里",

  discard: {
    title: "放弃新建实例？",
    body: "已填的内容不会保留。",
    confirm: "放弃",
    cancel: "继续填写",
  },

  retry: "重试",
} as const;
