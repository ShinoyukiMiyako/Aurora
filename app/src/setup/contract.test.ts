// 两边的契约各写一份，这里把 contract.rs 的字段和枚举取值读出来，与本文件里的 TS 样例逐一比对。
// 样例的类型标注让 tsc 把住 TS 这一边：多字段少字段都过不了类型检查。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PROGRESS_EVENT,
  isFailure,
  type DirCheck,
  type DirIssue,
  type Existing,
  type ExistingKind,
  type Failure,
  type FailureCode,
  type InstallMode,
  type InstallPlan,
  type Phase,
  type Probe,
  type Progress,
} from "./contract";

const RUST = readFileSync(new URL("../../src-tauri-setup/src/contract.rs", import.meta.url), "utf8");

function rustBody(kind: "struct" | "enum", name: string): string {
  const match = new RegExp(`pub ${kind} ${name} \\{([^}]*)\\}`).exec(RUST);
  if (match === null) throw new Error(`contract.rs 里没有 ${kind} ${name}`);
  return match[1];
}

const camel = (snake: string) => snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const snake = (pascal: string) => pascal.replace(/[A-Z]/g, (c, at: number) => (at === 0 ? c.toLowerCase() : `_${c.toLowerCase()}`));

const rustFields = (name: string) => [...rustBody("struct", name).matchAll(/pub (\w+):/g)].map((m) => camel(m[1])).sort();
const rustVariants = (name: string) => [...rustBody("enum", name).matchAll(/^\s*(\w+),\s*$/gm)].map((m) => snake(m[1])).sort();

const EXISTING: Existing = { kind: "upgrade", version: "", dir: "" };
const PROBE: Probe = { payloadVersion: "", defaultDir: "", requiredBytes: 0, existing: null, interrupted: false, elevated: false };
const PLAN: InstallPlan = { mode: "fresh", dir: null, desktopShortcut: true };
const CHECK: DirCheck = { normalized: "", issue: null, hasConfig: false, notEmpty: false, appended: false, freeBytes: 0 };
const PROGRESS: Progress = { phase: "unpack", percent: 0, slow: false };
const FAILURE: Failure = { code: "disk_full", detail: "" };

const EXISTING_KINDS: Record<ExistingKind, true> = { upgrade: true, same: true, newer: true, broken: true };
const INSTALL_MODES: Record<InstallMode, true> = { fresh: true, upgrade: true, repair: true };
const DIR_ISSUES: Record<DirIssue, true> = { empty: true, relative: true, bang: true, forbidden: true, minecraft: true, network: true, unwritable: true, no_space: true };
const PHASES: Record<Phase, true> = { unpack: true, write: true, verify: true };
const FAILURE_CODES: Record<FailureCode, true> = { dir_unwritable: true, disk_full: true, extract_failed: true, payload_exit: true, verify_failed: true };

describe("前后端契约", () => {
  it.each([
    ["Existing", EXISTING],
    ["Probe", PROBE],
    ["InstallPlan", PLAN],
    ["DirCheck", CHECK],
    ["Progress", PROGRESS],
    ["Failure", FAILURE],
  ])("结构 %s 两边字段一致", (name, sample) => {
    expect(rustFields(name)).toEqual(Object.keys(sample).sort());
  });

  it.each([
    ["ExistingKind", EXISTING_KINDS],
    ["InstallMode", INSTALL_MODES],
    ["DirIssue", DIR_ISSUES],
    ["Phase", PHASES],
    ["FailureCode", FAILURE_CODES],
  ])("枚举 %s 两边取值一致", (name, sample) => {
    expect(rustVariants(name)).toEqual(Object.keys(sample).sort());
  });

  it("进度事件名两边一致", () => {
    expect(RUST).toContain(`pub const PROGRESS_EVENT: &str = "${PROGRESS_EVENT}";`);
  });
});

describe("isFailure", () => {
  it.each(Object.keys(FAILURE_CODES))("认得 %s", (code) => {
    expect(isFailure({ code, detail: "x" })).toBe(true);
  });

  it.each([
    ["字符串", "IPC 断了"],
    ["null", null],
    ["未知错误码", { code: "boom", detail: "x" }],
    ["原型链上的键", { code: "constructor", detail: "x" }],
    ["缺原因", { code: "disk_full" }],
    ["原因不是字符串", { code: "disk_full", detail: 2 }],
  ])("不把%s当安装失败", (_, value) => {
    expect(isFailure(value)).toBe(false);
  });
});
