import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfigFromFile, type ConfigEnv, type Plugin, type PluginOption } from "vite";
import { describe, expect, it } from "vitest";
import * as appInfo from "../src/lib/app-info";
import { ADDITIONAL_TERMS_FILE, ASSET_LICENSE_FILE, LICENSE_TEXT_FILE as scriptLicenseFile, THIRD_PARTY_LICENSES_FILE as scriptFile } from "./licenses-file.mjs";

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
    expect(appInfo.THIRD_PARTY_LICENSES_FILE).toBe(scriptFile);
  });

  it("前端读取协议全文用的文件名与构建时写出的是同一个", () => {
    expect(scriptLicenseFile).toBe("LICENSE.txt");
    expect(appInfo.LICENSE_TEXT_FILE).toBe(scriptLicenseFile);
  });

  // 条文按文件名互相指引，产物里的名字跟仓库根目录走
  it("前端读取附加条款与素材许可用的文件名与构建时写出的是同一个，也和仓库根目录的文件同名", () => {
    expect(ADDITIONAL_TERMS_FILE).toBe("LICENSE-ADDITIONAL-TERMS.md");
    expect(ASSET_LICENSE_FILE).toBe("LICENSE-ASSETS.md");
    expect(appInfo.ADDITIONAL_TERMS_FILE).toBe(ADDITIONAL_TERMS_FILE);
    expect(appInfo.ASSET_LICENSE_FILE).toBe(ASSET_LICENSE_FILE);
    expect(existsSync(join(APP_DIR, "..", ADDITIONAL_TERMS_FILE))).toBe(true);
    expect(existsSync(join(APP_DIR, "..", ASSET_LICENSE_FILE))).toBe(true);
  });
});

// 关于页与引导程序的协议页都按这些文件名去读；哪个产物漏了哪份，界面上那份就打不开
describe("协议全文、附加条款与素材许可随两个前端分发", () => {
  const root = (file: string) => readFileSync(join(APP_DIR, "..", file), "utf8");
  // 产物文件名、仓库根目录的源文件、开发服务器给的类型
  const texts: readonly [file: string, source: string, contentType: string][] = [
    ["LICENSE.txt", "LICENSE", "text/plain; charset=utf-8"],
    ["LICENSE-ADDITIONAL-TERMS.md", "LICENSE-ADDITIONAL-TERMS.md", "text/markdown; charset=utf-8"],
    ["LICENSE-ASSETS.md", "LICENSE-ASSETS.md", "text/markdown; charset=utf-8"],
  ];

  it.each(["production", "setup"])("%s 模式构建时把仓库根目录的三份文本逐字写进产物根目录", async (mode) => {
    const plugin = await licenseTextPlugin({ command: "build", mode });
    const emitted: unknown[] = [];
    const generateBundle = plugin.generateBundle as unknown as (this: { emitFile(file: unknown): void }) => void;
    generateBundle.call({ emitFile: (file) => emitted.push(file) });
    expect(emitted).toEqual(texts.map(([file, source]) => ({ type: "asset", fileName: file, source: root(source) })));
  }, 30_000);

  it.each(["development", "setup"])("%s 模式的开发服务器在同名路径上给出同一份文本", async (mode) => {
    const plugin = await licenseTextPlugin({ command: "serve", mode });
    const mounted = new Map<string, Middleware>();
    const configureServer = plugin.configureServer as unknown as (server: { middlewares: { use(path: string, handler: Middleware): void } }) => void;
    configureServer({ middlewares: { use: (path, handler) => mounted.set(path, handler) } });
    expect([...mounted.keys()]).toEqual(texts.map(([file]) => `/${file}`));

    for (const [file, source, contentType] of texts) {
      const headers: [string, string][] = [];
      let body: string | undefined;
      mounted.get(`/${file}`)?.({}, { setHeader: (name, value) => headers.push([name, value]), end: (text) => (body = text) });
      expect(headers).toEqual([["Content-Type", contentType]]);
      expect(body).toBe(root(source));
    }
  }, 30_000);
});
