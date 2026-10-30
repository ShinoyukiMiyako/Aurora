import { cx } from "../lib/util";
import styles from "./KeyHint.module.css";

export interface KeyHintProps {
  /**
   * 组合键按顺序逐键给出，一键一帽，不写「+」：["Ctrl", "K"]。
   * 键名用 Ctrl、Shift、Alt、Enter、Esc、Tab、Space、Backspace、Delete、F1-F12、大写字母，方向键用 ↑ ↓ ← →。
   */
  keys: readonly string[];
  /** inverse：放在提示气泡里，透明底、描边与字随气泡反色。 */
  tone?: "default" | "inverse";
  className?: string;
}

/** 快捷键提示。被提示的目标控件应自带 aria-keyshortcuts。菜单项右侧的快捷键用纯文字，不用它。 */
export function KeyHint({ keys, tone = "default", className }: KeyHintProps) {
  if (keys.length === 0) throw new Error("KeyHint 至少需要一个键");
  return (
    <span className={cx(styles.combo, className)} data-tone={tone}>
      {keys.map((key, i) => (
        <kbd key={`${i}-${key}`} className={styles.key}>
          {key}
        </kbd>
      ))}
    </span>
  );
}
