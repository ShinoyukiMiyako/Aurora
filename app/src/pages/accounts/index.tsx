// 账户页：管理启动游戏所用的身份。顶部是当前账户的聚光卡，下面是全部账户卡与添加卡。
// 登录弹窗（设备码、离线、外置登录）由外壳按 state.login 挂载，这里只经 actions 打开它们，
// 所以从标题栏、启动拦截发起的登录进到本页同样可见。

import { useId, useState, type ReactNode } from "react";
import { ACTION_ERROR, BOOT_SLICE_ERROR, MSA_CLIENT_ID_MISSING, SLOW_LOADING_HINT } from "../../copy/flows";
import type { AccountKind } from "../../domain/types";
import { useLoadingGate } from "../../lib/loading-gate";
import { useReflow } from "../../lib/reflow";
import { useRunner } from "../../shell/useRunner";
import { useLauncherActions, useLauncherSelector } from "../../state/launcher";
import type { PageProps } from "../../state/route";
import { activeAccount, microsoftLoginUnavailable } from "../../state/selectors";
import type { SliceStatus } from "../../state/store";
import { Appear } from "../../ui/Appear";
import { Banner, BannerSlot } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Card } from "../../ui/Card";
import { EmptyState } from "../../ui/EmptyState";
import { KV } from "../../ui/KV";
import { Loadable } from "../../ui/Loadable";
import { MenuButton } from "../../ui/MenuButton";
import { EntranceBlock, numberEntrance, Page, useEntranceIndex, usePageEntrance } from "../../ui/Page";
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

/** 加载中的账户卡骨架张数：大多数人一两个账户，两张加上添加卡正好排满一行。 */
const SKELETON_CARDS = 2;

/** 聚光卡 UUID 胶囊的高度：小号复制按钮 30 加上下内边距各 2。 */
const UUID_PILL_HEIGHT = 34;

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
  const microsoftUnavailable = useLauncherSelector(microsoftLoginUnavailable);
  const act = useAccountActions();
  const gridRef = useReflow<HTMLDivElement>();

  // 上一次落定的读取结果。读取出错后点重试的这一轮不开加载门：错误卡留在原处、重试按钮转圈，结果回来再原位换掉。
  // 不这样做的话错误卡一点就消失、只剩页头，300 ms 内又失败时错误卡再重新出现，整块闪一下。
  const [settled, setSettled] = useState<SliceStatus | null>(status.kind === "loading" ? null : status);
  if (status.kind !== "loading" && status !== settled) setSettled(status);
  const retryingFrom = status.kind === "loading" && settled !== null && settled.kind === "error" ? settled : null;
  const gate = useLoadingGate(status.kind === "loading" && retryingFrom === null);
  const ready = status.kind === "ready" && gate.view === "content";
  const error = status.kind === "error" ? status.error : retryingFrom === null ? null : retryingFrom.error;
  const current = ready ? me : null;
  const offlineReason = online ? undefined : ACCOUNTS_COPY.offline.needsNetwork;
  const microsoftReason = microsoftUnavailable ? MSA_CLIENT_ID_MISSING.reason : offlineReason;

  const openLogin = (kind: AccountKind) => void run(() => actions.openLogin(kind), OPEN_LOGIN_ERROR[kind]);

  // 当前账户凭据失效时聚光卡上的「重新登录」是这一屏的主按钮
  const headerPrimary = current === null || current.status !== "expired";
  // 没读到之前先占住副标题这一行（null），读到时同一行填上文字，页头不长高
  const subtitle = !ready ? null : current === null ? ACCOUNTS_COPY.subtitleNone : ACCOUNTS_COPY.subtitle(accounts.length, current.name);

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
              // 断网原因放悬停提示气泡，不占右侧提示位，免得把标签挤成省略号
              { label: ACCOUNTS_COPY.menuAuthlib, icon: "server", disabled: !online, disabledReason: offlineReason, onSelect: () => openLogin("authlib") },
            ]}
            trigger={(props) => (
              <Button {...props} iconRight="chevron-down">
                {ACCOUNTS_COPY.addOther}
              </Button>
            )}
          />
          <Button variant={headerPrimary ? "primary" : "secondary"} icon="plus" disabledReason={microsoftReason} onClick={() => openLogin("microsoft")}>
            {ACCOUNTS_COPY.addMicrosoft}
          </Button>
        </>
      }
    />
  );

  return (
    <Page aria-labelledby={titleId}>
      {header}
      <BannerSlot>
        {!online && (
          <Banner tone="warn" title={ACCOUNTS_COPY.offline.title}>
            {ACCOUNTS_COPY.offline.body}
          </Banner>
        )}
      </BannerSlot>
      <Loadable view={gate.view} skeleton={<LoadingSkeleton />}>
        {() => (
          <Body>
            {/* 错误卡、聚光卡与空状态互换：旧的原地淡出并让出位置，新的淡入落位，下面的分区由让位滑过去 */}
            <Appear>
              {error !== null && (
                <Card key="error" padding="lg">
                  <Callout
                    tone="danger"
                    action={
                      <Button
                        variant="ghost"
                        size="sm"
                        icon="refresh"
                        loading={retryingFrom !== null}
                        onClick={() => void run(() => actions.reload("accounts"), ACTION_ERROR.refreshAccounts)}
                      >
                        {ACCOUNTS_COPY.retry}
                      </Button>
                    }
                  >
                    <span className={styles.errorTitle}>{BOOT_SLICE_ERROR.accounts}</span>
                    <span className={styles.errorDetail}>{error.message}</span>
                  </Callout>
                </Card>
              )}
              {current !== null && <Spotlight key="spot" account={current} online={online} act={act} />}
              {ready && current === null && (
                <Card key="empty" padding="lg">
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
            </Appear>
            {ready && (
              <EntranceBlock as="section" className={styles.section}>
                <SectionTitle hint={ACCOUNTS_COPY.count(accounts.length)}>{ACCOUNTS_COPY.allAccounts}</SectionTitle>
                {/* 账户增删：新卡淡入落位，被删的卡原地淡出并让出位置，其余卡与添加卡从旧格子滑到新格子 */}
                <div ref={gridRef} className={styles.grid}>
                  <Appear itemClassName={styles.cell}>
                    {accounts.map((account) => (
                      <AccountCard key={account.uuid} account={account} current={account.uuid === currentAccountId} online={online} act={act} />
                    ))}
                    <AddCard key="add" online={online} microsoftUnavailable={microsoftUnavailable} onAdd={openLogin} />
                  </Appear>
                </div>
              </EntranceBlock>
            )}
          </Body>
        )}
      </Loadable>
      {/* 骨架在读屏里是隐藏的，读得久了的说明放在它外面 */}
      <Appear>{gate.view === "skeleton" && gate.slow && <p className={styles.slowHint}>{SLOW_LOADING_HINT}</p>}</Appear>
    </Page>
  );
}

/**
 * 读到之后的正文，与骨架同一副栈。挂载时页面还在入场，就把页面分给这里的序号接着往下编，聚光卡与分区照常错开入场；
 * 等过加载才挂上时 Loadable 已经整体淡入，里面的区块不再各自淡入一层。
 */
function Body({ children }: { children: ReactNode }) {
  const ref = useReflow<HTMLDivElement>();
  const index = useEntranceIndex();
  const entrance = usePageEntrance();
  const [start] = useState(entrance === null ? null : index);
  return (
    <div ref={ref} className={styles.body}>
      {numberEntrance(children, start)}
    </div>
  );
}

/**
 * 聚光卡与账户网格的骨架，结构照真实内容逐行画：聚光卡的舞台与信息区（标签、名称、类型、UUID、键值三行、动作），
 * 「全部账户」标题行，账户卡（舞台、名称、类型、底部按钮）加添加卡。换成内容时只有交叉淡化，没有位移。
 */
function LoadingSkeleton() {
  return (
    <div className={styles.body}>
      <Card padding="none" clip>
        <div className={styles.spotGrid}>
          <div className={styles.stage} data-variant="spot">
            <div className={styles.backdrop} />
          </div>
          <div className={styles.spotInfo}>
            <div className={styles.tagRow}>
              <Skeleton shape="block" width={72} height={18} radius="xs" />
              <Skeleton shape="block" width={96} height={18} radius="xs" />
            </div>
            <div className={styles.spotName}>
              <Skeleton shape="text" width="45%" />
            </div>
            <div className={styles.kindLine}>
              <Skeleton shape="text" width={144} />
            </div>
            <Skeleton shape="block" width={300} height={UUID_PILL_HEIGHT} radius="sm" className={styles.uuidBone} />
            <KV
              rows={Array.from({ length: 3 }, () => ({ label: <Skeleton shape="text" width={56} />, value: <Skeleton shape="text" width={120} /> }))}
              className={styles.spotKv}
            />
            <div className={styles.spotActions}>
              <Skeleton shape="block" width={120} height={30} radius="sm" />
            </div>
          </div>
        </div>
      </Card>
      <div className={styles.section}>
        <div className={styles.sectionBone}>
          <Skeleton shape="text" width={96} />
        </div>
        <div className={styles.grid}>
          {Array.from({ length: SKELETON_CARDS }, (_, i) => (
            <Card key={i} padding="none" clip>
              <div className={styles.stage} data-variant="card">
                <div className={styles.backdrop} />
              </div>
              <div className={styles.cardBody}>
                <div className={styles.cardName}>
                  <Skeleton shape="text" width="60%" />
                </div>
                <div className={styles.cardKind}>
                  <Skeleton shape="text" width="40%" />
                </div>
                <div className={styles.cardFoot}>
                  <Skeleton shape="block" width={96} height={30} radius="sm" />
                </div>
              </div>
            </Card>
          ))}
          <div className={styles.addCard} />
        </div>
      </div>
    </div>
  );
}
