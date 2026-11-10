// 标题栏的动效约定：jsdom 不做布局也不跑 CSS 过渡，这里直接读样式表核对声明。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./TitleBar.module.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** 选择器恰好是 selector 的那几条规则的声明，后写的覆盖先写的；一条都没有时抛出，免得改了类名后断言落空。 */
function declarations(selector: string): Map<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const decls = new Map<string, string>();
  let found = false;
  for (const match of css.matchAll(new RegExp(`(?:^|\\n|,)\\s*${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, "g"))) {
    found = true;
    for (const decl of match[1].split(";")) {
      const at = decl.indexOf(":");
      if (at < 0) continue;
      decls.set(decl.slice(0, at).trim(), decl.slice(at + 1).trim().replace(/\s+/g, " "));
    }
  }
  if (!found) throw new Error(`样式表里没有 ${selector}`);
  return decls;
}

describe("窗口三键的焦点环", () => {
  it("只过渡底色与字色：焦点环瞬时出现与消失，box-shadow 不进过渡", () => {
    const transition = declarations(".winFace").get("transition");
    expect(transition).toBe("background-color var(--sk-dur-hover) var(--sk-ease), color var(--sk-dur-hover) var(--sk-ease)");
  });
});

describe("搜索入口的按压", () => {
  it("伪输入框按下缩到 0.97，compact 档的方形图标入口缩到 0.94，都走 tap 弹簧", () => {
    expect(declarations(".search:active").get("scale")).toBe("0.97");
    expect(declarations(".searchIcon:active").get("scale")).toBe("0.94");
    for (const selector of [".search", ".searchIcon"]) {
      expect(declarations(selector).get("transition")).toContain("scale var(--sk-spring-tap-dur) var(--sk-spring-tap)");
    }
  });

  it("按压不写 transform、过渡里也没有 transform：跟着账户胶囊滑动的布局动画把位移写在行内 transform 上", () => {
    for (const selector of [".search:active", ".searchIcon:active", ":global([data-sk-reduced]) .search:active", ":global([data-sk-reduced]) .searchIcon:active"]) {
      expect(declarations(selector).has("transform")).toBe(false);
    }
    for (const selector of [".search", ".searchIcon"]) {
      expect(declarations(selector).get("transition")).not.toMatch(/(^|,\s*)transform\s/);
    }
  });

  it("减少动画时不缩放，按下瞬时降到 0.85 不透明度", () => {
    for (const selector of [":global([data-sk-reduced]) .search:active", ":global([data-sk-reduced]) .searchIcon:active"]) {
      const reduced = declarations(selector);
      expect(reduced.get("scale")).toBe("none");
      expect(reduced.get("opacity")).toBe("0.85");
      expect(reduced.get("transition")).toBe("none");
    }
  });
});
