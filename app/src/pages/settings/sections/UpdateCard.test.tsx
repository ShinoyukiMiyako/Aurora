// @vitest-environment jsdom
// 更新卡的状态行：下载中的已下大小与更新面板按同一个节拍换字，主句里的百分数与进度条同一条平滑逐帧走。
// 更新通道选项块：选了就写、连按方向键每次都写，下载中与已下好时先确认，写失败回到原值。
import { MotionConfig } from "framer-motion";
import { act, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UPDATE_COPY } from "../../../copy/updater";
import { percent } from "../../../domain/format";
import { COMPLETION_HOLD_S, SPEED_REFRESH_MS } from "../../../lib/progress-display";
import { OverlayProvider, OverlayRoot } from "../../../shell/overlay";
import { INITIAL_UPDATER_STATE, type DownloadSource, type UpdateInfo, type UpdaterChannels, type UpdaterPhase } from "../../../state/updater/machine";
import { deferred, type Deferred } from "../../../test/launcher";
import { drainFrames, keydown, render, stepFrames, stubMatchMedia, stubResizeObserver, type Rendered } from "../../../test/dom";
import s from "../settings.module.css";
import { ChannelPicker, StatusLine, useDownloadHold } from "./UpdateCard";
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

/** 主句里单独成节点、随平滑逐帧换字的百分数；主句不带百分数时为 null。 */
function percentNode(): string | null {
  const nodes = view?.container.querySelectorAll(`.${s.updateTitle} > span`);
  if (nodes === undefined) throw new Error("还没有挂载");
  if (nodes.length > 1) throw new Error(`主句里应当至多一个百分数节点，实为 ${nodes.length} 个`);
  return nodes.length === 0 ? null : nodes[0].textContent;
}

/** 状态行右侧唯一的按钮。 */
function statusButton(): HTMLButtonElement {
  const found = view?.container.querySelector<HTMLButtonElement>(`.${s.updateRow} button`);
  if (found === null || found === undefined) throw new Error("状态行里没有按钮");
  return found;
}

/** 按钮上看得见的文案：文案槽（LabelSlot）里叠着全部候选，看得见的只有标着 data-current 的那条。 */
const buttonLabel = () => (statusButton().querySelector("[data-align] > [data-current]") ?? statusButton()).textContent;

/** settle 弹簧约 0.26 s 停稳；走 1 s 的帧足够它落到目标上。 */
const SETTLE_FRAMES = 60;

describe("更新卡下载中的次句", () => {
  it("每 100 ms 一条进度：从 0 开始传的第一条立即换上，不停在 0 B；之后已下大小每 500 ms 才换一次，进度停下后最后一条到点补上", () => {
    view = render(line(0));
    expect([title(), sub()]).toEqual(["正在下载 0.3.0 · 0%", "0 B / 10.0 MB"]);
    act(() => void vi.advanceTimersByTime(100));
    view.rerender(line(MB));
    expect(sub()).toBe("1.0 MB / 10.0 MB");
    for (let i = 2; i <= 5; i++) {
      act(() => void vi.advanceTimersByTime(100));
      view.rerender(line(i * MB));
      expect(sub()).toBe("1.0 MB / 10.0 MB");
    }
    // 换上 1 MB 之后间隔满的那一刻换上最近报上来的 5 MB，紧接着到的 6 MB 等下一个间隔
    act(() => void vi.advanceTimersByTime(100));
    expect(sub()).toBe("5.0 MB / 10.0 MB");
    view.rerender(line(6 * MB));
    expect(sub()).toBe("5.0 MB / 10.0 MB");
    act(() => void vi.advanceTimersByTime(SPEED_REFRESH_MS - 1));
    expect(sub()).toBe("5.0 MB / 10.0 MB");
    act(() => void vi.advanceTimersByTime(1));
    expect(sub()).toBe("6.0 MB / 10.0 MB");
  });

  it("换源后从 0 重来与重来后的第一条都立即换上、带上换源说明，主句在总量未知时不带百分数；传到总量立即换上，不差一截", async () => {
    const hk: DownloadSource = { index: 1, count: 4, name: "hk" };
    view = render(line(6 * MB));
    act(() => void vi.advanceTimersByTime(100));
    view.rerender(line(0, null, hk));
    expect([title(), percentNode(), sub()]).toEqual(["正在下载 0.3.0", null, "0 B · 已换用备用下载源（2/4）"]);
    act(() => void vi.advanceTimersByTime(100));
    view.rerender(line(3 * MB, TOTAL, hk));
    expect(sub()).toBe("3.0 MB / 10.0 MB · 已换用备用下载源（2/4）");
    act(() => void vi.advanceTimersByTime(100));
    view.rerender(line(4 * MB, TOTAL, hk));
    expect(sub()).toBe("3.0 MB / 10.0 MB · 已换用备用下载源（2/4）");
    act(() => void vi.advanceTimersByTime(100));
    view.rerender(line(TOTAL, TOTAL, hk));
    expect(sub()).toBe("10.0 MB / 10.0 MB · 已换用备用下载源（2/4）");
    await stepFrames(SETTLE_FRAMES);
    expect(title()).toBe("正在下载 0.3.0 · 100%");
  });
});

describe("更新卡下载中的主句", () => {
  it("百分数与进度条同一条平滑：新进度到了不当场换字，逐帧走过去，停在上报的值上", async () => {
    view = render(line(0));
    expect([title(), percentNode()]).toEqual(["正在下载 0.3.0 · 0%", "0%"]);
    view.rerender(line(4 * MB));
    // 进度事件约 100 ms 一条，照原样换字一秒跳十次；字等帧走起来才动
    expect(title()).toBe("正在下载 0.3.0 · 0%");
    await stepFrames(3);
    const node = percentNode();
    if (node === null) throw new Error("主句里没有百分数节点");
    const midway = Number.parseInt(node, 10);
    expect(midway).toBeGreaterThan(0);
    expect(midway).toBeLessThan(40);
    await stepFrames(SETTLE_FRAMES);
    expect([title(), percentNode()]).toEqual(["正在下载 0.3.0 · 40%", "40%"]);
  });

  it("换源与新源的第一条进度在同一次渲染里到：百分数从新源的进度起算，不停在上一个源下到的位置", async () => {
    view = render(line(8 * MB));
    expect(percentNode()).toBe("80%");
    view.rerender(line(MB / 2, TOTAL, { index: 1, count: 4, name: "hk" }));
    await stepFrames(2);
    expect(title()).toBe("正在下载 0.3.0 · 5%");
  });

  it("减少动画：百分数不走平滑，下一帧就是上报的值", async () => {
    const reduced = (node: ReactNode) => <MotionConfig reducedMotion="always">{node}</MotionConfig>;
    view = render(reduced(line(0)));
    view.rerender(reduced(line(4 * MB)));
    await stepFrames(1);
    expect(title()).toBe("正在下载 0.3.0 · 40%");
  });
});

describe("更新卡下载完成时的收尾", () => {
  const downloading = (bytes: number, totalBytes: number | null = TOTAL, source: DownloadSource | null = null): UpdaterPhase => ({
    kind: "downloading",
    update: UPDATE,
    taskId: "t",
    bytes,
    totalBytes,
    source,
  });
  const READY: UpdaterPhase = { kind: "ready", update: UPDATE };
  /** 收尾时长内的最后一帧（帧长 16 ms）：再走两帧就过了收尾。 */
  const HOLD_FRAMES = Math.floor((COMPLETION_HOLD_S * 1000) / 16) - 1;

  /** 卡片的状态行照卡片的接法：先过收尾，再按留住的阶段求呈现。 */
  function HeldLine({ phase }: { phase: UpdaterPhase }) {
    const shown = useDownloadHold(phase);
    return <StatusLine view={updateCardView({ ...INITIAL_UPDATER_STATE, currentVersion: "0.2.0", phase: shown.phase }, CTX)} onAction={() => undefined} />;
  }

  function held(phase: UpdaterPhase, reducedMotion = false): ReactNode {
    const node = (
      <OverlayProvider>
        <HeldLine phase={phase} />
        <OverlayRoot />
      </OverlayProvider>
    );
    return reducedMotion ? <MotionConfig reducedMotion="always">{node}</MotionConfig> : node;
  }

  it("下载完成：先在原处留一拍，主句的百分数推到 100%、次句换到总量，收尾时长过了才换成已下好", async () => {
    // 最后一条进度停在五成到九成之间的任意一处：后端常在报完最后一条之后几毫秒就报完成，平滑还没追上
    const last = Math.round(TOTAL * (0.5 + Math.random() * 0.4));
    const lastPct = percent(last / TOTAL);
    view = render(held(downloading(0)));
    view.rerender(held(downloading(last)));
    await stepFrames(SETTLE_FRAMES);
    expect(title()).toBe(`正在下载 0.3.0 · ${lastPct}`);
    view.rerender(held(READY));
    // 完成的那一次提交仍是下载中的样子；次句到了总量，立即换上满数
    expect([title(), sub(), buttonLabel()]).toEqual([`正在下载 0.3.0 · ${lastPct}`, "10.0 MB / 10.0 MB", UPDATE_COPY.viewProgress]);
    await stepFrames(HOLD_FRAMES);
    expect([title(), sub(), buttonLabel()]).toEqual(["正在下载 0.3.0 · 100%", "10.0 MB / 10.0 MB", UPDATE_COPY.viewProgress]);
    await stepFrames(2);
    expect([title(), sub(), buttonLabel()]).toEqual([UPDATE_COPY.ready("0.3.0"), UPDATE_COPY.readySub, UPDATE_COPY.restartInstall]);
    // 收尾只留一次：改为退出时安装再改回来，已下好不再被留住
    view.rerender(held({ kind: "install_on_exit", update: UPDATE }));
    view.rerender(held(READY));
    expect(title()).toBe(UPDATE_COPY.ready("0.3.0"));
  });

  it("换过源的下载完成：留住的次句带着换源说明，百分数接着这个源的平滑推满", async () => {
    const hk: DownloadSource = { index: 1, count: 4, name: "hk" };
    view = render(held(downloading(0, null, hk)));
    view.rerender(held(downloading((TOTAL * 3) / 4, TOTAL, hk)));
    await stepFrames(SETTLE_FRAMES);
    view.rerender(held(READY));
    expect([title(), sub()]).toEqual(["正在下载 0.3.0 · 75%", "10.0 MB / 10.0 MB · 已换用备用下载源（2/4）"]);
    await stepFrames(HOLD_FRAMES);
    expect(title()).toBe("正在下载 0.3.0 · 100%");
  });

  it("减少动画：收尾时长为 0，完成的那一次提交就换成已下好", () => {
    view = render(held(downloading(TOTAL / 2), true));
    view.rerender(held(READY, true));
    expect([title(), buttonLabel()]).toEqual([UPDATE_COPY.ready("0.3.0"), UPDATE_COPY.restartInstall]);
  });

  it("总量未知时没有满格可推：完成就换成已下好", () => {
    view = render(held(downloading(3 * MB, null)));
    view.rerender(held(READY));
    expect(title()).toBe(UPDATE_COPY.ready("0.3.0"));
  });

  it("下载失败不留：失败的那一次提交就换成失败的说法", () => {
    view = render(held(downloading(TOTAL / 2)));
    view.rerender(held({ kind: "download_failed", update: UPDATE, reason: "连接被重置", signature: false, network: null, sourcesTried: 1, refusal: null }));
    expect(title()).toBe(UPDATE_COPY.available("0.3.0"));
  });
});

describe("状态行的按钮", () => {
  const channels: UpdaterChannels = { package_channel: "stable", preference: "stable", relation: "same", channel_heads: [], refused: [] };
  const statusOf = (phase: UpdaterPhase): ReactNode => (
    <OverlayProvider>
      <StatusLine view={updateCardView({ ...INITIAL_UPDATER_STATE, currentVersion: "0.2.0", channels, phase }, CTX)} onAction={() => undefined} />
      <OverlayRoot />
    </OverlayProvider>
  );
  /** 按钮文案槽里叠着的全部候选；按钮直接写字、没有文案槽时为 null。 */
  const slotOptions = () => {
    const slot = statusButton().querySelector("[data-align]");
    return slot === null ? null : [...slot.children].map((el) => el.textContent);
  };
  const PANEL_GROUP = [UPDATE_COPY.view, UPDATE_COPY.viewProgress, UPDATE_COPY.restartInstall, UPDATE_COPY.installNow];

  it("有新版本、下载中、已下好、退出时安装、安装中之间换阶段：按钮里叠着同一组候选、按最宽的定宽，下载完成换成「重启并安装」时左缘不跳", () => {
    const steps: [UpdaterPhase, string][] = [
      [{ kind: "available", update: UPDATE }, UPDATE_COPY.view],
      [{ kind: "downloading", update: UPDATE, taskId: "t", bytes: MB, totalBytes: TOTAL, source: null }, UPDATE_COPY.viewProgress],
      [{ kind: "ready", update: UPDATE }, UPDATE_COPY.restartInstall],
      [{ kind: "install_on_exit", update: UPDATE }, UPDATE_COPY.installNow],
      [{ kind: "installing", update: UPDATE }, UPDATE_COPY.restartInstall],
    ];
    view = render(statusOf(steps[0][0]));
    const button = statusButton();
    for (const [phase, label] of steps) {
      view.rerender(statusOf(phase));
      // 同一颗按钮原地换字，不重挂
      expect([statusButton() === button, buttonLabel(), slotOptions()]).toEqual([true, label, PANEL_GROUP]);
    }
  });

  it("检查一组（检查更新、重试）带刷新图标，不进这组文案槽", () => {
    view = render(statusOf({ kind: "idle" }));
    expect([buttonLabel(), slotOptions()]).toEqual([UPDATE_COPY.check, null]);
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
