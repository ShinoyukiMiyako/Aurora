// 命令面板的尺寸稳定性：jsdom 不做布局，读样式表文本断言。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");
const css = strip(readFileSync(new URL("./CommandPalette.module.css", import.meta.url), "utf8"));

function ruleOf(selector: string): string {
  const rule = new RegExp(`(?:^|\\n)${selector.replace(".", "\\.")} \\{([^}]*)\\}`).exec(css);
  if (rule === null) throw new Error(`没有 ${selector} 规则`);
  return rule[1];
}

function declaration(rule: string, property: string): string | null {
  const match = new RegExp(`(?:^|\\s)${property}: ([^;]+);`).exec(rule);
  return match === null ? null : match[1];
}

describe("命令面板的结果列表", () => {
  const list = ruleOf(".list");

  it("定高：结果条数随键入变化时面板下沿与底栏不跟着伸缩", () => {
    expect(declaration(list, "height")).toBe("min(400px, 52vh)");
    expect(declaration(list, "max-height")).toBeNull();
    // 窗口矮到放不下时仍可随面板的最大高收缩，底栏不被裁掉
    expect(declaration(list, "flex")).toBe("0 1 auto");
  });

  it("滚动槽常驻，右内边距让给它：结果从溢出变成放得下时各行不横跳", () => {
    expect(declaration(list, "scrollbar-gutter")).toBe("stable");
    expect(declaration(list, "padding")).toBe("var(--sk-space-6) 0 var(--sk-space-6) var(--sk-space-6)");
  });
});

describe("命令面板的开合", () => {
  it("缩放以顶边中点为原点：顶边锚定在标题栏下方，开合时不上下漂", () => {
    expect(declaration(ruleOf(".panel"), "transform-origin")).toBe("top center");
  });
});
