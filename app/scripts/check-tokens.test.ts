import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkTokens, RULES } from "./check-tokens.mjs";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(SCRIPTS, "..");
const FIXTURES = join(SCRIPTS, "guard-fixtures");
const GUARD = join(SCRIPTS, "check-tokens.mjs");

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

/** bad 样例里每个违规行用 `expect T<n>` 标出，一行可以有多个标记。 */
function expectedMarks(root: string): string[] {
  return filesUnder(root)
    .flatMap((file) => {
      const rel = relative(root, file).split(sep).join("/");
      return readFileSync(file, "utf8")
        .split(/\r?\n/)
        .flatMap((line, i) => [...line.matchAll(/expect (T\d+)/g)].map((m) => `${rel}:${i + 1}:${m[1]}`));
    })
    .sort();
}

const found = (root: string) => checkTokens({ root }).map((v) => `${v.file}:${v.line}:${v.rule}`).sort();

const ruleDirs = readdirSync(FIXTURES).sort();

describe("令牌守卫", () => {
  const temps: string[] = [];
  const tempRoot = () => {
    const dir = mkdtempSync(join(tmpdir(), "sk-guard-"));
    temps.push(dir);
    return dir;
  };
  const writeIn = (root: string, rel: string, text: string) => {
    const file = join(root, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  afterEach(() => {
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("每条规则都有样例，T9 的 bad 样例在测试里现造", () => {
    const expected = Object.keys(RULES).sort();
    expect(ruleDirs).toEqual(expected);
    for (const rule of expected) {
      expect(readdirSync(join(FIXTURES, rule)).sort()).toEqual(rule === "T9" ? ["good"] : ["bad", "good"]);
    }
  });

  it.each(ruleDirs.filter((rule) => rule !== "T9"))("%s 的 bad 样例恰好命中所有标记行", (rule) => {
    const root = join(FIXTURES, rule, "bad");
    const marks = expectedMarks(root);
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.some((mark) => mark.endsWith(`:${rule}`))).toBe(true);
    expect(found(root)).toEqual(marks);
  });

  it.each(ruleDirs)("%s 的 good 样例零违规", (rule) => {
    expect(found(join(FIXTURES, rule, "good"))).toEqual([]);
  });

  it("T9 查 src、scripts 与 src-tauri/src 里的 Emoji", () => {
    const root = tempRoot();
    // 用码位现造，仓库里不落任何 Emoji 字符
    const glyph = String.fromCodePoint(0x1f338);
    writeIn(root, "src/ui/label.ts", `export const label = "${glyph}";\n`);
    writeIn(root, "scripts/tool.mjs", `console.log("ok");\nconsole.log("${glyph}");\n`);
    writeIn(root, "src-tauri/src/main.rs", `fn main() {}\n// ${glyph}\n`);
    writeIn(root, "src-tauri/src/notes.txt", `${glyph}\n`);
    expect(found(root)).toEqual(["scripts/tool.mjs:2:T9", "src-tauri/src/main.rs:2:T9", "src/ui/label.ts:1:T9"]);
  });

  it("豁免只覆盖注释所在行与下一行", () => {
    const root = tempRoot();
    writeIn(root, "src/ui/a.ts", ["// sk-guard-allow T1: 取色器原始值", 'export const a = "#111111";', 'export const b = "#222222";', ""].join("\n"));
    expect(found(root)).toEqual(["src/ui/a.ts:3:T1"]);
  });

  it("豁免只放过点名的规则", () => {
    const root = tempRoot();
    writeIn(root, "src/ui/a.ts", ["// sk-guard-allow T10: 关于页", 'export const a = "#111111 Petalfall";', ""].join("\n"));
    expect(found(root)).toEqual(["src/ui/a.ts:2:T1"]);
  });

  it("ui/ 白名单之外的字面色值照报", () => {
    const root = tempRoot();
    writeIn(root, "src/ui/a.module.css", [".a {", "  color: #FFFFFF;", "  background: #FFFFFE;", "}", ""].join("\n"));
    writeIn(root, "src/pages/a.module.css", [".a {", "  color: #FFFFFF;", "}", ""].join("\n"));
    expect(found(root)).toEqual(["src/pages/a.module.css:2:T1", "src/pages/a.module.css:2:T2", "src/ui/a.module.css:3:T1"]);
  });

  it("多行 transition 声明在分号处结束", () => {
    const root = tempRoot();
    writeIn(
      root,
      "src/ui/a.module.css",
      [".a {", "  transition:", "    opacity var(--sk-dur-hover) var(--sk-ease),", "    color 90ms linear;", "  inset: 0 2px;", "}", ""].join("\n"),
    );
    expect(found(root)).toEqual(["src/ui/a.module.css:4:T8"]);
  });

  it("命令行逐条打印「文件:行:规则」并以非 0 退出", () => {
    const bad = spawnSync(process.execPath, [GUARD, "--root", join(FIXTURES, "T11", "bad")], { encoding: "utf8" });
    expect(bad.status).toBe(1);
    expect(bad.stdout.trim()).toBe(`src/ui/Rich.tsx:1:T11 ${RULES.T11}:export const props = { dangerouslySetInnerHTML: { __html: "" } }; // expect T11`);
    expect(bad.stderr).toContain("1 处违规");

    const good = spawnSync(process.execPath, [GUARD, "--root", join(FIXTURES, "T11", "good")], { encoding: "utf8" });
    expect(good.status).toBe(0);
    expect(good.stdout).toContain("0 违规");
  });

  it("应用源码本身零违规", () => {
    expect(checkTokens({ root: APP_ROOT })).toEqual([]);
  });
});
