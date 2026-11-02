import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfigFromFile, type ConfigEnv, type Plugin, type PluginOption } from "vite";
import { describe, expect, it } from "vitest";
import { LICENSE_TEXT_FILE as appInfoLicenseFile, THIRD_PARTY_LICENSES_FILE as appInfoFile } from "../src/lib/app-info";
import { LICENSE_TEXT_FILE as scriptLicenseFile, THIRD_PARTY_LICENSES_FILE as scriptFile } from "./licenses-file.mjs";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSC = createRequire(import.meta.url).resolve("typescript/bin/tsc");

async function flattenPlugins(options: readonly PluginOption[]): Promise<Plugin[]> {
  const out: Plugin[] = [];
  for (const option of options) {
    const value = await option;
    if (Array.isArray(value)) out.push(...(await flattenPlugins(value)));
    else if (value) out.push(value);
  }
  return out;
}

/** 照 vite 命令行的方式读 vite.config.ts：不从测试里直接 import，免得把构建配置收进前端工程的类型检查。 */
async function licenseTextPlugin(env: ConfigEnv): Promise<Plugin> {
  const loaded = await loadConfigFromFile(env, join(APP_DIR, "vite.config.ts"), APP_DIR, "silent");
  if (loaded === null) throw new Error("vite.config.ts 没读出来");
  const plugin = (await flattenPlugins(loaded.config.plugins ?? [])).find((p) => p.name === "petalfall:license-text");
  if (plugin === undefined) throw new Error(`${env.mode} 模式没有挂协议全文插件`);
  return plugin;
}

type Middleware = (req: unknown, res: { setHeader(name: string, value: string): void; end(body: string): void }) => void;

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

// 关于页与引导程序的协议页都按这个文件名去读；哪个产物漏了它，界面上的协议全文就打不开
describe("协议全文随两个前端分发", () => {
  const license = readFileSync(join(APP_DIR, "..", "LICENSE"), "utf8");

  it.each(["production", "setup"])("%s 模式构建时把仓库根目录的 LICENSE 写成产物根目录的 LICENSE.txt", async (mode) => {
    const plugin = await licenseTextPlugin({ command: "build", mode });
    const emitted: unknown[] = [];
    const generateBundle = plugin.generateBundle as unknown as (this: { emitFile(file: unknown): void }) => void;
    generateBundle.call({ emitFile: (file) => emitted.push(file) });
    expect(emitted).toEqual([{ type: "asset", fileName: "LICENSE.txt", source: license }]);
  }, 30_000);

  it.each(["development", "setup"])("%s 模式的开发服务器在 /LICENSE.txt 上按纯文本给出同一份协议", async (mode) => {
    const plugin = await licenseTextPlugin({ command: "serve", mode });
    const mounted = new Map<string, Middleware>();
    const configureServer = plugin.configureServer as unknown as (server: { middlewares: { use(path: string, handler: Middleware): void } }) => void;
    configureServer({ middlewares: { use: (path, handler) => mounted.set(path, handler) } });
    expect([...mounted.keys()]).toEqual(["/LICENSE.txt"]);

    const headers: [string, string][] = [];
    let body: string | undefined;
    mounted.get("/LICENSE.txt")?.({}, { setHeader: (name, value) => headers.push([name, value]), end: (text) => (body = text) });
    expect(headers).toEqual([["Content-Type", "text/plain; charset=utf-8"]]);
    expect(body).toBe(license);
  }, 30_000);
});
