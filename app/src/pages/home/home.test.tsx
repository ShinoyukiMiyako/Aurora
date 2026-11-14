// @vitest-environment jsdom
// @module-tag heavy-page
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../art/illustrations/test-canvas";
import type { InstanceDto } from "../../ipc/instances";
import { IpcError } from "../../ipc/errors";
import { GAME_EXIT_EVENT } from "../../ipc/launch";
import { CORE_EVENT } from "../../ipc/tasks";
import { APP_NAME } from "../../lib/app-info";
import type { KnownServerDto, NewsItemDto, PinnedServerDto, PlayDayDto, ServerStatusDto } from "../../state/queries/home";
import { OverlayRoot } from "../../shell/overlay";
import { ShellProvider, useNav, useShell, type NavApi, type ShellApi } from "../../shell/shell";
import { AppearanceProvider, DEFAULT_APPEARANCE } from "../../state/appearance";
import { LauncherProvider, useLauncher, type LauncherApi } from "../../state/launcher";
import { DEFAULT_UI_SHAPE, UI_SHAPE_WRITE_DELAY_MS, UiShapeProvider, type UiShape } from "../../state/ui-shape";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../test/dom";
import type { IpcArgs, IpcRecorder } from "../../test/fake-bridge";
import { accountDto, bootOverrides, callsOf, configDto, deferred, emit, instanceDto, resetRecorder, settle } from "../../test/launcher";
import { RemoteImageProvider } from "../../ui/remote-image";
import s from "./home.module.css";
import HomePage from "./index";
import { world } from "./test-data";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** 2026-10-30 是星期五，下午三点。 */
const NOW = new Date(2026, 9, 30, 15, 0, 0).getTime();

let view: Rendered | undefined;
let nav: NavApi;
let shell: ShellApi;
let launcher: LauncherApi;
let instances: InstanceDto[];
let pinned: PinnedServerDto[];
let writeText: ReturnType<typeof vi.fn>;
/** 启动时读到的界面形状：默认没记过。 */
let shape: UiShape;

function Probe() {
  nav = useNav();
  shell = useShell();
  launcher = useLauncher();
  return null;
}

const flush = () =>
  act(async () => {
    await settle();
  });

async function mount() {
  view = render(
    <AppearanceProvider initial={DEFAULT_APPEARANCE}>
      <UiShapeProvider initial={shape}>
        <LauncherProvider>
          <ShellProvider>
            <RemoteImageProvider resolve={async (url) => url}>
              <Probe />
              <HomePage route={{ page: "home" }} />
            </RemoteImageProvider>
            <OverlayRoot />
          </ShellProvider>
        </LauncherProvider>
      </UiShapeProvider>
    </AppearanceProvider>,
  );
  await flush();
}

function day(date: string, entries: [string, number][]): PlayDayDto {
  return { date, minutes: entries.reduce((t, [, m]) => t + m, 0), instances: entries.map(([version_id, minutes]) => ({ version_id, minutes })) };
}

const PLAY_DAYS: PlayDayDto[] = [
  day("2026-10-20", [["创造", 15]]),
  day("2026-10-26", [["生存", 120]]),
  day("2026-10-28", [["已删除", 30]]),
  day("2026-10-29", [["创造", 40]]),
  day("2026-10-30", [["生存", 95]]),
];

const NEWS: NewsItemDto[] = [
  { id: "n-live", title: "Minecraft Live 回顾", summary: "直播内容一览。", date: NOW - 3 * DAY, tag: "event", thumbnail_url: null, game_version: null },
  { id: "n-1211", title: "Minecraft 1.21.1", summary: "修复若干问题。", date: NOW - DAY, tag: "release", thumbnail_url: null, game_version: "1.21.1" },
  { id: "n-263", title: "Minecraft 26.3", summary: "新的方块与生物。", date: NOW - 2 * DAY, tag: "release", thumbnail_url: null, game_version: "26.3" },
];

const KNOWN = (): KnownServerDto[] => [
  { name: "晨星", address: "play.example", pinned: pinned.some((p) => p.address === "play.example") },
  { name: "本地", address: "localhost", pinned: pinned.some((p) => p.address === "localhost") },
];

function ping(address: string): ServerStatusDto {
  const base = { address, version_name: null, motd: null, favicon: null, checked_at: NOW, error: null };
  if (address === "play.example") {
    return { ...base, reachable: true, latency_ms: 38, online: 127, max: 500, version_name: "Paper 1.21.4", motd: "第六周目开荒中", last_seen_at: NOW, last_online: 127 };
  }
  return { ...base, reachable: false, latency_ms: null, online: null, max: null, last_seen_at: NOW - 2 * HOUR, last_online: 12_000, error: "连接被拒绝" };
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  resetRecorder(ipc);
  shape = DEFAULT_UI_SHAPE;
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
  writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

  instances = [
    instanceDto("生存", { loaders: [{ kind: "fabric", version: "0.16.9" }], mc_version: "1.21.1", playtime_min: 2480, last_played_at: NOW - 2 * MINUTE, mod_count: 78, world_count: 2 }),
    instanceDto("创造", { mc_version: "1.20.1", playtime_min: 60, last_played_at: NOW - 2 * HOUR }),
    instanceDto("空岛", { mc_version: "1.21.1", created_at: NOW - DAY }),
    instanceDto("红石", { mc_version: "1.19.2", playtime_min: 10, last_played_at: NOW - 3 * DAY }),
  ];
  pinned = [{ name: "晨星", address: "play.example", instance: null }];
  bootOverrides(ipc, { instances, config: configDto({ selected_version: "生存" }) });
  ipc.overrides.set("list_instances", () => instances);
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("skin_info", () => null);
  ipc.overrides.set("play_stats", (args: IpcArgs) => {
    const range = args.range as { from: string; to: string };
    return { from: range.from, to: range.to, days: PLAY_DAYS, total_minutes: 300, instances: [] };
  });
  ipc.overrides.set("list_news", () => ({ items: NEWS, fetched_at: NOW, offline: false, launcher_error: null }));
  ipc.overrides.set("list_pinned_servers", () => pinned);
  ipc.overrides.set("set_pinned_servers", (args: IpcArgs) => {
    pinned = args.servers as PinnedServerDto[];
    return pinned;
  });
  ipc.overrides.set("list_known_servers", () => KNOWN());
  ipc.overrides.set("ping_servers", () => pinned.map((p) => ping(p.address)));
  ipc.overrides.set("list_instance_content", () => ({
    resource_packs: [],
    shader_packs: [],
    worlds: [world("New World", { name: "海岛据点", last_played: NOW - 2 * MINUTE }), world("旧档", { last_played: NOW - 9 * DAY })],
  }));
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const text = () => document.body.textContent as string;

/** 浏览器报告的联网状态：改返回值后发出对应事件，订阅方立即重算。 */
function setOnline(onLine: boolean) {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(onLine);
  act(() => {
    window.dispatchEvent(new Event(onLine ? "online" : "offline"));
  });
}
/** 窗口最小化或还原：改读数后发出 visibilitychange，宿主把 WebView2 设为不可见或可见时页面收到的就是它。 */
function setPageVisibility(state: DocumentVisibilityState) {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}
const buttonByLabel = (label: string) => {
  const el = document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (el === null) throw new Error(`找不到名称为 ${label} 的元素`);
  return el;
};
const buttonByText = (label: string, root: ParentNode = document) => {
  const el = [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label);
  if (el === undefined) throw new Error(`找不到按钮 ${label}`);
  return el;
};
const click = (el: Element) =>
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
  });
const openMenu = async (trigger: HTMLElement) => {
  act(() => trigger.focus());
  click(trigger);
  await flush();
};
/** 退场动画期间旧菜单还在文档里，取未在退场的那一个。 */
const menuItems = () => [...document.querySelectorAll<HTMLElement>(':not([data-exiting]) > [role="menu"] [role="menuitem"]')];
const menuItem = (prefix: string) => {
  const item = menuItems().find((el) => el.textContent?.startsWith(prefix));
  if (item === undefined) throw new Error(`菜单里找不到 ${prefix}`);
  return item;
};
const dialog = () => {
  const all = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
  return all.length === 0 ? null : all[all.length - 1];
};
const statLabel = (prefix: string) => {
  const el = [...document.querySelectorAll<HTMLElement>('[role="group"][aria-label]')].find((g) => g.getAttribute("aria-label")?.startsWith(prefix));
  if (el === undefined) throw new Error(`找不到数据块 ${prefix}`);
  return el.getAttribute("aria-label");
};
const bar = (datePrefix: string) => {
  const el = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="近 7 天每日游玩时长"] button')].find((b) => b.getAttribute("aria-label")?.startsWith(datePrefix));
  if (el === undefined) throw new Error(`找不到 ${datePrefix} 的柱子`);
  return el;
};

describe("主页：问候与继续游玩", () => {
  it("问候当前账户，底栏是今天的时长与连续天数", async () => {
    await mount();
    expect(document.querySelector("h1")?.textContent).toBe("下午好，Steve");
    expect(text()).toContain("10月30日 · 星期五");
    expect(text()).toContain("离线账户");
    expect(text()).toContain("1 小时 35 分钟今天");
    expect(text()).toContain("3 天连续游玩");
  });

  it("大卡显示当前实例的名称、版本、加载器、Mod 数、累计时长与最近玩的存档", async () => {
    await mount();
    expect(document.querySelector("h2")?.textContent).toBe("生存");
    expect(text()).toContain("上次 2 分钟前");
    for (const fragment of ["1.21.1", "Fabric", "0.16.9", "78 个 Mod", "累计 41 小时 20 分钟", "存档「海岛据点」"]) expect(text()).toContain(fragment);
  });

  it("实例一个存档都没有：不读存档目录，信息行只写累计时长；游戏退出后数到了新存档才去读", async () => {
    instances = instances.map((i) => (i.id === "生存" ? { ...i, world_count: 0 } : i));
    await mount();
    expect(callsOf(ipc, "list_instance_content")).toEqual([]);
    expect(text()).toContain("累计 41 小时 20 分钟");
    expect(text()).not.toContain("存档「");

    instances = instances.map((i) => (i.id === "生存" ? { ...i, world_count: 1, last_played_at: NOW } : i));
    act(() => emit(GAME_EXIT_EVENT, { version_id: "生存", exit_code: 0, crashed: false, killed: false, duration_ms: 30 * MINUTE }));
    await flush();
    expect(callsOf(ipc, "list_instance_content")).toEqual([{ id: "生存" }]);
    expect(text()).toContain("存档「海岛据点」");
  });

  it("大卡落到缺版本 JSON 的实例且存档数不出来：工作目录解析不出来，不读存档目录，也不弹错误", async () => {
    instances = instances.map((i) => (i.id === "生存" ? { ...i, status: "broken", broken_reason: "缺少版本 JSON", mc_version: null, world_count: null, mod_count: null } : i));
    ipc.overrides.set("list_instance_content", () => {
      throw new IpcError("instance_failed", "实例 生存 的版本 JSON 不可用：缺少版本 JSON");
    });
    await mount();
    expect(document.querySelector("h2")?.textContent).toBe("生存");
    expect(callsOf(ipc, "list_instance_content")).toEqual([]);
    expect(launcher.state.toasts).toEqual([]);
  });

  it("未完成但版本 JSON 还在的实例数得出存档：照常读，信息行写存档名", async () => {
    instances = instances.map((i) =>
      i.id === "生存" ? { ...i, incomplete: { kind: "repair", outcome: "pending", started_at: NOW - MINUTE, spec: null, error: null }, world_count: 2 } : i,
    );
    await mount();
    expect(callsOf(ipc, "list_instance_content")).toEqual([{ id: "生存" }]);
    expect(text()).toContain("存档「海岛据点」");
  });

  it("整合包实例：大卡挂出整合包名与版本，让出 Mod 数", async () => {
    instances = instances.map((i) =>
      i.id === "生存" ? { ...i, modpack: { platform: "modrinth", project_id: "1KVo5zza", version_id: "v6", name: "Fabulously Optimized", version: "6.2.0" } } : i,
    );
    await mount();
    const meta = document.querySelector("h2")?.nextElementSibling as HTMLElement;
    expect([...meta.children].map((el) => el.textContent)).toEqual(["1.21.1", "Fabric0.16.9", "Fabulously Optimized 6.2.0"]);
    expect(text()).not.toContain("78 个 Mod");
  });

  it("换一个：当前项禁用并标「当前」，选另一个写入配置并就地换成它", async () => {
    await mount();
    await openMenu(buttonByText("换一个"));
    expect(menuItems().map((el) => el.textContent)).toEqual(["生存当前", "创造1.20.1", "空岛1.21.1", "红石1.19.2", "全部实例"]);
    expect(menuItem("生存").getAttribute("aria-disabled")).toBe("true");
    click(menuItem("创造"));
    await flush();
    expect(callsOf(ipc, "update_config")).toContainEqual({ selectedVersion: "创造" });
    expect(launcher.state.selectedInstanceId).toBe("创造");
    // 旧面在淡出期间还留在文档里（jsdom 不跑完退场），新面已经挂上
    expect([...document.querySelectorAll("h2")].map((h) => h.textContent)).toContain("创造");
  });

  it("没有账户：写「还没有登录账户」，「添加账户」去账户页；没有实例：空状态的主按钮打开新建流程", async () => {
    bootOverrides(ipc, { accounts: [], instances: [] });
    instances = [];
    await mount();
    expect(document.querySelector("h1")?.textContent).toBe("下午好");
    expect(text()).toContain("还没有登录账户");
    expect(text()).toContain("还没有可以继续的实例");
    // 最近游玩在加载期间占过位，列表到了一个都没有就整段退场；退场中的那一段还在文档里淡出（带 inert），不算
    expect([...document.querySelectorAll('section[aria-labelledby="home-recent-title"]')].filter((el) => el.closest("[inert]") === null)).toEqual([]);
    click(buttonByText("新建实例"));
    expect(shell.createInstance).toEqual({ open: true, preset: null });
    click(buttonByText("添加账户"));
    expect(nav.route).toEqual({ page: "accounts" });
  });
});

describe("主页：当前目录没有实例", () => {
  const dir = (name: string, version_count: number | null, extra: { is_current?: boolean; available?: boolean } = {}) => ({
    name,
    path: `D:\\${name}\\.minecraft`,
    is_current: extra.is_current === true,
    available: extra.available !== false,
    version_count,
  });
  const current = dir("默认目录", 0, { is_current: true });

  beforeEach(() => {
    bootOverrides(ipc, { instances: [] });
    instances = [];
  });

  it("别的目录里有版本：点名它，主按钮切过去，新建实例退为次按钮", async () => {
    ipc.overrides.set("list_game_directories", () => [current, dir("HMCL", 3), dir("PCL2", 12)]);
    await mount();
    expect(text()).toContain("这个目录还没有实例");
    expect(text()).toContain("「PCL2」里有 12 个版本，切过去就能玩，文件不会被移动。");
    expect(text()).not.toContain("还没有可以继续的实例");
    expect(buttonByText("切到 PCL2").getAttribute("data-variant")).toBe("primary");
    expect(buttonByText("新建实例").getAttribute("data-variant")).toBe("secondary");
  });

  it("主按钮走切换流程：确认之后才切到那个目录", async () => {
    ipc.overrides.set("list_game_directories", () => [current, dir("PCL2", 12)]);
    await mount();
    click(buttonByText("切到 PCL2"));
    await flush();
    expect(text()).toContain("切换到「PCL2」？");
    expect(callsOf(ipc, "set_game_directory")).toEqual([]);
    click(buttonByText("切换"));
    await flush();
    expect(callsOf(ipc, "set_game_directory")).toEqual([{ path: "D:\\PCL2\\.minecraft" }]);
  });

  it("别的目录空着、访问不到或读不到版本数：维持原来的说法", async () => {
    ipc.overrides.set("list_game_directories", () => [current, dir("空的", 0), dir("移动硬盘", 30, { available: false }), dir("读不到", null)]);
    await mount();
    expect(text()).toContain("还没有可以继续的实例");
    expect(text()).not.toContain("切到");
    expect(buttonByText("新建实例").getAttribute("data-variant")).toBe("primary");
  });

  it("目录列表读不出：不挡新建实例", async () => {
    ipc.overrides.set("list_game_directories", () => {
      throw new IpcError("io", "读不出");
    });
    await mount();
    expect(text()).toContain("还没有可以继续的实例");
    expect(buttonByText("新建实例").getAttribute("data-variant")).toBe("primary");
  });

  it("有实例时不读目录列表：探测目录要摸盘", async () => {
    bootOverrides(ipc, { instances: [instanceDto("生存")] });
    instances = [instanceDto("生存")];
    await mount();
    expect(callsOf(ipc, "list_game_directories")).toEqual([]);
  });
});

describe("主页：最近游玩", () => {
  it("排除大卡上的实例与没玩过的，按上次游玩倒序；点卡片进详情", async () => {
    await mount();
    const titles = [...document.querySelectorAll<HTMLButtonElement>('section[aria-labelledby="home-recent-title"] button[aria-label^="打开「"]')].map((b) => b.textContent);
    expect(titles).toEqual(["创造", "红石"]);
    expect(text()).toContain("2 小时前 · 原版");
    click(buttonByLabel("打开「红石」"));
    expect(nav.route).toEqual({ page: "instance", id: "红石", tab: "overview" });
  });

  /** 在场的最近游玩段：退场中的那一段（包在带 inert 的层里）不算。 */
  const recentSection = () =>
    [...document.querySelectorAll<HTMLElement>('section[aria-labelledby="home-recent-title"]')].find((el) => el.closest("[inert]:not(section)") === null) ?? null;
  /** 推迟实例列表的读取，返回放行函数。 */
  const holdInstances = () => {
    let release: () => void = () => {
      throw new Error("实例列表的读取还没发出");
    };
    ipc.overrides.set("list_instances", () => new Promise<InstanceDto[]>((resolve) => (release = () => resolve(instances))));
    return () =>
      act(async () => {
        release();
        await settle();
      });
  };

  /** 在场段落里骨架层（整层 aria-hidden）中的骨架卡数。 */
  const skeletonCards = () => {
    const grid = recentSection()?.querySelector(`[aria-hidden="true"] > .${s.recentGrid}`);
    if (grid === null || grid === undefined) throw new Error("最近游玩没有骨架网格");
    return grid.children.length;
  };
  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });

  // 段落夹在两排卡片之间：加载期间不占位的话，列表一到整段插进来，下面一排被一帧顶下去
  it("实例列表晚到：加载期间整段原位占着（前 300 ms 隐身、不可交互），读出来后在同一个段落里换成卡片", async () => {
    shape = { recentCards: 2, repairBanner: false };
    const release = holdInstances();
    await mount();
    const held = recentSection();
    if (held === null) throw new Error("实例列表还在读，最近游玩却没有占位");
    expect(held.hasAttribute("data-pending")).toBe(true);
    expect(held.hasAttribute("inert")).toBe(true);
    expect(held.querySelector('[aria-busy="true"]')).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(held.hasAttribute("data-pending")).toBe(false);
    expect(held.hasAttribute("inert")).toBe(false);

    await release();
    // 骨架出现后至少停留 300 ms
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(recentSection()).toBe(held);
    const titles = [...held.querySelectorAll<HTMLButtonElement>('button[aria-label^="打开「"]')].map((b) => b.textContent);
    expect(titles).toEqual(["创造", "红石"]);
  });

  it("换一个：成了大卡的那张原地淡出（带 inert），原来的大卡加入，留下的卡是同一个节点、滑到新位置", async () => {
    await mount();
    const cardOf = (name: string) => buttonByLabel(`打开「${name}」`).closest<HTMLElement>("[class]:not(button)");
    const kept = cardOf("红石");
    await openMenu(buttonByText("换一个"));
    click(menuItem("创造"));
    await flush();
    const section = recentSection() as HTMLElement;
    const cards = [...section.querySelectorAll<HTMLButtonElement>('button[aria-label^="打开「"]')];
    expect(cards.filter((b) => b.closest("[inert]") === null).map((b) => b.textContent)).toEqual(["生存", "红石"]);
    expect(cards.filter((b) => b.closest("[inert]") !== null).map((b) => b.textContent)).toEqual(["创造"]);
    expect(cardOf("红石")).toBe(kept);
  });

  it("实例列表晚到且除大卡外一个都没玩过：照记下的形状占位的段落退场让出位置，不留空白，记下 0 张", async () => {
    shape = { recentCards: 2, repairBanner: false };
    instances = instances.map((i) => (i.id === "生存" ? i : { ...i, last_played_at: null }));
    const release = holdInstances();
    await mount();
    expect(recentSection()).not.toBeNull();
    await release();
    expect(recentSection()).toBeNull();
    await advance(UI_SHAPE_WRITE_DELAY_MS);
    expect(callsOf(ipc, "set_ui_shape")).toEqual([{ patch: { recent_cards: 0 } }]);
  });

  it("记下 3 张、实例列表还在读：首帧就按 3 张骨架占位，不按这一档的上限 5 张", async () => {
    vi.stubGlobal("innerWidth", 1280);
    shape = { recentCards: 3, repairBanner: false };
    holdInstances();
    await mount();
    expect(shell.tier).toBe("regular");
    expect(skeletonCards()).toBe(3);
  });

  it("记下的张数比这一档放得下的多：按这一档的上限占位", async () => {
    // jsdom 默认 1024 宽，落在 compact 档，上限 4 张
    shape = { recentCards: 6, repairBanner: false };
    holdInstances();
    await mount();
    expect(skeletonCards()).toBe(4);
  });

  it("记下 0 张：实例列表还在读时首帧不画这一段，过了隐身期也不补；读到有卡再出现", async () => {
    const release = holdInstances();
    await mount();
    expect(document.querySelector('section[aria-labelledby="home-recent-title"]')).toBeNull();
    await advance(300);
    expect(document.querySelector('section[aria-labelledby="home-recent-title"]')).toBeNull();
    await release();
    // 加载门已过了隐身期，按骨架的最短停留再等一拍才算读完
    await advance(300);
    const titles = [...(recentSection() as HTMLElement).querySelectorAll<HTMLButtonElement>('button[aria-label^="打开「"]')].map((b) => b.textContent);
    expect(titles).toEqual(["创造", "红石"]);
  });

  it("列表落定后记下这次的张数：攒 1 秒写一次，与记下的不同才写", async () => {
    shape = { recentCards: 3, repairBanner: false };
    const release = holdInstances();
    await mount();
    await release();
    await advance(UI_SHAPE_WRITE_DELAY_MS - 1);
    expect(callsOf(ipc, "set_ui_shape")).toEqual([]);
    await advance(1);
    expect(callsOf(ipc, "set_ui_shape")).toEqual([{ patch: { recent_cards: 2 } }]);
  });

  it("记下的就是这次的张数：不写", async () => {
    shape = { recentCards: 2, repairBanner: false };
    await mount();
    await advance(5 * UI_SHAPE_WRITE_DELAY_MS);
    expect(callsOf(ipc, "set_ui_shape")).toEqual([]);
  });

  it("记下的是最宽一档的张数：compact 档只列 4 张，玩过的有 6 个就记 6", async () => {
    instances = [
      instanceDto("生存", { last_played_at: NOW - MINUTE }),
      ...["一", "二", "三", "四", "五", "六", "七"].map((name, i) => instanceDto(name, { last_played_at: NOW - (i + 2) * HOUR })),
    ];
    await mount();
    const titles = [...(recentSection() as HTMLElement).querySelectorAll<HTMLButtonElement>('button[aria-label^="打开「"]')].map((b) => b.textContent);
    expect(titles).toEqual(["一", "二", "三", "四"]);
    await advance(UI_SHAPE_WRITE_DELAY_MS);
    expect(callsOf(ipc, "set_ui_shape")).toEqual([{ patch: { recent_cards: 6 } }]);
  });

  it("实例列表读取失败：不把失败记成 0 张", async () => {
    shape = { recentCards: 2, repairBanner: false };
    ipc.overrides.set("list_instances", () => {
      throw new IpcError("io_failed", "versions 目录读不出来");
    });
    await mount();
    expect(launcher.state.status.instances.kind).toBe("error");
    await advance(5 * UI_SHAPE_WRITE_DELAY_MS);
    expect(callsOf(ipc, "set_ui_shape")).toEqual([]);
  });

  it("实例列表读取失败后重试：不在的段落不为重读先插进隐身占位，读到有卡再出现", async () => {
    let failing = true;
    let release: () => void = () => {
      throw new Error("重读还没发出");
    };
    ipc.overrides.set("list_instances", () => {
      if (failing) throw new IpcError("io_failed", "versions 目录读不出来");
      return new Promise<InstanceDto[]>((resolve) => (release = () => resolve(instances)));
    });
    await mount();
    expect(launcher.state.status.instances.kind).toBe("error");
    expect(recentSection()).toBeNull();

    failing = false;
    const heroError = [...document.querySelectorAll<HTMLElement>("[data-pad]")].find((card) => card.textContent?.includes("实例列表读不出来"));
    if (heroError === undefined) throw new Error("大卡没有原位报错");
    click(buttonByText("重试", heroError));
    await flush();
    expect(launcher.state.status.instances.kind).toBe("loading");
    expect(recentSection()).toBeNull();
    // 过了隐身期也不补一块骨架：这一段读完之前是什么样就还是什么样
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(recentSection()).toBeNull();

    await act(async () => {
      release();
      await settle();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    const titles = [...(recentSection() as HTMLElement).querySelectorAll<HTMLButtonElement>('button[aria-label^="打开「"]')].map((b) => b.textContent);
    expect(titles).toEqual(["创造", "红石"]);
  });

  it("设置晚于实例列表：大卡指向谁定下来之前最近游玩不出卡，不先排除错的实例再改", async () => {
    let releaseConfig: () => void = () => {
      throw new Error("设置的读取还没发出");
    };
    ipc.overrides.set("get_config", () => new Promise((resolve) => (releaseConfig = () => resolve(configDto({ selected_version: "创造" })))));
    shape = { recentCards: 2, repairBanner: false };
    await mount();
    const held = recentSection();
    if (held === null) throw new Error("设置还在读，记下 2 张的最近游玩却没有占位");
    expect(held.querySelector('button[aria-label^="打开「"]')).toBeNull();
    await act(async () => {
      releaseConfig();
      await settle();
    });
    const titles = [...(recentSection() as HTMLElement).querySelectorAll<HTMLButtonElement>('button[aria-label^="打开「"]')].map((b) => b.textContent);
    expect(titles).toEqual(["生存", "红石"]);
  });

  it("修复连跑两批下载：卡片上的进度环第二批从当批进度重新走，不停在上一批的满格", async () => {
    ipc.overrides.set("repair_instance", () => new Promise(() => undefined));
    await mount();
    await act(async () => {
      await launcher.actions.repairInstance("创造");
      await settle();
    });
    const [task] = launcher.state.tasks;
    const ring = () => {
      const el = document.querySelector<HTMLElement>('section[aria-labelledby="home-recent-title"] [role="progressbar"]');
      if (el === null) throw new Error("最近游玩里没有进度环");
      return el;
    };
    act(() => emit(CORE_EVENT, { kind: "download", task_id: `${task.id}#1`, total: 3, finished: 3, bytes: 3_000, total_bytes: 3_000, speed: 1_000 }));
    await flush();
    expect(ring().getAttribute("aria-valuenow")).toBe("100");
    act(() => emit(CORE_EVENT, { kind: "download", task_id: `${task.id}#1`, total: 40, finished: 2, bytes: 5_000, total_bytes: 100_000, speed: 1_000 }));
    await flush();
    expect(ring().getAttribute("aria-valuenow")).toBe("5");
  });

  it("最近卡换面：开始修复后进度环在同一角接手，换下来的启动钮带 inert 留在原处淡出，点不到", async () => {
    ipc.overrides.set("repair_instance", () => new Promise(() => undefined));
    await mount();
    const card = buttonByLabel("打开「创造」").closest<HTMLElement>("[data-clip]");
    if (card === null) throw new Error("找不到「创造」的最近卡");
    const faces = () => [...card.querySelectorAll<HTMLElement>('[class*="recentFace"]')];
    expect(faces()).toHaveLength(1);
    await act(async () => {
      await launcher.actions.repairInstance("创造");
      await settle();
    });
    const live = faces().filter((f) => !f.hasAttribute("inert"));
    const leaving = faces().filter((f) => f.hasAttribute("inert"));
    expect(live).toHaveLength(1);
    expect(live[0].querySelector('[role="progressbar"]')).not.toBeNull();
    expect(leaving).toHaveLength(1);
    expect(leaving[0].querySelector("button")).not.toBeNull();
  });
});

describe("主页：游玩日历与洞察", () => {
  it("副标题是当月天数与合计；当日详情列出当天玩的实例", async () => {
    await mount();
    expect(text()).toContain("2026年10月 · 5 天 · 共 5 小时");
    expect(text()).toContain("10月30日 · 周五");
    expect(document.querySelector('[aria-label="打开「生存」"]')).not.toBeNull();
  });

  it("洞察：近 7 天、连续天数、常玩加载器与累计时长", async () => {
    await mount();
    expect(statLabel("近 7 天")).toBe("近 7 天 4.8 小时，较前 7 天 +1800%");
    expect(statLabel("连续游玩")).toBe("连续游玩 3 天，继续保持");
    expect(statLabel("常玩加载器")).toBe("常玩加载器 Fabric，近 30 天占 80%");
    expect(statLabel("累计时长")).toBe("累计时长 43 小时，4 个实例");
  });

  it("连续游玩断了：只写 0 天，没有可以「继续保持」的；接上一天又写回来", async () => {
    let days = [day("2026-10-26", [["生存", 120]])];
    ipc.overrides.set("play_stats", (args: IpcArgs) => {
      const range = args.range as { from: string; to: string };
      return { from: range.from, to: range.to, days, total_minutes: 120, instances: [] };
    });
    await mount();
    expect(statLabel("连续游玩")).toBe("连续游玩 0 天");
    expect(text()).not.toContain("继续保持");

    days = [...days, day("2026-10-30", [["生存", 30]])];
    act(() => emit(GAME_EXIT_EVENT, { version_id: "生存", exit_code: 0, crashed: false, killed: false, duration_ms: 30 * MINUTE }));
    await flush();
    expect(statLabel("连续游玩")).toBe("连续游玩 1 天，继续保持");
  });

  it("wide 档：洞察并进第一排，与问候、继续游玩同排，跨 3 列", async () => {
    vi.stubGlobal("innerWidth", 1440);
    await mount();
    const insights = document.querySelector('[aria-label="近 7 天每日游玩时长"]')?.closest<HTMLElement>("[data-span]");
    const greeting = document.querySelector("h1")?.closest<HTMLElement>("[data-span]");
    if (!insights || !greeting) throw new Error("找不到洞察卡或问候卡");
    expect(insights.parentElement).toBe(greeting.parentElement);
    expect(insights.style.getPropertyValue("--card-span-wide")).toBe("3");
    expect(document.querySelector("h2")?.textContent).toBe("生存");
  });

  it("点柱子在日历里选中那天：实例已删除与没玩的日子各有说明", async () => {
    await mount();
    click(bar("10月28日"));
    expect(bar("10月28日").getAttribute("aria-pressed")).toBe("true");
    expect(text()).toContain("10月28日 · 周三");
    expect(text()).toContain("30 分钟");
    expect(text()).toContain("当天玩的实例已被删除");
    click(bar("10月27日"));
    expect(text()).toContain("这天没有游玩");
    expect(text()).toContain("休息也是游戏的一部分。");
  });

  it("游戏退出：游玩记录与大卡的存档重取，这一局新建的存档进信息行；单纯重扫实例列表不重取", async () => {
    await mount();
    const stats = callsOf(ipc, "play_stats").length;
    const content = callsOf(ipc, "list_instance_content").length;
    await act(async () => {
      await launcher.actions.refreshInstances();
    });
    await flush();
    expect(callsOf(ipc, "play_stats")).toHaveLength(stats);
    expect(callsOf(ipc, "list_instance_content")).toHaveLength(content);

    ipc.overrides.set("list_instance_content", () => ({
      resource_packs: [],
      shader_packs: [],
      worlds: [world("New World", { name: "海岛据点", last_played: NOW - 2 * MINUTE }), world("新家", { name: "山顶小屋", last_played: NOW })],
    }));
    act(() => emit(GAME_EXIT_EVENT, { version_id: "生存", exit_code: 0, crashed: false, killed: false, duration_ms: 30 * MINUTE }));
    await flush();
    expect(callsOf(ipc, "play_stats")).toHaveLength(stats + 1);
    expect(callsOf(ipc, "list_instance_content").slice(content)).toEqual([{ id: "生存" }]);
    expect(text()).toContain("存档「山顶小屋」");
  });

  it("游玩记录读不出但统计读得出：大卡与洞察写读不到，不写还没玩过与 0 分钟", async () => {
    instances = instances.map((i) => ({ ...i, playtime_min: null, last_played_at: null, play_error: "解析 游玩记录 失败" }));
    await mount();
    expect(text()).toContain("上次游玩读不到");
    expect(text()).toContain("累计时长读不到");
    expect(text()).not.toContain("还没玩过");
    expect(text()).not.toContain("累计 0 分钟");
    expect(document.querySelector('[aria-label^="累计时长 读不到，"]')?.textContent).toContain("累计时长读不到");
  });

  it("游玩记录读取失败：两张卡原位报错，重试再请求一次", async () => {
    ipc.overrides.set("play_stats", () => {
      throw new IpcError("io", "playtime.json 读不出来");
    });
    await mount();
    expect(text().match(/游玩记录读取失败/g)).toHaveLength(2);
    expect(text()).toContain("playtime.json 读不出来");
    const before = callsOf(ipc, "play_stats").length;
    click(buttonByText("重试"));
    await flush();
    expect(callsOf(ipc, "play_stats")).toHaveLength(before + 1);
  });
});

describe("主页：资讯", () => {
  /** 在场的启动器资讯提示：退场中的那一条（包在带 inert 的层里淡出）不算。 */
  const liveNotes = () => [...document.querySelectorAll<HTMLElement>('[role="note"]')].filter((el) => el.closest("[inert]") === null);

  it("按发布时刻倒序列出，标签写类型", async () => {
    await mount();
    const titles = [...document.querySelectorAll<HTMLButtonElement>("button")].map((b) => b.textContent).filter((t) => t?.startsWith("Minecraft"));
    expect(titles).toEqual(["Minecraft 1.21.1", "Minecraft 26.3", "Minecraft Live 回顾"]);
    expect(text()).toContain("正式版");
    expect(text()).toContain("活动");
  });

  // List 的根规则清零外边距与内边距，与页面类同一特异性：上距写在 List 上时谁赢看样式表注入顺序，冷启动主页时被清掉，
  // 内容比骨架矮 10、整排跟着缩
  it("列表上方的留白落在包住列表的那一层上，不写在 List 自己身上", async () => {
    await mount();
    const list = buttonByText("Minecraft 1.21.1").closest("ul");
    if (list === null) throw new Error("资讯行不在列表里");
    expect(list.className).not.toMatch(/newsList/);
    expect(list.parentElement?.className).toMatch(/newsList/);
  });

  it("已有该版本的实例：主按钮打开它，先关弹窗再跳转", async () => {
    await mount();
    click(buttonByText("Minecraft 1.21.1"));
    await flush();
    const modal = dialog();
    expect(modal?.textContent).toContain("修复若干问题。");
    click(buttonByText("打开「生存」", modal as HTMLElement));
    await flush();
    expect(nav.route).toEqual({ page: "instance", id: "生存", tab: "overview" });
  });

  it("还没有该版本：主按钮带版本预设打开新建；没有对应版本的资讯只有「关闭」", async () => {
    await mount();
    click(buttonByText("Minecraft 26.3"));
    await flush();
    click(buttonByText("用 26.3 新建实例", dialog() as HTMLElement));
    expect(shell.createInstance).toEqual({ open: true, preset: { mcVersion: "26.3" } });
    act(() => shell.closeCreateInstance());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    click(buttonByText("Minecraft Live 回顾"));
    await flush();
    const buttons = [...(dialog() as HTMLElement).querySelectorAll("button")].map((b) => b.textContent);
    expect(buttons).toEqual(["关闭"]);
  });

  it("拉取失败且没有缓存：原位错误态，重试再拉一次", async () => {
    ipc.overrides.set("list_news", () => {
      throw new IpcError("network_failed", "连接超时");
    });
    await mount();
    expect(text()).toContain("资讯暂时没拉下来");
    expect(text()).toContain("连接超时");
    const before = callsOf(ipc, "list_news").length;
    // 首挂不跳过退避，点了「重试」才要后端立即重取
    expect(callsOf(ipc, "list_news")).toEqual(Array.from({ length: before }, () => ({ retry: false })));
    click(buttonByText("重试"));
    await flush();
    expect(callsOf(ipc, "list_news")).toHaveLength(before + 1);
    expect(callsOf(ipc, "list_news")[before]).toEqual({ retry: true });
  });

  it("只有启动器资讯没拉下来：官方资讯照常列出，底部轻提示原因，重试再拉一次；拉下来后提示消失", async () => {
    let launcherError: { code: string; message: string; detail?: unknown } | null = { code: "network_failed", message: "GitHub 限流", detail: { url: "https://api.github.com/x", status: 403 } };
    ipc.overrides.set("list_news", () => ({ items: NEWS, fetched_at: NOW, offline: false, launcher_error: launcherError }));
    await mount();
    expect(text()).toContain("Minecraft 1.21.1");
    // 「资讯暂时没拉下来」只出现在启动器资讯的提示里一次：整张卡没有切成错误态
    expect(text().split("资讯暂时没拉下来")).toHaveLength(2);
    expect(text()).not.toContain("离线中");
    const note = document.querySelector<HTMLElement>('[role="note"]');
    if (note === null) throw new Error("没有启动器资讯的提示");
    expect(note.textContent).toBe(`${APP_NAME}资讯暂时没拉下来：GitHub 限流（403）重试`);
    const before = callsOf(ipc, "list_news").length;
    launcherError = null;
    click(buttonByText("重试", note));
    await flush();
    expect(callsOf(ipc, "list_news")).toHaveLength(before + 1);
    expect(callsOf(ipc, "list_news")[before]).toEqual({ retry: true });
    // 提示退场：淡出期间它还在文档里，但已经 inert、不在场
    expect(liveNotes()).toEqual([]);
    expect(note.closest("[inert]")).not.toBeNull();
    expect(text()).toContain("Minecraft 1.21.1");
  });

  // 官方资讯的磁盘缓存还新鲜（不算离线），启动器资讯没有缓存又取不到：只有 launcher_error，没有 offline
  it("断网时只有启动器资讯没拉下来：恢复联网自动重取一次，拉下来后提示消失", async () => {
    let reachable = false;
    ipc.overrides.set("list_news", () => ({
      items: NEWS,
      fetched_at: NOW,
      offline: false,
      launcher_error: reachable ? null : { code: "network_failed", message: "dns lookup failed", detail: { url: "https://api.github.com/x" } },
    }));
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await mount();
    expect(document.querySelector('[role="note"]')?.textContent).toContain(`${APP_NAME}资讯暂时没拉下来`);
    expect(callsOf(ipc, "list_news")).toHaveLength(1);

    reachable = true;
    setOnline(true);
    await flush();
    // 恢复联网的那次重取跳过后端退避，否则退避期内拿回来的仍是断网时那次失败
    expect(callsOf(ipc, "list_news")).toEqual([{ retry: false }, { retry: true }]);
    expect(liveNotes()).toEqual([]);
    expect(text()).not.toContain("离线中");
  });

  it("后端给的是缓存：副标题注明离线中", async () => {
    ipc.overrides.set("list_news", () => ({ items: NEWS, fetched_at: NOW - DAY, offline: true, launcher_error: null }));
    await mount();
    expect(text()).toContain("游戏更新与官方活动 · 离线中");
  });

  it("断网又没有缓存：说「需要联网获取」而不是拉取失败；恢复联网自动重取一次", async () => {
    let reachable = false;
    ipc.overrides.set("list_news", () => {
      if (!reachable) throw new IpcError("network_failed", "dns lookup failed");
      return { items: NEWS, fetched_at: NOW, offline: false, launcher_error: null };
    });
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await mount();
    expect(text()).toContain("需要联网获取");
    expect(text()).not.toContain("资讯暂时没拉下来");
    expect(callsOf(ipc, "list_news")).toHaveLength(1);

    reachable = true;
    setOnline(true);
    await flush();
    expect(callsOf(ipc, "list_news")).toEqual([{ retry: false }, { retry: true }]);
    expect(text()).not.toContain("需要联网获取");
    expect(text()).toContain("Minecraft 1.21.1");
    expect(text()).not.toContain("游戏更新与官方活动 · 离线中");
  });

  it("拿到的是新内容、之后才断网：内容留着，副标题注明离线中；恢复联网不重取", async () => {
    await mount();
    expect(text()).not.toContain("离线中");
    setOnline(false);
    expect(text()).toContain("游戏更新与官方活动 · 离线中");
    expect(text()).toContain("Minecraft 1.21.1");
    setOnline(true);
    await flush();
    expect(text()).not.toContain("离线中");
    expect(callsOf(ipc, "list_news")).toHaveLength(1);
  });
});

describe("主页：固定的服务器", () => {
  it("行写在线人数与延迟；加号从多人列表里固定，更多菜单取消固定", async () => {
    await mount();
    expect(text()).toContain("1 个 · 在线人数与延迟");
    expect(text()).toContain("127/500 在线");
    expect(text()).toContain("38 ms");
    await openMenu(buttonByLabel("固定服务器"));
    expect(menuItems().map((el) => el.textContent)).toEqual(["本地localhost"]);
    click(menuItem("本地"));
    await flush();
    expect(callsOf(ipc, "set_pinned_servers").at(-1)).toEqual({
      servers: [
        { name: "晨星", address: "play.example", instance: null },
        { name: "本地", address: "localhost", instance: null },
      ],
    });
    expect(text()).toContain("2 个 · 在线人数与延迟");
    expect(text()).toContain("连不上");
    expect(text()).toContain("上次 2 小时前在线 1.2 万");

    await openMenu(buttonByLabel("晨星 的更多操作"));
    click(menuItem("取消固定"));
    await flush();
    expect(callsOf(ipc, "set_pinned_servers").at(-1)).toEqual({ servers: [{ name: "本地", address: "localhost", instance: null }] });
  });

  it("取消固定：焦点在这一行时交给加号，不随退场的行掉回 body", async () => {
    await mount();
    const more = buttonByLabel("晨星 的更多操作");
    act(() => more.focus());
    await openMenu(more);
    click(menuItem("取消固定"));
    await flush();
    expect(callsOf(ipc, "set_pinned_servers").at(-1)).toEqual({ servers: [] });
    expect(document.activeElement).toBe(buttonByLabel("固定服务器"));
  });

  it("取消固定失败：行还在，焦点留给它的「更多」", async () => {
    await mount();
    ipc.overrides.set("set_pinned_servers", () => {
      throw new Error("写不进去");
    });
    const more = buttonByLabel("晨星 的更多操作");
    act(() => more.focus());
    await openMenu(more);
    click(menuItem("取消固定"));
    await flush();
    expect(document.activeElement).toBe(buttonByLabel("晨星 的更多操作"));
  });

  it("全部已固定时加号菜单只有一条禁用说明", async () => {
    pinned = [
      { name: "晨星", address: "play.example", instance: null },
      { name: "本地", address: "localhost", instance: null },
    ];
    await mount();
    await openMenu(buttonByLabel("固定服务器"));
    expect(menuItems().map((el) => el.textContent)).toEqual(["所有服务器都已固定"]);
    expect(menuItems()[0].getAttribute("aria-disabled")).toBe("true");
  });

  it("多人列表里没固定的超过菜单上限：菜单列前 9 台加「全部 N 台服务器…」，弹窗里每台都能固定，固定一台少一台", async () => {
    const many: KnownServerDto[] = Array.from({ length: 12 }, (_, i) => ({ name: `服${i + 1}`, address: `s${i + 1}.example`, pinned: false }));
    ipc.overrides.set("list_known_servers", () => many.map((k) => ({ ...k, pinned: pinned.some((p) => p.address === k.address) })));
    await mount();
    await openMenu(buttonByLabel("固定服务器"));
    const labels = menuItems().map((el) => el.textContent);
    expect(labels).toHaveLength(10);
    expect(labels.slice(0, 9)).toEqual(many.slice(0, 9).map((k) => `${k.name}${k.address}`));
    expect(labels[9]).toBe("全部 12 台服务器…");

    click(menuItem("全部 12 台服务器"));
    await flush();
    const picker = () => {
      const el = dialog();
      if (el === null || !el.textContent?.includes("从游戏的多人服务器列表里挑选")) throw new Error("服务器挑选弹窗没有打开");
      return el;
    };
    // 刚固定的那一行还在淡出，已经标了 inert，不算列表的行
    const pickRows = () => [...picker().querySelectorAll<HTMLButtonElement>('li:not([inert]) > button[aria-label^="固定 "]')];
    expect(pickRows().map((b) => b.getAttribute("aria-label"))).toEqual(many.map((k) => `固定 ${k.name}`));

    click(pickRows()[11]);
    await flush();
    expect(callsOf(ipc, "set_pinned_servers").at(-1)).toEqual({
      servers: [
        { name: "晨星", address: "play.example", instance: null },
        { name: "服12", address: "s12.example", instance: null },
      ],
    });
    // 弹窗不自动关闭：刚固定的这台从列表里消失，其余照常可选
    expect(pickRows()).toHaveLength(11);
    expect(pickRows().some((b) => b.getAttribute("aria-label") === "固定 服12")).toBe(false);

    click(buttonByText("关闭", picker()));
    await flush();
    await openMenu(buttonByLabel("固定服务器"));
    expect(menuItems().at(-1)?.textContent).toBe("全部 11 台服务器…");
  });

  // 固定的那一行连同焦点一起从列表里拿掉：焦点不能掉到 body，连续固定多台时停在原位置附近
  it("挑选弹窗：键盘固定一台后焦点移到同一位置的下一行，最后一行移到上一行，列表空了移到「关闭」", async () => {
    const many: KnownServerDto[] = Array.from({ length: 11 }, (_, i) => ({ name: `服${i + 1}`, address: `s${i + 1}.example`, pinned: false }));
    ipc.overrides.set("list_known_servers", () => many.map((k) => ({ ...k, pinned: pinned.some((p) => p.address === k.address) })));
    await mount();
    await openMenu(buttonByLabel("固定服务器"));
    click(menuItem("全部 11 台服务器"));
    await flush();
    const picker = dialog() as HTMLElement;
    // 挑空时整个列表连同最后一行淡出，那一层带 inert：里面的行同样不算
    const rows = () => [...picker.querySelectorAll<HTMLButtonElement>('li > button[aria-label^="固定 "]')].filter((b) => b.closest("[inert]") === null);
    const focused = () => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent;
    const pickFocused = async () => {
      const el = document.activeElement;
      if (!(el instanceof HTMLButtonElement) || !picker.contains(el)) throw new Error(`焦点不在挑选弹窗的行上：${String(el?.tagName)}`);
      click(el);
      await flush();
    };

    act(() => rows()[2].focus());
    await pickFocused();
    expect(rows()).toHaveLength(10);
    expect(focused()).toBe("固定 服4");

    act(() => rows()[9].focus());
    expect(focused()).toBe("固定 服11");
    await pickFocused();
    expect(focused()).toBe("固定 服10");

    act(() => rows()[0].focus());
    for (let left = rows().length; left > 0; left--) await pickFocused();
    expect(rows()).toHaveLength(0);
    expect(picker.textContent).toContain("所有服务器都已固定");
    // 挑空时列表连同最后一行原地淡出（不可交互），不是同一帧换成空状态
    const leftover = picker.querySelector<HTMLElement>('li > button[aria-label^="固定 "]');
    expect(leftover).not.toBeNull();
    expect(leftover?.closest("[inert]")).not.toBeNull();
    expect(document.activeElement).toBe(buttonByText("关闭", picker));
    expect(pinned).toHaveLength(12);
  });

  it("挑选弹窗：同一行连点两下只固定一次；固定失败报错后这一行回到列表里，可以再点", async () => {
    const many: KnownServerDto[] = Array.from({ length: 12 }, (_, i) => ({ name: `服${i + 1}`, address: `s${i + 1}.example`, pinned: false }));
    ipc.overrides.set("list_known_servers", () => many.map((k) => ({ ...k, pinned: pinned.some((p) => p.address === k.address) })));
    let failNext = false;
    ipc.overrides.set("set_pinned_servers", (args: IpcArgs) => {
      if (failNext) {
        failNext = false;
        throw new IpcError("io", "servers.dat 写不进去");
      }
      pinned = args.servers as PinnedServerDto[];
      return pinned;
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await mount();
    await openMenu(buttonByLabel("固定服务器"));
    click(menuItem("全部 12 台服务器"));
    await flush();
    const pickRow = (name: string) => (dialog() as HTMLElement).querySelector<HTMLButtonElement>(`li:not([inert]) > button[aria-label="固定 ${name}"]`);

    const row = pickRow("服3") as HTMLButtonElement;
    click(row);
    click(row);
    await flush();
    expect(callsOf(ipc, "set_pinned_servers")).toHaveLength(1);
    expect(pinned.map((p) => p.address)).toEqual(["play.example", "s3.example"]);
    expect(pickRow("服3")).toBeNull();

    failNext = true;
    click(pickRow("服5") as HTMLButtonElement);
    expect(pickRow("服5")).toBeNull();
    await flush();
    expect(launcher.state.toasts.map((t) => [t.tone, t.body])).toEqual([["error", "servers.dat 写不进去"]]);
    expect(pickRow("服5")).not.toBeNull();
    click(pickRow("服5") as HTMLButtonElement);
    await flush();
    expect(pinned.map((p) => p.address)).toEqual(["play.example", "s3.example", "s5.example"]);
  });

  it("复制地址：写剪贴板并原位显示「已复制」，2 秒后复原，不弹通知", async () => {
    await mount();
    await openMenu(buttonByLabel("晨星 的更多操作"));
    click(menuItem("复制地址"));
    await flush();
    expect(writeText).toHaveBeenCalledWith("play.example");
    await openMenu(buttonByLabel("晨星 的更多操作"));
    expect(menuItem("已复制").textContent).toBe("已复制play.example");
    expect(launcher.state.toasts).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(menuItems().some((el) => el.textContent?.startsWith("复制地址"))).toBe(true);
  });

  it("复制地址被剪贴板拒绝：只弹一次「复制失败」带原因，菜单项不换成「已复制」", async () => {
    writeText.mockImplementation(async () => {
      throw new Error("Document is not focused.");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await mount();
    await openMenu(buttonByLabel("晨星 的更多操作"));
    click(menuItem("复制地址"));
    await flush();
    expect(launcher.state.toasts.map((t) => [t.tone, t.title, t.body])).toEqual([["error", "复制失败", "Document is not focused."]]);
    await openMenu(buttonByLabel("晨星 的更多操作"));
    expect(menuItem("复制地址").textContent).toBe("复制地址play.example");
  });

  it("主页可见时每 60 秒重测一次", async () => {
    await mount();
    const before = callsOf(ipc, "ping_servers").length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(callsOf(ipc, "ping_servers")).toHaveLength(before + 1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(callsOf(ipc, "ping_servers")).toHaveLength(before + 2);
  });

  it("窗口隐藏期间不重测；隐藏跨过了重测周期时，还原立即补测一次，之后周期照常", async () => {
    await mount();
    const before = callsOf(ipc, "ping_servers").length;
    setPageVisibility("hidden");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * 60_000);
    });
    expect(callsOf(ipc, "ping_servers")).toHaveLength(before);

    setPageVisibility("visible");
    await flush();
    expect(callsOf(ipc, "ping_servers")).toHaveLength(before + 1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(callsOf(ipc, "ping_servers")).toHaveLength(before + 2);
  });

  it("隐藏没跨过重测周期：还原不多测，下一个周期到点才测", async () => {
    await mount();
    const before = callsOf(ipc, "ping_servers").length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    setPageVisibility("hidden");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    setPageVisibility("visible");
    await flush();
    expect(callsOf(ipc, "ping_servers")).toHaveLength(before);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(callsOf(ipc, "ping_servers")).toHaveLength(before + 1);
  });

  it("补测只补一次：还原后再隐藏、再还原，没有新跨过周期就不再测", async () => {
    await mount();
    const before = callsOf(ipc, "ping_servers").length;
    setPageVisibility("hidden");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    setPageVisibility("visible");
    await flush();
    expect(callsOf(ipc, "ping_servers")).toHaveLength(before + 1);

    setPageVisibility("hidden");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    setPageVisibility("visible");
    await flush();
    expect(callsOf(ipc, "ping_servers")).toHaveLength(before + 1);
  });

  // 单台测速分不出本机断网与服务器宕机：本机离线时整张卡说明本机离线，不把每台都标成连不上
  it("断网：整卡注明本机离线并暂停测速，每台都不下连通结论，在线人数取上次的结果；恢复联网立即重测一次", async () => {
    pinned = [
      { name: "晨星", address: "play.example", instance: null },
      { name: "本地", address: "localhost", instance: null },
    ];
    await mount();
    const signals = () => [...document.querySelectorAll<HTMLElement>("[data-quality], [data-state]")].filter((el) => el.className.includes("signal")).map((el) => el.dataset.state);
    expect(text()).toContain("38 ms");
    expect(text()).toContain("连不上");
    expect(signals()).toEqual(["online", "unreachable"]);
    const before = callsOf(ipc, "ping_servers").length;

    setOnline(false);
    expect(text()).toContain("2 个 · 在线人数与延迟 · 本机离线");
    expect(text()).not.toContain("连不上");
    expect(text()).not.toContain("38 ms");
    expect(signals()).toEqual(["paused", "paused"]);
    expect(document.querySelectorAll("[data-on]")).toHaveLength(0);
    expect(text()).toContain("127/500 在线");
    expect(text()).toContain("上次 2 小时前在线 1.2 万");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * 60_000);
    });
    expect(callsOf(ipc, "ping_servers")).toHaveLength(before);

    setOnline(true);
    await flush();
    expect(callsOf(ipc, "ping_servers")).toHaveLength(before + 1);
    expect(text()).toContain("2 个 · 在线人数与延迟");
    expect(text()).not.toContain("本机离线");
    expect(text()).toContain("38 ms");
    expect(text()).toContain("连不上");
    expect(signals()).toEqual(["online", "unreachable"]);
    // 周期重测接着恢复
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(callsOf(ipc, "ping_servers")).toHaveLength(before + 2);
  });

  it("断网时进主页测到的全是连不上：恢复联网重测回来之前每台写「测速中」，不把断网期间的结果当结论", async () => {
    let reachable = false;
    ipc.overrides.set("ping_servers", () => {
      if (!reachable) return pinned.map((p) => ({ ...ping(p.address), reachable: false, latency_ms: null, online: null, max: null, error: "网络不可达" }));
      return new Promise<ServerStatusDto[]>((resolve) => setTimeout(() => resolve(pinned.map((p) => ping(p.address))), 2_000));
    });
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await mount();
    const signals = () => [...document.querySelectorAll<HTMLElement>("[data-state]")].filter((el) => el.className.includes("signal")).map((el) => el.dataset.state);
    expect(text()).toContain("1 个 · 在线人数与延迟 · 本机离线");
    expect(signals()).toEqual(["paused"]);

    reachable = true;
    setOnline(true);
    await flush();
    expect(callsOf(ipc, "ping_servers")).toHaveLength(2);
    expect(text()).not.toContain("本机离线");
    expect(text()).not.toContain("连不上");
    expect(text()).toContain("测速中");
    expect(signals()).toEqual(["pending"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(text()).toContain("38 ms");
    expect(text()).not.toContain("测速中");
    expect(signals()).toEqual(["online"]);
  });

  // 结果晚到时行若从一行长成三行，下面的行与提示会被逐行挤下去
  it("测速结果晚到：行先给 MOTD 与在线人数留好位置（加载中），结果到了在同一处换上", async () => {
    ipc.overrides.set("ping_servers", () => new Promise<ServerStatusDto[]>((resolve) => setTimeout(() => resolve(pinned.map((p) => ping(p.address))), 2_000)));
    await mount();
    const row = document.querySelector<HTMLElement>('[data-server-row="play.example"]');
    if (row === null) throw new Error("找不到晨星这一行");
    expect(row.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(row.textContent).not.toContain("127/500 在线");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(document.querySelector('[data-server-row="play.example"]')).toBe(row);
    expect(row.querySelector('[aria-busy="true"]')).toBeNull();
    expect(row.textContent).toContain("第六周目开荒中");
    expect(row.textContent).toContain("127/500 在线");
  });

  it("固定列表晚到：卡头先占住副标题一行，台数到了填进同一行；列表区先是隐身占位的骨架", async () => {
    let release: () => void = () => {
      throw new Error("固定列表的读取还没发出");
    };
    ipc.overrides.set("list_pinned_servers", () => new Promise<PinnedServerDto[]>((resolve) => (release = () => resolve(pinned))));
    await mount();
    const header = [...document.querySelectorAll("h2")].find((h) => h.textContent === "固定的服务器")?.parentElement;
    if (header === undefined || header === null) throw new Error("找不到服务器卡的卡头");
    expect(header.querySelector("[data-reserve]")).not.toBeNull();
    const card = header.closest<HTMLElement>("[data-pad]") as HTMLElement;
    expect(card.querySelector('[aria-busy="true"] [aria-hidden="true"][data-pending]')).not.toBeNull();
    await act(async () => {
      release();
      await settle();
    });
    expect(header.querySelector("[data-reserve]")).toBeNull();
    expect(header.textContent).toContain("1 个 · 在线人数与延迟");
  });

  it("固定列表读取失败：卡头照样占住副标题一行，不比加载中矮；重试读到后台数填进同一行", async () => {
    let failing = true;
    ipc.overrides.set("list_pinned_servers", () => {
      if (failing) throw new IpcError("io_failed", "servers.dat 读不出来");
      return pinned;
    });
    await mount();
    const header = [...document.querySelectorAll("h2")].find((h) => h.textContent === "固定的服务器")?.parentElement;
    if (header === undefined || header === null) throw new Error("找不到服务器卡的卡头");
    const card = header.closest<HTMLElement>("[data-pad]") as HTMLElement;
    expect(card.textContent).toContain("固定的服务器读不出来");
    expect(header.querySelector("[data-reserve]")).not.toBeNull();

    failing = false;
    click(buttonByText("重试", card));
    await flush();
    expect(header.querySelector("[data-reserve]")).toBeNull();
    expect(header.textContent).toContain("1 个 · 在线人数与延迟");
  });

  it("取消固定最后一台：列表连同最后一行原地淡出（带 inert），空状态在同一处淡入", async () => {
    await mount();
    await openMenu(buttonByLabel("晨星 的更多操作"));
    click(menuItem("取消固定"));
    await flush();
    const row = document.querySelector<HTMLElement>('[data-server-row="play.example"]');
    expect(row).not.toBeNull();
    expect(row?.closest("[inert]")).not.toBeNull();
    expect(text()).toContain("还没有固定服务器");
  });

  it("整批测速失败后重测：重测途中提示留着、「重试」标着忙；重测成功提示退场", async () => {
    let failing = true;
    let release: () => void = () => {
      throw new Error("重测还没发出");
    };
    ipc.overrides.set("ping_servers", () => {
      if (failing) throw new IpcError("invalid_argument", "地址不合法");
      return new Promise<ServerStatusDto[]>((resolve) => (release = () => resolve(pinned.map((p) => ping(p.address)))));
    });
    await mount();
    const liveCallouts = () => [...document.querySelectorAll<HTMLElement>('[data-tone="danger"]')].filter((el) => el.closest("[inert]") === null);
    expect(liveCallouts()).toHaveLength(1);
    // 失败了就不再等结果：行里不留一直转的骨架
    expect(document.querySelector('[data-server-row="play.example"] [aria-busy="true"]')).toBeNull();

    failing = false;
    click(buttonByText("重试", liveCallouts()[0]));
    await flush();
    expect(liveCallouts()).toHaveLength(1);
    expect(liveCallouts()[0].textContent).toContain("地址不合法");
    expect(buttonByText("重试", liveCallouts()[0]).getAttribute("aria-busy")).toBe("true");

    await act(async () => {
      release();
      await settle();
    });
    expect(liveCallouts()).toHaveLength(0);
    expect(text()).toContain("127/500 在线");
  });

  it("没有固定服务器：紧凑空状态", async () => {
    pinned = [];
    await mount();
    expect(text()).toContain("还没有固定服务器");
    expect(text()).toContain("把常去的服务器放这里");
  });

  it("延迟测不出来：危险提示写出后端给的完整原因，不截成两行", async () => {
    const reason = "服务器地址 play.example:99999 不合法：端口必须是 1 到 65535 之间的整数，冒号后面只能写数字，IPv6 地址要用方括号括起来再写端口";
    ipc.overrides.set("ping_servers", () => {
      throw new IpcError("invalid_argument", reason);
    });
    await mount();
    const callouts = [...document.querySelectorAll<HTMLElement>('[data-tone="danger"]')];
    expect(callouts).toHaveLength(1);
    // jsdom 不排版，截不截成两行只能看文字容器上的 data-full；原因是后端原文，截掉后半句就看不出该怎么改地址
    const body = callouts[0].querySelector<HTMLElement>("[data-full]");
    expect(body?.getAttribute("data-full")).toBe("true");
    expect(body?.textContent).toBe(`延迟测不出来：${reason}`);
  });
});

describe("主页：固定服务器的「加入」", () => {
  const SERVER = { kind: "multiplayer", address: "play.example" } as const;

  beforeEach(() => {
    // 红石是 1.20 之前的版本，只能加入服务器、不能进存档，照样能加入；空岛的版本两样都不支持，不该出现在实例选择里
    instances = instances.map((i) =>
      i.id === "红石" ? { ...i, quick_play: { singleplayer: false, multiplayer: true } } : i.id === "空岛" ? { ...i, quick_play: { singleplayer: false, multiplayer: false } } : i,
    );
    ipc.overrides.set("launch_game", () => ({ pid: 4242 }));
    ipc.overrides.set("set_pinned_server_instance", (args: IpcArgs) => {
      pinned = pinned.map((p) => (p.address === args.address ? { ...p, instance: args.instance as string | null } : p));
      return pinned;
    });
  });

  const joinButton = () => buttonByText("加入");
  /** 正在退场的面板还在文档里，取未在退场的那一个。 */
  const picker = () => {
    const el = [...document.querySelectorAll<HTMLElement>('[role="dialog"]:not([data-exiting])')].find((d) => d.getAttribute("aria-label")?.startsWith("选择用来加入"));
    return el === undefined ? null : el;
  };
  const radios = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[role="radio"]')];
  const commandIndex = (cmd: string) => ipc.calls.findIndex((c) => c.cmd === cmd);

  it("记住的实例可用：点「加入」直接以它启动并进服，不弹实例选择", async () => {
    pinned = [{ name: "晨星", address: "play.example", instance: "创造" }];
    await mount();
    click(joinButton());
    await flush();
    expect(picker()).toBeNull();
    const calls = callsOf(ipc, "launch_game");
    expect(calls).toHaveLength(1);
    expect(calls[0].versionId).toBe("创造");
    expect(calls[0].quickPlay).toEqual(SERVER);
    expect(callsOf(ipc, "set_pinned_server_instance")).toHaveLength(0);
  });

  it("没记住：弹出锚在「加入」上的实例选择，只列能加入的实例（按上次游玩倒序），默认选中当前实例", async () => {
    await mount();
    click(joinButton());
    await flush();
    const panel = picker();
    if (panel === null) throw new Error("没有弹出实例选择");
    expect(panel.getAttribute("aria-label")).toBe("选择用来加入「晨星」的实例");
    expect(panel.textContent).toContain("用哪个实例加入");
    const options = radios(panel);
    const eligible = instances.filter((i) => i.status === "ready" && i.quick_play !== null && i.quick_play.multiplayer);
    expect(options).toHaveLength(eligible.length);
    expect(options.map((o) => o.textContent)).toEqual(["生存· 1.21.1 Fabric", "创造· 1.20.1", "红石· 1.19.2"]);
    expect(options.some((o) => o.textContent?.includes("空岛"))).toBe(false);
    expect(options.map((o) => o.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    const remember = panel.querySelector<HTMLElement>('[role="checkbox"]');
    expect(remember?.getAttribute("aria-checked")).toBe("false");
    expect(callsOf(ipc, "launch_game")).toHaveLength(0);
  });

  it("没记住时「加入」是实例选择的锚点：读屏能知道它弹出对话框、此刻是否展开、展开的是哪一个", async () => {
    await mount();
    const button = joinButton();
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.hasAttribute("aria-controls")).toBe(false);
    click(button);
    await flush();
    const panel = picker();
    if (panel === null) throw new Error("没有弹出实例选择");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(panel.id).not.toBe("");
    expect(button.getAttribute("aria-controls")).toBe(panel.id);
  });

  it("实例选择开着时再点「加入」：收起面板，不重新打开，也不启动", async () => {
    await mount();
    const button = joinButton();
    click(button);
    await flush();
    const panel = picker();
    if (panel === null) throw new Error("没有弹出实例选择");
    click(radios(panel)[1]);
    click(button);
    await flush();
    expect(picker()).toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(callsOf(ipc, "launch_game")).toHaveLength(0);
  });

  it("记住的实例可用时「加入」直接启动，不标弹出对话框", async () => {
    pinned = [{ name: "晨星", address: "play.example", instance: "创造" }];
    await mount();
    const button = joinButton();
    expect(button.hasAttribute("aria-haspopup")).toBe(false);
    expect(button.hasAttribute("aria-expanded")).toBe(false);
  });

  it("选定并勾选「记住这个选择」：先保存选择（一次，参数为地址与实例）再启动，之后菜单里出现「更换加入用的实例」", async () => {
    await mount();
    click(joinButton());
    await flush();
    const panel = picker();
    if (panel === null) throw new Error("没有弹出实例选择");
    click(radios(panel)[2]);
    const remember = panel.querySelector<HTMLElement>('[role="checkbox"]');
    if (remember === null) throw new Error("没有「记住这个选择」");
    click(remember);
    click(buttonByText("加入服务器", panel));
    await flush();
    expect(callsOf(ipc, "set_pinned_server_instance")).toEqual([{ address: "play.example", instance: "红石" }]);
    expect(commandIndex("set_pinned_server_instance")).toBeLessThan(commandIndex("launch_game"));
    const calls = callsOf(ipc, "launch_game");
    expect(calls.map((a) => [a.versionId, a.quickPlay])).toEqual([["红石", SERVER]]);
    expect(picker()).toBeNull();

    await openMenu(buttonByLabel("晨星 的更多操作"));
    expect(menuItems().map((el) => el.textContent)).toEqual(["复制地址play.example", "更换加入用的实例红石", "不再记住实例", "取消固定"]);
  });

  it("不勾选「记住」：不保存，直接以选定的实例启动", async () => {
    await mount();
    click(joinButton());
    await flush();
    const panel = picker();
    if (panel === null) throw new Error("没有弹出实例选择");
    click(radios(panel)[1]);
    click(buttonByText("加入服务器", panel));
    await flush();
    expect(callsOf(ipc, "set_pinned_server_instance")).toHaveLength(0);
    expect(callsOf(ipc, "launch_game").map((a) => [a.versionId, a.quickPlay])).toEqual([["创造", SERVER]]);
  });

  it("保存选择失败：报「加入用的实例没有保存」加原因，并且不启动", async () => {
    ipc.overrides.set("set_pinned_server_instance", () => {
      throw new IpcError("config_write_failed", "配置写入失败");
    });
    await mount();
    click(joinButton());
    await flush();
    const panel = picker();
    if (panel === null) throw new Error("没有弹出实例选择");
    const remember = panel.querySelector<HTMLElement>('[role="checkbox"]');
    if (remember === null) throw new Error("没有「记住这个选择」");
    click(remember);
    click(buttonByText("加入服务器", panel));
    await flush();
    expect(callsOf(ipc, "set_pinned_server_instance")).toHaveLength(1);
    expect(callsOf(ipc, "launch_game")).toHaveLength(0);
    expect(launcher.state.toasts.filter((t) => t.tone === "error").map((t) => [t.title, t.body])).toEqual([["加入用的实例没有保存", "配置写入失败"]]);
  });

  it("记住的实例已经不在：按没记住处理，点「加入」弹实例选择", async () => {
    pinned = [{ name: "晨星", address: "play.example", instance: "已删除" }];
    await mount();
    click(joinButton());
    await flush();
    expect(picker()).not.toBeNull();
    expect(callsOf(ipc, "launch_game")).toHaveLength(0);
  });

  it("记住的实例已经不在：菜单不写已不存在的 id，说清楚它不在了；点了打开实例选择且默认勾选记住，选定后绑定换成新实例", async () => {
    pinned = [{ name: "晨星", address: "play.example", instance: "已删除" }];
    await mount();
    await openMenu(buttonByLabel("晨星 的更多操作"));
    expect(menuItems().map((el) => el.textContent)).toEqual(["复制地址play.example", "重新选择实例之前的实例已不在", "不再记住实例", "取消固定"]);
    click(menuItem("重新选择实例"));
    await flush();
    const panel = picker();
    if (panel === null) throw new Error("没有弹出实例选择");
    expect(panel.querySelector('[role="checkbox"]')?.getAttribute("aria-checked")).toBe("true");
    click(buttonByText("加入服务器", panel));
    await flush();
    expect(callsOf(ipc, "set_pinned_server_instance")).toEqual([{ address: "play.example", instance: "生存" }]);
    expect(callsOf(ipc, "launch_game").map((a) => [a.versionId, a.quickPlay])).toEqual([["生存", SERVER]]);

    await openMenu(buttonByLabel("晨星 的更多操作"));
    expect(menuItems().map((el) => el.textContent)).toEqual(["复制地址play.example", "更换加入用的实例生存", "不再记住实例", "取消固定"]);
  });

  it("实例列表没读出来：手里的列表是空的，不能断定记住的实例不在了，菜单照旧写它的名字", async () => {
    pinned = [{ name: "晨星", address: "play.example", instance: "生存" }];
    ipc.overrides.set("list_instances", () => {
      throw new IpcError("config_read_failed", "读不出实例列表");
    });
    await mount();
    await openMenu(buttonByLabel("晨星 的更多操作"));
    expect(menuItems().map((el) => el.textContent)).toEqual(["复制地址play.example", "更换加入用的实例生存", "不再记住实例", "取消固定"]);
  });

  it("记住的实例损坏或版本不支持：它还在列表里，菜单照旧写它的名字，不说它不在了", async () => {
    pinned = [{ name: "晨星", address: "play.example", instance: "空岛" }];
    await mount();
    await openMenu(buttonByLabel("晨星 的更多操作"));
    expect(menuItems().map((el) => el.textContent)).toEqual(["复制地址play.example", "更换加入用的实例空岛", "不再记住实例", "取消固定"]);
  });

  it("记住的实例正在运行：「加入」aria-disabled 并写明原因，点了不启动；别的实例运行时照常走替换确认", async () => {
    pinned = [{ name: "晨星", address: "play.example", instance: "创造" }];
    await mount();
    await act(async () => {
      await launcher.actions.launch("创造");
    });
    await flush();
    const join = joinButton();
    expect(join.getAttribute("aria-disabled")).toBe("true");
    act(() => {
      join.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const tipId = join.getAttribute("aria-describedby");
    if (tipId === null) throw new Error("「加入」悬停后没有关联提示气泡");
    expect(document.getElementById(tipId)?.textContent).toContain("「创造」正在运行");
    click(join);
    await flush();
    expect(callsOf(ipc, "launch_game").map((a) => a.versionId)).toEqual(["创造"]);

    // 换成记住生存：创造仍在运行，点「加入」弹替换确认，确认里带着这次的 quickPlay
    pinned = [{ name: "晨星", address: "play.example", instance: "生存" }];
    await act(async () => {
      await launcher.actions.setPinnedServerInstance("play.example", "生存");
    });
    await flush();
    click(joinButton());
    await flush();
    expect(launcher.state.launchPrompt).toEqual({ instanceId: "生存", occupantId: "创造", occupantPhase: "running", quickPlay: SERVER });
  });

  it("记住的实例在备份或恢复存档：「加入」aria-disabled 并写明原因，点了不启动", async () => {
    pinned = [{ name: "晨星", address: "play.example", instance: "创造" }];
    instances = instances.map((i) => (i.id === "创造" ? { ...i, activity: "backing_up" } : i));
    await mount();
    const join = joinButton();
    expect(join.getAttribute("aria-disabled")).toBe("true");
    act(() => {
      join.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const tipId = join.getAttribute("aria-describedby");
    if (tipId === null) throw new Error("「加入」悬停后没有关联提示气泡");
    expect(document.getElementById(tipId)?.textContent).toBe("「创造」正在备份或恢复存档，完成后再加入");
    click(join);
    await flush();
    expect(callsOf(ipc, "launch_game")).toHaveLength(0);
    expect(picker()).toBeNull();
  });

  it("实例选择里选中的正是运行中的实例：「加入服务器」aria-disabled 并写明原因，点了既不保存也不启动；换一个实例就能加入", async () => {
    await mount();
    await act(async () => {
      await launcher.actions.launch("生存");
    });
    await flush();
    click(joinButton());
    await flush();
    const panel = picker();
    if (panel === null) throw new Error("没有弹出实例选择");
    // 默认选中当前实例，也就是正在运行的生存
    expect(radios(panel).map((o) => o.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    const remember = panel.querySelector<HTMLElement>('[role="checkbox"]');
    if (remember === null) throw new Error("没有「记住这个选择」");
    click(remember);
    const submit = buttonByText("加入服务器", panel);
    expect(submit.getAttribute("aria-disabled")).toBe("true");
    act(() => {
      submit.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const tipId = submit.getAttribute("aria-describedby");
    if (tipId === null) throw new Error("「加入服务器」悬停后没有关联提示气泡");
    expect(document.getElementById(tipId)?.textContent).toContain("「生存」正在运行");
    click(submit);
    await flush();
    expect(callsOf(ipc, "set_pinned_server_instance")).toHaveLength(0);
    expect(callsOf(ipc, "launch_game").map((a) => a.versionId)).toEqual(["生存"]);
    expect(picker()).not.toBeNull();

    click(radios(panel)[1]);
    const enabled = buttonByText("加入服务器", panel);
    expect(enabled.getAttribute("aria-disabled")).toBeNull();
    click(enabled);
    await flush();
    expect(callsOf(ipc, "set_pinned_server_instance")).toEqual([{ address: "play.example", instance: "创造" }]);
    expect(launcher.state.launchPrompt).toEqual({ instanceId: "创造", occupantId: "生存", occupantPhase: "running", quickPlay: SERVER });
  });

  it("「不再记住实例」清掉绑定；「更换加入用的实例」打开实例选择且默认勾选记住", async () => {
    pinned = [{ name: "晨星", address: "play.example", instance: "生存" }];
    await mount();
    await openMenu(buttonByLabel("晨星 的更多操作"));
    click(menuItem("更换加入用的实例"));
    await flush();
    const panel = picker();
    if (panel === null) throw new Error("没有弹出实例选择");
    expect(panel.querySelector('[role="checkbox"]')?.getAttribute("aria-checked")).toBe("true");
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flush();

    await openMenu(buttonByLabel("晨星 的更多操作"));
    click(menuItem("不再记住实例"));
    await flush();
    expect(callsOf(ipc, "set_pinned_server_instance")).toEqual([{ address: "play.example", instance: null }]);
    await openMenu(buttonByLabel("晨星 的更多操作"));
    expect(menuItems().map((el) => el.textContent)).toEqual(["复制地址play.example", "取消固定"]);
  });

  it("只有一个能加入的实例：不给单选组，直接写明用它", async () => {
    instances = instances.map((i) => (i.id === "生存" ? i : { ...i, quick_play: { singleplayer: false, multiplayer: false } }));
    await mount();
    click(joinButton());
    await flush();
    const panel = picker();
    if (panel === null) throw new Error("没有弹出实例选择");
    expect(radios(panel)).toHaveLength(0);
    expect(panel.textContent).toContain("生存· 1.21.1 Fabric");
    click(buttonByText("加入服务器", panel));
    await flush();
    expect(callsOf(ipc, "launch_game").map((a) => [a.versionId, a.quickPlay])).toEqual([["生存", SERVER]]);
  });

  it("七个以上能加入的实例：改用下拉选择，当前实例不在其中时默认最近玩过的", async () => {
    instances = Array.from({ length: 8 }, (_, i) => instanceDto(`实例${i + 1}`, { last_played_at: NOW - (8 - i) * HOUR }));
    await mount();
    click(joinButton());
    await flush();
    const panel = picker();
    if (panel === null) throw new Error("没有弹出实例选择");
    expect(radios(panel)).toHaveLength(0);
    expect(panel.querySelector('[role="combobox"]')?.textContent).toContain("实例8");
    click(buttonByText("加入服务器", panel));
    await flush();
    expect(callsOf(ipc, "launch_game").map((a) => [a.versionId, a.quickPlay])).toEqual([["实例8", SERVER]]);
  });

  it("没有能加入服务器的实例：实例选择换成紧凑空状态，不给复选框与主按钮", async () => {
    instances = instances.map((i) => ({ ...i, quick_play: { singleplayer: false, multiplayer: false } }));
    await mount();
    click(joinButton());
    await flush();
    const panel = picker();
    if (panel === null) throw new Error("没有弹出实例选择");
    expect(panel.textContent).toContain("没有能加入服务器的实例");
    expect(panel.textContent).toContain("新建一个 1.6 以后的实例再来加入。");
    expect(panel.querySelector('[role="checkbox"]')).toBeNull();
    expect(radios(panel)).toHaveLength(0);
    expect([...panel.querySelectorAll("button")].some((b) => b.textContent === "加入服务器")).toBe(false);
  });
});

describe("主页：账户皮肤", () => {
  it("取到真皮肤时立绘能拖动转身，仍在「管理账户」按钮里", async () => {
    ipc.overrides.set("skin_info", () => ({ kind: "remote", sha1: "ab".repeat(20), model: "wide", hat: true }));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(["skin"]) })));
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 64, height: 64 })));
    await mount();
    await flush();
    const figure = document.querySelector<HTMLElement>('[data-sk-art="skin"]');
    expect(figure?.dataset.art).toBe("skin");
    expect(figure?.querySelector('canvas[data-tauri-drag-region="false"]')).not.toBeNull();
    expect(figure?.closest("button")?.getAttribute("aria-label")).toBe("管理账户");
  });

  it("皮肤查询失败：照常画剪影立绘，不弹通知，原因写进控制台", async () => {
    const failure = new IpcError("io", "账户文件读不出来");
    ipc.overrides.set("skin_info", () => {
      throw failure;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await mount();
    expect(document.querySelector('[data-sk-art="skin"]')?.getAttribute("data-art")).toBe("silhouette");
    expect(launcher.state.toasts).toEqual([]);
    const skinWarnings = warn.mock.calls.filter(([message]) => String(message).includes("皮肤"));
    expect(skinWarnings).toHaveLength(1);
    expect(skinWarnings[0][1]).toBeInstanceOf(IpcError);
    expect((skinWarnings[0][1] as IpcError).message).toBe("账户文件读不出来");
  });

  it("刷新账户后皮肤信息重取失败：立绘沿用上次读到的皮肤，不退回剪影，原因写进控制台", async () => {
    const account = accountDto();
    ipc.overrides.set("skin_info", () => ({ kind: "remote", sha1: "cd".repeat(20), model: "wide", hat: true }));
    ipc.overrides.set("refresh_account", () => account);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(["skin"]) })));
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 64, height: 64 })));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await mount();
    await flush();
    const art = () => document.querySelector<HTMLElement>('[data-sk-art="skin"]')?.dataset.art;
    expect(art()).toBe("skin");
    const skinCalls = callsOf(ipc, "skin_info").length;

    ipc.overrides.set("skin_info", () => {
      throw new IpcError("io", "账户文件读不出来");
    });
    await act(async () => {
      await launcher.actions.refreshAccount(account.uuid);
    });
    await flush();
    expect(callsOf(ipc, "skin_info").slice(skinCalls)).toEqual([{ accountUuid: account.uuid }]);
    expect(art()).toBe("skin");
    // 这一次以失败落定（不是还停在重取中），提示写的是实际画出来的样子
    const skinWarnings = warn.mock.calls.filter(([message]) => String(message).includes("皮肤")).map(([message]) => message);
    expect(skinWarnings).toEqual(["[home] 当前账户的皮肤信息读不出来，立绘沿用上次读到的皮肤"]);
  });

  it("切换到皮肤信息还没读到的账户：立绘留着上一位的皮肤，读到「没有皮肤」才换成剪影", async () => {
    const first = accountDto();
    const second = accountDto({ uuid: "00000000-0000-0000-0000-00000000a002", name: "Alex" });
    let current = first;
    bootOverrides(ipc, { accounts: [first, second], instances, config: configDto({ selected_version: "生存" }) });
    ipc.overrides.set("list_instances", () => instances);
    ipc.overrides.set("current_account", () => current);
    ipc.overrides.set("set_current_account", (args: IpcArgs) => {
      current = args.uuid === second.uuid ? second : first;
      return null;
    });
    const secondSkin = deferred<null>();
    ipc.overrides.set("skin_info", (args: IpcArgs) => (args.accountUuid === second.uuid ? secondSkin.promise : { kind: "remote", sha1: "ef".repeat(20), model: "wide", hat: true }));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(["skin"]) })));
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 64, height: 64 })));
    await mount();
    await flush();
    const art = () => document.querySelector<HTMLElement>('[data-sk-art="skin"]')?.dataset.art;
    expect(art()).toBe("skin");

    await act(async () => {
      await launcher.actions.selectAccount(second.uuid);
    });
    await flush();
    expect(document.querySelector("h1")?.textContent).toContain("Alex");
    expect(art()).toBe("skin");
    secondSkin.resolve(null);
    await flush();
    expect(art()).toBe("silhouette");
  });
});
