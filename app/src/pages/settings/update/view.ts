// 关于页更新卡在各阶段的呈现：主句、次句、唯一的按钮。纯函数，便于逐状态核对。

import { formatBytes, formatDate, formatRelative, percent } from "../../../domain/format";
import { UPDATE_COPY } from "../../../copy/updater";
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

export interface CardView {
  title: string;
  /** 有新版本时主句用强调色。 */
  accent: boolean;
  sub: string | null;
  /** 次句是错误原文：可选中复制。 */
  subIsError: boolean;
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

export function updateCardView(state: UpdaterState, ctx: CardContext): CardView {
  const { phase } = state;
  const offline = ctx.online ? undefined : UPDATE_COPY.offlineReason;
  const check = (label: string = UPDATE_COPY.check) => button(label, "secondary", "check", { disabledReason: offline });
  const installReason = ctx.gameRunning ? UPDATE_COPY.gameRunningReason : undefined;
  const view = (title: string, sub: string | null, btn: CardButton, extra: Partial<Pick<CardView, "accent" | "subIsError">> = {}): CardView => ({
    title,
    sub,
    button: btn,
    accent: false,
    subIsError: false,
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
      return view(UPDATE_COPY.checkFailed, phase.message, check(UPDATE_COPY.retry), { subIsError: true });
    case "available": {
      const parts: string[] = [];
      if (phase.update.date !== null) parts.push(UPDATE_COPY.publishedAt(formatDate(phase.update.date)));
      if (ctx.skippedVersion === phase.update.version) parts.push(UPDATE_COPY.skipped);
      const sub = parts.length === 0 ? null : parts.join(" · ");
      return view(UPDATE_COPY.available(phase.update.version), sub, button(UPDATE_COPY.view, "primary", "open_panel"), { accent: true });
    }
    case "download_failed":
      return view(
        UPDATE_COPY.available(phase.update.version),
        UPDATE_COPY.downloadFailedCard(phase.signature ? UPDATE_COPY.signatureInvalid : phase.reason),
        button(UPDATE_COPY.view, "primary", "open_panel"),
        { accent: true, subIsError: true },
      );
    case "downloading": {
      const fraction = downloadFraction(phase.bytes, phase.totalBytes);
      const title = fraction === null ? UPDATE_COPY.downloading(phase.update.version) : UPDATE_COPY.downloadingPct(phase.update.version, percent(fraction));
      const sub = phase.totalBytes === null ? formatBytes(phase.bytes) : UPDATE_COPY.progress(formatBytes(phase.bytes), formatBytes(phase.totalBytes));
      return view(title, sub, button(UPDATE_COPY.viewProgress, "secondary", "open_panel"));
    }
    case "ready":
      return view(UPDATE_COPY.ready(phase.update.version), UPDATE_COPY.readySub, button(UPDATE_COPY.restartInstall, "primary", "install", { disabledReason: installReason }));
    case "install_on_exit":
      return view(UPDATE_COPY.installOnExitCard(phase.update.version), null, button(UPDATE_COPY.installNow, "secondary", "install", { disabledReason: installReason }));
    case "installing":
      return view(UPDATE_COPY.installingCard, null, button(UPDATE_COPY.restartInstall, "primary", "install", { loading: true }));
  }
}
