// jsdom 不做布局，这里直接读样式表核对：开局选项的说明行里有后端原文（读不到默认设置、开局 Mod 查不到），
// 其中的 Windows 路径没有空格可断，右栏又裁掉横向溢出，不放开折行后半截就看不见了。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./create.module.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function declarations(selector: string): string {
  const rule = new RegExp(`(?:^|\\n)\\.${selector}\\s*\\{([^}]*)\\}`).exec(css);
  if (rule === null) throw new Error(`样式表里没有 .${selector}`);
  return rule[1];
}

describe("确认步的说明行", () => {
  it("开局选项的说明行放开任意处折行，长路径不被右栏裁掉", () => {
    expect(declarations("optionNote")).toMatch(/overflow-wrap:\s*anywhere/);
  });

});
