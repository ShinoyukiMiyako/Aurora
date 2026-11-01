// 头图菜单、设置页「实例管理」与崩溃页共用的一组实例操作：重命名、固定、打开文件夹、导出整合包、补全与删除。
// 几处入口的锁定判断与反馈都从这里出，保证完全一致（删除确认与实例库共用 delete.tsx）。动作一律经外层统一错误处理执行。

import { ACTION_ERROR } from "../../copy/flows";
import type { InstanceSummary } from "../../domain/adapt";
import { instanceNameError } from "../../domain/rules";
import { useRunner } from "../../shell/useRunner";
import { shallowArrayEqual, useLauncherActions, useLauncherSelector } from "../../state/launcher";
import { busyInstanceId } from "../../state/selectors";
import type { LauncherActions } from "../../state/store";
import { HERO_COPY, LOCK_REASON, OVERVIEW_COPY } from "./copy";
import { useDeleteInstance } from "./delete";
import { instanceLocks, workLock, type InstanceLock, type InstanceLocks, type WorkLock } from "./model";

/** 打开文件夹的目标，与状态层动作的入参同一类型。 */
export type FolderTarget = Parameters<LauncherActions["openFolder"]>[0];

/** 打开前后端要先占住实例（缺了要建出来）的工作子目录；实例文件夹本身与单个存档只是定位，不占。 */
const WORK_FOLDERS: ReadonlySet<FolderTarget> = new Set<FolderTarget>(["mods", "saves", "resourcepacks", "shaderpacks", "logs", "screenshots"]);

export interface InstanceOps {
  locks: InstanceLocks;
  /** 打开工作子目录与写实例设置的锁：安装、补全、改名、删除进行中；游戏运行不挡。 */
  work: WorkLock | null;
  busy: boolean;
  installing: boolean;
  /** 校验新名字；与当前名字相同（只改大小写也算不同）时为 null。 */
  nameError(name: string): string | null;
  /** 成功返回 true；失败已由统一错误处理报告。 */
  rename(name: string): Promise<boolean>;
  togglePin(): void;
  openFolder(target: FolderTarget, world?: string): void;
  /** 这个目标此刻打不开的原因；能打开为 undefined。 */
  folderReason(target: FolderTarget): string | undefined;
  /** 实例设置此刻改不了的原因；能改为 undefined，可以直接交给 disabledReason。 */
  settingsReason: string | undefined;
  /** 此刻不能导出整合包的原因；能导出为 undefined。菜单项与导出弹窗的主按钮共用它。 */
  exportReason: string | undefined;
  repair(): void;
  remove(): void;
}

/** 锁定原因的悬停文字；没有锁为 undefined，可以直接交给 disabledReason。 */
export function lockReason(lock: InstanceLock | null, kind: "mods" | "rename" | "repair" | "delete"): string | undefined {
  if (lock === null) return undefined;
  if (lock === "modifying" || lock === "backing_up") {
    if (kind === "mods") throw new Error(`${lock} 与改动 Mod 互相兼容，不会因此锁住 Mod 操作`);
    return lock === "modifying" ? LOCK_REASON.modifying[kind] : LOCK_REASON.backingUp[kind];
  }
  if (kind === "rename") return lock === "running" ? LOCK_REASON.renameRunning : LOCK_REASON.renameInstalling;
  if (kind === "mods") return lock === "running" ? LOCK_REASON.runningMods : LOCK_REASON.installing;
  if (kind === "repair" && lock === "installing") return LOCK_REASON.repairInProgress;
  return LOCK_REASON.running;
}

/**
 * 导出读的是此刻的文件，与「改动中」同属一类：游戏运行、装 Mod 都不挡；安装、补全、改名、删除会挪走或重写目录，挡住。
 * 占位项的目录还没落盘，损坏的实例写不出可用的整合包。
 */
export function exportReason(inst: InstanceSummary, work: WorkLock | null): string | undefined {
  if (inst.placeholder) return LOCK_REASON.export.placeholder;
  if (work !== null) return LOCK_REASON.export[work];
  if (inst.status === "broken") return LOCK_REASON.export.broken;
  return undefined;
}

export function useInstanceOps(inst: InstanceSummary): InstanceOps {
  const actions = useLauncherActions();
  const run = useRunner();
  const deleteInstance = useDeleteInstance();
  const id = inst.id;
  const busy = useLauncherSelector((s) => busyInstanceId(s) === id);
  // 改名校验要全部实例名；只订阅名字，别的实例的进度与状态变化不让页面重渲染
  const ids = useLauncherSelector((s) => s.instances.map((i) => i.id), shallowArrayEqual);
  const installing = inst.status === "installing";
  const locks = instanceLocks(busy, installing, inst.activity === "modifying", inst.activity === "backing_up");
  const work = workLock(installing, inst.activity);
  const name = inst.name;

  const nameError = (next: string) => (next.trim() === name ? null : instanceNameError(next.trim(), ids, id));

  const rename = async (next: string): Promise<boolean> => {
    const trimmed = next.trim();
    if (trimmed === name) return true;
    const outcome = await run(() => actions.renameInstance(id, trimmed), ACTION_ERROR.renameInstance);
    if (outcome.ok) actions.toast("success", HERO_COPY.renamed(outcome.value));
    return outcome.ok;
  };

  const togglePin = () => {
    void run(() => actions.togglePin(id), ACTION_ERROR.pin);
  };

  const openFolder = (target: FolderTarget, world?: string) => {
    void run(() => actions.openFolder(target, id, world === undefined ? null : world), ACTION_ERROR.openFolder);
  };

  const folderReason = (target: FolderTarget) => {
    // 占位项的目录要等任务排到、导入要等读完整合包定下名字才建，前端分不清建了没有，一律先挡住
    if (inst.placeholder) return LOCK_REASON.placeholderFolder;
    return work === null || !WORK_FOLDERS.has(target) ? undefined : LOCK_REASON.work.folder[work];
  };
  const settingsReason = work === null ? undefined : LOCK_REASON.work.settings[work];

  const repair = () => {
    void run(() => actions.repairInstance(id), ACTION_ERROR.repair).then((outcome) => {
      if (outcome.ok) actions.toast("info", OVERVIEW_COPY.repairStarted(name), OVERVIEW_COPY.repairStartedBody);
    });
  };

  const remove = () => {
    void deleteInstance(inst);
  };

  return {
    locks,
    work,
    busy,
    installing,
    nameError,
    rename,
    togglePin,
    openFolder,
    folderReason,
    settingsReason,
    exportReason: exportReason(inst, work),
    repair,
    remove,
  };
}
