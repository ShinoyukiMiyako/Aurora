// 概览：状态横幅（至多一条）→ 四格数据 → 存档与实例信息 → Mod 速览与资源包光影。
// 每个模块各自加载、各自出错，不互相等待。

import { useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../../art/Icon";
import { KindTile, WorldModeTile, type WorldMode } from "../../art/illustrations/FeatureTile";
import { hueOf } from "../../art/illustrations/seed";
import { ACTION_ERROR, crashCategoryLabel, lockReason, MODPACK_REIMPORT_COPY, modpackLabel } from "../../copy/flows";
import type { InstanceSummary } from "../../domain/adapt";
import { formatBytes, formatDate, formatMemory, formatRelative, formatSpeed, percent } from "../../domain/format";
import { needsReimport } from "../../domain/rules";
import type { LaunchView } from "../../launch/launchView";
import { useLaunch } from "../../launch/useLaunch";
import { cx } from "../../lib/util";
import { useNav, useShell } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import { useLauncherActions, useLauncherSelector, useNow } from "../../state/launcher";
import {
  useInstanceContent,
  useInstanceMods,
  useInstanceSettings,
  type CrashReportDto,
  type InstalledMod,
  type InstanceContentDto,
  type UpdateCandidate,
} from "../../state/queries/instance";
import type { ResourceResult } from "../../state/resource";
import { reimportRoute, type InstanceTab } from "../../state/route";
import { instanceTask } from "../../state/selectors";
import { progressTrack } from "../../state/tasks";
import { Badge } from "../../ui/Badge";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Card } from "../../ui/Card";
import { CardHeader } from "../../ui/CardHeader";
import { EmptyState } from "../../ui/EmptyState";
import { IconButton } from "../../ui/IconButton";
import { KV } from "../../ui/KV";
import { LoaderTag } from "../../ui/LoaderTag";
import { MoreMenu } from "../../ui/MoreMenu";
import { ProgressBar } from "../../ui/ProgressBar";
import { Skeleton } from "../../ui/Skeleton";
import { StatGrid, StatTile } from "../../ui/StatTile";
import { Tag } from "../../ui/Tag";
import { Thumb } from "../../ui/Thumb";
import { Tooltip } from "../../ui/Tooltip";
import { HERO_COPY, OVERVIEW_COPY, WORLD_BACKUP_COPY } from "./copy";
import { useJavaInfo, useMemoryInfo } from "./hooks";
import styles from "./instance.module.css";
import {
  chosenRuntime,
  enterWorldBlock,
  isPendingModUpdate,
  modRows,
  modTotals,
  overviewBanner,
  peekLayout,
  peekPerRow,
  playtimeNote,
  sortWorlds,
  worldName,
  WORLDS_PREVIEW,
  type ModRow,
} from "./model";
import type { InstanceOps } from "./ops";
import { FolderButton, ModuleError, SlowHint, useModuleView } from "./parts";
import { useWorldOps, WorldBackupsModal, worldRef, type WorldRef } from "./WorldBackupsModal";
import { UpdatePreviewModal } from "./UpdatePreviewModal";

export interface OverviewTabProps {
  inst: InstanceSummary;
  queryId: string | null;
  ops: InstanceOps;
  view: LaunchView;
  crash: ResourceResult<CrashReportDto | null>;
  crashActive: boolean;
  updates: ResourceResult<UpdateCandidate[]>;
  onTab(tab: InstanceTab): void;
}

export function OverviewTab({ inst, queryId, ops, view, crash, crashActive, updates, onTab }: OverviewTabProps) {
  const modded = inst.loader !== "vanilla";
  const content = useInstanceContent(queryId);
  const mods = useInstanceMods(modded ? queryId : null);
  const banner = overviewBanner(view.kind, crashActive);
  const outdated = updates.status === "ready" ? updates.data.length : null;

  return (
    <div className={styles.stack}>
      {banner === "failed" && <FailedBanner inst={inst} />}
      {banner === "crashed" && crash.status === "ready" && crash.data !== null && <CrashBanner report={crash.data} onTab={onTab} />}
      {banner === "broken" && view.kind === "broken" && (needsReimport(inst) ? <ReimportBanner inst={inst} reason={view.reason} ops={ops} /> : <BrokenBanner reason={view.reason} ops={ops} />)}
      {banner === "installing" && view.kind === "installing" && <InstallingBanner instanceId={inst.id} />}
      <StatsCard inst={inst} content={content} mods={mods} outdated={outdated} />
      <div className={styles.overviewGrid}>
        <WorldsCard inst={inst} view={view} content={content} ops={ops} />
        <InfoCard inst={inst} queryId={queryId} onTab={onTab} />
        <ModsPeekCard inst={inst} queryId={queryId} mods={mods} updates={updates} ops={ops} onTab={onTab} />
        <PacksCard inst={inst} content={content} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 横幅

function FailedBanner({ inst }: { inst: InstanceSummary }) {
  const entry = useLaunch(inst.id);
  const failure = entry.failure;
  if (failure === null) throw new Error("启动失败横幅需要失败会话的文案");
  const secondary = failure.secondary;
  return (
    <Banner
      tone="danger"
      icon="alert"
      title={OVERVIEW_COPY.failedTitle(failure.title)}
      actions={
        <>
          <Button onClick={() => entry.fix(failure.fix.kind)}>{failure.fix.label}</Button>
          {secondary !== null && (
            <Button variant="ghost" onClick={() => entry.fix(secondary.kind)}>
              {secondary.label}
            </Button>
          )}
        </>
      }
    >
      {failure.body}
    </Banner>
  );
}

function CrashBanner({ report, onTab }: { report: CrashReportDto; onTab(tab: InstanceTab): void }) {
  const now = useNow(30_000);
  if (report.at === null) throw new Error("实例的崩溃报告缺少崩溃时刻");
  const first = report.diagnoses[0];
  return (
    <Banner
      tone="danger"
      icon="bug"
      title={OVERVIEW_COPY.crashTitle(formatRelative(report.at, now))}
      actions={<Button onClick={() => onTab("crash")}>{OVERVIEW_COPY.viewCrash}</Button>}
    >
      {first === undefined ? OVERVIEW_COPY.crashBodyNoClue : OVERVIEW_COPY.crashBody(crashCategoryLabel(first.category))}
    </Banner>
  );
}

function BrokenBanner({ reason, ops }: { reason: string; ops: InstanceOps }) {
  return (
    <Banner tone="warn" icon="alert" title={OVERVIEW_COPY.brokenTitle} actions={<Button icon="wrench" disabledReason={lockReason(ops.locks.repair, "repair")} onClick={ops.repair}>{OVERVIEW_COPY.repair}</Button>}>
      {reason}
    </Banner>
  );
}

/** 整合包没导入完：补全补不回来，横幅改给重新导入与删除。 */
function ReimportBanner({ inst, reason, ops }: { inst: InstanceSummary; reason: string; ops: InstanceOps }) {
  const { go } = useNav();
  return (
    <Banner
      tone="warn"
      icon="alert"
      title={OVERVIEW_COPY.brokenTitle}
      actions={
        <>
          <Button icon="modpack" onClick={() => go(reimportRoute(inst))}>
            {MODPACK_REIMPORT_COPY.reimport}
          </Button>
          <Button variant="danger" icon="trash" disabledReason={lockReason(ops.locks.delete, "delete")} onClick={ops.remove}>
            {MODPACK_REIMPORT_COPY.deleteInstance}
          </Button>
        </>
      }
    >
      {reason}
    </Banner>
  );
}

export function InstallingBanner({ instanceId }: { instanceId: string }) {
  const { go } = useNav();
  // 进度每个任务约 100 ms 一次：横幅自己订阅本实例的任务，页面拿到的启动视图里的任务进度可能是旧的
  const task = useLauncherSelector((s) => instanceTask(s, instanceId));
  const running = task !== null && task.status === "running";
  const title = task === null ? OVERVIEW_COPY.queuedTitle : task.title;
  return (
    <Banner tone="info" icon="download" title={title} actions={<Button variant="ghost" onClick={() => go({ page: "tasks" })}>{OVERVIEW_COPY.viewTasks}</Button>}>
      <div className={styles.bannerProgress}>
        {/* 排队可能很久：静态空轨道，不放常驻的不定进度动画 */}
        <ProgressBar value={running ? task.progress : 0} tone="info" size="sm" track={task === null ? undefined : progressTrack(task)} label={title} />
        <span className={styles.num}>
          {running
            ? OVERVIEW_COPY.installProgress(percent(task.progress), formatSpeed(task.speedBps), task.totalBytes === null ? null : formatBytes(task.totalBytes))
            : OVERVIEW_COPY.queuedBody}
        </span>
      </div>
    </Banner>
  );
}

// ---------------------------------------------------------------- 四格数据

function StatsCard({
  inst,
  content,
  mods,
  outdated,
}: {
  inst: InstanceSummary;
  content: ResourceResult<InstanceContentDto>;
  mods: ResourceResult<InstalledMod[]>;
  outdated: number | null;
}) {
  const now = useNow(30_000);
  // 列表扫完就与 Mod 速览用同一个总数，不让两处一个写 12 个、一个写「还没有装任何 Mod」
  const modTotal = mods.status === "ready" ? modTotals(inst, mods.data.length).total : inst.modCount;
  const hours = Math.floor(inst.playtimeMin / 60);
  const minutes = inst.playtimeMin % 60;
  const playtime = playtimeNote(inst, now);
  const modded = inst.loader !== "vanilla";
  const worlds = useModuleView(content);
  const worldsBytes = content.status === "ready" ? content.data.worlds.reduce((sum, w) => sum + w.size_bytes, 0) : 0;

  const modDelta = !modded
    ? { direction: "flat" as const, text: OVERVIEW_COPY.modsVanilla }
    : outdated === null
      ? undefined
      : outdated > 0
        ? { direction: "up" as const, tone: "positive" as const, text: OVERVIEW_COPY.modsOutdated(outdated) }
        : { direction: "flat" as const, text: OVERVIEW_COPY.modsLatest };

  return (
    <Card>
      <StatGrid columns={4}>
        <StatTile
          icon="clock"
          label={OVERVIEW_COPY.statPlaytime}
          value={String(hours > 0 ? hours : minutes)}
          unit={hours > 0 ? OVERVIEW_COPY.hoursUnit(minutes) : OVERVIEW_COPY.minutesUnit}
          delta={playtime === null ? undefined : { direction: "flat", text: playtime }}
        />
        <StatTile
          icon="calendar"
          label={OVERVIEW_COPY.statLastPlayed}
          kind="text"
          value={inst.lastPlayedAt === null ? OVERVIEW_COPY.never : formatRelative(inst.lastPlayedAt, now)}
          delta={{ direction: "flat", text: inst.lastPlayedAt === null ? OVERVIEW_COPY.rememberOnLaunch : formatDate(inst.lastPlayedAt) }}
        />
        {modTotal === null ? (
          <StatTile icon="box" label={OVERVIEW_COPY.statMods} kind="text" value={OVERVIEW_COPY.modsUnknown} />
        ) : (
          <StatTile icon="box" label={OVERVIEW_COPY.statMods} value={String(modTotal)} unit={OVERVIEW_COPY.modsUnit} delta={modDelta} />
        )}
        {worlds.view === "ready" && content.status === "ready" ? (
          <StatTile
            icon="globe"
            label={OVERVIEW_COPY.statWorlds}
            value={String(content.data.worlds.length)}
            unit={OVERVIEW_COPY.worldsUnit}
            delta={{ direction: "flat", text: content.data.worlds.length > 0 ? OVERVIEW_COPY.worldsSize(worldsBytes) : OVERVIEW_COPY.worldsNone }}
          />
        ) : worlds.view === "error" ? (
          <StatTile icon="globe" label={OVERVIEW_COPY.statWorlds} kind="text" value={OVERVIEW_COPY.worldsError} />
        ) : (
          <div className={styles.statSkeleton}>{worlds.view === "skeleton" && <Skeleton shape="text" lines={3} />}</div>
        )}
      </StatGrid>
    </Card>
  );
}

// ---------------------------------------------------------------- 存档

const MODE_LABEL = { survival: "生存", creative: "创造", adventure: "冒险", spectator: "旁观", hardcore: "极限" } as const;
const MODE_TILE: Readonly<Record<keyof typeof MODE_LABEL, WorldMode | null>> = {
  survival: "survival",
  creative: "creative",
  adventure: "adventure",
  hardcore: "hardcore",
  spectator: null,
};

function WorldsCard({ inst, view, content, ops }: { inst: InstanceSummary; view: LaunchView; content: ResourceResult<InstanceContentDto>; ops: InstanceOps }) {
  const now = useNow(30_000);
  // 不经 useLaunch：它按片订阅的启动视图随下载进度变，页面传进来的 view 只在阶段变化时变，存档行用它就够了
  const actions = useLauncherActions();
  const run = useRunner();
  // 直达按世界文件夹名：level.dat 里的世界名可以重名，也可以和文件夹名不同
  const enter = (dirName: string) => void run(() => actions.quickPlay(inst.id, { kind: "singleplayer", world_dir_name: dirName }), ACTION_ERROR.launch(inst.name));
  const [expanded, setExpanded] = useState(false);
  const worldOps = useWorldOps(inst, ops);
  const block = enterWorldBlock(inst, view.kind, worldOps.busyWorlds.length > 0);
  const enterReason = block === null ? undefined : OVERVIEW_COPY.enterWorldBlocked[block];
  // 弹窗关上后仍记着最近看的那个存档：退场动画期间标题与列表不变成空的
  const [backupsOf, setBackupsOf] = useState<WorldRef | null>(null);
  const [backupsOpen, setBackupsOpen] = useState(false);
  const load = useModuleView(content);
  const worlds = content.status === "ready" ? sortWorlds(content.data.worlds) : [];
  const total = worlds.reduce((sum, w) => sum + w.size_bytes, 0);
  const shown = expanded ? worlds : worlds.slice(0, WORLDS_PREVIEW);
  const subtitle =
    load.view !== "ready" ? undefined : worlds.length > 0 ? OVERVIEW_COPY.worldsSubtitle(worlds.length, total) : OVERVIEW_COPY.worldsEmptySubtitle;

  return (
    <Card>
      <CardHeader
        icon="world"
        title={OVERVIEW_COPY.worldsTitle}
        subtitle={subtitle}
        actions={<FolderButton ops={ops} target="saves" label={OVERVIEW_COPY.openSaves} size="sm" />}
      />
      {load.view === "skeleton" && <RowSkeletons rows={3} slow={load.slow} />}
      {load.view === "error" && content.status === "error" && <ModuleError title={OVERVIEW_COPY.worldsError} error={content.error} onRetry={content.reload} />}
      {load.view === "ready" && worlds.length === 0 && <EmptyState compact scene="map" title={OVERVIEW_COPY.worldsEmptyTitle} body={OVERVIEW_COPY.worldsEmptyBody} />}
      {load.view === "ready" && worlds.length > 0 && (
        <>
          <ul className={styles.rows}>
            {shown.map((w, i) => {
              const name = worldName(w);
              const tile = w.mode === null ? null : MODE_TILE[w.mode];
              return (
                <li key={w.dir_name} className={styles.row}>
                  {tile === null ? <KindTile kind="unknown" /> : <WorldModeTile mode={tile} />}
                  <div className={styles.rowMain}>
                    <span className={styles.rowTitle}>
                      <span className={styles.ellipsis}>{name}</span>
                      {i === 0 && w.last_played !== null && (
                        <Tag tone="accent" size="sm">
                          {OVERVIEW_COPY.recent}
                        </Tag>
                      )}
                    </span>
                    <span className={styles.rowSub}>
                      {w.level_status === "unreadable" ? (
                        OVERVIEW_COPY.worldUnreadable
                      ) : (
                        <>
                          <span data-mode={w.mode === null ? undefined : w.mode} className={styles.modeText}>
                            {w.mode === null ? OVERVIEW_COPY.modeUnknown : MODE_LABEL[w.mode]}
                          </span>
                          {` · ${w.last_played === null ? OVERVIEW_COPY.worldNeverPlayed : formatRelative(w.last_played, now)}`}
                        </>
                      )}
                    </span>
                  </div>
                  <span className={cx(styles.rowMeta, styles.worldSize)}>{formatBytes(w.size_bytes)}</span>
                  <IconButton icon="play" label={OVERVIEW_COPY.enterWorld(name)} size="sm" disabledReason={enterReason} onClick={() => enter(w.dir_name)} />
                  <IconButton icon="folder" label={OVERVIEW_COPY.openWorld(name)} size="sm" onClick={() => ops.openFolder("world", w.dir_name)} />
                  <MoreMenu
                    size="sm"
                    label={WORLD_BACKUP_COPY.rowMenu(name)}
                    items={worldOps.menu(worldRef(w), () => {
                      setBackupsOf(worldRef(w));
                      setBackupsOpen(true);
                    })}
                  />
                </li>
              );
            })}
          </ul>
          {worlds.length > WORLDS_PREVIEW && (
            <div className={styles.cardFoot}>
              <Button variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)}>
                {expanded ? OVERVIEW_COPY.collapse : OVERVIEW_COPY.expandWorlds(worlds.length - WORLDS_PREVIEW)}
              </Button>
            </div>
          )}
        </>
      )}
      {backupsOf !== null && <WorldBackupsModal inst={inst} world={backupsOf} open={backupsOpen} onClose={() => setBackupsOpen(false)} worldOps={worldOps} />}
    </Card>
  );
}

// ---------------------------------------------------------------- 实例信息

function InfoCard({ inst, queryId, onTab }: { inst: InstanceSummary; queryId: string | null; onTab(tab: InstanceTab): void }) {
  const settings = useInstanceSettings(queryId);
  const java = useJavaInfo(inst, settings);
  const memory = useMemoryInfo(inst, settings, queryId);
  const description = settings.status === "ready" ? settings.data.description : inst.description;

  const javaValue = (() => {
    if (java.status === "loading") return <Skeleton shape="text" width={96} />;
    if (java.status === "error") return <span className={styles.dangerText}>{java.error.message}</span>;
    const info = java.value;
    if (info === null) return HERO_COPY.versionUnknown;
    const runtime = chosenRuntime(info.choice);
    // 实例跟随全局、全局固定了默认 Java：用的是那个固定的 Java，找不到时启动会失败，不会去下载
    const globalPin = info.choice.auto && info.choice.pick.kind === "global";
    const text = globalPin
      ? runtime === null
        ? OVERVIEW_COPY.javaGlobalMissing
        : OVERVIEW_COPY.javaGlobalPinned(runtime.version.major)
      : info.choice.auto
        ? runtime === null
          ? OVERVIEW_COPY.javaAutoDownload
          : OVERVIEW_COPY.javaAutoFound(runtime.version.major)
        : runtime === null
          ? OVERVIEW_COPY.javaPinnedMissing
          : OVERVIEW_COPY.javaPinned(runtime.version.major);
    return (
      <span>
        {text}
        <span className={styles.soft}>{OVERVIEW_COPY.javaRequired(info.required)}</span>
      </span>
    );
  })();

  // 整合包记录读不出来时如实写原因，不当成「自行组装」
  const modpackValue =
    inst.modpack !== null ? (
      modpackLabel(inst.modpack)
    ) : inst.modpackError !== null ? (
      <span className={styles.dangerText}>{inst.modpackError}</span>
    ) : (
      OVERVIEW_COPY.modpackNone
    );

  const memoryValue =
    memory.status === "loading" ? (
      <Skeleton shape="text" width={72} />
    ) : memory.status === "error" ? (
      <span className={styles.dangerText}>{memory.error.message}</span>
    ) : (
      <span className={styles.num}>
        {formatMemory(memory.value.effectiveMb)}
        {memory.value.followsGlobal && <span className={styles.soft}>{OVERVIEW_COPY.memoryFollow}</span>}
      </span>
    );

  return (
    <Card>
      <CardHeader
        icon="info"
        title={OVERVIEW_COPY.infoTitle}
        actions={
          <Button variant="ghost" size="sm" iconRight="chevron-right" onClick={() => onTab("settings")}>
            {OVERVIEW_COPY.settings}
          </Button>
        }
      />
      {description !== null && description.trim() !== "" && <p className={styles.description}>{description}</p>}
      <KV
        rows={[
          { label: OVERVIEW_COPY.kvVersion, value: <span className={styles.num}>{inst.mcVersion === null ? HERO_COPY.versionUnknown : inst.mcVersion}</span> },
          { label: OVERVIEW_COPY.kvLoader, value: <LoaderTag loader={inst.loader} version={inst.loaderVersion} size="sm" /> },
          { label: OVERVIEW_COPY.kvModpack, value: modpackValue },
          { label: OVERVIEW_COPY.kvJava, value: javaValue },
          { label: OVERVIEW_COPY.kvMemory, value: memoryValue },
          { label: OVERVIEW_COPY.kvCreated, value: inst.createdAt === null ? OVERVIEW_COPY.createdUnknown : formatDate(inst.createdAt) },
        ]}
      />
    </Card>
  );
}

// ---------------------------------------------------------------- Mod 速览

function ModsPeekCard({
  inst,
  queryId,
  mods,
  updates,
  ops,
  onTab,
}: {
  inst: InstanceSummary;
  queryId: string | null;
  mods: ResourceResult<InstalledMod[]>;
  updates: ResourceResult<UpdateCandidate[]>;
  ops: InstanceOps;
  onTab(tab: InstanceTab): void;
}) {
  const { openCreateInstance } = useShell();
  const { go } = useNav();
  const actions = useLauncherActions();
  const run = useRunner();
  const vanilla = inst.loader === "vanilla";
  const updating = useLauncherSelector((s) => s.tasks.some((t) => isPendingModUpdate(t, inst.id)));
  const load = useModuleView(mods);
  const rows: ModRow[] = mods.status === "ready" ? modRows(mods.data, updates.status === "ready" ? updates.data : null) : [];
  const { total, partial } = modTotals(inst, rows.length);
  const outdated = rows.filter((r) => r.update !== null);
  // 「全部更新」先打开更新预览，与 Mod 标签同一个弹窗；key 每次打开递增，勾选从默认全选重新开始
  const [preview, setPreview] = useState<{ key: number; open: boolean } | null>(null);

  const subtitle = vanilla || load.view !== "ready" || rows.length === 0 ? undefined : partial ? OVERVIEW_COPY.modsPartial(total, rows.length) : OVERVIEW_COPY.modsCount(total);

  return (
    <Card>
      <CardHeader
        icon="mod"
        title={OVERVIEW_COPY.modsTitle}
        subtitle={subtitle}
        actions={
          !vanilla && (
            <Button variant="ghost" size="sm" iconRight="chevron-right" onClick={() => onTab("mods")}>
              {OVERVIEW_COPY.manage}
            </Button>
          )
        }
      />
      {vanilla ? (
        <Callout
          tone="info"
          action={
            <Button size="sm" icon="plus" onClick={() => openCreateInstance()}>
              {OVERVIEW_COPY.newInstance}
            </Button>
          }
        >
          {OVERVIEW_COPY.vanillaPeek}
        </Callout>
      ) : load.view === "pending" || load.view === "skeleton" ? (
        <>
          <div className={styles.peek}>{load.view === "skeleton" && Array.from({ length: 12 }, (_, i) => <Skeleton key={i} shape="square" size={44} />)}</div>
          <SlowHint slow={load.slow} />
        </>
      ) : mods.status === "error" ? (
        <ModuleError title={OVERVIEW_COPY.modsError} error={mods.error} onRetry={mods.reload} />
      ) : rows.length === 0 ? (
        <Callout
          tone="info"
          action={
            <Button size="sm" icon="compass" onClick={() => go({ page: "discover", kind: "mod", forInstance: inst.id })}>
              {OVERVIEW_COPY.findMods}
            </Button>
          }
        >
          {OVERVIEW_COPY.noModsPeek}
        </Callout>
      ) : (
        <>
          <PeekTiles rows={rows} total={total} onOpen={() => onTab("mods")} />
          {outdated.length > 0 && (
            <Callout
              tone="info"
              icon="sparkle"
              action={
                <Button
                  size="sm"
                  icon="download"
                  disabledReason={lockReason(ops.locks.mods, "mods")}
                  loading={updating}
                  onClick={() => setPreview((p) => ({ key: p === null ? 0 : p.key + 1, open: true }))}
                >
                  {OVERVIEW_COPY.updateAll}
                </Button>
              }
            >
              {OVERVIEW_COPY.outdatedHint(
                outdated.slice(0, 3).map((r) => r.name),
                outdated.length,
              )}
            </Callout>
          )}
        </>
      )}
      {preview !== null && (
        <UpdatePreviewModal
          key={preview.key}
          open={preview.open}
          queryId={queryId}
          rows={outdated}
          onClose={() => setPreview((p) => (p === null ? p : { ...p, open: false }))}
          onConfirm={(picked) => {
            setPreview((p) => (p === null ? p : { ...p, open: false }));
            void run(() => actions.updateAllMods(inst.id, picked), ACTION_ERROR.updateMods);
          }}
        />
      )}
    </Card>
  );
}

function PeekTiles({ rows, total, onOpen }: { rows: readonly ModRow[]; total: number; onOpen(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [perRow, setPerRow] = useState(1);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) throw new Error("Mod 速览容器尚未挂载");
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setPerRow(peekPerRow(entry.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const { shown, more } = peekLayout(rows.length, total, perRow);
  return (
    <div ref={ref} className={styles.peek}>
      {rows.slice(0, shown).map((r) => (
        <Tooltip key={r.fileName} content={r.name} sub={`${r.version === null ? "" : r.version}${r.enabled ? "" : OVERVIEW_COPY.modDisabledSuffix}`}>
          <button type="button" className={styles.peekTile} aria-label={r.name} onClick={onOpen}>
            <Thumb url={r.iconUrl} kind="mod" hue={hueOf(r.seed)} size={44} inactive={!r.enabled} />
            {r.update !== null && <Badge tone="accent" ring className={styles.peekDot} />}
          </button>
        </Tooltip>
      ))}
      {more > 0 && (
        <button type="button" className={styles.peekMore} onClick={onOpen}>
          +{more}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 资源包与光影

function PacksCard({ inst, content }: { inst: InstanceSummary; content: ResourceResult<InstanceContentDto> }) {
  const { go } = useNav();
  const vanilla = inst.loader === "vanilla";
  const discover = () => go({ page: "discover", kind: "resourcepack", forInstance: inst.id });
  const load = useModuleView(content);

  return (
    <Card>
      <CardHeader icon="image" title={OVERVIEW_COPY.packsTitle} actions={<IconButton icon="compass" label={OVERVIEW_COPY.findPacks} size="sm" onClick={discover} />} />
      {load.view === "skeleton" && <RowSkeletons rows={2} slow={load.slow} />}
      {load.view === "error" && content.status === "error" && <ModuleError title={OVERVIEW_COPY.packsError} error={content.error} onRetry={content.reload} />}
      {load.view === "ready" && content.status === "ready" && (
        <ul className={styles.rows}>
          {(() => {
            const active = content.data.shader_packs.find((s) => s.active);
            return (
              <li className={styles.row}>
                <KindTile kind="shader" />
                <div className={styles.rowMain}>
                  <span className={styles.rowTitle} data-muted={active === undefined || undefined}>
                    <span className={styles.ellipsis}>{active === undefined ? OVERVIEW_COPY.noShader : active.file_name}</span>
                  </span>
                  <span className={styles.rowSub}>{active !== undefined ? OVERVIEW_COPY.shaderSub : vanilla ? OVERVIEW_COPY.shaderVanilla : OVERVIEW_COPY.shaderHint}</span>
                </div>
                {active !== undefined && (
                  <Tag tone="accent" size="sm">
                    {OVERVIEW_COPY.shaderActive}
                  </Tag>
                )}
              </li>
            );
          })()}
          {content.data.resource_packs.length === 0 ? (
            <li className={styles.row}>
              <KindTile kind="resource-pack" />
              <div className={styles.rowMain}>
                <span className={styles.rowTitle} data-muted="">
                  {OVERVIEW_COPY.noResourcePack}
                </span>
                <span className={styles.rowSub}>{OVERVIEW_COPY.vanillaTextures}</span>
              </div>
            </li>
          ) : (
            [...content.data.resource_packs]
              .sort((a, b) => (a.load_order === null ? Infinity : a.load_order) - (b.load_order === null ? Infinity : b.load_order))
              .map((p) => (
                <li key={p.file_name} className={styles.row}>
                  <KindTile kind="resource-pack" />
                  <div className={styles.rowMain}>
                    <span className={styles.rowTitle}>
                      <span className={styles.ellipsis}>{p.file_name}</span>
                    </span>
                    <span className={styles.rowSub}>{p.load_order === null ? OVERVIEW_COPY.packInactive : OVERVIEW_COPY.packOrder(p.load_order)}</span>
                  </div>
                </li>
              ))
          )}
        </ul>
      )}
      {inst.mcVersion !== null && (
        <p className={styles.footNote}>
          <Icon name="info" size={14} />
          {OVERVIEW_COPY.packsFoot(inst.loader, inst.mcVersion)}
        </p>
      )}
    </Card>
  );
}

function RowSkeletons({ rows, slow }: { rows: number; slow: boolean }) {
  return (
    <div className={styles.rows}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={styles.row}>
          <Skeleton shape="square" size={44} />
          <div className={styles.rowMain}>
            <Skeleton shape="text" lines={2} />
          </div>
        </div>
      ))}
      <SlowHint slow={slow} />
    </div>
  );
}

