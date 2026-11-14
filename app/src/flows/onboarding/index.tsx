// 首次启动向导：四步交代游戏目录、Java、账户与外观。只有第一步必填，后三步都能跳过，
// 第二、三步还能「直接开始」用默认值收尾；每步的默认值就是推荐值，一路「下一步」就能得到可用的启动器。
//
// 何时落盘：离开第一步时就把游戏目录、收下的文件夹与「向导已走过」一次写下（commitFirstRun），之后中途关掉窗口，
// 下次打开直接进主界面，不会再从头走一遍；向导仍挂着，接着走后面几步。回到第一步改了目录或勾选再离开时重新提交，
// 没改不重复提交。收尾只把向导卸载（finishFirstRun）。第二到四步的开关与外观在各步里即时写入。
// 后端拒绝了游戏目录时停在（或回到）第一步，把原因写在输入框下。

import { AnimatePresence, motion, useIsPresent, useReducedMotionConfig } from "framer-motion";
import { useRef, useState, type ReactNode, type Ref } from "react";
import { Icon } from "../../art/Icon";
import { BlossomBranch } from "../../art/illustrations/BlossomBranch";
import { useLoadingGate } from "../../lib/loading-gate";
import { fade, popMark, stepPane, stepPaneFade } from "../../lib/motion";
import { useMounted } from "../../lib/useMounted";
import { usePaintedOnce } from "../../lib/usePaintedOnce";
import { cx } from "../../lib/util";
import { useShell } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import { describeError, gameDirDataRejectionOf } from "../../state/errors";
import type { FlowProps } from "../../state/flows";
import { useLauncherActions, useLauncherSelector } from "../../state/launcher";
import { useDiscoveredGameDirectories } from "../../state/queries/catalog";
import { Appear } from "../../ui/Appear";
import { Button, CONTROL_ICON_SIZE, GlyphSlot } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Loadable } from "../../ui/Loadable";
import { DIR_COPY, FOOTER_COPY, STEP_COPY, stepCounter, WIZARD_LABEL } from "./copy";
import {
  advance,
  back,
  backToStart,
  canJumpTo,
  canSkip,
  canStartNow,
  dirProblem,
  extraCandidates,
  INITIAL_WIZARD,
  jumpTo,
  LAST_STEP,
  pickedExtras,
  STEPS,
  stepId,
  stepStatus,
  type WizardState,
} from "./model";
import s from "./onboarding.module.css";
import { StepAccount } from "./StepAccount";
import { StepAppearance } from "./StepAppearance";
import { GameDirSkeleton, StepGameDir } from "./StepGameDir";
import { StepJava } from "./StepJava";

/** 后端拒绝游戏目录时的错误码。 */
const INVALID_GAME_DIRECTORY = "invalid_game_directory";

/** 左栏宽度随窗口档位；花枝插画按它画。 */
const SIDE_WIDTH = { compact: 248, regular: 248, wide: 272 } as const;
const BRANCH_HEIGHT = 200;

/**
 * 收尾时整体淡出并轻微放大。退场一律走 fade.out，缩放也跟着它在 120ms 内走完：外壳要等这段退场播完才挂主界面，
 * 缩放若走弹簧，透明度早已到 0 还要再等弹簧静止，窗口只剩底色与标题条。减少动画时只淡出：缩放在那里是一步到位的。
 *
 * 淡出在根上，放大在根里面的晕染与面板上：根在外壳的滚动容器里撑满一格，放大根会把容器的可滚动区撑大、冒出滚动条，
 * 根随之变窄变矮，面板在退场途中一帧左移、上移半个滚动条宽。根自己裁切溢出，里面放大出去的部分不外溢。
 * 晕染铺满根、面板在根里居中，两者各按自身中心放大，合起来与整体放大一样。
 */
const FINISH_FADE = { opacity: 0, transition: fade.out } as const;
const FINISH_GROW = { scale: 1.02, transition: fade.out } as const;

type FinishVia = "start_now" | "skip" | "finish";

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * 后端拒绝了这个游戏目录时写在输入框下的原因；别的失败为 null，只由通知说明。
 * 游戏目录被更新的版本用过、或记数据格式的文件读不懂，同样是这个目录不能用，原因也落在输入框下；
 * 这两种不用通知里那句带路径的正文：路径就在上面的输入框里。
 */
function dirRejection(error: unknown): string | null {
  if (errorCode(error) === INVALID_GAME_DIRECTORY) return describeError(error);
  const rejection = gameDirDataRejectionOf(error);
  if (rejection === null) return null;
  switch (rejection.kind) {
    case "too_new":
      return DIR_COPY.dataTooNew(rejection.detail);
    case "unreadable":
      return DIR_COPY.dataFormatUnreadable(rejection.detail.reason);
  }
}

interface StepPaneProps {
  /** popLayout 往直接子项上挂 ref 来量尺寸、把退场的那一步抽出布局：React 19 下它是普通 prop，要自己接住挂到根元素上。 */
  ref?: Ref<HTMLDivElement>;
  direction: 1 | -1;
  /** 是否播入场：向导挂上时就在的那一步不播。只认挂载那一刻的值。 */
  enter: boolean;
  children: ReactNode;
}

/** 换步时新旧两步短暂并存：正在退场的那一步不可交互、不朗读，焦点与读屏只落在新的一步上。 */
function StepPane({ ref, direction, enter, children }: StepPaneProps) {
  const present = useIsPresent();
  const reduced = useReducedMotionConfig() === true;
  // 冻结挂载那一刻的值：向导挂上之后每次渲染给的 enter 都为真，挂载时就在的那一步不能因此退回起点
  const [entering] = useState(enter);
  // 换上来的一步先停在起点，画出第一帧之后才起步：换步那次提交要挂上整片新内容，从提交就计时的话第一帧画出来时已走掉一截。
  // 旧的一步这时正在退场，多等这一帧不会露出空白
  const painted = usePaintedOnce("pane", entering);
  return (
    <motion.div
      ref={ref}
      className={s.pane}
      custom={direction}
      variants={reduced ? stepPaneFade : stepPane}
      initial={entering ? "enter" : false}
      animate={painted ? "center" : "enter"}
      exit="exit"
      data-step-pane=""
      aria-hidden={present ? undefined : true}
      inert={!present}
    >
      {children}
    </motion.div>
  );
}

/**
 * 步骤条行尾的「已跳过」：跳过那一步时弹出，回到那一步时原地淡出。它在行尾，进出都不挤别的内容，退场不必抽出布局。
 * 按钮里只能放行内元素，所以不用 ui/Appear（它每项外面包一层 div），自己挂 popMark。
 */
function SkippedTag() {
  const reduced = useReducedMotionConfig() === true;
  const mark = reduced ? popMark.reduced : popMark.tag;
  // 跳过与换步落在同一次提交里，那一帧要挂上整片新的一步：先停在起点，画出第一帧之后才弹出，开头一截不在提交里耗掉
  const painted = usePaintedOnce("tag", true);
  return (
    <motion.span className={s.railSkipped} initial={mark.initial} animate={painted ? mark.animate : mark.initial} exit={mark.exit}>
      {FOOTER_COPY.skippedTag}
    </motion.span>
  );
}

function StepRail({ wizard, onJump }: { wizard: WizardState; onJump: (index: number) => void }) {
  return (
    <ol className={s.rail} aria-label={FOOTER_COPY.stepsLabel}>
      {STEPS.map((id, i) => {
        const status = stepStatus(wizard, i);
        return (
          <li key={id}>
            <button
              type="button"
              className={s.railItem}
              data-status={status}
              aria-current={status === "current" ? "step" : undefined}
              disabled={!canJumpTo(wizard, i)}
              onClick={() => onJump(i)}
            >
              <span className={s.railDot}>
                {/* 序号换成勾号时勾号弹出、序号原地淡出，圆的尺寸不变 */}
                <GlyphSlot glyph={status === "done" ? "check" : "index"}>{status === "done" ? <Icon name="check" size={14} /> : i + 1}</GlyphSlot>
              </span>
              <span className={s.railName}>{STEP_COPY[id].name}</span>
              <AnimatePresence>{status === "skipped" && <SkippedTag key="skipped" />}</AnimatePresence>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export default function OnboardingFlow(_props: FlowProps<"onboarding">) {
  const settings = useLauncherSelector((s) => s.settings);
  const settingsStatus = useLauncherSelector((s) => s.status.settings);
  const actions = useLauncherActions();
  const { tier } = useShell();
  const run = useRunner();
  const reduced = useReducedMotionConfig() === true;
  const settingsGate = useLoadingGate(settings === null);
  const discovered = useDiscoveredGameDirectories();
  // 文件夹探测的加载门放在这里：第一步重新挂上（配置晚到、换步回来）时接着这一轮，不从等待期重来
  const discoveredGate = useLoadingGate(discovered.status === "loading");
  const [wizard, setWizard] = useState<WizardState>(INITIAL_WIZARD);
  const [pathOverride, setPathOverride] = useState<string | null>(null);
  const [deselected, setDeselected] = useState<ReadonlySet<string>>(new Set());
  const [dirError, setDirError] = useState<string | null>(null);
  const [finishing, setFinishing] = useState<FinishVia | null>(null);
  const [committing, setCommitting] = useState(false);
  // 上次提交给后端的第一步内容；与此刻一样就不再提交
  const [committed, setCommitted] = useState<string | null>(null);
  // 向导挂上时就在的那一步不播入场：窗口这时才显示出来，内容应当已经在位。
  // 不能写成 AnimatePresence 的 initial={false}：那会让这一步里之后才挂载的元素也永远跳过入场
  const mounted = useMounted();

  // 默认目录来自后端配置：配置读到之前没有目录可言，各个按钮也都不可用
  const path = settings === null ? null : pathOverride === null ? settings.defaultGameDir : pathOverride;
  const id = stepId(wizard.index);
  const copy = STEP_COPY[id];

  const currentPath = (): string => {
    if (path === null) throw new Error("配置读到之前不能提交游戏目录");
    return path;
  };

  /** 离开第一步前的本地校验；不通过时把原因写在输入框下并停在第一步。 */
  const dirAccepted = (): boolean => {
    const problem = dirProblem(currentPath());
    if (problem === null) {
      setDirError(null);
      return true;
    }
    setDirError(problem === "empty" ? DIR_COPY.empty : DIR_COPY.bang);
    return false;
  };

  /** 把第一步写下：本地校验不过或后端拒绝时回到第一步、写明原因，返回 false。 */
  const commitStepOne = async (): Promise<boolean> => {
    if (!dirAccepted()) {
      setWizard(backToStart);
      return false;
    }
    const gameDir = currentPath().trim();
    // 探测结果还没回来时用户也就没见过它们，不替用户收下
    const extras = discovered.status === "ready" ? pickedExtras(extraCandidates(discovered.data, gameDir), deselected) : [];
    const key = JSON.stringify([gameDir, extras]);
    if (committed === key) return true;
    setCommitting(true);
    const result = await run(() => actions.commitFirstRun(gameDir, extras), FOOTER_COPY.finishFailed);
    setCommitting(false);
    if (result.ok) {
      setCommitted(key);
      return true;
    }
    const rejection = dirRejection(result.error);
    if (rejection !== null) setDirError(rejection);
    setWizard(backToStart);
    return false;
  };

  // 离开第一步要等提交回来：这期间再按 Enter、点步骤条也会各自提交一次、各自前进，连按两下 Enter 就越过了第二步，
  // 点过步骤条的那次还会在已经换步之后照原目标跳转而抛错。同一时刻只放行一次换步，之后到的直接忽略。
  const stepping = useRef(false);
  const step = async (move: () => Promise<void>) => {
    if (stepping.current) return;
    stepping.current = true;
    try {
      await move();
    } finally {
      stepping.current = false;
    }
  };

  const next = () =>
    step(async () => {
      if (wizard.index === 0 && !(await commitStepOne())) return;
      setWizard((w) => advance(w, "next"));
    });

  const jump = (index: number) =>
    step(async () => {
      if (wizard.index === 0 && index !== 0 && !(await commitStepOne())) return;
      setWizard((w) => jumpTo(w, index));
    });

  const finish = async (via: FinishVia) => {
    setFinishing(via);
    // 收尾只能在第二步以后，离开第一步时已经按用户当时看到的内容提交过；这里不按此刻的状态重算：
    // 用户离开第一步之后才探测到的文件夹，用户没见过，不替用户收下
    if (committed === null && !(await commitStepOne())) {
      setFinishing(null);
      return;
    }
    // 成功后 firstRun 变为 false，外壳卸载向导
    await run(() => actions.finishFirstRun(), FOOTER_COPY.finishFailed);
  };

  let body: ReactNode;
  if (settingsStatus.kind === "error") {
    body = (
      <Callout
        tone="danger"
        announce
        action={
          <Button size="sm" variant="ghost" onClick={() => void run(() => actions.reload("settings"), DIR_COPY.settingsFailed)}>
            {DIR_COPY.retry}
          </Button>
        }
      >
        <span className={s.calloutTitle}>{DIR_COPY.settingsFailed}</span>
        <span className={s.errorText}>{settingsStatus.error.message}</span>
      </Callout>
    );
  } else if (id === "gameDir") {
    // 配置先于向导挂上时多半已经读到，这里一挂上就是内容；冷启动时配置晚到才经加载门占位、交叉淡入
    body = (
      <Loadable view={settingsGate.view} skeleton={<GameDirSkeleton />}>
        {() => {
          if (settings === null || path === null) throw new Error("加载门放行内容时配置一定已经读到");
          return (
            <StepGameDir
              path={path}
              defaultPath={settings.defaultGameDir}
              error={dirError}
              deselected={deselected}
              othersView={discoveredGate.view}
              onPathChange={(value) => {
                setPathOverride(value);
                setDirError(null);
              }}
              onToggleExtra={(extra, picked) =>
                setDeselected((prev) => {
                  const nextSet = new Set(prev);
                  if (picked) nextSet.delete(extra);
                  else nextSet.add(extra);
                  return nextSet;
                })
              }
              onSubmit={() => void next()}
            />
          );
        }}
      </Loadable>
    );
  } else if (id === "java") {
    body = <StepJava />;
  } else if (id === "account") {
    body = <StepAccount />;
  } else {
    body = <StepAppearance />;
  }

  const ready = settings !== null;
  const busy = finishing !== null || committing;
  const last = wizard.index === LAST_STEP;
  // 主按钮在第一步是提交中、在第四步是收尾中才转圈
  const primaryLoading = last ? finishing === "finish" : committing;

  return (
    <motion.div className={s.root} exit={FINISH_FADE}>
      <motion.span className={s.ambience} aria-hidden="true" exit={reduced ? undefined : FINISH_GROW} />
      <motion.div className={s.panel} role="group" aria-label={WIZARD_LABEL} exit={reduced ? undefined : FINISH_GROW}>
        <aside className={s.side}>
          <BlossomBranch width={SIDE_WIDTH[tier]} height={BRANCH_HEIGHT} />
          <StepRail wizard={wizard} onJump={(index) => void jump(index)} />
        </aside>
        <section className={s.main}>
          <div className={s.stage}>
            <AnimatePresence mode="popLayout" custom={wizard.direction}>
              <StepPane key={id} direction={wizard.direction} enter={mounted.current}>
                <header className={s.head}>
                  <span className={s.counter}>{stepCounter(wizard.index + 1, STEPS.length)}</span>
                  <h1 className={s.title}>{copy.title}</h1>
                  <p className={s.desc}>{copy.desc}</p>
                </header>
                <div className={s.scroll}>{body}</div>
              </StepPane>
            </AnimatePresence>
          </div>
          {/* 随步骤出没的按钮淡入淡出、退场时立即让位；主按钮按最宽的文案定宽，换到第四步、点下转圈时宽度都不变 */}
          <footer className={s.footer}>
            <div className={s.footerStart}>
              <Appear itemClassName={s.footerItem}>
                {wizard.index > 0 && (
                  <Button key="back" variant="ghost" icon="arrow-left" disabled={busy} onClick={() => setWizard(back)}>
                    {FOOTER_COPY.back}
                  </Button>
                )}
                {canStartNow(wizard.index) && (
                  <Button key="start-now" variant="ghost" loading={finishing === "start_now"} disabled={busy && finishing !== "start_now"} onClick={() => void finish("start_now")}>
                    {FOOTER_COPY.startNow}
                  </Button>
                )}
              </Appear>
            </div>
            <div className={s.footerEnd}>
              <Appear itemClassName={s.footerItem}>
                {canSkip(wizard.index) && (
                  <Button
                    key="skip"
                    variant="ghost"
                    loading={finishing === "skip"}
                    disabled={busy && finishing !== "skip"}
                    onClick={() => (last ? void finish("skip") : setWizard((w) => advance(w, "skip")))}
                  >
                    {FOOTER_COPY.skip}
                  </Button>
                )}
              </Appear>
              {/*
               * 主按钮从头到尾是同一颗按钮（聚焦着的按钮不丢焦点），每一步都一样宽，左边的「跳过」不被推走：
               * - 「开始使用」与后置箭头排成一行撑出宽度。箭头常驻，前三步由样式表按 data-face 隐去，到第四步淡入，
               *   不随按钮的 iconRight 来去一帧出没。
               * - 两条文案各一层叠着交叉淡化；「下一步」铺满按钮居中，停在原来不带图标的按钮上的位置。
               */}
              <Button
                className={s.primaryAction}
                variant="primary"
                data-face={last ? "finish" : "next"}
                loading={primaryLoading}
                disabled={!ready || (busy && !primaryLoading)}
                // 加载中文字淡去但保留占位，换成更长的字看不见却会撑宽按钮：可见文案不换，进行中的说法只给读屏
                aria-label={finishing === "finish" ? FOOTER_COPY.preparing : undefined}
                onClick={() => void (last ? finish("finish") : next())}
              >
                <span className={cx(s.primaryFace, s.primaryNext)} data-current={!last || undefined} aria-hidden={last || undefined}>
                  {FOOTER_COPY.next}
                </span>
                <span className={s.primaryFinish}>
                  <span className={s.primaryFace} data-current={last || undefined} aria-hidden={!last || undefined}>
                    {FOOTER_COPY.finish}
                  </span>
                  <Icon name="arrow-right" size={CONTROL_ICON_SIZE.md} className={s.primaryArrow} />
                </span>
              </Button>
            </div>
          </footer>
        </section>
      </motion.div>
    </motion.div>
  );
}
