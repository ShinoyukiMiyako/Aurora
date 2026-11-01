// 并行通道卡：三条通道各在下什么，空出的通道画虚线框；末行交代还有多少在排队。

import { Icon } from "../../art/Icon";
import { percent } from "../../domain/format";
import type { Task } from "../../domain/types";
import { progressTrack } from "../../state/tasks";
import { Card } from "../../ui/Card";
import { CardHeader } from "../../ui/CardHeader";
import { ProgressBar } from "../../ui/ProgressBar";
import { QUEUE_DOTS_MAX } from "./constants";
import { TASKS_COPY } from "./copy";
import { laneSlots } from "./model";
import styles from "./tasks.module.css";

export interface LanesCardProps {
  running: readonly Task[];
  queued: readonly Task[];
}

export function LanesCard({ running, queued }: LanesCardProps) {
  return (
    <Card>
      <CardHeader title={TASKS_COPY.lanes.title} subtitle={TASKS_COPY.lanes.subtitle} icon="layers" level={2} />
      <ol className={styles.lanes}>
        {laneSlots(running).map((task, i) => (
          // 通道是固定的三个位置，按位置作 key：任务换了通道不该带着整行做进出
          <li key={i} className={styles.lane} data-busy={task === null ? undefined : ""}>
            <span className={styles.laneNo} aria-hidden="true">
              {i + 1}
            </span>
            {task === null ? (
              <span className={styles.laneIdle}>{TASKS_COPY.lanes.idle}</span>
            ) : (
              <div className={styles.laneBody}>
                <div className={styles.laneTitle}>
                  <span className={styles.laneName} title={task.title}>
                    {task.title}
                  </span>
                  <span className={styles.lanePct}>{percent(task.progress)}</span>
                </div>
                <ProgressBar value={task.progress} size="sm" track={progressTrack(task)} label={TASKS_COPY.lanes.progressLabel(task.title)} />
              </div>
            )}
          </li>
        ))}
      </ol>
      <p className={styles.queueLine}>
        {queued.length > 0 ? (
          <>
            <span className={styles.queueDots} aria-hidden="true">
              {queued.slice(0, QUEUE_DOTS_MAX).map((q) => (
                <span key={q.id} className={styles.queueDot} />
              ))}
            </span>
            {TASKS_COPY.lanes.queued(queued.length)}
          </>
        ) : (
          <>
            <Icon name="check-circle" size={14} />
            {TASKS_COPY.lanes.none}
          </>
        )}
      </p>
    </Card>
  );
}
