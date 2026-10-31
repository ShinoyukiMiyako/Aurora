// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../art/illustrations/test-canvas";
import type { InstalledMod } from "../../ipc/mods";
import { OverlayRoot } from "../../shell/overlay";
import { pickFile } from "../../shell/platform";
import { ShellProvider, useNav, type NavApi } from "../../shell/shell";
import { WindowPortProvider, browserWindowPort, type WindowDropEvent, type WindowPort } from "../../shell/window";
import { LauncherProvider, useLauncher, type LauncherApi } from "../../state/launcher";
import type { ProjectDetail, SearchArgs, SearchEntry, SearchResultDto } from "../../state/queries/discover";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../test/dom";
import type { IpcArgs, IpcRecorder } from "../../test/fake-bridge";
import { bootOverrides, callsOf, configDto, deferred, instanceDto, resetRecorder, settle, type Deferred } from "../../test/launcher";
import { entry, match, modVersion, result } from "./fixtures";
import DiscoverPage from "./index";
import { clearSnapshot } from "./session";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));
// 系统选择文件对话框只在 Tauri 里有：默认照真实实现在测试里拒绝，个别用例改成返回选中的文件
vi.mock("../../shell/platform", async (orig) => {
  const actual = await orig<typeof import("../../shell/platform")>();
  return { ...actual, pickFile: vi.fn(actual.pickFile) };
});

let view: Rendered | undefined;
let nav: NavApi;
let launcher: LauncherApi;
let observers: { callback: IntersectionObserverCallback; options: IntersectionObserverInit | undefined; targets: Element[] }[];
let online: boolean;
let dropHandlers: ((event: WindowDropEvent) => void)[];
let port: WindowPort;

function Probe() {
  nav = useNav();
  launcher = useLauncher();
  return null;
}

/** 外壳的页面区：一个纵向滚动容器里按路由渲染发现页。 */
function PageArea() {
  const { route } = useNav();
  return <div style={{ overflowY: "auto" }}>{route.page === "discover" && <DiscoverPage route={route} />}</div>;
}

const flush = () =>
  act(async () => {
    await settle();
  });

async function mount(route: Parameters<NavApi["go"]>[0] = { page: "discover" }) {
  view = render(
    <WindowPortProvider port={port}>
      <LauncherProvider>
        <ShellProvider>
          <Probe />
          <PageArea />
          <OverlayRoot />
        </ShellProvider>
      </LauncherProvider>
    </WindowPortProvider>,
  );
  await flush();
  act(() => nav.go(route));
  await flush();
}

function searchCalls(): SearchArgs[] {
  return callsOf(ipc, "search_resources").map((a) => a as unknown as SearchArgs);
}

function lastSearch(): SearchArgs {
  const calls = searchCalls();
  const last = calls[calls.length - 1];
  if (last === undefined) throw new Error("还没有发起搜索");
  return last;
}

function searchInput(): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>('input[aria-label="搜索资源"]');
  if (el === null) throw new Error("找不到搜索框");
  return el;
}

function typeInto(input: HTMLInputElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  if (descriptor === undefined || descriptor.set === undefined) throw new Error("jsdom 的 input 没有 value 设置器");
  const set = descriptor.set;
  act(() => {
    set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function buttonByText(text: string, root: ParentNode = document): HTMLButtonElement {
  const el = [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text);
  if (el === undefined) throw new Error(`找不到按钮 ${text}`);
  return el;
}

function card(title: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[role="button"][aria-label="${title}，查看详情"]`);
  if (el === null) throw new Error(`找不到结果卡 ${title}`);
  return el;
}

const cardTitles = () => [...document.querySelectorAll('[role="button"][aria-label$="，查看详情"]')].map((el) => el.getAttribute("aria-label"));

/** 打开着的弹窗：关闭后在退场动画期间仍挂着，带 data-exiting 的不算。 */
function openDialogs(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].filter((el) => el.closest("[data-exiting]") === null);
}

function dialog(): HTMLElement {
  const [el] = openDialogs();
  if (el === undefined) throw new Error("弹窗没有打开");
  return el;
}

function detailOf(e: SearchEntry, overrides: Partial<ProjectDetail> = {}): ProjectDetail {
  return {
    platform: e.platform,
    project_id: e.project_id,
    slug: e.slug,
    title: e.title,
    summary: e.description,
    body: "## 简介\n\n一段介绍。",
    body_format: "markdown",
    author: e.author,
    downloads: e.downloads,
    follows: e.follows,
    icon_url: null,
    gallery: [],
    hue: e.hue,
    categories: [],
    resource_type: e.resource_type,
    loaders: e.loaders,
    game_versions: ["1.21.1"],
    date_published: null,
    date_modified: null,
    page_url: null,
    source_url: null,
    issues_url: null,
    wiki_url: null,
    latest_version: null,
    dependencies: [],
    distribution_allowed: true,
    ...overrides,
  };
}

function installedMod(projectId: string): InstalledMod {
  return {
    path: `mods/${projectId}.jar`,
    file_name: `${projectId}.jar`,
    enabled: true,
    size: 1,
    modified_ms: 0,
    metadata: null,
    icon_url: null,
    source: { platform: "modrinth", project_id: projectId, version_id: "x", version_number: null, title: null, dependency_of: null },
  };
}

const CURSOR = {
  modrinth: { offset: 24, exhausted: false, total: 30, absorbed: [] },
  curseforge: { offset: 0, exhausted: true, total: 0, absorbed: [] },
};

let pages: (args: IpcArgs) => SearchResultDto;

beforeEach(() => {
  vi.useFakeTimers();
  resetRecorder(ipc);
  clearSnapshot();
  stubMatchMedia(false);
  stubCanvas();
  stubResizeObserver();
  observers = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      private entry: (typeof observers)[number];
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        this.entry = { callback, options, targets: [] };
        observers.push(this.entry);
      }
      observe(el: Element) {
        this.entry.targets.push(el);
      }
      disconnect() {
        this.entry.targets = [];
      }
    },
  );
  online = true;
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
  dropHandlers = [];
  port = {
    ...browserWindowPort(),
    onDrop: async (handler) => {
      dropHandlers.push(handler);
      return () => {
        dropHandlers = dropHandlers.filter((h) => h !== handler);
      };
    },
  };
  bootOverrides(ipc, { instances: [instanceDto("生存", { loaders: [{ kind: "fabric", version: "0.16.5" }] }), instanceDto("创造")], config: configDto({ selected_version: "生存" }) });
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("list_manifest", () => ({ latest: { release: "1.21.1", snapshot: "24w14a" }, versions: [], loader_errors: [], stale_since: null, fetch_error: null }));
  ipc.overrides.set("list_mods", (args) => (args.versionId === "生存" ? [installedMod("A")] : []));
  pages = (args) =>
    args.cursor === null
      ? result([entry("A"), entry("B")], { total: 57, next_cursor: CURSOR })
      : result([entry("B"), entry("C")], { total: 57, next_cursor: null });
  ipc.overrides.set("search_resources", (args) => pages(args));
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("发现页：搜索", () => {
  it("进页带关键词与类型：首页按这组条件搜一次，结果卡与总数照后端返回", async () => {
    await mount({ page: "discover", query: "sod", kind: "mod" });
    expect(searchCalls()).toHaveLength(1);
    expect(lastSearch()).toEqual({
      query: "sod",
      resourceTypes: ["mod"],
      category: null,
      platform: null,
      loaders: [],
      gameVersions: [],
      sort: "relevance",
      limit: 24,
      cursor: null,
    });
    expect(cardTitles()).toEqual(["资源 A，查看详情", "资源 B，查看详情"]);
    expect(document.body.textContent).toContain("约 57 个结果");
    expect(searchInput().value).toBe("sod");
  });

  it("输入停 300 ms 才搜；生效的关键词写回路由", async () => {
    await mount();
    expect(lastSearch().query).toBeNull();
    typeInto(searchInput(), "钠");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(299);
    });
    expect(searchCalls().map((a) => a.query)).toEqual([null]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await flush();
    expect(searchCalls().map((a) => a.query)).toEqual([null, "钠"]);
    expect(nav.route).toEqual({ page: "discover", query: "钠" });
  });

  it("热门分类再点一次取消（回到已搜过的条件直接用缓存）；换成没有该分类的类型时分类清掉", async () => {
    await mount();
    act(() => buttonByText("优化").click());
    await flush();
    expect(lastSearch().category).toBe("optimization");
    expect(buttonByText("优化").getAttribute("aria-pressed")).toBe("true");
    act(() => buttonByText("优化").click());
    await flush();
    expect(buttonByText("优化").getAttribute("aria-pressed")).toBe("false");
    expect(searchCalls().map((a) => a.category)).toEqual([null, "optimization"]);
    expect(cardTitles()).toEqual(["资源 A，查看详情", "资源 B，查看详情"]);
    act(() => buttonByText("优化").click());
    await flush();
    const shaderTab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === "光影");
    if (shaderTab === undefined) throw new Error("找不到光影标签");
    act(() => shaderTab.click());
    await flush();
    expect([lastSearch().resourceTypes, lastSearch().category]).toEqual([["shader"], null]);
    expect(nav.route).toEqual({ page: "discover", kind: "shader" });
  });

  it("「已装入」按各实例已装 Mod 的平台来源计数", async () => {
    await mount();
    expect(callsOf(ipc, "list_mods").map((a) => a.versionId).sort()).toEqual(["创造", "生存"]);
    expect(card("资源 A").textContent).toContain("已装入 1 个实例");
    expect(card("资源 B").textContent).not.toContain("已装入");
  });

  it("「已装入」逐个读各实例的 Mod 列表：同时在读的不超过 2 个，前面的读完后面的才接上", async () => {
    const ids = ["甲", "乙", "丙", "丁", "戊"];
    bootOverrides(ipc, { instances: ids.map((id) => instanceDto(id, { loaders: [{ kind: "fabric", version: "0.16.5" }] })), config: configDto({ selected_version: "甲" }) });
    const waiting = new Map<string, Deferred<InstalledMod[]>>();
    let inFlight = 0;
    let peak = 0;
    ipc.overrides.set("list_mods", (args) => {
      const d = deferred<InstalledMod[]>();
      waiting.set(String(args.versionId), d);
      inFlight++;
      peak = Math.max(peak, inFlight);
      return d.promise.finally(() => inFlight--);
    });
    await mount();
    expect(callsOf(ipc, "list_mods").map((a) => a.versionId)).toEqual(["甲", "乙"]);
    for (const id of ids) {
      const d = waiting.get(id);
      if (d === undefined) throw new Error(`「${id}」的 Mod 列表还没开始读`);
      await act(async () => {
        d.resolve(id === "丁" ? [installedMod("A")] : []);
        await settle();
      });
    }
    expect(callsOf(ipc, "list_mods").map((a) => a.versionId)).toEqual(ids);
    expect(peak).toBe(2);
    expect(card("资源 A").textContent).toContain("已装入 1 个实例");
  });

  it("结果里一个 Mod 都没有时不读任何实例的 Mod 列表", async () => {
    pages = () => result([entry("R", { title: "材质", resource_type: "resource_pack", loaders: [] }), entry("P", { title: "整合包", resource_type: "modpack" })]);
    await mount();
    expect(cardTitles()).toEqual(["材质，查看详情", "整合包，查看详情"]);
    expect(callsOf(ipc, "list_mods")).toEqual([]);
  });

  it("滚到底部附近按游标接下一页，同一工程只留先到的一张，到底后提示", async () => {
    await mount();
    const near = observers.find((o) => o.options !== undefined && o.options.rootMargin === "0px 0px 600px 0px" && o.targets.length > 0);
    if (near === undefined) throw new Error("没有观察列表尾");
    await act(async () => {
      near.callback([{ isIntersecting: true, target: near.targets[0] } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
      await settle();
    });
    expect(searchCalls()).toHaveLength(2);
    expect(lastSearch().cursor).toEqual(CURSOR);
    expect(cardTitles()).toEqual(["资源 A，查看详情", "资源 B，查看详情", "资源 C，查看详情"]);
    expect(document.body.textContent).toContain("已经到底了");
  });
});

/** 结果区里正在显示的骨架卡数。 */
const skeletonCards = () => document.querySelectorAll('section[aria-label="搜索资源"] [aria-busy="true"] > *').length;

describe("发现页：加载态的时机", () => {
  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });

  it("300 ms 内返回的搜索不出骨架；超过 300 ms 才出，出现后至少停留 300 ms", async () => {
    pages = () => new Promise<SearchResultDto>((resolve) => setTimeout(() => resolve(result([entry("A")])), 280)) as never;
    await mount();
    await advance(279);
    expect(skeletonCards()).toBe(0);
    await advance(1);
    await flush();
    expect(cardTitles()).toEqual(["资源 A，查看详情"]);
    expect(skeletonCards()).toBe(0);

    // 换个关键词：这次 320 ms 才返回，骨架在 300 ms 出现，数据到了也要停满 300 ms
    pages = () => new Promise<SearchResultDto>((resolve) => setTimeout(() => resolve(result([entry("B")])), 320)) as never;
    typeInto(searchInput(), "慢");
    act(() => searchInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await flush();
    await advance(299);
    expect(skeletonCards()).toBe(0);
    await advance(1);
    expect(skeletonCards()).toBe(24);
    await advance(20);
    await flush();
    expect(skeletonCards()).toBe(24);
    await advance(280);
    await flush();
    expect(skeletonCards()).toBe(0);
    expect(cardTitles()).toEqual(["资源 B，查看详情"]);
  });

  it("首页请求 10 s 还没回来才提示「比平时慢」，20 s 按超时呈现可重试", async () => {
    pages = () => new Promise<SearchResultDto>(() => {}) as never;
    await mount();
    await advance(9_999);
    expect(document.body.textContent).not.toContain("比平时慢一些");
    await advance(1);
    expect(document.body.textContent).toContain("比平时慢一些");
    await advance(9_999);
    expect(document.body.textContent).not.toContain("请求超时");
    await advance(1);
    expect(document.body.textContent).toContain("请求超时");
    expect(document.body.textContent).toContain("资源平台 20 秒内没有回应。");
  });
});

describe("发现页：失败与离线", () => {
  it("首页失败原位给出原因，重试成功后出现结果", async () => {
    let fail = true;
    pages = () => {
      if (fail) throw new Error("Modrinth 返回 502");
      return result([entry("A")]);
    };
    await mount();
    expect(document.body.textContent).toContain("暂时连不上资源平台");
    expect(document.body.textContent).toContain("Modrinth 返回 502");
    fail = false;
    act(() => buttonByText("重试").click());
    await flush();
    expect(cardTitles()).toEqual(["资源 A，查看详情"]);
    expect(searchCalls()).toHaveLength(2);
  });

  it("只有一个平台失败：照常列出另一个平台的结果并说明", async () => {
    pages = () => result([entry("A")], { errors: [{ platform: "curseforge", message: "503" }] });
    await mount();
    expect(cardTitles()).toEqual(["资源 A，查看详情"]);
    expect(document.body.textContent).toContain("CurseForge 暂时没有响应，下面只有 Modrinth 的结果。");
  });

  it("断网时顶部提示；恢复联网后正在看的搜索立即重取", async () => {
    await mount();
    expect(searchCalls()).toHaveLength(1);
    online = false;
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(document.body.textContent).toContain("没有网络连接");
    online = true;
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await settle();
    });
    expect(document.body.textContent).not.toContain("搜索和安装需要联网");
    expect(searchCalls()).toHaveLength(2);
  });
});

describe("发现页：资源详情与安装", () => {
  const pack = entry("R1", { title: "柔光材质", resource_type: "resource_pack", loaders: [] });
  const v = modVersion("rp-2", { project_id: "R1", loaders: [], game_versions: ["1.21.1"], file_size: 2048 });

  beforeEach(() => {
    pages = () => result([pack]);
    ipc.overrides.set("project_detail", () => detailOf(pack, { latest_version: v }));
    ipc.overrides.set("list_mod_versions", () => [v]);
    ipc.overrides.set("match_instances", () => [
      match("生存", { best_version: v }),
      match("创造", { state: "incompatible", compatibility: { kind: "mismatch", reason: "需要 1.20.1" }, best_version: null }),
    ]);
    ipc.overrides.set("install_resource", (args) => ({ file_name: "rp.zip", path: "x", platform: "modrinth", resource_type: "resource_pack", world: args.world }));
  });

  it("默认勾选当前实例；确认后按勾选的实例与版本发起安装并关闭弹窗", async () => {
    await mount();
    act(() => card("柔光材质").click());
    await flush();
    expect(callsOf(ipc, "project_detail")).toEqual([{ platform: "modrinth", projectId: "R1" }]);
    const survival = dialog().querySelector('[role="checkbox"][aria-label^="生存，兼容"]');
    const creative = dialog().querySelector('[role="checkbox"][aria-label^="创造，不兼容"]');
    if (survival === null || creative === null) throw new Error("目标列表里缺少实例");
    expect(survival.getAttribute("aria-checked")).toBe("true");
    expect(creative.getAttribute("aria-checked")).toBe("false");
    expect(creative.hasAttribute("disabled")).toBe(true);
    expect(dialog().textContent).toContain("已选 1 个实例");

    act(() => buttonByText("安装", dialog()).click());
    await flush();
    const installs = callsOf(ipc, "install_resource");
    expect(installs).toHaveLength(1);
    expect(installs[0]).toMatchObject({ versionId: "生存", resourceType: "resource_pack", world: null, platform: "modrinth", projectId: "R1", fileVersionId: "rp-2" });
    expect(openDialogs()).toHaveLength(0);
  });

  it("离线时不发起安装，只提示恢复联网后再装", async () => {
    await mount();
    act(() => card("柔光材质").click());
    await flush();
    online = false;
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    act(() => buttonByText("安装", dialog()).click());
    await flush();
    expect(callsOf(ipc, "install_resource")).toHaveLength(0);
    expect(launcher.state.toasts.map((t) => [t.tone, t.title, t.body])).toContainEqual(["warning", "没有网络连接", "恢复联网后再安装"]);
    expect(openDialogs()).toHaveLength(1);
  });

  it("数据包：逐个读各实例的存档，同时在读的不超过 2 个；读完后按存档判定", async () => {
    const ids = ["甲", "乙", "丙", "丁"];
    const dp = entry("D1", { title: "地形", resource_type: "data_pack", loaders: [] });
    const dv = modVersion("dp-1", { project_id: "D1", loaders: [] });
    bootOverrides(ipc, { instances: ids.map((id) => instanceDto(id)), config: configDto({ selected_version: "甲" }) });
    pages = () => result([dp]);
    ipc.overrides.set("project_detail", () => detailOf(dp, { latest_version: dv }));
    ipc.overrides.set("list_mod_versions", () => [dv]);
    ipc.overrides.set("match_instances", () => ids.map((id) => match(id, { best_version: dv })));
    const waiting = new Map<string, Deferred<unknown>>();
    let inFlight = 0;
    let peak = 0;
    ipc.overrides.set("list_instance_content", (args) => {
      const d = deferred<unknown>();
      waiting.set(String(args.id), d);
      inFlight++;
      peak = Math.max(peak, inFlight);
      return d.promise.finally(() => inFlight--);
    });
    await mount();
    act(() => card("地形").click());
    await flush();
    expect(callsOf(ipc, "list_instance_content").map((a) => a.id)).toEqual(["甲", "乙"]);
    const world = { dir_name: "w", level_status: "ok", level_error: null, name: "主世界", mode: null, last_played: null, size_bytes: 0, modified_at: null };
    for (const id of ids) {
      const d = waiting.get(id);
      if (d === undefined) throw new Error(`「${id}」的存档还没开始读`);
      await act(async () => {
        d.resolve({ resource_packs: [], shader_packs: [], worlds: id === "乙" ? [] : [world] });
        await settle();
      });
    }
    expect(callsOf(ipc, "list_instance_content").map((a) => a.id)).toEqual(ids);
    expect(peak).toBe(2);
    expect(dialog().querySelector('[role="checkbox"][aria-label^="甲，兼容"]')?.getAttribute("aria-checked")).toBe("true");
    expect(dialog().querySelector('[role="checkbox"][aria-label^="乙，不可用，还没有存档"]')).not.toBeNull();
  });

  it("路由带 open 时进页直接打开该资源的详情", async () => {
    await mount({ page: "discover", open: { platform: "modrinth", projectId: "R1" } });
    expect(callsOf(ipc, "project_detail")).toEqual([{ platform: "modrinth", projectId: "R1" }]);
    expect(dialog().textContent).toContain("柔光材质");
    expect(nav.route).toEqual({ page: "discover" });
  });
});

describe("发现页：整合包", () => {
  it("平台整合包：默认名避开已有实例，装成新实例后面板原位切到进度", async () => {
    const pack = entry("M1", { title: "生存", resource_type: "modpack", loaders: ["fabric"] });
    const v = modVersion("mp-1", { project_id: "M1", version_number: "2.0.0", loaders: ["fabric"], game_versions: ["1.20.1"] });
    pages = () => result([pack]);
    ipc.overrides.set("project_detail", () => detailOf(pack, { latest_version: v }));
    ipc.overrides.set("list_mod_versions", () => [v]);
    ipc.overrides.set("summarize_platform_modpack", () => new Promise(() => {}));
    // 导入任务一直在跑：面板停在进度态
    ipc.overrides.set("install_modpack", () => new Promise(() => {}));
    await mount();
    act(() => card("生存").click());
    await flush();
    const nameInput = dialog().querySelector<HTMLInputElement>("input");
    if (nameInput === null) throw new Error("没有名称输入框");
    expect(nameInput.value).toBe("生存 2");
    expect(dialog().textContent).toContain("1.20.1 · Fabric");

    act(() => buttonByText("安装为新实例", dialog()).click());
    await flush();
    const installs = callsOf(ipc, "install_modpack");
    expect(installs).toHaveLength(1);
    expect(installs[0]).toMatchObject({ source: { kind: "platform", platform: "modrinth", project_id: "M1", version_id: "mp-1" }, name: "生存 2" });
    // 平台版本没声明包含的工程：不知道 Mod 数，任务详情只写版本，不写「0 个 Mod」
    expect(launcher.state.tasks.map((t) => [t.title, t.detail])).toEqual([["导入整合包 生存", "2.0.0"]]);
    expect(openDialogs()).toHaveLength(1);
    expect(buttonByText("查看实例", dialog())).toBeDefined();
  });

  it("本地整合包：读取失败按错误码说明原因并留在第一步；读取成功后导入为新实例", async () => {
    const { IpcError } = await import("../../ipc/errors");
    let broken = true;
    ipc.overrides.set("preview_modpack", () => {
      if (broken) throw new IpcError("modpack_manifest_missing", "manifest not found");
      return {
        format: "modrinth",
        name: "创造",
        version: null,
        summary: null,
        author: null,
        minecraft: "1.21.1",
        loader: { kind: "quilt", version: "0.26.0" },
        remote_files: 120,
        remote_bytes: 3 * 1024 * 1024,
        override_files: 8,
        override_bytes: 4096,
      };
    });
    ipc.overrides.set("install_modpack", () => new Promise(() => {}));
    await mount();
    act(() => buttonByText("导入整合包文件").click());
    await flush();
    const path = dialog().querySelector<HTMLInputElement>('input[aria-label="整合包文件的完整路径"]');
    if (path === null) throw new Error("没有路径输入框");
    typeInto(path, "D:\Downloads\pack.mrpack");
    act(() => buttonByText("读取", dialog()).click());
    await flush();
    expect(callsOf(ipc, "preview_modpack")).toEqual([{ path: "D:\Downloads\pack.mrpack" }]);
    expect(dialog().textContent).toContain("这个压缩包里没有 modrinth.index.json 或 manifest.json，不像是整合包");

    broken = false;
    act(() => buttonByText("读取", dialog()).click());
    await flush();
    expect(dialog().textContent).toContain("整合包没有写版本号");
    expect(dialog().textContent).toContain("120 个文件需要下载");
    const nameInput = dialog().querySelector<HTMLInputElement>('input:not([aria-label="整合包文件的完整路径"])');
    if (nameInput === null) throw new Error("没有名称输入框");
    expect(nameInput.value).toBe("创造 2");

    act(() => buttonByText("导入为新实例", dialog()).click());
    await flush();
    const installs = callsOf(ipc, "install_modpack");
    expect(installs).toHaveLength(1);
    expect(installs[0]).toMatchObject({ source: { kind: "file", path: "D:\Downloads\pack.mrpack" }, name: "创造 2" });
    // 120 个待下载文件不等于 120 个 Mod：任务详情不写 Mod 数
    expect(launcher.state.tasks.map((t) => [t.title, t.detail])).toEqual([["导入整合包 创造", "未写版本号"]]);
    expect(launcher.state.toasts.map((t) => t.title)).toContain("已开始导入「创造 2」");
    expect(openDialogs()).toHaveLength(0);
  });
});

describe("发现页：平台整合包的清单摘要与同包提醒", () => {
  const pack = entry("M1", { title: "樱落", resource_type: "modpack", loaders: ["fabric"] });
  const v = modVersion("mp-3", { project_id: "M1", version_number: "3.0.0", loaders: ["fabric"], game_versions: ["1.20.1"], file_size: 2_000_000 });
  const summary = (overrides: Record<string, unknown> = {}) => ({
    format: "modrinth",
    name: "樱落",
    version: "3.0.0",
    minecraft: "1.21.1",
    loader: { kind: "quilt", version: "0.26.4" },
    pack_bytes: 1_048_576,
    remote_files: 48,
    mod_files: 41,
    remote_bytes: 9 * 1_048_576,
    override_files: 3,
    override_bytes: 512,
    ...overrides,
  });

  beforeEach(() => {
    pages = () => result([pack]);
    ipc.overrides.set("project_detail", () => detailOf(pack, { latest_version: v }));
    ipc.overrides.set("list_mod_versions", () => [v]);
    ipc.overrides.set("install_modpack", () => new Promise(() => {}));
  });

  async function openPack() {
    await mount();
    act(() => card("樱落").click());
    await flush();
  }

  it("Modrinth：按所选版本读清单，清单里的游戏版本、加载器、Mod 数与下载量为准，并随任务带上", async () => {
    ipc.overrides.set("summarize_platform_modpack", () => summary());
    await openPack();
    expect(callsOf(ipc, "summarize_platform_modpack")).toEqual([{ platform: "modrinth", projectId: "M1", versionId: "mp-3" }]);
    expect(dialog().textContent).toContain("41 个 Mod");
    // 整合包文件本身加上清单里要另外下载的文件
    expect(dialog().textContent).toContain("下载约 10.0 MB");
    expect(dialog().textContent).toContain("1.21.1 · Quilt · 41 个 Mod");
    act(() => buttonByText("安装为新实例", dialog()).click());
    await flush();
    expect(launcher.state.tasks.map((t) => t.detail)).toEqual(["3.0.0 · 41 个 Mod"]);
  });

  it("CurseForge：清单分不出 Mod，改写要下载的文件数，任务详情不写 Mod 数", async () => {
    ipc.overrides.set("summarize_platform_modpack", () => summary({ format: "curseforge", mod_files: null, remote_bytes: null }));
    await openPack();
    expect(dialog().textContent).toContain("48 个文件需要下载");
    expect(dialog().textContent).not.toContain("41 个 Mod");
    expect(dialog().textContent).not.toContain("下载约");
    act(() => buttonByText("安装为新实例", dialog()).click());
    await flush();
    expect(launcher.state.tasks.map((t) => t.detail)).toEqual(["3.0.0"]);
  });

  it("清单读不出来：说明原因可重试，仍可按平台版本信息安装", async () => {
    const { IpcError } = await import("../../ipc/errors");
    let fail = true;
    ipc.overrides.set("summarize_platform_modpack", () => {
      if (fail) throw new IpcError("remote_pack_unreadable", "服务器不支持分段下载", { url: "https://x/p.mrpack", reason: "no_range" });
      return summary();
    });
    await openPack();
    expect(dialog().textContent).toContain("整合包清单没能提前读出来");
    expect(dialog().textContent).toContain("服务器不支持分段下载");
    expect(dialog().textContent).toContain("1.20.1 · Fabric");
    fail = false;
    const retry = [...dialog().querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.textContent === "重试");
    expect(retry).toHaveLength(1);
    act(() => retry[0].click());
    await flush();
    expect(dialog().textContent).toContain("41 个 Mod");
    expect(dialog().textContent).not.toContain("整合包清单没能提前读出来");
  });

  it("已有来自同一整合包的实例：卡片写出个数，面板提醒再装一次是独立的新实例", async () => {
    ipc.overrides.set("summarize_platform_modpack", () => summary());
    const fromPack = { platform: "modrinth" as const, project_id: "M1", version_id: "mp-2", name: "樱落", version: "2.0.0" };
    bootOverrides(ipc, {
      instances: [instanceDto("樱落周目", { modpack: fromPack }), instanceDto("另一份", { modpack: { ...fromPack, project_id: "M2" } }), instanceDto("樱落二周目", { modpack: fromPack })],
      config: configDto({ selected_version: "樱落周目" }),
    });
    await mount();
    expect(card("樱落").textContent).toContain("已有 2 个实例来自它");
    act(() => card("樱落").click());
    await flush();
    expect(dialog().textContent).toContain("你已经有 2 个来自这个整合包的实例（「樱落周目」），再装一次会得到一个独立的新实例。");
  });

  it("没有来自它的实例时卡片与面板都不提", async () => {
    ipc.overrides.set("summarize_platform_modpack", () => summary());
    await openPack();
    expect(card("樱落").textContent).not.toContain("实例来自它");
    expect(dialog().textContent).not.toContain("来自这个整合包");
  });
});

describe("发现页：本地整合包的三种入口", () => {
  const PACK = "D:\\Downloads\\生存.mrpack";
  const preview = (path: string) => ({
    format: "modrinth",
    name: path.includes("创造") ? "创造包" : "生存包",
    version: "1.2.0",
    summary: null,
    author: null,
    minecraft: "1.21.1",
    loader: { kind: "fabric", version: "0.16.9" },
    remote_files: 12,
    remote_bytes: 2048,
    override_files: 3,
    override_bytes: 512,
  });
  const fire = (event: WindowDropEvent) =>
    act(async () => {
      for (const handler of [...dropHandlers]) handler(event);
      await settle();
    });
  const nameValue = () => {
    const input = dialog().querySelector<HTMLInputElement>('input:not([aria-label="整合包文件的完整路径"])');
    if (input === null) throw new Error("没有名称输入框");
    return input.value;
  };
  const dropZone = () => {
    const el = dialog().querySelector<HTMLElement>("[data-drop-zone]");
    if (el === null) throw new Error("没有投放区");
    return el;
  };
  const clickInDialog = (text: string) =>
    act(async () => {
      buttonByText(text, dialog()).click();
      await settle();
    });

  beforeEach(() => {
    ipc.overrides.set("preview_modpack", (args) => preview(String(args.path)));
  });

  it("路由带入文件路径：进页直接打开导入弹窗并读取它，随后路由里去掉这个路径", async () => {
    await mount({ page: "discover", importFile: PACK });
    expect(callsOf(ipc, "preview_modpack")).toEqual([{ path: PACK }]);
    expect(nameValue()).toBe("生存包");
    expect(dialog().textContent).toContain("版本 1.2.0");
    expect(nav.route).toEqual({ page: "discover" });
  });

  it("已在发现页时外壳带来新的文件路径：同样打开弹窗读取", async () => {
    await mount();
    act(() => nav.go({ page: "discover", importFile: PACK }));
    await flush();
    expect(callsOf(ipc, "preview_modpack")).toEqual([{ path: PACK }]);
    expect(nameValue()).toBe("生存包");
    expect(nav.route).toEqual({ page: "discover" });
  });

  it("「选择文件」：选中即读取；取消选择什么都不做", async () => {
    await mount();
    act(() => buttonByText("导入整合包文件").click());
    await flush();
    vi.mocked(pickFile).mockResolvedValueOnce(null);
    await clickInDialog("选择文件");
    expect(callsOf(ipc, "preview_modpack")).toEqual([]);
    expect(dialog().textContent).toContain("把整合包文件拖到这里");

    vi.mocked(pickFile).mockResolvedValueOnce("C:\\packs\\创造.zip");
    await clickInDialog("选择文件");
    expect(vi.mocked(pickFile).mock.calls.map((c) => c[0].filter.extensions)).toEqual([
      ["mrpack", "zip"],
      ["mrpack", "zip"],
    ]);
    expect(callsOf(ipc, "preview_modpack")).toEqual([{ path: "C:\\packs\\创造.zip" }]);
    expect(nameValue()).toBe("创造包");
  });

  it("浏览器预览里没有系统对话框：如实报错，弹窗停在第一步", async () => {
    await mount();
    act(() => buttonByText("导入整合包文件").click());
    await flush();
    await clickInDialog("选择文件");
    const toast = launcher.state.toasts.find((t) => t.title === "没能打开文件选择");
    expect(toast?.tone).toBe("error");
    expect(toast?.body).toContain("浏览器预览里没有系统的选择文件对话框");
    expect(callsOf(ipc, "preview_modpack")).toEqual([]);
    expect(dialog().textContent).toContain("把整合包文件拖到这里");
  });

  it("弹窗打开时拖进文件：投放区高亮，松开读第一个整合包，外壳不再自己导航", async () => {
    await mount({ page: "discover", query: "钠" });
    act(() => buttonByText("导入整合包文件").click());
    await flush();
    await fire({ type: "enter", content: { kind: "files", paths: ["D:\\notes.txt", PACK] } });
    expect(dropZone().dataset.state).toBe("over");
    await fire({ type: "leave" });
    expect(dropZone().dataset.state).toBeUndefined();
    await fire({ type: "enter", content: { kind: "files", paths: [PACK] } });
    await fire({ type: "drop", content: { kind: "files", paths: ["D:\\notes.txt", PACK] } });
    expect(callsOf(ipc, "preview_modpack")).toEqual([{ path: PACK }]);
    expect(nameValue()).toBe("生存包");
    expect(nav.route).toEqual({ page: "discover", query: "钠" });
  });

  it("拖进来的都不是整合包：照样交给后端读，按错误码说明只认哪两种文件", async () => {
    const { IpcError } = await import("../../ipc/errors");
    ipc.overrides.set("preview_modpack", () => {
      throw new IpcError("modpack_unsupported_extension", "unsupported");
    });
    await mount();
    act(() => buttonByText("导入整合包文件").click());
    await flush();
    await fire({ type: "drop", content: { kind: "files", paths: ["D:\\a.png", "D:\\b.jar"] } });
    expect(callsOf(ipc, "preview_modpack")).toEqual([{ path: "D:\\a.png" }]);
    expect(dialog().textContent).toContain("只认 .mrpack 和 CurseForge 导出的 .zip");
    expect(dropZone()).toBeDefined();
  });
});
