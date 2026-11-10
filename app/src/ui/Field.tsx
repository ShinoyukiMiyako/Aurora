// 表单项：标签 → 控件 → 提示或错误（错误出现时替换提示）。纵向排布；「左说明、右控件」的设置项用设置行。
//
// 关联经上下文下发：放进来的输入框、下拉选择、开关等自动拿到 id（标签 for 指向它）、aria-describedby（提示与错误）
// 与 aria-invalid；单选组这类不可被 label 关联的控件用 labelId 做 aria-labelledby。
// 提示与错误共用一个常驻的 polite 播报区：先有播报区、后变内容，读屏才会念出新出现的错误。
// 之后才出现的错误按流内块的增删（insertItem）淡入并从略小处落到位，与 Appear 里的提示条、警告同一种出现方式；
// 挂载时就有的错误跟着所在页面或弹窗入场。

import { motion } from "framer-motion";
import { createContext, useContext, useId, type ReactNode } from "react";
import { Icon } from "../art/Icon";
import { insertItem } from "../lib/motion";
import { useMounted } from "../lib/useMounted";
import { cx } from "../lib/util";
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
  const mounted = useMounted();
  return (
    <FieldContext.Provider value={control}>
      <div className={cx(styles.field, className)}>
        <label id={control.labelId} htmlFor={control.controlId} className={styles.label}>
          {label}
          {optional && <span className={styles.optional}>{FIELD_OPTIONAL_SUFFIX}</span>}
        </label>
        {children}
        <div id={control.describedBy} className={styles.message} data-error={invalid || undefined} data-reserve={reserve || undefined} aria-live="polite">
          {invalid ? (
            <motion.span
              key="error"
              className={styles.error}
              initial={mounted.current ? insertItem.initial : false}
              animate={insertItem.animate}
            >
              <Icon name="alert" size={14} className={styles.errorIcon} />
              <span>{error}</span>
            </motion.span>
          ) : (
            hint
          )}
        </div>
      </div>
    </FieldContext.Provider>
  );
}
