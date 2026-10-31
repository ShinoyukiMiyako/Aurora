// 搜索结果的分页累积：一组筛选条件（首页参数）是一次搜索，往下翻时把上一页接进已有结果、按游标请求下一页。
// 每一页本身是状态层的一次按需查询（同参数共享、可重试）；累积与翻页游标归页面。

import { useState } from "react";
import { invalidate } from "../../state/resource";
import { useSearch, type SearchArgs, type SearchEntry, type SearchResultDto } from "../../state/queries/discover";
import { appendHits, MAX_RESULTS, searchKey } from "./model";

export interface PagesState {
  baseKey: string;
  /** 已经接上的页。 */
  settled: SearchResultDto[];
  /** 正在看（或正在请求）的那一页。 */
  request: SearchArgs;
}

export interface ResultPages {
  hits: SearchEntry[];
  /** 第一页的结果（总数、平台失败、跳过的平台都以它为准）；还没到时为 null。 */
  first: SearchResultDto | null;
  loadingFirst: boolean;
  /** 第一页失败。 */
  firstError: Error | null;
  loadingNext: boolean;
  nextError: Error | null;
  /** 平台说没有下一页了。 */
  end: boolean;
  /** 累积到上限，不再预取。 */
  capped: boolean;
  canLoadMore: boolean;
  loadMore(): void;
  /** 重试当前失败的那一页。 */
  retry(): void;
  /** 从第一页重新搜：平台部分失败、离线恢复后用。 */
  restart(): void;
  /** 会话快照要保存的部分。 */
  state: PagesState;
}

function firstPage(base: SearchArgs): SearchArgs {
  return { ...base, cursor: null };
}

export function useResultPages(base: SearchArgs, restored: PagesState | null): ResultPages {
  const baseKey = searchKey(firstPage(base));
  const [state, setState] = useState<PagesState>(() =>
    restored !== null && restored.baseKey === baseKey ? restored : { baseKey, settled: [], request: firstPage(base) },
  );
  // 条件变化即换一次搜索：在渲染里同步重置，不让旧结果与新条件同屏一帧
  let current = state;
  if (state.baseKey !== baseKey) {
    current = { baseKey, settled: [], request: firstPage(base) };
    setState(current);
  }

  const result = useSearch(current.request);
  const ready = result.status === "ready" ? result.data : null;
  const pages = ready === null ? current.settled : [...current.settled, ready];
  const hits = pages.reduce<SearchEntry[]>((acc, page) => appendHits(acc, page.hits), []);
  const onFirst = current.settled.length === 0;
  const end = ready !== null && ready.next_cursor === null;
  const capped = hits.length >= MAX_RESULTS;
  const canLoadMore = ready !== null && !result.refreshing && ready.next_cursor !== null && !capped;

  return {
    hits,
    first: pages.length > 0 ? pages[0] : null,
    loadingFirst: onFirst && result.status === "loading",
    firstError: onFirst && result.status === "error" ? result.error : null,
    loadingNext: !onFirst && result.status === "loading",
    nextError: !onFirst && result.status === "error" ? result.error : null,
    end,
    capped,
    canLoadMore,
    loadMore() {
      if (ready === null || ready.next_cursor === null || capped) return;
      setState({ baseKey, settled: [...current.settled, ready], request: { ...firstPage(base), cursor: ready.next_cursor } });
    },
    retry() {
      result.reload();
    },
    restart() {
      const start = firstPage(base);
      setState({ baseKey, settled: [], request: start });
      // 首页可能还以旧结果留在缓存里：让它失效，重新订阅时就是一次新请求
      invalidate(searchKey(start));
    },
    state: current,
  };
}
