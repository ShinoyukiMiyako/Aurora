import { describe, expect, it } from "vitest";
import { autoCheckEnabled, updateToAnnounce } from "./auto-check";
import { INITIAL_UPDATER_STATE, type UpdateInfo, type UpdaterChannels, type UpdaterPhase, type UpdaterState } from "./machine";

const UPDATE: UpdateInfo = { version: "0.3.0", current_version: "0.2.0", notes: null, date: null, channel: "stable" };

function state(phase: UpdaterPhase, extra: Partial<UpdaterState> = {}): UpdaterState {
  return { ...INITIAL_UPDATER_STATE, currentVersion: "0.2.0", phase, ...extra };
}

describe("自动检查的排期条件", () => {
  const ready = { firstRun: false, checkUpdates: true } as const;

  it("向导走完、开关打开、后端信息已到且支持更新时才排期", () => {
    expect(autoCheckEnabled(state({ kind: "idle" }), ready)).toBe(true);
    expect(autoCheckEnabled(state({ kind: "up_to_date", checkedAt: 1 }), ready)).toBe(true);
  });

  it("任一条件不满足都不排期", () => {
    expect(autoCheckEnabled(state({ kind: "idle" }), { firstRun: true, checkUpdates: true })).toBe(false);
    expect(autoCheckEnabled(state({ kind: "idle" }), { firstRun: null, checkUpdates: true })).toBe(false);
    expect(autoCheckEnabled(state({ kind: "idle" }), { firstRun: false, checkUpdates: false })).toBe(false);
    expect(autoCheckEnabled(state({ kind: "idle" }), { firstRun: false, checkUpdates: null })).toBe(false);
    expect(autoCheckEnabled(INITIAL_UPDATER_STATE, ready)).toBe(false);
    expect(autoCheckEnabled(state({ kind: "unsupported", reason: "missing_pubkey" }), ready)).toBe(false);
    expect(autoCheckEnabled(state({ kind: "unsupported", reason: "debug_build" }), ready)).toBe(false);
    expect(autoCheckEnabled(state({ kind: "unsupported", reason: "signed_version_not_required" }), ready)).toBe(false);
  });
});

describe("查完之后要不要提示", () => {
  it("查到新版本、没跳过、没提示过、没看过：提示这一版", () => {
    expect(updateToAnnounce(state({ kind: "available", update: UPDATE }), null, null)).toEqual(UPDATE);
    expect(updateToAnnounce(state({ kind: "available", update: UPDATE }), "0.2.9", "0.2.9")).toEqual(UPDATE);
  });

  it("跳过的、提示过的、在面板里看过的版本都不再提示", () => {
    expect(updateToAnnounce(state({ kind: "available", update: UPDATE }), "0.3.0", null)).toBeNull();
    expect(updateToAnnounce(state({ kind: "available", update: UPDATE }), null, "0.3.0")).toBeNull();
    expect(updateToAnnounce(state({ kind: "available", update: UPDATE }, { seenVersion: "0.3.0" }), null, null)).toBeNull();
  });

  it("别的通道的候选与同通道的一样提示：判断只看版本，不看通道", () => {
    const beta: UpdateInfo = { version: "0.3.0-beta.1", current_version: "0.2.0", notes: null, date: null, channel: "beta" };
    const channels: UpdaterChannels = { package_channel: "stable", preference: "beta", relation: "following", channel_heads: [], refused: [] };
    expect(updateToAnnounce(state({ kind: "available", update: beta }, { channels }), null, null)).toEqual(beta);
    expect(updateToAnnounce(state({ kind: "available", update: beta }, { channels }), null, "0.3.0-beta.1")).toBeNull();
  });

  it("更新源没跟上、下载被拒时不提示", () => {
    expect(updateToAnnounce(state({ kind: "check_failed", message: "旧", network: null, staleChannel: "beta" }), null, null)).toBeNull();
    expect(updateToAnnounce(state({ kind: "download_failed", update: UPDATE, reason: "读不了", signature: false, network: null, sourcesTried: 1, refusal: "data_too_new" }), null, null)).toBeNull();
  });

  it("没查到新版本或检查失败时不提示", () => {
    expect(updateToAnnounce(state({ kind: "up_to_date", checkedAt: 5 }), null, null)).toBeNull();
    expect(updateToAnnounce(state({ kind: "check_failed", message: "超时", network: "timeout", staleChannel: null }), null, null)).toBeNull();
    expect(updateToAnnounce(state({ kind: "ready", update: UPDATE }), null, null)).toBeNull();
  });
});
