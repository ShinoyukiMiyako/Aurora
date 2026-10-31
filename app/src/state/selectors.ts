// 选择器：页面、外壳与启动层读状态的统一入口，避免各处自己拼同样的判断。

import type { Account, InstanceSummary } from "../domain/adapt";
import { SIDEBAR_PIN_LIMIT } from "../domain/limits";
import type { Task } from "../domain/types";
import { isSessionActive } from "./session";
import type { LauncherState } from "./store";
import { isActiveTask, queuePosition as taskQueuePosition } from "./tasks";

export function activeAccount(state: LauncherState): Account | null {
  if (state.currentAccountId === null) return null;
  const account = state.accounts.find((a) => a.uuid === state.currentAccountId);
  if (account === undefined) throw new Error(`当前账户 ${state.currentAccountId} 不在账户列表里`);
  return account;
}

/** 正在占用游戏进程的实例（准备 / 下载 / 启动 / 运行中）；没有为 null。 */
export function busyInstanceId(state: LauncherState): string | null {
  return state.session !== null && isSessionActive(state.session) ? state.session.instanceId : null;
}

export function activeTasks(state: LauncherState): Task[] {
  return state.tasks.filter(isActiveTask);
}

export function findInstance(state: LauncherState, id: string): InstanceSummary | undefined {
  return state.instances.find((i) => i.id === id);
}

/** 按 id 取实例；不存在时抛错（路由剪除保证页面拿不到已删除的 id）。 */
export function getInstance(state: LauncherState, id: string): InstanceSummary {
  const inst = findInstance(state, id);
  if (inst === undefined) throw new Error(`实例 ${id} 不存在`);
  return inst;
}

/** 实例当前挂着的未完成任务（新建、导入、修复、装 Mod 等）。 */
export function instanceTask(state: LauncherState, instanceId: string): Task | null {
  const task = state.tasks.find((t) => t.instanceId === instanceId && isActiveTask(t));
  return task === undefined ? null : task;
}

export function queuePosition(state: LauncherState, taskId: string): number | null {
  return taskQueuePosition(state.tasks, taskId);
}

/**
 * 侧栏固定的实例，按固定顺序。固定列表与实例列表来自两条命令、分别刷新：删除或改名后两者之间有一拍不同步，
 * 这一拍里指向已不在列表中的实例的固定项不画（后端返回的固定列表本身不含已删除的实例）。
 */
export function pinnedInstances(state: LauncherState): InstanceSummary[] {
  return state.sidebarPins.flatMap((id) => {
    const inst = findInstance(state, id);
    return inst === undefined ? [] : [inst];
  });
}

/** 还能再固定一个（已固定的取消固定不受此限）。 */
export function canPinMore(state: LauncherState): boolean {
  return state.sidebarPins.length < SIDEBAR_PIN_LIMIT;
}

/** 有活动会话或排队、进行中的任务时，关闭窗口要先确认。 */
export function closeNeedsConfirm(state: LauncherState): { session: boolean; tasks: number } {
  return { session: busyInstanceId(state) !== null, tasks: activeTasks(state).length };
}
