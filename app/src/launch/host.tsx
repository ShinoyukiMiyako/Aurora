// 启动层向外壳要的三样能力：经外层统一错误处理执行动作、导航、命令式确认。
// 依赖方向上启动层不能引用外壳，所以由外壳在 ShellProvider 里提供这个上下文，形状在这里定义。

import { createContext, useContext, type ReactNode } from "react";
import type { Route } from "../state/route";
import type { ConfirmDialogProps } from "../ui/ConfirmDialog";

export type RunOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** 命令式确认的入参，与 ConfirmDialog 的同名属性一致。 */
export type ConfirmOptions = Pick<ConfirmDialogProps, "title" | "body" | "confirmLabel" | "cancelLabel" | "tone">;

export interface LaunchHost {
  /** 执行动作；失败转成 error 通知并写控制台，返回的 Promise 不 reject。 */
  run<T>(work: () => T | Promise<T>, title: string): Promise<RunOutcome<T>>;
  go(route: Route): void;
  /** 弹确认框；确认为 true，取消、Esc、被新的确认顶掉为 false。 */
  confirm(options: ConfirmOptions): Promise<boolean>;
}

const LaunchHostContext = createContext<LaunchHost | null>(null);

export function LaunchHostProvider({ host, children }: { host: LaunchHost; children: ReactNode }) {
  return <LaunchHostContext.Provider value={host}>{children}</LaunchHostContext.Provider>;
}

export function useLaunchHost(): LaunchHost {
  const host = useContext(LaunchHostContext);
  if (host === null) throw new Error("启动层组件必须放在 ShellProvider 之内");
  return host;
}
