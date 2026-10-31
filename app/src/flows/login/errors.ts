// 外置登录的错误归类：探测服务器与登录两步各自要把后端错误码翻成弹窗里的原位提示。
// 流程层不引用 ipc：错误码与原文经 state/errors 取，附加字段（detail）按结构读取。

import { AUTHLIB_COPY } from "../../copy/flows";
import { errorRecord } from "../../state/errors";
import { AUTHLIB_DIALOG_COPY } from "./copy";

function detailOf(error: unknown): unknown {
  return typeof error === "object" && error !== null && "detail" in error ? (error as { detail: unknown }).detail : null;
}

function detailField(error: unknown, key: string): string | null {
  const detail = detailOf(error);
  if (typeof detail !== "object" || detail === null) return null;
  const value = (detail as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

export interface InlineProblem {
  title: string;
  body: string;
}

/** 探测服务器失败里能原位提示的三种：连不上、不是外置登录服务器、地址无效。其余为 null，交给外层统一处理。 */
export function probeProblem(error: unknown): InlineProblem | null {
  const { code, message } = errorRecord(error);
  switch (code) {
    case "Http":
      return AUTHLIB_COPY.unreachable;
    case "NotYggdrasilServer":
      return AUTHLIB_COPY.notYggdrasil;
    case "invalid_argument":
      return { title: AUTHLIB_DIALOG_COPY.invalidUrl, body: message };
    default:
      return null;
  }
}

export type LoginProblem =
  /** 账户或密码不正确：提示挂在密码框下，清空并聚焦密码框。 */
  | { kind: "credentials" }
  /** 网络失败：可以原样重试。 */
  | { kind: "network" }
  | { kind: "no_profile" }
  /** 认证服务器拒绝了这次登录（被封禁、请求过于频繁等）：原位显示服务器给的说明。 */
  | { kind: "rejected"; message: string };

/** 登录失败里能原位提示的；不是认证服务器给出的错误为 null，交给外层统一处理。 */
export function loginProblem(error: unknown): LoginProblem | null {
  const { code, message } = errorRecord(error);
  if (code === "Yggdrasil" && detailField(error, "error") === "ForbiddenOperationException") return { kind: "credentials" };
  if (code === "Http") return { kind: "network" };
  if (code === "YggdrasilNoProfile") return { kind: "no_profile" };
  if (code !== "Yggdrasil") return null;
  const serverMessage = detailField(error, "error_message");
  return { kind: "rejected", message: serverMessage === null ? message : serverMessage };
}

/** 地址的规范写法：去掉首尾空白，没写协议时补 https://。 */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "") return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}
