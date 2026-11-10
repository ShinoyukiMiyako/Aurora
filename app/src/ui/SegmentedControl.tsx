// 分段控件：同一视图内 2 到 6 个短选项的模式或筛选切换（加载器筛选、日志级别、内存「跟随全局 / 单独设置」）。
// 切换内容面板用标签页；值要提交才生效的用单选组。不允许横向滚动，compact 档放不下就该换下拉选择。
// 选中块在项之间滑动；同一个 layoutId 只在本实例内部使用，不会飞到别的分段控件上。

import { motion } from "framer-motion";
import { useId } from "react";
import { Icon, type IconName } from "../art/Icon";
import { springs } from "../lib/motion";
import { cssVars, cx } from "../lib/util";
import { assertRadioCount, useGroupName } from "./RadioGroup";
import { useRovingGroup } from "./roving";
import styles from "./SegmentedControl.module.css";

/** 加载器筛选每项文字前的识别色圆点。 */
export type SegmentDot = "vanilla" | "fabric" | "quilt" | "forge" | "neoforge";

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
  /**
   * 右侧计数（各加载器的实例数），并入项的名称朗读：「Fabric，3 个」。
   * null：计数还没到，先占住计数槽的宽度，数据到达时项不变宽、后面的项不被推开。
   */
  count?: number | null;
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
  /** 计数槽按几位数字定宽：位数在这以内变化时项不变宽。日志级别这类能到四位数的传 4。 */
  countDigits?: number;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
}

const ICON_SIZE = { sm: 14, md: 16 } as const;

/** 计数槽默认的定宽位数：实例数、任务数常见在两位以内。 */
export const SEGMENT_COUNT_DIGITS = 2;

/**
 * 选中块的圆角（与 --sk-r-xs 相同）。经 style 传给布局动画：在宽度不同的两项之间滑动时 framer-motion 用 scaleX 形变，
 * 只有 style 里的圆角会被逐帧反算校正，写在类里的会被拉成椭圆。
 */
export const SEGMENT_THUMB_RADIUS = 7;

export function SegmentedControl<T extends string>({ value, onChange, options, size = "md", block = false, countDigits = SEGMENT_COUNT_DIGITS, ariaLabel, disabled = false, className }: SegmentedControlProps<T>) {
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
      style={cssVars({ "--segment-count-digits": countDigits })}
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
            aria-label={option.count === undefined || option.count === null ? undefined : `${option.label}，${option.count} 个`}
            disabled={disabled || option.disabled === true}
            tabIndex={roving.tabIndexOf(i)}
            className={styles.item}
            onClick={() => {
              if (!checked) onChange(option.value);
            }}
          >
            {/* 依赖取选中值：控件只是重渲染（上方内容变高、计数变化）时不量布局，选中块随项一起到位，不从旧坐标滑过来 */}
            {checked && <motion.span layoutId={thumbId} layoutDependency={value} className={styles.thumb} style={{ borderRadius: SEGMENT_THUMB_RADIUS }} transition={springs.settle} />}
            <span className={styles.content}>
              {option.dot !== undefined && <span className={styles.dot} data-loader={option.dot} />}
              {option.icon !== undefined && <Icon name={option.icon} size={ICON_SIZE[size]} />}
              <span className={styles.label}>{option.label}</span>
              {option.count !== undefined && (
                <span className={styles.count} aria-hidden={option.count === null || undefined}>
                  {option.count}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
