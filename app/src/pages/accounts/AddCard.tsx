// 添加卡：排在账户卡网格末尾的虚线框，三种账户各一行。断网时微软与外置登录不可选，构建里没有微软登录 client_id 时
// 微软那一行不可选，说明行都换成原因。

import { Icon } from "../../art/Icon";
import { MSA_CLIENT_ID_MISSING } from "../../copy/flows";
import type { AccountKind } from "../../domain/types";
import { List, ListRow } from "../../ui/ListRow";
import styles from "./accounts.module.css";
import { ACCOUNTS_COPY } from "./copy";
import { KIND_ICON } from "./model";

const ORDER: readonly AccountKind[] = ["microsoft", "offline", "authlib"];

export interface AddCardProps {
  online: boolean;
  microsoftUnavailable: boolean;
  onAdd: (kind: AccountKind) => void;
}

export function AddCard({ online, microsoftUnavailable, onAdd }: AddCardProps) {
  return (
    <div className={styles.addCard}>
      <h3 className={styles.addTitle}>{ACCOUNTS_COPY.addCard}</h3>
      <List>
        {ORDER.map((kind) => {
          const option = ACCOUNTS_COPY.addOptions[kind];
          const needsNetwork = kind !== "offline" && !online;
          const missingClientId = kind === "microsoft" && microsoftUnavailable;
          const reason = missingClientId ? MSA_CLIENT_ID_MISSING.reason : needsNetwork ? ACCOUNTS_COPY.offline.needsNetwork : null;
          return (
            <ListRow
              key={kind}
              leading={
                <span className={styles.addIcon} data-kind={kind}>
                  <Icon name={KIND_ICON[kind]} size={20} />
                </span>
              }
              title={<span className={styles.addName}>{option.name}</span>}
              meta={<span className={styles.addDescription}>{reason === null ? option.description : reason}</span>}
              disabled={reason !== null}
              onClick={() => onAdd(kind)}
            />
          );
        })}
      </List>
    </div>
  );
}
