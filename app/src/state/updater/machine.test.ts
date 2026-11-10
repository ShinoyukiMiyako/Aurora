import { describe, expect, it } from "vitest";
import type { ChannelHeadDto, ChannelHeadState, ChannelRelation, RefusalReason, RefusedUpdateDto, UpdateChannel } from "../../ipc/system";
import type { UpdaterInfoDto } from "../queries/catalog";
import {
  canCheck,
  downloadFraction,
  hasPanel,
  INITIAL_UPDATER_STATE,
  showsUpdateDot,
  updaterReducer,
  type UpdateInfo,
  type UpdaterChannels,
  type UpdaterEvent,
  type UpdaterPhase,
  type UpdaterState,
} from "./machine";

const UPDATE: UpdateInfo = { version: "0.2.1", current_version: "0.2.0", notes: "修复若干问题", date: Date.UTC(2026, 9, 28), channel: "stable" };

/** info() 默认值折出的通道信息。 */
const STABLE_SAME: UpdaterChannels = { package_channel: "stable", preference: "stable", relation: "same", channel_heads: [], refused: [] };

function info(overrides: Partial<UpdaterInfoDto> = {}): UpdaterInfoDto {
  return {
    current_version: "0.2.0",
    supported: true,
    unsupported_reason: null,
    package_channel: "stable",
    preference: "stable",
    relation: "same",
    available: null,
    channel_heads: [],
    refused: [],
    downloaded_version: null,
    downloaded_channel: null,
    downloaded_intent: null,
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
    const downloaded = { downloaded_version: "0.2.1", downloaded_channel: "stable", downloaded_intent: "update" } as const;
    expect(run(INITIAL_UPDATER_STATE, { type: "info", info: info({ available: UPDATE, ...downloaded }) }).phase).toEqual({ kind: "ready", update: UPDATE });
    expect(run(INITIAL_UPDATER_STATE, { type: "info", info: info({ available: UPDATE, ...downloaded, install_on_exit: true }) }).phase).toEqual({
      kind: "install_on_exit",
      update: UPDATE,
    });
  });

  it("已下载的版本与检查结果不是同一版时按版本号补出更新信息，不借用另一版的说明", () => {
    const next = run(INITIAL_UPDATER_STATE, { type: "info", info: info({ available: { ...UPDATE, version: "0.2.2" }, downloaded_version: "0.2.1", downloaded_channel: "stable", downloaded_intent: "update" }) });
    expect(next.phase).toEqual({ kind: "ready", update: { version: "0.2.1", current_version: "0.2.0", notes: null, date: null, channel: "stable" } });
  });

  it("检查中、下载中、安装中不被后端信息覆盖", () => {
    const downloading: UpdaterPhase = { kind: "downloading", update: UPDATE, taskId: "t1", bytes: 10, totalBytes: 100, source: { index: 1, count: 4, name: "hk" } };
    for (const phase of [{ kind: "checking" } as const, downloading, { kind: "installing", update: UPDATE } as const]) {
      expect(run(at(phase), { type: "info", info: info({ available: UPDATE }) }).phase).toEqual(phase);
    }
  });

  it("后端没有可报的更新时，会话内的「已是最新」「检查失败」保留；带版本的阶段回到 idle", () => {
    expect(run(at({ kind: "up_to_date", checkedAt: 5 }), { type: "info", info: info() }).phase).toEqual({ kind: "up_to_date", checkedAt: 5 });
    expect(run(at({ kind: "check_failed", message: "超时", network: "timeout", staleChannel: null }), { type: "info", info: info() }).phase).toEqual({ kind: "check_failed", message: "超时", network: "timeout", staleChannel: null });
    expect(run(at({ kind: "ready", update: UPDATE }), { type: "info", info: info({ current_version: "0.2.1" }) })).toEqual(
      at({ kind: "idle" }, { currentVersion: "0.2.1", channels: STABLE_SAME }),
    );
  });

  it("同一版本下载失败后再同步，失败原因保留，重试入口不丢", () => {
    const failed: UpdaterPhase = { kind: "download_failed", update: UPDATE, reason: "连接被重置", signature: false, network: "connect", sourcesTried: 3, refusal: null };
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
    const failed = run(at({ kind: "idle" }), { type: "check_start" }, { type: "check_failed", message: "DNS 解析失败", network: "connect", staleChannel: null });
    expect(failed.phase).toEqual({ kind: "check_failed", message: "DNS 解析失败", network: "connect", staleChannel: null });
    expect(run(failed, { type: "check_start" }).phase).toEqual({ kind: "checking" });
  });

  it("不支持、下载中、已下载、安装中都不能检查", () => {
    const blocked: UpdaterPhase[] = [
      { kind: "unsupported", reason: "missing_pubkey" },
      { kind: "downloading", update: UPDATE, taskId: "t", bytes: 0, totalBytes: null, source: null },
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
    expect(run(state, { type: "check_failed", message: "x", network: null, staleChannel: null })).toBe(state);
  });
});

describe("下载", () => {
  const start = run(at({ kind: "available", update: UPDATE }), { type: "download_start", taskId: "t1" });

  it("从 available 开始，进度按任务号更新，别的任务的进度被忽略", () => {
    expect(start.phase).toEqual({ kind: "downloading", update: UPDATE, taskId: "t1", bytes: 0, totalBytes: null, source: null });
    const progressed = run(start, { type: "download_progress", taskId: "t1", bytes: 512, totalBytes: 2048 });
    expect(progressed.phase).toMatchObject({ bytes: 512, totalBytes: 2048 });
    expect(run(progressed, { type: "download_progress", taskId: "stale", bytes: 9999, totalBytes: 9999 })).toBe(progressed);
  });

  it("完成进入 ready；失败带原因与是否签名问题；取消回到 available", () => {
    expect(run(start, { type: "download_done", taskId: "t1", update: UPDATE }).phase).toEqual({ kind: "ready", update: UPDATE });
    expect(run(start, { type: "download_failed", taskId: "t1", reason: "签名不符", signature: true, network: null, sourcesTried: 1, refusal: null }).phase).toEqual({
      kind: "download_failed",
      update: UPDATE,
      reason: "签名不符",
      signature: true,
      network: null,
      sourcesTried: 1,
      refusal: null,
    });
    expect(run(start, { type: "download_failed", taskId: "t1", reason: "error sending request", signature: false, network: "timeout", sourcesTried: 4, refusal: null }).phase).toMatchObject({
      reason: "error sending request",
      network: "timeout",
      sourcesTried: 4,
    });
    expect(run(start, { type: "download_cancelled", taskId: "t1" }).phase).toEqual({ kind: "available", update: UPDATE });
  });

  it("下载失败后可以重试；没有可下的版本时不开始", () => {
    const failed = run(start, { type: "download_failed", taskId: "t1", reason: "断网", signature: false, network: "connect", sourcesTried: 2, refusal: null });
    expect(run(failed, { type: "download_start", taskId: "t2" }).phase).toEqual({ kind: "downloading", update: UPDATE, taskId: "t2", bytes: 0, totalBytes: null, source: null });
    const idle = at({ kind: "idle" });
    expect(run(idle, { type: "download_start", taskId: "t3" })).toBe(idle);
  });

  it("换源：记下第几个源，已下的字节归 0、总量回到未知，新源的进度从头接着写", () => {
    const progressed = run(start, { type: "download_source", taskId: "t1", index: 0, count: 4, name: "cn" }, { type: "download_progress", taskId: "t1", bytes: 7_340_032, totalBytes: 22_846_361 });
    expect(progressed.phase).toEqual({ kind: "downloading", update: UPDATE, taskId: "t1", bytes: 7_340_032, totalBytes: 22_846_361, source: { index: 0, count: 4, name: "cn" } });
    const switched = run(progressed, { type: "download_source", taskId: "t1", index: 2, count: 4, name: "global" });
    expect(switched.phase).toEqual({ kind: "downloading", update: UPDATE, taskId: "t1", bytes: 0, totalBytes: null, source: { index: 2, count: 4, name: "global" } });
    expect(run(switched, { type: "download_progress", taskId: "t1", bytes: 1024, totalBytes: 22_846_361 }).phase).toMatchObject({ bytes: 1024, totalBytes: 22_846_361, source: { index: 2 } });
  });

  it("别的任务或不在下载中时到达的换源事件被丢弃", () => {
    const progressed = run(start, { type: "download_progress", taskId: "t1", bytes: 512, totalBytes: 2048 });
    expect(run(progressed, { type: "download_source", taskId: "stale", index: 1, count: 2, name: "hk" })).toBe(progressed);
    const ready = at({ kind: "ready", update: UPDATE });
    expect(run(ready, { type: "download_source", taskId: "t1", index: 1, count: 2, name: "hk" })).toBe(ready);
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
    expect(done).toEqual(at({ kind: "idle" }, { currentVersion: "0.2.1", channels: STABLE_SAME }));
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
    expect(hasPanel({ kind: "check_failed", message: "x", network: null, staleChannel: null })).toBe(false);
    expect(hasPanel({ kind: "available", update: UPDATE })).toBe(true);
    expect(hasPanel({ kind: "installing", update: UPDATE })).toBe(true);
  });
});

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

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)];
}

const CHANNELS: readonly UpdateChannel[] = ["dev", "beta", "stable"];
const RELATIONS: readonly ChannelRelation[] = ["same", "waiting", "following"];
const HEAD_STATES: readonly ChannelHeadState[] = ["published", "not_published", "stale", "failed"];
const REASONS: readonly RefusalReason[] = ["data_too_new", "preference_unsaved"];

describe("通道信息", () => {
  it("信息到达之前为 null；到达后是更新信息里的包的通道、偏好、关系、各通道结果与被拒列表", () => {
    expect(INITIAL_UPDATER_STATE.channels).toBeNull();
    const heads: ChannelHeadDto[] = [
      { channel: "beta", state: "published", version: "1.0.0-beta.3", date: Date.UTC(2026, 10, 2) },
      { channel: "stable", state: "not_published", version: null, date: null },
    ];
    const refused: RefusedUpdateDto[] = [{ version: "1.0.0-beta.2", channel: "beta", reason: "data_too_new", intent: "update" }];
    const next = run(INITIAL_UPDATER_STATE, {
      type: "info",
      info: info({ current_version: "1.0.0-dev.9", package_channel: "dev", preference: "beta", relation: "waiting", channel_heads: heads, refused }),
    });
    expect(next.channels).toEqual({ package_channel: "dev", preference: "beta", relation: "waiting", channel_heads: heads, refused });
    expect(next.currentVersion).toBe("1.0.0-dev.9");
  });

  it("每次信息到达整份换成新的，不与上一份合并（固定种子的随机序列，含三项都为空、列表都为空的边界）", () => {
    const rand = seeded(20261110);
    let state = INITIAL_UPDATER_STATE;
    for (let i = 0; i < 40; i++) {
      const unknown = i === 0 || i === 39;
      const heads: ChannelHeadDto[] =
        i === 1
          ? []
          : CHANNELS.filter(() => rand() < 0.7).map((channel) => {
              const headState = pick(rand, HEAD_STATES);
              const listed = headState === "published" || headState === "stale";
              return { channel, state: headState, version: listed ? `1.${i}.0-${channel}.${Math.floor(rand() * 100)}` : null, date: listed ? Math.floor(rand() * 2 ** 40) : null };
            });
      const refused: RefusedUpdateDto[] = rand() < 0.4 ? [] : [{ version: `1.${i}.0`, channel: pick(rand, CHANNELS), reason: pick(rand, REASONS), intent: "update" }];
      const fields: UpdaterChannels = {
        package_channel: unknown ? null : pick(rand, CHANNELS),
        preference: unknown ? null : pick(rand, CHANNELS),
        relation: unknown ? null : pick(rand, RELATIONS),
        channel_heads: heads,
        refused,
      };
      const prev = state.channels;
      state = run(state, { type: "info", info: info(fields) });
      expect(state.channels).toEqual(fields);
      expect(state.channels).not.toBe(prev);
    }
  });

  it("包的通道认不出：三项都为 null，阶段是不支持", () => {
    const next = run(INITIAL_UPDATER_STATE, {
      type: "info",
      info: info({ current_version: "0.0.0-local", supported: false, unsupported_reason: "unknown_channel", package_channel: null, preference: null, relation: null }),
    });
    expect(next.phase).toEqual({ kind: "unsupported", reason: "unknown_channel" });
    expect(next.channels).toEqual({ package_channel: null, preference: null, relation: null, channel_heads: [], refused: [] });
  });

  it("下载进度只换阶段，通道信息仍是同一个对象：只取通道信息的订阅方不跟着进度重渲染", () => {
    const synced = run(at({ kind: "idle" }), { type: "info", info: info({ available: UPDATE }) });
    const progressed = run(synced, { type: "download_start", taskId: "t1" }, { type: "download_progress", taskId: "t1", bytes: 10, totalBytes: 100 });
    expect(progressed.phase).toMatchObject({ kind: "downloading", bytes: 10 });
    expect(progressed.channels).toBe(synced.channels);
  });
});

describe("后端信息折成阶段：通道与被拒", () => {
  it("别的通道的候选照样进入 available，通道取自候选", () => {
    const candidate: UpdateInfo = { version: "1.1.0-beta.1", current_version: "1.1.0-dev.4", notes: null, date: null, channel: "beta" };
    const next = run(INITIAL_UPDATER_STATE, { type: "info", info: info({ current_version: "1.1.0-dev.4", package_channel: "dev", preference: "dev", available: candidate }) });
    expect(next.phase).toEqual({ kind: "available", update: candidate });
  });

  it("已下好的包：通道只认 downloaded_channel，同一版的检查结果只借说明与发布时间", () => {
    const listed: UpdateInfo = { version: "1.1.0-beta.1", current_version: "1.0.0", notes: "主页加了资讯", date: 1_700_000_000_000, channel: "stable" };
    const base = { current_version: "1.0.0", available: listed, downloaded_version: "1.1.0-beta.1", downloaded_channel: "beta", downloaded_intent: "update" } as const;
    expect(run(INITIAL_UPDATER_STATE, { type: "info", info: info(base) }).phase).toEqual({
      kind: "ready",
      update: { version: "1.1.0-beta.1", current_version: "1.0.0", notes: "主页加了资讯", date: 1_700_000_000_000, channel: "beta" },
    });
    expect(run(INITIAL_UPDATER_STATE, { type: "info", info: info({ ...base, install_on_exit: true }) }).phase).toEqual({
      kind: "install_on_exit",
      update: { version: "1.1.0-beta.1", current_version: "1.0.0", notes: "主页加了资讯", date: 1_700_000_000_000, channel: "beta" },
    });
  });

  it("后端报了已下好的包却没报通道，或用意不是普通更新：是违约，直接抛出", () => {
    const downloaded = { downloaded_version: "0.2.1", downloaded_channel: "stable", downloaded_intent: "update" } as const;
    expect(() => run(INITIAL_UPDATER_STATE, { type: "info", info: info({ ...downloaded, downloaded_channel: null }) })).toThrow("却没报它所属的通道");
    expect(() => run(INITIAL_UPDATER_STATE, { type: "info", info: info({ ...downloaded, downloaded_intent: null }) })).toThrow("用意却是 null");
    expect(() => run(INITIAL_UPDATER_STATE, { type: "info", info: info({ ...downloaded, downloaded_intent: "switch" }) })).toThrow("用意却是 switch");
  });

  it("被拒装的下载失败：后端不再报那一版时仍保留；同一版仍在时同样保留；出现别的新版本时让位", () => {
    const refused: UpdaterPhase = { kind: "download_failed", update: UPDATE, reason: "0.2.1 读不了这台电脑上的数据", signature: false, network: null, sourcesTried: 1, refusal: "data_too_new" };
    const entry: RefusedUpdateDto = { version: "0.2.1", channel: "stable", reason: "data_too_new", intent: "update" };
    const gone = run(at(refused), { type: "info", info: info({ refused: [entry] }) });
    expect(gone.phase).toEqual(refused);
    expect(gone.channels?.refused).toEqual([entry]);
    expect(run(at(refused), { type: "info", info: info({ available: UPDATE, refused: [entry] }) }).phase).toEqual(refused);
    const newer: UpdateInfo = { ...UPDATE, version: "0.2.2" };
    expect(run(at(refused), { type: "info", info: info({ available: newer, refused: [entry] }) }).phase).toEqual({ kind: "available", update: newer });
    // 不是被拒的下载失败照旧：那一版不在了就回到 idle
    expect(run(at({ ...refused, refusal: null }), { type: "info", info: info() }).phase).toEqual({ kind: "idle" });
  });
});

describe("改更新通道", () => {
  const changed = info({ package_channel: "stable", preference: "beta", relation: "following", channel_heads: [], refused: [] });
  const BETA_FOLLOWING: UpdaterChannels = { package_channel: "stable", preference: "beta", relation: "following", channel_heads: [], refused: [] };
  const downloading: UpdaterPhase = { kind: "downloading", update: UPDATE, taskId: "t1", bytes: 10, totalBytes: 100, source: null };
  const resets: UpdaterPhase[] = [
    { kind: "idle" },
    { kind: "up_to_date", checkedAt: 5 },
    { kind: "check_failed", message: "测试版的更新源还没跟上", network: null, staleChannel: "beta" },
    { kind: "available", update: UPDATE },
    { kind: "download_failed", update: UPDATE, reason: "连接被重置", signature: false, network: "connect", sourcesTried: 2, refusal: null },
    { kind: "download_failed", update: UPDATE, reason: "读不了", signature: false, network: null, sourcesTried: 1, refusal: "data_too_new" },
    { kind: "ready", update: UPDATE },
    { kind: "install_on_exit", update: UPDATE },
  ];
  // 代次取随机值，含最小的 1 与最大的安全整数
  const rand = seeded(42);
  const generations = [1, Number.MAX_SAFE_INTEGER, ...Array.from({ length: resets.length }, () => 2 + Math.floor(rand() * 1_000_000))];

  it("idle、up_to_date、check_failed、available、download_failed、ready、install_on_exit 都回到 idle，通道信息换成写完之后的，欠下一次检查", () => {
    resets.forEach((phase, i) => {
      const generation = generations[i];
      const next = run(at(phase, { channels: STABLE_SAME }), { type: "preference_changed", info: changed, generation });
      expect(next.phase).toEqual({ kind: "idle" });
      expect(next.channels).toEqual(BETA_FOLLOWING);
      expect(next.channelCheckDue).toBe(generation);
    });
  });

  it("检查中、下载中、安装中阶段不动，通道信息照样换、检查照样欠下", () => {
    for (const phase of [{ kind: "checking" } as const, downloading, { kind: "installing", update: UPDATE } as const]) {
      const next = run(at(phase), { type: "preference_changed", info: changed, generation: 7 });
      expect(next.phase).toEqual(phase);
      expect(next.channels).toEqual(BETA_FOLLOWING);
      expect(next.channelCheckDue).toBe(7);
    }
  });

  it("写完之后的信息说不支持：阶段跟着变成不支持", () => {
    const next = run(at({ kind: "available", update: UPDATE }), { type: "preference_changed", info: { ...changed, supported: false, unsupported_reason: "pubkey_mismatch" }, generation: 3 });
    expect(next.phase).toEqual({ kind: "unsupported", reason: "pubkey_mismatch" });
  });

  it("欠着的检查在下一次检查开始时清掉；被拒的检查开始不清", () => {
    const due = run(at({ kind: "up_to_date", checkedAt: 1 }), { type: "preference_changed", info: changed, generation: 4 });
    expect(run(due, { type: "check_start" })).toEqual({ ...due, phase: { kind: "checking" }, channelCheckDue: null });
    const blocked = { ...due, phase: downloading };
    expect(run(blocked, { type: "check_start" })).toBe(blocked);
    // 连着改几次，号只换成最后那次的
    expect(run(due, { type: "preference_changed", info: changed, generation: 5 }, { type: "preference_changed", info: changed, generation: 6 }).channelCheckDue).toBe(6);
  });
});

describe("检查作废与更新源没跟上", () => {
  it("检查作废只在检查中生效，回到 idle、不落失败；别的阶段原样返回", () => {
    const checking = at({ kind: "checking" });
    expect(run(checking, { type: "check_superseded" })).toEqual(at({ kind: "idle" }));
    const others: UpdaterPhase[] = [{ kind: "idle" }, { kind: "up_to_date", checkedAt: 3 }, { kind: "available", update: UPDATE }, { kind: "ready", update: UPDATE }];
    for (const phase of others) {
      const state = at(phase);
      expect(run(state, { type: "check_superseded" })).toBe(state);
    }
  });

  it("检查失败带上更新源没跟上的那个通道；之后照常能重试", () => {
    const failed = run(at({ kind: "idle" }), { type: "check_start" }, { type: "check_failed", message: "测试版的更新源给出的版本旧", network: null, staleChannel: "beta" });
    expect(failed.phase).toEqual({ kind: "check_failed", message: "测试版的更新源给出的版本旧", network: null, staleChannel: "beta" });
    expect(run(failed, { type: "check_start" }).phase).toEqual({ kind: "checking" });
  });
});

describe("下载被拒", () => {
  const start = run(at({ kind: "available", update: UPDATE }), { type: "download_start", taskId: "t1" });
  const refused = run(start, { type: "download_failed", taskId: "t1", reason: "0.2.1 读不了这台电脑上的数据", signature: false, network: null, sourcesTried: 1, refusal: "data_too_new" });

  it("落进带 refusal 的下载失败，被拒的版本与通道就是阶段里的那一版", () => {
    expect(refused.phase).toEqual({ kind: "download_failed", update: UPDATE, reason: "0.2.1 读不了这台电脑上的数据", signature: false, network: null, sourcesTried: 1, refusal: "data_too_new" });
  });

  it("不能从被拒的下载失败重新开始下载，但能检查更新", () => {
    expect(run(refused, { type: "download_start", taskId: "t2" })).toBe(refused);
    expect(canCheck(refused.phase)).toBe(true);
    expect(run(refused, { type: "check_start" }).phase).toEqual({ kind: "checking" });
  });
});
