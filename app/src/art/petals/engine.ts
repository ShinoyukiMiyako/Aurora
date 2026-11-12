// 花瓣引擎：持有画布、模拟状态与帧循环，把外部条件（暂停、减少动画、档位、外观、尺寸）落成
// 「跑 rAF / 停 rAF / 画一帧静止画面」。React 组件只负责把这些条件喂进来（PetalCanvas.tsx）。
//
// 花瓣是全站唯一常驻的动画，所以停得比别处更彻底：暂停条件成立时取消 rAF，画布保留最后一帧；
// 减少动画或降到最低级时根本不启动 rAF，也不监听指针，只在尺寸或外观变化时重画一帧静态散落。
// 自动降级不是用户操作引起的，换档时画面不能跳：一级裁下的花瓣就地淡出，二级把正在飘的花瓣原地定格。

import { ambientFade, springAt, tweenAt } from "../../lib/motion";
import { PetalGovernor, type GovernorDowngrade } from "./governor";
import {
  EDGE_ON,
  LAYER_COUNTS,
  LAYERS,
  NIGHT_ALPHA,
  clampDt,
  countPetals,
  createLayers,
  freezeLayers,
  layerCounts,
  nextDrawAt,
  resizeLayers,
  scaleWidth,
  scatterStill,
  step,
  type Bounds,
  type FlipTurn,
  type Petal,
  type PetalLevel,
  type PetalTier,
  type Pointer,
  type Random,
  type StillPetal,
} from "./sim";
import { buildSprites, cellSize, readPetalPalette, type SpriteSheet } from "./sprites";

export type PetalMode = "day" | "night";

export interface PetalInputs {
  /** 外壳汇总的暂停条件：页面不可见、窗口失焦、窗口最小化、带遮罩的浮层打开。 */
  paused: boolean;
  /** 减少动画的生效值（应用设置或系统偏好任一开启）。 */
  reduced: boolean;
  tier: PetalTier;
  mode: PetalMode;
  /** 强调色名：只用来判断要不要按新令牌重建精灵。 */
  accent: string;
}

export interface PetalDowngrade {
  tier: PetalTier;
  level: 1 | 2;
  windowMediansMs: readonly number[];
}

export interface PetalStats {
  /** 花瓣飘落的 rAF 循环是否在跑（定格后补投花瓣淡入、窄花瓣转向的那一小段收尾不算）。 */
  running: boolean;
  level: PetalLevel;
  /** 当前参与绘制的花瓣数。 */
  count: number;
  /** 最近至多 600 帧「模拟 + 绘制」的平均耗时；还没有跑过帧时为 null。 */
  avgFrameMs: number | null;
  /** 最近一个已结束的降级窗口的绘制间隔中位数；还没有窗口结束时为 null。 */
  drawIntervalMedianMs: number | null;
}

export interface FrameScheduler {
  request(callback: FrameRequestCallback): number;
  cancel(id: number): void;
}

export interface PetalEngineOptions {
  canvas: HTMLCanvasElement;
  /** 指针来源：花瓣层的父元素（内容区）。指针在卡片上方时照样推开卡片下面的花瓣。 */
  host: HTMLElement;
  inputs: PetalInputs;
  onDowngrade(event: PetalDowngrade): void;
  random: Random;
  scheduler?: FrameScheduler;
  clock?: () => number;
}

/** 后备缓冲上限 400 万像素：超大窗口降低有效像素比，换取稳定的填充开销。 */
export const MAX_BACKING_PIXELS = 4_000_000;
export const MAX_DPR = 2;
/** 静态散落在尺寸变化时防抖：拖动窗口边缘期间不反复重画。 */
export const STILL_RESIZE_DEBOUNCE_MS = 100;
export const FRAME_COST_SAMPLES = 600;

export function effectiveDpr(dpr: number, cssWidth: number, cssHeight: number): number {
  return Math.min(dpr, MAX_DPR, Math.sqrt(MAX_BACKING_PIXELS / (cssWidth * cssHeight)));
}

const animationFrames: FrameScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (id) => cancelAnimationFrame(id),
};

/** 当前存活的引擎，按创建顺序；开发诊断读最后一个。 */
const live: PetalEngine[] = [];

/** 最近创建且仍存活的花瓣引擎的统计；没有挂载花瓣层时为 null。 */
export function currentPetalStats(): PetalStats | null {
  const engine = live[live.length - 1];
  return engine === undefined ? null : engine.stats();
}

export class PetalEngine {
  private readonly canvas: HTMLCanvasElement;
  private readonly host: HTMLElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly onDowngrade: (event: PetalDowngrade) => void;
  private readonly random: Random;
  private readonly scheduler: FrameScheduler;
  private readonly clock: () => number;
  private readonly governor = new PetalGovernor();

  private inputs: PetalInputs;
  /** 最近一次非零的画布 CSS 尺寸；画布被折叠成 0 时保留，恢复时据此按比例缩放。 */
  private bounds: Bounds | null = null;
  private hasArea = false;
  private origin = { left: 0, top: 0 };
  private dprEff = 1;
  private sprites: SpriteSheet | null = null;
  private spriteKey = "";
  private layers: Petal[][] | null = null;
  /** 一级降级裁下的花瓣（按层）：照常飘着淡出，淡完才丢。since 是开始淡出时的模拟时钟。 */
  private leaving: { layers: Petal[][]; since: number } | null = null;
  private still: StillPetal[][] | null = null;
  /**
   * 二级降级定格后的收尾：petals 是补投的静态花瓣，按环境层的淡入曲线浮现；turning 是定格时比静态散落下限还窄、
   * 被夹到下限的几片，沿 settle 弹簧从定格姿态转过去。静态散落本不跑帧回调，只在这一小段逐帧重画，淡完就停：
   * settle 弹簧在淡入的 480 ms 里早已落定，到时直接按夹过的 sx 画不会跳。
   * t 是收尾已经播了的秒数，从定格那一拍起算：那一拍已按 t = 0 画过定格姿态，下一帧就该按帧间隔往前走，
   * 窄花瓣才是带着翻面速度接上的，而不是先停一帧。last 是上一次推进 t 的帧时间；暂停时清空，暂停期间不计时，
   * 恢复后的第一帧只记下帧时间、按停下时的姿态再画一次。
   */
  private arriving: { petals: ReadonlySet<StillPetal>; turning: ReadonlyMap<StillPetal, FlipTurn>; t: number; last: number | null } | null = null;
  private arrivalRaf: number | null = null;
  private simT = 0;
  private last: number | null = null;
  /** 下一拍的时刻；负无穷表示还没起拍，下一帧必画。 */
  private drawDue = Number.NEGATIVE_INFINITY;
  private raf: number | null = null;
  private pointer: Pointer | null = null;
  private listening = false;
  private pendingSize: { width: number; height: number; dpr: number } | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly costs = new Float64Array(FRAME_COST_SAMPLES);
  private costCount = 0;
  private costNext = 0;
  private costSum = 0;
  private destroyed = false;

  constructor(options: PetalEngineOptions) {
    const ctx = options.canvas.getContext("2d");
    if (!ctx) throw new Error("花瓣画布拿不到 Canvas 2D 上下文");
    this.canvas = options.canvas;
    this.host = options.host;
    this.ctx = ctx;
    this.inputs = options.inputs;
    this.onDowngrade = options.onDowngrade;
    this.random = options.random;
    this.scheduler = options.scheduler ?? animationFrames;
    this.clock = options.clock ?? (() => performance.now());
    live.push(this);
  }

  /** 读画布矩形与设备像素比。挂载、ResizeObserver 回调与像素比变化时调用；指针换算用的矩形只在这里刷新。 */
  measure(): void {
    if (this.destroyed) return;
    const rect = this.canvas.getBoundingClientRect();
    this.origin = { left: rect.left, top: rect.top };
    const size = { width: rect.width, height: rect.height, dpr: window.devicePixelRatio };
    if (this.isStill() && this.bounds !== null) {
      this.pendingSize = size;
      if (this.pendingTimer !== null) clearTimeout(this.pendingTimer);
      this.pendingTimer = setTimeout(() => this.flushPendingSize(), STILL_RESIZE_DEBOUNCE_MS);
      return;
    }
    this.applySize(size.width, size.height, size.dpr);
  }

  update(next: PetalInputs): void {
    if (this.destroyed) return;
    const prev = this.inputs;
    this.inputs = next;
    // 暂停条件（失焦、遮罩打开）同时意味着指针已不在花瓣上；恢复后花瓣按恢复速率回到原轨迹
    if (next.paused && !prev.paused) this.pointer = null;
    if (next.tier !== prev.tier) this.applyCounts();
    this.sync();
  }

  stats(): PetalStats {
    const field = this.isStill() ? this.still : this.layers;
    return {
      running: this.raf !== null,
      level: this.governor.level,
      count: field === null ? 0 : countPetals(field),
      avgFrameMs: this.costCount === 0 ? null : this.costSum / this.costCount,
      drawIntervalMedianMs: this.governor.lastWindowMedianMs,
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.raf !== null) this.scheduler.cancel(this.raf);
    this.raf = null;
    if (this.arrivalRaf !== null) this.scheduler.cancel(this.arrivalRaf);
    this.arrivalRaf = null;
    this.listen(false);
    if (this.pendingTimer !== null) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    live.splice(live.indexOf(this), 1);
  }

  private isStill(): boolean {
    return this.inputs.reduced || this.governor.level === 2;
  }

  private flushPendingSize(): void {
    this.pendingTimer = null;
    const size = this.pendingSize;
    this.pendingSize = null;
    if (size !== null) this.applySize(size.width, size.height, size.dpr);
  }

  private applySize(width: number, height: number, dpr: number): void {
    if (!(width > 0 && height > 0)) {
      this.hasArea = false;
      this.sync();
      return;
    }
    const prev = this.bounds;
    const bounds = { width, height };
    this.bounds = bounds;
    this.hasArea = true;
    this.dprEff = effectiveDpr(dpr, width, height);
    const backingWidth = Math.round(width * this.dprEff);
    const backingHeight = Math.round(height * this.dprEff);
    // 给后备缓冲赋值（哪怕是原值）就会清空画布，尺寸没变就不碰它
    const cleared = backingWidth !== this.canvas.width || backingHeight !== this.canvas.height;
    if (cleared) {
      this.canvas.width = backingWidth;
      this.canvas.height = backingHeight;
    }
    if (prev !== null && prev.width !== width) {
      if (this.layers !== null) scaleWidth(this.layers, prev.width, width);
      if (this.leaving !== null) scaleWidth(this.leaving.layers, prev.width, width);
    }
    this.sync();
    // ResizeObserver 回调排在本帧的 rAF 之后：刚清空的画布要等下一拍才画，这一帧就以空白上屏，拖动窗口边框期间
    // 花瓣层整片消失。播放中也按当前时刻立即重画（不跑 rAF 时 sync 已经画过）；首次量到尺寸时画布本来就是空的
    if (cleared && prev !== null && this.raf !== null) this.drawStillFrame(bounds);
  }

  private applyCounts(): void {
    if (this.bounds === null) return;
    if (this.layers !== null) resizeLayers(this.layers, layerCounts(this.inputs.tier, this.governor.level), this.bounds, this.random);
    if (this.still !== null) this.still = scatterStill(LAYER_COUNTS[this.inputs.tier], this.bounds, this.random, this.still);
  }

  /** 把当前条件落成运行状态；不跑 rAF 时立即重画一帧（暂停中尺寸变化会清空画布，必须补画）。 */
  private sync(): void {
    if (this.destroyed) return;
    const still = this.isStill();
    if (!still && this.pendingTimer !== null) {
      clearTimeout(this.pendingTimer);
      this.flushPendingSize();
      return;
    }
    const bounds = this.hasArea ? this.bounds : null;
    if (bounds !== null) {
      if (still && this.still === null) this.still = scatterStill(LAYER_COUNTS[this.inputs.tier], bounds, this.random, null);
      if (!still && this.layers === null) this.layers = createLayers(layerCounts(this.inputs.tier, this.governor.level), bounds, this.random);
    }
    const run = bounds !== null && !still && !this.inputs.paused;
    if (run && this.raf === null) {
      this.last = null;
      this.drawDue = Number.NEGATIVE_INFINITY;
      this.governor.restart();
      this.raf = this.scheduler.request(this.onFrame);
    } else if (!run && this.raf !== null) {
      this.scheduler.cancel(this.raf);
      this.raf = null;
    }
    this.listen(!still);
    // 收尾途中暂停（失焦时窗口仍看得见）：停在此刻的姿态，恢复后接着播，不一帧跳到终态。
    // 打开减少动画：转向属于缩放，和淡入一起直接到位。没有尺寸时什么也看不见，同样直接到位
    this.settleArrivals(bounds === null || !still || this.inputs.reduced ? "finish" : this.inputs.paused ? "hold" : "play");
    if (!run && bounds !== null) this.drawStillFrame(bounds);
  }

  private readonly onFrame = (now: number): void => {
    this.raf = this.scheduler.request(this.onFrame);
    if (now < this.drawDue) return;
    const layers = this.layers;
    const bounds = this.bounds;
    if (layers === null || bounds === null) throw new Error("花瓣帧循环在没有花瓣或尺寸时运行");
    const started = this.clock();
    const dt = this.last === null ? 0 : clampDt(now - this.last);
    this.last = now;
    this.drawDue = nextDrawAt(this.drawDue, now);
    this.simT += dt;
    if (this.leaving !== null && this.simT - this.leaving.since >= ambientFade.out.duration) this.leaving = null;
    step(layers, dt, this.simT, this.pointer, bounds, this.random);
    if (this.leaving !== null) step(this.leaving.layers, dt, this.simT, this.pointer, bounds, this.random);
    this.drawLayers(layers);
    this.recordCost(this.clock() - started);
    const downgrade = this.governor.sample(now);
    if (downgrade !== null) this.applyDowngrade(downgrade, layers, bounds, now);
  };

  /** now：触发降级的这一拍的帧时间，二级降级的收尾从这一拍起算。 */
  private applyDowngrade(downgrade: GovernorDowngrade, layers: Petal[][], bounds: Bounds, now: number): void {
    if (downgrade.level === 1) {
      const counts = layerCounts(this.inputs.tier, 1);
      this.leaving = { layers: layers.map((petals, li) => petals.slice(counts[li])), since: this.simT };
      resizeLayers(layers, counts, bounds, this.random);
    } else {
      // 定格在这一帧刚画出的位置上，不重新抽取；数量照静态散落补齐，补投的那几片淡入，过窄的几片转到下限
      const frozen = freezeLayers(layers, bounds);
      const still = scatterStill(LAYER_COUNTS[this.inputs.tier], bounds, this.random, frozen.layers);
      const kept = new Set(frozen.layers.flat());
      const added = still.flat().filter((p) => !kept.has(p));
      this.still = still;
      this.leaving = null;
      this.arriving = added.length === 0 && frozen.turning.size === 0 ? null : { petals: new Set(added), turning: frozen.turning, t: 0, last: now };
    }
    this.sync();
    this.onDowngrade({ tier: this.inputs.tier, level: downgrade.level, windowMediansMs: downgrade.windowMediansMs });
  }

  /**
   * 定格后的收尾还没播完：play 逐帧重画到播完；hold 停在此刻的姿态，等恢复再接着播；finish 直接到位。
   * hold 与 finish 都不留任何帧回调。
   */
  private settleArrivals(mode: "play" | "hold" | "finish"): void {
    const arriving = this.arriving;
    if (arriving === null) return;
    if (mode === "play") {
      if (this.arrivalRaf === null) this.arrivalRaf = this.scheduler.request(this.onArrivalFrame);
      return;
    }
    if (this.arrivalRaf !== null) this.scheduler.cancel(this.arrivalRaf);
    this.arrivalRaf = null;
    if (mode === "hold") arriving.last = null;
    else this.arriving = null;
  }

  private readonly onArrivalFrame = (now: number): void => {
    const arriving = this.arriving;
    const still = this.still;
    const bounds = this.bounds;
    if (arriving === null || still === null || bounds === null) throw new Error("花瓣收尾帧在没有待收尾的静态花瓣时运行");
    if (arriving.last !== null) arriving.t += (now - arriving.last) / 1000;
    arriving.last = now;
    if (arriving.t >= ambientFade.in.duration) {
      this.arriving = null;
      this.arrivalRaf = null;
    } else {
      this.arrivalRaf = this.scheduler.request(this.onArrivalFrame);
    }
    this.drawStillPetals(still, bounds);
  };

  private recordCost(ms: number): void {
    if (this.costCount < FRAME_COST_SAMPLES) {
      this.costs[this.costCount++] = ms;
    } else {
      this.costSum -= this.costs[this.costNext];
      this.costs[this.costNext] = ms;
      this.costNext = (this.costNext + 1) % FRAME_COST_SAMPLES;
    }
    this.costSum += ms;
  }

  private listen(on: boolean): void {
    if (on === this.listening) return;
    this.listening = on;
    if (on) {
      this.host.addEventListener("pointermove", this.onPointerMove, { passive: true });
      this.host.addEventListener("pointerleave", this.onPointerLeave);
    } else {
      this.host.removeEventListener("pointermove", this.onPointerMove);
      this.host.removeEventListener("pointerleave", this.onPointerLeave);
      this.pointer = null;
    }
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    this.pointer = { x: event.clientX - this.origin.left, y: event.clientY - this.origin.top };
  };

  private readonly onPointerLeave = (): void => {
    this.pointer = null;
  };

  private drawStillFrame(bounds: Bounds): void {
    if (this.isStill()) {
      if (this.still === null) throw new Error("静态散落尚未生成");
      this.drawStillPetals(this.still, bounds);
      return;
    }
    if (this.layers === null) throw new Error("花瓣尚未生成");
    // dt = 0：只按当前模拟时钟重算位置（宽度缩放后基准线变了），不推进、不改推开偏移
    step(this.layers, 0, this.simT, this.pointer, bounds, this.random);
    if (this.leaving !== null) step(this.leaving.layers, 0, this.simT, this.pointer, bounds, this.random);
    this.drawLayers(this.layers);
  }

  /** 精灵按「明暗 | 强调色 | 像素单元」缓存，任一变化在这一帧重建；随后清空画布。 */
  private prepare(): SpriteSheet {
    const cellDev = cellSize(this.dprEff);
    const key = `${this.inputs.mode}|${this.inputs.accent}|${cellDev}`;
    if (this.sprites === null || key !== this.spriteKey) {
      this.sprites = buildSprites(readPetalPalette(this.canvas), cellDev, this.canvas.ownerDocument);
      this.spriteKey = key;
    }
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    // 精灵本身无平滑；旋转绘制时开启平滑，像素方块的斜边才不会逐帧闪烁
    ctx.imageSmoothingEnabled = true;
    return this.sprites;
  }

  private layerAlpha(layer: number): number {
    return LAYERS[layer].alpha * (this.inputs.mode === "night" ? NIGHT_ALPHA : 1);
  }

  private drawLayers(layers: readonly Petal[][]): void {
    const sprites = this.prepare();
    const leaving = this.leaving;
    // 裁下的花瓣跟同层的一起画，远近次序不乱，只是透明度跟着淡出走
    const fading = leaving === null ? 0 : 1 - tweenAt(ambientFade.out, this.simT - leaving.since);
    layers.forEach((petals, li) => {
      const alpha = this.layerAlpha(li);
      this.ctx.globalAlpha = alpha;
      this.blitPetals(sprites, petals);
      if (leaving === null || leaving.layers[li].length === 0) return;
      this.ctx.globalAlpha = alpha * fading;
      this.blitPetals(sprites, leaving.layers[li]);
    });
  }

  private blitPetals(sprites: SpriteSheet, petals: readonly Petal[]): void {
    const k = this.dprEff;
    for (const p of petals) {
      const f = Math.cos(p.flip);
      if (Math.abs(f) < EDGE_ON) continue;
      this.blit(sprites.sprite(p.glyph, p.tone), p.rot, f, (p.bx + p.ox) * k, (p.y + p.oy) * k);
    }
  }

  private drawStillPetals(still: readonly StillPetal[][], bounds: Bounds): void {
    const sprites = this.prepare();
    const arriving = this.arriving;
    still.forEach((petals, li) => {
      const alpha = this.layerAlpha(li);
      this.ctx.globalAlpha = alpha;
      for (const p of petals) if (arriving === null || !arriving.petals.has(p)) this.blitStill(sprites, p, bounds);
      if (arriving === null) return;
      this.ctx.globalAlpha = alpha * tweenAt(ambientFade.in, arriving.t);
      for (const p of petals) if (arriving.petals.has(p)) this.blitStill(sprites, p, bounds);
    });
  }

  private blitStill(sprites: SpriteSheet, p: StillPetal, bounds: Bounds): void {
    const k = this.dprEff;
    this.blit(sprites.sprite(p.glyph, p.tone), p.rot, this.stillScale(p), p.nx * bounds.width * k, p.ny * bounds.height * k);
  }

  /** 静态花瓣此刻的水平缩放：收尾中转向的那几片按 settle 弹簧从定格姿态走向夹过的 sx，其余就是 sx。 */
  private stillScale(p: StillPetal): number {
    const arriving = this.arriving;
    if (arriving === null) return p.sx;
    const turn = arriving.turning.get(p);
    if (turn === undefined) return p.sx;
    return p.sx + springAt("settle", turn.sx0 - p.sx, turn.v0, arriving.t).x;
  }

  /** translate(x, y) · rotate(rot) · scale(sx, 1)，平移已换算到设备像素；精灵本身就是设备像素尺寸，以中心为锚点。 */
  private blit(sprite: HTMLCanvasElement, rotDeg: number, sx: number, x: number, y: number): void {
    const r = (rotDeg * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    this.ctx.setTransform(c * sx, s * sx, -s, c, x, y);
    this.ctx.drawImage(sprite, -sprite.width / 2, -sprite.height / 2);
  }
}
