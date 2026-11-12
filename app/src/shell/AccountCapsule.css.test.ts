// 账户胶囊与切换菜单的动效约定：jsdom 不跑 CSS 过渡，这里直接读样式表核对声明。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./AccountCapsule.module.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** 选择器恰好是 selector 的那条规则的声明块。 */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (m === null) throw new Error(`没有 ${selector} 规则`);
  return m[1];
}

describe("账户胶囊的按压", () => {
  it("按下缩到 0.97，用独立的 scale 属性，不被布局动画写在行内的 transform 盖掉", () => {
    expect(rule(".capsule:active:not(:disabled)")).toMatch(/\sscale:\s*0\.97;/);
    expect(rule(".capsule:active:not(:disabled)")).not.toMatch(/transform/);
    expect(rule(".capsule")).toMatch(/scale var\(--sk-spring-tap-dur\) var\(--sk-spring-tap\)/);
  });

  it("减少动画时不缩放，按下瞬时降到 0.85 不透明度", () => {
    const reduced = rule(":global([data-sk-reduced]) .capsule:active:not(:disabled)");
    expect(reduced).toMatch(/\sscale:\s*none;/);
    expect(reduced).toMatch(/\sopacity:\s*0\.85;/);
    expect(reduced).toMatch(/\stransition:\s*none;/);
  });

  it("等待期的胶囊占位但看不见；到时刻以透明度过渡淡入", () => {
    expect(rule(".capsule[data-pending]")).toMatch(/\sopacity:\s*0;/);
    expect(rule(".capsule")).toMatch(/opacity var\(--sk-dur-in\) var\(--sk-ease-out\)/);
  });

  it("胶囊裁掉溢出：长名换短名时按旧宽度退场的内容层不伸出胶囊右缘", () => {
    expect(rule(".capsule")).toMatch(/\soverflow:\s*hidden;/);
  });

  it("compact 档的正圆胶囊不裁：头像右上角的提醒点伸出内圆，裁了会被削掉一角", () => {
    expect(rule(".capsule[data-compact]")).toMatch(/\soverflow:\s*visible;/);
    // 同一特异性，写在 .capsule 之后才盖得住它的 hidden
    expect(css.indexOf(".capsule[data-compact] {")).toBeGreaterThan(css.indexOf(".capsule {"));
  });
});

describe("切换菜单", () => {
  it("高亮随键盘与指针瞬时切换，菜单项不做底色过渡", () => {
    expect(rule(".item")).not.toMatch(/transition/);
  });
});
