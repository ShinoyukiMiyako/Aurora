// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CORE_EVENT } from "../../ipc/tasks";
import type { IpcRecorder } from "../../test/fake-bridge";
import { callsOf, deferred, emit, resetRecorder } from "../../test/launcher";
import { UPDATER_PORT } from "./port";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));

const update = { version: "0.2.0", current_version: "0.1.0", notes: null, date: null };

function download(taskId: string, bytes: number, totalBytes: number | null) {
  return { kind: "download", task_id: taskId, total: 1, finished: 0, bytes, total_bytes: totalBytes, speed: 0 };
}

function source(taskId: string, index: number, count: number, name: string) {
  return { kind: "source", task_id: taskId, index, count, name };
}

beforeEach(() => {
  resetRecorder(ipc);
});

describe("启动器更新命令", () => {
  it("下载进度只收同一 taskId 的下载事件，下载结束即退订", async () => {
    const pending = deferred<typeof update>();
    ipc.overrides.set("download_update", () => pending.promise);
    const seen: [number, number | null][] = [];
    const done = UPDATER_PORT.download("launcher-update-1", (bytes, total) => seen.push([bytes, total]), () => undefined);
    await vi.waitFor(() => expect(callsOf(ipc, "download_update")).toEqual([{ taskId: "launcher-update-1" }]));

    emit(CORE_EVENT, download("launcher-update-1", 0, 1200));
    emit(CORE_EVENT, download("install-生存#1", 500, 9000));
    emit(CORE_EVENT, { kind: "stage", task_id: "launcher-update-1", message: "正在校验签名" });
    emit(CORE_EVENT, download("launcher-update-1", 1200, 1200));
    pending.resolve(update);
    expect(await done).toEqual(update);

    emit(CORE_EVENT, download("launcher-update-1", 1200, 1200));
    expect(seen).toEqual([
      [0, 1200],
      [1200, 1200],
    ]);
  });

  it("下载失败照常抛出原错误，并且同样退订", async () => {
    ipc.overrides.set("download_update", () => {
      throw Object.assign(new Error("签名不符"), { code: "update_signature_invalid" });
    });
    const seen: number[] = [];
    await expect(UPDATER_PORT.download("launcher-update-2", (bytes) => seen.push(bytes), (s) => seen.push(s.index))).rejects.toMatchObject({ code: "update_signature_invalid" });
    emit(CORE_EVENT, download("launcher-update-2", 10, null));
    emit(CORE_EVENT, source("launcher-update-2", 1, 4, "hk"));
    expect(seen).toEqual([]);
  });

  it("换源只收同一 taskId 的换源事件，按到达顺序与进度交错转给调用方，下载结束即退订", async () => {
    const pending = deferred<typeof update>();
    ipc.overrides.set("download_update", () => pending.promise);
    const seen: unknown[] = [];
    const done = UPDATER_PORT.download(
      "launcher-update-4",
      (bytes) => seen.push(bytes),
      (s) => seen.push(s),
    );
    await vi.waitFor(() => expect(callsOf(ipc, "download_update")).toEqual([{ taskId: "launcher-update-4" }]));

    emit(CORE_EVENT, source("launcher-update-4", 0, 4, "cn"));
    emit(CORE_EVENT, download("launcher-update-4", 700, 1200));
    emit(CORE_EVENT, source("install-生存#1", 3, 4, "github"));
    emit(CORE_EVENT, source("launcher-update-4", 1, 4, "hk"));
    emit(CORE_EVENT, download("launcher-update-4", 100, 1200));
    pending.resolve(update);
    await done;

    emit(CORE_EVENT, source("launcher-update-4", 2, 4, "global"));
    expect(seen).toEqual([{ index: 0, count: 4, name: "cn" }, 700, { index: 1, count: 4, name: "hk" }, 100]);
  });

  it("检查、取消、安装与退出时安装各调一次对应命令", async () => {
    ipc.overrides.set("check_update", () => update);
    ipc.overrides.set("cancel_task", () => false);
    ipc.overrides.set("install_update", () => null);
    ipc.overrides.set("set_install_on_exit", () => null);
    await expect(UPDATER_PORT.check()).resolves.toEqual(update);
    await UPDATER_PORT.cancel("launcher-update-3");
    await UPDATER_PORT.install();
    await UPDATER_PORT.setInstallOnExit(true);
    expect(ipc.calls.map((c) => [c.cmd, c.args])).toEqual([
      ["check_update", {}],
      ["cancel_task", { taskId: "launcher-update-3" }],
      ["install_update", {}],
      ["set_install_on_exit", { enabled: true }],
    ]);
  });
});
