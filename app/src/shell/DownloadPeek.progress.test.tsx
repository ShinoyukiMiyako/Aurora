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
  ipc.overrides.set("install_java", () => new Promise(() => undefined));
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

describe("快览的任务进度条", () => {
  it("一个任务连跑两批下载：第二批从当批进度重新走，不停在上一批的满格", async () => {
    await act(() => launcher.actions.installJava(21));
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
    act(() => emit(CORE_EVENT, { kind: "download", task_id: `${task.id}#1`, total: 3, finished: 3, bytes: 3_000, total_bytes: 3_000, speed: 1_000 }));
    await flush();
    expect(bar().getAttribute("aria-valuenow")).toBe("100");
    act(() => emit(CORE_EVENT, { kind: "download", task_id: `${task.id}#1`, total: 40, finished: 2, bytes: 5_000, total_bytes: 100_000, speed: 1_000 }));
    await flush();
    expect(bar().getAttribute("aria-valuenow")).toBe("5");
  });
});
