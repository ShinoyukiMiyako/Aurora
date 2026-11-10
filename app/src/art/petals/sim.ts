// 花瓣粒子的模拟：生成、回收、逐帧推进、指针推开与平滑。全部是纯函数（随机源由调用方注入），
// 为了每帧不分配对象，step 原地改写花瓣。绘制与生命周期在 engine.ts。
//
// 坐标一律是 CSS 像素，原点为画布左上角。每片花瓣的横向位置 = 基准线 x0 + 正弦摆动，
// 再叠加指针推开造成的偏移 (ox, oy)；推力按不含偏移的位置计算，避免偏移反过来改变推力形成抖动。

import { CELL, GLYPHS, TONE_WEIGHTS, type GlyphId, type ToneId } from "./glyphs";

export type PetalTier = "compact" | "regular" | "wide";

/** 景深层：0 远景、1 中景、2 近景；绘制顺序由远到近。 */
export type LayerIndex = 0 | 1 | 2;

export type Range = readonly [number, number];

export interface LayerSpec {
  name: "far" | "mid" | "near";
  /** 该层允许的字模，均匀抽取。远景只用小字模，近景只用大字模，像素单元三层相同。 */
  glyphs: readonly GlyphId[];
  /** 日樱下的不透明度；夜樱再乘 NIGHT_ALPHA。 */
  alpha: number;
  /** 下落速度 px/s。 */
  vy: Range;
  /** 摆幅 px。 */
  amp: Range;
  /** 摆动角频率 rad/s。 */
  w: Range;
  /** 自转速度在 ±spin °/s 内均匀抽取。 */
  spin: number;
  /** 翻面角频率 rad/s。 */
  flipW: Range;
  /** 推力系数：远处的花瓣被推得少，近处的多，推开本身也带出景深。 */
  push: number;
}

export const LAYERS: readonly [LayerSpec, LayerSpec, LayerSpec] = [
  { name: "far", glyphs: [3, 4], alpha: 0.4, vy: [10, 16], amp: [12, 24], w: [0.3, 0.55], spin: 20, flipW: [0.8, 1.4], push: 0.55 },
  { name: "mid", glyphs: [1, 2, 3], alpha: 0.65, vy: [15, 24], amp: [18, 36], w: [0.35, 0.7], spin: 30, flipW: [1.0, 1.8], push: 0.8 },
  { name: "near", glyphs: [0, 1], alpha: 0.9, vy: [22, 32], amp: [24, 48], w: [0.45, 0.85], spin: 35, flipW: [1.2, 2.4], push: 1.0 },
];

/** 各档位下远、中、近三层的花瓣数（合计 16 / 20 / 26）：窗口越宽花瓣越多，密度大致不变。 */
export const LAYER_COUNTS: Readonly<Record<PetalTier, readonly [number, number, number]>> = {
  compact: [6, 6, 4],
  regular: [8, 7, 5],
  wide: [10, 9, 7],
};

/** 指针推开半径 px，三层相同。 */
export const POINTER_RADIUS = 96;
/** 最大推开距离 px，再乘该层推力系数。 */
export const PUSH_DISTANCE = 46;
/** 让开速率 /s：目标偏移不小于当前偏移时用它，花瓣迅速让路。 */
export const K_YIELD = 8;
/** 恢复速率 /s：约 1.2 s 回到 95%，像在空气里慢慢漂回原轨迹。 */
export const K_RETURN = 2.5;
/** 单帧模拟步长上限 s：掉帧或调试器断点之后不让花瓣瞬移。 */
export const DT_MAX = 0.05;
/**
 * 绘制节拍 ms，约 62 fps：花瓣飘得慢，跟满高刷只是多耗电。取 16 而不是 16.67：60 Hz 屏的帧间隔正好贴着
 * 16.67，时间戳稍有抖动就会被判成没到点，平白少画一帧。
 */
export const DRAW_INTERVAL_MS = 16;
/** 夜樱下各层不透明度的系数：深底上同样的不透明度显得更亮。 */
export const NIGHT_ALPHA = 0.8;
/** 落出底边多少 px 后回收。 */
export const RECYCLE_MARGIN = 16;
/** 回收与新增的花瓣在顶边以上 RECYCLE_MARGIN 到 RECYCLE_MARGIN + RESPAWN_SPREAD 之间出现，错开进场时刻。 */
export const RESPAWN_SPREAD = 40;
/** |cos(flip)| 低于它时花瓣几乎侧对视线，这一帧不画。 */
export const EDGE_ON = 0.06;
/** 静态散落时任意两片花瓣的最小间距 px 与每片的最多投点次数。 */
export const STILL_MIN_GAP = 56;
export const STILL_ATTEMPTS = 30;
/** 静态散落的水平缩放下限：模拟翻面到一半的姿态，再随机取正负号。 */
export const STILL_SCALE_MIN = 0.55;

export interface Petal {
  glyph: GlyphId;
  tone: ToneId;
  /** 摆动的基准线。 */
  x0: number;
  y: number;
  vy: number;
  amp: number;
  w: number;
  phase: number;
  /** 自转角，度。 */
  rot: number;
  spin: number;
  /** 翻面相位，弧度；绘制时水平缩放 cos(flip)，为负即镜像。 */
  flip: number;
  flipW: number;
  /** 推开偏移。 */
  ox: number;
  oy: number;
  /** 最近一次 step 算出的未加推开偏移的横坐标。 */
  bx: number;
}

export interface Bounds {
  width: number;
  height: number;
}

export interface Pointer {
  x: number;
  y: number;
}

/** 返回 [0, 1) 均匀分布的随机源。 */
export type Random = () => number;

/** 线性同余随机源：只用于视觉回归与陈列的固定种子，生产环境用 Math.random，每次挂载分布不同。 */
export function createRandom(seed: number): Random {
  if (!Number.isInteger(seed) || seed < 0) throw new Error(`随机种子必须是非负整数，实为 ${seed}`);
  let state = seed % 4294967296;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const TAU = Math.PI * 2;

function uniform(rand: Random, [min, max]: Range): number {
  return min + (max - min) * rand();
}

function pick<T>(rand: Random, items: readonly T[]): T {
  return items[Math.min(items.length - 1, Math.floor(rand() * items.length))];
}

export function pickTone(rand: Random): ToneId {
  const u = rand();
  let acc = 0;
  for (let i = 0; i < TONE_WEIGHTS.length - 1; i++) {
    acc += TONE_WEIGHTS[i];
    if (u < acc) return i as ToneId;
  }
  return (TONE_WEIGHTS.length - 1) as ToneId;
}

/** 字模在屏幕上的高度 px。 */
export function glyphHeight(glyph: GlyphId): number {
  return GLYPHS[glyph].rows * CELL;
}

/** 顶部进场位置：y ∈ [−(MARGIN + SPREAD), −MARGIN]。 */
function topY(rand: Random): number {
  return -RECYCLE_MARGIN - RESPAWN_SPREAD * rand();
}

/**
 * 生成一片花瓣，抽取该层全部参数、字模与色调。
 * scatter：首次挂载用，y ∈ [−字模高, h]，画面一开始就是满的，不从顶部「开始下雨」；
 * top：回收与档位变化新增用，从顶边以上进场，不在半空突然出现。
 */
export function spawnPetal(layer: LayerIndex, bounds: Bounds, rand: Random, at: "scatter" | "top"): Petal {
  const spec = LAYERS[layer];
  const glyph = pick(rand, spec.glyphs);
  const tone = pickTone(rand);
  const x0 = rand() * bounds.width;
  const s = glyphHeight(glyph);
  const y = at === "top" ? topY(rand) : -s + rand() * (bounds.height + s);
  return {
    glyph,
    tone,
    x0,
    y,
    vy: uniform(rand, spec.vy),
    amp: uniform(rand, spec.amp),
    w: uniform(rand, spec.w),
    phase: rand() * TAU,
    rot: rand() * 360,
    spin: uniform(rand, [-spec.spin, spec.spin]),
    flip: rand() * TAU,
    flipW: uniform(rand, spec.flipW),
    ox: 0,
    oy: 0,
    bx: x0,
  };
}

/** 落出底边的花瓣回到顶部，层不变、其余参数全部重抽，推开偏移清零（它已经是另一片花瓣了）。 */
export function respawnAtTop(p: Petal, layer: LayerIndex, bounds: Bounds, rand: Random): void {
  Object.assign(p, spawnPetal(layer, bounds, rand, "top"));
}

export function clampDt(elapsedMs: number): number {
  return Math.min(DT_MAX, Math.max(0, elapsedMs / 1000));
}

/**
 * 节拍 due 上的这一帧在 now 画完后，下一拍的时刻。沿节拍累加而不是从 now 起算：帧间隔略短于节拍的屏
 * （70、75 Hz）从 now 起算只能每两帧画一次，掉到 37 fps 上下，70 Hz 时绘制间隔还会越过慢窗口的线；累加
 * 则让这一拍晚到的部分抵给下一拍。落后整拍以上（卡顿、恢复播放）不补画，从 now 重新起拍。
 */
export function nextDrawAt(due: number, now: number): number {
  const next = due + DRAW_INTERVAL_MS;
  return next > now ? next : now + DRAW_INTERVAL_MS;
}

/** 与帧率无关的指数平滑系数。 */
export function smoothing(k: number, dt: number): number {
  return 1 - Math.exp(-k * dt);
}

export interface PushVector {
  tx: number;
  ty: number;
}

/**
 * 指针对位于 (bx, y) 的花瓣的目标推开偏移，写进 out：方向背离指针，模长
 * PUSH_DISTANCE × push × (1 − d / R)²，d ≥ R 时为 0。指针几乎压在花瓣上时方向无定义，也取 0。
 */
export function pushTarget(bx: number, y: number, pointer: Pointer | null, push: number, out: PushVector): PushVector {
  out.tx = 0;
  out.ty = 0;
  if (pointer === null) return out;
  const dx = bx - pointer.x;
  const dy = y - pointer.y;
  const d = Math.hypot(dx, dy);
  if (d >= POINTER_RADIUS || d <= 0.1) return out;
  const f = PUSH_DISTANCE * push * (1 - d / POINTER_RADIUS) ** 2;
  out.tx = (dx / d) * f;
  out.ty = (dy / d) * f;
  return out;
}

const scratch: PushVector = { tx: 0, ty: 0 };

/**
 * 推进一帧：下落、自转、翻面、回收、摆动、推开平滑。simT 是只在播放时累加的模拟时钟（已含本帧 dt），
 * 暂停期间不走，恢复后摆动相位不跳。dt = 0 时只按当前时钟重算位置，用于暂停中重画。
 */
export function step(layers: readonly Petal[][], dt: number, simT: number, pointer: Pointer | null, bounds: Bounds, rand: Random): void {
  for (let li = 0; li < layers.length; li++) {
    const layer = li as LayerIndex;
    const push = LAYERS[layer].push;
    for (const p of layers[li]) {
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
      p.flip += p.flipW * dt;
      if (p.y > bounds.height + RECYCLE_MARGIN) respawnAtTop(p, layer, bounds, rand);
      p.bx = p.x0 + p.amp * Math.sin(p.w * simT + p.phase);
      const { tx, ty } = pushTarget(p.bx, p.y, pointer, push, scratch);
      const k = Math.hypot(tx, ty) >= Math.hypot(p.ox, p.oy) ? K_YIELD : K_RETURN;
      const a = smoothing(k, dt);
      p.ox += (tx - p.ox) * a;
      p.oy += (ty - p.oy) * a;
    }
  }
}

/** 降级等级：0 完整；1 去掉远景层、中景减半；2 改为静态散落。 */
export type PetalLevel = 0 | 1 | 2;

export function layerCounts(tier: PetalTier, level: PetalLevel): readonly [number, number, number] {
  const [far, mid, near] = LAYER_COUNTS[tier];
  if (level === 0 || level === 2) return [far, mid, near];
  return [0, Math.ceil(mid / 2), near];
}

export function createLayers(counts: readonly number[], bounds: Bounds, rand: Random): Petal[][] {
  return counts.map((n, li) => Array.from({ length: n }, () => spawnPetal(li as LayerIndex, bounds, rand, "scatter")));
}

/** 按层增删到目标数量：多出的从数组尾部移除，新增的从顶部进场。 */
export function resizeLayers(layers: Petal[][], counts: readonly number[], bounds: Bounds, rand: Random): void {
  if (layers.length !== counts.length) throw new Error(`花瓣层数 ${layers.length} 与目标层数 ${counts.length} 不一致`);
  layers.forEach((petals, li) => {
    if (petals.length > counts[li]) petals.length = counts[li];
    while (petals.length < counts[li]) petals.push(spawnPetal(li as LayerIndex, bounds, rand, "top"));
  });
}

/** 宽度变化时按比例缩放基准线，保持横向分布；高度变化不重排，超出新底边的花瓣按回收规则回到顶部。 */
export function scaleWidth(layers: readonly Petal[][], oldWidth: number, newWidth: number): void {
  if (!(oldWidth > 0)) throw new Error(`缩放花瓣基准线需要正的原宽度，实为 ${oldWidth}`);
  const k = newWidth / oldWidth;
  for (const petals of layers) for (const p of petals) p.x0 *= k;
}

export function countPetals(layers: readonly (readonly unknown[])[]): number {
  return layers.reduce((n, petals) => n + petals.length, 0);
}

/** 减少动画时的静态花瓣。位置按画布尺寸归一化，尺寸变化时按新尺寸重画即可。 */
export interface StillPetal {
  glyph: GlyphId;
  tone: ToneId;
  nx: number;
  ny: number;
  rot: number;
  /** 水平缩放，带符号：负值为镜像。 */
  sx: number;
}

/**
 * 把正在飘的花瓣原地定格成静态散落（自动降到最低级时用），画面不跳：位置取此刻的绘制位置（含推开偏移），
 * 自转角不变，翻面取此刻的 cos(flip)。此刻看不见的花瓣（在顶边以上候场、整片落在画布外、侧对视线）不定格，
 * 空出来的数量交给 scatterStill 补投。
 */
export function freezeLayers(layers: readonly (readonly Petal[])[], bounds: Bounds): StillPetal[][] {
  return layers.map((petals) => {
    const frozen: StillPetal[] = [];
    for (const p of petals) {
      const x = p.bx + p.ox;
      const y = p.y + p.oy;
      const sx = Math.cos(p.flip);
      // 精灵以中心为锚点任意旋转，半条对角线以内都可能落在画布上
      const glyph = GLYPHS[p.glyph];
      const reach = (Math.hypot(glyph.cols, glyph.rows) * CELL) / 2;
      const outside = x < -reach || x > bounds.width + reach || y < -reach || y > bounds.height + reach;
      if (outside || Math.abs(sx) < EDGE_ON) continue;
      frozen.push({ glyph: p.glyph, tone: p.tone, nx: x / bounds.width, ny: y / bounds.height, rot: p.rot, sx });
    }
    return frozen;
  });
}

/**
 * 静态散落：existing 为 null 时全部新投；否则保留其中每层前 counts[i] 片（档位变化时按层增删），
 * 新增的按最小间距随机投点（每片最多投 STILL_ATTEMPTS 次，仍不满足就接受最后一次），间距对全部层一起计算。
 */
export function scatterStill(counts: readonly number[], bounds: Bounds, rand: Random, existing: readonly (readonly StillPetal[])[] | null): StillPetal[][] {
  if (!(bounds.width > 0 && bounds.height > 0)) throw new Error(`静态散落需要正的画布尺寸，实为 ${bounds.width}×${bounds.height}`);
  if (existing !== null && existing.length !== counts.length) throw new Error(`已有静态花瓣 ${existing.length} 层，目标 ${counts.length} 层`);
  const kept = counts.map((n, li) => (existing === null ? [] : existing[li].slice(0, n)));
  const placed = kept.flat().map((p) => ({ x: p.nx * bounds.width, y: p.ny * bounds.height }));
  return kept.map((petals, li) => {
    const spec = LAYERS[li as LayerIndex];
    while (petals.length < counts[li]) {
      let x = 0;
      let y = 0;
      for (let attempt = 0; attempt < STILL_ATTEMPTS; attempt++) {
        x = rand() * bounds.width;
        y = rand() * bounds.height;
        if (placed.every((q) => Math.hypot(q.x - x, q.y - y) >= STILL_MIN_GAP)) break;
      }
      placed.push({ x, y });
      const glyph = pick(rand, spec.glyphs);
      const tone = pickTone(rand);
      const rot = rand() * 360;
      const scale = uniform(rand, [STILL_SCALE_MIN, 1]);
      petals.push({ glyph, tone, nx: x / bounds.width, ny: y / bounds.height, rot, sx: rand() < 0.5 ? -scale : scale });
    }
    return petals;
  });
}
