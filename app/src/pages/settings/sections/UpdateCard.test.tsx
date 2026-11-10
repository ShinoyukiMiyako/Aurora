// @vitest-environment jsdom
// 更新卡的状态行：下载中的已下大小与更新面板按同一个节拍换字，主句里的百分比照每条进度事件走。
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SPEED_REFRESH_MS } from "../../../lib/progress-display";
import { OverlayProvider, OverlayRoot } from "../../../shell/overlay";
import { INITIAL_UPDATER_STATE, type DownloadSource, type UpdateInfo } from "../../../state/updater/machine";
import { render, type Rendered } from "../../../test/dom";
import s from "../settings.module.css";
import { StatusLine } from "./UpdateCard";
import { updateCardView, type CardContext } from "./update-view";

const MB = 1024 * 1024;
const TOTAL = 10 * MB;
const T0 = 1_730_000_000_000;
const UPDATE: UpdateInfo = { version: "0.3.0", current_version: "0.2.0", notes: null, date: null };
const CTX: CardContext = { checkUpdates: true, skippedVersion: null, now: T0, online: true, gameRunning: false };

let view: Rendered | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
});

function line(bytes: number, totalBytes: number | null = TOTAL, source: DownloadSource | null = null): ReactNode {
  const cardView = updateCardView({ ...INITIAL_UPDATER_STATE, currentVersion: "0.2.0", phase: { kind: "downloading", update: UPDATE, taskId: "t", bytes, totalBytes, source } }, CTX);
  return (
    <OverlayProvider>
      <StatusLine view={cardView} onAction={() => undefined} />
      <OverlayRoot />
    </OverlayProvider>
  );
}

function textOf(className: string): string | null {
  const el = view?.container.querySelector(`.${className}`);
  if (el === null || el === undefined) throw new Error(`状态行里没有 .${className}`);
  return el.textContent;
}

const title = () => textOf(s.updateTitle);
const sub = () => textOf(s.mutedText);

describe("更新卡下载中的次句", () => {
  it("每 100 ms 一条进度：主句百分比条条都换，已下大小每 500 ms 才换一次；进度停下后最后一条到点补上", () => {
    view = render(line(0));
    expect([title(), sub()]).toEqual(["正在下载 0.3.0 · 0%", "0 B / 10.0 MB"]);
    for (let i = 1; i <= 4; i++) {
      act(() => void vi.advanceTimersByTime(100));
      view.rerender(line(i * MB));
      expect([title(), sub()]).toEqual([`正在下载 0.3.0 · ${i * 10}%`, "0 B / 10.0 MB"]);
    }
    // 间隔满的那一刻换上最近报上来的 4 MB，紧接着到的 5 MB 等下一个间隔
    act(() => void vi.advanceTimersByTime(100));
    expect(sub()).toBe("4.0 MB / 10.0 MB");
    view.rerender(line(5 * MB));
    expect([title(), sub()]).toEqual(["正在下载 0.3.0 · 50%", "4.0 MB / 10.0 MB"]);
    act(() => void vi.advanceTimersByTime(SPEED_REFRESH_MS - 1));
    expect(sub()).toBe("4.0 MB / 10.0 MB");
    act(() => void vi.advanceTimersByTime(1));
    expect(sub()).toBe("5.0 MB / 10.0 MB");
  });

  it("换源后从 0 重来立即换上、带上换源说明；传到总量立即换上，不差一截", () => {
    const hk: DownloadSource = { index: 1, count: 4, name: "hk" };
    view = render(line(6 * MB));
    act(() => void vi.advanceTimersByTime(100));
    view.rerender(line(0, null, hk));
    expect(sub()).toBe("0 B · 已换用备用下载源（2/4）");
    act(() => void vi.advanceTimersByTime(100));
    view.rerender(line(3 * MB, TOTAL, hk));
    expect(sub()).toBe("0 B / 10.0 MB · 已换用备用下载源（2/4）");
    act(() => void vi.advanceTimersByTime(100));
    view.rerender(line(TOTAL, TOTAL, hk));
    expect([title(), sub()]).toEqual(["正在下载 0.3.0 · 100%", "10.0 MB / 10.0 MB · 已换用备用下载源（2/4）"]);
  });
});
