// 账户胶囊：标题栏右列的当前账户，点开是账户切换菜单。没有账户时是「添加账户」，直接去账户页。
// 宽度按档：compact 只留头像，regular 头像 + 名字，wide 再加一行账户类型。当前账户需要重新登录时头像角上挂提醒点。
//
// 切换菜单的行带头像与两行文字，通用菜单画不了，这里自己实现同一套键盘约定：
// 打开即聚焦当前账户，↑↓ 循环移动，Home / End 到首尾，Enter / Space 执行，Esc 关闭并把焦点还给胶囊。

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Icon } from "../art/Icon";
import type { SkinRef } from "../art/skin/layout";
import { AccountAvatar } from "../art/skin/AccountAvatar";
import { ACTION_ERROR, NEXT_LAUNCH_SUFFIX, TOAST_COPY, accountKindLabel } from "../copy/flows";
import type { Account } from "../domain/adapt";
import { isImeComposing } from "../lib/util";
import { useLauncherActions, useLauncherSelector } from "../state/launcher";
import { useSkinInfo } from "../state/queries/home";
import { activeAccount, busyInstanceId } from "../state/selectors";
import { Popover } from "../ui/Popover";
import { Tooltip } from "../ui/Tooltip";
import styles from "./AccountCapsule.module.css";
import { ACCOUNT_COPY, SHELL_ACTION_ERROR } from "../copy/shell";
import { useNav, useShell } from "./shell";
import { useRunner } from "./useRunner";

/** 账户的皮肤；读取失败经外层统一错误处理报告，头像退回剪影（与「没有皮肤」同样的画法）。 */
export function useAccountSkin(uuid: string): SkinRef | null {
  const skin = useSkinInfo(uuid);
  const run = useRunner();
  const error = skin.status === "error" ? skin.error : null;
  useEffect(() => {
    if (error !== null) void run(() => Promise.reject(error), SHELL_ACTION_ERROR.skin);
  }, [error, run]);
  if (skin.status === "loading" || skin.data === undefined) return null;
  return skin.data;
}

/** 账户行的第二行：需要重新登录时说明这一点，否则写账户类型。 */
export function accountLine(account: Account): string {
  return account.status === "expired" ? ACCOUNT_COPY.needsRelogin : accountKindLabel(account.kind, account.authServer);
}

/** 切换当前账户：成功后弹一条通知，游戏占着进程时说明只影响下一次启动。选中的已是当前账户时什么都不做。 */
export function useSwitchAccount(): (account: Account) => void {
  const actions = useLauncherActions();
  const currentId = useLauncherSelector((s) => s.currentAccountId);
  const gameBusy = useLauncherSelector((s) => busyInstanceId(s) !== null);
  const run = useRunner();
  return (account) => {
    if (account.uuid === currentId) return;
    const body = `${accountKindLabel(account.kind, account.authServer)}${gameBusy ? NEXT_LAUNCH_SUFFIX : ""}`;
    void run(() => actions.selectAccount(account.uuid), ACTION_ERROR.selectAccount).then((result) => {
      if (result.ok) actions.toast("success", TOAST_COPY.accountSwitched(account.name), body);
    });
  };
}

export function AccountCapsule() {
  const current = useLauncherSelector(activeAccount);
  const accounts = useLauncherSelector((s) => s.accounts);
  const { tier } = useShell();
  const { route, go } = useNav();
  const switchTo = useSwitchAccount();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const onAccountsPage = route.page === "accounts";

  if (current === null) {
    const button = (
      <button
        type="button"
        className={styles.add}
        data-compact={tier === "compact" || undefined}
        data-here={onAccountsPage || undefined}
        aria-label={ACCOUNT_COPY.addLabel}
        onClick={() => go({ page: "accounts" })}
      >
        <Icon name="user" size={16} />
        {tier !== "compact" && <span>{ACCOUNT_COPY.add}</span>}
      </button>
    );
    return tier === "compact" ? (
      <Tooltip content={ACCOUNT_COPY.add} side="bottom">
        {button}
      </Tooltip>
    ) : (
      button
    );
  }

  const close = () => setOpen(false);
  const pick = (account: Account) => {
    close();
    switchTo(account);
  };
  const manage = () => {
    close();
    go({ page: "accounts" });
  };

  const kind = accountLine(current);
  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        className={styles.capsule}
        data-compact={tier === "compact" || undefined}
        data-here={onAccountsPage || undefined}
        data-open={open || undefined}
        aria-label={ACCOUNT_COPY.current(current.name, kind)}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <CapsuleAvatar account={current} />
        {tier !== "compact" && (
          <span className={styles.text}>
            <span className={styles.name}>{current.name}</span>
            {tier === "wide" && (
              <span className={styles.kind} data-expired={current.status === "expired" || undefined}>
                {kind}
              </span>
            )}
          </span>
        )}
      </button>
      <Popover open={open} anchor={anchor} onClose={close} placement="bottom-end" role="presentation">
        <AccountMenu accounts={accounts} currentId={current.uuid} onPick={pick} onManage={manage} />
      </Popover>
    </>
  );
}

function CapsuleAvatar({ account }: { account: Account }) {
  const skin = useAccountSkin(account.uuid);
  return (
    <span className={styles.avatar}>
      <AccountAvatar uuid={account.uuid} skin={skin} size={24} />
      {account.status === "expired" && <span className={styles.warnDot} aria-hidden="true" />}
    </span>
  );
}

interface AccountMenuProps {
  accounts: readonly Account[];
  currentId: string;
  onPick: (account: Account) => void;
  onManage: () => void;
}

function AccountMenu({ accounts, currentId, onPick, onManage }: AccountMenuProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const items = () => (listRef.current === null ? [] : [...listRef.current.querySelectorAll<HTMLElement>("[data-menu-item]")]);

  useLayoutEffect(() => {
    const all = items();
    const target = all.find((el) => el.dataset.current !== undefined);
    if (target === undefined) throw new Error("账户菜单里没有当前账户");
    target.focus();
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (isImeComposing(event)) return;
    const all = items();
    const from = all.findIndex((el) => el === document.activeElement);
    let next: number;
    switch (event.key) {
      case "ArrowDown":
        next = (from + 1) % all.length;
        break;
      case "ArrowUp":
        next = from <= 0 ? all.length - 1 : from - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = all.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    all[next].focus();
  };

  return (
    <div ref={listRef} className={styles.menu} role="menu" aria-label={ACCOUNT_COPY.menuLabel} onKeyDown={onKeyDown}>
      {accounts.map((account) => (
        <AccountRow key={account.uuid} account={account} current={account.uuid === currentId} onPick={() => onPick(account)} />
      ))}
      <div className={styles.separator} role="separator" />
      <button type="button" className={styles.item} role="menuitem" tabIndex={-1} data-menu-item="" onClick={onManage}>
        <span className={styles.manageIcon} aria-hidden="true">
          <Icon name="users" size={16} />
        </span>
        <span className={styles.itemText}>
          <span className={styles.itemName}>{ACCOUNT_COPY.manage}</span>
          <span className={styles.itemLine}>{ACCOUNT_COPY.manageHint}</span>
        </span>
      </button>
    </div>
  );
}

function AccountRow({ account, current, onPick }: { account: Account; current: boolean; onPick: () => void }) {
  const skin = useAccountSkin(account.uuid);
  return (
    <button
      type="button"
      className={styles.item}
      role="menuitemradio"
      aria-checked={current}
      tabIndex={-1}
      data-menu-item=""
      data-current={current || undefined}
      onClick={onPick}
    >
      <AccountAvatar uuid={account.uuid} skin={skin} size={32} current={current} />
      <span className={styles.itemText}>
        <span className={styles.itemName}>{account.name}</span>
        <span className={styles.itemLine} data-expired={account.status === "expired" || undefined}>
          {accountLine(account)}
        </span>
      </span>
      {current && (
        <span className={styles.check} aria-hidden="true">
          <Icon name="check" size={16} />
        </span>
      )}
    </button>
  );
}
