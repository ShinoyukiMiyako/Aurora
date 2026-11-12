// 启动胶囊样式里的动效约定：jsdom 不算样式，这里直接读 CSS 文本断言。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BREATH_CYCLES } from "./breath";

const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");
const css = strip(readFileSync(new URL("./LaunchCapsule.module.css", import.meta.url), "utf8"));

/** 选择器完全一致的那条规则的声明块。 */
function ruleOf(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(css);
  if (rule === null) throw new Error(`没有 ${selector} 规则`);
  return rule[1];
}

/** 声明的值；跨行的多值写法压成单空格。 */
function declaration(rule: string, property: string): string {
  const match = new RegExp(`(?:^|\\s)${property}:\\s*([^;]+);`).exec(rule);
  if (match === null) throw new Error(`规则里没有 ${property}`);
  return match[1].replace(/\s+/g, " ").trim();
}

describe("按压", () => {
  it.each([
    [".go:active", "scale(0.97)"],
    [".pill:active:not([aria-disabled=\"true\"])", "scale(0.96)"],
    [".iconAction:active:not([aria-disabled=\"true\"])", "scale(0.94)"],
  ])("%s 缩到 %s", (selector, scale) => {
    expect(declaration(ruleOf(selector), "transform")).toBe(scale);
  });

  it.each([".go:active:not([data-disabled])", ".pill:active:not([aria-disabled=\"true\"])", ".iconAction:active:not([aria-disabled=\"true\"])"])(
    "减少动画时 %s 不缩放，按下瞬时降到 0.85 不透明度",
    (selector) => {
      const rule = ruleOf(`:global([data-sk-reduced]) ${selector}`);
      expect(declaration(rule, "transform")).toBe("none");
      expect(declaration(rule, "opacity")).toBe("0.85");
      expect(declaration(rule, "transition")).toBe("none");
    },
  );

  it("按压缩放走 tap 弹簧；启动按钮的带原因禁用进出时透明度过渡，不在一帧里闪成半透明", () => {
    expect(declaration(ruleOf(".iconAction"), "transition")).toContain("transform var(--sk-spring-tap-dur) var(--sk-spring-tap)");
    expect(declaration(ruleOf(".go"), "transition")).toContain("opacity var(--sk-dur-hover) var(--sk-ease)");
  });

  it("减少动画时启动按钮不留透明度过渡：松开后即时回到不透明，不按 150 ms 补间，与胶囊内其它按钮一致", () => {
    expect(declaration(ruleOf(":global([data-sk-reduced]) .go"), "transition")).toBe("none");
    for (const selector of [".pill", ".iconAction"]) expect(declaration(ruleOf(selector), "transition")).not.toContain("opacity");
  });
});

describe("进度填充", () => {
  it("不常驻 will-change：它不是循环动画，平时不该多占一个合成层", () => {
    expect(ruleOf(".fill")).not.toContain("will-change");
  });
});

describe("运行光晕", () => {
  /** glow 关键帧：[百分位, 不透明度]，按百分位排序。 */
  const glowFrames = () => {
    const keyframes = /@keyframes glow \{([\s\S]*?)\n\}/.exec(css);
    if (keyframes === null) throw new Error("没有 glow 关键帧");
    const frames: [number, string][] = [];
    for (const [, stops, body] of keyframes[1].matchAll(/([\d.%,\s]+)\{([^}]*)\}/g)) {
      for (const stop of stops.split(",")) frames.push([Number.parseFloat(stop), declaration(body, "opacity")]);
    }
    return frames.sort((a, b) => a[0] - b[0]);
  };

  it("整个呼吸窗口是一段只播一次的关键帧，时长为窗口的整周期数", () => {
    expect(declaration(ruleOf(":global(:root[data-sk-breath]:not([data-sk-reduced])) .glow"), "animation")).toBe(
      `glow calc(var(--sk-loop-breath) * ${BREATH_CYCLES}) var(--sk-ease-breath)`,
    );
  });

  it("从静止帧 0.5 起、回到 0.5 止，窗口开始与结束都不跳变；中间仍在 0.2 与 0.9 之间呼吸，最亮落在各周期中点", () => {
    expect(declaration(ruleOf(".glow"), "opacity")).toBe("0.5");
    const frames = glowFrames();
    expect(frames[0]).toEqual([0, "0.5"]);
    expect(frames.at(-1)).toEqual([100, "0.5"]);
    const peaks = Array.from({ length: BREATH_CYCLES }, (_, k) => Number((((k + 0.5) / BREATH_CYCLES) * 100).toFixed(3)));
    const troughs = Array.from({ length: BREATH_CYCLES - 1 }, (_, k) => Number((((k + 1) / BREATH_CYCLES) * 100).toFixed(3)));
    expect(frames.filter(([, opacity]) => opacity === "0.9").map(([at]) => at)).toEqual(peaks);
    expect(frames.filter(([, opacity]) => opacity === "0.2").map(([at]) => at)).toEqual(troughs);
    expect(frames).toHaveLength(2 + peaks.length + troughs.length);
  });
});
