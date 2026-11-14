// 启动状态岛：标题栏中列的会话胶囊，任何页面都能看到当前游戏会话。会话出现即出现，清空即退场。
// 点开是会话详情（阶段清单、最近 4 行日志、动作），动作经状态容器的会话动作与外层统一错误处理执行。
//
// 退场动画期间外层拿到的会话是最后一帧的快照：显示按快照画；会话可能因为实例被删除而清空，
// 所以这里只按 id 查实例、查不到时退回 id 显示，不读必然存在的实例。
//
// 游戏日志每 100 ms 一批。状态岛按会话除日志以外的字段订阅，收起时日志怎么来都不重渲染；
// 展开后的最近几行由 LatestLogs 自己订阅，只有它跟着换。

import { AnimatePresence, motion, useIsPresent, useReducedMotionConfig, useTransform, type MotionValue, type Variants } from "framer-motion";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { fade, faceSwap, lineSwap, lineSwapFade, popMark, shake, springs } from "../lib/motion";
import { useReflow } from "../lib/reflow";
import { useCompletionHold, useDisplaySpeed, useFinishing, type FinishedItem } from "../lib/progress-display";
import { playTween } from "../lib/slide";
import { useLauncherActions, useLauncherSelector } from "../state/launcher";
import { findInstance } from "../state/selectors";
import { DOWNLOAD_STAGE, isLoadingPhase, type SessionState } from "../state/session";
import { Appear } from "../ui/Appear";
import { Button } from "../ui/Button";
import { Popover } from "../ui/Popover";
import { fillOffset, MIN_VISIBLE_PROGRESS, useSmoothProgress } from "../ui/ProgressBar";
import { ProgressRing } from "../ui/ProgressRing";
import { PercentOf } from "../ui/SmoothPercent";
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
  // 这座岛上画过加载的那一局。它进入运行时底边进度条与详情里的进度环先推满、留一拍再退场
  const [loadedTask, setLoadedTask] = useState(loading ? session.taskId : null);
  if (loading && loadedTask !== session.taskId) setLoadedTask(session.taskId);
  const finishing = useFinishing(loadingFinished(session, loadedTask), useCompletionHold()).has(session.taskId);
  const progressShown = loading || finishing;
  // 底边进度条的平滑放在不随阶段换行的这一层，胶囊上的百分数直接读它：字与条是同一个值，按构造同数，换行时新行不另起弹簧。
  // 换了一局时平滑直接跳到新一局的进度，字与条一起跳，不从上一局停下的位置往回走
  const bar = useIslandProgress(session.progress, session.taskId);
  // 详情在加载期间开着：加载结束（进入运行、失败、取消）后阶段清单留到浮层关闭，停在最终状态。
  // 清单连间距两百多像素，加载一结束就抽走会让日志与动作行上跳、浮层底边骤缩；关掉再打开时不在加载期就不画
  const [stagesHeld, setStagesHeld] = useState(false);
  if (open && loading && !stagesHeld) setStagesHeld(true);
  if (!open && stagesHeld) setStagesHeld(false);
  const stages = loading || stagesHeld;
  const detailKey = detailLayoutKey(session, stages);
  // 清单出没时外框沿 morph 形变，被挤开的日志区要走同一条弹簧，否则先于外框下沿到位、与它分开动。
  // 这里的位移只来自清单的增删（Appear 的进出，正文里没有自己变尺寸的布局节点），增删观察报在提交后的微任务里，
  // 与外框的形变同一刻起步，不用在形变节点上补跑（sync）
  const detailReflow = useReflow<HTMLDivElement>("morph");
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
                  variants={reduced ? lineSwapFade : lineSwap}
                  initial="enter"
                  animate="show"
                  exit="leave"
                >
                  <SecondText second={second} progress={loading ? bar.smooth : null} />
                </motion.span>
              </AnimatePresence>
              {slot.map((candidate) => (
                <span key={islandSecondText(candidate)} className={styles.reserve} aria-hidden="true">
                  <SecondText second={candidate} progress={null} />
                </span>
              ))}
            </span>
            {/* 状态点退场时立即脱离布局：外框的宽度动画按没有它的宽度量，淡完那一帧不再跳一次。
                出没走小标记的 dot 档：从 0 弹出并淡入，退场淡出缩到 0.6；减少动画只淡入淡出 */}
            <AnimatePresence mode="popLayout">
              {tone === "running" && (
                <motion.span key="running" className={styles.runningDot} {...(reduced ? popMark.reduced : popMark.dot)} aria-hidden="true">
                  {/* 呼吸在里面这层：退场的透明度写在外层的内联样式上，CSS 动画要是也挂在外层会盖过它，只能在退场时撤掉呼吸，
                      点就从呼吸中途跳回满亮再淡出。分两层后两者相乘，退场途中呼吸照常走 */}
                  <span ref={dotRef} className={styles.breathing} />
                </motion.span>
              )}
              {session.phase === "crashed" && <motion.span key="danger" className={styles.dangerDot} {...(reduced ? popMark.reduced : popMark.dot)} aria-hidden="true" />}
            </AnimatePresence>
          </motion.span>
          <AnimatePresence>{progressShown && <IslandBar key="bar" fill={bar.fill} />}</AnimatePresence>
        </motion.button>
      </motion.span>
      <span className="sk-sr-only" aria-live="polite">
        {ISLAND_COPY.announce(name, sessionPhaseLabel(session))}
      </span>
      {/* 内容结构变了（清单出没、动作行换一套按钮）时外框沿 morph 形变到新高度；动作行在底部那一层，跟着外框下沿走 */}
      <Popover
        open={open && present}
        anchor={anchor}
        onClose={close}
        placement="bottom"
        autoFocus
        aria-label={ISLAND_COPY.detailsLabel(name)}
        className={styles.detailPanel}
        layoutKey={detailKey}
        footer={<DetailActions session={session} controls={controls} onClose={close} />}
      >
        <div ref={detailReflow} className={styles.detail}>
          <DetailHead session={session} instance={instance} name={name} now={now} ring={progressShown} />
          {/* 换了一次启动（taskId 变）时清单重新挂载，勾号按新的这次启动算 */}
          <Appear>{stages && <StageList key={session.taskId} session={session} />}</Appear>
          <LatestLogs instanceId={session.instanceId} />
        </div>
      </Popover>
    </>
  );
}

/**
 * 第二段一行的内容：显示的那一行与占宽的候选同一结构，候选量出来的宽度才和显示时一致。
 * 显示的那一行在加载中传 progress：底边进度条的那个平滑值本身，百分数直接读它，字与条逐帧同数，不随每次上报跳字。
 * 不各行另起一条平滑：新行的弹簧从零速起步，换行时条正带着速度走，字会一路落后几个百分点。
 * 退场中的旧行留着它最后一次渲染时的 progress，照样逐帧读这个值：交叉淡化的那一百多毫秒里两行写同一个数，只有标签不同。
 * 旧行要是停在换行那一刻的数，条正带着速度走时同屏会有两个相差十几点的百分数。候选只写占位的数字。
 */
function SecondText({ second, progress }: { second: IslandSecond; progress: MotionValue<number> | null }) {
  return (
    <>
      {second.label !== null && <span>{second.label}</span>}
      {second.value !== null && (progress === null ? <span className={styles.value}>{second.value}</span> : <PercentOf className={styles.value} value={progress} />)}
    </>
  );
}

/** 显示用的会话：下载中的速度换成平滑过的那个；别的不动。 */
function withShownSpeed(session: SessionState, speedBps: number): SessionState {
  const d = session.download;
  if (session.phase !== "downloading" || d === null || d.speedBps === speedBps) return session;
  return { ...session, download: { ...d, speedBps } };
}

/**
 * 写速度的那几行字用的会话：下载速度平滑过、每秒最多换两次字。只在下载阶段喂真实速度：别的阶段没有数据在流，下载记录里留着的是最后一次的速度。
 * 节拍放在只画这一行字的小段里（与下载任务页的 TaskMeta 同一做法）：到点补字时只重画这一行，胶囊与详情的其余部分不跟着重渲染，
 * 详情收起时也就没有节拍。详情头与下载那一行各取一份：喂的是同一串速度，下载阶段之外都喂 0，进下载时同一刻从头起步
 * （在下载中打开详情时两份也是同一次挂载），写出来是同一个数。代价是在下载中途打开详情时，第一拍写的是此刻的速度，之后才接着平滑。
 */
function useShownSpeedSession(session: SessionState): SessionState {
  const speed = useDisplaySpeed(session.phase === "downloading" && session.download !== null ? session.download.speedBps : 0);
  return withShownSpeed(session, speed);
}

/**
 * 加载刚走完的那一局：交给 useFinishing 的完成项，运行起点就是加载结束的时刻。只认进入运行的、且在这座岛上画过加载的那一局
 * （loadedTask）：找回的一局一来就在运行，没有进度条可推满；失败与取消没有走满这回事。
 */
export function loadingFinished(session: SessionState, loadedTask: string | null): FinishedItem[] {
  if (session.phase !== "running" || session.taskId !== loadedTask) return [];
  if (session.runningSince === null) throw new Error("running 会话缺少运行起点");
  return [{ id: session.taskId, finishedAt: session.runningSince }];
}

/**
 * 状态岛的进度：胶囊上的百分数读 smooth，底边进度条的填充位移读 fill。
 * 字从 0% 起、照真实进度写，smooth 不带最少显示长度；条在进度大于 0 时不短于 MIN_VISIBLE_PROGRESS。
 * 下限不能加在逐帧平滑之后（离开 0 的第一帧一下冒出那一截），也不能放进 smooth 的终点（字会从 2% 起跳），
 * 所以下限自己是一条同样平滑的值：目标大于 0 时从 0 弹到 MIN_VISIBLE_PROGRESS，换一局时与 smooth 按同一规则跳，条取两者的较大者。
 * 下限的终点就是 MIN_VISIBLE_PROGRESS，smooth 过了它之后条取的就是 smooth 本身，字与条按构造同数。
 */
export function useIslandProgress(progress: number, track: string): { smooth: MotionValue<number>; fill: MotionValue<string> } {
  const bar = useSmoothProgress(progress, track);
  const floor = useSmoothProgress(bar.target > 0 ? MIN_VISIBLE_PROGRESS : 0, track);
  const fill = useTransform([bar.smooth, floor.smooth], ([p, min]: number[]) => fillOffset(Math.max(p, min)));
  return { smooth: bar.smooth, fill };
}

function IslandBar({ fill }: { fill: MotionValue<string> }) {
  return (
    <motion.span className={styles.barTrack} aria-hidden="true" exit={{ opacity: 0, transition: fade.out }}>
      <motion.span className={styles.barFill} style={{ x: fill }} />
    </motion.span>
  );
}

/** ring：进度环在不在。加载中，以及加载刚走完、环正推到满格的那一拍（这时已在运行，按 100% 算，不再封顶 99%）。 */
function DetailHead({ session, instance, name, now, ring }: { session: SessionState; instance: InstanceSummary | undefined; name: string; now: number; ring: boolean }) {
  const catalog = useBlockCatalog();
  const loading = isLoadingPhase(session.phase);
  return (
    <div className={styles.head}>
      <span className={styles.headBlock} aria-hidden="true">
        {instance !== undefined && <InstanceBlock instanceId={instance.id} cover={instanceCover(instance, catalog)} width={28} />}
      </span>
      <div className={styles.headText}>
        <p className={styles.headName}>{name}</p>
        <HeadPhase session={session} now={now} />
      </div>
      {/* 进度环比头部文字两行矮，撤掉不改头部高度；加载结束时淡出而不是瞬没 */}
      <Appear itemClassName={styles.headRing}>
        {ring && <ProgressRing key="ring" value={session.progress} size={36} capAt99={loading} track={session.taskId} label={ISLAND_COPY.progressLabel} />}
      </Appear>
    </div>
  );
}

/** 详情头的副行：阶段，加上下载进度与速度、计时这类说明。 */
function HeadPhase({ session, now }: { session: SessionState; now: number }) {
  const shown = useShownSpeedSession(session);
  const detail = sessionDetail(shown, now);
  const phase = sessionPhaseLabel(shown);
  return <p className={styles.headPhase}>{detail === null ? phase : `${phase} · ${detail}`}</p>;
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

/**
 * 下载阶段那一行的右侧：进行中写「done/total · 速度」，没有缺失文件被跳过时写「无需下载」。
 * 加载在这一步就结束了（取消、失败）时只写 done/total：那一行已停成 halted，头部写着「已取消」「启动失败」，再写速度就像还在下载。
 */
export function downloadStageNote(session: SessionState): string | null {
  const d = session.download;
  if (session.stageIndex === DOWNLOAD_STAGE) {
    if (d === null || d.total === null) return null;
    const files = `${d.done}/${d.total}`;
    return isLoadingPhase(session.phase) ? `${files} · ${formatSpeed(d.speedBps)}` : files;
  }
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
  // 勾号换上空圈的那一格：与换一枚小控件同一口径，从 0.6 走 pop 弹出；减少动画时只淡入
  const check = useReducedMotionConfig() === true ? faceSwap.reduced : faceSwap.pop;
  return (
    <ol className={styles.stages} aria-label={ISLAND_COPY.stagesLabel}>
      {LOADING_STAGES.map((label, i) => {
        const st = stageState(session.stageIndex, i, loading);
        return (
          <li key={label} className={styles.stage} data-state={st}>
            <span className={styles.stageDot} aria-hidden="true">
              {st === "done" && (
                <motion.span className={styles.stageCheck} initial={i < doneBeforeOpen ? false : check.initial} animate={check.animate}>
                  <Icon name="check" size={12} />
                </motion.span>
              )}
            </span>
            <span className={styles.stageLabel}>{label}</span>
            {i === DOWNLOAD_STAGE ? <DownloadStageNote session={session} /> : <StageNoteText note={stageNote(session, i)} />}
          </li>
        );
      })}
    </ol>
  );
}

function StageNoteText({ note }: { note: string | null }) {
  return note === null ? null : <span className={styles.stageNote}>{note}</span>;
}

/** 下载那一行的右侧：写着速度，换字节拍在这一小段里，补字时清单的其余各行不跟着重渲染。 */
function DownloadStageNote({ session }: { session: SessionState }) {
  const shown = useShownSpeedSession(session);
  return <StageNoteText note={stageNote(shown, DOWNLOAD_STAGE)} />;
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

/**
 * 详情浮层的布局键：浮层的结构只随这几样变，变了浮层才量一次布局、外框形变到新高度。
 * - 阶段清单在不在、是哪一次启动的（stages 为清单此刻画不画）；
 * - 动作行是哪一套按钮：随阶段换（三个加载阶段是同一套），失败时还看修复动作的文案，文案长短决定动作行折不折行。
 * 进度、速度、日志、计时这类高频重渲染不换键。加载或运行结束后结束按钮留在原位、结构其实没变，键照样换一次：只多量一次，量出来没变就不动。
 */
export function detailLayoutKey(session: SessionState, stages: boolean): string {
  const fix = session.phase === "failed" ? islandFailure(session).fix.label : null;
  return JSON.stringify([stages ? session.taskId : null, isLoadingPhase(session.phase) ? "loading" : session.phase, fix]);
}

/** 结束这一局的按钮：加载中是「取消启动」，运行中是「结束游戏」。 */
type EndAction = "cancel" | "stop";

function liveEndAction(phase: SessionState["phase"]): EndAction | null {
  if (isLoadingPhase(phase)) return "cancel";
  return phase === "running" ? "stop" : null;
}

/** 动作行里一项的布局矩形（px），相对动作行，不含 transform 与 translate。 */
interface ActionBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 让位交给 Web Animations 的一段位移：box 是这一项终点处的布局矩形，keys 是各关键帧距起步的毫秒数与那一刻的 translate。 */
interface ActionPassage {
  box: ActionBox;
  start: number;
  keys: readonly { at: number; x: number; y: number }[];
}

/** 两个矩形有没有叠在一起；只贴着边不算。 */
function overlaps(a: ActionBox, b: ActionBox): boolean {
  return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}

/**
 * passages 里的兄弟途经 target 时，最后一次压在它上面之后的那个关键帧的时刻（文档时间轴）；都没压上时为 null。
 * 关键帧之间线性相连，相邻两帧只隔 1/120 秒（lib/slide），按关键帧比就够；取压着的最后一帧的下一帧，宁晚不早。
 */
function passedAt(target: ActionBox, passages: readonly ActionPassage[]): number | null {
  let clear: number | null = null;
  for (const { box, start, keys } of passages) {
    for (let i = keys.length - 1; i >= 0; i--) {
      const { x, y } = keys[i];
      if (!overlaps({ ...box, left: box.left + x, top: box.top + y }, target)) continue;
      const at = start + keys[Math.min(i + 1, keys.length - 1)].at;
      if (clear === null || at > clear) clear = at;
      break;
    }
  }
  return clear;
}

/** 这一项的布局矩形：动作行是定位祖先，量到的就是相对它的位置。 */
function actionBox(el: HTMLElement): ActionBox {
  return { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight };
}

/** 关键帧里的 translate；只写了一个值时纵向是 0（CSS 的 translate 就是这么解释的）。 */
function translateOf(value: string): { x: number; y: number } {
  const [x, y = "0px"] = value.trim().split(/\s+/);
  const parsed = { x: parseFloat(x), y: parseFloat(y) };
  if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) throw new Error(`读不懂让位关键帧的 translate：${value}`);
  return parsed;
}

/** 让位此刻挂在这一项上的那一段；没有、或起步时刻还没定（不是走 morph 的让位）时为 null。 */
function passageOf(el: HTMLElement): ActionPassage | null {
  for (const animation of el.getAnimations()) {
    const effect = animation.effect;
    const start = animation.startTime;
    if (!(effect instanceof KeyframeEffect) || typeof start !== "number") continue;
    const frames = effect.getKeyframes();
    if (frames.length < 2 || !frames.every((frame) => typeof frame.translate === "string")) continue;
    const duration = effect.getTiming().duration;
    if (typeof duration !== "number") throw new Error(`让位的时长应是毫秒数，实为 ${String(duration)}`);
    return { box: actionBox(el), start, keys: frames.map((frame) => ({ at: frame.computedOffset * duration, ...translateOf(String(frame.translate)) })) };
  }
  return null;
}

function buttonIn(item: HTMLElement): HTMLButtonElement {
  const button = item.querySelector("button");
  if (button === null) throw new Error("动作行里的一项没有按钮");
  return button;
}

/**
 * 原地退场的这一项压着新按钮：它的按钮自己先淡到全透明并停在那里，返回淡完的时刻（文档时间轴）。之前已经挂过的沿用那一段。
 * 外面那层（Appear）的退场由 framer-motion 起步，起点随提交到下一帧隔多久而定（不超过 40 ms 取提交那一刻，超过取那一帧），
 * 淡完的时刻在这里拿不准；按钮上这一段淡完的时刻是定的，新按钮按它起步就不会与它叠着画。
 * 起点钉在提交后的第一帧动笔的那一刻（now）：钉在提交那一刻的话，那一帧来得晚时第一帧画出来已淡掉大半，甚至直接没了。
 * 用 fade.quick：先出后入，新按钮少等一些。
 */
function vacate(item: HTMLElement, now: number, vacating: WeakMap<Element, Animation>): number {
  let away = vacating.get(item);
  if (away === undefined) {
    away = playTween(buttonIn(item), [{}, { opacity: 0 }], fade.quick);
    if (away.effect === null) throw new Error("淡出的动画没有效果对象");
    away.effect.updateTiming({ fill: "forwards" });
    away.startTime = now;
    vacating.set(item, away);
  }
  const start = away.startTime;
  if (typeof start !== "number") throw new Error(`退场项淡出的起步时刻应是毫秒数，实为 ${String(start)}`);
  return start + fade.quick.duration * 1000;
}

/**
 * 新插入的按钮先停在全透明，等压着它的都让开再淡入，两者不叠着画：
 * - 滑过来的兄弟：右对齐的一行在「完整日志」右边插进两颗（加载转失败、运行转崩溃）时，「完整日志」左移一百来像素，正好横穿原位淡入的「收起」。
 *   兄弟的轨迹取让位挂在它身上的那一段：lib/reflow 走 morph 时起步时刻已钉下，关键帧就是整条弹簧轨迹。
 * - 原地退场的项：popLayout 把它钉在原处淡出，新按钮常落在同一处（「取消启动」「结束游戏」的位置上换上「收起」或修复、诊断按钮），
 *   它先淡掉（vacate），新按钮等它淡完。
 * 淡入挂在按钮本身、淡到按钮自己的透明度：外面那层（Appear）的入场照常，退场时外层淡出照样盖住它。
 * 新插入的项自己至多在新开的一行里从上一行下沿滑下来（lib/reflow），压不到别的行上，按它的终点比。
 * 让位没起动画（减少动画，或这次没有兄弟被挪动）、也没有退场项压着时没有可等的，照常淡入。
 * now 是提交后的第一帧跑 rAF 回调的那一刻，这一帧画出来之前两者都已挂上。不取 rAF 的时间戳：那是这一帧开始排的时刻，
 * 主线程前面压着长任务时会早于提交（开发构建里启动失败那次提交后的第一帧早了六十多毫秒，下一帧的时间戳一下追回一百多毫秒），
 * 钉在它上面的淡出在第二帧就走完了。
 */
function holdUntilClear(entering: readonly HTMLElement[], staying: readonly HTMLElement[], leaving: readonly HTMLElement[], vacating: WeakMap<Element, Animation>, now: number): void {
  // 组件测试的 jsdom 没有 getAnimations：那里不播动画，也就没有可等的让位
  const passages = staying.some((item) => typeof item.getAnimations !== "function") ? [] : staying.map(passageOf).filter((passage): passage is ActionPassage => passage !== null);
  // 提交之后、这一帧之前又换过一次时，已经原地回来的退场项不再淡出：那次提交没有它的淡出可撤，挂上就停在全透明
  const exiting = leaving.filter((item) => item.hasAttribute("inert"));
  if (passages.length === 0 && exiting.length === 0) return;
  const boxes = entering.map(actionBox);
  const vacated = exiting.flatMap((item) => {
    const box = actionBox(item);
    return boxes.some((target) => overlaps(box, target)) ? [{ box, at: vacate(item, now, vacating) }] : [];
  });
  entering.forEach((item, i) => {
    let at = passedAt(boxes[i], passages);
    for (const spot of vacated) {
      if (overlaps(spot.box, boxes[i]) && (at === null || spot.at > at)) at = spot.at;
    }
    if (at === null || at <= now) return;
    const fadeIn = playTween(buttonIn(item), [{ opacity: 0 }, {}], fade.in);
    if (fadeIn.effect === null) throw new Error("淡入的动画没有效果对象");
    fadeIn.effect.updateTiming({ fill: "backwards" });
    fadeIn.startTime = at;
  });
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
  // 其余的增删（加载转运行、失败或崩溃）都有新按钮插入：退场的淡出并立即脱离布局，右对齐的其余按钮滑到新位置。
  // 动作行所在的底部那一层随外框沿 morph 形变，按钮的位移（换组、修复文案变长折行）走同一条弹簧才与外框下沿同拍到位。
  // 这些位移都来自按钮的增删（折行也是换上的那一套更宽），由增删观察在提交后的微任务里接住，与形变同一刻起步，不用补跑（sync）
  const reflow = useReflow<HTMLDivElement>("morph");
  const row = useRef<HTMLDivElement | null>(null);
  const attach = useCallback(
    (el: HTMLDivElement | null) => {
      if (el === null) return;
      row.current = el;
      const stop = reflow(el);
      return () => {
        row.current = null;
        if (typeof stop === "function") stop();
      };
    },
    [reflow],
  );
  // 上一次提交时在场的各项：换一套按钮时据此认出新插入的。每次提交都比一遍（只走 DOM、不读布局），
  // 按钮的集合由阶段、失败修复、结束按钮的去留拼成，按依赖写容易漏
  const present = useRef<ReadonlySet<Element> | null>(null);
  // 按钮上挂了淡出（vacate）的退场项。退场没播完又回来时 framer-motion 让同一个节点原地回来，那段淡出要撤掉，否则按钮停在全透明
  const [vacating] = useState(() => new WeakMap<Element, Animation>());
  useLayoutEffect(() => {
    const el = row.current;
    if (el === null) throw new Error("动作行没有挂上");
    const children = [...el.children].filter((child): child is HTMLElement => child instanceof HTMLElement);
    const items = children.filter((child) => !child.hasAttribute("inert"));
    const before = present.current;
    present.current = new Set(items);
    if (before === null) return;
    const entering = items.filter((item) => !before.has(item));
    if (entering.length === 0) return;
    for (const item of entering) {
      const away = vacating.get(item);
      if (away === undefined) continue;
      away.cancel();
      vacating.delete(item);
    }
    const staying = items.filter((item) => before.has(item));
    const leaving = children.filter((child) => child.hasAttribute("inert"));
    // 让位在增删观察的回调里起（提交后的微任务），到下一帧的 rAF 时已经建好；淡出与停住都在这一帧画出来之前挂上
    requestAnimationFrame(() => holdUntilClear(entering, staying, leaving, vacating, performance.now()));
  });
  return (
    <div ref={attach} className={styles.actions}>
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
