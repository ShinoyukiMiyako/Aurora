import { cx } from "../../lib/util";
import { EMPTY_CATEGORIES, EMPTY_SCENES, emptyArtGeometry, sceneGlyphPath, type EmptyArtSize, type EmptyScene } from "./empty-art";
import styles from "./EmptyArt.module.css";
import { PixelPetal } from "./PixelPetal";

export interface EmptyArtProps {
  scene: EmptyScene;
  /** 画布边长：96 常规、64 compact；88 / 72 只用于崩溃诊断页头部。 */
  size: EmptyArtSize;
  className?: string;
}

/** 空状态图：纯装饰，永远 aria-hidden；含义由旁边的标题与正文给出。不使用任何原版材质。 */
export function EmptyArt({ scene, size, className }: EmptyArtProps) {
  const { category } = EMPTY_SCENES[scene];
  const petals = EMPTY_CATEGORIES[category];
  const g = emptyArtGeometry(size);
  return (
    <svg
      className={cx(styles.art, className)}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
      focusable="false"
      data-scene={scene}
      data-category={category}
    >
      <circle className={styles.base} cx={g.circle.cx} cy={g.circle.cy} r={g.circle.r} />
      <svg x={g.glyph.x} y={g.glyph.y} width={g.glyph.size} height={g.glyph.size} viewBox="0 0 24 24" overflow="visible">
        <path className={styles.glyph} d={sceneGlyphPath(scene)} strokeWidth={g.glyph.strokeWidth} />
      </svg>
      <PixelPetal glyph={petals.a.glyph} tone={petals.a.tone} x={g.petalA.x} y={g.petalA.y} />
      {petals.b && <PixelPetal glyph={petals.b.glyph} tone={petals.b.tone} x={g.petalB.x} y={g.petalB.y} />}
    </svg>
  );
}
