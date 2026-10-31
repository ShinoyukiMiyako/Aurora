// 实例卡片底栏左侧的启动入口：与启动胶囊、状态岛、侧栏图标读同一个启动视图，只是紧凑形态。
// 每种视图写什么、点了做什么都照搬胶囊的判定，这里只负责排版。

import { Icon } from "../../art/Icon";
import { LAUNCH_COPY, SESSION_COPY, TASK_STATUS_LABEL } from "../../copy/flows";
import { percent } from "../../domain/format";
import { sessionPhaseLabel, stageLabel, type LaunchView } from "../../launch/launchView";
import { useLaunch, type LaunchEntry } from "../../launch/useLaunch";
import { useNow } from "../../state/launcher";
import { Button } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";
import { ProgressBar } from "../../ui/ProgressBar";
import styles from "./library.module.css";

export function CardStatus({ instanceId }: { instanceId: string }) {
  const entry = useLaunch(instanceId);
  const view = entry.view;
  switch (view.kind) {
    case "ready":
      return (
        <div className={styles.status} data-view="ready">
          <Button size="sm" icon="play" onClick={entry.launch}>
            {LAUNCH_COPY.launchShort}
          </Button>
          {view.busyElsewhere && <span className={styles.statusHint}>{LAUNCH_COPY.busyElsewhere}</span>}
        </div>
      );
    case "loading":
      return <LoadingStatus view={view} entry={entry} />;
    case "running":
      return <RunningStatus view={view} entry={entry} />;
    case "stopped":
      return (
        <div className={styles.status} data-view="stopped">
          <span className={styles.statusHint}>
            <Icon name="check" size={14} />
            {sessionPhaseLabel(view.session)}
          </span>
        </div>
      );
    case "failed": {
      const failure = entry.failure;
      if (failure === null) throw new Error("启动失败的入口缺少失败文案");
      return (
        <div className={styles.status} data-view="failed">
          <span className={styles.statusDanger}>{LAUNCH_COPY.failedTitle}</span>
          <Button size="sm" onClick={() => entry.fix(failure.fix.kind)}>
            {failure.fix.label}
          </Button>
        </div>
      );
    }
    case "crashed":
      return (
        <div className={styles.status} data-view="crashed">
          <span className={styles.statusDanger}>{LAUNCH_COPY.crashedTitle}</span>
          <Button
            size="sm"
            onClick={() => {
              entry.openCrash();
              entry.dismiss();
            }}
          >
            {LAUNCH_COPY.viewCrash}
          </Button>
        </div>
      );
    case "installing":
      return <InstallingStatus view={view} />;
    case "broken":
      return (
        <div className={styles.status} data-view="broken">
          <Button size="sm" icon="wrench" onClick={entry.launch}>
            {LAUNCH_COPY.repairAndLaunch}
          </Button>
        </div>
      );
  }
}

function LoadingStatus({ view, entry }: { view: Extract<LaunchView, { kind: "loading" }>; entry: LaunchEntry }) {
  const s = view.session;
  const stopping = entry.stopping;
  return (
    <div className={styles.status} data-view="loading">
      <div className={styles.statusProgress}>
        <span className={styles.statusLine}>
          <span className={styles.ellipsis}>{stopping ? SESSION_COPY.stopping : stageLabel(s.stageIndex)}</span>
          <b className={styles.statusPct}>{percent(s.progress, true)}</b>
        </span>
        <ProgressBar value={s.progress} size="sm" track={s.taskId} label={stageLabel(s.stageIndex)} />
      </div>
      <IconButton icon="x" label={LAUNCH_COPY.cancel} size="sm" disabled={stopping} onClick={entry.cancel} />
    </div>
  );
}

function RunningStatus({ view, entry }: { view: Extract<LaunchView, { kind: "running" }>; entry: LaunchEntry }) {
  const now = useNow(1000);
  const since = view.session.runningSince;
  if (since === null) throw new Error("running 会话缺少运行起点");
  const stopping = entry.stopping;
  return (
    <div className={styles.status} data-view="running">
      <span className={styles.running}>
        <span className={styles.runningDot} aria-hidden="true" />
        {stopping ? SESSION_COPY.stopping : LAUNCH_COPY.runningTitle(now - since)}
      </span>
      <Button size="sm" variant="ghost" icon="stop" loading={stopping} onClick={entry.stop}>
        {LAUNCH_COPY.stopGame}
      </Button>
    </div>
  );
}

function InstallingStatus({ view }: { view: Extract<LaunchView, { kind: "installing" }> }) {
  const task = view.task;
  // 排队（或后端在装、本次运行没有对应任务）时不画进度段：排队可能很久，不定进度条不允许常驻
  const queued = task === null || task.status === "queued";
  return (
    <div className={styles.status} data-view="installing">
      <div className={styles.statusProgress}>
        <span className={styles.statusLine}>
          <span className={styles.ellipsis}>{queued ? LAUNCH_COPY.queuedTitle : LAUNCH_COPY.installingTitle(percent(task.progress))}</span>
          {queued && <b className={styles.statusPct}>{TASK_STATUS_LABEL.queued}</b>}
        </span>
        <ProgressBar
          value={queued ? 0 : task.progress}
          tone="info"
          size="sm"
          track={queued ? undefined : `${task.id}#${task.attempt}`}
          label={queued ? LAUNCH_COPY.queuedTitle : task.title}
        />
      </div>
    </div>
  );
}
