// 真实 bridge 的命令名和参数键是和 Rust 的 commands 对上的唯一地方，写错了只有到真机才发现。

import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  open: vi.fn(),
  win: { minimize: vi.fn(), close: vi.fn(), onCloseRequested: vi.fn() },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => tauri.win }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: tauri.open }));

import { createTauriBridge, inTauri } from "./bridge";
import type { InstallPlan, Progress } from "./contract";

beforeEach(() => {
  tauri.invoke.mockReset().mockResolvedValue(undefined);
  tauri.listen.mockReset();
  tauri.open.mockReset();
  tauri.win.minimize.mockReset();
  tauri.win.close.mockReset();
  tauri.win.onCloseRequested.mockReset();
});

describe("真实 bridge", () => {
  it("命令名和参数键与 Rust 一致", async () => {
    const bridge = createTauriBridge();
    const plan: InstallPlan = { mode: "fresh", dir: String.raw`D:\游戏 目录\app`, desktopShortcut: false };
    await bridge.probe();
    await bridge.checkDir("D:\\x");
    await bridge.launcherRunning();
    await bridge.install(plan);
    await bridge.openLauncher("D:\\x");
    await bridge.openLog();
    await bridge.runStandardInstaller();
    await bridge.windowReady();
    expect(tauri.invoke.mock.calls).toEqual([
      ["probe"],
      ["check_dir", { path: "D:\\x" }],
      ["launcher_running"],
      ["install", { plan }],
      ["open_launcher", { dir: "D:\\x" }],
      ["open_log"],
      ["run_standard_installer"],
      ["window_ready"],
    ]);
  });

  it("install 的拒绝原样透出，Failure 不被包一层", async () => {
    const failure = { code: "payload_exit", detail: "2" };
    tauri.invoke.mockRejectedValue(failure);
    await expect(createTauriBridge().install({ mode: "repair", dir: null, desktopShortcut: true })).rejects.toBe(failure);
  });

  it("进度事件取负载交给处理函数", async () => {
    const progress: Progress = { phase: "write", percent: 12.5, slow: false };
    const unlisten = vi.fn();
    tauri.listen.mockImplementation(async (name: string, handler: (event: { payload: Progress }) => void) => {
      expect(name).toBe("setup://progress");
      handler({ payload: progress });
      return unlisten;
    });
    const seen: Progress[] = [];
    await expect(createTauriBridge().onProgress((p) => seen.push(p))).resolves.toBe(unlisten);
    expect(seen).toEqual([progress]);
  });

  it("选文件夹只选一个目录，从给定位置打开", async () => {
    tauri.open.mockResolvedValue("D:\\picked");
    await expect(createTauriBridge().pickFolder("选一个安装位置", "D:\\x")).resolves.toBe("D:\\picked");
    expect(tauri.open).toHaveBeenCalledWith({ directory: true, multiple: false, title: "选一个安装位置", defaultPath: "D:\\x" });
  });

  it("外链走 opener 命令，非 http(s) 拒绝", async () => {
    const bridge = createTauriBridge();
    await bridge.openExternal("https://example.com/a");
    expect(tauri.invoke).toHaveBeenCalledWith("plugin:opener|open_url", { url: "https://example.com/a" });
    tauri.invoke.mockClear();
    await expect(bridge.openExternal("file:///C:/x.exe")).rejects.toThrow("只能打开 http(s) 网址");
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it("关闭请求按 allow 的结果拦或放", async () => {
    const handlers: ((event: { preventDefault(): void }) => void)[] = [];
    tauri.win.onCloseRequested.mockImplementation(async (handler: (typeof handlers)[number]) => {
      handlers.push(handler);
      return () => undefined;
    });
    let allowed = false;
    await createTauriBridge().onCloseRequested(() => allowed);
    const preventDefault = vi.fn();
    handlers[0]({ preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    allowed = true;
    handlers[0]({ preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it("最小化和关闭走当前窗口", async () => {
    const bridge = createTauriBridge();
    await bridge.minimize();
    await bridge.close();
    expect(tauri.win.minimize).toHaveBeenCalledTimes(1);
    expect(tauri.win.close).toHaveBeenCalledTimes(1);
  });

  // 三份原文都由构建写进引导程序自己的产物，不经 Rust 命令
  it("协议全文、附加条款与素材许可从产物根目录读，不走命令", async () => {
    const fetch = vi.fn(async (url: string) => new Response(`正文 ${url}`, { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const bridge = createTauriBridge();
    await expect(bridge.loadLicenseText()).resolves.toBe("正文 /LICENSE.txt");
    await expect(bridge.loadAdditionalTerms()).resolves.toBe("正文 /LICENSE-ADDITIONAL-TERMS.md");
    await expect(bridge.loadAssetLicense()).resolves.toBe("正文 /LICENSE-ASSETS.md");
    expect(fetch.mock.calls.map((c) => c[0])).toEqual(["/LICENSE.txt", "/LICENSE-ADDITIONAL-TERMS.md", "/LICENSE-ASSETS.md"]);
    expect(tauri.invoke).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("inTauri", () => {
  it("按窗口上有没有 Tauri 内部对象判断", () => {
    vi.stubGlobal("window", {});
    expect(inTauri()).toBe(false);
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    expect(inTauri()).toBe(true);
    vi.unstubAllGlobals();
  });
});
