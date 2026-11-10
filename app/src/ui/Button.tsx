// 按钮只有四种变体：主（每个视图至多 1 个）、次（默认）、幽灵、危险（每个视图至多 1 个）。
// 只有图标没有文字时用 IconButton；在多个互斥选项间切换用分段控件。

import { useState, type ButtonHTMLAttributes, type MouseEvent, type MouseEventHandler, type ReactNode, type Ref } from "react";
import { Icon, type IconName, type IconSize } from "../art/Icon";
import { Spinner, type SpinnerTone } from "../art/Spinner";
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

export interface GlyphSlotProps {
  /** 当前内容的身份（图标名、加载指示）；null 为空着。只有它变了才算换内容，同一身份下内容的其他属性照常更新。 */
  glyph: string | null;
  enter?: GlyphEnter;
  /** 只用于定位。 */
  className?: string;
  /** 当前内容。 */
  children?: ReactNode;
}

interface GlyphShown {
  glyph: string;
  /** 它换上来那一刻的内容：之后被换下时，退场层画的就是这份。 */
  node: ReactNode;
  key: number;
}

/**
 * 图标位：换图标、图标与加载指示互换时，新内容在同一格里入场，旧内容原地淡出，按钮尺寸不变。
 * 用 CSS 动画而不是 motion 组件：列表每行都有图标按钮，没换过内容时它只是一层 span，不为此多付挂载代价。
 * 被换下的那层保留原来的 DOM 节点（key 不变），加载指示的旋转不会从头开始；它淡出结束后才移除。
 * 挂载时就在的内容不播入场，跟着所在页面的入场走。
 */
export function GlyphSlot({ glyph, enter = "pop", className, children }: GlyphSlotProps) {
  const [state, setState] = useState<{ current: GlyphShown | null; leaving: GlyphShown | null; swaps: number }>(() => ({
    current: glyph === null ? null : { glyph, node: children, key: 0 },
    leaving: null,
    swaps: 0,
  }));
  const shown = state.current === null ? null : state.current.glyph;
  if (glyph !== shown) {
    const swaps = state.swaps + 1;
    // 从空着换上来时，还在淡出的那层接着淡出
    setState({ current: glyph === null ? null : { glyph, node: children, key: swaps }, leaving: state.current === null ? state.leaving : state.current, swaps });
  }
  const { current, leaving } = state;
  if (current === null && leaving === null) return null;
  return (
    <span className={cx(styles.glyphSlot, className)}>
      {leaving !== null && (
        <span
          key={leaving.key}
          className={styles.glyph}
          data-glyph={leaving.glyph}
          data-leaving=""
          onAnimationEnd={(event) => {
            // 里面的加载指示自己也在跑动画，只认这一层的淡出
            if (event.target !== event.currentTarget) return;
            setState((s) => (s.leaving !== null && s.leaving.key === leaving.key ? { ...s, leaving: null } : s));
          }}
        >
          {leaving.node}
        </span>
      )}
      {current !== null && (
        <span key={current.key} className={styles.glyph} data-glyph={current.glyph} data-enter={current.key > 0 ? enter : undefined}>
          {children}
        </span>
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
      {iconRight !== undefined && <Icon name={iconRight} size={iconSize} />}
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
