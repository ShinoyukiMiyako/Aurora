// 启动胶囊：实例启动的唯一入口与全程呈现。就绪 -> 准备 / 下载 / 启动 -> 运行中 -> 已结束 / 启动失败 / 崩溃，外加安装中、损坏。
// 状态只取 useLaunch 的视图；这里只决定每个面画什么、面与面之间怎么换。
//
// - 容器宽度随面变化（layout + morph 弹簧）；底色与描边是几张叠层，切换时交叉淡入，不过渡 background-color。
// - 面切换：旧面淡出上移，新面稍后淡入下落（popLayout，旧面不占位）。
// - 方块组装跨面连续：加载 -> 取消时拆解、加载 -> 失败 / 崩溃时崩落、加载 -> 运行时坐定，都要在旧面上演完再换面，
//   所以视图变化后先把旧面「留住」一小段（useFaceHold）；减少动画时不留，直接换。
// - 进度填充在容器级的裁切层里，按 translateX((p − 1) × 100%) 移动，不随面的入场位移一起动。

import { AnimatePresence, motion, useReducedMotionConfig, useTransform, type Variants } from "framer-motion";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../art/Icon";
import { ASSEMBLY_TIMING, AssemblingBlock, type AssemblyExit } from "../art/iso/AssemblingBlock";
import { Spinner } from "../art/Spinner";
import { LAUNCH_COPY, PHASE_LABEL, SESSION_COPY } from "../copy/flows";
import { percent } from "../domain/format";
import { fade, springs } from "../lib/motion";
import { cx } from "../lib/util";
import { useNow } from "../state/launcher";
import { progressTrack } from "../state/tasks";
import { softDisabledProps } from "../ui/Button";
import { fillOffset, useSmoothProgress } from "../ui/ProgressBar";
import { useBreathPhase } from "./breath";
import { instanceCover } from "./cover";
import styles from "./LaunchCapsule.module.css";
import { brokenAction, sessionDetail, sessionPhaseLabel, stageLabel, type LaunchView } from "./launchView";
import { useLaunch, type LaunchEntry } from "./useLaunch";

export type LaunchCapsuleSize = "md" | "lg";

export interface LaunchCapsuleProps {
  instanceId: string;
  /** md 高 48；lg 高 56（主页「继续游玩」）。 */
  size?: LaunchCapsuleSize;
  /** 撑满父宽。 */
  block?: boolean;
  /** 崩溃诊断页上就绪面写「重新启动」。 */
  relaunch?: boolean;
  className?: string;
}

export const CAPSULE_HEIGHT: Readonly<Record<LaunchCapsuleSize, number>> = { md: 48, lg: 56 };

/** 视图变化后旧面留住的时长（毫秒）：拆解、崩落演完再换面；坐定之后再过这么久切到运行面。 */
export const FACE_HOLD_MS = { disassemble: 240, collapse: 260, afterSeat: 200 } as const;

/** 新面比旧面晚这么久入场（秒），旧面先让出位置。 */
const FACE_ENTER_DELAY = 0.04;

type Tone = "loading" | "running" | "danger" | "muted" | "info" | "none";
const TONES: readonly Exclude<Tone, "none">[] = ["loading", "running", "danger", "muted", "info"];

function toneOf(face: LaunchView): Tone {
  switch (face.kind) {
    case "loading":
      return "loading";
    case "running":
      return "running";
    case "failed":
    case "crashed":
      return "danger";
    case "stopped":
      return "muted";
    case "installing":
      return "info";
    case "ready":
    case "broken":
      return "none";
  }
}

/** 面的身份：同一个面内部的数值变化（进度、计时）不触发换面。 */
export function faceKey(view: LaunchView): string {
  return view.kind === "stopped" ? `stopped:${view.reason}` : view.kind;
}

/** 按会话阶段落面：准备 1、下载 2、启动 3。 */
export function placedForStage(stageIndex: number): 0 | 1 | 2 | 3 {
  if (stageIndex < 3) return 1;
  if (stageIndex === 3) return 2;
  return 3;
}

/** 安装中按任务进度落面：≥ 0 左面、≥ 1/3 右面、≥ 2/3 顶面。 */
export function placedForProgress(progress: number): 1 | 2 | 3 {
  if (progress >= 2 / 3) return 3;
  if (progress >= 1 / 3) return 2;
  return 1;
}

interface FaceHold {
  face: LaunchView;
  /** 留住期间方块的退场方式；坐定时为 null。 */
  exit: AssemblyExit | null;
  /** 留住期间方块落齐并坐定（加载 -> 运行、安装 -> 就绪）。 */
  seat: boolean;
  ms: number;
}

/** 视图从 prev 换到 next 时旧面要不要留住、留多久；不留为 null。 */
export function holdFor(prev: LaunchView, next: LaunchView): FaceHold | null {
  if (prev.kind === "loading") {
    if (next.kind === "stopped" && next.reason === "cancelled") return { face: prev, exit: "disassemble", seat: false, ms: FACE_HOLD_MS.disassemble };
    if (next.kind === "failed" || next.kind === "crashed") return { face: prev, exit: "collapse", seat: false, ms: FACE_HOLD_MS.collapse };
    if (next.kind === "running") return { face: prev, exit: null, seat: true, ms: seatAt(placedForStage(prev.session.stageIndex)) + FACE_HOLD_MS.afterSeat };
  }
  if (prev.kind === "installing" && next.kind === "ready") {
    const task = prev.task;
    const placed = task === null || task.status === "queued" ? 1 : placedForProgress(task.progress);
    return { face: prev, exit: null, seat: true, ms: seatAt(placed) + FACE_HOLD_MS.afterSeat };
  }
  return null;
}

/** 坐定时刻：未落的面依次落下（间隔 90 ms），最后一面开始落位 120 ms 后坐定；三面早已落齐则为 0。 */
function seatAt(placed: number): number {
  const remaining = 3 - placed;
  return remaining > 0 ? (remaining - 1) * ASSEMBLY_TIMING.stepGapMs + ASSEMBLY_TIMING.seatDelayMs : 0;
}

function useFaceHold(view: LaunchView, reduced: boolean): { face: LaunchView; exit: AssemblyExit | null; seat: boolean } {
  const key = faceKey(view);
  // 上一次提交时的视图：留住的旧面要用它最后的样子（下载到一半取消，方块与进度停在取消那一刻）
  const committed = useRef(view);
  useLayoutEffect(() => {
    committed.current = view;
  });
  const [prevKey, setPrevKey] = useState(key);
  const [hold, setHold] = useState<FaceHold | null>(null);
  if (key !== prevKey) {
    // 渲染期间就决定留不留：比 effect 早一帧，旧面不会先换成新面再闪回来
    setPrevKey(key);
    setHold(reduced ? null : holdFor(committed.current, view));
  }
  useEffect(() => {
    if (hold === null) return;
    const timer = setTimeout(() => setHold(null), hold.ms);
    return () => clearTimeout(timer);
  }, [hold]);
  if (hold !== null) return { face: hold.face, exit: hold.exit, seat: hold.seat };
  return { face: view, exit: null, seat: false };
}

const faceSwap: Variants = {
  enter: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: { ...springs.settle, delay: FACE_ENTER_DELAY, opacity: { ...fade.in, delay: FACE_ENTER_DELAY } } },
  leave: { opacity: 0, y: -6, transition: fade.out },
};

export function LaunchCapsule({ instanceId, size = "md", block = false, relaunch = false, className }: LaunchCapsuleProps) {
  const entry = useLaunch(instanceId);
  const reduced = useReducedMotionConfig() === true;
  const { face, exit, seat } = useFaceHold(entry.view, reduced);
  const capsuleRef = useRef<HTMLDivElement>(null);
  const key = faceKey(face);
  // 键盘按了面上的按钮（「启动」「结束游戏」）随即换面：焦点还停在退场的旧面上，旧面移除时浏览器把它落回 body
  // 且不派发任何事件，键盘用户只能从文档开头重新找起。换面时焦点在胶囊里，就交给新面第一个可用的按钮；
  // 新面没有按钮（安装中、已结束）时交给胶囊本身（不进 Tab 序列），之后换上带按钮的面再交给按钮
  useLayoutEffect(() => {
    const capsule = capsuleRef.current;
    if (capsule === null || !capsule.contains(document.activeElement)) return;
    const next = capsule.querySelector<HTMLElement>(`[data-face="${key}"] button:not(:disabled)`);
    (next ?? capsule).focus();
  }, [key]);
  const tone = toneOf(face);
  const expanded = face.kind !== "ready" && face.kind !== "broken";
  const height = CAPSULE_HEIGHT[size];
  const fill = fillOf(face, seat);
  const announce = entry.view.kind === "loading" || entry.view.kind === "running" || entry.view.kind === "stopped" || entry.view.kind === "failed" || entry.view.kind === "crashed"
    ? sessionPhaseLabel(entry.view.session)
    : "";

  return (
    <motion.div
      ref={capsuleRef}
      layout
      transition={{ layout: springs.morph }}
      role="group"
      aria-label={LAUNCH_COPY.group(entry.instance.name)}
      tabIndex={-1}
      className={cx(styles.capsule, className)}
      data-size={size}
      data-block={block || undefined}
      data-expanded={expanded || undefined}
      style={{ borderRadius: height / 2 }}
    >
      {TONES.map((t) => (
        <span key={t} className={styles.layer} data-layer={t} data-active={t === tone || undefined} aria-hidden="true" />
      ))}
      {face.kind === "running" && <BreathGlow />}
      {fill !== null && <Fill value={fill.value} track={fill.track} tone={fill.tone} />}
      {/* 只播报 phase 的变化，计时与百分比不播报 */}
      <span className={styles.srOnly} aria-live="polite">
        {announce}
      </span>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div key={key} data-face={key} layout className={styles.face} variants={faceSwap} initial="enter" animate="show" exit="leave">
          <Face face={face} entry={entry} exit={exit} seat={seat} relaunch={relaunch} />
        </motion.div>
      </AnimatePresence>
    </motion.div>
  );
}

export function fillOf(face: LaunchView, seat: boolean): { value: number; track: string; tone: "loading" | "info" } | null {
  if (face.kind === "loading") return { value: seat ? 1 : face.session.progress, track: face.session.taskId, tone: "loading" };
  if (face.kind === "installing" && face.task !== null && face.task.status === "running") {
    return { value: seat ? 1 : face.task.progress, track: progressTrack(face.task), tone: "info" };
  }
  return null;
}

function Fill({ value, track, tone }: { value: number; track: string; tone: "loading" | "info" }) {
  const { smooth } = useSmoothProgress(value, track);
  const x = useTransform(smooth, fillOffset);
  return (
    <span className={styles.clip} aria-hidden="true">
      <motion.span className={styles.fill} data-tone={tone} style={{ x }} />
    </span>
  );
}

function BreathGlow() {
  const ref = useRef<HTMLSpanElement>(null);
  useBreathPhase(ref, true);
  return <span ref={ref} className={styles.glow} aria-hidden="true" />;
}

function Face({ face, entry, exit, seat, relaunch }: { face: LaunchView; entry: LaunchEntry; exit: AssemblyExit | null; seat: boolean; relaunch: boolean }) {
  const cover = instanceCover(entry.instance);
  const id = entry.instance.id;
  switch (face.kind) {
    case "ready":
      return (
        <button type="button" className={styles.go} onClick={entry.launch}>
          <Icon name="play" size={18} />
          {relaunch ? LAUNCH_COPY.relaunch : LAUNCH_COPY.launch}
        </button>
      );
    case "broken": {
      const action = brokenAction(face);
      return (
        <button type="button" className={styles.go} data-tone="warn" onClick={entry.launch}>
          <Icon name={action.icon} size={18} />
          {action.label}
        </button>
      );
    }
    case "loading": {
      const s = face.session;
      const stopping = entry.stopping && entry.view.kind === "loading";
      return (
        <>
          <span className={styles.blockSlot}>
            <AssemblingBlock instanceId={id} cover={cover} placed={seat ? 3 : placedForStage(s.stageIndex)} seated={seat} exit={exit} width={28} />
          </span>
          <Text
            title={stopping ? SESSION_COPY.stopping : stageLabel(s.stageIndex)}
            sub={face.phase === "downloading" ? sessionDetail(s, Date.now()) : PHASE_LABEL[face.phase]}
          />
          <Percent value={seat ? 1 : s.progress} track={s.taskId} />
          <IconAction label={LAUNCH_COPY.cancel} icon="x" onClick={entry.cancel} disabled={stopping || exit !== null || seat} />
        </>
      );
    }
    case "running":
      return <RunningFace face={face} entry={entry} />;
    case "stopped":
      return (
        <>
          {face.reason !== "cancelled" && (
            <span className={styles.blockSlot}>
              <AssemblingBlock instanceId={id} cover={cover} placed={3} seated width={28} />
            </span>
          )}
          <Text title={sessionPhaseLabel(face.session)} sub={sessionDetail(face.session, Date.now())} />
        </>
      );
    case "failed": {
      const failure = entry.failure;
      if (failure === null) throw new Error("启动失败的入口缺少失败文案");
      return (
        <>
          <span className={styles.dot} data-tone="danger" />
          <Text title={LAUNCH_COPY.failedTitle} sub={failure.title} />
          <span className={styles.actions}>
            <button type="button" className={styles.pill} onClick={() => entry.fix(failure.fix.kind)}>
              {failure.fix.label}
            </button>
            <IconAction label={LAUNCH_COPY.dismiss} icon="x" onClick={entry.dismiss} />
          </span>
        </>
      );
    }
    case "crashed":
      return (
        <>
          <span className={styles.dot} data-tone="danger" />
          <Text title={LAUNCH_COPY.crashedTitle} sub={sessionDetail(face.session, Date.now())} />
          <span className={styles.actions}>
            <button type="button" className={styles.pill} onClick={entry.openCrash}>
              {LAUNCH_COPY.viewCrash}
            </button>
            <IconAction label={LAUNCH_COPY.dismiss} icon="x" onClick={entry.dismiss} />
          </span>
        </>
      );
    case "installing": {
      const task = face.task;
      const queued = task === null || task.status === "queued";
      return (
        <>
          <span className={styles.blockSlot}>
            <AssemblingBlock instanceId={id} cover={cover} placed={seat ? 3 : queued ? 1 : placedForProgress(task.progress)} seated={seat} width={28} />
          </span>
          {queued ? (
            <Text title={LAUNCH_COPY.queuedTitle} sub={face.queuePosition === null ? null : LAUNCH_COPY.queuedDetail(face.queuePosition)} />
          ) : (
            <InstallingText progress={seat ? 1 : task.progress} track={progressTrack(task)} sub={task.title} />
          )}
        </>
      );
    }
  }
}

function RunningFace({ face, entry }: { face: Extract<LaunchView, { kind: "running" }>; entry: LaunchEntry }) {
  const now = useNow(1000);
  const runningSince = face.session.runningSince;
  if (runningSince === null) throw new Error("running 会话缺少运行起点");
  const stopping = entry.stopping && entry.view.kind === "running";
  return (
    <>
      <span className={styles.dot} data-tone="ok" />
      <Text title={stopping ? SESSION_COPY.stopping : LAUNCH_COPY.runningTitle(now - runningSince)} sub={entry.instance.name} />
      <span className={styles.actions}>
        {/* 正在结束期间不用原生禁用：确认框关闭后焦点刚还到这里，原生禁用会把它丢回 body */}
        <button type="button" className={styles.pill} data-tone="ok" {...softDisabledProps(stopping, entry.stop)} aria-busy={stopping || undefined}>
          {stopping ? <Spinner size={16} tone="current" decorative /> : <Icon name="stop" size={14} />}
          {LAUNCH_COPY.stopGame}
        </button>
      </span>
    </>
  );
}

function Text({ title, sub }: { title: ReactNode; sub: ReactNode | null }) {
  return (
    <span className={styles.text}>
      <span className={styles.title}>{title}</span>
      {sub !== null && <span className={styles.sub}>{sub}</span>}
    </span>
  );
}

/** 百分比文字取平滑值的整数，加载阶段封顶 99%。 */
function Percent({ value, track }: { value: number; track: string }) {
  const { smooth } = useSmoothProgress(value, track);
  const text = useTransform(smooth, (p) => percent(p, true));
  return <motion.span className={styles.pct}>{text}</motion.span>;
}

function InstallingText({ progress, track, sub }: { progress: number; track: string; sub: string }) {
  const { smooth } = useSmoothProgress(progress, track);
  const title = useTransform(smooth, (p) => LAUNCH_COPY.installingTitle(percent(p)));
  return <Text title={<motion.span>{title}</motion.span>} sub={sub} />;
}

/** disabled 时保持可聚焦（aria-disabled）：按下「取消启动」后、换面之前，焦点要留在胶囊里等新面接住。 */
function IconAction({ label, icon, onClick, disabled = false }: { label: string; icon: "x"; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className={styles.iconAction} aria-label={label} {...softDisabledProps(disabled, onClick)}>
      <Icon name={icon} size={16} />
    </button>
  );
}
