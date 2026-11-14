// 按钮只有四种变体：主（每个视图至多 1 个）、次（默认）、幽灵、危险（每个视图至多 1 个）。
// 只有图标没有文字时用 IconButton；在多个互斥选项间切换用分段控件。

import { useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type MouseEvent, type MouseEventHandler, type ReactNode, type Ref } from "react";
import { Icon, type IconName, type IconSize } from "../art/Icon";
import { Spinner, type SpinnerTone } from "../art/Spinner";
import { fade, faceSwap, tweenAt, type SpringName } from "../lib/motion";
import { elapsedSeconds, playTrack, playTween, scaleTrack } from "../lib/slide";
import { cx } from "../lib/util";
import styles from "./Button.module.css";
import { Tooltip } from "./Tooltip";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ControlSize = "sm" | "md" | "lg";

/** 控件高度阶梯 30 / 36 / 44 对应的图标档。 */
export const CONTROL_ICON_SIZE = { sm: 16, md: 18, lg: 20 } as const satisfies Readonly<Record<ControlSize, IconSize>>;

/** 加载指示的颜色：强调实底上用强调实底的字色，危险实底上随按钮文字色，其余用强调色。 */
const SPINNER_TONE: Readonly<Record<ButtonVariant, SpinnerTone>> = { primary: "on-accent", secondary: "accent", ghost: "accent", danger: "current" };

/** 图标位里加载指示的身份，与图标名并列。 */
const SPINNER_GLYPH = "spinner";

/** 换上来的内容怎么入场：pop 从 0.6 弹出（换了个图标），tap 从 0.8 收拢（换成加载指示，动作已经开始，不该再抢眼）。 */
export type GlyphEnter = "pop" | "tap";

// 起点与同一格里换小控件（faceSwap）同一份，两边不各写一遍；弹簧按名字交给 scaleTrack，与 faceSwap 里展开的是同一条
const GLYPH_ENTER: Readonly<Record<GlyphEnter, { spring: SpringName; from: number }>> = {
  pop: { spring: "pop", from: faceSwap.pop.initial.scale },
  tap: { spring: "tap", from: faceSwap.tap.initial.scale },
};

export interface GlyphSlotProps {
  /** 当前内容的身份（图标名、加载指示）；null 为空着。只有它变了才算换内容，同一身份下内容的其他属性照常更新。 */
  glyph: string | null;
  enter?: GlyphEnter;
  /** 只用于定位。 */
  className?: string;
  /** 当前内容。 */
  children?: ReactNode;
}

interface GlyphLayer {
  glyph: string;
  /** 它换上来（或被接回）那一刻的内容：之后被换下时，退场层画的就是这份。 */
  node: ReactNode;
  key: number;
  /** 正在播的入场；播完、被换下或被接回的层为 null。 */
  enter: GlyphEnter | null;
}

interface GlyphState {
  current: GlyphLayer | null;
  /** 正在淡出的层。各层身份互不相同，也不与当前层相同：同一身份回来时接回原来那层，而不是再叠一层。 */
  leaving: readonly GlyphLayer[];
  swaps: number;
}

type Tween = typeof fade.in | typeof fade.out;

/** 一层正在播的透明度补间：被打断时按它算出此刻的透明度，从那里接着走。 */
interface GlyphFade {
  animation: Animation;
  from: number;
  to: number;
  tween: Tween;
}

const opacityOf = (f: GlyphFade) => f.from + (f.to - f.from) * tweenAt(f.tween, elapsedSeconds(f.animation));

function swapGlyph(state: GlyphState, glyph: string | null, node: ReactNode, enter: GlyphEnter): GlyphState {
  const swaps = state.swaps + 1;
  // 还在淡出的同一身份回来了（快速来回切换）：接回原来那层。DOM 节点不换，加载指示的旋转相位连续，也不会两枚叠着转
  const back = glyph === null ? undefined : state.leaving.find((layer) => layer.glyph === glyph);
  const leaving = state.leaving.filter((layer) => layer !== back);
  if (state.current !== null) leaving.push({ ...state.current, enter: null });
  const current = glyph === null ? null : back !== undefined ? { ...back, node } : { glyph, node, key: swaps, enter };
  return { current, leaving, swaps };
}

function layerElement(slot: HTMLElement, glyph: string): HTMLElement {
  for (const el of slot.children) if (el instanceof HTMLElement && el.dataset.glyph === glyph) return el;
  throw new Error(`图标位里找不到「${glyph}」这一层`);
}

/**
 * 图标位：换图标、图标与加载指示互换时，新内容在同一格里入场，旧内容原地淡出，按钮尺寸不变。
 * 挂载时就在的内容不播入场，跟着所在页面的入场走。
 *
 * 动画只在换内容的那一刻由 Web Animations 起，不挂 CSS 关键帧，也不用 motion 组件（列表每行都有图标按钮，
 * 没换过内容时它只是一层 span）。不用 CSS 关键帧是因为：
 * - 关键帧挂在属性上，所在子树从 display: none 变回可见（按档位隐藏的表格列）时会整段重播，换过的图标再弹一次；
 *   退场层的淡出也要等重新显示才开始，旧图标先闪出来。脚本起的动画不随显隐重启，隐藏期间照常播完、照常移除。
 * - 换关键帧只能从头播。这里记着每层透明度补间的起止，被打断时算出此刻的值，从那里接着淡出或淡回。
 * 退场层保留原来的 DOM 节点（key 不变），加载指示的旋转不从头开始；淡出结束后才移除。层按 key 排序渲染，节点从不移动。
 */
export function GlyphSlot({ glyph, enter = "pop", className, children }: GlyphSlotProps) {
  const [state, setState] = useState<GlyphState>(() => ({
    current: glyph === null ? null : { glyph, node: children, key: 0, enter: null },
    leaving: [],
    swaps: 0,
  }));
  if (glyph !== (state.current === null ? null : state.current.glyph)) setState(swapGlyph(state, glyph, children, enter));

  const root = useRef<HTMLSpanElement>(null);
  const [fades] = useState(() => new Map<number, GlyphFade>());
  // 上一次提交时的当前层：换内容之后据此分辨谁被换下、谁新换上、谁被接回
  const shown = useRef(state.current === null ? null : state.current.key);

  useLayoutEffect(() => {
    const was = shown.current;
    const current = state.current;
    const now = current === null ? null : current.key;
    if (was === now) return;
    shown.current = now;
    const slot = root.current;
    if (slot === null) throw new Error("图标位换了内容，却没有渲染出来");

    const drop = (key: number) => setState((s) => (s.leaving.some((layer) => layer.key === key) ? { ...s, leaving: s.leaving.filter((layer) => layer.key !== key) } : s));
    if (typeof slot.animate !== "function") {
      // 运行环境没有 Web Animations（组件测试的 jsdom）：直接到位，换下的层立即移除
      setState((s) => ({ ...s, current: s.current === null ? null : { ...s.current, enter: null }, leaving: [] }));
      return;
    }

    // resting：这一层没有在播透明度补间时的透明度
    const fadeTo = (layer: GlyphLayer, to: number, tween: Tween, resting: number, done: () => void) => {
      const running = fades.get(layer.key);
      const from = running === undefined ? resting : opacityOf(running);
      running?.animation.cancel();
      const animation = playTween(layerElement(slot, layer.glyph), [{ opacity: from }, { opacity: to }], tween);
      const record: GlyphFade = { animation, from, to, tween };
      fades.set(layer.key, record);
      animation.onfinish = () => {
        if (fades.get(layer.key) === record) fades.delete(layer.key);
        done();
      };
    };

    for (const layer of state.leaving) {
      if (layer.key === was) fadeTo(layer, 0, fade.out, 1, () => drop(layer.key));
      // 没提交过就被换下（并发渲染里一次提交前换了两回）：从没画出来，直接移除
      else if (!fades.has(layer.key)) drop(layer.key);
    }
    if (current === null) return;
    if (current.enter === null) {
      // 接回的层：从此刻的透明度淡回；它的淡出若已播完、还没来得及移除，就从 0 淡回
      fadeTo(current, 1, fade.in, 0, () => undefined);
      return;
    }
    const { spring, from } = GLYPH_ENTER[current.enter];
    const reduced = slot.ownerDocument.documentElement.hasAttribute("data-sk-reduced");
    // 入场播完就摘掉 data-enter：标记只表示「正在入场」，不留在元素上
    let pending = reduced ? 1 : 2;
    const settled = () => {
      pending -= 1;
      if (pending === 0) setState((s) => (s.current !== null && s.current.key === current.key && s.current.enter !== null ? { ...s, current: { ...s.current, enter: null } } : s));
    };
    // 减少动画：不缩放，只淡入
    if (!reduced) playTrack(layerElement(slot, current.glyph), scaleTrack(spring, from)).onfinish = settled;
    fadeTo(current, 1, fade.in, 0, settled);
  }, [state, fades]);

  const { current, leaving } = state;
  if (current === null && leaving.length === 0) return null;
  const layers = (current === null ? [...leaving] : [...leaving, current]).sort((a, b) => a.key - b.key);
  return (
    <span ref={root} className={cx(styles.glyphSlot, className)}>
      {layers.map((layer) =>
        layer === current ? (
          <span key={layer.key} className={styles.glyph} data-glyph={layer.glyph} data-enter={layer.enter === null ? undefined : layer.enter}>
            {children}
          </span>
        ) : (
          <span key={layer.key} className={styles.glyph} data-glyph={layer.glyph} data-leaving="">
            {layer.node}
          </span>
        ),
      )}
    </span>
  );
}

export interface SoftDisabledProps<E extends Element> {
  "aria-disabled": true | undefined;
  onClick: MouseEventHandler<E>;
}

/**
 * 不可用但保持可聚焦的按钮属性：aria-disabled 让读屏读出不可用，点击在这里挡掉。
 * 原生按钮的 Enter / 空格激活同样以 click 派发，一并挡住；submit 按钮同时挡住表单提交。
 * 不用原生 disabled：聚焦着的按钮一旦禁用，浏览器把焦点落回 body，键盘用户只能从文档开头重新找起。
 * 胶囊这类自绘按钮也经它，拦截只写这一处。
 */
export function softDisabledProps<E extends Element>(inert: boolean, onClick: MouseEventHandler<E> | undefined): SoftDisabledProps<E> {
  return {
    "aria-disabled": inert || undefined,
    onClick: (event: MouseEvent<E>) => {
      if (inert) {
        event.preventDefault();
        return;
      }
      onClick?.(event);
    },
  };
}

type NativeButton = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "type" | "disabled">;

export interface ButtonProps extends NativeButton {
  /** 随 rest 落到 button 元素上：相邻的控件消失时，调用方靠它把焦点交给这个按钮。 */
  ref?: Ref<HTMLButtonElement>;
  variant?: ButtonVariant;
  size?: ControlSize;
  /** 前置图标。 */
  icon?: IconName;
  /** 后置图标。 */
  iconRight?: IconName;
  /**
   * 后置图标翻转 180°：展开收起的箭头用同一个朝下的图标，展开时传 true 朝上，沿 settle 弹簧转过去，减少动画时直接到位。
   * 不要在页面样式里按按钮内部结构去转它（例如「按钮的直接子级 svg」）。
   */
  iconRightFlipped?: boolean;
  /**
   * 进行中：有前置图标时图标位交叉淡化成加载指示，否则指示叠在正中淡入、文字淡去但保留占位，宽度不变。
   * 加载期间要换文案的（「创建」换「正在创建…」），把文案放进 LabelSlot 列出两条，否则按钮会变宽变窄。
   * 不降低不透明度（与禁用区分）；保持可聚焦，点击与 Enter / 空格都无效（同 focusableWhenDisabled）。
   * 只在动作预计超过 300 ms 时使用。
   */
  loading?: boolean;
  disabled?: boolean;
  /**
   * 与 disabled 同用：不可用但保持可聚焦，用 aria-disabled 代替原生禁用，外观同禁用，点击与 Enter / 空格都无效。
   * 按钮可能在聚焦着时变成不可用（按下后动作进行中、挡住重复触发）就传它，免得焦点随原生禁用丢回 body。
   * 同时传 disabledReason 时照常挂原因提示。
   */
  focusableWhenDisabled?: boolean;
  /**
   * 禁用原因不显而易见时（例如「游戏运行中不能修改」）传它：按钮保持可聚焦，悬停与聚焦显示原因，点击无效。
   */
  disabledReason?: string;
  /** 撑满父容器宽度。 */
  block?: boolean;
  type?: "button" | "submit";
  children: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  iconRight,
  iconRightFlipped = false,
  loading = false,
  disabled = false,
  focusableWhenDisabled = false,
  disabledReason,
  block = false,
  type = "button",
  className,
  onClick,
  children,
  ...rest
}: ButtonProps) {
  const iconSize = CONTROL_ICON_SIZE[size];
  const spinner = <Spinner size={iconSize} tone={SPINNER_TONE[variant]} decorative />;
  // 不可用而保持可聚焦：带原因的禁用，或要求禁用时留住焦点；只传 disabled 时以原生禁用为准，原因也不显示
  const softDisabled = disabled ? focusableWhenDisabled : disabledReason !== undefined;
  const guard = softDisabledProps(loading || softDisabled, onClick);

  const button = (
    <button
      {...rest}
      type={type}
      className={cx(styles.button, className)}
      data-variant={variant}
      data-size={size}
      data-block={block || undefined}
      data-has-icon={icon !== undefined || undefined}
      data-icon-right-flipped={(iconRight !== undefined && iconRightFlipped) || undefined}
      data-loading={loading || undefined}
      data-disabled={softDisabled || undefined}
      disabled={disabled && !focusableWhenDisabled}
      aria-disabled={guard["aria-disabled"]}
      aria-busy={loading || undefined}
      onClick={guard.onClick}
    >
      {icon !== undefined && (
        <GlyphSlot glyph={loading ? SPINNER_GLYPH : icon} enter={loading ? "tap" : "pop"}>
          {loading ? spinner : <Icon name={icon} size={iconSize} />}
        </GlyphSlot>
      )}
      <span className={styles.label}>{children}</span>
      {iconRight !== undefined && <Icon name={iconRight} size={iconSize} className={styles.iconRight} />}
      {icon === undefined && (
        <GlyphSlot glyph={loading ? SPINNER_GLYPH : null} enter="tap" className={styles.centerSpinner}>
          {loading && spinner}
        </GlyphSlot>
      )}
    </button>
  );

  // 包裹层常驻：原因随状态来去时按钮不重挂，聚焦着的按钮不丢焦点
  const reason = softDisabled ? disabledReason : undefined;
  return (
    <Tooltip content={reason} disabled={reason === undefined}>
      {button}
    </Tooltip>
  );
}
