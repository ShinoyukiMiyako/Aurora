// jsdom 不做布局，这里直接读样式表核对：开局选项的说明行里有后端原文（读不到默认设置、开局 Mod 查不到），
// 其中的 Windows 路径没有空格可断，右栏又裁掉横向溢出，不放开折行后半截就看不见了。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./create.module.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function declarations(selector: string): string {
  const rule = new RegExp(`(?:^|\\n)\\.${selector}\\s*\\{([^}]*)\\}`).exec(css);
  if (rule === null) throw new Error(`样式表里没有 .${selector}`);
  return rule[1];
}

/** 按完整的选择器文本取规则体（逗号并列的选择器要写全；单写其中一个不会匹配到并列的那条）。 */
function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const rule = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (rule === null) throw new Error(`样式表里没有 ${selector}`);
  return rule[1];
}

describe("确认步的说明行", () => {
  it("开局选项的说明行放开任意处折行，长路径不被右栏裁掉", () => {
    expect(declarations("optionNote")).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("开局脚注没勾任何 Mod 项时只是透明，仍然占着位置", () => {
    const hidden = block(".starterNote[data-hidden]");
    expect(hidden).toMatch(/opacity:\s*0/);
    expect(hidden).not.toMatch(/display:\s*none|visibility/);
  });
});

describe("版本列表", () => {
  it("行与骨架行同高：上下内边距扣掉描边，骨架行不被定高的列表区压扁", () => {
    expect(declarations("row")).toMatch(/padding:\s*calc\(var\(--sk-space-8\) - 1px\) var\(--sk-space-12\)/);
    expect(declarations("skeletonRow")).toMatch(/flex:\s*none/);
  });

  it("列表常驻滚动条槽，列表区向右多让出一个槽宽，行的右缘不随筛选横移", () => {
    expect(declarations("list")).toMatch(/scrollbar-gutter:\s*stable/);
    expect(declarations("listArea")).toMatch(/margin:[^;]*\(var\(--sk-space-4\) \+ var\(--sk-scrollbar-size\)\) \* -1/);
    expect(declarations("listArea")).toMatch(/overflow:\s*hidden/);
  });

  it("给读屏的加载说明绝对定位、裁成一像素：不进步骤的弹性布局，不多出一道间距", () => {
    const sr = declarations("srOnly");
    expect(sr).toMatch(/position:\s*absolute/);
    expect(sr).toMatch(/clip-path:\s*inset\(50%\)/);
  });

  it("筛选行不折行，计数在余下的宽度里靠右、放不下出省略号", () => {
    expect(declarations("filterRow")).not.toMatch(/flex-wrap:\s*wrap/);
    const count = declarations("filterCount");
    expect(count).toMatch(/flex:\s*1 1 0/);
    expect(count).toMatch(/text-overflow:\s*ellipsis/);
    expect(block(".filterCount[data-pending]")).toMatch(/opacity:\s*0/);
  });
});

describe("步骤容器", () => {
  it("自己就是纵向滚动容器，滚动锚定不关：让位从容器自身算起，认得锚定挪的滚动位置", () => {
    const pane = declarations("pane");
    expect(pane).toMatch(/overflow-y:\s*auto/);
    expect(pane).not.toMatch(/overflow-anchor/);
  });
});

describe("选中勾", () => {
  it("选中时淡入并带回弹，取消时更快淡出、缩回不回弹", () => {
    const base = declarations("check");
    expect(base).toMatch(/opacity var\(--sk-dur-out\) var\(--sk-ease-in\)/);
    expect(base).toMatch(/scale var\(--sk-dur-out\) var\(--sk-ease-in\)/);
    const on = block('[aria-checked="true"] > .check');
    expect(on).toMatch(/opacity var\(--sk-dur-in\) var\(--sk-ease-out\)/);
    expect(on).toMatch(/scale var\(--sk-spring-pop-dur\) var\(--sk-spring-pop\)/);
  });

  it("减少动画：不缩放，但保留透明度的淡入淡出", () => {
    const reduced = block(":global([data-sk-reduced]) .check");
    expect(reduced).toMatch(/scale:\s*1/);
    expect(reduced).toMatch(/transition:\s*opacity var\(--sk-dur-out\)/);
    expect(block(':global([data-sk-reduced]) [aria-checked="true"] > .check')).toMatch(/transition:\s*opacity var\(--sk-dur-in\) var\(--sk-ease-out\)/);
  });
});

describe("步骤导航", () => {
  it("圆点换态与所在行同一拍渐变；当前步的渐变底画在叠层上，只淡入淡出叠层", () => {
    const dot = declarations("stepDot");
    for (const property of ["background-color", "border-color", "color"]) expect(dot).toMatch(new RegExp(`${property} var\\(--sk-dur-hover\\)`));
    const layer = block(".stepDot::before");
    expect(layer).toMatch(/background:\s*var\(--sk-accent-grad\)/);
    expect(layer).toMatch(/transition:\s*opacity/);
    expect(block('.stepButton[data-state="current"] .stepDot::before')).toMatch(/opacity:\s*1/);
    expect(block('.stepButton[data-state="current"] .stepDot')).not.toMatch(/background|box-shadow/);
  });

  it("当前步的底色是一块垫在各行之下的滑块，不是各行自己的底色", () => {
    expect(declarations("stepMark")).toMatch(/position:\s*absolute/);
    expect(declarations("stepMark")).toMatch(/z-index:\s*-1/);
    expect(css).not.toMatch(/\.stepButton\[data-state="current"\]\s*\{[^}]*background/);
  });
});

describe("底栏", () => {
  it("两句提示叠在同一格，主按钮与隐形的创建按钮叠在同一格", () => {
    expect(declarations("footHint")).toMatch(/display:\s*inline-grid/);
    expect(declarations("footHintLine")).toMatch(/grid-area:\s*1 \/ 1/);
    expect(block(".primaryButton,\n.primaryGhost")).toMatch(/grid-area:\s*1 \/ 1/);
    expect(block(".primaryGhost")).toMatch(/visibility:\s*hidden/);
  });

  it("按钮行占满提示之外的宽度：宽度不随按钮增减变化，让位才接得住", () => {
    const actions = declarations("footActions");
    expect(actions).toMatch(/flex:\s*1 1 0/);
    expect(actions).toMatch(/justify-content:\s*flex-end/);
    expect(actions).toMatch(/position:\s*relative/);
  });
});
