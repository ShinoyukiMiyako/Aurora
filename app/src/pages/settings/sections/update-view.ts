// 关于页更新卡在各阶段的呈现：主句、次句、唯一的按钮。纯函数，便于逐状态核对。

import { formatBytes, formatDate, formatRelative, percent } from "../../../domain/format";
import { downloadFailureCopy, sourceSwitchedCopy, UPDATE_COPY } from "../../../copy/updater";
import { downloadFraction, type UpdaterState } from "../../../state/updater/machine";

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
}

/** 下载中的次句素材：已下大小要按显示节拍换字，由渲染它的组件节流后交给 downloadSub 拼成句子。 */
export interface CardProgress {
  bytes: number;
  totalBytes: number | null;
  /** 换过源时跟在字节后面的一句；还在第一个源时为 null。 */
  switched: string | null;
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

function button(label: string, variant: CardButton["variant"], action: CardAction, extra: Partial<Omit<CardButton, "label" | "variant" | "action">> = {}): CardButton {
  return { label, variant, action, loading: false, disabled: false, disabledReason: undefined, ...extra };
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
      return view(UPDATE_COPY.current(state.currentVersion), ctx.checkUpdates ? UPDATE_COPY.autoOn : UPDATE_COPY.autoOff, check());
    }
    case "checking":
      return view(UPDATE_COPY.checking, null, button(UPDATE_COPY.check, "secondary", "check", { loading: true }));
    case "up_to_date":
      return view(UPDATE_COPY.upToDate, UPDATE_COPY.checkedAgo(formatRelative(phase.checkedAt, ctx.now)), check());
    case "check_failed":
      return view(phase.network === null ? UPDATE_COPY.checkFailed : UPDATE_COPY.networkFailed[phase.network], phase.message, check(UPDATE_COPY.retry), { subIsError: true });
    case "available": {
      const parts: string[] = [];
      if (phase.update.date !== null) parts.push(UPDATE_COPY.publishedAt(formatDate(phase.update.date)));
      if (ctx.skippedVersion === phase.update.version) parts.push(UPDATE_COPY.skipped);
      const sub = parts.length === 0 ? null : parts.join(" · ");
      return view(UPDATE_COPY.available(phase.update.version), sub, button(UPDATE_COPY.view, "primary", "open_panel"), { accent: true });
    }
    case "download_failed": {
      const { summary, raw } = downloadFailureCopy(phase);
      return view(UPDATE_COPY.available(phase.update.version), summary, button(UPDATE_COPY.view, "primary", "open_panel"), { accent: true, raw });
    }
    case "downloading": {
      const fraction = downloadFraction(phase.bytes, phase.totalBytes);
      const title = fraction === null ? UPDATE_COPY.downloading(phase.update.version) : UPDATE_COPY.downloadingPct(phase.update.version, percent(fraction));
      // 已下大小随进度事件约 100 ms 一涨，次句不在这里定稿：交给组件按显示节拍换字
      const progress = { bytes: phase.bytes, totalBytes: phase.totalBytes, switched: sourceSwitchedCopy(phase.source) };
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
