import { cx } from "../../lib/util";
import { ArtCrossfade } from "../illustrations/ArtCrossfade";
import { BitmapCanvas } from "../illustrations/BitmapCanvas";
import { useDevicePixelRatio } from "../illustrations/canvas";
import { accountHue } from "../illustrations/seed";
import styles from "./AccountFigure.module.css";
import { FIGURE_SIZE, type FigureScale, type SkinRef } from "./layout";
import { silhouetteFigureCanvas, skinFigureCanvas } from "./render";
import { useSkin } from "./useSkin";

export interface AccountFigureProps {
  uuid: string;
  skin: SkinRef | null;
  /** 每个皮肤像素的 CSS px：4 / 5 / 6，对应 64 × 128、80 × 160、96 × 192。 */
  scale: FigureScale;
  /** 单独出现时的可访问名称；不传则 aria-hidden。 */
  label?: string;
  className?: string;
}

/**
 * 角色正面立绘（头、身体、双臂、双腿，含外层）。只用于主页问候卡、账户页聚光卡与账户卡、离线账户弹窗。
 * 取不到皮肤时是同尺寸的剪影立绘，手臂宽按皮肤体型，没有皮肤信息时按宽体型。
 */
export function AccountFigure({ uuid, skin, scale, label, className }: AccountFigureProps) {
  const dpr = useDevicePixelRatio();
  const loaded = useSkin(skin);
  const width = FIGURE_SIZE.width * scale;
  const height = FIGURE_SIZE.height * scale;
  const canvas = (bitmap: CanvasImageSource) => <BitmapCanvas bitmap={bitmap} cssWidth={width} cssHeight={height} dpr={dpr} />;
  const model = skin === null ? "wide" : skin.model;
  return (
    <span
      className={cx(styles.figure, className)}
      style={{ width, height }}
      data-sk-art="skin"
      data-art={loaded ? "skin" : "silhouette"}
      role={label === undefined ? undefined : "img"}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
    >
      <ArtCrossfade fallback={canvas(silhouetteFigureCanvas(accountHue(uuid), model, scale, dpr))} real={loaded ? canvas(skinFigureCanvas(loaded, scale, dpr)) : null} />
    </span>
  );
}
