// 数据块：卡片内的一组关键数字（游玩洞察、实例概览的累计时长、下载总量）。
// 本身无底色、无描边，必须放在卡片里，由 StatGrid 排成 2 或 4 列。
//
// 环比的方向与色调解耦：方向只决定图标，色调由调用方显式给出。
// 游玩时长下降不是坏事，不能按方向自动标红。

import { motion } from "framer-motion";
import { useState, type ReactNode } from "react";
import { Icon, type IconName } from "../art/Icon";
import { fade } from "../lib/motion";
import { cx } from "../lib/util";
import styles from "./StatTile.module.css";

export type DeltaDirection = "up" | "down" | "flat";
export type DeltaTone = "positive" | "negative" | "neutral";

const DELTA_ICON = { up: "arrow-up", down: "arrow-down", flat: "minus" } as const satisfies Readonly<Record<DeltaDirection, IconName>>;

export interface StatDelta {
  direction: DeltaDirection;
  /** 默认 neutral。 */
  tone?: DeltaTone;
  /** 可见的环比文字，同时并入读屏名称：「较前 7 天 +18%」。 */
  text: string;
}

export interface StatTileProps {
  label: string;
  icon?: IconName;
  /** 数值（不超过 6 个字符）或非数字值（「Fabric」「暂无」）。 */
  value: string;
  /** number 用大号等宽数字；text 用于非数字值，字号小一档。 */
  kind?: "number" | "text";
  unit?: string;
  /**
   * 环比行。undefined 表示没有这一行；null 表示这一行要等数据（还在检查更新）：先占住一行的高度，
   * 文字到了再淡入，一排数据块不因环比晚到而变高、把卡片下面的内容挤下去。
   */
  delta?: StatDelta | null;
  className?: string;
}

/** 读屏名称：「近 7 天 12.5 小时，较前 7 天 +18%」。环比还在等（null）时不念。 */
export function statLabel(label: string, value: string, unit: string | undefined, delta: StatDelta | null | undefined): string {
  const amount = unit === undefined ? value : `${value} ${unit}`;
  return delta === undefined || delta === null ? `${label} ${amount}` : `${label} ${amount}，${delta.text}`;
}

export function StatTile({ label, icon, value, kind = "number", unit, delta, className }: StatTileProps) {
  // 挂载时就有的环比跟着所在页面的入场走；占过位之后，文字每次到达都淡入。
  // reserved 只在占位显示时翻转，那时文字不在，换成 motion 元素不会让已显示的环比重挂
  const [reserved, setReserved] = useState(delta === null);
  if (delta === null && !reserved) setReserved(true);
  return (
    <div className={cx(styles.tile, className)} role="group" aria-label={statLabel(label, value, unit, delta)}>
      <span className={styles.label}>
        {icon !== undefined && <Icon name={icon} size={14} />}
        {label}
      </span>
      <span className={styles.value} data-kind={kind}>
        {value}
        {unit !== undefined && <span className={styles.unit}>{unit}</span>}
      </span>
      {delta === null ? (
        <span className={styles.delta} data-reserve="" aria-hidden="true" />
      ) : delta === undefined ? null : reserved ? (
        <motion.span
          className={styles.delta}
          data-direction={delta.direction}
          data-tone={delta.tone === undefined ? "neutral" : delta.tone}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: fade.in }}
        >
          <DeltaText delta={delta} />
        </motion.span>
      ) : (
        <span className={styles.delta} data-direction={delta.direction} data-tone={delta.tone === undefined ? "neutral" : delta.tone}>
          <DeltaText delta={delta} />
        </span>
      )}
    </div>
  );
}

function DeltaText({ delta }: { delta: StatDelta }) {
  return (
    <>
      <Icon name={DELTA_ICON[delta.direction]} size={12} />
      {delta.text}
    </>
  );
}

export interface StatGridProps {
  columns: 2 | 4;
  className?: string;
  children: ReactNode;
}

/** 数据块的排布：行距 14、列距 16。 */
export function StatGrid({ columns, className, children }: StatGridProps) {
  return (
    <div className={cx(styles.grid, className)} data-columns={columns}>
      {children}
    </div>
  );
}
