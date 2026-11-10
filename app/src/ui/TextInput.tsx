// 单行输入：文本、带单位的数字、路径、搜索（SearchInput 在此之上固定搜索图标与清空）。
// 结构是一个带描边的容器：[前缀图标] 输入区 [清空] [后缀单位]，点容器任意处都聚焦输入区。
// 名称由所在 Field 的标签或 aria-label 提供；回车回调在输入法组字期间不触发（组字时的回车属于输入法）。

import { AnimatePresence, motion, useReducedMotionConfig } from "framer-motion";
import { useRef, type InputHTMLAttributes, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref } from "react";
import { Icon, type IconName } from "../art/Icon";
import { popMark } from "../lib/motion";
import { useMounted } from "../lib/useMounted";
import { cx, isImeComposing } from "../lib/util";
import type { ControlSize } from "./Button";
import { mergeDescribedBy, useFieldControl } from "./Field";
import styles from "./TextInput.module.css";

export const CLEAR_LABEL = "清空";

/** 前缀图标随档位：sm、md 用 16，lg 用 20。 */
const PREFIX_ICON_SIZE = { sm: 16, md: 16, lg: 20 } as const satisfies Record<ControlSize, 16 | 20>;

type NativeInput = Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "value" | "onChange" | "prefix" | "type" | "children" | "className">;

export interface TextInputProps extends NativeInput {
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "password" | "url" | "email" | "number";
  size?: ControlSize;
  /** 前缀图标。 */
  icon?: IconName;
  /** 右侧单位或说明（「MB」「px」）。 */
  suffix?: ReactNode;
  /** 有内容时显示清空按钮。 */
  clearable?: boolean;
  /** 校验失败；在 Field 里时由 Field 的 error 决定，不必再传。 */
  invalid?: boolean;
  /** 回车（不在组字中）时调用：搜索提交、行内重命名确认。 */
  onEnter?: () => void;
  /**
   * 清空按钮之后、单位之前的附加内容（搜索框的快捷键提示）。会出没的内容自带退场时用 popLayout：
   * 描边容器是定位基准，退场项原地淡出，同一时刻出现的清空键直接落在最终位置。
   * 挂载时就在的不想单独入场，在元素自己身上写 initial={mounted.current ? 起点 : false}（lib/useMounted），
   * 不要在 AnimatePresence 上写 initial={false}：那会让它里面之后才挂载的元素也永远跳过入场。SearchInput 的键帽可作参照。
   */
  trailing?: ReactNode;
  /** 作用在描边容器上，用于布局（宽度、外边距）。 */
  className?: string;
  ref?: Ref<HTMLInputElement>;
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

export function TextInput({
  value,
  onChange,
  type = "text",
  size = "md",
  icon,
  suffix,
  clearable = false,
  invalid = false,
  onEnter,
  trailing,
  className,
  disabled = false,
  readOnly = false,
  id,
  onKeyDown,
  ref,
  ...rest
}: TextInputProps) {
  const field = useFieldControl();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isInvalid = invalid || (field !== null && field.invalid);
  const showClear = clearable && value !== "" && !disabled && !readOnly;
  // 挂载时就有内容的清空键跟着所在页面入场，不单独弹入。只在清空键自己身上关掉入场，不用 AnimatePresence 的
  // initial={false}：那会让清空键里之后才挂载的元素也永远跳过入场
  const mounted = useMounted();
  // 减少动画时缩放是一步到位的：清空键只淡入淡出
  const mark = useReducedMotionConfig() === true ? popMark.reduced : popMark.glyph;

  const focusInput = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || event.target === inputRef.current || (event.target as Element).closest("button")) return;
    // 不阻止的话按在容器空白处会先让输入框失焦再聚焦，光标位置与选区都会丢
    event.preventDefault();
    inputRef.current?.focus();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && onEnter && !isImeComposing(event)) onEnter();
    onKeyDown?.(event);
  };

  return (
    <div
      className={cx(styles.box, className)}
      data-size={size}
      data-invalid={isInvalid || undefined}
      data-disabled={disabled || undefined}
      data-readonly={readOnly || undefined}
      onPointerDown={focusInput}
    >
      {icon !== undefined && <Icon name={icon} size={PREFIX_ICON_SIZE[size]} className={styles.prefix} />}
      <input
        {...rest}
        ref={(el) => {
          inputRef.current = el;
          assignRef(ref, el);
        }}
        id={id ?? field?.controlId}
        type={type}
        className={styles.input}
        value={value}
        disabled={disabled}
        readOnly={readOnly}
        aria-invalid={isInvalid || undefined}
        aria-describedby={mergeDescribedBy(rest["aria-describedby"], field)}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      {/* 打出第一个字时弹入、清空时淡出；退场即脱离布局，同时出现的快捷键键帽不会先被挤到右边再跳回来 */}
      <AnimatePresence mode="popLayout">
        {showClear && (
          <motion.button
            key="clear"
            type="button"
            // 不进 Tab 顺序：键盘用户全选删除或在搜索框里按 Esc 即可清空，多一个停靠点只会拖慢工具条上的 Tab
            tabIndex={-1}
            className={styles.clear}
            aria-label={CLEAR_LABEL}
            initial={mounted.current ? mark.initial : false}
            animate={mark.animate}
            exit={mark.exit}
            onClick={() => {
              onChange("");
              inputRef.current?.focus();
            }}
          >
            <Icon name="x" size={14} />
          </motion.button>
        )}
      </AnimatePresence>
      {trailing}
      {suffix !== undefined && <span className={styles.suffix}>{suffix}</span>}
    </div>
  );
}
