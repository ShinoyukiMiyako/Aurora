// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OFFLINE_PROBE_MS } from "../domain/limits";
import { IpcError } from "../ipc/errors";
import { render, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, callsOf, deferred, resetRecorder, settle, type Deferred } from "../test/launcher";
import { isConnectionError, network, NetworkMonitor, useOnline, type NetworkHooks } from "./online";
import { LauncherStore } from "./store";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

let view: Rendered | undefined;
let online: boolean;
const seen: boolean[] = [];

function Probe() {
  seen.push(useOnline());
  return null;
}

const offlineError = () => new IpcError("files_offline", "还缺 3 个文件，当前没有网络连接", { count: 3 });

beforeEach(() => {
  vi.useFakeTimers();
  online = true;
  seen.length = 0;
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
  resetRecorder(ipc);
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
});

function goOffline(): void {
  online = false;
  window.dispatchEvent(new Event("offline"));
}

function goOnline(): void {
  online = true;
  window.dispatchEvent(new Event("online"));
}

describe("连接类错误的判定", () => {
  it("后端判定的离线失败码、登录的网络故障、带 detail.network 的错误算；其余不算", () => {
    expect(isConnectionError(offlineError())).toBe(true);
    expect(isConnectionError(new IpcError("account_refresh_network", "x"))).toBe(true);
    expect(isConnectionError(new IpcError("Http", "x"))).toBe(true);
    expect(isConnectionError(new IpcError("download_failed", "x", { network: "connect" }))).toBe(true);
    expect(isConnectionError(new IpcError("modrinth_failed", "x", { network: "timeout" }))).toBe(true);
    expect(isConnectionError(new IpcError("download_failed", "x", { network: "dns" }))).toBe(false);
    expect(isConnectionError(new IpcError("download_failed", "x", { network: 1 }))).toBe(false);
    expect(isConnectionError(new IpcError("download_failed", "下载源上找不到这个文件（404）", { status: 404 }))).toBe(false);
    expect(isConnectionError(new Error("编程错误"))).toBe(false);
  });
});

describe("联网状态：浏览器事件", () => {
  it("按 navigator.onLine 取值，随 offline / online 事件刷新", () => {
    online = false;
    view = render(<Probe />);
    expect(seen.at(-1)).toBe(false);
    act(goOnline);
    expect(seen.at(-1)).toBe(true);
    act(goOffline);
    expect(seen.at(-1)).toBe(false);
  });

  it("卸载后退订：之后的事件不再触发渲染", () => {
    view = render(<Probe />);
    view.unmount();
    view = undefined;
    const renders = seen.length;
    goOffline();
    expect(seen).toHaveLength(renders);
  });
});

describe("联网状态：连通性探测", () => {
  let probes: Deferred<boolean>[];
  let monitor: NetworkMonitor;
  let hooks: NetworkHooks & { recovered: number; errors: unknown[] };

  beforeEach(() => {
    probes = [];
    monitor = new NetworkMonitor(
      () => {
        const d = deferred<boolean>();
        probes.push(d);
        return d.promise;
      },
      { navigatorOnline: () => online, target: () => window },
    );
    hooks = {
      recovered: 0,
      errors: [],
      onRecovered() {
        hooks.recovered += 1;
      },
      onProbeError(error) {
        hooks.errors.push(error);
      },
    };
    monitor.start(hooks);
  });
  afterEach(() => {
    monitor.stop();
  });

  it("在线时遇到连接类错误立即探测；连不上判为离线，之后每 15 秒探测一次，连上即恢复并通知一次", async () => {
    monitor.reportFailure(offlineError());
    monitor.reportFailure(offlineError());
    expect(probes).toHaveLength(1);
    probes[0].resolve(false);
    await settle();
    expect(monitor.isOnline()).toBe(false);

    await vi.advanceTimersByTimeAsync(OFFLINE_PROBE_MS - 1);
    expect(probes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(probes).toHaveLength(2);
    probes[1].resolve(false);
    await settle();
    expect(monitor.isOnline()).toBe(false);
    expect(hooks.recovered).toBe(0);

    await vi.advanceTimersByTimeAsync(OFFLINE_PROBE_MS);
    probes[2].resolve(true);
    await settle();
    expect(monitor.isOnline()).toBe(true);
    expect(hooks.recovered).toBe(1);
    // 恢复后不再轮询
    await vi.advanceTimersByTimeAsync(OFFLINE_PROBE_MS * 3);
    expect(probes).toHaveLength(3);
  });

  it("探测连得上：只是这一个请求失败，仍算在线", async () => {
    monitor.reportFailure(offlineError());
    probes[0].resolve(true);
    await settle();
    expect(monitor.isOnline()).toBe(true);
    expect(hooks.recovered).toBe(0);
  });

  it("不是连接类的错误不探测", () => {
    monitor.reportFailure(new IpcError("download_failed", "下载源上找不到这个文件（404）", { status: 404 }));
    monitor.reportFailure(new Error("编程错误"));
    expect(probes).toHaveLength(0);
  });

  it("浏览器报告断网时不探测；online 事件到来即恢复并通知", async () => {
    goOffline();
    expect(monitor.isOnline()).toBe(false);
    await vi.advanceTimersByTimeAsync(OFFLINE_PROBE_MS * 2);
    expect(probes).toHaveLength(0);
    goOnline();
    expect(monitor.isOnline()).toBe(true);
    expect(hooks.recovered).toBe(1);
  });

  it("探测判的离线遇到浏览器的 online 事件：马上再探测，不等下一轮", async () => {
    monitor.reportFailure(offlineError());
    probes[0].resolve(false);
    await settle();
    goOnline();
    expect(probes).toHaveLength(2);
    probes[1].resolve(true);
    await settle();
    expect(monitor.isOnline()).toBe(true);
    expect(hooks.recovered).toBe(1);
  });

  it("探测命令本身出错：状态不变，错误交给状态容器", async () => {
    monitor.reportFailure(offlineError());
    const broken = new IpcError("unknown", "command probe_network not found");
    probes[0].reject(broken);
    await settle();
    expect(monitor.isOnline()).toBe(true);
    expect(hooks.errors).toEqual([broken]);
  });

  it("同一时刻只能接一个状态容器", () => {
    expect(() => monitor.start(hooks)).toThrow("已经接到一个状态容器上了");
  });
});

describe("应用唯一的联网状态", () => {
  it("页面经 useOnline 看到探测判定的离线；探测走后端命令", async () => {
    ipc.overrides.set("probe_network", () => false);
    view = render(<Probe />);
    expect(seen.at(-1)).toBe(true);
    network.reportFailure(offlineError());
    await act(async () => {
      await settle();
    });
    expect(callsOf(ipc, "probe_network")).toHaveLength(1);
    expect(seen.at(-1)).toBe(false);
    ipc.overrides.set("probe_network", () => true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OFFLINE_PROBE_MS);
      await settle();
    });
    expect(seen.at(-1)).toBe(true);
  });
});

describe("网络恢复通知", () => {
  let probes: boolean[];
  let monitor: NetworkMonitor;
  let runs: Map<number, Deferred<unknown>>;

  beforeEach(() => {
    probes = [];
    monitor = new NetworkMonitor(async () => probes.shift() === true, { navigatorOnline: () => online, target: () => window });
    bootOverrides(ipc);
    runs = new Map();
    ipc.overrides.set("install_java", (args) => {
      const d = deferred<unknown>();
      runs.set(Number(args.requiredMajor), d);
      return d.promise;
    });
  });

  it("断网期间失败的下载：恢复后弹「网络已恢复」写失败个数，「全部重试」把它们重新排进队列", async () => {
    const store = new LauncherStore({ network: monitor });
    store.start();
    await settle();
    for (const major of [17, 21]) await store.actions.installJava(major);
    await settle();
    goOffline();
    for (const major of [17, 21]) runs.get(major)?.reject(new IpcError("java_failed", "网络连接失败", { network: "connect" }));
    await settle();
    expect(store.getState().tasks.map((t) => t.status)).toEqual(["failed", "failed"]);

    goOnline();
    const toast = store.getState().toasts.at(-1);
    expect(toast).toMatchObject({ tone: "info", title: "网络已恢复", body: "有 2 个下载失败", action: { label: "全部重试" } });
    if (toast?.action === undefined || !("run" in toast.action)) throw new Error("恢复通知应带全部重试");
    await toast.action.run();
    await settle();
    expect(store.getState().tasks.map((t) => [t.status, t.attempt])).toEqual([
      ["running", 2],
      ["running", 2],
    ]);
    store.stop();
  });

  it("没有失败任务时只写「网络已恢复」，不带操作；探测判的离线恢复也一样", async () => {
    const store = new LauncherStore({ network: monitor });
    store.start();
    await settle();
    probes = [false, true];
    ipc.overrides.set("launch_game", () => {
      throw offlineError();
    });
    await store.actions.launch("生存");
    await settle();
    expect(monitor.isOnline()).toBe(false);
    await vi.advanceTimersByTimeAsync(OFFLINE_PROBE_MS);
    await settle();
    expect(monitor.isOnline()).toBe(true);
    const toast = store.getState().toasts.at(-1);
    expect(toast).toMatchObject({ tone: "info", title: "网络已恢复" });
    expect(toast?.body).toBeUndefined();
    expect(toast?.action).toBeUndefined();
    store.stop();
  });
});
