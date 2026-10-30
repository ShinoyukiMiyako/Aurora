// 账户：离线、微软设备码、外置登录（authlib-injector），以及当前账户的切换与移除。
// 账户 DTO 只含 uuid / name / account_type，绝不含任何令牌。

import { invoke, listen, type UnlistenFn } from "./bridge";

export type AccountType = "microsoft" | "offline" | "authlib_injector";

export interface AccountDto {
  uuid: string;
  name: string;
  account_type: AccountType;
}

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

export const currentAccount = (): Promise<AccountDto | null> => invoke<AccountDto | null>("current_account");

export const createOfflineAccount = (name: string): Promise<AccountDto> =>
  invoke<AccountDto>("create_offline_account", { name });

/** 在整个登录完成时 resolve；期间经 onDeviceCode 收到待输入短码。 */
export const microsoftLogin = (): Promise<AccountDto> => invoke<AccountDto>("microsoft_login");

export const authlibLogin = (serverUrl: string, username: string, password: string): Promise<AccountDto> =>
  invoke<AccountDto>("authlib_login", { serverUrl, username, password });

export const listAccounts = (): Promise<AccountDto[]> => invoke<AccountDto[]>("list_accounts");

export const setCurrentAccount = (uuid: string): Promise<void> => invoke<void>("set_current_account", { uuid });

export const removeAccount = (uuid: string): Promise<void> => invoke<void>("remove_account", { uuid });

export const onDeviceCode = (handler: (code: DeviceCode) => void): Promise<UnlistenFn> =>
  listen<DeviceCode>(DEVICE_CODE_EVENT, handler);
