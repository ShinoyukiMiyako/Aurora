import { cx } from "../../lib/util";
import type { PetalGlyphName, PetalTone } from "./petal-glyphs";
import styles from "./PetalGround.module.css";
import { PixelPetal } from "./PixelPetal";

export const PETAL_GROUND_WIDTH = 128;
export const PETAL_GROUND_HEIGHT = 24;
/** 投影椭圆的中心线；立绘底边与它对齐。 */
export const PETAL_GROUND_BASELINE = 16;

const PETALS: readonly { glyph: PetalGlyphName; tone: PetalTone; x: number; y: number }[] = [
  { glyph: "P4", tone: "light", x: 20, y: 10 },
  { glyph: "P5", tone: "mid", x: 42, y: 15 },
  { glyph: "P3", tone: "light", x: 66, y: 7 },
  { glyph: "P5", tone: "deep", x: 90, y: 14 },
  { glyph: "P4", tone: "mid", x: 102, y: 9 },
];

/** 花瓣地面：问候卡角色立绘脚下的投影与散落花瓣，静态，固定 128 × 24。 */
export function PetalGround({ className }: { className?: string }) {
  return (
    <svg
      className={cx(styles.ground, className)}
      width={PETAL_GROUND_WIDTH}
      height={PETAL_GROUND_HEIGHT}
      viewBox={`0 0 ${PETAL_GROUND_WIDTH} ${PETAL_GROUND_HEIGHT}`}
      aria-hidden="true"
      focusable="false"
    >
      <ellipse className={styles.shadow} cx={64} cy={PETAL_GROUND_BASELINE} rx={56} ry={7} />
      {PETALS.map((p) => (
        <PixelPetal key={`${p.x}-${p.y}`} glyph={p.glyph} tone={p.tone} x={p.x} y={p.y} />
      ))}
    </svg>
  );
}
