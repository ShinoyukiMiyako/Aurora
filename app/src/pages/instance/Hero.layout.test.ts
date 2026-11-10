// 头图与概览的几条防位移、防跳变规则。jsdom 不做布局，这里直接读样式表核对：
// 让位要认得到动作行里的每一项、改名的校验错误不进流、改名钮与速览方格的按压反馈没被盖掉。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./instance.module.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** 选择器（逗号分组里的任一个）恰好是 selector 的那些规则的声明，拼在一起；一条都没有时报错。 */
function declarations(selector: string): string {
  const want = selector.replace(/\s+/g, " ").trim();
  const found: string[] = [];
  for (const rule of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = rule[1].split(",").map((s) => s.replace(/\s+/g, " ").trim());
    if (selectors.includes(want)) found.push(rule[2]);
  }
  if (found.length === 0) throw new Error(`样式表里没有 ${selector} 的规则`);
  return found.join("\n").replace(/\s+/g, " ");
}

describe("头图动作行", () => {
  it("方块、文字列与动作排成同一个弹性行：让位挂在这一行上，行宽由卡面定死", () => {
    expect(declarations(".heroInner")).toContain("display: flex;");
  });

  it("图钉与更多钮外面那一层是真实的盒子：提示气泡外层没有盒子，让位认不到", () => {
    const own = declarations(".heroAction");
    expect(own).toContain("display: flex;");
    expect(own).not.toContain("contents");
  });

  it("状态标签退场时以标签行为基准抽出布局", () => {
    expect(declarations(".heroChips")).toContain("position: relative;");
  });
});

describe("改名的校验错误", () => {
  it("错误不进输入行的流：绝对定位叠在下面标签行的位置上", () => {
    const own = declarations(".renameError");
    expect(own).toContain("position: absolute;");
    expect(own).toContain("top: calc(100% + var(--sk-space-6));");
  });

  it("出错时标签行淡出让位给错误，只动透明度", () => {
    expect(declarations(".heroText:has(> .renameRow[data-invalid]) > .heroChips")).toContain("opacity: 0;");
    expect(declarations(".heroChips")).toContain("transition: opacity var(--sk-dur-hover) var(--sk-ease);");
  });
});

describe("按压反馈", () => {
  it("改名钮自己的过渡把图标按钮的按压弹簧与底色过渡一并写回来，不整条盖掉", () => {
    const own = declarations(".heroEdit");
    expect(own).toContain("opacity var(--sk-dur-hover) var(--sk-ease)");
    expect(own).toContain("transform var(--sk-spring-tap-dur) var(--sk-spring-tap)");
    expect(own).toContain("background-color var(--sk-dur-hover) var(--sk-ease)");
  });

  it("速览方格与「+N」按下缩到 0.94，减少动画时改成变淡", () => {
    expect(declarations(".peekTile:active")).toContain("transform: scale(0.94);");
    expect(declarations(".peekMore:active")).toContain("transform: scale(0.94);");
    expect(declarations(":global([data-sk-reduced]) .peekTile:active")).toContain("transform: none;");
    expect(declarations(".peekTile")).toContain("transform var(--sk-spring-tap-dur) var(--sk-spring-tap)");
  });
});
