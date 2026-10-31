import { cssVars, cx } from "../../lib/util";
import styles from "./CoverPattern.module.css";
import { pickPetalTone, type PetalGlyphName, type PetalTone } from "./petal-glyphs";
import { PixelPetal } from "./PixelPetal";
import { fnv1a32, mulberry32 } from "./seed";

export interface CoverPetal {
  glyph: PetalGlyphName;
  tone: PetalTone;
  /** 左上角，底纹 viewBox（320 × 120）坐标。 */
  x: number;
  y: number;
}

const SCATTER_GLYPHS: readonly PetalGlyphName[] = ["P2", "P3", "P4", "P5"];

/**
 * 封面花瓣散布：以实例 id 为种子，字模固定 P2–P5 各一片，依次抽色调、x ∈ [16, 304)、y ∈ [8, 72)。
 * 同一实例在任何位置、任何一次启动散布完全相同。
 */
export function coverPetals(seed: string): CoverPetal[] {
  const random = mulberry32(fnv1a32(seed));
  return SCATTER_GLYPHS.map((glyph) => {
    const tone = pickPetalTone(random());
    const x = 16 + Math.floor(random() * 288);
    const y = 8 + Math.floor(random() * 64);
    return { glyph, tone, x, y };
  });
}

export interface CoverPatternProps {
  /** 远丘、近丘的色相。 */
  hue: number;
  /** 花瓣散布的种子，实例用实例 id。 */
  seed: string;
  className?: string;
}

/**
 * 实例封面底纹：远丘、近丘两层带色相的低饱和丘陵 + 4 片像素花瓣，叠在卡面底色之上。
 * 丘陵按底边对齐、等比铺满（slice）；花瓣按同一缩放换算位置，但像素单元固定 2 px，不随卡面缩放。
 */
export function CoverPattern({ hue, seed, className }: CoverPatternProps) {
  return (
    <div className={cx(styles.pattern, className)} style={cssVars({ "--hue": hue })} aria-hidden="true">
      <svg className={styles.hills} viewBox="0 0 320 120" preserveAspectRatio="xMidYMax slice" focusable="false">
        <path className={styles.far} d="M0 86C60 70 110 72 160 80C210 88 260 70 320 64V120H0Z" />
        <path className={styles.near} d="M0 104C70 92 130 96 200 102C250 106 290 98 320 94V120H0Z" />
      </svg>
      {coverPetals(seed).map((p) => (
        <PixelPetal key={p.glyph} className={styles.petal} glyph={p.glyph} tone={p.tone} style={cssVars({ "--px": p.x, "--py": p.y })} />
      ))}
    </div>
  );
}
