// 表单项：标签 → 控件 → 提示或错误（错误出现时替换提示）。纵向排布；「左说明、右控件」的设置项用设置行。
//
// 关联经上下文下发：放进来的输入框、下拉选择、开关等自动拿到 id（标签 for 指向它）、aria-describedby（提示与错误）
// 与 aria-invalid；单选组这类不可被 label 关联的控件用 labelId 做 aria-labelledby。
// 提示与错误共用一个常驻的 polite 播报区：先有播报区、后变内容，读屏才会念出新出现的错误。
// 播报区里的提示与错误是同一个 Appear 里互斥的两块：之后才出现的画出第一帧再淡入并从略小处落到位，换下去的抽出布局、
// 叠在换上来的那块上原地淡出（错误替换提示时提示不一帧消失），减少动画时只动透明度；挂载时就有的跟着所在页面或弹窗入场。

import { Fragment, createContext, useContext, useId, type ReactNode } from "react";
import { Icon } from "../art/Icon";
import { cx } from "../lib/util";
import { Appear } from "./Appear";
import styles from "./Field.module.css";

export interface FieldControl {
  /** 控件元素的 id，标签的 for 指向它。 */
  controlId: string;
  /** 标签元素的 id，供不能被 label 关联的控件（单选组、分段控件）做 aria-labelledby。 */
  labelId: string;
  /** 提示与错误所在元素的 id。 */
  describedBy: string;
  invalid: boolean;
}

const FieldContext = createContext<FieldControl | null>(null);

/** 控件读取所在 Field 的关联信息；不在 Field 里时为 null，控件须自带 aria-label。 */
export function useFieldControl(): FieldControl | null {
  return useContext(FieldContext);
}

/** 把调用方自己的 aria-describedby 与所在 Field 的合并。 */
export function mergeDescribedBy(own: string | undefined, field: FieldControl | null): string | undefined {
  const ids = [own, field?.describedBy].filter((id): id is string => id !== undefined && id !== "");
  return ids.length > 0 ? ids.join(" ") : undefined;
}

export const FIELD_OPTIONAL_SUFFIX = "（可选）";

export interface FieldProps {
  label: ReactNode;
  /** 标签后缀「（可选）」；必填项不加星号，默认即必填。 */
  optional?: boolean;
  hint?: ReactNode;
  /** 校验失败的原因；有值时替换提示，并让控件进入错误态。 */
  error?: string;
  /**
   * 提示行常驻占一行：没有提示、但会校验出错的字段，或提示随输入时有时无的字段用。
   * 错误或提示出现、消失时字段不变高，下面的内容不被挤开（错误长到折成两行时仍会多一行）。
   */
  reserve?: boolean;
  className?: string;
  children: ReactNode;
}

export function Field({ label, optional = false, hint, error, reserve = false, className, children }: FieldProps) {
  const base = useId();
  const invalid = error !== undefined && error !== "";
  const control: FieldControl = { controlId: `${base}-control`, labelId: `${base}-label`, describedBy: `${base}-message`, invalid };
  // 这几种值本来画不出任何节点：照样包进 Appear 会多出一层空的包裹，播报区不再 :empty，没有提示的字段平白多出上距
  const hinted = hint !== undefined && hint !== null && typeof hint !== "boolean" && hint !== "";
  return (
    <FieldContext.Provider value={control}>
      <div className={cx(styles.field, className)}>
        <label id={control.labelId} htmlFor={control.controlId} className={styles.label}>
          {label}
          {optional && <span className={styles.optional}>{FIELD_OPTIONAL_SUFFIX}</span>}
        </label>
        {children}
        <div id={control.describedBy} className={styles.message} data-error={invalid || undefined} data-reserve={reserve || undefined} aria-live="polite">
          {/* 两块的 key 固定：同一块里换字（换一条错误、提示随输入改说法）原地换，不退场重播 */}
          <Appear itemClassName={styles.item}>
            {invalid ? (
              <span key="error" className={styles.error}>
                <Icon name="alert" size={14} className={styles.errorIcon} />
                <span>{error}</span>
              </span>
            ) : (
              hinted && <Fragment key="hint">{hint}</Fragment>
            )}
          </Appear>
        </div>
      </div>
    </FieldContext.Provider>
  );
}
