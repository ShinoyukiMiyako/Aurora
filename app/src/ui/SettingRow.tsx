// 设置行：左侧标题 + 说明，右侧控件。连续多行之间自动有分隔线。
// 纵向「标签 → 控件 → 提示」的表单项用 Field，不用它。

import { useId, type ReactNode } from "react";
import { cx } from "../lib/util";
import styles from "./SettingRow.module.css";

export interface SettingRowIds {
  /** 标题元素的 id：控件用 aria-labelledby 指向它，名称与可见标题一致。 */
  titleId: string;
  /** 说明元素的 id；没有说明时为 undefined。 */
  descriptionId: string | undefined;
}

export interface SettingRowProps {
  title: ReactNode;
  description?: ReactNode;
  /**
   * compact 档把控件折到说明下方并撑满整行：控件是滑杆、内存滑杆或撑满宽度的下拉时用，
   * 它们在 60% 宽的控件区里拖动精度不够。
   */
  stackOnCompact?: boolean;
  /** 控件；传函数时拿到标题与说明的 id，用来关联控件的名称与描述。 */
  children: ReactNode | ((ids: SettingRowIds) => ReactNode);
  className?: string;
}

export function SettingRow({ title, description, stackOnCompact = false, children, className }: SettingRowProps) {
  const id = useId();
  const ids: SettingRowIds = { titleId: `${id}-title`, descriptionId: description === undefined ? undefined : `${id}-desc` };
  return (
    <div className={cx(styles.row, className)} data-stack={stackOnCompact || undefined}>
      <div className={styles.text}>
        <span id={ids.titleId} className={styles.title}>
          {title}
        </span>
        {description !== undefined && (
          <span id={ids.descriptionId} className={styles.description}>
            {description}
          </span>
        )}
      </div>
      <div className={styles.control}>{typeof children === "function" ? children(ids) : children}</div>
    </div>
  );
}
