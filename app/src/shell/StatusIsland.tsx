// 启动状态岛：标题栏中列的会话胶囊，任何页面都能看到当前游戏会话。会话出现即出现，清空即退场。
// 点开是会话详情（阶段清单、最近 4 行日志、动作），动作经状态容器的会话动作与外层统一错误处理执行。
//
// 退场动画期间外层拿到的会话是最后一帧的快照：显示按快照画；会话可能因为实例被删除而清空，
// 所以这里只按 id 查实例、查不到时退回 id 显示，不读必然存在的实例。

import { AnimatePresence, motion, useIsPresent, useTransform, type Variants } from "framer-motion";
import { useCallback, useRef, useState } from "react";
import { Icon } from "../art/Icon";
import { InstanceBlock } from "../art/iso/InstanceBlock";
import { ACTION_ERROR, CONFIRM_COPY, LAUNCH_COPY, LAUNCH_STAGES, PHASE_LABEL, SESSION_COPY, STOPPED_LABEL, failureCopy, type FailureFixKind } from "../copy/flows";
import type { InstanceSummary } from "../domain/adapt";
import { clock, formatElapsed, formatSpeed, percent } from "../domain/format";
import { useBreathPhase } from "../launch/breath";
import { instanceCover } from "../launch/cover";
import { useLaunchHost } from "../launch/host";
import { sessionDetail, sessionPhaseLabel } from "../launch/launchView";
import { fade, shake, springs } from "../lib/motion";
import { useLauncherActions, useLauncherSelector, useNow } from "../state/launcher";
import { findInstance } from "../state/selectors";
import { isLoadingPhase, type SessionState } from "../state/session";
import { Button } from "../ui/Button";
import { Popover } from "../ui/Popover";
import { fillOffset, useSmoothProgress } from "../ui/ProgressBar";
import { ProgressRing } from "../ui/ProgressRing";
import { ISLAND_COPY } from "../copy/shell";
import { useShell } from "./shell";
import styles from "./StatusIsland.module.css";
import type { Tier } from "./tier";

/** 胶囊高 34，圆角取高度一半；经 style 传给布局动画，宽度变化时圆角不被拉伸。 */
const ISLAND_RADIUS = 17;

export type IslandTone = "loading" | "running" | "danger" | "neutral";

export function islandTone(session: SessionState): IslandTone {
  if (isLoadingPhase(session.phase)) return "loading";
  if (session.phase === "running") return "running";
  if (session.phase === "failed" || session.phase === "crashed") return "danger";
  return "neutral";
}

export interface IslandSecond {
  /** 阶段文字；compact 档的加载与运行只留数字。 */
  label: string | null;
  /** 百分比或计时：放进固定宽的槽里，数字变化不改胶囊宽度。 */
  value: string | null;
}

/** 收起态的第二段：加载阶段「准备中 37%」（封顶 99%），运行「已运行 mm:ss」；compact 档用短格式。 */
export function islandSecond(session: SessionState, tier: Tier, now: number, stopping: boolean): IslandSecond {
  const compact = tier === "compact";
  const phase = session.phase;
  if (stopping && (isLoadingPhase(phase) || phase === "running")) return { label: SESSION_COPY.stopping, value: null };
  if (isLoadingPhase(phase)) {
    const pct = percent(session.progress, true);
    return { label: compact ? null : PHASE_LABEL[phase], value: pct };
  }
  switch (phase) {
    case "running": {
      if (session.runningSince === null) throw new Error("running 会话缺少运行起点");
      const elapsed = now - session.runningSince;
      return compact ? { label: null, value: formatElapsed(elapsed) } : { label: SESSION_COPY.running(elapsed), value: null };
    }
    case "stopped": {
      if (session.stopReason === null) throw new Error("stopped 会话缺少结束原因");
      if (session.stopReason === "cancelled") return { label: compact ? ISLAND_COPY.shortCancelled : STOPPED_LABEL.cancelled, value: null };
      return { label: compact ? ISLAND_COPY.shortEnded : STOPPED_LABEL[session.stopReason], value: null };
    }
    case "failed":
      return { label: PHASE_LABEL.failed, value: null };
    case "crashed":
      return { label: PHASE_LABEL.crashed, value: null };
  }
}

export function islandSecondText(second: IslandSecond): string {
  return [second.label, second.value].filter((part): part is string => part !== null).join(" ");
}

export function StatusIsland() {
  // 只随会话变（含展开时显示的日志），下载进度不让状态岛重渲染
  const session = useLauncherSelector((s) => s.session);
  return <AnimatePresence>{session !== null && <Island key="island" session={session} />}</AnimatePresence>;
}

const shakeVariants: Variants = {
  rest: { x: 0 },
  shake: { x: [...shake.x], transition: shake.transition },
};

function Island({ session }: { session: SessionState }) {
  const actions = useLauncherActions();
  const instance = useLauncherSelector((s) => findInstance(s, session.instanceId));
  const { tier } = useShell();
  const host = useLaunchHost();
  const now = useNow(1000);
  const present = useIsPresent();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  // 「正在结束」是纯界面态：确认结束或点了取消、IPC 还没返回的这段时间；超时由动作本身以错误结束
  const [stopping, setStopping] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const name = instance === undefined ? session.instanceId : instance.name;
  const tone = islandTone(session);
  const second = islandSecond(session, tier, now, stopping);
  const loading = isLoadingPhase(session.phase);

  const endSession = async () => {
    setStopping(true);
    await host.run(() => actions.stop(), ACTION_ERROR.stop);
    setStopping(false);
  };
  const controls: IslandControls = {
    stopping,
    cancel: () => void endSession(),
    stop: () =>
      void (async () => {
        if (await host.confirm({ ...CONFIRM_COPY.stopGame(name), tone: "danger" })) await endSession();
      })(),
    dismiss: () => actions.dismissSession(),
    openLogs: () => host.go({ page: "instance", id: session.instanceId, tab: "logs" }),
    openCrash: () => host.go({ page: "instance", id: session.instanceId, tab: "crash" }),
    fix: (kind) =>
      void host.run(async () => {
        const target = actions.failureFix(kind);
        if ("to" in target) host.go(target.to);
        else await host.run(target.run, target.errorTitle);
      }, ACTION_ERROR.launch(name)),
  };

  return (
    <>
      <motion.button
        ref={setAnchor}
        type="button"
        layout
        className={styles.island}
        data-tone={tone}
        data-open={open || undefined}
        aria-label={ISLAND_COPY.label(name, islandSecondText(second))}
        aria-expanded={open}
        aria-haspopup="dialog"
        style={{ borderRadius: ISLAND_RADIUS }}
        initial={{ opacity: 0, scale: 0.92 }}
        animate={{ opacity: 1, scale: 1, transition: { ...springs.base, opacity: fade.in } }}
        exit={{ opacity: 0, scale: 0.96, transition: fade.out }}
        transition={{ layout: springs.morph }}
        onClick={() => setOpen((v) => !v)}
      >
        <motion.span className={styles.row} layout="position" variants={shakeVariants} initial={false} animate={session.phase === "crashed" ? "shake" : "rest"}>
          <span className={styles.blockFrame} aria-hidden="true">
            {instance !== undefined && <InstanceBlock instanceId={instance.id} cover={instanceCover(instance)} width={20} />}
          </span>
          <span className={styles.name}>{name}</span>
          <span className={styles.second}>
            {second.label !== null && <span>{second.label}</span>}
            {second.value !== null && <span className={styles.value}>{second.value}</span>}
          </span>
          {tone === "running" && <RunningDot />}
          {session.phase === "crashed" && <motion.span className={styles.dangerDot} initial={{ scale: 0 }} animate={{ scale: 1, transition: springs.pop }} aria-hidden="true" />}
        </motion.span>
        <AnimatePresence>{loading && <IslandBar key="bar" session={session} />}</AnimatePresence>
      </motion.button>
      <span className={styles.srOnly} aria-live="polite">
        {ISLAND_COPY.announce(name, sessionPhaseLabel(session))}
      </span>
      <Popover open={open && present} anchor={anchor} onClose={close} placement="bottom" autoFocus aria-label={ISLAND_COPY.detailsLabel(name)}>
        <div className={styles.detail}>
          <DetailHead session={session} instance={instance} name={name} now={now} />
          {loading && <StageList session={session} />}
          <LatestLogs session={session} />
          <DetailActions session={session} controls={controls} onClose={close} />
        </div>
      </Popover>
    </>
  );
}

function RunningDot() {
  const ref = useRef<HTMLSpanElement>(null);
  useBreathPhase(ref, true);
  return <motion.span ref={ref} className={styles.runningDot} initial={{ scale: 0 }} animate={{ scale: 1, transition: springs.pop }} aria-hidden="true" />;
}

function IslandBar({ session }: { session: SessionState }) {
  const { smooth } = useSmoothProgress(session.progress, session.taskId);
  const x = useTransform(smooth, fillOffset);
  return (
    <motion.span className={styles.barTrack} aria-hidden="true" exit={{ opacity: 0, transition: fade.out }}>
      <motion.span className={styles.barFill} style={{ x }} />
    </motion.span>
  );
}

function DetailHead({ session, instance, name, now }: { session: SessionState; instance: InstanceSummary | undefined; name: string; now: number }) {
  const detail = sessionDetail(session, now);
  const phase = sessionPhaseLabel(session);
  return (
    <div className={styles.head}>
      <span className={styles.headBlock} aria-hidden="true">
        {instance !== undefined && <InstanceBlock instanceId={instance.id} cover={instanceCover(instance)} width={28} />}
      </span>
      <div className={styles.headText}>
        <p className={styles.headName}>{name}</p>
        <p className={styles.headPhase}>{detail === null ? phase : `${phase} · ${detail}`}</p>
      </div>
      {isLoadingPhase(session.phase) && <ProgressRing value={session.progress} size={36} capAt99 track={session.taskId} label={ISLAND_COPY.progressLabel} />}
    </div>
  );
}

export type StageState = "done" | "now" | "todo";

/** 阶段清单不含最后一项「游戏运行中」：清单只在加载阶段出现。 */
const LOADING_STAGES = LAUNCH_STAGES.slice(0, -1);
const DOWNLOAD_STAGE = 3;

export function stageState(stageIndex: number, index: number): StageState {
  if (index < stageIndex) return "done";
  return index === stageIndex ? "now" : "todo";
}

/** 下载阶段那一行的右侧：进行中写「done/total · 速度」，没有缺失文件被跳过时写「无需下载」。 */
export function downloadStageNote(session: SessionState): string | null {
  const d = session.download;
  if (session.stageIndex === DOWNLOAD_STAGE) return d === null || d.total === null ? null : `${d.done}/${d.total} · ${formatSpeed(d.speedBps)}`;
  if (session.stageIndex > DOWNLOAD_STAGE && d === null) return SESSION_COPY.noDownload;
  return null;
}

/**
 * 阶段清单一行的右侧：下载阶段写进度或「无需下载」；其余情况下这一阶段有启动器提醒（例如准备阶段检查项给出的警告）
 * 时写「N 条提醒」。提醒只记在日志里、不弹通知，这里是它在界面上唯一的痕迹。
 */
export function stageNote(session: SessionState, index: number): string | null {
  if (index === DOWNLOAD_STAGE) {
    const note = downloadStageNote(session);
    if (note !== null) return note;
  }
  const warned = session.stageWarnings[index];
  if (warned === undefined) throw new Error(`启动阶段 ${index} 没有提醒计数`);
  return warned > 0 ? ISLAND_COPY.stageWarnings(warned) : null;
}

function StageList({ session }: { session: SessionState }) {
  return (
    <ol className={styles.stages} aria-label={ISLAND_COPY.stagesLabel}>
      {LOADING_STAGES.map((label, i) => {
        const st = stageState(session.stageIndex, i);
        const note = stageNote(session, i);
        return (
          <li key={label} className={styles.stage} data-state={st}>
            <span className={styles.stageDot} aria-hidden="true">
              {st === "done" && (
                <motion.span className={styles.stageCheck} initial={{ scale: 0.6 }} animate={{ scale: 1, transition: springs.pop }}>
                  <Icon name="check" size={12} />
                </motion.span>
              )}
            </span>
            <span className={styles.stageLabel}>{label}</span>
            {note !== null && <span className={styles.stageNote}>{note}</span>}
          </li>
        );
      })}
    </ol>
  );
}

const LOG_LINES = 4;

function LatestLogs({ session }: { session: SessionState }) {
  if (session.logs.length === 0) return null;
  const lines = session.logs.slice(-LOG_LINES);
  const offset = session.logs.length - lines.length;
  return (
    <div className={styles.logs} role="log" aria-label={ISLAND_COPY.logLabel}>
      {lines.map((line, i) => (
        <p key={offset + i} className={styles.logLine} data-level={line.level}>
          {`${clock(line.at)} ${line.text}`}
        </p>
      ))}
    </div>
  );
}

interface IslandControls {
  stopping: boolean;
  cancel(): void;
  stop(): void;
  dismiss(): void;
  openLogs(): void;
  openCrash(): void;
  fix(kind: FailureFixKind): void;
}

function islandFailure(session: SessionState) {
  if (session.failure === null) throw new Error("failed 会话缺少失败码");
  return failureCopy(session.failure.code, session.failure.params, { accountName: session.accountName, javaPinned: false });
}

function DetailActions({ session, controls, onClose }: { session: SessionState; controls: IslandControls; onClose: () => void }) {
  const phase = session.phase;
  // 「完整日志」「查看诊断」与修复动作先关浮层再执行
  const leave = (work: () => void) => () => {
    onClose();
    work();
  };
  // 修复动作只用第一个按钮；第二个按钮（与实例是否固定 Java 有关）不在岛里出现
  const failure = phase === "failed" ? islandFailure(session) : null;
  // spawn_failed 的修复动作本身就是「完整日志」，不再重复一个同名按钮
  const showLogs = failure === null || failure.fix.kind !== "open_logs";
  return (
    <div className={styles.actions}>
      {showLogs && (
        <Button variant="ghost" size="sm" onClick={leave(controls.openLogs)}>
          {ISLAND_COPY.fullLog}
        </Button>
      )}
      {isLoadingPhase(phase) && (
        <Button variant="secondary" size="sm" icon="x" loading={controls.stopping} onClick={controls.cancel}>
          {LAUNCH_COPY.cancel}
        </Button>
      )}
      {phase === "running" && (
        <Button variant="secondary" size="sm" icon="stop" loading={controls.stopping} onClick={controls.stop}>
          {LAUNCH_COPY.stopGame}
        </Button>
      )}
      {(phase === "failed" || phase === "crashed") && (
        <Button variant="ghost" size="sm" onClick={controls.dismiss}>
          {LAUNCH_COPY.dismiss}
        </Button>
      )}
      {failure !== null && (
        <Button variant="primary" size="sm" onClick={leave(() => controls.fix(failure.fix.kind))}>
          {failure.fix.label}
        </Button>
      )}
      {phase === "crashed" && (
        <Button variant="primary" size="sm" onClick={leave(controls.openCrash)}>
          {LAUNCH_COPY.viewCrash}
        </Button>
      )}
    </div>
  );
}
