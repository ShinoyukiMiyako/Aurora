// 下载快览：标题栏右列的下载入口与它的浮层。入口空闲时是下载图标；有进行中的任务时换成总进度环 + 计数角标；
// 有用户还没看过的失败任务时挂一个危险点（未看标记归状态层），打开快览即算看过，进入下载任务页由那一页清除。
// 浮层只列进行中的任务（运行在前、排队在后，各自保持队列顺序），已结束的去下载任务页看。
//
// 动效：图标与进度环叠在同一格交叉淡入，角标与危险点出现时弹入、消失时淡出缩小，入口尺寸始终不变；
// 账户胶囊伸缩时入口跟着胶囊左缘滑（SLIDES_WITH_CAPSULE）；浮层里任务行增删时淡入淡出，其余行从旧位置滑到新位置，
// 浮层外框随之形变到新高度，失败条与底栏跟着外框下沿走。
// 行里的进度文字与下载任务页同一套显示节流（lib/progress-display）：速度平滑、每秒最多换两次字，百分数与进度条同步走；
// 任务完成时行先留在原处把进度推满、停一拍，再退场。

import { AnimatePresence, motion, useIsPresent, useReducedMotionConfig } from "framer-motion";
import { createContext, useContext, useEffect, useReducer, useState, type ReactNode } from "react";
import { Icon } from "../art/Icon";
import { ACTION_ERROR, CONFIRM_COPY, taskPhaseText } from "../copy/flows";
import { formatSpeed, percent } from "../domain/format";
import type { Task } from "../domain/types";
import type { ConfirmOptions } from "../launch/host";
import { fade, popMark, springs } from "../lib/motion";
import { useCompletionHold, useDisplaySpeed, useFinishing, type FinishedItem } from "../lib/progress-display";
import { useReflow } from "../lib/reflow";
import { useInsertItem } from "../lib/useInsertItem";
import { useMounted } from "../lib/useMounted";
import { useLauncherActions, useLauncherSelector } from "../state/launcher";
import { clearableFinishedCount, findInstance } from "../state/selectors";
import type { LauncherState } from "../state/store";
import { isActiveTask, progressTrack } from "../state/tasks";
import { Appear } from "../ui/Appear";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Popover } from "../ui/Popover";
import { ProgressBar } from "../ui/ProgressBar";
import { ProgressRing } from "../ui/ProgressRing";
import { SmoothPercent } from "../ui/SmoothPercent";
import { PEEK_COPY } from "../copy/shell";
import { SLIDES_WITH_CAPSULE } from "./AccountCapsule";
import styles from "./DownloadPeek.module.css";
import { useNav, useShell } from "./shell";
import { useRunner } from "./useRunner";

/** 底栏随浮层外框的形变移动：与外框同一条弹簧，下沿与底栏一起到位。 */
const FOLLOW_PANEL = { layout: springs.morph } as const;

/**
 * 入口上的总进度：按声明大小加权（Σ 大小 × 进度 / Σ 大小）。大小都未知时为 null，入口画静态虚线环；
 * 大小未知的任务不参与加权，免得一个没有大小的小文件把总进度拉成它自己的进度。
 */
export function overallProgress(tasks: readonly Task[]): number | null {
  let total = 0;
  let done = 0;
  for (const task of tasks) {
    if (!isActiveTask(task) || task.totalBytes === null || task.totalBytes <= 0) continue;
    total += task.totalBytes;
    done += task.totalBytes * task.progress;
  }
  return total === 0 ? null : done / total;
}

/**
 * 总进度环的标识：活动任务连同各自所在的批次。有任务结束或入队、某个任务换了批次时标识就变，
 * 环直接跳到按新集合加权的值，不从旧值倒退着动画过去；标识不变时只增不减。
 */
export function overallTrack(tasks: readonly Task[]): string {
  return tasks.filter(isActiveTask).map(progressTrack).sort().join("\n");
}

const NOT_FINISHING: ReadonlySet<string> = new Set();

/**
 * 浮层的列表顺序：运行中在前、排队在后，两组内部保持队列（数组）顺序。
 * 刚完成、还在收尾的任务（finishing，lib/progress-display 的 useFinishing）仍算运行中，留在原来的位置把进度推满，收尾结束才退场。
 */
export function peekRows(tasks: readonly Task[], finishing: ReadonlySet<string> = NOT_FINISHING): Task[] {
  const held = (t: Task) => t.status === "done" && finishing.has(t.id);
  return [...tasks.filter((t) => t.status === "running" || held(t)), ...tasks.filter((t) => t.status === "queued")];
}

/** 已完成的任务与完成时刻：收尾从这一刻算起。失败与取消没有走满这回事，不算。 */
function completions(tasks: readonly Task[]): FinishedItem[] {
  return tasks
    .filter((t) => t.status === "done")
    .map((t) => {
      if (t.finishedAt === null) throw new Error(`已完成的任务 ${t.id} 没有完成时刻`);
      return { id: t.id, finishedAt: t.finishedAt };
    });
}

/** 进度文案模板里百分数的占位：百分数是与进度条同步平滑的文字节点（ui/SmoothPercent），按模板摆到它的位置上。 */
const PERCENT_SLOT = "\u0000";

/**
 * 行右侧状态文字能出现的最宽字样：百分数满格；速度在每个单位下取四位整数（formatSpeed 不到 100 时带一位小数，
 * 也是四个字符，小数点不比数字宽）；再加排队中的状态词。它们不可见地叠在状态文字下面，这一格按其中最宽的定宽：
 * 速度每半秒换一次字、从排队轮到运行时这一格不变宽，左侧详情的省略位置不跟着抖。用真实字样撑宽而不写像素，换字体字号照样对。
 */
export const ROW_STATE_WIDEST: readonly string[] = [
  ...[0, 1, 2, 3].map((unit) => PEEK_COPY.progress(percent(1), formatSpeed(1023 * 1024 ** unit))),
  PEEK_COPY.queued,
];

/** 模板在百分数前后的两段文字。 */
function aroundPercent(text: string): readonly [string, string] {
  const parts = text.split(PERCENT_SLOT);
  if (parts.length !== 2) throw new Error(`快览的进度文案里百分数应当恰好出现一次，实为 ${parts.length - 1} 次`);
  return [parts[0], parts[1]];
}

/**
 * 浮层的布局键：变了浮层才量一次布局、外框形变到新高度。由列表的行（按显示顺序）、有没有失败条、有没有「清除已结束」、
 * 以及 settled 组成。进度、速度、失败数从 1 到 2 这类不改变高度的变化不换键，下载进度的高频重渲染不量布局。
 * 行退场与列表、空态换手都是先在流里淡出、播完才离开布局：数据变的那一刻布局还没变，真正变高变矮在退场播完的那次提交，
 * settled 是那一刻记的一笔（是否空态就在行 id 序列与这一笔里：序列为空、换手播完才是空态）。
 */
export function peekLayoutKey(rows: readonly Task[], settled: number, failedCount: number, finishedCount: number): string {
  return JSON.stringify([rows.map((t) => t.id), settled, failedCount > 0, finishedCount > 0]);
}

/**
 * 取消一个任务前要不要确认：排队中的直接取消；运行中的新建与导入取消后实例会被删除，
 * 修复取消后实例停在文件不完整的状态，这两类要确认；其余直接取消。
 */
export function cancelTaskConfirm(state: Pick<LauncherState, "instances">, task: Task): ConfirmOptions | null {
  if (task.status !== "running") return null;
  if (task.kind !== "game" && task.kind !== "modpack" && task.kind !== "repair") return null;
  if (task.instanceId === null) throw new Error(`任务 ${task.id}（${task.kind}）没有目标实例`);
  // 新建中的实例可能还没进实例列表；实例 id 就是它的目录名，可以直接写进文案
  const inst = findInstance(state, task.instanceId);
  const name = inst === undefined ? task.instanceId : inst.name;
  const copy = task.kind === "repair" ? CONFIRM_COPY.cancelRepair(task.title, name) : CONFIRM_COPY.cancelCreate(task.title, name);
  return { ...copy, cancelLabel: CONFIRM_COPY.keepDownloading, tone: "danger" };
}

export function DownloadPeek() {
  // 任务表本身就是这里要显示的高频切片；会话日志与别的变化不让快览重渲染
  const tasks = useLauncherSelector((s) => s.tasks);
  const unseen = useLauncherSelector((s) => s.unseenFailures);
  const instances = useLauncherSelector((s) => s.instances);
  const actions = useLauncherActions();
  const { confirm } = useShell();
  const { go } = useNav();
  const run = useRunner();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const mounted = useMounted();
  // 进度环换上来是弹入的小图标；减少动画时缩放一步到位，只淡入淡出
  const ringMark = useReducedMotionConfig() === true ? popMark.reduced : popMark.glyph;
  // 浮层里的退场播完、节点离开布局的那一刻记一笔：浮层的布局键要在那次提交变，外框才在真正变矮时形变
  const [settled, markSettled] = useReducer((n: number) => n + 1, 0);

  const active = tasks.filter(isActiveTask);
  // 只有列表按收尾留行；入口的环与计数、标题行的计数、底栏都按真实状态，与下载任务页同一口径
  const finishing = useFinishing(completions(tasks), useCompletionHold());
  const rows = peekRows(tasks, finishing);
  const failedCount = tasks.filter((t) => t.status === "failed").length;
  // 「清除已结束」的计数按点了真能清掉的算：落地中的任务清除会留着，不计
  const finishedCount = useLauncherSelector(clearableFinishedCount);
  const layoutKey = peekLayoutKey(rows, settled, failedCount, finishedCount);

  // 快览开着的时候，失败即被看到（包括开着期间新出现的）
  useEffect(() => {
    if (open && unseen > 0) actions.markFailuresSeen();
  }, [actions, open, unseen]);

  const close = () => setOpen(false);
  const leaveTo = (filter?: "failed") => {
    close();
    go(filter === undefined ? { page: "tasks" } : { page: "tasks", filter });
  };
  const cancel = (task: Task) =>
    void run(async () => {
      const options = cancelTaskConfirm({ instances }, task);
      if (options !== null && !(await confirm(options))) return;
      await actions.cancelTask(task.id);
    }, ACTION_ERROR.cancelTask);

  return (
    <>
      <motion.button
        ref={setAnchor}
        type="button"
        {...SLIDES_WITH_CAPSULE}
        className={styles.entry}
        aria-label={PEEK_COPY.button(active.length, unseen)}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-open={open || undefined}
        onClick={() => setOpen((v) => !v)}
      >
        {/* 空闲图标与进度环叠在同一格交叉淡入：刚点的下载落在这里，入口尺寸不变 */}
        <AnimatePresence>
          {active.length === 0 ? (
            <motion.span
              key="idle"
              className={styles.glyphSlot}
              initial={mounted.current ? { opacity: 0 } : false}
              animate={{ opacity: 1, transition: fade.in }}
              exit={{ opacity: 0, transition: fade.out }}
            >
              <Icon name="download" size={18} />
            </motion.span>
          ) : (
            <motion.span
              key="active"
              className={styles.glyphSlot}
              initial={mounted.current ? ringMark.initial : false}
              animate={ringMark.animate}
              exit={ringMark.exit}
            >
              <ActiveGlyph tasks={tasks} />
            </motion.span>
          )}
        </AnimatePresence>
        {/*
         * 计数角标与失败点的出现、消失由 Badge 自己播（弹入、缩小淡出），这里只给它退场的机会；
         * initial={false} 让入口挂载时就在的不弹。两者都是叶子，封不住别人的入场
         */}
        <AnimatePresence initial={false}>{active.length > 0 && <Badge key="count" count={active.length} tone="accent" ring className={styles.count} />}</AnimatePresence>
        <AnimatePresence initial={false}>
          {unseen > 0 && (
            <span key="failed" className={styles.failDot} data-alone={active.length === 0 || undefined}>
              <Badge tone="danger" ring />
            </span>
          )}
        </AnimatePresence>
      </motion.button>
      <Popover
        open={open}
        anchor={anchor}
        onClose={close}
        placement="bottom-end"
        aria-label={PEEK_COPY.title}
        className={styles.popover}
        layoutKey={layoutKey}
        header={<PeekHead activeCount={active.length} />}
        footer={<PeekFoot failedCount={failedCount} finishedCount={finishedCount} layoutKey={layoutKey} onLeave={leaveTo} onClearFinished={() => actions.clearFinishedTasks()} />}
      >
        <PeekList rows={rows} finishing={finishing} onCancel={cancel} onSettled={markSettled} />
      </Popover>
    </>
  );
}

function PeekHead({ activeCount }: { activeCount: number }) {
  return (
    <div className={styles.head}>
      <span className={styles.headTitle}>{PEEK_COPY.title}</span>
      <span className={styles.headMeta}>{activeCount > 0 ? PEEK_COPY.activeSummary(activeCount) : PEEK_COPY.idle}</span>
    </div>
  );
}

/**
 * 浮层的主体：任务行或空态。随浮层打开挂载，打开时就在的行不单独播入场，开着期间新来的行淡入。
 * 行与列表的退场播完时调 onSettled：那一刻节点才离开布局，浮层要在那次提交量布局。
 */
function PeekList({ rows, finishing, onCancel, onSettled }: { rows: readonly Task[]; finishing: ReadonlySet<string>; onCancel: (task: Task) => void; onSettled: () => void }) {
  const mounted = useMounted();
  // 走 morph：外框、主体下沿与底栏随同一次变化沿 morph 形变，行若走更快的 settle，删中间一行时下面的行先到位、
  // 与还在收的下沿之间空出一道缝，插入时末行先滑出、被主体裁掉半截
  const list = useReflow<HTMLUListElement>("morph");
  return (
    // 列表与空态先退后进：最后一行跟着列表一起淡出，空态再淡入；退场的列表不脱离布局，外框在换手的那一刻才形变
    <AnimatePresence mode="wait" onExitComplete={onSettled}>
      {rows.length > 0 ? (
        <ListLayer key="list" enter={mounted.current}>
          <ul ref={list} className={styles.list}>
            {/*
             * 行退场时留在流里淡出，播完才移除，下面的行再滑上来，外框与主体同时形变到新高度。不用 popLayout：
             * 弹出流外的末行会挂在主体已经收上去的下沿之外
             */}
            <AnimatePresence onExitComplete={onSettled}>
              {rows.map((task) => (
                <PeekRow key={task.id} task={task} finishing={finishing.has(task.id)} enter={mounted.current} onCancel={() => onCancel(task)} />
              ))}
            </AnimatePresence>
          </ul>
        </ListLayer>
      ) : (
        <motion.p
          key="empty"
          className={styles.empty}
          initial={mounted.current ? { opacity: 0 } : false}
          animate={{ opacity: 1, transition: fade.in }}
          exit={{ opacity: 0, transition: fade.out }}
        >
          {PEEK_COPY.empty}
        </motion.p>
      )}
    </AnimatePresence>
  );
}

/** 列表那一层正在退场：里面的行跟着整块淡出，行自己的 useIsPresent 却仍是在场（见 ListLayer）。 */
const ListLeaving = createContext(false);

/**
 * 列表那一层。最后一行走掉时不是行自己退场，而是整块列表冻结在最后一帧、跟着这一层淡出：里面的行仍算在场，
 * 所以退场期间 inert 要打在这一层上，跟着淡出的行同样点不到、聚焦不到；行要知道自己在退场，也看这一层（ListLeaving）。
 */
function ListLayer({ enter, children }: { enter: boolean; children: ReactNode }) {
  const present = useIsPresent();
  return (
    <motion.div inert={!present} initial={enter ? { opacity: 0 } : false} animate={{ opacity: 1, transition: fade.in }} exit={{ opacity: 0, transition: fade.out }}>
      <ListLeaving.Provider value={!present}>{children}</ListLeaving.Provider>
    </motion.div>
  );
}

interface PeekFootProps {
  failedCount: number;
  finishedCount: number;
  layoutKey: string;
  onLeave: (filter?: "failed") => void;
  onClearFinished: () => void;
}

/**
 * 浮层的底部：失败条与底栏。整块跟着外框下沿走（浮层的底部槽位）；失败条出现、消失时底栏在槽位里上下移，
 * 与外框下沿同一条弹簧、同一个布局键，一起到位。
 */
function PeekFoot({ failedCount, finishedCount, layoutKey, onLeave, onClearFinished }: PeekFootProps) {
  return (
    <>
      <Appear>
        {failedCount > 0 && (
          <div key="failed" className={styles.failed}>
            <Icon name="x-circle" size={16} />
            <span className={styles.failedText}>{PEEK_COPY.failed(failedCount)}</span>
            <Button variant="ghost" size="sm" onClick={() => onLeave("failed")}>
              {PEEK_COPY.view}
            </Button>
          </div>
        )}
      </Appear>
      <motion.div className={styles.foot} layout="position" layoutDependency={layoutKey} transition={FOLLOW_PANEL}>
        <Appear>
          {finishedCount > 0 && (
            <Button key="clear" variant="ghost" size="sm" onClick={onClearFinished}>
              {PEEK_COPY.clearFinished(finishedCount)}
            </Button>
          )}
        </Appear>
        <Button variant="secondary" size="sm" iconRight="arrow-right" onClick={() => onLeave()}>
          {PEEK_COPY.allTasks}
        </Button>
      </motion.div>
    </>
  );
}

function ActiveGlyph({ tasks }: { tasks: readonly Task[] }) {
  const progress = overallProgress(tasks);
  return (
    <span className={styles.glyph} aria-hidden="true">
      {progress === null ? (
        <svg className={styles.unknownRing} width={24} height={24} viewBox="0 0 24 24" focusable="false">
          <circle cx={12} cy={12} r={10.75} fill="none" strokeWidth={2.5} strokeDasharray="3 4" />
        </svg>
      ) : (
        <ProgressRing value={progress} size={24} track={overallTrack(tasks)} label={PEEK_COPY.totalProgress} />
      )}
      <span className={styles.glyphIcon}>
        <Icon name="download" size={12} />
      </span>
    </span>
  );
}

/**
 * finishing：刚完成、还在收尾。仍按进行中的样子画（同一个行、同一个 track），进度条与百分数推到满格；
 * 取消键留在原位、尾部不变宽，但已不可用（任务已经完成）。焦点可能正停在它上面，所以保持可聚焦。
 *
 * 退场中的行 props 停在离开前的那次渲染（AnimatePresence 冻结）。减少动画时没有收尾这一拍（useCompletionHold 为 0），
 * 任务完成的那一刻行就离开列表，冻结下来的是完成前的样子：运行中、进度停在最后一次上报、取消键可按。所以退场中按任务 id
 * 读实时任务，已完成就按收尾画，详情也取实时任务，与有收尾这一拍时离开前的样子相同。在场的行不读：页面每次都给最新的任务。
 */
function PeekRow({ task: placed, finishing, enter, onCancel }: { task: Task; finishing: boolean; enter: boolean; onCancel: () => void }) {
  // ul 的直接子项只能是 li，不能再包一层 Appear；减少动画时进出只留透明度，删掉的行不先缩一下再淡出
  const insert = useInsertItem();
  // 退场时行留在流里淡出、播完才移除：这段时间带 inert，取消键点不到、聚焦不到，读屏也不再读它
  const present = useIsPresent();
  const listLeaving = useContext(ListLeaving);
  const leaving = !present || listLeaving;
  const live = useLauncherSelector((s) => (leaving ? s.tasks.find((t) => t.id === placed.id) : undefined));
  // 淡出途中任务被「清除已结束」拿掉时读不到，照冻结的样子淡完：节点已带 inert，只剩这一百多毫秒
  const landed = live !== undefined && live.status === "done";
  const task = landed ? live : placed;
  const holding = finishing || landed;
  const queued = task.status === "queued";
  const progress = holding ? 1 : task.progress;
  const track = progressTrack(task);
  return (
    <motion.li className={styles.row} inert={!present} initial={enter ? insert.initial : false} animate={insert.animate} exit={insert.exit}>
      <div className={styles.rowHead}>
        <span className={styles.rowTitle} title={task.title}>
          {task.title}
        </span>
        <IconButton icon="x" size="sm" label={PEEK_COPY.cancel} tooltipSide="left" disabled={holding} focusableWhenDisabled onClick={onCancel} />
      </div>
      <ProgressBar value={queued ? 0 : progress} tone={queued ? "muted" : "accent"} size="sm" track={track} label={PEEK_COPY.rowProgress(task.title)} />
      <div className={styles.rowMeta}>
        <span className={styles.rowDetail}>{queued || task.phase === null ? task.detail : taskPhaseText(task.phase, "short")}</span>
        <span className={styles.rowState}>
          <RowStateText task={task} finishing={holding} progress={progress} track={track} />
          {ROW_STATE_WIDEST.map((sample) => (
            <span key={sample} className={styles.rowStateSample} aria-hidden="true">
              {sample}
            </span>
          ))}
        </span>
      </div>
    </motion.li>
  );
}

/**
 * 行右侧正在显示的状态文字。速度的换字节拍放在这一小段里（与下载任务页的 TaskMeta 同一做法）：平滑后的速度到点补字时
 * 只重画这一段，整行的标题、进度条与取消键不跟着重渲染。排队中也挂着它，轮到运行时速度接着同一份平滑。
 */
function RowStateText({ task, finishing, progress, track }: { task: Task; finishing: boolean; progress: number; track: string }) {
  // 写出来的速度是平滑过、每秒最多换两次字的那个，不是每 100 ms 一跳的瞬时值
  const live = useDisplaySpeed(task.speedBps);
  // 任务一完成，状态层就把速度清零：收尾这一拍留着完成前最后显示的速度，行在原处推满、淡出，不在最后一拍跳成 0。
  // 下载任务页的收尾行换成完成摘要，是因为那一行收尾后还留在已结束里；快览的行收尾完就走，这时换一次字只会闪一下
  const [lastLive, setLastLive] = useState(live);
  if (!finishing && live !== lastLive) setLastLive(live);
  const speed = finishing ? lastLive : live;
  if (task.status === "queued") return <span className={styles.rowStateText}>{PEEK_COPY.queued}</span>;
  const [beforePercent, afterPercent] = aroundPercent(PEEK_COPY.progress(PERCENT_SLOT, formatSpeed(speed)));
  return (
    <span className={styles.rowStateText}>
      {beforePercent}
      <SmoothPercent value={progress} track={track} />
      {afterPercent}
    </span>
  );
}
