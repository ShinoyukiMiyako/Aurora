// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IpcError } from "../ipc/errors";
import type { PinnedServerDto } from "../ipc/system";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, callsOf, resetRecorder, startedStore } from "../test/launcher";
import type { LauncherStore } from "./store";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

const hypixel: PinnedServerDto = { name: "Hypixel", address: "mc.hypixel.net", instance: null };
const wynn: PinnedServerDto = { name: "Wynncraft", address: "play.wynncraft.com", instance: null };
const local: PinnedServerDto = { name: "自家服", address: "192.168.1.8:25565", instance: "生存" };

let stored: PinnedServerDto[];
let failNextWrite: boolean;
let store: LauncherStore;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_720_000_000_000);
  resetRecorder(ipc);
  bootOverrides(ipc);
  stored = [local];
  failNextWrite = false;
  ipc.overrides.set("list_pinned_servers", () => stored.map((s) => ({ ...s })));
  ipc.overrides.set("set_pinned_servers", (args) => {
    if (failNextWrite) {
      failNextWrite = false;
      throw new IpcError("config_write_failed", "配置写入失败");
    }
    stored = (args.servers as PinnedServerDto[]).map((s) => ({ ...s }));
    return stored;
  });
  store = await startedStore();
});
afterEach(() => {
  store.stop();
  vi.useRealTimers();
});

describe("固定服务器的读改写按调用顺序串行", () => {
  it("快速连续固定两台：两台都在，顺序与点击顺序一致", async () => {
    await Promise.all([store.actions.togglePinServer(hypixel), store.actions.togglePinServer(wynn)]);
    expect(stored).toEqual([local, hypixel, wynn]);
    // 后一次的读发生在前一次写完之后
    expect(ipc.calls.filter((c) => c.cmd.endsWith("pinned_servers")).map((c) => c.cmd)).toEqual([
      "list_pinned_servers",
      "set_pinned_servers",
      "list_pinned_servers",
      "set_pinned_servers",
    ]);
  });

  it("同一台连点两下：先固定再取消，回到原样", async () => {
    await Promise.all([store.actions.togglePinServer(hypixel), store.actions.togglePinServer(hypixel)]);
    expect(stored).toEqual([local]);
    expect(callsOf(ipc, "set_pinned_servers").map((a) => (a.servers as PinnedServerDto[]).map((s) => s.address))).toEqual([
      ["192.168.1.8:25565", "mc.hypixel.net"],
      ["192.168.1.8:25565"],
    ]);
  });

  it("前一次写入失败：错误原样交给它的调用方，后一次照常在原列表上执行", async () => {
    failNextWrite = true;
    const results = await Promise.allSettled([store.actions.togglePinServer(hypixel), store.actions.togglePinServer(wynn)]);
    expect(results[0]).toMatchObject({ status: "rejected", reason: { code: "config_write_failed" } });
    expect(results[1]).toEqual({ status: "fulfilled", value: undefined });
    expect(stored).toEqual([local, wynn]);
  });
});
