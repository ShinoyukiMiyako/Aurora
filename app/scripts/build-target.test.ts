import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildTarget } from "./build-target.mjs";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(rel: string): Record<string, any> {
  return JSON.parse(readFileSync(join(APP_DIR, rel), "utf8"));
}

describe("构建目标", () => {
  it("--mode setup 走引导程序的产物目录、入口、端口和许可清单起点", () => {
    expect(buildTarget("setup")).toEqual({ outDir: "dist-setup", html: "setup.html", port: 1430, hmrPort: 1431, rootPackage: "petalfall-setup", emitLicenseText: true });
  });

  it.each(["development", "production"])("默认模式 %s 仍是启动器，且不写协议全文", (mode) => {
    expect(buildTarget(mode)).toEqual({ outDir: "dist", html: "index.html", port: 1420, hmrPort: 1421, rootPackage: "petalfall-tauri", emitLicenseText: false });
  });

  it.each([
    ["production", "src-tauri/tauri.conf.json"],
    ["setup", "src-tauri-setup/tauri.conf.json"],
  ])("%s 的产物目录和端口与 %s 一致", (mode, conf) => {
    const target = buildTarget(mode);
    const { build } = readJson(conf);
    expect(build.devUrl).toBe(`http://localhost:${target.port}`);
    expect(build.frontendDist).toBe(`../${target.outDir}`);
  });

  it("package.json 的引导程序脚本按 setup 模式调 vite", () => {
    const { scripts } = readJson("package.json");
    expect(scripts["dev:setup"]).toBe("vite --mode setup");
    expect(scripts["build:setup"]).toBe("tsc && vite build --mode setup");
  });

  it("引导程序的 tauri 配置调的是这两个脚本，窗口由代码创建", () => {
    const conf = readJson("src-tauri-setup/tauri.conf.json");
    expect(conf.build.beforeDevCommand).toBe("pnpm dev:setup");
    expect(conf.build.beforeBuildCommand).toBe("pnpm build:setup");
    expect(conf.identifier).toBe("org.petalfall.setup");
    expect(conf.mainBinaryName).toBe("petalfall-setup");
    expect(conf.version).toBe("../src-tauri/tauri.conf.json");
    expect(conf.bundle.active).toBe(false);
    expect(conf.app.windows).toHaveLength(1);
    expect(conf.app.windows[0]).toMatchObject({ create: false, url: "setup.html", width: 880, height: 580, decorations: false, resizable: false, maximizable: false, visible: false });
  });

  // 按全集比对：只查缺的话，多授一条权限测试照样过，收窄就悄悄退回去了
  it("引导程序的能力文件只授予前端用到的权限", () => {
    const capability = readJson("src-tauri-setup/capabilities/default.json");
    expect(capability.windows).toEqual(["main"]);
    expect([...capability.permissions].sort()).toEqual(
      [
        "core:event:allow-listen",
        "core:event:allow-unlisten",
        "core:window:allow-minimize",
        "core:window:allow-close",
        "core:window:allow-destroy",
        "core:window:allow-start-dragging",
        "core:window:allow-internal-toggle-maximize",
        "opener:allow-open-url",
        "opener:allow-default-urls",
        "dialog:allow-open",
      ].sort(),
    );
  });

  it("引导程序的入口页挂的是 setup 的入口，并写死日樱外观", () => {
    const html = readFileSync(join(APP_DIR, buildTarget("setup").html), "utf8");
    expect(html).toContain('src="/src/setup/main.tsx"');
    expect(html).toContain('data-sk-mode="day"');
    expect(html).toContain('data-sk-accent="sakura"');
    expect(html).toContain('data-sk-tier="regular"');
  });
});
