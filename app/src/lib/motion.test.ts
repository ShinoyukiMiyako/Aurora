import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ambientFade, fade, insertItem, insertItemFade, pageItem, popMark, rootTransition, shake, SPRING_PARAMS, springAt, springs, stepPane, stepPaneFade, tabPanel, TOOLTIP_TIMING, tweenAt, twoParam, type PanelFrom, type SpringName } from "./motion";

const TOKENS = readFileSync(new URL("../styles/tokens.css", import.meta.url), "utf8");

function token(name: string): string {
  const line = TOKENS.split(/\r?\n/).find((l) => l.trim().startsWith(`${name}:`));
  if (!line) throw new Error(`tokens.css 缺少 ${name}`);
  return line.trim().slice(name.length + 1).trim().replace(/;$/, "");
}

/** 从 framer-motion 的物理参数反解两参弹簧：duration = 2π / √k，bounce = 1 − c / (2√k)。 */
function inverse(t: unknown): { duration: number; bounce: number; mass: number } {
  const { stiffness, damping, mass } = t as { stiffness: number; damping: number; mass: number };
  const omega = Math.sqrt(stiffness);
  return { duration: (2 * Math.PI) / omega, bounce: 1 - damping / (2 * omega), mass };
}

/** 两参弹簧从 0 到 1 的解析解（质量 1）。 */
function position(t: number, duration: number, bounce: number): number {
  const omega = (2 * Math.PI) / duration;
  const zeta = 1 - bounce;
  if (zeta >= 1) return 1 - Math.exp(-omega * t) * (1 + omega * t);
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * omega * t) * (Math.cos(wd * t) + ((zeta * omega) / wd) * Math.sin(wd * t));
}

/**
 * CSS linear() 近似的生成算法：时长取最后一次 |x − 1| > 0.002 的时刻（10 µs 步长扫描），向上取整到 10 ms；
 * 采样点数 round(时长 / 12) + 1，等时取样保留 3 位小数，末点固定为 1。
 */
function cssSpring(duration: number, bounce: number): { durationMs: number; linear: string } {
  let last = 0;
  for (let i = 0; i <= 200_000; i++) {
    const t = i * 1e-5;
    if (Math.abs(position(t, duration, bounce) - 1) > 0.002) last = t;
  }
  const durationMs = Math.ceil(last * 100) * 10;
  const n = Math.round(durationMs / 12) + 1;
  const values = Array.from({ length: n }, (_, i) =>
    i === n - 1 ? 1 : Number(position((i * durationMs) / (n - 1) / 1000, duration, bounce).toFixed(3)),
  );
  return { durationMs, linear: `linear(${values.join(", ")})` };
}

describe("弹簧预设", () => {
  it("六个预设的两参数值", () => {
    expect(SPRING_PARAMS).toEqual({
      tap: { duration: 0.22, bounce: 0 },
      settle: { duration: 0.26, bounce: 0.1 },
      pop: { duration: 0.32, bounce: 0.2 },
      soft: { duration: 0.34, bounce: 0.12 },
      morph: { duration: 0.35, bounce: 0.14 },
      base: { duration: 0.3, bounce: 0.35 },
    });
  });

  it.each(Object.keys(SPRING_PARAMS) as SpringName[])("%s 换算成物理弹簧后能反解回原参数", (name) => {
    const t = springs[name] as { type: string };
    expect(t.type).toBe("spring");
    const back = inverse(t);
    expect(back.mass).toBe(1);
    expect(back.duration).toBeCloseTo(SPRING_PARAMS[name].duration, 10);
    expect(back.bounce).toBeCloseTo(SPRING_PARAMS[name].bounce, 10);
  });

  it("具体数值：tap 刚度 (2π/0.22)²、阻尼 2·2π/0.22", () => {
    const t = twoParam(0.22, 0) as { stiffness: number; damping: number };
    expect(t.stiffness).toBeCloseTo(815.67, 2);
    expect(t.damping).toBeCloseTo(57.12, 2);
    const base = springs.base as { stiffness: number; damping: number };
    expect(base.stiffness).toBeCloseTo(438.65, 2);
    expect(base.damping).toBeCloseTo(27.23, 2);
  });

  it("不使用 duration / bounce 形式（中断时会丢继承速度）", () => {
    for (const t of Object.values(springs)) {
      expect(t).not.toHaveProperty("duration");
      expect(t).not.toHaveProperty("bounce");
    }
  });
});

describe("CSS 弹簧近似与动效令牌", () => {
  it.each([
    ["tap", 300],
    ["settle", 250],
    ["pop", 410],
  ] as const)("--sk-spring-%s 与解析解逐点一致，时长 %d ms", (name, expectedMs) => {
    const { duration, bounce } = SPRING_PARAMS[name];
    const generated = cssSpring(duration, bounce);
    expect(generated.durationMs).toBe(expectedMs);
    expect(token(`--sk-spring-${name}-dur`)).toBe(`${expectedMs}ms`);
    expect(token(`--sk-spring-${name}`)).toBe(generated.linear);
  });

  it("补间与 CSS 令牌同值", () => {
    expect(token("--sk-ease-out")).toBe(`cubic-bezier(${fade.in.ease.join(", ")})`);
    expect(token("--sk-ease-in")).toBe(`cubic-bezier(${fade.out.ease.join(", ")})`);
    expect(token("--sk-dur-in")).toBe(`${fade.in.duration * 1000}ms`);
    expect(token("--sk-dur-out")).toBe(`${fade.out.duration * 1000}ms`);
  });

  it("环境层显隐：入 480 ms 走淡入曲线，出 200 ms 走淡出曲线", () => {
    expect(ambientFade).toEqual({
      in: { duration: 0.48, ease: [0.16, 1, 0.3, 1] },
      out: { duration: 0.2, ease: [0.4, 0, 1, 1] },
    });
    expect(ambientFade.in.ease).toBe(fade.in.ease);
    expect(ambientFade.out.ease).toBe(fade.out.ease);
  });

  it("tweenAt：按补间自己的时长与缓动曲线给进度，两端钳在 0 与 1", () => {
    expect(tweenAt(ambientFade.in, -0.1)).toBe(0);
    expect(tweenAt(ambientFade.in, 0)).toBe(0);
    expect(tweenAt(ambientFade.in, 0.48)).toBe(1);
    expect(tweenAt(ambientFade.in, 3)).toBe(1);
    // 三次贝塞尔的参数式：x(s) 是时间占比，y(s) 是进度
    const bezier = (a: number, b: number, s: number) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
    for (const tween of [ambientFade.in, ambientFade.out, fade.in]) {
      const [x1, y1, x2, y2] = tween.ease;
      for (const s of [0.1, 0.35, 0.6, 0.9]) expect(tweenAt(tween, bezier(x1, x2, s) * tween.duration)).toBeCloseTo(bezier(y1, y2, s), 2);
    }
    // 淡入前快后慢，过一半时间已走完九成；淡出前慢后快，过一半时间还不到四成
    expect(tweenAt(ambientFade.in, 0.24)).toBeGreaterThan(0.9);
    expect(tweenAt(ambientFade.out, 0.1)).toBeLessThan(0.4);
  });
});

describe("springAt：带初值的解析解", () => {
  const NAMES: SpringName[] = ["tap", "settle", "pop", "soft", "morph", "base"];

  it.each(NAMES)("%s：从 -1 静止出发，与 0 到 1 的阶跃解只差一个平移", (name) => {
    const { duration, bounce } = SPRING_PARAMS[name];
    for (const t of [0, 0.01, 0.05, 0.12, 0.3, 0.6]) {
      expect(springAt(name, -1, 0, t).x).toBeCloseTo(position(t, duration, bounce) - 1, 9);
    }
  });

  it.each(NAMES)("%s：t = 0 时原样给回初始位移与初速度", (name) => {
    const at = springAt(name, -120, 640, 0);
    expect(at.x).toBeCloseTo(-120, 9);
    expect(at.v).toBeCloseTo(640, 9);
  });

  it.each(NAMES)("%s：速度是位移对时间的导数", (name) => {
    const h = 1e-6;
    for (const t of [0.003, 0.04, 0.11, 0.25]) {
      const slope = (springAt(name, -80, 300, t + h).x - springAt(name, -80, 300, t - h).x) / (2 * h);
      expect(springAt(name, -80, 300, t).v).toBeCloseTo(slope, 3);
    }
  });

  it("途中接力：从某一刻的位移与速度重新出发，轨迹与不间断时相同", () => {
    const mid = springAt("settle", -120, 0, 0.05);
    const relay = springAt("settle", mid.x, mid.v, 0.07);
    const straight = springAt("settle", -120, 0, 0.12);
    expect(relay.x).toBeCloseTo(straight.x, 9);
    expect(relay.v).toBeCloseTo(straight.v, 9);
  });

  it("最终回到 0 并停住", () => {
    for (const name of NAMES) {
      const end = springAt(name, 300, -900, 2);
      expect(Math.abs(end.x)).toBeLessThan(1e-3);
      expect(Math.abs(end.v)).toBeLessThan(1e-2);
    }
  });
});

describe("变体与时机", () => {
  it("根过渡：位移走 base 弹簧，透明度走淡入补间", () => {
    expect(rootTransition).toEqual({ ...springs.base, opacity: fade.in });
  });

  it("页面区块从下方 6px 上移，第 i 项延迟 20 + min(i, 4) × 25 ms，120 ms 封顶", () => {
    expect(pageItem.hidden).toEqual({ opacity: 0, y: 6 });
    const show = pageItem.show as (i: number) => { y: number; transition: { delay: number; opacity: { delay: number } } };
    expect(show(0).y).toBe(0);
    expect(show(0).transition.delay).toBeCloseTo(0.02, 10);
    expect(show(1).transition.delay).toBeCloseTo(0.045, 10);
    expect(show(3).transition.delay).toBeCloseTo(0.095, 10);
    expect(show(4).transition.delay).toBeCloseTo(0.12, 10);
    expect(show(9).transition.delay).toBeCloseTo(0.12, 10);
  });

  it("页面区块的透明度与位移同一个延迟：按值指定的 opacity 过渡不继承根上的 delay，必须自己带", () => {
    const show = pageItem.show as (i: number) => { transition: Record<string, unknown> & { delay: number; opacity: Record<string, unknown> } };
    for (const i of [0, 1, 2, 3, 4, 7]) {
      const { transition } = show(i);
      expect(transition.opacity).toEqual({ ...fade.in, delay: transition.delay });
      expect(transition.opacity.delay).toBeGreaterThan(0);
    }
    const second = show(2).transition;
    expect(second.opacity.delay).toBeCloseTo(0.07, 10);
    expect(second).toEqual({ ...springs.soft, delay: second.delay, opacity: { ...fade.in, delay: second.delay } });
  });

  it("面板变体与页面区块同名，子元素才接得住编排", () => {
    expect(Object.keys(tabPanel).sort()).toEqual(Object.keys(pageItem).sort());
  });

  it("面板来向：不传时从下方 6px，横排标签按方向从左右 8px，竖排分区按方向从上下 6px", () => {
    const hidden = tabPanel.hidden as (from: PanelFrom | undefined) => Record<string, number>;
    expect(hidden(undefined)).toEqual({ opacity: 0, y: 6 });
    expect(hidden({ axis: "x", dir: 1 })).toEqual({ opacity: 0, x: 8 });
    expect(hidden({ axis: "x", dir: -1 })).toEqual({ opacity: 0, x: -8 });
    expect(hidden({ axis: "y", dir: 1 })).toEqual({ opacity: 0, y: 6 });
    expect(hidden({ axis: "y", dir: -1 })).toEqual({ opacity: 0, y: -6 });
    // 落定时两个方向都回到 0：上一块面板从哪一侧进来，不影响这一块
    expect(tabPanel.show).toEqual({ opacity: 1, x: 0, y: 0, transition: { ...springs.settle, opacity: fade.in } });
  });

  it("否定抖动每段走淡入的令牌曲线", () => {
    expect(shake.transition).toEqual({ duration: 0.36, ease: fade.in.ease });
  });

  it("流内块增删：从 0.98 落到位走 settle，透明度走补间，退场只淡出不回弹", () => {
    expect(insertItem.initial).toEqual({ opacity: 0, scale: 0.98 });
    expect(insertItem.animate).toEqual({ opacity: 1, scale: 1, transition: { ...springs.settle, opacity: fade.in } });
    expect(insertItem.exit).toEqual({ opacity: 0, scale: 0.98, transition: fade.out });
  });

  it("小标记两档：点从 0 弹出、退场缩到 0.6；图形从 0.8 弹出、退场只淡出；入场都走 pop 加淡入补间", () => {
    const show = { opacity: 1, scale: 1, transition: { ...springs.pop, opacity: fade.in } };
    expect(popMark.dot).toEqual({ initial: { opacity: 0, scale: 0 }, animate: show, exit: { opacity: 0, scale: 0.6, transition: fade.out } });
    expect(popMark.glyph).toEqual({ initial: { opacity: 0, scale: 0.8 }, animate: show, exit: { opacity: 0, transition: fade.out } });
  });

  it("小标记的减少动画档只动透明度，进出都不带缩放", () => {
    expect(popMark.reduced).toEqual({ initial: { opacity: 0 }, animate: { opacity: 1, transition: fade.in }, exit: { opacity: 0, transition: fade.out } });
    for (const phase of Object.values(popMark.reduced)) expect(phase).not.toHaveProperty("scale");
  });

  it("向导换步：前进时新步骤从右侧 16px 进、旧步骤朝左 16px 退，后退反过来，方向为 0 只淡入淡出", () => {
    const enter = stepPane.enter as (dir: number) => Record<string, unknown>;
    const exit = stepPane.exit as (dir: number) => Record<string, unknown>;
    expect(enter(1)).toEqual({ opacity: 0, x: 16 });
    expect(exit(1)).toEqual({ opacity: 0, x: -16, transition: fade.out });
    expect(enter(-1)).toEqual({ opacity: 0, x: -16 });
    expect(exit(-1)).toEqual({ opacity: 0, x: 16, transition: fade.out });
    expect(Math.abs(enter(0).x as number)).toBe(0);
    expect(Math.abs(exit(0).x as number)).toBe(0);
    expect(stepPane.center).toEqual({ opacity: 1, x: 0, transition: { ...springs.soft, opacity: fade.in } });
  });

  it("减少动画档的增删与换步只动透明度：没有缩放与位移可让根部配置一步到位", () => {
    expect(insertItemFade).toEqual({ initial: { opacity: 0 }, animate: { opacity: 1, transition: fade.in }, exit: { opacity: 0, transition: fade.out } });
    expect(stepPaneFade).toEqual({ enter: { opacity: 0 }, center: { opacity: 1, transition: fade.in }, exit: { opacity: 0, transition: fade.out } });
  });

  it("提示气泡时机", () => {
    expect(TOOLTIP_TIMING).toEqual({ delay: 280, sidebarDelay: 120, warmWindow: 400, linger: 120 });
  });
});
