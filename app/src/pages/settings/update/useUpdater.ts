// 更新卡与更新面板读写同一份更新状态：状态机实例放在模块里，跨页面挂载保留（检查过、下载中都不因切页丢失）。
// 后端更新信息经按需查询同步进状态机；每个改动后端状态的动作完成后让查询失效，以后端为准再同步一次。

import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import { useUpdaterInfo, type UpdaterInfoDto } from "../../../state/queries/catalog";
import type { ResourceResult } from "../../../state/resource";
import { invalidate } from "../../../state/resource";
import { UpdaterController } from "./controller";
import type { UpdaterState } from "./machine";
import { UPDATER_PORT } from "./port";

const UpdaterContext = createContext<UpdaterController>(new UpdaterController(UPDATER_PORT));

/** 测试与外壳可以换一个状态机实例（例如注入假的后端）。 */
export const UpdaterControllerProvider = UpdaterContext.Provider;

export interface UpdaterApi {
  state: UpdaterState;
  info: ResourceResult<UpdaterInfoDto>;
  check(): Promise<void>;
  download(): Promise<void>;
  cancelDownload(): Promise<void>;
  setInstallOnExit(enabled: boolean): Promise<void>;
  install(): Promise<void>;
  markSeen(version: string): void;
}

const INFO_KEY = "updater";

export function useUpdater(): UpdaterApi {
  const controller = useContext(UpdaterContext);
  const info = useUpdaterInfo();
  const infoData = info.status === "ready" ? info.data : null;
  useEffect(() => {
    if (infoData !== null) controller.sync(infoData);
  }, [controller, infoData]);
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
