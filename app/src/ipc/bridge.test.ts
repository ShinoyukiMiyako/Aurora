import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAppearance, setAppearance } from "./appearance";
import { inTauri, invoke, listen } from "./bridge";
import { IpcError, isCancelled, toIpcError } from "./errors";
import { mockCommands, resetMocks } from "./mock";
import { clearMockEventListeners, emitMockEvent } from "./mock/events";
import { isMockTaskCancelled } from "./mock/handlers/tasks";
import { CORE_EVENT, cancelTask, loadTaskJournal, onCoreEvent, saveTaskJournal, type CoreEvent, type TaskRecordDto } from "./tasks";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  resetMocks();
  clearMockEventListeners();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("浏览器与测试环境走 mock", () => {
  it("没有 __TAURI_INTERNALS__ 时不调 Tauri", async () => {
    expect(inTauri()).toBe(false);
    await getAppearance();
    expect(tauriInvoke).not.toHaveBeenCalled();
  });

  it("mock 只登记基础层负责的五条命令", () => {
    expect(mockCommands()).toEqual(["cancel_task", "get_appearance", "load_task_journal", "save_task_journal", "set_appearance"]);
  });

  it("未实现的命令直接抛错，不返回空值", async () => {
    const error = await invoke("list_instances").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(IpcError);
    expect((error as Error).message).toBe("mock 未实现 list_instances");
  });

  it("外观读写：补丁合并进完整状态，返回值与后续读取一致", async () => {
    expect(await getAppearance()).toEqual({ mode: "day", accent: "sakura", petals: true, panorama: false, reduce_motion: false });
    const saved = await setAppearance({ mode: "night", accent: "moss" });
    expect(saved).toEqual({ mode: "night", accent: "moss", petals: true, panorama: false, reduce_motion: false });
    expect(await getAppearance()).toEqual(saved);
    resetMocks();
    expect((await getAppearance()).mode).toBe("day");
  });

  it("非法补丁整次不生效，错误码 unknown", async () => {
    const error = await setAppearance({ mode: "dusk" as never, petals: false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IpcError);
    expect((error as IpcError).code).toBe("unknown");
    expect((error as IpcError).message).toContain("dusk");
    expect((await getAppearance()).petals).toBe(true);
    const unknownField = await invoke("set_appearance", { patch: { theme: "x" } }).catch((e: unknown) => e);
    expect((unknownField as IpcError).message).toContain("theme");
  });

  it("返回值经过序列化往返，改返回值改不到 mock 内部状态", async () => {
    const first = await getAppearance();
    first.mode = "night";
    expect((await getAppearance()).mode).toBe("day");
  });

  it("任务日志：种子一条已完成的 Java 下载，写入后整表替换", async () => {
    const seed = await loadTaskJournal();
    expect(seed).toHaveLength(1);
    expect(seed[0]).toMatchObject({ kind: "java", title: "下载 Java 25", status: "done", spec: { command: "install_java", args: { requiredMajor: 25 } } });
    const record: TaskRecordDto = { ...seed[0], id: "task-2", status: "failed", error: { code: "network", message: "连接超时" }, finished_at: 1 };
    await saveTaskJournal([record]);
    expect(await loadTaskJournal()).toEqual([record]);
  });

  it("取消任务登记到 mock，供长任务模拟检查", async () => {
    expect(isMockTaskCancelled("task-7")).toBe(false);
    await cancelTask("task-7");
    expect(isMockTaskCancelled("task-7")).toBe(true);
    expect(isMockTaskCancelled("task-8")).toBe(false);
  });

  it("事件：负载按 JSON 往返送达，退订后不再收到", async () => {
    const received: CoreEvent[] = [];
    const unlisten = await onCoreEvent((e) => received.push(e));
    const payload: CoreEvent = { kind: "download", task_id: "t1", total: 10, finished: 3, bytes: 2048, total_bytes: null, speed: 512 };
    emitMockEvent(CORE_EVENT, payload);
    expect(received).toEqual([payload]);
    expect(received[0]).not.toBe(payload);
    unlisten();
    emitMockEvent(CORE_EVENT, { kind: "stage", task_id: null, message: "x" });
    expect(received).toHaveLength(1);
  });
});

describe("Tauri 窗口里走真命令", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  });

  it("命令名与参数原样传给 Tauri，返回值原样返回", async () => {
    vi.mocked(tauriInvoke).mockResolvedValueOnce({ mode: "night" });
    expect(inTauri()).toBe(true);
    expect(await invoke("get_appearance")).toEqual({ mode: "night" });
    await cancelTask("t9");
    expect(vi.mocked(tauriInvoke).mock.calls).toEqual([["get_appearance", undefined], ["cancel_task", { taskId: "t9" }]]);
  });

  it("字符串错误归一成 code unknown，正文原样", async () => {
    vi.mocked(tauriInvoke).mockRejectedValueOnce("磁盘已满");
    const error = await invoke("install_java", { requiredMajor: 21 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IpcError);
    expect(error).toMatchObject({ code: "unknown", message: "磁盘已满", detail: undefined });
  });

  it("结构化错误保留 code、message 与 detail", async () => {
    vi.mocked(tauriInvoke).mockRejectedValueOnce({ code: "cancelled", message: "已取消", detail: { stage: "download" } });
    const error = await invoke("install_version").catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "cancelled", message: "已取消", detail: { stage: "download" } });
    expect(isCancelled(error)).toBe(true);
  });

  it("无法识别的错误照样抛出，正文带原始值", async () => {
    vi.mocked(tauriInvoke).mockRejectedValueOnce(42);
    const error = await invoke("x").catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "unknown", message: "后端返回了无法识别的错误：42", detail: 42 });
    expect(isCancelled(error)).toBe(false);
  });

  it("listen 只把负载交给处理函数", async () => {
    const unlisten = vi.fn();
    vi.mocked(tauriListen).mockImplementationOnce(async (_event, handler) => {
      handler({ event: CORE_EVENT, id: 1, payload: { kind: "stage", task_id: null, message: "下载资源" } });
      return unlisten;
    });
    const got: unknown[] = [];
    const off = await listen(CORE_EVENT, (p) => got.push(p));
    expect(vi.mocked(tauriListen).mock.calls[0][0]).toBe(CORE_EVENT);
    expect(got).toEqual([{ kind: "stage", task_id: null, message: "下载资源" }]);
    expect(off).toBe(unlisten);
  });
});

describe("toIpcError", () => {
  it("前端自己的 Error 原样返回", () => {
    const own = new TypeError("bad");
    expect(toIpcError(own)).toBe(own);
  });

  it("缺 message 的对象不算结构化错误", () => {
    const error = toIpcError({ code: "network" });
    expect(error).toMatchObject({ code: "unknown", message: '后端返回了无法识别的错误：{"code":"network"}' });
  });
});
