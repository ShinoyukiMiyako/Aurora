// @vitest-environment jsdom
// @module-tag heavy-page
// 快览行的进度文字、完成收尾与退场后的布局键。要让 framer-motion 把百分数的平滑与行的退场播完，帧跟着假时钟走：
// 用 stepFrames 逐帧推进，收尾时先卸载、再排空帧循环，同文件后面的用例才推得动。
import { visualElementStore } from "framer-motion";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PEEK_COPY } from "../copy/shell";
import { formatSpeed } from "../domain/format";
import { MAX_PARALLEL_TASKS } from "../domain/limits";
import { IpcError } from "../ipc/errors";
import { CORE_EVENT } from "../ipc/tasks";
import { feedSpeed, publishSpeed, SPEED_REFRESH_MS, startSpeed } from "../lib/progress-display";
import { LauncherProvider, useLauncher, type LauncherApi } from "../state/launcher";
import { drainFrames, render, stepFrames, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, deferred, emit, resetRecorder, settle, type Deferred } from "../test/launcher";
import { DownloadPeek, peekLayoutKey, peekRows, ROW_STATE_WIDEST } from "./DownloadPeek";
import styles from "./DownloadPeek.module.css";
import { OverlayRoot } from "./overlay";
import { ShellProvider } from "./shell";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

let view: Rendered | undefined;
let launcher: LauncherApi;
let runs: Map<number, Deferred<unknown>>;

function Host() {
  launcher = useLauncher();
  return <DownloadPeek />;
}

const flush = () =>
  act(async () => {
    await settle();
  });

function entry(): HTMLButtonElement {
  const button = view?.container.querySelector<HTMLButtonElement>("button[aria-haspopup='dialog']");
  if (button === null || button === undefined) throw new Error("找不到下载入口");
  return button;
}

function panel(): HTMLElement {
  const found = document.querySelector<HTMLElement>("[role='dialog']:not([data-exiting])");
  if (found === null) throw new Error("快览没有打开");
  return found;
}

/** 快览里标题含 title 的行；没有时为 null。 */
function rowOf(title: string): HTMLElement | null {
  const found = [...panel().querySelectorAll<HTMLElement>("li")].filter((li) => li.textContent?.includes(title));
  if (found.length > 1) throw new Error(`「${title}」的行不止一个`);
  return found.length === 0 ? null : found[0];
}

function row(title: string): HTMLElement {
  const found = rowOf(title);
  if (found === null) throw new Error(`快览里没有「${title}」的行`);
  return found;
}

/** 行右侧正在显示的状态文字（不含叠在下面撑宽度的字样）。 */
function stateText(title: string): string | null {
  const text = row(title).querySelector(`.${styles.rowState} > .${styles.rowStateText}`);
  if (text === null) throw new Error(`「${title}」的行没有状态文字`);
  return text.textContent;
}

function barValue(title: string): string | null {
  const bar = document.querySelector<HTMLElement>(`[role="progressbar"][aria-label="${PEEK_COPY.rowProgress(title)}"]`);
  if (bar === null) throw new Error(`快览里没有「${title}」的进度条`);
  return bar.getAttribute("aria-valuenow");
}

/** 快览面板上的布局键：浮层把它作为外框布局动画的 layoutDependency。 */
function panelLayoutKey(): [string[], number, boolean, boolean] {
  const key = visualElementStore.get(panel())?.getProps().layoutDependency;
  if (typeof key !== "string") throw new Error(`快览面板的布局键应当是字符串，实为 ${String(key)}`);
  return JSON.parse(key) as [string[], number, boolean, boolean];
}

async function startJava(major: number) {
  await act(() => launcher.actions.installJava(major));
  await flush();
  const task = launcher.state.tasks.find((t) => t.spec.args.requiredMajor === major);
  if (task === undefined) throw new Error(`没有 Java ${major} 的任务`);
  return task;
}

async function openPeek() {
  act(() => entry().click());
  await flush();
}

const javaResult = (major: number) => ({ component: "java-runtime-delta", version: { major, minor: 0, security: 1, build: 1, raw: `${major}.0.1` }, java_executable: `C:/java${major}.exe` });

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_730_000_000_000);
  stubResizeObserver();
  resetRecorder(ipc);
  bootOverrides(ipc);
  runs = new Map();
  ipc.overrides.set("install_java", (args) => {
    const d = deferred<unknown>();
    runs.set(Number(args.requiredMajor), d);
    return d.promise;
  });
  view = render(
    <LauncherProvider>
      <ShellProvider>
        <Host />
        <OverlayRoot />
      </ShellProvider>
    </LauncherProvider>,
  );
  await flush();
});
afterEach(async () => {
  view?.unmount();
  view = undefined;
  await drainFrames();
  vi.useRealTimers();
});

describe("快览行的进度文字", () => {
  it("速度按显示节流换字，不随每次上报跳；百分数与进度条同一种平滑，条先到新值、字跟着走过去", async () => {
    const java = await startJava(21);
    await openPeek();
    const download = (bytes: number, speed: number) =>
      act(() => emit(CORE_EVENT, { kind: "download", task_id: `${java.id}#1`, total: 3, finished: 1, bytes, total_bytes: 1_000, speed }));

    const first = Date.now();
    download(300, 1_000_000);
    await flush();
    // 第一批的第一次上报换了进度标识，百分数直接跳到位；速度从 0 起步，也直接写上
    await stepFrames(20);
    expect(stateText(java.title)).toBe(PEEK_COPY.progress("30%", formatSpeed(1_000_000)));

    const second = Date.now();
    download(600, 3_000_000);
    await flush();
    // 进度条的目标已是新值；百分数还没开始走，速度离上次换字不到 500 ms，都不换
    expect(barValue(java.title)).toBe("60");
    expect(stateText(java.title)).toBe(PEEK_COPY.progress("30%", formatSpeed(1_000_000)));

    await stepFrames(30);
    // 到点按平均值换字：此刻的平均值在 1 MB/s 与 3 MB/s 之间，不是最新的瞬时值
    const shown = publishSpeed(feedSpeed(startSpeed(1_000_000, first), 3_000_000, second), first + SPEED_REFRESH_MS).shown;
    expect(shown).toBeGreaterThan(1_000_000);
    expect(shown).toBeLessThan(3_000_000);
    expect(stateText(java.title)).toBe(PEEK_COPY.progress("60%", formatSpeed(shown)));
  });

  it("状态文字下面叠着不可见的最宽字样撑住宽度：排队中与运行中的行都有，读屏读不到", async () => {
    const running = await startJava(21);
    // 比同时进行的上限多一个，最后一个排队
    for (const major of [17, 11, 8].slice(0, MAX_PARALLEL_TASKS)) await startJava(major);
    await openPeek();
    const queuedTask = launcher.state.tasks.find((t) => t.status === "queued");
    if (queuedTask === undefined) throw new Error("同时进行的上限之外应当有一个排队中的任务");
    expect(stateText(queuedTask.title)).toBe(PEEK_COPY.queued);
    for (const title of [running.title, queuedTask.title]) {
      const state = row(title).querySelector(`.${styles.rowState}`);
      if (state === null) throw new Error(`「${title}」的行没有状态格`);
      const samples = [...state.children].filter((el) => el.classList.contains(styles.rowStateSample));
      expect(samples.map((el) => el.textContent)).toEqual([...ROW_STATE_WIDEST]);
      for (const el of samples) expect(el.getAttribute("aria-hidden")).toBe("true");
    }
  });
});

describe("快览行的完成收尾", () => {
  it("任务完成：行留在原处把进度推满、停一拍，取消键不可用；收尾结束才退场，别的行不受影响", async () => {
    const done = await startJava(21);
    const other = await startJava(17);
    await openPeek();
    act(() => emit(CORE_EVENT, { kind: "download", task_id: `${done.id}#1`, total: 3, finished: 2, bytes: 600, total_bytes: 1_000, speed: 1_000 }));
    await flush();

    runs.get(21)?.resolve(javaResult(21));
    await flush();
    expect(launcher.state.tasks.find((t) => t.id === done.id)?.status).toBe("done");
    // 收尾：同一个行还在进行中的位置上，进度条推满；任务已经完成，取消键留着占位但不可用
    expect(panelLayoutKey()[0]).toEqual([done.id, other.id]);
    expect(barValue(done.title)).toBe("100");
    const cancelKey = (title: string) => row(title).querySelector(`button[aria-label="${PEEK_COPY.cancel}"]`);
    expect(cancelKey(done.title)?.getAttribute("aria-disabled")).toBe("true");
    expect(cancelKey(other.title)?.getAttribute("aria-disabled")).toBeNull();

    // 收尾还没结束（160 ms）：行一直在，还排在进行中的位置上
    await stepFrames(10);
    expect(rowOf(done.title)).not.toBeNull();
    expect(panelLayoutKey()[0]).toEqual([done.id, other.id]);

    // 收尾结束后照常退场：淡完从列表里拿掉，另一行留着
    await stepFrames(40);
    expect(rowOf(done.title)).toBeNull();
    expect(panelLayoutKey()[0]).toEqual([other.id]);
    expect(rowOf(other.title)).not.toBeNull();
  });
});

describe("快览行收尾期间的速度", () => {
  it("任务完成、速度被清零后，收尾这一拍与随后的退场里速度那半段仍是完成前显示的速度，不写成 0", async () => {
    const java = await startJava(21);
    await openPeek();
    act(() => emit(CORE_EVENT, { kind: "download", task_id: `${java.id}#1`, total: 3, finished: 2, bytes: 600, total_bytes: 1_000, speed: 2_000_000 }));
    await flush();
    await stepFrames(20);
    expect(stateText(java.title)).toBe(PEEK_COPY.progress("60%", formatSpeed(2_000_000)));
    /** 此刻百分数节点写着的字：它跟着进度条平滑走，这里只核对速度那半段。 */
    const shownPercent = () => {
      const node = row(java.title).querySelector(`.${styles.rowStateText} > span`);
      if (node === null || node.textContent === null) throw new Error("状态文字里没有百分数");
      return node.textContent;
    };

    runs.get(21)?.resolve(javaResult(21));
    await flush();
    const done = launcher.state.tasks.find((t) => t.id === java.id);
    expect(done?.status).toBe("done");
    expect(done?.speedBps).toBe(0);
    expect(stateText(java.title)).toBe(PEEK_COPY.progress(shownPercent(), formatSpeed(2_000_000)));

    // 收尾中（160 ms）：进度在推满，速度不动
    await stepFrames(10);
    expect(panelLayoutKey()[0]).toEqual([java.id]);
    expect(stateText(java.title)).toBe(PEEK_COPY.progress(shownPercent(), formatSpeed(2_000_000)));

    // 收尾结束（260 ms）后行在淡出：数据里已经没有这一行，节点还在，写的仍是同一个速度
    await stepFrames(8);
    expect(panelLayoutKey()[0]).toEqual([]);
    expect(stateText(java.title)).toBe(PEEK_COPY.progress(shownPercent(), formatSpeed(2_000_000)));
  });
});

describe("快览的布局键接线", () => {
  it("布局键传给了浮层；行退场播完、列表与空态换手播完时各记一笔，外框在真正变矮的那次提交形变", async () => {
    const first = await startJava(21);
    const second = await startJava(17);
    await openPeek();
    const key = peekLayoutKey(peekRows(launcher.state.tasks), 0, 0, 0);
    expect(visualElementStore.get(panel())?.getProps().layoutDependency).toBe(key);
    expect(panelLayoutKey()).toEqual([[first.id, second.id], 0, false, false]);
    // 底栏跟着外框下沿走：同一个布局键，只在它变时量布局，不随进度的高频重渲染量
    const foot = panel().querySelector<HTMLElement>(`.${styles.foot}`);
    if (foot === null) throw new Error("快览没有底栏");
    expect(visualElementStore.get(foot)?.getProps().layoutDependency).toBe(key);

    runs.get(21)?.reject(new IpcError("java_failed", "运行时清单下载失败"));
    await flush();
    // 行还留在流里淡出：数据已经变了，这一笔还没记
    expect(rowOf(first.title)).not.toBeNull();
    expect(panelLayoutKey()).toEqual([[second.id], 0, true, true]);
    await stepFrames(30);
    expect(rowOf(first.title)).toBeNull();
    expect(panelLayoutKey()).toEqual([[second.id], 1, true, true]);

    runs.get(17)?.reject(new IpcError("java_failed", "又失败了"));
    await flush();
    expect(panelLayoutKey()).toEqual([[], 1, true, true]);
    // 列表整块淡出、空态再淡入：换手播完记下第二笔
    await stepFrames(30);
    expect(panel().textContent).toContain(PEEK_COPY.empty);
    expect(panelLayoutKey()).toEqual([[], 2, true, true]);
  });
});
