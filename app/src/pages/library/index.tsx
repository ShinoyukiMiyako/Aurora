// 实例库：全部实例的卡片网格。页头说总数、固定数与累计时长；工具条按加载器筛选、按名称搜索、三种排序，
// 登记了不止一个游戏目录时还能切目录；有损坏实例时页头下出现修复横幅；网格末尾是新建卡（筛选或搜索时不出现）。
// 当前目录没有实例、别的目录里有版本时，空状态直接给切过去的入口。
// 筛选与排序变化时卡片按布局动画挪位；一次超过 40 项或减少动画时直接重排。

import { AnimatePresence, motion, useReducedMotionConfig, type Variants } from "framer-motion";
import { useEffect, useId, useMemo, useRef } from "react";
import { Icon } from "../../art/Icon";
import { ACTION_ERROR, GAME_DIR_SWITCH_COPY, gameDirSwitchReason, LOADER_NAME, lockReason, SLOW_LOADING_HINT } from "../../copy/flows";
import type { InstanceSummary } from "../../domain/adapt";
import { locksOf } from "../../domain/instance-locks";
import { useLoadingGate } from "../../lib/loading-gate";
import { fade, springs } from "../../lib/motion";
import { useNav, useShell } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import { describeError } from "../../state/errors";
import { useLauncherActions, useLauncherSelector, useNow } from "../../state/launcher";
import { useGameDirectories, type GameDirectoryDto } from "../../state/queries/catalog";
import { busyInstanceId, gameDirectoryBusy } from "../../state/selectors";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { EmptyState } from "../../ui/EmptyState";
import { EntranceBlock, Page } from "../../ui/Page";
import { PageHeader } from "../../ui/PageHeader";
import { SearchInput } from "../../ui/SearchInput";
import { SegmentedControl, type SegmentOption } from "../../ui/SegmentedControl";
import { Select } from "../../ui/Select";
import { Skeleton } from "../../ui/Skeleton";
import { switchSuggestion } from "../shared/switch-suggestion";
import { useSwitchDirectory } from "../shared/useSwitchDirectory";
import { LIBRARY_COPY } from "./copy";
import { CARD_COVER_HEIGHT, InstanceCard } from "./InstanceCard";
import styles from "./library.module.css";
import {
  brokenInstances,
  directoryOptions,
  FILTER_LOADERS,
  isFiltered,
  loaderCounts,
  normalizedQuery,
  orderSignature,
  SORT_KEYS,
  totalPlaytime,
  visibleInstances,
  type LoaderFilter,
  type SortKey,
} from "./model";
import { useLibraryView } from "./view-state";

/** 加载中的骨架卡数：按档位铺满首屏两行。 */
const SKELETON_CARDS = { compact: 6, regular: 8, wide: 10 } as const;

/** 一次变化涉及的布局动画元素上限：再多测量本身就会掉帧，改为直接重排。 */
const LAYOUT_ANIMATION_LIMIT = 40;

const SEARCH_SHORTCUT = ["Ctrl", "F"] as const;

const NO_DIRECTORIES: readonly GameDirectoryDto[] = [];

const cellMotion: Variants = {
  hidden: { opacity: 0, scale: 0.98 },
  show: { opacity: 1, scale: 1, transition: { ...springs.settle, opacity: fade.in } },
  leave: { opacity: 0, scale: 0.98, transition: fade.out },
};

const cellFade: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: fade.in },
  leave: { opacity: 0, transition: fade.out },
};

export default function LibraryPage() {
  // 只订阅实例列表、它的读取状态与固定个数：下载进度与游戏日志不让整页与每张卡跟着重渲染
  const all = useLauncherSelector((s) => s.instances);
  const slice = useLauncherSelector((s) => s.status.instances);
  const pinCount = useLauncherSelector((s) => s.sidebarPins.length);
  const sessionInstance = useLauncherSelector(busyInstanceId);
  const directoryBusy = useLauncherSelector(gameDirectoryBusy);
  const actions = useLauncherActions();
  const { go } = useNav();
  const { tier, openCreateInstance, registerFind } = useShell();
  const run = useRunner();
  const now = useNow(30_000);
  const titleId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const [view, setView] = useLibraryView();
  const dirs = useGameDirectories();
  const switchTo = useSwitchDirectory();

  // 目录列表是缓存的，盘上的版本却可能被别的启动器改过：回到这一页时后台重读一次
  const refreshDirs = dirs.refresh;
  useEffect(() => refreshDirs(), [refreshDirs]);

  useEffect(
    () =>
      registerFind(() => {
        const input = searchRef.current;
        if (input === null) throw new Error("实例库的搜索框尚未挂载");
        input.focus();
        input.select();
      }),
    [registerFind],
  );

  const ready = slice.kind === "ready";
  // 目录列表读不出时这里只是少一个切换入口，错误由设置页的游戏目录卡片原位呈现
  const knownDirs = dirs.data === undefined ? NO_DIRECTORIES : dirs.data;
  const suggestion = switchSuggestion(knownDirs);
  // 空状态的说法取决于目录列表：等它回来再定，不先闪一下「实例库还是空的」
  const awaitingDirs = ready && all.length === 0 && dirs.status === "loading";
  // 300 ms 内读到就不出骨架；骨架一旦出现至少停留一段，数据早到也等满再换成卡片
  const gate = useLoadingGate(slice.kind === "loading" || awaitingDirs);
  const counts = useMemo(() => loaderCounts(all), [all]);
  const shown = useMemo(() => visibleInstances(all, view), [all, view]);
  const broken = useMemo(() => brokenInstances(all), [all]);
  const filtered = isFiltered(view);

  const filterOptions: SegmentOption<LoaderFilter>[] = [
    { value: "all", label: LIBRARY_COPY.filterAll, count: ready ? all.length : undefined },
    ...FILTER_LOADERS.map((loader) => ({ value: loader, label: LOADER_NAME[loader], dot: loader, count: ready ? counts[loader] : undefined })),
  ];
  const sortOptions = SORT_KEYS.map((key) => ({ value: key, label: LIBRARY_COPY.sort[key] }));

  // 被基底占用、备份或改动占着的这轮不排：补全排上也只会被 instance_busy 拒绝，留下一个失败的任务
  const repairReason = (inst: InstanceSummary) => lockReason(locksOf(inst, inst.id === sessionInstance).repair, "repair");
  const repairable = broken.filter((inst) => repairReason(inst) === undefined);
  const repairAll = () => {
    for (const inst of repairable) void run(() => actions.repairInstance(inst.id), ACTION_ERROR.repair);
  };

  const clearFilter = () => setView({ loader: "all", query: "" });
  const switchDirectory = (dir: GameDirectoryDto) => void switchTo(dir.path, dir.name);

  const subtitle =
    gate.view === "skeleton" ? (
      <Skeleton shape="text" width={260} />
    ) : !ready ? null : all.length === 0 ? (
      LIBRARY_COPY.subtitleEmpty
    ) : (
      LIBRARY_COPY.subtitle(all.length, pinCount, totalPlaytime(all))
    );

  return (
    <Page aria-labelledby={titleId}>
      <PageHeader
        titleId={titleId}
        title={LIBRARY_COPY.title}
        subtitle={subtitle}
        actions={
          <>
            <Button variant="ghost" icon="compass" onClick={() => go({ page: "discover", kind: "modpack" })}>
              {LIBRARY_COPY.importModpack}
            </Button>
            <Button variant="primary" icon="plus" onClick={() => openCreateInstance()}>
              {LIBRARY_COPY.create}
            </Button>
          </>
        }
      />

      <EntranceBlock className={styles.toolbar}>
        <SegmentedControl value={view.loader} onChange={(loader) => setView({ loader })} options={filterOptions} size="sm" ariaLabel={LIBRARY_COPY.filterLabel} />
        <div className={styles.tools}>
          <SearchInput
            ref={searchRef}
            value={view.query}
            onChange={(query) => setView({ query })}
            placeholder={LIBRARY_COPY.searchPlaceholder}
            aria-label={LIBRARY_COPY.searchPlaceholder}
            shortcut={SEARCH_SHORTCUT}
            size="sm"
            className={styles.search}
          />
          {knownDirs.length > 1 && <DirectorySelect dirs={knownDirs} busy={directoryBusy} instanceCount={ready ? all.length : null} onPick={switchDirectory} />}
          <Select<SortKey> value={view.sort} onChange={(sort) => setView({ sort })} options={sortOptions} size="sm" ariaLabel={LIBRARY_COPY.sortLabel} className={styles.sort} />
        </div>
      </EntranceBlock>

      {broken.length > 0 && (
        <Banner
          tone="warn"
          icon="wrench"
          title={LIBRARY_COPY.repairTitle(broken.length)}
          actions={
            <Button size="sm" disabledReason={repairable.length === 0 ? repairReason(broken[0]) : undefined} onClick={repairAll}>
              {broken.length > 1 ? LIBRARY_COPY.repairAll : LIBRARY_COPY.repairOne}
            </Button>
          }
        >
          {LIBRARY_COPY.repairBody(broken.map((inst) => inst.name))}
        </Banner>
      )}

      {gate.view !== "content" || slice.kind === "loading" ? (
        <>
          <EntranceBlock className={styles.grid} aria-busy="true" aria-label={LIBRARY_COPY.loadingLabel}>
            {gate.view === "skeleton" && Array.from({ length: SKELETON_CARDS[tier] }, (_, i) => <SkeletonCard key={i} />)}
          </EntranceBlock>
          {gate.slow && <p className={styles.slowHint}>{SLOW_LOADING_HINT}</p>}
        </>
      ) : slice.kind === "error" ? (
        <EntranceBlock>
          <EmptyState
            scene="error"
            titleAs="h2"
            title={LIBRARY_COPY.loadErrorTitle}
            body={describeError(slice.error)}
            action={
              <div className={styles.actions}>
                <Button onClick={() => void run(() => actions.reload("instances"), ACTION_ERROR.refreshInstances)}>{LIBRARY_COPY.retry}</Button>
                <Button variant="ghost" icon="folder" onClick={() => void run(() => actions.openFolder("game_dir"), ACTION_ERROR.openFolder)}>
                  {LIBRARY_COPY.openGameDir}
                </Button>
              </div>
            }
          />
        </EntranceBlock>
      ) : all.length === 0 ? (
        <EntranceBlock>
          <EmptyState
            scene="sapling"
            titleAs="h2"
            title={suggestion === null ? LIBRARY_COPY.emptyTitle : GAME_DIR_SWITCH_COPY.emptyTitle}
            body={suggestion === null ? LIBRARY_COPY.emptyBody : GAME_DIR_SWITCH_COPY.emptyBody(suggestion.dir.name, suggestion.versions)}
            action={
              <div className={styles.actions}>
                {suggestion !== null && (
                  <Button variant="primary" icon="folder-open" disabledReason={gameDirSwitchReason(directoryBusy, suggestion.dir.available)} onClick={() => switchDirectory(suggestion.dir)}>
                    {GAME_DIR_SWITCH_COPY.emptyAction(suggestion.dir.name)}
                  </Button>
                )}
                <Button icon="compass" onClick={() => go({ page: "discover", kind: "modpack" })}>
                  {LIBRARY_COPY.emptyAction}
                </Button>
              </div>
            }
          />
        </EntranceBlock>
      ) : shown.length === 0 ? (
        <EntranceBlock>
          <EmptyState
            scene="telescope"
            titleAs="h2"
            title={LIBRARY_COPY.noMatchTitle}
            body={noMatchBody(view.query, view.loader)}
            action={
              <Button icon="x" onClick={clearFilter}>
                {LIBRARY_COPY.clearFilter}
              </Button>
            }
          />
        </EntranceBlock>
      ) : (
        <InstanceGrid shown={shown} now={now} showCreate={!filtered} onCreate={() => openCreateInstance()} />
      )}
    </Page>
  );
}

/** 选中别的目录时走切换流程，确认并切换成功之前这里仍显示原目录。 */
function DirectorySelect({ dirs, busy, instanceCount, onPick }: { dirs: readonly GameDirectoryDto[]; busy: boolean; instanceCount: number | null; onPick: (dir: GameDirectoryDto) => void }) {
  const current = dirs.find((d) => d.is_current);
  if (current === undefined) throw new Error("游戏目录列表里没有当前目录");
  const pick = (path: string) => {
    const dir = dirs.find((d) => d.path === path);
    if (dir === undefined) throw new Error(`目录 ${path} 不在游戏目录列表里`);
    onPick(dir);
  };
  return (
    <Select<string>
      value={current.path}
      onChange={pick}
      options={directoryOptions(dirs, busy, instanceCount)}
      size="sm"
      ariaLabel={LIBRARY_COPY.directoryLabel}
      className={styles.directory}
    />
  );
}

function noMatchBody(query: string, loader: LoaderFilter): string {
  const q = query.trim();
  if (normalizedQuery(q) !== "") return LIBRARY_COPY.noMatchQuery(q, loader === "all" ? null : loader);
  if (loader === "all") throw new Error("没有筛选也没有搜索时不会出现「没有符合条件的实例」");
  return LIBRARY_COPY.noMatchLoader(loader);
}

function InstanceGrid({ shown, now, showCreate, onCreate }: { shown: readonly InstanceSummary[]; now: number; showCreate: boolean; onCreate: () => void }) {
  const reduced = useReducedMotionConfig() === true;
  const animateLayout = !reduced && shown.length <= LAYOUT_ANIMATION_LIMIT;
  const signature = `${orderSignature(shown)}\n${showCreate ? "+" : ""}`;
  const variants = reduced ? cellFade : cellMotion;
  return (
    <EntranceBlock as="section" className={styles.grid} aria-label={LIBRARY_COPY.gridLabel}>
      <AnimatePresence mode="popLayout" initial={false}>
        {shown.map((inst) => (
          <motion.div
            key={inst.id}
            className={styles.cell}
            layout={animateLayout}
            layoutDependency={signature}
            transition={{ layout: springs.settle }}
            variants={variants}
            initial="hidden"
            animate="show"
            exit="leave"
          >
            <InstanceCard inst={inst} now={now} />
          </motion.div>
        ))}
        {showCreate && (
          <motion.div
            key="create"
            className={styles.cell}
            layout={animateLayout}
            layoutDependency={signature}
            transition={{ layout: springs.settle }}
            variants={variants}
            initial="hidden"
            animate="show"
            exit="leave"
          >
            <button type="button" className={styles.createTile} onClick={onCreate}>
              <span className={styles.createIcon}>
                <Icon name="plus" size={24} />
              </span>
              <span className={styles.createTitle}>{LIBRARY_COPY.createTileTitle}</span>
              <span className={styles.createBody}>{LIBRARY_COPY.createTileBody}</span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </EntranceBlock>
  );
}

function SkeletonCard() {
  return (
    <Card padding="none" clip className={styles.card}>
      <Skeleton shape="block" width="100%" height={CARD_COVER_HEIGHT} radius="xs" />
      <div className={styles.body}>
        <Skeleton shape="square" size={44} className={styles.avatar} />
        <Skeleton shape="text" lines={3} />
      </div>
      <div className={styles.foot} />
    </Card>
  );
}
