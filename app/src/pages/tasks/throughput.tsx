// 下载任务页的吞吐采样范围：曲线与运行中任务行的剩余时间共用同一份「最近 N 秒」采样。
// 采样要读运行中任务的实时速度，而页面本身只订阅任务表的结构（进度变了不重排），所以由这里单独订阅运行中的任务、
// 每秒采一次，经上下文交给吞吐卡与运行中的任务行。这一层的 children 由页面给出，进度更新时只有它自己重渲染，
// 子树原样沿用；每秒换一次采样时，只有读采样的部件跟着重渲染。

import { createContext, use, type ReactNode } from "react";
import { shallowArrayEqual, useLauncherSelector } from "../../state/launcher";
import { useThroughput } from "./hooks";
import type { ThroughputSample } from "./model";

const ThroughputContext = createContext<readonly ThroughputSample[] | null>(null);

export function ThroughputScope({ children }: { children: ReactNode }) {
  const running = useLauncherSelector((s) => s.tasks.filter((t) => t.status === "running"), shallowArrayEqual);
  const history = useThroughput(running);
  return <ThroughputContext.Provider value={history}>{children}</ThroughputContext.Provider>;
}

/**
 * 最近 N 秒的吞吐采样；只能在 ThroughputScope 之内、渲染期间调用。可以按条件调用（React 的 use 读上下文不受调用顺序约束）：
 * 部件只在真的读了采样的那几次渲染之后随采样更新：吞吐卡总是读，任务列表里只有运行中的行读。
 */
export function readThroughputHistory(): readonly ThroughputSample[] {
  const history = use(ThroughputContext);
  if (history === null) throw new Error("吞吐采样只能在 ThroughputScope 之内读取");
  return history;
}
