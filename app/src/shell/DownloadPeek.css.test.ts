// 下载入口与快览的样式约定：jsdom 不做布局也不跑 CSS 过渡，这里直接读样式表核对声明。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./DownloadPeek.module.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** 选择器恰好是 selector 的那条规则的声明，属性名到值。 */
function rule(selector: string): Map<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (m === null) throw new Error(`没有 ${selector} 规则`);
  const decls = new Map<string, string>();
  for (const decl of m[1].split(";")) {
    const at = decl.indexOf(":");
    if (at < 0) continue;
    decls.set(decl.slice(0, at).trim(), decl.slice(at + 1).trim().replace(/\s+/g, " "));
  }
  return decls;
}

describe("快览列表的滚动条槽位", () => {
  it("滚动交给浮层的主体（常驻槽位）并封顶 320；列表右侧不再加内边距，右边留白由槽承担", () => {
    expect(rule(".popover").get("--popover-body-max-height")).toBe("320px");
    expect(rule(".list").get("padding")).toBe("0 0 var(--sk-space-8) var(--sk-space-8)");
    // 自己不再另开滚动区：两层滚动容器会叠出两道槽，主体形变途中不滚动的约定也管不到里面那一层
    expect(css).not.toMatch(/overflow(-y)?\s*:\s*(auto|scroll)/);
  });
});

describe("快览行状态文字的留宽", () => {
  it("状态文字与不可见的最宽字样叠在同一格，宽度取最宽的那条；文字靠右、不折行，数字等宽", () => {
    const state = rule(".rowState");
    expect(state.get("display")).toBe("inline-grid");
    expect(state.get("flex")).toBe("none");
    expect(state.get("justify-items")).toBe("end");
    expect(state.get("white-space")).toBe("nowrap");
    expect(state.get("font-variant-numeric")).toBe("tabular-nums");
    expect(rule(".rowStateText").get("grid-area")).toBe("1 / 1");
    const sample = rule(".rowStateSample");
    expect(sample.get("grid-area")).toBe("1 / 1");
    expect(sample.get("visibility")).toBe("hidden");
  });
});

describe("快览底栏里的退场", () => {
  it("底栏自己是定位祖先：它随外框形变带 transform，退场的「清除已结束」量位置与被摆放都按它", () => {
    expect(rule(".foot").get("position")).toBe("relative");
  });
});

describe("下载入口的按压", () => {
  it("按下缩到 0.94，走 tap 弹簧；减少动画时改为瞬时降到 0.85 不透明度", () => {
    expect(rule(".entry:active").get("scale")).toBe("0.94");
    expect(rule(".entry").get("transition")).toContain("scale var(--sk-spring-tap-dur) var(--sk-spring-tap)");
    const reduced = rule(":global([data-sk-reduced]) .entry:active");
    expect(reduced.get("scale")).toBe("none");
    expect(reduced.get("opacity")).toBe("0.85");
    expect(reduced.get("transition")).toBe("none");
  });

  it("按压不写 transform、过渡里也没有 transform：跟着账户胶囊滑动的布局动画把位移写在行内 transform 上", () => {
    for (const selector of [".entry:active", ":global([data-sk-reduced]) .entry:active"]) expect(rule(selector).has("transform")).toBe(false);
    expect(rule(".entry").get("transition")).not.toMatch(/(^|,\s*)transform\s/);
  });
});

describe("失败点在两角之间换位", () => {
  it("用 translate 挪、沿 settle 过渡，不改 top / bottom", () => {
    const alone = rule(".failDot[data-alone]");
    expect(alone.get("translate")).toBe("0 -19px");
    expect(alone.has("top")).toBe(false);
    expect(alone.has("bottom")).toBe(false);
    expect(rule(".failDot").get("transition")).toBe("translate var(--sk-spring-settle-dur) var(--sk-spring-settle)");
    expect(rule(":global([data-sk-reduced]) .failDot").get("transition")).toBe("none");
  });
});
