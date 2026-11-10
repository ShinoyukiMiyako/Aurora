// 搜索框：固定前缀搜索图标、固定可清空。有内容时 Esc 清空并保持聚焦，没有内容时 Esc 照常交给 Esc 栈。
// 回车提交用 onEnter（发现页触发搜索）；本地过滤类搜索直接随 onChange 生效。
// 有对应的全局快捷键时传 shortcut，内容为空且未聚焦时在右侧显示键帽。
//
// Esc 栈在 window 捕获阶段先于输入框拿到 Esc：放在弹窗、浮层里的搜索框若只靠自己的 keydown，
// 按 Esc 会直接关掉整个弹窗。所以在浮层里且有内容、有焦点时临时登记一层，让清空排在弹窗关闭之前；
// 在页面里时栈本来为空，不登记，免得「有浮层打开」的判定被一个搜索框改写、全局快捷键失效。

import { AnimatePresence, motion } from "framer-motion";
import { useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { fade } from "../lib/motion";
import { isImeComposing } from "../lib/util";
import { useEscapeLayer } from "../shell/overlay";
import { KeyHint } from "./KeyHint";
import styles from "./SearchInput.module.css";
import { TextInput, type TextInputProps } from "./TextInput";

export const SEARCH_PLACEHOLDER = "搜索";

const OVERLAY_ROOT_SELECTOR = "[data-sk-overlay-root]";

/** aria-keyshortcuts 的键名按 UI Events 规范写全称：Ctrl 写作 Control。 */
function ariaKeyShortcuts(keys: readonly string[]): string {
  return keys.map((key) => (key === "Ctrl" ? "Control" : key)).join("+");
}

export interface SearchInputProps extends Omit<TextInputProps, "icon" | "clearable" | "type" | "suffix" | "trailing"> {
  /** 聚焦这个搜索框的全局快捷键，逐键给出：["Ctrl", "F"]。 */
  shortcut?: readonly string[];
}

export function SearchInput({ value, onChange, shortcut, placeholder = SEARCH_PLACEHOLDER, onFocus, onBlur, onKeyDown, ...rest }: SearchInputProps) {
  const [focused, setFocused] = useState(false);
  const [inOverlay, setInOverlay] = useState(false);

  useEscapeLayer(focused && inOverlay && value !== "", () => onChange(""), { kind: "popover" });

  const handleFocus = (event: ReactFocusEvent<HTMLInputElement>) => {
    setFocused(true);
    setInOverlay(event.currentTarget.closest(OVERLAY_ROOT_SELECTOR) !== null);
    onFocus?.(event);
  };

  const handleBlur = (event: ReactFocusEvent<HTMLInputElement>) => {
    setFocused(false);
    onBlur?.(event);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && value !== "" && !isImeComposing(event)) {
      event.preventDefault();
      onChange("");
    }
    onKeyDown?.(event);
  };

  return (
    <TextInput
      {...rest}
      type="text"
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      icon="search"
      clearable
      aria-keyshortcuts={shortcut === undefined ? undefined : ariaKeyShortcuts(shortcut)}
      trailing={
        // 聚焦、失焦时键帽只淡入淡出，与描边变色同节奏；退场即脱离布局，不挤同时弹入的清空键
        shortcut === undefined ? undefined : (
          <AnimatePresence initial={false} mode="popLayout">
            {value === "" && !focused && (
              <motion.span key="shortcut" className={styles.shortcut} initial={{ opacity: 0 }} animate={{ opacity: 1, transition: fade.in }} exit={{ opacity: 0, transition: fade.out }}>
                <KeyHint keys={shortcut} />
              </motion.span>
            )}
          </AnimatePresence>
        )
      }
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    />
  );
}
