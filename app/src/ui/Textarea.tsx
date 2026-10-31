// 多行输入：JVM 参数、长描述。最小高 84、最大高 240，超出在内部滚动；只允许纵向拉伸。
// 关闭拼写检查：参数与路径里的英文会被标满红线。mono 用等宽字（JVM 参数、日志片段）。

import type { Ref, TextareaHTMLAttributes } from "react";
import { cx } from "../lib/util";
import { mergeDescribedBy, useFieldControl } from "./Field";
import styles from "./Textarea.module.css";

type NativeTextarea = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange" | "children">;

export interface TextareaProps extends NativeTextarea {
  value: string;
  onChange: (value: string) => void;
  mono?: boolean;
  invalid?: boolean;
  ref?: Ref<HTMLTextAreaElement>;
}

export function Textarea({ value, onChange, mono = false, invalid = false, className, id, ref, ...rest }: TextareaProps) {
  const field = useFieldControl();
  const isInvalid = invalid || (field !== null && field.invalid);
  return (
    <textarea
      spellCheck={false}
      {...rest}
      ref={ref}
      id={id ?? field?.controlId}
      className={cx(styles.textarea, className)}
      data-mono={mono || undefined}
      value={value}
      aria-invalid={isInvalid || undefined}
      aria-describedby={mergeDescribedBy(rest["aria-describedby"], field)}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
