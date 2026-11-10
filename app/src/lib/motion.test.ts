import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fade, insertItem, pageItem, rootTransition, SPRING_PARAMS, springAt, springs, tabPanel, TOOLTIP_TIMING, twoParam, type SpringName } from "./motion";

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

  it("页面区块第 i 项延迟 20 + min(i, 5) × 40 ms", () => {
    const show = pageItem.show as (i: number) => { transition: { delay: number } };
    expect(show(0).transition.delay).toBeCloseTo(0.02, 10);
    expect(show(1).transition.delay).toBeCloseTo(0.06, 10);
    expect(show(5).transition.delay).toBeCloseTo(0.22, 10);
    expect(show(9).transition.delay).toBeCloseTo(0.22, 10);
  });

  it("面板变体与页面区块同名，子元素才接得住编排", () => {
    expect(Object.keys(tabPanel).sort()).toEqual(Object.keys(pageItem).sort());
  });

  it("流内块增删：从 0.98 落到位走 settle，透明度走补间，退场只淡出不回弹", () => {
    expect(insertItem.initial).toEqual({ opacity: 0, scale: 0.98 });
    expect(insertItem.animate).toEqual({ opacity: 1, scale: 1, transition: { ...springs.settle, opacity: fade.in } });
    expect(insertItem.exit).toEqual({ opacity: 0, scale: 0.98, transition: fade.out });
  });

  it("提示气泡时机", () => {
    expect(TOOLTIP_TIMING).toEqual({ delay: 280, sidebarDelay: 120, warmWindow: 400, linger: 120 });
  });
});
