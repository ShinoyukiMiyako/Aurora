// 下载失败时另放的后端原文：试过多个下载源时它逐行一个源，屏幕上分行靠 white-space: pre-line。
// jsdom 不做布局，textContent 里的换行符不论样式如何都在，渲染测试锁不住这一点，所以直接读样式表核对两处原文节点的声明。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function stylesheet(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 顶层规则里选择器恰好是 selector 的那几条的声明，后写的覆盖先写的；一条都没有时抛出，免得改了类名后断言落空。 */
function declarations(css: string, selector: string): Map<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const decls = new Map<string, string>();
  let found = false;
  for (const match of css.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, "g"))) {
    found = true;
    for (const decl of match[1].split(";")) {
      const at = decl.indexOf(":");
      if (at < 0) continue;
      decls.set(decl.slice(0, at).trim(), decl.slice(at + 1).trim());
    }
  }
  if (!found) throw new Error(`样式表里没有 ${selector}`);
  return decls;
}

describe("下载失败另放的后端原文逐行显示", () => {
  it("更新面板：原文块 .failureRaw 保留换行", () => {
    expect(declarations(stylesheet("./UpdatePanel.module.css"), ".failureRaw").get("white-space")).toBe("pre-line");
  });

  it("关于页更新卡：状态文字里的原文 .updateText .errorText 保留换行", () => {
    expect(declarations(stylesheet("../pages/settings/settings.module.css"), ".updateText .errorText").get("white-space")).toBe("pre-line");
  });
});
