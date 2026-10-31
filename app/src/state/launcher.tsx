// LauncherProvider / useLauncher：把状态容器接进 React。事件订阅随 Provider 挂载建立一次、卸载时全部撤销；
// 页面不自己 listen。actions 引用稳定，可以放心放进依赖数组。

import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { LauncherStore, type LauncherActions, type LauncherState } from "./store";

interface LauncherContextValue {
  store: LauncherStore;
}

const LauncherContext = createContext<LauncherContextValue | null>(null);

export interface LauncherProviderProps {
  /** 测试注入预先建好的容器；应用里省略，由 Provider 自己建。 */
  store?: LauncherStore;
  children: ReactNode;
}

export function LauncherProvider({ store: injected, children }: LauncherProviderProps) {
  const [store] = useState(() => (injected === undefined ? new LauncherStore() : injected));
  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);
  const [value] = useState<LauncherContextValue>(() => ({ store }));
  return <LauncherContext.Provider value={value}>{children}</LauncherContext.Provider>;
}

export interface LauncherApi {
  state: LauncherState;
  actions: LauncherActions;
}

export function useLauncher(): LauncherApi {
  const ctx = useContext(LauncherContext);
  if (ctx === null) throw new Error("useLauncher 必须在 LauncherProvider 之内使用");
  const state = useSyncExternalStore(ctx.store.subscribe, ctx.store.getState, ctx.store.getState);
  return { state, actions: ctx.store.actions };
}

/** 按固定间隔刷新的当前时间：「已运行 mm:ss」每 1 s，相对时间每 30 s。 */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
