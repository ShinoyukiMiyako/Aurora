// 首次启动向导：四步交代游戏目录、Java、账户与外观。只有第一步必填，后三步都能跳过，
// 第二、三步还能「直接开始」用默认值收尾；每步的默认值就是推荐值，一路「下一步」就能得到可用的启动器。
//
// 何时落盘：首次启动标记由 completeFirstRun 一次写下，写下后状态层把 firstRun 置为 false、外壳随即卸载向导。
// 所以它只在收尾时调用；第二到四步的开关与外观在各步里即时写入，不受影响。收尾时后端拒绝了游戏目录，
// 回到第一步把原因写在输入框下。

import { AnimatePresence, motion, useIsPresent, type Variants } from "framer-motion";
import { useState, type ReactNode } from "react";
import { Icon } from "../../art/Icon";
import { BlossomBranch } from "../../art/illustrations/BlossomBranch";
import { fade, springs } from "../../lib/motion";
import { useShell } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import { describeError } from "../../state/errors";
import type { FlowProps } from "../../state/flows";
import { useLauncher } from "../../state/launcher";
import { useDiscoveredGameDirectories } from "../../state/queries/catalog";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Skeleton } from "../../ui/Skeleton";
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
import { StepGameDir } from "./StepGameDir";
import { StepJava } from "./StepJava";

/** 后端拒绝游戏目录时的错误码。 */
const INVALID_GAME_DIRECTORY = "invalid_game_directory";

/** 左栏宽度随窗口档位；花枝插画按它画。 */
const SIDE_WIDTH = { compact: 248, regular: 248, wide: 272 } as const;
const BRANCH_HEIGHT = 200;

/** 新步骤从前进方向一侧滑入，旧步骤朝反方向退出；减少动画时位移被关掉，只剩淡入淡出。 */
const stepMotion: Variants = {
  enter: (dir: number) => ({ opacity: 0, x: 16 * dir }),
  center: { opacity: 1, x: 0, transition: { ...springs.soft, opacity: fade.in } },
  exit: (dir: number) => ({ opacity: 0, x: -16 * dir, transition: fade.out }),
};

type FinishVia = "start_now" | "skip" | "finish";

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** 换步时新旧两步短暂并存：正在退场的那一步不可交互、不朗读，焦点与读屏只落在新的一步上。 */
function StepPane({ direction, children }: { direction: 1 | -1; children: ReactNode }) {
  const present = useIsPresent();
  return (
    <motion.div
      className={s.pane}
      custom={direction}
      variants={stepMotion}
      initial="enter"
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
              <span className={s.railDot}>{status === "done" ? <Icon name="check" size={14} /> : i + 1}</span>
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
  const { state, actions } = useLauncher();
  const { tier } = useShell();
  const run = useRunner();
  const discovered = useDiscoveredGameDirectories();
  const [wizard, setWizard] = useState<WizardState>(INITIAL_WIZARD);
  const [pathOverride, setPathOverride] = useState<string | null>(null);
  const [deselected, setDeselected] = useState<ReadonlySet<string>>(new Set());
  const [dirError, setDirError] = useState<string | null>(null);
  const [finishing, setFinishing] = useState<FinishVia | null>(null);

  const settings = state.settings;
  const settingsStatus = state.status.settings;
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

  const next = () => {
    if (wizard.index === 0 && !dirAccepted()) return;
    setWizard((w) => advance(w, "next"));
  };

  const jump = (index: number) => {
    if (wizard.index === 0 && !dirAccepted()) return;
    setWizard((w) => jumpTo(w, index));
  };

  const finish = async (via: FinishVia) => {
    if (!dirAccepted()) {
      setWizard(backToStart);
      return;
    }
    setFinishing(via);
    const gameDir = currentPath().trim();
    // 探测结果还没回来时用户也就没见过它们，不替用户收下
    const extras = discovered.status === "ready" ? pickedExtras(extraCandidates(discovered.data, gameDir), deselected) : [];
    const result = await run(() => actions.completeFirstRun(gameDir, extras), FOOTER_COPY.finishFailed);
    // 成功时 firstRun 变为 false，外壳卸载向导；这里只处理失败
    if (result.ok) return;
    setFinishing(null);
    if (errorCode(result.error) === INVALID_GAME_DIRECTORY) setDirError(describeError(result.error));
    setWizard(backToStart);
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
  } else if (settings === null || path === null) {
    body = (
      <div className={s.stepBody} aria-busy="true">
        <Skeleton shape="block" width="100%" height={52} radius="md" />
        <Skeleton shape="block" width="100%" height={76} radius="md" />
      </div>
    );
  } else if (id === "gameDir") {
    body = (
      <StepGameDir
        path={path}
        defaultPath={settings.defaultGameDir}
        error={dirError}
        deselected={deselected}
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
        onSubmit={next}
      />
    );
  } else if (id === "java") {
    body = <StepJava />;
  } else if (id === "account") {
    body = <StepAccount />;
  } else {
    body = <StepAppearance />;
  }

  const ready = settings !== null;
  const busy = finishing !== null;
  const last = wizard.index === LAST_STEP;

  return (
    <motion.div className={s.root} exit={{ opacity: 0, scale: 1.02, transition: { ...springs.soft, opacity: fade.out } }}>
      <span className={s.ambience} aria-hidden="true" />
      <div className={s.panel} role="group" aria-label={WIZARD_LABEL}>
        <aside className={s.side}>
          <BlossomBranch width={SIDE_WIDTH[tier]} height={BRANCH_HEIGHT} />
          <StepRail wizard={wizard} onJump={jump} />
        </aside>
        <section className={s.main}>
          <div className={s.stage}>
            <AnimatePresence mode="popLayout" initial={false} custom={wizard.direction}>
              <StepPane key={id} direction={wizard.direction}>
                <header className={s.head}>
                  <span className={s.counter}>{stepCounter(wizard.index + 1, STEPS.length)}</span>
                  <h1 className={s.title}>{copy.title}</h1>
                  <p className={s.desc}>{copy.desc}</p>
                </header>
                <div className={s.scroll}>{body}</div>
              </StepPane>
            </AnimatePresence>
          </div>
          <footer className={s.footer}>
            <div className={s.footerStart}>
              {wizard.index > 0 && (
                <Button variant="ghost" icon="arrow-left" disabled={busy} onClick={() => setWizard(back)}>
                  {FOOTER_COPY.back}
                </Button>
              )}
              {canStartNow(wizard.index) && (
                <Button variant="ghost" loading={finishing === "start_now"} disabled={busy && finishing !== "start_now"} onClick={() => void finish("start_now")}>
                  {FOOTER_COPY.startNow}
                </Button>
              )}
            </div>
            <div className={s.footerEnd}>
              {canSkip(wizard.index) && (
                <Button
                  variant="ghost"
                  loading={finishing === "skip"}
                  disabled={busy && finishing !== "skip"}
                  onClick={() => (last ? void finish("skip") : setWizard((w) => advance(w, "skip")))}
                >
                  {FOOTER_COPY.skip}
                </Button>
              )}
              {last ? (
                <Button variant="primary" iconRight="arrow-right" loading={finishing === "finish"} disabled={!ready || (busy && finishing !== "finish")} onClick={() => void finish("finish")}>
                  {finishing === "finish" ? FOOTER_COPY.preparing : FOOTER_COPY.finish}
                </Button>
              ) : (
                <Button variant="primary" disabled={!ready || busy} onClick={next}>
                  {FOOTER_COPY.next}
                </Button>
              )}
            </div>
          </footer>
        </section>
      </div>
    </motion.div>
  );
}
