// @vitest-environment jsdom
// @module-tag heavy-page
import { MotionConfig } from "framer-motion";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi, type Mock } from "vitest";
import { stubCanvas } from "../../art/illustrations/test-canvas";
import { mockInvoke } from "../../ipc/mock";
import { MOCK_DOWNLOADS_DIR, reset as resetModpackMock, seedMockDownloads } from "../../ipc/mock/handlers/modpack";
import type { InstanceSources } from "../../ipc/mods";
import { OverlayRoot } from "../../shell/overlay";
import { pickFile } from "../../shell/platform";
import { ShellProvider, useNav, type NavApi } from "../../shell/shell";
import { WindowPortProvider, browserWindowPort, type WindowDropEvent, type WindowPort } from "../../shell/window";
import { LauncherProvider, useLauncher, type LauncherApi } from "../../state/launcher";
import type { ProjectDetail, SearchArgs, SearchEntry, SearchResultDto } from "../../state/queries/discover";
import type { BlockedFileDto, PackModDto } from "../../state/store";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../test/dom";
import type { IpcArgs, IpcRecorder } from "../../test/fake-bridge";
import { emulateFocusFixup } from "../../test/focus-fixup";
import { bootOverrides, callsOf, cancelledError, configDto, deferred, instanceDto, resetRecorder, settle, type Deferred } from "../../test/launcher";
import { entry, match, modVersion, result } from "./fixtures";
import DiscoverPage from "./index";
import { PickFolderProvider, type PickFolder } from "./platform";
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
/** 系统选择文件夹对话框的替身：默认选中系统下载文件夹。 */
let pickFolder: Mock<PickFolder>;

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

async function mount(route: Parameters<NavApi["go"]>[0] = { page: "discover" }, reducedMotion: "always" | "never" = "never") {
  view = render(
    <MotionConfig reducedMotion={reducedMotion}>
      <WindowPortProvider port={port}>
        <LauncherProvider>
          <ShellProvider>
            <PickFolderProvider value={pickFolder}>
              <Probe />
              <PageArea />
              <OverlayRoot />
            </PickFolderProvider>
          </ShellProvider>
        </LauncherProvider>
      </WindowPortProvider>
    </MotionConfig>,
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

/** 预览里的 n 个照常下载的 Mod，条数与 mod_files 对上。 */
function packMods(n: number): PackModDto[] {
  return Array.from({ length: n }, (_, i) => ({
    path: `mods/mod-${String(i + 1).padStart(3, "0")}.jar`,
    file_name: `mod-${String(i + 1).padStart(3, "0")}.jar`,
    origin: "remote",
    optional: false,
    project_id: null,
    file_id: null,
    availability: "download",
  }));
}

/** installed_sources 的一行：实例里装着这些 Modrinth 工程。 */
function sourcesOf(versionId: string, projectIds: readonly string[]): InstanceSources {
  return { status: "ready", version_id: versionId, sources: projectIds.map((id) => ({ platform: "modrinth", project_id: id })) };
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
  pickFolder = vi.fn<PickFolder>(async () => MOCK_DOWNLOADS_DIR);
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
  ipc.overrides.set("installed_sources", () => [sourcesOf("创造", []), sourcesOf("生存", ["A"])]);
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

  it("从实例的 Mod 页过来：写回路由之后适配实例还在，搜索按它的版本与加载器", async () => {
    await mount({ page: "discover", kind: "mod", forInstance: "生存" });
    expect(nav.route).toEqual({ page: "discover", kind: "mod" });
    expect(document.body.textContent).toContain("适配：生存");
    expect(lastSearch()).toMatchObject({ gameVersions: ["1.21.1"], loaders: ["fabric"] });
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

  it("「已装入」一条 installed_sources 取齐全部实例的已装来源，不逐个读 Mod 列表", async () => {
    await mount();
    expect(callsOf(ipc, "installed_sources")).toEqual([{}]);
    expect(callsOf(ipc, "list_mods")).toEqual([]);
    expect(card("资源 A").textContent).toContain("已装入 1 个实例");
    expect(card("资源 B").textContent).not.toContain("已装入");
  });

  it("「已装入」只数可用实例里装着同平台同工程的：读不出的、列表外的、别的平台的都不算", async () => {
    const ids = ["甲", "乙", "丙", "丁", "戊"];
    bootOverrides(ipc, { instances: ids.map((id) => instanceDto(id, { loaders: [{ kind: "fabric", version: "0.16.5" }] })), config: configDto({ selected_version: "甲" }) });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    ipc.overrides.set("installed_sources", () => [
      sourcesOf("丁", ["A", "B"]),
      sourcesOf("丙", []),
      { status: "error", version_id: "乙", error: { code: "config_invalid", message: "卷宗不是合法的 JSON" } },
      { status: "ready", version_id: "戊", sources: [{ platform: "curseforge", project_id: "A" }] },
      sourcesOf("甲", ["A"]),
      sourcesOf("盘上还有但列表里没有", ["A", "B"]),
    ]);
    await mount();
    expect(card("资源 A").textContent).toContain("已装入 2 个实例");
    expect(card("资源 B").textContent).toContain("已装入 1 个实例");
    expect(warn.mock.calls.map((c) => c[0])).toContain("「乙」的已装 Mod 来源读不出来，发现页的「已装入」不计这个实例");
  });

  it("移除 Mod 后已装来源失效重取，「已装入」随之更新", async () => {
    let installed = ["A"];
    ipc.overrides.set("installed_sources", () => [sourcesOf("创造", []), sourcesOf("生存", installed)]);
    ipc.overrides.set("remove_mod", () => {
      installed = [];
      return null;
    });
    await mount();
    expect(card("资源 A").textContent).toContain("已装入 1 个实例");
    await act(async () => {
      await launcher.actions.removeMod("生存", "A.jar", "资源 A");
      await settle();
    });
    expect(callsOf(ipc, "installed_sources")).toHaveLength(2);
    expect(card("资源 A").textContent).not.toContain("已装入");
  });

  it("结果里一个 Mod 都没有时不读已装来源", async () => {
    pages = () => result([entry("R", { title: "材质", resource_type: "resource_pack", loaders: [] }), entry("P", { title: "整合包", resource_type: "modpack" })]);
    await mount();
    expect(cardTitles()).toEqual(["材质，查看详情", "整合包，查看详情"]);
    expect(callsOf(ipc, "installed_sources")).toEqual([]);
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

  it("超时后点重试：重新开始一轮加载，超时说明立即收起；新一轮照样 10 s 提示慢、20 s 超时", async () => {
    let call = 0;
    pages = () => {
      call += 1;
      // 第一次一直不回；重试那次 25 s 才回，足够再超时一次
      if (call === 1) return new Promise<SearchResultDto>(() => {}) as never;
      return new Promise<SearchResultDto>((resolve) => setTimeout(() => resolve(result([entry("A")])), 25_000)) as never;
    };
    await mount();
    // 分两步走到 20 s：慢提示在 10 s 那一刻渲染出来，超时接在它后面计
    await advance(10_000);
    await advance(10_000);
    expect(document.body.textContent).toContain("请求超时");

    act(() => buttonByText("重试").click());
    await flush();
    expect(searchCalls()).toHaveLength(2);
    expect(document.body.textContent).not.toContain("请求超时");
    expect(document.body.textContent).toContain("搜索中…");
    expect(document.body.textContent).not.toContain("比平时慢一些");
    await advance(9_999);
    expect(document.body.textContent).not.toContain("比平时慢一些");
    await advance(1);
    expect(document.body.textContent).toContain("比平时慢一些");
    await advance(9_999);
    expect(document.body.textContent).not.toContain("请求超时");
    await advance(1);
    expect(document.body.textContent).toContain("请求超时");
    // 超时之后结果才到：照常换成结果
    await advance(5_000);
    await flush();
    expect(cardTitles()).toEqual(["资源 A，查看详情"]);
    expect(document.body.textContent).not.toContain("请求超时");
  });

  it("超时后结果晚到；之后同一组条件的首页缓存丢了、再从头加载：重新计时，不直接显示超时", async () => {
    let first = true;
    pages = (args) => {
      if (args.query === "换一个") return result([entry("B")]);
      if (first) {
        first = false;
        return new Promise<SearchResultDto>((resolve) => setTimeout(() => resolve(result([entry("A")])), 25_000)) as never;
      }
      return new Promise<SearchResultDto>(() => {}) as never;
    };
    await mount();
    await advance(10_000);
    await advance(10_000);
    expect(document.body.textContent).toContain("请求超时");
    await advance(5_000);
    await flush();
    expect(cardTitles()).toEqual(["资源 A，查看详情"]);

    // 换个关键词后断网再恢复：没人在看的首页缓存随之丢弃
    typeInto(searchInput(), "换一个");
    act(() => searchInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await flush();
    expect(cardTitles()).toEqual(["资源 B，查看详情"]);
    online = false;
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    online = true;
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await settle();
    });

    // 回到最初的条件：这是新的一次请求，刚开始加载
    const before = searchCalls().length;
    typeInto(searchInput(), "");
    await flush();
    expect(searchCalls()).toHaveLength(before + 1);
    expect(document.body.textContent).toContain("搜索中…");
    expect(document.body.textContent).not.toContain("请求超时");
    // 分两步走：慢提示在 10 s 那一刻渲染出来，超时接在它后面计
    await advance(10_000);
    expect(document.body.textContent).toContain("比平时慢一些");
    await advance(9_999);
    expect(document.body.textContent).not.toContain("请求超时");
    await advance(1);
    expect(document.body.textContent).toContain("请求超时");
  });

  it("超时后断网再恢复联网：恢复时重发的首页请求从头计时，不沿用上一次的超时", async () => {
    let call = 0;
    pages = () => {
      call += 1;
      // 第一次一直不回；恢复联网重发的那次 25 s 才回
      if (call === 1) return new Promise<SearchResultDto>(() => {}) as never;
      return new Promise<SearchResultDto>((resolve) => setTimeout(() => resolve(result([entry("A")])), 25_000)) as never;
    };
    await mount();
    await advance(10_000);
    await advance(10_000);
    expect(document.body.textContent).toContain("请求超时");

    online = false;
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    online = true;
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await settle();
    });
    expect(searchCalls()).toHaveLength(2);
    expect(document.body.textContent).not.toContain("请求超时");
    expect(document.body.textContent).toContain("搜索中…");
    await advance(300);
    expect(skeletonCards()).toBe(24);
    await advance(9_700);
    expect(document.body.textContent).toContain("比平时慢一些");
    await advance(9_999);
    expect(document.body.textContent).not.toContain("请求超时");
    await advance(1);
    expect(document.body.textContent).toContain("请求超时");
    await advance(5_000);
    await flush();
    expect(cardTitles()).toEqual(["资源 A，查看详情"]);
  });

  // 慢提示与超时说的是眼前这次请求：加载中途换了条件，两者一起按新请求从头计时，不会一个重来一个不重来；
  // 骨架一直在，不因换了请求再多等一个出现延迟
  it("首页加载中途换关键词：慢提示与超时按新请求从头计时", async () => {
    pages = () => new Promise<SearchResultDto>(() => {}) as never;
    await mount();
    await advance(10_000);
    expect(document.body.textContent).toContain("比平时慢一些");
    await advance(2_000);
    typeInto(searchInput(), "换一个");
    act(() => searchInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await flush();
    expect(searchCalls()).toHaveLength(2);
    expect(document.body.textContent).not.toContain("比平时慢一些");
    expect(skeletonCards()).toBe(24);
    // 旧请求本该超时的时刻（开始后 20 s）过去了，新请求才等了 8 s
    await advance(8_000);
    expect(document.body.textContent).not.toContain("请求超时");
    await advance(1_999);
    expect(document.body.textContent).not.toContain("比平时慢一些");
    // 分两步走到新请求的 20 s：慢提示在 10 s 那一刻渲染出来，超时接在它后面计
    await advance(1);
    expect(document.body.textContent).toContain("比平时慢一些");
    await advance(9_999);
    expect(document.body.textContent).not.toContain("请求超时");
    await advance(1);
    expect(document.body.textContent).toContain("请求超时");
  });

  it("下一页 10 s 还没回来才在列表尾写「比平时慢」，回来后收起", async () => {
    let resolveNext: ((r: SearchResultDto) => void) | undefined;
    pages = (args) =>
      args.cursor === null
        ? result([entry("A"), entry("B")], { total: 57, next_cursor: CURSOR })
        : (new Promise<SearchResultDto>((resolve) => {
            resolveNext = resolve;
          }) as never);
    await mount();
    const near = observers.find((o) => o.options !== undefined && o.options.rootMargin === "0px 0px 600px 0px" && o.targets.length > 0);
    if (near === undefined) throw new Error("没有观察列表尾");
    await act(async () => {
      near.callback([{ isIntersecting: true, target: near.targets[0] } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
      await settle();
    });
    expect(searchCalls()).toHaveLength(2);
    const foot = () => document.querySelector('section[aria-label="搜索资源"]')?.textContent as string;
    expect(foot()).toContain("搜索中…");
    await advance(9_999);
    expect(foot()).not.toContain("比平时慢一些");
    await advance(1);
    expect(foot()).toContain("比平时慢一些");
    const finish = resolveNext;
    if (finish === undefined) throw new Error("下一页请求没有发出");
    await act(async () => {
      finish(result([entry("C")], { total: 57, next_cursor: null }));
      await settle();
    });
    expect(foot()).not.toContain("比平时慢一些");
    expect(cardTitles()).toEqual(["资源 A，查看详情", "资源 B，查看详情", "资源 C，查看详情"]);
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

  it("一个平台失败、另一个平台确实一条都没有：空状态上方照样说明失败的平台并可重试，不让人以为两个平台都没有", async () => {
    let fail = true;
    pages = () => (fail ? result([], { errors: [{ platform: "modrinth", message: "502" }] }) : result([entry("A")]));
    await mount();
    expect(document.body.textContent).toContain("Modrinth 暂时没有响应，下面只有 CurseForge 的结果。");
    expect(document.body.textContent).toContain("没有符合条件的资源");
    fail = false;
    act(() => buttonByText("重试").click());
    await flush();
    expect(cardTitles()).toEqual(["资源 A，查看详情"]);
    expect(document.body.textContent).not.toContain("暂时没有响应");
    expect(searchCalls()).toHaveLength(2);
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
    ipc.overrides.set("list_mod_versions", () => ({ versions: [v], truncated: false }));
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
    expect(dialog().textContent).not.toContain("只列出了其中一部分");

    act(() => buttonByText("安装", dialog()).click());
    await flush();
    const installs = callsOf(ipc, "install_resource");
    expect(installs).toHaveLength(1);
    expect(installs[0]).toMatchObject({ versionId: "生存", resourceType: "resource_pack", world: null, platform: "modrinth", projectId: "R1", fileVersionId: "rp-2" });
    expect(openDialogs()).toHaveLength(0);
  });

  it("Mod 的前置预览：已装前置在平台上已下架时照常列出并标明，不计进待下载的文件", async () => {
    const mod = entry("M1", { title: "钠" });
    const main = modVersion("main2", { project_id: "M1", file_size: 4096 });
    pages = () => result([mod]);
    ipc.overrides.set("project_detail", () => detailOf(mod, { latest_version: main }));
    ipc.overrides.set("list_mod_versions", () => ({ versions: [main], truncated: false }));
    ipc.overrides.set("match_instances", () => [match("生存", { best_version: main })]);
    ipc.overrides.set("plan_install", () => ({
      items: [
        { version: main, title: "钠", icon_url: null, required_by: null, already_satisfied: false },
        {
          version: modVersion("gone1", { project_id: "D1", name: "dep-gone.jar", version_number: "0.9.1", file_name: "dep-gone.jar", file_size: null, game_versions: [], loaders: [] }),
          title: "织布机",
          icon_url: null,
          required_by: "M1",
          already_satisfied: true,
          delisted: true,
        },
        { version: modVersion("kept1", { project_id: "D2", version_number: "1.2.0" }), title: "线团", icon_url: null, required_by: "M1", already_satisfied: true },
      ],
      skipped: [],
    }));
    await mount();
    act(() => card("钠").click());
    await flush();
    const rows = [...dialog().querySelectorAll<HTMLElement>("[data-satisfied]")].map((row) => row.textContent);
    expect(rows).toEqual(["织布机钠 的前置已安装，平台上已找不到这个版本", "线团钠 的前置已满足，跳过"]);
    expect(dialog().textContent).not.toContain("0.9.1");
    expect(dialog().textContent).toContain("已选 1 个实例 · 共 1 个文件待下载");
  });

  it("版本列表截断时，安装面板的版本下拉与版本标签都说明列表不全", async () => {
    const note = "CurseForge 上的文件太多，这里只列出了其中一部分，没找到的版本请到 CurseForge 网页查看";
    const notes = () => {
      const text = dialog().textContent;
      if (text === null) throw new Error("弹窗没有文字");
      return text.split(note).length - 1;
    };
    ipc.overrides.set("list_mod_versions", () => ({ versions: [v], truncated: true }));
    await mount();
    act(() => card("柔光材质").click());
    await flush();
    // 只请求一份不过滤的列表，截断标记随它一起来
    expect(callsOf(ipc, "list_mod_versions")).toEqual([{ platform: "modrinth", projectId: "R1", gameVersions: [], loaders: [] }]);
    expect(notes()).toBe(1);
    const versionsTab = [...dialog().querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === "版本");
    if (versionsTab === undefined) throw new Error("没有版本标签");
    act(() => versionsTab.click());
    await flush();
    expect(notes()).toBe(2);
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

  it("同时发布成 Mod 的数据包：结果卡标数据包，点开后头图的类型标与卡一致", async () => {
    const dual = entry("D0", { title: "地貌重塑", resource_type: "data_pack" });
    pages = () => result([dual]);
    ipc.overrides.set("project_detail", () => detailOf(dual, { resource_type: "mod", latest_version: v }));
    await mount();
    act(() => card("地貌重塑").click());
    await flush();
    const tags = dialog().querySelector("h2")?.previousElementSibling;
    if (tags === null || tags === undefined) throw new Error("头图没有标签行");
    expect(tags.firstElementChild?.textContent).toBe("数据包");
  });

  it("数据包：逐个读各实例的存档，同时在读的不超过 2 个；读完后按存档判定", async () => {
    const ids = ["甲", "乙", "丙", "丁"];
    const dp = entry("D1", { title: "地形", resource_type: "data_pack", loaders: [] });
    const dv = modVersion("dp-1", { project_id: "D1", loaders: [] });
    bootOverrides(ipc, { instances: ids.map((id) => instanceDto(id)), config: configDto({ selected_version: "甲" }) });
    pages = () => result([dp]);
    ipc.overrides.set("project_detail", () => detailOf(dp, { latest_version: dv }));
    ipc.overrides.set("list_mod_versions", () => ({ versions: [dv], truncated: false }));
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

  it("数据包可更新：新版本默认装进旧版本所在的存档，不是最近游玩的那个", async () => {
    const dp = entry("D2", { title: "地形扩展", resource_type: "data_pack", loaders: [] });
    const next = modVersion("dp-2", { project_id: "D2", loaders: [], version_number: "1.1.0" });
    bootOverrides(ipc, { instances: [instanceDto("甲")], config: configDto({ selected_version: "甲" }) });
    pages = () => result([dp]);
    ipc.overrides.set("project_detail", () => detailOf(dp, { latest_version: next }));
    ipc.overrides.set("list_mod_versions", () => ({ versions: [next], truncated: false }));
    ipc.overrides.set("match_instances", () => [
      match("甲", { state: "installed", best_version: next, installed: { file_name: "terrain-1.0.0.zip", version_id: "dp-1", version_number: "1.0.0", world: "Old" } }),
    ]);
    const world = (dir: string, name: string, lastPlayed: number) => ({ dir_name: dir, level_status: "ok", level_error: null, name, mode: null, last_played: lastPlayed, size_bytes: 0, modified_at: null });
    // 最近玩的是「新世界」，旧版本装在「老世界」
    ipc.overrides.set("list_instance_content", () => ({ resource_packs: [], shader_packs: [], worlds: [world("New", "新世界", 2_000), world("Old", "老世界", 1_000)] }));
    await mount();
    act(() => card("地形扩展").click());
    await flush();
    expect(dialog().querySelector('[role="checkbox"][aria-label^="甲，可更新，已装 1.0.0，将换成 1.1.0"]')?.getAttribute("aria-checked")).toBe("true");

    act(() => buttonByText("更新", dialog()).click());
    await flush();
    const installs = callsOf(ipc, "install_resource");
    expect(installs).toHaveLength(1);
    expect(installs[0]).toMatchObject({ versionId: "甲", resourceType: "data_pack", world: "Old", fileVersionId: "dp-2" });
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
    ipc.overrides.set("list_mod_versions", () => ({ versions: [v], truncated: false }));
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
    // 平台整合包不提供可选文件勾选：可选文件照装
    expect(installs[0]).toMatchObject({ source: { kind: "platform", platform: "modrinth", project_id: "M1", version_id: "mp-1" }, name: "生存 2", excludedOptional: [] });
    // 平台版本没声明包含的工程：不知道 Mod 数，任务详情只写版本，不写「0 个 Mod」
    expect(launcher.state.tasks.map((t) => [t.title, t.detail])).toEqual([["导入整合包 生存", "2.0.0"]]);
    expect(openDialogs()).toHaveLength(1);
    expect(buttonByText("查看实例", dialog())).toBeDefined();
  });

  it("平台整合包导入失败后断网：面板的重试与安装一样只提示恢复联网后再装，不把任务重新排进队列", async () => {
    const { IpcError } = await import("../../ipc/errors");
    const pack = entry("M1", { title: "樱落", resource_type: "modpack", loaders: ["fabric"] });
    const v = modVersion("mp-1", { project_id: "M1", version_number: "2.0.0", loaders: ["fabric"], game_versions: ["1.20.1"] });
    pages = () => result([pack]);
    ipc.overrides.set("project_detail", () => detailOf(pack, { latest_version: v }));
    ipc.overrides.set("list_mod_versions", () => ({ versions: [v], truncated: false }));
    ipc.overrides.set("summarize_platform_modpack", () => new Promise(() => {}));
    ipc.overrides.set("install_modpack", () => {
      throw new IpcError("network_failed", "连接 cdn.modrinth.com 失败");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await mount();
    act(() => card("樱落").click());
    await flush();
    act(() => buttonByText("安装为新实例", dialog()).click());
    await flush();
    expect(launcher.state.tasks.map((t) => t.status)).toEqual(["failed"]);

    online = false;
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    act(() => buttonByText("重试", dialog()).click());
    await flush();
    expect(launcher.state.tasks.map((t) => [t.status, t.attempt])).toEqual([["failed", 1]]);
    expect(callsOf(ipc, "install_modpack")).toHaveLength(1);
    expect(launcher.state.toasts.map((t) => [t.tone, t.title, t.body])).toContainEqual(["warning", "没有网络连接", "恢复联网后再安装"]);
  });

  it("平台整合包缺下载密钥：面板写「没装成」加规定的原因，主按钮仍是重试", async () => {
    const { IpcError } = await import("../../ipc/errors");
    const pack = entry("M1", { title: "樱落", resource_type: "modpack", loaders: ["fabric"] });
    const v = modVersion("mp-1", { project_id: "M1", version_number: "2.0.0", loaders: ["fabric"], game_versions: ["1.20.1"] });
    pages = () => result([pack]);
    ipc.overrides.set("project_detail", () => detailOf(pack, { latest_version: v }));
    ipc.overrides.set("list_mod_versions", () => ({ versions: [v], truncated: false }));
    ipc.overrides.set("summarize_platform_modpack", () => new Promise(() => {}));
    ipc.overrides.set("install_modpack", () => {
      throw new IpcError("curseforge_key_missing", "CurseForge API key 未配置（环境变量 PETALFALL_CURSEFORGE_API_KEY 缺失），该源已禁用");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await mount();
    act(() => card("樱落").click());
    await flush();
    act(() => buttonByText("安装为新实例", dialog()).click());
    await flush();
    expect(dialog().textContent).toContain("没装成：有文件只能从 CurseForge 下载，需要先设置环境变量 PETALFALL_CURSEFORGE_API_KEY");
    expect(dialog().textContent).not.toContain("该源已禁用");
    expect(buttonByText("重试", dialog())).toBeDefined();
  });

  it("平台整合包的名称按去掉首尾空格后的样子校验：前面多个空格撞上已有实例就报重名，末尾多个空格照常装、装成去掉空格的名字", async () => {
    const pack = entry("M1", { title: "樱落", resource_type: "modpack", loaders: ["fabric"] });
    const v = modVersion("mp-1", { project_id: "M1", version_number: "2.0.0", loaders: ["fabric"], game_versions: ["1.20.1"] });
    pages = () => result([pack]);
    ipc.overrides.set("project_detail", () => detailOf(pack, { latest_version: v }));
    ipc.overrides.set("list_mod_versions", () => ({ versions: [v], truncated: false }));
    ipc.overrides.set("summarize_platform_modpack", () => new Promise(() => {}));
    ipc.overrides.set("install_modpack", () => new Promise(() => {}));
    await mount();
    act(() => card("樱落").click());
    await flush();
    const nameInput = dialog().querySelector<HTMLInputElement>("input");
    if (nameInput === null) throw new Error("没有名称输入框");

    typeInto(nameInput, " 生存");
    await flush();
    expect(dialog().textContent).toContain("已经有同名的实例了，换一个吧");
    expect(buttonByText("安装为新实例", dialog()).disabled).toBe(true);

    typeInto(nameInput, "樱落 ");
    await flush();
    expect(dialog().textContent).not.toContain("Windows 不允许");
    act(() => buttonByText("安装为新实例", dialog()).click());
    await flush();
    expect(callsOf(ipc, "install_modpack").map((a) => a.name)).toEqual(["樱落"]);
  });

  it("本地整合包的名称同样按去掉首尾空格后的样子校验", async () => {
    ipc.overrides.set("preview_modpack", () => ({
      format: "modrinth",
      name: "樱落",
      version: "1.0.0",
      summary: null,
      author: null,
      minecraft: "1.21.1",
      loader: null,
      remote_files: 0,
      mod_files: 0,
      remote_bytes: 0,
      override_files: 0,
      override_bytes: 0,
      mods: [],
      optional_extras: [],
      blocked_files: [],
    }));
    ipc.overrides.set("install_modpack", () => new Promise(() => {}));
    await mount();
    act(() => buttonByText("导入整合包文件").click());
    await flush();
    const path = dialog().querySelector<HTMLInputElement>('input[aria-label="整合包文件的完整路径"]');
    if (path === null) throw new Error("没有路径输入框");
    typeInto(path, "D:\\Downloads\\pack.mrpack");
    act(() => buttonByText("读取", dialog()).click());
    await flush();
    const nameInput = dialog().querySelector<HTMLInputElement>("input");
    if (nameInput === null) throw new Error("没有名称输入框");

    typeInto(nameInput, " 创造");
    await flush();
    expect(dialog().textContent).toContain("已经有同名的实例了，换一个吧");
    expect(buttonByText("导入为新实例").disabled).toBe(true);

    typeInto(nameInput, "樱落 ");
    await flush();
    expect(dialog().textContent).not.toContain("Windows 不允许");
    act(() => buttonByText("导入为新实例").click());
    await flush();
    expect(callsOf(ipc, "install_modpack").map((a) => a.name)).toEqual(["樱落"]);
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
        mod_files: 96,
        remote_bytes: 3 * 1024 * 1024,
        override_files: 8,
        override_bytes: 4096,
        mods: packMods(96),
        optional_extras: [],
        blocked_files: [],
      };
    });
    ipc.overrides.set("install_modpack", () => new Promise(() => {}));
    await mount();
    act(() => buttonByText("导入整合包文件").click());
    await flush();
    const path = dialog().querySelector<HTMLInputElement>('input[aria-label="整合包文件的完整路径"]');
    if (path === null) throw new Error("没有路径输入框");
    typeInto(path, "D:\\Downloads\\pack.mrpack");
    act(() => buttonByText("读取", dialog()).click());
    await flush();
    expect(callsOf(ipc, "preview_modpack")).toEqual([{ path: "D:\\Downloads\\pack.mrpack" }]);
    expect(dialog().textContent).toContain("这个压缩包里没有 modrinth.index.json 或 manifest.json，不像是整合包");

    broken = false;
    act(() => buttonByText("读取", dialog()).click());
    await flush();
    expect(dialog().textContent).toContain("整合包没有写版本号");
    expect(dialog().textContent).toContain("120 个文件需要下载");
    // 120 个待下载文件里只有一部分是 Mod：Mod 数取预览给的口径，不拿文件数充数
    expect(dialog().textContent).toContain("96 个 Mod");
    expect(dialog().textContent).toContain("1.21.1 · Quilt · 96 个 Mod");
    const nameInput = dialog().querySelector<HTMLInputElement>('input:not([aria-label="整合包文件的完整路径"])');
    if (nameInput === null) throw new Error("没有名称输入框");
    expect(nameInput.value).toBe("创造 2");

    act(() => buttonByText("导入为新实例", dialog()).click());
    await flush();
    const installs = callsOf(ipc, "install_modpack");
    expect(installs).toHaveLength(1);
    expect(installs[0]).toMatchObject({ source: { kind: "file", path: "D:\\Downloads\\pack.mrpack" }, name: "创造 2", excludedOptional: [] });
    expect(launcher.state.tasks.map((t) => [t.title, t.detail])).toEqual([["导入整合包 创造", "未写版本号 · 96 个 Mod"]]);
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
    ipc.overrides.set("list_mod_versions", () => ({ versions: [v], truncated: false }));
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

  it("CurseForge：摘要同样给出 Mod 数与下载量，并随任务带上", async () => {
    ipc.overrides.set("summarize_platform_modpack", () => summary({ format: "curseforge", mod_files: 37, remote_bytes: 4 * 1_048_576 }));
    await openPack();
    expect(dialog().textContent).toContain("1.21.1 · Quilt · 37 个 Mod");
    expect(dialog().textContent).toContain("下载约 5.0 MB");
    expect(dialog().textContent).not.toContain("个文件需要下载");
    act(() => buttonByText("安装为新实例", dialog()).click());
    await flush();
    expect(launcher.state.tasks.map((t) => t.detail)).toEqual(["3.0.0 · 37 个 Mod"]);
  });

  it("平台没给齐每个文件的大小：照写 Mod 数，下载量不显示；一个 Mod 都没有时写 0 个", async () => {
    ipc.overrides.set("summarize_platform_modpack", () => summary({ format: "curseforge", mod_files: 0, remote_bytes: null }));
    await openPack();
    expect(dialog().textContent).toContain("0 个 Mod");
    expect(dialog().textContent).not.toContain("下载约");
    expect(dialog().textContent).not.toContain("个文件需要下载");
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

  it("CurseForge 拒绝了下载密钥：摘要失败处写出怎么换密钥，不只给后端原文", async () => {
    const { IpcError } = await import("../../ipc/errors");
    ipc.overrides.set("summarize_platform_modpack", () => {
      throw new IpcError("curseforge_key_rejected", "CurseForge 拒绝了下载密钥（HTTP 401）：https://edge.forgecdn.net/files/1/2/p.zip", {
        realm: "curseforge",
        url: "https://edge.forgecdn.net/files/1/2/p.zip",
        status: 401,
      });
    });
    await openPack();
    expect(dialog().textContent).toContain("整合包清单没能提前读出来");
    expect(dialog().textContent).toContain("CurseForge 拒绝了下载密钥。设置环境变量 PETALFALL_CURSEFORGE_API_KEY 换一个可用的密钥后重试");
    expect(dialog().textContent).not.toContain("HTTP 401");
  });

  it("清单用了不支持的压缩格式：摘要失败处写统一说法，不给后端原文里的方法编号与条目名", async () => {
    const { IpcError } = await import("../../ipc/errors");
    ipc.overrides.set("summarize_platform_modpack", () => {
      throw new IpcError("modpack_unsupported_compression", "整合包条目 manifest.json 用了不支持的压缩方法 93", { method: 93, entry: "manifest.json" });
    });
    await openPack();
    expect(dialog().textContent).toContain("整合包清单没能提前读出来");
    expect(dialog().textContent).toContain("整合包用了不支持的压缩方式，用整合包作者发布的原始文件再试");
    expect(dialog().textContent).not.toContain("方法 93");
    expect(dialog().textContent).not.toContain("manifest.json");
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

  describe("一步至多一条说明块", () => {
    const panel = () => {
      const found = dialog().querySelector("aside");
      if (found === null) throw new Error("详情弹窗里没有安装面板");
      return found;
    };
    const callouts = () => [...panel().querySelectorAll('[class*="_callout_"]')].map((el) => el.textContent);
    const rows = () => [...panel().querySelectorAll('[class*="_warnNote_"]')].map((el) => el.textContent);
    const fromPack = { platform: "modrinth" as const, project_id: "M1", version_id: "mp-2", name: "樱落", version: "2.0.0" };
    const hasInstanceFromPack = () => bootOverrides(ipc, { instances: [instanceDto("樱落周目", { modpack: fromPack })], config: configDto({ selected_version: "樱落周目" }) });
    const DUPLICATE = "你已经有 1 个来自这个整合包的实例（「樱落周目」），再装一次会得到一个独立的新实例。";
    const BLOCKED = "作者不允许启动器直接下载这个整合包。开始安装后会列出要到 CurseForge 网页手动下载的文件。";
    const VERSIONS_FAILED = "整合包的版本列表没加载出来，只能装最新版本";
    const SUMMARY_FAILED = "整合包清单没能提前读出来，Mod 数和下载大小要到导入时才知道";

    it("四条同时成立：手动下载说明留作说明块，其余按版本列表、清单、重名的顺序写成行，读取失败的重试都还在", async () => {
      const { IpcError } = await import("../../ipc/errors");
      hasInstanceFromPack();
      let versionsFail = true;
      ipc.overrides.set("project_detail", () => detailOf(pack, { latest_version: v, distribution_allowed: false }));
      ipc.overrides.set("list_mod_versions", () => {
        if (versionsFail) throw new IpcError("network_failed", "版本接口超时");
        return { versions: [v], truncated: false };
      });
      ipc.overrides.set("summarize_platform_modpack", () => Promise.reject(new IpcError("remote_pack_unreadable", "服务器不支持分段下载", { url: "https://x/p.mrpack", reason: "no_range" })));
      await openPack();

      expect(callouts()).toEqual([BLOCKED]);
      expect(rows()).toEqual([`${VERSIONS_FAILED}版本接口超时重试`, `${SUMMARY_FAILED}服务器不支持分段下载重试`, DUPLICATE]);

      versionsFail = false;
      const [versionsRow] = panel().querySelectorAll<HTMLElement>('[class*="_warnNote_"]');
      act(() => buttonByText("重试", versionsRow).click());
      await flush();
      expect(rows()).toEqual([`${SUMMARY_FAILED}服务器不支持分段下载重试`, DUPLICATE]);
    });

    it("这个版本没标游戏版本：说明块留给挡住安装的这一条，重名写成行", async () => {
      hasInstanceFromPack();
      const unlabeled = modVersion("mp-3", { project_id: "M1", version_number: "3.0.0", loaders: ["fabric"], game_versions: [] });
      ipc.overrides.set("project_detail", () => detailOf(pack, { latest_version: unlabeled }));
      ipc.overrides.set("list_mod_versions", () => ({ versions: [unlabeled], truncated: false }));
      ipc.overrides.set("summarize_platform_modpack", () => new Promise(() => {}));
      await openPack();
      expect(callouts()).toEqual(["这个版本没有标注游戏版本，没法建实例"]);
      expect(rows()).toEqual([DUPLICATE]);
      expect(buttonByText("安装为新实例", dialog()).disabled).toBe(true);
    });

    it("受限清单排在后面写成行：打开清单的入口还在", async () => {
      const { IpcError } = await import("../../ipc/errors");
      const unlabeled = modVersion("mp-3", { project_id: "M1", version_number: "3.0.0", loaders: ["fabric"], game_versions: [] });
      const body = { project_id: 700, file_id: 7001, file_name: "sakura-3.0.0.zip", web_url: "https://www.curseforge.com/minecraft/modpacks/sakura/files/7001", destination: "sakura-3.0.0.zip", sha1: "3f786850e387550fdab836ed7e6dc881de23001b", fingerprint: 0, size: 2048 };
      ipc.overrides.set("project_detail", () => detailOf(pack, { latest_version: unlabeled }));
      ipc.overrides.set("list_mod_versions", () => ({ versions: [unlabeled], truncated: false }));
      ipc.overrides.set("summarize_platform_modpack", () => Promise.reject(new IpcError("distribution_blocked", "原文", { files: [body] })));
      await openPack();
      expect(callouts()).toEqual(["这个版本没有标注游戏版本，没法建实例"]);
      expect(rows()).toEqual(["作者不允许启动器直接下载这个整合包，需要到 CurseForge 网页手动下载。查看这些文件"]);

      act(() => buttonByText("查看这些文件", panel()).click());
      await flush();
      expect(document.body.textContent).toContain("sakura-3.0.0.zip");
    });

    it("只有重名一条：照旧是说明块，不写成行", async () => {
      hasInstanceFromPack();
      ipc.overrides.set("summarize_platform_modpack", () => summary());
      await openPack();
      expect(callouts()).toEqual([DUPLICATE]);
      expect(rows()).toEqual([]);
    });

    it("开始安装后这些提醒都收起：版本选择已经不在了，面板上只留进度态那一条说明块", async () => {
      const { IpcError } = await import("../../ipc/errors");
      hasInstanceFromPack();
      ipc.overrides.set("list_mod_versions", () => {
        throw new IpcError("network_failed", "版本接口超时");
      });
      ipc.overrides.set("summarize_platform_modpack", () => new Promise(() => {}));
      ipc.overrides.set("install_modpack", () => {
        throw new IpcError("network_failed", "连接 cdn.modrinth.com 失败");
      });
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      await openPack();
      expect(callouts()).toEqual([expect.stringContaining(VERSIONS_FAILED)]);
      act(() => buttonByText("安装为新实例", dialog()).click());
      await flush();
      expect(callouts()).toEqual(["没装成：网络连接失败"]);
      expect(rows()).toEqual([]);
    });
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
    mod_files: 10,
    remote_bytes: 2048,
    override_files: 3,
    override_bytes: 512,
    mods: packMods(10),
    optional_extras: [],
    blocked_files: [],
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
    // pickFile 是文件级 vi.fn，restoreMocks 只还原 spyOn，调用记录不清就会带进下一个用例
    vi.mocked(pickFile).mockClear();
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

  const closeDialog = () =>
    act(async () => {
      const close = dialog().querySelector<HTMLButtonElement>('button[aria-label="关闭"]');
      if (close === null) throw new Error("弹窗没有关闭按钮");
      close.click();
      await settle();
    });

  /** 第一次读失败（文件没下载完），之后读得出来：模拟用户等下载完成后再带入同一个文件。 */
  async function failOnceThenRead() {
    const { IpcError } = await import("../../ipc/errors");
    let calls = 0;
    ipc.overrides.set("preview_modpack", (args) => {
      calls += 1;
      if (calls === 1) throw new IpcError("modpack_corrupt", "unexpected end of archive");
      return preview(String(args.path));
    });
  }

  it("读失败后关掉弹窗，外壳再带入同一个文件：重新读取，不直接显示上次的错误", async () => {
    await failOnceThenRead();
    await mount({ page: "discover", importFile: PACK });
    expect(dialog().textContent).toContain("文件不完整或已损坏，重新下载一份再试");
    await closeDialog();
    expect(openDialogs()).toHaveLength(0);

    act(() => nav.go({ page: "discover", importFile: PACK }));
    // 请求发出到结果回来之间显示读取中，而不是缓存里那条旧错误
    expect(dialog().textContent).toContain("正在读取 生存.mrpack");
    expect(dialog().textContent).not.toContain("文件不完整或已损坏");
    await flush();
    expect(callsOf(ipc, "preview_modpack")).toEqual([{ path: PACK }, { path: PACK }]);
    expect(dialog().textContent).not.toContain("文件不完整或已损坏");
    expect(nameValue()).toBe("生存包");
  });

  it("读失败后关掉弹窗，重新打开再把同一个文件拖进投放区：同样重新读取", async () => {
    await failOnceThenRead();
    await mount();
    act(() => buttonByText("导入整合包文件").click());
    await flush();
    await fire({ type: "drop", content: { kind: "files", paths: [PACK] } });
    expect(dialog().textContent).toContain("文件不完整或已损坏，重新下载一份再试");
    await closeDialog();

    act(() => buttonByText("导入整合包文件").click());
    await flush();
    // 重新打开是从选文件开始，不带着上次的错误
    expect(dialog().textContent).not.toContain("文件不完整或已损坏");
    await fire({ type: "drop", content: { kind: "files", paths: [PACK] } });
    expect(callsOf(ipc, "preview_modpack")).toEqual([{ path: PACK }, { path: PACK }]);
    expect(nameValue()).toBe("生存包");
  });

  it("读成功过的文件关掉后再带入：也重新读取，显示文件现在的内容", async () => {
    let version = "1.2.0";
    ipc.overrides.set("preview_modpack", (args) => ({ ...preview(String(args.path)), version }));
    await mount({ page: "discover", importFile: PACK });
    expect(dialog().textContent).toContain("版本 1.2.0");
    await closeDialog();

    version = "1.3.0";
    act(() => nav.go({ page: "discover", importFile: PACK }));
    expect(dialog().textContent).toContain("正在读取 生存.mrpack");
    await flush();
    expect(callsOf(ipc, "preview_modpack")).toEqual([{ path: PACK }, { path: PACK }]);
    expect(dialog().textContent).toContain("版本 1.3.0");
    expect(dialog().textContent).not.toContain("版本 1.2.0");
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

describe("发现页：需要手动下载的文件与可选文件", () => {
  const BLOCKED_PACK = "D:\\Downloads\\blocked-pack.zip";
  const MRPACK = "D:\\Downloads\\生存.mrpack";
  const FILES: BlockedFileDto[] = [
    {
      project_id: 900001,
      file_id: 5000001,
      file_name: "blocked-a.jar",
      web_url: "https://www.curseforge.com/minecraft/mc-mods/blocked-a/files/5000001",
      destination: "mods/blocked-a.jar",
      sha1: "3f786850e387550fdab836ed7e6dc881de23001b",
      fingerprint: 0,
      size: 1024,
    },
    {
      project_id: 900002,
      file_id: 5000002,
      file_name: "blocked-b.jar",
      web_url: "https://www.curseforge.com/minecraft/mc-mods/blocked-b/files/5000002",
      destination: "mods/blocked-b.jar",
      sha1: "89e6c98d92887913cadf06b2adb97f26cde4849b",
      fingerprint: 0,
      size: 1024,
    },
  ];

  beforeEach(() => {
    // 下载文件夹里的文件与认领过的文件是假后端的内存状态，用例之间不能串
    resetModpackMock();
  });

  const clickIn = (root: ParentNode, text: string) =>
    act(async () => {
      buttonByText(text, root).click();
      await settle();
    });
  /** 看得见的文字：状态标签换一个时旧的还在淡出（标着 data-exiting），不算。 */
  const shownText = (el: Element) => {
    const copy = el.cloneNode(true) as Element;
    for (const gone of copy.querySelectorAll("[data-exiting]")) gone.remove();
    return copy.textContent;
  };
  const blockedDialog = () => {
    const el = openDialogs().find((d) => d.querySelector("h2")?.textContent === "需要手动下载的文件");
    if (el === undefined) throw new Error("需要手动下载的文件清单没有打开");
    return el;
  };
  const blockedRow = (file: string) => {
    const row = [...blockedDialog().querySelectorAll("li")].find((li) => li.textContent?.startsWith(file));
    if (row === undefined) throw new Error(`清单里没有 ${file}`);
    return row;
  };
  const modRows = () => [...dialog().querySelectorAll('ul[aria-label="包内 Mod"] > li')];
  const rowsTagged = (tag: string) => modRows().filter((li) => li.textContent?.endsWith(tag)).map((li) => li.textContent?.slice(0, -tag.length));
  const submitButton = () => buttonByText("导入为新实例", dialog());
  const checkbox = (label: string) => {
    const el = dialog().querySelector<HTMLButtonElement>(`[role="checkbox"][aria-label="${label}"]`);
    if (el === null) throw new Error(`没有勾选框 ${label}`);
    return el;
  };

  it("本地 .mrpack：Mod 行数等于 mod_files，可选文件默认勾上；取消勾选一个可选 Mod 后导入，只跳过它", async () => {
    await mount({ page: "discover", importFile: MRPACK });
    expect(modRows()).toHaveLength(41);
    expect(dialog().textContent).toContain("包内 Mod · 41");
    expect(rowsTagged("包内自带")).toEqual(["config-helper.jar", "pack-tweaks.jar"]);
    expect(rowsTagged("可选")).toEqual(["optional-helper.jar"]);
    expect(dialog().textContent).toContain("其他可选文件");
    expect(checkbox("装上 optional-helper.jar").getAttribute("aria-checked")).toBe("true");
    expect(checkbox("装上 optional-pack.zip").getAttribute("aria-checked")).toBe("true");

    act(() => checkbox("装上 optional-helper.jar").click());
    expect(checkbox("装上 optional-helper.jar").getAttribute("aria-checked")).toBe("false");
    // 勾选只决定下不下载，清单里的 Mod 数与下载量照整包写
    expect(dialog().textContent).toContain("包内 Mod · 41");
    expect(dialog().textContent).toContain("1.21.1 · Fabric · 41 个 Mod");

    ipc.overrides.set("install_modpack", () => new Promise(() => {}));
    await clickIn(dialog(), "导入为新实例");
    const installs = callsOf(ipc, "install_modpack");
    expect(installs).toHaveLength(1);
    expect(installs[0].excludedOptional).toEqual(["mods/optional-helper.jar"]);
    expect(launcher.state.tasks[0].spec.args.excludedOptional).toEqual(["mods/optional-helper.jar"]);
  });

  it("减少动效时清单的状态标签与说明块照常淡入淡出：换成「已找到」时旧标签先留在原处淡出", async () => {
    seedMockDownloads(["blocked-a.jar"]);
    await mount({ page: "discover", importFile: BLOCKED_PACK }, "always");
    await clickIn(dialog(), "查看这些文件");
    await clickIn(blockedDialog(), "我已下载，重新检查");
    expect(shownText(blockedRow("blocked-b.jar"))).toBe("blocked-b.jar装到 mods/还没找到打开网页");

    seedMockDownloads(["blocked-b.jar"]);
    await clickIn(blockedDialog(), "我已下载，重新检查");
    const row = blockedRow("blocked-b.jar");
    expect([...row.querySelectorAll("[data-exiting]")].map((el) => el.textContent)).toEqual(["还没找到"]);
    expect(shownText(row)).toBe("blocked-b.jar装到 mods/已找到");
    expect([...blockedDialog().querySelectorAll("[data-exiting]")].map((el) => el.textContent)).toContain("找到 1 个，还差 1 个。文件要和网页上的完全一致，改过名也能认出来。");
  });

  it("受限文件挡住导入；清单里检查下载文件夹：只下了 a 时 a 已找到、b 还没找到，都找到后继续导入，确认步原地重新读取", async () => {
    seedMockDownloads(["blocked-a.jar"]);
    await mount({ page: "discover", importFile: BLOCKED_PACK });
    expect(modRows()).toHaveLength(41);
    expect(rowsTagged("需手动下载")).toEqual(["blocked-a.jar", "blocked-b.jar"]);
    expect(dialog().textContent).toContain("有 2 个文件需要到 CurseForge 网页手动下载，下载好之前不能导入。");
    // 说明块里的操作只用小号幽灵按钮
    expect(buttonByText("查看这些文件", dialog())).toMatchObject({ dataset: { variant: "ghost", size: "sm" } });
    expect(submitButton().getAttribute("aria-disabled")).toBe("true");
    await clickIn(dialog(), "导入为新实例");
    expect(callsOf(ipc, "install_modpack")).toEqual([]);

    // 改过的名字在重新读取后还在
    const nameInput = dialog().querySelector<HTMLInputElement>('input:not([aria-label="整合包文件的完整路径"])');
    if (nameInput === null) throw new Error("没有名称输入框");
    typeInto(nameInput, "周末联机");

    await clickIn(dialog(), "查看这些文件");
    expect(blockedDialog().textContent).toContain("这 2 个文件的作者不允许启动器直接下载。到 CurseForge 网页下载后，回到这里重新检查。");
    expect(blockedRow("blocked-a.jar").textContent).toBe("blocked-a.jar装到 mods/打开网页");
    expect(blockedDialog().textContent).toContain("下载好后选文件所在的文件夹");
    // 底栏说明叠上清单自己的 12 号 text-2 样式，不沿用共用说明的 text-3
    const footNote = [...blockedDialog().querySelectorAll("span")].find((s) => s.textContent === "下载好后选文件所在的文件夹");
    expect(footNote?.className.split(" ").some((c) => c.includes("blockedFootNote"))).toBe(true);

    await clickIn(blockedDialog(), "我已下载，重新检查");
    expect(pickFolder.mock.calls).toEqual([[MOCK_DOWNLOADS_DIR, "选择下载好的文件所在的文件夹"]]);
    expect(callsOf(ipc, "claim_blocked_files").map((c) => [c.folder, (c.files as BlockedFileDto[]).map((f) => f.file_id)])).toEqual([[MOCK_DOWNLOADS_DIR, [5000001, 5000002]]]);
    expect(blockedRow("blocked-a.jar").textContent).toBe("blocked-a.jar装到 mods/已找到");
    expect(blockedRow("blocked-b.jar").textContent).toBe("blocked-b.jar装到 mods/还没找到打开网页");
    expect(blockedDialog().textContent).toContain("找到 1 个，还差 1 个。文件要和网页上的完全一致，改过名也能认出来。");
    expect(buttonByText("我已下载，重新检查", blockedDialog())).toBeDefined();

    seedMockDownloads(["blocked-b.jar"]);
    await clickIn(blockedDialog(), "我已下载，重新检查");
    expect(shownText(blockedRow("blocked-b.jar"))).toBe("blocked-b.jar装到 mods/已找到");
    expect(shownText(blockedDialog())).toContain("2 个文件都已找到。");
    expect(shownText(blockedDialog())).not.toContain("还差");

    // 第二次读取挂起：确认步原地显示重新读取，主按钮不能点
    const gate = deferred<void>();
    ipc.overrides.set("preview_modpack", (args) => gate.promise.then(() => mockInvoke("preview_modpack", args)));
    await clickIn(blockedDialog(), "继续导入");
    expect(openDialogs()).toHaveLength(1);
    expect(dialog().textContent).toContain("正在重新读取 blocked-pack.zip…");
    expect(submitButton().disabled).toBe(true);
    await act(async () => {
      gate.resolve();
      await settle();
    });
    expect(callsOf(ipc, "preview_modpack")).toEqual([{ path: BLOCKED_PACK }, { path: BLOCKED_PACK }]);
    expect(dialog().textContent).not.toContain("正在重新读取");
    expect(rowsTagged("已找到")).toEqual(["blocked-a.jar", "blocked-b.jar"]);
    expect(dialog().textContent).not.toContain("下载好之前不能导入");
    expect(nameInput.isConnected && nameInput.value).toBe("周末联机");
    expect(submitButton().getAttribute("aria-disabled")).toBeNull();

    ipc.overrides.set("install_modpack", () => new Promise(() => {}));
    await clickIn(dialog(), "导入为新实例");
    expect(callsOf(ipc, "install_modpack")).toMatchObject([{ source: { kind: "file", path: BLOCKED_PACK }, name: "周末联机", excludedOptional: [] }]);
  });

  it("「继续导入」：「查看这些文件」被重新读取换掉，焦点落回确认步的第一个控件，不掉回 body，也不停在关闭按钮上", async () => {
    seedMockDownloads(["blocked-a.jar", "blocked-b.jar"]);
    await mount({ page: "discover", importFile: BLOCKED_PACK });
    const view = buttonByText("查看这些文件", dialog());
    act(() => view.focus());
    await clickIn(dialog(), "查看这些文件");
    await clickIn(blockedDialog(), "我已下载，重新检查");

    const gate = deferred<void>();
    ipc.overrides.set("preview_modpack", (args) => gate.promise.then(() => mockInvoke("preview_modpack", args)));
    await clickIn(blockedDialog(), "继续导入");
    expect(view.isConnected).toBe(false);
    expect(dialog().textContent).toContain("正在重新读取 blocked-pack.zip…");
    expect(document.activeElement).toBe(buttonByText("换封面", dialog()));

    // 读完之后焦点不被新内容打断
    await act(async () => {
      gate.resolve();
      await settle();
    });
    expect(document.activeElement).toBe(buttonByText("换封面", dialog()));
  });

  it("选文件夹时取消什么都不变；选的文件夹读不了时原位写出后端原文，列表状态不变；别的失败交给外层通知", async () => {
    const { IpcError } = await import("../../ipc/errors");
    await mount({ page: "discover", importFile: BLOCKED_PACK });
    await clickIn(dialog(), "查看这些文件");
    pickFolder.mockResolvedValueOnce(null);
    await clickIn(blockedDialog(), "我已下载，重新检查");
    expect(callsOf(ipc, "claim_blocked_files")).toEqual([]);
    expect(blockedRow("blocked-a.jar").textContent).toBe("blocked-a.jar装到 mods/打开网页");

    ipc.overrides.set("claim_blocked_files", () => {
      throw new IpcError("io", "选的文件夹不存在：D:\\nope", { path: "D:\\nope" });
    });
    pickFolder.mockResolvedValueOnce("D:\\nope");
    await clickIn(blockedDialog(), "我已下载，重新检查");
    expect(blockedDialog().textContent).toContain("选的文件夹不存在：D:\\nope");
    expect(blockedRow("blocked-a.jar").textContent).toBe("blocked-a.jar装到 mods/打开网页");
    expect(launcher.state.toasts.filter((t) => t.tone === "error")).toEqual([]);

    ipc.overrides.set("claim_blocked_files", () => {
      throw new IpcError("invalid_argument", "file_id 5000001 出现了不止一次");
    });
    await clickIn(blockedDialog(), "我已下载，重新检查");
    expect(launcher.state.toasts.find((t) => t.title === "没能检查下载好的文件")?.body).toBe("file_id 5000001 出现了不止一次");
  });

  it("系统对话框弹出之前连点「我已下载，重新检查」只弹一个；用户取消后可以再检查一次", async () => {
    const picked = deferred<string | null>();
    pickFolder.mockImplementationOnce(() => picked.promise);
    await mount({ page: "discover", importFile: BLOCKED_PACK });
    await clickIn(dialog(), "查看这些文件");
    await clickIn(blockedDialog(), "我已下载，重新检查");
    await clickIn(blockedDialog(), "我已下载，重新检查");
    expect(pickFolder).toHaveBeenCalledTimes(1);

    await act(async () => {
      picked.resolve(null);
      await settle();
    });
    await clickIn(blockedDialog(), "我已下载，重新检查");
    expect(pickFolder).toHaveBeenCalledTimes(2);
    expect(callsOf(ipc, "claim_blocked_files")).toHaveLength(1);
  });

  it("取下载文件夹失败后还能再检查一次：通知交给外层，这次检查不留下占位", async () => {
    const { IpcError } = await import("../../ipc/errors");
    ipc.overrides.set("downloads_folder", () => {
      throw new IpcError("io", "找不到系统的下载文件夹");
    });
    await mount({ page: "discover", importFile: BLOCKED_PACK });
    await clickIn(dialog(), "查看这些文件");
    await clickIn(blockedDialog(), "我已下载，重新检查");
    expect(launcher.state.toasts.find((t) => t.title === "没能检查下载好的文件")?.body).toBe("找不到系统的下载文件夹");
    expect(pickFolder).not.toHaveBeenCalled();

    ipc.overrides.set("downloads_folder", () => MOCK_DOWNLOADS_DIR);
    await clickIn(blockedDialog(), "我已下载，重新检查");
    expect(pickFolder).toHaveBeenCalledTimes(1);
  });

  it("等系统对话框期间关掉了清单：选好文件夹也不再认领", async () => {
    const picked = deferred<string | null>();
    pickFolder.mockImplementationOnce(() => picked.promise);
    await mount({ page: "discover", importFile: BLOCKED_PACK });
    await clickIn(dialog(), "查看这些文件");
    await clickIn(blockedDialog(), "我已下载，重新检查");
    await clickIn(blockedDialog(), "关闭");
    await act(async () => {
      picked.resolve(MOCK_DOWNLOADS_DIR);
      await settle();
    });
    expect(callsOf(ipc, "claim_blocked_files")).toEqual([]);
  });

  it("检查中：主按钮写「正在检查…」，行内「打开网页」不能点；关掉清单不打断检查，晚到的结果丢弃，再打开从头开始", async () => {
    const gate = deferred<unknown>();
    ipc.overrides.set("claim_blocked_files", () => gate.promise);
    await mount({ page: "discover", importFile: BLOCKED_PACK });
    await clickIn(dialog(), "查看这些文件");
    await clickIn(blockedDialog(), "我已下载，重新检查");
    expect(buttonByText("正在检查…", blockedDialog()).getAttribute("aria-busy")).toBe("true");
    const openButtons = [...blockedDialog().querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.textContent === "打开网页");
    expect(openButtons.map((b) => b.getAttribute("aria-disabled"))).toEqual(["true", "true"]);
    act(() => openButtons[0].click());
    expect(callsOf(ipc, "plugin:opener|open_url")).toEqual([]);

    await clickIn(blockedDialog(), "关闭");
    await act(async () => {
      gate.resolve({ claimed: [{ file_id: 5000001, source_path: "x" }], missing: [5000002] });
      await settle();
    });
    await clickIn(dialog(), "查看这些文件");
    expect(blockedRow("blocked-a.jar").textContent).toBe("blocked-a.jar装到 mods/打开网页");
    expect(blockedRow("blocked-b.jar").textContent).toBe("blocked-b.jar装到 mods/打开网页");
    expect(buttonByText("我已下载，重新检查", blockedDialog()).getAttribute("aria-busy")).toBeNull();
  });

  it("「打开网页」聚焦着时开始检查：焦点留在按钮上；这个文件找到后按钮消失，焦点交给主按钮，没找到的行照旧", async () => {
    onTestFinished(emulateFocusFixup());
    seedMockDownloads(["blocked-a.jar"]);
    const gate = deferred<void>();
    ipc.overrides.set("claim_blocked_files", (args) => gate.promise.then(() => mockInvoke("claim_blocked_files", args)));
    await mount({ page: "discover", importFile: BLOCKED_PACK });
    await clickIn(dialog(), "查看这些文件");
    const web = buttonByText("打开网页", blockedRow("blocked-a.jar"));
    act(() => web.focus());
    await clickIn(blockedDialog(), "我已下载，重新检查");
    expect(web.disabled).toBe(false);
    expect(document.activeElement).toBe(web);

    await act(async () => {
      gate.resolve();
      await settle();
    });
    expect(shownText(blockedRow("blocked-a.jar"))).toBe("blocked-a.jar装到 mods/已找到");
    expect(document.activeElement).toBe(buttonByText("我已下载，重新检查", blockedDialog()));

    // 还在的那一行不受影响：焦点在它上面时检查完留在原处
    const other = buttonByText("打开网页", blockedRow("blocked-b.jar"));
    act(() => other.focus());
    ipc.overrides.delete("claim_blocked_files");
    await clickIn(blockedDialog(), "我已下载，重新检查");
    expect(shownText(blockedRow("blocked-b.jar"))).toBe("blocked-b.jar装到 mods/还没找到打开网页");
    expect(document.activeElement).toBe(other);
  });

  it("平台整合包以 distribution_blocked 失败：面板写出个数，「查看这些文件」打开清单，「打开网页」用系统浏览器打开文件页；都找到后重新安装", async () => {
    const { IpcError } = await import("../../ipc/errors");
    const opened = vi.fn();
    vi.stubGlobal("open", opened);
    const pack = entry("M1", { title: "生存", resource_type: "modpack", loaders: ["fabric"] });
    const v = modVersion("mp-1", { project_id: "M1", version_number: "2.0.0", loaders: ["fabric"], game_versions: ["1.20.1"] });
    pages = () => result([pack]);
    ipc.overrides.set("project_detail", () => detailOf(pack, { latest_version: v }));
    ipc.overrides.set("list_mod_versions", () => ({ versions: [v], truncated: false }));
    ipc.overrides.set("summarize_platform_modpack", () => new Promise(() => {}));
    let attempts = 0;
    ipc.overrides.set("install_modpack", () => {
      attempts += 1;
      if (attempts === 1) throw new IpcError("distribution_blocked", "这些文件的作者不允许启动器直接下载，需要到 CurseForge 网页手动下载：blocked-a.jar、blocked-b.jar", { files: FILES });
      return new Promise(() => {});
    });
    await mount();
    act(() => card("生存").click());
    await flush();
    await clickIn(dialog(), "安装为新实例");
    expect(dialog().textContent).toContain("没装成：有 2 个文件需要到 CurseForge 网页手动下载");
    expect(launcher.state.tasks[0].error).toEqual({ code: "distribution_blocked", message: expect.any(String), blocked_files: FILES });
    expect([...dialog().querySelectorAll("button")].some((b) => b.textContent === "重试")).toBe(false);

    await clickIn(dialog(), "查看这些文件");
    await clickIn(blockedRow("blocked-b.jar"), "打开网页");
    expect(callsOf(ipc, "plugin:opener|open_url")).toEqual([{ url: FILES[1].web_url }]);
    expect(opened).toHaveBeenCalledWith(FILES[1].web_url, "_blank", "noopener,noreferrer");

    seedMockDownloads(["Blocked-A.jar", "blocked-b.JAR"]);
    await clickIn(blockedDialog(), "我已下载，重新检查");
    expect(blockedDialog().textContent).toContain("2 个文件都已找到。");
    await clickIn(blockedDialog(), "重新安装");
    const installs = callsOf(ipc, "install_modpack");
    expect(installs).toHaveLength(2);
    const { taskId: firstId, ...firstArgs } = installs[0];
    const { taskId: secondId, ...secondArgs } = installs[1];
    expect(secondArgs).toEqual(firstArgs);
    expect([firstId, secondId]).toEqual([`${launcher.state.tasks[0].id}#1`, `${launcher.state.tasks[0].id}#2`]);
    expect(launcher.state.tasks[0]).toMatchObject({ status: "running", attempt: 2, error: null });
    expect(openDialogs()).toHaveLength(1);
  });

  it("清单开着时任务已被别处重试并取消：「重新安装」重排不了，失败报出来，不悄悄没反应", async () => {
    const { IpcError } = await import("../../ipc/errors");
    const pack = entry("M1", { title: "生存", resource_type: "modpack", loaders: ["fabric"] });
    const v = modVersion("mp-1", { project_id: "M1", version_number: "2.0.0", loaders: ["fabric"], game_versions: ["1.20.1"] });
    pages = () => result([pack]);
    ipc.overrides.set("project_detail", () => detailOf(pack, { latest_version: v }));
    ipc.overrides.set("list_mod_versions", () => ({ versions: [v], truncated: false }));
    ipc.overrides.set("summarize_platform_modpack", () => new Promise(() => {}));
    let attempts = 0;
    ipc.overrides.set("install_modpack", () => {
      attempts += 1;
      if (attempts === 1) throw new IpcError("distribution_blocked", "原文", { files: FILES });
      throw cancelledError();
    });
    await mount();
    act(() => card("生存").click());
    await flush();
    await clickIn(dialog(), "安装为新实例");
    await clickIn(dialog(), "查看这些文件");
    seedMockDownloads(["blocked-a.jar", "blocked-b.jar"]);
    await clickIn(blockedDialog(), "我已下载，重新检查");

    const { id } = launcher.state.tasks[0];
    await act(async () => {
      launcher.actions.retryTask(id);
      await settle();
    });
    expect(launcher.state.tasks[0].status).toBe("cancelled");
    await clickIn(blockedDialog(), "重新安装");
    expect(launcher.state.toasts.find((t) => t.title === "没能加入下载队列")?.body).toBe(`任务 ${id} 是 cancelled，只有失败的任务能重试`);
  });

  it("清单里的文件都找到后断网：重新安装与面板的重试同一口径，只提示恢复联网后再装，不把任务重新排进队列", async () => {
    const { IpcError } = await import("../../ipc/errors");
    const pack = entry("M1", { title: "生存", resource_type: "modpack", loaders: ["fabric"] });
    const v = modVersion("mp-1", { project_id: "M1", version_number: "2.0.0", loaders: ["fabric"], game_versions: ["1.20.1"] });
    pages = () => result([pack]);
    ipc.overrides.set("project_detail", () => detailOf(pack, { latest_version: v }));
    ipc.overrides.set("list_mod_versions", () => ({ versions: [v], truncated: false }));
    ipc.overrides.set("summarize_platform_modpack", () => new Promise(() => {}));
    ipc.overrides.set("install_modpack", () => {
      throw new IpcError("distribution_blocked", "这些文件的作者不允许启动器直接下载，需要到 CurseForge 网页手动下载：blocked-a.jar、blocked-b.jar", { files: FILES });
    });
    await mount();
    act(() => card("生存").click());
    await flush();
    await clickIn(dialog(), "安装为新实例");
    await clickIn(dialog(), "查看这些文件");
    seedMockDownloads(["blocked-a.jar", "blocked-b.jar"]);
    await clickIn(blockedDialog(), "我已下载，重新检查");
    expect(blockedDialog().textContent).toContain("2 个文件都已找到。");

    online = false;
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    await clickIn(blockedDialog(), "重新安装");
    expect(launcher.state.tasks.map((t) => [t.status, t.attempt])).toEqual([["failed", 1]]);
    expect(callsOf(ipc, "install_modpack")).toHaveLength(1);
    expect(launcher.state.toasts.map((t) => [t.tone, t.title, t.body])).toContainEqual(["warning", "没有网络连接", "恢复联网后再安装"]);
  });

  it("作者不允许启动器下载的 Mod：说明块里的「打开网页」用系统浏览器打开工程页，打不开时报出来；安装按钮禁用", async () => {
    const { IpcError } = await import("../../ipc/errors");
    vi.stubGlobal("open", vi.fn());
    const mod = entry("M1", { title: "受限 Mod", resource_type: "mod", loaders: ["fabric"] });
    const url = "https://www.curseforge.com/minecraft/mc-mods/locked";
    pages = () => result([mod]);
    ipc.overrides.set("project_detail", () => detailOf(mod, { distribution_allowed: false, page_url: url }));
    ipc.overrides.set("list_mod_versions", () => ({ versions: [], truncated: false }));
    await mount();
    act(() => card("受限 Mod").click());
    await flush();
    expect(dialog().textContent).toContain("作者不允许在启动器里下载这个资源，只能去 CurseForge 网页下载。");
    expect(buttonByText("安装", dialog()).disabled).toBe(true);

    await clickIn(dialog(), "打开网页");
    expect(callsOf(ipc, "plugin:opener|open_url")).toEqual([{ url }]);

    ipc.overrides.set("plugin:opener|open_url", () => {
      throw new IpcError("internal", "没有默认浏览器");
    });
    await clickIn(dialog(), "打开网页");
    expect(launcher.state.toasts.find((t) => t.title === "没能打开网页")?.body).toBe("没有默认浏览器");
  });

  it("Mod 的安装面板一步至多一条说明块：判断失败留作说明块，手动下载写成行，重试与打开网页的入口都还在", async () => {
    const { IpcError } = await import("../../ipc/errors");
    vi.stubGlobal("open", vi.fn());
    const mod = entry("M1", { title: "受限 Mod", resource_type: "mod", loaders: ["fabric"] });
    pages = () => result([mod]);
    ipc.overrides.set("project_detail", () => detailOf(mod, { distribution_allowed: false, page_url: "https://www.curseforge.com/minecraft/mc-mods/locked" }));
    ipc.overrides.set("list_mod_versions", () => ({ versions: [], truncated: false }));
    let failing = true;
    ipc.overrides.set("match_instances", () => {
      if (failing) throw new IpcError("network_failed", "连接超时");
      return [];
    });
    await mount();
    act(() => card("受限 Mod").click());
    await flush();

    const panel = dialog().querySelector("aside") as HTMLElement;
    const callouts = () => [...panel.querySelectorAll<HTMLElement>('[class*="_callout_"]')];
    const rows = () => [...panel.querySelectorAll<HTMLElement>('[class*="_warnNote_"]')];
    expect(callouts().map((el) => [el.dataset.tone, el.textContent])).toEqual([["danger", "没能判断能装进哪些实例连接超时重试"]]);
    expect(rows().map((el) => el.textContent)).toEqual(["作者不允许在启动器里下载这个资源，只能去 CurseForge 网页下载。打开网页"]);

    failing = false;
    act(() => buttonByText("重试", panel).click());
    await flush();
    expect(callouts().map((el) => [el.dataset.tone, el.textContent])).toEqual([["warn", "作者不允许在启动器里下载这个资源，只能去 CurseForge 网页下载。打开网页"]]);
    expect(rows()).toEqual([]);
  });

  it("介绍末尾的「在网页上打开」用系统浏览器打开工程页，打不开时报出来", async () => {
    const { IpcError } = await import("../../ipc/errors");
    const mod = entry("M1", { title: "有工程页", resource_type: "mod", loaders: ["fabric"] });
    const url = "https://modrinth.com/mod/sodium";
    pages = () => result([mod]);
    ipc.overrides.set("project_detail", () => detailOf(mod, { page_url: url }));
    ipc.overrides.set("list_mod_versions", () => ({ versions: [], truncated: false }));
    await mount();
    act(() => card("有工程页").click());
    await flush();

    await clickIn(dialog(), "在网页上打开");
    expect(callsOf(ipc, "plugin:opener|open_url")).toEqual([{ url }]);
    expect(launcher.state.toasts.filter((t) => t.tone === "error")).toEqual([]);

    ipc.overrides.set("plugin:opener|open_url", () => {
      throw new IpcError("internal", "没有默认浏览器");
    });
    await clickIn(dialog(), "在网页上打开");
    expect(launcher.state.toasts.filter((t) => t.tone === "error").map((t) => [t.title, t.body])).toEqual([["没能打开网页", "没有默认浏览器"]]);
  });

  describe("整合包本体要手动下载时的提前说明", () => {
    const NOTE = "作者不允许启动器直接下载这个整合包。开始安装后会列出要到 CurseForge 网页手动下载的文件。";
    const LISTED = "作者不允许启动器直接下载这个整合包，需要到 CurseForge 网页手动下载。";
    const SUMMARY_FAILED = "整合包清单没能提前读出来";
    const BODY = {
      project_id: 700,
      file_id: 7001,
      file_name: "生存 2.0.0.zip",
      web_url: "https://www.curseforge.com/minecraft/modpacks/survival/files/7001",
      destination: "生存 2.0.0.zip",
      sha1: "3f786850e387550fdab836ed7e6dc881de23001b",
      fingerprint: 0,
      size: 2048,
    };

    async function openPack(allowed: boolean, summary: () => unknown) {
      const pack = entry("M1", { title: "生存", resource_type: "modpack", loaders: ["fabric"] });
      const v = modVersion("mp-1", { project_id: "M1", version_number: "2.0.0", loaders: ["fabric"], game_versions: ["1.20.1"] });
      pages = () => result([pack]);
      ipc.overrides.set("project_detail", () => detailOf(pack, { latest_version: v, distribution_allowed: allowed }));
      ipc.overrides.set("list_mod_versions", () => ({ versions: [v], truncated: false }));
      ipc.overrides.set("summarize_platform_modpack", summary);
      await mount();
      act(() => card("生存").click());
      await flush();
    }

    const READY_SUMMARY = {
      name: "生存",
      version: "2.0.0",
      minecraft: "1.20.1",
      loader: { kind: "fabric", version: "0.16.5" },
      format: "curseforge",
      pack_bytes: 2048,
      remote_files: 2,
      mod_files: 2,
      remote_bytes: 4096,
      override_files: 0,
      override_bytes: 0,
    };

    const blockedSummary = async () => {
      const { IpcError } = await import("../../ipc/errors");
      throw new IpcError("distribution_blocked", "这些文件的作者不允许启动器直接下载，需要到 CurseForge 网页手动下载：生存 2.0.0.zip", { files: [BODY] });
    };

    it("摘要报本体受限：只说要手动下载，不当成清单读不出来，也不给重试；安装照常能点，点了走手动下载", async () => {
      await openPack(false, blockedSummary);
      expect(dialog().textContent).toContain(LISTED);
      expect(dialog().textContent).not.toContain(NOTE);
      expect(dialog().textContent).not.toContain(SUMMARY_FAILED);
      expect([...dialog().querySelectorAll("button")].some((b) => b.textContent === "重试")).toBe(false);

      const { IpcError } = await import("../../ipc/errors");
      ipc.overrides.set("install_modpack", () => {
        throw new IpcError("distribution_blocked", "原文", { files: [BODY] });
      });
      await clickIn(dialog(), "安装为新实例");
      expect(dialog().textContent).toContain("没装成：有 1 个文件需要到 CurseForge 网页手动下载");
      expect(dialog().textContent).not.toContain(LISTED);
      expect(buttonByText("查看这些文件", dialog())).toBeDefined();
    });

    it("工程允许下载、这个版本的本体受限：以摘要为准，同样提前说明", async () => {
      await openPack(true, blockedSummary);
      expect(dialog().textContent).toContain(LISTED);
      expect(dialog().textContent).not.toContain(SUMMARY_FAILED);
    });

    it("安装前就能打开清单：认领到本体后摘要重读，说明收起、Mod 数出来，没有发起安装", async () => {
      let claimed = false;
      await openPack(false, () => (claimed ? READY_SUMMARY : blockedSummary()));
      ipc.overrides.set("claim_blocked_files", () => {
        claimed = true;
        return { claimed: [{ file_id: 7001, source_path: `${MOCK_DOWNLOADS_DIR}\\生存 2.0.0 (1).zip` }], missing: [] };
      });

      await clickIn(dialog(), "查看这些文件");
      expect(blockedRow("生存 2.0.0.zip").textContent).not.toContain("装到");
      await clickIn(blockedDialog(), "我已下载，重新检查");
      expect(callsOf(ipc, "summarize_platform_modpack")).toHaveLength(2);
      await clickIn(blockedDialog(), "继续导入");

      expect(dialog().textContent).not.toContain(LISTED);
      expect(dialog().textContent).toContain("2 个 Mod");
      expect(callsOf(ipc, "install_modpack")).toEqual([]);
    });

    it("认领完不点继续、直接关掉清单：摘要照样已经重读过", async () => {
      let claimed = false;
      await openPack(false, () => (claimed ? READY_SUMMARY : blockedSummary()));
      ipc.overrides.set("claim_blocked_files", () => {
        claimed = true;
        return { claimed: [{ file_id: 7001, source_path: `${MOCK_DOWNLOADS_DIR}\\生存 2.0.0 (1).zip` }], missing: [] };
      });

      await clickIn(dialog(), "查看这些文件");
      await clickIn(blockedDialog(), "我已下载，重新检查");
      await clickIn(blockedDialog(), "关闭");

      expect(dialog().textContent).not.toContain(LISTED);
    });

    it("清单里没找到本体：摘要不重读，说明还在", async () => {
      await openPack(false, blockedSummary);
      ipc.overrides.set("claim_blocked_files", () => ({ claimed: [], missing: [7001] }));

      await clickIn(dialog(), "查看这些文件");
      await clickIn(blockedDialog(), "我已下载，重新检查");

      expect(callsOf(ipc, "summarize_platform_modpack")).toHaveLength(1);
      expect(dialog().textContent).toContain(LISTED);
    });

    it("工程标着不允许、摘要还没到：先按工程标记说明，还没有清单可开", async () => {
      await openPack(false, () => new Promise(() => {}));
      expect(dialog().textContent).toContain(NOTE);
      expect([...dialog().querySelectorAll("button")].some((b) => b.textContent === "查看这些文件")).toBe(false);
    });

    it("工程标着不允许、这个版本的摘要读到了：本体拿得到，不说明", async () => {
      await openPack(false, () => READY_SUMMARY);
      expect(dialog().textContent).not.toContain(NOTE);
      expect(dialog().textContent).not.toContain(SUMMARY_FAILED);
    });

    it("工程允许、摘要因别的原因失败：照旧写清单读不出来并给重试，不说要手动下载", async () => {
      const { IpcError } = await import("../../ipc/errors");
      await openPack(true, () => Promise.reject(new IpcError("network_failed", "连接超时")));
      expect(dialog().textContent).not.toContain(NOTE);
      expect(dialog().textContent).toContain(SUMMARY_FAILED);
      expect(buttonByText("重试", dialog())).toBeDefined();
    });
  });

  it("CurseForge 整合包本体就需要手动下载：清单照常列出这个包，不写落点目录；找到后重新安装", async () => {
    const { IpcError } = await import("../../ipc/errors");
    const PACK: BlockedFileDto[] = [
      {
        project_id: 700,
        file_id: 7001,
        file_name: "生存 2.0.0.zip",
        web_url: "https://www.curseforge.com/minecraft/modpacks/survival/files/7001",
        destination: "生存 2.0.0.zip",
        sha1: "3f786850e387550fdab836ed7e6dc881de23001b",
        fingerprint: 0,
        size: 2048,
      },
    ];
    const pack = entry("M1", { title: "生存", resource_type: "modpack", loaders: ["fabric"] });
    const v = modVersion("mp-1", { project_id: "M1", version_number: "2.0.0", loaders: ["fabric"], game_versions: ["1.20.1"] });
    pages = () => result([pack]);
    ipc.overrides.set("project_detail", () => detailOf(pack, { latest_version: v }));
    ipc.overrides.set("list_mod_versions", () => ({ versions: [v], truncated: false }));
    ipc.overrides.set("summarize_platform_modpack", () => new Promise(() => {}));
    let attempts = 0;
    ipc.overrides.set("install_modpack", () => {
      attempts += 1;
      if (attempts === 1) throw new IpcError("distribution_blocked", "这些文件的作者不允许启动器直接下载，需要到 CurseForge 网页手动下载：生存 2.0.0.zip", { files: PACK });
      return new Promise(() => {});
    });
    ipc.overrides.set("claim_blocked_files", () => ({ claimed: [{ file_id: 7001, source_path: `${MOCK_DOWNLOADS_DIR}\\生存 2.0.0 (1).zip` }], missing: [] }));
    await mount();
    act(() => card("生存").click());
    await flush();
    await clickIn(dialog(), "安装为新实例");
    expect(dialog().textContent).toContain("没装成：有 1 个文件需要到 CurseForge 网页手动下载");

    await clickIn(dialog(), "查看这些文件");
    const row = blockedRow("生存 2.0.0.zip");
    expect(row.textContent).not.toContain("装到");
    await clickIn(blockedDialog(), "我已下载，重新检查");
    expect(blockedDialog().textContent).toContain("1 个文件都已找到。");
    await clickIn(blockedDialog(), "重新安装");
    expect(callsOf(ipc, "install_modpack")).toHaveLength(2);
  });
});
