// 任务行：类型图标（带结局角标）、标题与类别标、详情、进度条（仅活动任务）、元信息行、右侧操作。

import { Icon, type IconName } from "../../art/Icon";
import { TASK_KIND_LABEL, taskStatusLabel } from "../../copy/flows";
import { percent } from "../../domain/format";
import type { Task, TaskStatus } from "../../domain/types";
import { cx } from "../../lib/util";
import { isActiveTask, progressTrack } from "../../state/tasks";
import { Button } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";
import { ListRow } from "../../ui/ListRow";
import { ProgressBar } from "../../ui/ProgressBar";
import { Tag } from "../../ui/Tag";
import { TASKS_COPY } from "./copy";
import { KIND_ICON, type RowMeta } from "./model";
import styles from "./tasks.module.css";

type BadgeTone = "ok" | "danger" | "muted";

const OUTCOME_BADGE: Readonly<Partial<Record<TaskStatus, { tone: BadgeTone; icon: IconName }>>> = {
  done: { tone: "ok", icon: "check" },
  failed: { tone: "danger", icon: "alert" },
  cancelled: { tone: "muted", icon: "x" },
};

function KindTile({ task }: { task: Task }) {
  const badge = OUTCOME_BADGE[task.status];
  return (
    <span
      className={styles.tile}
      data-active={isActiveTask(task) ? "" : undefined}
      role="img"
      aria-label={`${TASK_KIND_LABEL[task.kind]}，${taskStatusLabel(task)}`}
    >
      <Icon name={KIND_ICON[task.kind]} size={20} />
      {badge !== undefined && (
        <span className={styles.badge} data-tone={badge.tone}>
          <Icon name={badge.icon} size={12} />
        </span>
      )}
    </span>
  );
}

export interface TaskRowProps {
  task: Task;
  meta: RowMeta;
  /** 关联的实例还在实例列表里（新建被取消后实例已撤掉，就不给「查看实例」）。 */
  hasInstance: boolean;
  /** 重试眼下必然失败（断网）时的原因：按钮置灰并在悬停时说明；能重试为 undefined。 */
  retryBlocked: string | undefined;
  onCancel(): void;
  onRetry(): void;
  /** 打开需要手动下载的文件清单；只有以这个原因失败的任务才有入口。 */
  onViewBlocked(): void;
  onViewInstance(): void;
}

export function TaskRow({ task, meta, hasInstance, retryBlocked, onCancel, onRetry, onViewBlocked, onViewInstance }: TaskRowProps) {
  const active = isActiveTask(task);
  const viewInstance = hasInstance && (
    <Button variant="ghost" size="sm" iconRight="arrow-right" onClick={onViewInstance}>
      {TASKS_COPY.row.viewInstance}
    </Button>
  );

  return (
    <ListRow
      size="lg"
      className={cx(styles.rowItem, (task.status === "done" || task.status === "cancelled") && styles.rowMuted)}
      leading={<KindTile task={task} />}
      title={
        <span className={styles.titleLine}>
          <span className={styles.titleText} title={task.title}>
            {task.title}
          </span>
          <Tag size="sm" tone="outline">
            {TASK_KIND_LABEL[task.kind]}
          </Tag>
          {task.status === "failed" && (
            <Tag size="sm" tone="danger">
              {TASKS_COPY.row.failedTag}
            </Tag>
          )}
        </span>
      }
      meta={task.detail === "" ? undefined : <span title={task.detail}>{task.detail}</span>}
      progress={
        <span className={styles.rowFoot}>
          {active && (
            // 排队中给静态空轨道，不用不定进度：一屏几十条循环光带会让同屏动画失控
            <ProgressBar
              value={task.status === "queued" ? 0 : task.progress}
              tone={task.status === "queued" ? "muted" : "accent"}
              size="sm"
              track={progressTrack(task)}
              label={TASKS_COPY.row.progressLabel(task.title)}
            />
          )}
          <span className={styles.rowMeta}>
            <span className={styles.rowMetaLeft} data-danger={meta.danger ? "" : undefined} title={meta.left}>
              {meta.left}
            </span>
            <span className={styles.rowMetaRight}>{meta.right}</span>
          </span>
        </span>
      }
      trailing={
        <span className={styles.side}>
          {task.status === "running" && <span className={styles.pct}>{percent(task.progress)}</span>}
          {active && <IconButton icon="x" label={TASKS_COPY.row.cancel} size="sm" onClick={onCancel} />}
          {/* 文件没到手时重试必然还是这个结果：清单找齐后由它重排任务 */}
          {task.status === "failed" &&
            (task.error?.blocked_files === undefined ? (
              <Button variant="secondary" size="sm" disabledReason={retryBlocked} onClick={onRetry}>
                {TASKS_COPY.row.retry}
              </Button>
            ) : (
              <Button variant="secondary" size="sm" onClick={onViewBlocked}>
                {TASKS_COPY.row.viewBlocked}
              </Button>
            ))}
          {!active && viewInstance}
        </span>
      }
    />
  );
}
