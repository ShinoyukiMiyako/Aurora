// 实例卡片底栏左侧的启动入口：与启动胶囊、状态岛、侧栏图标读同一个启动视图，只是紧凑形态。
// 每种视图写什么、点了做什么都照搬胶囊的判定，这里只负责排版。
// 换一种视图（点了启动、进入运行、结束、崩溃、修好）时与胶囊换面同一手感：旧面原地淡出并让出位置，新面晚一拍从下方落到位。
// 同一种视图里的阶段名、百分比与计时原位更新，不换面。

import { AnimatePresence, motion, useIsPresent, useReducedMotionConfig } from "framer-motion";
import { useLayoutEffect, useRef, type ReactNode, type Ref } from "react";
import { Icon } from "../../art/Icon";
import { LAUNCH_COPY, lockReason, MODPACK_REIMPORT_COPY, SESSION_COPY, TASK_STATUS_LABEL } from "../../copy/flows";
import type { InstanceSummary } from "../../domain/adapt";
import { locksOf } from "../../domain/instance-locks";
import { needsReimport } from "../../domain/rules";
import { sessionPhaseLabel, stageLabel, type LaunchView } from "../../launch/launchView";
import { useLaunch, type LaunchEntry } from "../../launch/useLaunch";
import { useMounted } from "../../lib/useMounted";
import { capsuleSwap, fade, springs } from "../../lib/motion";
import { useNav } from "../../shell/shell";
import { useNow } from "../../state/launcher";
import { reimportRoute } from "../../state/route";
import { progressTrack } from "../../state/tasks";
import { Button } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";
import { ProgressBar } from "../../ui/ProgressBar";
import { SmoothPercent } from "../../ui/SmoothPercent";
import { useDeleteInstance } from "../instance/delete";
import styles from "./library.module.css";

/** 底栏上的面：启动视图的种类，整合包没导入完的损坏实例另算一种（按钮完全不同）。 */
type FaceKind = LaunchView["kind"] | "reimport";

/**
 * 换面的进出。新面晚 faceEnterDelay 入场，旧面先让开。减少动画时只交叉淡化：
 * 位移在那里是一步到位的，带位移的退场会先跳一下再淡出。
 */
function faceMotion(reduced: boolean) {
  const delay = reduced ? 0 : capsuleSwap.faceEnterDelay;
  return {
    enter: reduced ? { opacity: 0 } : { opacity: 0, y: 6 },
    show: { opacity: 1, y: 0, transition: { ...springs.settle, delay, opacity: { ...fade.in, delay } } },
    leave: reduced ? { opacity: 0, transition: fade.out } : { opacity: 0, y: -6, transition: fade.out },
  } as const;
}

export function CardStatus({ inst }: { inst: InstanceSummary }) {
  const entry = useLaunch(inst.id);
  const view = entry.view;
  const kind: FaceKind = view.kind === "broken" && needsReimport(inst) ? "reimport" : view.kind;
  const reduced = useReducedMotionConfig() === true;
  // 卡片挂载时就在的面跟着卡片出现，不单独入场
  const mounted = useMounted();
  const slotRef = useRef<HTMLDivElement>(null);
  // 键盘按了面上的按钮（「启动」「取消启动」「修复并启动」）随即换面：焦点还停在退场的旧面上，旧面一变成不可交互，
  // 浏览器就把焦点落回 body，键盘用户只能从文档开头重新找起。焦点在旧面里时交给新面第一个可用的按钮
  useLayoutEffect(() => {
    const slot = slotRef.current;
    const active = document.activeElement;
    if (slot === null || active === null || !slot.contains(active)) return;
    const face = slot.querySelector<HTMLElement>(`[data-view="${kind}"]:not([inert])`);
    if (face === null || face.contains(active)) return;
    face.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
  }, [kind]);
  return (
    <div ref={slotRef} className={styles.statusSlot}>
      <AnimatePresence mode="popLayout">
        <Face key={kind} kind={kind} entering={mounted.current} reduced={reduced}>
          <FaceContent view={view} entry={entry} inst={inst} reimport={kind === "reimport"} />
        </Face>
      </AnimatePresence>
    </div>
  );
}

interface FaceProps {
  /** popLayout 把退场的面抽出布局时要量这一层，由 AnimatePresence 递进来。 */
  ref?: Ref<HTMLDivElement>;
  kind: FaceKind;
  /** 卡片挂载之后才换上来的面才播入场。 */
  entering: boolean;
  reduced: boolean;
  children: ReactNode;
}

/** 退场中的面已经让出位置、叠在新面上淡出：点不到、聚焦不到，按选择器找按钮时用 :not([inert]) 排除它。 */
function Face({ ref, kind, entering, reduced, children }: FaceProps) {
  const present = useIsPresent();
  const m = faceMotion(reduced);
  return (
    <motion.div ref={ref} className={styles.status} data-view={kind} inert={!present} initial={entering ? m.enter : false} animate={m.show} exit={m.leave}>
      {children}
    </motion.div>
  );
}

function FaceContent({ view, entry, inst, reimport }: { view: LaunchView; entry: LaunchEntry; inst: InstanceSummary; reimport: boolean }) {
  switch (view.kind) {
    case "ready":
      return (
        <>
          <Button size="sm" icon="play" disabledReason={entry.blocked === null ? undefined : entry.blocked} onClick={entry.launch}>
            {LAUNCH_COPY.launchShort}
          </Button>
          {view.busyElsewhere && <span className={styles.statusHint}>{LAUNCH_COPY.busyElsewhere}</span>}
        </>
      );
    case "loading":
      return <LoadingStatus view={view} entry={entry} />;
    case "running":
      return <RunningStatus view={view} entry={entry} />;
    case "stopped":
      return (
        <span className={styles.statusHint}>
          <Icon name="check" size={14} />
          {sessionPhaseLabel(view.session)}
        </span>
      );
    case "failed": {
      const failure = entry.failure;
      if (failure === null) throw new Error("启动失败的入口缺少失败文案");
      return (
        <>
          <span className={styles.statusDanger}>{LAUNCH_COPY.failedTitle}</span>
          <Button size="sm" onClick={() => entry.fix(failure.fix.kind)}>
            {failure.fix.label}
          </Button>
        </>
      );
    }
    case "crashed":
      return (
        <>
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
        </>
      );
    case "installing":
      return <InstallingStatus view={view} />;
    case "broken":
      if (reimport) return <ReimportStatus inst={inst} />;
      return (
        // 视图是 broken 说明本实例没有活动的会话；补全被基底占用、备份、改动挡住时不让点了才报 instance_busy
        <Button size="sm" icon="wrench" disabledReason={lockReason(locksOf(inst, false).repair, "repair")} onClick={entry.launch}>
          {LAUNCH_COPY.repairAndLaunch}
        </Button>
      );
  }
}

/** 整合包没导入完：补全补不回来，底栏不给「修复并启动」，改给重新导入与删除。 */
function ReimportStatus({ inst }: { inst: InstanceSummary }) {
  const { go } = useNav();
  const deleteInstance = useDeleteInstance();
  return (
    <>
      <Button size="sm" icon="modpack" onClick={() => go(reimportRoute(inst))}>
        {MODPACK_REIMPORT_COPY.reimport}
      </Button>
      <Button size="sm" variant="danger" icon="trash" disabledReason={lockReason(locksOf(inst, false).delete, "delete")} onClick={() => void deleteInstance(inst)}>
        {MODPACK_REIMPORT_COPY.delete}
      </Button>
    </>
  );
}

function LoadingStatus({ view, entry }: { view: Extract<LaunchView, { kind: "loading" }>; entry: LaunchEntry }) {
  const s = view.session;
  const stopping = entry.stopping;
  return (
    <>
      <div className={styles.statusProgress}>
        <span className={styles.statusLine}>
          <span className={styles.ellipsis}>{stopping ? SESSION_COPY.stopping : stageLabel(s.stageIndex)}</span>
          {/* 与下面的进度条同一条平滑（同一个 track），字跟着条走，不随每次上报跳字。
              加载阶段的进度到不了 99%（最后一段从 91% 起，进入运行才算满），不用封顶 */}
          <SmoothPercent className={styles.statusPct} value={s.progress} track={s.taskId} />
        </span>
        <ProgressBar value={s.progress} size="sm" track={s.taskId} label={stageLabel(s.stageIndex)} />
      </div>
      <IconButton icon="x" label={LAUNCH_COPY.cancel} size="sm" disabled={stopping} focusableWhenDisabled onClick={entry.cancel} />
    </>
  );
}

function RunningStatus({ view, entry }: { view: Extract<LaunchView, { kind: "running" }>; entry: LaunchEntry }) {
  const now = useNow(1000);
  const since = view.session.runningSince;
  if (since === null) throw new Error("running 会话缺少运行起点");
  const stopping = entry.stopping;
  return (
    <>
      {/* 文案占满按钮左边的空间：换成「正在结束…」或计时跨过整点时，结束按钮停在原处，不在指针下左右跳 */}
      <span className={styles.running}>
        <span className={styles.runningDot} aria-hidden="true" />
        <span className={styles.ellipsis}>{stopping ? SESSION_COPY.stopping : LAUNCH_COPY.runningTitle(now - since)}</span>
      </span>
      <Button size="sm" variant="ghost" icon="stop" loading={stopping} onClick={entry.stop}>
        {LAUNCH_COPY.stopGame}
      </Button>
    </>
  );
}

/** 文案模板里百分数的占位：模板按它切成前后两段，中间摆与进度条同步平滑的百分数节点（ui/SmoothPercent）。 */
const PERCENT_SLOT = "\u0000";

function aroundPercent(text: string): readonly [string, string] {
  const parts = text.split(PERCENT_SLOT);
  if (parts.length !== 2) throw new Error(`安装中的标题里百分数应当恰好出现一次，实为 ${parts.length - 1} 次`);
  return [parts[0], parts[1]];
}

const [INSTALLING_BEFORE, INSTALLING_AFTER] = aroundPercent(LAUNCH_COPY.installingTitle(PERCENT_SLOT));

function InstallingStatus({ view }: { view: Extract<LaunchView, { kind: "installing" }> }) {
  const task = view.task;
  // 排队（或后端在装、本次运行没有对应任务）时不画进度段：排队可能很久，不定进度条不允许常驻
  const queued = task === null || task.status === "queued";
  return (
    <div className={styles.statusProgress}>
      <span className={styles.statusLine}>
        <span className={styles.ellipsis}>
          {queued ? (
            LAUNCH_COPY.queuedTitle
          ) : (
            // 百分数与下面的进度条同一条平滑；平滑只在真有进度时挂上，排队的卡不多带一条弹簧
            <>
              {INSTALLING_BEFORE}
              <SmoothPercent value={task.progress} track={progressTrack(task)} />
              {INSTALLING_AFTER}
            </>
          )}
        </span>
        {queued && <b className={styles.statusPct}>{TASK_STATUS_LABEL.queued}</b>}
      </span>
      <ProgressBar
        value={queued ? 0 : task.progress}
        tone="info"
        size="sm"
        track={queued ? undefined : progressTrack(task)}
        label={queued ? LAUNCH_COPY.queuedTitle : task.title}
      />
    </div>
  );
}
