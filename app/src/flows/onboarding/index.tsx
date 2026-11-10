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
import type { DataWriter } from "../../copy/data-format";
import { useLoadingGate } from "../../lib/loading-gate";
import { fade, stepPane, stepPaneFade } from "../../lib/motion";
import { useMounted } from "../../lib/useMounted";
import { useShell } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import { describeError } from "../../state/errors";
import type { FlowProps } from "../../state/flows";
import { useLauncherActions, useLauncherSelector } from "../../state/launcher";
import { useDiscoveredGameDirectories } from "../../state/queries/catalog";
import { Appear } from "../../ui/Appear";
import { Button, GlyphSlot } from "../../ui/Button";
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
/** 游戏目录被更新的版本用过、或记数据格式的文件读不懂：同样是这个目录不能用，原因也落在输入框下。 */
const GAME_DIR_DATA_TOO_NEW = "game_dir_data_too_new";
const DATA_FORMAT_UNREADABLE = "data_format_unreadable";

// 写成以通道为键的表：后端加了通道、类型跟着加时，这里漏写会在编译期报出来
const WRITER_CHANNELS: Readonly<Record<NonNullable<DataWriter["written_by_channel"]>, true>> = { dev: true, beta: true, stable: true };

function isWriterChannel(value: unknown): value is keyof typeof WRITER_CHANNELS {
  return typeof value === "string" && Object.hasOwn(WRITER_CHANNELS, value);
}

/** 左栏宽度随窗口档位；花枝插画按它画。 */
const SIDE_WIDTH = { compact: 248, regular: 248, wide: 272 } as const;
const BRANCH_HEIGHT = 200;

/**
 * 收尾时整体淡出并轻微放大。退场一律走 fade.out，缩放也跟着它在 120ms 内走完：外壳要等这段退场播完才挂主界面，
 * 缩放若走弹簧，透明度早已到 0 还要再等弹簧静止，窗口只剩底色与标题条。减少动画时只淡出：缩放在那里是一步到位的。
 */
const FINISH_EXIT = { opacity: 0, scale: 1.02, transition: fade.out } as const;
const FINISH_EXIT_REDUCED = { opacity: 0, transition: fade.out } as const;

type FinishVia = "start_now" | "skip" | "finish";

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** 后端错误附带的 detail。流程层不引用 ipc，按结构读；不是对象说明前后端的错误契约被破坏，抛出。 */
function detailOf(error: unknown, code: string): Record<string, unknown> {
  const detail = typeof error === "object" && error !== null && "detail" in error ? (error as { detail: unknown }).detail : undefined;
  if (typeof detail !== "object" || detail === null || Array.isArray(detail)) throw new Error(`${code} 的 detail 应是对象，实为 ${JSON.stringify(detail)}`);
  return detail as Record<string, unknown>;
}

/** 用过这个目录的那一版。字段形状不对同样是契约破坏，抛出，不退回「更新的落樱」把缺口藏起来。 */
function dataWriterOf(detail: Record<string, unknown>): DataWriter {
  const { written_by: version, written_by_channel: channel } = detail;
  if (version !== null && typeof version !== "string") throw new Error(`${GAME_DIR_DATA_TOO_NEW} 的 detail.written_by 应是字符串或 null，实为 ${JSON.stringify(version)}`);
  if (channel !== null && !isWriterChannel(channel)) throw new Error(`${GAME_DIR_DATA_TOO_NEW} 的 detail.written_by_channel 不认识：${JSON.stringify(channel)}`);
  return { written_by: version, written_by_channel: channel };
}

function unreadableReasonOf(detail: Record<string, unknown>): string {
  const { reason } = detail;
  if (typeof reason !== "string") throw new Error(`${DATA_FORMAT_UNREADABLE} 的 detail.reason 应是字符串，实为 ${JSON.stringify(reason)}`);
  return reason;
}

/**
 * 后端拒绝了这个游戏目录时写在输入框下的原因；别的失败为 null，只由通知说明。
 * 数据格式的两种不用通知里那句带路径的正文：路径就在上面的输入框里。
 */
function dirRejection(error: unknown): string | null {
  const code = errorCode(error);
  switch (code) {
    case INVALID_GAME_DIRECTORY:
      return describeError(error);
    case GAME_DIR_DATA_TOO_NEW:
      return DIR_COPY.dataTooNew(dataWriterOf(detailOf(error, code)));
    case DATA_FORMAT_UNREADABLE:
      return DIR_COPY.dataFormatUnreadable(unreadableReasonOf(detailOf(error, code)));
    default:
      return null;
  }
}

interface StepPaneProps {
  /** popLayout 往直接子项上挂 ref 来量尺寸、把退场的那一步抽出布局：React 19 下它是普通 prop，要自己接住挂到根元素上。 */
  ref?: Ref<HTMLDivElement>;
  direction: 1 | -1;
  /** 是否播入场：向导挂上时就在的那一步不播。 */
  enter: boolean;
  children: ReactNode;
}

/** 换步时新旧两步短暂并存：正在退场的那一步不可交互、不朗读，焦点与读屏只落在新的一步上。 */
function StepPane({ ref, direction, enter, children }: StepPaneProps) {
  const present = useIsPresent();
  const reduced = useReducedMotionConfig() === true;
  return (
    <motion.div
      ref={ref}
      className={s.pane}
      custom={direction}
      variants={reduced ? stepPaneFade : stepPane}
      initial={enter ? "enter" : false}
      animate="center"
      exit="exit"
      data-step-pane=""
      aria-hidden={present ? undefined : true}
      inert={!present}
    >
      {children}
    </motion.div>
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
              {status === "skipped" && <span className={s.railSkipped}>{FOOTER_COPY.skippedTag}</span>}
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

  return (
    <motion.div className={s.root} exit={reduced ? FINISH_EXIT_REDUCED : FINISH_EXIT}>
      <span className={s.ambience} aria-hidden="true" />
      <div className={s.panel} role="group" aria-label={WIZARD_LABEL}>
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
              {/* 隐形的「开始使用 →」垫在同一格里撑出宽度，真按钮撑满这一格：宽度跟着按钮组件自己的尺寸走，不在这里复写 */}
              <div className={s.primarySlot}>
                {last ? (
                  <Button
                    className={s.primaryAction}
                    variant="primary"
                    iconRight="arrow-right"
                    block
                    loading={finishing === "finish"}
                    disabled={!ready || (busy && finishing !== "finish")}
                    // 加载中文字淡去但保留占位，换成更长的字看不见却会撑宽按钮：可见文案不换，进行中的说法只给读屏
                    aria-label={finishing === "finish" ? FOOTER_COPY.preparing : undefined}
                    onClick={() => void finish("finish")}
                  >
                    {FOOTER_COPY.finish}
                  </Button>
                ) : (
                  <Button className={s.primaryAction} variant="primary" block loading={committing} disabled={!ready || (busy && !committing)} onClick={() => void next()}>
                    {FOOTER_COPY.next}
                  </Button>
                )}
                <span className={s.primaryGhost} aria-hidden="true" inert>
                  <Button variant="primary" iconRight="arrow-right">
                    {FOOTER_COPY.finish}
                  </Button>
                </span>
              </div>
            </div>
          </footer>
        </section>
      </div>
    </motion.div>
  );
}
