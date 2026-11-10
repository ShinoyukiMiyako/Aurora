import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { lockedCliIntegrities } from "./locked-cli.mjs";

const SCRIPT = fileURLToPath(new URL("./locked-cli.mjs", import.meta.url));
const LOCK_PATH = fileURLToPath(new URL("../../app/pnpm-lock.yaml", import.meta.url));
// Windows 上检出的锁文件是 CRLF，CI 上是 LF；脚本两种都认，这里的对照统一按 LF 找
const LOCK = readFileSync(LOCK_PATH, "utf8").replace(/\r\n/g, "\n");
const PACKAGE = JSON.parse(readFileSync(new URL("../../app/package.json", import.meta.url), "utf8"));

const root = mkdtempSync(join(tmpdir(), "locked-cli-"));
after(() => rmSync(root, { recursive: true, force: true }));

const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** text 里 pattern 的全部匹配取第 1 组，要求恰好一条。 */
function only(text, pattern, what) {
  const found = [...text.matchAll(pattern)].map((match) => match[1]);
  assert.equal(found.length, 1, `${what} 应恰好一处，实际 ${found.length} 处`);
  return found[0];
}

// 锁定版本不写死：从 package.json 的声明出发，到锁文件 importers 里同一条声明下面读 version，CLI 一升级这里跟着走
const SPECIFIER = PACKAGE.devDependencies["@tauri-apps/cli"];
const VERSION = only(
  LOCK,
  new RegExp(`^      '@tauri-apps/cli':\\n        specifier: ${literal(SPECIFIER)}\\n        version: (\\S+)$`, "gm"),
  "锁文件 importers 里 @tauri-apps/cli 的声明",
);
// 对照值按整段文本直接找 packages 里那一条的 resolution，不经过被测函数的逐行索引
const integrityInLock = (name) =>
  only(
    LOCK,
    new RegExp(`^  '@tauri-apps/${literal(name)}@${literal(VERSION)}':\\n    resolution: \\{integrity: (sha512-[^}\\s]+)\\}$`, "gm"),
    `锁文件 packages 里 @tauri-apps/${name}@${VERSION} 的 integrity`,
  );
const CLI_INTEGRITY = integrityInLock("cli");
const GNU_INTEGRITY = integrityInLock("cli-linux-x64-gnu");

// 构造的锁文件：版本、键和 resolution 的写法都照真实锁文件；snapshots 里的同名键没有 resolution，不能被算进去
const fake = (name) => `sha512-${createHash("sha512").update(name).digest("base64")}`;
const FAKE_CLI = fake("cli");
const FAKE_GNU = fake("cli-linux-x64-gnu");
const lockText = ({ packages }) =>
  [
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .:",
    "    devDependencies:",
    "      '@tauri-apps/cli':",
    "        specifier: ~2.11.5",
    "        version: 2.11.5",
    "",
    "packages:",
    "",
    ...packages,
    "snapshots:",
    "",
    "  '@tauri-apps/cli-linux-x64-gnu@2.11.5':",
    "    optional: true",
    "",
    "  '@tauri-apps/cli@2.11.5':",
    "    optionalDependencies:",
    "      '@tauri-apps/cli-linux-x64-gnu': 2.11.5",
    "",
  ].join("\n");
const CLI_ENTRY = ["  '@tauri-apps/cli@2.11.5':", `    resolution: {integrity: ${FAKE_CLI}}`, "    hasBin: true", ""];
const GNU_ENTRY = ["  '@tauri-apps/cli-linux-x64-gnu@2.11.5':", `    resolution: {integrity: ${FAKE_GNU}}`, "    cpu: [x64]", ""];

function writeLock(name, text) {
  const path = join(root, name);
  writeFileSync(path, text, "utf8");
  return path;
}

describe("按锁文件取签名 CLI 的 integrity", () => {
  it("仓库里的锁文件读出锁定版本下 cli 与 cli-linux-x64-gnu 两条 sha512 integrity", () => {
    // sha512 摘要 64 字节，base64 后带两个等号；两条不同，免得把同一条读了两遍
    for (const integrity of [CLI_INTEGRITY, GNU_INTEGRITY]) {
      assert.match(integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
      assert.equal(Buffer.from(integrity.slice("sha512-".length), "base64").length, 64);
    }
    assert.notEqual(CLI_INTEGRITY, GNU_INTEGRITY);
    const expected = [
      { name: "cli", integrity: CLI_INTEGRITY },
      { name: "cli-linux-x64-gnu", integrity: GNU_INTEGRITY },
    ];
    assert.deepEqual(lockedCliIntegrities(LOCK, VERSION), expected);
    assert.deepEqual(lockedCliIntegrities(LOCK.replace(/\n/g, "\r\n"), VERSION), expected);
  });

  // 工作流按 `while IFS=$'\t' read -r name integrity` 逐行读这份输出，格式差一点就取错包或一个都不核对
  it("命令行对仓库里的锁文件输出两行 名字<TAB>integrity，先 cli 后 cli-linux-x64-gnu", () => {
    const result = run(LOCK_PATH, VERSION);
    assert.equal(result.stderr, "");
    assert.equal(result.status, 0);
    assert.equal(result.stdout, `cli\t${CLI_INTEGRITY}\ncli-linux-x64-gnu\t${GNU_INTEGRITY}\n`);
  });

  it("构造的锁文件里 snapshots 的同名键不算，只认 packages 里带 resolution 的那一条", () => {
    assert.deepEqual(lockedCliIntegrities(lockText({ packages: [...GNU_ENTRY, ...CLI_ENTRY] }), "2.11.5"), [
      { name: "cli", integrity: FAKE_CLI },
      { name: "cli-linux-x64-gnu", integrity: FAKE_GNU },
    ]);
  });

  it("要求的版本与锁定的不符时以非零退出，不输出任何一行", () => {
    const result = run(writeLock("mismatch.yaml", lockText({ packages: [...GNU_ENTRY, ...CLI_ENTRY] })), "2.11.6");
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /锁文件锁定 @tauri-apps\/cli 2\.11\.5，要求的是 2\.11\.6/);
  });

  it("Linux 原生绑定一条 integrity 都没有时以非零退出，cli 那一行也不输出", () => {
    const result = run(writeLock("zero.yaml", lockText({ packages: CLI_ENTRY })), "2.11.5");
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /锁文件里 @tauri-apps\/cli-linux-x64-gnu@2\.11\.5 的 integrity 应有恰好一条，实际 0 条/);
  });

  it("CLI 本体的 integrity 多于一条时以非零退出", () => {
    const result = run(writeLock("double.yaml", lockText({ packages: [...CLI_ENTRY, ...GNU_ENTRY, ...CLI_ENTRY] })), "2.11.5");
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /锁文件里 @tauri-apps\/cli@2\.11\.5 的 integrity 应有恰好一条，实际 2 条/);
  });
});
