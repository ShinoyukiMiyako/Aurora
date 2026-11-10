// 并行通道卡：三条通道各在下什么，空出的通道画虚线框；末行交代还有多少在排队。
//
// 通道粘住任务（model 的 laneSlots）：别的任务结束不会让它换道。通道里换了人（空闲换成任务、任务收尾后让给下一个）时，
// 旧内容原地淡出、新内容从下方落进同一格，两者叠在一起交接，通道不变高。

import { AnimatePresence, motion, useIsPresent, useReducedMotionConfig, type Variants } from "framer-motion";
import { useState, type ReactNode } from "react";
import { Icon } from "../../art/Icon";
import type { Task } from "../../domain/types";
import { lineSwap, lineSwapFade } from "../../lib/motion";
import { useMounted } from "../../lib/useMounted";
import { progressTrack } from "../../state/tasks";
import { Card } from "../../ui/Card";
import { CardHeader } from "../../ui/CardHeader";
import { ProgressBar } from "../../ui/ProgressBar";
import { QUEUE_DOTS_MAX } from "./constants";
import { TASKS_COPY } from "./copy";
import { laneSlots, NO_LANES } from "./model";
import { SmoothPercent } from "../../ui/SmoothPercent";
import styles from "./tasks.module.css";

export interface LanesCardProps {
  running: readonly Task[];
  /** 刚完成、还在收尾的任务：留在原来的通道里把进度条推满，收尾结束才让出通道。 */
  finishing: readonly Task[];
  queued: readonly Task[];
}

/** 通道里的一份内容。换人后旧的那份还在原处淡出，这段时间它已经不是这条通道：不可交互，读屏也不再读它。 */
function LaneFace({ variants, enter, children }: { variants: Variants; enter: boolean; children: ReactNode }) {
  const present = useIsPresent();
  return (
    <motion.div className={styles.laneFace} inert={!present} variants={variants} initial={enter ? "enter" : false} animate="show" exit="leave">
      {children}
    </motion.div>
  );
}

const laneIds = (lanes: readonly (Task | null)[]) => lanes.map((t) => (t === null ? null : t.id));
const sameIds = (a: readonly (string | null)[], b: readonly (string | null)[]) => a.every((id, i) => id === b[i]);

export function LanesCard({ running, finishing, queued }: LanesCardProps) {
  const [occupants, setOccupants] = useState(() => laneIds(laneSlots(NO_LANES, running, finishing)));
  const lanes = laneSlots(occupants, running, finishing);
  const ids = laneIds(lanes);
  if (!sameIds(ids, occupants)) setOccupants(ids);
  // 挂载时就在的通道内容跟着页面入场，不另播换人
  const mounted = useMounted();
  // 减少动画时通道换人只交叉淡化：位移在那里一步到位，旧行会先跳一下再淡出
  const swap = useReducedMotionConfig() === true ? lineSwapFade : lineSwap;
  const queuedText = TASKS_COPY.lanes.queued(queued.length);

  return (
    <Card>
      <CardHeader title={TASKS_COPY.lanes.title} subtitle={TASKS_COPY.lanes.subtitle} icon="layers" level={2} />
      <ol className={styles.lanes}>
        {lanes.map((task, i) => (
          // 通道是固定的三个位置，按位置作 key；里面换人由下面按任务作 key 的那一层交接
          <li key={i} className={styles.lane} data-busy={task === null ? undefined : ""}>
            <span className={styles.laneNo} aria-hidden="true">
              {i + 1}
            </span>
            <div className={styles.laneSlot}>
              <AnimatePresence>
                <LaneFace key={task === null ? "idle" : task.id} variants={swap} enter={mounted.current}>
                  {task === null ? (
                    <span className={styles.laneIdle}>{TASKS_COPY.lanes.idle}</span>
                  ) : (
                    <div className={styles.laneBody}>
                      <div className={styles.laneTitle}>
                        <span className={styles.laneName} title={task.title}>
                          {task.title}
                        </span>
                        <SmoothPercent className={styles.lanePct} value={task.progress} track={progressTrack(task)} />
                      </div>
                      <ProgressBar value={task.progress} size="sm" track={progressTrack(task)} label={TASKS_COPY.lanes.progressLabel(task.title)} />
                    </div>
                  )}
                </LaneFace>
              </AnimatePresence>
            </div>
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
            {/* 窄窗口里放不下就省略，不折成两行：这张卡定了总览行的高度，折行会把下面的筛选与列表推下去 */}
            <span className={styles.queueText} title={queuedText}>
              {queuedText}
            </span>
          </>
        ) : (
          <>
            <Icon name="check-circle" size={14} />
            <span className={styles.queueText}>{TASKS_COPY.lanes.none}</span>
          </>
        )}
      </p>
    </Card>
  );
}
