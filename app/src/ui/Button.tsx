// 按钮只有四种变体：主（每个视图至多 1 个）、次（默认）、幽灵、危险（每个视图至多 1 个）。
// 只有图标没有文字时用 IconButton；在多个互斥选项间切换用分段控件。

import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from "react";
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

type NativeButton = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "type" | "disabled">;

export interface ButtonProps extends NativeButton {
  variant?: ButtonVariant;
  size?: ControlSize;
  /** 前置图标。 */
  icon?: IconName;
  /** 后置图标。 */
  iconRight?: IconName;
  /**
   * 进行中：有前置图标时图标位换成加载指示，否则指示居中、文字保留占位，宽度不变。
   * 不降低不透明度（与禁用区分），但不响应点击。只在动作预计超过 300 ms 时使用。
   */
  loading?: boolean;
  disabled?: boolean;
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
  disabledReason,
  block = false,
  type = "button",
  className,
  onClick,
  children,
  ...rest
}: ButtonProps) {
  const iconSize = CONTROL_ICON_SIZE[size];
  const softDisabled = disabledReason !== undefined && !disabled;
  const inert = loading || softDisabled;

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    // 加载中与带原因的禁用保持可聚焦，所以点击要在这里挡住；submit 按钮同时挡住表单提交
    if (inert) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };

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
      disabled={disabled}
      aria-disabled={inert || undefined}
      aria-busy={loading || undefined}
      onClick={handleClick}
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

  return softDisabled ? <Tooltip content={disabledReason}>{button}</Tooltip> : button;
}
