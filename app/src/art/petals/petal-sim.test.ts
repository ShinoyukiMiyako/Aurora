import { describe, expect, it } from "vitest";
import { CELL, GLYPHS, TONE_WEIGHTS } from "./glyphs";
import {
  DT_MAX,
  EDGE_ON,
  K_RETURN,
  K_YIELD,
  LAYER_COUNTS,
  LAYERS,
  POINTER_RADIUS,
  PUSH_DISTANCE,
  RECYCLE_MARGIN,
  STILL_MIN_GAP,
  STILL_SCALE_MIN,
  clampDt,
  countPetals,
  createLayers,
  createRandom,
  freezeLayers,
  layerCounts,
  nextDrawAt,
  pickTone,
  pushTarget,
  resizeLayers,
  scaleWidth,
  scatterStill,
  spawnPetal,
  step,
  type LayerIndex,
  type Petal,
} from "./sim";

const SEED = 20231;
const BOUNDS = { width: 1036, height: 680 };

/** 一片不下落、不自转、不翻面、不摆动的花瓣，只用来观察推开偏移。 */
function still(x: number, y: number): Petal {
  return { glyph: 0, tone: 0, x0: x, y, vy: 0, amp: 0, w: 0, phase: 0, rot: 0, spin: 0, flip: 0, flipW: 0, ox: 0, oy: 0, bx: x };
}

describe("随机源", () => {
  it("固定种子按线性同余给出确定序列", () => {
    const rand = createRandom(SEED);
    expect([rand(), rand(), rand()]).toEqual([0.0766411260701716, 0.306439925218001, 0.15259146597236395]);
  });

  it("拒绝负数与小数种子", () => {
    expect(() => createRandom(-1)).toThrow("随机种子");
    expect(() => createRandom(1.5)).toThrow("随机种子");
  });

  it("色调按 0.40 / 0.35 / 0.25 抽取", () => {
    const rand = createRandom(SEED);
    const counts = [0, 0, 0];
    const n = 20000;
    for (let i = 0; i < n; i++) counts[pickTone(rand)]++;
    counts.forEach((c, i) => expect(c / n).toBeCloseTo(TONE_WEIGHTS[i], 1));
    expect(pickTone(() => 0)).toBe(0);
    expect(pickTone(() => 0.3999)).toBe(0);
    expect(pickTone(() => 0.4)).toBe(1);
    expect(pickTone(() => 0.7499)).toBe(1);
    expect(pickTone(() => 0.75)).toBe(2);
    expect(pickTone(() => 0.99999)).toBe(2);
  });
});

describe("生成", () => {
  it("首次挂载铺满画面：x0 ∈ [0, w]，y ∈ [−字模高, h]，参数落在该层区间内", () => {
    const rand = createRandom(SEED);
    for (const layer of [0, 1, 2] as LayerIndex[]) {
      const spec = LAYERS[layer];
      for (let i = 0; i < 300; i++) {
        const p = spawnPetal(layer, BOUNDS, rand, "scatter");
        const s = GLYPHS[p.glyph].rows * 2;
        expect(spec.glyphs).toContain(p.glyph);
        expect(p.x0).toBeGreaterThanOrEqual(0);
        expect(p.x0).toBeLessThanOrEqual(BOUNDS.width);
        expect(p.y).toBeGreaterThanOrEqual(-s);
        expect(p.y).toBeLessThanOrEqual(BOUNDS.height);
        expect(p.vy).toBeGreaterThanOrEqual(spec.vy[0]);
        expect(p.vy).toBeLessThanOrEqual(spec.vy[1]);
        expect(p.amp).toBeGreaterThanOrEqual(spec.amp[0]);
        expect(p.amp).toBeLessThanOrEqual(spec.amp[1]);
        expect(Math.abs(p.spin)).toBeLessThanOrEqual(spec.spin);
        expect(p.flipW).toBeGreaterThanOrEqual(spec.flipW[0]);
        expect(p.flipW).toBeLessThanOrEqual(spec.flipW[1]);
        expect(p.rot).toBeGreaterThanOrEqual(0);
        expect(p.rot).toBeLessThan(360);
        expect([p.ox, p.oy]).toEqual([0, 0]);
      }
    }
  });

  it("三层字模分配：远景只用 P4 P5，近景只用 P1 P2", () => {
    expect(LAYERS.map((l) => l.glyphs.map((g) => GLYPHS[g].name))).toEqual([["P4", "P5"], ["P2", "P3", "P4"], ["P1", "P2"]]);
    expect(LAYERS.map((l) => l.alpha)).toEqual([0.4, 0.65, 0.9]);
    expect(LAYERS.map((l) => l.push)).toEqual([0.55, 0.8, 1.0]);
  });

  it("数量随档位：16 / 20 / 26；一级降级去掉远景、中景减半向上取整，二级的静态散落用完整数量", () => {
    expect(Object.values(LAYER_COUNTS).map((c) => c.reduce((a, b) => a + b, 0))).toEqual([16, 20, 26]);
    expect(layerCounts("compact", 1)).toEqual([0, 3, 4]);
    expect(layerCounts("regular", 1)).toEqual([0, 4, 5]);
    expect(layerCounts("wide", 1)).toEqual([0, 5, 7]);
    expect(layerCounts("wide", 2)).toEqual([10, 9, 7]);
    expect(countPetals(createLayers(layerCounts("regular", 0), BOUNDS, createRandom(SEED)))).toBe(20);
  });
});

describe("回收", () => {
  it("落出底边 16 px 以外才回收，回到 y ∈ [−56, −16]，层不变、推开偏移清零", () => {
    const rand = createRandom(SEED);
    for (let i = 0; i < 200; i++) {
      const p = spawnPetal(2, BOUNDS, rand, "scatter");
      Object.assign(p, { y: BOUNDS.height + RECYCLE_MARGIN, vy: 0, ox: 7, oy: -3 });
      step([[], [], [p]], 0, 0, null, BOUNDS, rand);
      expect(p.y).toBe(BOUNDS.height + RECYCLE_MARGIN);
      p.y += 0.01;
      step([[], [], [p]], 0, 0, null, BOUNDS, rand);
      expect(p.y).toBeGreaterThanOrEqual(-56);
      expect(p.y).toBeLessThanOrEqual(-16);
      expect(LAYERS[2].glyphs).toContain(p.glyph);
      expect([p.ox, p.oy]).toEqual([0, 0]);
      expect(p.x0).toBeGreaterThanOrEqual(0);
      expect(p.x0).toBeLessThanOrEqual(BOUNDS.width);
    }
  });

  it("档位变化按层增删：多出的从尾部移除，新增的从顶部进场", () => {
    const rand = createRandom(SEED);
    const layers = createLayers(LAYER_COUNTS.wide, BOUNDS, rand);
    const keptFar = layers[0].slice(0, 6);
    resizeLayers(layers, LAYER_COUNTS.compact, BOUNDS, rand);
    expect(layers.map((l) => l.length)).toEqual([6, 6, 4]);
    expect(layers[0]).toEqual(keptFar);
    const before = layers.map((l) => l.length);
    resizeLayers(layers, LAYER_COUNTS.wide, BOUNDS, rand);
    expect(layers.map((l) => l.length)).toEqual([10, 9, 7]);
    layers.forEach((petals, li) =>
      petals.slice(before[li]).forEach((p) => {
        expect(p.y).toBeGreaterThanOrEqual(-56);
        expect(p.y).toBeLessThanOrEqual(-16);
      }),
    );
    expect(() => resizeLayers(layers, [1, 2], BOUNDS, rand)).toThrow("层数");
  });
});

describe("运动方程", () => {
  it("dt 超过 0.05 s 被钳制，负值记为 0", () => {
    expect(clampDt(16)).toBeCloseTo(0.016, 10);
    expect(clampDt(50)).toBe(DT_MAX);
    expect(clampDt(51)).toBe(DT_MAX);
    expect(clampDt(5000)).toBe(DT_MAX);
    expect(clampDt(-3)).toBe(0);
  });

  it("绘制节拍沿上一拍累加，晚到的余量抵给下一拍", () => {
    expect(nextDrawAt(1000, 1000)).toBe(1016);
    // 晚了 10 ms 才画，下一拍仍在 1016，不顺延到 1026
    expect(nextDrawAt(1000, 1010)).toBe(1016);
  });

  it("绘制节拍落后整拍以上时从当前帧重新起拍，不连着补画", () => {
    expect(nextDrawAt(1000, 1016)).toBe(1032);
    expect(nextDrawAt(1000, 1100)).toBe(1116);
    expect(nextDrawAt(Number.NEGATIVE_INFINITY, 1000)).toBe(1016);
  });

  it("按 dt 下落、自转、翻面，横向 = x0 + A·sin(ω·simT + phase)", () => {
    const p = spawnPetal(1, BOUNDS, createRandom(SEED), "scatter");
    Object.assign(p, { x0: 300, y: 100, vy: 20, amp: 30, w: 0.5, phase: 1, rot: 10, spin: -25, flip: 0.2, flipW: 1.5 });
    step([[], [p], []], 0.04, 3, null, BOUNDS, createRandom(1));
    expect(p.y).toBeCloseTo(100.8, 10);
    expect(p.rot).toBeCloseTo(9, 10);
    expect(p.flip).toBeCloseTo(0.26, 10);
    expect(p.bx).toBeCloseTo(300 + 30 * Math.sin(0.5 * 3 + 1), 10);
  });

  it("dt = 0 只按当前时钟重算位置，不推进", () => {
    const p = spawnPetal(0, BOUNDS, createRandom(SEED), "scatter");
    const before = { y: p.y, rot: p.rot, flip: p.flip };
    step([[p], [], []], 0, 7.5, { x: p.x0, y: p.y + 10 }, BOUNDS, createRandom(1));
    expect({ y: p.y, rot: p.rot, flip: p.flip }).toEqual(before);
    expect([p.ox, p.oy]).toEqual([0, 0]);
    expect(p.bx).toBeCloseTo(p.x0 + p.amp * Math.sin(p.w * 7.5 + p.phase), 10);
  });
});

describe("指针推开", () => {
  it("半径内目标偏移背离指针，模长 46 × push × (1 − d/R)²；半径外与重合时为 0", () => {
    const out = { tx: 0, ty: 0 };
    const pointer = { x: 100, y: 100 };
    for (const [push, dx, dy] of [
      [1, 30, 40],
      [0.8, -20, 0],
      [0.55, 0, -60],
      [1, 60, -70],
    ]) {
      const d = Math.hypot(dx, dy);
      pushTarget(100 + dx, 100 + dy, pointer, push, out);
      const magnitude = PUSH_DISTANCE * push * (1 - d / POINTER_RADIUS) ** 2;
      expect(Math.hypot(out.tx, out.ty)).toBeCloseTo(magnitude, 10);
      // 与指针指向花瓣的方向同向，即背离指针
      expect((out.tx * dx + out.ty * dy) / (magnitude * d)).toBeCloseTo(1, 10);
    }
    expect(pushTarget(100 + POINTER_RADIUS, 100, pointer, 1, out)).toEqual({ tx: 0, ty: 0 });
    expect(pushTarget(100 + 57.6, 100 + 76.8, pointer, 1, out)).toEqual({ tx: 0, ty: 0 });
    expect(pushTarget(100.05, 100, pointer, 1, out)).toEqual({ tx: 0, ty: 0 });
    expect(pushTarget(150, 100, null, 1, out)).toEqual({ tx: 0, ty: 0 });
    pushTarget(100 + POINTER_RADIUS - 1, 100, pointer, 1, out);
    expect(out.tx).toBeGreaterThan(0);
  });

  it("让开按 K = 8 指数平滑，恢复按 K = 2.5，与帧率无关", () => {
    const p = still(200, 200);
    const pointer = { x: 170, y: 200 };
    const target = PUSH_DISTANCE * LAYERS[2].push * (1 - 30 / POINTER_RADIUS) ** 2;
    step([[], [], [p]], 0.02, 0, pointer, BOUNDS, createRandom(1));
    const afterOne = target * (1 - Math.exp(-K_YIELD * 0.02));
    expect(p.ox).toBeCloseTo(afterOne, 10);
    expect(p.oy).toBeCloseTo(0, 10);

    // 两个 0.01 s 小步与一个 0.02 s 大步结果相同
    const q = still(200, 200);
    step([[], [], [q]], 0.01, 0, pointer, BOUNDS, createRandom(1));
    step([[], [], [q]], 0.01, 0, pointer, BOUNDS, createRandom(1));
    expect(q.ox).toBeCloseTo(afterOne, 10);

    // 指针离开：目标为 0，小于当前偏移，按恢复速率衰减
    step([[], [], [p]], 0.03, 0, null, BOUNDS, createRandom(1));
    expect(p.ox).toBeCloseTo(afterOne * Math.exp(-K_RETURN * 0.03), 10);

    // 远景层推力系数 0.55
    const far = still(200, 200);
    step([[far], [], []], 0.02, 0, pointer, BOUNDS, createRandom(1));
    expect(far.ox).toBeCloseTo(PUSH_DISTANCE * 0.55 * (1 - 30 / POINTER_RADIUS) ** 2 * (1 - Math.exp(-K_YIELD * 0.02)), 10);
  });

  it("推力按不含偏移的位置计算：已被推开的花瓣不会因偏移离开半径而弹回", () => {
    const p = still(200, 200);
    const pointer = { x: 150, y: 200 };
    for (let i = 0; i < 400; i++) step([[], [], [p]], 0.016, 0, pointer, BOUNDS, createRandom(1));
    const target = PUSH_DISTANCE * (1 - 50 / POINTER_RADIUS) ** 2;
    expect(p.ox).toBeCloseTo(target, 6);
  });
});

describe("尺寸变化", () => {
  it("宽度变化按比例缩放 x0，原宽度非正时报错", () => {
    const layers = createLayers(LAYER_COUNTS.regular, BOUNDS, createRandom(SEED));
    const before = layers.flat().map((p) => p.x0);
    scaleWidth(layers, BOUNDS.width, 777);
    layers.flat().forEach((p, i) => expect(p.x0).toBeCloseTo((before[i] * 777) / BOUNDS.width, 10));
    expect(() => scaleWidth(layers, 0, 500)).toThrow("原宽度");
  });
});

describe("静态散落", () => {
  it("按档位数量散落，两两间距不小于 56 px，翻面缩放 |sx| ∈ [0.55, 1]", () => {
    const still = scatterStill(LAYER_COUNTS.wide, BOUNDS, createRandom(SEED), null);
    expect(still.map((l) => l.length)).toEqual([10, 9, 7]);
    const points = still.flat().map((p) => ({ x: p.nx * BOUNDS.width, y: p.ny * BOUNDS.height }));
    for (let i = 0; i < points.length; i++)
      for (let j = i + 1; j < points.length; j++) expect(Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y)).toBeGreaterThanOrEqual(STILL_MIN_GAP);
    for (const p of still.flat()) {
      expect(Math.abs(p.sx)).toBeGreaterThanOrEqual(0.55);
      expect(Math.abs(p.sx)).toBeLessThanOrEqual(1);
      expect(p.nx).toBeGreaterThanOrEqual(0);
      expect(p.nx).toBeLessThan(1);
    }
    expect(still.flat().some((p) => p.sx < 0)).toBe(true);
    expect(still.flat().some((p) => p.sx > 0)).toBe(true);
  });

  it("放不下时每片投 30 次后接受最后一次，数量不打折", () => {
    let calls = 0;
    const rand = () => {
      calls++;
      return 0.5;
    };
    const still = scatterStill([3, 0, 0], { width: 40, height: 40 }, rand, null);
    expect(still[0].map((p) => [p.nx, p.ny])).toEqual([
      [0.5, 0.5],
      [0.5, 0.5],
      [0.5, 0.5],
    ]);
    // 第一片一次就满足；后两片各投 30 次（每次两个随机数），每片再抽字模、色调、角度、缩放与正负号
    expect(calls).toBe(2 + 30 * 2 * 2 + 5 * 3);
  });

  it("定格：看得见的花瓣按此刻的绘制位置、自转角与翻面定格；候场、出界与侧对视线的不定格", () => {
    const bounds = { width: 400, height: 300 };
    const reach = (Math.hypot(GLYPHS[0].cols, GLYPHS[0].rows) * CELL) / 2;
    const at = (x: number, y: number, patch: Partial<Petal> = {}): Petal => ({ ...still(x, y), ...patch });
    const pushed = at(100, 120, { ox: 5, oy: -3, rot: 33, flip: Math.PI, tone: 2 });
    const leftEdge = at(-reach + 1, 150, { flip: 0.5 });
    const waiting = at(200, -reach - 1);
    const below = at(200, bounds.height + reach + 1);
    const right = at(bounds.width + reach + 1, 100);
    const edgeOn = at(200, 100, { flip: Math.acos(EDGE_ON / 2) });
    const field = freezeLayers([[waiting, leftEdge], [below, right], [edgeOn, pushed]], bounds);
    expect(field.layers).toEqual([
      [{ glyph: 0, tone: 0, nx: (-reach + 1) / 400, ny: 0.5, rot: 0, sx: Math.cos(0.5) }],
      [],
      [{ glyph: 0, tone: 2, nx: 105 / 400, ny: 117 / 300, rot: 33, sx: -1 }],
    ]);
    expect(field.turning.size).toBe(0);
  });

  it("定格：比静态散落下限窄的花瓣夹到下限、不改正负号，记下此刻的姿态与翻面速度作转向起点", () => {
    const bounds = { width: 400, height: 300 };
    const at = (x: number, y: number, patch: Partial<Petal>): Petal => ({ ...still(x, y), ...patch });
    // cos(1) ≈ 0.540，正在变窄；cos(2) ≈ −0.416，镜像的一面正在变宽；cos(0.98) ≈ 0.557 刚好不用夹
    const narrow = at(50, 60, { flip: 1, flipW: 2 });
    const mirrored = at(150, 160, { flip: 2, flipW: 1.5, rot: 70 });
    const wide = at(250, 260, { flip: 0.98, flipW: 2.4 });
    const field = freezeLayers([[narrow], [mirrored, wide], []], bounds);
    expect(field.layers.map((petals) => petals.map((p) => p.sx))).toEqual([[STILL_SCALE_MIN], [-STILL_SCALE_MIN, Math.cos(0.98)], []]);
    expect(field.layers[1][0]).toMatchObject({ nx: 150 / 400, ny: 160 / 300, rot: 70 });
    expect(field.turning.size).toBe(2);
    expect(field.turning.get(field.layers[0][0])).toEqual({ sx0: Math.cos(1), v0: -Math.sin(1) * 2 });
    expect(field.turning.get(field.layers[1][0])).toEqual({ sx0: Math.cos(2), v0: -Math.sin(2) * 1.5 });
    expect(field.turning.has(field.layers[1][1])).toBe(false);
  });

  it("定格后的整片画面和静态散落同一个下限：任意翻面相位都不会留下近乎侧立的细条", () => {
    const layers = createLayers(LAYER_COUNTS.wide, BOUNDS, createRandom(SEED));
    for (const p of layers.flat()) p.y = BOUNDS.height / 2;
    const field = freezeLayers(layers, BOUNDS);
    const frozen = field.layers.flat();
    for (const p of frozen) expect(Math.abs(p.sx)).toBeGreaterThanOrEqual(STILL_SCALE_MIN);
    // 翻面相位均匀分布时约三分之一落在下限以内：这几片都记了转向，起点就是被夹之前的姿态
    expect(field.turning.size).toBeGreaterThan(0);
    for (const [p, turn] of field.turning) {
      expect(frozen).toContain(p);
      expect(Math.abs(turn.sx0)).toBeLessThan(STILL_SCALE_MIN);
      expect(Math.abs(turn.sx0)).toBeGreaterThanOrEqual(EDGE_ON);
      expect(Math.sign(p.sx)).toBe(Math.sign(turn.sx0));
    }
  });

  it("档位变化保留已有的散落、只补新增的；尺寸非正时报错", () => {
    const rand = createRandom(SEED);
    const compact = scatterStill(LAYER_COUNTS.compact, BOUNDS, rand, null);
    const wide = scatterStill(LAYER_COUNTS.wide, BOUNDS, rand, compact);
    wide.forEach((petals, li) => expect(petals.slice(0, compact[li].length)).toEqual(compact[li]));
    const back = scatterStill(LAYER_COUNTS.compact, BOUNDS, rand, wide);
    expect(back).toEqual(compact);
    expect(() => scatterStill(LAYER_COUNTS.compact, { width: 0, height: 10 }, rand, null)).toThrow("画布尺寸");
    expect(() => scatterStill(LAYER_COUNTS.compact, BOUNDS, rand, [[]])).toThrow("层");
  });
});
