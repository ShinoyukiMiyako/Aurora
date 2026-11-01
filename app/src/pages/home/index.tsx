// 主页：打开启动器的第一屏。第一排问候与「继续游玩」（wide 档再并上游玩洞察），第二排最近游玩，
// 下面是游玩日历、洞察、资讯与固定的服务器。卡片保持微透底色、不加背景模糊，外壳铺在内容区底下的飘落花瓣从卡片后面隐约透出。
//
// 游玩记录在这里查一次，问候卡、日历与洞察共用；日历与洞察共享「选中日期」与日历停留的月份。
// 游戏退出后状态层统一作废游玩记录的缓存，这里订阅着就会重取，刚结束的这一局随之进入日历与洞察。

import { useMemo, useState } from "react";
import { useLoadingGate } from "../../lib/loading-gate";
import { useShell } from "../../shell/shell";
import { useLauncherSelector, useNow } from "../../state/launcher";
import { usePlayStats } from "../../state/queries/home";
import type { PageProps } from "../../state/route";
import { Bento } from "../../ui/Bento";
import type { ResponsiveValue } from "../../ui/Card";
import { monthOf } from "../../ui/CalendarHeatmap";
import { Page } from "../../ui/Page";
import { buildActivity, localDateKey, statsRange } from "./activity";
import { ContinueCard } from "./ContinueCard";
import { GreetingCard } from "./GreetingCard";
import { continueTarget } from "./instances";
import { NewsCard } from "./NewsCard";
import { CalendarCard, InsightsCard } from "./PlayCards";
import type { PlayView } from "./play-view";
import { RecentStrip } from "./RecentStrip";
import { ServersCard } from "./ServersCard";
import s from "./home.module.css";

export default function HomePage(_props: PageProps<"home">) {
  // 主页根与各张卡只订阅自己用到的那几片：游戏运行时日志每 100 ms 一批，整份订阅会让整块 bento 跟着重渲染
  const instancesReady = useLauncherSelector((s) => s.status.instances.kind === "ready");
  const instances = useLauncherSelector((s) => s.instances);
  const selectedInstanceId = useLauncherSelector((s) => s.selectedInstanceId);
  const { tier } = useShell();
  const now = useNow(60_000);
  const today = localDateKey(now);
  const wide = tier === "wide";

  const range = useMemo(() => statsRange(today), [today]);
  const stats = usePlayStats(range);
  const statsGate = useLoadingGate(stats.status === "loading");
  const activity = useMemo(() => (stats.status === "ready" ? buildActivity(stats.data, today) : null), [stats.status, stats.data, today]);

  let play: PlayView;
  if (stats.status === "error") play = { status: "error", error: stats.error, retry: stats.reload };
  else if (activity === null || statsGate.view === "skeleton") play = { status: "loading", gate: statsGate };
  else play = { status: "ready", activity };

  const [selected, setSelected] = useState(today);
  const [month, setMonth] = useState(() => monthOf(today));
  const pickDay = (date: string) => {
    setSelected(date);
    setMonth(monthOf(date));
  };

  const target = instancesReady ? continueTarget(instances, selectedInstanceId) : null;

  const insights = (span: ResponsiveValue, className?: string) => (
    <InsightsCard span={span} play={play} today={today} selected={selected} onPickDay={pickDay} className={className} />
  );

  return (
    <Page className={s.home}>
      <Bento>
        <GreetingCard span={{ compact: 4, wide: 3 }} play={play} />
        <ContinueCard span={{ compact: 8, wide: 6 }} target={target} />
        {/* 只在 wide 档挂载，但跨列值逐档校验，窄档也得填合法值 */}
        {wide && insights({ compact: 4, wide: 3 }, s.rowOne)}
      </Bento>
      <RecentStrip currentId={target === null ? null : target.id} />
      <Bento>
        <CalendarCard span={{ compact: 7, wide: 5 }} play={play} today={today} month={month} onMonthChange={setMonth} selected={selected} onSelect={setSelected} />
        {!wide && insights(5)}
        <NewsCard span={{ compact: 7, wide: 4 }} />
        <ServersCard span={{ compact: 5, wide: 3 }} />
      </Bento>
    </Page>
  );
}
