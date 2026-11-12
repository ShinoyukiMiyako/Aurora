// 更新面板的样式约定：jsdom 不做布局，这里直接读样式表核对声明。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatBytes } from "../domain/format";
import { UPDATE_COPY } from "../copy/updater";

const css = readFileSync(new URL("./UpdatePanel.module.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function rule(selector: string): Map<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (m === null) throw new Error(`没有 ${selector} 规则`);
  const decls = new Map<string, string>();
  for (const decl of m[1].split(";")) {
    const at = decl.indexOf(":");
    if (at < 0) continue;
    decls.set(decl.slice(0, at).trim(), decl.slice(at + 1).trim());
  }
  return decls;
}

describe("更新包的下载进度文字", () => {
  it("文字槽按最长的写法定宽、右对齐，数字等宽：数位与单位变化时同一行的进度条长度不变", () => {
    const text = rule(".progressText");
    expect(text.get("text-align")).toBe("right");
    expect(text.get("font-variant-numeric")).toBe("tabular-nums");
    const minWidth = text.get("min-width");
    if (minWidth === undefined) throw new Error(".progressText 没有写最小宽");
    const width = /^(\d+)ch$/.exec(minWidth);
    if (width === null) throw new Error(`.progressText 的最小宽不是按字符数写的：${minWidth}`);
    // 进位前的最大值：1024 进制下四舍五入够 1024 就进到下一个单位，所以每段最长是「1023 MB」这样的 7 个字符
    const longest = UPDATE_COPY.progress(formatBytes(1023 * 1024 * 1024 + 1), formatBytes(1023 * 1024 * 1024 + 1));
    expect(longest).toBe("1023 MB / 1023 MB");
    expect(Number(width[1])).toBeGreaterThanOrEqual(longest.length);
  });
});
