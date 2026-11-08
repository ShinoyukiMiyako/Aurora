// @vitest-environment jsdom
// @module-tag heavy-page
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIRM_COPY } from "../copy/flows";
import type { Task } from "../domain/types";
import { GAME_EXIT_EVENT } from "../ipc/launch";
import { LauncherProvider, useLauncher, type LauncherApi } from "../state/launcher";
import type { LauncherState } from "../state/store";
import { render, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, callsOf, configDto, deferred, emit, instanceDto, resetRecorder, runningGameInfo, settle } from "../test/launcher";
import { OverlayRoot } from "./overlay";
import { ShellProvider } from "./shell";
import { WindowPortProvider, type CloseRequestHandler, type WindowPort } from "./window";
import { afterLaunchMove, attentionEvents, closeConfirmOptions, useAfterLaunch, useBackgroundAttention, useCloseGuard } from "./window-behavior";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

interface FakeWindow {
  port: WindowPort & Record<"show" | "minimize" | "restoreWithoutFocus" | "destroy" | "requestAttention", ReturnType<typeof vi.fn>>;
  flags: { focused: boolean; minimized: boolean; maximized: boolean };
  /** 模拟 Alt+F4：依次调用登记的关闭请求处理器，返回是否挡住了默认关闭。 */
  requestClose(): Promise<boolean>;
}

function fakeWindow(init: Partial<FakeWindow["flags"]> = {}): FakeWindow {
  const flags = { focused: true, minimized: false, maximized: false, ...init };
  const handlers = new Set<CloseRequestHandler>();
  const requestClose = async () => {
    let prevented = false;
    for (const handler of [...handlers]) await handler({ preventDefault: () => (prevented = true) });
    return prevented;
  };
  const port = {
    native: true,
    show: vi.fn(async () => {}),
    minimize: vi.fn(async () => {
      flags.minimized = true;
    }),
    restoreWithoutFocus: vi.fn(async () => {
      flags.minimized = false;
    }),
    toggleMaximize: async () => {
      flags.maximized = !flags.maximized;
    },
    close: async () => {
      await requestClose();
    },
    destroy: vi.fn(async () => {}),
    isMaximized: async () => flags.maximized,
    isMinimized: async () => flags.minimized,
    isFocused: async () => flags.focused,
    requestAttention: vi.fn(async () => {}),
    onResized: async () => () => {},
    onFocusChanged: async () => () => {},
    onCloseRequested: async (handler: CloseRequestHandler) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    onDrop: async () => () => {},
  };
  return { port, flags, requestClose };
}

let view: Rendered | undefined;
let launcher: LauncherApi;
let win: FakeWindow;

function Hooks() {
  useCloseGuard();
  useAfterLaunch();
  useBackgroundAttention();
  launcher = useLauncher();
  return null;
}

async function mount() {
  view = render(
    <WindowPortProvider port={win.port}>
      <LauncherProvider>
        <ShellProvider>
          <Hooks />
          <OverlayRoot />
        </ShellProvider>
      </LauncherProvider>
    </WindowPortProvider>,
  );
  await flush();
}

const flush = () =>
  act(async () => {
    await settle();
  });

const dialogButton = (text: string) => {
  const el = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === text);
  if (el === undefined) throw new Error(`弹窗里找不到按钮 ${text}`);
  return el;
};

beforeEach(() => {
  vi.useFakeTimers();
  resetRecorder(ipc);
  stubResizeObserver();
  bootOverrides(ipc, { instances: [instanceDto("生存")] });
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  win = fakeWindow();
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  // 假定时器也换了 requestAnimationFrame：先撤用例的替身，还原到的才是假定时器那一份，再由 useRealTimers 收走
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("关闭确认的文案", () => {
  it("没有会话也没有任务时不确认", () => {
    expect(closeConfirmOptions({ session: false, tasks: 0, downloads: 0, backups: 0 })).toBeNull();
  });

  it("只有会话：正文说游戏会继续运行，取消键是「取消」", () => {
    const options = closeConfirmOptions({ session: true, tasks: 0, downloads: 0, backups: 0 });
    expect(options).toEqual({
      title: CONFIRM_COPY.closeTitle,
      body: CONFIRM_COPY.closeWithSession,
      confirmLabel: CONFIRM_COPY.closeConfirm,
      cancelLabel: CONFIRM_COPY.cancel,
      tone: "danger",
    });
  });

  it("只有任务：正文写任务数，取消键是「继续下载」", () => {
    const options = closeConfirmOptions({ session: false, tasks: 2, downloads: 2, backups: 0 });
    expect(options?.body).toBe("还有 2 个下载没完成，关闭后会中断，下次打开可以重试。");
    expect(options?.cancelLabel).toBe(CONFIRM_COPY.keepDownloading);
  });

  it("只有本地任务：不说成下载，取消键是「取消」", () => {
    const options = closeConfirmOptions({ session: false, tasks: 2, downloads: 0, backups: 0 });
    expect(options?.body).toBe("还有 2 个任务没完成，关闭后会中断，下次打开可以重试。");
    expect(options?.cancelLabel).toBe(CONFIRM_COPY.cancel);
  });

  it("下载与本地任务都有：正文写任务，取消键仍是「继续下载」", () => {
    const options = closeConfirmOptions({ session: false, tasks: 3, downloads: 1, backups: 0 });
    expect(options?.body).toBe("还有 3 个任务没完成，关闭后会中断，下次打开可以重试。");
    expect(options?.cancelLabel).toBe(CONFIRM_COPY.keepDownloading);
  });

  it("两者都有：合并成一个对话框，正文先会话后任务", () => {
    const options = closeConfirmOptions({ session: true, tasks: 1, downloads: 1, backups: 0 });
    expect(options?.body).toBe(`${CONFIRM_COPY.closeWithSession}${CONFIRM_COPY.closeWithTasks(1, 1)}`);
    expect(options?.cancelLabel).toBe(CONFIRM_COPY.cancel);
  });
});

describe("关闭确认：自动备份", () => {
  it("只有自动备份在跑：正文说备份会中断，取消键是「取消」", () => {
    expect(closeConfirmOptions({ session: false, tasks: 0, downloads: 0, backups: 2 })).toEqual({
      title: CONFIRM_COPY.closeTitle,
      body: "有 2 个实例正在自动备份存档，关闭后这次备份不会完成。",
      confirmLabel: CONFIRM_COPY.closeConfirm,
      cancelLabel: CONFIRM_COPY.cancel,
      tone: "danger",
    });
  });

  it("与任务同时有：正文按任务、备份的顺序拼接，取消键仍是「继续下载」", () => {
    const options = closeConfirmOptions({ session: false, tasks: 1, downloads: 1, backups: 1 });
    expect(options?.body).toBe(`${CONFIRM_COPY.closeWithTasks(1, 1)}${CONFIRM_COPY.closeWithBackups(1)}`);
    expect(options?.cancelLabel).toBe(CONFIRM_COPY.keepDownloading);
  });
});

describe("游戏启动后的窗口动作", () => {
  it("保持打开与最小化照设置执行", () => {
    expect(afterLaunchMove("keep", 3)).toBe("keep");
    expect(afterLaunchMove("minimize", 0)).toBe("minimize");
  });

  it("关闭启动器：没有进行中的任务时退出，有任务时降级为最小化", () => {
    expect(afterLaunchMove("close", 0)).toBe("exit");
    expect(afterLaunchMove("close", 1)).toBe("minimize");
  });
});

function task(id: string, status: Task["status"], kind: Task["kind"] = "game"): Task {
  return {
    id,
    kind,
    title: id,
    detail: "",
    instanceId: null,
    status,
    progress: 0,
    bytes: 0,
    totalBytes: null,
    doneBytes: 0,
    transferredBytes: 0,
    batchTransferred: 0,
    batchFiles: 0,
    phase: null,
    speedBps: 0,
    startedAt: null,
    attempt: 1,
    error: status === "failed" ? { code: "network_failed", message: "断网" } : null,
    createdAt: 0,
    finishedAt: status === "done" || status === "failed" ? 1 : null,
    spec: { command: "install_version", args: {} },
  };
}

function withTasks(tasks: Task[]): LauncherState {
  return { session: null, tasks } as unknown as LauncherState;
}

describe("后台提醒的事件", () => {
  it("进行中的任务失败提醒一次，不恢复窗口", () => {
    expect(attentionEvents(withTasks([task("a", "running")]), withTasks([task("a", "failed")]))).toEqual([{ kind: "task_failed", restore: false }]);
  });

  it("新建、导入、修复完成算实例就绪；装 Mod 完成不提醒", () => {
    const prev = withTasks([task("a", "running", "modpack"), task("b", "running", "mod"), task("c", "queued", "repair")]);
    const next = withTasks([task("a", "done", "modpack"), task("b", "done", "mod"), task("c", "done", "repair")]);
    expect(attentionEvents(prev, next)).toEqual([
      { kind: "instance_ready", restore: false },
      { kind: "instance_ready", restore: false },
    ]);
  });

  it("从任务日志恢复出来的失败记录不是这次运行里发生的，不提醒", () => {
    expect(attentionEvents(withTasks([]), withTasks([task("a", "failed")]))).toEqual([]);
  });
});

describe("关闭请求", () => {
  it("没有会话与任务：直接写一次任务记录并销毁窗口", async () => {
    await mount();
    let prevented = false;
    await act(async () => {
      prevented = await win.requestClose();
      await settle();
    });
    expect(prevented).toBe(true);
    expect(callsOf(ipc, "save_task_journal")).toHaveLength(1);
    expect(win.port.destroy).toHaveBeenCalledTimes(1);
  });

  it("游戏在启动中：先确认，取消就不关", async () => {
    ipc.overrides.set("launch_game", () => deferred<never>().promise);
    await mount();
    act(() => void launcher.actions.launch("生存"));
    await flush();
    await act(async () => {
      void win.requestClose();
      await settle();
    });
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe(CONFIRM_COPY.closeTitle);
    act(() => dialogButton(CONFIRM_COPY.cancel).click());
    await flush();
    expect(win.port.destroy).not.toHaveBeenCalled();
    expect(callsOf(ipc, "save_task_journal")).toHaveLength(0);
  });

  it("游戏退出后自动备份还在跑：先确认，取消就不关；备份完（实例不再报占用）直接关", async () => {
    bootOverrides(ipc, { instances: [instanceDto("生存", { activity: "backing_up" })] });
    await mount();
    await act(async () => {
      void win.requestClose();
      await settle();
    });
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(CONFIRM_COPY.closeWithBackups(1));
    act(() => dialogButton(CONFIRM_COPY.cancel).click());
    await flush();
    expect(win.port.destroy).not.toHaveBeenCalled();

    ipc.overrides.set("list_instances", () => [instanceDto("生存", { activity: null })]);
    await act(async () => {
      await launcher.actions.reload("instances");
    });
    await act(async () => {
      await win.requestClose();
      await settle();
    });
    expect(win.port.destroy).toHaveBeenCalledTimes(1);
  });

  it("手动备份在任务表里：只算一次任务，不再按自动备份提一遍", async () => {
    ipc.overrides.set("backup_world", () => deferred<never>().promise);
    await mount();
    act(() => void launcher.actions.backupWorld("生存", "w1", "旧世界"));
    await flush();
    await act(async () => {
      void win.requestClose();
      await settle();
    });
    const body = document.querySelector('[role="dialog"]')?.textContent;
    expect(body).toContain("还有 1 个任务没完成");
    expect(body).not.toContain("自动备份");
  });

  it("确认之后写任务记录再销毁，不结束游戏进程", async () => {
    ipc.overrides.set("launch_game", () => deferred<never>().promise);
    await mount();
    act(() => void launcher.actions.launch("生存"));
    await flush();
    await act(async () => {
      void win.requestClose();
      await settle();
    });
    act(() => dialogButton(CONFIRM_COPY.closeConfirm).click());
    await flush();
    expect(callsOf(ipc, "save_task_journal")).toHaveLength(1);
    expect(win.port.destroy).toHaveBeenCalledTimes(1);
    expect(callsOf(ipc, "stop_game")).toHaveLength(0);
    expect(callsOf(ipc, "cancel_task")).toHaveLength(0);
  });
});

describe("启动后的窗口行为与后台提醒", () => {
  it("设置为最小化：进入运行时最小化，游戏退出时恢复窗口", async () => {
    bootOverrides(ipc, { instances: [instanceDto("生存")], config: configDto({ after_launch: "minimize" }) });
    ipc.overrides.set("launch_game", () => ({ pid: 1 }));
    await mount();
    await act(async () => {
      await launcher.actions.launch("生存");
      await settle();
    });
    expect(launcher.state.session?.phase).toBe("running");
    expect(win.port.minimize).toHaveBeenCalledTimes(1);
    act(() => emit(GAME_EXIT_EVENT, { version_id: "生存", exit_code: 0, crashed: false, killed: false, duration_ms: 1000 }));
    await flush();
    expect(win.port.restoreWithoutFocus).toHaveBeenCalledTimes(1);
  });

  describe("最小化之后页面 hidden、动画帧停摆", () => {
    const launchThenHide = async () => {
      bootOverrides(ipc, { instances: [instanceDto("生存")], config: configDto({ after_launch: "minimize" }) });
      ipc.overrides.set("launch_game", () => ({ pid: 1 }));
      ipc.overrides.set("last_crash", () => null);
      await mount();
      await act(async () => {
        await launcher.actions.launch("生存");
        await settle();
      });
      expect(win.flags.minimized).toBe(true);
      win.flags.focused = false;
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      vi.stubGlobal("requestAnimationFrame", () => 0);
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
    };

    it("游戏正常退出：窗口恢复，不等任何一帧", async () => {
      await launchThenHide();
      act(() => emit(GAME_EXIT_EVENT, { version_id: "生存", exit_code: 0, crashed: false, killed: false, duration_ms: 1000 }));
      await flush();
      expect(win.flags.minimized).toBe(false);
      expect(launcher.state.session?.phase).toBe("stopped");
    });

    it("游戏崩溃：窗口恢复并请求任务栏提醒，不等任何一帧", async () => {
      await launchThenHide();
      act(() => emit(GAME_EXIT_EVENT, { version_id: "生存", exit_code: 1, crashed: true, killed: false, duration_ms: 1000 }));
      await flush();
      expect(win.flags.minimized).toBe(false);
      expect(win.port.requestAttention).toHaveBeenCalledTimes(1);
      expect(launcher.state.session?.phase).toBe("crashed");
    });
  });

  it("设置为关闭：点启动的一局进入运行时写任务记录并销毁窗口", async () => {
    bootOverrides(ipc, { instances: [instanceDto("生存")], config: configDto({ after_launch: "close" }) });
    ipc.overrides.set("launch_game", () => ({ pid: 1 }));
    await mount();
    await act(async () => {
      await launcher.actions.launch("生存");
      await settle();
    });
    expect(callsOf(ipc, "save_task_journal")).toHaveLength(1);
    expect(win.port.destroy).toHaveBeenCalledTimes(1);
  });

  it("设置为关闭：开机接回的一局不再退出；它结束后点启动的下一局照常退出", async () => {
    bootOverrides(ipc, { instances: [instanceDto("生存")], config: configDto({ after_launch: "close" }), runningGame: { game: runningGameInfo(), broken_record: null } });
    ipc.overrides.set("last_launch_log", () => null);
    await mount();
    expect(launcher.state.session).toMatchObject({ phase: "running", runningSince: 1_719_999_009_000, reattached: true });
    expect(win.port.destroy).not.toHaveBeenCalled();
    expect(win.port.minimize).not.toHaveBeenCalled();
    expect(callsOf(ipc, "save_task_journal")).toHaveLength(0);

    act(() => emit(GAME_EXIT_EVENT, { version_id: "生存", exit_code: 0, crashed: false, killed: false, duration_ms: 1000 }));
    await flush();
    act(() => launcher.actions.dismissSession());
    ipc.overrides.set("launch_game", () => ({ pid: 1 }));
    await act(async () => {
      await launcher.actions.launch("生存");
      await settle();
    });
    expect(win.port.destroy).toHaveBeenCalledTimes(1);
  });

  it("设置为最小化：渲染进程重载后找回的一局不最小化，退出时也不去动窗口", async () => {
    bootOverrides(ipc, { instances: [instanceDto("生存")], config: configDto({ after_launch: "minimize" }), runningGame: { game: runningGameInfo({ reattached: false }), broken_record: null } });
    ipc.overrides.set("last_launch_log", () => null);
    await mount();
    expect(launcher.state.session).toMatchObject({ phase: "running", reattached: true });
    expect(win.port.minimize).not.toHaveBeenCalled();
    act(() => emit(GAME_EXIT_EVENT, { version_id: "生存", exit_code: 0, crashed: false, killed: false, duration_ms: 1000 }));
    await flush();
    expect(launcher.state.session?.phase).toBe("stopped");
    expect(win.port.restoreWithoutFocus).not.toHaveBeenCalled();
    expect(win.port.destroy).not.toHaveBeenCalled();
  });

  it("设置为保持打开：进入运行时不动窗口", async () => {
    ipc.overrides.set("launch_game", () => ({ pid: 1 }));
    await mount();
    await act(async () => {
      await launcher.actions.launch("生存");
      await settle();
    });
    expect(win.port.minimize).not.toHaveBeenCalled();
    expect(win.port.destroy).not.toHaveBeenCalled();
  });

  it("窗口最小化在后台时崩溃：恢复窗口并请求任务栏提醒", async () => {
    win = fakeWindow({ focused: false, minimized: true });
    ipc.overrides.set("launch_game", () => ({ pid: 1 }));
    ipc.overrides.set("last_crash", () => null);
    await mount();
    await act(async () => {
      await launcher.actions.launch("生存");
      await settle();
    });
    act(() => emit(GAME_EXIT_EVENT, { version_id: "生存", exit_code: 1, crashed: true, killed: false, duration_ms: 1000 }));
    await flush();
    expect(win.port.restoreWithoutFocus).toHaveBeenCalledTimes(1);
    expect(win.port.requestAttention).toHaveBeenCalledTimes(1);
  });

  it("窗口在前台时崩溃：不打扰任务栏", async () => {
    ipc.overrides.set("launch_game", () => ({ pid: 1 }));
    ipc.overrides.set("last_crash", () => null);
    await mount();
    await act(async () => {
      await launcher.actions.launch("生存");
      await settle();
    });
    act(() => emit(GAME_EXIT_EVENT, { version_id: "生存", exit_code: 1, crashed: true, killed: false, duration_ms: 1000 }));
    await flush();
    expect(launcher.state.session?.phase).toBe("crashed");
    expect(win.port.requestAttention).not.toHaveBeenCalled();
  });
});
