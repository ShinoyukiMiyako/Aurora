import { readFileSync } from "node:fs";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAppearance, setAppearance } from "./appearance";
import { inTauri, invoke, listen } from "./bridge";
import { installMod } from "./discover";
import { installVersion, repairInstance } from "./instances";
import { installJava } from "./java";
import { launchGame } from "./launch";
import { updateMod } from "./mods";
import { IpcError, isCancelled, toIpcError } from "./errors";
import { mockCommands, resetMocks } from "./mock";
import { clearMockEventListeners, emitMockEvent } from "./mock/events";
import { beginMockTask, endMockTask, isMockTaskCancelled } from "./mock/handlers/tasks";
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

  // 浏览器里跑界面时每条真命令都要有 mock，mock 也不能登记后端没有的命令：
  // 两边以 generate_handler! 的注册表为准逐条对齐。
  it("mock 与后端注册的命令一一对应", () => {
    const lib = readFileSync(new URL("../../src-tauri/src/lib.rs", import.meta.url), "utf8");
    const block = lib.slice(lib.indexOf("generate_handler!["), lib.indexOf("])", lib.indexOf("generate_handler![")));
    const registered = [...block.matchAll(/commands::\w+::(\w+)/g)].map((m) => m[1]).sort();
    expect(registered.length).toBeGreaterThan(80);
    expect(new Set(registered).size).toBe(registered.length);
    expect(mockCommands().filter((cmd) => !cmd.startsWith("plugin:"))).toEqual(registered);
  });

  // 插件命令不在 generate_handler! 里，它能不能调由能力文件授权：mock 提供的每一条都要在那里授予。
  it("mock 提供的插件命令都在能力文件里授了权", () => {
    const capability = JSON.parse(readFileSync(new URL("../../src-tauri/capabilities/default.json", import.meta.url), "utf8")) as {
      permissions: string[];
    };
    const plugins = mockCommands().filter((cmd) => cmd.startsWith("plugin:"));
    expect(plugins).toEqual(["plugin:opener|open_url"]);
    for (const cmd of plugins) {
      const [plugin, name] = cmd.slice("plugin:".length).split("|");
      expect(capability.permissions).toContain(`${plugin}:allow-${name.replaceAll("_", "-")}`);
    }
  });

  it("opener 的 mock 放行 http(s)、mailto、tel，别的协议照插件原文拒绝", async () => {
    const open = vi.fn();
    vi.stubGlobal("window", { open });
    await invoke("plugin:opener|open_url", { url: "https://example.org/issues" });
    expect(open).toHaveBeenCalledWith("https://example.org/issues", "_blank", "noopener,noreferrer");
    const denied = await invoke("plugin:opener|open_url", { url: "file:///C:/Windows/System32/calc.exe" }).catch((e: unknown) => e);
    expect(denied).toMatchObject({ code: "unknown", message: "Not allowed to open url file:///C:/Windows/System32/calc.exe" });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("未实现的命令直接抛错，不返回空值", async () => {
    const error = await invoke("no_such_command").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(IpcError);
    expect((error as Error).message).toBe("mock 未实现 no_such_command");
  });

  it("外观读写：补丁合并进完整状态，返回值与后续读取一致", async () => {
    expect(await getAppearance()).toEqual({ mode: "day", accent: "sakura", petals: true, panorama: false, reduce_motion: false });
    const saved = await setAppearance({ mode: "night", accent: "moss" });
    expect(saved).toEqual({ mode: "night", accent: "moss", petals: true, panorama: false, reduce_motion: false });
    expect(await getAppearance()).toEqual(saved);
    resetMocks();
    expect((await getAppearance()).mode).toBe("day");
  });

  it("非法补丁整次不生效，错误码与后端一致为 invalid_argument", async () => {
    const error = await setAppearance({ mode: "dusk" as never, petals: false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IpcError);
    expect((error as IpcError).code).toBe("invalid_argument");
    expect((error as IpcError).message).toContain("dusk");
    expect((await getAppearance()).petals).toBe(true);
    const unknownField = await invoke("set_appearance", { patch: { theme: "x" } }).catch((e: unknown) => e);
    expect(unknownField).toMatchObject({ code: "invalid_argument" });
    expect((unknownField as IpcError).message).toContain("theme");
    const notObject = await invoke("set_appearance", { patch: [true] }).catch((e: unknown) => e);
    expect(notObject).toMatchObject({ code: "invalid_argument" });
    // 缺参数是 Tauri 自己的参数错误，到前端是纯字符串，归一后为 unknown。
    const missing = await invoke("set_appearance", {}).catch((e: unknown) => e);
    expect(missing).toMatchObject({ code: "unknown" });
    expect(await getAppearance()).toEqual({ mode: "day", accent: "sakura", petals: true, panorama: false, reduce_motion: false });
  });

  it("返回值经过序列化往返，改返回值改不到 mock 内部状态", async () => {
    const first = await getAppearance();
    first.mode = "night";
    expect((await getAppearance()).mode).toBe("day");
  });

  it("任务日志：种子一条已完成的 Java 下载，序号为 0；写入后整表替换并记下序号", async () => {
    const seed = await loadTaskJournal();
    expect(seed.seq).toBe(0);
    expect(seed.tasks).toHaveLength(1);
    expect(seed.tasks[0]).toMatchObject({ kind: "java", title: "下载 Java 25", status: "done", spec: { command: "install_java", args: { requiredMajor: 25 } } });
    const record: TaskRecordDto = { ...seed.tasks[0], id: "task-2", status: "failed", error: { code: "network", message: "连接超时" }, finished_at: 1 };
    await saveTaskJournal(1, [record]);
    expect(await loadTaskJournal()).toEqual({ seq: 1, tasks: [record] });
  });

  it("任务日志：缺 id、id 重复或序号为 0 时整次拒绝，原表不变", async () => {
    const seed = await loadTaskJournal();
    const dup = await saveTaskJournal(1, [{ ...seed.tasks[0], id: "a" }, { ...seed.tasks[0], id: "a" }]).catch((e: unknown) => e);
    expect(dup).toMatchObject({ code: "invalid_argument" });
    expect((dup as IpcError).message).toContain("a");
    const empty = await saveTaskJournal(1, [{ ...seed.tasks[0], id: "" }]).catch((e: unknown) => e);
    expect(empty).toMatchObject({ code: "invalid_argument", message: "任务日志第 0 项缺少字符串 id" });
    const zero = await saveTaskJournal(0, []).catch((e: unknown) => e);
    expect(zero).toMatchObject({ code: "invalid_argument", message: "任务日志的序号从 1 起，收到 0" });
    expect(await loadTaskJournal()).toEqual(seed);
    await saveTaskJournal(1, []);
    expect(await loadTaskJournal()).toEqual({ seq: 1, tasks: [] });
  });

  it("任务日志：晚到的旧序号直接丢弃，盘上留序号大的那份", async () => {
    const seed = await loadTaskJournal();
    const table = (id: string): TaskRecordDto[] => [{ ...seed.tasks[0], id }];
    await saveTaskJournal(3, table("third"));
    await saveTaskJournal(2, table("second"));
    // 与已落盘的序号相同也算旧
    await saveTaskJournal(3, table("third-again"));
    expect(await loadTaskJournal()).toEqual({ seq: 3, tasks: table("third") });
    await saveTaskJournal(4, table("fourth"));
    expect(await loadTaskJournal()).toEqual({ seq: 4, tasks: table("fourth") });
  });

  it("取消：返回任务此刻是否在运行，未运行的 id 也记下", async () => {
    expect(isMockTaskCancelled("task-7")).toBe(false);
    expect(await cancelTask("task-7")).toBe(false);
    expect(isMockTaskCancelled("task-7")).toBe(true);
    expect(isMockTaskCancelled("task-8")).toBe(false);

    beginMockTask("task-8");
    expect(await cancelTask("task-8")).toBe(true);
    expect(isMockTaskCancelled("task-8")).toBe(true);
    endMockTask("task-8");
    expect(await cancelTask("task-8")).toBe(false);
  });

  it("长任务登记与后端一样拒绝空 id 与重复 id", () => {
    beginMockTask("task-9");
    expect(() => beginMockTask("task-9")).toThrow(expect.objectContaining({ code: "task_conflict", detail: { task_id: "task-9" } }));
    expect(() => beginMockTask(" ")).toThrow(expect.objectContaining({ code: "invalid_argument" }));
    endMockTask("task-9");
    expect(() => beginMockTask("task-9")).not.toThrow();
  });

  it("事件：负载按 JSON 往返送达，退订后不再收到", async () => {
    const received: CoreEvent[] = [];
    const unlisten = await onCoreEvent((e) => received.push(e));
    const payload: CoreEvent = { kind: "download", task_id: "t1", total: 10, finished: 3, bytes: 2048, total_bytes: null, transferred: 1024, speed: 512 };
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
    vi.mocked(tauriInvoke).mockResolvedValueOnce({ mode: "night" }).mockResolvedValueOnce(true);
    expect(inTauri()).toBe(true);
    expect(await invoke("get_appearance")).toEqual({ mode: "night" });
    expect(await cancelTask("t9")).toBe(true);
    expect(vi.mocked(tauriInvoke).mock.calls).toEqual([["get_appearance", undefined], ["cancel_task", { taskId: "t9" }]]);
  });

  // 键名逐个对应 Rust 命令形参的 camelCase 形式；漏传 taskId 时 Tauri 会以参数错误拒绝整条命令。
  it("长命令带 taskId，参数键与 Rust 形参一致", async () => {
    for (let i = 0; i < 6; i++) vi.mocked(tauriInvoke).mockResolvedValueOnce(null);
    await installJava("t-java", 21);
    await installVersion("t-ver", "1.21.1", "fabric", "0.16.9", "周末生存");
    await installMod("t-mod", "1.21.1-fabric", "modrinth", "AANobbMI", "mv1");
    await launchGame({ taskId: "t-run", versionId: "1.21.1", accountUuid: "u-1", offlineName: null, offlineFallback: true, quickPlay: null });
    await repairInstance("t-fix", "周末生存");
    await repairInstance("t-loader", "周末生存", { reinstallLoader: true });
    expect(vi.mocked(tauriInvoke).mock.calls).toEqual([
      ["install_java", { taskId: "t-java", requiredMajor: 21 }],
      ["install_version", { taskId: "t-ver", id: "1.21.1", loader: "fabric", loaderVersion: "0.16.9", targetName: "周末生存" }],
      ["install_mod", { taskId: "t-mod", versionId: "1.21.1-fabric", platform: "modrinth", projectId: "AANobbMI", modVersionId: "mv1" }],
      ["launch_game", { taskId: "t-run", versionId: "1.21.1", accountUuid: "u-1", offlineFallback: true, offlineName: null, quickPlay: null }],
      ["repair_instance", { taskId: "t-fix", id: "周末生存" }],
      ["repair_instance", { taskId: "t-loader", id: "周末生存", reinstallLoader: true }],
    ]);
  });

  it("组合任务的一项带上 step（第 0 项也带），键名与 Rust 形参一致", async () => {
    vi.mocked(tauriInvoke).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await installMod("t-all", "1.21.1-fabric", "modrinth", "AANobbMI", "mv1", 0);
    await updateMod("t-all", "1.21.1-fabric", "AANobbMI-0.5.jar", "mv2", 1);
    expect(vi.mocked(tauriInvoke).mock.calls).toEqual([
      ["install_mod", { taskId: "t-all", versionId: "1.21.1-fabric", platform: "modrinth", projectId: "AANobbMI", modVersionId: "mv1", step: 0 }],
      ["update_mod", { taskId: "t-all", versionId: "1.21.1-fabric", fileName: "AANobbMI-0.5.jar", modVersionId: "mv2", step: 1 }],
    ]);
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
