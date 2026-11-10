// 窗口骨架：左栏 248（字标、花枝、版本与协议入口）、主列（标题、说明、内容）、右对齐的底栏，右上角只有最小化和关闭。
// 骨架数值沿用启动器 first-run 面板的 regular 档：安装窗关闭后向导面板以同尺寸出现，两段流程看着像一个产品。
// 不引用 shell/TitleBar 的窗口按钮：它连带整个外壳。
//
// 左栏和窗口按钮由 FrameShell 常驻，视图只渲染主列里的那一页（Frame）。花瓣是氛围层，换步时不该随内容一起卸掉重撒；
// 换步时新页淡入、旧页淡出，按方向带一点横移，和启动器首启向导的换步是同一种手感。
//
// 窗口四周的空白都能拖动：data-tauri-drag-region="deep" 下子树里的按钮、输入框自然挡住拖动。
// 内容区例外：滚动条和要选中的错误原文都不是可点击元素，放在拖动区里一按就成了拖窗。
// 窗口级的东西（版本号、关窗能力、协议入口）由 App 经 FrameChrome 下发，视图只管自己的标题、内容和底栏。

import { AnimatePresence, motion, useIsPresent, useReducedMotionConfig, type Variants } from "framer-motion";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, type ReactNode, type Ref } from "react";
import { Icon } from "../art/Icon";
import { fade, springs } from "../lib/motion";
import { playTrack, springTrack } from "../lib/slide";
import { softDisabledProps } from "../ui/Button";
import { Tooltip } from "../ui/Tooltip";
import { BrandMark, StageArt } from "./art";
import type { SetupCopy } from "./copy";
import type { StepDirection } from "./model";
import styles from "./setup.module.css";

export interface FrameChrome {
  copy: SetupCopy["frame"];
  /** 载荷版本；探测之前就崩溃时没有。 */
  version: string | null;
  canClose: boolean;
  canOpenLegal: boolean;
  /** 减少动画的生效值，花瓣层要用。 */
  reduced: boolean;
  onMinimize(): void;
  onClose(): void;
  onOpenLegal(): void;
}

const FrameChromeContext = createContext<FrameChrome | null>(null);

export const FrameChromeProvider = FrameChromeContext.Provider;

function useFrameChrome(): FrameChrome {
  const chrome = useContext(FrameChromeContext);
  if (chrome === null) throw new Error("FrameShell 必须在 FrameChromeProvider 之内使用");
  return chrome;
}

function WindowControls({ chrome }: { chrome: FrameChrome }) {
  const { copy, canClose, onMinimize, onClose } = chrome;
  const closeGuard = softDisabledProps<HTMLButtonElement>(!canClose, onClose);
  return (
    <div className={styles.windowControls}>
      <button type="button" className={styles.winButton} aria-label={copy.minimize} onClick={onMinimize}>
        <span className={styles.winFace}>
          <Icon name="win-min" size={16} />
        </span>
      </button>
      <Tooltip content={copy.closeBlocked} side="left" disabled={canClose}>
        <button type="button" className={styles.winButton} data-close="" data-disabled={!canClose || undefined} aria-label={copy.close} aria-disabled={closeGuard["aria-disabled"]} onClick={closeGuard.onClick}>
          <span className={styles.winFace}>
            <Icon name="win-close" size={16} />
          </span>
        </button>
      </Tooltip>
    </div>
  );
}

/** 换步时的横移距离（px），和首启向导一致。 */
const STEP_SHIFT_PX = 16;

/** 新页从前进方向一侧进来，旧页朝反方向退出；方向为 0 时只淡入淡出。 */
const stepMotion: Variants = {
  enter: (direction: StepDirection) => ({ opacity: 0, x: STEP_SHIFT_PX * direction }),
  center: { opacity: 1, x: 0, transition: { ...springs.soft, opacity: fade.in } },
  exit: (direction: StepDirection) => ({ opacity: 0, x: -STEP_SHIFT_PX * direction, transition: fade.out }),
};

/**
 * 减少动画时的换步：只淡入淡出。不能沿用 stepMotion 等根部 MotionConfig 去关位移：它把位移改成一步到位，
 * 旧页会先横跳 16px、还是不透明的，再花一个 fade.out 淡掉。
 */
const stepFade: Variants = {
  enter: { opacity: 0 },
  center: { opacity: 1, transition: fade.in },
  exit: { opacity: 0, transition: fade.out },
};

/** 视图把它标在两页里「同一块」内容上（值相同），换步时那两块跟着走，见 carryAcross。 */
const CARRY_ATTR = "data-setup-carry";

/** 位置差不到这么多像素不算挪动：亚像素取整的抖动不该起动画。 */
const CARRY_EPSILON_PX = 1;

/**
 * 两页都有的同一块内容在换步时跟着走：新页这一块从旧页那一块的位置沿弹簧滑到自己的位置，旧页那一块同时朝新位置走，
 * 两块交叉淡入淡出，看着是一块在挪。这是兜底：能预留就先预留（欢迎页与选目录页靠 leadFloor 让标题区等高，这一块本就在同一高度），
 * 竖向挪得多了，挪动中的块会压过新页的说明。
 * 位移交给 Web Animations、写在 translate 上：整段在合成线程上播，与页面自己在 transform 上的横移叠加、互不覆盖。
 * 旧页这时已被 popLayout 抽出布局、叠在原处，量到的就是它换步前的位置。
 */
function carryAcross(pane: HTMLElement): void {
  if (pane.ownerDocument.documentElement.hasAttribute("data-sk-reduced")) return;
  const target = pane.querySelector<HTMLElement>(`[${CARRY_ATTR}]`);
  // 运行环境没有 Web Animations（组件测试的 jsdom）时不跟
  if (target === null || typeof target.animate !== "function") return;
  const host = pane.parentElement;
  if (host === null) throw new Error("换步的页不在主列里");
  const name = target.getAttribute(CARRY_ATTR);
  let source: HTMLElement | null = null;
  for (const sibling of host.children) {
    if (sibling === pane) continue;
    const found = sibling.querySelector<HTMLElement>(`[${CARRY_ATTR}="${name}"]`);
    if (found !== null) source = found;
  }
  if (source === null) return;
  const from = source.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  if (Math.abs(dx) < CARRY_EPSILON_PX && Math.abs(dy) < CARRY_EPSILON_PX) return;
  playTrack(target, springTrack("morph", dx, 0, dy, 0));
  playTrack(source, springTrack("morph", dx, 0, dy, 0, -dx, -dy));
}

interface StepPaneProps {
  /** popLayout 往直接子项上挂 ref 来量尺寸、把退场的页抽出布局：React 19 下它是普通 prop，要自己接住挂到根元素上。 */
  ref?: Ref<HTMLDivElement>;
  direction: StepDirection;
  /** 是否播入场：骨架挂上时就在的那一页不播。 */
  enter: boolean;
  children: ReactNode;
}

/** 换步时新旧两页短暂并存：退场中的那一页不可交互、不朗读，焦点与读屏只落在新的一页上。 */
function StepPane({ ref, direction, enter, children }: StepPaneProps) {
  const present = useIsPresent();
  const reduced = useReducedMotionConfig() === true;
  const own = useRef<HTMLDivElement | null>(null);
  const bind = useCallback(
    (el: HTMLDivElement | null) => {
      own.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );
  // 只在这一页挂上的那一刻跟一次：此后同一页里的重渲染与换步无关
  const entering = useRef(enter);
  useLayoutEffect(() => {
    const pane = own.current;
    if (pane === null) throw new Error("换步的页挂上了却没有元素");
    if (entering.current) carryAcross(pane);
  }, []);
  return (
    <motion.div
      ref={bind}
      className={styles.pane}
      custom={direction}
      variants={reduced ? stepFade : stepMotion}
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

export interface FrameShellProps {
  /** 当前这一页的键：变了就是换步，新页入场、旧页退场。 */
  step: string;
  /** 换步方向，由 model 的 stepDirection 在换步那一刻算好。 */
  direction: StepDirection;
  /** 当前这一页：渲染 Frame 的视图。 */
  children: ReactNode;
}

/** 常驻的窗口骨架：左栏、窗口按钮，以及主列里按 step 换的那一页。 */
export function FrameShell({ step, direction, children }: FrameShellProps) {
  const chrome = useFrameChrome();
  const { copy, version } = chrome;
  // 骨架挂上时就在的那一页不播入场：窗口这时才显示出来，内容应当已经在位
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);
  return (
    <div className={styles.frame}>
      <aside className={styles.side} data-tauri-drag-region="deep">
        <div className={styles.brand}>
          <BrandMark />
        </div>
        <StageArt reduced={chrome.reduced} />
        <div className={styles.sideFoot}>
          <span className={styles.sideMeta}>{version === null ? copy.license : copy.versionLine(version)}</span>
          <button type="button" className={styles.legalLink} disabled={!chrome.canOpenLegal} onClick={chrome.onOpenLegal}>
            {copy.legalLink}
          </button>
        </div>
      </aside>
      <main className={styles.main} data-tauri-drag-region="deep">
        <WindowControls chrome={chrome} />
        <AnimatePresence mode="popLayout" custom={direction}>
          <StepPane key={step} direction={direction} enter={mounted.current}>
            {children}
          </StepPane>
        </AnimatePresence>
      </main>
    </div>
  );
}

export interface FrameProps {
  title: ReactNode;
  /** 标题下的说明。 */
  lead?: ReactNode;
  /**
   * 说明区至少按这段文字的高度占位，它本身不显示。两页之间原地换（只淡不移）、下面又有同一块内容时，
   * 各自把对方的说明传进来：两页的标题区一样高，那块内容在两页里就在同一高度上，换步时不用挪。
   */
  leadFloor?: ReactNode;
  /** 主列内容，超高时在这一块内滚动。 */
  children?: ReactNode;
  /** 底栏右侧的按钮，主按钮放最后。 */
  footer?: ReactNode;
  /** 底栏左侧，放幽灵按钮。 */
  footerStart?: ReactNode;
}

/** 主列里的一页：标题、说明、内容和底栏。放在 FrameShell 里，左栏与窗口按钮在那边。 */
export function Frame({ title, lead, leadFloor, children, footer, footerStart }: FrameProps) {
  return (
    <>
      <header className={styles.head}>
        <h1 className={styles.title}>{title}</h1>
        {lead !== undefined &&
          (leadFloor === undefined ? (
            <p className={styles.lead}>{lead}</p>
          ) : (
            <div className={styles.leadSlot}>
              <p className={styles.lead}>{lead}</p>
              <p className={styles.lead} data-floor="" aria-hidden="true">
                {leadFloor}
              </p>
            </div>
          ))}
      </header>
      <div className={styles.body} data-tauri-drag-region="false">
        {children}
      </div>
      {(footer !== undefined || footerStart !== undefined) && (
        <footer className={styles.footer}>
          <div className={styles.footerStart}>{footerStart}</div>
          <div className={styles.footerEnd}>{footer}</div>
        </footer>
      )}
    </>
  );
}
