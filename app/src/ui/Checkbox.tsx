// 复选框：多选（表格批量选择、安装目标）、提交后才生效的布尔项、同意类确认。立即生效的设置用开关。
// checked 为 "mixed" 时显示半选（表头的「部分已选」），点击后变为全选。
// Space 切换；Enter 不切换（与原生复选框一致，表单里的 Enter 留给提交）。

import { AnimatePresence, motion } from "framer-motion";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { Icon } from "../art/Icon";
import { fade, springs } from "../lib/motion";
import { cx } from "../lib/util";
import styles from "./Checkbox.module.css";
import { mergeDescribedBy, useFieldControl } from "./Field";
import { Tooltip } from "./Tooltip";

export type CheckState = boolean | "mixed";

export interface CheckboxProps {
  checked: CheckState;
  onChange: (next: boolean) => void;
  label?: ReactNode;
  /** 没有可见标签时必填（表格行的选择框）。 */
  ariaLabel?: string;
  invalid?: boolean;
  disabled?: boolean;
  /** 禁用原因不显而易见时传它：保持可聚焦，悬停与聚焦显示原因，点击无效。 */
  disabledReason?: string;
  className?: string;
}

export function Checkbox({ checked, onChange, label, ariaLabel, invalid = false, disabled = false, disabledReason, className }: CheckboxProps) {
  const field = useFieldControl();
  if (label === undefined && ariaLabel === undefined && field === null) throw new Error("Checkbox 没有可见标签时必须传 ariaLabel");
  const softDisabled = disabledReason !== undefined && !disabled;
  const isInvalid = invalid || (field !== null && field.invalid);
  const glyph = checked === "mixed" ? "minus" : checked ? "check" : null;

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    // 按钮的 Enter 会合成一次点击，这里拦下
    if (event.key === "Enter") event.preventDefault();
  };

  const box = (
    <button
      type="button"
      role="checkbox"
      id={field?.controlId}
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-invalid={isInvalid || undefined}
      aria-describedby={mergeDescribedBy(undefined, field)}
      aria-disabled={softDisabled || undefined}
      disabled={disabled}
      className={cx(styles.root, className)}
      data-invalid={isInvalid || undefined}
      data-disabled={softDisabled || undefined}
      onKeyDown={onKeyDown}
      onClick={() => {
        if (!softDisabled) onChange(checked !== true);
      }}
    >
      <span className={styles.box}>
        <AnimatePresence initial={false}>
          {glyph !== null && (
            <motion.span
              key={glyph}
              className={styles.glyph}
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1, transition: { ...springs.pop, opacity: fade.in } }}
              exit={{ opacity: 0, transition: fade.out }}
            >
              <Icon name={glyph} size={14} />
            </motion.span>
          )}
        </AnimatePresence>
      </span>
      {label !== undefined && <span className={styles.label}>{label}</span>}
    </button>
  );

  return softDisabled ? <Tooltip content={disabledReason}>{box}</Tooltip> : box;
}
