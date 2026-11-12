// @vitest-environment jsdom
// @module-tag heavy-page
// 更新面板换阶段时不塌、不硬切：开始安装时正文与底栏都留着，只换状态块与按钮状态；版本不在了时弹窗播完退场再走。
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../art/illustrations/test-canvas";
import { sourceSwitchedCopy, UPDATE_COPY } from "../copy/updater";
import { formatBytes } from "../domain/format";
import type { UpdateDto, UpdaterInfoDto } from "../ipc/system";
import { CORE_EVENT } from "../ipc/tasks";
import { SPEED_REFRESH_MS } from "../lib/progress-display";
import { AppearanceProvider, DEFAULT_APPEARANCE } from "../state/appearance";
import { LauncherProvider } from "../state/launcher";
import type { DownloadSource, UpdaterPhase } from "../state/updater/machine";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, callsOf, deferred, emit, resetRecorder, settle, type Deferred } from "../test/launcher";
import { OverlayRoot } from "./overlay";
import { ShellProvider, useShell, type ShellApi } from "./shell";
import { UpdatePanelMount, updatePanelLayoutKey } from "./UpdatePanel";
import styles from "./UpdatePanel.module.css";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

const UPDATE: UpdateDto = { version: "0.2.0", current_version: "0.1.0", notes: "修复若干问题", date: null };

let view: Rendered | undefined;
let shell: ShellApi;
let info: UpdaterInfoDto;
let install: Deferred<null>;

function Probe() {
  shell = useShell();
  return null;
}

const flush = () =>
  act(async () => {
    await settle();
  });

/** 已下好、等安装：打开面板。 */
async function openReady() {
  view = render(
    <AppearanceProvider initial={{ ...DEFAULT_APPEARANCE, petals: false }}>
      <LauncherProvider>
        <ShellProvider>
          <Probe />
          <UpdatePanelMount />
          <OverlayRoot />
        </ShellProvider>
      </LauncherProvider>
    </AppearanceProvider>,
  );
  await flush();
  act(() => shell.openUpdatePanel());
  await flush();
}

function dialog(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-sk-modal-layer]:not([data-exiting]) [role="dialog"]');
  if (el === null) throw new Error("更新面板没有打开");
  return el;
}

/** 正文末尾随阶段替换的状态块。 */
const statusBlocks = () => [...dialog().querySelectorAll<HTMLElement>(`.${styles.status}`)];

function button(text: string): HTMLButtonElement {
  const found = [...dialog().querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.textContent === text);
  if (found.length !== 1) throw new Error(`「${text}」按钮应当恰好一个，实为 ${found.length}`);
  return found[0];
}

beforeEach(() => {
  vi.useFakeTimers();
  resetRecorder(ipc);
  stubResizeObserver();
  stubMatchMedia(false);
  stubCanvas();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  info = { current_version: "0.1.0", supported: true, unsupported_reason: null, available: UPDATE, downloaded_version: UPDATE.version, install_on_exit: false };
  install = deferred<null>();
  bootOverrides(ipc);
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("updater_info", () => info);
  ipc.overrides.set("install_update", () => install.promise);
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
});

describe("开始安装", () => {
  it("正文不换成转圈：更新说明还在，状态块说明正在安装；底栏留着原来两个键，按下的转圈、另一个禁用", async () => {
    await openReady();
    // 打开时就在的状态块跟着弹窗一起出现，不单独淡入
    expect(statusBlocks().map((el) => [el.textContent, el.style.opacity])).toEqual([[UPDATE_COPY.readyNote, "1"]]);
    act(() => button(UPDATE_COPY.restartInstall).click());
    await flush();
    expect(dialog().textContent).toContain(UPDATE.notes);
    expect(dialog().textContent).toContain(UPDATE_COPY.installNote);
    // 已下好的说明那一块同帧移除、不留着退场，正在安装的一块从透明淡入
    const blocks = statusBlocks();
    expect(blocks.map((el) => el.textContent)).toEqual([UPDATE_COPY.installing]);
    expect(blocks[0].style.opacity).toBe("0");
    expect(dialog().textContent).not.toContain(UPDATE_COPY.readyNote);
    const restart = button(UPDATE_COPY.restartInstall);
    expect(restart.getAttribute("aria-busy")).toBe("true");
    expect(restart.getAttribute("aria-disabled")).toBe("true");
    expect(button(UPDATE_COPY.installOnExit).disabled).toBe(true);
    // 安装中不可关闭：没有右上角关闭键
    expect(dialog().querySelector('button[aria-label="关闭"]')).toBeNull();
  });

  it("从「退出时安装」改为现在安装：沿用那一面的底栏，「改为现在安装」转圈、「关闭」禁用", async () => {
    info = { ...info, install_on_exit: true };
    await openReady();
    act(() => button(UPDATE_COPY.switchToNow).click());
    await flush();
    expect(button(UPDATE_COPY.switchToNow).getAttribute("aria-busy")).toBe("true");
    expect(button(UPDATE_COPY.close).disabled).toBe(true);
  });

  it("安装没能拉起：回到已下载，两个键恢复可用，状态块换回已下好的说明", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await openReady();
    act(() => button(UPDATE_COPY.restartInstall).click());
    await flush();
    install.reject(new Error("安装程序没有启动"));
    await flush();
    expect(button(UPDATE_COPY.restartInstall).hasAttribute("aria-busy")).toBe(false);
    expect(button(UPDATE_COPY.installOnExit).disabled).toBe(false);
    expect(statusBlocks().map((el) => [el.textContent, el.style.opacity])).toEqual([[UPDATE_COPY.readyNote, "0"]]);
    expect(dialog().textContent).not.toContain(UPDATE_COPY.installing);
  });

  it("安装命令返回、这一版不在了：弹窗留在原处播退场，不随版本消失同帧卸载", async () => {
    await openReady();
    act(() => button(UPDATE_COPY.restartInstall).click());
    await flush();
    info = { ...info, available: null, downloaded_version: null };
    install.resolve(null);
    await flush();
    expect(shell.updatePanelOpen).toBe(false);
    expect(document.querySelector('[data-sk-modal-layer]:not([data-exiting])')).toBeNull();
    const leaving = document.querySelector<HTMLElement>("[data-sk-modal-layer][data-exiting]");
    expect(leaving?.textContent).toContain(UPDATE_COPY.panelTitle(UPDATE.version));
  });
});

describe("下载进度的文字", () => {
  const TOTAL = 10 * 1024 * 1024;

  /** 点「下载」并拿到下载任务的 id：下载命令一直挂着，进度只由测试发的事件推动。 */
  async function startDownload(): Promise<string> {
    info = { ...info, downloaded_version: null };
    ipc.overrides.set("download_update", () => deferred<UpdateDto>().promise);
    await openReady();
    act(() => button(UPDATE_COPY.download).click());
    await flush();
    const taskId = callsOf(ipc, "download_update")[0].taskId;
    if (typeof taskId !== "string") throw new Error("下载命令没有带 taskId");
    return taskId;
  }

  const progress = (taskId: string, bytes: number) =>
    act(() => emit(CORE_EVENT, { kind: "download", task_id: taskId, total: 1, finished: 0, bytes, total_bytes: TOTAL, speed: 0 }));
  const sizeText = () => dialog().querySelector(`.${styles.progressText}`)?.textContent;
  const barValue = () => dialog().querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow");

  it("进度条随每条进度事件走，已下大小的字每 500 ms 才换一次", async () => {
    const taskId = await startDownload();
    progress(taskId, 0);
    await flush();
    expect(sizeText()).toBe(UPDATE_COPY.progress(formatBytes(0), formatBytes(TOTAL)));
    const step = SPEED_REFRESH_MS / 5;
    for (let i = 1; i <= 4; i++) {
      await act(() => vi.advanceTimersByTimeAsync(step));
      progress(taskId, (TOTAL * i) / 10);
      await flush();
      expect(barValue()).toBe(String(i * 10));
      expect(sizeText()).toBe(UPDATE_COPY.progress(formatBytes(0), formatBytes(TOTAL)));
    }
    // 间隔满的那一刻换上最近报上来的那一条
    await act(() => vi.advanceTimersByTimeAsync(step));
    expect(sizeText()).toBe(UPDATE_COPY.progress(formatBytes((TOTAL * 4) / 10), formatBytes(TOTAL)));
  });

  it("换源后进度从 0 重来：字立即回到 0，不停在作废的旧值上", async () => {
    const taskId = await startDownload();
    progress(taskId, TOTAL / 2);
    await act(() => vi.advanceTimersByTimeAsync(SPEED_REFRESH_MS));
    expect(sizeText()).toBe(UPDATE_COPY.progress(formatBytes(TOTAL / 2), formatBytes(TOTAL)));
    await act(() => vi.advanceTimersByTimeAsync(100));
    act(() => emit(CORE_EVENT, { kind: "source", task_id: taskId, index: 1, count: 3, name: "hk" }));
    await flush();
    // 换源时总量也回到未知，只写已下大小
    expect(sizeText()).toBe(formatBytes(0));
  });
});

describe("弹窗形变的依赖", () => {
  const update = { version: "0.2.0", current_version: "0.1.0", notes: null, date: null };
  const downloading = (bytes: number, source: DownloadSource | null): UpdaterPhase => ({ kind: "downloading", update, taskId: "t", bytes, totalBytes: 1200, source });
  const failed = (signature: boolean): UpdaterPhase => ({ kind: "download_failed", update, reason: "连接被重置", signature, network: null, sourcesTried: 1 });
  const key = updatePanelLayoutKey;

  it("下载进度与仍在第一个源时不变；换过源之后再换也不变（同样多一行提示）", () => {
    expect(key(downloading(0, null), false)).toBe(key(downloading(900, { index: 0, count: 3, name: "cn" }), false));
    expect(key(downloading(0, { index: 1, count: 3, name: "hk" }), false)).toBe(key(downloading(700, { index: 2, count: 3, name: "global" }), false));
  });

  it("换了源、换了阶段、游戏开始或结束、失败带不带后端原文、换了一版都变", () => {
    expect(key(downloading(0, { index: 1, count: 3, name: "hk" }), false)).not.toBe(key(downloading(0, null), false));
    expect(key({ kind: "ready", update }, true)).not.toBe(key({ kind: "ready", update }, false));
    expect(key({ kind: "ready", update }, false)).not.toBe(key({ kind: "install_on_exit", update }, false));
    // 签名不符时只有说明、没有原文，比别的失败少一段
    expect(key(failed(true), false)).not.toBe(key(failed(false), false));
    expect(key({ kind: "available", update }, false)).not.toBe(key({ kind: "available", update: { ...update, version: "0.3.0" } }, false));
  });
});

describe("换阶段时弹窗形变", () => {
  const TOTAL = 1200;

  /** 面板被量布局的次数：Modal 只在 layoutKey 变了的那次重渲染量面板、播形变，不变时一次都不量。 */
  function countMeasures(el: HTMLElement): { count: number } {
    const counter = { count: 0 };
    const real = el.getBoundingClientRect.bind(el);
    el.getBoundingClientRect = () => {
      counter.count += 1;
      return real();
    };
    return counter;
  }

  it("下载进度回调不量面板；开始下载、换了下载源、下载失败这几次改变高度时才量", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    info = { ...info, downloaded_version: null };
    const pending = deferred<UpdateDto>();
    ipc.overrides.set("download_update", () => pending.promise);
    await openReady();
    const measures = countMeasures(dialog());

    act(() => button(UPDATE_COPY.download).click());
    await flush();
    expect(measures.count).toBeGreaterThan(0);
    const taskId = callsOf(ipc, "download_update")[0].taskId;
    if (typeof taskId !== "string") throw new Error("下载命令没有带 taskId");

    measures.count = 0;
    for (const bytes of [0, 400, 800]) {
      act(() => emit(CORE_EVENT, { kind: "download", task_id: taskId, total: 1, finished: 0, bytes, total_bytes: TOTAL, speed: 0 }));
      await flush();
    }
    // 已下大小的字按节拍补上最后一条：这次重渲染同样不量面板
    await act(() => vi.advanceTimersByTimeAsync(SPEED_REFRESH_MS));
    expect(dialog().textContent).toContain(UPDATE_COPY.progress(formatBytes(800), formatBytes(TOTAL)));
    expect(measures.count).toBe(0);

    act(() => emit(CORE_EVENT, { kind: "source", task_id: taskId, index: 1, count: 3, name: "hk" }));
    await flush();
    const switched = sourceSwitchedCopy({ index: 1, count: 3 });
    if (switched === null) throw new Error("换到第二个源应当有提示");
    expect(dialog().textContent).toContain(switched);
    expect(measures.count).toBeGreaterThan(0);

    measures.count = 0;
    pending.reject(new Error("连接被重置"));
    await flush();
    expect(statusBlocks().map((el) => el.textContent)).toEqual([expect.stringContaining("连接被重置")]);
    expect(measures.count).toBeGreaterThan(0);
  });
});
