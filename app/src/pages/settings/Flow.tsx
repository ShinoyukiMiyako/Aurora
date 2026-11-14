// 设置页里的竖排栈：直接子项变高变矮、出现消失（说明换行、联动出现的提示、晚到的数据）时，
// 排在后面的兄弟从旧位置滑到新位置，而不是一帧跳过去（lib/reflow）。变的那一块自己仍是一步到位的。

import type { ReactNode } from "react";
import { useReflow } from "../../lib/reflow";
import s from "./settings.module.css";

/** 一个分区里的卡片栈。 */
export function SectionFlow({ children }: { children: ReactNode }) {
  const reflow = useReflow<HTMLDivElement>();
  return (
    <div ref={reflow} className={s.sectionFlow}>
      {children}
    </div>
  );
}

/**
 * 卡片里卡头下面的一列设置行；排法与卡片自己相同，连续的设置行之间照常有分隔线。
 * 所在卡片要开 reflowEdge（ui/Card）：行变矮时下面的行还在往上滑，卡片外框一步收矮的话末行会先画到卡片外面。
 */
export function RowFlow({ children }: { children: ReactNode }) {
  const reflow = useReflow<HTMLDivElement>();
  return (
    <div ref={reflow} className={s.flow}>
      {children}
    </div>
  );
}
