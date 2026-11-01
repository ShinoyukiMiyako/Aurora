// 设置页与启动器更新的文案。产品名一律经 APP_NAME 拼入。

import type { IconName } from "../../art/Icon";
import { APP_NAME } from "../../lib/app-info";
import type { SettingsSection } from "../../state/route";

export const SETTINGS_TITLE = "设置";
export const SETTINGS_NAV_LABEL = "设置分区";
export const settingsSubtitle = (section: string) => `${section} · 改动立即生效`;

/** 单项写入失败的通知标题；正文由外层给出原因。 */
export const saveFailed = (name: string) => `没能保存「${name}」`;

export const SECTION_META: Readonly<Record<SettingsSection, { icon: IconName; hint: string }>> = {
  general: { icon: "sliders", hint: "启动后行为、语言" },
  download: { icon: "download", hint: "下载源与速度" },
  java: { icon: "java", hint: "运行时与自动选择" },
  game: { icon: "cpu", hint: "内存、隔离与目录" },
  appearance: { icon: "palette", hint: "明暗、强调色、花瓣、动画" },
  about: { icon: "info", hint: "" },
};

export const aboutHint = (version: string) => `版本 ${version}`;
export const aboutUpdateHint = (version: string) => `有新版本 ${version}`;
export const UPDATE_DOT_LABEL = "有可用更新";

export const LOAD_COPY = {
  failedTitle: "配置载入失败",
  retry: "重试",
  offlineReason: "联网后才能使用",
} as const;

// ---------------------------------------------------------------- 常规

export const GENERAL_COPY = {
  launchTitle: "启动",
  launchSubtitle: "按下「启动游戏」之后启动器做什么",
  afterLaunch: "游戏启动后",
  advancedTitle: "高级",
  clientId: "微软登录 client_id",
  clientIdDesc: "自定义 Azure 应用的 client_id，用于微软正版登录；出于安全不回显已保存的值",
  clientIdSet: "已配置",
  clientIdUnset: "未配置",
  clientIdEdit: "修改",
  clientIdPlaceholderSet: "输入以覆盖现有 client_id",
  clientIdPlaceholderUnset: "输入 client_id",
  cancel: "取消",
  save: "保存",
  clientIdSaved: "client_id 已保存",
} as const;

export const AFTER_LAUNCH_OPTIONS = [
  { value: "keep", label: "保持打开", desc: "游戏运行时启动器留在原处，方便看日志" },
  { value: "minimize", label: "最小化", desc: "游戏窗口出现后启动器缩到任务栏，结束后再弹回来" },
  { value: "close", label: "关闭启动器", desc: "游戏启动后启动器退出，游戏日志与崩溃诊断将不可用" },
] as const;

// ---------------------------------------------------------------- 下载

export const DOWNLOAD_COPY = {
  sourceTitle: "下载源",
  sourceSubtitle: "游戏本体、加载器与资源文件从哪里下",
  fileSource: "文件下载源",
  versionListSource: "版本列表源",
  versionListDesc: "拉取游戏版本清单时的来源",
  recommended: "推荐",
  speedTitle: "速度",
  concurrency: "同时下载的文件数",
  concurrencyDesc: "单个任务内同时下载的文件数。下载队列本身最多 3 个任务并行，这里调的是每个任务有多快。",
  concurrencyValue: (n: number) => `${n} 个`,
  tasks: "下载任务",
  tasksBusy: (n: number) => `现在有 ${n} 个任务在队列里`,
  tasksIdle: "队列空闲",
  viewTasks: "查看任务",
} as const;

export const SOURCE_OPTIONS = [
  { value: "auto", label: "自动", icon: "zap", desc: "按测速结果在官方源与镜像之间择优，测不出来时镜像优先" },
  { value: "official_first", label: "官方源优先", icon: "globe", desc: "直连 Mojang 与各平台 CDN，镜像兜底；海外网络更稳" },
  { value: "mirror_first", label: "镜像源优先", icon: "server", desc: "BMCLAPI 镜像优先，官方兜底；由 bangbang93 维护，大陆网络更快" },
] as const;

/** 同时下载的文件数：8 到 256，步进 8。 */
export const CONCURRENCY = { min: 8, max: 256, step: 8, marks: [8, 64, 128, 256] } as const;

// ---------------------------------------------------------------- Java

export const JAVA_COPY = {
  title: "Java 运行时",
  subtitle: "实例设置里选了「自动」时用这里的规则；单个实例仍可单独指定",
  rescan: "重新扫描",
  autoDownload: "自动下载 Java",
  autoDownloadDesc: "启动时缺少匹配的运行时，自动下载对应版本",
  defaultJava: "默认 Java",
  auto: "自动选择",
  recommended: "推荐",
  autoDesc: (majors: readonly number[], autoDownload: boolean) => {
    const tail = autoDownload ? "自动下载哪个" : "提示你装哪个";
    const list = majors.length === 0 ? "" : `：${majors.map((m) => `Java ${m}`).join(" / ")}`;
    return `按每个实例的游戏版本挑选匹配的主版本${list}，缺哪个就${tail}。`;
  },
  runtime: (major: number) => `Java ${major}`,
  bits64: "64 位",
  bits32: "32 位",
  users: (n: number, major: number) => `${n} 个实例需要 Java ${major}`,
  noUsers: "暂时没有实例需要这个版本",
  pinnedNote: "固定成单一 Java 后，要求其他主版本的实例（例如 1.12.2 要 Java 8、1.21 要 Java 21）会启动失败，除非在实例设置里单独指定。",
  pinnedMissing: "默认 Java 已经找不到了，跟随全局的实例会启动失败",
  useAuto: "改回自动选择",
  pickAgain: "重新选择",
  missingAuto: (list: string) => `还缺 ${list}，首次启动对应实例时会自动下载。`,
  missingManual: (list: string) => `还缺 ${list}，对应实例会启动失败。可以在下面手动下载，或打开「自动下载 Java」。`,
  bits32Note: "32 位 Java 最多只能用约 1.5 GB 内存，装 Mod 的实例很容易内存不足。",
  scanDone: (n: number) => `扫描完成，找到 ${n} 个 Java 运行时`,
  scanDiff: (added: number, removed: number) => `新增 ${added} 个，消失 ${removed} 个`,
  scanFailed: "扫描 Java 时出错",
  emptyTitle: "没有在本机找到 Java",
  emptyAuto: "首次启动时会自动下载",
  emptyManual: "可以在下面手动下载",
  downloadTitle: "下载运行时",
  downloadMajor: "要下载的主版本",
  download: "下载",
  managedInstalled: (major: number) => `已经装了托管的 Java ${major}`,
  majorUsers: (n: number) => `${n} 个实例需要`,
  noMajors: "还没有实例用到需要下载的 Java，新建实例后这里会列出它们要的主版本。",
  enqueued: (major: number) => `已加入下载队列：Java ${major}`,
  add: "添加 Java",
  added: (major: number) => `已添加 Java ${major}`,
  addedBody: (vendor: string, version: string) => `${vendor} ${version}`,
  addFailed: "没能添加 Java",
  pickFailed: "没能打开文件选择框",
  incomplete: "不完整",
  missingFiles: (files: readonly string[]) => `缺少 ${files.join("、")}，自动选择会跳过它`,
  manualTitle: "手动添加的 Java",
  manualDesc: "移除只删记录，不动磁盘文件",
  manualDetail: (major: number, vendor: string, version: string) => `Java ${major} · ${vendor} ${version}`,
  unrecognized: "识别不出",
  unrecognizedDesc: "这个位置现在识别不出 Java，文件可能被移走了",
  remove: "移除",
  removed: "已移除手动添加的 Java",
  defaultReset: "默认 Java 改回了自动选择",
  removeFailed: "没能移除 Java",
} as const;

export const GPU_COPY = {
  title: "显卡",
  subtitle: `让${APP_NAME}启动的游戏用哪块显卡`,
  toggle: "让游戏用独立显卡",
  descSwitchable: (name: string) => `启动前把这次用的 Java 设为 Windows 图形设置里的「高性能」，游戏会用 ${name}`,
  descSingle: "这台电脑只找到一块显卡，开着也不会换显卡",
  descLoading: "正在读取显卡信息…",
  descGeneric: "启动前把这次用的 Java 设为 Windows 图形设置里的「高性能」",
  dualNote: (powerSaving: string, highPerformance: string) =>
    `这台电脑有两块显卡：${powerSaving} 和 ${highPerformance}。笔记本常默认用省电的那块跑游戏，帧数会低不少。`,
  revertNote:
    "关掉后，已经写进 Windows 的设置不会自动改回；要改回，到 Windows 设置 → 系统 → 屏幕 → 显示卡（Windows 10：系统 → 显示 → 图形设置）里把 java.exe 改回「让 Windows 决定」。",
  readFailed: "读不到显卡信息",
} as const;

// ---------------------------------------------------------------- 游戏

export const MEMORY_COPY = {
  title: "内存",
  subtitle: (total: string) => `本机共 ${total}，这里是所有实例的默认值`,
  auto: "自动分配",
  autoDesc: (tier: string, recommended: string) => `按实例类型与开机时的空闲内存决定；当前按「${tier}」档给 ${recommended}`,
  max: "最大内存",
  recommendedTip: (tier: string, mb: string) => `「${tier}」档推荐 ${mb}`,
  available: (mb: string) => `现在空闲 ${mb}`,
  custom: (n: number) => `${n} 个实例用自定义内存，不受这里影响`,
  overAvailable: (value: string, available: string) => `给游戏 ${value} 已经超过现在的空闲内存 ${available}，浏览器、语音软件开多了容易卡顿。`,
  readFailed: "读不到本机内存信息",
} as const;

export const MEMORY_TIER_LABEL = {
  vanilla: "原版",
  modded: "装 Mod",
  large_modpack: "大型整合",
} as const;

export const ISOLATION_COPY = {
  title: "版本隔离",
  setting: "隔离档位",
  note: "已有实例的存档不会被搬动。",
  recommended: "推荐",
} as const;

export const ISOLATION_OPTIONS = [
  { value: "disabled", label: "关闭隔离", desc: "所有实例共用同一个目录，Mod 与配置可能互相串味（已有 mods 或 saves 的实例仍会单独存放）" },
  { value: "mod_loaders_only", label: "仅加载器版本", desc: "装了加载器的实例各自独立，原版共用一份" },
  { value: "non_release_only", label: "仅非正式版本", desc: "快照与远古版本各自独立，正式版共用一份" },
  { value: "mod_loaders_and_non_release", label: "加载器与非正式版本", desc: "装了加载器的实例和快照各自独立存放存档、配置与资源包，纯原版正式版共用一份" },
  { value: "all", label: "全部隔离", desc: "每个实例都有自己的 .minecraft，互不影响，占用空间最多" },
] as const;

export const RECOMMENDED_ISOLATION = "mod_loaders_and_non_release";

export const GAME_DIR_COPY = {
  title: "游戏目录",
  subtitle: "版本、库文件与共用资源放在这里，实例的存档按隔离策略分开",
  copyPath: "复制路径",
  openFolder: "打开文件夹",
  change: "更改",
  othersTitle: "其他文件夹",
  othersDesc: "可以并存多个 .minecraft，切换后实例库换成那个目录里的实例；移除只删记录，不动磁盘文件",
  rediscover: "重新探测",
  unavailable: "不可达",
  unavailableTip: "这个位置现在访问不到，记录仍然保留",
  switch: "切换",
  remove: "移除",
  discoveredTitle: "发现未记录的文件夹",
  add: "添加",
  dataDir: "数据目录",
  busyReason: "有游戏或下载在进行，结束后再切换",
  unavailableReason: "位置访问不到，无法切过去",
  bangError: "路径里不能有「!」，Java 会读不出里面的游戏文件",
  confirmTitle: (name: string) => `切换到「${name}」？`,
  confirmBody: "实例库会换成这个目录里的实例，原目录的文件不会被移动或删除。",
  confirmLabel: "切换",
  switchFailed: "没能切换游戏目录",
  addFailed: "没能添加文件夹",
  removeFailed: "没能移除文件夹",
  pickFailed: "没能打开文件夹选择框",
  dirsFailed: "游戏目录列表读不出来",
  discoverFailed: "没能探测其他启动器的文件夹",
} as const;

export const WORLD_BACKUP_COPY = {
  title: "存档备份",
  subtitle: "退出游戏后自动备份玩过的存档，备份放在游戏目录下，删除实例也不会带走",
  auto: "自动备份",
  autoDesc: "游戏退出后，把这次玩过的存档各备份一份",
  keep: "每个存档保留",
  keepDesc: "只清理自动备份，手动备份一直保留",
  keepOption: (n: number) => `${n} 份`,
  total: "总量上限",
  totalDesc: "超过后先删最旧的自动备份",
  totalOption: (gb: number) => `${gb} GB`,
  /** 自动备份关着时后两项不起作用：清理只在写完一份自动备份后进行。 */
  pruneOff: "自动备份关闭时不会清理",
} as const;

/** 两个下拉的常用取值；配置里是别的值（手改过配置）时把它作为额外一项列出。 */
export const KEEP_PER_WORLD_OPTIONS: readonly number[] = [3, 5, 10, 20];
export const MAX_TOTAL_GB_OPTIONS: readonly number[] = [5, 10, 20, 50, 100];

// ---------------------------------------------------------------- 外观

export const APPEARANCE_COPY = {
  modeTitle: "明暗",
  modeSubtitle: "切换立即生效，并记在本机",
  accentTitle: "强调色",
  accentSubtitle: "按钮、选中态、进度条与花瓣都会跟着变",
  motionTitle: "背景与动效",
  petals: "飘落花瓣",
  petalsDesc: "主页背景少量像素花瓣缓慢飘落，鼠标经过时轻轻避让",
  petalsReduced: "「减少动画」已开启，花瓣会停在原处不动",
  panorama: "樱花林全景背景",
  panoramaDesc: "主页背景换成原版的樱花林全景，花瓣照常飘在它前面。全景图读取自你本机的游戏文件。",
  panoramaMissing: "本机还没有带樱花林全景的游戏版本，装好 1.20 系列任一版本后可以开启",
  reduceMotion: "减少动画",
  reduceMotionDesc: "停掉花瓣飘落、卡面视差与页面过渡。系统开了「减少动态效果」时无论这里怎么设都会生效。",
  systemReduced: "系统已开启",
} as const;

// ---------------------------------------------------------------- 关于

export const ABOUT_COPY = {
  versionLine: (v: string, license: string) => `版本 ${v} · ${license}`,
  infoTitle: "版本信息",
  copy: "复制",
  copied: "已复制",
  versionRow: "版本",
  channelRow: "发布通道",
  builtRow: "构建日期",
  licenseRow: "开源协议",
  sourceRow: "源代码",
  /** 「复制」整段版本信息时写进剪贴板的文字，反馈问题时直接贴出来。 */
  infoText: (rows: { name: string; version: string; channel: string; built: string; license: string; source: string }) =>
    [`${rows.name} ${rows.version}`, `发布通道：${rows.channel}`, `构建日期：${rows.built}`, `开源协议：${rows.license}`, `源代码：${rows.source}`].join("\n"),
  supportTitle: "支持",
  openLogs: "打开日志目录",
  openLogsDesc: "反馈问题时把这里的最新日志一起发来",
  open: "打开",
  openLogsFailed: "没能打开日志目录",
  licenses: "第三方许可",
  licensesDesc: "随应用分发的字体与依赖，各自的版本与许可证",
  view: "查看",
  licensesSubtitle: (n: number) => `共 ${n} 个，构建时从依赖树生成`,
  licensesNpm: "前端依赖与字体",
  licensesCargo: "Rust 依赖",
  licensesLoading: "正在读取许可清单…",
  licensesFailed: "第三方许可清单读不出来",
  licensesHeadName: "名称",
  licensesHeadVersion: "版本",
  licensesHeadLicense: "许可证",
  feedback: "问题反馈",
  feedbackDesc: "在仓库的 Issues 页提交问题或建议，会用系统浏览器打开",
  feedbackFailed: "没能打开问题反馈页",
  disclaimer: `实例图标、皮肤与全景图这些原版图案读取自你本机的游戏文件，不随${APP_NAME}分发。${APP_NAME}是社区开源项目，与 Mojang Studios 和 Microsoft 没有关联。`,
  infoFailed: "版本信息读不出来",
} as const;
