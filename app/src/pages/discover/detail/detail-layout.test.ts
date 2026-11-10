// 资源详情里只靠样式表实现的动效约定。jsdom 不算样式，这里直接读样式表核对。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./detail.module.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** 选择器（逗号分组里的任一个）对应的声明，按属性名取值；同一个选择器出现多次时后面的覆盖前面的。 */
function decls(selector: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!m[1].split(",").some((s) => s.trim() === selector)) continue;
    for (const part of m[2].split(";")) {
      const at = part.indexOf(":");
      if (at >= 0) out.set(part.slice(0, at).trim(), part.slice(at + 1).trim().replace(/\s+/g, " "));
    }
  }
  return out;
}

describe("版本列表的「加载更多」", () => {
  it("按类名居中：不论后面跟不跟截断说明都不被拉成整行宽，样式表里不再有按排位认按钮的选择器", () => {
    expect(decls(".loadMore").get("align-self")).toBe("center");
    expect(css).not.toMatch(/\.versions\s*>[^{}]*:last-child/);
  });
});

describe("换参数重取期间旧内容压暗", () => {
  it("与全站同一种：透明度取禁用令牌，压暗走退场时长、恢复走入场时长，只过渡透明度", () => {
    expect(decls(".dimmable[data-stale]").get("opacity")).toBe("var(--sk-disabled)");
    expect(decls(".dimmable[data-stale]").get("transition")).toBe("opacity var(--sk-dur-out) var(--sk-ease-in)");
    expect(decls(".dimmable").get("transition")).toBe("opacity var(--sk-dur-in) var(--sk-ease-out)");
  });
});
