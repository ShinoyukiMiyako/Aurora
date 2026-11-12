// 页头「全部取消」退场时的定位基准。它包在 popLayout 里，退场那一刻按 offsetParent 量位置、改成绝对定位留在原处淡出。
// 动作区按内容定宽、靠右：拿它作基准，退场项一抽走它的左缘就右移，退场项落到清除按钮上叠着淡出。
// jsdom 不做布局，这里读样式表核对：定位基准是页头，动作区自己不是定位元素。页头确实带上这个类由整页测试核对。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./tasks.module.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** 恰好以这个类为选择器的那条规则的声明体。 */
function ruleOf(className: string): string {
  const found = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((rule) => rule[1].trim() === `.${className}`);
  if (found.length !== 1) throw new Error(`.${className} 的规则有 ${found.length} 条`);
  return found[0][2];
}

/** 声明体里的 position；没写为 null。 */
function positionOf(body: string): string | null {
  const m = /(?:^|;)\s*position\s*:\s*([\w-]+)/.exec(body);
  return m === null ? null : m[1];
}

describe("全部取消退场时按页头定位", () => {
  it("页头是定位元素", () => {
    expect(positionOf(ruleOf("header"))).toBe("relative");
  });

  it("动作区不是定位元素：退场项越过它，按页头量位置", () => {
    expect(positionOf(ruleOf("headerActions"))).toBeNull();
  });
});
