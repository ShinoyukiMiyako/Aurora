import { cx } from "../../lib/util";
import { ArtCrossfade } from "../illustrations/ArtCrossfade";
import { BitmapCanvas } from "../illustrations/BitmapCanvas";
import { useDevicePixelRatio } from "../illustrations/canvas";
import { accountHue } from "../illustrations/seed";
import styles from "./AccountFigure.module.css";
import { FIGURE_FRAME, FIGURE_FRAME_PAD, FIGURE_SIZE, type FigureScale, type SkinRef } from "./layout";
import { silhouetteFigureCanvas, skinFigureCanvas } from "./render";
import { SpinningFigure } from "./SpinningFigure";
import { useSkin } from "./useSkin";

export interface AccountFigureProps {
  uuid: string;
  skin: SkinRef | null;
  /** 每个皮肤像素的 CSS px：4 / 5 / 6，布局方框对应 64 × 128、80 × 160、96 × 192。 */
  scale: FigureScale;
  /** 单独出现时的可访问名称；不传则 aria-hidden。 */
  label?: string;
  /** 真皮肤可以拖动转身。剪影是 2D 的，不响应。 */
  interactive?: boolean;
  className?: string;
}

/**
 * 角色立绘：皮肤盒子的 3D 正交投影，含外层。只用于主页问候卡、账户页聚光卡与账户卡、离线账户弹窗。
 * 取不到皮肤时是剪影立绘，手臂宽按皮肤体型，没有皮肤信息时按宽体型。换了皮肤时旧立绘留到新皮肤取到，两张交叉淡化。
 *
 * 根元素仍按 16 × 32 占位：底边是脚底基线，各处的脚下投影和页面布局都以它为准。
 * 投影比这个方框宽也比它高，画在四周外扩的外框里，外框不参与布局。
 */
export function AccountFigure({ uuid, skin, scale, label, interactive = false, className }: AccountFigureProps) {
  const dpr = useDevicePixelRatio();
  const shown = useSkin(skin);
  const frameWidth = FIGURE_FRAME.width * scale;
  const frameHeight = FIGURE_FRAME.height * scale;
  const pad = FIGURE_FRAME_PAD * scale;
  const canvas = (bitmap: CanvasImageSource) => <BitmapCanvas bitmap={bitmap} cssWidth={frameWidth} cssHeight={frameHeight} dpr={dpr} />;
  const model = skin === null ? "wide" : skin.model;
  const real = shown === null ? null : interactive ? <SpinningFigure skin={shown.skin} scale={scale} dpr={dpr} /> : canvas(skinFigureCanvas(shown.skin, scale, dpr));
  return (
    <span
      className={cx(styles.figure, className)}
      style={{ width: FIGURE_SIZE.width * scale, height: FIGURE_SIZE.height * scale }}
      data-sk-art="skin"
      data-art={shown ? "skin" : "silhouette"}
      role={label === undefined ? undefined : "img"}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
    >
      <span className={styles.frame} style={{ left: -pad, top: -pad, width: frameWidth, height: frameHeight }}>
        <ArtCrossfade fallback={canvas(silhouetteFigureCanvas(accountHue(uuid), model, scale, dpr))} real={real} realKey={shown === null ? undefined : shown.key} />
      </span>
    </span>
  );
}
