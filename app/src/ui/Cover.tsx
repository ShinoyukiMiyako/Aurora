import { useReducedMotionConfig } from "framer-motion";
import { useEffect, useLayoutEffect, useRef, useState, type AnimationEvent, type ReactNode } from "react";
import { coverRect, prepareDisplayCanvas, useDevicePixelRatio } from "../art/illustrations/canvas";
import { CoverPattern } from "../art/illustrations/CoverPattern";
import type { InstanceCover } from "../art/iso/covers";
import type { IsoWidth } from "../art/iso/geometry";
import { InstanceBlock } from "../art/iso/InstanceBlock";
import { TextureTile, useTextureTile } from "../art/iso/TextureTile";
import { springAt } from "../lib/motion";
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
 *
 * 换形态：媒体晚到（art → texture、art / texture → remote）时旧的一层留在下面，新的一层连同压暗整层淡入盖上去，
 * 淡入播完才卸下旧层，身份方块随之淡出；不出现「先换成灰底加压暗、图再淡入」的中间态。
 * 首帧就有的形态（平铺材质已在缓存里）不播淡入，跟着所在页面的入场走。
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
    // 画第一帧之前就量出宽度：等 ResizeObserver 回报要晚一帧，材质已在缓存里的平铺也会先空一帧再淡入
    setWidth(el.clientWidth);
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
  const shown: CoverLayer = remote ? "remote" : textured ? "texture" : "art";

  // 换形态在渲染期同步记下：新的一层挂上的这一帧，旧的一层就得已经垫在下面。
  // 只有媒体晚到（形态往上换）才垫；往下换（远程图地址清空、平铺材质没了）直接换，没有可留的旧层。
  // 上一层还在淡入时又往上换（材质与远程图前后脚到）：它连同它下面的一起垫着，并且接着淡入，
  // 不能降成静止的下层，否则淡入动画随 data-reveal 摘掉，半透明的平铺一帧跳成不透明
  const [layers, setLayers] = useState<{ shown: CoverLayer; under: readonly CoverLayer[] }>({ shown, under: [] });
  let current = layers;
  if (layers.shown !== shown) {
    current = { shown, under: LAYER_RANK[shown] > LAYER_RANK[layers.shown] ? [...layers.under, layers.shown] : [] };
    setLayers(current);
  }
  const under = current.under;
  const settled = () => setLayers((l) => (l.under.length === 0 ? l : { ...l, under: [] }));

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

  /** 第 depth 层（0 是最底下）：盖在别的层上的都在淡入；只有最上面那层播完才算换完，一次卸下下面所有层。 */
  const layer = (kind: CoverLayer, depth: number) => {
    if (kind === "art") {
      return (
        <div key="art" className={styles.art} aria-hidden="true">
          <CoverPattern hue={hue} seed={seed} className={styles.pattern} />
        </div>
      );
    }
    // 淡入只认最上面那层自己的动画：中间那层先开始、先播完，卡内其他动画冒上来的 animationend 也不算
    const reveal = depth > 0;
    const onAnimationEnd =
      reveal && depth === under.length
        ? (event: AnimationEvent<HTMLDivElement>) => {
            if (event.target === event.currentTarget) settled();
          }
        : undefined;
    if (kind === "remote") {
      return (
        <div key="remote" className={styles.media} data-reveal={reveal || undefined} onAnimationEnd={onAnimationEnd} aria-hidden="true">
          <canvas ref={canvasRef} className={styles.image} />
        </div>
      );
    }
    // 平铺垫在远程图下面时 tile 一定还在（它只取决于 texture）；这里判空只为类型收窄
    if (tile === null) return null;
    return (
      <div key="texture" className={styles.media} data-reveal={reveal || undefined} onAnimationEnd={onAnimationEnd} aria-hidden="true">
        {width > 0 && <TextureTile face={tile} width={width + 2 * TILE_OVERHANG_PX} height={height + 2 * TILE_OVERHANG_PX} className={styles.tile} />}
      </div>
    );
  };

  return (
    <div
      ref={ref}
      className={cx(styles.cover, className)}
      style={{ height, ...cssVars({ "--hue": hue, "--tile-overhang": `${TILE_OVERHANG_PX}px` }) }}
      data-source={shown}
      data-shade={media && shade !== null ? shade : undefined}
    >
      {/* 各层放在同一个带 key 的数组里：往上换时已有的层原地留着，正在播的淡入不因节点重建而重播 */}
      {[...under, shown].map(layer)}
      {identity !== null && (!remote || under.length > 0) && (
        <span className={styles.identity} data-leaving={remote || undefined}>
          <InstanceBlock instanceId={identity.instanceId} cover={identity.cover} width={coverIdentityWidth(height)} lift />
        </span>
      )}
      {children !== undefined && <div className={styles.content}>{children}</div>}
    </div>
  );
}

/** 卡面的三种形态，按「晚到」的先后排：art 一开始就有，平铺要等材质，远程图要等下载解码。 */
type CoverLayer = "art" | "texture" | "remote";
const LAYER_RANK: Readonly<Record<CoverLayer, number>> = { art: 0, texture: 1, remote: 2 };

// ---------------------------------------------------------------- 视差

/** 悬停宿主：与悬停样式里的选择器一致。 */
const HOVER_HOST = 'a, button, [role="button"], [data-sk-hover-host]';

/*
 * 所有显示平铺的卡面共用文档上的一组指针监听与一条帧循环，结果写成卡面根上的 --tile-x / --tile-y。
 * 不在挂载时找好宿主再挂到它身上：卡片要等卡内的标题按钮登记后才标成悬停宿主，晚于卡面的副作用，
 * 那时按 closest 找不到它；每帧按指针所在元素现找，宿主什么时候出现都对得上。
 *
 * 平铺层沿 settle 弹簧追指针给出的目标：每帧按弹簧解析解推进一步，目标中途变了就带着当前速度转向。
 * 不用 CSS 过渡去追：每帧改一次目标，过渡就从零速重新起步，每帧只追上剩余距离的一小截，跟手发黏。
 * 帧循环只在有卡面还没停稳时跑，全部停稳就停。
 */
interface Drift {
  x: number;
  vx: number;
  y: number;
  vy: number;
}

const parallaxCovers = new Map<HTMLElement, Drift>();
let pointer: { x: number; y: number; target: Element } | null = null;
let frame = 0;
/** 上一帧的时间戳；帧循环停着时为 null，重新起步的第一帧按一帧的时长推进。 */
let lastFrameAt: number | null = null;

const FRAME_S = 1 / 60;
/** 离目标与速度都落到这以下就算停稳，直接落到目标上。 */
const REST_PX = 0.05;
const REST_PX_PER_S = 2;

function trackParallax(cover: HTMLElement): () => void {
  if (parallaxCovers.size === 0) {
    document.addEventListener("pointermove", onPointer);
    // 指针不动而内容滚过去时没有 pointermove，换到新元素上会有 pointerover
    document.addEventListener("pointerover", onPointer);
    document.addEventListener("pointerout", onPointerOut);
  }
  parallaxCovers.set(cover, { x: 0, vx: 0, y: 0, vy: 0 });
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
    lastFrameAt = null;
    pointer = null;
  };
}

function scheduleParallax(): void {
  if (frame === 0) frame = requestAnimationFrame(stepParallax);
}

function onPointer(event: PointerEvent): void {
  pointer = event.target instanceof Element ? { x: event.clientX, y: event.clientY, target: event.target } : null;
  scheduleParallax();
}

function onPointerOut(event: PointerEvent): void {
  // 移出窗口：之后不会再有指针事件，在这里归位
  if (event.relatedTarget !== null) return;
  pointer = null;
  scheduleParallax();
}

function stepParallax(now: number): void {
  frame = 0;
  const dt = lastFrameAt === null ? FRAME_S : Math.max(0, (now - lastFrameAt) / 1000);
  lastFrameAt = now;
  let moving = false;
  // 先把所有目标量完再逐个写：边量边写会让后面那张卡面的测量撞上前一张刚写的样式，每帧强制重排一次
  const targets = [...parallaxCovers.keys()].map(parallaxTarget);
  let i = 0;
  for (const [cover, drift] of parallaxCovers) {
    const target = targets[i++];
    const x = springAt("settle", drift.x - target.x, drift.vx, dt);
    const y = springAt("settle", drift.y - target.y, drift.vy, dt);
    const resting = Math.abs(x.x) < REST_PX && Math.abs(y.x) < REST_PX && Math.abs(x.v) < REST_PX_PER_S && Math.abs(y.v) < REST_PX_PER_S;
    drift.x = resting ? target.x : target.x + x.x;
    drift.vx = resting ? 0 : x.v;
    drift.y = resting ? target.y : target.y + y.x;
    drift.vy = resting ? 0 : y.v;
    if (!resting) moving = true;
    writeShift(cover, drift.x, drift.y);
  }
  if (moving) scheduleParallax();
  else lastFrameAt = null;
}

/** 指针此刻要平铺层去的位置：不在这张卡面的悬停宿主上时归位。 */
function parallaxTarget(cover: HTMLElement): { x: number; y: number } {
  const host = cover.closest(HOVER_HOST);
  if (pointer === null || host === null || !host.contains(pointer.target)) return { x: 0, y: 0 };
  const rect = host.getBoundingClientRect();
  return { x: parallaxShift(pointer.x, rect.left, rect.width), y: parallaxShift(pointer.y, rect.top, rect.height) };
}

/** 宿主中心为 0，指针越往一边，平铺层越往反方向移，到宿主边缘为上限；宿主在动时指针可能落在框外，按边缘算。 */
function parallaxShift(at: number, start: number, size: number): number {
  if (size <= 0) return 0;
  const t = Math.min(1, Math.max(-1, ((at - start) / size) * 2 - 1));
  return Math.round(-t * PARALLAX_MAX_PX * 100) / 100;
}

function writeShift(cover: HTMLElement, x: number, y: number): void {
  const px = (v: number) => `${Math.round(v * 100) / 100}px`;
  for (const [name, value] of [["--tile-x", px(x)], ["--tile-y", px(y)]] as const) {
    // 每帧都会结算到所有平铺卡面，值没变就不写，不让整页卡面跟着重算样式
    if (cover.style.getPropertyValue(name) !== value) cover.style.setProperty(name, value);
  }
}
