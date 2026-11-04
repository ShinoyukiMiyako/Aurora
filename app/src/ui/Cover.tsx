import { useReducedMotionConfig } from "framer-motion";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { coverRect, prepareDisplayCanvas, useDevicePixelRatio } from "../art/illustrations/canvas";
import { CoverPattern } from "../art/illustrations/CoverPattern";
import type { InstanceCover } from "../art/iso/covers";
import type { IsoWidth } from "../art/iso/geometry";
import { InstanceBlock } from "../art/iso/InstanceBlock";
import { TextureTile, useTextureTile } from "../art/iso/TextureTile";
import { cssVars, cx } from "../lib/util";
import styles from "./Cover.module.css";
import { useNearViewport, useRemoteImage } from "./remote-image";

/** 卡面右侧身份方块的宽度：W = 32 × floor(卡面高 × 0.5 / 32)，最小 32；方块宽度只有 32 / 64 / 96 / 128 四档。 */
export function coverIdentityWidth(height: number): IsoWidth {
  const steps = Math.floor((height * 0.5) / 32);
  return (32 * Math.min(4, Math.max(1, steps))) as IsoWidth;
}

/** 视差位移上限：指针在悬停宿主边缘时，平铺层朝反方向移动 8 px。 */
const PARALLAX_MAX_PX = 8;

/**
 * 平铺层向卡面四周多铺出的宽度。静止时不位移，模糊在画布边缘晕开的半透明边落在可见区外；对焦后模糊消失，
 * 最远位移 8 px 也还剩 4 px。用多铺而不是整体放大来遮边：放大会让 8 px 一格的像素被非整数倍重采样，对焦时就不锐利了。
 */
const TILE_OVERHANG_PX = 12;

/**
 * 远程图解码上限的分档步长（设备像素）。上限一变，取图钩子就丢掉旧位图重新解码，卡面先闪回平铺或渐变再淡入；
 * 按卡宽精确算时拖动窗口改宽逐帧都在闪。向上取整到档位，同一档内改宽只重画画布；一档 256 让多解出的边长不到 256，
 * 整页几十张图常驻也多不了多少内存。
 */
const DECODE_EDGE_STEP_PX = 256;

export interface CoverProps {
  /** 底色与底纹的色相：实例为封面色相，资源为资源色相。 */
  hue: number;
  /** 底纹花瓣散布的种子：实例用实例 id。 */
  seed: string;
  /** 卡面高度由页面给定；圆角由所在卡片的裁切负责，卡面自身不设圆角。 */
  height: number;
  /** 远程图（整合包封面、资讯头图、实例的玩家图片）；null 或缺省时不取图。加载中与失败时显示平铺或 art 形态。 */
  remoteUrl?: string | null;
  /** 材质平铺：给出时平铺这块方块的侧面材质，本机读不到材质时画 art 形态；与 remoteUrl 同时给出时以远程图为准。 */
  texture?: InstanceCover | null;
  /** 实例卡面右侧的身份方块；远程图显示时不画。 */
  identity?: { instanceId: string; cover: InstanceCover } | null;
  /** 远程图或材质平铺上放文字时的压暗区：下方 42% 或左侧 55%。 */
  shade?: "bottom" | "left" | null;
  /** 叠在卡面上的内容（标题等）。 */
  children?: ReactNode;
  className?: string;
}

/**
 * 卡面：卡片顶部或背景的视觉区，根上的 data-source 写明实际显示的形态（art / texture / remote），
 * 文字不放在卡面内部的调用方按它给文字换媒体色。
 * art 形态 = 色相渐变底 + 樱花底纹（+ 右侧实例方块）；texture 形态为封面方块的侧面材质平铺，静止时微糊；
 * remote 形态为远程图。texture 与 remote 都按媒体处理：媒体文字色，有文字的一侧加压暗。
 * 悬停（在可点宿主内）时底纹上浮 4 px、远程图放大 3%、平铺对焦清晰并随指针做视差。
 */
export function Cover({ hue, seed, height, remoteUrl = null, texture = null, identity = null, shade = null, children, className }: CoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dpr = useDevicePixelRatio();
  const near = useNearViewport(ref);
  const tile = useTextureTile(texture);
  const reduced = useReducedMotionConfig() === true;
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

  // 宽度量出来之前不加载：解码尺寸按卡面最长边 × dpr × 2 封顶，再向上取整到档位
  const maxEdge = Math.ceil((Math.max(width, height) * dpr * 2) / DECODE_EDGE_STEP_PX) * DECODE_EDGE_STEP_PX;
  const image = useRemoteImage(remoteUrl, near && width > 0, maxEdge);
  const remote = image.status === "ready";
  const textured = !remote && tile !== null;
  const media = remote || textured;

  useLayoutEffect(() => {
    if (image.status !== "ready" || width === 0) return;
    const canvas = canvasRef.current;
    if (!canvas) throw new Error("卡面的 <canvas> 尚未挂载");
    const ctx = prepareDisplayCanvas(canvas, width, height, dpr, true);
    const r = coverRect(image.bitmap.width, image.bitmap.height, canvas.width, canvas.height);
    ctx.drawImage(image.bitmap, r.sx, r.sy, r.sw, r.sh, 0, 0, canvas.width, canvas.height);
  }, [image, width, height, dpr]);

  // 减少动画时不跟指针：没有视差，平铺保持静止形态
  useEffect(() => {
    if (!textured || reduced) return;
    const el = ref.current;
    if (!el) throw new Error("卡面节点尚未挂载");
    return trackParallax(el);
  }, [textured, reduced]);

  return (
    <div
      ref={ref}
      className={cx(styles.cover, className)}
      style={{ height, ...cssVars({ "--hue": hue, "--tile-overhang": `${TILE_OVERHANG_PX}px` }) }}
      data-source={remote ? "remote" : textured ? "texture" : "art"}
      data-shade={media && shade !== null ? shade : undefined}
    >
      {remote ? (
        <div className={styles.media} aria-hidden="true">
          <canvas ref={canvasRef} className={styles.image} />
        </div>
      ) : tile !== null ? (
        <div className={styles.media} aria-hidden="true">
          {width > 0 && <TextureTile face={tile} width={width + 2 * TILE_OVERHANG_PX} height={height + 2 * TILE_OVERHANG_PX} className={styles.tile} />}
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

// ---------------------------------------------------------------- 视差

/** 悬停宿主：与悬停样式里的选择器一致。 */
const HOVER_HOST = 'a, button, [role="button"], [data-sk-hover-host]';

/*
 * 所有显示平铺的卡面共用文档上的一组指针监听，按帧结算一次，结果写成卡面根上的 --tile-x / --tile-y。
 * 不在挂载时找好宿主再挂到它身上：卡片要等卡内的标题按钮登记后才标成悬停宿主，晚于卡面的副作用，
 * 那时按 closest 找不到它；每帧按指针所在元素现找，宿主什么时候出现都对得上。
 */
const parallaxCovers = new Set<HTMLElement>();
let pointer: { x: number; y: number; target: Element } | null = null;
let frame = 0;

function trackParallax(cover: HTMLElement): () => void {
  if (parallaxCovers.size === 0) {
    document.addEventListener("pointermove", onPointer);
    // 指针不动而内容滚过去时没有 pointermove，换到新元素上会有 pointerover
    document.addEventListener("pointerover", onPointer);
    document.addEventListener("pointerout", onPointerOut);
  }
  parallaxCovers.add(cover);
  return () => {
    parallaxCovers.delete(cover);
    cover.style.removeProperty("--tile-x");
    cover.style.removeProperty("--tile-y");
    if (parallaxCovers.size > 0) return;
    document.removeEventListener("pointermove", onPointer);
    document.removeEventListener("pointerover", onPointer);
    document.removeEventListener("pointerout", onPointerOut);
    if (frame !== 0) cancelAnimationFrame(frame);
    frame = 0;
    pointer = null;
  };
}

function onPointer(event: PointerEvent): void {
  pointer = event.target instanceof Element ? { x: event.clientX, y: event.clientY, target: event.target } : null;
  if (frame === 0) frame = requestAnimationFrame(settleParallax);
}

function onPointerOut(event: PointerEvent): void {
  // 移出窗口：之后不会再有指针事件，在这里归位
  if (event.relatedTarget !== null) return;
  pointer = null;
  if (frame === 0) frame = requestAnimationFrame(settleParallax);
}

function settleParallax(): void {
  frame = 0;
  for (const cover of parallaxCovers) {
    const host = cover.closest(HOVER_HOST);
    if (pointer === null || host === null || !host.contains(pointer.target)) {
      writeShift(cover, 0, 0);
      continue;
    }
    const rect = host.getBoundingClientRect();
    writeShift(cover, parallaxShift(pointer.x, rect.left, rect.width), parallaxShift(pointer.y, rect.top, rect.height));
  }
}

/** 宿主中心为 0，指针越往一边，平铺层越往反方向移，到宿主边缘为上限；宿主在动时指针可能落在框外，按边缘算。 */
function parallaxShift(at: number, start: number, size: number): number {
  if (size <= 0) return 0;
  const t = Math.min(1, Math.max(-1, ((at - start) / size) * 2 - 1));
  return Math.round(-t * PARALLAX_MAX_PX * 100) / 100;
}

function writeShift(cover: HTMLElement, x: number, y: number): void {
  for (const [name, value] of [["--tile-x", `${x}px`], ["--tile-y", `${y}px`]] as const) {
    // 每帧都会结算到所有平铺卡面，值没变就不写，不让整页卡面跟着重算样式
    if (cover.style.getPropertyValue(name) !== value) cover.style.setProperty(name, value);
  }
}
