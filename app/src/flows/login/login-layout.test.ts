import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");
const css = strip(readFileSync(new URL("./login.module.css", import.meta.url), "utf8"));

/** 选择器原样相等的那条规则的声明。 */
function ruleFor(selector: string): string {
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (m[1].split(",").some((s) => s.trim() === selector)) return m[2];
  }
  throw new Error(`没有 ${selector} 规则`);
}

function declaration(rule: string, property: string): string {
  const match = new RegExp(`(?:^|\\s|;)${property}:\\s*([^;]+);`).exec(rule);
  if (match === null) throw new Error(`规则里没有 ${property}`);
  return match[1].replace(/\s+/g, " ").trim();
}

describe("登录弹窗的动效只动位移、缩放与透明度", () => {
  it("没有过渡布局属性、阴影、滤镜，也没有 transition: all", () => {
    for (const m of css.matchAll(/transition:\s*([^;]+);/g)) {
      expect(m[1]).not.toMatch(/\b(all|width|height|top|left|margin|padding|box-shadow|filter)\b/);
    }
  });

  it("换内容的那一格是退场项的定位基准", () => {
    expect(declaration(ruleFor(".swap"), "position")).toBe("relative");
  });
});

describe("离线账户", () => {
  it("用户名提示区预留两行：默认说明折成两行，换成一行的提示时下面不上抽", () => {
    expect(declaration(ruleFor(".offlineForm .nameField [data-reserve]"), "min-height")).toBe("calc(var(--sk-lh-caption) * 2)");
  });

  it("换立绘的那一格铺满舞台，宽窄不同的立绘互换时这一格不挪位", () => {
    const swap = ruleFor(".stageSwap");
    expect([declaration(swap, "flex"), declaration(swap, "align-self")]).toEqual(["1", "stretch"]);
    const slot = ruleFor(".stageSlot");
    expect([declaration(slot, "align-items"), declaration(slot, "justify-content")]).toEqual(["flex-end", "center"]);
  });
});

describe("按压回馈", () => {
  for (const name of ["preset", "profile"]) {
    it(`.${name} 按下缩到 0.97、松开沿 tap 弹回；减少动画时不缩放，降到 0.85 不透明度`, () => {
      expect(declaration(ruleFor(`.${name}:active`), "transform")).toBe("scale(0.97)");
      expect(declaration(ruleFor(`.${name}`), "transition")).toContain("transform var(--sk-spring-tap-dur) var(--sk-spring-tap)");
      const reduced = ruleFor(`:global([data-sk-reduced]) .${name}:active`);
      expect(declaration(reduced, "transform")).toBe("none");
      expect(declaration(reduced, "opacity")).toBe("0.85");
      expect(declaration(reduced, "transition")).toBe("none");
    });
  }
});

describe("状态换色与勾号", () => {
  it("角色勾号常驻：未选中时透明、缩在 0.6，选中时沿 pop 弹到位并淡入；减少动画不缩放", () => {
    const idle = ruleFor(".profileCheck");
    expect([declaration(idle, "opacity"), declaration(idle, "scale")]).toEqual(["0", "0.6"]);
    const checked = ruleFor('.profile[aria-checked="true"] .profileCheck');
    expect([declaration(checked, "opacity"), declaration(checked, "scale")]).toEqual(["1", "1"]);
    expect(declaration(checked, "transition")).toContain("scale var(--sk-spring-pop-dur) var(--sk-spring-pop)");
    expect(declaration(ruleFor(":global([data-sk-reduced]) .profileCheck"), "scale")).toBe("none");
  });

  it("步骤条、代码格与等待行的颜色走悬停时长的颜色过渡", () => {
    const dot = declaration(ruleFor(".stepperDot"), "transition");
    for (const property of ["border-color", "background-color", "color"]) expect(dot).toContain(`${property} var(--sk-dur-hover) var(--sk-ease)`);
    for (const selector of [".stepperItem", ".cell", ".waitLine"]) {
      expect(declaration(ruleFor(selector), "transition")).toBe("color var(--sk-dur-hover) var(--sk-ease)");
    }
  });
});
