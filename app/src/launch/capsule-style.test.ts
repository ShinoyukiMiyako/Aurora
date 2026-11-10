// 启动胶囊样式里的动效约定：jsdom 不算样式，这里直接读 CSS 文本断言。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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
});

describe("进度填充", () => {
  it("不常驻 will-change：它不是循环动画，平时不该多占一个合成层", () => {
    expect(ruleOf(".fill")).not.toContain("will-change");
  });
});

describe("运行光晕", () => {
  it("呼吸的首尾帧与窗口外的静止帧同为 0.5：窗口开始、结束时都不跳变", () => {
    const keyframes = /@keyframes glow \{([\s\S]*?)\n\}/.exec(css);
    if (keyframes === null) throw new Error("没有 glow 关键帧");
    const edge = /0%,\s*100% \{([^}]*)\}/.exec(keyframes[1]);
    if (edge === null) throw new Error("glow 关键帧没有首尾帧");
    expect(declaration(edge[1], "opacity")).toBe(declaration(ruleOf(".glow"), "opacity"));
    expect(declaration(ruleOf(".glow"), "opacity")).toBe("0.5");
  });
});
