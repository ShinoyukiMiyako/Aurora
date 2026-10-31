// 头图菜单、设置页「实例管理」与崩溃页共用的一组实例操作：重命名、固定、打开文件夹、补全、删除与复制。
// 几处入口的确认文案、锁定判断与反馈都从这里出，保证完全一致。动作一律经外层统一错误处理执行。

import { useCallback } from "react";
import { ACTION_ERROR, CONFIRM_COPY, TOAST_COPY } from "../../copy/flows";
import type { InstanceSummary } from "../../domain/adapt";
import { formatBytes } from "../../domain/format";
import { instanceNameError } from "../../domain/rules";
import { useShell } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import { useLauncher } from "../../state/launcher";
import { busyInstanceId, instanceTask } from "../../state/selectors";
import type { LauncherActions } from "../../state/store";
import { DELETE_COPY, HERO_COPY, LOCK_REASON, OVERVIEW_COPY } from "./copy";
import styles from "./instance.module.css";
import { instanceLocks, worldName, type InstanceLock, type InstanceLocks } from "./model";

/** 打开文件夹的目标，与状态层动作的入参同一类型。 */
export type FolderTarget = Parameters<LauncherActions["openFolder"]>[0];

export interface InstanceOps {
  locks: InstanceLocks;
  busy: boolean;
  installing: boolean;
  /** 校验新名字；与当前名字相同（只改大小写也算不同）时为 null。 */
  nameError(name: string): string | null;
  /** 成功返回 true；失败已由统一错误处理报告。 */
  rename(name: string): Promise<boolean>;
  togglePin(): void;
  openFolder(target: FolderTarget, world?: string): void;
  repair(): void;
  remove(): void;
}

/** 锁定原因的悬停文字；没有锁为 undefined，可以直接交给 disabledReason。 */
export function lockReason(lock: InstanceLock | null, kind: "mods" | "rename" | "repair" | "delete"): string | undefined {
  if (lock === null) return undefined;
  if (lock === "modifying") {
    if (kind === "mods") throw new Error("改动 Mod 与改动 Mod 互相兼容，不会因此锁住 Mod 操作");
    return LOCK_REASON.modifying[kind];
  }
  if (kind === "rename") return lock === "running" ? LOCK_REASON.renameRunning : LOCK_REASON.renameInstalling;
  if (kind === "mods") return lock === "running" ? LOCK_REASON.runningMods : LOCK_REASON.installing;
  if (kind === "repair" && lock === "installing") return LOCK_REASON.repairInProgress;
  return LOCK_REASON.running;
}

export function useInstanceOps(inst: InstanceSummary): InstanceOps {
  const { state, actions } = useLauncher();
  const { confirm } = useShell();
  const run = useRunner();
  const busy = busyInstanceId(state) === inst.id;
  const installing = inst.status === "installing";
  const locks = instanceLocks(busy, installing, inst.activity === "modifying");
  const ids = state.instances.map((i) => i.id);
  const id = inst.id;
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

  const repair = () => {
    void run(() => actions.repairInstance(id), ACTION_ERROR.repair).then((outcome) => {
      if (outcome.ok) actions.toast("info", OVERVIEW_COPY.repairStarted(name), OVERVIEW_COPY.repairStartedBody);
    });
  };

  const remove = () => {
    void (async () => {
      // 存档数与体积以后端的删除预览为准：共用目录里的存档不随实例删除，不能拿概览里的存档列表来数
      const preview = await run(() => actions.previewInstanceDeletion(id), ACTION_ERROR.deleteInstance(name));
      if (!preview.ok) return;
      const worlds = preview.value.worlds;
      const copy = CONFIRM_COPY.deleteInstance(name, worlds.length);
      const pending = instanceTask(state, id);
      const ok = await confirm({
        title: copy.title,
        tone: "danger",
        confirmLabel: copy.confirmLabel,
        body: (
          <div className={styles.confirmBody}>
            <p>{copy.body}</p>
            {worlds.length > 0 && (
              <>
                <p>
                  {DELETE_COPY.worldsListIntro}
                  <span className={styles.num}>{formatBytes(worlds.reduce((sum, w) => sum + w.size_bytes, 0))}</span>
                </p>
                <ul className={styles.confirmList}>
                  {worlds.map((w) => (
                    <li key={w.dir_name}>{worldName(w)}</li>
                  ))}
                </ul>
                <p>{DELETE_COPY.backupHint}</p>
              </>
            )}
            {pending !== null && <p>{DELETE_COPY.installingNote}</p>}
          </div>
        ),
      });
      if (!ok) return;
      await run(() => actions.deleteInstance(id, worlds.length), ACTION_ERROR.deleteInstance(name));
    })();
  };

  return { locks, busy, installing, nameError, rename, togglePin, openFolder, repair, remove };
}

/**
 * 复制到剪贴板，给 CopyButton 用：成功时 resolve，按钮原位换成「已复制」。失败时统一错误处理已弹出「复制失败」，
 * 按钮保持原样，所以失败不再向按钮传播（按钮不接 rejection，传过去只会变成无人处理的 rejection）。
 */
export function useCopy(): (text: string) => Promise<void> {
  const run = useRunner();
  return useCallback(
    (text: string) =>
      new Promise<void>((resolve) => {
        void run(() => navigator.clipboard.writeText(text), TOAST_COPY.copyFailed).then((outcome) => {
          if (outcome.ok) resolve();
        });
      }),
    [run],
  );
}
