// 花瓣徽记：应用内的品牌图形，按 petal-mark.json 逐格画出。五瓣的 SakuraMark 只留给加载图形与花枝插图。
// 像素画只有落在整数倍上才不糊，所以尺寸从设备像素算起：边长换成设备像素后挑放得下的最大版本，余量留白；
// 画布仍占满整个边长，换缩放比时布局不动。

import { useMemo } from "react";
import { cx } from "../lib/util";
import { BitmapCanvas } from "./illustrations/BitmapCanvas";
import { blankPixels, pixelsToCanvas, useDevicePixelRatio, type Pixels } from "./illustrations/canvas";
import type { Rgb } from "./illustrations/color";
import master from "./petal-mark.json";
import styles from "./PetalMark.module.css";

function hexToRgb(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

const PALETTE = new Map(Object.entries(master.palette).map(([cell, hex]) => [cell, hexToRgb(hex)]));
const TRANSPARENT_CELL = ".";

function cellColor(cell: string): Rgb {
  const rgb = PALETTE.get(cell);
  if (rgb === undefined) throw new Error(`花瓣母版里有调色板之外的格子「${cell}」`);
  return rgb;
}

export interface PetalRendition {
  grid: "grid16" | "grid12";
  /** 每格占几个设备像素。 */
  scale: number;
}

/**
 * 挑放得下的最大版本。可选边长是 16、24、32、48、64……：24 由 12 格母版的 2 倍给出，其余是主母版的整数倍。
 * 25-31 也用 24：主母版在这一段只有 1 倍，退回 16 会比占位小四成上下，125%、150% 缩放下 Logo 的徽记明显比字标小一圈。
 */
export function petalRendition(deviceSide: number): PetalRendition {
  if (deviceSide < 16) throw new Error(`花瓣徽记没有 ${deviceSide} 设备像素的版本：最小是主母版 1 倍的 16`);
  if (deviceSide < 24) return { grid: "grid16", scale: 1 };
  if (deviceSide < 32) return { grid: "grid12", scale: 2 };
  return { grid: "grid16", scale: Math.floor(deviceSide / 16) };
}

/** 生成 deviceSide × deviceSide 的位图：放大是整格复制，不产生调色板之外的颜色。 */
export function rasterizePetalMark(deviceSide: number): Pixels {
  const { grid, scale } = petalRendition(deviceSide);
  const rows = master[grid];
  const inset = Math.floor((deviceSide - rows.length * scale) / 2);
  const pixels = blankPixels(deviceSide, deviceSide);
  rows.forEach((row, gridY) => {
    for (let gridX = 0; gridX < row.length; gridX++) {
      if (row[gridX] === TRANSPARENT_CELL) continue;
      const [r, g, b] = cellColor(row[gridX]);
      const top = inset + gridY * scale;
      const left = inset + gridX * scale;
      for (let y = top; y < top + scale; y++) {
        for (let x = left; x < left + scale; x++) pixels.data.set([r, g, b, 255], (y * deviceSide + x) * 4);
      }
    }
  });
  return pixels;
}

export interface PetalMarkProps {
  /** 占位边长（CSS px），徽记在其中居中。 */
  size: number;
  className?: string;
}

export function PetalMark({ size, className }: PetalMarkProps) {
  const dpr = useDevicePixelRatio();
  const deviceSide = Math.round(size * dpr);
  const bitmap = useMemo(() => pixelsToCanvas(rasterizePetalMark(deviceSide)), [deviceSide]);
  // 自定义缩放下 size × dpr 可能乘不出整数，这时 CSS 边长要跟着位图取整，否则画布被贴到设备像素网格时会差出一行，位图被再缩放一次
  const cssSide = deviceSide / dpr;
  return <BitmapCanvas bitmap={bitmap} cssWidth={cssSide} cssHeight={cssSide} dpr={dpr} className={cx(styles.mark, className)} />;
}
