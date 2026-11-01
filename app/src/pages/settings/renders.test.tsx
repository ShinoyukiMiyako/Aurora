// @vitest-environment jsdom
// @module-tag heavy-page
// 设置页按片订阅：下载进度每个任务约 100 ms 一次、游戏日志每 100 ms 一批。分区与载入门整份订阅状态时，
// 整个分区（滑杆、单选卡、实例头像串、Java 列表）都随它们重渲染。这里在一个补全任务下载、另一个实例运行的场景下，
// 逐个分区发 20 次进度与 20 批日志，数页面子树的提交次数。「常规」分区由界面语言的改动负责，不在这里数。
import { act, Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../art/illustrations/test-canvas";
import { GAME_LOG_EVENT } from "../../ipc/launch";
import { resetMocks } from "../../ipc/mock";
import { CORE_EVENT } from "../../ipc/tasks";
import { OverlayRoot } from "../../shell/overlay";
import { ShellProvider } from "../../shell/shell";
import { AppearanceProvider, DEFAULT_APPEARANCE } from "../../state/appearance";
import { LauncherProvider, useLauncher, type LauncherApi } from "../../state/launcher";
import type { SettingsSection } from "../../state/route";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { bootOverrides, emit, instanceDto, resetRecorder, settle } from "../../test/launcher";
import SettingsPage from "./index";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));

const BUILD = { version: "0.3.0-preview.2", channel: "preview", builtAt: "2026-10-30T08:15:30.000Z" } as const;

let view: Rendered | undefined;
let launcher: LauncherApi;
let commits = 0;

function Probe() {
  launcher = useLauncher();
  return null;
}

const flush = () =>
  act(async () => {
    await settle(20);
  });

beforeEach(() => {
  vi.useFakeTimers();
  resetMocks();
  resetRecorder(ipc);
  stubResizeObserver();
  stubMatchMedia(false);
  stubCanvas();
  vi.stubGlobal("__PETALFALL_BUILD__", BUILD);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  commits = 0;
  // 两个实例要不同的 Java：「Java」分区的实例头像串与下载卡都有内容
  bootOverrides(ipc, { instances: [instanceDto("生存", { java_major: 21, memory_mb: 6144 }), instanceDto("创造", { java_major: 17 })] });
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("repair_instance", () => new Promise(() => undefined));
  ipc.overrides.set("launch_game", () => ({ pid: 4242 }));
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const SECTIONS: readonly { section: Exclude<SettingsSection, "general">; heading: string }[] = [
  { section: "download", heading: "下载源" },
  { section: "java", heading: "Java 运行时" },
  { section: "game", heading: "游戏目录" },
  { section: "appearance", heading: "明暗" },
  { section: "about", heading: "启动器更新" },
];

describe("设置页按片订阅", () => {
  it.each(SECTIONS)("「$section」分区：补全任务下载、另一个实例运行时，20 次下载进度加 20 批游戏日志，页面子树一次都不提交", async ({ section, heading }) => {
    view = render(
      <AppearanceProvider initial={DEFAULT_APPEARANCE}>
        <LauncherProvider>
          <ShellProvider>
            <Probe />
            <Profiler id="settings" onRender={() => void (commits += 1)}>
              <SettingsPage route={{ page: "settings", section }} />
            </Profiler>
            <OverlayRoot />
          </ShellProvider>
        </LauncherProvider>
      </AppearanceProvider>,
    );
    await flush();
    await act(async () => {
      await launcher.actions.repairInstance("生存");
      await launcher.actions.launch("创造");
      await settle();
    });
    await flush();
    const [task] = launcher.state.tasks;
    expect(task.status).toBe("running");
    expect(launcher.state.session).toMatchObject({ instanceId: "创造", phase: "running" });
    // 分区内容确实画出来了，而不是停在载入门的骨架上
    expect([...document.querySelectorAll("h2, h3")].map((h) => h.textContent)).toContain(heading);

    commits = 0;
    for (let i = 1; i <= 20; i++) {
      act(() => {
        emit(CORE_EVENT, { kind: "download", task_id: `${task.id}#1`, total: 20, finished: i, bytes: i * 1000, total_bytes: 20_000, speed: 1_000_000 });
      });
      act(() => {
        emit(GAME_LOG_EVENT, { version_id: "创造", lines: [{ level: "info", source: "game", text: `第 ${i} 行` }] });
      });
    }
    expect(launcher.state.tasks[0].progress).toBe(1);
    expect(launcher.state.session?.logs).toHaveLength(20);
    expect(commits).toBe(0);
  });

  it("「下载」分区：任务数变了才重渲染，下载队列一行如实写出进行中的任务数", async () => {
    view = render(
      <AppearanceProvider initial={DEFAULT_APPEARANCE}>
        <LauncherProvider>
          <ShellProvider>
            <Probe />
            <SettingsPage route={{ page: "settings", section: "download" }} />
            <OverlayRoot />
          </ShellProvider>
        </LauncherProvider>
      </AppearanceProvider>,
    );
    await flush();
    const body = () => document.body.textContent ?? "";
    expect(body()).toContain("队列空闲");
    await act(async () => {
      await launcher.actions.repairInstance("生存");
      await settle();
    });
    expect(body()).toContain("现在有 1 个任务在队列里");
  });
});
