// 通知切片：时长、上限与挤出、去重、暂停全部在这里实现，调用方不传时长。纯函数，计时器由状态容器安排。
//
// 寿命用绝对截止时刻 deadline 表示，暂停期间改记剩余寿命 pausedRemainingMs；两者同时只有一个非空。
// 暂停有两个来源（指针悬停或焦点在任意一条通知内、窗口不可见），任一来源存在即全部暂停，全部解除才恢复；
// 恢复时剩余不足 TOAST_MIN_REMAIN_MS 的补到这个值，免得刚移开指针就消失。

import { TOAST_ACTION_MIN_TTL_MS, TOAST_DEDUPE_MS, TOAST_MAX, TOAST_MIN_REMAIN_MS, TOAST_TTL_MS } from "../domain/limits";
import { renamedRoute, routeInstanceId, type Route } from "./route";

export type ToastTone = "info" | "success" | "warning" | "error";

/**
 * 至多一个动作：导航用 to，执行命令（重试、下载 Java、启动等）用 run。点击后先关闭这条再执行。
 * 命令经外层统一错误处理执行，失败通知的标题取 errorTitle（动作文案只有两三个字，当不了失败标题）。
 * instance：动作闭包里写死的实例（见 instanceAction）。路由是数据，改名时直接改写；闭包改写不了，要靠它重建。
 */
export type ToastAction = { label: string; instance?: ToastActionInstance } & ({ to: Route } | { run: () => void | Promise<void>; errorTitle: string });

interface ToastActionInstance {
  id: string;
  build: (id: string) => ToastAction;
}

/** 闭包里带着实例 id 的动作：build 按给定的 id 造动作，实例改名时用新 id 重造一份。 */
export function instanceAction(id: string, build: (id: string) => ToastAction): ToastAction {
  return { ...build(id), instance: { id, build } };
}

export interface Toast {
  id: string;
  tone: ToastTone;
  title: string;
  body?: string;
  createdAt: number;
  /** 满额寿命；null 表示不自动消失（error）。 */
  ttlMs: number | null;
  /** 未暂停时的消失时刻；不自动消失或暂停中为 null。 */
  deadline: number | null;
  /** 暂停期间记录的剩余寿命；未暂停为 null。 */
  pausedRemainingMs: number | null;
  /** 去重时并进这一条的次数。每并进一次加 1，界面据此给一次反馈：不然重复的通知像是没发出来。 */
  repeats: number;
  action?: ToastAction;
}

export type ToastPauseReason = "hover" | "hidden";

export interface ToastsState {
  items: Toast[];
  pausedBy: readonly ToastPauseReason[];
  seq: number;
}

export interface ToastInput {
  tone: ToastTone;
  title: string;
  body?: string;
  action?: ToastAction;
}

export const EMPTY_TOASTS: ToastsState = { items: [], pausedBy: [], seq: 0 };

/** 满额寿命：按色调取值，带动作时至少 TOAST_ACTION_MIN_TTL_MS；error 无论如何不自动消失。 */
export function toastTtl(tone: ToastTone, hasAction: boolean): number | null {
  const base = TOAST_TTL_MS[tone];
  if (base === null) return null;
  return hasAction ? Math.max(base, TOAST_ACTION_MIN_TTL_MS) : base;
}

function withFullLife(toast: Toast, paused: boolean, now: number): Toast {
  if (toast.ttlMs === null) return { ...toast, deadline: null, pausedRemainingMs: null };
  return paused ? { ...toast, deadline: null, pausedRemainingMs: toast.ttlMs } : { ...toast, deadline: now + toast.ttlMs, pausedRemainingMs: null };
}

/** 挤出一条：优先最早的非 error；全是 error 时挤最早的那条。 */
function evictOne(items: Toast[]): Toast[] {
  const victim = items.findIndex((t) => t.tone !== "error");
  const index = victim === -1 ? 0 : victim;
  return items.filter((_, i) => i !== index);
}

export function pushToast(state: ToastsState, input: ToastInput, now: number): { state: ToastsState; id: string } {
  const paused = state.pausedBy.length > 0;
  const target = targetOf(input.action);
  // 文案相同但动作指向别的实例时并进旧条，新通知就用上了旧动作
  const duplicate = state.items.find(
    (t) => t.tone === input.tone && t.title === input.title && t.body === input.body && now - t.createdAt <= TOAST_DEDUPE_MS && targetOf(t.action) === target,
  );
  if (duplicate) {
    const items = state.items.map((t) => (t === duplicate ? { ...withFullLife(t, paused, now), repeats: t.repeats + 1 } : t));
    return { state: { ...state, items }, id: duplicate.id };
  }
  const seq = state.seq + 1;
  const id = `toast-${seq}`;
  const base: Toast = {
    id,
    tone: input.tone,
    title: input.title,
    createdAt: now,
    ttlMs: toastTtl(input.tone, input.action !== undefined),
    deadline: null,
    pausedRemainingMs: null,
    repeats: 0,
  };
  if (input.body !== undefined) base.body = input.body;
  if (input.action !== undefined) base.action = input.action;
  let items = [...state.items, withFullLife(base, paused, now)];
  while (items.length > TOAST_MAX) items = evictOne(items);
  return { state: { ...state, items, seq }, id };
}

export function dismissToast(state: ToastsState, id: string): ToastsState {
  if (!state.items.some((t) => t.id === id)) return state;
  return { ...state, items: state.items.filter((t) => t.id !== id) };
}

export function pauseToasts(state: ToastsState, reason: ToastPauseReason, now: number): ToastsState {
  if (state.pausedBy.includes(reason)) return state;
  const wasPaused = state.pausedBy.length > 0;
  const pausedBy = [...state.pausedBy, reason];
  if (wasPaused) return { ...state, pausedBy };
  const items = state.items.map((t) => (t.deadline === null ? t : { ...t, deadline: null, pausedRemainingMs: Math.max(0, t.deadline - now) }));
  return { ...state, items, pausedBy };
}

export function resumeToasts(state: ToastsState, reason: ToastPauseReason, now: number): ToastsState {
  if (!state.pausedBy.includes(reason)) return state;
  const pausedBy = state.pausedBy.filter((r) => r !== reason);
  if (pausedBy.length > 0) return { ...state, pausedBy };
  const items = state.items.map((t) =>
    t.pausedRemainingMs === null ? t : { ...t, deadline: now + Math.max(t.pausedRemainingMs, TOAST_MIN_REMAIN_MS), pausedRemainingMs: null },
  );
  return { ...state, items, pausedBy };
}

function actionTarget(action: ToastAction): string | null {
  if (action.instance !== undefined) return action.instance.id;
  return "to" in action ? routeInstanceId(action.to) : null;
}

function targetOf(action: ToastAction | undefined): string | null {
  return action === undefined ? null : actionTarget(action);
}

function mapTargeting(state: ToastsState, id: string, change: (toast: Toast, action: ToastAction) => Toast): ToastsState {
  const targets = (toast: Toast) => toast.action !== undefined && actionTarget(toast.action) === id;
  if (!state.items.some(targets)) return state;
  return { ...state, items: state.items.map((t) => (t.action !== undefined && targets(t) ? change(t, t.action) : t)) };
}

/**
 * 实例改名：动作指向旧 id 的通知换到新 id。只动此刻留着的通知，之后有实例用上旧名字时，新发的通知按新实例走，
 * 留着的已经离开了这个名字，不必分辨一个名字说的是改名前还是改名后的实例。
 */
export function retargetToasts(state: ToastsState, from: string, to: string): ToastsState {
  return mapTargeting(state, from, (toast, action) => {
    if (action.instance !== undefined) return { ...toast, action: instanceAction(to, action.instance.build) };
    return "to" in action ? { ...toast, action: { ...action, to: renamedRoute(action.to, from, to) } } : toast;
  });
}

/** 实例删除：通知留着，动作摘掉。之后有实例用上这个名字时，点它不能落到新实例上。 */
export function detachToasts(state: ToastsState, id: string): ToastsState {
  return mapTargeting(state, id, (toast) => ({ ...toast, action: undefined }));
}

/** 换游戏目录：实例 id 只在一个目录内唯一，留着的动作可能落到另一目录的同名实例上，一律摘掉。 */
export function detachInstanceToasts(state: ToastsState): ToastsState {
  if (!state.items.some((t) => targetOf(t.action) !== null)) return state;
  return { ...state, items: state.items.map((t) => (targetOf(t.action) === null ? t : { ...t, action: undefined })) };
}

/** 移除到期的通知。 */
export function expireToasts(state: ToastsState, now: number): ToastsState {
  if (!state.items.some((t) => t.deadline !== null && t.deadline <= now)) return state;
  return { ...state, items: state.items.filter((t) => t.deadline === null || t.deadline > now) };
}

/** 最近一个到期时刻；没有会自动消失的通知（或全部暂停中）为 null。 */
export function nextToastDeadline(state: ToastsState): number | null {
  let next: number | null = null;
  for (const t of state.items) if (t.deadline !== null && (next === null || t.deadline < next)) next = t.deadline;
  return next;
}

export interface ToastCountdown {
  /** 剩余寿命占满额寿命的比例，倒计时细线按它画。 */
  fraction: number;
  remainingMs: number;
  paused: boolean;
}

/** 通知单条组件的倒计时；不自动消失的通知没有倒计时，为 null。 */
export function toastCountdown(toast: Toast, now: number): ToastCountdown | null {
  if (toast.ttlMs === null) return null;
  if (toast.pausedRemainingMs !== null) {
    return { fraction: Math.min(1, toast.pausedRemainingMs / toast.ttlMs), remainingMs: toast.pausedRemainingMs, paused: true };
  }
  if (toast.deadline === null) throw new Error(`通知 ${toast.id} 既没有截止时刻也没有暂停剩余`);
  const remainingMs = Math.max(0, toast.deadline - now);
  return { fraction: Math.min(1, remainingMs / toast.ttlMs), remainingMs, paused: false };
}
