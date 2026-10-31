// @vitest-environment jsdom
// 实例详情按片订阅：游戏日志每 100 ms 一批。页面整份订阅状态时，头图、标签条与当前标签的每张卡都随它重渲染。
// 这里让本实例在运行中、发 20 批日志，数页面子树的提交次数（React Profiler）与各部件的渲染次数
// （计数外壳直接调用原组件函数；不单独导出的卡片与行按它每次渲染必定经过的钩子或部件计数）。
import { act, isValidElement, Profiler, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../art/illustrations/test-canvas";
import type { CrashReportDto } from "../../ipc/diagnostics";
import type { HistoryEvent } from "../../ipc/history";
import type { InstanceSettingsDto } from "../../ipc/instances";
import { SESSION_COPY } from "../../copy/flows";
import { formatBytes, formatSpeed, percent } from "../../domain/format";
import { GAME_LOG_EVENT, LAUNCH_PHASE_EVENT } from "../../ipc/launch";
import type { InstalledMod } from "../../ipc/mods";
import { CORE_EVENT } from "../../ipc/tasks";
import { OverlayRoot } from "../../shell/overlay";
import { ShellProvider, useNav, type NavApi } from "../../shell/shell";
import { LauncherProvider, useLauncher, type LauncherApi } from "../../state/launcher";
import { routeKey, type InstanceTab } from "../../state/route";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { bootOverrides, configDto, deferred, emit, instanceDto, resetRecorder, settle } from "../../test/launcher";
import { RemoteImageProvider } from "../../ui/remote-image";
import { HERO_COPY, OVERVIEW_COPY } from "./copy";
import InstancePage from "./index";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));

const renders = vi.hoisted(() => ({
  Hero: 0,
  Tabs: 0,
  OverviewTab: 0,
  ModsTab: 0,
  SettingsTab: 0,
  LogsTab: 0,
  CrashTab: 0,
  LogConsole: 0,
  /** 变更历史卡：每次渲染调用一次 useHistory。 */
  HistoryCard: 0,
  /** 时间线的每一行：时刻包在一个提示气泡里，整页只有这里的提示气泡包着 <time>。 */
  TimelineItem: 0,
}));
/** 控制台最近一次拿到的行数：确认日志确实画到了控制台上。 */
const consoleLines = vi.hoisted(() => ({ last: -1 }));

function counted<P>(key: keyof typeof renders, component: (props: P) => ReactNode) {
  return (props: P) => {
    renders[key] += 1;
    return component(props);
  };
}

vi.mock("./Hero", async (orig) => {
  const mod = await orig<typeof import("./Hero")>();
  return { ...mod, Hero: counted("Hero", mod.Hero) };
});
vi.mock("./OverviewTab", async (orig) => {
  const mod = await orig<typeof import("./OverviewTab")>();
  return { ...mod, OverviewTab: counted("OverviewTab", mod.OverviewTab) };
});
vi.mock("./ModsTab", async (orig) => {
  const mod = await orig<typeof import("./ModsTab")>();
  return { ...mod, ModsTab: counted("ModsTab", mod.ModsTab) };
});
vi.mock("./SettingsTab", async (orig) => {
  const mod = await orig<typeof import("./SettingsTab")>();
  return { ...mod, SettingsTab: counted("SettingsTab", mod.SettingsTab) };
});
vi.mock("./LogsTab", async (orig) => {
  const mod = await orig<typeof import("./LogsTab")>();
  return { ...mod, LogsTab: counted("LogsTab", mod.LogsTab) };
});
vi.mock("./CrashTab", async (orig) => {
  const mod = await orig<typeof import("./CrashTab")>();
  return { ...mod, CrashTab: counted("CrashTab", mod.CrashTab) };
});
vi.mock("../../ui/Tabs", async (orig) => {
  const mod = await orig<typeof import("../../ui/Tabs")>();
  return { ...mod, Tabs: counted("Tabs", mod.Tabs as (props: Parameters<typeof mod.Tabs>[0]) => ReactNode) };
});
vi.mock("../../ui/LogConsole", async (orig) => {
  const mod = await orig<typeof import("../../ui/LogConsole")>();
  return {
    ...mod,
    LogConsole: (props: Parameters<typeof mod.LogConsole>[0]) => {
      renders.LogConsole += 1;
      consoleLines.last = props.lines.length;
      return mod.LogConsole(props);
    },
  };
});
vi.mock("../../state/queries/instance", async (orig) => {
  const mod = await orig<typeof import("../../state/queries/instance")>();
  return {
    ...mod,
    useHistory: (id: string | null) => {
      renders.HistoryCard += 1;
      return mod.useHistory(id);
    },
  };
});
vi.mock("../../ui/Tooltip", async (orig) => {
  const mod = await orig<typeof import("../../ui/Tooltip")>();
  return {
    ...mod,
    Tooltip: (props: Parameters<typeof mod.Tooltip>[0]) => {
      if (isValidElement(props.children) && props.children.type === "time") renders.TimelineItem += 1;
      return mod.Tooltip(props);
    },
  };
});

const ID = "樱花生存";
const OTHER = "创造";
const NOW = new Date(2026, 9, 31, 12, 0, 0).getTime();

let view: Rendered | undefined;
let launcher: LauncherApi;
let nav: NavApi;
let commits = 0;

function Probe() {
  launcher = useLauncher();
  nav = useNav();
  return null;
}

/** 与外壳的装法一致：页面按路由键挂载，路由来自外壳的导航（实例列表读到之后才进实例页）。 */
function Routed() {
  const { route } = useNav();
  return route.page === "instance" ? <InstancePage key={routeKey(route)} route={route} /> : null;
}

const flush = () =>
  act(async () => {
    await settle(20);
  });

async function open(tab: InstanceTab, id = ID) {
  view = render(
    <LauncherProvider>
      <ShellProvider>
        <RemoteImageProvider resolve={(url) => Promise.resolve(url)}>
          <Probe />
          <Profiler id="page" onRender={() => void (commits += 1)}>
            <Routed />
          </Profiler>
          <OverlayRoot />
        </RemoteImageProvider>
      </ShellProvider>
    </LauncherProvider>,
  );
  await flush();
  act(() => nav.go({ page: "instance", id, tab }));
  await flush();
}

async function launch(id: string) {
  await act(async () => {
    await launcher.actions.launch(id);
    await settle(20);
  });
  expect(launcher.state.session).toMatchObject({ instanceId: id, phase: "running" });
}

/** 20 批日志，每批一行；之后会话里正好 20 行。 */
function logs(id: string) {
  for (let i = 1; i <= 20; i++) {
    act(() => {
      emit(GAME_LOG_EVENT, { version_id: id, lines: [{ level: i % 5 === 0 ? "warn" : "info", source: "game", text: `第 ${i} 行` }] });
    });
  }
  expect(launcher.state.session?.logs).toHaveLength(20);
}

function mod(fileName: string, name: string): InstalledMod {
  return {
    path: `D:/Games/.minecraft/versions/${ID}/mods/${fileName}`,
    file_name: fileName,
    enabled: true,
    size: 1024,
    modified_ms: 1,
    metadata: { mod_id: name.toLowerCase(), name, version: "1.0.0", description: null, authors: [], depends: [], minecraft_version: null, icon: null, loader: "fabric", format: "fabric" },
    icon_url: null,
    source: null,
  };
}

const settings: InstanceSettingsDto = {
  description: null,
  cover: null,
  isolation: "follow_global",
  memory_mb: null,
  java: "auto",
  jvm_args: "",
  resolution: { width: 854, height: 480 },
  fullscreen: false,
};

const crash: CrashReportDto = {
  at: NOW - 3_600_000,
  exit_code: -1,
  session_started_at: NOW - 4_000_000,
  log_path: `D:/Games/.minecraft/versions/${ID}/logs/latest.log`,
  diagnoses: [{ category: "out_of_memory", summary: "", advice: "", detail: null, matched: "java.lang.OutOfMemoryError: Java heap space", line: 18, context: ["a", "b"] }],
  suspects: [{ mod_id: "sodium", file_name: "sodium.jar" }],
  java: { major: 21, path: "C:/Java/jdk-21/bin/java.exe", is_64bit: true },
  max_memory_mb: 4096,
  warnings: [],
};

const history: HistoryEvent[] = [
  { kind: "install", id: "100-000", at: Math.floor(NOW / 1000) - 3600, files: ["sodium-0.5.jar"] },
  {
    kind: "update",
    id: "200-000",
    at: Math.floor(NOW / 1000) - 60,
    file_name: "sodium.jar",
    old_file: "sodium-0.5.jar",
    from_version: "v05",
    to_version: "v06",
    title: "Sodium",
    from_version_number: "0.5.0",
    to_version_number: "0.6.0",
  },
];

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  resetRecorder(ipc);
  stubMatchMedia(false);
  stubResizeObserver();
  stubCanvas();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  for (const key of Object.keys(renders) as (keyof typeof renders)[]) renders[key] = 0;
  consoleLines.last = -1;
  commits = 0;
  bootOverrides(ipc, {
    instances: [instanceDto(ID, { loaders: [{ kind: "fabric", version: "0.16.10" }], mod_count: 2, last_crash_at: NOW - 3_600_000, last_played_at: NOW - 7_200_000 }), instanceDto(OTHER)],
    config: configDto({ memory: { max_mb: 4096, min_mb: null, auto: false } }),
  });
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("launch_game", () => ({ pid: 4242 }));
  ipc.overrides.set("get_instance_settings", () => settings);
  ipc.overrides.set("list_mods", () => [mod("sodium.jar", "Sodium"), mod("lithium.jar", "Lithium")]);
  ipc.overrides.set("check_updates", () => []);
  ipc.overrides.set("list_instance_content", () => ({
    resource_packs: [],
    shader_packs: [],
    worlds: [{ dir_name: "w1", level_status: "ok", level_error: null, name: "新世界", mode: "survival", last_played: NOW - 60_000, size_bytes: 1024, modified_at: null }],
  }));
  ipc.overrides.set("detect_java", () => [{ path: "C:/Java/jdk-21/bin/java.exe", version: { major: 21, minor: 0, security: 5, build: 0, raw: "21.0.5" }, is_64bit: true, vendor: "Microsoft", source: "registry" }]);
  ipc.overrides.set("memory_advice", () => ({ total_mb: 32768, available_mb: 16000, tier: "modded", recommended_mb: 6144 }));
  ipc.overrides.set("last_crash", () => crash);
  ipc.overrides.set("last_launch_log", () => null);
  ipc.overrides.set("list_history", () => history);
  ipc.overrides.set("rollback_checks", () => history.map((e) => ({ event_id: e.id, can_rollback: e.kind === "update", reason: e.kind === "update" ? null : "安装事件不支持回滚" })));
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("实例详情：本实例运行中，20 批游戏日志", () => {
  it.each<[InstanceTab, keyof typeof renders]>([
    ["overview", "OverviewTab"],
    ["mods", "ModsTab"],
    ["settings", "SettingsTab"],
    ["crash", "CrashTab"],
  ])("%s 标签：页面子树一次都不提交，头图、标签条与标签内容都不重渲染", async (tab, panel) => {
    await open(tab);
    await launch(ID);
    await flush();
    expect(renders[panel]).toBeGreaterThan(0);
    commits = 0;
    const before = { ...renders };
    logs(ID);
    expect(commits).toBe(0);
    expect(renders).toEqual(before);
  });

  it("日志标签：只有日志控制台随每批日志重渲染，头图、标签条、变更历史与时间线都不动", async () => {
    await open("logs");
    await launch(ID);
    await flush();
    expect([...document.querySelectorAll("ol > li")].map((li) => li.textContent)).toHaveLength(2);
    expect(renders.LogConsole).toBeGreaterThan(0);
    expect(renders.TimelineItem).toBeGreaterThan(0);
    const before = { ...renders };
    logs(ID);
    expect(consoleLines.last).toBe(20);
    expect(renders.LogConsole - before.LogConsole).toBeGreaterThanOrEqual(20);
    expect({ ...renders, LogConsole: before.LogConsole }).toEqual(before);
  });

  it("另一个实例在运行：它的日志连本实例的日志控制台都不让重渲染", async () => {
    await open("logs", OTHER);
    await launch(ID);
    await flush();
    commits = 0;
    const before = { ...renders };
    logs(ID);
    expect(commits).toBe(0);
    expect(renders).toEqual(before);
  });
});

// 进度事件同样每个任务约 100 ms 一次：页面只在启动视图的种类或画出来的判定变了时重渲染，
// 百分比由胶囊、头图的安装标签与概览的安装横幅各自订阅
describe("实例详情：本实例的进度在走", () => {
  it.each<[InstanceTab, keyof typeof renders]>([
    ["overview", "OverviewTab"],
    ["mods", "ModsTab"],
  ])("%s 标签：补全中 20 次下载进度，头图、标签条与标签内容不重渲染，头图标签与横幅的百分比照常走", async (tab, panel) => {
    // 没崩溃过：概览顶部才是安装横幅（崩溃横幅优先）。补全命令一直不返回：任务停在进行中，进度全靠事件推
    bootOverrides(ipc, {
      instances: [instanceDto(ID, { loaders: [{ kind: "fabric", version: "0.16.10" }], mod_count: 2, last_played_at: NOW - 7_200_000 }), instanceDto(OTHER)],
      config: configDto({ memory: { max_mb: 4096, min_mb: null, auto: false } }),
    });
    ipc.overrides.set("last_crash", () => null);
    ipc.overrides.set("repair_instance", () => new Promise(() => undefined));
    await open(tab);
    await act(async () => {
      await launcher.actions.repairInstance(ID);
      await settle(20);
    });
    await flush();
    const task = launcher.state.tasks.find((t) => t.instanceId === ID);
    if (task === undefined || task.status !== "running") throw new Error("补全任务应在进行中");
    expect(document.body.textContent).toContain(HERO_COPY.installing("0%"));
    expect(renders[panel]).toBeGreaterThan(0);
    const before = { ...renders };
    for (let i = 1; i <= 20; i++) {
      act(() => {
        emit(CORE_EVENT, { kind: "download", task_id: `${task.id}#1`, total: 40, finished: i, bytes: i * 1000, total_bytes: 40_000, speed: 1_000_000 });
      });
    }
    const progress = launcher.state.tasks.find((t) => t.id === task.id)?.progress;
    if (progress === undefined) throw new Error("补全任务不见了");
    expect(percent(progress)).toBe("50%");
    expect(document.body.textContent).toContain(HERO_COPY.installing("50%"));
    if (tab === "overview") {
      const banner = OVERVIEW_COPY.installProgress("50%", formatSpeed(1_000_000), formatBytes(40_000));
      expect(document.body.textContent).toContain(banner);
    }
    expect(renders).toEqual(before);
  });

  it("启动停在下载阶段，20 次进度：头图、标签条与概览不重渲染，胶囊上的文件计数照常走", async () => {
    const spawn = deferred<{ pid: number }>();
    ipc.overrides.set("launch_game", () => spawn.promise);
    await open("overview");
    act(() => void launcher.actions.launch(ID));
    await flush();
    const session = launcher.state.session;
    if (session === null) throw new Error("启动后应有会话");
    const step = (finished: number) =>
      act(() => {
        emit(LAUNCH_PHASE_EVENT, { task_id: session.taskId, phase: "downloading", stage_index: 3, download: { finished, total: 100, bytes: 0, total_bytes: null, speed: 2048 } });
      });
    step(0);
    await flush();
    expect(launcher.state.session?.phase).toBe("downloading");
    const before = { ...renders };
    for (let i = 1; i <= 20; i++) step(i);
    expect(launcher.state.session?.download?.done).toBe(20);
    expect(document.body.textContent).toContain(SESSION_COPY.downloadProgress(20, 100, 2048));
    expect(renders).toEqual(before);
  });

  it("日志标签：启动停在下载阶段，20 次进度不带新日志，日志控制台也不重渲染", async () => {
    const spawn = deferred<{ pid: number }>();
    ipc.overrides.set("launch_game", () => spawn.promise);
    await open("logs");
    act(() => void launcher.actions.launch(ID));
    await flush();
    const session = launcher.state.session;
    if (session === null) throw new Error("启动后应有会话");
    const step = (finished: number) =>
      act(() => {
        emit(LAUNCH_PHASE_EVENT, { task_id: session.taskId, phase: "downloading", stage_index: 3, download: { finished, total: 100, bytes: 0, total_bytes: null, speed: 2048 } });
      });
    step(0);
    await flush();
    expect(launcher.state.session?.phase).toBe("downloading");
    expect(renders.LogConsole).toBeGreaterThan(0);
    const logsBefore = launcher.state.session?.logs;
    const before = { ...renders };
    for (let i = 1; i <= 20; i++) step(i);
    expect(launcher.state.session?.download?.done).toBe(20);
    expect(launcher.state.session?.logs).toBe(logsBefore);
    expect(renders).toEqual(before);
  });
});
