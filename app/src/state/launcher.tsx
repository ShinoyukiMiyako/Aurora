// LauncherProvider / useLauncher：把状态容器接进 React。事件订阅随 Provider 挂载建立一次、卸载时全部撤销；
// 页面不自己 listen。actions 引用稳定，可以放心放进依赖数组。
//
// 下载进度与游戏日志每 100 ms 就换一次状态。useLauncher 订阅整份状态，任何变化都让组件重渲染；
// 只用到一部分的组件用 useLauncherSelector 选出自己要的那一片，片段没变（按 isEqual 比较）就不重渲染。

import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
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

function useStore(hook: string): LauncherStore {
  const ctx = useContext(LauncherContext);
  if (ctx === null) throw new Error(`${hook} 必须在 LauncherProvider 之内使用`);
  return ctx.store;
}

/** 整份状态加动作。状态的任何变化（含每 100 ms 的下载进度）都会让调用它的组件重渲染。 */
export function useLauncher(): LauncherApi {
  const store = useStore("useLauncher");
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  return { state, actions: store.actions };
}

/** 只要动作、不读状态：不订阅，状态怎么变都不重渲染。 */
export function useLauncherActions(): LauncherActions {
  return useStore("useLauncherActions").actions;
}

/** 两个数组逐项相同（===）。选出由若干实例或任务拼成的新数组时用它做 isEqual。 */
export function shallowArrayEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, i) => Object.is(item, b[i]));
}

/**
 * 订阅状态的一片。状态变了就重新选一次，与上一次选出的按 isEqual 相等时沿用上一次的值，组件不重渲染。
 * selector 可以每次渲染都是新的函数；它要是纯函数，同一份状态总选出相等的结果。
 */
export function useLauncherSelector<T>(selector: (state: LauncherState) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  const store = useStore("useLauncherSelector");
  const last = useRef<{ state: LauncherState; selector: (state: LauncherState) => T; value: T } | null>(null);
  const getSnapshot = (): T => {
    const state = store.getState();
    const prev = last.current;
    if (prev !== null && prev.state === state && prev.selector === selector) return prev.value;
    const picked = selector(state);
    const value = prev !== null && isEqual(prev.value, picked) ? prev.value : picked;
    last.current = { state, selector, value };
    return value;
  };
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
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
