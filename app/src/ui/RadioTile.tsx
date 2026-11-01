// 选项块组：每个选项需要一句说明的单选（下载源、启动后行为、版本隔离、安装方式）。
// 它是表单控件，不是卡片变体。1 到 3 列网格，compact 档最多 2 列；键盘行为与单选组一致。

import type { ReactNode } from "react";
import { Icon, type IconName } from "../art/Icon";
import { cssVars, cx } from "../lib/util";
import { assertRadioCount, useGroupName } from "./RadioGroup";
import styles from "./RadioTile.module.css";
import { useRovingGroup } from "./roving";

export interface RadioTileOption<T extends string> {
  value: T;
  title: ReactNode;
  description?: ReactNode;
  /** 等宽的单行附注（路径、地址），可选中复制。 */
  note?: string;
  icon?: IconName;
  disabled?: boolean;
}

export interface RadioTileProps<T extends string> {
  value: T | null;
  onChange: (value: T) => void;
  options: readonly RadioTileOption<T>[];
  /** 列数，默认取选项数与 3 的较小者；compact 档超过 2 列时按 2 列排。 */
  columns?: 1 | 2 | 3;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
  /**
   * 选项来自本机扫描这类运行时数据（默认 Java 列表里的每个运行时），个数由用户的机器决定，不是界面能定下的：
   * 不设 6 个的上限，下限照旧。界面自己列出的选项组不要开它，超过 6 个应改用 Select。
   */
  openEnded?: boolean;
}

export function RadioTile<T extends string>({ value, onChange, options, columns, ariaLabel, disabled = false, className, openEnded = false }: RadioTileProps<T>) {
  assertRadioCount("RadioTile", options.length, openEnded);
  const name = useGroupName("RadioTile", ariaLabel);
  const roving = useRovingGroup(options, value, onChange, disabled);
  const cols = columns ?? Math.min(options.length, 3);
  return (
    <div
      role="radiogroup"
      {...name}
      aria-disabled={disabled || undefined}
      className={cx(styles.grid, className)}
      data-columns={cols}
      style={cssVars({ "--tile-columns": cols })}
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
            disabled={disabled || option.disabled === true}
            tabIndex={roving.tabIndexOf(i)}
            className={styles.tile}
            onClick={() => {
              if (!checked) onChange(option.value);
            }}
          >
            <span className={styles.dot} />
            {option.icon !== undefined && (
              <span className={styles.iconBase}>
                <Icon name={option.icon} size={18} />
              </span>
            )}
            <span className={styles.text}>
              <span className={styles.title}>{option.title}</span>
              {option.description !== undefined && <span className={styles.description}>{option.description}</span>}
              {option.note !== undefined && <span className={styles.note}>{option.note}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
