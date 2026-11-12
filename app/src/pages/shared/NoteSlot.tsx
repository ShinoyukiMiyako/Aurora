// 随选项换的多行说明（设置行的说明随分段选择、任务状态变化）：高度取全部候选里最高的那条，换说明时行高不变，
// 分段控件不在指针下跳，下面的行与卡片也不被推动。LabelSlot 是单行不折行的按钮文案，这里是会折行的正文。
//
// 备用的候选只画在伪元素里（attr 取值、visibility: hidden），不进文本内容与可访问名称：
// 读屏只读当前这条，按文字找说明的代码也只认当前这条。所以备用候选最多两条（::before 与 ::after）。
// current 为 null 表示此刻没有说明，照样按最高的候选占位。

import { useState } from "react";
import styles from "./NoteSlot.module.css";

/** 备用候选最多几条：只有 ::before 与 ::after 两个伪元素可用。 */
export const NOTE_SLOT_MAX_RESERVES = 2;

export interface NoteSlotProps {
  /** 现在显示的说明；null 表示不显示任何说明，仍按候选占位。不为 null 时必须在 options 里。 */
  current: string | null;
  /** 全部可能出现的说明。 */
  options: readonly string[];
  /** 当前说明是校验错误这类要用危险色的话时传 danger；不传沿用所在位置的字色。 */
  tone?: "danger";
}

export function NoteSlot({ current, options, tone }: NoteSlotProps) {
  const unique = [...new Set(options)];
  if (current !== null && !unique.includes(current)) throw new Error(`NoteSlot 当前说明「${current}」不在候选里：${unique.join(" / ")}`);
  const reserves = unique.filter((option) => option !== current);
  if (reserves.length > NOTE_SLOT_MAX_RESERVES) throw new Error(`NoteSlot 备用说明最多 ${NOTE_SLOT_MAX_RESERVES} 条，收到 ${reserves.length} 条`);
  // 挂载时就在的说明跟着所在页面的入场走；换过一次之后，每次换上来的说明淡入
  const [first] = useState(current);
  const [changed, setChanged] = useState(false);
  if (!changed && current !== first) setChanged(true);
  return (
    <span className={styles.slot} data-tone={tone} data-reserve-a={reserves[0]} data-reserve-b={reserves[1]}>
      {current !== null && (
        <span key={current} className={styles.current} data-enter={changed || undefined}>
          {current}
        </span>
      )}
    </span>
  );
}
