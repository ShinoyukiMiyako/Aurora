// jsdom 不做布局：卡片里几处「文字变了不挤动旁边」的约束直接读样式表核对。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./library.module.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** 选择器恰好是 selector 的那条规则（逗号分组里任一项相等即可）里的声明，值里的连续空白压成一个空格。 */
function declarations(selector: string): Record<string, string> {
  for (const rule of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!rule[1].split(",").some((s) => s.trim() === selector)) continue;
    const entries = rule[2]
      .split(";")
      .map((d) => d.trim())
      .filter((d) => d !== "")
      .map((d) => {
        const colon = d.indexOf(":");
        return [d.slice(0, colon).trim(), d.slice(colon + 1).replace(/\s+/g, " ").trim()] as const;
      });
    return Object.fromEntries(entries);
  }
  throw new Error(`样式表里没有选择器恰为 ${selector} 的规则`);
}

describe("工具条", () => {
  it("工具组按带目录选择的宽度占位、组内靠右排：目录选择晚到或撤掉都不改变工具条折不折行", () => {
    const tools = declarations(".tools");
    const slots = [".search", ".directory", ".sort"].map((selector) => declarations(selector).width);
    expect(slots).toEqual(["var(--lib-search-width)", "var(--lib-directory-width)", "var(--lib-sort-width)"]);
    expect(tools["min-width"]).toBe(`calc(${slots.join(" + ")} + 2 * ${tools.gap})`);
    expect(tools["justify-content"]).toBe("flex-end");
    expect(tools["margin-left"]).toBe("auto");
  });
});

describe("实例卡片的统计行", () => {
  it("固定一行高、裁掉排不下的项：文案变长或卡变窄时卡片不长高", () => {
    const stats = declarations(".stats");
    expect(stats.height).toBe("var(--sk-lh-caption)");
    expect(stats["line-height"]).toBe("var(--sk-lh-caption)");
    expect(stats.overflow).toBe("hidden");
    expect(stats["flex-wrap"]).toBe("wrap");
  });

  it("相对时间按最宽的常见写法占宽：跨位数时后面的项不横移", () => {
    expect(declarations(".stats > li:first-child > span")["min-width"]).toBe("var(--lib-stat-recent-min)");
    expect(declarations(".stats")["--lib-stat-recent-min"]).toMatch(/^\d+(\.\d+)?em$/);
  });

  it("四项按最宽写法排不下时只在视觉上收起第四项：显示哪几项只随卡宽变，不随时长、Mod 数的位数变；读屏照旧读到", () => {
    expect(declarations(".stats")["container-type"]).toBe("inline-size");
    const query = /@container\s*\(width < (\d+)px\)\s*\{\s*\.stats > li:nth-child\(n \+ 4\)\s*\{([^}]*)\}\s*\}/.exec(css);
    if (query === null) throw new Error("样式表里没有按卡宽收起第四项的容器查询");
    // 与只给读屏的说明（.srOnly）同一套视觉隐藏：不占行内位置、裁成看不见，但不移出无障碍树
    const hidden = Object.fromEntries(
      query[2]
        .split(";")
        .map((d) => d.trim())
        .filter((d) => d !== "")
        .map((d) => d.split(":").map((part) => part.trim())),
    );
    expect(hidden).toEqual(declarations(".srOnly"));
    // 阈值不低于四项最宽写法：每项 16px 图标加 4px 间距、三处 12px 列距，文字按 12px 字号的 em 数
    // （相对时间预留的 4.4em、「读不到」3em、四位 Mod 数与三位存档数每位 0.6em）
    const recent = Number.parseFloat(declarations(".stats")["--lib-stat-recent-min"]);
    const worst = 4 * (16 + 4) + 3 * 12 + (recent + 3 + 4 * 0.6 + 3 * 0.6) * 12;
    expect(Number(query[1])).toBeGreaterThanOrEqual(worst);
  });
});

describe("卡面与新建卡的悬停", () => {
  it("图钉的显隐有透明度过渡，并保留图标按钮自己的按压与颜色过渡", () => {
    const transition = declarations(".coverTop .pin").transition;
    for (const property of ["opacity", "transform", "background-color", "border-color", "color"]) expect(transition).toContain(`${property} var(`);
  });

  it("卡面版本号的字色随卡面形态换时按悬停那一档淡过去；带模糊的文字阴影不过渡，随形态瞬切", () => {
    expect(declarations(".coverVersion").transition).toBe("color var(--sk-dur-hover) var(--sk-ease)");
    // 阴影仍随媒体形态挂上，只是不补间（那条规则的选择器里带逗号，declarations 按逗号拆分组匹配不到它）
    expect(css).toMatch(/\.coverVersion\s*\{[^}]*text-shadow: var\(--sk-media-text-shadow\);/);
  });

  it("新建卡悬停上浮、按下缩到 0.99；减少动画时不位移，按下改为降透明度", () => {
    expect(declarations(":global(:root:not([data-sk-reduced])) .createTile:hover").translate).toBe("0 -2px");
    const active = declarations(":global(:root:not([data-sk-reduced])) .createTile:active");
    expect(active.scale).toBe("0.99");
    expect(active.translate).toBe("none");
    expect(declarations(":global([data-sk-reduced]) .createTile:active")).toEqual({ opacity: "0.85", transition: "none" });
    expect(declarations(".createTile").transition).toContain("translate var(--sk-spring-settle-dur) var(--sk-spring-settle)");
  });

  it("新建卡悬停时图标随卡体一起上浮 2px，不再自己另抬一次", () => {
    expect(css).not.toMatch(/\.createIcon\s*\{[^}]*translate/);
    expect(css).not.toMatch(/\.createTile:hover \.createIcon/);
    expect(declarations(".createIcon").transition).toBeUndefined();
  });
});

describe("实例卡片底栏", () => {
  it("运行文案占满结束按钮左边的空间：文案变短或计时多一段时按钮不在指针下移动", () => {
    expect(declarations(".running").flex).toBe("1");
  });

  it("换面的槽位不设定位：标题按钮的覆盖层照样盖住底栏空白处", () => {
    expect(declarations(".statusSlot").position).toBeUndefined();
    expect(declarations(".statusSlot").flex).toBe("1");
  });
});
