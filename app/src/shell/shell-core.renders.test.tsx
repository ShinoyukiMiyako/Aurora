// @vitest-environment jsdom
// @module-tag heavy-page
// 外壳核心与命令面板按片订阅：下载进度每个任务约 100 ms 一次、游戏日志每 100 ms 一批。外壳核心整份订阅状态时，
// 它每次都重算历史剪除、快捷键表与全部上下文值；命令面板开着时整份订阅，每一批日志都把几十个条目重排一遍。
// 这里在一个补全任务下载、另一个实例运行的场景下发 20 次进度与 20 批日志，数外壳子树与面板子树的提交次数。
import { act, Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../art/illustrations/test-canvas";
import { GAME_LOG_EVENT } from "../ipc/launch";
import { CORE_EVENT } from "../ipc/tasks";
import { DEFAULT_APPEARANCE, AppearanceProvider } from "../state/appearance";
import { LauncherProvider, useLauncher, type LauncherApi } from "../state/launcher";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { accountDto, bootOverrides, emit, instanceDto, resetRecorder, settle } from "../test/launcher";
import { ChromeProvider, type ChromeApi } from "./chrome";
import { CommandPalette } from "./CommandPalette";
import { OverlayRoot } from "./overlay";
import { ShellProvider, useShell, type ShellApi } from "./shell";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

let view: Rendered | undefined;
let launcher: LauncherApi;
let shell: ShellApi;
let commits = 0;
const chrome: ChromeApi = { scrollContentToTop: vi.fn(), focusContent: vi.fn() };

/** 在外壳之外读整份状态：它自己的重渲染不算进外壳子树。 */
function Probe() {
  launcher = useLauncher();
  return null;
}

function ShellProbe() {
  shell = useShell();
  return null;
}

const flush = () =>
  act(async () => {
    await settle();
  });

beforeEach(() => {
  vi.useFakeTimers();
  resetRecorder(ipc);
  stubResizeObserver();
  stubMatchMedia(false);
  stubCanvas();
  commits = 0;
  bootOverrides(ipc, {
    accounts: [accountDto(), accountDto({ uuid: "00000000-0000-0000-0000-00000000a002", name: "Alex" })],
    instances: [instanceDto("生存"), instanceDto("创造")],
    pins: ["生存", "创造"],
  });
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("updater_info", () => ({ current_version: "0.1.0", supported: false, unsupported_reason: null, available: null, downloaded_version: null, install_on_exit: false }));
  ipc.overrides.set("repair_instance", () => new Promise(() => undefined));
  ipc.overrides.set("launch_game", () => ({ pid: 4242 }));
  ipc.overrides.set("skin_info", () => null);
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
});

async function mountBusy() {
  view = render(
    <AppearanceProvider initial={{ ...DEFAULT_APPEARANCE, petals: false }}>
      <LauncherProvider>
        <Probe />
        <Profiler id="shell" onRender={() => void (commits += 1)}>
          <ShellProvider>
            <ChromeProvider value={chrome}>
              <ShellProbe />
              <CommandPalette />
              <OverlayRoot />
            </ChromeProvider>
          </ShellProvider>
        </Profiler>
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
  return task;
}

function stream(taskId: string) {
  for (let i = 1; i <= 20; i++) {
    act(() => {
      emit(CORE_EVENT, { kind: "download", task_id: `${taskId}#1`, total: 20, finished: i, bytes: i * 1000, total_bytes: 20_000, speed: 1_000_000 });
    });
    act(() => {
      emit(GAME_LOG_EVENT, { version_id: "创造", lines: [{ level: "info", source: "game", text: `第 ${i} 行` }] });
    });
  }
  expect(launcher.state.tasks[0].progress).toBe(1);
  expect(launcher.state.session?.logs).toHaveLength(20);
}

describe("外壳核心与命令面板按片订阅", () => {
  it("面板关着：20 次下载进度加 20 批游戏日志，外壳子树一次都不提交", async () => {
    const task = await mountBusy();
    commits = 0;
    stream(task.id);
    expect(commits).toBe(0);
  });

  it("面板开着：20 次下载进度加 20 批游戏日志，面板一次都不重排；当前实例的操作仍是结束运行中的那一局", async () => {
    const task = await mountBusy();
    act(() => shell.openPalette());
    await flush();
    const options = () => [...document.querySelectorAll("[role='option']")].map((o) => o.textContent);
    expect(options().some((t) => t?.startsWith("结束游戏"))).toBe(true);
    expect(options().some((t) => t?.startsWith("切换到 Alex"))).toBe(true);
    commits = 0;
    stream(task.id);
    expect(commits).toBe(0);
  });
});
