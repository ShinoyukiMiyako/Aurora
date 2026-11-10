// 会换的短文案：按钮标签（「检查更新」与「全部更新 · 3」）、状态词（「排队中」与「下载中」）。
// 把全部可能出现的文案叠在同一格里，宽度取最宽的那条，换文案时盒子不变宽，同一行的其他内容不被挤动。
// 文案里带数字时把最宽的情形也列进 options（例如按三位数给一条）。

import styles from "./LabelSlot.module.css";

export interface LabelSlotProps {
  /** 现在显示的文案，必须在 options 里。 */
  current: string;
  /** 全部可能出现的文案。 */
  options: readonly string[];
}

export function LabelSlot({ current, options }: LabelSlotProps) {
  if (!options.includes(current)) throw new Error(`LabelSlot 当前文案「${current}」不在候选里：${options.join("、")}`);
  return (
    <span className={styles.slot}>
      {[...new Set(options)].map((option) => (
        // 不显示的那几条是 visibility: hidden：不进可访问性树，读屏只读到当前这条
        <span key={option} className={styles.option} data-current={option === current || undefined}>
          {option}
        </span>
      ))}
    </span>
  );
}
