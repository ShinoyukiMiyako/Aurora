// 账户页的纯推导：类型行、验证方式、卡片底部状态、删除后会切到谁，以及删除确认的正文。
// 与 React 无关，便于逐条覆盖边界。

import type { IconName } from "../../art/Icon";
import { accountKindLabel } from "../../copy/flows";
import type { Account } from "../../domain/adapt";
import type { AccountKind } from "../../domain/types";
import { ACCOUNTS_COPY, DELETE_COPY } from "./copy";

export const KIND_ICON: Readonly<Record<AccountKind, IconName>> = {
  microsoft: "shield",
  authlib: "server",
  offline: "user",
};

/** 凭据账户（微软、外置登录）有令牌，能刷新与重新登录；它们与离线账户分两个库存放，删除后的回落规则各不相同。 */
export function isCredential(account: Account): boolean {
  return account.kind !== "offline";
}

/** 外置登录账户必有服务器名（适配层已校验），这里再取一次是为了让类型收窄。 */
function serverOf(account: Account): string {
  if (account.authServer === null) throw new Error(`外置登录账户 ${account.name} 缺少服务器名`);
  return account.authServer;
}

export type KindLineTone = "ok" | "warn" | "default";

/** 聚光卡类型行：微软账户正常时标「正版已验证」用成功色，凭据失效时一律警示色标「需要重新登录」。 */
export function kindLine(account: Account): { text: string; tone: KindLineTone } {
  const label = accountKindLabel(account.kind, account.authServer);
  if (account.status === "expired") return { text: `${label} · ${ACCOUNTS_COPY.reloginSuffix}`, tone: "warn" };
  if (account.kind === "microsoft") return { text: `${label} · ${ACCOUNTS_COPY.verifiedSuffix}`, tone: "ok" };
  return { text: label, tone: "default" };
}

export function verifyMethod(account: Account): string {
  switch (account.kind) {
    case "microsoft":
      return ACCOUNTS_COPY.method.microsoft;
    case "authlib":
      return ACCOUNTS_COPY.method.authlib(serverOf(account));
    case "offline":
      return ACCOUNTS_COPY.method.offline;
  }
}

const BARE_UUID = /^[0-9a-f]{32}$/i;

/**
 * 界面上展示与复制的 UUID：后端存的是不带连字符的 32 位十六进制，按 8-4-4-4-12 分段，与游戏内、皮肤站显示的一致。
 * 已经带连字符或不是这种形状的原样给出，不猜测改写。
 */
export function displayUuid(uuid: string): string {
  if (!BARE_UUID.test(uuid)) return uuid;
  const u = uuid.toLowerCase();
  return `${u.slice(0, 8)}-${u.slice(8, 12)}-${u.slice(12, 16)}-${u.slice(16, 20)}-${u.slice(20)}`;
}

export type CardFoot =
  /** 当前账户：「使用中」，凭据失效时另带警示标（重新登录的主按钮在聚光卡上）。 */
  | { kind: "current"; expired: boolean }
  /** 非当前且凭据失效：警示标 + 「重新登录」。 */
  | { kind: "expired" }
  | { kind: "switch" };

export function cardFoot(account: Account, isCurrent: boolean): CardFoot {
  if (isCurrent) return { kind: "current", expired: account.status === "expired" };
  if (account.status === "expired") return { kind: "expired" };
  return { kind: "switch" };
}

export type NextAfterRemoval =
  /** 删的不是当前账户，当前账户不变。 */
  | { kind: "unchanged" }
  | { kind: "switch"; account: Account }
  /** 删的是当前离线账户、没有别的离线账户，且凭据账户不止一个：后端回到上次选中的那个，前端不知道是谁。 */
  | { kind: "previous_credential" }
  | { kind: "last" };

/**
 * 预测删除后的当前账户，与后端的回落规则一致：
 * - 删当前凭据账户：凭据库里剩下的第一个；凭据库空了再取离线库的第一个。
 * - 删当前离线账户：离线库里剩下的第一个；离线库空了就回到凭据库自己的选中项（只剩一个凭据账户时就是它）。
 * 列表顺序就是后端顺序（凭据账户在前、离线账户在后，各自按库内顺序）。
 */
export function nextAfterRemoval(accounts: readonly Account[], currentId: string | null, removedUuid: string): NextAfterRemoval {
  if (currentId !== removedUuid) return { kind: "unchanged" };
  const removed = accounts.find((a) => a.uuid === removedUuid);
  if (removed === undefined) throw new Error(`账户 ${removedUuid} 不在列表里`);
  const rest = accounts.filter((a) => a.uuid !== removedUuid);
  const credentials = rest.filter(isCredential);
  const offline = rest.filter((a) => !isCredential(a));
  if (isCredential(removed)) {
    const next = credentials.length > 0 ? credentials[0] : offline[0];
    return next === undefined ? { kind: "last" } : { kind: "switch", account: next };
  }
  if (offline.length > 0) return { kind: "switch", account: offline[0] };
  if (credentials.length === 0) return { kind: "last" };
  if (credentials.length === 1) return { kind: "switch", account: credentials[0] };
  return { kind: "previous_credential" };
}

export interface DeleteConfirm {
  title: string;
  body: string;
  confirmLabel: string;
}

/**
 * 删除确认：基本后果 + 当前账户会切到谁（或这是最后一个）+ 微软账户要重新走设备码 +
 * 正在运行的游戏用的就是它时说明游戏不受影响。
 */
export function deleteConfirm(account: Account, accounts: readonly Account[], currentId: string | null, usedByRunningGame: boolean): DeleteConfirm {
  const parts: string[] = [DELETE_COPY.base];
  const next = nextAfterRemoval(accounts, currentId, account.uuid);
  if (next.kind === "switch") parts.push(DELETE_COPY.switchTo(next.account.name));
  else if (next.kind === "previous_credential") parts.push(DELETE_COPY.switchToPreviousCredential);
  else if (next.kind === "last") parts.push(DELETE_COPY.last);
  if (account.kind === "microsoft") parts.push(DELETE_COPY.microsoft);
  if (usedByRunningGame) parts.push(DELETE_COPY.running);
  return { title: DELETE_COPY.title(account.name), body: parts.join(""), confirmLabel: DELETE_COPY.confirm };
}
