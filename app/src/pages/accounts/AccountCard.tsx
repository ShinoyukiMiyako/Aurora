// 账户卡：舞台（类型短标、更多菜单、立绘）+ 名称与类型 + 底部状态。当前账户卡带选中描边。

import type { Account } from "../../domain/adapt";
import { accountKindLabel } from "../../copy/flows";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import type { MenuEntry } from "../../ui/Menu";
import { MoreMenu } from "../../ui/MoreMenu";
import { Tag } from "../../ui/Tag";
import styles from "./accounts.module.css";
import { ACCOUNTS_COPY, KIND_SHORT } from "./copy";
import { cardFoot, displayUuid, isCredential, KIND_ICON } from "./model";
import { Stage } from "./Stage";
import type { AccountActions } from "./useAccountActions";

export interface AccountCardProps {
  account: Account;
  current: boolean;
  online: boolean;
  act: AccountActions;
}

export function AccountCard({ account, current, online, act }: AccountCardProps) {
  const foot = cardFoot(account, current);
  const offlineReason = online ? undefined : ACCOUNTS_COPY.offline.needsNetwork;

  const items: MenuEntry[] = [];
  if (!current) items.push({ label: ACCOUNTS_COPY.setCurrent, icon: "check", onSelect: () => act.switchTo(account.uuid) });
  // 凭据失效的账户刷新必然失败，菜单里只给能成功的动作；重新登录在卡片底部
  // 断网原因走菜单项的悬停提示气泡：右侧提示位与标签同一行、不折行，放原因会把标签挤成省略号
  if (isCredential(account) && account.status === "ok") {
    items.push({ label: ACCOUNTS_COPY.refresh, icon: "refresh", disabled: !online, disabledReason: offlineReason, onSelect: () => act.refresh(account.uuid) });
  }
  items.push(
    { label: ACCOUNTS_COPY.copyUuid, icon: "copy", onSelect: () => act.copyFromMenu(displayUuid(account.uuid)) },
    { kind: "separator" },
    { label: ACCOUNTS_COPY.deleteAccount, icon: "trash", danger: true, onSelect: () => act.remove(account) },
  );

  return (
    <Card padding="none" clip selected={current} className={styles.accountCard}>
      <Stage account={account} variant="card">
        <span className={styles.stageTag}>
          <Tag size="sm" tone={current ? "accent" : "neutral"} icon={KIND_ICON[account.kind]}>
            {KIND_SHORT[account.kind]}
          </Tag>
        </span>
        <span className={styles.stageMenu}>
          <MoreMenu size="sm" label={ACCOUNTS_COPY.moreActions(account.name)} items={items} />
        </span>
      </Stage>
      <div className={styles.cardBody}>
        <h3 className={styles.cardName}>{account.name}</h3>
        <span className={styles.cardKind}>{accountKindLabel(account.kind, account.authServer)}</span>
        <div className={styles.cardFoot}>
          {foot.kind === "current" && (
            <>
              <Tag tone="accent" size="sm" icon="check">
                {ACCOUNTS_COPY.inUse}
              </Tag>
              {foot.expired && (
                <Tag tone="warn" size="sm" icon="alert">
                  {ACCOUNTS_COPY.expiredTag}
                </Tag>
              )}
            </>
          )}
          {foot.kind === "expired" && (
            <>
              <Tag tone="warn" size="sm" icon="alert">
                {ACCOUNTS_COPY.expiredTag}
              </Tag>
              <Button size="sm" disabledReason={offlineReason} onClick={() => act.relogin(account.uuid)}>
                {ACCOUNTS_COPY.relogin}
              </Button>
            </>
          )}
          {foot.kind === "switch" && (
            <Button size="sm" onClick={() => act.switchTo(account.uuid)}>
              {ACCOUNTS_COPY.switchTo}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
