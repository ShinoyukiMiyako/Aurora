// 账户：离线、微软设备码（可取消）、外置登录（authlib-injector：探测服务器、认证、多角色时选角色），
// 以及刷新、切换与移除。账户 DTO 绝不含任何令牌；外置登录等待选角色期间的令牌只留在后端内存。
//
// 登录类错误的 code 取后端账户错误枚举的变体名（见 AuthErrorCode），XSTS 拒绝时 detail.xerr 为 XErr 数值；
// 取消一律为 "cancelled"，参数不合法为 "invalid_argument"。

import type { SkinInfoDto } from "./art";
import { invoke, listen, type UnlistenFn } from "./bridge";

export type AccountType = "microsoft" | "offline" | "authlib_injector";

/** ok：凭据可用；expired：续期已被服务器判定失效，只有重新登录才能恢复。 */
export type AccountStatus = "ok" | "expired";

export interface AccountDto {
  uuid: string;
  name: string;
  account_type: AccountType;
  /** 外置登录的验证服务器名；其余类型为 null。 */
  auth_server: string | null;
  /** 加入时刻，毫秒时间戳。同一账户重新登录不改变它。 */
  added_at: number;
  status: AccountStatus;
  /** 最近一次成功验证或续期的时刻，毫秒时间戳；离线账户恒为 null。 */
  last_verified_at: number | null;
}

/** 登录、刷新失败时可能出现的错误码（后端账户错误枚举的变体名）。 */
export type AuthErrorCode =
  | "Base"
  | "Http"
  | "Parse"
  | "Response"
  | "DeviceCodeExpired"
  | "AuthorizationDeclined"
  | "OAuth"
  | "XstsBanned"
  | "XstsNoXboxAccount"
  | "XstsRegionUnavailable"
  | "XstsAdultVerificationRequired"
  | "XstsChildAccount"
  | "XstsUnknown"
  | "MinecraftProfileNotFound"
  | "ReloginRequired"
  | "InvalidUsername"
  | "Yggdrasil"
  | "YggdrasilNoProfile"
  | "NotYggdrasilServer"
  | "AccountNotFound"
  | "CredentialSerialize"
  | "CredentialDeserialize"
  | "Dpapi"
  | "OfflineStoreSerialize"
  | "OfflineStoreDeserialize";

export const DEVICE_CODE_EVENT = "aurora://device-code";

/** 微软登录进入设备码阶段时推送，供界面展示待输入短码与验证网址。 */
export interface DeviceCode {
  user_code: string;
  verification_uri: string;
  /** 秒。 */
  expires_in: number;
  /** 轮询间隔，秒。 */
  interval: number;
  message: string;
}

/** 外置登录验证服务器的探测结果。 */
export interface AuthServerDto {
  /** 解析出的 API 根地址（以 / 结尾）。 */
  api_root: string;
  /** 服务器自报的名字；没写时为主机名。 */
  server_name: string;
  host: string;
}

export interface AuthlibProfileDto {
  uuid: string;
  name: string;
  /** 取不到皮肤时为 null，画剪影。 */
  skin: SkinInfoDto | null;
}

export type AuthlibLoginResult =
  | { status: "logged_in"; account: AccountDto }
  | { status: "select_profile"; pending_id: string; server_name: string; profiles: AuthlibProfileDto[] };

export const currentAccount = (): Promise<AccountDto | null> => invoke<AccountDto | null>("current_account");

/** 微软与外置账户在前，离线账户在后。 */
export const listAccounts = (): Promise<AccountDto[]> => invoke<AccountDto[]>("list_accounts");

/** 保存离线账户并设为当前账户。用户名非标准字符的软性告警经 core-event 的 warning 推送。 */
export const createOfflineAccount = (name: string): Promise<AccountDto> =>
  invoke<AccountDto>("create_offline_account", { name });

/**
 * 在整个登录完成、账户落库并成为当前账户时 resolve；期间经 onDeviceCode 收到待输入短码。
 * 被 cancelMicrosoftLogin 或新的一次登录顶替时以 code "cancelled" 拒绝。
 */
export const microsoftLogin = (): Promise<AccountDto> => invoke<AccountDto>("microsoft_login");

/** 取消正在进行的微软登录；返回此刻是否有登录在进行（没有也不是错误）。 */
export const cancelMicrosoftLogin = (): Promise<boolean> => invoke<boolean>("cancel_microsoft_login");

export const onDeviceCode = (handler: (code: DeviceCode) => void): Promise<UnlistenFn> =>
  listen<DeviceCode>(DEVICE_CODE_EVENT, handler);

/**
 * 探测验证服务器（总时限 10 秒）。没写协议头时按 https 补全。地址不合法报 invalid_argument，
 * 连不上或超时报 Http，连上了但不是验证服务器报 NotYggdrasilServer。
 */
export const probeAuthServer = (url: string): Promise<AuthServerDto> => invoke<AuthServerDto>("probe_auth_server", { url });

/** 外置登录第一步。账号密码错误报 Yggdrasil（detail.error 为服务器给的异常名），账户下没有角色报 YggdrasilNoProfile。 */
export const authlibLogin = (serverUrl: string, username: string, password: string): Promise<AuthlibLoginResult> =>
  invoke<AuthlibLoginResult>("authlib_login", { serverUrl, username, password });

/** 外置登录第二步：绑定所选角色。待选 id 失效或角色不在列表里报 invalid_argument。 */
export const selectAuthlibProfile = (pendingId: string, profileUuid: string): Promise<AccountDto> =>
  invoke<AccountDto>("select_authlib_profile", { pendingId, profileUuid });

/** 刷新名字、皮肤与令牌。凭据失效时账户转为 expired 并报 ReloginRequired；离线账户报 invalid_argument。 */
export const refreshAccount = (uuid: string): Promise<AccountDto> => invoke<AccountDto>("refresh_account", { uuid });

export const setCurrentAccount = (uuid: string): Promise<void> => invoke<void>("set_current_account", { uuid });

export const removeAccount = (uuid: string): Promise<void> => invoke<void>("remove_account", { uuid });
