// 吞吐卡：总进度环、当前总速度、剩余字节与时间、两枚小统计，以及贴在卡底的最近 N 秒吞吐曲线。

import { useId } from "react";
import { formatBytes, formatSpeed } from "../../domain/format";
import { useDisplayCount } from "../../lib/progress-display";
import { cssVars } from "../../lib/util";
import { Card } from "../../ui/Card";
import { ProgressRing } from "../../ui/ProgressRing";
import { TASKS_COPY } from "./copy";
import { CHART_STEP, CHART_VIEW, SAMPLE_INTERVAL_MS } from "./constants";
import { usePacedEtaSpeed, type ChartFrame } from "./hooks";
import { chartGeometry, overviewRemaining, totalEtaSpeed, type Overview, type ThroughputSample } from "./model";
import styles from "./tasks.module.css";

/** 画布比卡宽出右缘外的那一格（视图坐标多一个点距）。 */
const PLOT_WIDTH = CHART_VIEW.width + CHART_STEP;

/** 曲线一个采样间隔滑一格：画布的宽、滑的距离（画布自身宽度的百分比）与时长交给样式表。 */
const CHART_SCROLL = cssVars({
  "--tasks-sample-period": `${SAMPLE_INTERVAL_MS}ms`,
  "--tasks-chart-width": `${(PLOT_WIDTH / CHART_VIEW.width) * 100}%`,
  "--tasks-chart-shift": `${-(CHART_STEP / PLOT_WIDTH) * 100}%`,
});

export interface ThroughputCardProps {
  overview: Overview;
  /** 写出来的总速度：平滑过、换字有节制的那个（lib/progress-display 的 useDisplaySpeed），不是瞬时值。 */
  speed: number;
  /** 总进度环的平滑标识（overviewTrack）：有任务结束或换批次时环直接跳到新值，不倒退着扫回去。 */
  track: string;
  history: readonly ThroughputSample[];
  /** 曲线的逐采样状态（useChartFrame）：纵轴上限与滑动的起步序号。 */
  frame: ChartFrame;
}

/**
 * 卡上的文字：总速度、剩余字节与时间、两枚小统计。已下字节按节拍换字（lib/progress-display 的 useDisplayCount），
 * 「已下载」与「剩余 …」用同一个值、同一拍换，剩余时间也跟着这一拍。节拍放在这一段里，到点补字时只重画文字，
 * 进度环与曲线不跟着重渲染。
 */
function FlowFigures({ overview, speed, history }: Pick<ThroughputCardProps, "overview" | "speed" | "history">) {
  const downloaded = useDisplayCount(overview.downloaded, overview.total);
  const etaSpeed = usePacedEtaSpeed(downloaded, totalEtaSpeed(history, overview.speed));
  return (
    <>
      <div className={styles.flowText}>
        <span className={styles.flowLabel}>{TASKS_COPY.flow[overview.label]}</span>
        <span className={styles.flowSpeed}>{formatSpeed(speed)}</span>
        <span className={styles.flowSub}>{overview.label !== "idle" ? overviewRemaining(overview, downloaded, etaSpeed) : TASKS_COPY.flow.idleSub}</span>
      </div>
      <div className={styles.flowStats}>
        <span className={styles.miniStat}>
          <span className={styles.miniValue}>{formatBytes(downloaded)}</span>
          <span className={styles.miniLabel}>{overview.localOnly ? TASKS_COPY.flow.processed : TASKS_COPY.flow.downloaded}</span>
        </span>
        <span className={styles.miniStat}>
          <span className={styles.miniValue}>{formatBytes(overview.total)}</span>
          <span className={styles.miniLabel}>{TASKS_COPY.flow.batchTotal}</span>
        </span>
      </div>
    </>
  );
}

export function ThroughputCard({ overview, speed, track, history, frame }: ThroughputCardProps) {
  // 渐变要按 id 引用；useId 的结果带冒号一类字符，在 url(#…) 里不合法
  const gradientId = `tasks-flow-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const chart = chartGeometry(history.map((s) => s.total), frame.ceiling);
  const active = overview.label !== "idle";

  return (
    <Card clip className={styles.flow}>
      <div className={styles.flowTop}>
        <ProgressRing
          value={overview.fraction}
          size={84}
          track={track}
          tone={active ? "accent" : "muted"}
          label={TASKS_COPY.flow.ringLabel}
          emptyText={active ? TASKS_COPY.flow.ringEmpty.unknown : TASKS_COPY.flow.ringEmpty.idle}
        />
        <FlowFigures overview={overview} speed={speed} history={history} />
      </div>
      <div className={styles.chart} style={CHART_SCROLL} aria-hidden="true">
        {/* 每个新采样换一次键：画布从头滑起，最新的一点从右缘外滑进来 */}
        <svg key={frame.seq} className={styles.chartPlot} viewBox={`0 0 ${PLOT_WIDTH} ${CHART_VIEW.height}`} preserveAspectRatio="none" focusable="false">
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" className={styles.chartStopTop} />
              <stop offset="1" className={styles.chartStopBottom} />
            </linearGradient>
          </defs>
          <path d={chart.area} fill={`url(#${gradientId})`} />
          <path d={chart.line} className={styles.chartLine} />
        </svg>
      </div>
      {chart.idle && <span className={styles.chartIdle}>{TASKS_COPY.flow.chartIdle}</span>}
    </Card>
  );
}
