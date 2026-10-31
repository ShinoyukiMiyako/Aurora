// 发现页：跨 Modrinth / CurseForge 搜资源，点开详情装进实例；整合包装成新实例，本地整合包文件从头图右上角导入。
// 页面持有界面上的筛选与分页累积；搜索结果、详情、版本、落位矩阵都是状态层的按需查询。

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { LOADER_NAME } from "../../copy/flows";
import { PLATFORM_TIMEOUT_MS, SEARCH_DEBOUNCE_MS, SLOW_HINT_MS } from "../../domain/limits";
import { useLoadingGate } from "../../lib/loading-gate";
import { useNav, useShell } from "../../shell/shell";
import { useLauncher, useNow } from "../../state/launcher";
import type { SearchEntry } from "../../state/queries/discover";
import { invalidate } from "../../state/resource";
import type { DiscoverKind, PageProps } from "../../state/route";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { EmptyState } from "../../ui/EmptyState";
import { EntranceBlock, Page } from "../../ui/Page";
import { TabPanel } from "../../ui/Tabs";
import { Spinner } from "../../art/Spinner";
import { PLATFORM_LABEL, SEARCH_COPY } from "./copy";
import { ResourceDetail, type DetailTarget } from "./detail/ResourceDetail";
import styles from "./discover.module.css";
import { useOnline } from "../../state/online";
import { useDebounced, useElapsed, useNearBottom, useScrollContainer, useStuck } from "./hooks";
import { ImportModpackDialog } from "./ImportModpackDialog";
import {
  allPlatformsFailed,
  clearFilters,
  conditionParts,
  curseForgeSkipNote,
  DEFAULT_FILTERS,
  fitCandidates,
  hasConditions,
  hitKey,
  installedCount,
  PAGE_SIZE,
  partialFailure,
  PREFETCH_MARGIN_PX,
  routeFilters,
  routeOfFilters,
  routeSignature,
  searchArgsOf,
  withFitInstance,
  withKind,
  type DiscoverFilters,
} from "./model";
import { ModSourcesProbe, modSourcesProgress, PROBE_CONCURRENCY, probeWindow, useCollected, type ModSourcesState } from "./probes";
import { ResultCard, SkeletonCard } from "./ResultCard";
import { readSnapshot, writeSnapshot } from "./session";
import { SearchHero, Toolbar } from "./Toolbar";
import { useResultPages, type ResultPages } from "./useResultPages";

export default function DiscoverPage({ route }: PageProps<"discover">) {
  const { state } = useLauncher();
  const nav = useNav();
  const shell = useShell();
  const titleId = useId();
  const tabsId = useId();
  const online = useOnline();
  const now = useNow(60000);

  const [restored] = useState(readSnapshot);
  const [filters, setFilters] = useState<DiscoverFilters>(() => routeFilters(restored === null ? DEFAULT_FILTERS : restored.filters, route, state.instances));
  const [detail, setDetail] = useState<DetailTarget | null>(() => (route.open === undefined ? null : { ...route.open, sources: [] }));
  const [importOpen, setImportOpen] = useState(false);
  const debounced = useDebounced(filters.query, SEARCH_DEBOUNCE_MS);
  const committedQuery = debounced.value;

  // 已在本页时外部导航又带来新参数（命令面板搜索、实例页「找 Mod」）：叠到当前筛选上
  const [appliedRoute, setAppliedRoute] = useState(() => routeSignature(route));
  const signature = routeSignature(route);
  if (signature !== appliedRoute) {
    setAppliedRoute(signature);
    const next = routeFilters(filters, route, state.instances);
    setFilters(next);
    debounced.flush(next.query);
    if (route.open !== undefined) setDetail({ ...route.open, sources: [] });
  }

  // 适配实例被删掉或变得不可用（开始重装、损坏）时回到不限
  const candidates = fitCandidates(state.instances);
  if (filters.fitInstance !== null && state.status.instances.kind === "ready" && !candidates.some((i) => i.id === filters.fitInstance)) {
    setFilters(withFitInstance(filters, null));
  }

  // 生效的关键词与类型写回路由：命令面板与历史项都能看到当前搜的是什么。
  // 进页带来的适配实例与详情参数在这一步从路由里去掉：它们只在进页那一刻生效
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

  const setKind = (next: DiscoverKind) => setFilters(withKind(filters, next));
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
  const open = (entry: SearchEntry) => setDetail({ platform: entry.platform, projectId: entry.project_id, sources: entry.sources });

  // 「已装入 n 个实例」只对 Mod 有意义：结果里确实有 Mod 时才去读各实例的 Mod 列表，同时在读的有上限
  const [modSources, report] = useCollected<ModSourcesState>();
  const installed = useMemo(() => {
    const out = new Map<string, ReadonlySet<string>>();
    for (const [id, s] of modSources) if (s.status === "ready") out.set(id, s.sources);
    return out;
  }, [modSources]);
  const probeIds = pages.hits.some((e) => e.resource_type === "mod") ? state.instances.filter((i) => i.status === "ready" && !i.placeholder).map((i) => i.id) : [];
  const probing = probeWindow(probeIds, (id) => modSourcesProgress(modSources.get(id)), PROBE_CONCURRENCY);

  return (
    <>
      <Page aria-labelledby={titleId}>
        {!online && (
          <Banner tone="warn" icon="cloud-off" title={SEARCH_COPY.offlineBanner} announce>
            {SEARCH_COPY.offlineBannerBody}
          </Banner>
        )}
        <SearchHero
          titleId={titleId}
          filters={filters}
          onFilters={setFilters}
          onQuery={setQuery}
          onSubmit={() => debounced.flush(filters.query)}
          onImport={() => setImportOpen(true)}
          inputRef={inputRef}
        />
        <EntranceBlock as="section" className={styles.results} aria-label={SEARCH_COPY.label}>
          <div ref={sentinelRef} className={styles.stickSentinel} aria-hidden="true" />
          <div className={styles.toolbarWrap} data-stuck={stuck || undefined}>
            <Toolbar tabsId={tabsId} filters={filters} onKind={setKind} onFit={setFit} onFilters={setFilters} fitCandidates={candidates} />
          </div>
          <TabPanel tabsId={tabsId} value={filters.kind} className={styles.panel}>
            <Results
              filters={filters}
              committedQuery={committedQuery}
              pages={pages}
              online={online}
              now={now}
              installed={installed}
              container={container}
              onOpen={open}
              onClearFilters={() => setFilters(clearFilters(filters))}
            />
          </TabPanel>
        </EntranceBlock>
      </Page>
      {probing.map((id) => (
        <ModSourcesProbe key={id} instanceId={id} onReport={report} />
      ))}
      <ResourceDetail target={detail} onClose={() => setDetail(null)} fitInstance={filters.fitInstance} online={online} />
      <ImportModpackDialog open={importOpen} onClose={() => setImportOpen(false)} online={online} />
    </>
  );
}

interface ResultsProps {
  filters: DiscoverFilters;
  committedQuery: string;
  pages: ResultPages;
  online: boolean;
  now: number;
  installed: ReadonlyMap<string, ReadonlySet<string>>;
  container: HTMLElement | null;
  onOpen: (entry: SearchEntry) => void;
  onClearFilters: () => void;
}

function Results({ filters, committedQuery, pages, online, now, installed, container, onOpen, onClearFilters }: ResultsProps) {
  const requestKey = JSON.stringify(pages.state.request);
  // 首页的骨架与「比平时慢」走全站统一的加载门；下一页只在列表尾追加一行，慢提示按这一页的请求单独计时
  const gate = useLoadingGate(pages.loadingFirst);
  const slowNext = useElapsed(pages.loadingNext, SLOW_HINT_MS, requestKey);
  const timedOut = useElapsed(pages.loadingFirst, PLATFORM_TIMEOUT_MS, requestKey);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const near = useNearBottom(bottomRef, container, PREFETCH_MARGIN_PX, pages.canLoadMore && online);
  const { canLoadMore, loadMore } = pages;
  useEffect(() => {
    if (near && canLoadMore) loadMore();
  }, [near, canLoadMore, loadMore]);

  const first = pages.first;
  const parts = conditionParts(filters, { loaderName: LOADER_NAME, platformName: PLATFORM_LABEL });
  const skip = first === null ? null : curseForgeSkipNote(first);
  const partial = first === null ? null : partialFailure(first);
  const clear = hasConditions(filters) ? (
    <Button size="sm" variant="ghost" onClick={onClearFilters}>
      {SEARCH_COPY.clearFilters}
    </Button>
  ) : null;

  const failed = pages.firstError !== null || timedOut;
  // 失败与超时时说明行不写「搜索中」：下面的空状态已经说清了结局
  const count = failed ? null : pages.loadingFirst || first === null ? SEARCH_COPY.searching : SEARCH_COPY.resultCount(first.total);
  const info = (
    <div className={styles.infoLine} aria-live="polite">
      {count !== null && <span className={styles.infoCount}>{count}</span>}
      {parts.map((p) => (
        <span key={p} className={styles.infoPart}>
          {p}
        </span>
      ))}
      {skip !== null && <span className={styles.infoPart}>{skip === "category_unmapped" ? SEARCH_COPY.onlyModrinthUnmapped : SEARCH_COPY.onlyModrinthKeyMissing}</span>}
      {clear}
    </div>
  );

  if (failed) {
    const message = pages.firstError === null ? SEARCH_COPY.timeoutBody : pages.firstError.message;
    return (
      <>
        {info}
        <EmptyState
          scene={online ? "error" : "offline"}
          title={online ? (timedOut ? SEARCH_COPY.timeout : SEARCH_COPY.allFailed) : SEARCH_COPY.offlineEmpty}
          body={online ? <span className={styles.selectable}>{message}</span> : SEARCH_COPY.offlineEmptyBody}
          action={
            online ? (
              <Button variant="secondary" icon="refresh" onClick={pages.restart}>
                {SEARCH_COPY.retry}
              </Button>
            ) : undefined
          }
        />
      </>
    );
  }

  if (gate.view !== "content") {
    return (
      <>
        {info}
        <div className={styles.grid} aria-busy="true">
          {gate.view === "skeleton" && Array.from({ length: PAGE_SIZE }, (_, i) => <SkeletonCard key={i} />)}
        </div>
        {gate.slow && <p className={styles.listNote}>{SEARCH_COPY.slow}</p>}
      </>
    );
  }

  if (first === null) throw new Error("搜索既不在加载、也没有失败，却没有第一页结果");

  if (allPlatformsFailed(first)) {
    return (
      <>
        {info}
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
      </>
    );
  }

  if (pages.hits.length === 0) {
    const query = committedQuery.trim();
    return (
      <>
        {info}
        <EmptyState
          scene="empty-branch"
          title={query === "" ? SEARCH_COPY.emptyNoQuery(filters.kind) : SEARCH_COPY.emptyWithQuery(query, filters.kind)}
          body={SEARCH_COPY.emptyBody}
          action={clear === null ? undefined : clear}
        />
      </>
    );
  }

  return (
    <>
      {info}
      {partial !== null && (
        <Callout
          tone="warn"
          action={
            <Button size="sm" variant="ghost" onClick={pages.restart}>
              {SEARCH_COPY.retry}
            </Button>
          }
        >
          {SEARCH_COPY.partialFailed(partial.failed, partial.other)}
        </Callout>
      )}
      <div className={styles.grid}>
        {pages.hits.map((entry) => (
          <ResultCard key={hitKey(entry)} entry={entry} installed={installedCount(entry, installed)} now={now} onOpen={onOpen} />
        ))}
      </div>
      <div ref={bottomRef} className={styles.listFoot}>
        {pages.loadingNext && (
          <span className={styles.listNote}>
            <Spinner size={16} />
            {slowNext ? SEARCH_COPY.slow : SEARCH_COPY.searching}
          </span>
        )}
        {pages.nextError !== null && (
          <Callout
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
        {pages.capped && <span className={styles.listNote}>{SEARCH_COPY.tooMany}</span>}
        {!pages.capped && pages.end && <span className={styles.listNote}>{SEARCH_COPY.end}</span>}
      </div>
    </>
  );
}
