// 空间受限处的单一动作（关闭、更多、复制、打开文件夹、行内移除、翻页）。
// label 必填，同时作为 aria-label 与悬停提示；旁边已有同义可见文字时用 tooltip={false} 关掉提示。

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "../art/Icon";
import { cx } from "../lib/util";
import { CONTROL_ICON_SIZE, GlyphSlot, softDisabledProps, type ControlSize } from "./Button";
import styles from "./IconButton.module.css";
import { Tooltip, type TooltipSide } from "./Tooltip";

export type IconButtonVariant = "ghost" | "secondary" | "danger";

type NativeButton = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "type" | "disabled" | "aria-label" | "aria-pressed">;

export interface IconButtonProps extends NativeButton {
  icon: IconName;
  label: string;
  variant?: IconButtonVariant;
  size?: ControlSize;
  /**
   * 切换型按钮的开关状态：传了即为切换型（输出 aria-pressed），true 时显示「开」态。
   * 触发菜单时不用它，把 aria-haspopup / aria-expanded / data-open 直接传进来，展开中同样显示「开」态。
   */
  pressed?: boolean;
  disabled?: boolean;
  /**
   * 与 disabled 同用，语义同 Button：不可用但保持可聚焦，用 aria-disabled 代替原生禁用，外观同禁用，点击与
   * Enter / 空格都无效。按钮可能在聚焦着时变成不可用（按下后动作进行中）就传它，免得焦点随原生禁用丢回 body。
   */
  focusableWhenDisabled?: boolean;
  /**
   * 禁用原因不显而易见时（例如「安装进行中，暂时不能打开」）传它，语义同 Button：按钮保持可聚焦，
   * 悬停与聚焦显示原因，点击无效。提示照常以 label 开头、原因写在第二行；tooltip={false} 时只写原因，
   * 否则原因无处可看。disabled 同时为真时以原生禁用为准。
   */
  disabledReason?: string;
  tooltip?: boolean;
  tooltipSide?: TooltipSide;
  /** 右上角角标（计数等），偏移 −4 / −4。 */
  badge?: ReactNode;
  type?: "button" | "submit";
}

export function IconButton({
  icon,
  label,
  variant = "ghost",
  size = "md",
  pressed,
  disabled = false,
  focusableWhenDisabled = false,
  disabledReason,
  tooltip = true,
  tooltipSide = "top",
  badge,
  type = "button",
  className,
  onClick,
  ...rest
}: IconButtonProps) {
  if (label.trim() === "") throw new Error("IconButton 的 label 不能为空：纯图标控件必须有可访问名称");
  if (variant === "danger" && pressed !== undefined) throw new Error("危险图标按钮没有切换态");
  if (disabledReason !== undefined && disabledReason.trim() === "") throw new Error(`IconButton「${label}」的 disabledReason 不能为空：说不出原因时用 disabled`);
  // 不可用而保持可聚焦：带原因的禁用，或要求禁用时留住焦点；只传 disabled 时以原生禁用为准，原因也不显示
  const softDisabled = disabled ? focusableWhenDisabled : disabledReason !== undefined;
  const guard = softDisabledProps(softDisabled, onClick);

  const button = (
    <button
      {...rest}
      type={type}
      className={cx(styles.button, className)}
      data-variant={variant}
      data-size={size}
      data-disabled={softDisabled || undefined}
      disabled={disabled && !focusableWhenDisabled}
      aria-label={label}
      aria-pressed={pressed}
      aria-disabled={softDisabled ? true : rest["aria-disabled"]}
      onClick={guard.onClick}
    >
      {/* 换图标（复制换成已复制、固定换成取消固定）时新图标弹出、旧图标淡出，不在同一帧硬切 */}
      <GlyphSlot glyph={icon}>
        <Icon name={icon} size={CONTROL_ICON_SIZE[size]} />
      </GlyphSlot>
      {badge !== undefined && <span className={styles.badge}>{badge}</span>}
    </button>
  );
  // 包裹层常驻：tooltip={false} 的按钮原因随状态来去时同样不重挂，聚焦着的按钮不丢焦点
  const reason = softDisabled ? disabledReason : undefined;
  return (
    <Tooltip content={tooltip ? label : reason} sub={tooltip ? reason : undefined} side={tooltipSide} wrap={reason !== undefined} disabled={!tooltip && reason === undefined}>
      {button}
    </Tooltip>
  );
}
