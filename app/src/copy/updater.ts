// 启动器更新的文案：外壳的更新面板与发现新版本的通知、设置页关于分区的更新卡共用。产品名一律经 APP_NAME 拼入。

import type { UpdaterUnsupportedReason } from "../ipc/system";
import { APP_NAME } from "../lib/app-info";
import { CONFIRM_COPY } from "./flows";

const RESTART_INSTALL = "重启并安装";

export const UPDATE_COPY = {
  cardTitle: `${APP_NAME}更新`,
  autoCheck: "自动检查更新",
  autoCheckDesc: `打开${APP_NAME}时检查一次，之后每 12 小时检查一次`,
  current: (v: string) => `当前是 ${v}`,
  autoOn: "已开启启动时自动检查",
  autoOff: "自动检查已关闭",
  check: "检查更新",
  checking: "正在检查…",
  upToDate: "已是最新版本",
  checkedAgo: (relative: string) => `${relative}检查过`,
  available: (v: string) => `有新版本 ${v}`,
  publishedAt: (date: string) => `发布于 ${date}`,
  skipped: "你跳过了这个版本",
  view: "查看更新",
  downloadingPct: (v: string, pct: string) => `正在下载 ${v} · ${pct}`,
  downloading: (v: string) => `正在下载 ${v}`,
  progress: (done: string, total: string) => `${done} / ${total}`,
  /** 换到了第 index + 1 个下载源（index 从 0 计）。只说第几个、共几个，不写源的地址与短名。 */
  sourceSwitched: (index: number, count: number) => `已换用备用下载源（${index + 1}/${count}）`,
  viewProgress: "查看进度",
  ready: (v: string) => `${v} 已下好，等待安装`,
  readySub: `安装时${APP_NAME}会短暂关闭`,
  restartInstall: RESTART_INSTALL,
  installOnExitCard: (v: string) => `关闭${APP_NAME}时会安装 ${v}`,
  installNow: "现在安装",
  checkFailed: "检查更新失败",
  /** 网络层失败的说法：检查失败时是主句，下载失败时是原因。TLS 不通也算 connect，这时用户的网络完全可能是好的，所以只说更新服务器，不叫人去检查网络。 */
  networkFailed: {
    connect: "连不上更新服务器",
    timeout: "更新服务器没有响应",
  },
  retry: "重试",
  unsupported: "当前环境不支持自动更新",
  /**
   * 不支持的原因：调试构建不检查更新；发布构建没配签名公钥时验不了更新包，同样不检查；
   * 没要求签名带版本号时，旧版本的合法包配上更高的版本号也能通过校验，等于防不住被换成旧版本，同样不检查；
   * 配置允许装不比当前新的版本时，伪造的清单直接指向旧版本的合法包就能装上，同样不检查；
   * 版本号的预发布标识认不出发布通道时不知道该取哪份清单，后端不猜着落到正式版的清单，同样不检查。
   * 「降级」在界面上已指降级启动，这里改说「换成旧版本」。
   */
  unsupportedSub: {
    debug_build: "开发环境或调试模式下不检查更新",
    missing_pubkey: "这个版本没有配置更新签名公钥，验不了更新包，所以不检查更新",
    signed_version_not_required: "这个版本没有要求更新包签名带上版本号，防不住被换成旧版本，所以不检查更新",
    downgrades_allowed: "这个版本的更新配置允许装不比当前新的版本，防不住被换成旧版本，所以不检查更新",
    unknown_channel: "这个版本的版本号认不出是哪个发布通道，不知道该从哪里取更新，所以不检查更新",
    pubkey_mismatch: "这个版本配的更新签名公钥与它所属的发布通道对不上，验不了更新包，所以不检查更新",
  } satisfies Readonly<Record<UpdaterUnsupportedReason, string>>,
  installingCard: "正在启动安装程序…",
  // 更新面板
  panelTitle: (v: string) => `更新到 ${v}`,
  panelSubtitle: (current: string, date: string | null) => (date === null ? `当前 ${current}` : `当前 ${current} · 发布于 ${date}`),
  notesTitle: "更新内容",
  notesEmpty: "这个版本没有附更新说明",
  installNote: `安装时${APP_NAME}会短暂关闭，装好后自动重新打开。`,
  skip: "跳过此版本",
  later: "稍后",
  download: "下载更新",
  background: "后台下载",
  cancelDownload: "取消下载",
  readyNote: "新版本已经下好了。",
  gameRunning: `游戏正在运行。安装会关闭${APP_NAME}，游戏日志与崩溃诊断会中断，结束游戏后再安装。`,
  gameRunningReason: "游戏正在运行，结束游戏后再安装",
  installOnExit: "退出时安装",
  installOnExitNote: (v: string) => `关闭${APP_NAME}时会自动安装 ${v}。`,
  switchToNow: "改为现在安装",
  close: "关闭",
  installing: "正在启动安装程序…",
  downloadFailed: "下载失败",
  downloadFailedBecause: (reason: string) => `下载失败：${reason}`,
  /**
   * 试过多个下载源、全都败在网络层：后端只在全是超时时报 timeout，有一个连不上就报 connect。
   * 所以 connect 时其余源可能是超时（连上过、甚至传过一段数据），这一句不能说死都连不上。
   */
  allSourcesFailed: {
    connect: "所有下载源都连不上或没有响应",
    timeout: "所有下载源都没有响应",
  },
  sourcesFailed: (tried: number) => `${tried} 个下载源都没能下完`,
  signatureInvalid: "更新包签名校验不通过，已丢弃，不会安装",
  /** 打包、备份这类本地任务不能说成下载：与关窗确认同一口径，有下载时取消键才写「继续下载」。 */
  restartConfirm: (tasks: number, downloads: number) => ({
    title: "重启并安装更新？",
    body: `还有 ${tasks} 个${downloads === tasks ? "下载" : ""}任务，重启会中断它们，之后需要重新开始。`,
    confirmLabel: RESTART_INSTALL,
    cancelLabel: downloads > 0 ? CONFIRM_COPY.keepDownloading : CONFIRM_COPY.cancel,
  }),
  // 失败通知标题
  installFailed: "没能安装更新",
  installOnExitFailed: "没能设为退出时安装",
  cancelFailed: "没能取消下载",
  skipFailed: "没能跳过这个版本",
  downloadStartFailed: "没能开始下载更新",
  checkStartFailed: "没能检查更新",
  openPanelFailed: "没能打开更新面板",
  offlineReason: "联网后才能使用",
} as const;

interface DownloadFailure {
  reason: string;
  signature: boolean;
  network: keyof typeof UPDATE_COPY.networkFailed | null;
  /** 试过的下载源个数，至少为 1。 */
  sourcesTried: number;
}

/**
 * 下载失败的写法，更新卡与更新面板共用。summary 是中文说法；raw 是另放、可选中的后端原文，
 * 它多半是插件的英文，不拼进中文句子；试过多个源时它逐行写着各源的原文。签名不符时包已丢弃，原因是固定说法，没有要另放的。
 */
export function downloadFailureCopy({ reason, signature, network, sourcesTried }: DownloadFailure): { summary: string; raw: string | null } {
  if (signature) return { summary: UPDATE_COPY.downloadFailedBecause(UPDATE_COPY.signatureInvalid), raw: null };
  if (sourcesTried > 1) {
    const because = network === null ? UPDATE_COPY.sourcesFailed(sourcesTried) : UPDATE_COPY.allSourcesFailed[network];
    return { summary: UPDATE_COPY.downloadFailedBecause(because), raw: reason };
  }
  if (network !== null) return { summary: UPDATE_COPY.downloadFailedBecause(UPDATE_COPY.networkFailed[network]), raw: reason };
  return { summary: UPDATE_COPY.downloadFailed, raw: reason };
}

/** 下载中换过源时多说的一句；还在用第一个源（或后端还没报源）时为 null，界面不提源的事。 */
export function sourceSwitchedCopy(source: { index: number; count: number } | null): string | null {
  if (source === null || source.index === 0) return null;
  return UPDATE_COPY.sourceSwitched(source.index, source.count);
}

/** 自动检查发现新版本时的通知：每个版本只弹一次，动作打开更新面板。 */
export const UPDATE_FOUND_TOAST = {
  title: (v: string) => `${APP_NAME} ${v} 可以更新了`,
  body: "点「查看」了解更新内容",
  action: "查看",
  rememberFailed: "没能记下已提示过的版本",
} as const;
