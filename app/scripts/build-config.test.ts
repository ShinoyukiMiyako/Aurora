import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LICENSE_TEXT_FILE as appInfoLicenseFile, THIRD_PARTY_LICENSES_FILE as appInfoFile } from "../src/lib/app-info";
import { LICENSE_TEXT_FILE as scriptLicenseFile, THIRD_PARTY_LICENSES_FILE as scriptFile } from "./licenses-file.mjs";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSC = createRequire(import.meta.url).resolve("typescript/bin/tsc");

describe("构建配置", () => {
  // pnpm typecheck 只查 tsconfig.json，构建配置自己的工程没人跑就会悄悄坏掉
  it("vite.config.ts 与 vitest.config.ts 在 tsconfig.node.json 下类型检查零错误", () => {
    const result = spawnSync(process.execPath, [TSC, "-p", join(APP_DIR, "tsconfig.node.json"), "--noEmit", "--pretty", "false"], { cwd: APP_DIR, encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.stdout).toBe("");
    expect(result.status).toBe(0);
    // 构建配置的工程是 composite，tsc 必写增量信息；它得落在被忽略的 node_modules 里，不能弄脏工作区
    expect(existsSync(join(APP_DIR, "tsconfig.node.tsbuildinfo"))).toBe(false);
    expect(existsSync(join(APP_DIR, "node_modules", ".tmp", "tsconfig.node.tsbuildinfo"))).toBe(true);
  }, 60_000);

  it("前端读取许可清单用的文件名与构建时写出的是同一个", () => {
    expect(scriptFile).toBe("third-party-licenses.json");
    expect(appInfoFile).toBe(scriptFile);
  });

  it("前端读取协议全文用的文件名与构建时写出的是同一个", () => {
    expect(scriptLicenseFile).toBe("LICENSE.txt");
    expect(appInfoLicenseFile).toBe(scriptLicenseFile);
  });
});
