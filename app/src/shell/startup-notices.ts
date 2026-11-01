// 启动提示：后端在启动时遇到、但不妨碍继续运行的问题（例如配置文件损坏、已按默认设置启动并把坏文件留作现场），
// 由外壳在启动后读一次，逐条以 warning 通知显示。读取本身失败经外层统一错误处理报告。
// 读取函数由 App 注入（真实实现是这里的 loadStartupNotices）：测试可以换成替身，不注入时外壳什么都不读。

import { useEffect, useRef } from "react";
import { SHELL_ACTION_ERROR, STARTUP_NOTICE_COPY } from "../copy/shell";
import { openFolder } from "../ipc/instances";
import { startupNotices, type StartupNoticeDto } from "../ipc/system";
import { useLauncherActions } from "../state/launcher";
import type { ToastAction } from "../state/toasts";
import { useRunner } from "./useRunner";

/** 一条启动提示的呈现：标题说清出了什么事，正文说清结果，至多一个动作。 */
export interface StartupNotice {
  title: string;
  body?: string;
  action?: ToastAction;
}

/** 后端提示到呈现的对照；认不出的 kind 说明前后端版本不一致，直接抛错，不当作没有提示。 */
export function describeStartupNotice(notice: StartupNoticeDto): StartupNotice {
  switch (notice.kind) {
    case "data_dir_unwritable":
      // 用户要的是一句「数据没丢」和为什么写不进去，所以原因进正文，不只留在日志里：这时日志多半也写不进去
      return {
        title: STARTUP_NOTICE_COPY.dataDirUnwritable.title,
        body: STARTUP_NOTICE_COPY.dataDirUnwritable.body(notice.reason),
        action: { label: STARTUP_NOTICE_COPY.dataDirUnwritable.action, run: () => openFolder("data_dir", null), errorTitle: SHELL_ACTION_ERROR.openDataDir },
      };
    case "config_reset":
      // 坏文件的完整路径与解析错误后端已写进启动器日志；通知里只说结果，给出打开数据目录的入口
      return {
        title: STARTUP_NOTICE_COPY.configReset.title,
        body: STARTUP_NOTICE_COPY.configReset.body,
        action: { label: STARTUP_NOTICE_COPY.configReset.action, run: () => openFolder("data_dir", null), errorTitle: SHELL_ACTION_ERROR.openDataDir },
      };
    case "config_fields_reset": {
      // 后端只在至少退回一项时发这条；空列表或认不出的字段同样说明前后端版本不一致
      if (notice.fields.length === 0) throw new Error("字段级重置的启动提示没有带任何字段");
      const copy = STARTUP_NOTICE_COPY.configFieldsReset;
      const items = notice.fields.map(({ field, value }) => {
        const label: string | undefined = Object.hasOwn(copy.fields, field) ? copy.fields[field] : undefined;
        if (label === undefined) throw new Error(`不认识的配置字段：${JSON.stringify(field)}`);
        return copy.item(label, value);
      });
      return { title: copy.title(notice.fields.length), body: copy.body(items) };
    }
    case "credentials_reset":
      // 留存的完整路径与原因后端已写进启动器日志；原文件就在数据目录里，通知说清后果，给出打开数据目录的入口
      return {
        title: STARTUP_NOTICE_COPY.credentialsReset.title,
        body: STARTUP_NOTICE_COPY.credentialsReset.body,
        action: { label: STARTUP_NOTICE_COPY.credentialsReset.action, run: () => openFolder("data_dir", null), errorTitle: SHELL_ACTION_ERROR.openDataDir },
      };
    default: {
      // 类型上已穷尽，运行期到这里的是新版后端的提示：只报它的 kind
      const unknown: never = notice;
      const stray: { kind: unknown } = unknown;
      throw new Error(`不认识的启动提示类型：${JSON.stringify(stray.kind)}`);
    }
  }
}

/** startup_notices 的真实读取：逐条换成呈现。 */
export async function loadStartupNotices(): Promise<StartupNotice[]> {
  return (await startupNotices()).map(describeStartupNotice);
}

/** 整个应用运行期间只读一次：StrictMode 的二次挂载、外壳布局重渲染都不再读。 */
export function useStartupNotices(load: (() => Promise<readonly StartupNotice[]>) | undefined): void {
  const actions = useLauncherActions();
  const run = useRunner();
  const loaded = useRef(false);

  useEffect(() => {
    if (load === undefined || loaded.current) return;
    loaded.current = true;
    void run(load, SHELL_ACTION_ERROR.startupNotices).then((result) => {
      if (!result.ok) return;
      for (const notice of result.value) actions.toast("warning", notice.title, notice.body, { action: notice.action });
    });
  }, [actions, load, run]);
}
