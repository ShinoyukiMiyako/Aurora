import { describe, expect, it } from "vitest";
import { FAKE_PROBE, createFakeBridge, fakeFromQuery } from "./fake-bridge";

describe("fakeFromQuery", () => {
  it("默认从 boot 开始，让 App 真的走一遍探测", () => {
    const fake = fakeFromQuery("");
    expect(fake.initial.view).toBe("boot");
    expect(fake.lang).toBeNull();
  });

  it.each([
    ["location", "location"],
    ["blocked", "blocked"],
    ["installing", "installing"],
    ["slow", "installing"],
    ["done", "done"],
    ["failed", "failed"],
    ["legal", "legal"],
    ["fatal", "fatal"],
  ])("?state=%s 直达 %s 视图", (state, view) => {
    expect(fakeFromQuery(`?state=${state}`).initial.view).toBe(view);
  });

  it.each(["upgrade", "same", "newer", "broken"])("?state=installed&kind=%s 让探测带上这种现有安装", async (kind) => {
    const fake = fakeFromQuery(`?state=installed&kind=${kind}`);
    expect(fake.initial.view).toBe("boot");
    expect((await fake.bridge.probe()).existing?.kind).toBe(kind);
  });

  it("?code= 选失败原因，退出码是可显示的数字", () => {
    expect(fakeFromQuery("?state=failed&code=disk_full").initial.failure?.code).toBe("disk_full");
    expect(fakeFromQuery("?state=failed").initial.failure).toEqual({ code: "payload_exit", detail: "2" });
  });

  it("?mode= 选安装种类，升级和修复都不带目录", () => {
    expect(fakeFromQuery("?state=done&mode=upgrade").initial.plan).toEqual({ mode: "upgrade", dir: null, desktopShortcut: false });
    expect(fakeFromQuery("?state=installing&mode=repair").initial.plan).toEqual({ mode: "repair", dir: null, desktopShortcut: false });
  });

  it("?lang= 原样带出，?elevated 与 ?interrupted 进探测结果", async () => {
    const fake = fakeFromQuery("?lang=en&elevated=1&interrupted=1");
    expect(fake.lang).toBe("en");
    const probe = await fake.bridge.probe();
    expect(probe.elevated).toBe(true);
    expect(probe.interrupted).toBe(true);
  });

  it("写错状态名时抛错，不悄悄落到默认状态", () => {
    expect(() => fakeFromQuery("?state=nope")).toThrow("不是");
  });

  it("blocked 状态下启动器开着，别的状态没开", async () => {
    await expect(fakeFromQuery("?state=blocked").bridge.launcherRunning()).resolves.toBe(true);
    await expect(fakeFromQuery("?state=done").bridge.launcherRunning()).resolves.toBe(false);
  });
});

describe("createFakeBridge", () => {
  it("记录调用和参数", async () => {
    const fake = createFakeBridge();
    await fake.checkDir("D:\\a");
    await fake.openLauncher("D:\\b");
    expect(fake.calls).toEqual([
      { name: "checkDir", args: ["D:\\a"] },
      { name: "openLauncher", args: ["D:\\b"] },
    ]);
    expect(fake.callsOf("openLauncher")).toEqual([["D:\\b"]]);
  });

  it("install 依次发进度，再按设定的结果结束", async () => {
    const failure = { code: "disk_full", detail: "x" } as const;
    const fake = createFakeBridge({ outcome: failure, progress: [{ phase: "unpack", percent: 5, slow: false }] });
    const seen: number[] = [];
    await fake.onProgress((p) => seen.push(p.percent));
    await expect(fake.install({ mode: "fresh", dir: "D:\\a", desktopShortcut: true })).rejects.toBe(failure);
    expect(seen).toEqual([5]);
  });

  it("关闭请求按注册的判断放行或拦下，退订后放行", async () => {
    const fake = createFakeBridge();
    expect(fake.requestClose()).toBe(true);
    const unlisten = await fake.onCloseRequested(() => false);
    expect(fake.requestClose()).toBe(false);
    unlisten();
    expect(fake.requestClose()).toBe(true);
  });

  it("默认探测是全新安装", async () => {
    await expect(createFakeBridge().probe()).resolves.toEqual(FAKE_PROBE);
    expect(FAKE_PROBE.existing).toBeNull();
  });
});
