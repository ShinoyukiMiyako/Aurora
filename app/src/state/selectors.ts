// 选择器：页面、外壳与启动层读状态的统一入口，避免各处自己拼同样的判断。

import type { Account, InstanceSummary } from "../domain/adapt";
import { SIDEBAR_PIN_LIMIT, USED_AUTH_SERVERS_LIMIT } from "../domain/limits";
import type { Task } from "../domain/types";
import { isSessionActive } from "./session";
import type { LauncherState } from "./store";
import { DOWNLOADS_WHEN_RUNNING, isActiveTask, queuePosition as taskQueuePosition, WORLD_TASK_COMMANDS } from "./tasks";

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

/** 游戏在跑或有任务在下时不能换游戏目录。 */
export function gameDirectoryBusy(state: LauncherState): boolean {
  return busyInstanceId(state) !== null || activeTasks(state).length > 0;
}

/** 活动任务里下载类的个数：本地打包与备份不能说成下载。 */
export function activeDownloads(state: LauncherState): number {
  return activeTasks(state).filter((t) => DOWNLOADS_WHEN_RUNNING[t.kind]).length;
}

export function findInstance(state: Pick<LauncherState, "instances">, id: string): InstanceSummary | undefined {
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

/**
 * 这个实例上有备份、导出或恢复任务在排队或进行中的存档（文件夹名，去重后按码位排序）。只随任务的增减变，
 * 不随进度变：按 shallowArrayEqual 订阅不会跟着下载进度重渲染。
 */
export function busyWorlds(state: LauncherState, instanceId: string): string[] {
  const worlds = new Set<string>();
  for (const task of state.tasks) {
    if (!isActiveTask(task) || task.instanceId !== instanceId || !WORLD_TASK_COMMANDS.has(task.spec.command)) continue;
    const world = task.spec.args.world;
    if (typeof world !== "string") throw new Error(`任务 ${task.title} 的参数 world 应为字符串`);
    worlds.add(world);
  }
  return [...worlds].sort();
}

/**
 * 实例的存档此刻正被备份、恢复或导出，后端会以 instance_busy 拒绝启动：后端报着 backing_up，或者前端有它的存档任务
 * 在排队或进行中（列表是任务开始前扫的，排着的任务一开始就会占住实例，这时点启动正好撞上它）。
 */
export function savesBusy(state: LauncherState, inst: InstanceSummary): boolean {
  return inst.activity === "backing_up" || busyWorlds(state, inst.id).length > 0;
}

/** 存档正被备份、恢复或导出的实例 id，按实例列表的顺序。只随实例列表与任务的增减变，按 shallowArrayEqual 订阅。 */
export function savesBusyIds(state: LauncherState): string[] {
  return state.instances.filter((inst) => savesBusy(state, inst)).map((inst) => inst.id);
}

/**
 * 这个实例有勾了存档的导出整合包任务在排队或进行中：导出会把整份存档读进包里，后端在它读完前拒绝恢复存档
 * （恢复要替换存档）；只读存档的备份与导出存档不受影响。只随任务的增减变。
 */
export function savesExported(state: LauncherState, instanceId: string): boolean {
  return state.tasks.some((task) => {
    if (!isActiveTask(task) || task.instanceId !== instanceId || task.spec.command !== "export_modpack") return false;
    const options = task.spec.args.options;
    if (typeof options !== "object" || options === null || !("extras" in options) || !Array.isArray(options.extras)) {
      throw new Error(`任务 ${task.title} 的参数 options.extras 应为数组`);
    }
    return options.extras.includes("saves");
  });
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

/**
 * 已有外置登录账户用过的验证服务器：按 API 根地址去重，最近添加的账户在前，最多 USED_AUTH_SERVERS_LIMIT 个。
 * except 里的地址（已经有固定快捷项的）不列。
 */
export function usedAuthServers(state: LauncherState, except: readonly string[]): { serverUrl: string; serverName: string }[] {
  const seen = new Set<string>(except);
  const servers: { serverUrl: string; serverName: string }[] = [];
  for (const account of [...state.accounts].sort((a, b) => b.addedAt - a.addedAt)) {
    if (account.kind !== "authlib") continue;
    if (account.serverUrl === null || account.authServer === null) throw new Error(`外置登录账户 ${account.name} 缺少验证服务器`);
    if (seen.has(account.serverUrl)) continue;
    seen.add(account.serverUrl);
    servers.push({ serverUrl: account.serverUrl, serverName: account.authServer });
  }
  return servers.slice(0, USED_AUTH_SERVERS_LIMIT);
}

/**
 * 有活动会话、排队或进行中的任务、或自动备份在跑时，关闭窗口要先确认。
 * 自动备份是后端在游戏退出后直接跑的，不在任务表里，只能看实例报的 backing_up；手动备份也报它，已经算在任务里，不重复数。
 * downloads 是 tasks 里下载类的个数，本地打包与备份不能说成下载。
 */
export function closeNeedsConfirm(state: LauncherState): { session: boolean; tasks: number; downloads: number; backups: number } {
  const tasks = activeTasks(state);
  const backups = state.instances.filter((inst) => inst.activity === "backing_up" && !tasks.some((t) => t.instanceId === inst.id)).length;
  return { session: busyInstanceId(state) !== null, tasks: tasks.length, downloads: activeDownloads(state), backups };
}
