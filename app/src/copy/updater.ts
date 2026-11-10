// 启动器更新的文案：外壳的更新面板与发现新版本的通知、设置页关于分区的更新卡共用。产品名一律经 APP_NAME 拼入。

import type { RefusalReason, UpdateChannel, UpdaterUnsupportedReason } from "../ipc/system";
import { APP_NAME } from "../lib/app-info";
import { CONFIRM_COPY, RELEASE_CHANNEL_LABEL, updateChannelLabel } from "./flows";

export { RELEASE_CHANNEL_OF, updateChannelLabel } from "./flows";

const RESTART_INSTALL = "重启并安装";

const STABLE_LABEL = RELEASE_CHANNEL_LABEL.stable;

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
  // 更新通道：选项块的小标题也是组的读屏名与写入失败通知里的名字
  channelTitle: "更新通道",
  channelDesc: "从选的这条线接收更新。选了更稳的线时，现在的版本先留着，等那条线出了更新的版本再换过去。",
  /** 选项说明是静态的，不随检查结果变：选项块的高度不在眼前变化，「还没有发布」由状态行说。 */
  channelOptionDesc: {
    dev: "每有改动就出一版，新东西最先到，也最可能有问题",
    beta: `从${RELEASE_CHANNEL_LABEL.preview}里挑出用过一阵的版本，更稳，更新慢一些`,
    stable: `${RELEASE_CHANNEL_LABEL.beta}里没再发现问题的版本，最稳，更新最慢`,
  } satisfies Readonly<Record<UpdateChannel, string>>,
  /** 标在包的通道那一项上。不叫「当前通道」：会和勾选的偏好混在一起。 */
  packageChannelTag: "现在装的",
  /**
   * 下载中、已下好时改通道的确认：后端要丢掉旧通道的结果和下好的包，这是唯一会白白损失东西的情形。
   * 丢掉的只是能重新下载的安装包，所以是普通色调；正在下载时取消键写「继续下载」，免得与取消下载混淆。
   */
  channelConfirm: (channel: UpdateChannel, version: string, downloading: boolean) => ({
    title: `把更新通道改成${updateChannelLabel(channel)}？`,
    body: downloading
      ? `正在下载的 ${version} 会被取消，之后按${updateChannelLabel(channel)}检查更新。`
      : `已下好的 ${version} 会被丢掉，之后按${updateChannelLabel(channel)}检查更新。`,
    confirmLabel: `改成${updateChannelLabel(channel)}`,
    cancelLabel: downloading ? CONFIRM_COPY.keepDownloading : CONFIRM_COPY.cancel,
  }),
  /** 偏好是正式版而正式版还没有发布时的状态行。 */
  notPublished: `${STABLE_LABEL}还没有发布`,
  notPublishedSub: "发布之前收不到任何更新",
  /** 偏好通道比包的通道慢、还没有接得上的版本时的状态行。要等的正式版号就是当前版本的核心号。 */
  waiting: (preference: UpdateChannel) => `在等${updateChannelLabel(preference)}追上来`,
  /** 等待期间只问偏好通道和更慢的通道，包的通道上的修复到不了这台电脑：这是选更慢通道的代价，当场写明。 */
  waitingSub: (core: string, packageChannel: UpdateChannel) => `要等到${STABLE_LABEL} ${core} 发布，在那之前收不到${updateChannelLabel(packageChannel)}的更新`,
  /** 偏好通道给出的版本全都旧于这台电脑见过的：界面分不清是缓存、换源还是回放，用中性的说法。 */
  sourceStale: (channel: UpdateChannel) => `${updateChannelLabel(channel)}的更新源还没跟上`,
  sourceStaleSub: "它给出的版本比这台电脑以前拿到过的旧，过一阵再查",
  /** 新版本不属于包的通道时，状态行次句开头写出它属于哪条线。 */
  fromChannel: (channel: UpdateChannel) => `属于${updateChannelLabel(channel)}`,
  /** 下好、验过签却不能装的版本：状态行主句。原因见 refusalReasonCopy。 */
  nothingInstallable: "暂时没有能装的新版本",
  /** 刚下好就被拒的那一版：原因后面接这一句。 */
  discarded: (reason: string) => `${reason}，已丢弃`,
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
  /**
   * 下载、验签都成了，只是这一版读不了这台电脑上的数据：面板的说明块。不沿用「下载失败：……」，下载是成功的；
   * 也不给重试，再下必然同样被拒。
   */
  dataTooNew: "这一版读不了这台电脑上的数据，已丢弃，不会安装。",
  /** 面板里的通道说明行，见 updateChannelNote：装上就换到了新版本所属的、也是偏好的那条线。 */
  channelNoteSwitches: (channel: UpdateChannel) => `这一版属于${updateChannelLabel(channel)}，装上以后就换到${updateChannelLabel(channel)}了。`,
  /** 面板里的通道说明行：偏好更快的人收到了更慢的线上更新的版本，装上以后仍按偏好收更新。 */
  channelNoteKeeps: (channel: UpdateChannel, preference: UpdateChannel) => `这一版属于${updateChannelLabel(channel)}，装上以后照常接收${updateChannelLabel(preference)}的更新。`,
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

/** 本次会话被拒的一个版本：版本号、所属通道与原因，字段同 updater_info 的 refused 条目。 */
interface RefusedVersion {
  version: string;
  channel: UpdateChannel;
  reason: RefusalReason;
}

/**
 * 普通更新被拒的原因句，状态行的次句用它（刚下好就被拒时另接 UPDATE_COPY.discarded）。数据格式号不上界面，只写被拒的那一版。
 * target_unsupported 只随换通道出现，进不了普通更新的这句话，遇到是调用方取错了条目。
 */
export function refusalReasonCopy({ version, channel, reason }: RefusedVersion): string {
  switch (reason) {
    case "data_too_new":
      return `${version} 读不了这台电脑上的数据`;
    case "preference_unsaved":
      return `没能保存更新通道，${updateChannelLabel(channel)} ${version} 这次先不装`;
    case "target_unsupported":
      throw new Error(`target_unsupported 只随换通道出现，普通更新的拒绝里不该有：${version}`);
  }
}

/** 一个可安装版本所属的通道，与偏好、包的通道放在一起，决定面板说明行与通知正文怎么写。 */
export interface UpdateChannels {
  /** 新版本所属的通道（UpdateDto 的 channel）。 */
  channel: UpdateChannel;
  /** 生效的偏好（updater_info 的 preference）。 */
  preference: UpdateChannel;
  /** 包的通道（updater_info 的 package_channel）。 */
  packageChannel: UpdateChannel;
}

/**
 * 更新面板里放在安装说明之前的通道说明行：新版本属于包的通道时没有这一行（与只有一条线时一样）；
 * 属于偏好通道时说装上就换过去了；属于别的线（偏好更快的人收到更慢的线上更新的版本）时说装上以后照常按偏好收更新。
 */
export function updateChannelNote({ channel, preference, packageChannel }: UpdateChannels): string | null {
  if (channel === packageChannel) return null;
  if (channel === preference) return UPDATE_COPY.channelNoteSwitches(channel);
  return UPDATE_COPY.channelNoteKeeps(channel, preference);
}

/** 自动检查发现新版本时的通知：每个版本只弹一次，动作打开更新面板。 */
export const UPDATE_FOUND_TOAST = {
  title: (v: string) => `${APP_NAME} ${v} 可以更新了`,
  body: "点「查看」了解更新内容",
  /** 新版本属于偏好通道、不属于包的通道：装上就换过去了，通知里先说清。 */
  switchesBody: (channel: UpdateChannel) => `装上以后就换到${updateChannelLabel(channel)}了，点「查看」了解更新内容`,
  action: "查看",
  rememberFailed: "没能记下已提示过的版本",
} as const;

/** 发现新版本的通知正文：装上会换到偏好通道时用 switchesBody，其余照旧。 */
export function updateFoundToastBody({ channel, preference, packageChannel }: UpdateChannels): string {
  return channel === preference && channel !== packageChannel ? UPDATE_FOUND_TOAST.switchesBody(channel) : UPDATE_FOUND_TOAST.body;
}
