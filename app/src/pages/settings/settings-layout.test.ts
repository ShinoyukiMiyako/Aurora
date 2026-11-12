// 设置页样式里与动效、尺寸稳定有关的约定。jsdom 不做样式计算，这里直接读样式表核对：
// 导航锚点的留白与吸顶对齐；图标底座的渐变只能叠一层淡入淡出，减少动画时选中不上浮；
// 更新卡状态行在没有次句时也不变矮。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./settings.module.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** 选择器原样写出的那一条规则的声明；样式表里没有这一条时报错。 */
function block(selector: string): Map<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (match === null) throw new Error(`样式表里没有 ${selector}`);
  const decls = new Map<string, string>();
  for (const decl of match[2].split(";")) {
    const at = decl.indexOf(":");
    if (at < 0) continue;
    decls.set(decl.slice(0, at).trim(), decl.slice(at + 1).trim().replace(/\s+/g, " "));
  }
  return decls;
}

describe("分区布局是导航锚点", () => {
  it("锚点的 scroll-margin-top 等于导航卡吸顶的 top：外壳滚回锚点时导航卡停在原处", () => {
    const top = block(".navCard").get("top");
    expect(top).toBe("4px");
    expect(block(".layout").get("scroll-margin-top")).toBe(top);
  });
});

describe("设置分区导航的图标底座", () => {
  it("底色常驻，不换成渐变：选中与否 background 只在底座本身写一次", () => {
    expect(block(".navIcon").get("background")).toBe("var(--sk-bg-2)");
    expect(block(".navItem[data-on] .navIcon").has("background")).toBe(false);
  });

  it("渐变叠在 ::before 上，平时透明、选中时不透明，只过渡透明度", () => {
    const overlay = block(".navIcon::before");
    expect(overlay.get("background")).toBe("var(--sk-accent-grad)");
    expect(overlay.get("opacity")).toBe("0");
    expect(overlay.get("transition")).toBe("opacity var(--sk-dur-hover) var(--sk-ease)");
    expect(block(".navItem[data-on] .navIcon::before").get("opacity")).toBe("1");
  });

  it("图标色随选中一起过渡，不再过渡背景", () => {
    const transition = block(".navIcon").get("transition");
    expect(transition).toContain("color var(--sk-dur-hover) var(--sk-ease)");
    expect(transition).not.toContain("background");
  });

  it("减少动画：选中项不上浮，过渡里只剩颜色", () => {
    expect(block(".navItem[data-on] .navIcon").get("translate")).toBe("0 -1px");
    expect(block(":global([data-sk-reduced]) .navItem[data-on] .navIcon").get("translate")).toBe("none");
    expect(block(":global([data-sk-reduced]) .navIcon").get("transition")).toBe("color var(--sk-dur-hover) var(--sk-ease)");
  });
});

describe("许可弹窗", () => {
  it("打开就取满高：读取中与读到后同一个框，读到时不从转圈的高度撑开", () => {
    expect(block(".licenseDialog").get("height")).toBe("100%");
  });
});

describe("更新卡的状态行", () => {
  it("文字列至少是主句一行、间距、次句一行的高度：检查中没有次句时也不变矮", () => {
    const text = block(".updateText");
    expect(text.get("min-height")).toBe("calc(var(--sk-lh-body) + var(--sk-space-2) + var(--sk-lh-caption))");
    expect(text.get("gap")).toBe("var(--sk-space-2)");
    expect(block(".updateTitle").get("line-height")).toBe("var(--sk-lh-body)");
    expect(block(".mutedText").get("line-height")).toBe("var(--sk-lh-caption)");
  });
});
