import { cx } from "../../lib/util";
import { ArtCrossfade } from "../illustrations/ArtCrossfade";
import { BitmapCanvas } from "../illustrations/BitmapCanvas";
import { useDevicePixelRatio } from "../illustrations/canvas";
import type { InstanceCover } from "./covers";
import { isoLayout, type IsoWidth } from "./geometry";
import styles from "./InstanceBlock.module.css";
import { blockBitmap, emblemBitmap } from "./render";
import { useBlockSource } from "./useBlockSource";

/** 不超过这个宽度的方块按小控件处理（头像、选择格），悬停上浮用 tap；更大的在卡面、头图上，随卡片用 settle。 */
const SMALL_BLOCK_MAX_WIDTH = 46;

export interface InstanceBlockProps {
  instanceId: string;
  cover: InstanceCover;
  /** 方块宽度 W；高度由投影决定（≈ 1.1124 W）。 */
  width: IsoWidth;
  /** 在可点宿主内悬停时上浮 2 px。 */
  lift?: boolean;
  className?: string;
}

/**
 * 实例的等距方块（无底座）：玩家图片或本机材质可读时画它（来源与回落顺序见 useBlockSource），否则是实例徽记，
 * 二者占完全相同的方框。
 * 材质晚到时交叉淡化，不发生布局位移。纯装饰，aria-hidden；可访问名称由宿主给出。
 */
export function InstanceBlock({ instanceId, cover, width, lift = false, className }: InstanceBlockProps) {
  const layout = isoLayout(width);
  const dpr = useDevicePixelRatio();
  const source = useBlockSource(cover);
  const real = source ? blockBitmap(source, layout, dpr) : null;
  const canvas = (bitmap: ImageBitmap) => <BitmapCanvas bitmap={bitmap} cssWidth={layout.width} cssHeight={layout.canvasHeight} dpr={dpr} />;

  return (
    <span
      className={cx(styles.block, lift && styles.lift, className)}
      style={{ width: layout.width, height: layout.canvasHeight }}
      data-sk-art="iso"
      data-art={real ? "texture" : "emblem"}
      data-large={width > SMALL_BLOCK_MAX_WIDTH || undefined}
      aria-hidden="true"
    >
      <ArtCrossfade fallback={canvas(emblemBitmap(instanceId, cover.hue, layout, dpr))} real={real ? canvas(real) : null} />
    </span>
  );
}
