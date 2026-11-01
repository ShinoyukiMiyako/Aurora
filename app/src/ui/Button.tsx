// 按钮只有四种变体：主（每个视图至多 1 个）、次（默认）、幽灵、危险（每个视图至多 1 个）。
// 只有图标没有文字时用 IconButton；在多个互斥选项间切换用分段控件。

import type { ButtonHTMLAttributes, MouseEvent, MouseEventHandler, ReactNode, Ref } from "react";
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
   * 进行中：有前置图标时图标位换成加载指示，否则指示居中、文字保留占位，宽度不变。
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
      {icon !== undefined &&
        (loading ? <Spinner size={iconSize} tone={SPINNER_TONE[variant]} decorative /> : <Icon name={icon} size={iconSize} />)}
      <span className={styles.label}>{children}</span>
      {iconRight !== undefined && <Icon name={iconRight} size={iconSize} />}
      {loading && icon === undefined && (
        <span className={styles.centerSpinner}>
          <Spinner size={iconSize} tone={SPINNER_TONE[variant]} decorative />
        </span>
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
