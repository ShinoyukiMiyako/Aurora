// @vitest-environment jsdom
// 外壳常驻部件的重渲染次数：下载进度每个任务约 100 ms 一次、游戏日志每 100 ms 一批，侧栏、标题栏、通知栈这些
// 一直挂着的部件要是随它们重渲染，带布局动画的指示条与状态岛每次都得重新量一遍布局。
// 各部件换成计数外壳：外壳直接调用原组件函数，它自己的订阅与父级带来的重渲染都记在外壳上。
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { stubCanvas } from "../art/illustrations/test-canvas";
import { GAME_LOG_EVENT } from "../ipc/launch";
import { CORE_EVENT } from "../ipc/tasks";
import { DEFAULT_APPEARANCE, AppearanceProvider } from "../state/appearance";
import type { FlowProps } from "../state/flows";
import { LauncherProvider, useLauncher, type LauncherApi } from "../state/launcher";
import { PAGE_IDS, type Route } from "../state/route";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, emit, instanceDto, resetRecorder, settle } from "../test/launcher";
import { AppShell } from "./AppShell";
import type { PageTable } from "./nav";
import { createPageRegistry, type PageRegistry } from "./pages";
import { ShellProvider } from "./shell";
import { WindowPortProvider, browserWindowPort } from "./window";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

const renders = vi.hoisted(() => ({ Sidebar: 0, TitleBar: 0, CommandPalette: 0, Toasts: 0, DropHint: 0, UpdatePanelMount: 0 }));

vi.mock("./Sidebar", async (orig) => {
  const mod = await orig<typeof import("./Sidebar")>();
  return {
    ...mod,
    Sidebar: () => {
      renders.Sidebar += 1;
      return mod.Sidebar();
    },
  };
});
vi.mock("./TitleBar", async (orig) => {
  const mod = await orig<typeof import("./TitleBar")>();
  return {
    ...mod,
    TitleBar: () => {
      renders.TitleBar += 1;
      return mod.TitleBar();
    },
  };
});
vi.mock("./CommandPalette", async (orig) => {
  const mod = await orig<typeof import("./CommandPalette")>();
  return {
    ...mod,
    CommandPalette: () => {
      renders.CommandPalette += 1;
      return mod.CommandPalette();
    },
  };
});
vi.mock("./Toasts", async (orig) => {
  const mod = await orig<typeof import("./Toasts")>();
  return {
    ...mod,
    Toasts: () => {
      renders.Toasts += 1;
      return mod.Toasts();
    },
  };
});
vi.mock("./DropHint", async (orig) => {
  const mod = await orig<typeof import("./DropHint")>();
  return {
    ...mod,
    DropHint: (props: Parameters<typeof mod.DropHint>[0]) => {
      renders.DropHint += 1;
      return mod.DropHint(props);
    },
  };
});
vi.mock("./UpdatePanel", async (orig) => {
  const mod = await orig<typeof import("./UpdatePanel")>();
  return {
    ...mod,
    UpdatePanelMount: () => {
      renders.UpdatePanelMount += 1;
      return mod.UpdatePanelMount();
    },
  };
});

let view: Rendered | undefined;
let launcher: LauncherApi;
let registry: PageRegistry;
let warn: MockInstance<typeof console.warn>;

function Probe() {
  launcher = useLauncher();
  return null;
}

/** 页面换成不订阅状态的桩：这里只数外壳自己的重渲染。 */
function stubPages(): PageTable {
  const entries = PAGE_IDS.map((page) => {
    function Page({ route }: { route: Route }) {
      return <p data-page={page}>{JSON.stringify(route)}</p>;
    }
    return [page, async () => ({ default: Page })] as const;
  });
  return Object.fromEntries(entries) as unknown as PageTable;
}

function LoginStub({ login }: FlowProps<"login">) {
  return <p data-flow="login">{login.kind}</p>;
}

const flush = () =>
  act(async () => {
    await settle();
  });

beforeEach(async () => {
  vi.useFakeTimers();
  resetRecorder(ipc);
  stubResizeObserver();
  stubMatchMedia(false);
  stubCanvas();
  HTMLElement.prototype.scrollTo = function scrollTo(this: HTMLElement) {
    this.scrollTop = 0;
  };
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("updater_info", () => ({ current_version: "0.1.0", supported: false, unsupported_reason: null, available: null, downloaded_version: null, install_on_exit: false }));
  registry = createPageRegistry(stubPages());
  await registry.load("home");
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  warn.mockRestore();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("外壳常驻部件按片订阅", () => {
  it("一个补全任务在下载、另一个实例在运行：20 次下载进度加 20 批游戏日志，侧栏、标题栏、命令面板、通知栈、放置提示、更新面板一次都不重渲染", async () => {
    ipc.overrides.set("repair_instance", () => new Promise(() => undefined));
    ipc.overrides.set("launch_game", () => ({ pid: 4242 }));
    bootOverrides(ipc, { instances: [instanceDto("生存"), instanceDto("创造")] });
    view = render(
      <WindowPortProvider port={browserWindowPort()}>
        <AppearanceProvider initial={{ ...DEFAULT_APPEARANCE, petals: false }}>
          <LauncherProvider>
            <ShellProvider>
              <Probe />
              <AppShell pages={registry} flows={{ login: LoginStub, onboarding: null, createInstance: null }} />
            </ShellProvider>
          </LauncherProvider>
        </AppearanceProvider>
      </WindowPortProvider>,
    );
    await flush();
    await act(async () => {
      await launcher.actions.repairInstance("生存");
      await launcher.actions.launch("创造");
      await settle();
    });
    const [task] = launcher.state.tasks;
    expect(task.status).toBe("running");
    expect(launcher.state.session).toMatchObject({ instanceId: "创造", phase: "running" });
    // 计数外壳确实接在外壳上：挂载以来每个部件都渲染过
    for (const count of Object.values(renders)) expect(count).toBeGreaterThan(0);

    const before = { ...renders };
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
    expect(renders).toEqual(before);
  });
});
