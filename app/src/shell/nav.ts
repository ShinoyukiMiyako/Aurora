// 导航历史栈：外壳自持，不调用 window.history（单窗口没有地址栏；历史要按实例存活剪除；WebView 自带的后退不能参与）。
// 每个历史项记下离开时的滚动位置，后退 / 前进回到它时恢复；go 进新项回到顶部，replace 不改滚动。
// 页面与流程的模块表也在这里：App 用 import.meta.glob 收集目录，交给 buildPageTable / buildFlowTable 校验成表。

import type { ComponentType } from "react";
import { FLOW_NAMES, isFlowName, type FlowName, type FlowProps } from "../state/flows";
import { HOME_ROUTE, LIBRARY_ROUTE, PAGE_IDS, isPageId, routeInstanceId, sameRoute, type PageId, type PageProps, type Route } from "../state/route";

export type { DiscoverKind, InstanceTab, PageId, PageProps, Route, RouteOf, SettingsSection, TaskFilter } from "../state/route";
export { INSTANCE_TABS, PAGE_IDS, SETTINGS_SECTIONS, routeInstanceId, routeKey, sameRoute } from "../state/route";

/** 历史总长上限，超出丢最早的项。 */
export const NAV_HISTORY_LIMIT = 50;

export interface HistoryEntry {
  /** 历史项的身份：replace 保留它，滚动恢复按它对位。 */
  seq: number;
  route: Route;
  scrollTop: number;
}

export interface NavHistory {
  entries: HistoryEntry[];
  index: number;
  /** 下一个历史项的 seq。 */
  nextSeq: number;
}

/** 应用每次启动都从主页开始，不恢复上次的页面。 */
export function initialHistory(): NavHistory {
  return { entries: [{ seq: 0, route: HOME_ROUTE, scrollTop: 0 }], index: 0, nextSeq: 1 };
}

export function currentEntry(history: NavHistory): HistoryEntry {
  const entry = history.entries[history.index];
  if (entry === undefined) throw new Error(`历史下标 ${history.index} 越界（共 ${history.entries.length} 项）`);
  return entry;
}

export const canBack = (history: NavHistory): boolean => history.index > 0;
export const canForward = (history: NavHistory): boolean => history.index < history.entries.length - 1;

/** 与当前项相同时什么都不做；否则截掉前进分支、压入新项，总长超限丢最早的项。 */
export function navGo(history: NavHistory, route: Route): NavHistory {
  if (sameRoute(currentEntry(history).route, route)) return history;
  const entries = [...history.entries.slice(0, history.index + 1), { seq: history.nextSeq, route, scrollTop: 0 }];
  const overflow = Math.max(0, entries.length - NAV_HISTORY_LIMIT);
  const kept = entries.slice(overflow);
  return { entries: kept, index: kept.length - 1, nextSeq: history.nextSeq + 1 };
}

/** 替换当前项的路由，保留它的 seq 与滚动位置（实例详情切 Tab、设置页切分区）。 */
export function navReplace(history: NavHistory, route: Route): NavHistory {
  const current = currentEntry(history);
  if (sameRoute(current.route, route)) return history;
  const entries = history.entries.map((e, i) => (i === history.index ? { ...e, route } : e));
  return { ...history, entries };
}

export function navBack(history: NavHistory): NavHistory {
  return canBack(history) ? { ...history, index: history.index - 1 } : history;
}

export function navForward(history: NavHistory): NavHistory {
  return canForward(history) ? { ...history, index: history.index + 1 } : history;
}

/** 离开当前项前记下滚动位置。 */
export function recordScroll(history: NavHistory, scrollTop: number): NavHistory {
  const current = currentEntry(history);
  if (current.scrollTop === scrollTop) return history;
  return { ...history, entries: history.entries.map((e, i) => (i === history.index ? { ...e, scrollTop } : e)) };
}

/**
 * 剪除失效路由（实例被删除、新建后取消安装）。当前项被剪时落到它之前最近的存活项，之前没有就落到之后最近的；
 * 剪完为空落到实例库。剪除后相邻的相同路由合并成一项，免得后退一下原地不动。
 */
export function pruneHistory(history: NavHistory, alive: (route: Route) => boolean): NavHistory {
  if (history.entries.every((e) => alive(e.route))) return history;
  const survivors: { entry: HistoryEntry; oldIndex: number }[] = [];
  history.entries.forEach((entry, oldIndex) => {
    if (!alive(entry.route)) return;
    const last = survivors[survivors.length - 1];
    if (last !== undefined && sameRoute(last.entry.route, entry.route)) {
      // 合并时保留离当前项更近的那一个的位置信息
      if (oldIndex <= history.index) survivors[survivors.length - 1] = { entry, oldIndex };
      return;
    }
    survivors.push({ entry, oldIndex });
  });
  if (survivors.length === 0) {
    return { entries: [{ seq: history.nextSeq, route: LIBRARY_ROUTE, scrollTop: 0 }], index: 0, nextSeq: history.nextSeq + 1 };
  }
  let index = -1;
  survivors.forEach((s, i) => {
    if (s.oldIndex <= history.index) index = i;
  });
  if (index === -1) index = 0;
  return { entries: survivors.map((s) => s.entry), index, nextSeq: history.nextSeq };
}

/** 实例改名后把历史里指向旧 id 的项换成新 id（改名不是删除，不能剪掉）。 */
export function renameInHistory(history: NavHistory, from: string, to: string): NavHistory {
  if (!history.entries.some((e) => routeInstanceId(e.route) === from)) return history;
  const rename = (route: Route): Route => {
    if (route.page === "instance" && route.id === from) return { ...route, id: to };
    if (route.page === "discover" && route.forInstance === from) return { ...route, forInstance: to };
    return route;
  };
  return { ...history, entries: history.entries.map((e) => ({ ...e, route: rename(e.route) })) };
}

/** 剪除生效前的那一帧：当前路由指向的实例已不存在时按实例库渲染，页面永远拿不到不存在的 id。 */
export function effectiveRoute(route: Route, exists: (instanceId: string) => boolean): Route {
  const id = routeInstanceId(route);
  return id !== null && !exists(id) ? LIBRARY_ROUTE : route;
}

// ---------------------------------------------------------------- 页面与流程模块表

export type PageComponent<P extends PageId> = ComponentType<PageProps<P>>;
export type PageLoader = () => Promise<{ default: ComponentType<{ route: never }> }>;
export type PageTable = { readonly [P in PageId]: () => Promise<{ default: PageComponent<P> }> };

export type FlowComponent<N extends FlowName> = ComponentType<FlowProps<N>>;
export type FlowTable = { readonly [N in FlowName]: () => Promise<{ default: FlowComponent<N> }> };

const MODULE_PATH = /\/(pages|flows)\/([^/]+)\/index\.tsx$/;

function collect<K extends string>(
  kind: "pages" | "flows",
  modules: Record<string, () => Promise<unknown>>,
  names: readonly K[],
  isName: (value: string) => value is K,
): Record<K, () => Promise<unknown>> {
  const table = new Map<K, () => Promise<unknown>>();
  for (const [path, loader] of Object.entries(modules)) {
    const match = MODULE_PATH.exec(path);
    if (match === null || match[1] !== kind) throw new Error(`${path} 不是 ${kind}/<名称>/index.tsx 形式的模块`);
    const name = match[2];
    if (!isName(name)) throw new Error(`${kind}/${name} 没有对应的约定名称（可用：${names.join("、")}）`);
    table.set(name, loader);
  }
  const missing = names.filter((n) => !table.has(n));
  if (missing.length > 0) throw new Error(`缺少 ${kind} 模块：${missing.join("、")}`);
  return Object.fromEntries(table) as Record<K, () => Promise<unknown>>;
}

/**
 * 校验 import.meta.glob("./pages/*\/index.tsx") 的结果：目录名必须与 Route 的 page 一一对应，缺一个或多一个都抛错。
 * 各模块默认导出页面组件，props 为 { route }。
 */
export function buildPageTable(modules: Record<string, () => Promise<unknown>>): PageTable {
  return collect("pages", modules, PAGE_IDS, isPageId) as unknown as PageTable;
}

/** 校验 import.meta.glob("./flows/*\/index.tsx") 的结果：login、onboarding、create-instance 三个目录。 */
export function buildFlowTable(modules: Record<string, () => Promise<unknown>>): FlowTable {
  return collect("flows", modules, FLOW_NAMES, isFlowName) as unknown as FlowTable;
}
