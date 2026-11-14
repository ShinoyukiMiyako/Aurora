// 发现页：跨 Modrinth / CurseForge 搜资源，点开详情装进实例；整合包装成新实例，本地整合包文件从头图右上角导入。
// 页面持有界面上的筛选与分页累积；搜索结果、详情、版本、落位矩阵都是状态层的按需查询。

import { motion } from "framer-motion";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { LOADER_NAME, SLOW_LOADING_HINT } from "../../copy/flows";
import type { InstanceSummary } from "../../domain/adapt";
import { PLATFORM_TIMEOUT_MS, SEARCH_DEBOUNCE_MS, SLOW_HINT_MS } from "../../domain/limits";
import { useLoadingGate, type LoadingView } from "../../lib/loading-gate";
import { fade, type PanelFrom } from "../../lib/motion";
import { useReflow } from "../../lib/reflow";
import { useNav, useShell } from "../../shell/shell";
import { useLauncherSelector, useNow } from "../../state/launcher";
import { useInstalledSources, type SearchEntry } from "../../state/queries/discover";
import { invalidate } from "../../state/resource";
import type { DiscoverKind, PageProps } from "../../state/route";
import { Appear } from "../../ui/Appear";
import { Banner, BannerSlot } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { EmptyState } from "../../ui/EmptyState";
import { LabelSlot } from "../../ui/LabelSlot";
import { Loadable } from "../../ui/Loadable";
import { EntranceBlock, numberEntrance, Page, useEntranceIndex } from "../../ui/Page";
import { TabPanel } from "../../ui/Tabs";
import { Spinner } from "../../art/Spinner";
import { tabStep } from "../instance/model";
import { PLATFORM_LABEL, SEARCH_COPY } from "./copy";
import { ResourceDetail, type DetailTarget } from "./detail/ResourceDetail";
import styles from "./discover.module.css";
import { useOnline } from "../../state/online";
import { revealTop, useDebounced, useNearBottom, useScrollContainer, useStuck } from "./hooks";
import { ImportModpackDialog, type ImportRequest } from "./ImportModpackDialog";
import {
  allPlatformsFailed,
  clearFilters,
  conditionParts,
  curseForgeSkipNote,
  DEFAULT_FILTERS,
  DISCOVER_KINDS,
  fitCandidates,
  hasConditions,
  hitKey,
  installedBySource,
  installedCount,
  instancesFromPack,
  partialFailure,
  PREFETCH_MARGIN_PX,
  projectOrigins,
  routeFilters,
  routeOfFilters,
  routeSignature,
  searchArgsOf,
  withFitInstance,
  withKind,
  type DiscoverFilters,
} from "./model";
import { ResultCard, SkeletonGrid } from "./ResultCard";
import { readSnapshot, writeSnapshot } from "./session";
import { SearchHero, Toolbar } from "./Toolbar";
import { useResultPages, type ResultPages } from "./useResultPages";

export default function DiscoverPage({ route }: PageProps<"discover">) {
  // 只订阅实例列表与它是否读到：装 Mod 期间下载进度每 100 ms 一次，整份订阅会让全部结果卡跟着重渲染
  const instances = useLauncherSelector((s) => s.instances);
  const instancesReady = useLauncherSelector((s) => s.status.instances.kind === "ready");
  const nav = useNav();
  const shell = useShell();
  const titleId = useId();
  const tabsId = useId();
  const online = useOnline();
  const now = useNow(60000);

  const [restored] = useState(readSnapshot);
  const [filters, setFilters] = useState<DiscoverFilters>(() => routeFilters(restored === null ? DEFAULT_FILTERS : restored.filters, route, instances));
  const [detail, setDetail] = useState<DetailTarget | null>(() => (route.open === undefined ? null : { ...route.open, sources: [], listedType: null }));
  // 外壳把拖进窗口的整合包经路由带进来：进页即打开导入弹窗读取它
  const [importing, setImporting] = useState<ImportRequest | null>(() => (route.importFile === undefined ? null : { file: route.importFile }));
  const debounced = useDebounced(filters.query, SEARCH_DEBOUNCE_MS);
  const committedQuery = debounced.value;

  // 已在本页时外部导航又带来新参数（命令面板搜索、实例页「找 Mod」）：叠到当前筛选上
  const [appliedRoute, setAppliedRoute] = useState(() => routeSignature(route));
  const signature = routeSignature(route);
  if (signature !== appliedRoute) {
    setAppliedRoute(signature);
    const next = routeFilters(filters, route, instances);
    setFilters(next);
    debounced.flush(next.query);
    if (route.open !== undefined) setDetail({ ...route.open, sources: [], listedType: null });
    if (route.importFile !== undefined) setImporting({ file: route.importFile });
  }

  // 适配实例被删掉或变得不可用（开始重装、损坏）时回到不限
  const candidates = fitCandidates(instances);
  if (filters.fitInstance !== null && instancesReady && !candidates.some((i) => i.id === filters.fitInstance)) {
    setFilters(withFitInstance(filters, null));
  }

  // 生效的关键词与类型写回路由：命令面板与历史项都能看到当前搜的是什么。
  // 进页带来的适配实例、详情与导入文件在这一步从路由里去掉：它们只在进页那一刻生效，后退、前进不再重放
  const kind = filters.kind;
  useEffect(() => {
    const writeBack = routeOfFilters(kind, committedQuery);
    const next = routeSignature(writeBack);
    if (next === appliedRoute) return;
    setAppliedRoute(next);
    nav.replace(writeBack);
  }, [appliedRoute, committedQuery, kind, nav]);

  const pages = useResultPages(searchArgsOf(filters, committedQuery), restored === null ? null : restored.pages);

  // 离开时把筛选与已翻到的页留给下次进来
  const latest = useRef({ filters, pages: pages.state });
  useEffect(() => {
    latest.current = { filters, pages: pages.state };
  });
  useEffect(() => () => writeSnapshot(latest.current), []);

  // 恢复联网：正在看的搜索结果立即重取（重取期间保留旧结果），失败的那一页随之重试
  const wasOffline = useRef(!online);
  useEffect(() => {
    if (online && wasOffline.current) invalidate("search");
    wasOffline.current = !online;
  }, [online]);

  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(
    () =>
      shell.registerFind(() => {
        const input = inputRef.current;
        if (input === null) throw new Error("发现页的搜索框尚未挂载");
        input.focus();
        input.select();
      }),
    [shell],
  );

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const container = useScrollContainer(sentinelRef);
  const stuck = useStuck(sentinelRef, container);
  const revealResults = (scroller: HTMLElement | null) => {
    const sentinel = sentinelRef.current;
    if (sentinel === null || scroller === null) throw new Error("发现页的结果区或滚动容器尚未挂载");
    revealTop(sentinel, scroller);
  };

  // 换了一组搜索条件（筛选、排序、关键词、外部带来的参数）：已经往下滚过结果区顶边时滚回去，新结果从头看起。
  // 在布局之后、绘制之前滚：换上来的占位与滚回去的位置在同一帧画出。
  // 进页那一次提交只记下条件、不滚：后退回来时外壳正要把滚动位置还原到上次看到的地方
  const searched = useRef<string | null>(null);
  const baseKey = pages.state.baseKey;
  useLayoutEffect(() => {
    if (searched.current === baseKey) return;
    const mounting = searched.current === null;
    searched.current = baseKey;
    if (!mounting) revealResults(container);
  });

  // 换类型时新面板从所选标签那一侧滑进来，和标签指示块的方向一致
  const [shownKind, setShownKind] = useState(filters.kind);
  const [panelFrom, setPanelFrom] = useState<PanelFrom | undefined>(undefined);
  if (filters.kind !== shownKind) {
    setShownKind(filters.kind);
    setPanelFrom({ axis: "x", dir: tabStep(DISCOVER_KINDS, shownKind, filters.kind) });
  }

  const setKind = (next: DiscoverKind) => {
    // 先滚再提交：标签指示块的布局动画在提交时取快照，前后两次都量在滚回之后的位置上，不按滚动差纵向飞一段
    revealResults(container);
    setFilters(withKind(filters, next));
  };
  const setFit = (id: string | null) => {
    if (id === null) {
      setFilters(withFitInstance(filters, null));
      return;
    }
    const fit = candidates.find((i) => i.id === id);
    if (fit === undefined) throw new Error(`实例 ${id} 不能作为适配实例`);
    setFilters(withFitInstance(filters, fit));
  };
  const setQuery = (query: string) => {
    setFilters({ ...filters, query });
    // 清空即刻生效，不必等防抖
    if (query === "") debounced.flush("");
  };
  // 引用稳定：结果卡包着 memo，页面因输入、筛选或详情开合重渲染时几百张卡不跟着重渲染
  const open = useCallback((entry: SearchEntry) => setDetail({ platform: entry.platform, projectId: entry.project_id, sources: entry.sources, listedType: entry.resource_type }), []);

  // 「已装入 n 个实例」只对 Mod 有意义：结果里确实有 Mod 时才读，全部实例的已装来源一条命令取齐
  const readyIds = useMemo(() => instances.filter((i) => i.status === "ready" && !i.placeholder).map((i) => i.id), [instances]);
  const sources = useInstalledSources(pages.hits.some((e) => e.resource_type === "mod") ? readyIds : null);
  const installed = useMemo(() => installedBySource(sources.data, readyIds), [sources.data, readyIds]);
  // 读不出的实例按没装处理，与实例列表照常显示它一致；原因留在控制台，不打断找资源
  const sourcesError = sources.error;
  useEffect(() => {
    if (sourcesError !== null) console.warn("全部实例的已装 Mod 来源读不出来，发现页的「已装入」暂不计数", sourcesError);
  }, [sourcesError]);
  const sourceRows = sources.data;
  useEffect(() => {
    if (sourceRows === undefined) return;
    for (const row of sourceRows) if (row.status === "error") console.warn(`「${row.version_id}」的已装 Mod 来源读不出来，发现页的「已装入」不计这个实例`, row.error);
  }, [sourceRows]);

  return (
    <>
      <Page aria-labelledby={titleId}>
        {/* 常驻槽位：断网时横幅淡入、恢复时淡出，头图与结果区由页面的让位滑开、滑回 */}
        <BannerSlot>
          {!online && (
            <Banner tone="warn" icon="cloud-off" title={SEARCH_COPY.offlineBanner} announce>
              {SEARCH_COPY.offlineBannerBody}
            </Banner>
          )}
        </BannerSlot>
        <SearchHero
          titleId={titleId}
          filters={filters}
          onFilters={setFilters}
          onQuery={setQuery}
          onSubmit={() => debounced.flush(filters.query)}
          onImport={() => setImporting({ file: null })}
          inputRef={inputRef}
        />
        <ResultsSection
          sentinelRef={sentinelRef}
          toolbar={
            <EntranceBlock key="toolbar" className={styles.toolbarWrap} data-stuck={stuck || undefined}>
              <Toolbar tabsId={tabsId} filters={filters} onKind={setKind} onFit={setFit} onFilters={setFilters} fitCandidates={candidates} />
            </EntranceBlock>
          }
          panel={
            <TabPanel key="panel" tabsId={tabsId} value={filters.kind} from={panelFrom} className={styles.panel}>
              <Results
                filters={filters}
                committedQuery={committedQuery}
                pages={pages}
                online={online}
                now={now}
                instances={instances}
                installed={installed}
                container={container}
                onOpen={open}
                onClearFilters={() => setFilters(clearFilters(filters))}
              />
            </TabPanel>
          }
        />
      </Page>
      <ResourceDetail target={detail} onClose={() => setDetail(null)} fitInstance={filters.fitInstance} online={online} />
      <ImportModpackDialog request={importing} onClose={() => setImporting(null)} online={online} />
    </>
  );
}

interface ResultsSectionProps {
  sentinelRef: Ref<HTMLDivElement>;
  toolbar: ReactNode;
  panel: ReactNode;
}

/**
 * 结果区：吸顶工具条与结果面板各算页面的一个一级区块，接在头图后面依次入场。
 * 面板不嵌在另一个正在入场的区块里：进页时整块只上移淡入一次，之后换类型才播面板自己的切换。
 */
function ResultsSection({ sentinelRef, toolbar, panel }: ResultsSectionProps) {
  const index = useEntranceIndex();
  return (
    <section className={styles.results} aria-label={SEARCH_COPY.label}>
      <div ref={sentinelRef} className={styles.stickSentinel} aria-hidden="true" />
      {numberEntrance([toolbar, panel], index)}
    </section>
  );
}

/** 首页超时在「比平时慢」之后再等多久：两者同属加载门的一轮，超时 = 这一轮开始后 PLATFORM_TIMEOUT_MS。 */
const TIMEOUT_AFTER_SLOW_MS = PLATFORM_TIMEOUT_MS - SLOW_HINT_MS;
if (TIMEOUT_AFTER_SLOW_MS <= 0) throw new Error(`首页超时（${PLATFORM_TIMEOUT_MS} ms）必须晚于慢提示（${SLOW_HINT_MS} ms）`);

interface ResultsProps {
  filters: DiscoverFilters;
  committedQuery: string;
  pages: ResultPages;
  online: boolean;
  now: number;
  instances: readonly InstanceSummary[];
  installed: ReadonlyMap<string, ReadonlySet<string>>;
  container: HTMLElement | null;
  onOpen: (entry: SearchEntry) => void;
  onClearFilters: () => void;
}

function Results({ filters, committedQuery, pages, online, now, instances, installed, container, onOpen, onClearFilters }: ResultsProps) {
  const { tier } = useShell();
  // 说明行折行、部分失败的提示条出没时，下面的结果区滑到新位置
  const reflow = useReflow<HTMLDivElement>();
  const requestKey = JSON.stringify(pages.state.request);
  // 首页超时只记在超时那一刻的请求上：换了请求、点了重试即作废。超时的那一轮对加载门来说已经结束，
  // 作废后加载门看到加载重新开始，从头算新的一轮
  const [timedOutKey, setTimedOutKey] = useState<string | null>(null);
  // 结果晚到或失败，那一次加载就结束了：之后同一组条件再从头加载（缓存被丢弃）是新的一次，不能沿用旧的超时
  if (timedOutKey !== null && !pages.loadingFirst) setTimedOutKey(null);
  // 恢复联网时页面会重发正在看的搜索：那是新的一次请求，之前的超时不算它的
  const [wasOnline, setWasOnline] = useState(online);
  if (online !== wasOnline) {
    setWasOnline(online);
    if (online) setTimedOutKey(null);
  }
  const timedOut = pages.loadingFirst && timedOutKey === requestKey;
  // 首页的骨架与「比平时慢」、下一页列表尾的加载行与「比平时慢」都走全站统一的加载门；以请求为一轮，
  // 加载中换了条件时慢提示（与接在它后面的超时）按新请求从头计时
  const gate = useLoadingGate(pages.loadingFirst && !timedOut, requestKey);
  const nextGate = useLoadingGate(pages.loadingNext, requestKey);

  // 加载门没有超时：超时接在它的「慢」后面计，与慢提示同一轮、同一个起点，加载门换轮时一起重来
  const latestKey = useRef(requestKey);
  useLayoutEffect(() => {
    latestKey.current = requestKey;
  });
  useEffect(() => {
    if (!gate.slow) return;
    const timer = setTimeout(() => setTimedOutKey(latestKey.current), TIMEOUT_AFTER_SLOW_MS);
    return () => clearTimeout(timer);
  }, [gate.slow]);
  const restartAfterFailure = () => {
    setTimedOutKey(null);
    pages.restart();
  };

  const [foot, setFoot] = useState<HTMLDivElement | null>(null);
  const near = useNearBottom(foot, container, PREFETCH_MARGIN_PX, pages.canLoadMore && online);
  const { canLoadMore, loadMore } = pages;
  useEffect(() => {
    if (near && canLoadMore) loadMore();
  }, [near, canLoadMore, loadMore]);

  const first = pages.first;
  const parts = conditionParts(filters, { loaderName: LOADER_NAME, platformName: PLATFORM_LABEL });
  const skip = first === null ? null : curseForgeSkipNote(first);
  const partial = first === null ? null : partialFailure(first);
  const conditional = hasConditions(filters);

  const failed = pages.firstError !== null || timedOut;
  // 失败与超时时说明行不写「搜索中」：下面的空状态已经说清了结局。
  // 首页等得久了，「搜索中…」原位换成慢提示：骨架下面的那一行在一整页骨架之后，几乎看不到
  const count = failed ? null : gate.slow ? SLOW_LOADING_HINT : pages.loadingFirst || first === null ? SEARCH_COPY.searching : SEARCH_COPY.resultCount(first.total);
  const info = (
    <div className={styles.infoLine} aria-live="polite">
      {/* 槽宽按几条候选里最宽的那条（慢提示）留住：换成慢提示、换成总数时后面的条件片段都不左右跳 */}
      {count !== null && (
        <span className={styles.infoCount}>
          <LabelSlot current={count} options={[count, SEARCH_COPY.searching, SLOW_LOADING_HINT]} align="start" />
        </span>
      )}
      {parts.map((p) => (
        <span key={p} className={styles.infoPart}>
          {p}
        </span>
      ))}
      {skip !== null && <span className={styles.infoPart}>{skip === "category_unmapped" ? SEARCH_COPY.onlyModrinthUnmapped : SEARCH_COPY.onlyModrinthKeyMissing}</span>}
      {conditional && (
        <Button size="sm" variant="ghost" className={styles.infoClear} onClick={onClearFilters}>
          {SEARCH_COPY.clearFilters}
        </Button>
      )}
    </div>
  );

  // 失败与超时不等骨架停满：结局已经定了，直接换成空状态
  const view: LoadingView = failed ? "content" : gate.view;

  // 部分失败的说明随结果一起出现：它在结果区外面，出现时自己淡入，结果区由让位滑下去，与骨架换结果的交叉淡入同一拍
  const partialNote =
    view === "content" && !failed && partial !== null ? (
      <Callout
        key="partial"
        tone="warn"
        action={
          <Button size="sm" variant="ghost" onClick={pages.restart}>
            {SEARCH_COPY.retry}
          </Button>
        }
      >
        {SEARCH_COPY.partialFailed(partial.failed, partial.other)}
      </Callout>
    ) : null;

  const outcome = (): { kind: string; node: ReactNode } => {
    if (failed) {
      const message = pages.firstError === null ? SEARCH_COPY.timeoutBody : pages.firstError.message;
      return {
        kind: "failed",
        node: (
          <EmptyState
            scene={online ? "error" : "offline"}
            title={online ? (timedOut ? SEARCH_COPY.timeout : SEARCH_COPY.allFailed) : SEARCH_COPY.offlineEmpty}
            body={online ? <span className={styles.selectable}>{message}</span> : SEARCH_COPY.offlineEmptyBody}
            action={
              online ? (
                <Button variant="secondary" icon="refresh" onClick={restartAfterFailure}>
                  {SEARCH_COPY.retry}
                </Button>
              ) : undefined
            }
          />
        ),
      };
    }

    if (first === null) throw new Error("搜索既不在加载、也没有失败，却没有第一页结果");

    if (allPlatformsFailed(first)) {
      return {
        kind: "all-failed",
        node: (
          <EmptyState
            scene={online ? "error" : "offline"}
            title={online ? SEARCH_COPY.allFailed : SEARCH_COPY.offlineEmpty}
            body={<span className={styles.selectable}>{first.errors.map((e) => `${PLATFORM_LABEL[e.platform]}：${e.message}`).join("\n")}</span>}
            action={
              <Button variant="secondary" icon="refresh" onClick={pages.restart}>
                {SEARCH_COPY.retry}
              </Button>
            }
          />
        ),
      };
    }

    if (pages.hits.length === 0) {
      const query = committedQuery.trim();
      // 另一个平台照常回来、只是一条都没有：失败的平台上可能有，空状态上方照样说明并给重试
      return {
        kind: "empty",
        node: (
          <EmptyState
            scene="empty-branch"
            title={query === "" ? SEARCH_COPY.emptyNoQuery(filters.kind) : SEARCH_COPY.emptyWithQuery(query, filters.kind)}
            body={SEARCH_COPY.emptyBody}
            action={
              conditional ? (
                <Button size="sm" variant="ghost" onClick={onClearFilters}>
                  {SEARCH_COPY.clearFilters}
                </Button>
              ) : undefined
            }
          />
        ),
      };
    }

    // 下一页的加载行与首页骨架同一口径：300 ms 内回来的不出现，免得列表尾一闪
    const nextLoading = pages.loadingNext && nextGate.view === "skeleton";
    return {
      kind: "hits",
      node: (
        <>
          <ResultGrid hits={pages.hits} instances={instances} installed={installed} now={now} onOpen={onOpen} />
          <div ref={setFoot} className={styles.listFoot}>
            <Appear itemClassName={styles.footItem}>
              {nextLoading && (
                <span key="loading" className={styles.listNote}>
                  <Spinner size={16} />
                  {nextGate.slow ? SLOW_LOADING_HINT : SEARCH_COPY.searching}
                </span>
              )}
              {pages.nextError !== null && (
                <Callout
                  key="next-error"
                  tone="danger"
                  action={
                    <Button size="sm" variant="ghost" onClick={pages.retry}>
                      {SEARCH_COPY.retry}
                    </Button>
                  }
                >
                  <span className={styles.selectable}>
                    {SEARCH_COPY.nextFailed}：{pages.nextError.message}
                  </span>
                </Callout>
              )}
              {pages.capped && (
                <span key="capped" className={styles.listNote}>
                  {SEARCH_COPY.tooMany}
                </span>
              )}
              {!pages.capped && pages.end && (
                <span key="end" className={styles.listNote}>
                  {SEARCH_COPY.end}
                </span>
              )}
            </Appear>
          </div>
        </>
      ),
    };
  };

  return (
    <div ref={reflow} className={styles.panelBody}>
      {info}
      <Appear>{partialNote}</Appear>
      {/* 加载中骨架照常占住一整页结果的高度（等待期看不见）：换条件时结果区不塌、滚动位置不被夹回；结果到了与骨架交叉淡入 */}
      <Loadable view={view} skeleton={<SkeletonGrid tier={tier} />}>
        {() => {
          const shown = outcome();
          return <OutcomeSwap swapKey={`${pages.state.baseKey}|${shown.kind}`}>{shown.node}</OutcomeSwap>;
        }}
      </Loadable>
    </div>
  );
}

/**
 * 结果区换了一组内容而没经过加载态（换回缓存里的条件，或超时之后结果才到）：整块淡入一次，不逐张卡动。
 * 挂上时就在的那一组不另外淡入：那一次由 Loadable 从加载态换上来时淡入，或跟着页面入场。
 */
function OutcomeSwap({ swapKey, children }: { swapKey: string; children: ReactNode }) {
  const [firstKey] = useState(swapKey);
  const [swapped, setSwapped] = useState(false);
  if (!swapped && swapKey !== firstKey) setSwapped(true);
  return (
    <motion.div key={swapKey} className={styles.outcome} initial={swapped ? { opacity: 0 } : false} animate={{ opacity: 1, transition: fade.in }}>
      {children}
    </motion.div>
  );
}

interface ResultGridProps {
  hits: readonly SearchEntry[];
  instances: readonly InstanceSummary[];
  installed: ReadonlyMap<string, ReadonlySet<string>>;
  now: number;
  onOpen: (entry: SearchEntry) => void;
}

/** 结果卡网格。挂上时就在的卡随结果区整块出现；之后翻页接上来的才各自淡入。一组新结果会整个重新挂上。 */
function ResultGrid({ hits, instances, installed, now, onOpen }: ResultGridProps) {
  const [initial] = useState(hits.length);
  return (
    <div className={styles.grid}>
      {hits.map((entry, i) => (
        <ResultCard
          key={hitKey(entry)}
          entry={entry}
          installed={entry.resource_type === "modpack" ? instancesFromPack(projectOrigins(entry), instances).length : installedCount(entry, installed)}
          now={now}
          onOpen={onOpen}
          fresh={i >= initial}
        />
      ))}
    </div>
  );
}
