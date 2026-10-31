// 账户页：管理启动游戏所用的身份。顶部是当前账户的聚光卡，下面是全部账户卡与添加卡。
// 登录弹窗（设备码、离线、外置登录）由外壳按 state.login 挂载，这里只经 actions 打开它们，
// 所以从标题栏、启动拦截发起的登录进到本页同样可见。

import { useId } from "react";
import { ACTION_ERROR, BOOT_SLICE_ERROR, SLOW_LOADING_HINT } from "../../copy/flows";
import type { AccountKind } from "../../domain/types";
import { useLoadingGate } from "../../lib/loading-gate";
import { useRunner } from "../../shell/useRunner";
import { useLauncherActions, useLauncherSelector } from "../../state/launcher";
import type { PageProps } from "../../state/route";
import { activeAccount } from "../../state/selectors";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Card } from "../../ui/Card";
import { EmptyState } from "../../ui/EmptyState";
import { MenuButton } from "../../ui/MenuButton";
import { EntranceBlock, Page } from "../../ui/Page";
import { PageHeader } from "../../ui/PageHeader";
import { SectionTitle } from "../../ui/SectionTitle";
import { Skeleton } from "../../ui/Skeleton";
import { AccountCard } from "./AccountCard";
import styles from "./accounts.module.css";
import { AddCard } from "./AddCard";
import { ACCOUNTS_COPY } from "./copy";
import { useOnline } from "../../state/online";
import { Spotlight } from "./Spotlight";
import { useAccountActions } from "./useAccountActions";

/** 加载中的账户卡骨架张数。 */
const SKELETON_CARDS = 3;

const OPEN_LOGIN_ERROR: Readonly<Record<AccountKind, string>> = {
  microsoft: ACTION_ERROR.microsoftLogin,
  offline: ACTION_ERROR.addOffline,
  authlib: ACTION_ERROR.authlib,
};

export default function AccountsPage(_props: PageProps<"accounts">) {
  const titleId = useId();
  const status = useLauncherSelector((s) => s.status.accounts);
  const accounts = useLauncherSelector((s) => s.accounts);
  const currentAccountId = useLauncherSelector((s) => s.currentAccountId);
  // 账户切片读到之前当前账户 id 与列表还对不上，那时不去找当前账户
  const me = useLauncherSelector((s) => (s.status.accounts.kind === "ready" ? activeAccount(s) : null));
  const actions = useLauncherActions();
  const run = useRunner();
  const online = useOnline();
  const act = useAccountActions();
  const gate = useLoadingGate(status.kind === "loading");
  const skeleton = gate.view === "skeleton";
  const ready = status.kind === "ready" && !skeleton;
  const current = ready ? me : null;
  const offlineReason = online ? undefined : ACCOUNTS_COPY.offline.needsNetwork;

  const openLogin = (kind: AccountKind) => void run(() => actions.openLogin(kind), OPEN_LOGIN_ERROR[kind]);

  // 当前账户凭据失效时聚光卡上的「重新登录」是这一屏的主按钮
  const headerPrimary = current === null || current.status !== "expired";
  const subtitle = !ready ? undefined : current === null ? ACCOUNTS_COPY.subtitleNone : ACCOUNTS_COPY.subtitle(accounts.length, current.name);

  const header = (
    <PageHeader
      titleId={titleId}
      title={ACCOUNTS_COPY.title}
      subtitle={subtitle}
      actions={
        <>
          <MenuButton
            placement="bottom-end"
            items={[
              { label: ACCOUNTS_COPY.menuOffline, icon: "user", onSelect: () => openLogin("offline") },
              { label: ACCOUNTS_COPY.menuAuthlib, icon: "server", disabled: !online, hint: offlineReason, onSelect: () => openLogin("authlib") },
            ]}
            trigger={(props) => (
              <Button {...props} iconRight="chevron-down">
                {ACCOUNTS_COPY.addOther}
              </Button>
            )}
          />
          <Button variant={headerPrimary ? "primary" : "secondary"} icon="plus" disabledReason={offlineReason} onClick={() => openLogin("microsoft")}>
            {ACCOUNTS_COPY.addMicrosoft}
          </Button>
        </>
      }
    />
  );

  return (
    <Page aria-labelledby={titleId}>
      {header}
      {!online && (
        <Banner tone="warn" title={ACCOUNTS_COPY.offline.title}>
          {ACCOUNTS_COPY.offline.body}
        </Banner>
      )}
      {skeleton && <LoadingSkeleton slow={gate.slow} />}
      {status.kind === "error" && !skeleton && (
        <Card padding="lg">
          <Callout
            tone="danger"
            action={
              <Button variant="ghost" size="sm" icon="refresh" onClick={() => void run(() => actions.reload("accounts"), ACTION_ERROR.refreshAccounts)}>
                {ACCOUNTS_COPY.retry}
              </Button>
            }
          >
            <span className={styles.errorTitle}>{BOOT_SLICE_ERROR.accounts}</span>
            <span className={styles.errorDetail}>{status.error.message}</span>
          </Callout>
        </Card>
      )}
      {ready && current !== null && <Spotlight account={current} online={online} act={act} />}
      {ready && current === null && (
        <Card padding="lg">
          <EmptyState
            scene="empty-nametag"
            titleAs="h2"
            title={ACCOUNTS_COPY.empty.title}
            body={ACCOUNTS_COPY.empty.body}
            action={
              <div className={styles.emptyActions}>
                <Button icon="user" onClick={() => openLogin("offline")}>
                  {ACCOUNTS_COPY.empty.addOffline}
                </Button>
                <Button icon="server" disabledReason={offlineReason} onClick={() => openLogin("authlib")}>
                  {ACCOUNTS_COPY.empty.addAuthlib}
                </Button>
              </div>
            }
          />
        </Card>
      )}
      {ready && (
        <EntranceBlock as="section" className={styles.section}>
          <SectionTitle hint={ACCOUNTS_COPY.count(accounts.length)}>{ACCOUNTS_COPY.allAccounts}</SectionTitle>
          <div className={styles.grid}>
            {accounts.map((account) => (
              <AccountCard key={account.uuid} account={account} current={account.uuid === currentAccountId} online={online} act={act} />
            ))}
            <AddCard online={online} onAdd={openLogin} />
          </div>
        </EntranceBlock>
      )}
    </Page>
  );
}

/** 聚光卡与账户卡的骨架：舞台灰块 + 两行文字，尺寸与真实内容一致。读得久了在下方补一行「比平时慢」。 */
function LoadingSkeleton({ slow }: { slow: boolean }) {
  return (
    <div className={styles.loading} aria-busy="true">
      <Card padding="none" clip>
        <div className={styles.spotGrid}>
          <Skeleton shape="block" width="100%" height={262} radius="xs" />
          <div className={styles.spotInfo}>
            <Skeleton shape="text" lines={2} width="60%" />
          </div>
        </div>
      </Card>
      <div className={styles.grid}>
        {Array.from({ length: SKELETON_CARDS }, (_, i) => (
          <Card key={i} padding="none" clip>
            <Skeleton shape="block" width="100%" height={156} radius="xs" />
            <div className={styles.cardBody}>
              <Skeleton shape="text" lines={2} />
            </div>
          </Card>
        ))}
      </div>
      {slow && <p className={styles.slowHint}>{SLOW_LOADING_HINT}</p>}
    </div>
  );
}
