// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ambientFade, springAt, tweenAt } from "../../lib/motion";
import { setRect } from "../../test/dom";
import { PetalEngine, STILL_RESIZE_DEBOUNCE_MS, currentPetalStats, effectiveDpr, type PetalDowngrade, type PetalInputs } from "./engine";
import { EDGE_ON, LAYERS, STILL_SCALE_MIN, createRandom } from "./sim";
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

/** 按 hz 的刷新率放 durationMs 毫秒，时间戳按帧序号现算，不累加浮点误差。返回这段时间的实际绘制帧数。 */
function playAt(r: Rig, hz: number, start: number, durationMs: number): number {
  const drawnBefore = r.ctx().frames().length;
  const count = Math.round((durationMs * hz) / 1000);
  for (let i = 0; i < count; i++) r.frames.run(start + (i * 1000) / hz);
  return r.ctx().frames().length - drawnBefore;
}

function lastFrame(r: Rig) {
  const all = r.ctx().frames();
  return all[all.length - 1];
}

type Draw = ReturnType<typeof lastFrame>["draws"][number];

/** 按层的满不透明度画的（定格留下的），区别于正在淡入的补投花瓣。 */
const solid = (d: Draw) => d.alpha === 0.4 || d.alpha === 0.65 || d.alpha === 0.9;
const pose = (d: Draw) => d.transform.map((v) => v.toFixed(6)).join(",");
/** 只看位置与自转角：变换的后四项是 −sin、cos 与平移，不含翻面缩放。 */
const place = (d: Draw) => d.transform.slice(2).map((v) => v.toFixed(6)).join(",");
/** 绘制变换 [cos·sx, sin·sx, −sin, cos, x, y] 的行列式就是带符号的翻面缩放 sx。 */
const sxOf = (d: Draw) => d.transform[0] * d.transform[3] - d.transform[1] * d.transform[2];

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

  it("120 Hz 下隔帧绘制，跳过的帧照样续约 rAF", () => {
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
    expect(r.frames.pending()).toBe(1);
  });

  it.each([75, 90, 100, 120, 144, 165, 240, 360])("%i Hz 屏上绘制限到约 60 帧", (hz) => {
    const r = rig();
    r.engine.measure();
    const drawn = playAt(r, hz, 1000, 10_000);
    expect(drawn / 10).toBeGreaterThanOrEqual(59);
    expect(drawn / 10).toBeLessThanOrEqual(63);
  });

  it("60 Hz 屏每帧都画，时间戳抖动不会掉成隔帧", () => {
    const r = rig();
    r.engine.measure();
    expect(playAt(r, 60, 1000, 10_000)).toBe(600);

    const jittered = rig();
    jittered.engine.measure();
    const drawnBefore = jittered.ctx().frames().length;
    for (let i = 0; i < 600; i++) jittered.frames.run(1000 + (i * 1000) / 60 + (i % 2 === 0 ? 0.3 : -0.3));
    expect(jittered.ctx().frames().length - drawnBefore).toBe(600);
  });

  it.each([120, 144, 240, 360])("%i Hz 屏上花瓣走过的路程与 60 Hz 相同：限帧不改变动画速度", (hz) => {
    // 画布够高，两秒内没有花瓣落出底边：回收发生在绘制帧上，会让不同帧率的两边分叉
    const tall = { left: 0, top: 0, width: 800, height: 5000 };
    const slow = rig({ tier: "wide" }, tall);
    const fast = rig({ tier: "wide" }, tall);
    slow.engine.measure();
    fast.engine.measure();
    playAt(slow, 60, 1000, 2000);
    playAt(fast, hz, 1000, 2000);
    // 收尾这一帧隔开一个节拍以上，两边都在同一时刻实际绘制，模拟时钟才可以逐片比对
    slow.frames.run(3020);
    fast.frames.run(3020);
    const expected = lastFrame(slow).draws;
    const actual = lastFrame(fast).draws;
    expect(actual).toHaveLength(expected.length);
    actual.forEach((d, i) => {
      for (let m = 0; m < 6; m++) expect(d.transform[m]).toBeCloseTo(expected[i].transform[m], 6);
    });
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

  it("播放中尺寸变化：后备缓冲一清空就按当前时刻重画一帧，不等下一拍", () => {
    const r = rig();
    r.engine.measure();
    r.frames.run(1000);
    r.frames.run(1016);
    const before = lastFrame(r);
    setRect(r.canvas, { ...RECT, height: 700 });
    r.engine.measure();
    expect([r.canvas.width, r.canvas.height]).toEqual([800, 700]);
    expect(r.ctx().frames()).toHaveLength(3);
    expect(r.ctx().ops.filter((op) => op.kind === "clear").at(-1)).toEqual({ kind: "clear", width: 800, height: 700 });
    // 同一时刻的画面：没有往下落、没有自转，只是画到了新的后备缓冲上
    expect(lastFrame(r).draws.map((d) => d.transform)).toEqual(before.draws.map((d) => d.transform));
    expect(r.frames.pending()).toBe(1);
    expect(r.engine.stats().running).toBe(true);
  });

  it("播放中像素比变化：立即按新像素比重画，精灵换成新的像素单元", () => {
    const r = rig();
    r.engine.measure();
    r.frames.run(1000);
    const before = lastFrame(r);
    vi.stubGlobal("devicePixelRatio", 1.5);
    r.engine.measure();
    expect([r.canvas.width, r.canvas.height]).toEqual([1200, 900]);
    expect(r.ctx().frames()).toHaveLength(2);
    const after = lastFrame(r).draws;
    expect(after).toHaveLength(before.draws.length);
    after.forEach((d, i) => {
      // 像素单元 round(2 × 1.5) = 3 个设备像素；位置按像素比放大
      expect(d.width % 3).toBe(0);
      expect(d.transform[4]).toBeCloseTo(before.draws[i].transform[4] * 1.5, 8);
      expect(d.transform[5]).toBeCloseTo(before.draws[i].transform[5] * 1.5, 8);
    });
  });

  it("尺寸没变的观察回调不清空画布，也不额外重画", () => {
    const r = rig();
    r.engine.measure();
    r.frames.run(1000);
    r.engine.measure();
    r.engine.measure();
    expect(r.ctx().frames()).toHaveLength(1);
    expect(r.frames.pending()).toBe(1);
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
    // 裁下的花瓣淡完（200 ms）之后不再画；P5 碎瓣（6 px）只出现在远景层
    now = runFrames(r.frames, now + 40, now + 280, 40);
    expect(lastFrame(r).draws.length).toBeLessThanOrEqual(12);
    expect(lastFrame(r).draws.some((d) => d.width === 6)).toBe(false);
    expect(r.ctx().frames()[0].draws.some((d) => d.width === 6)).toBe(true);

    runFrames(r.frames, now + 40, 10_000, 40);
    expect(r.downgrades.map((d) => d.level)).toEqual([1, 2]);
    expect(r.downgrades[1]).toEqual({ tier: "wide", level: 2, windowMediansMs: [40, 40] });
    expect(r.engine.stats()).toMatchObject({ running: false, level: 2, count: 26 });
    expect(unlisten.mock.calls.map((c) => c[0])).toEqual(["pointermove", "pointerleave"]);
    // 补投的花瓣淡入完，之后再没有任何帧回调
    r.frames.run(10_016);
    r.frames.run(10_016 + 480);
    expect(r.frames.pending()).toBe(0);
    expect(lastFrame(r).draws).toHaveLength(26);
    // 降到静态后关掉暂停、切换档位都不会重新开始播放
    r.engine.update({ ...BASE, tier: "regular" });
    expect(r.frames.pending()).toBe(0);
    expect(r.engine.stats().count).toBe(20);
  });

  it("一级降级裁下的花瓣不在半空消失：照常飘着，按环境层的退场曲线淡出，淡完才移除", () => {
    const r = rig({ tier: "wide" });
    r.engine.measure();
    let now = runFrames(r.frames, 1000, 6000, 40);
    expect(r.engine.stats()).toMatchObject({ level: 1, count: 12 });
    r.frames.run((now += 40));
    const first = lastFrame(r);
    const k1 = 1 - tweenAt(ambientFade.out, 0.04);
    // 每层先画留下的、再画同层裁下的：远景（留下的已空）、远景裁下、中景、中景裁下、近景
    expect(first.alphas).toHaveLength(5);
    [0.4, 0.4 * k1, 0.65, 0.65 * k1, 0.9].forEach((a, i) => expect(first.alphas[i]).toBeCloseTo(a, 3));
    const leaving = first.draws.filter((d) => d.alpha !== 0.65 && d.alpha !== 0.9);
    expect(leaving.length).toBeGreaterThan(0);
    expect(first.draws.length - leaving.length).toBeLessThanOrEqual(12);
    expect(leaving.some((d) => d.width === 6)).toBe(true);

    r.frames.run((now += 40));
    r.frames.run((now += 40));
    expect(lastFrame(r).alphas[1]).toBeCloseTo(0.4 * (1 - tweenAt(ambientFade.out, 0.12)), 3);
    expect(lastFrame(r).alphas[1]).toBeLessThan(first.alphas[1]);

    runFrames(r.frames, now + 40, now + 160, 40);
    expect(lastFrame(r).alphas).toEqual([0.4, 0.65, 0.9]);
    expect(lastFrame(r).draws.length).toBeLessThanOrEqual(12);
    expect(r.engine.stats().count).toBe(12);
  });

  it("二级降级原地定格：花瓣停在这一拍画出的位姿上，补投的 480 ms 淡入，淡完停掉帧回调", () => {
    const r = rig({ tier: "wide" });
    r.engine.measure();
    runFrames(r.frames, 1000, 10_000, 40);
    expect(r.engine.stats()).toMatchObject({ running: false, level: 2, count: 26 });
    const all = r.ctx().frames();
    // 10000 这一拍先照常飘落着画了一帧，降级后立即补画定格的静态散落
    const moving = all[all.length - 2].draws;
    const frozen = all[all.length - 1];
    const kept = frozen.draws.filter(solid);
    const added = frozen.draws.filter((d) => !solid(d));
    expect(kept.length).toBeGreaterThan(6);
    expect(added.length).toBe(26 - kept.length);
    for (const d of added) expect(d.alpha).toBe(0);
    // 定格的每一片都与这一拍画出的某一片位姿完全相同：不重新抽取，不跳
    const movingPoses = new Set(moving.map(pose));
    for (const d of kept) expect(movingPoses.has(pose(d))).toBe(true);
    expect(r.frames.pending()).toBe(1);

    r.frames.run(10_016);
    r.frames.run(10_016 + 240);
    const mid = lastFrame(r);
    const k = tweenAt(ambientFade.in, 0.24);
    const arriving = mid.draws.filter((d) => !solid(d));
    expect(arriving.map(pose)).toEqual(added.map(pose));
    for (const d of arriving) expect([0.4 * k, 0.65 * k, 0.9 * k].some((a) => Math.abs(a - d.alpha) < 1e-9)).toBe(true);
    // 位置与自转角原地不动；翻面够宽的连姿态都不变（窄的那几片在转向，见下一条）
    expect(mid.draws.filter(solid).map(place)).toEqual(kept.map(place));
    const wide = kept.filter((d) => Math.abs(sxOf(d)) >= STILL_SCALE_MIN).map(pose);
    expect(wide.length).toBeGreaterThan(0);
    expect(mid.draws.filter(solid).map(pose)).toEqual(expect.arrayContaining(wide));

    r.frames.run(10_016 + 480);
    expect(r.frames.pending()).toBe(0);
    const done = lastFrame(r);
    expect(done.alphas).toEqual([0.4, 0.65, 0.9]);
    expect(done.draws).toHaveLength(26);
    expect(done.draws.map(place).sort()).toEqual([...kept, ...added].map(place).sort());
  });

  it("二级降级时比静态散落下限窄的花瓣：定格那一帧不跳，随后沿 settle 弹簧转到下限，正负号不变", () => {
    const r = rig({ tier: "wide" });
    r.engine.measure();
    runFrames(r.frames, 1000, 10_000, 40);
    const frozen = lastFrame(r).draws.filter(solid);
    const narrow = frozen.filter((d) => Math.abs(sxOf(d)) < STILL_SCALE_MIN);
    // 翻面相位均匀分布，26 片里总有几片正侧着身
    expect(narrow.length).toBeGreaterThan(0);
    const at = (draws: Draw[], d: Draw) => {
      const found = draws.find((e) => place(e) === place(d));
      if (found === undefined) throw new Error("这一帧里找不到定格的那片花瓣");
      return found;
    };

    const target = (d: Draw) => Math.sign(sxOf(d)) * STILL_SCALE_MIN;
    // 离下限还远的几片：一拍之内翻面速度再大也转不到（不是一步跳过去的）
    const far = narrow.filter((d) => Math.abs(sxOf(d) - target(d)) >= 0.05);
    expect(far.length).toBeGreaterThan(0);

    // 收尾的第一帧取起点，仍是定格姿态；再过一拍已经在转、还没到；半程时已基本落定（不是憋到最后才跳）
    r.frames.run(10_016);
    for (const d of narrow) expect(sxOf(at(lastFrame(r).draws, d))).toBeCloseTo(sxOf(d), 12);
    r.frames.run(10_032);
    for (const d of far) expect(Math.abs(sxOf(at(lastFrame(r).draws, d)) - target(d))).toBeGreaterThan(1e-3);
    r.frames.run(10_016 + 240);
    for (const d of narrow) expect(Math.abs(sxOf(at(lastFrame(r).draws, d)) - target(d))).toBeLessThan(0.01);

    r.frames.run(10_016 + 480);
    expect(r.frames.pending()).toBe(0);
    const done = lastFrame(r).draws;
    for (const d of done) expect(Math.abs(sxOf(d))).toBeGreaterThanOrEqual(STILL_SCALE_MIN - 1e-9);
    for (const d of narrow) expect(sxOf(at(done, d))).toBeCloseTo(Math.sign(sxOf(d)) * STILL_SCALE_MIN, 12);
  });

  it("收尾在淡入的时长里播完：最窄、翻得最快的花瓣转到下限时 settle 弹簧也已落定，最后一帧不跳", () => {
    const fastest = Math.max(...LAYERS.map((l) => l.flipW[1]));
    for (const v0 of [fastest, -fastest]) expect(Math.abs(springAt("settle", EDGE_ON - STILL_SCALE_MIN, v0, ambientFade.in.duration).x)).toBeLessThan(1e-3);
  });

  it("收尾途中打开减少动画：补投的淡入与窄花瓣的转向直接到位，不留帧回调", () => {
    const r = rig({ tier: "wide" });
    r.engine.measure();
    runFrames(r.frames, 1000, 10_000, 40);
    r.frames.run(10_016);
    r.frames.run(10_032);
    expect(r.frames.pending()).toBe(1);
    r.engine.update({ ...BASE, tier: "wide", reduced: true });
    expect(r.frames.pending()).toBe(0);
    const done = lastFrame(r);
    expect(done.alphas).toEqual([0.4, 0.65, 0.9]);
    expect(done.draws).toHaveLength(26);
    for (const d of done.draws) expect(Math.abs(sxOf(d))).toBeGreaterThanOrEqual(STILL_SCALE_MIN - 1e-9);
  });

  it("补投的花瓣淡入中暂停或销毁：直接到位，不留帧回调", () => {
    const r = rig({ tier: "wide" });
    r.engine.measure();
    runFrames(r.frames, 1000, 10_000, 40);
    r.frames.run(10_016);
    expect(r.frames.pending()).toBe(1);
    r.engine.update({ ...BASE, tier: "wide", paused: true });
    expect(r.frames.pending()).toBe(0);
    expect(lastFrame(r).alphas).toEqual([0.4, 0.65, 0.9]);
    expect(lastFrame(r).draws).toHaveLength(26);
    r.engine.update({ ...BASE, tier: "wide" });
    expect(r.frames.pending()).toBe(0);

    const s = rig({ tier: "wide" });
    s.engine.measure();
    runFrames(s.frames, 1000, 10_000, 40);
    expect(s.frames.pending()).toBe(1);
    s.engine.destroy();
    expect(s.frames.pending()).toBe(0);
  });

  it("帧率正常时不降级", () => {
    const r = rig({ tier: "wide" });
    r.engine.measure();
    runFrames(r.frames, 1000, 12_000, 16);
    expect(r.downgrades).toEqual([]);
    expect(r.engine.stats()).toMatchObject({ running: true, level: 0, count: 26, drawIntervalMedianMs: 16 });
  });

  // 帧间隔略短于节拍的屏：从上次绘制起算时只能每两帧画一次，绘制间隔 28.6 ms，正好越过慢窗口的线
  it("70 Hz 屏不因限帧被判成慢窗口", () => {
    const r = rig({ tier: "wide" });
    r.engine.measure();
    playAt(r, 70, 1000, 12_000);
    expect(r.downgrades).toEqual([]);
    expect(r.engine.stats()).toMatchObject({ running: true, level: 0, count: 26 });
    expect(r.engine.stats().drawIntervalMedianMs).toBeCloseTo(1000 / 70, 6);
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
