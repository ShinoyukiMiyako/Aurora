// 开关：立即生效的二元设置。需要点「保存」才生效的表单项用复选框。
// 受控：点击后由父组件立即改 checked，圆钮随之移动；背后的动作失败时父组件把 checked 退回，圆钮回到原位。
// 整行（轨道 + 文字）是一个按钮；放进设置行或表格时只有轨道，名称由 ariaLabel 提供。

import type { ReactNode } from "react";
import { cx } from "../lib/util";
import { useFieldControl } from "./Field";
import styles from "./Toggle.module.css";
import { Tooltip } from "./Tooltip";

export interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  /** 没有可见标签时必填。 */
  ariaLabel?: string;
  disabled?: boolean;
  /** 禁用原因不显而易见时传它：保持可聚焦，悬停与聚焦显示原因，点击无效。 */
  disabledReason?: string;
  className?: string;
  /**
   * 外面再包一层 Tooltip（Mod 列表的开关）时它经 cloneElement 写进来。根节点是内层的提示包裹，不往下交给开关按钮的话，
   * 外层气泡在无障碍树里与开关没有关联；交给按钮后由内层 Tooltip 与禁用原因的气泡 id 合并。
   */
  "aria-describedby"?: string;
}

export function Toggle({ checked, onChange, label, description, ariaLabel, disabled = false, disabledReason, className, "aria-describedby": describedBy }: ToggleProps) {
  const field = useFieldControl();
  if (label === undefined && ariaLabel === undefined && field === null) throw new Error("Toggle 没有可见标签时必须传 ariaLabel");
  const softDisabled = disabledReason !== undefined && !disabled;

  const toggle = (
    <button
      type="button"
      role="switch"
      id={field?.controlId}
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      aria-disabled={softDisabled || undefined}
      disabled={disabled}
      className={cx(styles.root, className)}
      data-disabled={softDisabled || undefined}
      onClick={() => {
        if (!softDisabled) onChange(!checked);
      }}
    >
      <span className={styles.track}>
        <span className={styles.thumb}>
          <span className={styles.knob} />
        </span>
      </span>
      {label !== undefined && (
        <span className={styles.text}>
          <span className={styles.label}>{label}</span>
          {description !== undefined && <span className={styles.description}>{description}</span>}
        </span>
      )}
    </button>
  );

  // 包裹层常驻：原因随状态来去时开关不重挂，聚焦着的开关不丢焦点
  return (
    <Tooltip content={disabledReason} disabled={!softDisabled}>
      {toggle}
    </Tooltip>
  );
}
