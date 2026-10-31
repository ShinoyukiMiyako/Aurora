// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstanceSummary } from "../domain/adapt";
import { GAME_LOG_EVENT } from "../ipc/launch";
import { LaunchHostProvider, type LaunchHost } from "../launch/host";
import { useLaunch } from "../launch/useLaunch";
import { CORE_EVENT } from "../ipc/tasks";
import { render, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, deferred, emit, resetRecorder, settle } from "../test/launcher";
import { LauncherProvider, shallowArrayEqual, useLauncher, useLauncherActions, useLauncherSelector, type LauncherApi } from "./launcher";
import type { LauncherState } from "./store";
import { isActiveTask } from "./tasks";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

const renders: Record<string, number> = {};
let launcher: LauncherApi;
let instancesSeen: InstanceSummary[][];
let view: Rendered | undefined;

function counted<T>(name: string, use: () => T): () => null {
  return function Counted() {
    use();
    renders[name] = name in renders ? renders[name] + 1 : 1;
    return null;
  };
}

const Whole = counted("整份订阅", () => {
  launcher = useLauncher();
});
const Instances = counted("实例列表", () => {
  instancesSeen.push(useLauncherSelector((s) => s.instances));
});
const Pins = counted("侧栏固定", () => useLauncherSelector((s) => s.sidebarPins));
const Active = counted("活动任务数", () => useLauncherSelector((s) => s.tasks.filter(isActiveTask).length));
const Busy = counted("安装中的实例", () =>
  useLauncherSelector(
    (s: LauncherState) => s.instances.filter((i) => i.status === "installing"),
    shallowArrayEqual,
  ),
);
const Tasks = counted("任务表", () => useLauncherSelector((s) => s.tasks));
const Logs = counted("会话日志", () => useLauncherSelector((s) => (s.session === null ? 0 : s.session.logs.length)));
const Actions = counted("只要动作", () => useLauncherActions());
const RunningEntry = counted("运行中实例的启动入口", () => useLaunch("创造"));
const InstallingEntry = counted("安装中实例的启动入口", () => useLaunch("生存"));

/** 启动入口要等实例列表读出来才能挂。 */
function WhenInstancesReady({ children }: { children: ReactNode }) {
  return useLauncherSelector((s) => s.status.instances.kind === "ready") ? children : null;
}

const host: LaunchHost = {
  run: async (work) => ({ ok: true, value: await work() }),
  go: () => undefined,
  confirm: async () => true,
};

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_720_000_000_000);
  resetRecorder(ipc);
  bootOverrides(ipc);
  for (const key of Object.keys(renders)) delete renders[key];
  instancesSeen = [];
  view = render(
    <LauncherProvider>
      <Whole />
      <Instances />
      <Pins />
      <Active />
      <Busy />
      <Tasks />
      <Logs />
      <Actions />
      <LaunchHostProvider host={host}>
        <WhenInstancesReady>
          <RunningEntry />
          <InstallingEntry />
        </WhenInstancesReady>
      </LaunchHostProvider>
    </LauncherProvider>,
  );
  await act(async () => {
    await settle();
  });
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
});

describe("按片订阅：高频的下载进度与游戏日志不让无关的组件重渲染", () => {
  it("20 次下载进度 + 20 批游戏日志：整份订阅重渲染 40 次；实例列表、侧栏、活动任务数、安装中的实例 0 次", async () => {
    const install = deferred<unknown>();
    ipc.overrides.set("install_resource", () => install.promise);
    ipc.overrides.set("launch_game", () => ({ pid: 4242 }));
    await act(async () => {
      await launcher.actions.installResource({
        resourceType: "resource_pack",
        platform: "modrinth",
        projectId: "faithful",
        name: "Faithful",
        targets: [{ instanceId: "生存", fileVersionId: "f1", world: null }],
      });
      await launcher.actions.launch("创造");
      await settle();
    });
    const [task] = launcher.state.tasks;
    expect(task.status).toBe("running");
    expect(launcher.state.session).toMatchObject({ instanceId: "创造", phase: "running" });
    const before = { ...renders };
    const instancesBefore = launcher.state.instances;

    for (let i = 1; i <= 20; i++) {
      act(() => {
        emit(CORE_EVENT, { kind: "download", task_id: `${task.id}#1`, total: 20, finished: i, bytes: i * 1000, total_bytes: 20_000, speed: 1_000_000 });
      });
      act(() => {
        emit(GAME_LOG_EVENT, { version_id: "创造", lines: [{ level: "info", source: "game", text: `第 ${i} 行` }] });
      });
    }

    const delta = (name: string) => renders[name] - before[name];
    expect(delta("整份订阅")).toBe(40);
    expect(delta("任务表")).toBe(20);
    expect(delta("会话日志")).toBe(20);
    expect(delta("实例列表")).toBe(0);
    expect(delta("侧栏固定")).toBe(0);
    expect(delta("活动任务数")).toBe(0);
    expect(delta("安装中的实例")).toBe(0);
    expect(delta("只要动作")).toBe(0);
    // 运行中的入口不读日志；安装中的入口只随自己任务的进度
    expect(delta("运行中实例的启动入口")).toBe(0);
    expect(delta("安装中实例的启动入口")).toBe(20);
    // 实例数组与其中的对象都是同一份
    expect(launcher.state.instances).toBe(instancesBefore);
    expect(launcher.state.tasks[0].progress).toBe(1);
  });

  it("活动任务的集合变了才重算实例：任务结束后安装中的实例换掉，没变的实例对象原样复用", async () => {
    const install = deferred<unknown>();
    ipc.overrides.set("install_resource", () => install.promise);
    await act(async () => {
      await launcher.actions.installResource({
        resourceType: "resource_pack",
        platform: "modrinth",
        projectId: "faithful",
        name: "Faithful",
        targets: [{ instanceId: "生存", fileVersionId: "f1", world: null }],
      });
      await settle();
    });
    const during = launcher.state.instances;
    expect(during.map((i) => [i.id, i.status])).toEqual([
      ["生存", "installing"],
      ["创造", "ready"],
    ]);
    const before = { ...renders };
    await act(async () => {
      install.resolve({ resource_type: "resource_pack", world: null, file_name: "faithful.zip" });
      await settle();
    });
    const after = launcher.state.instances;
    expect(after).not.toBe(during);
    expect(after.map((i) => [i.id, i.status])).toEqual([
      ["生存", "ready"],
      ["创造", "ready"],
    ]);
    expect(after[1]).toBe(during[1]);
    expect(renders["实例列表"] - before["实例列表"]).toBe(1);
    expect(renders["侧栏固定"] - before["侧栏固定"]).toBe(0);
  });

  it("选出的新数组按 isEqual 判等：内容没变就沿用上一次的引用", async () => {
    const seen = instancesSeen.length;
    act(() => {
      launcher.actions.toast("info", "无关的通知");
    });
    expect(instancesSeen.length).toBe(seen);
    expect(renders["安装中的实例"]).toBe(1);
  });
});
