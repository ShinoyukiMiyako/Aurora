// 固定的服务器卡在最窄的档位里怎么让位。jsdom 不做布局，这里直接读样式表核对按档位的规则：
// 卡片在 compact（span 5）与 wide（span 3）两档最窄，这两档里行上的「加入」保留文字按钮，延迟文字先让位、只留信号格；
// regular 档卡片更宽，延迟照常显示。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./home.module.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** 样式表里每条规则的选择器列表与声明。只处理平铺的规则，主页样式没有嵌套。 */
function rules(): { selectors: string[]; decls: Map<string, string> }[] {
  const out: { selectors: string[]; decls: Map<string, string> }[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = new Map<string, string>();
    for (const decl of match[2].split(";")) {
      const at = decl.indexOf(":");
      if (at < 0) continue;
      decls.set(decl.slice(0, at).trim(), decl.slice(at + 1).trim());
    }
    out.push({ selectors: match[1].split(",").map((s) => s.trim()), decls });
  }
  return out;
}

/** 把某个类按档位隐藏的那些档位名。 */
function tiersHiding(className: string): string[] {
  const tiers: string[] = [];
  const pattern = new RegExp(`data-sk-tier="(\\w+)"\\]\\)?\\s+\\.${className}$`);
  for (const rule of rules()) {
    if (rule.decls.get("display") !== "none") continue;
    for (const selector of rule.selectors) {
      const m = pattern.exec(selector);
      if (m !== null) tiers.push(m[1]);
    }
  }
  return tiers.sort();
}

describe("固定的服务器卡：最窄档位的让位", () => {
  it("延迟文字在卡片最窄的 compact 与 wide 两档隐藏，regular 档照常显示", () => {
    expect(tiersHiding("ping")).toEqual(["compact", "wide"]);
  });

  it("「加入」在任何档位都不隐藏", () => {
    expect(tiersHiding("serverJoin")).toEqual([]);
  });
});
