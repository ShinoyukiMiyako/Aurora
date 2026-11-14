// @vitest-environment jsdom
// @module-tag heavy-page
// 页面按片订阅：下载进度每个任务约 100 ms 一次、游戏日志每 100 ms 一批。页面整份订阅状态时，发现页的几百张结果卡、
// 主页的整块 bento、实例库的每张卡都随它们重渲染。这里在一个补全任务下载、另一个实例运行的场景下发 20 次进度与 20 批日志，
// 数页面子树的提交次数（React Profiler），以及各卡片组件的渲染次数（计数外壳直接调用原组件函数）。
import { act, Profiler, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../art/illustrations/test-canvas";
import { GAME_LOG_EVENT } from "../ipc/launch";
import { resetMocks } from "../ipc/mock";
import { CORE_EVENT } from "../ipc/tasks";
import { OverlayRoot } from "../shell/overlay";
import { ShellProvider } from "../shell/shell";
import { AppearanceProvider, DEFAULT_APPEARANCE } from "../state/appearance";
import { LauncherProvider, useLauncher, type LauncherApi } from "../state/launcher";
import { DEFAULT_UI_SHAPE, UiShapeProvider } from "../state/ui-shape";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcArgs, IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, configDto, emit, instanceDto, resetRecorder, settle } from "../test/launcher";
import { RemoteImageProvider } from "../ui/remote-image";
import type { ProjectDetail } from "../state/queries/discover";
import { entry, match, modVersion, result } from "./discover/fixtures";
import DiscoverPage from "./discover/index";
import { PickFolderProvider } from "./discover/platform";
import { clearSnapshot } from "./discover/session";
import HomePage from "./home/index";
import LibraryPage from "./library/index";
import { resetLibraryView } from "./library/view-state";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

const renders = vi.hoisted(() => ({
  ResultCard: 0,
  InstanceCard: 0,
  GreetingCard: 0,
  ContinueCard: 0,
  RecentStrip: 0,
  CalendarCard: 0,
  InsightsCard: 0,
  NewsCard: 0,
  ServersCard: 0,
}));

// 结果卡包着 memo 时换掉 memo 里的组件函数、保留 memo 本身，数的是越过 memo 比较之后真正的渲染；
// 是普通函数组件时直接包一层计数。
vi.mock("./discover/ResultCard", async (orig) => {
  const mod = await orig<typeof import("./discover/ResultCard")>();
  const real: unknown = mod.ResultCard;
  const count = (render: (props: unknown) => ReactNode) => (props: unknown) => {
    renders.ResultCard += 1;
    return render(props);
  };
  if (typeof real === "function") return { ...mod, ResultCard: count(real as (props: unknown) => ReactNode) };
  const memoized = real as { type: (props: unknown) => ReactNode };
  return { ...mod, ResultCard: { ...memoized, type: count(memoized.type) } };
});
vi.mock("./library/InstanceCard", async (orig) => {
  const mod = await orig<typeof import("./library/InstanceCard")>();
  return {
    ...mod,
    InstanceCard: (props: Parameters<typeof mod.InstanceCard>[0]) => {
      renders.InstanceCard += 1;
      return mod.InstanceCard(props);
    },
  };
});
vi.mock("./home/GreetingCard", async (orig) => {
  const mod = await orig<typeof import("./home/GreetingCard")>();
  return {
    ...mod,
    GreetingCard: (props: Parameters<typeof mod.GreetingCard>[0]) => {
      renders.GreetingCard += 1;
      return mod.GreetingCard(props);
    },
  };
});
vi.mock("./home/ContinueCard", async (orig) => {
  const mod = await orig<typeof import("./home/ContinueCard")>();
  return {
    ...mod,
    ContinueCard: (props: Parameters<typeof mod.ContinueCard>[0]) => {
      renders.ContinueCard += 1;
      return mod.ContinueCard(props);
    },
  };
});
vi.mock("./home/RecentStrip", async (orig) => {
  const mod = await orig<typeof import("./home/RecentStrip")>();
  return {
    ...mod,
    RecentStrip: (props: Parameters<typeof mod.RecentStrip>[0]) => {
      renders.RecentStrip += 1;
      return mod.RecentStrip(props);
    },
  };
});
vi.mock("./home/PlayCards", async (orig) => {
  const mod = await orig<typeof import("./home/PlayCards")>();
  return {
    ...mod,
    CalendarCard: (props: Parameters<typeof mod.CalendarCard>[0]) => {
      renders.CalendarCard += 1;
      return mod.CalendarCard(props);
    },
    InsightsCard: (props: Parameters<typeof mod.InsightsCard>[0]) => {
      renders.InsightsCard += 1;
      return mod.InsightsCard(props);
    },
  };
});
vi.mock("./home/NewsCard", async (orig) => {
  const mod = await orig<typeof import("./home/NewsCard")>();
  return {
    ...mod,
    NewsCard: (props: Parameters<typeof mod.NewsCard>[0]) => {
      renders.NewsCard += 1;
      return mod.NewsCard(props);
    },
  };
});
vi.mock("./home/ServersCard", async (orig) => {
  const mod = await orig<typeof import("./home/ServersCard")>();
  return {
    ...mod,
    ServersCard: (props: Parameters<typeof mod.ServersCard>[0]) => {
      renders.ServersCard += 1;
      return mod.ServersCard(props);
    },
  };
});

const NOW = new Date(2026, 9, 30, 15, 0, 0).getTime();

let view: Rendered | undefined;
let launcher: LauncherApi;
/** 页面子树（含弹窗经传送门挂出去的部分）的提交次数。 */
let commits = 0;

function Probe() {
  launcher = useLauncher();
  return null;
}

const flush = () =>
  act(async () => {
    await settle();
  });

async function mount(page: ReactNode) {
  view = render(
    <AppearanceProvider initial={DEFAULT_APPEARANCE}>
      <UiShapeProvider initial={DEFAULT_UI_SHAPE}>
        <LauncherProvider>
          <ShellProvider>
            <RemoteImageProvider resolve={async (url) => url}>
              <PickFolderProvider value={async () => null}>
                <Probe />
                <div style={{ overflowY: "auto" }}>
                  <Profiler id="page" onRender={() => void (commits += 1)}>
                    {page}
                  </Profiler>
                </div>
              </PickFolderProvider>
            </RemoteImageProvider>
            <OverlayRoot />
          </ShellProvider>
        </LauncherProvider>
      </UiShapeProvider>
    </AppearanceProvider>,
  );
  await flush();
}

/** 生存在补全（下载任务一直在跑），创造在运行。 */
async function busy() {
  await act(async () => {
    await launcher.actions.repairInstance("生存");
    await launcher.actions.launch("创造");
    await settle();
  });
  const [task] = launcher.state.tasks;
  expect(task.status).toBe("running");
  expect(launcher.state.session).toMatchObject({ instanceId: "创造", phase: "running" });
  return task;
}

let progressed = 0;

function downloads(taskId: string) {
  for (let i = 0; i < 20; i++) {
    progressed += 1;
    act(() => {
      emit(CORE_EVENT, { kind: "download", task_id: `${taskId}#1`, total: 1000, finished: progressed, bytes: progressed * 1000, total_bytes: 1_000_000, speed: 1_000_000 });
    });
  }
}

function logs() {
  for (let i = 1; i <= 20; i++) {
    act(() => {
      emit(GAME_LOG_EVENT, { version_id: "创造", lines: [{ level: "info", source: "game", text: `第 ${i} 行` }] });
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  resetRecorder(ipc);
  clearSnapshot();
  resetLibraryView();
  stubMatchMedia(false);
  stubCanvas();
  stubResizeObserver();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  for (const key of Object.keys(renders) as (keyof typeof renders)[]) renders[key] = 0;
  commits = 0;
  progressed = 0;
  bootOverrides(ipc, {
    instances: [instanceDto("生存", { loaders: [{ kind: "fabric", version: "0.16.5" }] }), instanceDto("创造"), instanceDto("空岛"), instanceDto("红石")],
    config: configDto({ selected_version: "生存" }),
  });
  ipc.overrides.set("repair_instance", () => new Promise(() => undefined));
  ipc.overrides.set("launch_game", () => ({ pid: 4242 }));
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("skin_info", () => null);
  ipc.overrides.set("list_manifest", () => ({ latest: { release: "1.21.1", snapshot: "24w14a" }, versions: [], loader_errors: [], stale_since: null, fetch_error: null }));
  ipc.overrides.set("list_mods", () => []);
  ipc.overrides.set("play_stats", (args: IpcArgs) => {
    const range = args.range as { from: string; to: string };
    return { from: range.from, to: range.to, days: [], total_minutes: 0, instances: [] };
  });
  ipc.overrides.set("list_news", () => ({ items: [], fetched_at: NOW, offline: false, launcher_error: null }));
  ipc.overrides.set("list_pinned_servers", () => []);
  ipc.overrides.set("list_known_servers", () => []);
  ipc.overrides.set("ping_servers", () => []);
  ipc.overrides.set("list_instance_content", () => ({ resource_packs: [], shader_packs: [], worlds: [] }));
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("发现页", () => {
  // 结果里 Mod 与整合包都有：整合包卡片的「来自它的实例」要逐张对照实例列表
  const hits = Array.from({ length: 24 }, (_, i) =>
    i % 6 === 5 ? entry(`P${i}`, { resource_type: "modpack" }) : entry(`M${i}`),
  );

  beforeEach(() => {
    ipc.overrides.set("search_resources", () => result(hits, { total: 24 }));
  });

  it("结果出来后：20 次下载进度加 20 批游戏日志，页面子树一次都不提交，结果卡一张都不重渲染", async () => {
    await mount(<DiscoverPage route={{ page: "discover" }} />);
    const task = await busy();
    await flush();
    expect(document.querySelectorAll('[role="button"][aria-label$="，查看详情"]')).toHaveLength(24);
    commits = 0;
    const cards = renders.ResultCard;
    downloads(task.id);
    expect(launcher.state.tasks[0].bytes).toBe(20_000);
    logs();
    expect(launcher.state.session?.logs).toHaveLength(20);
    expect(commits).toBe(0);
    expect(renders.ResultCard).toBe(cards);
  });

  it("打开资源详情（简介与安装面板都在）：20 次下载进度加 20 批游戏日志，页面子树一次都不提交", async () => {
    const pack = hits[0];
    const v = modVersion("v1", { project_id: pack.project_id });
    ipc.overrides.set("project_detail", (): ProjectDetail => ({
      platform: pack.platform,
      project_id: pack.project_id,
      slug: pack.slug,
      title: pack.title,
      summary: pack.description,
      body: "## 简介\n\n一段介绍。",
      body_format: "markdown",
      author: pack.author,
      downloads: pack.downloads,
      follows: pack.follows,
      icon_url: null,
      gallery: [],
      hue: pack.hue,
      categories: [],
      resource_type: pack.resource_type,
      loaders: pack.loaders,
      game_versions: ["1.21.1"],
      date_published: null,
      date_modified: null,
      page_url: null,
      source_url: null,
      issues_url: null,
      wiki_url: null,
      latest_version: v,
      dependencies: [],
      distribution_allowed: true,
    }));
    ipc.overrides.set("list_mod_versions", () => ({ versions: [v], truncated: false }));
    ipc.overrides.set("match_instances", () => [match("生存", { best_version: v }), match("创造", { best_version: v }), match("空岛", { best_version: v }), match("红石", { best_version: v })]);
    await mount(<DiscoverPage route={{ page: "discover" }} />);
    const task = await busy();
    const card = document.querySelector<HTMLElement>(`[role="button"][aria-label="${pack.title}，查看详情"]`);
    if (card === null) throw new Error("找不到结果卡");
    act(() => card.click());
    await flush();
    const dialog = document.querySelector('[role="dialog"]');
    if (dialog === null) throw new Error("详情没有打开");
    expect(dialog.querySelectorAll('[role="checkbox"]').length).toBeGreaterThan(0);
    commits = 0;
    downloads(task.id);
    logs();
    expect(launcher.state.session?.logs).toHaveLength(20);
    expect(commits).toBe(0);
  });

  it("导入本地整合包到确认步、再打开需要手动下载的文件清单：20 次下载进度加 20 批游戏日志，页面子树一次都不提交", async () => {
    resetMocks();
    await mount(<DiscoverPage route={{ page: "discover" }} />);
    const task = await busy();
    const click = (text: string) =>
      act(() => {
        const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text);
        if (button === undefined) throw new Error(`找不到按钮 ${text}`);
        button.click();
      });
    click("导入整合包文件");
    await flush();
    const path = document.querySelector<HTMLInputElement>('input[aria-label="整合包文件的完整路径"]');
    if (path === null) throw new Error("没有路径输入框");
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (descriptor === undefined || descriptor.set === undefined) throw new Error("jsdom 的 input 没有 value 设置器");
    const set = descriptor.set;
    act(() => {
      set.call(path, "D:\\Downloads\\blocked-pack.zip");
      path.dispatchEvent(new Event("input", { bubbles: true }));
    });
    click("读取");
    await flush();
    expect(document.querySelectorAll('ul[aria-label="包内 Mod"] > li')).toHaveLength(41);
    click("查看这些文件");
    await flush();
    expect([...document.querySelectorAll('[role="dialog"] h2')].map((h) => h.textContent)).toEqual(["导入整合包文件", "需要手动下载的文件"]);
    commits = 0;
    downloads(task.id);
    expect(launcher.state.tasks[0].bytes).toBe(20_000);
    logs();
    expect(launcher.state.session?.logs).toHaveLength(20);
    expect(commits).toBe(0);
  });

  it("在搜索框里打字（防抖期间还没发起新的搜索）：页面重渲染，结果卡不跟着重渲染", async () => {
    await mount(<DiscoverPage route={{ page: "discover" }} />);
    expect(document.querySelectorAll('[role="button"][aria-label$="，查看详情"]')).toHaveLength(24);
    const cards = renders.ResultCard;
    const input = document.querySelector<HTMLInputElement>('input[aria-label="搜索资源"]');
    if (input === null) throw new Error("找不到搜索框");
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (descriptor === undefined || descriptor.set === undefined) throw new Error("jsdom 的 input 没有 value 设置器");
    const set = descriptor.set;
    commits = 0;
    for (const value of ["钠", "钠石", "钠石英"]) {
      act(() => {
        set.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    expect(commits).toBeGreaterThanOrEqual(3);
    expect(renders.ResultCard).toBe(cards);
  });
});

describe("主页", () => {
  it("游戏运行中：20 批日志，主页子树一次都不提交", async () => {
    await mount(<HomePage route={{ page: "home" }} />);
    await busy();
    await flush();
    commits = 0;
    const before = { ...renders };
    logs();
    expect(launcher.state.session?.logs).toHaveLength(20);
    expect(commits).toBe(0);
    expect(renders).toEqual(before);
  });

  it("20 次下载进度：只有显示下载进度的问候卡跟着重渲染，其余卡片一次都不重渲染", async () => {
    await mount(<HomePage route={{ page: "home" }} />);
    const task = await busy();
    await flush();
    const before = { ...renders };
    downloads(task.id);
    expect(launcher.state.tasks[0].bytes).toBe(20_000);
    expect(renders).toEqual({ ...before, GreetingCard: before.GreetingCard + 20 });
  });
});

describe("实例库", () => {
  it("20 次下载进度加 20 批游戏日志：实例卡一张都不重渲染；日志不让页面子树提交", async () => {
    await mount(<LibraryPage />);
    const task = await busy();
    await flush();
    expect(document.querySelectorAll("article")).toHaveLength(4);
    const cards = renders.InstanceCard;
    downloads(task.id);
    commits = 0;
    logs();
    expect(launcher.state.session?.logs).toHaveLength(20);
    expect(commits).toBe(0);
    expect(renders.InstanceCard).toBe(cards);
  });
});
