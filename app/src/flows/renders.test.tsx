// @vitest-environment jsdom
// 流程弹窗按片订阅：新建实例、登录各弹窗、首次启动向导开着的时候，下载进度每个任务约 100 ms 一次、
// 游戏日志每 100 ms 一批都与它们无关。弹窗整份订阅状态时，版本列表、立绘与表单都随它们重渲染。
// 这里在一个补全任务下载、另一个实例运行的场景下发 20 次进度与 20 批日志，数弹窗子树的提交次数。
import { act, Profiler, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../art/illustrations/test-canvas";
import { GAME_LOG_EVENT } from "../ipc/launch";
import { resetMocks } from "../ipc/mock";
import { CORE_EVENT } from "../ipc/tasks";
import { OverlayRoot } from "../shell/overlay";
import { ShellProvider } from "../shell/shell";
import { AppearanceProvider, DEFAULT_APPEARANCE } from "../state/appearance";
import { LauncherProvider, useLauncher, useLauncherSelector, type LauncherApi } from "../state/launcher";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { accountDto, bootOverrides, emit, instanceDto, resetRecorder, settle } from "../test/launcher";
import CreateInstanceFlow from "./create-instance/index";
import LoginFlow from "./login/index";
import OnboardingFlow from "./onboarding/index";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

let view: Rendered | undefined;
let launcher: LauncherApi;
let commits = 0;

function Probe() {
  launcher = useLauncher();
  return null;
}

/** 登录弹窗由外壳按状态里的 login 挂载；这里照做，只订阅 login 这一片。 */
function LoginHost() {
  const login = useLauncherSelector((s) => s.login);
  return login === null ? null : <LoginFlow login={login} />;
}

const flush = () =>
  act(async () => {
    await settle();
  });

beforeEach(() => {
  vi.useFakeTimers();
  resetMocks();
  resetRecorder(ipc);
  stubResizeObserver();
  stubMatchMedia(false);
  stubCanvas();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  commits = 0;
  bootOverrides(ipc, {
    accounts: [
      accountDto(),
      accountDto({
        uuid: "b7c2d3e4f5a64b7c8d9e0f1a2b3c4d5e",
        name: "Yozakura",
        account_type: "authlib_injector",
        auth_server: "Example Skin",
        server_url: "https://skin.example/api/yggdrasil/",
        username: "yozakura@example.com",
      }),
    ],
    instances: [instanceDto("生存"), instanceDto("创造")],
  });
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("skin_info", () => null);
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

async function mountBusy(flow: ReactNode, open?: () => Promise<void>) {
  view = render(
    <AppearanceProvider initial={DEFAULT_APPEARANCE}>
      <LauncherProvider>
        <ShellProvider>
          <Probe />
          <Profiler id="flow" onRender={() => void (commits += 1)}>
            {flow}
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
    if (open !== undefined) await open();
    await settle();
  });
  await flush();
  const [task] = launcher.state.tasks;
  expect(task.status).toBe("running");
  expect(launcher.state.session).toMatchObject({ instanceId: "创造", phase: "running" });
  return task;
}

function stream(taskId: string) {
  commits = 0;
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

const dialogTitle = () => document.querySelector("[role='dialog'] h2")?.textContent;

describe("流程弹窗按片订阅", () => {
  it("新建实例：20 次下载进度加 20 批游戏日志，弹窗子树一次都不提交", async () => {
    const task = await mountBusy(<CreateInstanceFlow preset={null} onClose={() => undefined} />);
    expect(dialogTitle()).toBe("新建实例");
    stream(task.id);
    expect(commits).toBe(0);
  });

  it("添加离线账户：20 次下载进度加 20 批游戏日志，弹窗子树一次都不提交", async () => {
    const task = await mountBusy(<LoginHost />, () => launcher.actions.openLogin("offline"));
    expect(dialogTitle()).toBe("添加离线账户");
    stream(task.id);
    expect(commits).toBe(0);
  });

  it("外置登录：20 次下载进度加 20 批游戏日志，弹窗子树一次都不提交；用过的验证服务器照常列出", async () => {
    const task = await mountBusy(<LoginHost />, () => launcher.actions.openLogin("authlib"));
    expect(document.querySelector("[role='dialog']")?.textContent).toContain("Example Skin");
    stream(task.id);
    expect(commits).toBe(0);
  });

  it("首次启动向导：20 次下载进度加 20 批游戏日志，向导子树一次都不提交", async () => {
    ipc.overrides.set("is_first_run", () => true);
    const task = await mountBusy(<OnboardingFlow />);
    expect(document.body.textContent).toContain("游戏文件放在哪");
    stream(task.id);
    expect(commits).toBe(0);
  });
});
