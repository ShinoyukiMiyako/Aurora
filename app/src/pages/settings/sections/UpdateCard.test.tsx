// @vitest-environment jsdom
// 更新卡的状态行：下载中的已下大小与更新面板按同一个节拍换字，主句里的百分比照每条进度事件走。
// 更新通道选项块：选了就写、连按方向键每次都写，下载中与已下好时先确认，写失败回到原值。
import { act, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SPEED_REFRESH_MS } from "../../../lib/progress-display";
import { OverlayProvider, OverlayRoot } from "../../../shell/overlay";
import { INITIAL_UPDATER_STATE, type DownloadSource, type UpdateInfo } from "../../../state/updater/machine";
import { deferred, type Deferred } from "../../../test/launcher";
import { drainFrames, keydown, render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../../test/dom";
import s from "../settings.module.css";
import { ChannelPicker, StatusLine } from "./UpdateCard";
import { updateCardView, type CardContext, type ChannelChangeCost, type ChannelId } from "./update-view";

/** 外层统一错误处理换成只记下通知的版本：选项块不需要整个状态容器，只要看写失败时报了什么。 */
const reported = vi.hoisted(() => ({ errors: [] as { title: string; body: string }[] }));
vi.mock("../../../shell/useRunner", async (orig) => {
  const mod = await orig<typeof import("../../../shell/useRunner")>();
  const runner: import("../../../shell/useRunner").Runner = (work, title) => mod.runGuarded(work, title, { error: (t, body) => void reported.errors.push({ title: t, body }) });
  return { ...mod, useRunner: () => runner };
});

const MB = 1024 * 1024;
const TOTAL = 10 * MB;
const T0 = 1_730_000_000_000;
const UPDATE: UpdateInfo = { version: "0.3.0", current_version: "0.2.0", notes: null, date: null, channel: "stable" };
const CTX: CardContext = { checkUpdates: true, skippedVersion: null, now: T0, online: true, gameRunning: false };

let view: Rendered | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  stubResizeObserver();
  stubMatchMedia(false);
  reported.errors = [];
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  view?.unmount();
  view = undefined;
  // 确认框的进出场在假时钟上排着帧，换回真实计时器之前排空
  await drainFrames();
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

interface PickerSetup {
  preference: ChannelId;
  packageChannel: ChannelId;
  locked?: boolean;
  /** 此刻改通道会丢掉什么；null 是直接写。 */
  cost?: ChannelChangeCost | null;
}

/** 每次写入的通道与它的结局：由用例逐个放行或拒绝，模拟后端写完才回来。 */
let writes: { channel: ChannelId; done: Deferred<void> }[];

/** 写成功后像更新信息同步回来那样换上新的生效偏好。 */
function Harness({ preference, packageChannel, locked = false, cost = null }: PickerSetup) {
  const [committed, setCommitted] = useState(preference);
  const setChannel = async (channel: ChannelId) => {
    const done = deferred<void>();
    writes.push({ channel, done });
    await done.promise;
    setCommitted(channel);
  };
  return <ChannelPicker preference={committed} packageChannel={packageChannel} locked={locked} costOf={() => cost} setChannel={setChannel} />;
}

function mountPicker(setup: PickerSetup) {
  writes = [];
  view = render(
    <OverlayProvider>
      <Harness {...setup} />
      <OverlayRoot />
    </OverlayProvider>,
  );
}

const flushWrites = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

const tiles = () => [...document.querySelectorAll<HTMLButtonElement>('[role="radiogroup"] [role="radio"]')];
function tile(title: string): HTMLButtonElement {
  const found = tiles().find((t) => t.textContent?.startsWith(title));
  if (found === undefined) throw new Error(`找不到选项「${title}」`);
  return found;
}
const written = () => writes.map((w) => w.channel);

/** 开着的确认框（退场中的不算：假时钟下退场播不完，节点会留着）。 */
const openDialogs = () => [...document.querySelectorAll<HTMLElement>('[data-sk-modal-layer]:not([data-exiting]) [role="dialog"]')];
function dialogButton(label: string): HTMLButtonElement {
  const found = [...(openDialogs()[0]?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => b.textContent === label);
  if (found === undefined) throw new Error(`确认框里没有「${label}」`);
  return found;
}

describe("更新通道选项块", () => {
  it("从快到慢列出三条线，各带一句说明；勾选生效的偏好，「现在装的」只标在包的通道上；组的读屏名是「更新通道」", () => {
    mountPicker({ preference: "beta", packageChannel: "dev" });
    const group = document.querySelector('[role="radiogroup"]');
    expect(group?.getAttribute("aria-label")).toBe("更新通道");
    expect(tiles().map((t) => t.textContent)).toEqual([
      "预览版现在装的每有改动就出一版，新东西最先到，也最可能有问题",
      "测试版从预览版里挑出用过一阵的版本，更稳，更新慢一些",
      "正式版测试版里没再发现问题的版本，最稳，更新最慢",
    ]);
    expect(tiles().map((t) => t.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    const tags = [...document.querySelectorAll('[data-tone="outline"]')];
    expect(tags.map((t) => [t.textContent, t.closest('[role="radio"]') === tile("预览版")])).toEqual([["现在装的", true]]);
    // 整组一个 Tab 停靠点，落在已选的那一项
    expect(tiles().map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("选更快的线：直接写，不弹确认；写入期间先显示新值，写完就是后端给的值", async () => {
    mountPicker({ preference: "stable", packageChannel: "stable" });
    act(() => tile("测试版").click());
    expect([written(), openDialogs()]).toEqual([["beta"], []]);
    expect(tile("测试版").getAttribute("aria-checked")).toBe("true");
    writes[0].done.resolve();
    await flushWrites();
    expect(tiles().map((t) => t.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
  });

  it("选更慢的线也不另确认：选择本身不装任何东西，代价由状态行写明", async () => {
    mountPicker({ preference: "dev", packageChannel: "dev" });
    act(() => tile("正式版").click());
    expect([written(), openDialogs()]).toEqual([["stable"], []]);
  });

  it("连按方向键：每按一下都写一次偏好，前一次还没写完也照写；首尾循环", async () => {
    mountPicker({ preference: "dev", packageChannel: "dev" });
    act(() => tile("预览版").focus());
    keydown(document.activeElement as Element, "ArrowRight");
    keydown(document.activeElement as Element, "ArrowRight");
    expect(written()).toEqual(["beta", "stable"]);
    expect(document.activeElement).toBe(tile("正式版"));
    keydown(document.activeElement as Element, "ArrowRight");
    expect(written()).toEqual(["beta", "stable", "dev"]);
    expect(openDialogs()).toEqual([]);
    for (const w of writes) w.done.resolve();
    await flushWrites();
    expect(tiles().map((t) => t.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
  });

  it("正在下载时改通道：先确认，正文说取消正在下的那一版，取消键是「继续下载」；继续下载则不写、选项回到原值", async () => {
    mountPicker({ preference: "stable", packageChannel: "stable", cost: { version: "0.3.0", downloading: true } });
    const target = tile("测试版");
    act(() => target.focus());
    act(() => target.click());
    expect(written()).toEqual([]);
    const [dialog] = openDialogs();
    expect([dialog.querySelector("h2")?.textContent, dialog.textContent?.includes("正在下载的 0.3.0 会被取消，之后按测试版检查更新。")]).toEqual(["把更新通道改成测试版？", true]);
    expect([...dialog.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["继续下载", "改成测试版"]);
    // 问的时候选项停在要改成的那一项
    expect(target.getAttribute("aria-checked")).toBe("true");

    act(() => dialogButton("继续下载").click());
    await flushWrites();
    expect([written(), openDialogs()]).toEqual([[], []]);
    expect(tiles().map((t) => t.getAttribute("aria-checked"))).toEqual(["false", "false", "true"]);
    // 焦点经焦点归还回到刚才那一块
    expect(document.activeElement).toBe(target);
  });

  it("正在下载时确认改通道：这时才写，写完换成新值", async () => {
    mountPicker({ preference: "stable", packageChannel: "stable", cost: { version: "0.3.0", downloading: true } });
    act(() => tile("预览版").click());
    act(() => dialogButton("改成预览版").click());
    expect(written()).toEqual(["dev"]);
    expect(tile("预览版").getAttribute("aria-checked")).toBe("true");
    writes[0].done.resolve();
    await flushWrites();
    expect(openDialogs()).toEqual([]);
    expect(tiles().map((t) => t.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
  });

  it("已下好时改通道：正文说丢掉下好的那一版，取消键是「取消」，取消则选项回到原值", async () => {
    mountPicker({ preference: "beta", packageChannel: "beta", cost: { version: "1.0.0-beta.4", downloading: false } });
    act(() => tile("正式版").click());
    const [dialog] = openDialogs();
    expect(dialog.querySelector("h2")?.textContent).toBe("把更新通道改成正式版？");
    expect(dialog.textContent).toContain("已下好的 1.0.0-beta.4 会被丢掉，之后按正式版检查更新。");
    expect([...dialog.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["取消", "改成正式版"]);
    act(() => dialogButton("取消").click());
    await flushWrites();
    expect([written(), tiles().map((t) => t.getAttribute("aria-checked"))]).toEqual([[], ["false", "true", "false"]]);
  });

  it("确认过、还在取消下载的写入期间再改：不再问一遍，照写", async () => {
    mountPicker({ preference: "stable", packageChannel: "stable", cost: { version: "0.3.0", downloading: true } });
    act(() => tile("测试版").click());
    act(() => dialogButton("改成测试版").click());
    await flushWrites();
    act(() => tile("预览版").click());
    expect(written()).toEqual(["beta", "dev"]);
    expect(openDialogs()).toEqual([]);
  });

  it("安装中整组不可用：点了不写", () => {
    mountPicker({ preference: "stable", packageChannel: "stable", locked: true });
    expect(tiles().map((t) => t.disabled)).toEqual([true, true, true]);
    act(() => tile("测试版").click());
    expect(written()).toEqual([]);
  });

  it("写失败：选项回到原值，按设置项的写法报「没能保存「更新通道」」与原因", async () => {
    mountPicker({ preference: "stable", packageChannel: "stable" });
    act(() => tile("测试版").click());
    writes[0].done.reject(new Error("写不进配置"));
    await flushWrites();
    expect(reported.errors).toEqual([{ title: "没能保存「更新通道」", body: "写不进配置" }]);
    expect(tiles().map((t) => t.getAttribute("aria-checked"))).toEqual(["false", "false", "true"]);
  });
});
