// 启动胶囊：实例启动的唯一入口与全程呈现。就绪 -> 准备 / 下载 / 启动 -> 运行中 -> 已结束 / 启动失败 / 崩溃，外加安装中、损坏。
// 状态只取 useLaunch 的视图；这里只决定每个面画什么、面与面之间怎么换。
//
// - 容器宽度随面变化（layout + morph 弹簧）；底色与描边是几张叠层，切换时交叉淡入，不过渡 background-color。
// - 面切换：旧面淡出上移，新面稍后淡入下落（popLayout，旧面不占位）。
// - 方块组装跨面连续：加载 -> 取消时拆解、加载 -> 失败 / 崩溃时崩落、加载 -> 运行时坐定，都要在旧面上演完再换面，
//   所以视图变化后先把旧面「留住」一小段（useFaceHold），时长按方块报来的组装进度算；减少动画时不留，直接换。
// - 进度填充在容器级的裁切层里，按 translateX((p − 1) × 100%) 移动，不随面的入场位移一起动。

import { AnimatePresence, motion, useReducedMotionConfig, useTransform, type Variants } from "framer-motion";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Icon } from "../art/Icon";
import { AssemblingBlock, assemblyExitMs, assemblySeatInMs, type AssemblyClock, type AssemblyExit } from "../art/iso/AssemblingBlock";
import { Spinner } from "../art/Spinner";
import { CRASH_CATEGORIES, crashClueLine, LAUNCH_COPY, LAUNCH_STAGES, PHASE_LABEL, SESSION_COPY, taskPhaseText, type FailureCopy } from "../copy/flows";
import { percent } from "../domain/format";
import { capsuleSwap, fade, lineSwap, lineSwapFade, springs } from "../lib/motion";
import { useDisplaySpeed } from "../lib/progress-display";
import { cx } from "../lib/util";
import { useNow } from "../state/launcher";
import { DOWNLOAD_STAGE, type SessionState } from "../state/session";
import { progressTrack } from "../state/tasks";
import { softDisabledProps } from "../ui/Button";
import { MIN_VISIBLE_PROGRESS, rawFillOffset, useSmoothProgress } from "../ui/ProgressBar";
import { Tooltip } from "../ui/Tooltip";
import { useBreathPhase } from "./breath";
import { useInstanceCover } from "./cover";
import styles from "./LaunchCapsule.module.css";
import { brokenAction, sessionDetail, sessionPhaseLabel, stageLabel, type LaunchView } from "./launchView";
import { useLaunch, type LaunchEntry } from "./useLaunch";
import { useMounted } from "../lib/useMounted";

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

/**
 * 文字槽的候选文案：槽宽取其中最宽的一条，槽里的文字在这些之间怎么换都不改胶囊宽度，也就不挤动同一行的按钮。
 * 下载的文件数按四位、速度按最宽的几种写法占位；更长的（上万个文件）在槽里省略，不撑宽。
 */
export const TEXT_SLOTS = {
  loadingTitle: [...LAUNCH_STAGES, SESSION_COPY.stopping],
  loadingSub: [
    PHASE_LABEL.preparing,
    PHASE_LABEL.downloading,
    PHASE_LABEL.launching,
    SESSION_COPY.countingFiles,
    ...[1000 * 1024, 99.9 * 1024 * 1024, 999 * 1024 * 1024].map((speed) => SESSION_COPY.downloadProgress(9999, 9999, speed)),
  ],
  percent: [percent(1, true)],
  /** 计时按两位小时占位：跨过一小时不变宽。 */
  runningTitle: [LAUNCH_COPY.runningTitle(((99 * 60 + 59) * 60 + 59) * 1000), SESSION_COPY.stopping],
  /** 崩溃线索读出来之前副行就在：标题不先居中再上移，线索到了只换字。 */
  crashSub: [...CRASH_CATEGORIES.map(crashClueLine), SESSION_COPY.noClue],
  installingTitle: [LAUNCH_COPY.installingTitle(percent(1)), LAUNCH_COPY.queuedTitle],
} as const satisfies Record<string, readonly string[]>;

type WidthSource = Pick<LaunchEntry, "instance" | "failure">;

/** 启动失败的面要用的文案；入口说失败了却没有文案是状态不一致，直接抛。 */
function failureOf(entry: Pick<LaunchEntry, "failure">): FailureCopy {
  if (entry.failure === null) throw new Error("启动失败的入口缺少失败文案");
  return entry.failure;
}

/**
 * 胶囊宽度只取决于：档位、是否撑满、哪个面、面里没有按候选定宽的那几段文字（就绪按钮的字、实例名、失败文案、
 * 已结束的说明、安装步骤）。交给布局动画做 layoutDependency：进度、文件数、速度、计时这类只改数字的重渲染
 * 不再逐次量布局；宽度真的会变（换面、换安装步骤）时才量一次、走 morph。
 */
export function capsuleLayoutKey(face: LaunchView, entry: WidthSource, size: LaunchCapsuleSize, block: boolean, relaunch: boolean): string {
  return JSON.stringify([size, block, faceKey(face), ...faceFreeText(face, entry, relaunch)]);
}

function faceFreeText(face: LaunchView, entry: WidthSource, relaunch: boolean): (string | null)[] {
  switch (face.kind) {
    case "ready":
      return [relaunch ? LAUNCH_COPY.relaunch : LAUNCH_COPY.launch];
    case "broken":
      return [brokenAction(face).label];
    case "loading":
    case "crashed":
      return [];
    case "running":
      return [entry.instance.name];
    case "stopped":
      return [sessionPhaseLabel(face.session), sessionDetail(face.session, Date.now())];
    case "failed": {
      const failure = failureOf(entry);
      return [failure.title, failure.fix.label];
    }
    case "installing":
      return [installingSub(face)];
  }
}

function installingSub(face: Extract<LaunchView, { kind: "installing" }>): string | null {
  const task = face.task;
  if (task === null || task.status === "queued") return face.queuePosition === null ? null : LAUNCH_COPY.queuedDetail(face.queuePosition);
  return task.phase === null ? task.title : taskPhaseText(task.phase, "short");
}

/** 按会话阶段落面：准备 1、下载 2、启动 3。 */
export function placedForStage(stageIndex: number): 0 | 1 | 2 | 3 {
  if (stageIndex < DOWNLOAD_STAGE) return 1;
  if (stageIndex === DOWNLOAD_STAGE) return 2;
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

/**
 * 视图从 prev 换到 next 时旧面要不要留住、留多久；不留为 null。clock 是旧面上方块此刻的组装进度（now 与它同一时基）：
 * 拆解、崩落按实际已落的面数算演完的时长；坐定按未落的面还要多久落齐（含刚换上时的首落延迟）再加坐定后的停顿。
 * 实际已落的面数会晚于阶段给出的落位数，按落位数估会在方块坐定前就换走旧面。
 */
export function holdFor(prev: LaunchView, next: LaunchView, clock: AssemblyClock | null, now: number): FaceHold | null {
  if (prev.kind === "loading") {
    if (next.kind === "stopped" && next.reason === "cancelled") return exitHold(prev, "disassemble", clockOf(clock));
    if (next.kind === "failed" || next.kind === "crashed") return exitHold(prev, "collapse", clockOf(clock));
    if (next.kind === "running") return seatHold(prev, clockOf(clock), now);
  }
  if (prev.kind === "installing" && next.kind === "ready") return seatHold(prev, clockOf(clock), now);
  return null;
}

function clockOf(clock: AssemblyClock | null): AssemblyClock {
  if (clock === null) throw new Error("加载面与安装中面的方块还没有报过组装进度");
  return clock;
}

/** 一面都还没落时没有可演的退场，直接换面。 */
function exitHold(face: LaunchView, exit: AssemblyExit, clock: AssemblyClock): FaceHold | null {
  const ms = assemblyExitMs(exit, clock.shown);
  return ms === 0 ? null : { face, exit, seat: false, ms };
}

function seatHold(face: LaunchView, clock: AssemblyClock, now: number): FaceHold {
  return { face, exit: null, seat: true, ms: assemblySeatInMs(clock, now) + capsuleSwap.holdMs.afterSeat };
}

function useFaceHold(view: LaunchView, reduced: boolean, clock: RefObject<AssemblyClock | null>): { face: LaunchView; exit: AssemblyExit | null; seat: boolean } {
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
    setHold(reduced ? null : holdFor(committed.current, view, clock.current, performance.now()));
  }
  useEffect(() => {
    if (hold === null) return;
    const timer = setTimeout(() => setHold(null), hold.ms);
    return () => clearTimeout(timer);
  }, [hold]);
  if (hold !== null) return { face: hold.face, exit: hold.exit, seat: hold.seat };
  return { face: view, exit: null, seat: false };
}

/**
 * 面切换，各段按 custom 传入的减少动画生效值取。根部 MotionConfig 只把位移类改成瞬时：透明度上的延迟它不管，
 * 带位移的退场在那里会先跳 6px 再淡出。所以减少动画时延迟归零，进出只交叉淡化。
 */
export const faceSwap: Variants = {
  enter: (reduced: boolean) => (reduced ? { opacity: 0 } : { opacity: 0, y: 6 }),
  show: (reduced: boolean) => {
    const delay = reduced ? 0 : capsuleSwap.faceEnterDelay;
    return { opacity: 1, y: 0, transition: { ...springs.settle, delay, opacity: { ...fade.in, delay } } };
  },
  leave: (reduced: boolean) => (reduced ? { opacity: 0, transition: fade.out } : { opacity: 0, y: -6, transition: fade.out }),
};

export function LaunchCapsule({ instanceId, size = "md", block = false, relaunch = false, className }: LaunchCapsuleProps) {
  const entry = useLaunch(instanceId);
  const reduced = useReducedMotionConfig() === true;
  // 加载面、安装中面上方块的组装进度，由方块写入；换面时据此决定旧面留多久
  const clock = useRef<AssemblyClock | null>(null);
  const { face, exit, seat } = useFaceHold(entry.view, reduced, clock);
  const capsuleRef = useRef<HTMLDivElement>(null);
  // 胶囊挂载时就在的面不播入场（跟着所在页面走）；之后换上来的面才播
  const mounted = useMounted();
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
  const layoutKey = capsuleLayoutKey(face, entry, size, block, relaunch);
  const announce = entry.view.kind === "loading" || entry.view.kind === "running" || entry.view.kind === "stopped" || entry.view.kind === "failed" || entry.view.kind === "crashed"
    ? sessionPhaseLabel(entry.view.session)
    : "";

  return (
    // 不撑满时胶囊自己的位置与宽度都由布局动画管：所在的动作行挂了兄弟让位（lib/reflow）时，它不再被让位重复位移一次
    <motion.div
      ref={capsuleRef}
      layout
      layoutDependency={layoutKey}
      transition={{ layout: springs.morph }}
      role="group"
      aria-label={LAUNCH_COPY.group(entry.instance.name)}
      tabIndex={-1}
      className={cx(styles.capsule, className)}
      data-size={size}
      data-block={block || undefined}
      data-expanded={expanded || undefined}
      data-reflow-skip={block ? undefined : ""}
      style={{ borderRadius: height / 2 }}
    >
      {TONES.map((t) => (
        <span key={t} className={styles.layer} data-layer={t} data-active={t === tone || undefined} aria-hidden="true" />
      ))}
      {/* 光晕与进度填充随面出现、消失：与色调叠层同时交叉淡入淡出，不在换面那一帧硬切 */}
      <AnimatePresence>
        {face.kind === "running" && <BreathGlow key="glow" appear={mounted.current} reduced={reduced} />}
        {fill !== null && <Fill key="fill" value={fill.value} track={fill.track} tone={fill.tone} appear={mounted.current} />}
      </AnimatePresence>
      {/* 只播报 phase 的变化，计时与百分比不播报 */}
      <span className="sk-sr-only" aria-live="polite">
        {announce}
      </span>
      {/* 退场的面按这里的 custom 取退场变体：它的 props 停在离场那一刻，减少动画的设置在那之后变了也按当前的走 */}
      <AnimatePresence mode="popLayout" custom={reduced}>
        <motion.div
          key={key}
          data-face={key}
          layout
          layoutDependency={layoutKey}
          transition={{ layout: springs.morph }}
          className={styles.face}
          variants={faceSwap}
          custom={reduced}
          initial={mounted.current ? "enter" : false}
          animate="show"
          exit="leave"
        >
          <Face face={face} entry={entry} exit={exit} seat={seat} relaunch={relaunch} entering={mounted.current} clock={clock} />
        </motion.div>
      </AnimatePresence>
    </motion.div>
  );
}

/**
 * 进度填充。安装中面在任务完成后、落地重扫回来之前拿到的是那个已完成的任务（launchView 的 installing.task）：文字写着 100%，
 * 填充也按满格留着，沿同一个 track 从完成前的位置走满，到就绪换面时才随面淡出，不在完成那一刻先没掉。
 */
export function fillOf(face: LaunchView, seat: boolean): { value: number; track: string; tone: "loading" | "info" } | null {
  if (face.kind === "loading") return { value: seat ? 1 : face.session.progress, track: face.session.taskId, tone: "loading" };
  if (face.kind === "installing" && face.task !== null && (face.task.status === "running" || face.task.status === "done")) {
    return { value: seat || face.task.status === "done" ? 1 : face.task.progress, track: progressTrack(face.task), tone: "info" };
  }
  return null;
}

/** appear：胶囊挂载之后才出现（排队的安装开始跑、点了启动），淡入；随胶囊一起挂载的直接显示。 */
function Fill({ value, track, tone, appear }: { value: number; track: string; tone: "loading" | "info"; appear: boolean }) {
  // 最少显示长度落在平滑的终点上，逐帧的位移不再加下限：从 0 起步时填充一帧帧长出来，不在第一帧冒出那一截
  const { smooth } = useSmoothProgress(value, track, MIN_VISIBLE_PROGRESS);
  const x = useTransform(smooth, rawFillOffset);
  return (
    <motion.span
      className={styles.clip}
      data-fill={tone}
      aria-hidden="true"
      initial={appear ? { opacity: 0 } : false}
      animate={{ opacity: 1, transition: fade.in }}
      exit={{ opacity: 0, transition: fade.out }}
    >
      <motion.span className={styles.fill} data-tone={tone} style={{ x }} />
    </motion.span>
  );
}

/**
 * 运行面的光晕。外层管出现与消失（与运行面同一拍淡入，离开运行面时淡出）；里层只在呼吸窗口内呼吸，
 * 呼吸是 CSS 动画、会盖过内联的透明度，所以两件事分在两层上。
 */
function BreathGlow({ appear, reduced }: { appear: boolean; reduced: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useBreathPhase(ref, true);
  return (
    <motion.span
      className={styles.glowLayer}
      data-glow=""
      aria-hidden="true"
      initial={appear ? { opacity: 0 } : false}
      animate={{ opacity: 1, transition: { ...fade.in, delay: reduced ? 0 : capsuleSwap.faceEnterDelay } }}
      exit={{ opacity: 0, transition: fade.out }}
    >
      <span ref={ref} className={styles.glow} />
    </motion.span>
  );
}

/**
 * entering：这个面是换上来的（胶囊早已挂载），方块要从一面未落起演组装；否则是随胶囊一起挂载的，按现状直接显示。
 * clock：加载面与安装中面的方块把组装进度写在这里。
 */
function Face({ face, entry, exit, seat, relaunch, entering, clock }: { face: LaunchView; entry: LaunchEntry; exit: AssemblyExit | null; seat: boolean; relaunch: boolean; entering: boolean; clock: RefObject<AssemblyClock | null> }) {
  const cover = useInstanceCover(entry.instance);
  const id = entry.instance.id;
  switch (face.kind) {
    case "ready": {
      // 存档备份或恢复进行中：保持可聚焦，悬停与聚焦写出原因，点击无效。
      // 包裹层常驻：备份结束时按钮不重挂，聚焦着的「启动」不丢焦点，换面时焦点也还在胶囊里
      const blocked = entry.blocked !== null;
      return (
        <Tooltip content={entry.blocked} disabled={!blocked}>
          <button type="button" className={styles.go} data-disabled={blocked || undefined} {...softDisabledProps(blocked, entry.launch)}>
            <Icon name="play" size={18} />
            {relaunch ? LAUNCH_COPY.relaunch : LAUNCH_COPY.launch}
          </button>
        </Tooltip>
      );
    }
    case "broken": {
      const action = brokenAction(face);
      // 与就绪面同一写法：包裹层常驻，被占着时带原因禁用，放开时按钮不重挂
      const blocked = entry.repairBlocked !== null;
      return (
        <Tooltip content={entry.repairBlocked} disabled={!blocked}>
          <button type="button" className={styles.go} data-tone="warn" data-disabled={blocked || undefined} {...softDisabledProps(blocked, entry.launch)}>
            <Icon name={action.icon} size={18} />
            {action.label}
          </button>
        </Tooltip>
      );
    }
    case "loading": {
      const s = face.session;
      const stopping = entry.stopping && entry.view.kind === "loading";
      return (
        <>
          <span className={styles.blockSlot}>
            <AssemblingBlock instanceId={id} cover={cover} placed={seat ? 3 : placedForStage(s.stageIndex)} seated={seat} exit={exit} width={28} enter={entering} clock={clock} />
          </span>
          <Text
            title={stopping ? SESSION_COPY.stopping : stageLabel(s.stageIndex)}
            titleKey={stopping ? "stopping" : `stage:${s.stageIndex}`}
            titleSlot={TEXT_SLOTS.loadingTitle}
            sub={loadingSub(face)}
            subSlot={TEXT_SLOTS.loadingSub}
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
      const failure = failureOf(entry);
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
          <Text title={LAUNCH_COPY.crashedTitle} sub={sessionDetail(face.session, Date.now())} subSlot={TEXT_SLOTS.crashSub} />
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
            <AssemblingBlock instanceId={id} cover={cover} placed={seat ? 3 : queued ? 1 : placedForProgress(task.progress)} seated={seat} width={28} enter={entering} clock={clock} />
          </span>
          {queued ? (
            <Text title={LAUNCH_COPY.queuedTitle} titleSlot={TEXT_SLOTS.installingTitle} sub={installingSub(face)} />
          ) : (
            <InstallingText progress={seat ? 1 : task.progress} track={progressTrack(task)} sub={installingSub(face)} />
          )}
        </>
      );
    }
  }
}

/** 加载面的副行：准备、启动写阶段；下载写文件数与速度，还没报过下载进度时写正在统计。 */
function loadingSub(face: Extract<LaunchView, { kind: "loading" }>): ReactNode {
  if (face.phase !== "downloading") return PHASE_LABEL[face.phase];
  const d = face.session.download;
  return d === null ? sessionDetail(face.session, Date.now()) : <DownloadDetail session={face.session} speedBps={d.speedBps} />;
}

/**
 * 下载阶段的副行。文件数照上报跟随；速度走 lib/progress-display 的显示节流（约 1 秒平均、每秒最多换两次字），
 * 不随每 100 ms 一次的瞬时速度跳字。报过下载进度之后才挂上，第一次报上来的速度直接显示，不从 0 爬上来；
 * 下载阶段一过就卸掉，下一段下载不接着上一段的平均。
 */
function DownloadDetail({ session, speedBps }: { session: SessionState; speedBps: number }) {
  const shown = useDisplaySpeed(speedBps);
  return sessionDetail(session, Date.now(), shown);
}

function RunningFace({ face, entry }: { face: Extract<LaunchView, { kind: "running" }>; entry: LaunchEntry }) {
  const now = useNow(1000);
  const runningSince = face.session.runningSince;
  if (runningSince === null) throw new Error("running 会话缺少运行起点");
  const stopping = entry.stopping && entry.view.kind === "running";
  return (
    <>
      <span className={styles.dot} data-tone="ok" />
      <Text
        title={stopping ? SESSION_COPY.stopping : LAUNCH_COPY.runningTitle(now - runningSince)}
        titleKey={stopping ? "stopping" : "clock"}
        titleSlot={TEXT_SLOTS.runningTitle}
        sub={entry.instance.name}
      />
      <span className={styles.actions}>
        {/* 正在结束期间不用原生禁用：确认框关闭后焦点刚还到这里，原生禁用会把它丢回 body */}
        <button type="button" className={styles.pill} data-tone="ok" {...softDisabledProps(stopping, entry.stop)} aria-busy={stopping || undefined}>
          {/* 图标与加载指示大小不同，放进同一个定宽格：换成「正在结束」时按钮不变宽 */}
          <span className={styles.pillIcon}>{stopping ? <Spinner size={16} tone="current" decorative /> : <Icon name="stop" size={14} />}</span>
          {LAUNCH_COPY.stopGame}
        </button>
      </span>
    </>
  );
}

interface TextProps {
  title: ReactNode;
  /** 标题换了一件事（阶段名、正在结束）时换这个键：旧行上移淡出、新行落到位。不给则原地直接换字。 */
  titleKey?: string;
  /** 标题槽按这些文案里最宽的一条定宽，标题怎么换都不改宽度，放不下时省略；不给则按标题本身取宽。 */
  titleSlot?: readonly string[];
  /** null 为没有副行；给了 subSlot 时副行常驻，null 只是这一行暂时空着（崩溃线索还没读出来）。 */
  sub: ReactNode | null;
  subSlot?: readonly string[];
}

function Text({ title, titleKey, titleSlot, sub, subSlot }: TextProps) {
  return (
    <span className={styles.text}>
      <Line className={styles.title} slot={titleSlot} swapKey={titleKey}>
        {title}
      </Line>
      {(sub !== null || subSlot !== undefined) && (
        <Line className={styles.sub} slot={subSlot}>
          {sub}
        </Line>
      )}
    </span>
  );
}

/**
 * 一行文字：可见的文字与占宽的候选文案叠在同一格。有候选时格宽只取候选，可见文字不参与撑宽；
 * 行常驻而文字晚到（null 变成有字）时，文字淡入；给了 swapKey 时键一换，新旧两行在同一格里交接。
 */
function Line({ className, slot, swapKey, children }: { className: string; slot: readonly string[] | undefined; swapKey?: string; children: ReactNode | null }) {
  const mounted = useMounted();
  // 减少动画时新旧两行只交叉淡化：位移在那里一步到位，旧行会先上跳再淡出
  const swap = useReducedMotionConfig() === true ? lineSwapFade : lineSwap;
  return (
    <span className={cx(className, styles.line)} data-slot={slot === undefined ? undefined : ""}>
      {children !== null &&
        (swapKey === undefined ? (
          <motion.span className={styles.value} initial={mounted.current ? { opacity: 0 } : false} animate={{ opacity: 1, transition: fade.in }}>
            {children}
          </motion.span>
        ) : (
          <AnimatePresence>
            <motion.span key={swapKey} className={styles.value} variants={swap} initial={mounted.current ? "enter" : false} animate="show" exit="leave">
              {children}
            </motion.span>
          </AnimatePresence>
        ))}
      {slot !== undefined && [...new Set(slot)].map((text) => (
        <span key={text} className={styles.reserve} aria-hidden="true">
          {text}
        </span>
      ))}
    </span>
  );
}

/** 百分比文字取平滑值的整数，加载阶段封顶 99%；按最宽的「99%」占位，数字进位不改宽度。 */
function Percent({ value, track }: { value: number; track: string }) {
  const { smooth } = useSmoothProgress(value, track);
  const text = useTransform(smooth, (p) => percent(p, true));
  return (
    <span className={cx(styles.pct, styles.line)} data-slot="">
      <motion.span className={styles.value}>{text}</motion.span>
      {TEXT_SLOTS.percent.map((reserve) => (
        <span key={reserve} className={styles.reserve} aria-hidden="true">
          {reserve}
        </span>
      ))}
    </span>
  );
}

function InstallingText({ progress, track, sub }: { progress: number; track: string; sub: string | null }) {
  const { smooth } = useSmoothProgress(progress, track);
  const title = useTransform(smooth, (p) => LAUNCH_COPY.installingTitle(percent(p)));
  return <Text title={<motion.span>{title}</motion.span>} titleSlot={TEXT_SLOTS.installingTitle} sub={sub} />;
}

/** disabled 时保持可聚焦（aria-disabled）：按下「取消启动」后、换面之前，焦点要留在胶囊里等新面接住。 */
function IconAction({ label, icon, onClick, disabled = false }: { label: string; icon: "x"; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className={styles.iconAction} aria-label={label} {...softDisabledProps(disabled, onClick)}>
      <Icon name={icon} size={16} />
    </button>
  );
}
