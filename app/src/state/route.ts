// 路由：界面状态，不写进 URL、不调用 window.history，历史栈由外壳自持（shell/nav.ts）。
// 类型定义放在状态层而不是外壳：通知的「查看诊断」、任务完成的「查看」都要带导航目标，状态层不能依赖外壳；
// 页面组件的 props 也要用到它，而页面只能从外壳引入 useShell / useNav / useRunner。

import type { Platform } from "../domain/types";

export const INSTANCE_TABS = ["overview", "mods", "settings", "logs", "crash"] as const;
export type InstanceTab = (typeof INSTANCE_TABS)[number];

export const SETTINGS_SECTIONS = ["general", "download", "java", "game", "appearance", "about"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export type DiscoverKind = "all" | "mod" | "modpack" | "resourcepack" | "shader" | "datapack";

/** 下载任务页的状态筛选：全部 / 进行中 / 已完成 / 失败与取消。 */
export type TaskFilter = "all" | "active" | "done" | "failed";

export type Route =
  | { page: "home" }
  | { page: "library" }
  | { page: "instance"; id: string; tab: InstanceTab }
  | {
      page: "discover";
      query?: string;
      /** 进页时选中的资源类型。 */
      kind?: DiscoverKind;
      /** 进页时把「适配实例」设为该实例，详情里默认勾选它。 */
      forInstance?: string;
      /** 进页后直接打开该资源的详情弹窗。 */
      open?: { platform: Platform; projectId: string };
    }
  /** filter：多个下载失败合并成一条通知时，「查看」直接切到「失败与取消」。 */
  | { page: "tasks"; filter?: TaskFilter }
  | { page: "accounts" }
  /** section 缺省等于 general。 */
  | { page: "settings"; section?: SettingsSection };

export type PageId = Route["page"];

/** 页面目录名与 page 字段一一对应：app/src/pages/<PageId>/index.tsx。 */
export const PAGE_IDS: readonly PageId[] = ["home", "library", "instance", "discover", "tasks", "accounts", "settings"];

export type RouteOf<P extends PageId> = Extract<Route, { page: P }>;

/** 页面模块默认导出的组件收到的 props。 */
export interface PageProps<P extends PageId> {
  route: RouteOf<P>;
}

export const HOME_ROUTE: Route = { page: "home" };
export const LIBRARY_ROUTE: Route = { page: "library" };

export function isPageId(value: string): value is PageId {
  return (PAGE_IDS as readonly string[]).includes(value);
}

/** 页面挂载与换页动效的 key：同一实例换 Tab、发现页换关键词、设置页换分区都不算换页。 */
export function routeKey(route: Route): string {
  return route.page === "instance" ? `instance:${route.id}` : route.page;
}

/** 路由指向的实例；不指向实例的路由为 null。discover 的 forInstance 也算：实例删了它就失效。 */
export function routeInstanceId(route: Route): string | null {
  if (route.page === "instance") return route.id;
  if (route.page === "discover" && route.forInstance !== undefined) return route.forInstance;
  return null;
}

export function sameRoute(a: Route, b: Route): boolean {
  switch (a.page) {
    case "instance":
      return b.page === "instance" && a.id === b.id && a.tab === b.tab;
    case "discover":
      return (
        b.page === "discover" &&
        a.query === b.query &&
        a.kind === b.kind &&
        a.forInstance === b.forInstance &&
        a.open?.platform === b.open?.platform &&
        a.open?.projectId === b.open?.projectId
      );
    case "tasks":
      return b.page === "tasks" && a.filter === b.filter;
    case "settings":
      return b.page === "settings" && (a.section ?? "general") === (b.section ?? "general");
    default:
      return a.page === b.page;
  }
}
