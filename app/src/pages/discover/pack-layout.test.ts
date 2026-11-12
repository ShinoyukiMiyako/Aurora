// 导入弹窗与受限文件清单里「不让东西变宽变高」的样式规则。jsdom 不做布局，这里直接读样式表核对。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./pack.module.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** 选择器（逗号分组里的任一个）对应的声明，按属性名取值；同一个选择器出现多次时后面的覆盖前面的。 */
function decls(selector: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!m[1].split(",").some((s) => s.trim() === selector)) continue;
    for (const part of m[2].split(";")) {
      const at = part.indexOf(":");
      if (at >= 0) out.set(part.slice(0, at).trim(), part.slice(at + 1).trim().replace(/\s+/g, " "));
    }
  }
  return out;
}

describe("投放区", () => {
  it("选文件面与读取面叠在同一格：读取开始时投放区不变高", () => {
    expect(decls(".dropZone").get("display")).toBe("grid");
    expect(decls(".dropFace").get("grid-area")).toBe("1 / 1");
  });

  it("拖进拖出时描边、底色与字色按悬停时长过渡，不写 all", () => {
    const transition = decls(".dropZone").get("transition");
    expect(transition?.split(", ")).toEqual([
      "border-color var(--sk-dur-hover) var(--sk-ease)",
      "background-color var(--sk-dur-hover) var(--sk-ease)",
      "color var(--sk-dur-hover) var(--sk-ease)",
    ]);
  });
});

describe("受限文件清单的主按钮", () => {
  it("三条文案叠在同一格按最宽留宽：没在显示的两条只画在不可见的伪元素里", () => {
    for (const part of [".primaryLabel > span", ".primaryLabel::before", ".primaryLabel::after"]) expect(decls(part).get("grid-area")).toBe("1 / 1");
    expect(decls(".primaryLabel").get("display")).toBe("inline-grid");
    expect(decls(".primaryLabel::before").get("content")).toBe("attr(data-reserve-a)");
    expect(decls(".primaryLabel::after").get("content")).toBe("attr(data-reserve-b)");
    expect(decls(".primaryLabel::before").get("visibility")).toBe("hidden");
    expect(decls(".primaryLabel::after").get("visibility")).toBe("hidden");
  });
});

describe("换内容时旧的一块叠在原处淡出", () => {
  it("说明块所在的栈都是定位容器：抽出布局的旧说明以它为基准，不飘到弹窗面板的角上", () => {
    for (const stack of [".blocked", ".choose", ".confirm"]) expect(decls(stack).get("position")).toBe("relative");
  });

  it("整合包表单转成只读时撤下的名称框、版本行与换封面，也以所在的栈为基准在原处淡出；名称文字的包裹层仍是弹性盒，长名称截得出省略号", () => {
    for (const stack of [".packFields", ".stageColumn"]) expect(decls(stack).get("position")).toBe("relative");
    const item = decls(".packField");
    expect([item.get("display"), item.get("flex-direction"), item.get("min-width")]).toEqual(["flex", "column", "0"]);
  });
});

describe("确认步的页脚", () => {
  it("挂载点撑满页脚、按页脚的间距排开，随确认步出现时淡入一次", () => {
    const host = decls(".footerHost");
    expect([host.get("display"), host.get("flex"), host.get("gap")]).toEqual(["flex", "1", "var(--sk-space-10)"]);
    expect(host.get("animation")).toBe("footer-in var(--sk-dur-in) var(--sk-ease-out) backwards");
    expect(css).toMatch(/@keyframes footer-in\s*\{\s*from\s*\{\s*opacity:\s*0;\s*\}\s*\}/);
  });
});
