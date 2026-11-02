// @vitest-environment jsdom
// @module-tag heavy-page
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PEEK_COPY } from "../copy/shell";
import { CORE_EVENT } from "../ipc/tasks";
import { LauncherProvider, useLauncher, type LauncherApi } from "../state/launcher";
import { render, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, emit, resetRecorder, settle } from "../test/launcher";
import { DownloadPeek } from "./DownloadPeek";
import { OverlayRoot } from "./overlay";
import { ShellProvider } from "./shell";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

let view: Rendered | undefined;
let launcher: LauncherApi;

function Host() {
  launcher = useLauncher();
  return <DownloadPeek />;
}

const flush = () =>
  act(async () => {
    await settle();
  });

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_730_000_000_000);
  stubResizeObserver();
  resetRecorder(ipc);
  bootOverrides(ipc);
  ipc.overrides.set("install_version", () => new Promise(() => undefined));
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
afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
});

describe("快览里的分步任务", () => {
  it("详情行换成第几步；换批次时进度条接着整体进度走，不回到这一批的 0", async () => {
    await act(() => launcher.actions.createInstance({ name: "新世界", mcVersion: "1.21.1", loader: "vanilla", loaderVersion: null, cover: "grass" }));
    await flush();
    const [task] = launcher.state.tasks;
    expect(task.status).toBe("running");
    const entry = view?.container.querySelector<HTMLButtonElement>("button[aria-haspopup='dialog']");
    if (entry === null || entry === undefined) throw new Error("找不到下载入口");
    act(() => entry.click());
    await flush();
    const bar = () => {
      const el = document.querySelector<HTMLElement>(`[role="progressbar"][aria-label="${PEEK_COPY.rowProgress(task.title)}"]`);
      if (el === null) throw new Error("快览里没有这个任务的进度条");
      return el;
    };
    const plan = ["metadata", "libraries", "assets", "natives"];
    const download = (total: number, finished: number, bytes: number, totalBytes: number) =>
      act(() => emit(CORE_EVENT, { kind: "download", task_id: `${task.id}#1`, total, finished, bytes, total_bytes: totalBytes, transferred: bytes, speed: 1_000 }));
    expect(document.body.textContent).toContain(task.detail);

    act(() => emit(CORE_EVENT, { kind: "phase", task_id: `${task.id}#1`, plan, index: 1 }));
    download(40, 8, 10_000, 50_000);
    await flush();
    // 权重 1 / 7 / 11 / 1：(1 + 7 × 0.2) / 20
    expect(bar().getAttribute("aria-valuenow")).toBe("12");
    expect(document.body.textContent).toContain("下载游戏本体与库文件 · 第 2/4 步");
    expect(document.body.textContent).not.toContain(task.detail);

    download(40, 40, 50_000, 50_000);
    act(() => emit(CORE_EVENT, { kind: "phase", task_id: `${task.id}#1`, plan, index: 2 }));
    download(3000, 0, 0, 124_000);
    await flush();
    expect(bar().getAttribute("aria-valuenow")).toBe("40");
    expect(document.body.textContent).toContain("下载资源文件 · 第 3/4 步");
  });
});
