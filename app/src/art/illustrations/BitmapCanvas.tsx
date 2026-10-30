import { useLayoutEffect, useRef } from "react";
import { prepareDisplayCanvas } from "./canvas";

export interface BitmapCanvasProps {
  /** 已按 CSS 尺寸 × dpr 生成好的位图；绘制时一比一贴上，不再缩放。 */
  bitmap: CanvasImageSource;
  cssWidth: number;
  cssHeight: number;
  dpr: number;
  className?: string;
}

/** 把预渲染的像素画贴进一张 CSS 尺寸固定的 <canvas>。纯装饰，aria-hidden。 */
export function BitmapCanvas({ bitmap, cssWidth, cssHeight, dpr, className }: BitmapCanvasProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) throw new Error("BitmapCanvas 的 <canvas> 尚未挂载");
    prepareDisplayCanvas(canvas, cssWidth, cssHeight, dpr, false).drawImage(bitmap, 0, 0);
  }, [bitmap, cssWidth, cssHeight, dpr]);
  return <canvas ref={ref} className={className} style={{ width: cssWidth, height: cssHeight }} aria-hidden="true" />;
}
