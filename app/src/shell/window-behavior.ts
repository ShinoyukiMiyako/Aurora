// 窗口层面的三件事：关闭前确认、游戏启动后按设置最小化或关闭启动器、窗口在后台时的任务栏提醒。
// 判定都是纯函数（便于逐条测试），钩子只负责在状态变化时调用它们并经外层统一错误处理执行窗口操作。

import { useEffect, useRef } from "react";
import { ACTION_ERROR, CONFIRM_COPY } from "../copy/flows";
import type { TaskKind } from "../domain/types";
import type { AfterLaunch } from "../ipc/config";
import type { ConfirmOptions } from "../launch/host";
import { useLauncher } from "../state/launcher";
import { activeTasks, closeNeedsConfirm } from "../state/selectors";
import type { LauncherState } from "../state/store";
import { isActiveTask } from "../state/tasks";
import { SHELL_ACTION_ERROR } from "../copy/shell";
import { useShell } from "./shell";
import { useRunner } from "./useRunner";
import { useWindowPort } from "./window";

// ---------------------------------------------------------------- 关闭确认

/** 关闭前要不要确认、确认框写什么。会话与任务同时成立时合并成一个对话框，正文按「会话、任务」顺序拼接。 */
export function closeConfirmOptions(need: { session: boolean; tasks: number }): ConfirmOptions | null {
  if (!need.session && need.tasks === 0) return null;
  const body = [need.session ? CONFIRM_COPY.closeWithSession : "", need.tasks > 0 ? CONFIRM_COPY.closeWithTasks(need.tasks) : ""].join("");
  return {
    title: CONFIRM_COPY.closeTitle,
    body,
    confirmLabel: CONFIRM_COPY.closeConfirm,
    // 只有任务时取消键说「继续下载」；有会话时取消的是「关掉启动器」本身，用「取消」
    cancelLabel: need.session ? CONFIRM_COPY.cancel : CONFIRM_COPY.keepDownloading,
    tone: "danger",
  };
}

/**
 * 关闭键、Alt+F4、任务栏关闭都进同一个关闭请求处理器：先挡住默认关闭，需要时确认，
 * 确认后把下载任务记录立即写一次再销毁窗口。确认退出不结束游戏进程。
 */
export function useCloseGuard(): void {
  const { state, actions } = useLauncher();
  const { confirm } = useShell();
  const run = useRunner();
  const port = useWindowPort();
  const latest = useRef({ state, actions, confirm, run });
  latest.current = { state, actions, confirm, run };

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const onClose = async (request: { preventDefault(): void }) => {
      request.preventDefault();
      const { state: now, actions: act, confirm: ask, run: exec } = latest.current;
      const options = closeConfirmOptions(closeNeedsConfirm(now));
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
 * 「关闭启动器」的自动退出不弹关闭确认。设置还没读到时按「保持打开」处理。
 */
export function useAfterLaunch(): void {
  const { state, actions } = useLauncher();
  const run = useRunner();
  const port = useWindowPort();
  const prevSession = useRef(state.session);
  const minimizedFor = useRef<string | null>(null);

  useEffect(() => {
    const prev = prevSession.current;
    const next = state.session;
    prevSession.current = next;
    const enteredRunning = next !== null && next.phase === "running" && (prev === null || prev.taskId !== next.taskId || prev.phase !== "running");
    if (enteredRunning) {
      const setting = state.settings === null ? "keep" : state.settings.afterLaunch;
      const move = afterLaunchMove(setting, activeTasks(state).length);
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
      if (await port.isMinimized()) await port.unminimize();
    }, SHELL_ACTION_ERROR.restore);
  }, [actions, port, run, state]);
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

/**
 * 两次状态之间值得在后台提醒的事件。任务只认「上一刻还在跑、这一刻结束」的转变：
 * 启动时从任务日志恢复出来的失败记录不是这次运行里发生的，不提醒。
 */
export function attentionEvents(prev: LauncherState, next: LauncherState): AttentionEvent[] {
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
  const { state } = useLauncher();
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
      if (restore && minimized) await port.unminimize();
      await port.requestAttention();
    }, SHELL_ACTION_ERROR.attention);
  }, [port, run, state]);
}
