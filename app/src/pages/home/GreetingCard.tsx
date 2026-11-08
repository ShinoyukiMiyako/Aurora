// 问候卡：日期、问候与当前账户、下载摘要、今天与连续游玩、当前账户的角色立绘（脚下是花瓣地面）。

import { useEffect } from "react";
import { Icon, type IconName } from "../../art/Icon";
import { PetalGround } from "../../art/illustrations/PetalGround";
import { AccountFigure } from "../../art/skin/AccountFigure";
import { BOOT_SLICE_ERROR, accountKindLabel } from "../../copy/flows";
import type { Account } from "../../domain/adapt";
import { formatPlaytime } from "../../domain/format";
import { useLoadingGate } from "../../lib/loading-gate";
import { cx } from "../../lib/util";
import { useNav, useShell } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import { useLauncherActions, useLauncherSelector, useNow } from "../../state/launcher";
import { useSkinInfo } from "../../state/queries/home";
import { activeAccount, activeTasks } from "../../state/selectors";
import { Button } from "../../ui/Button";
import { Card, type ResponsiveValue } from "../../ui/Card";
import { List, ListRow } from "../../ui/ListRow";
import { ProgressBar } from "../../ui/ProgressBar";
import { Skeleton } from "../../ui/Skeleton";
import { Tag } from "../../ui/Tag";
import { Tooltip } from "../../ui/Tooltip";
import { minutesOn, streakDays } from "./activity";
import { HOME_COPY, greeting } from "./copy";
import { SKELETON_SIZE } from "./layout";
import type { PlayView } from "./play-view";
import s from "./home.module.css";

const ACCOUNT_ICON: Readonly<Record<Account["kind"], IconName>> = { microsoft: "shield", offline: "user", authlib: "server" };

export interface GreetingCardProps {
  span: ResponsiveValue;
  play: PlayView;
}

export function GreetingCard({ span, play }: GreetingCardProps) {
  const actions = useLauncherActions();
  const { go } = useNav();
  const { tier } = useShell();
  const run = useRunner();
  const now = useNow(60_000);
  const date = new Date(now);
  const accounts = useLauncherSelector((s) => s.status.accounts);
  const account = useLauncherSelector((s) => (s.status.accounts.kind === "ready" ? activeAccount(s) : null));
  const accountGate = useLoadingGate(accounts.kind === "loading");
  // 只订阅活动任务的个数与平均进度：它们随下载进度变是应当的，别的状态变化不让问候卡重渲染
  const taskCount = useLauncherSelector((s) => activeTasks(s).length);
  const taskProgress = useLauncherSelector((s) => {
    const tasks = activeTasks(s);
    return tasks.length === 0 ? null : tasks.reduce((t, task) => t + task.progress, 0) / tasks.length;
  });

  const skin = useSkinInfo(account === null ? null : account.uuid);
  const skinError = skin.status === "error" ? skin.error : null;
  useEffect(() => {
    // 皮肤拿不到时画剪影立绘是既定的回落，不弹通知（网络失败、没有皮肤后端已经折成「没有皮肤」）；
    // 走到这里的是账户库读取一类的真错误，原因留在控制台，便于排查
    if (skinError !== null) console.warn("[home] 当前账户的皮肤信息读不出来，立绘显示剪影", skinError);
  }, [skinError]);

  const accountLine = () => {
    if (accounts.kind === "loading") {
      return (
        <span className={cx(s.greetSkeleton, accountGate.view === "pending" && s.pending)} aria-busy="true">
          <Skeleton shape="block" width="70%" height={SKELETON_SIZE.greetName} radius="sm" />
          <Skeleton shape="block" width="40%" height={SKELETON_SIZE.tagSm} radius="pill" />
        </span>
      );
    }
    if (accounts.kind === "error") {
      return (
        <span className={s.greetIssue}>
          <span className={s.greetMuted}>{BOOT_SLICE_ERROR.accounts}</span>
          <Button size="sm" variant="ghost" icon="refresh" onClick={() => void run(() => actions.reload("accounts"), BOOT_SLICE_ERROR.accounts)}>
            {HOME_COPY.retry}
          </Button>
        </span>
      );
    }
    if (account === null) {
      return (
        <span className={s.greetIssue}>
          <span className={s.greetMuted}>{HOME_COPY.noAccount}</span>
          <Button size="sm" variant="secondary" icon="plus" onClick={() => go({ page: "accounts" })}>
            {HOME_COPY.addAccount}
          </Button>
        </span>
      );
    }
    return (
      <Tag tone="accent" size="sm" icon={ACCOUNT_ICON[account.kind]}>
        {accountKindLabel(account.kind, account.authServer)}
      </Tag>
    );
  };

  return (
    <Card span={span} padding="none" className={cx(s.rowOne, s.greet)}>
      <div className={s.greetBody}>
        <span className={s.greetDate}>{HOME_COPY.dateLine(date)}</span>
        <h1 className={s.greetTitle}>
          <span className={s.greetHello}>
            {greeting(date)}
            {account !== null && HOME_COPY.greetingComma}
          </span>
          {account !== null && <span className={s.greetName}>{account.name}</span>}
        </h1>
        {accountLine()}
      </div>

      <div className={cx(s.greetFoot, account !== null && s.greetFootFigure)}>
        {taskProgress !== null && (
          <List>
            <ListRow
              size="lg"
              leading={<Icon name="download" size={18} />}
              title={HOME_COPY.downloads(taskCount)}
              progress={<ProgressBar value={taskProgress} tone="info" size="sm" label={HOME_COPY.downloadsProgress} />}
              onClick={() => go({ page: "tasks" })}
            />
          </List>
        )}
        <GreetingStats play={play} />
      </div>

      {account !== null && (
        <Tooltip content={HOME_COPY.manageAccount} sub={accountKindLabel(account.kind, account.authServer)} side="left">
          <button type="button" className={s.figureButton} aria-label={HOME_COPY.manageAccount} onClick={() => go({ page: "accounts" })}>
            <PetalGround className={s.figureGround} />
            <AccountFigure uuid={account.uuid} skin={skin.status === "ready" ? skin.data : null} scale={tier === "compact" ? 5 : 6} interactive className={s.figure} />
          </button>
        </Tooltip>
      )}
    </Card>
  );
}

function GreetingStats({ play }: { play: PlayView }) {
  // 读取失败时日历与洞察两张卡原位报错并给重试，这里不重复报错，只是不画这两个数字
  if (play.status === "error") return null;
  if (play.status === "loading") {
    return (
      <div className={cx(s.greetStats, play.gate.view === "pending" && s.pending)} aria-busy="true">
        <Skeleton shape="text" lines={2} width="30%" />
        <Skeleton shape="text" lines={2} width="24%" />
      </div>
    );
  }
  const today = minutesOn(play.activity, play.activity.today);
  return (
    <div className={s.greetStats}>
      <span className={s.greetStat}>
        <b className={s.greetStatValue}>{today > 0 ? formatPlaytime(today) : HOME_COPY.todayNone}</b>
        {HOME_COPY.today}
      </span>
      <span className={s.greetStat}>
        <b className={s.greetStatValue}>{HOME_COPY.days(streakDays(play.activity))}</b>
        {HOME_COPY.streak}
      </span>
    </div>
  );
}
