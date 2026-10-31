// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRect } from "../../test/dom";
import { PetalEngine, STILL_RESIZE_DEBOUNCE_MS, currentPetalStats, effectiveDpr, type PetalDowngrade, type PetalInputs } from "./engine";
import { createRandom } from "./sim";
import { manualFrames, stubCanvas, stubPetalTokens, type FakeContext, type ManualFrames } from "./test-canvas";

const SEED = 20231;
const BASE: PetalInputs = { paused: false, reduced: false, tier: "compact", mode: "day", accent: "sakura" };
const RECT = { left: 100, top: 50, width: 800, height: 600 };

let canvases: ReturnType<typeof stubCanvas>;
let tokens: ReturnType<typeof stubPetalTokens>;
const engines: PetalEngine[] = [];

interface Rig {
  engine: PetalEngine;
  canvas: HTMLCanvasElement;
  host: HTMLDivElement;
  frames: ManualFrames;
  downgrades: PetalDowngrade[];
  ctx(): FakeContext;
}

function rig(inputs: Partial<PetalInputs> = {}, rect = RECT): Rig {
  const host = document.createElement("div");
  const canvas = document.createElement("canvas");
  host.append(canvas);
  document.body.append(host);
  setRect(canvas, rect);
  const frames = manualFrames();
  const downgrades: PetalDowngrade[] = [];
  let t = 0;
  const engine = new PetalEngine({
    canvas,
    host,
    inputs: { ...BASE, ...inputs },
    onDowngrade: (e) => downgrades.push(e),
    random: createRandom(SEED),
    scheduler: frames,
    // 每次读时钟前进 0.25 ms：一帧读两次，帧耗时恒为 0.25 ms
    clock: () => (t += 0.25),
  });
  engines.push(engine);
  return { engine, canvas, host, frames, downgrades, ctx: () => canvases.contextOf(canvas) };
}

/** 从 start 起每 interval 毫秒跑一帧，直到 end（含）。返回最后一帧的时间。 */
function runFrames(frames: ManualFrames, start: number, end: number, interval: number): number {
  let now = start;
  for (; now <= end; now += interval) frames.run(now);
  return now - interval;
}

function lastFrame(r: Rig) {
  const all = r.ctx().frames();
  return all[all.length - 1];
}

beforeEach(() => {
  canvases = stubCanvas();
  tokens = stubPetalTokens();
  vi.stubGlobal("devicePixelRatio", 1);
});

afterEach(() => {
  for (const e of engines.splice(0)) e.destroy();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("播放", () => {
  it("挂载即按 CSS 尺寸建后备缓冲、铺满花瓣并开始 rAF；首帧之前没有耗时统计", () => {
    const r = rig();
    r.engine.measure();
    expect([r.canvas.width, r.canvas.height]).toEqual([800, 600]);
    expect(r.frames.pending()).toBe(1);
    expect(r.engine.stats()).toEqual({ running: true, level: 0, count: 16, avgFrameMs: null, drawIntervalMedianMs: null });
    r.frames.run(1000);
    const frame = lastFrame(r);
    expect(frame.alphas).toEqual([0.4, 0.65, 0.9]);
    expect(frame.draws.length).toBeGreaterThan(10);
    expect(frame.draws.length).toBeLessThanOrEqual(16);
    expect(r.ctx().imageSmoothingEnabled).toBe(true);
    expect(r.engine.stats().avgFrameMs).toBe(0.25);
    expect(r.frames.pending()).toBe(1);
  });

  it("侧对视线（|cos(flip)| < 0.06）的花瓣这一帧不画", () => {
    const r = rig({ tier: "wide" });
    r.engine.measure();
    runFrames(r.frames, 1000, 1000 + 16 * 300, 16);
    const frames = r.ctx().frames();
    const draws = frames.flatMap((f) => f.draws);
    // 绘制变换的第一列是 cos(rot)·cos(flip)、sin(rot)·cos(flip)，模长即 |cos(flip)|
    for (const d of draws) expect(Math.hypot(d.transform[0], d.transform[1])).toBeGreaterThanOrEqual(0.06);
    expect(frames.some((f) => f.draws.length < 26)).toBe(true);
    expect(frames.every((f) => f.draws.length <= 26)).toBe(true);
  });

  it("夜樱下三层不透明度乘 0.8", () => {
    const r = rig({ mode: "night" });
    r.engine.measure();
    r.frames.run(1000);
    lastFrame(r).alphas.forEach((a, i) => expect(a).toBeCloseTo([0.32, 0.52, 0.72][i], 10));
  });

  it("两次绘制间隔不足 12 ms 的帧跳过，120 Hz 下隔帧绘制", () => {
    const r = rig();
    r.engine.measure();
    r.frames.run(1000);
    const frames = () => r.ctx().frames().length;
    expect(frames()).toBe(1);
    r.frames.run(1008.3);
    expect(frames()).toBe(1);
    r.frames.run(1016.7);
    expect(frames()).toBe(2);
    r.frames.run(1025);
    expect(frames()).toBe(2);
    r.frames.run(1033.3);
    expect(frames()).toBe(3);
    // 跳过的帧照样续约 rAF
    expect(r.frames.pending()).toBe(1);
  });

  it("精灵就是设备像素尺寸、以中心为锚点；超过 400 万像素时降低有效像素比", () => {
    vi.stubGlobal("devicePixelRatio", 1.25);
    const r = rig();
    r.engine.measure();
    expect([r.canvas.width, r.canvas.height]).toEqual([1000, 750]);
    r.frames.run(1000);
    for (const d of lastFrame(r).draws) {
      // 像素单元 round(2 × 1.25) = 3 个设备像素
      expect(d.width % 3).toBe(0);
      expect(d.height % 3).toBe(0);
      expect([d.x, d.y]).toEqual([-d.width / 2, -d.height / 2]);
    }

    vi.stubGlobal("devicePixelRatio", 2);
    const big = rig({}, { left: 0, top: 0, width: 3000, height: 2000 });
    big.engine.measure();
    expect(effectiveDpr(2, 3000, 2000)).toBeCloseTo(Math.sqrt(4_000_000 / 6_000_000), 12);
    expect([big.canvas.width, big.canvas.height]).toEqual([2449, 1633]);
    expect(big.canvas.width * big.canvas.height).toBeLessThanOrEqual(4_000_000);
    expect(effectiveDpr(3, 800, 600)).toBe(2);
  });

  it("画布尺寸为 0 时不生成花瓣也不跑 rAF，有了尺寸再开始", () => {
    const r = rig({}, { left: 0, top: 0, width: 0, height: 0 });
    r.engine.measure();
    expect(r.frames.pending()).toBe(0);
    expect(r.engine.stats().count).toBe(0);
    setRect(r.canvas, RECT);
    r.engine.measure();
    expect(r.frames.pending()).toBe(1);
    expect(r.engine.stats().count).toBe(16);
  });
});

describe("暂停与恢复", () => {
  it("暂停即取消 rAF、画布保留当前画面；恢复后首帧 dt 为 0，此后与从未暂停的同种子引擎逐帧一致", () => {
    const a = rig();
    const b = rig();
    a.engine.measure();
    b.engine.measure();
    a.frames.run(1000);
    a.frames.run(1016);
    b.frames.run(1000);
    b.frames.run(1016);
    const beforePause = lastFrame(a);

    a.engine.update({ ...BASE, paused: true });
    expect(a.frames.pending()).toBe(0);
    expect(a.frames.cancelled()).toHaveLength(1);
    expect(a.engine.stats().running).toBe(false);
    // 暂停时补画的一帧与暂停前最后一帧完全相同
    expect(lastFrame(a)).toEqual(beforePause);

    a.engine.update(BASE);
    expect(a.frames.pending()).toBe(1);
    a.frames.run(61_000);
    expect(lastFrame(a)).toEqual(beforePause);
    a.frames.run(61_016);
    a.frames.run(61_032);
    b.frames.run(1032);
    b.frames.run(1048);
    expect(lastFrame(a)).toEqual(lastFrame(b));
  });

  it("暂停中尺寸变化立即按新尺寸重画一帧", () => {
    const r = rig({ paused: true });
    r.engine.measure();
    expect(r.frames.pending()).toBe(0);
    const drawn = r.ctx().frames().length;
    expect(drawn).toBe(1);
    setRect(r.canvas, { ...RECT, width: 1000 });
    r.engine.measure();
    expect(r.canvas.width).toBe(1000);
    expect(r.ctx().frames()).toHaveLength(2);
    expect(lastFrame(r).draws.length).toBeGreaterThan(0);
  });

  it("档位变化按层增删花瓣", () => {
    const r = rig();
    r.engine.measure();
    r.engine.update({ ...BASE, tier: "wide" });
    expect(r.engine.stats().count).toBe(26);
    r.engine.update({ ...BASE, tier: "regular" });
    expect(r.engine.stats().count).toBe(20);
  });
});

describe("指针推开", () => {
  it("内容区上的指针推开附近花瓣，离开后按原轨迹恢复；pointermove 里不读布局", () => {
    const a = rig({ tier: "wide" });
    const b = rig({ tier: "wide" });
    a.engine.measure();
    b.engine.measure();
    a.frames.run(1000);
    b.frames.run(1000);
    expect(lastFrame(a)).toEqual(lastFrame(b));
    // 瞄准近景层最后一片：指针放在它正下方 20 px
    const target = lastFrame(a).draws.length - 1;
    const [, , , , x, y] = lastFrame(a).draws[target].transform;
    const rectReads = vi.spyOn(a.canvas, "getBoundingClientRect");
    a.host.dispatchEvent(new MouseEvent("pointermove", { clientX: x + RECT.left, clientY: y + 20 + RECT.top }));
    expect(rectReads).not.toHaveBeenCalled();
    let now = 1000;
    for (let i = 0; i < 10; i++) {
      now += 16;
      a.frames.run(now);
      b.frames.run(now);
    }
    // 指针在花瓣下方：花瓣被向上推开
    const pushedDraws = lastFrame(a).draws;
    const freeDraws = lastFrame(b).draws;
    expect(pushedDraws).toHaveLength(freeDraws.length);
    const lift = Math.max(...pushedDraws.map((d, i) => freeDraws[i].transform[5] - d.transform[5]));
    expect(lift).toBeGreaterThan(5);

    a.host.dispatchEvent(new MouseEvent("pointerleave"));
    for (let i = 0; i < 200; i++) {
      now += 16;
      a.frames.run(now);
      b.frames.run(now);
    }
    const fa = lastFrame(a).draws;
    const fb = lastFrame(b).draws;
    expect(fa).toHaveLength(fb.length);
    fa.forEach((d, i) => {
      expect(Math.abs(d.transform[4] - fb[i].transform[4])).toBeLessThan(0.05);
      expect(Math.abs(d.transform[5] - fb[i].transform[5])).toBeLessThan(0.05);
    });
  });

  it("暂停时视为没有指针", () => {
    const a = rig();
    const b = rig();
    a.engine.measure();
    b.engine.measure();
    a.frames.run(1000);
    b.frames.run(1000);
    const [, , , , x, y] = lastFrame(a).draws[0].transform;
    a.host.dispatchEvent(new MouseEvent("pointermove", { clientX: x + RECT.left + 10, clientY: y + RECT.top }));
    a.engine.update({ ...BASE, paused: true });
    a.engine.update(BASE);
    // 恢复后的首帧 dt 为 0，补跑一次同时刻的帧让两个引擎对齐
    a.frames.run(1000);
    let now = 1000;
    for (let i = 0; i < 6; i++) {
      now += 16;
      a.frames.run(now);
      b.frames.run(now);
    }
    expect(lastFrame(a)).toEqual(lastFrame(b));
  });
});

describe("减少动画", () => {
  it("不启动 rAF、不监听指针，只画一帧静态散落，数量同档位", () => {
    const host = document.createElement("div");
    const listen = vi.spyOn(host, "addEventListener");
    const canvas = document.createElement("canvas");
    host.append(canvas);
    document.body.append(host);
    setRect(canvas, RECT);
    const frames = manualFrames();
    const engine = new PetalEngine({ canvas, host, inputs: { ...BASE, reduced: true }, onDowngrade: () => {}, random: createRandom(SEED), scheduler: frames });
    engines.push(engine);
    engine.measure();
    expect(frames.pending()).toBe(0);
    expect(listen).not.toHaveBeenCalled();
    const drawn = canvases.contextOf(canvas).frames();
    expect(drawn).toHaveLength(1);
    expect(drawn[0].draws).toHaveLength(16);
    expect(engine.stats()).toMatchObject({ running: false, count: 16, avgFrameMs: null });
  });

  it("尺寸变化防抖 100 ms 后按新尺寸重画，位置按比例保持", () => {
    vi.useFakeTimers();
    const r = rig({ reduced: true });
    r.engine.measure();
    const first = lastFrame(r).draws.map((d) => d.transform[4]);
    setRect(r.canvas, { ...RECT, width: 1200 });
    r.engine.measure();
    vi.advanceTimersByTime(STILL_RESIZE_DEBOUNCE_MS - 1);
    expect(r.canvas.width).toBe(800);
    expect(r.ctx().frames()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(r.canvas.width).toBe(1200);
    expect(r.ctx().frames()).toHaveLength(2);
    lastFrame(r).draws.forEach((d, i) => expect(d.transform[4]).toBeCloseTo(first[i] * 1.5, 8));
  });

  it("外观变化重建精灵并立即重画；关掉减少动画后恢复播放并开始监听指针", () => {
    const r = rig({ reduced: true });
    const listen = vi.spyOn(r.host, "addEventListener");
    r.engine.measure();
    const builtBefore = canvases.created();
    const readsBefore = tokens.reads();
    r.engine.update({ ...BASE, reduced: true, mode: "night" });
    expect(canvases.created() - builtBefore).toBe(15);
    expect(tokens.reads() - readsBefore).toBe(5);
    expect(r.ctx().frames()).toHaveLength(2);
    lastFrame(r).alphas.forEach((a, i) => expect(a).toBeCloseTo([0.32, 0.52, 0.72][i], 10));
    // 同一外观再次更新不重建
    r.engine.update({ ...BASE, reduced: true, mode: "night" });
    expect(canvases.created() - builtBefore).toBe(15);

    r.engine.update({ ...BASE, mode: "night" });
    expect(r.frames.pending()).toBe(1);
    expect(listen.mock.calls.map((c) => c[0])).toEqual(["pointermove", "pointerleave"]);
    expect(listen.mock.calls[0][2]).toEqual({ passive: true });
  });
});

describe("自动降级", () => {
  it("连续两窗中位数 > 28 ms 降一级：去掉远景、中景减半；再两窗降到静态散落并停掉 rAF 与指针", () => {
    const r = rig({ tier: "wide" });
    const unlisten = vi.spyOn(r.host, "removeEventListener");
    r.engine.measure();
    expect(r.engine.stats().count).toBe(26);
    let now = runFrames(r.frames, 1000, 6000, 40);
    expect(r.downgrades).toEqual([{ tier: "wide", level: 1, windowMediansMs: [40, 40] }]);
    expect(r.engine.stats()).toMatchObject({ running: true, level: 1, count: 12, drawIntervalMedianMs: 40 });
    r.frames.run((now += 40));
    // P5 碎瓣（6 px）只出现在远景层
    expect(lastFrame(r).draws.length).toBeLessThanOrEqual(12);
    expect(lastFrame(r).draws.some((d) => d.width === 6)).toBe(false);
    expect(r.ctx().frames()[0].draws.some((d) => d.width === 6)).toBe(true);

    runFrames(r.frames, now + 40, 10_000, 40);
    expect(r.downgrades.map((d) => d.level)).toEqual([1, 2]);
    expect(r.downgrades[1]).toEqual({ tier: "wide", level: 2, windowMediansMs: [40, 40] });
    expect(r.frames.pending()).toBe(0);
    expect(r.engine.stats()).toMatchObject({ running: false, level: 2, count: 26 });
    expect(lastFrame(r).draws).toHaveLength(26);
    expect(unlisten.mock.calls.map((c) => c[0])).toEqual(["pointermove", "pointerleave"]);
    // 降到静态后关掉暂停、切换档位都不会重新开始播放
    r.engine.update({ ...BASE, tier: "regular" });
    expect(r.frames.pending()).toBe(0);
    expect(r.engine.stats().count).toBe(20);
  });

  it("帧率正常时不降级", () => {
    const r = rig({ tier: "wide" });
    r.engine.measure();
    runFrames(r.frames, 1000, 12_000, 16);
    expect(r.downgrades).toEqual([]);
    expect(r.engine.stats()).toMatchObject({ running: true, level: 0, count: 26, drawIntervalMedianMs: 16 });
  });
});

describe("销毁与诊断", () => {
  it("销毁后取消 rAF、移除指针监听，诊断回到上一个仍存活的引擎", () => {
    const first = rig({ tier: "regular" });
    first.engine.measure();
    const second = rig({ tier: "wide" });
    const unlisten = vi.spyOn(second.host, "removeEventListener");
    second.engine.measure();
    expect(currentPetalStats()?.count).toBe(26);
    second.engine.destroy();
    expect(second.frames.pending()).toBe(0);
    expect(unlisten.mock.calls.map((c) => c[0])).toEqual(["pointermove", "pointerleave"]);
    expect(currentPetalStats()?.count).toBe(20);
    second.engine.measure();
    second.engine.update({ ...BASE, tier: "compact" });
    expect(second.frames.pending()).toBe(0);
    first.engine.destroy();
    expect(currentPetalStats()).toBeNull();
  });

  it("拿不到 2D 上下文时报错", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const canvas = document.createElement("canvas");
    expect(() => new PetalEngine({ canvas, host: document.body, inputs: BASE, onDowngrade: () => {}, random: Math.random })).toThrow("2D 上下文");
  });
});
