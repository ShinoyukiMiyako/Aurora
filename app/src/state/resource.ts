// 资源型数据的按需查询：某实例的 Mod、内容、历史、崩溃报告、最近日志、搜索结果等。
//
// - 同 key 共享一次请求：多个组件同时要同一份数据只发一次命令，结果一起拿到。
// - invalidate(prefix) 让 key 等于 prefix 或以「prefix:」开头的数据失效：有人在看的立即重取（重取期间保留旧数据），
//   没人看的直接丢弃，下次有人要时再取。key 用冒号分段，「history:1.21」不会误伤「history:1.21.1」。
// - 失效后旧请求晚到的结果按版本号丢弃，界面不会被旧数据覆盖。
// - 错误进入 error 状态由页面原位呈现（模块级错误），不吞、不转成空数据。出错的条目没人看了就丢掉，下次有人要时重新请求。

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

export type ResourceStatus = "loading" | "ready" | "error";

export interface ResourceSnapshot<T> {
  status: ResourceStatus;
  /** ready 时为最新数据；error 时为上一次成功的数据（从没成功过为 undefined）。 */
  data: T | undefined;
  error: Error | null;
  /** 已有数据、正在后台重取。 */
  refreshing: boolean;
}

export type ResourceResult<T> = (
  | { status: "loading"; data: undefined; error: null; refreshing: false }
  | { status: "ready"; data: T; error: null; refreshing: boolean }
  | { status: "error"; data: T | undefined; error: Error; refreshing: false }
) & {
  /** 重新请求（「重试」按钮用）。 */
  reload(): void;
  /** 后台重读（见 ResourceCache.refresh）：已有请求在路上时不再发，也不作废它。 */
  refresh(): void;
};

interface Entry {
  snapshot: ResourceSnapshot<unknown>;
  fetcher: () => Promise<unknown>;
  listeners: Set<() => void>;
  /** 每次发起请求加一；回来的结果版本不符就丢弃。 */
  version: number;
  inFlight: boolean;
  lastUsed: number;
}

/** 没人订阅的缓存条目最多留这么多个，超出按最久未用淘汰（搜索词这类 key 会不断变化）。 */
const IDLE_ENTRY_LIMIT = 64;

const LOADING_SNAPSHOT: ResourceSnapshot<never> = { status: "loading", data: undefined, error: null, refreshing: false };

function toError(raw: unknown): Error {
  return raw instanceof Error ? raw : new Error(`查询以非 Error 值拒绝：${String(raw)}`);
}

export function matchesPrefix(key: string, prefix: string): boolean {
  return key === prefix || key.startsWith(`${prefix}:`);
}

export class ResourceCache {
  private entries = new Map<string, Entry>();
  private clock = 0;
  private errorObservers = new Set<(error: Error) => void>();

  /** 旁听请求失败（错误照常进入条目的 error 状态）：联网状态据此判断要不要探测连通性。返回退订函数。 */
  observeErrors(observer: (error: Error) => void): () => void {
    this.errorObservers.add(observer);
    return () => {
      this.errorObservers.delete(observer);
    };
  }

  private entry(key: string, fetcher: () => Promise<unknown>): Entry {
    let entry = this.entries.get(key);
    if (entry === undefined) {
      entry = { snapshot: LOADING_SNAPSHOT, fetcher, listeners: new Set(), version: 0, inFlight: false, lastUsed: ++this.clock };
      this.entries.set(key, entry);
    }
    return entry;
  }

  private set(entry: Entry, snapshot: ResourceSnapshot<unknown>): void {
    entry.snapshot = snapshot;
    for (const listener of [...entry.listeners]) listener();
  }

  private fetch(key: string, entry: Entry, fetcher: () => Promise<unknown> = entry.fetcher): void {
    const version = ++entry.version;
    entry.inFlight = true;
    // 出错时手里还有上一次成功的数据（重取失败过）：重试期间照常给出它，与失效重取保留旧数据一致；这次也失败时
    // 下面的失败分支从快照里接着带上它。从没成功过的才回到 loading
    const kept = entry.snapshot.data;
    if (entry.snapshot.status === "ready") this.set(entry, { ...entry.snapshot, refreshing: true });
    else if (entry.snapshot.status === "error") this.set(entry, kept === undefined ? LOADING_SNAPSHOT : { status: "ready", data: kept, error: null, refreshing: true });
    fetcher().then(
      (data) => {
        if (this.entries.get(key) !== entry || entry.version !== version) return;
        entry.inFlight = false;
        this.set(entry, { status: "ready", data, error: null, refreshing: false });
      },
      (raw: unknown) => {
        if (this.entries.get(key) !== entry || entry.version !== version) return;
        entry.inFlight = false;
        const error = toError(raw);
        this.set(entry, { status: "error", data: entry.snapshot.data, error, refreshing: false });
        for (const observer of [...this.errorObservers]) observer(error);
        this.sweepIfAbandoned(key, entry);
      },
    );
  }

  /**
   * 出错的条目没人看了就丢掉：订阅只在 loading 时发请求，留着它的话断网时看过的页面恢复联网后再进来还是那条错误。
   * 延后一个宏任务再查：组件交接（React 在同一次提交里先退订旧的、再订阅新的）期间订阅数短暂归零，
   * 当场丢掉会让新订阅者从头请求，出错的页面每次重渲染都换 key 时还会反复请求。
   */
  private sweepIfAbandoned(key: string, entry: Entry): void {
    if (entry.listeners.size > 0 || entry.snapshot.status !== "error") return;
    setTimeout(() => {
      if (this.entries.get(key) === entry && entry.listeners.size === 0 && entry.snapshot.status === "error") this.entries.delete(key);
    }, 0);
  }

  /** 订阅一个 key；首个订阅者到来且没有可用数据时发起请求。返回退订函数。 */
  subscribe(key: string, fetcher: () => Promise<unknown>, listener: () => void): () => void {
    const entry = this.entry(key, fetcher);
    entry.fetcher = fetcher;
    entry.listeners.add(listener);
    entry.lastUsed = ++this.clock;
    if (!entry.inFlight && entry.snapshot.status === "loading") this.fetch(key, entry);
    return () => {
      entry.listeners.delete(listener);
      entry.lastUsed = ++this.clock;
      this.sweepIfAbandoned(key, entry);
      this.evictIdle();
    };
  }

  snapshot(key: string): ResourceSnapshot<unknown> {
    const entry = this.entries.get(key);
    return entry === undefined ? LOADING_SNAPSHOT : entry.snapshot;
  }

  reload(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) throw new Error(`资源 ${key} 还没有被订阅过，不能重载`);
    this.fetch(key, entry);
  }

  /**
   * 不是玩家点的重读（切回页面时看看盘上变了没有）：已有请求在路上就等它。reload 会作废在途的那次，
   * 初次加载的骨架要从头等，回到前台与切页撞在一起时也多读一遍。
   */
  refresh(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) throw new Error(`资源 ${key} 还没有被订阅过，不能重读`);
    if (!entry.inFlight) this.fetch(key, entry);
  }

  /**
   * 只这一次换用 fetcher 重取，例如用户点「重试」时要后端跳过退避立即重取的那一次；
   * 之后的失效重取与 reload 仍用订阅时登记的 fetcher，取的必须是同一份数据。
   */
  reloadWith(key: string, fetcher: () => Promise<unknown>): void {
    const entry = this.entries.get(key);
    if (entry === undefined) throw new Error(`资源 ${key} 还没有被订阅过，不能重载`);
    this.fetch(key, entry, fetcher);
  }

  invalidate(prefix: string): void {
    for (const [key, entry] of [...this.entries]) {
      if (!matchesPrefix(key, prefix)) continue;
      if (entry.listeners.size > 0) this.fetch(key, entry);
      else this.entries.delete(key);
    }
  }

  /** 读取一份数据（命令式调用方用）：命中缓存直接返回，否则与订阅者共享同一次请求。 */
  async read<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const entry = this.entry(key, fetcher);
    if (entry.snapshot.status === "ready" && !entry.snapshot.refreshing) return entry.snapshot.data as T;
    if (!entry.inFlight) this.fetch(key, entry);
    return new Promise<T>((resolve, reject) => {
      const listener = () => {
        const snap = entry.snapshot;
        if (snap.status === "ready" && !snap.refreshing) {
          entry.listeners.delete(listener);
          resolve(snap.data as T);
        } else if (snap.status === "error") {
          entry.listeners.delete(listener);
          reject(snap.error);
        }
      };
      entry.listeners.add(listener);
    });
  }

  clear(): void {
    this.entries.clear();
  }

  private evictIdle(): void {
    const idle = [...this.entries].filter(([, e]) => e.listeners.size === 0 && !e.inFlight);
    if (idle.length <= IDLE_ENTRY_LIMIT) return;
    idle.sort(([, a], [, b]) => a.lastUsed - b.lastUsed);
    for (const [key] of idle.slice(0, idle.length - IDLE_ENTRY_LIMIT)) this.entries.delete(key);
  }
}

/** 应用唯一的资源缓存。状态层的动作完成后经 invalidate 让相关数据失效。 */
export const resources = new ResourceCache();

export function invalidate(prefix: string): void {
  resources.invalidate(prefix);
}

/**
 * 按 key 订阅一份资源。key 为 null 时不请求（条件查询），返回 loading。
 * fetcher 只在首次请求、失效重取与 reload 时调用；同一个 key 的 fetcher 必须取同一份数据。
 */
export function useResource<T>(key: string | null, fetcher: () => Promise<T>, cache: ResourceCache = resources): ResourceResult<T> {
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });
  const subscribe = useCallback(
    (listener: () => void) => (key === null ? () => undefined : cache.subscribe(key, () => fetcherRef.current(), listener)),
    [cache, key],
  );
  const getSnapshot = useCallback(() => (key === null ? LOADING_SNAPSHOT : cache.snapshot(key)), [cache, key]);
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot) as ResourceSnapshot<T>;
  const reload = useCallback(() => {
    if (key === null) throw new Error("未启用的查询不能重载");
    cache.reload(key);
  }, [cache, key]);
  const refresh = useCallback(() => {
    if (key === null) throw new Error("未启用的查询不能重读");
    cache.refresh(key);
  }, [cache, key]);
  return { ...snap, reload, refresh } as ResourceResult<T>;
}
