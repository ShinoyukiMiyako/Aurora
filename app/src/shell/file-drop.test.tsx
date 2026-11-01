// @vitest-environment jsdom
// @module-tag heavy-page
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DROP_COPY } from "../copy/shell";
import { LauncherProvider, useLauncher, type LauncherApi } from "../state/launcher";
import { render, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, resetRecorder, settle } from "../test/launcher";
import { DropHint } from "./DropHint";
import { fileExtension, firstModpack, isFileOfKind } from "./file-drop";
import { OverlayRoot } from "./overlay";
import { ShellProvider, useNav, useShell, type NavApi, type ShellApi } from "./shell";
import { WindowPortProvider, browserWindowPort, type WindowDropEvent, type WindowPort } from "./window";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

let view: Rendered | undefined;
let nav: NavApi;
let shell: ShellApi;
let launcher: LauncherApi;
let dropHandlers: ((event: WindowDropEvent) => void)[];
let port: WindowPort;

function Probe() {
  nav = useNav();
  shell = useShell();
  launcher = useLauncher();
  return <DropHint hint={shell.fileDropHint} />;
}

async function mount() {
  view = render(
    <WindowPortProvider port={port}>
      <LauncherProvider>
        <ShellProvider>
          <Probe />
          <OverlayRoot />
        </ShellProvider>
      </LauncherProvider>
    </WindowPortProvider>,
  );
  await act(async () => {
    await settle();
  });
}

/** 模拟系统的一次拖放事件。 */
const fire = (event: WindowDropEvent) =>
  act(() => {
    for (const handler of [...dropHandlers]) handler(event);
  });

const hintText = () => document.querySelector('[role="status"][data-hint]')?.textContent;

const PACK = "D:\\Downloads\\All the Mods 10.mrpack";
const CF_PACK = "C:\\Users\\a\\Desktop\\RLCraft.ZIP";
const JAR = "D:\\Downloads\\sodium.jar";
const JAR_B = "D:\\Downloads\\Lithium.JAR";

beforeEach(() => {
  vi.useFakeTimers();
  resetRecorder(ipc);
  stubResizeObserver();
  bootOverrides(ipc);
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  dropHandlers = [];
  port = {
    ...browserWindowPort(),
    onDrop: async (handler) => {
      dropHandlers.push(handler);
      return () => {
        dropHandlers = dropHandlers.filter((h) => h !== handler);
      };
    },
  };
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
});

describe("文件种类判定", () => {
  it("扩展名取最后一段文件名的最后一个点之后，不分大小写；没有扩展名或以点开头为空", () => {
    expect(fileExtension(PACK)).toBe("mrpack");
    expect(fileExtension(CF_PACK)).toBe("zip");
    expect(fileExtension("/home/a/pack.tar.gz")).toBe("gz");
    expect(fileExtension("D:\\a.b\\README")).toBe("");
    expect(fileExtension("D:\\packs\\.zip")).toBe("");
  });

  it("整合包只认 .mrpack 与 .zip；一次拖进多个文件取第一个整合包", () => {
    expect(isFileOfKind(PACK, "modpack")).toBe(true);
    expect(isFileOfKind(CF_PACK, "modpack")).toBe(true);
    expect(isFileOfKind("D:\\mods\\sodium.jar", "modpack")).toBe(false);
    expect(firstModpack(["D:\\a.png", CF_PACK, PACK])).toBe(CF_PACK);
    expect(firstModpack(["D:\\a.png", "D:\\b.jar"])).toBeNull();
    expect(firstModpack([])).toBeNull();
  });
});

describe("窗口级拖放：外壳自己处理", () => {
  it("拖进整合包显示放置提示；松开后导航到发现页并带上文件路径，提示收起", async () => {
    await mount();
    expect(dropHandlers).toHaveLength(1);
    fire({ type: "enter", content: { kind: "files", paths: [PACK] } });
    expect(shell.fileDropHint).toBe("modpack");
    expect(hintText()).toBe(DROP_COPY.modpackHint);
    fire({ type: "drop", content: { kind: "files", paths: ["D:\\notes.txt", PACK] } });
    expect(nav.route).toEqual({ page: "discover", importFile: PACK });
    expect(shell.fileDropHint).toBeNull();
    expect(nav.canBack).toBe(true);
  });

  it("拖出窗口：提示收起，不导航", async () => {
    await mount();
    fire({ type: "enter", content: { kind: "files", paths: [CF_PACK] } });
    fire({ type: "leave" });
    expect(shell.fileDropHint).toBeNull();
    expect(nav.route).toEqual({ page: "home" });
  });

  it("拖进的不是整合包：不显示提示；松开后不导航，弹一条只认哪两种文件的提醒", async () => {
    await mount();
    fire({ type: "enter", content: { kind: "files", paths: ["D:\\shots\\sakura.png"] } });
    expect(shell.fileDropHint).toBeNull();
    fire({ type: "drop", content: { kind: "files", paths: ["D:\\shots\\sakura.png"] } });
    expect(nav.route).toEqual({ page: "home" });
    expect(launcher.state.toasts.map((t) => [t.tone, t.title, t.body])).toEqual([["warning", DROP_COPY.notModpack.title, DROP_COPY.notModpack.body]]);
  });

  it("没有页面收 .jar 时拖进 .jar：不显示提示；松开后不导航，说明要到实例的 Mod 页，不再说它不是整合包", async () => {
    await mount();
    fire({ type: "enter", content: { kind: "files", paths: [JAR] } });
    expect(shell.fileDropHint).toBeNull();
    fire({ type: "drop", content: { kind: "files", paths: [JAR, JAR_B] } });
    expect(nav.route).toEqual({ page: "home" });
    expect(launcher.state.toasts.map((t) => [t.tone, t.title, t.body])).toEqual([["warning", DROP_COPY.jarElsewhere.title, DROP_COPY.jarElsewhere.body]]);
  });

  it("没有页面收 .jar 时 .jar 和整合包一起拖进来：照常导入整合包", async () => {
    await mount();
    fire({ type: "enter", content: { kind: "files", paths: [JAR, PACK] } });
    expect(shell.fileDropHint).toBe("modpack");
    fire({ type: "drop", content: { kind: "files", paths: [JAR, PACK] } });
    expect(nav.route).toEqual({ page: "discover", importFile: PACK });
    expect(launcher.state.toasts).toEqual([]);
  });

  it("有浮层打开时外壳不处理：不提示、不导航、不提醒", async () => {
    await mount();
    act(() => shell.openPalette());
    fire({ type: "enter", content: { kind: "files", paths: [PACK] } });
    expect(shell.fileDropHint).toBeNull();
    fire({ type: "drop", content: { kind: "files", paths: [PACK] } });
    expect(nav.route).toEqual({ page: "home" });
    expect(launcher.state.toasts).toEqual([]);
  });

  it("首次启动向导期间外壳不处理", async () => {
    bootOverrides(ipc, { firstRun: true });
    await mount();
    expect(launcher.state.firstRun).toBe(true);
    fire({ type: "enter", content: { kind: "files", paths: [PACK] } });
    fire({ type: "drop", content: { kind: "files", paths: [PACK] } });
    expect(shell.fileDropHint).toBeNull();
    expect(nav.route).toEqual({ page: "home" });
  });
});

describe("窗口级拖放：外置登录服务器链接", () => {
  const SERVER = "https://littleskin.cn/api/yggdrasil";
  const link = { kind: "auth_server", url: SERVER } as const;

  it("拖进链接显示「松开以添加外置登录服务器」；松开后打开外置登录弹窗并带上地址，提示收起，不导航", async () => {
    await mount();
    fire({ type: "enter", content: link });
    expect(shell.fileDropHint).toBe("auth_server");
    expect(hintText()).toBe(DROP_COPY.authServerHint);
    await act(async () => {
      for (const handler of [...dropHandlers]) handler({ type: "drop", content: link });
      await settle();
    });
    expect(shell.fileDropHint).toBeNull();
    expect(launcher.state.login).toEqual({ kind: "authlib", intent: { kind: "manual" }, prefill: null, dropped: SERVER });
    expect(nav.route).toEqual({ page: "home" });
  });

  it("拖出窗口：提示收起，不打开弹窗", async () => {
    await mount();
    fire({ type: "enter", content: link });
    fire({ type: "leave" });
    expect(shell.fileDropHint).toBeNull();
    expect(launcher.state.login).toBeNull();
  });

  it("有浮层打开或在首次启动向导里：不提示，松开也不打开弹窗", async () => {
    await mount();
    act(() => shell.openPalette());
    fire({ type: "enter", content: link });
    expect(shell.fileDropHint).toBeNull();
    fire({ type: "drop", content: link });
    expect(launcher.state.login).toBeNull();
    view?.unmount();

    bootOverrides(ipc, { firstRun: true });
    await mount();
    fire({ type: "enter", content: link });
    fire({ type: "drop", content: link });
    expect(shell.fileDropHint).toBeNull();
    expect(launcher.state.login).toBeNull();
  });

  it("登记了接收方（导入弹窗的投放区）：链接不交给它，外壳也不处理", async () => {
    await mount();
    const target = { onEnter: vi.fn(), onLeave: vi.fn(), onDrop: vi.fn() };
    act(() => void shell.registerFileDrop(target));
    fire({ type: "enter", content: link });
    fire({ type: "drop", content: link });
    expect(target.onEnter).not.toHaveBeenCalled();
    expect(target.onDrop).not.toHaveBeenCalled();
    expect(shell.fileDropHint).toBeNull();
    expect(launcher.state.login).toBeNull();
  });
});

describe("窗口级拖放：登记了接收方", () => {
  it("最后登记的接收方独占全部事件，外壳不提示也不导航；注销后外壳恢复处理", async () => {
    await mount();
    const outer = { onEnter: vi.fn(), onLeave: vi.fn(), onDrop: vi.fn() };
    const inner = { onEnter: vi.fn(), onLeave: vi.fn(), onDrop: vi.fn() };
    let offOuter = () => {};
    let offInner = () => {};
    act(() => {
      offOuter = shell.registerFileDrop(outer);
      offInner = shell.registerFileDrop(inner);
    });
    fire({ type: "enter", content: { kind: "files", paths: [PACK] } });
    fire({ type: "leave" });
    fire({ type: "drop", content: { kind: "files", paths: ["D:\\a.jar", PACK] } });
    expect(inner.onEnter.mock.calls).toEqual([[[PACK]]]);
    expect(inner.onLeave).toHaveBeenCalledTimes(1);
    expect(inner.onDrop.mock.calls).toEqual([[["D:\\a.jar", PACK]]]);
    expect(outer.onEnter).not.toHaveBeenCalled();
    expect(outer.onDrop).not.toHaveBeenCalled();
    expect(shell.fileDropHint).toBeNull();
    expect(nav.route).toEqual({ page: "home" });

    act(() => offInner());
    fire({ type: "drop", content: { kind: "files", paths: [PACK] } });
    expect(outer.onDrop.mock.calls).toEqual([[[PACK]]]);
    act(() => offOuter());
    fire({ type: "drop", content: { kind: "files", paths: [PACK] } });
    expect(nav.route).toEqual({ page: "discover", importFile: PACK });
  });

  it("接收方没给 onEnter / onLeave 时只收松开", async () => {
    await mount();
    const onDrop = vi.fn();
    act(() => void shell.registerFileDrop({ onDrop }));
    fire({ type: "enter", content: { kind: "files", paths: [PACK] } });
    fire({ type: "leave" });
    fire({ type: "drop", content: { kind: "files", paths: [PACK] } });
    expect(onDrop).toHaveBeenCalledTimes(1);
  });
});

describe("窗口级拖放：页面收 .jar", () => {
  const jarTarget = (reason?: string) => ({ lockReason: vi.fn(() => reason), onDrop: vi.fn() });
  const toastsNow = () => launcher.state.toasts.map((t) => [t.tone, t.title, t.body]);

  it("拖进 .jar 提示松开以添加；松开只把 .jar 按原顺序交给页面，不导航也不提醒", async () => {
    await mount();
    const target = jarTarget();
    act(() => void shell.registerJarDrop(target));
    fire({ type: "enter", content: { kind: "files", paths: ["D:\\notes.txt", JAR] } });
    expect(shell.fileDropHint).toBe("mods");
    expect(hintText()).toBe(DROP_COPY.modsHint);
    fire({ type: "drop", content: { kind: "files", paths: [JAR, "D:\\notes.txt", JAR_B] } });
    expect(shell.fileDropHint).toBeNull();
    expect(target.onDrop.mock.calls).toEqual([[[JAR, JAR_B]]]);
    expect(nav.route).toEqual({ page: "home" });
    expect(toastsNow()).toEqual([]);
  });

  it("页面此刻收不了：不提示「松开以添加」，松开不交给页面，写明这条原因", async () => {
    await mount();
    const target = jarTarget("游戏正在运行，Mod 文件被占用");
    act(() => void shell.registerJarDrop(target));
    fire({ type: "enter", content: { kind: "files", paths: [JAR] } });
    expect(shell.fileDropHint).toBeNull();
    fire({ type: "drop", content: { kind: "files", paths: [JAR] } });
    expect(target.onDrop).not.toHaveBeenCalled();
    expect(toastsNow()).toEqual([["warning", DROP_COPY.modsLocked, "游戏正在运行，Mod 文件被占用"]]);
  });

  it("页面只收 .jar：整合包照常导入，别的文件照常提醒，服务器链接照常打开弹窗", async () => {
    await mount();
    const target = jarTarget();
    act(() => void shell.registerJarDrop(target));

    fire({ type: "enter", content: { kind: "files", paths: [PACK] } });
    expect(shell.fileDropHint).toBe("modpack");
    fire({ type: "drop", content: { kind: "files", paths: [PACK] } });
    expect(nav.route).toEqual({ page: "discover", importFile: PACK });

    fire({ type: "drop", content: { kind: "files", paths: ["D:\\notes.txt"] } });
    expect(toastsNow()).toEqual([["warning", DROP_COPY.notModpack.title, DROP_COPY.notModpack.body]]);

    await act(async () => {
      for (const handler of [...dropHandlers]) handler({ type: "drop", content: { kind: "auth_server", url: "https://littleskin.cn/api/yggdrasil" } });
      await settle();
    });
    expect(launcher.state.login).toMatchObject({ kind: "authlib", dropped: "https://littleskin.cn/api/yggdrasil" });
    expect(target.onDrop).not.toHaveBeenCalled();
  });

  it(".jar 和整合包一起拖到收 .jar 的页面：.jar 优先，只交 .jar，不导入", async () => {
    await mount();
    const target = jarTarget();
    act(() => void shell.registerJarDrop(target));
    fire({ type: "enter", content: { kind: "files", paths: [PACK, JAR] } });
    expect(shell.fileDropHint).toBe("mods");
    fire({ type: "drop", content: { kind: "files", paths: [PACK, JAR] } });
    expect(target.onDrop.mock.calls).toEqual([[[JAR]]]);
    expect(nav.route).toEqual({ page: "home" });
  });

  it("有浮层打开或在首次启动向导里：不提示，松开也不交给页面", async () => {
    await mount();
    const target = jarTarget();
    act(() => void shell.registerJarDrop(target));
    act(() => shell.openPalette());
    fire({ type: "enter", content: { kind: "files", paths: [JAR] } });
    expect(shell.fileDropHint).toBeNull();
    fire({ type: "drop", content: { kind: "files", paths: [JAR] } });
    expect(target.onDrop).not.toHaveBeenCalled();
    expect(toastsNow()).toEqual([]);
    view?.unmount();

    bootOverrides(ipc, { firstRun: true });
    await mount();
    const wizard = jarTarget();
    act(() => void shell.registerJarDrop(wizard));
    fire({ type: "enter", content: { kind: "files", paths: [JAR] } });
    fire({ type: "drop", content: { kind: "files", paths: [JAR] } });
    expect(shell.fileDropHint).toBeNull();
    expect(wizard.onDrop).not.toHaveBeenCalled();
  });

  it("导入弹窗这类独占的接收方排在页面前面：文件交给它，页面收不到", async () => {
    await mount();
    const target = jarTarget();
    const exclusive = { onDrop: vi.fn() };
    act(() => {
      shell.registerJarDrop(target);
      shell.registerFileDrop(exclusive);
    });
    fire({ type: "drop", content: { kind: "files", paths: [JAR] } });
    expect(exclusive.onDrop.mock.calls).toEqual([[[JAR]]]);
    expect(target.onDrop).not.toHaveBeenCalled();
  });

  it("最后登记的页面收；注销后交回前一个，全部注销后回到外壳的说明", async () => {
    await mount();
    const outer = jarTarget();
    const inner = jarTarget();
    let offOuter = () => {};
    let offInner = () => {};
    act(() => {
      offOuter = shell.registerJarDrop(outer);
      offInner = shell.registerJarDrop(inner);
    });
    fire({ type: "drop", content: { kind: "files", paths: [JAR] } });
    expect(inner.onDrop).toHaveBeenCalledTimes(1);
    expect(outer.onDrop).not.toHaveBeenCalled();

    act(() => offInner());
    fire({ type: "drop", content: { kind: "files", paths: [JAR] } });
    expect(outer.onDrop).toHaveBeenCalledTimes(1);

    act(() => offOuter());
    fire({ type: "drop", content: { kind: "files", paths: [JAR] } });
    expect(inner.onDrop).toHaveBeenCalledTimes(1);
    expect(outer.onDrop).toHaveBeenCalledTimes(1);
    expect(toastsNow()).toEqual([["warning", DROP_COPY.jarElsewhere.title, DROP_COPY.jarElsewhere.body]]);
  });
});

describe("订阅", () => {
  it("订阅失败经外层统一错误处理报告", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    port = { ...port, onDrop: () => Promise.reject(new Error("没有监听权限")) };
    await mount();
    expect(launcher.state.toasts.map((t) => [t.tone, t.body])).toEqual([["error", "没有监听权限"]]);
  });

  it("卸载即退订", async () => {
    await mount();
    expect(dropHandlers).toHaveLength(1);
    view?.unmount();
    view = undefined;
    expect(dropHandlers).toHaveLength(0);
  });
});
