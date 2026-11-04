// 流程文案表。页面与组件只 import，不内联；产品名一律取自 app-info。
// 插值一律经 domain/format 格式化；带插值的条目写成函数，参数缺失属于调用方的契约错误，直接抛出。

import type { ExtraLoaderKind } from "../domain/adapt";
import { formatBytes, formatElapsed, formatMemory, formatRelative, formatSpeed } from "../domain/format";
import type { BaseBusyLock, InstanceLock } from "../domain/instance-locks";
import type { AccountKind, FailureCode, InstallPhase, LoaderKind, SessionPhase, StopReason, TaskError, TaskKind, TaskPhase, TaskStatus } from "../domain/types";
import type { CrashSource, ExitCodeKind, ExitCodeNoteDto, LaunchWarningCode } from "../ipc/diagnostics";
import type { NameRule, TemplateSkipReason } from "../ipc/instances";
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

/** 加载持续超过 SLOW_HINT_MS 时在加载态下方追加的一句，各页面与模块共用。 */
export const SLOW_LOADING_HINT = "比平时慢一些，仍在加载…";

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

/** 外部安装器写进版本的附加加载器，写法同上。 */
export const EXTRA_LOADER_NAME: Readonly<Record<ExtraLoaderKind, string>> = {
  optifine: "OptiFine",
  liteloader: "LiteLoader",
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
  empty: "输入用户名",
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

const RUNNING_LABEL = "已运行";

export const SESSION_COPY = {
  downloadProgress: (done: number, total: number, speedBps: number) => `文件 ${done}/${total} · ${formatSpeed(speedBps)}`,
  countingFiles: "正在统计缺失文件…",
  running: (elapsedMs: number) => `${RUNNING_LABEL} ${formatElapsed(elapsedMs)}`,
  /** 单独取出是给状态岛：文字与计时分开放，文字部分才不会每秒变。 */
  runningLabel: RUNNING_LABEL,
  cancelledDetail: "已下载的文件会保留",
  played: (minutes: number) => (minutes < 1 ? "本次游玩不到 1 分钟" : `本次游玩 ${Math.floor(minutes)} 分钟`),
  crashClue: (label: string) => cluePointer([label]),
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
  /** 存档备份或恢复进行中，启动入口的禁用原因。 */
  savesBusy: "正在备份或恢复存档，完成后再启动",
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
  playUnknown: "上次游玩读不到",
} as const;

// ---------------------------------------------------------------- 启动失败

/** 失败修复动作的种类；按钮行为由启动层按种类执行。 */
export type FailureFixKind = "download_java" | "pick_java" | "auto_java" | "auto_default_java" | "relogin" | "retry" | "open_game_dir" | "repair" | "reinstall_loader" | "open_logs" | "launch_offline_once" | "open_client_id_settings";

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
  /** 本次启动所用账户的类型：外置登录账户的故障不是微软的故障。 */
  accountKind: AccountKind;
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
// 实例本来就跟随全局、是全局设置固定了默认 Java：把实例改回自动选择什么也不会变，要改的是默认 Java；
// 只想让这个实例换 Java 的，去实例设置里单独指定。
const AUTO_DEFAULT_JAVA: FailureFix = { kind: "auto_default_java", label: "默认 Java 改回自动" };
const PICK_JAVA: FailureFix = { kind: "pick_java", label: "选择 Java" };
/** 启动失败通知、实例管理卡与修复横幅上同一个说法。 */
export const REINSTALL_LOADER_LABEL = "重新安装加载器";
/** 加载器自带的库缺失：启动失败卡的正文与任务失败原因同一句。 */
const LOADER_LIBRARY_MISSING_REASON = `加载器自带的文件缺失或已损坏，只能由加载器安装器生成，需要${REINSTALL_LOADER_LABEL}`;
/** 只给验证暂时不可用的两个失败码：同一账户立即重新启动，不刷新登录，只保证单人游戏。 */
const OFFLINE_ONCE: FailureFix = { kind: "launch_offline_once", label: "以离线方式进单人" };
/** 启动时续期与登录弹窗碰到的是同一个拒绝，标题、正文与去设置的按钮共用。 */
export const APP_NOT_APPROVED = {
  title: "登录应用未获批准",
  body: `${APP_NAME}使用的微软应用（client_id）还没有获准访问 Minecraft 服务，不是你的账户或网络的问题。可以在「设置 · 常规 · 高级」里换成已获批准的 client_id。`,
  fixLabel: "打开设置",
} as const;
/** 构建时没有内嵌微软登录 client_id（fork 与自行构建）：登录失败卡与各登录入口的不可用原因共用。 */
export const MSA_CLIENT_ID_MISSING = {
  title: "这个版本没有内置微软登录",
  body: `这个版本的${APP_NAME}没有内置微软应用的 client_id，自行构建和 fork 的版本都是这样。在「设置 · 常规 · 高级」里填入你自己注册并获准的 client_id 后就能登录。`,
  reason: "这个版本没有内置微软登录，在设置里填入 client_id 后可用",
  /** 首次启动向导里设置页还去不了。 */
  onboardingReason: "这个版本没有内置微软登录，先走完向导，再到设置里填入 client_id",
  fixLabel: "打开设置",
} as const;

/** 固定的 Java 是实例设置里指定的，还是设置里固定的默认 Java（参数 pinned_by）。 */
function pinnedGlobally(params: FailureParams, code: FailureCode): boolean {
  const by = strParam(params, "pinned_by", code);
  if (by !== "instance" && by !== "global") throw new Error(`启动失败码 ${code} 的参数 pinned_by 不认识：${by}`);
  return by === "global";
}

/** 失败通知的操作只放得下 2 到 4 个字：按钮文案更长的修复动作在这里写短，其余沿用按钮文案。 */
export function failureToastLabel(fix: FailureFix): string {
  switch (fix.kind) {
    case "auto_java":
      return "改为自动";
    case "auto_default_java":
      return "改回自动";
    case "reinstall_loader":
      return "重新安装";
    default:
      return fix.label;
  }
}

export function failureCopy(code: FailureCode, params: FailureParams, ctx: FailureContext): FailureCopy {
  switch (code) {
    case "java_missing": {
      const major = numParam(params, "major", code);
      return {
        title: `找不到 Java ${major}`,
        body: `Minecraft ${strParam(params, "mc_version", code)} 需要 Java ${major}，自动下载已关闭。`,
        fix: { kind: "download_java", label: `下载 Java ${major}` },
        secondary: PICK_JAVA,
      };
    }
    case "java_pinned_missing": {
      const path = strParam(params, "path", code);
      if (pinnedGlobally(params, code)) {
        return { title: "默认 Java 不存在", body: `设置里固定的默认 Java 已经找不到了：${path}。`, fix: AUTO_DEFAULT_JAVA, secondary: PICK_JAVA };
      }
      return { title: "指定的 Java 不存在", body: `实例设置里选的 Java 已经找不到了：${path}。`, fix: AUTO_JAVA, secondary: null };
    }
    case "java_too_old": {
      const mc = strParam(params, "mc_version", code);
      const current = numParam(params, "current", code);
      const title = `Java ${current} 无法运行 ${mc}`;
      const need = `Minecraft ${mc} 至少需要 Java ${numParam(params, "major", code)}`;
      if (pinnedGlobally(params, code)) {
        return { title, body: `${need}，设置里把默认 Java 固定成了 Java ${current}。`, fix: AUTO_DEFAULT_JAVA, secondary: PICK_JAVA };
      }
      return { title, body: `${need}。`, fix: AUTO_JAVA, secondary: null };
    }
    case "account_relogin":
      return { title: "需要重新登录", body: `${ctx.accountName} 的登录已失效。`, fix: { kind: "relogin", label: "重新登录" }, secondary: null };
    // 微软与外置登录账户续期时连不上都走这里，文案不写账户类型
    case "account_refresh_network":
      return {
        title: "无法验证账户",
        body: "网络连接失败，暂时无法刷新登录。联网后重试；只玩单人游戏的话，可以先以离线方式进入。",
        fix: RETRY,
        secondary: OFFLINE_ONCE,
      };
    // 不读插值参数：status 只供排查，缺了也不该让失败卡抛错
    case "account_service_down": {
      const microsoft = ctx.accountKind === "microsoft";
      return {
        title: microsoft ? "微软登录服务暂时不可用" : "登录服务暂时不可用",
        body: `${microsoft ? "微软的" : ""}登录服务出了故障，不是 ${ctx.accountName} 这个账户的问题。稍后重试；想先玩单人游戏，可以选择以离线方式进入。`,
        fix: RETRY,
        secondary: OFFLINE_ONCE,
      };
    }
    // 不给「重试」：同一个 client_id 重试只会得到同样的结果。不给以离线方式进单人：验证不是暂时不可用，后端也不放行
    case "account_app_not_approved":
      return { title: APP_NOT_APPROVED.title, body: APP_NOT_APPROVED.body, fix: { kind: "open_client_id_settings", label: APP_NOT_APPROVED.fixLabel }, secondary: null };
    // 同上：填上 client_id 之前结果不会变，验证也不是暂时不可用
    case "account_client_id_missing":
      return { title: MSA_CLIENT_ID_MISSING.title, body: MSA_CLIENT_ID_MISSING.body, fix: { kind: "open_client_id_settings", label: MSA_CLIENT_ID_MISSING.fixLabel }, secondary: null };
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
        // reason 只有这一个固定值，其余是解析器的原话：文件写坏时说缺 mainClass 就说错了
        body: params.reason === "missing_main_class" ? "找不到启动入口（mainClass），版本 JSON 可能没有正确合并。" : "版本 JSON 读不出来，可能写坏了或被改动过。",
        fix: { kind: "repair", label: "修复实例" },
        secondary: null,
      };
    case "loader_library_missing":
      return { title: "加载器文件缺失", body: sentence(LOADER_LIBRARY_MISSING_REASON), fix: { kind: "reinstall_loader", label: REINSTALL_LOADER_LABEL }, secondary: null };
    case "path_unsupported":
      return {
        title: "路径里有 Java 读不了的字符",
        body: `「${strParam(params, "char", code)}」不在这台电脑的系统编码里，Java 读不了 ${strParam(params, "path", code)}。给实例改个名字或换一个游戏目录，避开这个字符。`,
        fix: { kind: "open_logs", label: "完整日志" },
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

/** 与后端规则的优先级同序；native_crash 只作兜底，排在最后。 */
export const CRASH_CATEGORIES = [
  "manual_debug_crash",
  "java_version_mismatch",
  "out_of_memory",
  "jvm_args_invalid",
  "missing_language_provider",
  "game_version_mismatch",
  "dependency_version_mismatch",
  "missing_dependency",
  "optifine_incompatible",
  "mixin_failure",
  "duplicate_mod",
  "native_library_missing",
  "intel_graphics_driver",
  "graphics_driver",
  "corrupted_jar",
  "loopback_unavailable",
  "native_crash",
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
  /** 这次的退出码。 */
  exitCode: number | null;
  /** 退出码在对照表里时的说明。 */
  exitNote: ExitCodeNoteDto | null;
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

/** Forge 自带的语言支持 id：日志说缺它们时没有可装的 Mod。 */
const FORGE_BUILTIN_PROVIDERS: readonly string[] = ["javafml", "lowcodefml"];

export function isForgeBuiltinProvider(detail: string): boolean {
  return FORGE_BUILTIN_PROVIDERS.includes(detail.toLowerCase());
}

/** 线索与扫描文件的来源名。 */
export const CRASH_SOURCE_LABEL: Readonly<Record<CrashSource, string>> = {
  session_log: "会话日志",
  crash_report: "崩溃报告",
  hs_err: "JVM 错误日志",
  exit_code: "退出码",
};

/** 退出码说明：phrase 用在页头括注与 native_crash 的解释里，explain 是摘要卡退出码行的悬停提示。 */
export const EXIT_CODE_COPY: Readonly<Record<ExitCodeKind, { phrase: string; explain: string }>> = {
  access_violation: {
    phrase: "访问冲突",
    explain: "游戏进程读写了不允许访问的内存，多出现在显卡驱动、Java 本体或带本地库的 Mod 里。",
  },
  stack_buffer_overrun: {
    phrase: "进程紧急中止",
    explain: "进程自己触发了紧急中止，Java 遇到致命错误后常以这个码退出，JVM 错误日志里通常有更多线索。",
  },
  generic_failure: {
    phrase: "报错退出",
    explain: "退出码 1 只说明进程报错退出，具体原因要看日志。",
  },
};

/** detail 是十六进制异常码的写法（来自 JVM 错误头或退出码）。 */
const NATIVE_EXCEPTION_CODE = /^0x[0-9A-F]{8}$/;
const NATIVE_EXCEPTION_KIND: Readonly<Record<string, ExitCodeKind | undefined>> = { "0xC0000005": "access_violation", "0xC0000409": "stack_buffer_overrun" };

/** 手动触发的崩溃不是故障，这句话顶替「日志指向」的句式。 */
const MANUAL_CRASH_NOTE = "这是按住 F3+C 十秒手动触发的崩溃，游戏本身没有问题。";

export const CRASH_CATEGORY: Readonly<Record<CrashCategoryName, CrashCategoryCopy>> = {
  manual_debug_crash: {
    label: "手动触发",
    title: "你认真的吗...?",
    explain: () => MANUAL_CRASH_NOTE,
  },
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
  dependency_version_mismatch: {
    label: "前置版本不对",
    title: "前置 Mod 的版本不对",
    explain: (c) => (c.detail === null ? "日志里有前置 Mod 已经装了，只是版本不对。" : `日志指向 ${c.detail} 已经装了，只是版本不对。`),
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
  missing_language_provider: {
    label: "缺少语言支持",
    title: "Mod 需要的语言支持库没装",
    explain: (c) => {
      if (c.detail === null) return "日志指向有 Mod 缺少语言支持库。";
      // javafml、lowcodefml 是 Forge 自带的语言支持：缺它说明 Mod 是给另一个版本的 Forge 做的，而不是少装了什么
      if (isForgeBuiltinProvider(c.detail)) return `日志指向有 Mod 是给另一个版本的 Forge 做的，它要的是 ${c.detail}。`;
      return `日志指向缺少语言支持库 ${c.detail}，它本身也是一个 Mod。`;
    },
  },
  game_version_mismatch: {
    label: "版本不符",
    title: "Mod 要求别的游戏或加载器版本",
    explain: (c) => (c.detail === null ? "日志里有 Mod 不支持当前的游戏版本或加载器版本。" : `日志指向 ${c.detail} 需要另一个版本的 Minecraft 或加载器。`),
  },
  optifine_incompatible: {
    label: "OptiFine 不兼容",
    title: "OptiFine 与当前加载器不兼容",
    explain: () => "日志指向 OptiFine 与这个实例的加载器版本对不上。OptiFine 只支持特定版本的 Forge，在 Fabric 与 Quilt 上还要另装转接 Mod。",
  },
  native_library_missing: {
    label: "本地库缺失",
    title: "本地库加载失败",
    explain: () => "游戏需要的本地库没有正确解压或加载。游戏目录路径含中文或特殊字符时也常出现这条线索。",
  },
  intel_graphics_driver: {
    label: "Intel 显卡驱动",
    title: "Intel 集成显卡驱动出错",
    explain: (c) =>
      c.detail === null
        ? "日志指向 Intel 集成显卡的驱动。可以先更新驱动，再试试让游戏改用独立显卡。"
        : `日志指向 Intel 集成显卡的驱动文件 ${c.detail}。可以先更新驱动，再试试让游戏改用独立显卡。`,
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
  loopback_unavailable: {
    label: "本机连接失败",
    title: "Java 建不起本机连接",
    explain: () =>
      `用到网络的 Mod 起不来。从 AI 工具、打包版终端这类打包应用里拉起${APP_NAME}时，写进临时目录的文件会被系统重定向，Java 连不上自己。从开始菜单直接打开${APP_NAME}再试，或把环境变量 TEMP 改到 AppData 之外；安全软件拦截时也会这样。`,
  },
  jvm_args_invalid: {
    label: "JVM 参数有误",
    title: "Java 不接受这些 JVM 参数",
    explain: (c) =>
      c.detail === null
        ? "日志指向自定义的 JVM 参数，Java 没能起来。可以到实例设置里改掉或删掉写错的参数再试。"
        : `日志指向 JVM 参数 ${c.detail}，Java 不认它，没能起来。可以到实例设置里改掉或删掉再试。`,
  },
  native_crash: {
    label: "进程异常退出",
    title: "游戏进程异常退出",
    explain: (c) => {
      // JVM 自己接住原生异常时以退出码 1 结束，真正的异常码只在错误头里，这时不能拿 1 来解释
      if (c.detail !== null && NATIVE_EXCEPTION_CODE.test(c.detail) && (c.exitNote === null || c.exitNote.hex !== c.detail)) {
        const kind = NATIVE_EXCEPTION_KIND[c.detail];
        const phrase = kind === undefined ? "" : `（${EXIT_CODE_COPY[kind].phrase}）`;
        return `JVM 记下了异常 ${c.detail}${phrase}，它死在原生代码里，日志里没有更具体的线索。常见于显卡驱动、Java 本体或带本地库的 Mod，可以先更新显卡驱动，再换一个 Java 版本试试。`;
      }
      const code = need(c.exitCode, "退出码", "native_crash");
      const note = need(c.exitNote, "退出码说明", "native_crash");
      if (note.code !== code) throw new Error(`退出码说明 ${note.code} 与退出码 ${code} 对不上`);
      return `退出码 ${note.hex}（${EXIT_CODE_COPY[note.kind].phrase}），日志里没有匹配到已知原因。常见于显卡驱动、Java 本体或带本地库的 Mod，可以先更新显卡驱动，再换一个 Java 版本试试。`;
    },
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

/**
 * 崩溃通用句式的主干：「日志指向 A 与 B」。native_crash 是退出码兜底，不来自任何一行日志，
 * 线索只有它时写「退出码指向」，否则紧接着的解释「日志里没有匹配到已知原因」就和这句对不上。
 */
export function cluePointer(labels: readonly string[]): string {
  const onlyExitCode = labels.every((label) => label === CRASH_CATEGORY.native_crash.label);
  return joinMixed(onlyExitCode ? "退出码指向" : "日志指向", joinCrashLabels(labels));
}

/** 会话副行与崩溃通知的一句话线索。手动触发的崩溃是玩家自己按出来的，不走「日志指向」的句式。 */
export function crashClueLine(category: CrashCategoryName): string {
  return category === "manual_debug_crash" ? CRASH_CATEGORY.manual_debug_crash.title : SESSION_COPY.crashClue(crashCategoryLabel(category));
}

export const CRASH_COPY = {
  manualNote: MANUAL_CRASH_NOTE,
  noClueTitle: "没有匹配到已知原因",
  noClueExplain: "可以对照完整日志排查，崩溃前的警告往往能找到更早的源头。",
  headline: (categories: readonly string[]) =>
    categories.length === 0 ? "没有匹配到已知原因" : `找到 ${categories.length} 条线索，${cluePointer(categories.map(crashCategoryLabel))}`,
  exitLine: (relative: string, exitCode: number | null, note: ExitCodeNoteDto | null) => {
    if (exitCode === null) return `${relative}崩溃 · 退出码未知`;
    if (note === null) return `${relative}崩溃 · 退出码 ${exitCode}`;
    if (note.code !== exitCode) throw new Error(`退出码说明 ${note.code} 与退出码 ${exitCode} 对不上`);
    return `${relative}崩溃 · 退出码 ${exitCode}（${note.hex} ${EXIT_CODE_COPY[note.kind].phrase}）`;
  },
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

// ---------------------------------------------------------------- 启动提醒

/** 后端的启动提醒全集（按启动阶段的先后）。诊断页按报告里记下的顺序展示。 */
export const LAUNCH_WARNING_CODES = [
  "game_path",
  "instance_name",
  "onedrive_folder",
  "icloud_folder",
  "long_player_name",
  "jvm_memory_unit",
  "jvm_min_over_max",
  "jvm_max_too_low",
] as const satisfies readonly LaunchWarningCode[];

/** 提醒上的动作：更换游戏目录去设置的「游戏」分区，重命名实例在头图就地改名，管理账户去账户页，打开实例设置切到实例的「设置」标签。 */
export type LaunchWarningActionKind = "change_game_dir" | "rename_instance" | "manage_accounts" | "instance_settings";

export interface LaunchWarningCopy {
  title: string;
  body: string;
  action: { kind: LaunchWarningActionKind; label: string };
}

const CHANGE_GAME_DIR = { kind: "change_game_dir", label: "更换游戏目录" } as const;
const OPEN_INSTANCE_SETTINGS = { kind: "instance_settings", label: CRASH_COPY.openInstanceSettings } as const;

/** 启动提醒不中断启动：加载时只写 warn 日志，崩溃后在诊断页的「这次启动时的提醒」里按这张表呈现。 */
export const LAUNCH_WARNING: Readonly<Record<LaunchWarningCode, LaunchWarningCopy>> = {
  // 后端只在这个版本真受影响时才记这两条，受影响的原因不止一种，这里不点名加载器
  game_path: {
    title: "游戏目录含中文或特殊字符",
    body: "这个版本在这样的路径下可能读不出文件，可以换到纯英文路径再试。",
    action: CHANGE_GAME_DIR,
  },
  instance_name: {
    title: "实例名含中文或特殊字符",
    body: "实例目录用的就是这个名字，这个版本在这样的路径下可能读不出文件，可以改成纯英文名字再试。",
    action: { kind: "rename_instance", label: "重命名实例" },
  },
  onedrive_folder: {
    title: "游戏目录在 OneDrive 里",
    body: "OneDrive 同步时会占用或替换正在读写的文件，存档与 Mod 可能读不全。可以换一个不在 OneDrive 里的游戏目录。",
    action: CHANGE_GAME_DIR,
  },
  icloud_folder: {
    title: "游戏目录在 iCloud 里",
    body: "iCloud 同步时会占用或替换正在读写的文件，存档与 Mod 可能读不全。可以换一个不在 iCloud 里的游戏目录。",
    action: CHANGE_GAME_DIR,
  },
  long_player_name: {
    title: "角色名超过 16 个字符",
    body: "Minecraft 1.20.3 及更新的版本进不了存档与服务器。可以到皮肤站换一个不超过 16 个字符的角色名。",
    action: { kind: "manage_accounts", label: "管理账户" },
  },
  jvm_memory_unit: {
    title: "JVM 参数里的内存写法不对",
    body: "-Xmx、-Xms 的数字后面只能跟 k、m、g、t，例如 -Xmx4g。",
    action: OPEN_INSTANCE_SETTINGS,
  },
  jvm_min_over_max: {
    title: "最小内存大于最大内存",
    body: "JVM 参数里 -Xms 比 -Xmx 大，Java 会拒绝启动。",
    action: OPEN_INSTANCE_SETTINGS,
  },
  jvm_max_too_low: {
    title: "最大内存低于 512 MB",
    body: "游戏多半进不了主界面，可以调高 -Xmx，或删掉它改用内存设置。",
    action: OPEN_INSTANCE_SETTINGS,
  },
};

/** 与崩溃类别同理：前后端随同一个安装包发布，出现未知的提醒说明发布有缺陷，直接抛错交给页面错误边界。 */
export function launchWarningCopy(code: string): LaunchWarningCopy {
  if (!(LAUNCH_WARNING_CODES as readonly string[]).includes(code)) throw new Error(`未知的启动提醒：${code}`);
  return LAUNCH_WARNING[code as LaunchWarningCode];
}

// ---------------------------------------------------------------- 下载任务

export const TASK_STATUS_LABEL: Readonly<Record<TaskStatus, string>> = {
  queued: "排队中",
  running: "下载中",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

/** 这几类运行时在本地读写，不是在下载。 */
const LOCAL_RUNNING_LABEL: Readonly<Partial<Record<TaskKind, string>>> = {
  modpack_export: "打包中",
  world_backup: "打包中",
  world_restore: "恢复中",
};

/** 一个任务此刻的状态标签：显示任务状态的地方都用它，不直接取 TASK_STATUS_LABEL。 */
export function taskStatusLabel(task: { kind: TaskKind; status: TaskStatus }): string {
  const local = task.status === "running" ? LOCAL_RUNNING_LABEL[task.kind] : undefined;
  return local === undefined ? TASK_STATUS_LABEL[task.status] : local;
}

/** 任务类别标签。修复任务补的是游戏文件，归在「游戏」名下；备份、导出与恢复都归在「存档」名下。 */
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
  world_backup: "存档",
  world_restore: "存档",
  modpack_export: "导出",
};

function versionWithLoader(mcVersion: string, loader: LoaderKind, loaderVersion: string | null, sep: string): string {
  if (loader === "vanilla") return mcVersion;
  if (loaderVersion === null) throw new Error(`加载器 ${loader} 缺少版本号`);
  return `${mcVersion}${sep}${LOADER_NAME[loader]} ${loaderVersion}`;
}

/** 任务详情里写实例名的写法。改名时 renamedDetail 靠它认出句子里的实例名，两边必须是同一种写法。 */
const instanceMention = (name: string): string => `「${name}」`;

export const TASK_TEXT = {
  createTitle: (mcVersion: string, loader: LoaderKind, loaderVersion: string | null) => `安装 ${versionWithLoader(mcVersion, loader, loaderVersion, " + ")}`,
  createDetail: (name: string) => `新实例${instanceMention(name)}`,
  modpackTitle: (name: string) => `导入整合包 ${name}`,
  modpackDetail: (version: string, modCount: number | null) => (modCount === null ? version : `${version} · ${modCount} 个 Mod`),
  repairTitle: (name: string) => `补全「${name}」的游戏文件`,
  reinstallLoaderTitle: (name: string) => `重新安装「${name}」的加载器`,
  /** 只靠主类探测到的加载器读不出版本号：有几个写几个，这时修复入口不能因为一句详情而走不通。 */
  repairDetail: (mcVersion: string, loader: LoaderKind, loaderVersion: string | null) =>
    loader !== "vanilla" && loaderVersion === null ? `${mcVersion} · ${LOADER_NAME[loader]}` : versionWithLoader(mcVersion, loader, loaderVersion, " · "),
  /** 损坏到连游戏版本都读不出来的实例。 */
  repairDetailUnknown: "游戏版本读不出来",
  installTitle: (name: string) => `安装 ${name}`,
  installDetail: (instance: string, dependencies: number) =>
    dependencies > 0 ? `到${instanceMention(instance)}，含 ${dependencies} 个前置` : `到${instanceMention(instance)}`,
  updateTitle: (modName: string) => `更新 ${modName}`,
  updateDetail: (from: string, to: string, instance: string) => `${from} → ${to} · ${instanceMention(instance)}`,
  updateAllTitle: (count: number) => `更新 ${count} 个 Mod`,
  updateAllDetail: instanceMention,
  /** 更新任务的详情后面跟上没有照办的前置：通知会消失，这里留一份全文。 */
  updateDetailWithDeps: (detail: string, deps: string) => `${detail} · ${deps}`,
  /** 新实例就绪后接着装的开局 Mod（一个组合任务）。 */
  starterTitle: (count: number) => `装上 ${count} 个开局 Mod`,
  starterDetail: instanceMention,
  javaTitle: (major: number) => `下载 Java ${major}`,
  javaDetailPending: "Mojang 运行时 · 手动",
  javaDetail: (version: string) => `Mojang ${version} · 手动`,
  backupTitle: (world: string) => `备份「${world}」`,
  exportWorldTitle: (world: string) => `导出「${world}」`,
  restoreTitle: (world: string) => `恢复「${world}」`,
  /** 备份、导出与恢复任务的详情：存档属于哪个实例。 */
  backupDetail: instanceMention,
  exportTitle: (name: string) => `导出整合包 ${name}`,
  exportDetail: (version: string, instance: string) => `${version} · ${instanceMention(instance)}`,
  /**
   * 实例改名后的详情：只换句子里的实例名。详情是写进任务日志的整句文案，版本号与前置数没有全都留在命令参数里，
   * 重启恢复的任务也没有入队上下文，所以不能按新名字重新生成。
   */
  renamedDetail: (detail: string, from: string, to: string) => detail.split(instanceMention(from)).join(instanceMention(to)),
  queuePosition: (n: number) => `排队中 · 第 ${n} 位`,
  attempt: (k: number) => `第 ${k} 次尝试`,
} as const;

/** 新建、补全实例的各步；键与后端 InstallPhase::key 一致。「校验游戏文件」「解压本地库」与启动阶段表同一说法。 */
export const INSTALL_PHASE_LABEL: Readonly<Record<InstallPhase, string>> = {
  metadata: "获取版本信息",
  loader_profile: "获取加载器信息",
  libraries: "下载游戏本体与库文件",
  assets: "下载资源文件",
  natives: "解压本地库",
  java: "准备 Java",
  loader_installer: "下载加载器安装器",
  loader_libraries: "下载加载器的库文件",
  loader_processors: "执行加载器安装器",
  verify: "校验游戏文件",
  template: "沿用默认设置",
};

/** 分步任务当前在第几步。long 用在横幅这类整句处，short 用在胶囊、任务行这类窄处。 */
export function taskPhaseText(phase: Pick<TaskPhase, "plan" | "index">, form: "long" | "short"): string {
  const key = phase.plan[phase.index];
  if (key === undefined) throw new Error(`步骤下标 ${phase.index} 超出步骤表 ${phase.plan.join()}`);
  const at = phase.index + 1;
  const count = phase.plan.length;
  const label = INSTALL_PHASE_LABEL[key];
  return form === "long" ? `第 ${at} 步，共 ${count} 步：${label}` : `${label} · 第 ${at}/${count} 步`;
}

/** 前端给「上次关闭时中断」的任务用的错误码。 */
export const TASK_INTERRUPTED_CODE = "interrupted";

/** 任务失败原因（行内与 Toast 正文）。能归类的给统一说法，其余用后端原文。 */
export function taskFailureReason(error: TaskError): string {
  switch (error.code) {
    case TASK_INTERRUPTED_CODE:
      return `${APP_NAME}关闭时中断`;
    case "network_failed":
      return "网络连接失败";
    case "hash_mismatch":
      return "下载到的文件和官方记录不一致";
    case "install_unsafe_path":
      return "版本文件里有指向游戏目录之外的路径，已拒绝写入";
    case "loader_library_missing":
      return LOADER_LIBRARY_MISSING_REASON;
    case "curseforge_key_rejected":
      return "CurseForge 拒绝了下载密钥。设置环境变量 PETALFALL_CURSEFORGE_API_KEY 换一个可用的密钥后重试";
    case "curseforge_key_missing":
      return "有文件只能从 CurseForge 下载，需要先设置环境变量 PETALFALL_CURSEFORGE_API_KEY";
    case "distribution_blocked":
      // 较早的任务日志只存了错误码与原文（原文里列着文件名），没有清单时照原文给出
      return error.blocked_files === undefined ? error.message : `有 ${error.blocked_files.length} 个文件需要到 CurseForge 网页手动下载`;
    case "modpack_unsupported_compression":
      return "整合包用了不支持的压缩方式，用整合包作者发布的原始文件再试";
    case "world_in_use":
      return "这个存档正被游戏打开";
    case "world_backup_corrupt":
      return "备份文件已损坏，无法恢复";
    case "world_backup_not_found":
      return "这份备份已经不在了";
    // 原存档已进回收站、恢复出的副本留在临时目录：两个位置都在后端原文里，统一说法会把它们丢掉
    case "world_restore_incomplete":
      return error.message;
    case "modpack_export_check_failed":
      return "导出的文件没通过校验，已删除";
    default:
      return error.message;
  }
}

/** 目标实例正在运行时，任务完成 Toast 正文末尾追加。 */
export const NEXT_LAUNCH_SUFFIX = "，下次启动生效";

const ALL_MODS_LATEST = "所有 Mod 都是最新的";

/** 安装时没有套上默认设置的原因（通知正文）。 */
const TEMPLATE_SKIP_REASON: Readonly<Record<TemplateSkipReason, string>> = {
  disabled: "新建实例时沿用默认设置已在配置里关闭",
  empty: "安装时没有找到默认设置，可能已被清除",
  shared_working_dir: "这个实例与其他未隔离的实例共用 .minecraft 里的设置",
};

export const TASK_TOAST = {
  ready: (name: string) => ({ title: `「${name}」已就绪`, body: "可以启动游戏了" }),
  imported: (name: string, modCount: number | null) => (modCount === null ? { title: `「${name}」已导入` } : { title: `「${name}」已导入`, body: `含 ${modCount} 个 Mod` }),
  repaired: (name: string) => ({ title: `「${name}」已修复` }),
  loaderReinstalled: (name: string) => ({ title: `「${name}」的加载器已重新安装` }),
  /** 重试「关闭时中断」的新建时，发现它在中断之前已经装完了。 */
  installFinishedBeforeInterrupt: (name: string) => ({ title: `「${name}」已经装好了` }),
  modInstalled: (mod: string, dependencies: number, instance: string) => ({
    title: dependencies > 0 ? `已安装 ${mod} 及 ${dependencies} 个前置` : `已安装 ${mod}`,
    body: `装入「${instance}」`,
  }),
  modUpdated: (mod: string, instance: string) => ({ title: `已更新 ${mod}`, body: `「${instance}」· 旧版本已保留，可以回滚` }),
  modsUpdated: (count: number, instance: string) => ({ title: `已更新 ${count} 个 Mod`, body: `「${instance}」· 旧版本已保留，可以回滚` }),
  /** 更新不走确认计划：新版本要的必需前置没有照办时，完成通知之后补一条，正文写后端原文。 */
  updateDepsSkipped: (instance: string, notes: readonly string[]) => ({ title: `「${instance}」有 ${notes.length} 个前置要留意`, body: notes.join("；") }),
  /** 「全部更新」重试时，上一次已经全部换好（或玩家另行更新、移除了），这一次没有要换的。 */
  modsAlreadyLatest: (instance: string) => ({ title: ALL_MODS_LATEST, body: `「${instance}」` }),
  resourcePack: (name: string) => ({ title: `已安装资源包 ${name}`, body: "进入游戏后在「选项 → 资源包」里启用" }),
  shader: (name: string, instance: string) => ({ title: `已安装光影 ${name}`, body: `已设为「${instance}」的当前光影` }),
  datapack: (name: string, world: string | null) => ({
    title: `已安装数据包 ${name}`,
    body: world === null ? "这个实例还没有存档，创建新世界时在「数据包」里选择它" : `已放入存档「${world}」`,
  }),
  java: (major: number) => ({ title: `Java ${major} 已就绪`, body: "需要它的实例会自动使用" }),
  /** 下载完已固定给某个实例（崩溃诊断里的「下载 Java N」）。 */
  javaPinned: (major: number, instance: string) => ({ title: `Java ${major} 已就绪`, body: `「${instance}」下次启动会用它` }),
  /** 从任务日志恢复后重试成功、已没有入队时上下文的任务。 */
  finished: (title: string) => ({ title: `已完成：${title}` }),
  failed: (title: string, reason: string) => ({ title: `下载失败：${title}`, body: reason }),
  /** 补全不止下载：还要解压、校验、跑安装器，标题不说下载。 */
  repairFailed: (title: string, reason: string) => ({ title: `${title}没有完成`, body: reason }),
  /** 导入同样不止下载，还可能没开工就被占用拒绝。名字用实例名，与开始、完成通知一致；任务标题写的是整合包自己的名字。 */
  importFailed: (instance: string, reason: string) => ({ title: `导入「${instance}」没有完成`, body: reason }),
  exportStarted: (name: string) => ({ title: `已开始导出「${name}」`, body: "进度见下载任务" }),
  /** bundled：打包进文件的 Mod 数；没有时不写正文。 */
  exported: (name: string, bundled: number) =>
    bundled > 0 ? { title: `已导出「${name}」`, body: `${bundled} 个 Mod 打包进了文件，分享前确认作者允许转载` } : { title: `已导出「${name}」` },
  exportFailed: (title: string, reason: string) => ({ title: `导出失败：${title}`, body: reason }),
  failedMany: (count: number, reasons: readonly string[]) => ({
    title: `${count} 个下载失败`,
    body: new Set(reasons).size === 1 ? reasons[0] : "原因各不相同",
  }),
  cancelled: (title: string) => ({ title: `已取消：${title}` }),
  /** 备份、导出、恢复存档的任务失败：它们不是下载，不并进「n 个下载失败」。 */
  worldFailed: (title: string, reason: string) => ({ title: `${title}没有完成`, body: reason }),
  backupStarted: (world: string) => ({ title: `已开始备份「${world}」`, body: "进度见下载任务" }),
  worldBackedUp: (world: string, size: number, pruned: number) => ({
    title: `已备份「${world}」`,
    body: pruned > 0 ? `${formatBytes(size)} · 清理了 ${pruned} 份旧的自动备份` : formatBytes(size),
  }),
  worldExported: (world: string, path: string) => ({ title: `已导出「${world}」`, body: path }),
  worldRestored: (world: string, previousInRecycleBin: boolean) =>
    previousInRecycleBin ? { title: `已恢复「${world}」`, body: "原来的存档已移入回收站" } : { title: `已恢复「${world}」` },
  viewBackupsAction: "查看备份",
  openContainingAction: "打开所在文件夹",
  duplicate: (name: string) => ({ title: `${name} 已在下载队列里` }),
  starterInstalled: (instance: string, count: number) => ({ title: `已给「${instance}」装上 ${count} 个 Mod` }),
  /** 新建时勾了沿用默认设置、安装结果却是跳过：就绪通知之后补一条，正文说原因。 */
  templateSkipped: (instance: string, reason: TemplateSkipReason) => ({ title: `「${instance}」没有沿用默认设置`, body: TEMPLATE_SKIP_REASON[reason] }),
  /** 要装的 Mod 连同前置都已在实例里，不入队。 */
  alreadyInstalled: (name: string, instance: string) => ({ title: `${name} 已经装在「${instance}」里了` }),
  enqueued: (name: string, instances: readonly string[]) => ({
    title: `已加入下载队列：${name}`,
    body: instances.length === 1 ? `装入「${instances[0]}」` : `装入 ${instances.length} 个实例，进度见下载任务`,
  }),
  launchAction: "启动",
  /** 在资源管理器里选中刚生成的文件。 */
  revealAction: "打开所在文件夹",
  retryAction: "重试",
  viewAction: "查看",
} as const;

// ---------------------------------------------------------------- 通知目录

export const TOAST_COPY = {
  crashed: (name: string) => `「${name}」崩溃了`,
  launchFailed: (name: string) => `「${name}」启动失败`,
  stopFailed: "无法结束游戏进程",
  allModsLatest: ALL_MODS_LATEST,
  modRemoved: (name: string) => `已移除 ${name}`,
  modsEnabled: (count: number) => `已启用 ${count} 个 Mod`,
  modsDisabled: (count: number) => ({ title: `已停用 ${count} 个 Mod`, body: "文件名后加了 .disabled，随时可以再启用" }),
  modsToggleFailed: (count: number, enabled: boolean) => (enabled ? `${count} 个 Mod 没能启用` : `${count} 个 Mod 没能停用`),
  modAdded: (fileName: string) => `已添加 ${fileName}`,
  modsAdded: (count: number) => `已添加 ${count} 个 Mod`,
  modsAddFailed: (added: number, failed: number) => (added === 0 ? `${failed} 个 Mod 没能添加` : `已添加 ${added} 个 Mod，${failed} 个没能添加`),
  modsRemoved: (count: number) => `已移除 ${count} 个 Mod`,
  modsRemoveFailed: (count: number) => `${count} 个 Mod 没能移除`,
  /** 批量动作里失败的几项原因不止一种时的正文；只有一种时直接写后端原文。 */
  mixedReasons: "原因各不相同",
  updateIgnored: (name: string) => ({ title: `已忽略 ${name} 的更新`, body: "检查更新时会跳过它，可以在更多菜单里恢复" }),
  updateRestored: (name: string) => `已恢复检查 ${name} 的更新`,
  rolledBack: (name: string, from: string, to: string) => ({ title: `已回滚 ${name}`, body: `${to} → ${from}` }),
  cannotRollback: "这条记录不能回滚",
  instanceDeleted: (name: string, worlds: number) =>
    worlds > 0 ? { title: `已删除「${name}」`, body: `${worlds} 个存档已移入回收站` } : { title: `已删除「${name}」` },
  playRecordsLagging: (name: string) => ({ title: `「${name}」的游玩记录没能跟着改`, body: "之后会自动补上" }),
  accountDeleted: (name: string) => `已删除账户 ${name}`,
  accountSwitched: (name: string) => `已切换到 ${name}`,
  instanceSelected: (name: string) => ({ title: `「${name}」已设为当前实例`, body: "主页的「继续游玩」会显示它" }),
  settingChanged: (name: string, item: string, value: string) => ({ title: joinMixed(`「${name}」的`, item, `已改为 ${value}`), body: "下次启动生效" }),
  networkRestored: (failed: number) => (failed === 0 ? { title: "网络已恢复" } : { title: "网络已恢复", body: `有 ${failed} 个下载失败` }),
  retryAllAction: "全部重试",
  copyFailed: "复制失败",
  pinLimit: "侧栏最多固定 5 个实例，先取消固定一个",
  loggedIn: (name: string) => `已登录 ${name}`,
  offlineAdded: (name: string) => `已添加离线账户 ${name}`,
  authlibAdded: (name: string, server: string) => ({ title: `已添加 ${name}`, body: `外置登录 · ${server}` }),
  /** 由启动拦截触发的登录或添加账户成功后，Toast 正文。 */
  continuingLaunch: (instance: string) => `正在启动「${instance}」`,
  templateSaved: (instance: string) => ({ title: `已把「${instance}」的设置保存为默认`, body: "新建实例时可以在确认步沿用" }),
  templateCleared: "已清除默认设置",
  /** 失败卡上选了「以离线方式进单人」，游戏起来之后。 */
  offlineLaunched: (name: string) => ({ title: `「${name}」以离线方式启动`, body: "这一局只能玩单人游戏，多人服务器与 Realms 用不了" }),
  viewCrashAction: "查看诊断",
  /** 游戏退出后的自动备份有存档没备份成：正文是第一个失败存档的后端原文。 */
  autoBackupFailed: (instance: string, message: string) => ({ title: `「${instance}」的自动备份没有完成`, body: message }),
  /** 改名已完成，存档备份还留在旧名下。 */
  backupsNotMoved: (name: string, path: string) => ({ title: `「${name}」的存档备份没能跟着改名`, body: `备份还在 ${path}` }),
  backupDeleted: { title: "已删除一份备份", body: "已移入回收站" },
  /** 关闭前启动的游戏还在运行，这次打开后接了回来。 */
  gameReattached: (name: string) => `已接回还在运行的「${name}」`,
  /** 上次关闭前在跑的那局游戏的记录读不出来：后端把它改名留存到 movedTo，改名也失败时为 null，记录还在 path。 */
  brokenGameRecord: (path: string, movedTo: string | null) => ({
    title: "上次关闭前那局游戏的记录读不出来",
    body: `${movedTo === null ? `记录没能移走，还在 ${path}` : `记录已移到 ${movedTo}`}，这一局的游玩时长与崩溃诊断不会补记`,
  }),
  copyErrorAction: "复制错误信息",
  openFolderAction: "打开文件夹",
} as const;

export function accountKindLabel(kind: AccountKind, authServer: string | null): string {
  if (kind === "microsoft") return "微软账户";
  if (kind === "offline") return "离线账户";
  if (authServer === null) throw new Error("外置登录账户缺少服务器名");
  return `外置登录 · ${authServer}`;
}

/** 外层统一错误处理（useRunner）用的标题：说清「什么没成功」。 */
export const ACTION_ERROR = {
  discardExportLeftovers: "没能清理上次没写完的导出文件",
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
  exportModpack: "没能开始导出整合包",
  revealExport: "没能打开导出文件所在的文件夹",
  repair: "没能开始补全游戏文件",
  reinstallLoader: `没能开始${REINSTALL_LOADER_LABEL}`,
  deleteInstance: (name: string) => `没能删除「${name}」`,
  renameInstance: "没能重命名实例",
  instanceSettings: "实例设置没有保存",
  settings: "设置没有保存",
  gameDirectory: "没能切换游戏目录",
  pin: "侧栏固定没有保存",
  selectInstance: "没能设为当前实例",
  toggleMod: "Mod 开关没有生效",
  addMod: "没能添加 Mod",
  removeMod: "没能移除 Mod",
  updateMods: "没能检查 Mod 更新",
  updateHold: "更新检查设置没有保存",
  install: "没能加入下载队列",
  probeNetwork: "没能检测网络连接",
  rollback: "没能回滚",
  saveTemplate: "没能保存默认设置",
  clearTemplate: "没能清除默认设置",
  cancelTask: "没能取消任务",
  openFolder: "没能打开文件夹",
  backupWorld: "没能开始备份存档",
  restoreWorld: "没能开始恢复存档",
  exportWorld: "没能开始导出存档",
  deleteWorldBackup: "没能删除这份备份",
  installJava: "没能开始下载 Java",
  dedicatedGpu: "没能改用独立显卡",
  servers: "服务器列表没有保存",
  firstRun: "首次设置没有保存",
  saveJournal: "下载任务记录没有保存",
  loadCrash: "崩溃报告读不出来",
  /** 开机时问后端有没有还在运行的游戏，没问出结果。 */
  recoverGame: "没能接回还在运行的游戏",
  /** 接回的一局，接回之前的日志没能垫进日志面板。 */
  backfillSessionLog: "这一局接回之前的日志读不出来",
  refreshInstances: "实例列表没能刷新",
  refreshAccounts: "账户列表没能刷新",
  artStatus: "原版材质状态读不出来",
  cancelLogin: "没能取消微软登录",
  relogin: "没能重新登录",
  readInstanceSettings: "实例设置读不出来",
  subscribe: "后端事件订阅失败",
  /** 任务本身已完成，完成后的落地（写封面、固定、刷新列表）出错。 */
  landTask: (title: string) => joinMixed(title, "已完成，后续设置没有写入"),
} as const;

/** 切换游戏目录：设置页的其他文件夹、实例库的目录选择与空状态走同一个流程，说法也是同一套。 */
export const GAME_DIR_SWITCH_COPY = {
  busyReason: "有游戏或下载在进行，结束后再切换",
  unavailableReason: "位置访问不到，无法切过去",
  bangError: "路径里不能有「!」，Java 会读不出里面的游戏文件",
  confirmTitle: (name: string) => `切换到「${name}」？`,
  confirmBody: "实例库会换成这个目录里的实例，原目录的文件不会被移动或删除。",
  confirmLabel: "切换",
  emptyTitle: "这个目录还没有实例",
  emptyBody: (name: string, versions: number) => `「${name}」里有 ${versions} 个版本，切过去就能玩，文件不会被移动。`,
  emptyAction: (name: string) => joinMixed("切到", name),
} as const;

/** 此刻切不到这个目录的原因，可以直接交给 disabledReason；能切时为 undefined。先说进行中的游戏与任务：等它们结束就能切。 */
export function gameDirSwitchReason(busy: boolean, available: boolean): string | undefined {
  if (busy) return GAME_DIR_SWITCH_COPY.busyReason;
  return available ? undefined : GAME_DIR_SWITCH_COPY.unavailableReason;
}

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

/** 放进「」里的文字：任务标题自己带直角引号（补全「生存」的游戏文件）时，内层换成『』。 */
function quoted(text: string): string {
  return `「${text.replaceAll("「", "『").replaceAll("」", "』")}」`;
}

export const CONFIRM_COPY = {
  cancel: "取消",
  keepDownloading: "继续下载",
  /** 被取消的都不是下载时的取消键：写「继续下载」就说错了在做的事。 */
  keepTasks: "不取消",
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
  occupantGone: (next: string, occupant: string) => ({
    title: `启动「${next}」？`,
    body: `「${occupant}」已经退出了。`,
    confirmLabel: "启动",
  }),
  cancelCreate: (taskTitle: string, instance: string) => ({
    title: `取消${quoted(taskTitle)}？`,
    body: `「${instance}」还没装好，取消后这个实例会被删除。`,
    confirmLabel: "取消任务",
  }),
  cancelRepair: (taskTitle: string, instance: string) => ({
    title: `取消${quoted(taskTitle)}？`,
    body: `「${instance}」会停在文件不完整的状态，之后可以再点「修复实例」。`,
    confirmLabel: "取消任务",
  }),
  cancelAll: (count: number, creating: number, repairing: number, downloads: number) => {
    const parts: string[] = [];
    if (creating > 0) parts.push(`正在新建的 ${creating} 个实例会被删除`);
    if (repairing > 0) parts.push(`正在修复的 ${repairing} 个实例会保持文件不完整`);
    return {
      title: `取消全部 ${count} 个任务？`,
      body: parts.length > 0 ? `${parts.join("，")}。` : downloads > 0 ? "已下载的部分会被丢弃。" : "还没完成的部分会被丢弃。",
      confirmLabel: "全部取消",
    };
  },
  /** moment 为备份时刻「2026年10月31日 14:02」，标题限 20 字，所以时刻写在正文里。 */
  restoreWorld: (world: string, moment: string) => ({
    title: `恢复「${world}」的备份？`,
    body: `存档会回到 ${moment} 备份时的样子，现在的存档会移入回收站，需要时可以从回收站找回。`,
    confirmLabel: "恢复备份",
  }),
  closeWithSession: `游戏会继续运行。游戏结束前重新打开${APP_NAME}可以接回这一局，否则这一局的游玩时长与崩溃诊断不会记下。`,
  closeWithTasks: (count: number, downloads: number) => `还有 ${count} 个${downloads === count ? "下载" : "任务"}没完成，关闭后会中断，下次打开可以重试。`,
  closeWithBackups: (count: number) => `有 ${count} 个实例正在自动备份存档，关闭后这次备份不会完成。`,
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

export type LoginFailureActionKind = "retry" | "open_xbox" | "use_offline" | "copy_error" | "close" | "open_client_id_settings";

export interface LoginFailureAction {
  kind: LoginFailureActionKind;
  label: string;
}

export interface LoginFailureCopy {
  title: string;
  body: string | null;
  primary: LoginFailureAction | null;
  secondary: LoginFailureAction | null;
  /** 没有主按钮：初始焦点落在「关闭」上。 */
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
    case "ServiceUnavailable":
      return plain("微软登录服务暂时不可用", "微软那边的服务出了故障，不是你的账户或网络的问题。稍后重试。", LOGIN_RETRY);
    // 不给「重试」：同一个 client_id 重试只会得到同样的结果
    case "AppNotApproved":
      return plain(APP_NOT_APPROVED.title, APP_NOT_APPROVED.body, { kind: "open_client_id_settings", label: APP_NOT_APPROVED.fixLabel }, { kind: "copy_error", label: "复制错误信息" });
    // 同上不给「重试」：填上 client_id 之前结果不会变
    case "MsaClientIdMissing":
      return plain(MSA_CLIENT_ID_MISSING.title, MSA_CLIENT_ID_MISSING.body, { kind: "open_client_id_settings", label: MSA_CLIENT_ID_MISSING.fixLabel });
    default:
      return plain("微软登录失败", `${message}（${code}）`, LOGIN_RETRY, { kind: "copy_error", label: "复制错误信息" });
  }
}

/**
 * 首次启动向导期间主界面没挂上，「打开设置」去不了设置页：主次按钮里都去掉它，正文补一句先走完向导。
 * 没有这个动作的失败原样返回。
 */
export function withoutSettingsAction(copy: LoginFailureCopy): LoginFailureCopy {
  const opensSettings = (action: LoginFailureAction | null) => action !== null && action.kind === "open_client_id_settings";
  if (!opensSettings(copy.primary) && !opensSettings(copy.secondary)) return copy;
  const hint = "先走完向导，再到设置里填写或更换。";
  const primary = opensSettings(copy.primary) ? null : copy.primary;
  return {
    ...copy,
    body: copy.body === null ? hint : `${copy.body}${hint}`,
    primary,
    secondary: opensSettings(copy.secondary) ? null : copy.secondary,
    closeOnly: primary === null,
  };
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
  serverDown: { title: "这个服务器暂时不可用", body: "服务器出了故障，地址没有写错。稍后重试。" },
  loginServiceDown: { title: "登录服务暂时不可用", body: "服务器出了故障，不是账户或密码的问题。稍后重试。" },
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
  if (incomplete.kind === "modpack") return "整合包没有导入完，删掉这个实例后重新导入";
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
  /** 这个实例的存档还没有备份时的末句。 */
  backupHint: "想留着存档的话，先在概览的存档菜单里选「备份存档」。",
  /** 已有备份时的末句，分三段：前半句、备份目录（等宽、可选中）、后半句。 */
  backupsKeptLead: (count: number) => `这些存档已有 ${count} 份备份，保留在 `,
  backupsKeptTail: "，不会随实例删除。",
  /** 实例已经没有存档、游戏目录里还留着它以前的存档备份时，接在 noWorlds 之后，同样分三段。 */
  backupsLeftLead: (count: number) => `这个实例以前的存档还有 ${count} 份备份，保留在 `,
  noWorlds: "这个实例没有存档。实例文件夹、Mod 与配置会一起移入回收站。",
  /** 实例上还挂着没完成的任务（新建、导入、补全、装 Mod）时追加：确认后先取消任务再删除。 */
  pendingTask: "正在进行的安装任务会先取消。",
  confirmLabel: (worlds: number) => (worlds > 0 ? `删除实例和 ${worlds} 个存档` : "删除实例"),
  /** 删除预览看出有实例经继承依赖它：这时删不了，不进确认框。Toast 正文放不下更多名字，只点两个。 */
  hasDependents: (name: string, dependents: readonly string[]) => {
    if (dependents.length === 0) throw new Error(`没有实例依赖「${name}」，不该走到这句`);
    const named = dependents
      .slice(0, 2)
      .map((d) => `「${d}」`)
      .join("");
    const rest = dependents.length > 2 ? `等 ${dependents.length} 个` : "";
    return { title: `不能删除「${name}」`, body: `实例${named}${rest}依赖它，要先删除依赖它的实例` };
  },
} as const;

// ---------------------------------------------------------------- 整合包没导入完

/** 整合包导入中断的实例补全补不回来：实例库卡片、头图菜单、概览横幅与实例管理卡都改给这两个入口。 */
export const MODPACK_REIMPORT_COPY = {
  reimport: "重新导入",
  menuReimport: "重新导入整合包",
  delete: "删除",
  deleteInstance: "删除实例",
  note: "整合包没有导入完，缺的 Mod 与配置补全补不回来，删掉这个实例后重新导入。",
} as const;

/** 整合包的显示名：「RLCraft 2.9.3」；整合包没写版本时只写名字。实例库卡片、头图标签与实例信息共用。 */
export function modpackLabel(pack: { name: string; version: string | null }): string {
  return pack.version === null ? pack.name : `${pack.name} ${pack.version}`;
}

// ---------------------------------------------------------------- 实例被当作基底

/**
 * 原版实例正被别的实例当作基底（instance_busy 的 activity 为 inherited）：那个实例启动到游戏退出、补全或导入整合包
 * 期间，原版的启动、删除、改名、补全都被拒。`user` 是正在用它的实例名。状态短句用于实例库卡片与删除确认；
 * 其余四条是对应控件禁用时的悬停提示与菜单项 hint。
 */
export const INSTANCE_IN_USE_COPY = {
  reason: (user: string) => `实例「${user}」正在使用它`,
  rename: (user: string) => `实例「${user}」正在使用它，结束后才能重命名`,
  repair: (user: string) => `实例「${user}」正在使用它，结束后才能补全`,
  reinstallLoader: (user: string) => `实例「${user}」正在使用它，结束后才能${REINSTALL_LOADER_LABEL}`,
  delete: (user: string) => `实例「${user}」正在使用它，结束后才能删除`,
  launch: (user: string) => `实例「${user}」正在使用它，结束后才能启动`,
} as const;

/** 依赖的实例在做什么，接在「正在」之后。 */
const BASE_ACTIVITY_LABEL: Readonly<Record<BaseBusyLock["activity"], string>> = {
  installing: "安装",
  repairing: "补全文件",
  renaming: "改名",
  deleting: "删除",
  launching: "启动",
  running: "运行",
};

/** 操作被实例锁挡住时的悬停提示与菜单项 hint。 */
const INSTANCE_LOCK_REASON = {
  running: "游戏正在运行，先结束游戏",
  runningMods: "游戏正在运行，Mod 文件被占用",
  installing: "实例正在补全文件",
  renameRunning: "游戏正在运行，结束后才能重命名",
  renameInstalling: "安装任务正在写这个实例的文件夹",
  repairInProgress: "进行中",
  modifying: {
    rename: "正在改动这个实例的 Mod、资源或设置，完成后才能重命名",
    repair: "正在改动这个实例的 Mod、资源或设置，完成后才能补全",
    reinstallLoader: `正在改动这个实例的 Mod、资源或设置，完成后才能${REINSTALL_LOADER_LABEL}`,
    delete: "正在改动这个实例的 Mod、资源或设置，完成后才能删除",
  },
  /** 备份、恢复或导出存档进行中，游戏退出后的自动备份也算。 */
  backingUp: {
    rename: "正在备份或恢复这个实例的存档，完成后才能重命名",
    repair: "正在备份或恢复这个实例的存档，完成后才能补全",
    reinstallLoader: `正在备份或恢复这个实例的存档，完成后才能${REINSTALL_LOADER_LABEL}`,
    delete: "正在备份或恢复这个实例的存档，完成后才能删除",
  },
} as const;

/** 锁定原因的悬停文字；没有锁为 undefined，可以直接交给 disabledReason。 */
export function lockReason(lock: InstanceLock | BaseBusyLock | null, kind: "mods" | "rename" | "repair" | "reinstallLoader" | "delete"): string | undefined {
  if (lock === null) return undefined;
  if (typeof lock === "object") {
    if (lock.kind === "base_busy") {
      if (kind !== "repair" && kind !== "reinstallLoader") throw new Error(`依赖的实例正忙只挡补全，不会锁住 ${kind}`);
      return `它依赖的实例「${lock.base}」正在${BASE_ACTIVITY_LABEL[lock.activity]}，结束后才能${kind === "repair" ? "补全" : REINSTALL_LOADER_LABEL}`;
    }
    if (kind === "mods") throw new Error("被别的实例当作基底时照样能改动 Mod，不会因此锁住 Mod 操作");
    return INSTANCE_IN_USE_COPY[kind](lock.usedBy);
  }
  if (lock === "modifying" || lock === "backing_up") {
    if (kind === "mods") throw new Error(`${lock} 与改动 Mod 互相兼容，不会因此锁住 Mod 操作`);
    return lock === "modifying" ? INSTANCE_LOCK_REASON.modifying[kind] : INSTANCE_LOCK_REASON.backingUp[kind];
  }
  if (kind === "rename") return lock === "running" ? INSTANCE_LOCK_REASON.renameRunning : INSTANCE_LOCK_REASON.renameInstalling;
  if (kind === "mods") return lock === "running" ? INSTANCE_LOCK_REASON.runningMods : INSTANCE_LOCK_REASON.installing;
  if ((kind === "repair" || kind === "reinstallLoader") && lock === "installing") return INSTANCE_LOCK_REASON.repairInProgress;
  return INSTANCE_LOCK_REASON.running;
}

/** 整合包名全是 Windows 不允许的字符、整理完什么都不剩时，新实例的默认名。 */
export const MODPACK_FALLBACK_NAME = "整合包";
