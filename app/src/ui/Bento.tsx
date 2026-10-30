// 仪表盘型页面（主页、实例概览）的 12 列错落网格。列表型页面（实例库、发现结果）的网格不用它。
// 子元素只放 Card，跨列由 Card 的 span 按尺寸档给出。
// Bento 自己不参与页面入场，把序号转交给每张卡片：一级区块是卡片，不是网格。

import type { ReactNode } from "react";
import { cssVars, cx } from "../lib/util";
import styles from "./Bento.module.css";
import { numberEntrance, useEntranceIndex } from "./Page";

export interface BentoProps {
  /** 固定行高（px），配合 Card 的 rowSpan 做错落；不给则行高随内容。 */
  rowHeight?: number;
  /** 只用于布局。 */
  className?: string;
  children: ReactNode;
}

export function Bento({ rowHeight, className, children }: BentoProps) {
  if (rowHeight !== undefined && !(rowHeight > 0)) throw new Error(`Bento 行高必须为正数，收到 ${rowHeight}`);
  const start = useEntranceIndex();
  return (
    <div className={cx(styles.bento, className)} style={rowHeight === undefined ? undefined : cssVars({ "--bento-row": `${rowHeight}px` })} data-fixed-rows={rowHeight === undefined ? undefined : ""}>
      {numberEntrance(children, start)}
    </div>
  );
}
