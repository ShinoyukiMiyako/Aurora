// 启动状态岛：标题栏中列的会话胶囊，任何页面都能看到当前游戏会话。会话出现即出现，清空即退场。
// 点开是会话详情（阶段清单、最近 4 行日志、动作），动作经状态容器的会话动作与外层统一错误处理执行。
//
// 退场动画期间外层拿到的会话是最后一帧的快照：显示按快照画；会话可能因为实例被删除而清空，
// 所以这里只按 id 查实例、查不到时退回 id 显示，不读必然存在的实例。
//
// 游戏日志每 100 ms 一批。状态岛按会话除日志以外的字段订阅，收起时日志怎么来都不重渲染；
// 展开后的最近几行由 LatestLogs 自己订阅，只有它跟着换。

import { AnimatePresence, motion, useIsPresent, useReducedMotionConfig, useTransform, type Variants } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../art/Icon";
import { InstanceBlock } from "../art/iso/InstanceBlock";
import { ACTION_ERROR, CONFIRM_COPY, LAUNCH_COPY, LAUNCH_STAGES, PHASE_LABEL, SESSION_COPY, STOPPED_LABEL, failureCopy, type FailureFixKind } from "../copy/flows";
import type { InstanceSummary } from "../domain/adapt";
import { clock, formatElapsed, formatSpeed, percent } from "../domain/format";
import { useBreathPhase } from "../launch/breath";
import { instanceCover } from "../launch/cover";
import { useBlockCatalog } from "../mc/catalog";
import { useLaunchHost } from "../launch/host";
import { sessionDetail, sessionPhaseLabel } from "../launch/launchView";
import { fade, lineSwap, shake, springs } from "../lib/motion";
import { useReflow } from "../lib/reflow";
import { useLauncherActions, useLauncherSelector } from "../state/launcher";
import { findInstance } from "../state/selectors";
import { DOWNLOAD_STAGE, isLoadingPhase, type SessionState } from "../state/session";
import { Appear } from "../ui/Appear";
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
      return { label: compact ? null : SESSION_COPY.runningLabel, value: formatElapsed(now - session.runningSince) };
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

/** 加载百分比的占位：封顶 99%，数字等宽，任何一个百分比都不比它宽。 */
const PERCENT_PEAK = percent(1, true);

const LOADING_LABELS = [PHASE_LABEL.preparing, PHASE_LABEL.downloading, PHASE_LABEL.launching] as const;

/** 运行计时的占位：同样位数的 0。数字等宽，位数不变就同宽，跨过一小时才变。 */
function clockPeak(session: SessionState, now: number): string {
  if (session.runningSince === null) throw new Error("running 会话缺少运行起点");
  return formatElapsed(now - session.runningSince).replace(/\d/g, "0");
}

/**
 * 第二段的槽：这些候选叠在同一格里占宽，格宽取最宽的一条，显示的那一行不参与撑宽。
 * regular 与 wide 档在加载与运行期间把「正在结束…」和三个加载阶段一并列进来：点了结束、阶段推进时胶囊不变宽，
 * 换的只是格里的那一行。compact 档只占当前这一行：它为省宽而设，不为片刻的「正在结束…」常年多占一截，
 * 那一下交给胶囊的宽度形变。
 */
export function islandSlot(session: SessionState, tier: Tier, now: number, stopping: boolean): readonly IslandSecond[] {
  const phase = session.phase;
  const compact = tier === "compact";
  const ending: IslandSecond = { label: SESSION_COPY.stopping, value: null };
  if (isLoadingPhase(phase)) {
    if (compact) return [stopping ? ending : { label: null, value: PERCENT_PEAK }];
    return [...LOADING_LABELS.map((label) => ({ label, value: PERCENT_PEAK })), ending];
  }
  if (phase === "running") {
    const clock: IslandSecond = { label: compact ? null : SESSION_COPY.runningLabel, value: clockPeak(session, now) };
    if (compact) return [stopping ? ending : clock];
    return [clock, ending];
  }
  return [islandSecond(session, tier, now, stopping)];
}

/**
 * 胶囊的宽度只取决于这几样：档位、名字、第二段的槽（候选文案与数字占位的位数）、尾部有没有圆点。
 * 交给布局动画做 layoutDependency：下载进度、百分比、运行计时、同一槽里换阶段文字这类重渲染不再逐次量一遍布局，
 * 否则运行中每秒都要量一次、再跑一段弹簧。
 */
export function islandLayoutKey(session: SessionState, tier: Tier, name: string, slot: readonly IslandSecond[]): string {
  return JSON.stringify([tier, name, slot, islandTone(session), session.phase === "crashed"]);
}

/**
 * 会话除日志以外的字段都相同（两边都没有会话也算）。拿到的会话快照里日志可能是旧的：状态岛除 LatestLogs 外都不读日志。
 */
function sameSessionExceptLogs(a: SessionState | null, b: SessionState | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  for (const key of Object.keys(a) as (keyof SessionState)[]) {
    if (key !== "logs" && !Object.is(a[key], b[key])) return false;
  }
  return true;
}

export function StatusIsland() {
  // 只随会话的阶段、进度、时刻与结局变；日志与别的任务的下载进度都不让状态岛重渲染
  const session = useLauncherSelector((s) => s.session, sameSessionExceptLogs);
  return <AnimatePresence>{session !== null && <Island key="island" session={session} />}</AnimatePresence>;
}

/**
 * 「已运行 mm:ss」用的当前时刻：只在运行中每秒走一次。其余阶段显示的内容与此刻无关，不挂计时器，
 * 免得停在加载、失败或崩溃的状态岛每秒白白重渲染。进入运行时立即取一次，不沿用挂载时的旧时刻。
 */
function useRunningNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

const shakeVariants: Variants = {
  rest: { x: 0 },
  shake: { x: [...shake.x], transition: shake.transition },
};

/** 减少动画时的退场：位移与缩放在那时瞬时到位，留在退场里会先瞬缩、瞬移一下再淡出，所以只留透明度。 */
const FADE_OUT = { opacity: 0, transition: fade.out };

function Island({ session }: { session: SessionState }) {
  const actions = useLauncherActions();
  const instance = useLauncherSelector((s) => findInstance(s, session.instanceId));
  const catalog = useBlockCatalog();
  const { tier } = useShell();
  const host = useLaunchHost();
  const now = useRunningNow(session.phase === "running");
  const present = useIsPresent();
  const reduced = useReducedMotionConfig() === true;
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  // 「正在结束」是纯界面态：确认结束或点了取消、IPC 还没返回的这段时间；超时由动作本身以错误结束
  const [stopping, setStopping] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const name = instance === undefined ? session.instanceId : instance.name;
  const tone = islandTone(session);
  const second = islandSecond(session, tier, now, stopping);
  const slot = islandSlot(session, tier, now, stopping);
  const loading = isLoadingPhase(session.phase);
  const layoutKey = islandLayoutKey(session, tier, name, slot);
  // 详情在加载期间开着：加载结束（进入运行、失败、取消）后阶段清单留到浮层关闭，停在最终状态。
  // 清单连间距两百多像素，加载一结束就抽走会让日志与动作行上跳、浮层底边骤缩；关掉再打开时不在加载期就不画
  const [stagesHeld, setStagesHeld] = useState(false);
  if (open && loading && !stagesHeld) setStagesHeld(true);
  if (!open && stagesHeld) setStagesHeld(false);
  const detailReflow = useReflow<HTMLDivElement>();
  const dotRef = useRef<HTMLSpanElement>(null);
  useBreathPhase(dotRef, tone === "running");

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
      {/* 崩溃时整座岛（描边与底色连同内容）抖一次。抖动放在外面这层：岛自己的 transform 归布局动画与入场、退场 */}
      <motion.span className={styles.shaker} variants={shakeVariants} initial={false} animate={session.phase === "crashed" ? "shake" : "rest"}>
        <motion.button
          ref={setAnchor}
          type="button"
          layout
          layoutDependency={layoutKey}
          className={styles.island}
          data-tone={tone}
          data-open={open || undefined}
          aria-label={ISLAND_COPY.label(name, islandSecondText(second))}
          aria-expanded={open}
          aria-haspopup="dialog"
          style={{ borderRadius: ISLAND_RADIUS }}
          initial={{ opacity: 0, scale: 0.92 }}
          animate={{ opacity: 1, scale: 1, transition: { ...springs.base, opacity: fade.in } }}
          exit={reduced ? FADE_OUT : { opacity: 0, scale: 0.96, transition: fade.out }}
          transition={{ layout: springs.morph }}
          onClick={() => setOpen((v) => !v)}
        >
          <motion.span
            className={styles.row}
            layout="position"
            layoutDependency={layoutKey}
            // 与外框同一枚弹簧：不写就落到根部的 base，外框入场缩放未完时变宽，内容会和外框分开动
            transition={{ layout: springs.morph }}
          >
            <span className={styles.blockFrame} aria-hidden="true">
              {instance !== undefined && <InstanceBlock instanceId={instance.id} cover={instanceCover(instance, catalog)} width={20} />}
            </span>
            <span className={styles.name}>{name}</span>
            <span className={styles.second}>
              {/* 阶段文字一变整行换掉（旧行上移淡出、新行从下方升入，与启动胶囊的阶段名同一套），百分比与计时在行内原地走。
                  新旧两行与占宽的候选叠在同一格里交接，格宽只取候选，换行时胶囊不变宽。
                  首帧那一行跟着整座岛入场，不单独播；行里只有文字、没有之后才挂载的动画元素，initial={false} 封不住别的入场 */}
              <AnimatePresence initial={false}>
                <motion.span
                  key={second.label === null ? "value-only" : `label:${second.label}`}
                  className={styles.face}
                  variants={lineSwap}
                  initial="enter"
                  animate="show"
                  exit={reduced ? FADE_OUT : "leave"}
                >
                  <SecondText second={second} />
                </motion.span>
              </AnimatePresence>
              {slot.map((candidate) => (
                <span key={islandSecondText(candidate)} className={styles.reserve} aria-hidden="true">
                  <SecondText second={candidate} />
                </span>
              ))}
            </span>
            {/* 状态点退场时立即脱离布局：外框的宽度动画按没有它的宽度量，淡完那一帧不再跳一次 */}
            <AnimatePresence mode="popLayout">
              {tone === "running" && (
                <motion.span
                  key="running"
                  className={styles.runningDot}
                  initial={{ scale: 0 }}
                  animate={{ scale: 1, transition: springs.pop }}
                  exit={reduced ? FADE_OUT : { opacity: 0, scale: 0.6, transition: fade.out }}
                  aria-hidden="true"
                >
                  {/* 呼吸在里面这层：退场的透明度写在外层的内联样式上，CSS 动画要是也挂在外层会盖过它，只能在退场时撤掉呼吸，
                      点就从呼吸中途跳回满亮再淡出。分两层后两者相乘，退场途中呼吸照常走 */}
                  <span ref={dotRef} className={styles.breathing} />
                </motion.span>
              )}
              {session.phase === "crashed" && (
                <motion.span
                  key="danger"
                  className={styles.dangerDot}
                  initial={{ scale: 0 }}
                  animate={{ scale: 1, transition: springs.pop }}
                  exit={reduced ? FADE_OUT : { opacity: 0, scale: 0.6, transition: fade.out }}
                  aria-hidden="true"
                />
              )}
            </AnimatePresence>
          </motion.span>
          <AnimatePresence>{loading && <IslandBar key="bar" session={session} />}</AnimatePresence>
        </motion.button>
      </motion.span>
      <span className={styles.srOnly} aria-live="polite">
        {ISLAND_COPY.announce(name, sessionPhaseLabel(session))}
      </span>
      <Popover open={open && present} anchor={anchor} onClose={close} placement="bottom" autoFocus aria-label={ISLAND_COPY.detailsLabel(name)}>
        <div ref={detailReflow} className={styles.detail}>
          <DetailHead session={session} instance={instance} name={name} now={now} />
          {/* 换了一次启动（taskId 变）时清单重新挂载，勾号按新的这次启动算 */}
          <Appear>{(loading || stagesHeld) && <StageList key={session.taskId} session={session} />}</Appear>
          <LatestLogs instanceId={session.instanceId} />
          <DetailActions session={session} controls={controls} onClose={close} />
        </div>
      </Popover>
    </>
  );
}

/** 第二段一行的内容：显示的那一行与占宽的候选同一结构，候选量出来的宽度才和显示时一致。 */
function SecondText({ second }: { second: IslandSecond }) {
  return (
    <>
      {second.label !== null && <span>{second.label}</span>}
      {second.value !== null && <span className={styles.value}>{second.value}</span>}
    </>
  );
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
  const catalog = useBlockCatalog();
  return (
    <div className={styles.head}>
      <span className={styles.headBlock} aria-hidden="true">
        {instance !== undefined && <InstanceBlock instanceId={instance.id} cover={instanceCover(instance, catalog)} width={28} />}
      </span>
      <div className={styles.headText}>
        <p className={styles.headName}>{name}</p>
        <p className={styles.headPhase}>{detail === null ? phase : `${phase} · ${detail}`}</p>
      </div>
      {/* 进度环比头部文字两行矮，撤掉不改头部高度；加载结束时淡出而不是瞬没 */}
      <Appear itemClassName={styles.headRing}>
        {isLoadingPhase(session.phase) && <ProgressRing key="ring" value={session.progress} size={36} capAt99 track={session.taskId} label={ISLAND_COPY.progressLabel} />}
      </Appear>
    </div>
  );
}

/** halted：加载已经结束（失败或取消）时停下的那一步，外观同未开始，不再画成进行中。 */
export type StageState = "done" | "now" | "todo" | "halted";

/** 阶段清单不含最后一项「游戏运行中」：清单只列加载的各步，加载结束后留在开着的详情里也只是停在最终状态。 */
const LOADING_STAGES = LAUNCH_STAGES.slice(0, -1);

/** loading 为 false 时清单是加载结束后留在详情里的：头部已写着「启动失败」「已取消」，出事那一步不能还像在进行。 */
export function stageState(stageIndex: number, index: number, loading: boolean): StageState {
  if (index < stageIndex) return "done";
  if (index > stageIndex) return "todo";
  return loading ? "now" : "halted";
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
  // 打开详情时已经完成的阶段直接画勾；之后才完成的那一步才弹出并淡入，否则每次打开都像所有阶段刚刚完成
  const [doneBeforeOpen] = useState(session.stageIndex);
  const loading = isLoadingPhase(session.phase);
  return (
    <ol className={styles.stages} aria-label={ISLAND_COPY.stagesLabel}>
      {LOADING_STAGES.map((label, i) => {
        const st = stageState(session.stageIndex, i, loading);
        const note = stageNote(session, i);
        return (
          <li key={label} className={styles.stage} data-state={st}>
            <span className={styles.stageDot} aria-hidden="true">
              {st === "done" && (
                <motion.span
                  className={styles.stageCheck}
                  initial={i < doneBeforeOpen ? false : { scale: 0.6, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1, transition: { ...springs.pop, opacity: fade.in } }}
                >
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

/** 详情里日志区的行数；样式里日志区的固定高度按它算。 */
export const LOG_LINES = 4;

/**
 * 详情里最近的几行日志：整座状态岛只有它订阅日志，详情收起时它不挂载。
 * 日志区常驻、高度固定为 LOG_LINES 行：首批日志常晚于详情打开才到、前几行逐批补齐，块要是随行数长高，下面的动作行会被一次次往下推。
 * 会话已清空（退场动画期间）或换成了别的实例时选择器拿不到日志：照旧画最后见过的几行，淡出途中内容不突然变空。
 */
function LatestLogs({ instanceId }: { instanceId: string }) {
  const live = useLauncherSelector((s) => (s.session !== null && s.session.instanceId === instanceId ? s.session.logs : null));
  const seen = useRef<SessionState["logs"]>([]);
  if (live !== null) seen.current = live;
  const logs = seen.current;
  const lines = logs.slice(-LOG_LINES);
  const offset = logs.length - lines.length;
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
  return failureCopy(session.failure.code, session.failure.params, { accountName: session.accountName, accountKind: session.accountKind, javaPinned: false });
}

/** 结束这一局的按钮：加载中是「取消启动」，运行中是「结束游戏」。 */
type EndAction = "cancel" | "stop";

function liveEndAction(phase: SessionState["phase"]): EndAction | null {
  if (isLoadingPhase(phase)) return "cancel";
  return phase === "running" ? "stop" : null;
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
  // 取消启动、结束游戏（或游戏自己退出）后会话进入已结束，停留片刻整座岛就退场。这段时间里结束按钮留在原位、改为不可用：
  // 只删不补时让位无从接起（退场项被抽出布局的那一帧没有增删节点、也没有尺寸变化），右对齐的「完整日志」会右跳一个按钮宽，
  // 正落在刚点过的位置；留着则位移为 0，聚焦着的按钮也不把焦点丢回页面。留的是此前显示的那一个（加载中游戏就退出了也是「取消启动」）
  const live = liveEndAction(phase);
  const [shownEnd, setShownEnd] = useState(live);
  if (live !== null && live !== shownEnd) setShownEnd(live);
  const end = live !== null ? live : phase === "stopped" ? shownEnd : null;
  // 其余的增删（加载转运行、失败或崩溃）都有新按钮插入：退场的淡出并立即脱离布局，右对齐的其余按钮滑到新位置
  const reflow = useReflow<HTMLDivElement>();
  return (
    <div ref={reflow} className={styles.actions}>
      <Appear itemClassName={styles.action}>
        {showLogs && (
          <Button key="logs" variant="ghost" size="sm" onClick={leave(controls.openLogs)}>
            {ISLAND_COPY.fullLog}
          </Button>
        )}
        {end === "cancel" && (
          <Button key="cancel" variant="secondary" size="sm" icon="x" loading={live === "cancel" && controls.stopping} disabled={live !== "cancel"} focusableWhenDisabled onClick={controls.cancel}>
            {LAUNCH_COPY.cancel}
          </Button>
        )}
        {end === "stop" && (
          <Button key="stop" variant="secondary" size="sm" icon="stop" loading={live === "stop" && controls.stopping} disabled={live !== "stop"} focusableWhenDisabled onClick={controls.stop}>
            {LAUNCH_COPY.stopGame}
          </Button>
        )}
        {(phase === "failed" || phase === "crashed") && (
          <Button key="dismiss" variant="ghost" size="sm" onClick={controls.dismiss}>
            {LAUNCH_COPY.dismiss}
          </Button>
        )}
        {failure !== null && (
          <Button key="fix" variant="primary" size="sm" onClick={leave(() => controls.fix(failure.fix.kind))}>
            {failure.fix.label}
          </Button>
        )}
        {phase === "crashed" && (
          <Button key="crash" variant="primary" size="sm" onClick={leave(controls.openCrash)}>
            {LAUNCH_COPY.viewCrash}
          </Button>
        )}
      </Appear>
    </div>
  );
}
