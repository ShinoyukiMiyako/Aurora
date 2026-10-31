// 账户页上各处共用的动作：切换、删除、刷新、重新登录、复制 UUID。全部经 useRunner 走外层统一错误处理，
// 页面不自己捕获。切换的结果在本页原位可见（聚光卡换人、描边移动），所以不弹通知；删除的通知由状态层发。

import { useState } from "react";
import { ACTION_ERROR, TOAST_COPY } from "../../copy/flows";
import type { Account } from "../../domain/adapt";
import { useShell } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import { useLauncher } from "../../state/launcher";
import { MANUAL_LOGIN } from "../../state/login";
import { invalidate } from "../../state/resource";
import { busyInstanceId } from "../../state/selectors";
import { ACCOUNTS_COPY } from "./copy";
import { deleteConfirm } from "./model";

export interface AccountActions {
  switchTo(uuid: string): void;
  remove(account: Account): void;
  refresh(uuid: string): void;
  relogin(uuid: string): void;
  /** 复制按钮用：成功 resolve；失败已经弹过「复制失败」，再以原错误 reject，按钮不显示「已复制」。 */
  copyText(text: string): Promise<void>;
  /** 菜单项用：菜单选中即关闭，没有原位反馈的位置，只在失败时报错。 */
  copyFromMenu(text: string): void;
  /** 正在刷新的账户（按钮显示进行中）。 */
  refreshing: ReadonlySet<string>;
}

function writeClipboard(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}

export function useAccountActions(): AccountActions {
  const { state, actions } = useLauncher();
  const { confirm } = useShell();
  const run = useRunner();
  const [refreshing, setRefreshing] = useState<ReadonlySet<string>>(() => new Set());

  const switchTo = (uuid: string) => void run(() => actions.selectAccount(uuid), ACTION_ERROR.selectAccount);

  const remove = (account: Account) => {
    const session = state.session;
    const usedByRunningGame = busyInstanceId(state) !== null && session !== null && session.accountUuid === account.uuid;
    const copy = deleteConfirm(account, state.accounts, state.currentAccountId, usedByRunningGame);
    void confirm({ ...copy, tone: "danger" }).then((ok) => {
      if (ok) void run(() => actions.removeAccount(account.uuid), ACTION_ERROR.removeAccount);
    });
  };

  const refresh = (uuid: string) => {
    setRefreshing((prev) => new Set(prev).add(uuid));
    void run(async () => {
      await actions.refreshAccount(uuid);
      // 刷新会重新拉取皮肤，缓存里的旧皮肤信息要作废
      invalidate(`skin:${uuid}`);
      actions.toast("success", ACCOUNTS_COPY.refreshed);
    }, ACTION_ERROR.refreshAccount).then(() =>
      setRefreshing((prev) => {
        const next = new Set(prev);
        next.delete(uuid);
        return next;
      }),
    );
  };

  const relogin = (uuid: string) => void run(() => actions.relogin(uuid, MANUAL_LOGIN), ACTION_ERROR.relogin);

  const copyText = async (text: string) => {
    const result = await run(() => writeClipboard(text), TOAST_COPY.copyFailed);
    if (!result.ok) throw result.error;
  };

  const copyFromMenu = (text: string) => void run(() => writeClipboard(text), TOAST_COPY.copyFailed);

  return { switchTo, remove, refresh, relogin, copyText, copyFromMenu, refreshing };
}
