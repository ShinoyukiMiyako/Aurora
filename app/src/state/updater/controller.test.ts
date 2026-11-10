import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IpcError } from "../../ipc/errors";
import type { UpdateChannel, UpdaterInfoDto } from "../../ipc/system";
import { UpdaterController, type UpdaterPort } from "./controller";
import type { UpdateInfo } from "./machine";

const UPDATE: UpdateInfo = { version: "1.4.0", current_version: "1.3.2", notes: null, date: null, channel: "stable" };

function ipcError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

const INFO: UpdaterInfoDto = { current_version: "1.3.2", supported: true, unsupported_reason: null, package_channel: "stable", preference: "stable", relation: "same", available: null, channel_heads: [], refused: [], downloaded_version: null, downloaded_channel: null, downloaded_intent: null, install_on_exit: false };

/** 写下偏好之后后端返回的信息：包是正式版（没有比它更慢的通道），候选与已下好的包都已清掉。 */
function infoAfter(channel: UpdateChannel): UpdaterInfoDto {
  return { ...INFO, preference: channel, relation: channel === "stable" ? "same" : "following" };
}

function fakePort(overrides: Partial<UpdaterPort> = {}): UpdaterPort & { calls: string[] } {
  const calls: string[] = [];
  const port: UpdaterPort = {
    check: async () => {
      calls.push("check");
      return UPDATE;
    },
    download: async (taskId, onProgress, onSource) => {
      calls.push(`download:${taskId}`);
      onSource({ index: 0, count: 1, name: "default" });
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
    setChannel: async (channel) => {
      calls.push(`channel:${channel}`);
      return infoAfter(channel);
    },
    ...overrides,
  };
  return Object.assign(port, { calls });
}

function controllerWith(port: UpdaterPort, now = 42_000): UpdaterController {
  const c = new UpdaterController(port, () => now, () => "task-1");
  c.sync(INFO);
  return c;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
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
    expect(c.getState().phase).toEqual({ kind: "check_failed", message: "连不上更新服务器", network: null, staleChannel: null });
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("网络层失败：记下 detail.network 的种类，原文照旧留在 message", async () => {
    const raw = "error sending request for url (https://petalfall.org/updates/latest.json)";
    const failWith = (network: string) => async () => Promise.reject(new IpcError("update_check_failed", raw, { endpoints: ["https://petalfall.org/updates/latest.json"], network }));
    const connect = controllerWith(fakePort({ check: failWith("connect") }));
    await connect.check();
    expect(connect.getState().phase).toEqual({ kind: "check_failed", message: raw, network: "connect", staleChannel: null });
    const timeout = controllerWith(fakePort({ check: failWith("timeout") }));
    await timeout.check();
    expect(timeout.getState().phase).toEqual({ kind: "check_failed", message: raw, network: "timeout", staleChannel: null });
  });

  it("更新源回了 404 以外的状态：落进 check_failed，状态码写进原文，不算网络层失败", async () => {
    const error = new IpcError("update_check_failed", "更新服务器返回了异常状态", { endpoints: ["https://petalfall.org/updates/latest.json"], status: 503 });
    const c = controllerWith(fakePort({ check: async () => Promise.reject(error) }));
    await c.check();
    expect(c.getState().phase).toEqual({ kind: "check_failed", message: "更新服务器返回了异常状态（503）", network: null, staleChannel: null });
  });

  it("不能检查的阶段调用 check 直接抛错，不发命令", async () => {
    const port = fakePort();
    const c = controllerWith(port);
    c.sync({ current_version: "1.3.2", supported: false, unsupported_reason: "debug_build", package_channel: "stable", preference: "stable", relation: "same", available: null, channel_heads: [], refused: [], downloaded_version: null, downloaded_channel: null, downloaded_intent: null, install_on_exit: false });
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
    expect(progress).toEqual([0, 0, 300, 1200]);
    expect(c.getState().phase).toEqual({ kind: "ready", update: UPDATE });
  });

  it("签名不符：失败原因标为签名问题", async () => {
    const c = controllerWith(fakePort({ download: async () => Promise.reject(ipcError("update_signature_invalid", "签名校验失败")) }));
    await c.check();
    await c.download();
    expect(c.getState().phase).toEqual({ kind: "download_failed", update: UPDATE, reason: "签名校验失败", signature: true, network: null, sourcesTried: 1, refusal: null });
  });

  it("下载的网络层失败：记下 detail.network 的种类，原文留在 reason", async () => {
    const raw = "error sending request for url (https://petalfall.org/updates/setup-1.4.0.exe)";
    const failWith = (network: string) => async () => Promise.reject(new IpcError("update_download_failed", raw, { network }));
    const connect = controllerWith(fakePort({ download: failWith("connect") }));
    await connect.check();
    await connect.download();
    expect(connect.getState().phase).toEqual({ kind: "download_failed", update: UPDATE, reason: raw, signature: false, network: "connect", sourcesTried: 1, refusal: null });
    const timeout = controllerWith(fakePort({ download: failWith("timeout") }));
    await timeout.check();
    await timeout.download();
    expect(timeout.getState().phase).toEqual({ kind: "download_failed", update: UPDATE, reason: raw, signature: false, network: "timeout", sourcesTried: 1, refusal: null });
  });

  it("下载失败不是网络层的：network 为 null，原文照旧", async () => {
    const raw = "`Download request failed with status: 503 Service Unavailable`";
    const c = controllerWith(fakePort({ download: async () => Promise.reject(new IpcError("update_download_failed", raw)) }));
    await c.check();
    await c.download();
    expect(c.getState().phase).toEqual({ kind: "download_failed", update: UPDATE, reason: raw, signature: false, network: null, sourcesTried: 1, refusal: null });
  });

  it("换源：当前源写进状态，换源时字节归 0，之后的进度从新源接着写", async () => {
    const seen: unknown[] = [];
    const c = controllerWith(
      fakePort({
        download: async (_taskId, onProgress, onSource) => {
          onSource({ index: 0, count: 4, name: "cn" });
          onProgress(5_000_000, 22_846_361);
          onSource({ index: 1, count: 4, name: "hk" });
          onProgress(1_000_000, 22_846_361);
          return UPDATE;
        },
      }),
    );
    await c.check();
    c.subscribe(() => {
      const p = c.getState().phase;
      if (p.kind === "downloading") seen.push([p.source?.index, p.bytes, p.totalBytes]);
    });
    await c.download();
    expect(seen).toEqual([
      [undefined, 0, null],
      [0, 0, null],
      [0, 5_000_000, 22_846_361],
      [1, 0, null],
      [1, 1_000_000, 22_846_361],
    ]);
    expect(c.getState().phase).toEqual({ kind: "ready", update: UPDATE });
  });

  it("多个源都失败：试过的源数取 detail.sources 的条数，网络种类与逐行原文照旧", async () => {
    const raw = "cn：error sending request\nhk：operation timed out\nglobal：error sending request";
    const sources = [
      { source: "cn", failure: "connect", message: "error sending request" },
      { source: "hk", failure: "timeout", message: "operation timed out" },
      { source: "global", failure: "connect", message: "error sending request" },
    ];
    const c = controllerWith(fakePort({ download: async () => Promise.reject(new IpcError("update_download_failed", raw, { network: "connect", sources })) }));
    await c.check();
    await c.download();
    expect(c.getState().phase).toEqual({ kind: "download_failed", update: UPDATE, reason: raw, signature: false, network: "connect", sourcesTried: 3, refusal: null });
  });

  it("后端只列了一个源、或没给逐源失败这一项：按 1 个源算，文案与单源一致", async () => {
    for (const detail of [{ sources: [{ source: "default", failure: "http", message: "404" }] }, { network: null }]) {
      const c = controllerWith(fakePort({ download: async () => Promise.reject(new IpcError("update_download_failed", "404", detail)) }));
      await c.check();
      await c.download();
      expect(c.getState().phase).toEqual({ kind: "download_failed", update: UPDATE, reason: "404", signature: false, network: null, sourcesTried: 1, refusal: null });
    }
  });

  it("后端列了逐源失败却一条都没有：是违约，先落进下载失败，再把违约抛给调用方，不当作 1 个源静默放过", async () => {
    const c = controllerWith(fakePort({ download: async () => Promise.reject(new IpcError("update_download_failed", "x", { network: "connect", sources: [] })) }));
    await c.check();
    await expect(c.download()).rejects.toThrow("detail.sources 不成形");
    expect(c.getState().phase).toEqual({ kind: "download_failed", update: UPDATE, reason: "x", signature: false, network: "connect", sourcesTried: 1, refusal: null });
  });

  it("逐源明细不成形：先落进下载失败（不停在下载中），再把违约抛给调用方", async () => {
    const c = controllerWith(fakePort({ download: async () => Promise.reject(new IpcError("update_download_failed", "x", { sources: [{ source: "cn", failure: "dns", message: "x" }] })) }));
    await c.check();
    await expect(c.download()).rejects.toThrow("detail.sources 不成形");
    expect(c.getState().phase).toEqual({ kind: "download_failed", update: UPDATE, reason: "x", signature: false, network: null, sourcesTried: 1, refusal: null });
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
    c.sync({ current_version: "1.3.2", supported: true, unsupported_reason: null, package_channel: "stable", preference: "stable", relation: "same", available: UPDATE, channel_heads: [], refused: [], downloaded_version: null, downloaded_channel: null, downloaded_intent: null, install_on_exit: false });
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
    c.sync({ current_version: "1.3.2", supported: true, unsupported_reason: null, package_channel: "stable", preference: "stable", relation: "same", available: null, channel_heads: [], refused: [], downloaded_version: "1.4.0", downloaded_channel: "stable", downloaded_intent: "update", install_on_exit: false });
    void c.install();
    await expect(c.install()).rejects.toThrow("当前阶段 installing 不能安装更新");
    expect(port.calls).toEqual(["install"]);
  });
});

/** 一个由用例决定何时落定的 promise。 */
function pending<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 把排着的微任务跑完：执行者内部的等待链都在微任务里推进。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** 固定种子的伪随机数（mulberry32）：每次跑出同一组数据，失败可以复现。 */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BETA_FOLLOWING = { package_channel: "stable", preference: "beta", relation: "following", channel_heads: [], refused: [] };

describe("UpdaterController：改更新通道", () => {
  it("写成功：拿返回的信息同步，阶段回到 idle，欠下一次检查；再改一次号随之变大", async () => {
    const port = fakePort();
    const c = controllerWith(port);
    await c.check();
    expect(c.getState().phase.kind).toBe("available");
    await c.setChannel("beta");
    expect(port.calls).toEqual(["check", "channel:beta"]);
    expect(c.getState()).toMatchObject({ phase: { kind: "idle" }, channels: BETA_FOLLOWING, channelCheckDue: 1 });
    await c.setChannel("dev");
    expect(c.getState()).toMatchObject({ phase: { kind: "idle" }, channels: { preference: "dev" }, channelCheckDue: 2 });
  });

  it("已是最新、检查失败时改：会话内的结论作废，回到 idle", async () => {
    const upToDate = controllerWith(fakePort({ check: async () => null }));
    await upToDate.check();
    await upToDate.setChannel("beta");
    expect(upToDate.getState().phase).toEqual({ kind: "idle" });
    const failed = controllerWith(fakePort({ check: async () => Promise.reject(ipcError("update_check_failed", "连不上")) }));
    await failed.check();
    await failed.setChannel("beta");
    expect(failed.getState().phase).toEqual({ kind: "idle" });
  });

  it("下载中改：先取消，等下载命令真正返回，再写偏好", async () => {
    const download = pending<UpdateInfo>();
    const port = fakePort({
      download: (taskId) => {
        port.calls.push(`download:${taskId}`);
        return download.promise;
      },
    });
    const c = controllerWith(port);
    await c.check();
    const downloading = c.download();
    const changing = c.setChannel("beta");
    await flush();
    // 取消已经发出，下载命令还没返回：这时写偏好后端只会报 update_busy
    expect(port.calls).toEqual(["check", "download:task-1", "cancel:task-1"]);
    expect(c.getState().phase.kind).toBe("downloading");
    download.reject(ipcError("cancelled", "已取消"));
    await changing;
    await downloading;
    expect(port.calls).toEqual(["check", "download:task-1", "cancel:task-1", "channel:beta"]);
    expect(c.getState()).toMatchObject({ phase: { kind: "idle" }, channels: BETA_FOLLOWING, channelCheckDue: 1 });
  });

  it("下载中改、取消没赶上下载恰好下完：照样等它返回再写，阶段经 ready 回到 idle", async () => {
    const download = pending<UpdateInfo>();
    const port = fakePort({ download: () => download.promise });
    const c = controllerWith(port);
    await c.check();
    const downloading = c.download();
    const phases: string[] = [];
    c.subscribe(() => phases.push(c.getState().phase.kind));
    const changing = c.setChannel("beta");
    await flush();
    download.resolve(UPDATE);
    await changing;
    await downloading;
    expect(phases).toEqual(["ready", "idle"]);
    expect(port.calls).toEqual(["check", "cancel:task-1", "channel:beta"]);
  });

  it("后端报 update_busy 或别的错误：状态一点不动，原错误抛给调用方", async () => {
    for (const code of ["update_busy", "invalid_argument", "updater_unsupported", "config_write_failed"]) {
      const port = fakePort({ setChannel: async () => Promise.reject(ipcError(code, `写不进：${code}`)) });
      const c = controllerWith(port);
      await c.check();
      const before = c.getState();
      await expect(c.setChannel("beta")).rejects.toMatchObject({ code });
      expect(c.getState()).toBe(before);
      expect(before).toMatchObject({ phase: { kind: "available" }, channels: { preference: "stable" }, channelCheckDue: null });
    }
  });

  it("安装中不能改：不调端口，直接抛出", async () => {
    const port = fakePort({
      install: () => {
        port.calls.push("install");
        return new Promise<void>(() => undefined);
      },
    });
    const c = controllerWith(port);
    c.sync({ ...INFO, downloaded_version: "1.4.0", downloaded_channel: "stable", downloaded_intent: "update" });
    void c.install();
    await expect(c.setChannel("beta")).rejects.toThrow("当前阶段 installing 不能改更新通道");
    await flush();
    expect(port.calls).toEqual(["install"]);
  });

  it("连按方向键：每次都写，按选的先后一个接一个发出，中间失败的那次不挡后面的，最后的状态是最后选的（固定种子的随机序列）", async () => {
    const rand = seeded(1110);
    const channels: UpdateChannel[] = ["beta", "beta"];
    const extra = 4 + Math.floor(rand() * 8);
    for (let i = 0; i < extra; i++) channels.push((["dev", "beta", "stable"] as const)[Math.floor(rand() * 3)]);
    const failAt = 1 + Math.floor(rand() * (channels.length - 2));
    const writes: { channel: UpdateChannel; answer: ReturnType<typeof pending<UpdaterInfoDto>> }[] = [];
    const c = controllerWith(
      fakePort({
        setChannel: (channel) => {
          const answer = pending<UpdaterInfoDto>();
          writes.push({ channel, answer });
          return answer.promise;
        },
      }),
    );
    const results = channels.map((channel) => c.setChannel(channel).then(() => "ok", (error: unknown) => (error as { code: string }).code));
    for (let i = 0; i < channels.length; i++) {
      await flush();
      // 前一次没落定之前，下一次不发出
      expect(writes).toHaveLength(i + 1);
      expect(writes[i].channel).toBe(channels[i]);
      if (i === failAt) writes[i].answer.reject(ipcError("config_write_failed", "写不进配置"));
      else writes[i].answer.resolve(infoAfter(channels[i]));
    }
    const outcomes = await Promise.all(results);
    expect(outcomes).toEqual(channels.map((_, i) => (i === failAt ? "config_write_failed" : "ok")));
    expect(c.getState().channels?.preference).toBe(channels[channels.length - 1]);
    expect(c.getState().channelCheckDue).toBe(channels.length);
  });
});

describe("UpdaterController：检查作废", () => {
  it("检查进行中改了通道、写入先返回：旧结果不落进状态，回到 idle，不算失败", async () => {
    const answer = pending<UpdateInfo | null>();
    const port = fakePort({ check: () => answer.promise });
    const c = controllerWith(port);
    const checking = c.check();
    await c.setChannel("beta");
    // 检查还在路上：阶段仍是检查中，检查欠着
    expect(c.getState()).toMatchObject({ phase: { kind: "checking" }, channels: BETA_FOLLOWING, channelCheckDue: 1 });
    answer.resolve(UPDATE);
    await checking;
    expect(c.getState()).toMatchObject({ phase: { kind: "idle" }, channelCheckDue: 1 });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("检查结果先于写入返回：同样作废；检查失败也一样不落进失败", async () => {
    for (const outcome of ["found", "failed"] as const) {
      const answer = pending<UpdateInfo | null>();
      const write = pending<UpdaterInfoDto>();
      const c = controllerWith(fakePort({ check: () => answer.promise, setChannel: () => write.promise }));
      const checking = c.check();
      const changing = c.setChannel("beta");
      if (outcome === "found") answer.resolve(UPDATE);
      else answer.reject(new IpcError("update_check_failed", "error sending request", { network: "connect" }));
      await checking;
      expect(c.getState().phase).toEqual({ kind: "idle" });
      write.resolve(infoAfter("beta"));
      await changing;
      expect(c.getState()).toMatchObject({ phase: { kind: "idle" }, channels: BETA_FOLLOWING, channelCheckDue: 1 });
    }
    expect(console.error).not.toHaveBeenCalled();
  });

  it("写入失败时同时在进行的检查照样作废：阶段回到 idle，不落失败", async () => {
    const answer = pending<UpdateInfo | null>();
    const c = controllerWith(fakePort({ check: () => answer.promise, setChannel: async () => Promise.reject(ipcError("config_write_failed", "写不进配置")) }));
    const checking = c.check();
    await expect(c.setChannel("beta")).rejects.toMatchObject({ code: "config_write_failed" });
    answer.resolve(UPDATE);
    await checking;
    expect(c.getState()).toMatchObject({ phase: { kind: "idle" }, channels: { preference: "stable" }, channelCheckDue: null });
  });

  it("后端报 update_superseded：作废，回到 idle，不写错误日志", async () => {
    const c = controllerWith(fakePort({ check: async () => Promise.reject(new IpcError("update_superseded", "检查期间改了更新通道")) }));
    await expect(c.check()).resolves.toBeUndefined();
    expect(c.getState().phase).toEqual({ kind: "idle" });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("作废之后照常能再检查", async () => {
    const c = controllerWith(fakePort({ check: vi.fn<UpdaterPort["check"]>().mockRejectedValueOnce(new IpcError("update_superseded", "x")).mockResolvedValueOnce(null) }));
    await c.check();
    await c.check();
    expect(c.getState().phase).toEqual({ kind: "up_to_date", checkedAt: 42_000 });
  });
});

describe("UpdaterController：更新源没跟上与下载被拒", () => {
  it("update_source_stale：落进 check_failed，带上 detail.channel，原文照旧", async () => {
    const message = "beta 的更新源给出的 1.0.0-beta.3 比这台电脑见过的 1.0.0-beta.4 旧";
    for (const channel of ["dev", "beta", "stable"] as const) {
      const error = new IpcError("update_source_stale", message, { channel, offered: [{ endpoint: `https://updates.example/${channel}/latest.json`, version: "1.0.0-beta.3" }], seen: "1.0.0-beta.4" });
      const c = controllerWith(fakePort({ check: async () => Promise.reject(error) }));
      await c.check();
      expect(c.getState().phase).toEqual({ kind: "check_failed", message, network: null, staleChannel: channel });
    }
  });

  it("update_source_stale 的 detail.channel 不成形：先落进检查失败（不停在检查中），再把违约抛给调用方", async () => {
    for (const detail of [{ channel: "preview" }, { channel: null }, {}, undefined]) {
      const c = controllerWith(fakePort({ check: async () => Promise.reject(new IpcError("update_source_stale", "旧", detail)) }));
      await expect(c.check()).rejects.toThrow("detail.channel 不成形");
      expect(c.getState().phase).toEqual({ kind: "check_failed", message: "旧", network: null, staleChannel: null });
    }
  });

  it("update_data_too_new：落进带 refusal 的下载失败，不能重试，记警告而不是错误", async () => {
    const port = fakePort({
      download: async (taskId) => {
        port.calls.push(`download:${taskId}`);
        throw new IpcError("update_data_too_new", "1.4.0 读不了这台电脑上的数据，下好的包已丢弃");
      },
    });
    const c = controllerWith(port);
    await c.check();
    await c.download();
    expect(c.getState().phase).toEqual({ kind: "download_failed", update: UPDATE, reason: "1.4.0 读不了这台电脑上的数据，下好的包已丢弃", signature: false, network: null, sourcesTried: 1, refusal: "data_too_new" });
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
    await expect(c.download()).rejects.toThrow("当前阶段 download_failed 不能开始下载");
    expect(port.calls).toEqual(["check", "download:task-1"]);
  });

  it("下载报 update_busy：沿用普通的下载失败，可以重试", async () => {
    const c = controllerWith(fakePort({ download: async () => Promise.reject(new IpcError("update_busy", "已有更新包正在下载或安装")) }));
    await c.check();
    await c.download();
    expect(c.getState().phase).toEqual({ kind: "download_failed", update: UPDATE, reason: "已有更新包正在下载或安装", signature: false, network: null, sourcesTried: 1, refusal: null });
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});
