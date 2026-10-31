// 发现页的会话级界面状态：离开再回来时恢复上次的搜索词、类型、筛选、排序与已翻到的页。
// 只活在本次运行的内存里，不进领域状态、不落盘；重启应用后从默认状态开始。
// 滚动位置归外壳的历史栈（后退、前进恢复，侧栏进入回到顶部），这里不另存一份。

import type { DiscoverFilters } from "./model";
import type { PagesState } from "./useResultPages";

export interface DiscoverSnapshot {
  filters: DiscoverFilters;
  pages: PagesState;
}

let snapshot: DiscoverSnapshot | null = null;

export function readSnapshot(): DiscoverSnapshot | null {
  return snapshot;
}

export function writeSnapshot(next: DiscoverSnapshot): void {
  snapshot = next;
}

/** 测试之间清掉上一例留下的状态。 */
export function clearSnapshot(): void {
  snapshot = null;
}
