import type { CSSProperties } from "react";
import { cx } from "../../lib/util";
import { glyphPath, PETAL_CELL, PETAL_GLYPHS, PETAL_TONES, transformGlyph, type PetalGlyphName, type PetalTone, type QuarterTurn } from "./petal-glyphs";
import styles from "./PixelPetal.module.css";

export interface PixelPetalProps {
  glyph: PetalGlyphName;
  tone: PetalTone;
  mirror?: boolean;
  rotate?: QuarterTurn;
  /** 嵌在另一个 SVG 里时的左上角坐标（父 SVG 的用户单位，须与 CSS px 一比一）。 */
  x?: number;
  y?: number;
  className?: string;
  /** 放在 HTML 绝对定位层里时的位置。 */
  style?: CSSProperties;
}

/**
 * 静态像素花瓣：每种颜色一条由 1 × 1 方格组成的路径，viewBox 为字模尺寸，元素尺寸为字模 × 2 px，
 * crispEdges 让方格边缘落在设备像素上。颜色取花瓣五阶令牌，随明暗与强调色自动换色。
 */
export function PixelPetal({ glyph, tone, mirror = false, rotate = 0, x, y, className, style }: PixelPetalProps) {
  const shape = transformGlyph(PETAL_GLYPHS[glyph], mirror, rotate);
  const shades = PETAL_TONES[tone];
  return (
    <svg
      className={cx(styles.petal, className)}
      style={style}
      x={x}
      y={y}
      width={shape.width * PETAL_CELL}
      height={shape.height * PETAL_CELL}
      viewBox={`0 0 ${shape.width} ${shape.height}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
      data-glyph={glyph}
      data-tone={tone}
    >
      <path data-shade={shades.main} d={glyphPath(shape, 1)} />
      <path data-shade={shades.light} d={glyphPath(shape, 2)} />
      <path data-shade={shades.dark} d={glyphPath(shape, 3)} />
    </svg>
  );
}
