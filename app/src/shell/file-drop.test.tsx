// @vitest-environment jsdom
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
import { WindowPortProvider, browserWindowPort, type FileDropEvent, type WindowPort } from "./window";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

let view: Rendered | undefined;
let nav: NavApi;
let shell: ShellApi;
let launcher: LauncherApi;
let dropHandlers: ((event: FileDropEvent) => void)[];
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
const fire = (event: FileDropEvent) =>
  act(() => {
    for (const handler of [...dropHandlers]) handler(event);
  });

const hintText = () => document.querySelector('[role="status"][data-hint]')?.textContent;

const PACK = "D:\\Downloads\\All the Mods 10.mrpack";
const CF_PACK = "C:\\Users\\a\\Desktop\\RLCraft.ZIP";

beforeEach(() => {
  vi.useFakeTimers();
  resetRecorder(ipc);
  stubResizeObserver();
  bootOverrides(ipc);
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  dropHandlers = [];
  port = {
    ...browserWindowPort(),
    onFileDrop: async (handler) => {
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
    fire({ type: "enter", paths: [PACK] });
    expect(shell.fileDropHint).toBe("modpack");
    expect(hintText()).toBe(DROP_COPY.modpackHint);
    fire({ type: "over" });
    expect(shell.fileDropHint).toBe("modpack");
    fire({ type: "drop", paths: ["D:\\notes.txt", PACK] });
    expect(nav.route).toEqual({ page: "discover", importFile: PACK });
    expect(shell.fileDropHint).toBeNull();
    expect(nav.canBack).toBe(true);
  });

  it("拖出窗口：提示收起，不导航", async () => {
    await mount();
    fire({ type: "enter", paths: [CF_PACK] });
    fire({ type: "leave" });
    expect(shell.fileDropHint).toBeNull();
    expect(nav.route).toEqual({ page: "home" });
  });

  it("拖进的不是整合包：不显示提示；松开后不导航，弹一条只认哪两种文件的提醒", async () => {
    await mount();
    fire({ type: "enter", paths: ["D:\\mods\\sodium.jar"] });
    expect(shell.fileDropHint).toBeNull();
    fire({ type: "drop", paths: ["D:\\mods\\sodium.jar"] });
    expect(nav.route).toEqual({ page: "home" });
    expect(launcher.state.toasts.map((t) => [t.tone, t.title, t.body])).toEqual([["warning", DROP_COPY.notModpack.title, DROP_COPY.notModpack.body]]);
  });

  it("有浮层打开时外壳不处理：不提示、不导航、不提醒", async () => {
    await mount();
    act(() => shell.openPalette());
    fire({ type: "enter", paths: [PACK] });
    expect(shell.fileDropHint).toBeNull();
    fire({ type: "drop", paths: [PACK] });
    expect(nav.route).toEqual({ page: "home" });
    expect(launcher.state.toasts).toEqual([]);
  });

  it("首次启动向导期间外壳不处理", async () => {
    bootOverrides(ipc, { firstRun: true });
    await mount();
    expect(launcher.state.firstRun).toBe(true);
    fire({ type: "enter", paths: [PACK] });
    fire({ type: "drop", paths: [PACK] });
    expect(shell.fileDropHint).toBeNull();
    expect(nav.route).toEqual({ page: "home" });
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
    fire({ type: "enter", paths: [PACK] });
    fire({ type: "leave" });
    fire({ type: "drop", paths: ["D:\\a.jar", PACK] });
    expect(inner.onEnter.mock.calls).toEqual([[[PACK]]]);
    expect(inner.onLeave).toHaveBeenCalledTimes(1);
    expect(inner.onDrop.mock.calls).toEqual([[["D:\\a.jar", PACK]]]);
    expect(outer.onEnter).not.toHaveBeenCalled();
    expect(outer.onDrop).not.toHaveBeenCalled();
    expect(shell.fileDropHint).toBeNull();
    expect(nav.route).toEqual({ page: "home" });

    act(() => offInner());
    fire({ type: "drop", paths: [PACK] });
    expect(outer.onDrop.mock.calls).toEqual([[[PACK]]]);
    act(() => offOuter());
    fire({ type: "drop", paths: [PACK] });
    expect(nav.route).toEqual({ page: "discover", importFile: PACK });
  });

  it("接收方没给 onEnter / onLeave 时只收松开", async () => {
    await mount();
    const onDrop = vi.fn();
    act(() => void shell.registerFileDrop({ onDrop }));
    fire({ type: "enter", paths: [PACK] });
    fire({ type: "leave" });
    fire({ type: "drop", paths: [PACK] });
    expect(onDrop).toHaveBeenCalledTimes(1);
  });
});

describe("订阅", () => {
  it("订阅失败经外层统一错误处理报告", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    port = { ...port, onFileDrop: () => Promise.reject(new Error("没有监听权限")) };
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
