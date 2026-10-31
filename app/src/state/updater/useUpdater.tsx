// 启动器更新状态接进 React。整个应用只有一份状态机：外壳在最外层挂 UpdaterProvider，跨页面保留
// （检查过、下载中都不因切页丢失），外壳的自动检查与更新面板、设置页的更新卡与导航提示点读写的都是它。
// 后端更新信息经按需查询同步进状态机；每个改动后端状态的动作完成后让查询失效，以后端为准再同步一次。

import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
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

export function useUpdater(): UpdaterApi {
  const controller = useContext(UpdaterContext);
  if (controller === null) throw new Error("useUpdater 必须在 UpdaterProvider 之内使用");
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
