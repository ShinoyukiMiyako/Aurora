// 流程文案表。页面与组件只 import，不内联；产品名一律取自 app-info。
// 插值一律经 domain/format 格式化；带插值的条目写成函数，参数缺失属于调用方的契约错误，直接抛出。

import { formatBytes, formatElapsed, formatMemory, formatRelative, formatSpeed } from "../domain/format";
import type { AccountKind, FailureCode, LoaderKind, SessionPhase, StopReason, TaskKind, TaskStatus } from "../domain/types";
import type { NameRule } from "../ipc/instances";
import { APP_NAME, type ReleaseChannel } from "../lib/app-info";

/** 启动失败（首帧之前出错）时错误页的文案。 */
export const BOOT_FAILURE_COPY = {
  /** WebView2 运行时过旧，缺少界面依赖的 color-mix 与容器查询。 */
  unsupported: {
    title: "需要更新 WebView2 运行时",
    body: `当前的 Microsoft Edge WebView2 运行时版本过旧，缺少界面需要的样式能力。更新后重新打开${APP_NAME}。`,
  },
  /** 读取外观设置、加载字体等启动步骤出错。 */
  failed: {
    title: `${APP_NAME}没能启动`,
    body: "启动时出了错，错误信息在下方。可以重新加载；问题反复出现时，把错误信息附在反馈里。",
  },
} as const;

/** 错误页上的按钮文案。 */
export const ERROR_SCREEN_ACTIONS = {
  reload: "重新加载",
  copy: "复制错误信息",
  copied: "已复制",
} as const;

// ---------------------------------------------------------------- 中西文混排

const LATIN_EDGE = /[A-Za-z0-9]/;
const CJK_EDGE = /[㐀-鿿]/;

/**
 * 拼接文案片段：汉字与英文、数字相邻处补一个半角空格，全角标点两侧不加空格。
 * 「日志指向」+「Mixin 注入失败」得到「日志指向 Mixin 注入失败」，「内存不足」+「与」+「Mixin…」得到「内存不足与 Mixin…」。
 */
export function joinMixed(...parts: string[]): string {
  let out = "";
  for (const part of parts) {
    if (part === "") continue;
    const last = out.slice(-1);
    const first = part.charAt(0);
    const needsSpace = (CJK_EDGE.test(last) && LATIN_EDGE.test(first)) || (LATIN_EDGE.test(last) && CJK_EDGE.test(first));
    out += needsSpace ? ` ${part}` : part;
  }
  return out;
}

// ---------------------------------------------------------------- 页面与导航

export const PAGE_LABEL = {
  home: "主页",
  library: "实例库",
  instance: "实例",
  discover: "发现",
  tasks: "下载任务",
  accounts: "账户",
  settings: "设置",
} as const;

export const INSTANCE_TAB_LABEL = {
  overview: "概览",
  mods: "Mod",
  settings: "设置",
  logs: "日志与历史",
  crash: "崩溃诊断",
} as const;

export const SETTINGS_SECTION_LABEL = {
  general: "常规",
  download: "下载",
  java: "Java",
  game: "游戏",
  appearance: "外观",
  about: "关于",
} as const;

/** 发布通道（由版本号推出，见 lib/app-info 的 buildInfo）：关于页的通道标与版本信息。 */
export const RELEASE_CHANNEL_LABEL: Readonly<Record<ReleaseChannel, string>> = {
  stable: "正式版",
  beta: "测试版",
  preview: "预览版",
};

/** 加载器的官方写法（英文专名保持官方大小写）。 */
export const LOADER_NAME: Readonly<Record<LoaderKind, string>> = {
  vanilla: "原版",
  fabric: "Fabric",
  quilt: "Quilt",
  forge: "Forge",
  neoforge: "NeoForge",
};

/** 封面预设的中文名，键为封面预设 id（与方块白名单一致）。新建实例、整合包导入与实例设置换封面共用。 */
const COVER_LABEL: Readonly<Record<string, string>> = {
  cherry_planks: "樱花木板",
  cherry_leaves: "樱花树叶",
  grass_block: "草方块",
  moss_block: "苔藓块",
  honeycomb_block: "蜜脾块",
  amethyst_block: "紫水晶块",
  copper_block: "铜块",
  prismarine_bricks: "海晶石砖",
  deepslate_tiles: "深板岩瓦",
  purpur_block: "紫珀块",
  mossy_cobblestone: "苔石",
  red_wool: "红色羊毛",
  blue_ice: "蓝冰",
  oxidized_copper: "氧化的铜",
  netherrack: "下界岩",
  end_stone_bricks: "末地石砖",
};

/** 漏配时直接抛，免得界面上出现 id 原文。 */
export function coverLabel(block: string): string {
  if (!Object.hasOwn(COVER_LABEL, block)) throw new Error(`封面 ${block} 没有配中文名`);
  return COVER_LABEL[block];
}

// ---------------------------------------------------------------- 实例名与离线用户名

/** 实例名校验的错误文案，按后端规则码一一对应。leading_dot 是后端额外拒绝的一条，文案按同一语气补写。 */
export const INSTANCE_NAME_ERROR: Readonly<Record<NameRule, string>> = {
  empty: "先给实例起个名字",
  too_long: "名称最多 32 个字",
  illegal_char: '名称里不能有 \\ / : * ? " < > | 这些字符',
  reserved: "这个名字 Windows 不允许用作文件夹名",
  leading_dot: "名称不能以 . 开头",
  duplicate: "已经有同名的实例了，换一个吧",
};

export const OFFLINE_NAME_COPY = {
  /** 未输入时的默认提示。 */
  hint: "推荐 3 到 16 位英文字母、数字或下划线，进服务器时显示的就是它",
  empty: "请输入用户名",
  tooLong: "最多 16 个字符",
  quote: "不能包含双引号",
  duplicate: "已经有同名账户了",
  nonStandard: "含有非标准字符，可能无法进入 1.18 及以上版本的世界和多数服务器",
  tooShort: "少于 3 个字符，多数服务器会拒绝",
  ok: "可以使用",
  submit: "添加并设为当前",
} as const;

// ---------------------------------------------------------------- 启动会话

/** 会话 phase 文案；stopped 按结束原因区分，见 STOPPED_LABEL。 */
export const PHASE_LABEL: Readonly<Record<Exclude<SessionPhase, "stopped">, string>> = {
  preparing: "准备中",
  downloading: "下载中",
  launching: "启动中",
  running: "游戏中",
  failed: "启动失败",
  crashed: "已崩溃",
};

export const STOPPED_LABEL: Readonly<Record<StopReason, string>> = {
  cancelled: "已取消启动",
  exited: "游戏已结束",
  killed: "游戏已结束",
};

export function phaseLabel(phase: SessionPhase, stopReason: StopReason | null): string {
  if (phase !== "stopped") return PHASE_LABEL[phase];
  if (stopReason === null) throw new Error("stopped 会话缺少结束原因");
  return STOPPED_LABEL[stopReason];
}

/** 八个阶段，下标即 session.stageIndex。 */
export const LAUNCH_STAGES = [
  "检查 Java",
  "校验游戏文件",
  "补全库文件",
  "下载缺失文件",
  "解压本地库",
  "生成启动参数",
  "启动游戏进程",
  "游戏运行中",
] as const;

export const SESSION_COPY = {
  downloadProgress: (done: number, total: number, speedBps: number) => `文件 ${done}/${total} · ${formatSpeed(speedBps)}`,
  countingFiles: "正在统计缺失文件…",
  running: (elapsedMs: number) => `已运行 ${formatElapsed(elapsedMs)}`,
  cancelledDetail: "已下载的文件会保留",
  played: (minutes: number) => (minutes < 1 ? "本次游玩不到 1 分钟" : `本次游玩 ${Math.floor(minutes)} 分钟`),
  crashClue: (label: string) => joinMixed("日志指向", label),
  noClue: "没有匹配到已知原因",
  /** 阶段清单里跳过下载时该行右侧的说明。 */
  noDownload: "无需下载",
  stageWarnings: (count: number) => `${count} 条提醒`,
  stopping: "正在结束…",
} as const;

/** 启动入口（胶囊、卡片底栏、侧栏头像副行）的文案。 */
export const LAUNCH_COPY = {
  launch: "启动游戏",
  launchShort: "启动",
  relaunch: "重新启动",
  repairAndLaunch: "修复并启动",
  cancel: "取消启动",
  stopGame: "结束游戏",
  viewCrash: "查看诊断",
  dismiss: "收起",
  crashedTitle: "游戏崩溃了",
  failedTitle: "启动失败",
  runningTitle: (elapsedMs: number) => `游戏中 · ${formatElapsed(elapsedMs)}`,
  queuedTitle: "等待安装",
  queuedDetail: (position: number) => `排队中 · 第 ${position} 位`,
  installingTitle: (pct: string) => `正在安装 ${pct}`,
  busyElsewhere: "另一个游戏在运行",
  group: (name: string) => `启动「${name}」`,
} as const;

/** 侧栏实例名称提示的副行。 */
export const AVATAR_LINE = {
  ready: (lastPlayedAt: number | null, now: number) => (lastPlayedAt === null ? formatRelative(null) : `上次游玩 ${formatRelative(lastPlayedAt, now)}`),
  loading: (phase: "preparing" | "downloading" | "launching", pct: string) => `${PHASE_LABEL[phase]} · ${pct}`,
  running: (elapsedMs: number) => `游戏中 · ${formatElapsed(elapsedMs)}`,
  failed: "启动失败，点开查看",
  crashed: "已崩溃，点开查看诊断",
  queued: (position: number) => `等待安装 · 第 ${position} 位`,
  installing: (pct: string) => `安装中 · ${pct}`,
  broken: "需要修复",
} as const;

// ---------------------------------------------------------------- 启动失败

/** 失败修复动作的种类；按钮行为由启动层按种类执行。 */
export type FailureFixKind = "download_java" | "pick_java" | "auto_java" | "relogin" | "retry" | "open_game_dir" | "repair" | "open_logs";

export interface FailureFix {
  kind: FailureFixKind;
  label: string;
}

export interface FailureCopy {
  /** ≤ 16 字。 */
  title: string;
  body: string;
  fix: FailureFix;
  secondary: FailureFix | null;
}

export interface FailureContext {
  /** 本次启动所用账户的名字。 */
  accountName: string;
  /** 实例设置里固定了 Java 路径（不是 auto）。 */
  javaPinned: boolean;
}

type FailureParams = Readonly<Record<string, string | number>>;

function param(params: FailureParams, key: string, code: FailureCode): string | number {
  const value = params[key];
  if (value === undefined) throw new Error(`启动失败码 ${code} 缺少插值参数 ${key}`);
  return value;
}

function numParam(params: FailureParams, key: string, code: FailureCode): number {
  const value = param(params, key, code);
  if (typeof value !== "number") throw new Error(`启动失败码 ${code} 的参数 ${key} 应为数字，实为 ${String(value)}`);
  return value;
}

function strParam(params: FailureParams, key: string, code: FailureCode): string {
  return String(param(params, key, code));
}

/** 句末补句号；原因原文自己已带句末标点时不重复。 */
function sentence(text: string): string {
  return /[。！？.!?]$/.test(text) ? text : `${text}。`;
}

const RETRY: FailureFix = { kind: "retry", label: "重试" };
const AUTO_JAVA: FailureFix = { kind: "auto_java", label: "改为自动选择" };

export function failureCopy(code: FailureCode, params: FailureParams, ctx: FailureContext): FailureCopy {
  switch (code) {
    case "java_missing": {
      const major = numParam(params, "major", code);
      return {
        title: `找不到 Java ${major}`,
        body: `Minecraft ${strParam(params, "mc_version", code)} 需要 Java ${major}，自动下载已关闭。`,
        fix: { kind: "download_java", label: `下载 Java ${major}` },
        secondary: { kind: "pick_java", label: "选择 Java" },
      };
    }
    case "java_pinned_missing":
      return {
        title: "指定的 Java 不存在",
        body: `实例设置里选的 Java 已经找不到了：${strParam(params, "path", code)}。`,
        fix: AUTO_JAVA,
        secondary: null,
      };
    case "java_too_old": {
      const mc = strParam(params, "mc_version", code);
      return {
        title: `Java ${numParam(params, "current", code)} 无法运行 ${mc}`,
        body: `Minecraft ${mc} 至少需要 Java ${numParam(params, "major", code)}。`,
        fix: AUTO_JAVA,
        secondary: null,
      };
    }
    case "account_relogin":
      return { title: "需要重新登录", body: `${ctx.accountName} 的登录已失效。`, fix: { kind: "relogin", label: "重新登录" }, secondary: null };
    case "account_refresh_network":
      return {
        title: "无法验证微软账户",
        body: "网络连接失败，暂时无法刷新登录。联网后重试；只玩单人游戏的话，可以先切换到离线账户。",
        fix: RETRY,
        secondary: null,
      };
    case "files_offline":
      return { title: "需要联网补全文件", body: `还缺 ${numParam(params, "count", code)} 个文件，当前没有网络连接。`, fix: RETRY, secondary: null };
    case "files_failed":
      return {
        title: `有 ${numParam(params, "count", code)} 个文件下载失败`,
        body: `已在所有下载源上重试过。${sentence(strParam(params, "reason", code))}`,
        fix: RETRY,
        secondary: null,
      };
    case "disk_full":
      return {
        title: "磁盘空间不足",
        body: `${strParam(params, "drive", code)} 还需要 ${formatBytes(numParam(params, "needed_bytes", code))}。`,
        fix: RETRY,
        secondary: { kind: "open_game_dir", label: "打开游戏目录" },
      };
    case "version_broken":
      return {
        title: "版本文件不完整",
        body: "找不到启动入口（mainClass），版本 JSON 可能没有正确合并。",
        fix: { kind: "repair", label: "修复实例" },
        secondary: null,
      };
    case "spawn_failed":
      return {
        title: "游戏进程没能启动",
        body: strParam(params, "message", code),
        fix: { kind: "open_logs", label: "完整日志" },
        secondary: ctx.javaPinned ? { kind: "auto_java", label: "改为自动选择 Java" } : null,
      };
  }
}

// ---------------------------------------------------------------- 崩溃诊断

export const CRASH_CATEGORIES = [
  "java_version_mismatch",
  "out_of_memory",
  "missing_dependency",
  "mixin_failure",
  "duplicate_mod",
  "native_library_missing",
  "graphics_driver",
  "corrupted_jar",
] as const;
export type CrashCategoryName = (typeof CRASH_CATEGORIES)[number];

export interface CrashExplainContext {
  /** 诊断条目的 detail 原文。 */
  detail: string | null;
  /** 这次所用 Java 的主版本。 */
  currentJava: number | null;
  /** 推算出的要求主版本。 */
  requiredJava: number | null;
  /** 这次的最大内存（MB）。 */
  maxMemoryMb: number | null;
}

interface CrashCategoryCopy {
  label: string;
  title: string;
  explain(ctx: CrashExplainContext): string;
}

function need<T>(value: T | null, what: string, category: CrashCategoryName): T {
  if (value === null) throw new Error(`诊断 ${category} 的解释需要 ${what}`);
  return value;
}

export const CRASH_CATEGORY: Readonly<Record<CrashCategoryName, CrashCategoryCopy>> = {
  java_version_mismatch: {
    label: "Java 版本不匹配",
    title: "Java 版本与游戏或 Mod 不匹配",
    explain: (c) =>
      `这次用的是 Java ${need(c.currentJava, "当前 Java 主版本", "java_version_mismatch")}，日志里有内容需要 Java ${need(c.requiredJava, "要求的 Java 主版本", "java_version_mismatch")}。`,
  },
  out_of_memory: {
    label: "内存不足",
    title: "游戏内存不够用了",
    explain: (c) => `这次的最大内存是 ${formatMemory(need(c.maxMemoryMb, "最大内存", "out_of_memory"))}，日志里出现了内存耗尽。`,
  },
  missing_dependency: {
    label: "缺少前置",
    title: "缺少前置 Mod",
    explain: (c) => (c.detail === null ? "日志里有 Mod 缺少前置，或前置的版本不满足要求。" : `日志指向缺少 ${c.detail}。`),
  },
  mixin_failure: {
    label: "Mixin 注入失败",
    title: "Mod 注入失败",
    explain: () => "常见于两个 Mod 互相冲突，或某个 Mod 不支持当前游戏版本。",
  },
  duplicate_mod: {
    label: "重复的 Mod",
    title: "同一个 Mod 装了不止一份",
    explain: (c) => `日志指向 ${need(c.detail, "重复的 Mod 名", "duplicate_mod")} 有多个文件，只需要保留一个版本。`,
  },
  native_library_missing: {
    label: "本地库缺失",
    title: "本地库加载失败",
    explain: () => "游戏需要的本地库没有正确解压或加载。游戏目录路径含中文或特殊字符时也常出现这条线索。",
  },
  graphics_driver: {
    label: "显卡驱动",
    title: "显卡驱动或 OpenGL 不可用",
    explain: () => "游戏没能创建窗口，多半是显卡驱动过旧，或游戏跑在了集成显卡上。",
  },
  corrupted_jar: {
    label: "文件损坏",
    title: "游戏或 Mod 文件损坏",
    explain: () => "有 jar 文件不完整或被改动过。",
  },
};

export function isCrashCategory(value: string): value is CrashCategoryName {
  return (CRASH_CATEGORIES as readonly string[]).includes(value);
}

/**
 * 诊断类别的标签。前后端随同一个安装包发布，出现未知类别说明发布有缺陷：直接抛错交给页面错误边界，不静默回落。
 */
export function crashCategoryLabel(category: string): string {
  if (!isCrashCategory(category)) throw new Error(`未知的崩溃诊断类别：${category}`);
  return CRASH_CATEGORY[category].label;
}

/** 类别列表拼接：A；A与B；A、B与C；A、B等 n 类问题。 */
export function joinCrashLabels(labels: readonly string[]): string {
  if (labels.length === 0) throw new Error("类别列表为空时不应拼接");
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return joinMixed(labels[0], "与", labels[1]);
  if (labels.length === 3) return joinMixed(`${labels[0]}、${labels[1]}`, "与", labels[2]);
  return joinMixed(`${labels[0]}、${labels[1]}`, "等", `${labels.length} 类问题`);
}

export const CRASH_COPY = {
  noClueTitle: "没有匹配到已知原因",
  noClueExplain: "可以对照完整日志排查，崩溃前的警告往往能找到更早的源头。",
  headline: (categories: readonly string[]) =>
    categories.length === 0
      ? "没有匹配到已知原因"
      : joinMixed(`找到 ${categories.length} 条线索，日志指向`, joinCrashLabels(categories.map(crashCategoryLabel))),
  exitLine: (relative: string, exitCode: number | null) => `${relative}崩溃 · ${exitCode === null ? "退出码未知" : `退出码 ${exitCode}`}`,
  clueIndex: (n: number) => `线索 ${n}`,
  /** 一键尝试 · 内存。 */
  raiseMemory: (targetMb: number) => `调到 ${formatMemory(targetMb)}`,
  memoryNote: (currentMb: number, followsGlobal: boolean) =>
    followsGlobal ? `当前最大内存 ${formatMemory(currentMb)}（跟随全局），只改这个实例` : `当前最大内存 ${formatMemory(currentMb)}，只改这个实例`,
  memoryAtCap: (totalMb: number) => `已到建议上限（本机 ${formatMemory(totalMb)} 的一半），可以关闭其他程序，或减少 Mod 与高清资源包`,
  lowerMemory: (targetMb: number) => `调低到 ${formatMemory(targetMb)}`,
  lowerMemoryNote: (currentMb: number) => `本机剩余内存不足以分配 ${formatMemory(currentMb)}`,
  use64BitJava: "改用 64 位 Java",
  openInstanceSettings: "打开实例设置",
} as const;

// ---------------------------------------------------------------- 下载任务

export const TASK_STATUS_LABEL: Readonly<Record<TaskStatus, string>> = {
  queued: "排队中",
  running: "下载中",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

/** 任务类别标签。修复任务补的是游戏文件，归在「游戏」名下。 */
export const TASK_KIND_LABEL: Readonly<Record<TaskKind, string>> = {
  game: "游戏",
  loader: "加载器",
  mod: "Mod",
  modpack: "整合包",
  java: "Java",
  resourcepack: "资源包",
  shader: "光影",
  datapack: "数据包",
  repair: "游戏",
};

function versionWithLoader(mcVersion: string, loader: LoaderKind, loaderVersion: string | null, sep: string): string {
  if (loader === "vanilla") return mcVersion;
  if (loaderVersion === null) throw new Error(`加载器 ${loader} 缺少版本号`);
  return `${mcVersion}${sep}${LOADER_NAME[loader]} ${loaderVersion}`;
}

export const TASK_TEXT = {
  createTitle: (mcVersion: string, loader: LoaderKind, loaderVersion: string | null) => `安装 ${versionWithLoader(mcVersion, loader, loaderVersion, " + ")}`,
  createDetail: (name: string) => `新实例「${name}」`,
  modpackTitle: (name: string) => `导入整合包 ${name}`,
  modpackDetail: (version: string, modCount: number | null) => (modCount === null ? version : `${version} · ${modCount} 个 Mod`),
  repairTitle: (name: string) => `补全「${name}」的游戏文件`,
  repairDetail: (mcVersion: string, loader: LoaderKind, loaderVersion: string | null) => versionWithLoader(mcVersion, loader, loaderVersion, " · "),
  /** 损坏到连游戏版本都读不出来的实例。 */
  repairDetailUnknown: "游戏版本读不出来",
  installTitle: (name: string) => `安装 ${name}`,
  installDetail: (instance: string, dependencies: number) =>
    dependencies > 0 ? `到「${instance}」，含 ${dependencies} 个前置` : `到「${instance}」`,
  updateTitle: (modName: string) => `更新 ${modName}`,
  updateDetail: (from: string, to: string, instance: string) => `${from} → ${to} · 「${instance}」`,
  javaTitle: (major: number) => `下载 Java ${major}`,
  javaDetailPending: "Mojang 运行时 · 手动",
  javaDetail: (version: string) => `Mojang ${version} · 手动`,
  queuePosition: (n: number) => `排队中 · 第 ${n} 位`,
  attempt: (k: number) => `第 ${k} 次尝试`,
} as const;

/** 前端给「上次关闭时中断」的任务用的错误码。 */
export const TASK_INTERRUPTED_CODE = "interrupted";

/** 任务失败原因（行内与 Toast 正文）。能归类的给统一说法，其余用后端原文。 */
export function taskFailureReason(error: { code: string; message: string }): string {
  switch (error.code) {
    case TASK_INTERRUPTED_CODE:
      return `${APP_NAME}关闭时中断`;
    case "network_failed":
      return "网络连接失败";
    case "hash_mismatch":
      return "下载到的文件和官方记录不一致";
    default:
      return error.message;
  }
}

/** 目标实例正在运行时，任务完成 Toast 正文末尾追加。 */
export const NEXT_LAUNCH_SUFFIX = "，下次启动生效";

export const TASK_TOAST = {
  ready: (name: string) => ({ title: `「${name}」已就绪`, body: "可以开始游戏了" }),
  imported: (name: string, modCount: number | null) => (modCount === null ? { title: `「${name}」已导入` } : { title: `「${name}」已导入`, body: `含 ${modCount} 个 Mod` }),
  repaired: (name: string) => ({ title: `「${name}」已修复` }),
  modInstalled: (mod: string, dependencies: number, instance: string) => ({
    title: dependencies > 0 ? `已安装 ${mod} 及 ${dependencies} 个前置` : `已安装 ${mod}`,
    body: `装入「${instance}」`,
  }),
  modUpdated: (mod: string, instance: string) => ({ title: `已更新 ${mod}`, body: `「${instance}」· 旧版本已保留，可以回滚` }),
  resourcePack: (name: string) => ({ title: `已安装资源包 ${name}`, body: "进入游戏后在「选项 → 资源包」里启用" }),
  shader: (name: string, instance: string) => ({ title: `已安装光影 ${name}`, body: `已设为「${instance}」的当前光影` }),
  datapack: (name: string, world: string | null) => ({
    title: `已安装数据包 ${name}`,
    body: world === null ? "这个实例还没有存档，创建新世界时在「数据包」里选择它" : `已放入存档「${world}」`,
  }),
  java: (major: number) => ({ title: `Java ${major} 已就绪`, body: "需要它的实例会自动使用" }),
  /** 从任务日志恢复后重试成功、已没有入队时上下文的任务。 */
  finished: (title: string) => ({ title: `已完成：${title}` }),
  failed: (title: string, reason: string) => ({ title: `下载失败：${title}`, body: reason }),
  failedMany: (count: number, reasons: readonly string[]) => ({
    title: `${count} 个下载失败`,
    body: new Set(reasons).size === 1 ? reasons[0] : "原因各不相同",
  }),
  cancelled: (title: string) => ({ title: `已取消：${title}` }),
  duplicate: (name: string) => ({ title: `${name} 已在下载队列里` }),
  /** 要装的 Mod 连同前置都已在实例里，不入队。 */
  alreadyInstalled: (name: string, instance: string) => ({ title: `${name} 已经装在「${instance}」里了` }),
  enqueued: (name: string, instances: readonly string[]) => ({
    title: `已加入下载队列：${name}`,
    body: instances.length === 1 ? `装入「${instances[0]}」` : `装入 ${instances.length} 个实例，进度见下载任务`,
  }),
  launchAction: "启动",
  retryAction: "重试",
  viewAction: "查看",
} as const;

// ---------------------------------------------------------------- 通知目录

export const TOAST_COPY = {
  crashed: (name: string) => `「${name}」崩溃了`,
  launchFailed: (name: string) => `「${name}」启动失败`,
  stopFailed: "无法结束游戏进程",
  allModsLatest: "所有 Mod 都是最新的",
  modRemoved: (name: string) => `已移除 ${name}`,
  rolledBack: (name: string, from: string, to: string) => ({ title: `已回滚 ${name}`, body: `${to} → ${from}` }),
  cannotRollback: "这条记录不能回滚",
  instanceDeleted: (name: string, worlds: number) =>
    worlds > 0 ? { title: `已删除「${name}」`, body: `${worlds} 个存档已移入回收站` } : { title: `已删除「${name}」` },
  accountDeleted: (name: string) => `已删除账户 ${name}`,
  accountSwitched: (name: string) => `已切换到 ${name}`,
  instanceSelected: (name: string) => ({ title: `「${name}」已设为当前实例`, body: "主页的「继续游玩」会显示它" }),
  settingChanged: (name: string, item: string, value: string) => ({ title: `「${name}」的${item}已改为 ${value}`, body: "下次启动生效" }),
  copyFailed: "复制失败",
  pinLimit: "侧栏最多固定 5 个实例，先取消固定一个",
  loggedIn: (name: string) => `已登录 ${name}`,
  offlineAdded: (name: string) => `已添加离线账户 ${name}`,
  authlibAdded: (name: string, server: string) => ({ title: `已添加 ${name}`, body: `外置登录 · ${server}` }),
  /** 由启动拦截触发的登录或添加账户成功后，Toast 正文。 */
  continuingLaunch: (instance: string) => `正在启动「${instance}」`,
  viewCrashAction: "查看诊断",
} as const;

export function accountKindLabel(kind: AccountKind, authServer: string | null): string {
  if (kind === "microsoft") return "微软账户";
  if (kind === "offline") return "离线账户";
  if (authServer === null) throw new Error("外置登录账户缺少服务器名");
  return `外置登录 · ${authServer}`;
}

/** 外层统一错误处理（useRunner）用的标题：说清「什么没成功」。 */
export const ACTION_ERROR = {
  launch: (name: string) => `「${name}」启动失败`,
  stop: "无法结束游戏进程",
  selectAccount: "没能切换账户",
  removeAccount: "没能删除账户",
  refreshAccount: "没能刷新账户",
  addOffline: "没能添加离线账户",
  microsoftLogin: "没能开始微软登录",
  authlib: "外置登录没有完成",
  createInstance: "没能开始新建实例",
  importModpack: "没能开始导入整合包",
  repair: "没能开始补全游戏文件",
  deleteInstance: (name: string) => `没能删除「${name}」`,
  renameInstance: "没能重命名实例",
  instanceSettings: "实例设置没有保存",
  settings: "设置没有保存",
  gameDirectory: "没能切换游戏目录",
  pin: "侧栏固定没有保存",
  selectInstance: "没能设为当前实例",
  toggleMod: "Mod 开关没有生效",
  removeMod: "没能移除 Mod",
  updateMods: "没能检查 Mod 更新",
  install: "没能加入下载队列",
  rollback: "没能回滚",
  cancelTask: "没能取消任务",
  openFolder: "没能打开文件夹",
  installJava: "没能开始下载 Java",
  servers: "服务器列表没有保存",
  firstRun: "首次设置没有保存",
  saveJournal: "下载任务记录没有保存",
  loadCrash: "崩溃报告读不出来",
  refreshInstances: "实例列表没能刷新",
  refreshAccounts: "账户列表没能刷新",
  artStatus: "原版材质状态读不出来",
  cancelLogin: "没能取消微软登录",
  relogin: "没能重新登录",
  readInstanceSettings: "实例设置读不出来",
  subscribe: "后端事件订阅失败",
  /** 任务本身已完成，完成后的落地（写封面、固定、刷新列表）出错。 */
  landTask: (title: string) => `${title}已完成，后续设置没有写入`,
} as const;

/** 启动时首查各切片失败的通知标题。 */
export const BOOT_SLICE_ERROR = {
  settings: "设置读不出来",
  accounts: "账户列表读不出来",
  instances: "实例列表读不出来",
  pins: "侧栏固定读不出来",
  tasks: "下载任务记录读不出来",
  firstRun: "首次启动状态读不出来",
} as const;

// ---------------------------------------------------------------- 确认对话框

export const CONFIRM_COPY = {
  cancel: "取消",
  keepDownloading: "继续下载",
  deleteInstance: (name: string, worlds: number) => ({
    title: `删除「${name}」？`,
    body:
      worlds > 0
        ? `${worlds} 个存档会移入回收站，Mod、配置和截图会被删除，无法恢复。`
        : "这个实例没有存档。Mod、配置和截图会被删除，无法恢复。",
    confirmLabel: "删除实例",
  }),
  stopGame: (name: string) => ({
    title: "结束游戏？",
    body: `会直接结束「${name}」的游戏进程，没保存的进度可能丢失。正常退出请在游戏菜单里保存并退出。`,
    confirmLabel: "结束游戏",
  }),
  replaceLoading: (next: string, occupant: string) => ({
    title: `改为启动「${next}」？`,
    body: `「${occupant}」还在启动，会先取消它。`,
    confirmLabel: "改为启动",
  }),
  replaceRunning: (next: string, occupant: string) => ({
    title: `结束「${occupant}」并启动「${next}」？`,
    body: `${APP_NAME}同一时间只运行一个游戏。没保存的进度可能丢失，建议先在游戏菜单里保存并退出。`,
    confirmLabel: "结束并启动",
  }),
  cancelCreate: (taskTitle: string, instance: string) => ({
    title: `取消「${taskTitle}」？`,
    body: `「${instance}」还没装好，取消后这个实例会被删除。`,
    confirmLabel: "取消任务",
  }),
  cancelRepair: (taskTitle: string, instance: string) => ({
    title: `取消「${taskTitle}」？`,
    body: `「${instance}」会停在文件不完整的状态，之后可以再点「修复实例」。`,
    confirmLabel: "取消任务",
  }),
  cancelAll: (count: number, creating: number, repairing: number) => {
    const parts: string[] = [];
    if (creating > 0) parts.push(`正在新建的 ${creating} 个实例会被删除`);
    if (repairing > 0) parts.push(`正在修复的 ${repairing} 个实例会保持文件不完整`);
    return {
      title: `取消全部 ${count} 个任务？`,
      body: parts.length > 0 ? `${parts.join("，")}。` : "已下载的部分会被丢弃。",
      confirmLabel: "全部取消",
    };
  },
  closeWithSession: `游戏会继续运行，但之后的日志和崩溃诊断不会被记录。`,
  closeWithTasks: (count: number) => `还有 ${count} 个下载没完成，关闭后会中断，下次打开可以重试。`,
  closeTitle: `关闭${APP_NAME}？`,
  closeConfirm: `关闭${APP_NAME}`,
} as const;

// ---------------------------------------------------------------- 登录

export const MICROSOFT_LOGIN_COPY = {
  fetching: "正在向微软获取登录代码…",
  stepOpen: "打开验证页面",
  copyLink: "复制链接",
  stepCode: "输入下面的代码",
  copyAndOpen: "复制并打开网页",
  waiting: "正在等待你在浏览器里完成登录…",
  expiresIn: (remainingMs: number) => `${formatElapsed(remainingMs)} 后过期`,
  expired: "代码已过期",
  reacquire: "重新获取代码",
  success: (name: string) => `已登录 ${name}`,
  updated: (name: string) => `已更新 ${name} 的登录`,
  setCurrent: "已设为当前账户",
  done: "完成",
  cancel: "取消",
} as const;

/** 前端判定的失败：发起登录后 15 s 内没收到设备码。 */
export const DEVICE_CODE_TIMEOUT_CODE = "device_code_timeout";

export type LoginFailureActionKind = "retry" | "open_xbox" | "use_offline" | "copy_error" | "close";

export interface LoginFailureAction {
  kind: LoginFailureActionKind;
  label: string;
}

export interface LoginFailureCopy {
  title: string;
  body: string | null;
  primary: LoginFailureAction | null;
  secondary: LoginFailureAction | null;
  /** 只剩「关闭」时用幽灵按钮。 */
  closeOnly: boolean;
}

const LOGIN_RETRY: LoginFailureAction = { kind: "retry", label: "重试" };

function xerrOf(detail: unknown): number | null {
  if (typeof detail !== "object" || detail === null) return null;
  const value = (detail as Record<string, unknown>).xerr;
  return typeof value === "number" ? value : null;
}

/** 微软登录失败对照：code 取后端账户错误枚举名；其余一律「微软登录失败」+ 原文与错误码。 */
export function microsoftLoginFailure(code: string, message: string, detail: unknown): LoginFailureCopy {
  const plain = (title: string, body: string | null, primary: LoginFailureAction | null, secondary: LoginFailureAction | null = null) => ({
    title,
    body,
    primary,
    secondary,
    closeOnly: primary === null,
  });
  switch (code) {
    case DEVICE_CODE_TIMEOUT_CODE:
      return plain("无法连接微软登录服务", null, LOGIN_RETRY);
    case "DeviceCodeExpired":
      return plain("代码已过期", "重新获取一个代码再试。", { kind: "retry", label: "重新获取代码" });
    case "AuthorizationDeclined":
      return plain("授权被拒绝了", "你在浏览器里拒绝了这次登录。", { kind: "retry", label: "重新登录" });
    case "Http":
      return plain("网络连接失败", "检查网络后重试。", LOGIN_RETRY);
    case "XstsNoXboxAccount":
      return plain(
        "还没有 Xbox 档案",
        "这个微软账户还没创建 Xbox 档案。先在浏览器登录一次 xbox.com，再回来重试。",
        LOGIN_RETRY,
        { kind: "open_xbox", label: "打开 xbox.com" },
      );
    case "XstsChildAccount":
      return plain("未成年账户需要家长许可", "请家庭组管理员在 Microsoft 家庭中把这个账户加入家庭组，再回来重试。", LOGIN_RETRY);
    case "XstsRegionUnavailable":
      return plain("所在地区不支持 Xbox Live", "这个账户所在的国家或地区无法使用 Xbox Live 服务。", null);
    case "XstsAdultVerificationRequired": {
      const xerr = xerrOf(detail);
      const suffix = xerr === null ? "" : `（XErr ${xerr}）`;
      return plain("需要完成成人身份验证", `先在 Xbox 官网完成身份验证，再回来重试${suffix}。`, LOGIN_RETRY);
    }
    case "XstsBanned":
      return plain("这个 Xbox 账户已被封禁", "无法用它登录 Minecraft（XErr 2148916227）。", null);
    case "MinecraftProfileNotFound":
      return plain(
        "这个账户没有 Minecraft",
        "没有找到 Minecraft Java 版的购买记录或游戏档案。买过的话，先在官方启动器里创建一次档案。",
        LOGIN_RETRY,
        { kind: "use_offline", label: "改用离线账户" },
      );
    default:
      return plain("微软登录失败", `${message}（${code}）`, LOGIN_RETRY, { kind: "copy_error", label: "复制错误信息" });
  }
}

export const LITTLESKIN_API = "https://littleskin.cn/api/yggdrasil";

export const AUTHLIB_COPY = {
  title: "添加外置登录账户",
  serverLabel: "认证服务器地址",
  serverPlaceholder: `例如 ${LITTLESKIN_API}`,
  preset: "LittleSkin",
  httpWarning: "这个地址不是 https，密码会以明文传输",
  next: "下一步",
  unreachable: { title: "连不上这个地址", body: "检查地址是否正确，或稍后重试。" },
  notYggdrasil: { title: "这个地址不是外置登录服务器", body: "需要支持 authlib-injector 的认证服务器地址，皮肤站的说明页里一般会给出。" },
  dropHint: "松开以添加外置登录服务器",
  username: "邮箱或用户名",
  password: "密码",
  passwordNote: `密码只用于这一次登录，${APP_NAME}不会保存`,
  login: "登录",
  badCredentials: "账户或密码不正确",
  network: "网络连接失败",
  retry: "重试",
  pickProfile: "使用这个角色",
  noProfile: { title: "这个账户下还没有角色", body: "先在皮肤站里创建一个角色，再回来登录。" },
} as const;

export const NO_ACCOUNT_COPY = {
  title: "还没有账户",
  body: "启动游戏需要一个账户。正版玩家添加微软账户，单人游戏或离线服务器可以先用离线账户。",
  addOffline: "添加离线账户",
  addMicrosoft: "添加微软账户",
} as const;

// ---------------------------------------------------------------- 实例未完成

type IncompleteInput = {
  kind: "install" | "repair" | "modpack" | "unknown";
  outcome: "pending" | "failed" | "cancelled" | "unknown";
  error: { code: string; message: string } | null;
};

/** 实例未完成标记对应的 brokenReason。 */
export function incompleteReason(incomplete: IncompleteInput): string {
  if (incomplete.error?.code === "marker_unreadable") return `未完成标记读不出来：${incomplete.error.message}`;
  if (incomplete.kind === "unknown" || incomplete.outcome === "unknown") {
    return incomplete.error === null ? "上次安装或补全没有完成，文件不完整" : `上次安装或补全没有完成：${incomplete.error.message}`;
  }
  // 导入半途而废时缺的是整合包里的 Mod 与配置，补全补不回来，只能删掉重新导入。
  if (incomplete.kind === "modpack") return "整合包没有导入完，请删掉这个实例后重新导入";
  const what = incomplete.kind === "install" ? "安装" : "补全";
  switch (incomplete.outcome) {
    case "pending":
      return `${what}没有完成：${APP_NAME}关闭时中断`;
    case "cancelled":
      return incomplete.kind === "install" ? "安装被取消，文件不完整" : "补全被取消，文件仍不完整";
    case "failed":
      return incomplete.error === null ? `${what}没有完成` : `${what}没有完成：${incomplete.error.message}`;
  }
}

// ---------------------------------------------------------------- 删除实例

/**
 * 实例库卡片菜单、头图菜单与实例管理卡共用的删除确认。删除是把实例文件夹移入回收站，
 * 所以正文按「移入回收站」写；存档只数实例文件夹里的（共用 .minecraft/saves 的不随实例删除）。
 */
export const DELETE_INSTANCE_COPY = {
  title: (name: string) => `删除「${name}」？`,
  /** 有存档时正文的三段：前半句、加粗的存档数、带总体积的后半句；其后列出存档名。 */
  worldsLead: "实例文件夹会移入回收站，其中的 ",
  worldsCount: (n: number) => `${n} 个存档`,
  worldsTail: (bytes: number) => `（共 ${formatBytes(bytes)}）也会一起删除：`,
  backupHint: "想留着存档的话，先在概览里打开存档文件夹备份一份。",
  noWorlds: "这个实例没有存档。实例文件夹、Mod 与配置会一起移入回收站。",
  /** 实例上还挂着没完成的任务（新建、导入、补全、装 Mod）时追加：确认后先取消任务再删除。 */
  pendingTask: "正在进行的安装任务会先取消。",
  confirmLabel: (worlds: number) => (worlds > 0 ? `删除实例和 ${worlds} 个存档` : "删除实例"),
} as const;
