// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOOT_SLICE_ERROR } from "../copy/flows";
import { CORE_EVENT } from "../ipc/tasks";
import { render } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { accountDto, bootOverrides, callsOf, emit, instanceDto, resetRecorder, settle } from "../test/launcher";
import { LauncherProvider, useLauncher, type LauncherApi } from "./launcher";
import { LauncherStore } from "./store";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

const INIT_COMMANDS = ["get_config", "list_accounts", "current_account", "list_instances", "get_sidebar_pins", "load_task_journal", "is_first_run"];

beforeEach(() => {
  vi.useFakeTimers();
  resetRecorder(ipc);
});
afterEach(() => {
  vi.useRealTimers();
});

function counts(): Record<string, number> {
  return Object.fromEntries(INIT_COMMANDS.map((cmd) => [cmd, callsOf(ipc, cmd).length]));
}

describe("启动首查", () => {
  it("StrictMode 下挂载、卸载、再挂载，每条首查命令仍只发一次", async () => {
    bootOverrides(ipc, { accounts: [accountDto({ name: "Alex" })], instances: [instanceDto("生存")], pins: ["生存"] });
    let api: LauncherApi | null = null;
    function Probe() {
      api = useLauncher();
      return null;
    }
    const view = render(
      <StrictMode>
        <LauncherProvider>
          <Probe />
        </LauncherProvider>
      </StrictMode>,
    );
    await act(async () => {
      await settle();
    });
    expect(counts()).toEqual(Object.fromEntries(INIT_COMMANDS.map((cmd) => [cmd, 1])));
    if (api === null) throw new Error("没有拿到 useLauncher");
    const { state } = api as LauncherApi;
    expect(Object.values(state.status).map((s) => s.kind)).toEqual(["ready", "ready", "ready", "ready", "ready", "ready"]);
    expect(state.accounts.map((a) => a.name)).toEqual(["Alex"]);
    expect(state.instances.map((i) => [i.id, i.pinned])).toEqual([["生存", true]]);
    expect(state.firstRun).toBe(false);
    view.unmount();
  });

  it("重复 start 只订阅一份事件：一条下载进度只处理一次", async () => {
    bootOverrides(ipc);
    const store = new LauncherStore();
    store.start();
    store.stop();
    store.start();
    await settle();
    expect(counts().list_instances).toBe(1);
    ipc.overrides.set("install_java", () => new Promise(() => undefined));
    await store.actions.installJava(21);
    await settle();
    const t = store.getState().tasks[0];
    let notified = 0;
    const off = store.subscribe(() => {
      notified += 1;
    });
    emit(CORE_EVENT, { kind: "download", task_id: `${t.id}#1`, total: 2, finished: 1, bytes: 1, total_bytes: 2, speed: 1 });
    expect(notified).toBe(1);
    off();
    store.stop();
  });

  it("stop 之后到达的事件不再处理", async () => {
    bootOverrides(ipc);
    const store = new LauncherStore();
    store.start();
    await settle();
    store.stop();
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    emit(CORE_EVENT, { kind: "download", task_id: "x#1", total: 1, finished: 1, bytes: 1, total_bytes: 1, speed: 1 });
    expect(notified).toBe(0);
  });

  it("一个切片读失败：该切片记为 error 并发通知，其余照常就绪", async () => {
    bootOverrides(ipc);
    ipc.overrides.set("list_instances", () => {
      throw { code: "io", message: "versions 目录读不出来" };
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = new LauncherStore();
    store.start();
    await settle();
    const { status, toasts } = store.getState();
    expect(status.instances).toMatchObject({ kind: "error", error: { message: "versions 目录读不出来" } });
    expect(status.accounts.kind).toBe("ready");
    expect(toasts).toEqual([expect.objectContaining({ tone: "error", title: BOOT_SLICE_ERROR.instances, body: "versions 目录读不出来" })]);
    expect(errors).toHaveBeenCalledWith(BOOT_SLICE_ERROR.instances, expect.objectContaining({ code: "io" }));

    ipc.overrides.set("list_instances", () => [instanceDto("恢复了")]);
    await store.actions.reload("instances");
    expect(store.getState().status.instances.kind).toBe("ready");
    expect(store.getState().instances.map((i) => i.id)).toEqual(["恢复了"]);
    store.stop();
  });
});
