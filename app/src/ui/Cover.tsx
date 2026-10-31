import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { coverRect, prepareDisplayCanvas, useDevicePixelRatio } from "../art/illustrations/canvas";
import { CoverPattern } from "../art/illustrations/CoverPattern";
import type { InstanceCover } from "../art/iso/covers";
import type { IsoWidth } from "../art/iso/geometry";
import { InstanceBlock } from "../art/iso/InstanceBlock";
import { cssVars, cx } from "../lib/util";
import styles from "./Cover.module.css";
import { useNearViewport, useRemoteImage } from "./remote-image";

/** 卡面右侧身份方块的宽度：W = 32 × floor(卡面高 × 0.5 / 32)，最小 32；方块宽度只有 32 / 64 / 96 / 128 四档。 */
export function coverIdentityWidth(height: number): IsoWidth {
  const steps = Math.floor((height * 0.5) / 32);
  return (32 * Math.min(4, Math.max(1, steps))) as IsoWidth;
}

export interface CoverProps {
  /** 底色与底纹的色相：实例为封面色相，资源为资源色相。 */
  hue: number;
  /** 底纹花瓣散布的种子：实例用实例 id。 */
  seed: string;
  /** 卡面高度由页面给定；圆角由所在卡片的裁切负责，卡面自身不设圆角。 */
  height: number;
  /** 远程图（整合包封面、资讯头图）；null 或缺省为代码绘制的 art 形态。加载中与失败时显示 art 形态。 */
  remoteUrl?: string | null;
  /** 实例卡面右侧的身份方块。 */
  identity?: { instanceId: string; cover: InstanceCover } | null;
  /** 远程图上放文字时的压暗区：下方 42% 或左侧 55%。 */
  shade?: "bottom" | "left" | null;
  /** 叠在卡面上的内容（标题等）。 */
  children?: ReactNode;
  className?: string;
}

/**
 * 卡面：卡片顶部或背景的视觉区。art 形态 = 色相渐变底 + 樱花底纹（+ 右侧实例方块）；remote 形态为远程图，
 * 上面放文字时加压暗与媒体文字色。悬停（在可点宿主内）时底纹上浮 4 px、远程图放大 3%。不用模糊滤镜。
 */
export function Cover({ hue, seed, height, remoteUrl = null, identity = null, shade = null, children, className }: CoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dpr = useDevicePixelRatio();
  const near = useNearViewport(ref);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) throw new Error("卡面节点尚未挂载");
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 宽度量出来之前不加载：解码尺寸按卡面最长边 × dpr × 2 封顶
  const image = useRemoteImage(remoteUrl, near && width > 0, Math.ceil(Math.max(width, height) * dpr * 2));
  const remote = image.status === "ready";

  useLayoutEffect(() => {
    if (image.status !== "ready" || width === 0) return;
    const canvas = canvasRef.current;
    if (!canvas) throw new Error("卡面的 <canvas> 尚未挂载");
    const ctx = prepareDisplayCanvas(canvas, width, height, dpr, true);
    const r = coverRect(image.bitmap.width, image.bitmap.height, canvas.width, canvas.height);
    ctx.drawImage(image.bitmap, r.sx, r.sy, r.sw, r.sh, 0, 0, canvas.width, canvas.height);
  }, [image, width, height, dpr]);

  return (
    <div
      ref={ref}
      className={cx(styles.cover, className)}
      style={{ height, ...cssVars({ "--hue": hue }) }}
      data-source={remote ? "remote" : "art"}
      data-shade={remote && shade !== null ? shade : undefined}
    >
      {remote ? (
        <div className={styles.media} aria-hidden="true">
          <canvas ref={canvasRef} className={styles.image} />
        </div>
      ) : (
        <div className={styles.art} aria-hidden="true">
          <CoverPattern hue={hue} seed={seed} />
        </div>
      )}
      {!remote && identity !== null && (
        <span className={styles.identity}>
          <InstanceBlock instanceId={identity.instanceId} cover={identity.cover} width={coverIdentityWidth(height)} lift />
        </span>
      )}
      {children !== undefined && <div className={styles.content}>{children}</div>}
    </div>
  );
}
