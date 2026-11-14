// 问候卡：日期、问候与当前账户、下载摘要、今天与连续游玩、当前账户的角色立绘（脚下是花瓣地面）。
//
// 账户与游玩记录各自晚到：名字、账户标签、今天与连续两个数字各是加载区，骨架逐行与内容同高，到了叠放交叉淡化。
// 骨架一旦出现至少停留一段：停留期间名字、立绘与标签都不提前露出来，和骨架同一刻换上。
// 问候语与数据无关，首帧就在，加载与出错期间也一直是这一页的 h1，读屏按标题导航找得到。

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { Icon, type IconName } from "../../art/Icon";
import { PetalGround } from "../../art/illustrations/PetalGround";
import { AccountFigure } from "../../art/skin/AccountFigure";
import { BOOT_SLICE_ERROR, accountKindLabel } from "../../copy/flows";
import type { Account } from "../../domain/adapt";
import { formatPlaytime } from "../../domain/format";
import { useLoadingGate } from "../../lib/loading-gate";
import { fade } from "../../lib/motion";
import { useReflow } from "../../lib/reflow";
import { useMounted } from "../../lib/useMounted";
import { cx } from "../../lib/util";
import { useNav, useShell } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import { useLauncherActions, useLauncherSelector, useNow } from "../../state/launcher";
import { skinSource, useSkinInfo } from "../../state/queries/home";
import { activeAccount, activeTasks } from "../../state/selectors";
import type { SliceStatus } from "../../state/store";
import { Appear } from "../../ui/Appear";
import { Button } from "../../ui/Button";
import { Card, type ResponsiveValue } from "../../ui/Card";
import { List, ListRow } from "../../ui/ListRow";
import { Loadable } from "../../ui/Loadable";
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
  // 上一次落定的读取结果。读取出错后点重试的这一轮不开加载门：出错的那一行留在原处、重试按钮转圈，结果回来再原位换掉。
  // 不这样做的话那一行一点就收起换成骨架，300 ms 内又失败时再重新出现，整块闪一下
  const [settled, setSettled] = useState<SliceStatus | null>(accounts.kind === "loading" ? null : accounts);
  if (accounts.kind !== "loading" && accounts !== settled) setSettled(accounts);
  const retrying = accounts.kind === "loading" && settled !== null && settled.kind === "error";
  const accountGate = useLoadingGate(accounts.kind === "loading" && !retrying);
  // 画出来的账户：骨架还在（加载中或最短停留没满）时一律当作还没到，名字、立绘、底栏让位与骨架同一刻换上
  const shown = accountGate.view === "content" ? account : null;
  const mounted = useMounted();
  // 名字一行随账户出没（没有账户、读取出错时不占这一行），下面的账户行沿 settle 滑到新位置
  const bodyRef = useReflow<HTMLDivElement>();
  // 只订阅活动任务的个数与平均进度：它们随下载进度变是应当的，别的状态变化不让问候卡重渲染
  const taskCount = useLauncherSelector((s) => activeTasks(s).length);
  const taskProgress = useLauncherSelector((s) => {
    const tasks = activeTasks(s);
    return tasks.length === 0 ? null : tasks.reduce((t, task) => t + task.progress, 0) / tasks.length;
  });

  const skin = useSkinInfo(account === null ? null : account.uuid);
  const figure = skinSource(skin);
  const silhouette = figure === null;
  const skinError = skin.status === "error" ? skin.error : null;
  useEffect(() => {
    // 皮肤拿不到时画剪影立绘是既定的回落，不弹通知（网络失败、没有皮肤后端已经折成「没有皮肤」）；
    // 走到这里的是账户库读取一类的真错误，原因留在控制台，便于排查。写明画的是剪影还是上一次的皮肤
    if (skinError !== null) console.warn(`[home] 当前账户的皮肤信息读不出来，立绘${silhouette ? "显示剪影" : "沿用上次读到的皮肤"}`, skinError);
  }, [skinError, silhouette]);

  // 出错、没有账户与账户标签三种互换时（重试成功、账户被移除）旧的原地淡出、新的淡入，各给一个 key
  const accountLine = () => {
    if (accounts.kind === "error" || retrying) {
      return (
        <span key="error" className={s.greetIssue}>
          <span className={s.greetMuted}>{BOOT_SLICE_ERROR.accounts}</span>
          <Button size="sm" variant="ghost" icon="refresh" loading={retrying} onClick={() => void run(() => actions.reload("accounts"), BOOT_SLICE_ERROR.accounts)}>
            {HOME_COPY.retry}
          </Button>
        </span>
      );
    }
    if (accounts.kind === "loading") throw new Error("账户还在加载，却要画账户行");
    if (account === null) {
      return (
        <span key="none" className={s.greetIssue}>
          <span className={s.greetMuted}>{HOME_COPY.noAccount}</span>
          <Button size="sm" variant="secondary" icon="plus" onClick={() => go({ page: "accounts" })}>
            {HOME_COPY.addAccount}
          </Button>
        </span>
      );
    }
    return (
      <Tag key="account" tone="accent" size="sm" icon={ACCOUNT_ICON[account.kind]}>
        {accountKindLabel(account.kind, account.authServer)}
      </Tag>
    );
  };

  const hello = greeting(date);

  return (
    <Card span={span} padding="none" className={cx(s.rowOne, s.greet)}>
      <div ref={bodyRef} className={s.greetBody}>
        <span className={s.greetDate}>{HOME_COPY.dateLine(date)}</span>
        <h1 className={s.greetTitle}>
          <span className={s.greetHello}>
            {hello}
            {/* 逗号跟着名字来去：之后才到的名字与它一起淡入，挂载时就在的不另播 */}
            <AnimatePresence>
              {shown !== null && (
                <motion.span
                  key="comma"
                  initial={mounted.current ? { opacity: 0 } : false}
                  animate={{ opacity: 1, transition: fade.in }}
                  exit={{ opacity: 0, transition: fade.out }}
                >
                  {HOME_COPY.greetingComma}
                </motion.span>
              )}
            </AnimatePresence>
          </span>
          <Loadable
            view={accountGate.view}
            skeleton={
              <span className={s.greetName}>
                <Skeleton shape="block" width="70%" height={SKELETON_SIZE.greetName} radius="sm" />
              </span>
            }
          >
            {() => <Appear>{shown !== null && <span key="name" className={s.greetName}>{shown.name}</span>}</Appear>}
          </Loadable>
        </h1>
        <Loadable
          view={accountGate.view}
          skeleton={
            <span className={s.greetLine}>
              <Skeleton shape="block" width="40%" height={SKELETON_SIZE.tagSm} radius="pill" />
            </span>
          }
          className={s.greetAccount}
        >
          {() => <Appear itemClassName={s.greetLine}>{accountLine()}</Appear>}
        </Loadable>
      </div>

      <div className={cx(s.greetFoot, shown !== null && s.greetFootFigure)}>
        {/* 下载开始时这一行淡入、全部结束时淡出；底栏贴底，下面的两个数字不动 */}
        <Appear>
          {taskProgress !== null && (
            <List key="downloads">
              <ListRow
                size="lg"
                leading={<Icon name="download" size={18} />}
                title={HOME_COPY.downloads(taskCount)}
                progress={<ProgressBar value={taskProgress} tone="info" size="sm" label={HOME_COPY.downloadsProgress} />}
                onClick={() => go({ page: "tasks" })}
              />
            </List>
          )}
        </Appear>
        {/* 游玩记录读取失败时日历与洞察两张卡原位报错并给重试，这里不重复报错：两个数字整块淡出，连同加载区一起离开，
            不再在底栏里占一份行距；重试时随加载区回来 */}
        <Appear>
          {play.status !== "error" && (
            <Loadable key="stats" view={play.status === "loading" ? play.gate.view : "content"} skeleton={<GreetingStatsSkeleton />}>
              {() => <GreetingStats play={play} />}
            </Loadable>
          )}
        </Appear>
      </div>

      {/* 立绘随账户一起到：之后才出现的淡入并从略小处落到位；包裹层负责定位，入场的缩放不改变按钮的落点 */}
      <Appear itemClassName={s.figureSlot}>
        {shown !== null && (
          <Tooltip key="figure" content={HOME_COPY.manageAccount} sub={accountKindLabel(shown.kind, shown.authServer)} side="left">
            <button type="button" className={s.figureButton} aria-label={HOME_COPY.manageAccount} onClick={() => go({ page: "accounts" })}>
              <PetalGround className={s.figureGround} />
              <AccountFigure uuid={shown.uuid} skin={figure} scale={tier === "compact" ? 5 : 6} interactive className={s.figure} />
            </button>
          </Tooltip>
        )}
      </Appear>
    </Card>
  );
}

/** 今天与连续两个数字的骨架：每块照真实的数值行与说明行画，行高相同。 */
function GreetingStatsSkeleton() {
  return (
    <div className={s.greetStats}>
      {[0, 1].map((i) => (
        <span key={i} className={cx(s.greetStat, s.greetStatSkeleton)}>
          <span className={s.greetStatValue}>
            <Skeleton shape="text" />
          </span>
          <Skeleton shape="text" width="60%" />
        </span>
      ))}
    </div>
  );
}

function GreetingStats({ play }: { play: Exclude<PlayView, { status: "error" }> }) {
  if (play.status === "loading") throw new Error("游玩记录还在加载，却要画问候卡的数字");
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
