// 单选组：2 到 6 个互斥的短选项，纵向或横向排列。每项需要一句说明时用选项块（RadioTile）；
// 工具条里的视图 / 筛选切换用分段控件；7 项以上用下拉选择。
// Tab 只进入已选项（没有已选项时进入第一项），方向键移动并选中。

import type { ReactNode } from "react";
import { cx } from "../lib/util";
import { useFieldControl } from "./Field";
import styles from "./RadioGroup.module.css";
import { useRovingGroup } from "./roving";

export interface RadioOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

/** 单选的选项数范围：少于 2 个不成选择，多于 6 个改用下拉选择。 */
export const RADIO_MIN_OPTIONS = 2;
export const RADIO_MAX_OPTIONS = 6;

export function assertRadioCount(component: string, count: number): void {
  if (count < RADIO_MIN_OPTIONS || count > RADIO_MAX_OPTIONS)
    throw new Error(`${component} 需要 ${RADIO_MIN_OPTIONS} 到 ${RADIO_MAX_OPTIONS} 个选项，收到 ${count} 个`);
}

/** 组名称：在 Field 里时指向 Field 的标签，否则必须有 ariaLabel。 */
export function useGroupName(component: string, ariaLabel: string | undefined): { "aria-label"?: string; "aria-labelledby"?: string } {
  const field = useFieldControl();
  if (ariaLabel !== undefined) return { "aria-label": ariaLabel };
  if (field !== null) return { "aria-labelledby": field.labelId };
  throw new Error(`${component} 必须放在 Field 里或传 ariaLabel`);
}

export interface RadioGroupProps<T extends string> {
  /** null：尚未选择。 */
  value: T | null;
  onChange: (value: T) => void;
  options: readonly RadioOption<T>[];
  orientation?: "vertical" | "horizontal";
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
}

export function RadioGroup<T extends string>({ value, onChange, options, orientation = "vertical", ariaLabel, disabled = false, className }: RadioGroupProps<T>) {
  assertRadioCount("RadioGroup", options.length);
  const name = useGroupName("RadioGroup", ariaLabel);
  const roving = useRovingGroup(options, value, onChange, disabled);
  return (
    <div role="radiogroup" {...name} aria-disabled={disabled || undefined} aria-orientation={orientation} className={cx(styles.group, className)} data-orientation={orientation} onKeyDown={roving.onKeyDown}>
      {options.map((option, i) => {
        const checked = option.value === value;
        const off = disabled || option.disabled === true;
        return (
          <button
            key={option.value}
            ref={roving.register(i)}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={off}
            tabIndex={roving.tabIndexOf(i)}
            className={styles.option}
            onClick={() => {
              if (!checked) onChange(option.value);
            }}
          >
            <span className={styles.dot} />
            <span className={styles.label}>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
