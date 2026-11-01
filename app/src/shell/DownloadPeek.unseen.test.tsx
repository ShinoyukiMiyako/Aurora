// @vitest-environment jsdom
// @module-tag heavy-page
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IpcError } from "../ipc/errors";
import TasksPage from "../pages/tasks";
import { LauncherProvider, useLauncher, type LauncherApi } from "../state/launcher";
import { render, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, deferred, resetRecorder, settle, type Deferred } from "../test/launcher";
import { DownloadPeek } from "./DownloadPeek";
import { OverlayRoot } from "./overlay";
import { ShellProvider, useNav, type NavApi } from "./shell";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

let view: Rendered | undefined;
let nav: NavApi;
let launcher: LauncherApi;
let runs: Map<number, Deferred<unknown>>;

function Host() {
  nav = useNav();
  launcher = useLauncher();
  return (
    <>
      <DownloadPeek />
      {nav.route.page === "tasks" && <TasksPage route={nav.route} />}
    </>
  );
}

const flush = () =>
  act(async () => {
    await settle();
  });

function entry(): HTMLButtonElement {
  if (view === undefined) throw new Error("还没有挂载");
  const button = view.container.querySelector<HTMLButtonElement>("button[aria-haspopup='dialog']");
  if (button === null) throw new Error("找不到下载入口");
  return button;
}

async function failJava(major: number): Promise<void> {
  await act(() => launcher.actions.installJava(major));
  await flush();
  runs.get(major)?.reject(new IpcError("java_failed", "运行时清单下载失败"));
  await flush();
}

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
afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
});

describe("未看过的失败任务", () => {
  it("失败后入口挂危险点；进入下载任务页即清除，离开后再有失败重新挂上，打开快览也清除", async () => {
    expect(entry().getAttribute("aria-label")).toBe("下载任务");
    await failJava(21);
    expect(launcher.state.unseenFailures).toBe(1);
    expect(entry().getAttribute("aria-label")).toContain("1 个任务失败");

    act(() => nav.go({ page: "tasks" }));
    await flush();
    expect(launcher.state.unseenFailures).toBe(0);
    expect(entry().getAttribute("aria-label")).toBe("下载任务");

    // 停在下载任务页期间新出现的失败也就在列表里
    await failJava(17);
    expect(launcher.state.unseenFailures).toBe(0);

    act(() => nav.go({ page: "home" }));
    await flush();
    await failJava(8);
    expect(entry().getAttribute("aria-label")).toContain("1 个任务失败");
    act(() => entry().click());
    await flush();
    expect(launcher.state.unseenFailures).toBe(0);
  });

  it("重试的那一次再失败是新的未看；重试回排队的不算；清除已结束一并清掉", async () => {
    await failJava(21);
    act(() => nav.go({ page: "tasks" }));
    await flush();
    act(() => nav.go({ page: "home" }));
    await flush();
    const [task] = launcher.state.tasks;
    act(() => launcher.actions.retryTask(task.id));
    await flush();
    expect(launcher.state.unseenFailures).toBe(0);
    runs.get(21)?.reject(new IpcError("java_failed", "又失败了"));
    await flush();
    expect(launcher.state.unseenFailures).toBe(1);

    // 失败行被重试回排队后，它不再算未看的失败
    act(() => launcher.actions.retryTask(task.id));
    await flush();
    expect(launcher.state.unseenFailures).toBe(0);
    runs.get(21)?.reject(new IpcError("java_failed", "第三次"));
    await flush();
    act(() => launcher.actions.clearFinishedTasks());
    expect(launcher.state.unseenFailures).toBe(0);
  });
});
