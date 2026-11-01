import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CRASH_CATEGORIES,
  CRASH_CATEGORY,
  CRASH_SOURCE_LABEL,
  EXIT_CODE_COPY,
  LAUNCH_WARNING,
  LAUNCH_WARNING_CODES,
  type CrashExplainContext,
} from "./flows";

// 前后端随同一个安装包发布：后端多出的类别或提醒在界面上没有文案会直接抛错，所以集合在测试里对齐，而不是等用户撞上。

/** Rust 源码里一个单元变体枚举的变体名（去掉注释与属性），并确认它按 snake_case 序列化。 */
function rustUnitVariants(source: string, enumName: string): string[] {
  const head = source.indexOf(`pub enum ${enumName} {`);
  if (head < 0) throw new Error(`源码里找不到 pub enum ${enumName}`);
  // 紧挨着枚举的文档注释与属性行（源码可能是 CRLF 检出）
  const above = source.slice(0, head).split(/\r?\n/);
  above.pop();
  const attrs: string[] = [];
  while (above.length > 0 && /^\s*(#\[|\/\/)/.test(above[above.length - 1])) attrs.push(above.pop() as string);
  if (!attrs.some((line) => line.includes('rename_all = "snake_case"'))) throw new Error(`${enumName} 没有按 snake_case 序列化，变体名换算不成界面值`);
  const close = source.indexOf("}", head);
  const body = source
    .slice(head + `pub enum ${enumName} {`.length, close)
    .replace(/\/\/.*$/gm, "")
    .replace(/#\[[^\]]*\]/g, "");
  const names = body
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  for (const name of names) if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) throw new Error(`${enumName} 的变体 ${name} 不是单元变体`);
  return names;
}

/** 与 serde 的 rename_all = "snake_case" 同一换算：每个大写字母前补下划线并转小写。 */
function snake(name: string): string {
  return name.replace(/[A-Z]/g, (c, i: number) => (i === 0 ? c.toLowerCase() : `_${c.toLowerCase()}`));
}

const crashRs = readFileSync(new URL("../../../crates/aurora-launch/src/crash.rs", import.meta.url), "utf8");
const launchRs = readFileSync(new URL("../../../crates/aurora-core/src/launch.rs", import.meta.url), "utf8");

describe("与后端的枚举对齐", () => {
  it("变体名换算与 serde 一致", () => {
    expect(snake("NativeCrash")).toBe("native_crash");
    expect(snake("OnedriveFolder")).toBe("onedrive_folder");
    expect(snake("JvmMinOverMax")).toBe("jvm_min_over_max");
    expect(rustUnitVariants("#[serde(rename_all = \"snake_case\")]\npub enum Demo {\n    /// 说明\n    A,\n    #[default]\n    BeCareful, // 尾注\n}", "Demo")).toEqual([
      "A",
      "BeCareful",
    ]);
  });

  it("崩溃类别：前端文案覆盖后端 CrashCategory 的全部变体，且不多出", () => {
    const backend = rustUnitVariants(crashRs, "CrashCategory").map(snake);
    expect([...backend].sort()).toEqual([...CRASH_CATEGORIES].sort());
  });

  it("启动提醒：前端文案覆盖后端 LaunchWarning 的全部变体，且不多出", () => {
    const backend = rustUnitVariants(launchRs, "LaunchWarning").map(snake);
    expect([...backend].sort()).toEqual([...LAUNCH_WARNING_CODES].sort());
  });
});

// 崩溃语境下不下定论、不道歉，术语统一：Mod 不叫模组，账户不叫账号。
const FORBIDDEN = ["导致", "引起", "造成", "元凶", "罪魁祸首", "问题出在", "崩溃原因是", "一键修复", "您", "抱歉", "模组", "账号", "帐号", "帐户", "！"];

const NOTE = { code: -1073741819, hex: "0xC0000005", kind: "access_violation", summary: "" } as const;

/** 每个类别能走到的解释分支：有 detail、没有 detail、Forge 自带的语言支持。 */
function explanations(): string[] {
  const full: CrashExplainContext = { detail: "sodium", currentJava: 17, requiredJava: 21, maxMemoryMb: 4096, exitCode: NOTE.code, exitNote: NOTE };
  const out: string[] = [];
  for (const category of CRASH_CATEGORIES) {
    const copy = CRASH_CATEGORY[category];
    out.push(copy.label, copy.title, copy.explain(full));
    if (category !== "duplicate_mod") out.push(copy.explain({ ...full, detail: null }));
  }
  out.push(CRASH_CATEGORY.missing_language_provider.explain({ ...full, detail: "javafml" }));
  return out;
}

describe("新增文案不用禁用词", () => {
  const texts = [
    ...explanations(),
    ...Object.values(EXIT_CODE_COPY).flatMap((c) => [c.phrase, c.explain]),
    ...Object.values(CRASH_SOURCE_LABEL),
    ...Object.values(LAUNCH_WARNING).flatMap((w) => [w.title, w.body, w.action.label]),
  ];

  it("收齐了全部类别、退出码说明与启动提醒", () => {
    // 17 类各有标签、标题与有 detail 的解释，除重复的 Mod 外再有无 detail 的解释，外加一条自带语言支持的分支
    expect(explanations()).toHaveLength(17 * 3 + 16 + 1);
    expect(texts).toHaveLength(68 + 3 * 2 + 4 + 8 * 3);
  });

  it.each(FORBIDDEN)("不含「%s」", (word) => {
    expect(texts.filter((t) => t.includes(word))).toEqual([]);
  });
});
