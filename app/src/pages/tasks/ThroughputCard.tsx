// 吞吐卡：总进度环、当前总速度、剩余字节与时间、两枚小统计，以及贴在卡底的最近 N 秒吞吐曲线。

import { useId } from "react";
import { formatBytes, formatSpeed } from "../../domain/format";
import { Card } from "../../ui/Card";
import { ProgressRing } from "../../ui/ProgressRing";
import { TASKS_COPY } from "./copy";
import { CHART_VIEW } from "./constants";
import { chartGeometry, overviewRemaining, totalEtaSpeed, type Overview, type ThroughputSample } from "./model";
import styles from "./tasks.module.css";

export interface ThroughputCardProps {
  overview: Overview;
  history: readonly ThroughputSample[];
}

export function ThroughputCard({ overview, history }: ThroughputCardProps) {
  // 渐变要按 id 引用；useId 的结果带冒号一类字符，在 url(#…) 里不合法
  const gradientId = `tasks-flow-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const chart = chartGeometry(history.map((s) => s.total));
  const active = overview.label !== "idle";

  return (
    <Card clip className={styles.flow}>
      <div className={styles.flowTop}>
        <ProgressRing value={overview.fraction} size={84} tone={active ? "accent" : "muted"} label={TASKS_COPY.flow.ringLabel} />
        <div className={styles.flowText}>
          <span className={styles.flowLabel}>{TASKS_COPY.flow[overview.label]}</span>
          <span className={styles.flowSpeed}>{formatSpeed(overview.speed)}</span>
          <span className={styles.flowSub}>{active ? overviewRemaining(overview, totalEtaSpeed(history, overview.speed)) : TASKS_COPY.flow.idleSub}</span>
        </div>
        <div className={styles.flowStats}>
          <span className={styles.miniStat}>
            <span className={styles.miniValue}>{formatBytes(overview.downloaded)}</span>
            <span className={styles.miniLabel}>{TASKS_COPY.flow.downloaded}</span>
          </span>
          <span className={styles.miniStat}>
            <span className={styles.miniValue}>{formatBytes(overview.total)}</span>
            <span className={styles.miniLabel}>{TASKS_COPY.flow.batchTotal}</span>
          </span>
        </div>
      </div>
      <svg className={styles.chart} viewBox={`0 0 ${CHART_VIEW.width} ${CHART_VIEW.height}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" className={styles.chartStopTop} />
            <stop offset="1" className={styles.chartStopBottom} />
          </linearGradient>
        </defs>
        <path d={chart.area} fill={`url(#${gradientId})`} />
        <path d={chart.line} className={styles.chartLine} />
      </svg>
      {chart.idle && <span className={styles.chartIdle}>{TASKS_COPY.flow.chartIdle}</span>}
    </Card>
  );
}
