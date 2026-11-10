// 启动器更新状态接进 React。整个应用只有一份状态机：外壳在最外层挂 UpdaterProvider，跨页面保留
// （检查过、下载中都不因切页丢失），外壳的自动检查与更新面板、设置页的更新卡与导航提示点读写的都是它。
// 后端更新信息经按需查询同步进状态机；每个改动后端状态的动作完成后让查询失效，以后端为准再同步一次。

import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useUpdaterInfo, type UpdaterInfoDto } from "../queries/catalog";
import { invalidate, type ResourceResult } from "../resource";
import { UpdaterController } from "./controller";
import type { UpdaterState } from "./machine";
import { UPDATER_PORT } from "./port";

const UpdaterContext = createContext<UpdaterController | null>(null);

const INFO_KEY = "updater";

export function UpdaterProvider({ children }: { children: ReactNode }) {
  const [controller] = useState(() => new UpdaterController(UPDATER_PORT));
  const info = useUpdaterInfo();
  const data = info.status === "ready" ? info.data : null;
  useEffect(() => {
    if (data !== null) controller.sync(data);
  }, [controller, data]);
  return <UpdaterContext.Provider value={controller}>{children}</UpdaterContext.Provider>;
}

export interface UpdaterApi {
  state: UpdaterState;
  /** 此刻的状态：动作 await 完之后要据结果决定下一步时用它，渲染时拿到的 state 那时已经过时。 */
  snapshot(): UpdaterState;
  info: ResourceResult<UpdaterInfoDto>;
  check(): Promise<void>;
  download(): Promise<void>;
  cancelDownload(): Promise<void>;
  setInstallOnExit(enabled: boolean): Promise<void>;
  install(): Promise<void>;
  markSeen(version: string): void;
}

function useController(hook: string): UpdaterController {
  const controller = useContext(UpdaterContext);
  if (controller === null) throw new Error(`${hook} 必须在 UpdaterProvider 之内使用`);
  return controller;
}

/**
 * 只订阅更新状态里的一部分：选出的值（按 Object.is）不变就不重渲染。下载更新时每条进度事件都换一次状态，
 * 只关心版本号、提示点的订阅方用它，不跟着进度重渲染。select 要选出原始值或状态里原有的对象：
 * 每次新拼的对象永远不相等，等于整份订阅。
 */
export function useUpdaterSelector<T>(select: (state: UpdaterState) => T): T {
  const controller = useController("useUpdaterSelector");
  // useSyncExternalStore 要求状态没变时快照也不变，否则反复重渲染：按状态与 select 记下上次的结果，
  // select 是每次渲染新建的函数时重选一次，选出的值没变就交回上次那个
  const last = useRef<{ state: UpdaterState; select: (state: UpdaterState) => T; value: T } | null>(null);
  const getSnapshot = (): T => {
    const state = controller.getState();
    const prev = last.current;
    if (prev !== null && prev.state === state && prev.select === select) return prev.value;
    const picked = select(state);
    const value = prev !== null && Object.is(prev.value, picked) ? prev.value : picked;
    last.current = { state, select, value };
    return value;
  };
  return useSyncExternalStore(controller.subscribe, getSnapshot, getSnapshot);
}

export function useUpdater(): UpdaterApi {
  const controller = useController("useUpdater");
  const info = useUpdaterInfo();
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);

  const actions = useMemo(() => {
    const thenResync = async (work: Promise<void>) => {
      try {
        await work;
      } finally {
        invalidate(INFO_KEY);
      }
    };
    return {
      snapshot: () => controller.getState(),
      check: () => thenResync(controller.check()),
      download: () => thenResync(controller.download()),
      cancelDownload: () => controller.cancelDownload(),
      setInstallOnExit: (enabled: boolean) => thenResync(controller.setInstallOnExit(enabled)),
      install: () => thenResync(controller.install()),
      markSeen: (version: string) => controller.markSeen(version),
    };
  }, [controller]);

  return { state, info, ...actions };
}
