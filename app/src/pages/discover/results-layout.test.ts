// 发现页结果区与工具条的版式约定。jsdom 不做布局，这里直接读样式表核对：哪些地方靠预留位置做到「数据晚到、状态切换时不挤动」，
// 哪些地方只许动透明度。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./discover.module.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** 选择器恰好是 selector 的那些规则里的声明，后写的覆盖先写的。@keyframes 里的帧不算规则。 */
function declarations(selector: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = rule[1].split(",").map((s) => s.trim());
    if (!selectors.includes(selector)) continue;
    for (const decl of rule[2].split(";")) {
      const at = decl.indexOf(":");
      if (at < 0) continue;
      out.set(decl.slice(0, at).trim(), decl.slice(at + 1).trim().replace(/\s+/g, " "));
    }
  }
  return out;
}

function value(selector: string, property: string): string | undefined {
  return declarations(selector).get(property);
}

describe("骨架卡与结果卡逐行同高", () => {
  it("摘要两行的上边距与行高与结果卡的摘要一致", () => {
    expect(value(".skeletonSummary", "margin")).toBe(value(".cardSummary", "margin"));
    expect(value(".skeletonSummary", "line-height")).toBe(value(".cardSummary", "line-height"));
    // 结果卡的摘要固定两行高：骨架画两行，两边一样高
    expect(value(".cardSummary", "min-height")).toBe("calc(var(--sk-lh-small) * 2)");
  });

  it("骨架网格的行按 1fr 等高：只画头一屏的骨架卡，空着的格子照样占住一整页的高度", () => {
    expect(value(".skeletonGrid", "grid-auto-rows")).toBe("1fr");
    expect(value(".skeletonSlot", "visibility")).toBe("hidden");
  });
});

describe("说明行与工具条不被晚到的文字挤动", () => {
  it("计数是定宽槽，「清除筛选」固定在行尾", () => {
    expect(value(".infoCount", "display")).toBe("inline-block");
    expect(value(".infoCount", "min-width")).toBe("8em");
    expect(value(".infoClear", "margin-left")).toBe("auto");
  });

  it("筛选条件数角标绝对定位叠在按钮角上，不占按钮宽度", () => {
    expect(value(".filterBadge", "position")).toBe("absolute");
  });

  it("热门分类的对勾位常驻：没选中时只是透明，选中时显出", () => {
    expect(value(".chip [data-glyph]", "opacity")).toBe("0");
    expect(value('.chip[aria-pressed="true"] [data-glyph]', "opacity")).toBe("1");
    // 显隐不改宽度：没有用 display 或尺寸去藏
    expect(declarations(".chip [data-glyph]").has("display")).toBe(false);
    expect(declarations(".chip [data-glyph]").has("width")).toBe(false);
  });
});

describe("吸顶工具条只动底色与透明度", () => {
  it("阴影画在 ::after 叠层上淡入淡出，吸住与松开都不过渡 box-shadow 本身", () => {
    expect(declarations(".toolbarWrap[data-stuck]").has("box-shadow")).toBe(false);
    expect(value(".toolbarWrap::after", "box-shadow")).toBe("var(--sk-shadow-sm)");
    expect(value(".toolbarWrap::after", "opacity")).toBe("0");
    expect(value(".toolbarWrap[data-stuck]::after", "opacity")).toBe("1");
    expect(value(".toolbarWrap::after", "transition")).toBe("opacity var(--sk-dur-hover) var(--sk-ease)");
    expect(value(".toolbarWrap", "transition")).toBe("background-color var(--sk-dur-hover) var(--sk-ease)");
  });

  it("样式表里没有对布局与阴影属性的过渡", () => {
    for (const rule of css.matchAll(/transition\s*:([^;}]*)/g)) {
      expect(rule[1]).not.toMatch(/\b(all|width|height|top|left|margin|padding|box-shadow|filter)\b/);
    }
  });
});
