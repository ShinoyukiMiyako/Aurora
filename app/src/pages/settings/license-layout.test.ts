// 第三方许可列表的列宽约定。jsdom 不做布局，这里直接读样式表核对网格的列定义：
// 按内容定宽的列（版本、许可证）在网格分配里先于弹性列拿到空间，不给它们上限、也不给名称列下限时，
// 一长串许可证表达式就会把名称列挤成 0 宽。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./settings.module.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function block(selector: string): Map<string, string> {
  const match = new RegExp(`(^|\\n)${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`).exec(css);
  if (match === null) throw new Error(`样式表里没有 ${selector}`);
  const decls = new Map<string, string>();
  for (const decl of match[2].split(";")) {
    const at = decl.indexOf(":");
    if (at < 0) continue;
    decls.set(decl.slice(0, at).trim(), decl.slice(at + 1).trim());
  }
  return decls;
}

/** 按顶层空白切开列定义：括号里的逗号与空格不算分隔。 */
function tracks(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (/\s/.test(ch) && depth === 0) {
      if (current !== "") out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current !== "") out.push(current);
  return out;
}

function percentCap(track: string): number {
  const m = /^fit-content\((\d+)%\)$/.exec(track);
  if (m === null) throw new Error(`${track} 不是带百分比上限的 fit-content 列`);
  return Number(m[1]);
}

describe("第三方许可列表的列宽", () => {
  const row = block(".licenseRow");
  const columns = row.get("grid-template-columns");
  if (columns === undefined) throw new Error(".licenseRow 没有列定义");
  const [name, version, license, ...rest] = tracks(columns);

  it("名称、版本、许可证三列", () => {
    expect(rest).toEqual([]);
    expect([name, version, license].every((t) => t !== undefined)).toBe(true);
  });

  it("名称列有不小于 12 个字符的下限，并占满剩余宽度", () => {
    const m = /^minmax\((\d+)ch,\s*1fr\)$/.exec(name);
    if (m === null) throw new Error(`名称列 ${name} 没有以字符数给出的下限`);
    expect(Number(m[1])).toBeGreaterThanOrEqual(12);
  });

  it("版本与许可证按内容定宽但各有上限，两列加起来不超过整行的 70%，名称列总能留下至少 30%", () => {
    expect(percentCap(version) + percentCap(license)).toBeLessThanOrEqual(70);
  });

  it("超过上限的版本号与许可证表达式在本列内换行，而不是撑出列外", () => {
    for (const selector of [".licenseVersion", ".licenseId"]) {
      const decls = block(selector);
      expect(decls.get("overflow-wrap"), selector).toBe("anywhere");
      expect(decls.get("white-space"), selector).toBeUndefined();
    }
  });
});
