// 启动提示：后端在启动时遇到、但不妨碍继续运行的问题（例如配置文件损坏、已按默认设置启动并把坏文件留作现场），
// 由外壳在启动后读一次，逐条以 warning 通知显示。读取本身失败经外层统一错误处理报告。
// 读取函数由 App 注入：外壳只定显示规则，取数的命令由后端定义。

import { useEffect, useRef } from "react";
import { SHELL_ACTION_ERROR } from "../copy/shell";
import { useLauncher } from "../state/launcher";
import { useRunner } from "./useRunner";

/** 与命令错误同形：code 为稳定的机器码，message 为直接显示的中文原文，detail 为排查用的结构化参数。 */
export interface StartupNotice {
  code: string;
  message: string;
  detail?: unknown;
}

/** 整个应用运行期间只读一次：StrictMode 的二次挂载、外壳布局重渲染都不再读。 */
export function useStartupNotices(load: (() => Promise<readonly StartupNotice[]>) | undefined): void {
  const { actions } = useLauncher();
  const run = useRunner();
  const loaded = useRef(false);

  useEffect(() => {
    if (load === undefined || loaded.current) return;
    loaded.current = true;
    void run(load, SHELL_ACTION_ERROR.startupNotices).then((result) => {
      if (!result.ok) return;
      for (const notice of result.value) actions.toast("warning", notice.message);
    });
  }, [actions, load, run]);
}
