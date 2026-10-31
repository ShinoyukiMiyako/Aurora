// 当前账户聚光卡：左侧舞台站着角色立绘，右侧是名称、类型、UUID、验证信息与动作。
// 凭据失效时动作换成「重新登录」主按钮，页头的「添加微软账户」随之降为次按钮，保证每屏一个主按钮。

import { Icon } from "../../art/Icon";
import { formatDate, formatRelative } from "../../domain/format";
import type { Account } from "../../domain/adapt";
import { COPY_FEEDBACK_MS } from "../../domain/limits";
import { useNow } from "../../state/launcher";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { CopyButton, KV, type KVRow } from "../../ui/KV";
import { MoreMenu } from "../../ui/MoreMenu";
import { Tag } from "../../ui/Tag";
import styles from "./accounts.module.css";
import { ACCOUNTS_COPY } from "./copy";
import { displayUuid, isCredential, KIND_ICON, kindLine, verifyMethod } from "./model";
import { Stage } from "./Stage";
import type { AccountActions } from "./useAccountActions";

/** 相对时间每 30 s 刷新一次。 */
const RELATIVE_REFRESH_MS = 30_000;

export interface SpotlightProps {
  account: Account;
  online: boolean;
  act: AccountActions;
}

export function Spotlight({ account, online, act }: SpotlightProps) {
  const now = useNow(RELATIVE_REFRESH_MS);
  const line = kindLine(account);
  const uuid = displayUuid(account.uuid);
  const credential = isCredential(account);
  const expired = account.status === "expired";
  const offlineReason = online ? undefined : ACCOUNTS_COPY.offline.needsNetwork;

  const rows: KVRow[] = [{ label: ACCOUNTS_COPY.kvMethod, value: verifyMethod(account) }];
  // 离线账户不经过验证，没有「上次验证」；凭据账户还没有成功验证过时这一行不出现，而不是写一个假时间
  if (credential && account.lastVerifiedAt !== null) rows.push({ label: ACCOUNTS_COPY.kvLastVerified, value: formatRelative(account.lastVerifiedAt, now) });
  rows.push({ label: ACCOUNTS_COPY.kvAdded, value: formatDate(account.addedAt) });

  return (
    <Card as="section" padding="none" clip selected className={styles.spot}>
      <div className={styles.spotGrid}>
        <Stage account={account} variant="spot" />
        <div className={styles.spotInfo}>
          <div className={styles.tagRow}>
            <Tag tone="accent" icon="check" size="sm">
              {ACCOUNTS_COPY.currentTag}
            </Tag>
            <Tag tone="outline" size="sm">
              {ACCOUNTS_COPY.addedAgo(formatRelative(account.addedAt, now))}
            </Tag>
          </div>
          <h2 className={styles.spotName}>{account.name}</h2>
          <p className={styles.kindLine} data-tone={line.tone}>
            <Icon name={KIND_ICON[account.kind]} size={16} />
            <span>{line.text}</span>
          </p>
          <div className={styles.uuid}>
            <code className={styles.uuidText}>{uuid}</code>
            <CopyButton text={uuid} label={ACCOUNTS_COPY.copyUuid} onCopy={act.copyText} feedbackMs={COPY_FEEDBACK_MS} />
          </div>
          <KV rows={rows} className={styles.spotKv} />
          <div className={styles.spotActions}>
            {credential &&
              (expired ? (
                <Button variant="primary" size="sm" icon="key" disabledReason={offlineReason} onClick={() => act.relogin(account.uuid)}>
                  {ACCOUNTS_COPY.relogin}
                </Button>
              ) : (
                <Button
                  size="sm"
                  icon="refresh"
                  loading={act.refreshing.has(account.uuid)}
                  disabledReason={offlineReason}
                  onClick={() => act.refresh(account.uuid)}
                >
                  {ACCOUNTS_COPY.refresh}
                </Button>
              ))}
            <MoreMenu
              size="sm"
              label={ACCOUNTS_COPY.moreActions(account.name)}
              items={[
                { label: ACCOUNTS_COPY.copyUuid, icon: "copy", onSelect: () => act.copyFromMenu(uuid) },
                { kind: "separator" },
                { label: ACCOUNTS_COPY.deleteAccount, icon: "trash", danger: true, onSelect: () => act.remove(account) },
              ]}
            />
          </div>
        </div>
      </div>
    </Card>
  );
}
