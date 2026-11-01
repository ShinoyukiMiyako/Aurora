// 固定的服务器卡在 compact（span 5）与 wide（span 3）两档最窄。jsdom 不做布局，这里直接读样式表核对让位规则：
// 这两档里延迟文字先藏起来、只留信号格，「加入」始终是文字按钮，任何一档都不藏。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./home.module.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const page = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");

const TIERS = ["compact", "regular", "wide"] as const;

/** 在哪几档里，某个类被 display: none 藏起来（按档位选择器 `:root[data-sk-tier="…"] .类名` 认）。 */
function hiddenTiers(source: string, className: string): string[] {
  const hidden = new Set<string>();
  for (const rule of source.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!/display\s*:\s*none/.test(rule[2])) continue;
    for (const selector of rule[1].split(",")) {
      const m = new RegExp(`:root\\[data-sk-tier="(\\w+)"\\]\\)?\\s+\\.${className}\\s*$`).exec(selector.trim());
      if (m !== null) hidden.add(m[1]);
    }
  }
  return TIERS.filter((tier) => hidden.has(tier));
}

describe("固定的服务器卡在最窄的档位里让位", () => {
  it("核对的前提：服务器卡在 compact 占 5 列、在 wide 占 3 列", () => {
    expect(page).toMatch(/<ServersCard span=\{\{ compact: 5, wide: 3 \}\} \/>/);
  });

  it("延迟文字在 compact 与 wide 两档藏起来，regular 照常显示", () => {
    expect(hiddenTiers(css, "ping")).toEqual(["compact", "wide"]);
  });

  it("「加入」在任何一档都不藏", () => {
    expect(hiddenTiers(css, "serverJoin")).toEqual([]);
  });

  it("档位选择器的识别本身：逗号分组与 :global 写法都认，不相干的类不算", () => {
    const sample = `
      :root[data-sk-tier="compact"] .ping,
      :global(:root[data-sk-tier="wide"]) .ping { display: none; }
      :root[data-sk-tier="regular"] .pingLabel { display: none; }
      :root[data-sk-tier="regular"] .ping { color: red; }
    `;
    expect(hiddenTiers(sample, "ping")).toEqual(["compact", "wide"]);
  });
});
