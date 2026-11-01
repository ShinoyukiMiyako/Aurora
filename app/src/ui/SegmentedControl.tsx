// 分段控件：同一视图内 2 到 6 个短选项的模式或筛选切换（加载器筛选、日志级别、内存「跟随全局 / 单独设置」）。
// 切换内容面板用标签页；值要提交才生效的用单选组。不允许横向滚动，compact 档放不下就该换下拉选择。
// 选中块在项之间滑动；同一个 layoutId 只在本实例内部使用，不会飞到别的分段控件上。

import { motion } from "framer-motion";
import { useId } from "react";
import { Icon, type IconName } from "../art/Icon";
import { springs } from "../lib/motion";
import { cx } from "../lib/util";
import { assertRadioCount, useGroupName } from "./RadioGroup";
import { useRovingGroup } from "./roving";
import styles from "./SegmentedControl.module.css";

/** 加载器筛选每项文字前的识别色圆点。 */
export type SegmentDot = "vanilla" | "fabric" | "quilt" | "forge" | "neoforge";

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
  /** 右侧计数（各加载器的实例数），并入项的名称朗读：「Fabric，3 个」。 */
  count?: number;
  dot?: SegmentDot;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: readonly SegmentOption<T>[];
  size?: "sm" | "md";
  /** 各项等宽撑满父容器。 */
  block?: boolean;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
}

const ICON_SIZE = { sm: 14, md: 16 } as const;

export function SegmentedControl<T extends string>({ value, onChange, options, size = "md", block = false, ariaLabel, disabled = false, className }: SegmentedControlProps<T>) {
  assertRadioCount("SegmentedControl", options.length);
  const name = useGroupName("SegmentedControl", ariaLabel);
  const roving = useRovingGroup(options, value, onChange, disabled);
  const thumbId = `${useId()}-thumb`;
  return (
    <div
      role="radiogroup"
      {...name}
      aria-disabled={disabled || undefined}
      className={cx(styles.group, className)}
      data-size={size}
      data-block={block || undefined}
      onKeyDown={roving.onKeyDown}
    >
      {options.map((option, i) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={roving.register(i)}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={option.count === undefined ? undefined : `${option.label}，${option.count} 个`}
            disabled={disabled || option.disabled === true}
            tabIndex={roving.tabIndexOf(i)}
            className={styles.item}
            onClick={() => {
              if (!checked) onChange(option.value);
            }}
          >
            {checked && <motion.span layoutId={thumbId} className={styles.thumb} transition={springs.settle} />}
            <span className={styles.content}>
              {option.dot !== undefined && <span className={styles.dot} data-loader={option.dot} />}
              {option.icon !== undefined && <Icon name={option.icon} size={ICON_SIZE[size]} />}
              <span className={styles.label}>{option.label}</span>
              {option.count !== undefined && <span className={styles.count}>{option.count}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
