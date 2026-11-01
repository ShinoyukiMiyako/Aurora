// 存档备份：概览存档行菜单与备份列表弹窗共用的锁定判断与动作，以及备份列表弹窗本身。
// 列表走按需查询缓存（key 见 worldBackupsKey），任务完成、删除一份、自动备份做完后由状态层按前缀失效；
// 锁定只订阅「哪些存档有任务」与「是不是在补全」这类只随任务增减变化的值，不随下载进度重渲染。

import { useState } from "react";
import { ACTION_ERROR, CONFIRM_COPY } from "../../copy/flows";
import type { InstanceSummary } from "../../domain/adapt";
import { clock, formatBytes, formatDate, formatRelative } from "../../domain/format";
import { useNav, useShell } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import { shallowArrayEqual, useLauncherActions, useLauncherSelector, useNow } from "../../state/launcher";
import type { WorldDto } from "../../state/queries/instance";
import { useResource, type ResourceResult } from "../../state/resource";
import { activeTasks, busyWorlds, savesExported } from "../../state/selectors";
import { worldBackupsKey, type WorldBackupDto, type WorldBackupListDto } from "../../state/store";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { EmptyState } from "../../ui/EmptyState";
import { List, ListRow } from "../../ui/ListRow";
import type { MenuEntry } from "../../ui/Menu";
import { Modal } from "../../ui/Modal";
import { Skeleton } from "../../ui/Skeleton";
import { Tag } from "../../ui/Tag";
import { WORLD_BACKUP_COPY, WORLD_BLOCKER_LABEL } from "./copy";
import styles from "./instance.module.css";
import { worldName } from "./model";
import type { InstanceOps } from "./ops";
import { ModuleError, SlowHint, useModuleView } from "./parts";

const COPY = WORLD_BACKUP_COPY;

/** 存档的两种称呼：dir 是文件夹名（命令参数），name 是界面上显示的存档名。 */
export interface WorldRef {
  dir: string;
  name: string;
}

export function worldRef(world: WorldDto): WorldRef {
  return { dir: world.dir_name, name: worldName(world) };
}

/** 备份时刻：绝对日期到分钟，「2026年10月31日 14:02」。 */
export function backupMoment(ts: number): string {
  return `${formatDate(ts)} ${clock(ts).slice(0, 5)}`;
}

export interface WorldLockInput {
  name: string;
  status: InstanceSummary["status"];
  activity: InstanceSummary["activity"];
  /** 本实例的游戏会话在准备、下载、启动或运行中。 */
  sessionActive: boolean;
  /** 本实例有排队或进行中的补全任务（后端还没报 repairing 时由前端任务表得知）。 */
  repairTask: boolean;
  /** 本实例有排队或进行中的备份、导出或恢复任务。 */
  worldTask: boolean;
  /** 本实例有勾了存档的导出整合包任务在排队或进行中：只挡恢复，备份与导出存档只读、照常。 */
  savesExport: boolean;
}

/**
 * 备份、导出与恢复此刻做不了的原因，都能做时为 undefined。后端在启动、运行与新建、补全、改名、删除、另一份备份期间
 * 都以 instance_busy 拒绝，这里提前禁用并写明原因；前端自己排着的存档任务也算「备份中」，否则第二个任务排上时
 * 正好撞上第一个占着的实例。
 */
export function worldLockReasons(input: WorldLockInput): { backup: string | undefined; restore: string | undefined } {
  if (input.sessionActive || input.activity === "launching" || input.activity === "running") return { backup: COPY.runningBackup, restore: COPY.runningRestore };
  const blocker =
    input.status === "installing"
      ? input.activity === "repairing" || input.repairTask
        ? WORLD_BLOCKER_LABEL.repairing
        : WORLD_BLOCKER_LABEL.installing
      : input.activity === "renaming"
        ? WORLD_BLOCKER_LABEL.renaming
        : input.activity === "deleting"
          ? WORLD_BLOCKER_LABEL.deleting
          : input.activity === "backing_up" || input.worldTask
            ? WORLD_BLOCKER_LABEL.backing_up
            : null;
  if (blocker === null) {
    return { backup: undefined, restore: input.savesExport ? COPY.blocked(input.name, WORLD_BLOCKER_LABEL.exporting) : undefined };
  }
  const reason = COPY.blocked(input.name, blocker);
  return { backup: reason, restore: reason };
}

export interface WorldOps {
  /** 「备份存档」「导出存档」此刻做不了的原因；能做为 undefined。 */
  backupReason: string | undefined;
  /** 「恢复」此刻做不了的原因（不看是哪个存档）；能做为 undefined。 */
  restoreReason: string | undefined;
  /** 有备份、导出或恢复任务在排队或进行中的存档文件夹名。 */
  busyWorlds: readonly string[];
  backup(world: WorldRef): void;
  /** 先弹系统保存对话框，选定位置后入队；取消对话框什么都不做。 */
  exportTo(world: WorldRef): void;
  /** 存档行菜单：备份存档、查看备份、导出存档。 */
  menu(world: WorldRef, onViewBackups: () => void): MenuEntry[];
}

export function useWorldOps(inst: InstanceSummary, ops: InstanceOps): WorldOps {
  const actions = useLauncherActions();
  const run = useRunner();
  const { saveFile } = useShell();
  const id = inst.id;
  const worlds = useLauncherSelector((s) => busyWorlds(s, id), shallowArrayEqual);
  const repairTask = useLauncherSelector((s) => activeTasks(s).some((t) => t.instanceId === id && t.spec.command === "repair_instance"));
  const savesExport = useLauncherSelector((s) => savesExported(s, id));
  const reasons = worldLockReasons({
    name: inst.name,
    status: inst.status,
    activity: inst.activity,
    sessionActive: ops.busy,
    repairTask,
    worldTask: worlds.length > 0,
    savesExport,
  });

  const backup = (world: WorldRef) => {
    void run(() => actions.backupWorld(id, world.dir, world.name), ACTION_ERROR.backupWorld);
  };

  const exportTo = (world: WorldRef) => {
    void run(async () => {
      // 文件夹名一定是合法的文件名，显示用的存档名可能带 : / 这类字符
      const dest = await saveFile({ title: COPY.exportDialogTitle(world.name), filter: { name: COPY.exportFilter, extensions: ["zip"] } }, `${world.dir}.zip`);
      if (dest === null) return;
      await actions.exportWorld(id, world.dir, world.name, dest);
    }, ACTION_ERROR.exportWorld);
  };

  const menu = (world: WorldRef, onViewBackups: () => void): MenuEntry[] => {
    const locked = reasons.backup !== undefined;
    return [
      { label: COPY.backup, icon: "archive", disabled: locked, disabledReason: reasons.backup, onSelect: () => backup(world) },
      { label: COPY.viewBackups, icon: "history", onSelect: onViewBackups },
      { label: COPY.export, icon: "upload", disabled: locked, disabledReason: reasons.backup, onSelect: () => exportTo(world) },
    ];
  };

  return { backupReason: reasons.backup, restoreReason: reasons.restore, busyWorlds: worlds, backup, exportTo, menu };
}

// ---------------------------------------------------------------- 备份列表弹窗

export interface WorldBackupsModalProps {
  inst: InstanceSummary;
  /** 最近一次打开的存档；关上后保留，退场动画期间列表照常显示。 */
  world: WorldRef;
  open: boolean;
  onClose(): void;
  worldOps: WorldOps;
}

function useWorldBackups(instanceId: string, world: string): ResourceResult<WorldBackupListDto> {
  const actions = useLauncherActions();
  return useResource(worldBackupsKey(instanceId, world), () => actions.listWorldBackups(instanceId, world));
}

export function WorldBackupsModal({ inst, world, open, onClose, worldOps }: WorldBackupsModalProps) {
  const actions = useLauncherActions();
  const run = useRunner();
  const list = useWorldBackups(inst.id, world.dir);
  const busy = worldOps.busyWorlds.includes(world.dir);
  const ready = list.status === "ready" ? list.data : null;

  const subtitle =
    ready === null
      ? undefined
      : `${ready.backups.length > 0 ? COPY.modalSubtitle(ready.backups.length, ready.total_bytes) : COPY.modalSubtitleEmpty}${ready.scope === "shared" ? COPY.sharedSuffix : ""}`;

  const footer = (
    <>
      <Button
        variant="ghost"
        icon="folder"
        disabledReason={ready === null ? undefined : ready.backups.length === 0 ? COPY.noFolderYet : undefined}
        disabled={ready === null}
        focusableWhenDisabled
        onClick={() => {
          if (ready === null) return;
          void run(() => actions.revealPath(ready.dir), ACTION_ERROR.openFolder);
        }}
      >
        {COPY.openFolder}
      </Button>
      {/* 这个存档的任务在进行时转圈，不换成带原因的禁用：原因气泡要多包一层，刚按下的按钮会重挂、丢掉焦点 */}
      <Button variant="primary" icon="archive" loading={busy} disabledReason={busy ? undefined : worldOps.backupReason} onClick={() => worldOps.backup(world)}>
        {COPY.backup}
      </Button>
    </>
  );

  return (
    <Modal open={open} onClose={onClose} size="md" title={COPY.modalTitle(world.name)} subtitle={subtitle} footer={footer}>
      <BackupsBody inst={inst} world={world} list={list} busy={busy} worldOps={worldOps} onClose={onClose} />
    </Modal>
  );
}

function BackupsBody({
  inst,
  world,
  list,
  busy,
  worldOps,
  onClose,
}: {
  inst: InstanceSummary;
  world: WorldRef;
  list: ResourceResult<WorldBackupListDto>;
  busy: boolean;
  worldOps: WorldOps;
  onClose(): void;
}) {
  const view = useModuleView(list);
  const policy = useLauncherSelector((s) => (s.settings === null ? null : s.settings.worldBackup));
  const { go } = useNav();
  return (
    <div className={styles.stack}>
      {view.view === "skeleton" && (
        <div className={styles.rows} aria-busy="true">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className={styles.row}>
              <div className={styles.rowMain}>
                <Skeleton shape="text" lines={2} />
              </div>
            </div>
          ))}
          <SlowHint slow={view.slow} />
        </div>
      )}
      {view.view === "error" && list.status === "error" && <ModuleError title={COPY.loadError} error={list.error} onRetry={list.reload} />}
      {view.view === "ready" && list.status === "ready" && list.data.backups.length === 0 && (
        <EmptyState compact scene="clock" title={COPY.emptyTitle} body={COPY.emptyBody} />
      )}
      {view.view === "ready" && list.status === "ready" && list.data.backups.length > 0 && (
        <BackupRows inst={inst} world={world} backups={list.data.backups} busy={busy} restoreReason={worldOps.restoreReason} />
      )}
      {policy !== null &&
        (policy.auto ? (
          <Callout tone="info">{COPY.autoOnNote(policy.keepPerWorld)}</Callout>
        ) : (
          <Callout
            tone="info"
            action={
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  onClose();
                  go({ page: "settings", section: "game" });
                }}
              >
                {COPY.goSettings}
              </Button>
            }
          >
            {COPY.autoOffNote}
          </Callout>
        ))}
    </div>
  );
}

function BackupRows({
  inst,
  world,
  backups,
  busy,
  restoreReason,
}: {
  inst: InstanceSummary;
  world: WorldRef;
  backups: readonly WorldBackupDto[];
  busy: boolean;
  restoreReason: string | undefined;
}) {
  const now = useNow(30_000);
  const actions = useLauncherActions();
  const run = useRunner();
  const { confirm } = useShell();
  // 删除不确认、也不走任务：请求回来之前再按一次，第二个请求撞上已经移走的文件，报 world_backup_not_found
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set());
  const rowRestoreReason = busy ? COPY.worldBusy : restoreReason;
  const rowDeleteReason = busy ? COPY.worldBusy : undefined;

  const restore = async (backup: WorldBackupDto) => {
    const ok = await confirm({ ...CONFIRM_COPY.restoreWorld(world.name, backupMoment(backup.created_at)), cancelLabel: CONFIRM_COPY.cancel, tone: "danger" });
    if (!ok) return;
    await run(() => actions.restoreWorldBackup(inst.id, world.dir, world.name, backup.file), ACTION_ERROR.restoreWorld);
  };

  const remove = (backup: WorldBackupDto) => {
    setRemoving((s) => new Set(s).add(backup.file));
    void run(() => actions.deleteWorldBackup(inst.id, world.dir, backup.file), ACTION_ERROR.deleteWorldBackup).then(() =>
      setRemoving((s) => {
        const next = new Set(s);
        next.delete(backup.file);
        return next;
      }),
    );
  };

  // 后端给出的就是新的在前；界面的顺序不依赖传输顺序，这里按备份时刻再排一次
  const sorted = [...backups].sort((a, b) => b.created_at - a.created_at);
  return (
    <List variant="flush">
      {sorted.map((b) => {
        const moment = backupMoment(b.created_at);
        // 存档名后来改过（level.dat 的 LevelName）时注明备份当时叫什么，免得认不出是哪一份
        const formerName = b.level_name !== null && b.level_name !== world.name ? COPY.formerName(b.level_name) : undefined;
        return (
          <ListRow
            key={b.file}
            title={
              <span className={styles.rowTitle}>
                <Tag tone={b.kind === "manual" ? "accent" : "neutral"} size="sm">
                  {COPY.kindLabel[b.kind]}
                </Tag>
                <span className={styles.ellipsis}>{COPY.moment(moment, formatRelative(b.created_at, now))}</span>
              </span>
            }
            meta={formerName}
            trailing={
              <span className={styles.rowActions}>
                <span className={styles.rowMeta}>{formatBytes(b.size_bytes)}</span>
                <Button size="sm" aria-label={COPY.restoreLabel(moment)} disabledReason={rowRestoreReason} onClick={() => void restore(b)}>
                  {COPY.restore}
                </Button>
                <Button size="sm" variant="ghost" aria-label={COPY.removeLabel(moment)} disabledReason={rowDeleteReason} loading={removing.has(b.file)} onClick={() => remove(b)}>
                  {COPY.remove}
                </Button>
              </span>
            }
          />
        );
      })}
    </List>
  );
}
