import { memo, useLayoutEffect, useRef, type RefObject } from "react";
import { springAt } from "../../lib/motion";
import { elapsedSeconds, playTrack, springTrack } from "../../lib/slide";
import { cssVars, cx } from "../../lib/util";
import styles from "./CoverPattern.module.css";
import { pickPetalTone, type PetalGlyphName, type PetalTone } from "./petal-glyphs";
import { PixelPetal } from "./PixelPetal";
import { fnv1a32, mulberry32 } from "./seed";

export interface CoverPetal {
  glyph: PetalGlyphName;
  tone: PetalTone;
  /** 左上角，底纹 viewBox（320 × 120）坐标。 */
  x: number;
  y: number;
}

const SCATTER_GLYPHS: readonly PetalGlyphName[] = ["P2", "P3", "P4", "P5"];

/** 底纹 viewBox 的宽高，与丘陵的 viewBox、样式表里花瓣位置的换算是同一套。 */
const VIEW_WIDTH = 320;
const VIEW_HEIGHT = 120;

/**
 * 封面花瓣散布：以实例 id 为种子，字模固定 P2–P5 各一片，依次抽色调、x ∈ [16, 304)、y ∈ [8, 72)。
 * 同一实例在任何位置、任何一次启动散布完全相同。
 */
export function coverPetals(seed: string): CoverPetal[] {
  const random = mulberry32(fnv1a32(seed));
  return SCATTER_GLYPHS.map((glyph) => {
    const tone = pickPetalTone(random());
    const x = 16 + Math.floor(random() * 288);
    const y = 8 + Math.floor(random() * 64);
    return { glyph, tone, x, y };
  });
}

export interface CoverPatternProps {
  /** 远丘、近丘的色相。 */
  hue: number;
  /** 花瓣散布的种子，实例用实例 id。 */
  seed: string;
  className?: string;
}

/**
 * 实例封面底纹：远丘、近丘两层带色相的低饱和丘陵 + 4 片像素花瓣，叠在卡面底色之上。
 * 丘陵按底边对齐、等比铺满（slice）；花瓣按同一缩放换算位置，但像素单元固定 2 px，不随卡面缩放。
 * 种子变了（新建实例的预览卡以正在键入的名称为种子）花瓣从旧位置滑到新位置，见 useScatterDrift。
 *
 * 包 memo：卡面挂上时量出宽度、进入视口都要整张重渲染，属性却没变，不该跟着重建丘陵与四片花瓣。
 * 一屏常有十几张卡面同时挂上（新建实例的外观步、实例库），这几次重渲染落在同一帧里。
 */
export const CoverPattern = memo(function CoverPattern({ hue, seed, className }: CoverPatternProps) {
  const ref = useScatterDrift(seed);
  return (
    <div ref={ref} className={cx(styles.pattern, className)} style={cssVars({ "--hue": hue })} aria-hidden="true">
      <svg className={styles.hills} viewBox="0 0 320 120" preserveAspectRatio="xMidYMax slice" focusable="false">
        <path className={styles.far} d="M0 86C60 70 110 72 160 80C210 88 260 70 320 64V120H0Z" />
        <path className={styles.near} d="M0 104C70 92 130 96 200 102C250 106 290 98 320 94V120H0Z" />
      </svg>
      {coverPetals(seed).map((p) => (
        <span key={p.glyph} className={styles.lane} data-lane={p.glyph}>
          <PixelPetal className={styles.petal} glyph={p.glyph} tone={p.tone} style={cssVars({ "--px": p.x, "--py": p.y })} />
        </span>
      ))}
    </div>
  );
});

/** 一片花瓣这一段滑动：起点相对新位置的位移（px）与初速度（px/s）。途中再换种子时据此算出此刻的位置与速度。 */
interface Drift {
  animation: Animation;
  x0: number;
  vx: number;
  y0: number;
  vy: number;
}

/**
 * 种子变了：每片花瓣（按字模常驻）从旧位置沿 settle 弹簧滑到新位置，不在每敲一个字时瞬移。
 * 花瓣照旧由样式表按 left / top 摆，卡面改宽改高时直接到位、不起动画；滑动是另加在外层上的 translate 位移，
 * 交给合成线程播，只在种子变的那一刻量一次底纹尺寸。途中再变就带着此刻的位移与速度转向。
 * 减少动画、或运行环境没有 Web Animations 时直接到位，还在滑的也一并落到新位置。
 */
function useScatterDrift(seed: string): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null);
  const shown = useRef(seed);
  const drifts = useRef(new Map<PetalGlyphName, Drift>());
  useLayoutEffect(() => {
    const from = shown.current;
    shown.current = seed;
    if (from === seed) return;
    const root = ref.current;
    if (root === null) throw new Error("封面底纹尚未挂载");
    driftPetals(root, coverPetals(from), coverPetals(seed), drifts.current);
  }, [seed]);
  return ref;
}

function driftPetals(root: HTMLElement, from: readonly CoverPetal[], to: readonly CoverPetal[], drifts: Map<PetalGlyphName, Drift>): void {
  // 与样式表同一条换算：丘陵按 slice 等比铺满，viewBox 坐标乘缩放就是 CSS 像素。同一个尺寸下新旧位置只差坐标差乘缩放
  const scale = Math.max(root.clientWidth / VIEW_WIDTH, root.clientHeight / VIEW_HEIGHT);
  const reduced = root.ownerDocument.documentElement.hasAttribute("data-sk-reduced");
  const before = new Map(from.map((p) => [p.glyph, p]));
  for (const p of to) {
    const lane = root.querySelector<HTMLElement>(`[data-lane="${p.glyph}"]`);
    const was = before.get(p.glyph);
    if (lane === null || was === undefined) throw new Error(`封面底纹里找不到花瓣 ${p.glyph}`);
    const flying = drifts.get(p.glyph);
    drifts.delete(p.glyph);
    // 还在滑的：按弹簧解析解算出此刻的位移与速度，接着走
    const t = flying === undefined ? 0 : elapsedSeconds(flying.animation);
    const x = flying === undefined ? { x: 0, v: 0 } : springAt("settle", flying.x0, flying.vx, t);
    const y = flying === undefined ? { x: 0, v: 0 } : springAt("settle", flying.y0, flying.vy, t);
    flying?.animation.cancel();
    // 尺寸为 0（卡面还没排版、被折叠）时没有可滑的距离
    if (reduced || typeof lane.animate !== "function" || !(scale > 0)) continue;
    const x0 = x.x + (was.x - p.x) * scale;
    const y0 = y.x + (was.y - p.y) * scale;
    if (x0 === 0 && y0 === 0 && x.v === 0 && y.v === 0) continue;
    const animation = playTrack(lane, springTrack("settle", x0, x.v, y0, y.v));
    const drift: Drift = { animation, x0, vx: x.v, y0, vy: y.v };
    drifts.set(p.glyph, drift);
    animation.onfinish = () => {
      if (drifts.get(p.glyph) === drift) drifts.delete(p.glyph);
    };
  }
}
