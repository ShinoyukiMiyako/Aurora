// 概览：状态横幅（至多一条）→ 四格数据 → 存档与实例信息 → Mod 速览与资源包光影。
// 每个模块各自加载、各自出错，不互相等待。

import { AnimatePresence, motion, useIsPresent, useReducedMotionConfig } from "framer-motion";
import { useLayoutEffect, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import { Icon } from "../../art/Icon";
import { KindTile, WorldModeTile, type WorldMode } from "../../art/illustrations/FeatureTile";
import { hueOf } from "../../art/illustrations/seed";
import { ACTION_ERROR, CRASH_COPY, crashCategoryLabel, INSTANCE_IN_USE_COPY, lockReason, MODPACK_REIMPORT_COPY, modpackLabel, REINSTALL_LOADER_LABEL, taskPhaseText } from "../../copy/flows";
import type { InstanceSummary } from "../../domain/adapt";
import { formatBytes, formatDate, formatMemory, formatRelative, formatSpeed, percent } from "../../domain/format";
import { canReinstallLoader, lostLoaderLibrary, needsReimport } from "../../domain/rules";
import type { LaunchView } from "../../launch/launchView";
import { useLaunch } from "../../launch/useLaunch";
import { useMounted } from "../../lib/useMounted";
import { useLoadingGate } from "../../lib/loading-gate";
import { fade, insertItem } from "../../lib/motion";
import { useReflow } from "../../lib/reflow";
import { cx } from "../../lib/util";
import { useNav, useShell } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import { useLauncherActions, useLauncherSelector, useNow, useNowSince } from "../../state/launcher";
import {
  useInstanceContent,
  useInstanceMods,
  useInstanceSettings,
  type CrashReportDto,
  type InstalledMod,
  type InstanceContentDto,
  type UpdateCandidate,
  type WorldDto,
} from "../../state/queries/instance";
import type { ResourceResult } from "../../state/resource";
import { reimportRoute, type InstanceTab } from "../../state/route";
import { instanceTask } from "../../state/selectors";
import { progressTrack } from "../../state/tasks";
import { Appear } from "../../ui/Appear";
import { Badge } from "../../ui/Badge";
import { Banner, BannerSlot } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Card } from "../../ui/Card";
import { CardHeader } from "../../ui/CardHeader";
import { EmptyState } from "../../ui/EmptyState";
import { IconButton } from "../../ui/IconButton";
import { KV } from "../../ui/KV";
import { Loadable } from "../../ui/Loadable";
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
  PEEK_TILE,
  peekLayout,
  peekPerRow,
  peekPlaceholder,
  playtimeNote,
  sortWorlds,
  worldName,
  worldsPlaceholder,
  WORLDS_PREVIEW,
  type ModRow,
} from "./model";
import type { InstanceOps } from "./ops";
import { FolderButton, loadableView, ModuleError, SlowHint, useModuleView } from "./parts";
import { useWorldOps, WorldBackupsModal, worldRef, type WorldRef } from "./WorldBackupsModal";
import { UpdatePreviewModal } from "./UpdatePreviewModal";

export interface OverviewTabProps {
  inst: InstanceSummary;
  queryId: string | null;
  ops: InstanceOps;
  view: LaunchView;
  crash: ResourceResult<CrashReportDto | null>;
  /** 上次崩溃的时刻：实例列表与崩溃报告里较晚的那个，报告没到时取列表里的。 */
  crashAt: number | null;
  crashActive: boolean;
  updates: ResourceResult<UpdateCandidate[]>;
  onTab(tab: InstanceTab): void;
}

export function OverviewTab({ inst, queryId, ops, view, crash, crashAt, crashActive, updates, onTab }: OverviewTabProps) {
  const modded = inst.loader !== "vanilla";
  const content = useInstanceContent(queryId);
  const mods = useInstanceMods(modded ? queryId : null);
  const banner = overviewBanner(view.kind, crashActive);
  const outdated = updates.status === "ready" ? updates.data.length : null;
  // 横幅出现、消失与各模块数据晚到撑高时，下面的卡片从原位置滑过去（标签面板里的栈不在页面一级，要自己挂）
  const stack = useReflow<HTMLDivElement>();
  const grid = useReflow<HTMLDivElement>();
  // 上次崩溃由列表时刻先判定：报告还在读就先画横幅（正文写正在读取），不等报告到了再插进来把下面整块推下去。
  // 报告读不到或读出来是空的时不画，与读到之前的口径一致
  const crashShown = banner === "crashed" && (crash.status === "loading" || (crash.status === "ready" && crash.data !== null));

  return (
    <div ref={stack} className={styles.stack}>
      {/* 至多一条横幅：换成另一种时旧的淡出、新的淡入，每种各自一个 key */}
      <BannerSlot>
        {banner === "failed" && <FailedBanner key="failed" inst={inst} />}
        {crashShown && <CrashBanner key="crashed" at={crashAt} report={crash.status === "ready" ? crash.data : null} onTab={onTab} />}
        {banner === "broken" &&
          view.kind === "broken" &&
          (needsReimport(inst) ? <ReimportBanner key="reimport" inst={inst} reason={view.reason} ops={ops} /> : <BrokenBanner key="broken" inst={inst} reason={view.reason} ops={ops} />)}
        {banner === "installing" && view.kind === "installing" && <InstallingBanner key="installing" instanceId={inst.id} />}
      </BannerSlot>
      <StatsCard inst={inst} content={content} mods={mods} outdated={outdated} />
      <div ref={grid} className={styles.overviewGrid}>
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
  // 横幅退场淡出的那一小段里它仍挂着、仍随启动状态重渲染，而会话可能已经不是失败态：留着最后一份失败文案画完退场。
  // 文案对象每次渲染都新建，记在 ref 里而不是 state（state 会因引用变化在渲染期反复重设）
  const last = useRef(entry.failure);
  if (entry.failure !== null) last.current = entry.failure;
  const failure = last.current;
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

/** report 为 null：报告还在读，标题按列表里的崩溃时刻先写出来，正文先写正在读取，报告到了原位换成诊断。 */
function CrashBanner({ at, report, onTab }: { at: number | null; report: CrashReportDto | null; onTab(tab: InstanceTab): void }) {
  const now = useNow(30_000);
  // 等过报告的才让诊断正文淡入；挂载时报告就在的跟着横幅自己的入场
  const [waited, setWaited] = useState(report === null);
  if (report === null && !waited) setWaited(true);
  if (at === null) throw new Error("上次崩溃横幅需要崩溃时刻");
  const first = report === null ? undefined : report.diagnoses[0];
  const body =
    report === null
      ? OVERVIEW_COPY.crashBodyPending
      : first === undefined
        ? OVERVIEW_COPY.crashBodyNoClue
        : first.category === "manual_debug_crash"
          ? CRASH_COPY.manualNote
          : OVERVIEW_COPY.crashBody(crashCategoryLabel(first.category));
  return (
    <Banner
      tone="danger"
      icon="bug"
      title={OVERVIEW_COPY.crashTitle(formatRelative(at, now))}
      actions={<Button onClick={() => onTab("crash")}>{OVERVIEW_COPY.viewCrash}</Button>}
    >
      <motion.span key={report === null ? "pending" : "report"} initial={report !== null && waited ? { opacity: 0 } : false} animate={{ opacity: 1, transition: fade.in }}>
        {body}
      </motion.span>
    </Banner>
  );
}

function BrokenBanner({ inst, reason, ops }: { inst: InstanceSummary; reason: string; ops: InstanceOps }) {
  // 原因写着要重新安装加载器时按钮照着说：普通的「修复实例」看上去又是刚失败过的那件事
  const reinstall = lostLoaderLibrary(inst) && canReinstallLoader(inst);
  return (
    <Banner
      tone="warn"
      icon="alert"
      title={OVERVIEW_COPY.brokenTitle}
      actions={
        reinstall ? (
          <Button icon="wrench" disabledReason={lockReason(ops.locks.repair, "reinstallLoader")} onClick={ops.reinstallLoader}>
            {REINSTALL_LOADER_LABEL}
          </Button>
        ) : (
          <Button icon="wrench" disabledReason={lockReason(ops.locks.repair, "repair")} onClick={ops.repair}>
            {OVERVIEW_COPY.repair}
          </Button>
        )
      }
    >
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
            ? task.phase === null
              ? OVERVIEW_COPY.installProgress(percent(task.progress), formatSpeed(task.speedBps), task.totalBytes === null ? null : formatBytes(task.totalBytes))
              : OVERVIEW_COPY.installStepProgress(percent(task.progress), taskPhaseText(task.phase, "long"), formatSpeed(task.speedBps))
            : OVERVIEW_COPY.queuedBody}
        </span>
      </div>
    </Banner>
  );
}

// ---------------------------------------------------------------- 四格数据

function PlaytimeTile({ minutes, lastPlayedAt, createdAt, now }: { minutes: number; lastPlayedAt: number | null; createdAt: number | null; now: number }) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const note = playtimeNote({ playtimeMin: minutes, lastPlayedAt, createdAt }, now);
  return (
    <StatTile
      icon="clock"
      label={OVERVIEW_COPY.statPlaytime}
      value={String(hours > 0 ? hours : rest)}
      unit={hours > 0 ? OVERVIEW_COPY.hoursUnit(rest) : OVERVIEW_COPY.minutesUnit}
      delta={note === null ? undefined : { direction: "flat", text: note }}
    />
  );
}

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
  const now = useNowSince(inst.lastPlayedAt, 30_000);
  // 列表扫完就与 Mod 速览用同一个总数，不让两处一个写 12 个、一个写「还没有装任何 Mod」
  const modTotal = mods.status === "ready" ? modTotals(inst, mods.data.length).total : inst.modCount;
  const modded = inst.loader !== "vanilla";
  const worlds = useModuleView(content);
  const worldsBytes = content.status === "ready" ? content.data.worlds.reduce((sum, w) => sum + w.size_bytes, 0) : 0;
  // 四格里只写得下「读不到」，原因放在格子下面；一张卡片只留一条提示
  const notices = [
    ...(inst.playError === null ? [] : [OVERVIEW_COPY.playError(inst.playError)]),
    ...(inst.dirError === null ? [] : [OVERVIEW_COPY.dirError(inst.dirError)]),
  ];

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
        {inst.playtimeMin === null ? (
          <StatTile icon="clock" label={OVERVIEW_COPY.statPlaytime} kind="text" value={OVERVIEW_COPY.playUnknown} />
        ) : (
          <PlaytimeTile minutes={inst.playtimeMin} lastPlayedAt={inst.lastPlayedAt} createdAt={inst.createdAt} now={now} />
        )}
        {inst.playError !== null ? (
          <StatTile icon="calendar" label={OVERVIEW_COPY.statLastPlayed} kind="text" value={OVERVIEW_COPY.playUnknown} />
        ) : (
          <StatTile
            icon="calendar"
            label={OVERVIEW_COPY.statLastPlayed}
            kind="text"
            value={inst.lastPlayedAt === null ? OVERVIEW_COPY.never : formatRelative(inst.lastPlayedAt, now)}
            delta={{ direction: "flat", text: inst.lastPlayedAt === null ? OVERVIEW_COPY.rememberOnLaunch : formatDate(inst.lastPlayedAt) }}
          />
        )}
        {modTotal === null ? (
          <StatTile icon="box" label={OVERVIEW_COPY.statMods} kind="text" value={OVERVIEW_COPY.modsUnknown} />
        ) : (
          <StatTile icon="box" label={OVERVIEW_COPY.statMods} value={String(modTotal)} unit={OVERVIEW_COPY.modsUnit} delta={modDelta} />
        )}
        {/* 存档格：读到之前骨架照常占着格子，读到后骨架淡出、数字淡入，叠在同一格里交接 */}
        <Loadable
          view={loadableView(worlds.view)}
          skeleton={
            <div className={styles.statSkeleton}>
              <Skeleton shape="text" lines={3} />
            </div>
          }
        >
          {() => {
            if (content.status === "loading") throw new Error("加载门已放行，存档查询却还在加载");
            if (content.status === "error") return <StatTile icon="globe" label={OVERVIEW_COPY.statWorlds} kind="text" value={OVERVIEW_COPY.worldsError} />;
            return (
              <StatTile
                icon="globe"
                label={OVERVIEW_COPY.statWorlds}
                value={String(content.data.worlds.length)}
                unit={OVERVIEW_COPY.worldsUnit}
                delta={{ direction: "flat", text: content.data.worlds.length > 0 ? OVERVIEW_COPY.worldsSize(worldsBytes) : OVERVIEW_COPY.worldsNone }}
              />
            );
          }}
        </Loadable>
      </StatGrid>
      {notices.length > 0 && (
        <Callout tone="warn" className={styles.statsNotice}>
          {notices.map((notice) => (
            <div key={notice}>{notice}</div>
          ))}
        </Callout>
      )}
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
  const enterReason = block === null ? undefined : typeof block === "object" ? INSTANCE_IN_USE_COPY.launch(block.usedBy) : OVERVIEW_COPY.enterWorldBlocked[block];
  // 弹窗关上后仍记着最近看的那个存档：退场动画期间标题与列表不变成空的
  const [backupsOf, setBackupsOf] = useState<WorldRef | null>(null);
  const [backupsOpen, setBackupsOpen] = useState(false);
  const load = useModuleView(content);
  const worlds = content.status === "ready" ? sortWorlds(content.data.worlds) : [];
  const total = worlds.reduce((sum, w) => sum + w.size_bytes, 0);
  const shown = expanded ? worlds : worlds.slice(0, WORLDS_PREVIEW);
  // 副标题必定会有：读到之前先占住一行（null），卡头不因文案晚到变高
  const subtitle = load.view !== "ready" ? null : worlds.length > 0 ? OVERVIEW_COPY.worldsSubtitle(worlds.length, total) : OVERVIEW_COPY.worldsEmptySubtitle;

  return (
    <Card>
      <CardHeader
        icon="world"
        title={OVERVIEW_COPY.worldsTitle}
        subtitle={subtitle}
        actions={<FolderButton ops={ops} target="saves" label={OVERVIEW_COPY.openSaves} size="sm" />}
      />
      {/* 读到之前按实例列表里的存档数画同样多的占位行，读到后卡片高度不变，第二行的卡片不被推下去 */}
      <Loadable view={loadableView(load.view)} skeleton={<WorldsSkeleton count={inst.worldCount} />}>
        {() => {
          if (content.status === "loading") throw new Error("加载门已放行，存档查询却还在加载");
          if (content.status === "error") return <ModuleError title={OVERVIEW_COPY.worldsError} error={content.error} onRetry={content.reload} />;
          if (worlds.length === 0) return <EmptyState compact scene="map" title={OVERVIEW_COPY.worldsEmptyTitle} body={OVERVIEW_COPY.worldsEmptyBody} />;
          return (
            <>
              <WorldRows worlds={shown}>
                {(w, i) => {
                  const name = worldName(w);
                  const tile = w.mode === null ? null : MODE_TILE[w.mode];
                  return (
                    <>
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
                    </>
                  );
                }}
              </WorldRows>
              {worlds.length > WORLDS_PREVIEW && (
                <div className={styles.cardFoot}>
                  <Button variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)}>
                    {expanded ? OVERVIEW_COPY.collapse : OVERVIEW_COPY.expandWorlds(worlds.length - WORLDS_PREVIEW)}
                  </Button>
                </div>
              )}
            </>
          );
        }}
      </Loadable>
      <SlowHint slow={load.slow} />
      {backupsOf !== null && <WorldBackupsModal inst={inst} world={backupsOf} open={backupsOpen} onClose={() => setBackupsOpen(false)} worldOps={worldOps} />}
    </Card>
  );
}

/** 一行存档的出入场：退场时已经不是列表的一行，不接受指针与焦点。减少动画时只留透明度（缩放在那里是一步到位的）。 */
const ROW_FADE = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: fade.in },
  exit: { opacity: 0, transition: fade.out },
} as const;

/**
 * 存档行的列表：游戏退出后重读、最近玩过的排到第一，或新建了存档、展开收起时，行不在原地瞬移。
 * 新来的行淡入并从略小处落到位，走掉的行抽出布局原地淡出，其余行从旧位置滑到新位置（列表挂着让位）。
 * 列表挂载时就在的行不单独入场：它们跟着模块内容一起淡入。
 */
function WorldRows({ worlds, children }: { worlds: readonly WorldDto[]; children(world: WorldDto, index: number): ReactNode }) {
  const reflow = useReflow<HTMLUListElement>();
  const mounted = useMounted();
  return (
    <ul ref={reflow} className={styles.rows}>
      <AnimatePresence mode="popLayout">
        {worlds.map((w, i) => (
          <WorldRow key={w.dir_name} entering={mounted.current}>
            {children(w, i)}
          </WorldRow>
        ))}
      </AnimatePresence>
    </ul>
  );
}

/** popLayout 量尺寸、把退场的行抽出布局要用 ref，由 AnimatePresence 递进来，落到 li 上。 */
function WorldRow({ ref, entering, children }: { ref?: Ref<HTMLLIElement>; entering: boolean; children: ReactNode }) {
  const present = useIsPresent();
  const item = useReducedMotionConfig() === true ? ROW_FADE : insertItem;
  return (
    <motion.li ref={ref} className={styles.row} inert={!present} initial={entering ? item.initial : false} animate={item.animate} exit={item.exit}>
      {children}
    </motion.li>
  );
}

/** 存档卡读到之前的占位：形状按实例列表里的存档数定（见 worldsPlaceholder），没有文字，退场叠在内容上淡出时也不留字。 */
function WorldsSkeleton({ count }: { count: number | null }) {
  const shape = worldsPlaceholder(count);
  if (shape.kind === "empty") return <EmptySkeleton />;
  return (
    <>
      <RowSkeletons rows={shape.rows} />
      {shape.foot && (
        <div className={styles.cardFoot}>
          <Skeleton shape="block" width={112} height={30} radius="sm" />
        </div>
      )}
    </>
  );
}

/** 紧凑空状态的轮廓：插画 64、标题一行、正文一行，与 EmptyState compact 的几何一致。 */
function EmptySkeleton() {
  return (
    <div className={styles.emptySkeleton}>
      <Skeleton shape="square" size={64} />
      <span className={styles.emptySkeletonTitle}>
        <Skeleton shape="text" width={96} />
      </span>
      <span className={styles.emptySkeletonBody}>
        <Skeleton shape="text" width={220} />
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- 实例信息

function InfoCard({ inst, queryId, onTab }: { inst: InstanceSummary; queryId: string | null; onTab(tab: InstanceTab): void }) {
  const settings = useInstanceSettings(queryId);
  const java = useJavaInfo(inst, settings);
  const memory = useMemoryInfo(inst, settings, queryId);
  const description = settings.status === "ready" ? settings.data.description : inst.description;
  // 这两格要等实例设置、本机 Java 与内存建议：300 ms 内读到不出骨架（只占位），骨架按常见文案的宽度给，
  // 读到后骨架淡出、值淡入叠在同一格里交接，右对齐的值不从骨架的左缘跳到自己的左缘
  const javaGate = useLoadingGate(java.status === "loading");
  const memoryGate = useLoadingGate(memory.status === "loading");

  const javaValue = () => {
    if (java.status === "loading") throw new Error("加载门已放行，Java 信息却还在加载");
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
  };

  // 整合包记录读不出来时如实写原因，不当成「自行组装」
  const modpackValue =
    inst.modpack !== null ? (
      modpackLabel(inst.modpack)
    ) : inst.modpackError !== null ? (
      <span className={styles.dangerText}>{inst.modpackError}</span>
    ) : (
      OVERVIEW_COPY.modpackNone
    );

  const memoryValue = () => {
    if (memory.status === "loading") throw new Error("加载门已放行，内存信息却还在加载");
    if (memory.status === "error") return <span className={styles.dangerText}>{memory.error.message}</span>;
    return (
      <span className={styles.num}>
        {formatMemory(memory.value.effectiveMb)}
        {memory.value.followsGlobal && <span className={styles.soft}>{OVERVIEW_COPY.memoryFollow}</span>}
      </span>
    );
  };

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
          {
            label: OVERVIEW_COPY.kvJava,
            value: (
              <Loadable view={javaGate.view} skeleton={<Skeleton shape="text" width={130} />}>
                {javaValue}
              </Loadable>
            ),
          },
          {
            label: OVERVIEW_COPY.kvMemory,
            value: (
              <Loadable view={memoryGate.view} skeleton={<Skeleton shape="text" width={100} />}>
                {memoryValue}
              </Loadable>
            ),
          },
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

  const loading = load.view === "pending" || load.view === "skeleton";
  // 读到之前先占住副标题那一行（null），卡头不因数量晚到变高；实例列表已说没有 Mod 时读到后也没有这一行，不占
  const subtitle =
    vanilla || (loading && inst.modCount === 0) || (!loading && (load.view !== "ready" || rows.length === 0))
      ? undefined
      : loading
        ? null
        : partial
          ? OVERVIEW_COPY.modsPartial(total, rows.length)
          : OVERVIEW_COPY.modsCount(total);

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
      ) : (
        <>
          {/* 读到之前按实例列表里的 Mod 数画占位格（按卡片内宽排成同样的行数），读到后叠放交叉淡入 */}
          <Loadable view={loadableView(load.view)} skeleton={<PeekSkeleton modCount={inst.modCount} />}>
            {() => {
              if (mods.status === "loading") throw new Error("加载门已放行，Mod 列表却还在加载");
              if (mods.status === "error") return <ModuleError title={OVERVIEW_COPY.modsError} error={mods.error} onRetry={mods.reload} />;
              if (rows.length === 0)
                return (
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
                );
              return (
                <>
                  <PeekTiles rows={rows} total={total} onOpen={() => onTab("mods")} />
                  {/* 联网的更新检查晚到秒级：提示条淡入并从略小处落到位，全部更新完消失时淡出 */}
                  <Appear>
                    {outdated.length > 0 && (
                      <Callout
                        key="outdated"
                        tone="info"
                        icon="sparkle"
                        action={
                          <Button
                            size="sm"
                            icon="download"
                            disabledReason={ops.modsReason}
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
                  </Appear>
                </>
              );
            }}
          </Loadable>
          <SlowHint slow={load.slow} />
        </>
      )}
      {preview !== null && (
        <UpdatePreviewModal
          key={preview.key}
          open={preview.open}
          queryId={queryId}
          rows={outdated}
          lock={ops.modsReason}
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

/**
 * 速览容器每行放几格。挂载时在布局效应里先同步量一次：那里的更新在绘制之前提交，首帧就是终值，
 * 不会先按 1 格加「+N」画一帧、下一帧才铺成两行；之后随卡片宽度变化。
 */
function usePeekPerRow(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [perRow, setPerRow] = useState(1);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) throw new Error("Mod 速览容器尚未挂载");
    setPerRow(peekPerRow(el.clientWidth));
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setPerRow(peekPerRow(entry.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, perRow];
}

/** 速览读到之前的占位格：格数见 peekPlaceholder，与真实图块同尺寸、同排布。 */
function PeekSkeleton({ modCount }: { modCount: number | null }) {
  const [ref, perRow] = usePeekPerRow();
  return (
    <div ref={ref} className={styles.peek}>
      {Array.from({ length: peekPlaceholder(modCount, perRow) }, (_, i) => (
        <Skeleton key={i} shape="square" size={PEEK_TILE} />
      ))}
    </div>
  );
}

function PeekTiles({ rows, total, onOpen }: { rows: readonly ModRow[]; total: number; onOpen(): void }) {
  const [ref, perRow] = usePeekPerRow();
  const { shown, more } = peekLayout(rows.length, total, perRow);
  return (
    <div ref={ref} className={styles.peek}>
      {rows.slice(0, shown).map((r) => (
        <Tooltip key={r.fileName} content={r.name} sub={`${r.version === null ? "" : r.version}${r.enabled ? "" : OVERVIEW_COPY.modDisabledSuffix}`}>
          <button type="button" className={styles.peekTile} aria-label={r.name} onClick={onOpen}>
            <Thumb url={r.iconUrl} kind="mod" hue={hueOf(r.seed)} size={44} inactive={!r.enabled} />
            {/* 更新检查晚到时提醒点弹出来，更新装完时缩小淡出；图块挂载时就有的不单独弹 */}
            <AnimatePresence initial={false}>{r.update !== null && <Badge key="update" tone="accent" ring className={styles.peekDot} />}</AnimatePresence>
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
  // 光影一行加资源包至少一行，读到之前就按这两行占位；包多出来的那几行撑高卡片时，底部说明从原位置滑下去
  const body = useReflow<HTMLDivElement>();

  return (
    <Card>
      <CardHeader icon="image" title={OVERVIEW_COPY.packsTitle} actions={<IconButton icon="compass" label={OVERVIEW_COPY.findPacks} size="sm" onClick={discover} />} />
      <div ref={body} className={styles.packsBody}>
        <Loadable view={loadableView(load.view)} skeleton={<RowSkeletons rows={2} />}>
          {() => {
            if (content.status === "loading") throw new Error("加载门已放行，资源包查询却还在加载");
            if (content.status === "error") return <ModuleError title={OVERVIEW_COPY.packsError} error={content.error} onRetry={content.reload} />;
            const active = content.data.shader_packs.find((s) => s.active);
            return (
              <ul className={styles.rows}>
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
            );
          }}
        </Loadable>
        <SlowHint slow={load.slow} />
        {inst.mcVersion !== null && (
          <p className={styles.footNote}>
            <Icon name="info" size={14} />
            {OVERVIEW_COPY.packsFoot(inst.loader, inst.mcVersion)}
          </p>
        )}
      </div>
    </Card>
  );
}

/** 行的占位：与真实的行同高（52）、同间距，没有文字。 */
function RowSkeletons({ rows }: { rows: number }) {
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
    </div>
  );
}

