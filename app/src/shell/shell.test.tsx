// @vitest-environment jsdom
// @module-tag heavy-page
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOAST_COPY } from "../copy/flows";
import { GAME_EXIT_EVENT } from "../ipc/launch";
import { LauncherProvider, useLauncher, type LauncherApi } from "../state/launcher";
import { keydown, render, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, callsOf, emit, instanceDto, resetRecorder, settle } from "../test/launcher";
import { OverlayRoot } from "./overlay";
import { pickSaveFile } from "./platform";
import { ShellProvider, useNav, useShell, type NavApi, type ShellApi } from "./shell";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));
vi.mock("./platform", async (orig) => {
  const actual = await orig<typeof import("./platform")>();
  return { ...actual, pickSaveFile: vi.fn(actual.pickSaveFile) };
});

let view: Rendered | undefined;
let nav: NavApi;
let shell: ShellApi;
let launcher: LauncherApi;
let instances: ReturnType<typeof instanceDto>[];

function Probe() {
  nav = useNav();
  shell = useShell();
  launcher = useLauncher();
  return null;
}

async function mount() {
  view = render(
    <LauncherProvider>
      <ShellProvider>
        <Probe />
        <OverlayRoot />
      </ShellProvider>
    </LauncherProvider>,
  );
  await act(async () => {
    await settle();
  });
}

const flush = () =>
  act(async () => {
    await settle();
  });

const dialogTitle = () => document.querySelector('[role="dialog"] h2')?.textContent;
const button = (text: string) => {
  const el = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === text);
  if (el === undefined) throw new Error(`弹窗里找不到按钮 ${text}`);
  return el;
};

beforeEach(() => {
  vi.useFakeTimers();
  resetRecorder(ipc);
  stubResizeObserver();
  instances = [instanceDto("生存"), instanceDto("创造")];
  bootOverrides(ipc, { instances, pins: ["创造"] });
  ipc.overrides.set("list_instances", () => instances);
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
});

describe("外壳：重启并安装更新", () => {
  it("只有备份这类本地任务：确认框不说成下载，取消键是「取消」，取消后不安装", async () => {
    ipc.overrides.set("backup_world", () => new Promise(() => {}));
    await mount();
    act(() => void launcher.actions.backupWorld("生存", "w1", "旧世界"));
    await flush();
    act(() => void shell.installUpdate());
    await flush();
    expect(dialogTitle()).toBe("重启并安装更新？");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("还有 1 个任务，重启会中断它们，之后需要重新开始。");
    expect(button("重启并安装").dataset.variant).toBe("danger");
    act(() => button("取消").click());
    await flush();
    expect(callsOf(ipc, "install_update")).toHaveLength(0);
  });
});

describe("外壳：导航", () => {
  it("go / back / forward 驱动路由与前后可用态", async () => {
    await mount();
    expect(nav.route).toEqual({ page: "home" });
    expect([nav.canBack, nav.canForward]).toEqual([false, false]);
    act(() => nav.go({ page: "instance", id: "生存", tab: "overview" }));
    act(() => nav.replace({ page: "instance", id: "生存", tab: "mods" }));
    expect(nav.route).toEqual({ page: "instance", id: "生存", tab: "mods" });
    act(() => nav.back());
    expect(nav.route).toEqual({ page: "home" });
    expect(nav.canForward).toBe(true);
    act(() => nav.forward());
    expect(nav.route).toEqual({ page: "instance", id: "生存", tab: "mods" });
  });

  it("实例被删除：当前页落到之前的存活项，历史里指向它的项一并剪除", async () => {
    await mount();
    act(() => nav.go({ page: "library" }));
    act(() => nav.go({ page: "instance", id: "生存", tab: "overview" }));
    instances = [instanceDto("创造")];
    await act(async () => {
      await launcher.actions.refreshInstances();
    });
    await flush();
    expect(nav.route).toEqual({ page: "library" });
    expect(nav.canForward).toBe(false);
  });

  it("滚动位置：go 回到顶部，后退恢复离开时的位置", async () => {
    await mount();
    const scroller = document.createElement("div");
    act(() => shell.bindPageScroll(scroller));
    act(() => nav.go({ page: "library" }));
    scroller.scrollTop = 640;
    act(() => nav.go({ page: "tasks" }));
    expect(scroller.scrollTop).toBe(0);
    act(() => nav.back());
    expect(scroller.scrollTop).toBe(640);
  });

  it("打开崩溃实例的诊断页即收起它的崩溃会话", async () => {
    ipc.overrides.set("launch_game", () => ({ pid: 1 }));
    ipc.overrides.set("last_crash", () => null);
    await mount();
    await act(async () => {
      await launcher.actions.launch("生存");
    });
    act(() => emit(GAME_EXIT_EVENT, { version_id: "生存", exit_code: 1, crashed: true, killed: false, duration_ms: 1000 }));
    await flush();
    expect(launcher.state.session?.phase).toBe("crashed");
    act(() => nav.go({ page: "instance", id: "生存", tab: "crash" }));
    await flush();
    expect(launcher.state.session).toBeNull();
  });
});

describe("外壳：确认框与启动替换", () => {
  it("新的确认顶掉尚未回答的旧请求，旧请求按取消结算", async () => {
    await mount();
    let first: Promise<boolean> | null = null;
    let second: Promise<boolean> | null = null;
    act(() => {
      first = shell.confirm({ title: "删除「生存」？", confirmLabel: "删除实例", tone: "danger" });
    });
    act(() => {
      second = shell.confirm({ title: "结束游戏？", confirmLabel: "结束游戏", tone: "danger" });
    });
    await expect(first).resolves.toBe(false);
    expect(dialogTitle()).toBe("结束游戏？");
    act(() => button("结束游戏").click());
    await expect(second).resolves.toBe(true);
  });

  it("另一实例在运行时再点启动：弹替换确认，确认后结束旧的并启动新的", async () => {
    ipc.overrides.set("launch_game", () => ({ pid: 1 }));
    ipc.overrides.set("stop_game", () => {
      emit(GAME_EXIT_EVENT, { version_id: "生存", exit_code: 0, crashed: false, killed: true, duration_ms: 1000 });
      return null;
    });
    await mount();
    await act(async () => {
      await launcher.actions.launch("生存");
    });
    expect(launcher.state.session).toMatchObject({ instanceId: "生存", phase: "running" });
    await act(async () => {
      await launcher.actions.launch("创造");
    });
    await flush();
    expect(dialogTitle()).toBe("结束「生存」并启动「创造」？");
    act(() => button("结束并启动").click());
    await flush();
    expect(callsOf(ipc, "stop_game")).toHaveLength(1);
    expect(callsOf(ipc, "launch_game").map((a) => a.versionId)).toEqual(["生存", "创造"]);
    expect(launcher.state.session).toMatchObject({ instanceId: "创造", phase: "running" });
    expect(launcher.state.launchPrompt).toBeNull();
  });
});

describe("外壳：全局快捷键", () => {
  it("Ctrl+K 开合命令面板；面板开着时导航快捷键无效", async () => {
    await mount();
    keydown(window, "k", { ctrlKey: true, code: "KeyK" });
    expect(shell.palette).toEqual({ open: true, query: "" });
    keydown(window, "2", { ctrlKey: true, code: "Digit2" });
    keydown(window, "k", { ctrlKey: true, code: "KeyK" });
    expect(shell.palette.open).toBe(false);
    expect(nav.route).toEqual({ page: "home" });
    keydown(window, "2", { ctrlKey: true, code: "Digit2" });
    expect(nav.route).toEqual({ page: "library" });
  });

  it("按住 Ctrl+K 不放：系统的按键自动重复不让面板开了又关", async () => {
    await mount();
    keydown(window, "k", { ctrlKey: true, code: "KeyK" });
    for (let i = 0; i < 3; i++) {
      const held = keydown(window, "k", { ctrlKey: true, code: "KeyK", repeat: true });
      expect(held.defaultPrevented).toBe(true);
      expect(shell.palette.open).toBe(true);
    }
    keydown(window, "k", { ctrlKey: true, code: "KeyK" });
    expect(shell.palette.open).toBe(false);
  });

  it("按住 Alt+← 不放照常逐项后退（与浏览器一致）", async () => {
    await mount();
    act(() => nav.go({ page: "library" }));
    act(() => nav.go({ page: "discover" }));
    keydown(window, "ArrowLeft", { altKey: true });
    keydown(window, "ArrowLeft", { altKey: true, repeat: true });
    expect(nav.route).toEqual({ page: "home" });
  });

  it("Alt+← 后退，Alt+1 打开第一个固定实例，Ctrl+N 打开新建实例，Ctrl+, 进设置", async () => {
    await mount();
    keydown(window, "1", { altKey: true, code: "Digit1" });
    expect(nav.route).toEqual({ page: "instance", id: "创造", tab: "overview" });
    keydown(window, "ArrowLeft", { altKey: true });
    expect(nav.route).toEqual({ page: "home" });
    keydown(window, ",", { ctrlKey: true, code: "Comma" });
    expect(nav.route).toEqual({ page: "settings" });
    keydown(window, "n", { ctrlKey: true, code: "KeyN" });
    expect(shell.createInstance).toEqual({ open: true, preset: null });
  });

  it("有浮层时 Alt+← 只关栈顶一层，不后退", async () => {
    await mount();
    act(() => nav.go({ page: "library" }));
    act(() => {
      void shell.confirm({ title: "取消全部 2 个任务？", confirmLabel: "全部取消" });
    });
    await flush();
    keydown(window, "ArrowLeft", { altKey: true });
    await flush();
    expect(nav.route).toEqual({ page: "library" });
  });

  it("Ctrl+F 交给最后登记的页面处理器，注销后无动作", async () => {
    await mount();
    const a = vi.fn();
    const b = vi.fn();
    const offA = shell.registerFind(a);
    const offB = shell.registerFind(b);
    const event = keydown(window, "f", { ctrlKey: true, code: "KeyF" });
    expect(event.defaultPrevented).toBe(true);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
    offB();
    offA();
    keydown(window, "f", { ctrlKey: true, code: "KeyF" });
    expect(a).not.toHaveBeenCalled();
  });

  it("首次启动向导期间导航快捷键全部无效", async () => {
    bootOverrides(ipc, { instances, firstRun: true });
    ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
    await mount();
    keydown(window, "2", { ctrlKey: true, code: "Digit2" });
    keydown(window, "k", { ctrlKey: true, code: "KeyK" });
    expect(nav.route).toEqual({ page: "home" });
    expect(shell.palette.open).toBe(false);
  });
});

describe("外壳：通知动作", () => {
  it("先关闭这条通知再导航", async () => {
    await mount();
    act(() => {
      launcher.actions.toast("error", "2 个下载失败", "原因各不相同", { action: { label: "查看", to: { page: "tasks", filter: "failed" } } });
    });
    const toast = launcher.state.toasts[0];
    act(() => shell.runToastAction(toast));
    expect(launcher.state.toasts).toEqual([]);
    expect(nav.route).toEqual({ page: "tasks", filter: "failed" });
  });
});

describe("外壳：写剪贴板", () => {
  let writeText: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  });

  it("写入成功：原文写进剪贴板，结果为 true，不弹通知", async () => {
    await mount();
    let written: boolean | undefined;
    await act(async () => {
      written = await shell.copyText("C:\\Games\\.minecraft\\versions\\生存");
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("C:\\Games\\.minecraft\\versions\\生存");
    expect(written).toBe(true);
    expect(launcher.state.toasts).toEqual([]);
  });

  it("写入失败：弹一条「复制失败」，结果为 false，Promise 不 reject", async () => {
    writeText.mockImplementation(() => Promise.reject(new Error("Document is not focused.")));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await mount();
    let written: boolean | undefined;
    await act(async () => {
      written = await shell.copyText("");
    });
    expect(written).toBe(false);
    expect(launcher.state.toasts.map((t) => [t.tone, t.title, t.body])).toEqual([["error", TOAST_COPY.copyFailed, "Document is not focused."]]);
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe("外壳：页面级快捷键", () => {
  it("F2 交给最后登记的处理器并屏蔽默认行为；注销后同一组合交还给更早登记的，全部注销后无动作", async () => {
    await mount();
    const a = vi.fn();
    const b = vi.fn();
    const offA = shell.registerShortcut({ key: "F2" }, a);
    const offB = shell.registerShortcut({ key: "F2" }, b);
    const event = keydown(window, "F2", { code: "F2" });
    expect(event.defaultPrevented).toBe(true);
    expect([a.mock.calls.length, b.mock.calls.length]).toEqual([0, 1]);
    offB();
    keydown(window, "F2", { code: "F2" });
    expect([a.mock.calls.length, b.mock.calls.length]).toEqual([1, 1]);
    offA();
    const idle = keydown(window, "F2", { code: "F2" });
    expect(idle.defaultPrevented).toBe(false);
    expect([a.mock.calls.length, b.mock.calls.length]).toEqual([1, 1]);
  });

  it("修饰键必须逐个一致：Ctrl+D 不响应 D、Ctrl+Shift+D 与 Alt+D；字母不分大小写", async () => {
    await mount();
    const dup = vi.fn();
    shell.registerShortcut({ key: "d", ctrl: true }, dup);
    keydown(window, "d", { code: "KeyD" });
    keydown(window, "D", { ctrlKey: true, shiftKey: true, code: "KeyD" });
    keydown(window, "d", { altKey: true, code: "KeyD" });
    keydown(window, "d", { ctrlKey: true, metaKey: true, code: "KeyD" });
    expect(dup).not.toHaveBeenCalled();
    keydown(window, "D", { ctrlKey: true, code: "KeyD" });
    expect(dup).toHaveBeenCalledTimes(1);
  });

  it("不带 Ctrl / Alt 的组合在输入框里不触发；带 Ctrl 的照常触发", async () => {
    await mount();
    const rename = vi.fn();
    const save = vi.fn();
    shell.registerShortcut({ key: "F2" }, rename);
    shell.registerShortcut({ key: "s", ctrl: true }, save);
    const input = document.createElement("input");
    document.body.append(input);
    try {
      input.focus();
      keydown(input, "F2", { code: "F2" });
      keydown(input, "s", { ctrlKey: true, code: "KeyS" });
      expect(rename).not.toHaveBeenCalled();
      expect(save).toHaveBeenCalledTimes(1);
    } finally {
      input.remove();
    }
  });

  it("有浮层打开、输入法组字、控件已经处理过的按键都不触发", async () => {
    await mount();
    const rename = vi.fn();
    shell.registerShortcut({ key: "F2" }, rename);
    keydown(window, "F2", { code: "F2", isComposing: true });
    const handled = new KeyboardEvent("keydown", { key: "F2", code: "F2", bubbles: true, cancelable: true });
    handled.preventDefault();
    act(() => {
      window.dispatchEvent(handled);
    });
    act(() => shell.openPalette());
    keydown(window, "F2", { code: "F2" });
    expect(rename).not.toHaveBeenCalled();
    act(() => shell.closePalette());
    keydown(window, "F2", { code: "F2" });
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it("首次启动向导期间页面快捷键无效", async () => {
    bootOverrides(ipc, { instances, firstRun: true });
    ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
    await mount();
    const rename = vi.fn();
    shell.registerShortcut({ key: "F2" }, rename);
    keydown(window, "F2", { code: "F2" });
    expect(rename).not.toHaveBeenCalled();
  });

  it("占用全局快捷键或 Esc 属于设计错误，登记时抛出", async () => {
    await mount();
    expect(() => shell.registerShortcut({ key: "k", ctrl: true }, () => undefined)).toThrow("Ctrl+k 是全局快捷键，页面不能占用");
    expect(() => shell.registerShortcut({ key: "f", ctrl: true }, () => undefined)).toThrow("Ctrl+f 是全局快捷键");
    expect(() => shell.registerShortcut({ key: "3", ctrl: true }, () => undefined)).toThrow("Ctrl+3 是全局快捷键");
    expect(() => shell.registerShortcut({ key: "5", alt: true }, () => undefined)).toThrow("Alt+5 是全局快捷键");
    expect(() => shell.registerShortcut({ key: ",", ctrl: true }, () => undefined)).toThrow("Ctrl+, 是全局快捷键");
    expect(() => shell.registerShortcut({ key: "Escape" }, () => undefined)).toThrow("Esc 归浮层体系");
    expect(() => shell.registerShortcut({ key: "6", alt: true }, () => undefined)).not.toThrow();
    expect(() => shell.registerShortcut({ key: "k", ctrl: true, shift: true }, () => undefined)).not.toThrow();
  });
});

describe("外壳：保存文件", () => {
  beforeEach(() => {
    vi.mocked(pickSaveFile).mockReset();
  });

  it("按种类：标题与类型过滤取外壳的表，路径补上这个种类的扩展名", async () => {
    vi.mocked(pickSaveFile).mockResolvedValueOnce("D:\\我的 分享\\周末包");
    await mount();
    await expect(shell.saveFile("mrpack", "周末包 1.2.0.mrpack")).resolves.toBe("D:\\我的 分享\\周末包.mrpack");
    expect(vi.mocked(pickSaveFile).mock.calls).toEqual([[{ title: "导出整合包", filter: { name: "Modrinth 整合包（*.mrpack）", extensions: ["mrpack"] }, defaultPath: "周末包 1.2.0.mrpack" }]]);
  });

  it("页面自带标题与类型过滤：原样交给对话框，路径补上它的扩展名；已带扩展名不重复，取消为 null", async () => {
    const dialog = { title: "导出「新的世界」", filter: { name: "存档压缩包（*.zip）", extensions: ["zip"] } };
    vi.mocked(pickSaveFile).mockResolvedValueOnce("E:\\备份\\新的世界").mockResolvedValueOnce("E:\\备份\\新的世界.ZIP").mockResolvedValueOnce(null);
    await mount();
    await expect(shell.saveFile(dialog, "New World.zip")).resolves.toBe("E:\\备份\\新的世界.zip");
    await expect(shell.saveFile(dialog, "New World.zip")).resolves.toBe("E:\\备份\\新的世界.ZIP");
    await expect(shell.saveFile(dialog, "New World.zip")).resolves.toBeNull();
    expect(vi.mocked(pickSaveFile).mock.calls[0]).toEqual([{ ...dialog, defaultPath: "New World.zip" }]);
  });
});

describe("外壳：选择文件", () => {
  it("浏览器预览里没有系统对话框：如实拒绝", async () => {
    await mount();
    await expect(shell.pickFile("modpack")).rejects.toThrow("浏览器预览里没有系统的选择文件对话框");
  });
});
