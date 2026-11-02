import { useMemo } from "react";
import { cx } from "../../lib/util";
import { BitmapCanvas } from "./BitmapCanvas";
import { branchCell, paintBranch, rasterizeBranch } from "./branch-art";
import styles from "./BlossomBranch.module.css";
import { pixelsToCanvas, useDevicePixelRatio } from "./canvas";

export interface BlossomBranchProps {
  /** 插画框的 CSS 尺寸；构图按 meet 等比放进框内，主枝从左缘伸进来。 */
  width: number;
  height: number;
  /** 水平镜像：放在左侧时让枝条从画面外伸入。 */
  mirror?: boolean;
  /** 账户舞台底纹用半透明；头图与向导用不透明。 */
  dim?: boolean;
  className?: string;
}

/**
 * 花枝插画：全站唯一的大插画，静态，每屏最多一幅。像素画按设备像素现画：每格取整数个设备像素，
 * 画布只占整格覆盖到的部分（不足一格的余量留在右下），贴上去是一比一，不会被浏览器再缩放。
 */
export function BlossomBranch({ width, height, mirror = false, dim = false, className }: BlossomBranchProps) {
  if (!(width > 0 && height > 0)) throw new Error(`花枝插画尺寸必须为正：${width}x${height}`);
  const dpr = useDevicePixelRatio();
  const cellDevice = branchCell(dpr);
  const art = useMemo(() => paintBranch(width, height, cellDevice / dpr), [width, height, cellDevice, dpr]);
  const bitmap = useMemo(() => pixelsToCanvas(rasterizeBranch(art, cellDevice)), [art, cellDevice]);
  return (
    <div className={cx(styles.branch, className)} style={{ width, height }} aria-hidden="true" data-mirror={mirror || undefined} data-dim={dim || undefined}>
      <BitmapCanvas bitmap={bitmap} cssWidth={(art.cols * cellDevice) / dpr} cssHeight={(art.rows * cellDevice) / dpr} dpr={dpr} className={styles.art} />
    </div>
  );
}
