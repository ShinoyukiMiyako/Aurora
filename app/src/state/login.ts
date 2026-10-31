// 登录流程的全局状态：设备码、离线账户、外置登录三个弹窗与启动时的「还没有账户」，都由外壳挂载、
// 由这里的状态驱动，从任何入口（账户页、标题栏、启动拦截、令牌失效）都能弹出。

import type { Account } from "../domain/adapt";

/** 登录完成后要做的事：手动登录只关弹窗；由启动拦截触发的登录成功后自动继续这次启动。 */
export type LoginIntent = { kind: "manual" } | { kind: "launch"; instanceId: string };

export const MANUAL_LOGIN: LoginIntent = { kind: "manual" };

export type DeviceLogin =
  /** 已调用 microsoft_login，等待设备码事件。 */
  | { status: "requesting"; startedAt: number }
  /** 已拿到代码；过期由界面按 expiresAt 判定，不等后端错误到达。 */
  | { status: "waiting"; userCode: string; verificationUri: string; expiresAt: number; intervalSec: number }
  /** updated：同一 UUID 的账户原先就在，这次是刷新登录。 */
  | { status: "success"; account: Account; updated: boolean }
  | { status: "failed"; code: string; message: string; detail: unknown };

/**
 * 外置登录重新登录时预填的内容：弹窗直接停在第二步，密码为空。API 根地址是上次登录时解析好的，
 * 服务器名随账户存着，不必再探测一次服务器。
 */
export interface AuthlibPrefill {
  serverUrl: string;
  serverName: string;
  /** 上次登录填的账号；较早登录的账户没有记下，为 null。 */
  username: string | null;
}

export type LoginState =
  | { kind: "no_account"; intent: LoginIntent }
  | { kind: "microsoft"; intent: LoginIntent; device: DeviceLogin }
  | { kind: "offline"; intent: LoginIntent }
  | { kind: "authlib"; intent: LoginIntent; prefill: AuthlibPrefill | null };

export type LoginKind = "microsoft" | "offline" | "authlib";

/** 设备码剩余有效期（毫秒，不小于 0）；只对 waiting 有意义。 */
export function deviceCodeRemaining(device: Extract<DeviceLogin, { status: "waiting" }>, now: number): number {
  return Math.max(0, device.expiresAt - now);
}

export function deviceCodeExpired(device: DeviceLogin, now: number): boolean {
  return device.status === "waiting" && now >= device.expiresAt;
}
