// jsdom 不做布局也不跑 CSS 过渡，这里直接读样式表核对窗口骨架里和动效有关的声明。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SETUP = readFileSync(new URL("./setup.module.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function decls(selector: string): Map<string, string> {
  const escaped = selector.replace(/[.[\]]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(SETUP);
  if (match === null) throw new Error(`样式表里没有 ${selector}`);
  const found = new Map<string, string>();
  for (const decl of match[1].split(";")) {
    const at = decl.indexOf(":");
    if (at < 0) continue;
    found.set(decl.slice(0, at).trim(), decl.slice(at + 1).trim().replace(/\s+/g, " "));
  }
  return found;
}

describe("换步的页", () => {
  it("撑满主列，也是页里退场块的定位基准", () => {
    const pane = decls(".pane");
    expect(pane.get("position")).toBe("relative");
    expect(pane.get("flex")).toBe("1");
    expect(pane.get("flex-direction")).toBe("column");
    expect(pane.get("min-height")).toBe("0");
  });

  it("窗口按钮抬在页上面：页是定位元素、入场时带 transform，不抬就被它盖住、点不到", () => {
    expect(decls(".windowControls").get("z-index")).toBe("var(--sk-z-page)");
  });
});

describe("说明区占位", () => {
  it("两段说明叠在同一格里，格子按较高的那段撑开，占位的那段看不见", () => {
    expect(decls(".leadSlot").get("display")).toBe("grid");
    expect(decls(".leadSlot > .lead").get("grid-area")).toBe("1 / 1");
    expect(decls(".lead[data-floor]").get("visibility")).toBe("hidden");
  });
});

describe("窗口按钮", () => {
  it("底块只过渡底色和字色，焦点环（box-shadow）立刻出现、立刻消失", () => {
    const transition = decls(".winFace").get("transition");
    expect(transition?.split(",").map((part) => part.trim().split(" ")[0])).toEqual(["background-color", "color"]);
  });
});
