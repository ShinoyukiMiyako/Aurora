// 账户页上各处共用的动作：切换、删除、刷新、重新登录、复制 UUID。全部经 useRunner 或外壳的 copyText 走外层统一错误处理，
// 页面不自己捕获。切换的结果在本页原位可见（聚光卡换人、描边移动），所以不弹通知；删除的通知由状态层发。

import { useState } from "react";
import { ACTION_ERROR } from "../../copy/flows";
import type { Account } from "../../domain/adapt";
import { useShell } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import { useLauncherActions, useLauncherSelector } from "../../state/launcher";
import { MANUAL_LOGIN } from "../../state/login";
import { busyInstanceId } from "../../state/selectors";
import { ACCOUNTS_COPY } from "./copy";
import { deleteConfirm } from "./model";

export interface AccountActions {
  switchTo(uuid: string): void;
  remove(account: Account): void;
  refresh(uuid: string): void;
  relogin(uuid: string): void;
  /** 复制按钮用：写进去为 true；失败已经弹过「复制失败」，为 false，按钮不显示「已复制」。永不 reject。 */
  copyText(text: string): Promise<boolean>;
  /** 菜单项用：菜单选中即关闭，没有原位反馈的位置，只在失败时报错。 */
  copyFromMenu(text: string): void;
  /** 正在刷新的账户（按钮显示进行中）。 */
  refreshing: ReadonlySet<string>;
}

export function useAccountActions(): AccountActions {
  const accounts = useLauncherSelector((s) => s.accounts);
  const currentAccountId = useLauncherSelector((s) => s.currentAccountId);
  // 正在运行的游戏用的是哪个账户：删除确认要说明游戏不受影响
  const gameAccount = useLauncherSelector((s) => (busyInstanceId(s) !== null && s.session !== null ? s.session.accountUuid : null));
  const actions = useLauncherActions();
  const { confirm, copyText } = useShell();
  const run = useRunner();
  const [refreshing, setRefreshing] = useState<ReadonlySet<string>>(() => new Set());

  const switchTo = (uuid: string) => void run(() => actions.selectAccount(uuid), ACTION_ERROR.selectAccount);

  const remove = (account: Account) => {
    const copy = deleteConfirm(account, accounts, currentAccountId, gameAccount === account.uuid);
    void confirm({ ...copy, tone: "danger" }).then((ok) => {
      if (ok) void run(() => actions.removeAccount(account.uuid), ACTION_ERROR.removeAccount);
    });
  };

  const refresh = (uuid: string) => {
    setRefreshing((prev) => new Set(prev).add(uuid));
    void run(async () => {
      // 凭据失效时账户已转为 expired、原位给出重新登录，不算失败也不弹成功；皮肤缓存由状态层作废
      if ((await actions.refreshAccount(uuid)) === "refreshed") actions.toast("success", ACCOUNTS_COPY.refreshed);
    }, ACTION_ERROR.refreshAccount).then(() =>
      setRefreshing((prev) => {
        const next = new Set(prev);
        next.delete(uuid);
        return next;
      }),
    );
  };

  const relogin = (uuid: string) => void run(() => actions.relogin(uuid, MANUAL_LOGIN), ACTION_ERROR.relogin);

  const copyFromMenu = (text: string) => void copyText(text);

  return { switchTo, remove, refresh, relogin, copyText, copyFromMenu, refreshing };
}
