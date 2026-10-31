// 页面组件表：每个页面按需加载一次，之后同步可用。
//
// 已经加载过的页面直接渲染组件本身，不经 React.lazy：lazy 包装在首次渲染时总要挂起一拍（原生 Promise 没有同步可读的状态），
// 换页时会闪一帧空白。还没加载过的页面经 lazy 挂起，由内容区的 Suspense 接住。
// 应用启动前预载主页（首帧就有内容），挂载后在空闲时预载其余页面。

import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import { PAGE_IDS, type PageId, type Route } from "../state/route";
import type { PageTable } from "./nav";

/** 表里的页面组件按 page 一一对应，渲染时由外壳保证 route 与组件匹配，这里统一按 Route 看待。 */
export type AnyPage = ComponentType<{ route: Route }>;

export interface PageRegistry {
  /** 已加载的组件；还没加载完时为 null。 */
  resolved(page: PageId): AnyPage | null;
  /** 首次渲染时用的懒加载包装。 */
  lazy(page: PageId): LazyExoticComponent<AnyPage>;
  load(page: PageId): Promise<AnyPage>;
  preloadAll(): Promise<void>;
}

export function createPageRegistry(table: PageTable): PageRegistry {
  const resolved = new Map<PageId, AnyPage>();
  const pending = new Map<PageId, Promise<AnyPage>>();
  const lazies = new Map<PageId, LazyExoticComponent<AnyPage>>();

  const load = (page: PageId): Promise<AnyPage> => {
    const existing = pending.get(page);
    if (existing !== undefined) return existing;
    const loader = table[page] as () => Promise<{ default: unknown }>;
    const promise = loader().then((mod) => {
      const component = mod.default as AnyPage;
      if (typeof component !== "function" && (typeof component !== "object" || component === null)) {
        throw new Error(`pages/${page}/index.tsx 没有默认导出页面组件`);
      }
      resolved.set(page, component);
      return component;
    });
    pending.set(page, promise);
    // 加载失败不缓存：下次进页（或内容区「重新加载」）重新请求模块。lazy 包装会永久记住失败，一并丢掉。
    // 这里只做清理，失败本身照常交给等待这个 Promise 的调用方
    promise.catch(() => {
      if (pending.get(page) !== promise) return;
      pending.delete(page);
      lazies.delete(page);
    });
    return promise;
  };

  return {
    resolved: (page) => {
      const component = resolved.get(page);
      return component === undefined ? null : component;
    },
    lazy: (page) => {
      let wrapped = lazies.get(page);
      if (wrapped === undefined) {
        wrapped = lazy(() => load(page).then((component) => ({ default: component })));
        lazies.set(page, wrapped);
      }
      return wrapped;
    },
    load,
    preloadAll: async () => {
      await Promise.all(PAGE_IDS.map((page) => load(page)));
    },
  };
}
