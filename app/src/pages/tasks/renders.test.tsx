// @vitest-environment jsdom
// @module-tag heavy-page
// 下载任务页按片订阅：每个运行中的任务约 100 ms 推一次进度、游戏日志每 100 ms 一批。页面整份订阅状态时，
// 页头、筛选和几十条已结束的任务行都随它们重渲染。这里三条通道都在下、还有一条排队、历史里有完成失败取消各一条，
// 外加一个实例在运行：只给其中一个任务推 20 次进度，数各部件的渲染次数；再推 20 批日志，数页面子树的提交次数。
import { act, Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GAME_LOG_EVENT } from "../../ipc/launch";
import { CORE_EVENT, type TaskRecordDto } from "../../ipc/tasks";
import { OverlayRoot } from "../../shell/overlay";
import { ShellProvider } from "../../shell/shell";
import { LauncherProvider, useLauncher, type LauncherApi } from "../../state/launcher";
import { render, stubResizeObserver, type Rendered } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { bootOverrides, cancelledError, deferred, emit, resetRecorder, settle, type Deferred } from "../../test/launcher";
import TasksPage from "./index";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));

const renders = vi.hoisted(() => ({ rows: new Map<string, number>(), LanesCard: 0, ThroughputCard: 0, PageHeader: 0, SegmentedControl: 0 }));

// 计数外壳直接调用原组件函数：组件自己的订阅与父级带来的重渲染都记在外壳上
vi.mock("./TaskRow", async (orig) => {
  const mod = await orig<typeof import("./TaskRow")>();
  return {
    ...mod,
    TaskRow: (props: Parameters<typeof mod.TaskRow>[0]) => {
      const seen = renders.rows.get(props.task.id);
      renders.rows.set(props.task.id, seen === undefined ? 1 : seen + 1);
      return mod.TaskRow(props);
    },
  };
});
vi.mock("./LanesCard", async (orig) => {
  const mod = await orig<typeof import("./LanesCard")>();
  return {
    ...mod,
    LanesCard: (props: Parameters<typeof mod.LanesCard>[0]) => {
      renders.LanesCard += 1;
      return mod.LanesCard(props);
    },
  };
});
vi.mock("./ThroughputCard", async (orig) => {
  const mod = await orig<typeof import("./ThroughputCard")>();
  return {
    ...mod,
    ThroughputCard: (props: Parameters<typeof mod.ThroughputCard>[0]) => {
      renders.ThroughputCard += 1;
      return mod.ThroughputCard(props);
    },
  };
});
vi.mock("../../ui/PageHeader", async (orig) => {
  const mod = await orig<typeof import("../../ui/PageHeader")>();
  return {
    ...mod,
    PageHeader: (props: Parameters<typeof mod.PageHeader>[0]) => {
      renders.PageHeader += 1;
      return mod.PageHeader(props);
    },
  };
});
vi.mock("../../ui/SegmentedControl", async (orig) => {
  const mod = await orig<typeof import("../../ui/SegmentedControl")>();
  return {
    ...mod,
    SegmentedControl: (props: Parameters<typeof mod.SegmentedControl>[0]) => {
      renders.SegmentedControl += 1;
      return mod.SegmentedControl(props);
    },
  };
});

const T0 = 1_730_000_000_000;
const MB = 1024 * 1024;

let view: Rendered | undefined;
let launcher: LauncherApi;
/** 页面子树（含经传送门挂出去的部分）的提交次数。 */
let commits = 0;
/** 每一次 Java 安装尝试的命令，按 taskId 记下，用例里决定它怎样结束。 */
let javaRuns: Map<string, Deferred<unknown>>;

function Probe() {
  launcher = useLauncher();
  return null;
}

const flush = () =>
  act(async () => {
    await settle();
  });

function record(id: string, status: TaskRecordDto["status"], overrides: Partial<TaskRecordDto> = {}): TaskRecordDto {
  return {
    id,
    kind: "java",
    title: `下载 Java ${id}`,
    detail: "Mojang 运行时 · 手动",
    instance_id: null,
    status,
    progress: 1,
    bytes: 2 * MB,
    total_bytes: 2 * MB,
    done_bytes: 2 * MB,
    speed_bps: 0,
    attempt: 1,
    error: null,
    created_at: T0 - 300_000,
    started_at: T0 - 290_000,
    finished_at: T0 - 240_000,
    spec: { command: "install_java", args: { requiredMajor: 11 } },
    ...overrides,
  };
}

const HISTORY: TaskRecordDto[] = [
  record("done-java", "done"),
  record("failed-java", "failed", { progress: 0.2, error: { code: "network_failed", message: "dns lookup failed" }, spec: { command: "install_java", args: { requiredMajor: 16 } } }),
  record("cancelled-java", "cancelled", { progress: 0.374, spec: { command: "install_java", args: { requiredMajor: 18 } } }),
];

/** 在场的节点：换组的行、清空的组还在原处淡出，自己或某个祖先标了 inert，不算。 */
const live = (el: Element) => el.closest("[inert]") === null;

function rowOf(title: string): HTMLLIElement {
  if (view === undefined) throw new Error("页面还没有挂载");
  const found = [...view.container.querySelectorAll<HTMLLIElement>("ul > li")].filter(live).filter((li) => li.textContent?.includes(title));
  if (found.length !== 1) throw new Error(`标题含「${title}」的任务行有 ${found.length} 个`);
  return found[0];
}

function rowText(title: string): string {
  return rowOf(title).textContent ?? "";
}

/** 区域里第一条在场进度条报给读屏的百分数（百分数文字随平滑逐帧走，这里读目标值）。 */
function progressOf(root: Element): string | null {
  const bar = [...root.querySelectorAll('[role="progressbar"]')].find(live);
  if (bar === undefined) throw new Error("这里没有进度条");
  return bar.getAttribute("aria-valuenow");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetRecorder(ipc);
  stubResizeObserver();
  renders.rows.clear();
  renders.LanesCard = 0;
  renders.ThroughputCard = 0;
  renders.PageHeader = 0;
  renders.SegmentedControl = 0;
  commits = 0;
  bootOverrides(ipc, { journal: HISTORY });
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  javaRuns = new Map();
  ipc.overrides.set("install_java", (args) => {
    const run = deferred<unknown>();
    javaRuns.set(String(args.taskId), run);
    return run.promise;
  });
  ipc.overrides.set("cancel_task", () => true);
  ipc.overrides.set("launch_game", () => ({ pid: 4242 }));
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
});

async function mountBusy() {
  view = render(
    <LauncherProvider>
      <ShellProvider>
        <Probe />
        <Profiler id="tasks" onRender={() => void (commits += 1)}>
          <TasksPage route={{ page: "tasks" }} />
        </Profiler>
        <OverlayRoot />
      </ShellProvider>
    </LauncherProvider>,
  );
  await flush();
  for (const major of [8, 17, 21, 25]) await act(() => launcher.actions.installJava(major));
  await act(async () => {
    await launcher.actions.launch("创造");
    await settle();
  });
  await flush();
  const running = launcher.state.tasks.filter((t) => t.status === "running");
  const queued = launcher.state.tasks.filter((t) => t.status === "queued");
  expect(running).toHaveLength(3);
  expect(queued).toHaveLength(1);
  expect(launcher.state.session).toMatchObject({ instanceId: "创造", phase: "running" });
  return { running, queued };
}

describe("下载任务页按片订阅", () => {
  it("给一个运行中的任务推 20 次进度：只有它那一行、并行通道卡与吞吐卡各重渲染 20 次，页头、筛选和其余任务行一次都不重渲染", async () => {
    const { running, queued } = await mountBusy();
    const [hot, ...cold] = running;
    const rowsBefore = new Map(renders.rows);
    // 计数外壳确实接在页面上：每一行都画过
    for (const id of [...running, ...queued].map((t) => t.id).concat(HISTORY.map((r) => r.id))) expect(rowsBefore.get(id)).toBeGreaterThan(0);
    const before = { LanesCard: renders.LanesCard, ThroughputCard: renders.ThroughputCard, PageHeader: renders.PageHeader, SegmentedControl: renders.SegmentedControl };

    for (let i = 1; i <= 20; i++) {
      act(() => {
        emit(CORE_EVENT, { kind: "download", task_id: `${hot.id}#1`, total: 100, finished: i, bytes: i * 5 * MB, total_bytes: 100 * MB, speed: 2 * MB });
      });
    }

    expect(launcher.state.tasks.find((t) => t.id === hot.id)?.progress).toBe(1);
    // 进度相关的部件如实跟上：行内与通道里的进度都到 100%
    expect(progressOf(rowOf(hot.title))).toBe("100");
    const lane = [...(view?.container.querySelectorAll("ol > li") ?? [])].find((li) => li.textContent?.includes(hot.title));
    if (lane === undefined) throw new Error("通道里没有这个任务");
    expect(progressOf(lane)).toBe("100");
    expect(renders.rows.get(hot.id)).toBe((rowsBefore.get(hot.id) as number) + 20);
    for (const id of [...cold, ...queued].map((t) => t.id).concat(HISTORY.map((r) => r.id))) expect(renders.rows.get(id)).toBe(rowsBefore.get(id));
    expect({ LanesCard: renders.LanesCard, ThroughputCard: renders.ThroughputCard, PageHeader: renders.PageHeader, SegmentedControl: renders.SegmentedControl }).toEqual({
      LanesCard: before.LanesCard + 20,
      ThroughputCard: before.ThroughputCard + 20,
      PageHeader: before.PageHeader,
      SegmentedControl: before.SegmentedControl,
    });
  });

  it("游戏运行中推 20 批日志：页面子树一次都不提交", async () => {
    await mountBusy();
    commits = 0;
    for (let i = 1; i <= 20; i++) {
      act(() => {
        emit(GAME_LOG_EVENT, { version_id: "创造", lines: [{ level: "info", source: "game", text: `第 ${i} 行` }] });
      });
    }
    expect(launcher.state.session?.logs).toHaveLength(20);
    expect(commits).toBe(0);
  });

  it("每秒换一次吞吐采样：只有运行中的行与吞吐卡跟着重渲染，排队与已结束的行不动", async () => {
    const { running, queued } = await mountBusy();
    const rowsBefore = new Map(renders.rows);
    const cardBefore = renders.ThroughputCard;
    for (let i = 0; i < 3; i++) act(() => void vi.advanceTimersByTime(1000));
    for (const t of running) expect(renders.rows.get(t.id)).toBe((rowsBefore.get(t.id) as number) + 3);
    for (const id of queued.map((t) => t.id).concat(HISTORY.map((r) => r.id))) expect(renders.rows.get(id)).toBe(rowsBefore.get(id));
    expect(renders.ThroughputCard).toBe(cardBefore + 3);
  });

  it("排队的任务轮到运行：那一行原地换成运行中，键盘焦点留在它的取消键上", async () => {
    const { running, queued } = await mountBusy();
    const [first] = running;
    const [next] = queued;
    const row = rowOf(next.title);
    const cancel = row.querySelector<HTMLButtonElement>('button[aria-label="取消任务"]');
    if (cancel === null) throw new Error("排队中的任务行没有取消键");
    cancel.focus();
    expect(document.activeElement).toBe(cancel);

    await act(async () => {
      const run = javaRuns.get(`${first.id}#1`);
      if (run === undefined) throw new Error("运行中的任务没有对应的安装命令");
      run.resolve({ component: "java-runtime-gamma", version: { major: 8, minor: 0, security: 0, build: 1, raw: "8.0.0+1" }, java_executable: "C:/Petal/runtime/8/bin/java.exe" });
      await settle();
    });

    expect(launcher.state.tasks.find((t) => t.id === first.id)?.status).toBe("done");
    expect(launcher.state.tasks.find((t) => t.id === next.id)?.status).toBe("running");
    // 同一个节点原地更新：行没有被拆掉重建，焦点不会掉回页面开头
    expect(rowOf(next.title)).toBe(row);
    expect(row.isConnected).toBe(true);
    expect(document.activeElement).toBe(cancel);
  });

  it("运行中的任务被取消：页面按新的结构重排，那一行移到「已结束」并写出取消时的进度", async () => {
    const { running } = await mountBusy();
    const [hot] = running;
    act(() => {
      emit(CORE_EVENT, { kind: "download", task_id: `${hot.id}#1`, total: 10, finished: 3, bytes: 30 * MB, total_bytes: 100 * MB, speed: 2 * MB });
    });
    const header = () => {
      if (view === undefined) throw new Error("页面还没有挂载");
      return [...view.container.querySelectorAll("section h2")].filter(live).map((h) => h.textContent);
    };
    expect(header()).toEqual(["进行中 · 4", "已结束 · 3"]);
    const headerRenders = renders.PageHeader;
    await act(async () => {
      await launcher.actions.cancelTask(hot.id);
      const run = javaRuns.get(`${hot.id}#1`);
      if (run === undefined) throw new Error("运行中的任务没有对应的安装命令");
      run.reject(cancelledError());
      await settle();
    });
    expect(launcher.state.tasks.find((t) => t.id === hot.id)?.status).toBe("cancelled");
    expect(header()).toEqual(["进行中 · 3", "已结束 · 4"]);
    expect(rowText(hot.title)).toContain("取消于 30%");
    expect(renders.PageHeader).toBeGreaterThan(headerRenders);
  });
});
