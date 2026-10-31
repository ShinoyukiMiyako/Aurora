// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { IpcError } from "../ipc/errors";
import { allowsNativeContextMenu, shortcutOf } from "./keys";
import { runGuarded } from "./useRunner";

type KeyInit = Partial<Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "isComposing" | "keyCode">>;
const key = (init: KeyInit) => shortcutOf({ key: "", code: "", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, isComposing: false, keyCode: 0, ...init });

describe("全局快捷键表", () => {
  it("Ctrl 组合", () => {
    expect(key({ ctrlKey: true, key: "k", code: "KeyK" })).toEqual({ kind: "palette" });
    expect(key({ ctrlKey: true, key: "K", code: "KeyK" })).toEqual({ kind: "palette" });
    expect(key({ ctrlKey: true, key: "n", code: "KeyN" })).toEqual({ kind: "create" });
    expect(key({ ctrlKey: true, key: "f", code: "KeyF" })).toEqual({ kind: "find" });
    expect(key({ ctrlKey: true, key: ",", code: "Comma" })).toEqual({ kind: "settings" });
    expect([1, 2, 3, 4].map((d) => key({ ctrlKey: true, key: String(d), code: `Digit${d}` }))).toEqual([
      { kind: "page", page: "home" },
      { kind: "page", page: "library" },
      { kind: "page", page: "discover" },
      { kind: "page", page: "tasks" },
    ]);
    expect(key({ ctrlKey: true, key: "5", code: "Digit5" })).toBeNull();
  });

  it("Alt 组合：前进后退与侧栏第 1 至 5 个固定实例", () => {
    expect(key({ altKey: true, key: "ArrowLeft" })).toEqual({ kind: "back" });
    expect(key({ altKey: true, key: "ArrowRight" })).toEqual({ kind: "forward" });
    expect(key({ altKey: true, key: "¡", code: "Digit1" })).toEqual({ kind: "pin", index: 0 });
    expect(key({ altKey: true, key: "5", code: "Digit5" })).toEqual({ kind: "pin", index: 4 });
    expect(key({ altKey: true, key: "6", code: "Digit6" })).toBeNull();
  });

  it("只认 Ctrl：Win 键、Shift、Ctrl+Alt 与无修饰键都不算", () => {
    expect(key({ metaKey: true, key: "k", code: "KeyK" })).toBeNull();
    expect(key({ ctrlKey: true, metaKey: true, key: "k", code: "KeyK" })).toBeNull();
    expect(key({ ctrlKey: true, shiftKey: true, key: "K", code: "KeyK" })).toBeNull();
    expect(key({ ctrlKey: true, altKey: true, key: "k", code: "KeyK" })).toBeNull();
    expect(key({ key: "k", code: "KeyK" })).toBeNull();
  });

  it("输入法组字期间一律不响应", () => {
    expect(key({ ctrlKey: true, key: "k", code: "KeyK", isComposing: true })).toBeNull();
    expect(key({ altKey: true, key: "ArrowLeft", keyCode: 229 })).toBeNull();
  });
});

describe("原生右键菜单", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("可编辑元素与 user-select: text 的区域保留，其余屏蔽", () => {
    document.body.innerHTML = `
      <div id="root" style="user-select: none">
        <input id="field" />
        <div contenteditable="true"><span id="rich">x</span></div>
        <pre id="log" style="user-select: text"><span id="line">INFO</span></pre>
        <button id="plain">x</button>
      </div>`;
    const el = (id: string) => document.getElementById(id);
    expect(allowsNativeContextMenu(el("field"))).toBe(true);
    expect(allowsNativeContextMenu(el("rich"))).toBe(true);
    expect(allowsNativeContextMenu(el("line"))).toBe(true);
    expect(allowsNativeContextMenu(el("plain"))).toBe(false);
    expect(allowsNativeContextMenu(null)).toBe(false);
  });
});

describe("外层统一错误处理", () => {
  it("成功原样返回结果，不报告", async () => {
    const error = vi.fn();
    await expect(runGuarded(() => Promise.resolve(42), "没能切换账户", { error })).resolves.toEqual({ ok: true, value: 42 });
    expect(error).not.toHaveBeenCalled();
  });

  it("rejection 转成 error 通知（正文为错误原文加错误码）并把原错误写进控制台", async () => {
    const error = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = new IpcError("XboxLive", "该微软账户没有 Xbox 档案", { xerr: 2148916233 });
    const result = await runGuarded(() => Promise.reject(failure), "没能开始微软登录", { error });
    expect(result).toEqual({ ok: false, error: failure });
    expect(error).toHaveBeenCalledWith("没能开始微软登录", "该微软账户没有 Xbox 档案（XErr 2148916233）");
    expect(consoleError).toHaveBeenCalledWith("没能开始微软登录", failure);
  });

  it("同步抛错与异步 reject 一样处理", async () => {
    const error = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await runGuarded(
      () => {
        throw new Error("「生存」的游戏正在运行，先结束游戏");
      },
      "没能删除「生存」",
      { error },
    );
    expect(result.ok).toBe(false);
    expect(error).toHaveBeenCalledWith("没能删除「生存」", "「生存」的游戏正在运行，先结束游戏");
  });

  it("用户主动取消不弹通知", async () => {
    const error = vi.fn();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const result = await runGuarded(() => Promise.reject(new IpcError("cancelled", "已取消")), "没能取消任务", { error });
    expect(result.ok).toBe(false);
    expect(error).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith("没能取消任务：已取消");
  });
});
