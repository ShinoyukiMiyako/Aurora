// 外壳自己的文案：标题栏、状态岛、下载快览、账户胶囊、侧栏、命令面板、通知容器与错误兜底。
// 与流程共用的词（阶段名、按钮动词、任务状态）从 flows.ts 取，不在这里另写一份。

import { LAUNCH_COPY, PAGE_LABEL, TASK_STATUS_LABEL, TASK_TOAST } from "./flows";
import { MAX_PARALLEL_TASKS } from "../domain/limits";
import { APP_NAME } from "../lib/app-info";

export const TITLEBAR_COPY = {
  back: "后退（Alt+←）",
  forward: "前进（Alt+→）",
  crumbSeparator: "/",
  minimize: "最小化",
  maximize: "最大化",
  restore: "还原",
  close: "关闭",
  searchLabel: "搜索实例、页面与操作",
  searchPlaceholder: "搜索实例、页面…",
  searchTooltip: "搜索（Ctrl+K）",
} as const;

export const ISLAND_COPY = {
  label: (name: string, second: string) => `${name}：${second}，查看详情`,
  /** 读屏只在阶段变化时播报这一句；每秒变化的计时与百分比不播报。 */
  announce: (name: string, phase: string) => `${name}：${phase}`,
  detailsLabel: (name: string) => `「${name}」的游戏会话`,
  progressLabel: "启动进度",
  stagesLabel: "启动阶段",
  logLabel: "最新日志",
  fullLog: "完整日志",
  /** 阶段清单一行的右侧：这一阶段启动器写了几条提醒（不中断启动，也不弹通知）。 */
  stageWarnings: (count: number) => `${count} 条提醒`,
  /** compact 档第二段的短格式。 */
  shortCancelled: "已取消",
  shortEnded: "已结束",
} as const;

export const PEEK_COPY = {
  title: PAGE_LABEL.tasks,
  /** 入口按钮的可访问名称：角标的计数与失败点并入名称，读屏不会念出孤零零的数字。 */
  button: (active: number, failed: number) =>
    [PAGE_LABEL.tasks, active > 0 ? `${active} 个进行中` : null, failed > 0 ? `${failed} 个任务失败` : null].filter((part) => part !== null).join("，"),
  activeSummary: (count: number) => `${count} 个进行中 · 最多 ${MAX_PARALLEL_TASKS} 个同时进行`,
  idle: "队列空闲",
  cancel: "取消任务",
  queued: TASK_STATUS_LABEL.queued,
  progress: (pct: string, speed: string) => `${pct} · ${speed}`,
  rowProgress: (title: string) => `${title}的进度`,
  totalProgress: "下载总进度",
  failed: (count: number) => `${count} 个任务失败`,
  view: TASK_TOAST.viewAction,
  empty: "没有进行中的下载。新建实例、导入整合包、安装 Mod 时，任务会排在这里。",
  clearFinished: (count: number) => `清除已结束（${count}）`,
  allTasks: "全部任务",
} as const;

export const ACCOUNT_COPY = {
  add: "添加账户",
  addLabel: "还没有账户，添加账户",
  current: (name: string, kind: string) => `当前账户 ${name}，${kind}，切换账户`,
  needsRelogin: "需要重新登录",
  menuLabel: "切换账户",
  manage: "管理账户",
  manageHint: "添加微软、离线或外置登录账户，删除账户",
} as const;

export const SIDEBAR_COPY = {
  nav: "主导航",
  pins: "固定的实例",
  create: "新建实例",
  createShortcut: "Ctrl+N",
  settingsShortcut: "Ctrl+,",
  pageShortcut: (n: number) => `Ctrl+${n}`,
  settingsWithUpdate: `${PAGE_LABEL.settings}，有可用更新`,
  menuLabel: (name: string) => `「${name}」的操作`,
  installing: "安装中",
  openDetail: "打开实例详情",
  openFolder: "打开实例文件夹",
  moveUp: "上移",
  moveDown: "下移",
  unpin: "取消固定",
  waitingInstall: LAUNCH_COPY.queuedTitle,
} as const;

export const PALETTE_COPY = {
  label: "命令面板",
  inputLabel: "搜索",
  placeholder: "搜索实例、页面与操作，或输入资源名去发现页搜索",
  groups: { instance: "实例", jump: "跳转", action: "操作", account: "账户", resource: "资源" },
  settingsSection: (section: string) => `${PAGE_LABEL.settings} · ${section}`,
  createInstance: "新建实例",
  toNight: "切换到夜樱",
  toDay: "切换到日樱",
  modeHint: "外观明暗",
  currentHint: "当前实例",
  stopGame: LAUNCH_COPY.stopGame,
  cancelLaunch: LAUNCH_COPY.cancel,
  viewCrash: "查看崩溃诊断",
  openGameDir: "打开游戏目录",
  switchAccount: (name: string) => `切换到 ${name}`,
  addMicrosoft: "添加微软账户",
  addOffline: "添加离线账户",
  searchDiscover: (query: string) => `在发现中搜索「${query}」`,
  footSelect: "选择",
  footRun: "执行",
  footOpen: "随时打开",
} as const;

export const TOASTS_COPY = {
  region: "通知",
} as const;

/** 窗口级文件拖放：放置提示与松开了别的文件时的说明。 */
export const DROP_COPY = {
  modpackHint: "松开以导入整合包",
  notModpack: { title: "拖进来的不是整合包", body: "只认 .mrpack 和 CurseForge 导出的 .zip" },
} as const;

/** 系统选择文件对话框：标题与文件类型下拉里的名称。 */
export const FILE_PICK_COPY = {
  modpack: { title: "选择整合包文件", filter: "整合包" },
} as const;

/** 页面级错误边界：外壳之内只有这一处兜底，标题栏、侧栏、状态岛不受页面错误影响。 */
export const PAGE_ERROR_COPY = {
  title: "这一页出错了",
  body: "错误已写入日志。可以重新加载这一页；问题反复出现时，把错误信息附在反馈里。",
  reload: "重新加载",
  copy: "复制错误信息",
  copied: "已复制",
  detail: "错误信息",
} as const;

/** 外壳本身渲染失败（Provider 或外壳布局抛错）时整屏错误页的文案。 */
export const SHELL_CRASH_COPY = {
  title: `${APP_NAME}出错了`,
  body: "界面遇到了无法继续的错误，错误信息在下方。可以重新加载；问题反复出现时，把错误信息附在反馈里。",
} as const;

/** 经外层统一错误处理执行时的失败标题：说清「什么没成功」。 */
export const SHELL_ACTION_ERROR = {
  minimize: "没能最小化窗口",
  maximize: "没能切换最大化",
  close: "没能关闭窗口",
  restore: "没能恢复窗口",
  attention: "没能提醒任务栏",
  windowState: "窗口状态读不出来",
  afterLaunch: "游戏启动后的窗口行为没有执行",
  petalsLog: "花瓣降级没有写入诊断日志",
  pageLog: "页面错误没有写入诊断日志",
  copy: "复制失败",
  appearance: "外观没有切换",
  skin: "账户皮肤读不出来",
  updater: "更新状态读不出来",
  pagePreload: "页面模块没能预载",
  fileDrop: "文件拖放没有接上",
  startupNotices: "启动提示读不出来",
  openDataDir: "没能打开数据目录",
} as const;

/** 启动提示：后端在启动时遇到、但不妨碍继续运行的问题。标题说清出了什么事，正文说清结果。 */
export const STARTUP_NOTICE_COPY = {
  configReset: {
    title: "配置文件损坏，已按默认设置启动",
    body: "原文件已改名，留在数据目录里",
    action: "打开目录",
  },
} as const;

/** 首次启动却缺少向导模块：构建产物不完整，外壳不能继续（错误原文进整屏错误页）。 */
export const SHELL_DEFECT_COPY = {
  missingOnboarding: "首次启动向导模块缺失：这个构建不完整，无法完成首次设置",
} as const;
