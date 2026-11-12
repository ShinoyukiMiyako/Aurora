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

/** 选择器恰好是 `.类名` 的那条规则的声明（不含伪类、属性选择器的变体）。 */
function ruleOf(source: string, className: string): string {
  for (const rule of source.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (rule[1].split(",").some((selector) => selector.trim() === `.${className}`)) return rule[2];
  }
  throw new Error(`样式表里没有 .${className} 的规则`);
}

describe("服务器行的高度不随测速结果变化", () => {
  it("文字列恒占三行：正文一行加 MOTD、在线人数两行说明", () => {
    expect(ruleOf(css, "serverText")).toMatch(/min-height:\s*calc\(var\(--sk-lh-body\) \+ 2 \* var\(--sk-lh-caption\)\);/);
  });

  it("两行说明与它们的骨架取说明字阶的行高，骨架文字条按它取高", () => {
    expect(ruleOf(css, "serverDetail")).toMatch(/line-height:\s*var\(--sk-lh-caption\);/);
  });
});

describe("信号格换色", () => {
  it("测速结果回来、延迟换档时颜色过渡，与行底色同一档时长", () => {
    expect(ruleOf(css, "signalBar")).toMatch(/transition:\s*background-color var\(--sk-dur-hover\) var\(--sk-ease\);/);
    expect(ruleOf(css, "serverRow")).toMatch(/transition:\s*background-color var\(--sk-dur-hover\) var\(--sk-ease\);/);
  });
});

describe("资讯与服务器的行骨架照真实的行排", () => {
  const decl = (className: string, property: string) => {
    const m = new RegExp(`(?:^|;|\\s)${property}:\\s*([^;]+);`).exec(ruleOf(css, className));
    if (m === null) throw new Error(`.${className} 没有 ${property}`);
    return m[1].trim();
  };

  it("行距与列表同为 2，上距与列表上方的留白相同：骨架换成内容时每一行都在原处", () => {
    expect(decl("rowSkeletons", "gap")).toBe(decl("serverList", "gap"));
    expect(decl("rowSkeletons", "padding-top")).toBe(decl("newsList", "padding-top"));
    expect(decl("serverList", "margin").split(/\s+/)[0]).toBe(decl("rowSkeletons", "padding-top"));
  });

  // 外边距会穿过无内边距的包裹层折叠出去；包裹层退场时被抽成绝对定位（top 取量到的位置），外边距不再折叠或再加一次，
  // 淡出途中整块下跳
  it("骨架列、资讯列表外层与慢提示的上距都用内边距，不用外边距", () => {
    for (const name of ["rowSkeletons", "newsList", "rowSlowHint"]) expect(ruleOf(css, name)).not.toMatch(/(?:^|[;\s])margin(?:-top)?\s*:/);
    expect(decl("rowSlowHint", "padding-top")).toBe("var(--sk-space-8)");
  });

  it("骨架行的内边距与服务器行相同；配 40 的缩略图，资讯骨架行合 56，与列表行同高", () => {
    expect(decl("rowSkeleton", "padding")).toBe(decl("serverRow", "padding"));
    expect(decl("rowSkeleton", "padding")).toBe("var(--sk-space-8) var(--sk-space-10)");
  });

  it("骨架文字条的行高：标题行取正文，说明行取说明", () => {
    expect(decl("skeletonBody", "line-height")).toBe("var(--sk-lh-body)");
    expect(decl("skeletonCaption", "line-height")).toBe("var(--sk-lh-caption)");
  });
});

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
