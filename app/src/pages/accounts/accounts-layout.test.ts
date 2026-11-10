// 账户页的预留空间与过渡规则。jsdom 不做布局，这里直接读样式表核对：会随状态增减的部分按最大的情形留位，
// 状态变化时卡片不变高、旁边的内容不被推动。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "");
const css = strip(readFileSync(new URL("./accounts.module.css", import.meta.url), "utf8"));
const kvCss = strip(readFileSync(new URL("../../ui/KV.module.css", import.meta.url), "utf8"));

/** 选择器恰好是 selector 的那条规则的声明（属性 -> 值）；没有这条规则时报错。 */
function declarations(source: string, selector: string): Record<string, string> {
  for (const rule of source.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = rule[1].split(",").map((s) => s.trim());
    if (!selectors.includes(selector)) continue;
    const out: Record<string, string> = {};
    for (const part of rule[2].split(";")) {
      const colon = part.indexOf(":");
      if (colon < 0) continue;
      out[part.slice(0, colon).trim()] = part.slice(colon + 1).trim().replace(/\s+/g, " ");
    }
    return out;
  }
  throw new Error(`样式表里没有 ${selector} 这条规则`);
}

describe("账户网格的增删", () => {
  it("网格是定位元素：被删的卡脱离布局时按网格里的偏移叠在原处", () => {
    expect(declarations(css, ".grid").position).toBe("relative");
  });

  it("包在卡外面的格子让卡片撑满，同一行照旧等高", () => {
    expect(declarations(css, ".cell")).toEqual({ display: "grid", "min-width": "0" });
  });
});

describe("账户卡底部三种形态等高", () => {
  it("按小号按钮高 30 留位，换下来的那一行以底部为基准叠在原处", () => {
    const foot = declarations(css, ".cardFoot");
    expect([foot["min-height"], foot.position, foot["align-items"]]).toEqual(["30px", "relative", "center"]);
  });

  it("标签与按钮一行放下、不折行：按钮不缩，「需要重新登录」标签可以省略收缩", () => {
    const row = declarations(css, ".footRow");
    expect(row["flex-wrap"]).toBeUndefined();
    expect(row["min-width"]).toBe("0");
    expect(declarations(css, ".footButton").flex).toBe("none");
    expect(declarations(css, ".footRow > .footTag")).toEqual({ flex: "0 1 auto", "min-width": "0" });
    expect(declarations(css, ".footTagText")).toMatchObject({ overflow: "hidden", "text-overflow": "ellipsis" });
  });
});

describe("选中描边与悬停", () => {
  it("聚光卡的外圈交给卡片的选中叠层画（只给宽度 4），阴影里不再另画一圈", () => {
    const spot = declarations(css, ".spot[data-selected][data-pad][data-clip]");
    expect(spot["--card-ring-width"]).toBe("var(--sk-space-4)");
    expect(spot["box-shadow"]).toBe("var(--sk-accent-glow), var(--sk-shadow-sm)");
  });

  it("账户卡的描边色随选中叠层一起过渡，减少动画时也保留", () => {
    expect(declarations(css, ".accountCard").transition).toContain("border-color var(--sk-dur-hover) var(--sk-ease)");
    expect(declarations(css, ":global([data-sk-reduced]) .accountCard").transition).toBe("border-color var(--sk-dur-hover) var(--sk-ease)");
  });

  it("账户卡悬停时阴影在 ::after 叠层上淡入，不对 box-shadow 做过渡", () => {
    const layer = declarations(css, ".accountCard::after");
    expect(layer).toMatchObject({ "box-shadow": "var(--sk-shadow)", opacity: "0", transition: "opacity var(--sk-dur-hover) var(--sk-ease)" });
    expect(declarations(css, ".accountCard:hover::after").opacity).toBe("1");
    expect(declarations(css, ".accountCard").transition).not.toContain("box-shadow");
  });
});

describe("聚光卡的键值表按三行留位", () => {
  it("核对的前提：KV 每行一行小号字，行距 8", () => {
    const kv = declarations(kvCss, ".kv");
    expect(kv["line-height"]).toBe("var(--sk-lh-small)");
    expect(kv.gap.split(" ")[0]).toBe("var(--sk-space-8)");
  });

  it("离线账户只有两行时也占三行的高度，行不被拉开", () => {
    const spotKv = declarations(css, ".spotKv");
    expect(spotKv["min-height"]).toBe("calc(3 * var(--sk-lh-small) + 2 * var(--sk-space-8))");
    expect(spotKv["align-content"]).toBe("start");
  });
});
