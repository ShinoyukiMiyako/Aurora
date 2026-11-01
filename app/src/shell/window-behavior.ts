// 窗口层面的三件事：关闭前确认、游戏启动后按设置最小化或关闭启动器、窗口在后台时的任务栏提醒。
// 判定都是纯函数（便于逐条测试），钩子只负责在状态变化时调用它们并经外层统一错误处理执行窗口操作。
// 三个钩子都挂在外壳根上：只按片订阅各自要判断的那几样（会话的阶段、任务的状态与个数），
// 下载进度与游戏日志每 100 ms 换一次状态，整份订阅会让外壳根和它不带 memo 的子部件跟着重渲染。

import { useEffect, useRef } from "react";
import { ACTION_ERROR, CONFIRM_COPY } from "../copy/flows";
import type { SessionPhase, TaskKind } from "../domain/types";
import type { AfterLaunch } from "../ipc/config";
import type { ConfirmOptions } from "../launch/host";
import { useLauncherActions, useLauncherSelector } from "../state/launcher";
import { activeTasks, closeNeedsConfirm } from "../state/selectors";
import type { LauncherState } from "../state/store";
import { isActiveTask } from "../state/tasks";
import { SHELL_ACTION_ERROR } from "../copy/shell";
import { useShell } from "./shell";
import { useRunner } from "./useRunner";
import { useWindowPort } from "./window";

// ---------------------------------------------------------------- 订阅的片

/** 会话是哪一次启动、在哪个阶段；日志与进度不在其中。 */
export interface SessionStep {
  taskId: string;
  phase: SessionPhase;
}

export function sessionStep(state: Pick<LauncherState, "session">): SessionStep | null {
  const s = state.session;
  return s === null ? null : { taskId: s.taskId, phase: s.phase };
}

export function sameSessionStep(a: SessionStep | null, b: SessionStep | null): boolean {
  if (a === null || b === null) return a === b;
  return a.taskId === b.taskId && a.phase === b.phase;
}

// ---------------------------------------------------------------- 关闭确认

/** 关闭前要不要确认、确认框写什么。几件事同时成立时合并成一个对话框，正文按「会话、任务、自动备份」顺序拼接。 */
export function closeConfirmOptions(need: { session: boolean; tasks: number; backups: number }): ConfirmOptions | null {
  if (!need.session && need.tasks === 0 && need.backups === 0) return null;
  const body = [
    need.session ? CONFIRM_COPY.closeWithSession : "",
    need.tasks > 0 ? CONFIRM_COPY.closeWithTasks(need.tasks) : "",
    need.backups > 0 ? CONFIRM_COPY.closeWithBackups(need.backups) : "",
  ].join("");
  return {
    title: CONFIRM_COPY.closeTitle,
    body,
    confirmLabel: CONFIRM_COPY.closeConfirm,
    // 只有任务时取消键说「继续下载」；有会话或只有备份时取消的是「关掉启动器」本身，用「取消」
    cancelLabel: need.session || need.tasks === 0 ? CONFIRM_COPY.cancel : CONFIRM_COPY.keepDownloading,
    tone: "danger",
  };
}

/**
 * 关闭键、Alt+F4、任务栏关闭都进同一个关闭请求处理器：先挡住默认关闭，需要时确认，
 * 确认后把下载任务记录立即写一次再销毁窗口。确认退出不结束游戏进程。
 */
export function useCloseGuard(): void {
  const need = useLauncherSelector(closeNeedsConfirm, (a, b) => a.session === b.session && a.tasks === b.tasks && a.backups === b.backups);
  const actions = useLauncherActions();
  const { confirm } = useShell();
  const run = useRunner();
  const port = useWindowPort();
  const latest = useRef({ need, actions, confirm, run });
  latest.current = { need, actions, confirm, run };

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const onClose = async (request: { preventDefault(): void }) => {
      request.preventDefault();
      const { need: now, actions: act, confirm: ask, run: exec } = latest.current;
      const options = closeConfirmOptions(now);
      if (options !== null && !(await ask(options))) return;
      await exec(() => act.flushTaskJournal(), ACTION_ERROR.saveJournal);
      await exec(() => port.destroy(), SHELL_ACTION_ERROR.close);
    };
    port.onCloseRequested(onClose).then(
      (release) => {
        if (disposed) release();
        else unlisten = release;
      },
      (error: unknown) => void latest.current.run(() => Promise.reject(error), SHELL_ACTION_ERROR.close),
    );
    return () => {
      disposed = true;
      if (unlisten !== null) unlisten();
    };
  }, [port]);
}

// ---------------------------------------------------------------- 游戏启动后

export type AfterLaunchMove = "keep" | "minimize" | "exit";

/** 「游戏启动后」设置在进入运行时的动作：关闭启动器时有进行中的下载任务降级为最小化。 */
export function afterLaunchMove(setting: AfterLaunch, activeTaskCount: number): AfterLaunchMove {
  if (setting === "keep") return "keep";
  if (setting === "minimize") return "minimize";
  return activeTaskCount > 0 ? "minimize" : "exit";
}

/**
 * 进入运行时按设置最小化或退出；因此最小化过的窗口在这个会话的进程退出时恢复，好让用户看到结束或崩溃。
 * 恢复不激活窗口：游戏退出时用户可能已在别的窗口里打字，焦点不该被启动器抢走。
 * 「关闭启动器」的自动退出不弹关闭确认。设置还没读到时按「保持打开」处理。
 */
export function useAfterLaunch(): void {
  const step = useLauncherSelector(sessionStep, sameSessionStep);
  const setting = useLauncherSelector((s): AfterLaunch => (s.settings === null ? "keep" : s.settings.afterLaunch));
  const activeCount = useLauncherSelector((s) => activeTasks(s).length);
  const actions = useLauncherActions();
  const run = useRunner();
  const port = useWindowPort();
  const prevSession = useRef(step);
  const minimizedFor = useRef<string | null>(null);

  useEffect(() => {
    const prev = prevSession.current;
    const next = step;
    prevSession.current = next;
    const enteredRunning = next !== null && next.phase === "running" && (prev === null || prev.taskId !== next.taskId || prev.phase !== "running");
    if (enteredRunning) {
      const move = afterLaunchMove(setting, activeCount);
      if (move === "minimize") {
        minimizedFor.current = next.taskId;
        void run(() => port.minimize(), SHELL_ACTION_ERROR.afterLaunch);
      } else if (move === "exit") {
        void (async () => {
          await run(() => actions.flushTaskJournal(), ACTION_ERROR.saveJournal);
          await run(() => port.destroy(), SHELL_ACTION_ERROR.afterLaunch);
        })();
      }
      return;
    }
    const owner = minimizedFor.current;
    if (owner === null) return;
    const stillRunning = next !== null && next.taskId === owner && next.phase === "running";
    if (stillRunning) return;
    minimizedFor.current = null;
    void run(async () => {
      if (await port.isMinimized()) await port.restoreWithoutFocus();
    }, SHELL_ACTION_ERROR.restore);
  }, [actions, activeCount, port, run, setting, step]);
}

// ---------------------------------------------------------------- 后台提醒

export type AttentionKind = "crashed" | "launch_failed" | "instance_ready" | "task_failed";

export interface AttentionEvent {
  kind: AttentionKind;
  /** 崩溃与启动失败要把最小化的窗口恢复出来，其余只闪任务栏。 */
  restore: boolean;
}

/** 新建、导入、修复：完成后实例才可用，算「实例级任务」。 */
const INSTANCE_TASK_KINDS: ReadonlySet<TaskKind> = new Set(["game", "modpack", "repair"]);

/** 判断后台提醒要看的两样：会话（只看是哪一次启动、在哪个阶段）与任务（只看 id、种类与状态）。 */
export type AttentionInputs = Pick<LauncherState, "session" | "tasks">;

function attentionInputs(state: LauncherState): AttentionInputs {
  return { session: state.session, tasks: state.tasks };
}

/** 两份输入算出的提醒一样：会话的启动与阶段相同，任务逐个 id、种类、状态相同。下载进度与日志不改变它。 */
export function sameAttentionInputs(a: AttentionInputs, b: AttentionInputs): boolean {
  if (!sameSessionStep(sessionStep(a), sessionStep(b))) return false;
  if (a.tasks === b.tasks) return true;
  return a.tasks.length === b.tasks.length && a.tasks.every((t, i) => {
    const u = b.tasks[i];
    return t.id === u.id && t.kind === u.kind && t.status === u.status;
  });
}

/**
 * 两次状态之间值得在后台提醒的事件。任务只认「上一刻还在跑、这一刻结束」的转变：
 * 启动时从任务日志恢复出来的失败记录不是这次运行里发生的，不提醒。
 */
export function attentionEvents(prev: AttentionInputs, next: AttentionInputs): AttentionEvent[] {
  const events: AttentionEvent[] = [];
  const s = next.session;
  if (s !== null && (s.phase === "crashed" || s.phase === "failed")) {
    const before = prev.session;
    const changed = before === null || before.taskId !== s.taskId || before.phase !== s.phase;
    if (changed) events.push({ kind: s.phase === "crashed" ? "crashed" : "launch_failed", restore: true });
  }
  if (next.tasks !== prev.tasks) {
    const previous = new Map(prev.tasks.map((t) => [t.id, t]));
    for (const task of next.tasks) {
      const before = previous.get(task.id);
      if (before === undefined || !isActiveTask(before)) continue;
      if (task.status === "failed") events.push({ kind: "task_failed", restore: false });
      else if (task.status === "done" && INSTANCE_TASK_KINDS.has(task.kind)) events.push({ kind: "instance_ready", restore: false });
    }
  }
  return events;
}

/** 窗口最小化或没有焦点时，崩溃、启动失败、实例就绪、任务失败要请求任务栏提醒；前台时什么都不做。 */
export function useBackgroundAttention(): void {
  const state = useLauncherSelector(attentionInputs, sameAttentionInputs);
  const run = useRunner();
  const port = useWindowPort();
  const prevState = useRef(state);

  useEffect(() => {
    const prev = prevState.current;
    prevState.current = state;
    if (prev === state) return;
    const events = attentionEvents(prev, state);
    if (events.length === 0) return;
    const restore = events.some((e) => e.restore);
    void run(async () => {
      const [focused, minimized] = await Promise.all([port.isFocused(), port.isMinimized()]);
      if (focused && !minimized) return;
      if (restore && minimized) await port.restoreWithoutFocus();
      await port.requestAttention();
    }, SHELL_ACTION_ERROR.attention);
  }, [port, run, state]);
}
