// 主页文案。页面里不写散落的字符串；跨页面共用的（启动入口、动作失败标题、加载器名）仍从 copy/flows 取。

import { formatCount, formatPlaytime } from "../../domain/format";
import { APP_NAME } from "../../lib/app-info";
import type { NewsTag } from "../../state/queries/home";

/** 周一为 0，与日历列序一致。 */
export const WEEKDAY_CHAR = ["一", "二", "三", "四", "五", "六", "日"] as const;

/** 问候按本地钟点分五段；凌晨 0-4 点说「夜深了」，不说「早上好」。 */
export function greeting(date: Date): string {
  const h = date.getHours();
  if (h < 5) return "夜深了";
  if (h < 11) return "早上好";
  if (h < 14) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
}

/** 星期下标：周一为 0。 */
export function mondayIndex(date: Date): number {
  return (date.getDay() + 6) % 7;
}

export const HOME_COPY = {
  // ---- 问候卡
  dateLine: (date: Date) => `${date.getMonth() + 1}月${date.getDate()}日 · 星期${WEEKDAY_CHAR[mondayIndex(date)]}`,
  greetingComma: "，",
  noAccount: "还没有登录账户",
  addAccount: "添加账户",
  manageAccount: "管理账户",
  downloads: (n: number) => `${n} 个下载进行中`,
  downloadsProgress: "下载总进度",
  today: "今天",
  todayNone: "还没开始",
  streak: "连续游玩",
  days: (n: number) => `${n} 天`,

  // ---- 继续游玩
  continueTag: "继续游玩",
  lastPlayed: (relative: string) => `上次 ${relative}`,
  neverPlayed: "还没玩过",
  switchInstance: "换一个",
  switchCurrent: "当前",
  allInstances: "全部实例",
  modCount: (n: number) => `${n} 个 Mod`,
  modpack: (name: string, version: string | null) => (version === null ? name : `${name} ${version}`),
  playtime: (minutes: number) => `累计 ${formatPlaytime(minutes)}`,
  world: (name: string) => `存档「${name}」`,
  details: "实例详情",
  continueEmptyTitle: "还没有可以继续的实例",
  continueEmptyBody: "新建一个实例，或者去发现页导入整合包。",
  createInstance: "新建实例",
  retry: "重试",

  // ---- 最近游玩
  recentTitle: "最近游玩",
  recentHint: "点卡片看详情，点右下角直接开玩",
  openInstance: (name: string) => `打开「${name}」`,
  recentMeta: (relative: string, loader: string) => `${relative} · ${loader}`,

  // ---- 游玩日历
  calendarTitle: "游玩日历",
  calendarSubtitle: (year: number, month: number, playedDays: number, minutes: number) =>
    `${year}年${month}月 · ${playedDays} 天 · 共 ${formatPlaytime(minutes)}`,
  prevMonth: "上个月",
  nextMonth: "下个月",
  dayLabel: (month: number, day: number, weekday: number) => `${month}月${day}日 · 周${WEEKDAY_CHAR[weekday]}`,
  dayNoPlay: "这天没有游玩",
  dayDeleted: "当天玩的实例已被删除",
  dayRest: "休息也是游戏的一部分。",
  noRecords: "还没有游玩记录",
  statsError: "游玩记录读取失败",

  // ---- 游玩洞察
  insightsTitle: "游玩洞察",
  insightsSubtitle: "近 7 天的节奏",
  week: "近 7 天",
  hours: "小时",
  dayUnit: "天",
  weekDelta: (percent: number) => `较前 7 天 ${percent >= 0 ? "+" : ""}${percent}%`,
  weekNoPrevious: "前 7 天没有记录",
  streakWeek: "一周没断过",
  streakKeep: "继续保持",
  topLoader: "常玩加载器",
  topLoaderShare: (percent: number) => `近 30 天占 ${percent}%`,
  none: "暂无",
  total: "累计时长",
  instanceCount: (n: number) => `${n} 个实例`,
  barsLabel: "近 7 天每日游玩时长",
  barToday: "今",

  // ---- 资讯
  newsTitle: "资讯",
  newsSubtitle: "游戏更新与官方活动",
  offline: "离线中",
  withOffline: (subtitle: string) => `${subtitle} · 离线中`,
  newsError: "资讯暂时没拉下来",
  launcherNewsError: `${APP_NAME}资讯暂时没拉下来`,
  newsNeedsNetwork: "需要联网获取",
  newsEmpty: "暂时没有新资讯",
  newsOpen: (name: string) => `打开「${name}」`,
  newsCreate: (version: string) => `用 ${version} 新建实例`,
  close: "关闭",

  // ---- 固定的服务器
  serversTitle: "固定的服务器",
  serversSubtitle: (n: number) => `${n} 个 · 在线人数与延迟`,
  serversSubtitleEmpty: "把常去的服务器放这里",
  /** 本机离线：说清是本机的问题，不是服务器都宕机了。 */
  serversOffline: (subtitle: string) => `${subtitle} · 本机离线`,
  pinServer: "固定服务器",
  allPinned: "所有服务器都已固定",
  pickAll: (n: number) => `全部 ${n} 台服务器…`,
  pickerTitle: "固定服务器",
  pickerSubtitle: "从游戏的多人服务器列表里挑选，点一下就固定到主页",
  pickerPin: (name: string) => `固定 ${name}`,
  knownLoading: "正在读取服务器列表…",
  knownError: "服务器列表读不出来",
  knownEmpty: "多人游戏列表里还没有服务器",
  serversEmptyTitle: "还没有固定服务器",
  serversEmptyBody: "点右上角的加号，从服务器列表里挑几个。",
  pinnedError: "固定的服务器读不出来",
  pingError: (reason: string) => `延迟测不出来：${reason}`,
  online: (online: number, max: number) => `${formatCount(online)}/${formatCount(max)} 在线`,
  lastOnline: (relative: string, online: number) => `上次 ${relative}在线 ${formatCount(online)}`,
  latency: (ms: number) => `${ms} ms`,
  unreachable: "连不上",
  pinging: "测速中",
  copyAddress: "复制地址",
  copied: "已复制",
  unpin: "取消固定",
  serverMore: (name: string) => `${name} 的更多操作`,
  join: "加入",
  joinRunning: (instance: string) => `「${instance}」正在运行`,
  joinLaunching: (instance: string) => `「${instance}」正在启动`,
  joinBackingUp: (instance: string) => `「${instance}」正在备份或恢复存档，完成后再加入`,
  joinPickerLabel: (server: string) => `选择用来加入「${server}」的实例`,
  joinPickerTitle: "用哪个实例加入",
  /** 实例选择里每项的版本小字；原版只写版本号。 */
  joinVersion: (mcVersion: string, loader: string | null) => (loader === null ? mcVersion : `${mcVersion} ${loader}`),
  /** 单选项里跟在实例名后面的版本小字。 */
  joinVersionInline: (version: string) => `· ${version}`,
  rememberChoice: "记住这个选择",
  joinServer: "加入服务器",
  switchJoinInstance: "更换加入用的实例",
  forgetJoinInstance: "不再记住实例",
  joinEmptyTitle: "没有能加入服务器的实例",
  joinEmptyBody: "新建一个 1.6 以后的实例再来加入。",
  /** 与外层统一错误标题的「……没有保存」同一句式，和同卡固定失败的「服务器列表没有保存」并列。 */
  saveJoinError: "加入用的实例没有保存",

  // ---- 共用
  worldsError: "存档列表读不出来",
} as const;

export const NEWS_TAG_LABEL: Readonly<Record<NewsTag, string>> = {
  release: "正式版",
  snapshot: "快照",
  event: "活动",
  launcher: APP_NAME,
};
