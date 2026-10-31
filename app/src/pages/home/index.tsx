// 主页：打开启动器的第一屏。第一排问候与「继续游玩」（wide 档再并上游玩洞察），第二排最近游玩，
// 下面是游玩日历、洞察、资讯与固定的服务器。卡片保持微透底色、不加背景模糊，外壳铺在内容区底下的飘落花瓣从卡片后面隐约透出。
//
// 游玩记录在这里查一次，问候卡、日历与洞察共用；日历与洞察共享「选中日期」与日历停留的月份。

import { useEffect, useMemo, useRef, useState } from "react";
import { useShell } from "../../shell/shell";
import { useLauncher, useNow } from "../../state/launcher";
import { usePlayStats } from "../../state/queries/home";
import type { PageProps } from "../../state/route";
import { Bento } from "../../ui/Bento";
import type { ResponsiveValue } from "../../ui/Card";
import { monthOf } from "../../ui/CalendarHeatmap";
import { Page } from "../../ui/Page";
import { buildActivity, localDateKey, playSignature, statsRange } from "./activity";
import { ContinueCard } from "./ContinueCard";
import { GreetingCard } from "./GreetingCard";
import { continueTarget } from "./instances";
import { useLoadingGate } from "./loading";
import { NewsCard } from "./NewsCard";
import { CalendarCard, InsightsCard } from "./PlayCards";
import type { PlayView } from "./play-view";
import { RecentStrip } from "./RecentStrip";
import { ServersCard } from "./ServersCard";
import s from "./home.module.css";

export default function HomePage(_props: PageProps<"home">) {
  const { state } = useLauncher();
  const { tier } = useShell();
  const now = useNow(60_000);
  const today = localDateKey(now);
  const wide = tier === "wide";

  const range = useMemo(() => statsRange(today), [today]);
  const stats = usePlayStats(range);
  const statsGate = useLoadingGate(stats.status === "loading");
  const activity = useMemo(() => (stats.status === "ready" ? buildActivity(stats.data, today) : null), [stats.status, stats.data, today]);

  // 游戏退出后实例列表会刷新出新的累计时长与上次游玩时刻；游玩记录跟着重取，日历与洞察才包含刚结束的这一局
  const signature = playSignature(state.instances);
  const lastSignature = useRef<string | null>(null);
  const reloadStats = stats.reload;
  const instancesReady = state.status.instances.kind === "ready";
  useEffect(() => {
    if (!instancesReady) return;
    const previous = lastSignature.current;
    lastSignature.current = signature;
    if (previous !== null && previous !== signature) reloadStats();
  }, [instancesReady, signature, reloadStats]);

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

  const target = state.status.instances.kind === "ready" ? continueTarget(state.instances, state.selectedInstanceId) : null;

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
