import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IpcError } from "../../ipc/errors";
import { UpdaterController, type UpdaterPort } from "./controller";
import type { UpdateInfo } from "./machine";

const UPDATE: UpdateInfo = { version: "1.4.0", current_version: "1.3.2", notes: null, date: null };

function ipcError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function fakePort(overrides: Partial<UpdaterPort> = {}): UpdaterPort & { calls: string[] } {
  const calls: string[] = [];
  const port: UpdaterPort = {
    check: async () => {
      calls.push("check");
      return UPDATE;
    },
    download: async (taskId, onProgress) => {
      calls.push(`download:${taskId}`);
      onProgress(300, 1200);
      onProgress(1200, 1200);
      return UPDATE;
    },
    cancel: async (taskId) => {
      calls.push(`cancel:${taskId}`);
    },
    install: async () => {
      calls.push("install");
    },
    setInstallOnExit: async (enabled) => {
      calls.push(`exit:${enabled}`);
    },
    ...overrides,
  };
  return Object.assign(port, { calls });
}

function controllerWith(port: UpdaterPort, now = 42_000): UpdaterController {
  const c = new UpdaterController(port, () => now, () => "task-1");
  c.sync({ current_version: "1.3.2", supported: true, unsupported_reason: null, available: null, downloaded_version: null, install_on_exit: false });
  return c;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("UpdaterController", () => {
  it("检查到更新：进入 available，订阅者收到通知", async () => {
    const port = fakePort();
    const c = controllerWith(port);
    const seen: string[] = [];
    c.subscribe(() => seen.push(c.getState().phase.kind));
    await c.check();
    expect(c.getState().phase).toEqual({ kind: "available", update: UPDATE });
    expect(seen).toEqual(["checking", "available"]);
    expect(port.calls).toEqual(["check"]);
  });

  it("已是最新：记下当时的时刻", async () => {
    const c = controllerWith(fakePort({ check: async () => null }), 77_000);
    await c.check();
    expect(c.getState().phase).toEqual({ kind: "up_to_date", checkedAt: 77_000 });
  });

  it("检查失败落进 check_failed（带后端原文与错误码），不再抛出，并写控制台", async () => {
    const c = controllerWith(fakePort({ check: async () => Promise.reject(ipcError("update_check_failed", "连不上更新服务器")) }));
    await expect(c.check()).resolves.toBeUndefined();
    expect(c.getState().phase).toEqual({ kind: "check_failed", message: "连不上更新服务器", network: null });
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("网络层失败：记下 detail.network 的种类，原文照旧留在 message", async () => {
    const raw = "error sending request for url (https://petalfall.org/updates/latest.json)";
    const failWith = (network: string) => async () => Promise.reject(new IpcError("update_check_failed", raw, { endpoints: ["https://petalfall.org/updates/latest.json"], network }));
    const connect = controllerWith(fakePort({ check: failWith("connect") }));
    await connect.check();
    expect(connect.getState().phase).toEqual({ kind: "check_failed", message: raw, network: "connect" });
    const timeout = controllerWith(fakePort({ check: failWith("timeout") }));
    await timeout.check();
    expect(timeout.getState().phase).toEqual({ kind: "check_failed", message: raw, network: "timeout" });
  });

  it("更新源回了 404 以外的状态：落进 check_failed，状态码写进原文，不算网络层失败", async () => {
    const error = new IpcError("update_check_failed", "更新服务器返回了异常状态", { endpoints: ["https://petalfall.org/updates/latest.json"], status: 503 });
    const c = controllerWith(fakePort({ check: async () => Promise.reject(error) }));
    await c.check();
    expect(c.getState().phase).toEqual({ kind: "check_failed", message: "更新服务器返回了异常状态（503）", network: null });
  });

  it("不能检查的阶段调用 check 直接抛错，不发命令", async () => {
    const port = fakePort();
    const c = controllerWith(port);
    c.sync({ current_version: "1.3.2", supported: false, unsupported_reason: "debug_build", available: null, downloaded_version: null, install_on_exit: false });
    await expect(c.check()).rejects.toThrow("unsupported");
    expect(port.calls).toEqual([]);
  });

  it("下载：用同一个任务号，进度逐步写入，完成进入 ready", async () => {
    const progress: (number | null)[] = [];
    const port = fakePort();
    const c = controllerWith(port);
    await c.check();
    c.subscribe(() => {
      const p = c.getState().phase;
      if (p.kind === "downloading") progress.push(p.bytes);
    });
    await c.download();
    expect(port.calls).toEqual(["check", "download:task-1"]);
    expect(progress).toEqual([0, 300, 1200]);
    expect(c.getState().phase).toEqual({ kind: "ready", update: UPDATE });
  });

  it("签名不符：失败原因标为签名问题", async () => {
    const c = controllerWith(fakePort({ download: async () => Promise.reject(ipcError("update_signature_invalid", "签名校验失败")) }));
    await c.check();
    await c.download();
    expect(c.getState().phase).toEqual({ kind: "download_failed", update: UPDATE, reason: "签名校验失败", signature: true, network: null });
  });

  it("下载的网络层失败：记下 detail.network 的种类，原文留在 reason", async () => {
    const raw = "error sending request for url (https://petalfall.org/updates/setup-1.4.0.exe)";
    const failWith = (network: string) => async () => Promise.reject(new IpcError("update_download_failed", raw, { network }));
    const connect = controllerWith(fakePort({ download: failWith("connect") }));
    await connect.check();
    await connect.download();
    expect(connect.getState().phase).toEqual({ kind: "download_failed", update: UPDATE, reason: raw, signature: false, network: "connect" });
    const timeout = controllerWith(fakePort({ download: failWith("timeout") }));
    await timeout.check();
    await timeout.download();
    expect(timeout.getState().phase).toEqual({ kind: "download_failed", update: UPDATE, reason: raw, signature: false, network: "timeout" });
  });

  it("下载失败不是网络层的：network 为 null，原文照旧", async () => {
    const raw = "`Download request failed with status: 503 Service Unavailable`";
    const c = controllerWith(fakePort({ download: async () => Promise.reject(new IpcError("update_download_failed", raw)) }));
    await c.check();
    await c.download();
    expect(c.getState().phase).toEqual({ kind: "download_failed", update: UPDATE, reason: raw, signature: false, network: null });
  });

  it("用户取消下载：回到 available，不算失败、不写错误日志", async () => {
    let reject!: (e: unknown) => void;
    const port = fakePort({
      download: () =>
        new Promise<UpdateInfo>((_, rej) => {
          reject = rej;
        }),
    });
    const c = controllerWith(port);
    await c.check();
    const pending = c.download();
    await c.cancelDownload();
    expect(port.calls).toEqual(["check", "cancel:task-1"]);
    reject(ipcError("cancelled", "已取消"));
    await pending;
    expect(c.getState().phase).toEqual({ kind: "available", update: UPDATE });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("没有进行中的下载时取消直接抛错", async () => {
    const c = controllerWith(fakePort());
    await expect(c.cancelDownload()).rejects.toThrow("没有进行中的下载");
  });

  it("退出时安装：命令成功后才切换阶段；命令失败时阶段不变并抛出", async () => {
    const c = controllerWith(fakePort());
    await c.check();
    await c.download();
    await c.setInstallOnExit(true);
    expect(c.getState().phase.kind).toBe("install_on_exit");
    const failing = controllerWith(fakePort({ setInstallOnExit: async () => Promise.reject(ipcError("update_not_ready", "还没下载好")) }));
    await failing.check();
    await failing.download();
    await expect(failing.setInstallOnExit(true)).rejects.toThrow("还没下载好");
    expect(failing.getState().phase.kind).toBe("ready");
  });

  it("安装没能拉起：回到 ready 并把原错误抛给调用方", async () => {
    const c = controllerWith(fakePort({ install: async () => Promise.reject(ipcError("update_install_failed", "安装程序没能启动")) }));
    await c.check();
    await c.download();
    await expect(c.install()).rejects.toThrow("安装程序没能启动");
    expect(c.getState().phase).toEqual({ kind: "ready", update: UPDATE });
  });

  it("安装命令返回：先进入 installing，返回后回到 idle", async () => {
    const port = fakePort();
    const c = controllerWith(port);
    await c.check();
    await c.download();
    const phases: string[] = [];
    c.subscribe(() => phases.push(c.getState().phase.kind));
    await c.install();
    expect(phases).toEqual(["installing", "idle"]);
    expect(port.calls).toEqual(["check", "download:task-1", "install"]);
  });

  it("markSeen 记下看过的版本", () => {
    const c = controllerWith(fakePort());
    c.markSeen("1.4.0");
    expect(c.getState().seenVersion).toBe("1.4.0");
  });
});

describe("UpdaterController：同一个动作进行中再发起一次", () => {
  function held<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve: (value: T) => void = () => undefined;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it("检查进行中再检查：按阶段不对抛错，不发第二次请求", async () => {
    const answer = held<UpdateInfo | null>();
    const port = fakePort({
      check: () => {
        port.calls.push("check");
        return answer.promise;
      },
    });
    const c = controllerWith(port);
    const first = c.check();
    await expect(c.check()).rejects.toThrow("当前阶段 checking 不能检查更新");
    answer.resolve(UPDATE);
    await first;
    expect(port.calls).toEqual(["check"]);
    expect(c.getState().phase).toEqual({ kind: "available", update: UPDATE });
  });

  it("下载进行中再下载：不起第二个下载，取消仍作用于进行中的那一个", async () => {
    const ids = ["task-1", "task-2"];
    const port = fakePort({
      download: (taskId) => {
        port.calls.push(`download:${taskId}`);
        return new Promise<UpdateInfo>(() => undefined);
      },
    });
    const c = new UpdaterController(port, () => 42_000, () => {
      const id = ids.shift();
      if (id === undefined) throw new Error("多要了任务 id");
      return id;
    });
    c.sync({ current_version: "1.3.2", supported: true, unsupported_reason: null, available: UPDATE, downloaded_version: null, install_on_exit: false });
    void c.download();
    await expect(c.download()).rejects.toThrow("当前阶段 downloading 不能开始下载");
    await c.cancelDownload();
    expect(port.calls).toEqual(["download:task-1", "cancel:task-1"]);
  });

  it("安装进行中再安装：不调第二次安装命令", async () => {
    const port = fakePort({
      install: () => {
        port.calls.push("install");
        return new Promise<void>(() => undefined);
      },
    });
    const c = controllerWith(port);
    c.sync({ current_version: "1.3.2", supported: true, unsupported_reason: null, available: null, downloaded_version: "1.4.0", install_on_exit: false });
    void c.install();
    await expect(c.install()).rejects.toThrow("当前阶段 installing 不能安装更新");
    expect(port.calls).toEqual(["install"]);
  });
});
