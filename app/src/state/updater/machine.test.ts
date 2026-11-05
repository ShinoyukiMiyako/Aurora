import { describe, expect, it } from "vitest";
import type { UpdaterInfoDto } from "../queries/catalog";
import {
  canCheck,
  downloadFraction,
  hasPanel,
  INITIAL_UPDATER_STATE,
  showsUpdateDot,
  updaterReducer,
  type UpdateInfo,
  type UpdaterEvent,
  type UpdaterPhase,
  type UpdaterState,
} from "./machine";

const UPDATE: UpdateInfo = { version: "0.2.1", current_version: "0.2.0", notes: "修复若干问题", date: Date.UTC(2026, 9, 28) };

function info(overrides: Partial<UpdaterInfoDto> = {}): UpdaterInfoDto {
  return {
    current_version: "0.2.0",
    supported: true,
    unsupported_reason: null,
    available: null,
    downloaded_version: null,
    install_on_exit: false,
    ...overrides,
  };
}

function at(phase: UpdaterPhase, extra: Partial<UpdaterState> = {}): UpdaterState {
  return { ...INITIAL_UPDATER_STATE, currentVersion: "0.2.0", phase, ...extra };
}

function run(state: UpdaterState, ...events: UpdaterEvent[]): UpdaterState {
  return events.reduce(updaterReducer, state);
}

describe("后端信息同步进状态机", () => {
  it("不支持更新的环境一律为 unsupported，并带出原因", () => {
    const next = run(INITIAL_UPDATER_STATE, { type: "info", info: info({ supported: false, unsupported_reason: "debug_build", available: UPDATE }) });
    expect(next.phase).toEqual({ kind: "unsupported", reason: "debug_build" });
    expect(next.currentVersion).toBe("0.2.0");
    const unsigned = run(INITIAL_UPDATER_STATE, { type: "info", info: info({ supported: false, unsupported_reason: "signed_version_not_required", available: UPDATE }) });
    expect(unsigned.phase).toEqual({ kind: "unsupported", reason: "signed_version_not_required" });
  });

  it("已下载的版本优先于检查结果；退出时安装为真时进入 install_on_exit", () => {
    expect(run(INITIAL_UPDATER_STATE, { type: "info", info: info({ available: UPDATE, downloaded_version: "0.2.1" }) }).phase).toEqual({ kind: "ready", update: UPDATE });
    expect(run(INITIAL_UPDATER_STATE, { type: "info", info: info({ available: UPDATE, downloaded_version: "0.2.1", install_on_exit: true }) }).phase).toEqual({
      kind: "install_on_exit",
      update: UPDATE,
    });
  });

  it("已下载的版本与检查结果不是同一版时按版本号补出更新信息，不借用另一版的说明", () => {
    const next = run(INITIAL_UPDATER_STATE, { type: "info", info: info({ available: { ...UPDATE, version: "0.2.2" }, downloaded_version: "0.2.1" }) });
    expect(next.phase).toEqual({ kind: "ready", update: { version: "0.2.1", current_version: "0.2.0", notes: null, date: null } });
  });

  it("检查中、下载中、安装中不被后端信息覆盖", () => {
    const downloading: UpdaterPhase = { kind: "downloading", update: UPDATE, taskId: "t1", bytes: 10, totalBytes: 100 };
    for (const phase of [{ kind: "checking" } as const, downloading, { kind: "installing", update: UPDATE } as const]) {
      expect(run(at(phase), { type: "info", info: info({ available: UPDATE }) }).phase).toEqual(phase);
    }
  });

  it("后端没有可报的更新时，会话内的「已是最新」「检查失败」保留；带版本的阶段回到 idle", () => {
    expect(run(at({ kind: "up_to_date", checkedAt: 5 }), { type: "info", info: info() }).phase).toEqual({ kind: "up_to_date", checkedAt: 5 });
    expect(run(at({ kind: "check_failed", message: "超时", network: "timeout" }), { type: "info", info: info() }).phase).toEqual({ kind: "check_failed", message: "超时", network: "timeout" });
    expect(run(at({ kind: "ready", update: UPDATE }), { type: "info", info: info({ current_version: "0.2.1" }) })).toEqual(
      at({ kind: "idle" }, { currentVersion: "0.2.1" }),
    );
  });

  it("同一版本下载失败后再同步，失败原因保留，重试入口不丢", () => {
    const failed: UpdaterPhase = { kind: "download_failed", update: UPDATE, reason: "连接被重置", signature: false, network: "connect" };
    expect(run(at(failed), { type: "info", info: info({ available: UPDATE }) }).phase).toEqual(failed);
    expect(run(at(failed), { type: "info", info: info({ available: { ...UPDATE, version: "0.3.0" } }) }).phase).toEqual({
      kind: "available",
      update: { ...UPDATE, version: "0.3.0" },
    });
  });
});

describe("检查", () => {
  it("idle -> checking -> up_to_date 记下检查时刻；有更新时进入 available", () => {
    expect(run(at({ kind: "idle" }), { type: "check_start" }, { type: "check_done", update: null, at: 1234 }).phase).toEqual({ kind: "up_to_date", checkedAt: 1234 });
    expect(run(at({ kind: "idle" }), { type: "check_start" }, { type: "check_done", update: UPDATE, at: 1 }).phase).toEqual({ kind: "available", update: UPDATE });
  });

  it("失败进入 check_failed，重试再回到 checking", () => {
    const failed = run(at({ kind: "idle" }), { type: "check_start" }, { type: "check_failed", message: "DNS 解析失败", network: "connect" });
    expect(failed.phase).toEqual({ kind: "check_failed", message: "DNS 解析失败", network: "connect" });
    expect(run(failed, { type: "check_start" }).phase).toEqual({ kind: "checking" });
  });

  it("不支持、下载中、已下载、安装中都不能检查", () => {
    const blocked: UpdaterPhase[] = [
      { kind: "unsupported", reason: "missing_pubkey" },
      { kind: "downloading", update: UPDATE, taskId: "t", bytes: 0, totalBytes: null },
      { kind: "ready", update: UPDATE },
      { kind: "install_on_exit", update: UPDATE },
      { kind: "installing", update: UPDATE },
      { kind: "checking" },
    ];
    for (const phase of blocked) {
      expect(canCheck(phase)).toBe(false);
      expect(run(at(phase), { type: "check_start" }).phase).toBe(phase);
    }
    expect(canCheck({ kind: "available", update: UPDATE })).toBe(true);
  });

  it("不在检查中时到达的检查结果被丢弃", () => {
    const state = at({ kind: "ready", update: UPDATE });
    expect(run(state, { type: "check_done", update: null, at: 9 })).toBe(state);
    expect(run(state, { type: "check_failed", message: "x", network: null })).toBe(state);
  });
});

describe("下载", () => {
  const start = run(at({ kind: "available", update: UPDATE }), { type: "download_start", taskId: "t1" });

  it("从 available 开始，进度按任务号更新，别的任务的进度被忽略", () => {
    expect(start.phase).toEqual({ kind: "downloading", update: UPDATE, taskId: "t1", bytes: 0, totalBytes: null });
    const progressed = run(start, { type: "download_progress", taskId: "t1", bytes: 512, totalBytes: 2048 });
    expect(progressed.phase).toMatchObject({ bytes: 512, totalBytes: 2048 });
    expect(run(progressed, { type: "download_progress", taskId: "stale", bytes: 9999, totalBytes: 9999 })).toBe(progressed);
  });

  it("完成进入 ready；失败带原因与是否签名问题；取消回到 available", () => {
    expect(run(start, { type: "download_done", taskId: "t1", update: UPDATE }).phase).toEqual({ kind: "ready", update: UPDATE });
    expect(run(start, { type: "download_failed", taskId: "t1", reason: "签名不符", signature: true, network: null }).phase).toEqual({
      kind: "download_failed",
      update: UPDATE,
      reason: "签名不符",
      signature: true,
      network: null,
    });
    expect(run(start, { type: "download_failed", taskId: "t1", reason: "error sending request", signature: false, network: "timeout" }).phase).toMatchObject({
      reason: "error sending request",
      network: "timeout",
    });
    expect(run(start, { type: "download_cancelled", taskId: "t1" }).phase).toEqual({ kind: "available", update: UPDATE });
  });

  it("下载失败后可以重试；没有可下的版本时不开始", () => {
    const failed = run(start, { type: "download_failed", taskId: "t1", reason: "断网", signature: false, network: "connect" });
    expect(run(failed, { type: "download_start", taskId: "t2" }).phase).toMatchObject({ kind: "downloading", taskId: "t2", bytes: 0 });
    const idle = at({ kind: "idle" });
    expect(run(idle, { type: "download_start", taskId: "t3" })).toBe(idle);
  });

  it("downloadFraction：总量未知或为 0 时为 null，并夹在 0 到 1", () => {
    expect(downloadFraction(5, null)).toBeNull();
    expect(downloadFraction(5, 0)).toBeNull();
    expect(downloadFraction(25, 100)).toBe(0.25);
    expect(downloadFraction(150, 100)).toBe(1);
  });
});

describe("安装", () => {
  it("ready 与 install_on_exit 之间互切；安装失败回到 ready", () => {
    const ready = at({ kind: "ready", update: UPDATE });
    const onExit = run(ready, { type: "install_on_exit", enabled: true });
    expect(onExit.phase).toEqual({ kind: "install_on_exit", update: UPDATE });
    expect(run(onExit, { type: "install_on_exit", enabled: false }).phase).toEqual({ kind: "ready", update: UPDATE });
    const installing = run(onExit, { type: "install_start" });
    expect(installing.phase).toEqual({ kind: "installing", update: UPDATE });
    expect(run(installing, { type: "install_failed" }).phase).toEqual({ kind: "ready", update: UPDATE });
  });

  it("安装命令返回（没有随进程退出）：回到 idle，等后端信息给出新版本", () => {
    const installing = at({ kind: "installing", update: UPDATE });
    const done = run(installing, { type: "install_done" }, { type: "info", info: info({ current_version: "0.2.1" }) });
    expect(done).toEqual(at({ kind: "idle" }, { currentVersion: "0.2.1" }));
    const ready = at({ kind: "ready", update: UPDATE });
    expect(run(ready, { type: "install_done" })).toBe(ready);
  });

  it("还没下载好时不能安装，也不能设为退出时安装", () => {
    const available = at({ kind: "available", update: UPDATE });
    expect(run(available, { type: "install_start" })).toBe(available);
    expect(run(available, { type: "install_on_exit", enabled: true })).toBe(available);
  });
});

describe("提示点", () => {
  it("没看过、没跳过的新版本亮；打开过面板或跳过后不亮；已下好时一直亮到安装", () => {
    const available = at({ kind: "available", update: UPDATE });
    expect(showsUpdateDot(available, null)).toBe(true);
    expect(showsUpdateDot(available, "0.2.1")).toBe(false);
    const seen = run(available, { type: "panel_seen", version: "0.2.1" });
    expect(showsUpdateDot(seen, null)).toBe(false);
    expect(showsUpdateDot(at({ kind: "ready", update: UPDATE }, { seenVersion: "0.2.1" }), "0.2.1")).toBe(true);
    expect(showsUpdateDot(at({ kind: "install_on_exit", update: UPDATE }, { seenVersion: "0.2.1" }), null)).toBe(true);
    expect(showsUpdateDot(at({ kind: "up_to_date", checkedAt: 1 }), null)).toBe(false);
  });

  it("只有带版本的阶段能打开更新面板", () => {
    expect(hasPanel({ kind: "idle" })).toBe(false);
    expect(hasPanel({ kind: "check_failed", message: "x", network: null })).toBe(false);
    expect(hasPanel({ kind: "available", update: UPDATE })).toBe(true);
    expect(hasPanel({ kind: "installing", update: UPDATE })).toBe(true);
  });
});
