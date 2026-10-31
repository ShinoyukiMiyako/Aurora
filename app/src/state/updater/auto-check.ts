// 自动检查更新的节奏，以及查完之后「这一版要不要提示」的判断。纯函数与常量；计时与提示由外壳安排。

import type { UpdateInfo, UpdaterState } from "./machine";

/** 启动后等这么久才查第一次：避开首屏加载与启动时的那一批请求。 */
export const AUTO_CHECK_DELAY_MS = 8_000;
/** 之后在运行期间每隔这么久再查一次。 */
export const AUTO_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

export interface AutoCheckContext {
  /** 首次启动向导还没走完（或还不知道）时不查。 */
  firstRun: boolean | null;
  /** 配置里的「自动检查更新」；配置还没读到为 null。 */
  checkUpdates: boolean | null;
}

/**
 * 现在该不该排期自动检查。后端更新信息还没到、或当前环境不支持更新（调试构建、没配公钥）时不排期，
 * 整个会话都不会发出检查请求。
 */
export function autoCheckEnabled(state: UpdaterState, ctx: AutoCheckContext): boolean {
  if (ctx.firstRun !== false || ctx.checkUpdates !== true) return false;
  return state.currentVersion !== null && state.phase.kind !== "unsupported";
}

/**
 * 一次自动检查之后要提示的版本：查到了新版本，并且用户没跳过它、之前没为它提示过、也没在更新面板里看过它。
 * 其余情况为 null（已是最新、检查失败、这一版已经知会过）。
 */
export function updateToAnnounce(state: UpdaterState, skippedVersion: string | null, notifiedVersion: string | null): UpdateInfo | null {
  const { phase } = state;
  if (phase.kind !== "available") return null;
  const { version } = phase.update;
  if (version === skippedVersion || version === notifiedVersion || version === state.seenVersion) return null;
  return phase.update;
}
