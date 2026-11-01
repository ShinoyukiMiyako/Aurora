import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./Toasts.module.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

describe("通知的位置", () => {
  it("弹窗打开时挪到右上角：主按钮在底栏右侧，通知留在右下角会盖住它", () => {
    const rule = /:global\(:root:has\(\[data-sk-modal-layer\]\)\) \.region \{([^}]*)\}/.exec(css);
    if (rule === null) throw new Error("没有弹窗打开时的位置规则");
    expect(rule[1]).toContain("bottom: auto");
    expect(rule[1]).toMatch(/top: /);
  });
});
