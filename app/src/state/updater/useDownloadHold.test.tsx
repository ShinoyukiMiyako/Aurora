// @vitest-environment jsdom
// 下载完成后的收尾一拍：更新卡与更新面板共用的规则，只看钩子交出去的阶段与 holding。
import { MotionConfig } from "framer-motion";
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPLETION_HOLD_S } from "../../lib/progress-display";
import { render, type Rendered } from "../../test/dom";
import type { DownloadSource, UpdateInfo, UpdaterPhase } from "./machine";
import { useDownloadHold } from "./useDownloadHold";

const MB = 1024 * 1024;
const TOTAL = 10 * MB;
const T0 = 1_730_000_000_000;
const UPDATE: UpdateInfo = { version: "0.3.0", current_version: "0.2.0", notes: null, date: null, channel: "stable" };
const READY: UpdaterPhase = { kind: "ready", update: UPDATE };
const HOLD_MS = COMPLETION_HOLD_S * 1000;

const downloading = (bytes: number, totalBytes: number | null = TOTAL, source: DownloadSource | null = null, taskId = "t"): UpdaterPhase => ({
  kind: "downloading",
  update: UPDATE,
  taskId,
  bytes,
  totalBytes,
  source,
});

let view: Rendered | undefined;
/** 钩子最近一次交出去的结果。 */
let shown: { phase: UpdaterPhase; holding: boolean } | null = null;

function Probe({ phase }: { phase: UpdaterPhase }) {
  shown = useDownloadHold(phase);
  return null;
}

function held(phase: UpdaterPhase, reducedMotion = false): ReactNode {
  return reducedMotion ? (
    <MotionConfig reducedMotion="always">
      <Probe phase={phase} />
    </MotionConfig>
  ) : (
    <Probe phase={phase} />
  );
}

function mount(phase: UpdaterPhase, reducedMotion = false) {
  view = render(held(phase, reducedMotion));
}

function step(phase: UpdaterPhase, reducedMotion = false) {
  if (view === undefined) throw new Error("还没有挂载");
  view.rerender(held(phase, reducedMotion));
}

function result(): { phase: UpdaterPhase; holding: boolean } {
  if (shown === null) throw new Error("钩子还没渲染过");
  return shown;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  shown = null;
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
});

describe("下载完成时的收尾", () => {
  it("下载中原样交出；完成的那一次提交起留一拍：按最后一份下载中画、已下大小换成总量，收尾时长过了才交出已下好", () => {
    const last = Math.round(TOTAL * (0.5 + Math.random() * 0.4));
    mount(downloading(0));
    step(downloading(last));
    expect(result()).toEqual({ phase: downloading(last), holding: false });
    step(READY);
    expect(result()).toEqual({ phase: downloading(TOTAL), holding: true });
    act(() => void vi.advanceTimersByTime(HOLD_MS - 1));
    expect(result()).toEqual({ phase: downloading(TOTAL), holding: true });
    act(() => void vi.advanceTimersByTime(1));
    expect(result()).toEqual({ phase: READY, holding: false });
  });

  it("留住的是最后一个源的那一份：换源说明跟着留下", () => {
    const hk: DownloadSource = { index: 1, count: 4, name: "hk" };
    mount(downloading(0, null, hk));
    step(downloading((TOTAL * 3) / 4, TOTAL, hk));
    step(READY);
    expect(result()).toEqual({ phase: downloading(TOTAL, TOTAL, hk), holding: true });
  });

  it("收尾只留一次：过了收尾之后改为退出时安装再改回来，已下好不再被留住", () => {
    mount(downloading(TOTAL / 2));
    step(READY);
    act(() => void vi.advanceTimersByTime(HOLD_MS));
    expect(result().holding).toBe(false);
    step({ kind: "install_on_exit", update: UPDATE });
    step(READY);
    expect(result()).toEqual({ phase: READY, holding: false });
  });

  it("减少动画：收尾时长为 0，完成的那一次提交就交出已下好", () => {
    mount(downloading(TOTAL / 2), true);
    step(READY, true);
    expect(result()).toEqual({ phase: READY, holding: false });
  });

  it("总量未知时没有满格可推：完成就交出已下好", () => {
    mount(downloading(3 * MB, null));
    step(READY);
    expect(result()).toEqual({ phase: READY, holding: false });
  });

  it("下载失败不留：失败的那一次提交就交出失败", () => {
    const failed: UpdaterPhase = { kind: "download_failed", update: UPDATE, reason: "连接被重置", signature: false, network: null, sourcesTried: 1, refusal: null };
    mount(downloading(TOTAL / 2));
    step(failed);
    expect(result()).toEqual({ phase: failed, holding: false });
  });

  it("下好的不是正在下的那一版（新一轮检查换了版本）：不留", () => {
    const other: UpdaterPhase = { kind: "ready", update: { ...UPDATE, version: "0.4.0" } };
    mount(downloading(TOTAL / 2));
    step(other);
    expect(result()).toEqual({ phase: other, holding: false });
  });
});
