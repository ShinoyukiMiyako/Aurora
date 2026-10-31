// 外层统一错误处理：界面事件处理器一律经 run(work, title) 调用动作。动作的 rejection 在这里转成 error 通知
// （标题由调用方按文案表给出，正文为错误原文）并把原错误写进控制台；页面与 state 里不写 try/catch。
// 用户主动取消（cancelled）是正常结局，不弹通知，只记一行信息日志。

import { useCallback } from "react";
import { isCancelled } from "../ipc/errors";
import { describeError } from "../state/errors";
import { useLauncherActions } from "../state/launcher";

export type RunResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** 执行一个动作；返回的 Promise 永不 reject，调用方需要结果时按 ok 分支，不需要时可以直接丢弃。 */
export type Runner = <T>(work: () => T | Promise<T>, title: string) => Promise<RunResult<T>>;

export interface RunReporter {
  error(title: string, body: string): void;
}

/**
 * run 的本体，与 React 无关，供测试与外壳内部的非组件代码复用。work 同步抛错与异步 reject 同样处理。
 */
export async function runGuarded<T>(work: () => T | Promise<T>, title: string, reporter: RunReporter): Promise<RunResult<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    if (isCancelled(error)) {
      console.info(`${title}：已取消`);
      return { ok: false, error };
    }
    console.error(title, error);
    reporter.error(title, describeError(error));
    return { ok: false, error };
  }
}

/** 只取动作、不订阅状态：外壳各处都调用它，订阅整份状态会让调用方随每次下载进度与游戏日志重渲染。 */
export function useRunner(): Runner {
  const actions = useLauncherActions();
  return useCallback<Runner>(
    (work, title) =>
      runGuarded(work, title, {
        error: (t, body) => {
          actions.toast("error", t, body);
        },
      }),
    [actions],
  );
}
