// 关于页更新卡在各阶段的呈现：主句、次句、唯一的按钮，以及更新通道选项块的取值与改通道前要不要确认。纯函数，便于逐状态核对。

import { formatBytes, formatDate, formatRelative, percent } from "../../../domain/format";
import { downloadFailureCopy, refusalReasonCopy, sourceSwitchedCopy, UPDATE_COPY } from "../../../copy/updater";
import { downloadFraction, supportedChannels, type SupportedChannels, type UpdaterChannels, type UpdaterPhase, type UpdaterState } from "../../../state/updater/machine";

/** 后端的通道名（dev、beta、stable）。 */
export type ChannelId = NonNullable<UpdaterChannels["package_channel"]>;

/** 选项块从快到慢排：预览版、测试版、正式版。 */
export const CHANNEL_ORDER: readonly ChannelId[] = ["dev", "beta", "stable"];

export type CardAction = "check" | "open_panel" | "install";

export interface CardButton {
  label: string;
  variant: "primary" | "secondary";
  action: CardAction;
  loading: boolean;
  /** 硬禁用（不支持更新的环境）。 */
  disabled: boolean;
  /** 带原因的禁用：悬停与聚焦显示原因。 */
  disabledReason: string | undefined;
  /** 文案槽的候选（LabelSlot）：同一组里换阶段时按钮按最宽的那条定宽；检查一组带图标，不进槽，为 null。 */
  slot: readonly string[] | null;
}

/**
 * 打开面板与安装这一组按钮可能写的文案。按钮在状态行里靠右，「查看进度」在下载完成时换成「重启并安装」、已下好与退出时安装
 * 之间来回换时，按钮不定宽的话左缘一帧跳开一个字宽，主句一栏跟着变窄。检查一组（检查更新、重试）前面带刷新图标，与这一组
 * 宽度本来就对不齐，不放进来。
 */
const PANEL_BUTTON_LABELS: readonly string[] = [UPDATE_COPY.view, UPDATE_COPY.viewProgress, UPDATE_COPY.restartInstall, UPDATE_COPY.installNow];

/**
 * 下载中主句里的百分数。进度事件约 100 ms 一条，照原样拼进主句一秒跳十次字，所以状态行不直接画 view.title，
 * 而是在 before 与 after 之间摆与进度条同一条平滑的百分数节点（ui/SmoothPercent）。
 */
export interface CardPercent {
  /** 0-1，上报的原值。 */
  value: number;
  /** 平滑的分段：换任务或换源都从新值起算。换源后字节从 0 重新报起，同一段里只进不退会让百分数停在上一个源下到的位置。 */
  track: string;
  before: string;
  after: string;
}

/** 下载中的次句素材：已下大小要按显示节拍换字，由渲染它的组件节流后交给 downloadSub 拼成句子。 */
export interface CardProgress {
  bytes: number;
  totalBytes: number | null;
  /** 换过源时跟在字节后面的一句；还在第一个源时为 null。 */
  switched: string | null;
  /** 主句里的百分数；总量未知时为 null，主句只写版本。 */
  percent: CardPercent | null;
}

export interface CardView {
  title: string;
  /** 有新版本时主句用强调色。 */
  accent: boolean;
  /** 次句；下载中为 null，次句改由 progress 给出。 */
  sub: string | null;
  /** 次句是错误原文：可选中复制。 */
  subIsError: boolean;
  /** 次句是中文说法时另放一行的错误原文，同样可选中复制。 */
  raw: string | null;
  /** 下载中的次句素材；其余阶段为 null。 */
  progress: CardProgress | null;
  button: CardButton;
}

export interface CardContext {
  checkUpdates: boolean;
  skippedVersion: string | null;
  now: number;
  online: boolean;
  /** 有游戏会话在准备或运行：安装会关闭启动器，期间不允许。 */
  gameRunning: boolean;
}

function button(label: string, variant: CardButton["variant"], action: CardAction, extra: Partial<Omit<CardButton, "label" | "variant" | "action" | "slot">> = {}): CardButton {
  return { label, variant, action, loading: false, disabled: false, disabledReason: undefined, slot: action === "check" ? null : PANEL_BUTTON_LABELS, ...extra };
}

/** 支持自更新时更新卡要的通道信息：核对过的包的通道、偏好与关系，加上各通道最近一次的结果与被拒的版本。 */
interface KnownChannels extends SupportedChannels {
  heads: UpdaterChannels["channel_heads"];
  refused: UpdaterChannels["refused"];
}

/** 支持自更新的阶段才调：那时更新信息已经到了，包的通道只在不支持时为空，空了是后端违约。 */
function knownChannels(state: UpdaterState): KnownChannels {
  const { channels } = state;
  if (channels === null) throw new Error("更新信息到达之前不该渲染更新卡");
  return { ...supportedChannels(channels), heads: channels.channel_heads, refused: channels.refused };
}

/** 版本的核心号：去掉第一个「-」及之后的部分，1.1.0-dev.61 的核心号是 1.1.0。 */
export function versionCore(version: string): string {
  const dash = version.indexOf("-");
  return dash < 0 ? version : version.slice(0, dash);
}

/**
 * 没有可装版本时（未检查、已是最新）按通道换的说法；都不命中时为 null，照旧写。同时命中时取靠前的：
 * 偏好是正式版而它还没发布；本次会话拒过普通更新（只在已是最新时，取最后一条）；偏好比包的通道慢、在等它追上来。
 * 被拒排在等待前面：等待中被拒的若正是等着的那一版，「要等到」那句已经不成立。
 * checkedAgo 是已是最新时的「x 分钟前检查过」，接在次句后面；未检查时为 null。
 */
function channelQuietLine(state: UpdaterState, version: string, checkedAgo: string | null): { title: string; sub: string } | null {
  const ch = knownChannels(state);
  const withChecked = (sub: string) => (checkedAgo === null ? sub : `${sub} · ${checkedAgo}`);
  if (ch.preference === "stable" && ch.heads.some((head) => head.channel === "stable" && head.state === "not_published")) {
    return { title: UPDATE_COPY.notPublished, sub: withChecked(UPDATE_COPY.notPublishedSub) };
  }
  // 被拒只在已是最新时说；换通道被拒的版本由换过去那一路自己说，不进状态行
  if (checkedAgo !== null) {
    const refused = ch.refused.filter((entry) => entry.intent === "update").at(-1);
    if (refused !== undefined) return { title: UPDATE_COPY.nothingInstallable, sub: withChecked(refusalReasonCopy(refused)) };
  }
  if (ch.relation === "waiting") {
    return { title: UPDATE_COPY.waiting(ch.preference), sub: withChecked(UPDATE_COPY.waitingSub(versionCore(version), ch.packageChannel)) };
  }
  return null;
}

/** 更新通道选项块要的取值；不支持自更新时为 null，整块不显示（状态行已说明原因）。 */
export interface ChannelChoice {
  /** 勾选的那一项：后端给的生效值，没选过或存的值认不出时就是包的通道，界面不自己推。 */
  preference: ChannelId;
  /** 标「现在装的」的那一项。 */
  packageChannel: ChannelId;
  /** 安装中整组不可用：窗口马上就关。 */
  locked: boolean;
}

export function channelChoice(state: UpdaterState): ChannelChoice | null {
  if (state.phase.kind === "unsupported") return null;
  const ch = knownChannels(state);
  return { preference: ch.preference, packageChannel: ch.packageChannel, locked: state.phase.kind === "installing" };
}

/** 改通道会丢掉的东西：正在下载的那一版，或已下好（含设了退出时安装）的那一版。 */
export interface ChannelChangeCost {
  version: string;
  downloading: boolean;
}

/** 改通道前要不要先确认：下载中与已下好时后端会丢掉那个包，其余阶段直接写入。 */
export function channelChangeCost(phase: UpdaterPhase): ChannelChangeCost | null {
  switch (phase.kind) {
    case "downloading":
      return { version: phase.update.version, downloading: true };
    case "ready":
    case "install_on_exit":
      return { version: phase.update.version, downloading: false };
    default:
      return null;
  }
}

/** 文案模板里百分数的占位：模板按它切成前后两段，中间摆平滑的百分数节点。 */
export const PERCENT_SLOT = "\u0000";

export function aroundPercent(text: string): readonly [string, string] {
  const parts = text.split(PERCENT_SLOT);
  if (parts.length !== 2) throw new Error(`下载中的主句里百分数应当恰好出现一次，实为 ${parts.length - 1} 次`);
  return [parts[0], parts[1]];
}

/** 下载中的次句：已下 / 总量（总量未知时只写已下），换过源时在后面说一句。bytes 由调用方给显示用的值。 */
export function downloadSub(progress: CardProgress): string {
  const size = progress.totalBytes === null ? formatBytes(progress.bytes) : UPDATE_COPY.progress(formatBytes(progress.bytes), formatBytes(progress.totalBytes));
  // 换源后字节从 0 重新报起，不说一句的话看着像进度倒退了
  return progress.switched === null ? size : `${size} · ${progress.switched}`;
}

export function updateCardView(state: UpdaterState, ctx: CardContext): CardView {
  const { phase } = state;
  const offline = ctx.online ? undefined : UPDATE_COPY.offlineReason;
  const check = (label: string = UPDATE_COPY.check) => button(label, "secondary", "check", { disabledReason: offline });
  const installReason = ctx.gameRunning ? UPDATE_COPY.gameRunningReason : undefined;
  const view = (title: string, sub: string | null, btn: CardButton, extra: Partial<Pick<CardView, "accent" | "subIsError" | "raw" | "progress">> = {}): CardView => ({
    title,
    sub,
    button: btn,
    accent: false,
    subIsError: false,
    raw: null,
    progress: null,
    ...extra,
  });

  switch (phase.kind) {
    case "unsupported": {
      // 后端只在不支持时给原因；不支持却没有原因属于后端违约
      if (phase.reason === null) throw new Error("updater_info 报告不支持更新却没有给出原因");
      return view(UPDATE_COPY.unsupported, UPDATE_COPY.unsupportedSub[phase.reason], button(UPDATE_COPY.check, "secondary", "check", { disabled: true }));
    }
    case "idle": {
      if (state.currentVersion === null) throw new Error("更新信息到达之前不该渲染更新卡");
      const line = channelQuietLine(state, state.currentVersion, null);
      if (line !== null) return view(line.title, line.sub, check());
      return view(UPDATE_COPY.current(state.currentVersion), ctx.checkUpdates ? UPDATE_COPY.autoOn : UPDATE_COPY.autoOff, check());
    }
    case "checking":
      return view(UPDATE_COPY.checking, null, button(UPDATE_COPY.check, "secondary", "check", { loading: true }));
    case "up_to_date": {
      if (state.currentVersion === null) throw new Error("更新信息到达之前不该渲染更新卡");
      const checkedAgo = UPDATE_COPY.checkedAgo(formatRelative(phase.checkedAt, ctx.now));
      const line = channelQuietLine(state, state.currentVersion, checkedAgo);
      if (line !== null) return view(line.title, line.sub, check());
      return view(UPDATE_COPY.upToDate, checkedAgo, check());
    }
    case "check_failed":
      // 更新源还没跟上是这台电脑记着的版本挡下的，不是后端原文能说清的失败：写中文说法，原文只进日志
      if (phase.staleChannel !== null) return view(UPDATE_COPY.sourceStale(phase.staleChannel), UPDATE_COPY.sourceStaleSub, check(UPDATE_COPY.retry));
      return view(phase.network === null ? UPDATE_COPY.checkFailed : UPDATE_COPY.networkFailed[phase.network], phase.message, check(UPDATE_COPY.retry), { subIsError: true });
    case "available": {
      const parts: string[] = [];
      // 新版本不属于包的通道时先写出它属于哪条线：装上它就离开了现在这条线，或换到了偏好的那条
      if (phase.update.channel !== knownChannels(state).packageChannel) parts.push(UPDATE_COPY.fromChannel(phase.update.channel));
      if (phase.update.date !== null) parts.push(UPDATE_COPY.publishedAt(formatDate(phase.update.date)));
      if (ctx.skippedVersion === phase.update.version) parts.push(UPDATE_COPY.skipped);
      const sub = parts.length === 0 ? null : parts.join(" · ");
      return view(UPDATE_COPY.available(phase.update.version), sub, button(UPDATE_COPY.view, "primary", "open_panel"), { accent: true });
    }
    case "download_failed": {
      // 下好、验过签却不能装：不是下载失败，也不给面板里的重试（再下必然同样被拒），按钮改为重新检查
      if (phase.refusal !== null) {
        const reason = refusalReasonCopy({ version: phase.update.version, channel: phase.update.channel, reason: phase.refusal });
        return view(UPDATE_COPY.nothingInstallable, UPDATE_COPY.discarded(reason), check());
      }
      const { summary, raw } = downloadFailureCopy(phase);
      return view(UPDATE_COPY.available(phase.update.version), summary, button(UPDATE_COPY.view, "primary", "open_panel"), { accent: true, raw });
    }
    case "downloading": {
      const fraction = downloadFraction(phase.bytes, phase.totalBytes);
      const title = fraction === null ? UPDATE_COPY.downloading(phase.update.version) : UPDATE_COPY.downloadingPct(phase.update.version, percent(fraction));
      // 还没报过源就是在用第一个源，与报了第 0 个源是同一段
      const sourceIndex = phase.source === null ? 0 : phase.source.index;
      let pct: CardPercent | null = null;
      if (fraction !== null) {
        const [before, after] = aroundPercent(UPDATE_COPY.downloadingPct(phase.update.version, PERCENT_SLOT));
        pct = { value: fraction, track: `${phase.taskId}:${sourceIndex}`, before, after };
      }
      // 已下大小随进度事件约 100 ms 一涨，次句不在这里定稿：交给组件按显示节拍换字
      const progress = { bytes: phase.bytes, totalBytes: phase.totalBytes, switched: sourceSwitchedCopy(phase.source), percent: pct };
      return view(title, null, button(UPDATE_COPY.viewProgress, "secondary", "open_panel"), { progress });
    }
    case "ready":
      return view(UPDATE_COPY.ready(phase.update.version), UPDATE_COPY.readySub, button(UPDATE_COPY.restartInstall, "primary", "install", { disabledReason: installReason }));
    case "install_on_exit":
      return view(UPDATE_COPY.installOnExitCard(phase.update.version), null, button(UPDATE_COPY.installNow, "secondary", "install", { disabledReason: installReason }));
    case "installing":
      return view(UPDATE_COPY.installingCard, null, button(UPDATE_COPY.restartInstall, "primary", "install", { loading: true }));
  }
}
