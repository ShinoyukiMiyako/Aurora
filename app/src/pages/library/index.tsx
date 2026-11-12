// 实例库：全部实例的卡片网格。页头说总数、固定数与累计时长；工具条按加载器筛选、按名称搜索、三种排序，
// 登记了不止一个游戏目录时还能切目录；有损坏实例时页头下出现修复横幅；网格末尾是新建卡（筛选或搜索时不出现）。
// 当前目录没有实例、别的目录里有版本时，空状态直接给切过去的入口。
// 卡片增删、换序、变高时其余卡片滑到新位置；一次进出或换位的卡片太多时整片淡入一次（判据见 model 的 crowdedChange），
// 减少动画时直接重排。

import { AnimatePresence, motion, useAnimate, useReducedMotionConfig, type Variants } from "framer-motion";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef } from "react";
import { Icon } from "../../art/Icon";
import { ACTION_ERROR, GAME_DIR_SWITCH_COPY, gameDirSwitchReason, LOADER_NAME, lockReason, SLOW_LOADING_HINT } from "../../copy/flows";
import type { InstanceSummary } from "../../domain/adapt";
import { locksOf } from "../../domain/instance-locks";
import { useMounted } from "../../lib/useMounted";
import { useLoadingGate, type LoadingView } from "../../lib/loading-gate";
import { fade, springs } from "../../lib/motion";
import { observeReflow, REFLOW_PAUSED_ATTR } from "../../lib/reflow";
import { useNav, useShell } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import { describeError } from "../../state/errors";
import { useLauncherActions, useLauncherSelector, useNow } from "../../state/launcher";
import { useGameDirectories, type GameDirectoryDto } from "../../state/queries/catalog";
import { busyInstanceId, gameDirectoryBusy } from "../../state/selectors";
import { Appear } from "../../ui/Appear";
import { Banner, BannerSlot } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { EmptyState } from "../../ui/EmptyState";
import { Loadable } from "../../ui/Loadable";
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
  CREATE_CELL_KEY,
  crowdedChange,
  directoryOptions,
  FILTER_LOADERS,
  isFiltered,
  loaderCounts,
  normalizedQuery,
  SORT_KEYS,
  totalPlaytime,
  visibleInstances,
  type GridShape,
  type LoaderFilter,
  type SortKey,
} from "./model";
import { useLibraryView } from "./view-state";

/** 加载中的骨架卡数：按档位铺满首屏两行。 */
const SKELETON_CARDS = { compact: 6, regular: 8, wide: 10 } as const;

const SEARCH_SHORTCUT = ["Ctrl", "F"] as const;

const NO_DIRECTORIES: readonly GameDirectoryDto[] = [];

/** 格子的退场按 AnimatePresence 的 custom 取：一次涉及太多格子（crowded）时直接撤下，由整片淡入代替逐个淡出。 */
const cellMotion: Variants = {
  hidden: { opacity: 0, scale: 0.98 },
  show: { opacity: 1, scale: 1, transition: { ...springs.settle, opacity: fade.in } },
  leave: (crowded: boolean) => (crowded ? { opacity: 0, transition: fade.none } : { opacity: 0, scale: 0.98, transition: fade.out }),
};

const cellFade: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: fade.in },
  leave: (crowded: boolean) => ({ opacity: 0, transition: crowded ? fade.none : fade.out }),
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
  const mounted = useMounted();

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

  // 计数没到时先占住计数槽（null）：读完那一帧六项不会一起变宽，工具条也不会因此折行
  const filterOptions: SegmentOption<LoaderFilter>[] = [
    { value: "all", label: LIBRARY_COPY.filterAll, count: ready ? all.length : null },
    ...FILTER_LOADERS.map((loader) => ({ value: loader, label: LOADER_NAME[loader], dot: loader, count: ready ? counts[loader] : null })),
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

  const pickDirectory = knownDirs.length > 1;
  const toolSlide = { layout: "position", layoutDependency: pickDirectory, transition: { layout: springs.settle } } as const;

  // 与网格同一个加载门：网格还在等的时候这里也不先给结论（目录列表没回来时不先说「还没有实例」）
  const subtitle =
    gate.view !== "content" || !ready ? null : all.length === 0 ? LIBRARY_COPY.subtitleEmpty : LIBRARY_COPY.subtitle(all.length, pinCount, totalPlaytime(all));

  return (
    <Page aria-labelledby={titleId}>
      <PageHeader
        titleId={titleId}
        title={LIBRARY_COPY.title}
        subtitle={<SubtitleSwap view={gate.view} text={subtitle} />}
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
        {/*
         * 目录列表由外壳预取，多数时候第一帧就在；预取还没回来就进了页面、或缓存被失效后重读时，目录选择晚一个往返才插进来。
         * 工具组按带目录选择的宽度占位（样式表的 .tools），插进来、撤掉都不改变工具条折不折行，下面的横幅与网格不动。
         * 三样都是布局动画节点，依赖取「有没有目录选择」：插进来、撤掉时搜索框在组内从原位置滑到新位置。
         * 窗口缩放引起的折行不改依赖，照常直接重排
         */}
        <div className={styles.tools}>
          <motion.div {...toolSlide}>
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
          </motion.div>
          {/* 撤掉时按右缘定位：组内靠右排，与排布同一个基准，退场项留在原处淡出，不叠到排序上 */}
          <AnimatePresence mode="popLayout" anchorX="right">
            {pickDirectory && (
              <motion.div key="directory" {...toolSlide} initial={mounted.current ? { opacity: 0 } : false} animate={{ opacity: 1, transition: fade.in }} exit={{ opacity: 0, transition: fade.out }}>
                <DirectorySelect dirs={knownDirs} busy={directoryBusy} instanceCount={ready ? all.length : null} onPick={switchDirectory} />
              </motion.div>
            )}
          </AnimatePresence>
          <motion.div {...toolSlide}>
            <Select<SortKey> value={view.sort} onChange={(sort) => setView({ sort })} options={sortOptions} size="sm" ariaLabel={LIBRARY_COPY.sortLabel} className={styles.sort} />
          </motion.div>
        </div>
      </EntranceBlock>

      {/* 横幅跟着内容一起出现：骨架还在停留时就插进来，会先把骨架推下去、骨架再换成卡片，连跳两次 */}
      <BannerSlot>
        {gate.view === "content" && broken.length > 0 && (
          <Banner
            key="repair"
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
      </BannerSlot>

      {/* 骨架与内容共用这一个一级区块：页面入场只播一次，换成内容时在块里交叉淡化，不再整块重挂、重播入场 */}
      <EntranceBlock>
        {/* 骨架层整层对读屏隐藏：加载说明放在它外面，常驻的状态区在骨架显出来时播报一次 */}
        <p className={styles.srOnly} role="status">
          {gate.view === "skeleton" ? LIBRARY_COPY.loadingLabel : ""}
        </p>
        <Loadable view={gate.view} skeleton={<SkeletonGrid count={SKELETON_CARDS[tier]} />}>
          {() => (
            // 读取失败、空库与有实例三种内容互换（重试成功、建好第一个实例、删掉最后一个）时交叉淡化，不硬切
            <Appear>
              {slice.kind === "error" ? (
                <EmptyState
                  key="error"
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
              ) : all.length === 0 ? (
                <EmptyState
                  key="empty"
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
              ) : (
                // 网格常驻：筛到没有结果时卡片照常播退场，无结果说明在原处淡入；清除筛选时反过来
                <div key="matches" className={styles.matches}>
                  <InstanceGrid shown={shown} now={now} showCreate={!filtered} onCreate={() => openCreateInstance()} />
                  <Appear>
                    {shown.length === 0 && (
                      <EmptyState
                        key="no-match"
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
                    )}
                  </Appear>
                </div>
              )}
            </Appear>
          )}
        </Loadable>
      </EntranceBlock>
      <Appear>
        {gate.slow && (
          <p key="slow" className={styles.slowHint}>
            {SLOW_LOADING_HINT}
          </p>
        )}
      </Appear>
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

/**
 * 卡片网格。卡片增删、换序（筛选、搜索、排序），或某张卡变高变矮（转损坏、修好、统计换字）时，其余卡片由兄弟让位
 * 从原位置滑过去。不用 framer-motion 的 layout：它只在格子自己重渲染时取快照，卡片内部变高时兄弟拿不到快照；
 * 它还会把格子的尺寸变化也补间成缩放，换到行高不同的行时卡片被纵向拉扁。
 * 一次进出或换位的格子太多（crowdedChange）时整片换上：新来的直接放上、走掉的直接撤下，网格整片淡入一次，
 * 这一次提交里让位暂停，免得整片淡入的同时可见的格子还在滑。
 */
function InstanceGrid({ shown, now, showCreate, onCreate }: { shown: readonly InstanceSummary[]; now: number; showCreate: boolean; onCreate: () => void }) {
  const reduced = useReducedMotionConfig() === true;
  const variants = reduced ? cellFade : cellMotion;
  // 挂载时就在的格子跟着所在区块出现，不逐个入场。不用 AnimatePresence 的 initial={false}：
  // 它会让这些格子里之后才挂载的元素（底栏换面、当前标签）也永远跳过入场
  const mounted = useMounted();
  const shape: GridShape = { ids: shown.map((inst) => inst.id), create: showCreate };
  const committed = useRef(shape);
  const crowded = mounted.current && crowdedChange(committed.current, shape);
  const gridRef = useRef<HTMLElement | null>(null);
  const [, animateGrid] = useAnimate();
  useLayoutEffect(() => {
    committed.current = shape;
    const grid = gridRef.current;
    if (!crowded || grid === null) return;
    // 让位暂停只开这一次提交：让位在提交之后的微任务里收下这批变化（位置照记、不起动画、正在滑的直接落位），
    // 紧接着的微任务里关掉，下一次变化照常滑；开关的增删本身不起动画。不交给 React 渲染这个属性：
    // 那样要等下一次渲染才去掉，下一次变化恰好和它同一次提交时也会被当成暂停
    grid.setAttribute(REFLOW_PAUSED_ATTR, "");
    queueMicrotask(() => grid.removeAttribute(REFLOW_PAUSED_ATTR));
    // 提交时先压到 0：首帧就看不到整批格子一闪
    grid.style.opacity = "0";
    void animateGrid(grid, { opacity: [0, 1] }, fade.in);
  });
  // 回调必须稳定：每次渲染换一个会拆掉重建观察，丢掉旧位置
  const attach = useCallback((el: HTMLElement | null) => {
    gridRef.current = el;
    if (el === null) return;
    const stop = observeReflow(el);
    return () => {
      gridRef.current = null;
      stop();
    };
  }, []);
  const enter = mounted.current && !crowded ? "hidden" : false;
  return (
    <section ref={attach} className={styles.grid} aria-label={LIBRARY_COPY.gridLabel}>
      <AnimatePresence mode="popLayout" custom={crowded}>
        {shown.map((inst) => (
          <motion.div key={inst.id} className={styles.cell} variants={variants} initial={enter} animate="show" exit="leave">
            <InstanceCard inst={inst} now={now} />
          </motion.div>
        ))}
        {showCreate && (
          <motion.div key={CREATE_CELL_KEY} className={styles.cell} variants={variants} initial={enter} animate="show" exit="leave">
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
    </section>
  );
}

/**
 * 页头副标题：骨架条与文字叠在同一格里交叉淡化，与下面网格的加载态同一个门、同一手感。副标题在 <p> 里，
 * Loadable 的 div 放不进去，这里用 span 照它画：等待期这一行空着（行高由页头常驻），骨架显出来时骨架条淡入；
 * 读到时文字淡入，显出来过的骨架条叠在下面淡出。挂载时就有的文字跟着页面入场，不另外淡入。
 */
function SubtitleSwap({ view, text }: { view: LoadingView; text: string | null }) {
  const mounted = useMounted();
  return (
    <span className={styles.subtitleSwap}>
      <AnimatePresence>
        {view === "skeleton" && (
          <motion.span key="skeleton" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: fade.in }} exit={{ opacity: 0, transition: fade.out }}>
            <Skeleton shape="text" width={260} />
          </motion.span>
        )}
        {text !== null && (
          <motion.span key="text" initial={mounted.current ? { opacity: 0 } : false} animate={{ opacity: 1, transition: fade.in }} exit={{ opacity: 0, transition: fade.out }}>
            {text}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

function SkeletonGrid({ count }: { count: number }) {
  return (
    <div className={styles.grid}>
      {Array.from({ length: count }, (_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}

/**
 * 骨架卡照真实卡片的结构排：名称、介绍、统计三行各放进真实那一行的类里，取到同样的行高与间距，
 * 换成卡片时卡高一像素不差（三行都按正文行高画时每张矮 4px，第二行起逐行累积）。
 */
function SkeletonCard() {
  return (
    <Card padding="none" clip className={styles.card}>
      <Skeleton shape="block" width="100%" height={CARD_COVER_HEIGHT} radius="xs" />
      <div className={styles.body}>
        <Skeleton shape="square" size={44} className={styles.avatar} />
        <div className={styles.name}>
          <Skeleton shape="text" width="60%" />
        </div>
        <div className={styles.meta}>
          <Skeleton shape="text" width="80%" />
        </div>
        <div className={styles.stats}>
          <Skeleton shape="text" width="70%" />
        </div>
      </div>
      <div className={styles.foot} />
    </Card>
  );
}
