// 樱花徽记与字标。徽记是五瓣樱花（每瓣带樱花特有的尖端缺刻），全部代码绘制，不使用任何商标图形。
// 徽记按显示尺寸分三种形态：≥ 28 完整形（渐变花瓣、花心、花蕊）；20-27 简化形（平涂花瓣、镂空花心）；
// 16 只用逐像素母版——矢量五瓣在 16 px 会糊成一团。17-19 px 与 16 px 以下没有可用形态，直接抛错。
// mono 是单色形：花瓣与镂空花心随 currentColor 走，加载图形用它，任何尺寸都画矢量（像素图旋转会抖）。

import { useId } from "react";
import { APP_NAME_EN } from "../lib/app-info";
import { cx } from "../lib/util";
import styles from "./Logo.module.css";

/** 一片花瓣：瓣根半径 1.2，瓣尖半径 13.6，缺刻底在半径 11.6。坐标原点为花心，第一瓣朝正上。 */
const PETAL = "M0 -1.2 C -4.4 -4.4 -6.4 -9.6 -3.6 -13.6 L 0 -11.6 L 3.6 -13.6 C 6.4 -9.6 4.4 -4.4 0 -1.2 Z";
const PETAL_ANGLES = [0, 72, 144, 216, 288] as const;
/** 花蕊落在两瓣之间。 */
const STAMEN_ANGLES = [36, 108, 180, 252, 324] as const;
const HEART_R = 2.6;

/**
 * 镂空花心的裁剪区：整块画布减去花心圆（evenodd）。不能把花心圆直接并进花瓣路径用 evenodd 挖洞：
 * 相邻花瓣在瓣根附近互相重叠，重叠区与花心区的奇偶计数会错，挖出的形状不是圆。
 */
const HEART_CUTOUT = `M-16 -16H16V16H-16Z M${-HEART_R} 0a${HEART_R} ${HEART_R} 0 1 0 ${2 * HEART_R} 0a${HEART_R} ${HEART_R} 0 1 0 ${-2 * HEART_R} 0Z`;

/** 16 px 像素母版：15 × 14 有效区，放在 16 × 16 画布的 (0, 1)。# 为强调色，o 为花心，. 透明。 */
const PIXEL_MASTER = [
  ".....##.##.....",
  ".....#####.....",
  ".....#####.....",
  ".##...###...##.",
  "####...#...####",
  "#####.....#####",
  ".####.ooo.####.",
  "..##.ooooo.##..",
  ".....ooooo.....",
  "....##.o.##....",
  "...###...###...",
  "..####...####..",
  "..####...####..",
  "..###.....###..",
] as const;

function pixelPath(cell: "#" | "o"): string {
  let d = "";
  PIXEL_MASTER.forEach((row, y) => {
    if (row.length !== 15) throw new Error(`徽记像素母版第 ${y + 1} 行宽度应为 15，实为 ${row.length}`);
    for (let x = 0; x < row.length; x++) if (row[x] === cell) d += `M${x} ${y + 1}h1v1h-1Z`;
  });
  return d;
}

const PIXEL_PETALS = pixelPath("#");
const PIXEL_HEART = pixelPath("o");

export type SakuraMarkForm = "full" | "simplified" | "pixel";

/** 按显示尺寸选形态；没有形态的尺寸抛错。 */
export function sakuraMarkForm(size: number): SakuraMarkForm {
  if (size === 16) return "pixel";
  if (size >= 20 && size <= 27) return "simplified";
  if (size >= 28) return "full";
  throw new Error(`樱花徽记没有 ${size} px 的形态：16 用像素母版，20-27 用简化形，28 起用完整形`);
}

/** useId 带冒号等符号，放进 url(#…) 前先洗成纯字母数字。 */
function useSvgId(prefix: string): string {
  return `${prefix}-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

export interface SakuraMarkProps {
  size: number;
  /** 单色形：填 currentColor，花心镂空，无花蕊、无渐变。 */
  mono?: boolean;
  className?: string;
}

export function SakuraMark({ size, mono = false, className }: SakuraMarkProps) {
  const id = useSvgId("sk-mark");
  const form = mono ? null : sakuraMarkForm(size);

  if (form === "pixel") {
    return (
      <svg className={cx(styles.mark, className)} width={16} height={16} viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden="true" focusable="false">
        <path className={styles.flat} d={PIXEL_PETALS} />
        <path className={styles.pixelHeart} d={PIXEL_HEART} />
      </svg>
    );
  }

  const petals = (fillClass: string | undefined, fill?: string) =>
    PETAL_ANGLES.map((angle) => <path key={angle} className={fillClass} d={PETAL} transform={`rotate(${angle})`} fill={fill} />);

  return (
    <svg className={cx(styles.mark, className)} width={size} height={size} viewBox="-16 -16 32 32" aria-hidden="true" focusable="false">
      <defs>
        {form === "full" ? (
          // 渐变定义在旋转之前、坐标取用户空间：五瓣共用一份，每瓣都从瓣尖浅到瓣根深。
          <linearGradient id={`${id}-g`} x1="0" y1="-14" x2="0" y2="4" gradientUnits="userSpaceOnUse">
            <stop offset="0" className={styles.stopTip} />
            <stop offset="1" className={styles.stopBase} />
          </linearGradient>
        ) : (
          <clipPath id={`${id}-c`}>
            <path d={HEART_CUTOUT} clipRule="evenodd" />
          </clipPath>
        )}
      </defs>
      {form === "full" ? (
        <>
          {petals(undefined, `url(#${id}-g)`)}
          <circle className={styles.heart} r={HEART_R} />
          {STAMEN_ANGLES.map((angle) => (
            <circle key={angle} className={styles.stamen} cx="0" cy="-4.2" r="0.9" transform={`rotate(${angle})`} />
          ))}
        </>
      ) : (
        <g clipPath={`url(#${id}-c)`}>{petals(mono ? styles.current : styles.flat)}</g>
      )}
    </svg>
  );
}

export type LogoSize = 20 | 28;

export interface LogoProps {
  /** 徽记边长：20 为 S 档（简化形），28 为 M 档（完整形）。 */
  size: LogoSize;
  className?: string;
}

/** 横排组合：徽记在左、字标在右，垂直中心对齐。字号 = round(徽记 × 0.68)，间距 = round(徽记 × 0.28)。 */
export function Logo({ size, className }: LogoProps) {
  return (
    <span className={cx(styles.logo, className)} style={{ gap: Math.round(size * 0.28) }}>
      <SakuraMark size={size} />
      <span className={styles.wordmark} style={{ fontSize: Math.round(size * 0.68) }}>
        {APP_NAME_EN}
      </span>
    </span>
  );
}
