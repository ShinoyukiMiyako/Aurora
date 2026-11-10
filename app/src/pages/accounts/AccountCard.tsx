// 账户卡：舞台（类型短标、更多菜单、立绘）+ 名称与类型 + 底部状态。当前账户卡带选中描边。

import { Fragment } from "react";
import type { Account } from "../../domain/adapt";
import { accountKindLabel } from "../../copy/flows";
import { Appear } from "../../ui/Appear";
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
    // 这个账户正在刷新时这一项禁用，不发第二次刷新；当前账户的进行中由聚光卡的忙碌按钮交代，不另给原因
    items.push({ label: ACCOUNTS_COPY.refresh, icon: "refresh", disabled: !online || act.refreshing.has(account.uuid), disabledReason: offlineReason, onSelect: () => act.refresh(account.uuid) });
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
        {/* 底部三种形态等高、不折行；换形态（切换账户、凭据失效）时旧的原地淡出，新的在同一处淡入 */}
        <div className={styles.cardFoot}>
          <Appear itemClassName={styles.footRow}>
            {foot.kind === "current" && (
              <Fragment key={foot.expired ? "current-expired" : "current"}>
                <Tag tone="accent" size="sm" icon="check">
                  {ACCOUNTS_COPY.inUse}
                </Tag>
                {foot.expired && <ExpiredTag />}
              </Fragment>
            )}
            {foot.kind === "expired" && (
              <Fragment key="expired">
                <ExpiredTag />
                <Button size="sm" disabledReason={offlineReason} onClick={() => act.relogin(account.uuid)} className={styles.footButton}>
                  {ACCOUNTS_COPY.relogin}
                </Button>
              </Fragment>
            )}
            {foot.kind === "switch" && (
              <Button key="switch" size="sm" onClick={() => act.switchTo(account.uuid)} className={styles.footButton}>
                {ACCOUNTS_COPY.switchTo}
              </Button>
            )}
          </Appear>
        </div>
      </div>
    </Card>
  );
}

/** 「需要重新登录」：最窄的卡里和旁边的标签或按钮放不下一行时，它自己省略收缩，底部不折成两行。 */
function ExpiredTag() {
  return (
    <Tag tone="warn" size="sm" icon="alert" className={styles.footTag}>
      <span className={styles.footTagText}>{ACCOUNTS_COPY.expiredTag}</span>
    </Tag>
  );
}
