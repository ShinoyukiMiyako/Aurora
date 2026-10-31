// Mod 管理：吸顶工具条（搜索、状态筛选、打开文件夹、全部更新、添加）+ 总数说明 + 表格。
// 游戏运行中（含加载中）与安装中禁用全部 Mod 文件操作：JVM 占着文件，Windows 下改名、替换、删除都会失败。

import { useEffect, useRef, useState } from "react";
import { hueOf } from "../../art/illustrations/seed";
import { ACTION_ERROR, TOAST_COPY } from "../../copy/flows";
import type { InstanceSummary } from "../../domain/adapt";
import { useNav, useShell } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import { errorRecord } from "../../state/errors";
import { shallowArrayEqual, useLauncherActions, useLauncherSelector } from "../../state/launcher";
import { useInstanceMods, type InstalledMod, type UpdateCandidate } from "../../state/queries/instance";
import { invalidate, type ResourceResult } from "../../state/resource";
import { progressTrack } from "../../state/tasks";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { EmptyState } from "../../ui/EmptyState";
import { IconButton } from "../../ui/IconButton";
import { Inset } from "../../ui/Inset";
import { ProgressBar } from "../../ui/ProgressBar";
import { SearchInput } from "../../ui/SearchInput";
import { SegmentedControl } from "../../ui/SegmentedControl";
import { Skeleton } from "../../ui/Skeleton";
import { Table, type TableColumn, type TableSort } from "../../ui/Table";
import { Tag } from "../../ui/Tag";
import { Thumb } from "../../ui/Thumb";
import { Toggle } from "../../ui/Toggle";
import { Tooltip } from "../../ui/Tooltip";
import { MODS_COPY, SOURCE_LABEL } from "./copy";
import styles from "./instance.module.css";
import { disabledFileName, enabledFileName, filterMods, isPendingModUpdate, modCounts, modRows, modTotals, removalRelations, updateTaskFiles, type ModFilter, type ModRow } from "./model";
import { lockReason, type InstanceOps } from "./ops";
import { FolderButton, ModuleError, SlowHint, useModuleView } from "./parts";

export interface ModsTabProps {
  inst: InstanceSummary;
  queryId: string | null;
  ops: InstanceOps;
  updates: ResourceResult<UpdateCandidate[]>;
}

const SKELETON_ROWS = 6;
const NETWORK_FAILED = "network_failed";

export function ModsTab({ inst, queryId, ops, updates }: ModsTabProps) {
  if (inst.loader === "vanilla") return <VanillaMods inst={inst} />;
  return <ModdedMods inst={inst} queryId={queryId} ops={ops} updates={updates} />;
}

function VanillaMods({ inst }: { inst: InstanceSummary }) {
  const { openCreateInstance } = useShell();
  return (
    <Card padding="lg">
      <EmptyState
        scene="book"
        titleAs="h2"
        title={MODS_COPY.vanillaTitle}
        body={MODS_COPY.vanillaBody(inst.name)}
        action={
          <Button icon="plus" onClick={() => openCreateInstance()}>
            {MODS_COPY.vanillaAction}
          </Button>
        }
      />
    </Card>
  );
}

function ModdedMods({ inst, queryId, ops, updates }: ModsTabProps) {
  const actions = useLauncherActions();
  const { tier, confirm, registerFind } = useShell();
  const { go } = useNav();
  const run = useRunner();
  const mods = useInstanceMods(queryId);
  const load = useModuleView(mods);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ModFilter>("all");
  const [sort, setSort] = useState<TableSort>({ key: "mod", direction: "asc" });
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [toggling, setToggling] = useState<ReadonlySet<string>>(new Set());
  // 启停成功后、重扫回来之前，行还是按旧文件名画的，盘上的文件已经改了名：记下新名字，只对记下时的那份列表有效。
  // 否则这期间再点开关或移除，会拿旧名字去调后端：启停对着不存在的旧名是空转（后端照成功返回），移除直接报找不到文件
  const [renamed, setRenamed] = useState<{ base: readonly InstalledMod[] | null; names: ReadonlyMap<string, string> }>({ base: null, names: new Map() });
  const [checking, setChecking] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const id = inst.id;
  const lock = lockReason(ops.locks.mods, "mods");

  useEffect(() => registerFind(() => searchRef.current?.focus()), [registerFind]);

  // 玩家手动往 mods 文件夹里放了 jar：窗口重新获得焦点时重扫
  useEffect(() => {
    if (queryId === null) return;
    const rescan = () => invalidate(`mods:${queryId}`);
    window.addEventListener("focus", rescan);
    return () => window.removeEventListener("focus", rescan);
  }, [queryId]);

  // 列表换了一份（启停后的重扫）就以磁盘为准，丢掉乐观的开关值
  const modsData = mods.status === "ready" ? mods.data : null;
  useEffect(() => setOverrides(new Map()), [modsData]);

  // 「检查更新」是玩家主动发起的：查完没有更新要告诉一声，离线要说清楚
  useEffect(() => {
    if (!checking) return;
    if (updates.status === "ready" && !updates.refreshing) {
      setChecking(false);
      if (updates.data.length === 0) actions.toast("info", TOAST_COPY.allModsLatest);
    } else if (updates.status === "error") {
      setChecking(false);
      if (errorRecord(updates.error).code === NETWORK_FAILED) actions.toast("warning", MODS_COPY.offlineCheck);
      else void run(() => Promise.reject(updates.error), ACTION_ERROR.updateMods);
    }
  }, [actions, checking, run, updates]);

  // 只订阅本实例排队与进行中的更新任务（含「全部更新」）：它们的进度条要跟着走，别的任务的进度不让整张表重渲染
  const updateTasks = useLauncherSelector(
    (s) => s.tasks.filter((t) => isPendingModUpdate(t, id)),
    shallowArrayEqual,
  );
  const updatingFiles = new Set(updateTasks.flatMap((t) => updateTaskFiles(t.spec)));
  const rows = modsData === null ? [] : modRows(modsData, updates.status === "ready" ? updates.data : null).map((r) => {
    const override = overrides.get(r.fileName);
    return override === undefined ? r : { ...r, enabled: override };
  });
  const counts = modCounts(rows);
  const shown = sortRows(filterMods(rows, query, filter), sort);
  const { total, partial } = modTotals(inst, rows.length);
  const shownTotal = mods.status === "ready" ? total : inst.modCount;
  const isUpdating = (r: ModRow) => pending.has(r.fileName) || updatingFiles.has(enabledFileName(r.fileName));
  const isToggling = (r: ModRow) => toggling.has(r.fileName);
  const diskName = (r: ModRow): string => {
    if (renamed.base !== modsData) return r.fileName;
    const name = renamed.names.get(r.fileName);
    return name === undefined ? r.fileName : name;
  };

  const toggle = (r: ModRow) => {
    // 上一次启停还没回来时不知道盘上是哪个名字，开关已带原因禁用，这里是第二道防线
    if (toggling.has(r.fileName)) return;
    const next = !r.enabled;
    const fileName = diskName(r);
    const base = modsData;
    setOverrides((m) => new Map(m).set(r.fileName, next));
    setToggling((s) => new Set(s).add(r.fileName));
    void run(() => actions.toggleMod(id, fileName, next), ACTION_ERROR.toggleMod).then((outcome) => {
      setToggling((s) => {
        const rest = new Set(s);
        rest.delete(r.fileName);
        return rest;
      });
      if (!outcome.ok) {
        setOverrides((m) => {
          const copy = new Map(m);
          copy.delete(r.fileName);
          return copy;
        });
        return;
      }
      const landed = next ? enabledFileName(fileName) : disabledFileName(fileName);
      setRenamed((prev) => ({ base, names: new Map(prev.base === base ? prev.names : []).set(r.fileName, landed) }));
      if (next) actions.toast("info", MODS_COPY.enabledToast(r.name));
      else actions.toast("info", MODS_COPY.disabledToast(r.name), MODS_COPY.disabledToastBody(landed));
    });
  };

  const update = (r: ModRow) => {
    setPending((p) => new Set(p).add(r.fileName));
    void run(() => actions.updateMod(id, enabledFileName(r.fileName)), ACTION_ERROR.updateMods).then(() =>
      setPending((p) => {
        const next = new Set(p);
        next.delete(r.fileName);
        return next;
      }),
    );
  };

  const updateAll = () => {
    const files = rows.filter((r) => r.update !== null).map((r) => r.fileName);
    setPending(new Set(files));
    void run(() => actions.updateAllMods(id), ACTION_ERROR.updateMods).then(() => setPending(new Set()));
  };

  const checkUpdates = () => {
    setChecking(true);
    updates.reload();
  };

  const remove = (r: ModRow) => {
    void (async () => {
      const relations = removalRelations(r, rows);
      const fileName = diskName(r);
      const ok = await confirm({
        title: MODS_COPY.removeTitle(r.name),
        tone: "danger",
        confirmLabel: MODS_COPY.removeConfirm,
        body: (
          <div className={styles.confirmBody}>
            <p>{MODS_COPY.removeBody(fileName, r.size)}</p>
            {relations.broughtIn.length > 0 && <p>{MODS_COPY.removeBroughtIn(relations.broughtIn)}</p>}
            {relations.dependents.length > 0 && <p>{MODS_COPY.removeDependents(relations.dependents)}</p>}
          </div>
        ),
      });
      if (ok) await run(() => actions.removeMod(id, fileName, r.name), ACTION_ERROR.removeMod);
    })();
  };

  const clearFilters = () => {
    setQuery("");
    setFilter("all");
  };

  const checkLoading = checking || updates.status === "loading" || updates.refreshing;
  const compact = tier === "compact";
  const columns = modColumns({ compact, lock, isUpdating, isToggling, toggle, update, remove });

  return (
    <div className={styles.stack}>
      <div className={styles.toolbar}>
        <SearchInput ref={searchRef} value={query} onChange={setQuery} placeholder={MODS_COPY.search} shortcut={["Ctrl", "F"]} size="md" className={styles.toolSearch} />
        <SegmentedControl
          size="sm"
          value={filter}
          onChange={setFilter}
          ariaLabel={MODS_COPY.filterLabel}
          options={[
            { value: "all", label: MODS_COPY.all, count: counts.all },
            { value: "enabled", label: MODS_COPY.enabled, count: counts.enabled },
            { value: "disabled", label: MODS_COPY.disabled, count: counts.disabled },
            { value: "outdated", label: MODS_COPY.outdated, count: counts.outdated },
          ]}
        />
        <div className={styles.toolRight}>
          <FolderButton ops={ops} target="mods" label={MODS_COPY.openFolder} variant="secondary" />
          {counts.outdated > 0 ? (
            <Button icon="download" disabledReason={lock} loading={pending.size > 0 || updateTasks.length > 0} onClick={updateAll}>
              {MODS_COPY.updateAll(counts.outdated)}
            </Button>
          ) : (
            <Button icon="download" loading={checkLoading} disabled={queryId === null} onClick={checkUpdates}>
              {MODS_COPY.checkUpdates}
            </Button>
          )}
          <Button icon="plus" onClick={() => go({ page: "discover", kind: "mod", forInstance: id })}>
            {MODS_COPY.addMod}
          </Button>
        </div>
      </div>

      <Inset className={styles.modSummary}>
        <span className={styles.modTotal}>
          {shownTotal !== null ? <b className={styles.bigNum}>{shownTotal}</b> : <Skeleton shape="block" width={40} height={28} radius="sm" />}
          {MODS_COPY.totalUnit}
        </span>
        {mods.status === "ready" && (
          <span className={styles.modSummaryText}>
            {partial && inst.modpack !== null ? MODS_COPY.partialNote(inst.modpack.name, total, rows.length) : MODS_COPY.completeNote(counts.enabled, counts.disabled)}
          </span>
        )}
        {updateTasks.length > 0 && (
          <span className={styles.modTask}>
            <ProgressBar value={updateTasks[0].status === "running" ? updateTasks[0].progress : 0} size="sm" track={progressTrack(updateTasks[0])} label={updateTasks[0].title} />
            <span className={styles.ellipsis}>{updateTasks[0].title}</span>
          </span>
        )}
      </Inset>

      {ops.locks.mods !== null && <Banner tone="info" title={ops.locks.mods === "running" ? MODS_COPY.bannerRunning : MODS_COPY.bannerInstalling} />}

      {load.view === "skeleton" && (
        <Card padding="none">
          <div className={styles.tableSkeleton}>
            {Array.from({ length: SKELETON_ROWS }, (_, i) => (
              <div key={i} className={styles.row}>
                <Skeleton shape="square" size={40} />
                <div className={styles.rowMain}>
                  <Skeleton shape="text" lines={2} />
                </div>
              </div>
            ))}
            <SlowHint slow={load.slow} />
          </div>
        </Card>
      )}
      {load.view === "error" && mods.status === "error" && (
        <Card padding="lg">
          <ModuleError
            title={MODS_COPY.errorTitle}
            error={mods.error}
            onRetry={mods.reload}
            extra={
              <Button variant="ghost" size="sm" disabledReason={ops.folderReason("mods")} onClick={() => ops.openFolder("mods")}>
                {MODS_COPY.openFolder}
              </Button>
            }
          />
        </Card>
      )}
      {load.view === "ready" && rows.length === 0 && (
        <Card padding="lg">
          <EmptyState
            scene="enchanted-book"
            titleAs="h2"
            title={MODS_COPY.emptyTitle}
            body={MODS_COPY.emptyBody}
            action={
              <Button icon="compass" onClick={() => go({ page: "discover", kind: "mod", forInstance: id })}>
                {MODS_COPY.emptyAction}
              </Button>
            }
          />
        </Card>
      )}
      {load.view === "ready" && rows.length > 0 && (
        <Card padding="none" className={styles.modCard}>
          <Table
            label={MODS_COPY.tableLabel}
            columns={columns}
            rows={shown}
            rowKey={(r) => r.fileName}
            density={compact ? "compact" : "regular"}
            sort={sort}
            onSortChange={setSort}
            isInactive={(r) => !r.enabled}
            className={styles.modTable}
            empty={
              <EmptyState
                compact
                icon="search"
                title={MODS_COPY.noMatchTitle}
                body={query.trim() !== "" ? MODS_COPY.noMatchQuery(query.trim(), partial) : MODS_COPY.noMatchFilter}
                action={
                  <Button variant="ghost" size="sm" onClick={clearFilters}>
                    {MODS_COPY.clearFilters}
                  </Button>
                }
              />
            }
          />
        </Card>
      )}
    </div>
  );
}

function sortRows(rows: ModRow[], sort: TableSort): ModRow[] {
  const dir = sort.direction === "asc" ? 1 : -1;
  const key = (r: ModRow): string => {
    if (sort.key === "source") return r.platform === null ? "~" : r.platform;
    if (sort.key === "enabled") return r.enabled ? "0" : "1";
    return r.name;
  };
  return [...rows].sort((a, b) => dir * key(a).localeCompare(key(b), "zh-CN") || a.name.localeCompare(b.name, "zh-CN"));
}

interface ColumnDeps {
  compact: boolean;
  lock: string | undefined;
  isUpdating(r: ModRow): boolean;
  isToggling(r: ModRow): boolean;
  toggle(r: ModRow): void;
  update(r: ModRow): void;
  remove(r: ModRow): void;
}

function SourceTag({ row }: { row: ModRow }) {
  if (row.platform === null)
    return (
      <Tag size="sm" icon="folder">
        {MODS_COPY.local}
      </Tag>
    );
  return (
    <Tag size="sm" tone={row.platform === "modrinth" ? "ok" : "warn"} icon="globe">
      {SOURCE_LABEL[row.platform]}
    </Tag>
  );
}

function modColumns({ compact, lock, isUpdating, isToggling, toggle, update, remove }: ColumnDeps): TableColumn<ModRow>[] {
  const toggleReason = (r: ModRow): string | undefined => (lock !== undefined ? lock : isToggling(r) ? MODS_COPY.togglePending : undefined);
  return [
    {
      key: "mod",
      header: MODS_COPY.colMod,
      minWidth: 260,
      sortable: true,
      cell: (r) => (
        <div className={styles.modCell}>
          <Thumb url={r.iconUrl} kind="mod" hue={hueOf(r.seed)} size={40} inactive={!r.enabled} />
          <div className={styles.modText}>
            <span className={styles.modTitle}>
              <span className={styles.modName}>{r.name}</span>
              {compact && r.version !== null && <span className={styles.modVersion}>{r.version}</span>}
            </span>
            <span className={styles.modSub}>
              {r.summary !== null && <span className={styles.ellipsis}>{r.summary}</span>}
              {compact && <SourceTag row={r} />}
              {compact && r.update !== null && (
                <Tag size="sm" tone="accent" icon="sparkle">
                  {MODS_COPY.updateTo(r.update.latest.version_number)}
                </Tag>
              )}
              {r.dependencyOf !== null && (
                <Tag size="sm" tone="info" icon="link">
                  {MODS_COPY.dependencyOf(r.dependencyOf)}
                </Tag>
              )}
              {!compact && r.summary === null && <span className={styles.modFile}>{r.fileName}</span>}
            </span>
          </div>
        </div>
      ),
    },
    {
      key: "version",
      header: MODS_COPY.colVersion,
      width: 150,
      tiers: ["regular", "wide"],
      cell: (r) => (
        <div className={styles.versionCell}>
          <span className={styles.modVersion}>{r.version === null ? MODS_COPY.versionUnknown : r.version}</span>
          {r.update !== null && (
            <Tag size="sm" tone="accent" icon="sparkle">
              {MODS_COPY.updateTo(r.update.latest.version_number)}
            </Tag>
          )}
        </div>
      ),
    },
    { key: "source", header: MODS_COPY.colSource, width: 120, tiers: ["regular", "wide"], sortable: true, cell: (r) => <SourceTag row={r} /> },
    { key: "author", header: MODS_COPY.colAuthor, width: 140, tiers: ["wide"], cell: (r) => (r.author === null ? "" : r.author) },
    {
      key: "enabled",
      header: MODS_COPY.colEnabled,
      width: 64,
      sortable: true,
      keepOpaque: true,
      // 锁住时开关自己用提示气泡写禁用原因；可用时悬停说明点了是停用还是启用
      cell: (r) => {
        const reason = toggleReason(r);
        return reason === undefined ? (
          <Tooltip content={MODS_COPY.toggleTip(r.enabled)}>
            <Toggle checked={r.enabled} onChange={() => toggle(r)} ariaLabel={MODS_COPY.toggleLabel(r.name, r.enabled)} />
          </Tooltip>
        ) : (
          <Toggle checked={r.enabled} onChange={() => toggle(r)} ariaLabel={MODS_COPY.toggleLabel(r.name, r.enabled)} disabledReason={reason} />
        );
      },
    },
    {
      key: "actions",
      header: MODS_COPY.colActions,
      width: 96,
      align: "end",
      keepOpaque: true,
      cell: (r) => (
        <div className={styles.rowActions}>
          {r.update !== null &&
            (compact ? (
              <IconButton icon="download" label={MODS_COPY.updateLabel(r.name)} size="sm" variant="secondary" disabled={isUpdating(r)} disabledReason={lock} onClick={() => update(r)} />
            ) : (
              <Button size="sm" disabledReason={lock} loading={isUpdating(r)} onClick={() => update(r)} aria-label={MODS_COPY.updateLabel(r.name)}>
                {MODS_COPY.update}
              </Button>
            ))}
          <IconButton icon="trash" label={MODS_COPY.remove(r.name)} size="sm" variant="danger" disabledReason={lock} onClick={() => remove(r)} />
        </div>
      ),
    },
  ];
}
