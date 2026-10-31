// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../art/illustrations/test-canvas";
import type { InstanceDto } from "../../ipc/instances";
import { IpcError } from "../../ipc/errors";
import { GAME_EXIT_EVENT } from "../../ipc/launch";
import type { KnownServerDto, NewsItemDto, PinnedServerDto, PlayDayDto, ServerStatusDto } from "../../state/queries/home";
import { OverlayRoot } from "../../shell/overlay";
import { ShellProvider, useNav, useShell, type NavApi, type ShellApi } from "../../shell/shell";
import { LauncherProvider, useLauncher, type LauncherApi } from "../../state/launcher";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../test/dom";
import type { IpcArgs, IpcRecorder } from "../../test/fake-bridge";
import { bootOverrides, callsOf, configDto, emit, instanceDto, resetRecorder, settle } from "../../test/launcher";
import { RemoteImageProvider } from "../../ui/remote-image";
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
    <LauncherProvider>
      <ShellProvider>
        <RemoteImageProvider resolve={async (url) => url}>
          <Probe />
          <HomePage route={{ page: "home" }} />
        </RemoteImageProvider>
        <OverlayRoot />
      </ShellProvider>
    </LauncherProvider>,
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
  pinned = [{ name: "晨星", address: "play.example" }];
  bootOverrides(ipc, { instances, config: configDto({ selected_version: "生存" }) });
  ipc.overrides.set("list_instances", () => instances);
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("skin_info", () => null);
  ipc.overrides.set("play_stats", (args: IpcArgs) => {
    const range = args.range as { from: string; to: string };
    return { from: range.from, to: range.to, days: PLAY_DAYS, total_minutes: 300, instances: [] };
  });
  ipc.overrides.set("list_news", () => ({ items: NEWS, fetched_at: NOW, offline: false }));
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
    expect(text()).not.toContain("最近游玩");
    click(buttonByText("新建实例"));
    expect(shell.createInstance).toEqual({ open: true, preset: null });
    click(buttonByText("添加账户"));
    expect(nav.route).toEqual({ page: "accounts" });
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
  it("按发布时刻倒序列出，标签写类型", async () => {
    await mount();
    const titles = [...document.querySelectorAll<HTMLButtonElement>("button")].map((b) => b.textContent).filter((t) => t?.startsWith("Minecraft"));
    expect(titles).toEqual(["Minecraft 1.21.1", "Minecraft 26.3", "Minecraft Live 回顾"]);
    expect(text()).toContain("正式版");
    expect(text()).toContain("活动");
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
    click(buttonByText("重试"));
    await flush();
    expect(callsOf(ipc, "list_news")).toHaveLength(before + 1);
  });

  it("后端给的是缓存：副标题注明离线中", async () => {
    ipc.overrides.set("list_news", () => ({ items: NEWS, fetched_at: NOW - DAY, offline: true }));
    await mount();
    expect(text()).toContain("游戏更新与官方活动 · 离线中");
  });

  it("断网又没有缓存：说「需要联网获取」而不是拉取失败；恢复联网自动重取一次", async () => {
    let reachable = false;
    ipc.overrides.set("list_news", () => {
      if (!reachable) throw new IpcError("network_failed", "dns lookup failed");
      return { items: NEWS, fetched_at: NOW, offline: false };
    });
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await mount();
    expect(text()).toContain("需要联网获取");
    expect(text()).not.toContain("资讯暂时没拉下来");
    expect(callsOf(ipc, "list_news")).toHaveLength(1);

    reachable = true;
    setOnline(true);
    await flush();
    expect(callsOf(ipc, "list_news")).toHaveLength(2);
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
    expect(text()).toContain("127 / 500 在线");
    expect(text()).toContain("38 ms");
    await openMenu(buttonByLabel("固定服务器"));
    expect(menuItems().map((el) => el.textContent)).toEqual(["本地localhost"]);
    click(menuItem("本地"));
    await flush();
    expect(callsOf(ipc, "set_pinned_servers").at(-1)).toEqual({
      servers: [
        { name: "晨星", address: "play.example" },
        { name: "本地", address: "localhost" },
      ],
    });
    expect(text()).toContain("2 个 · 在线人数与延迟");
    expect(text()).toContain("连不上");
    expect(text()).toContain("上次 2 小时前在线 1.2 万");

    await openMenu(buttonByLabel("晨星 的更多操作"));
    click(menuItem("取消固定"));
    await flush();
    expect(callsOf(ipc, "set_pinned_servers").at(-1)).toEqual({ servers: [{ name: "本地", address: "localhost" }] });
  });

  it("全部已固定时加号菜单只有一条禁用说明", async () => {
    pinned = [
      { name: "晨星", address: "play.example" },
      { name: "本地", address: "localhost" },
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
    const pickRows = () => [...picker().querySelectorAll<HTMLButtonElement>('button[aria-label^="固定 "]')];
    expect(pickRows().map((b) => b.getAttribute("aria-label"))).toEqual(many.map((k) => `固定 ${k.name}`));

    click(pickRows()[11]);
    await flush();
    expect(callsOf(ipc, "set_pinned_servers").at(-1)).toEqual({
      servers: [
        { name: "晨星", address: "play.example" },
        { name: "服12", address: "s12.example" },
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
    const rows = () => [...picker.querySelectorAll<HTMLButtonElement>('button[aria-label^="固定 "]')];
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
    const pickRow = (name: string) => (dialog() as HTMLElement).querySelector<HTMLButtonElement>(`button[aria-label="固定 ${name}"]`);

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

  // 单台测速分不出本机断网与服务器宕机：本机离线时整张卡说明本机离线，不把每台都标成连不上
  it("断网：整卡注明本机离线并暂停测速，每台都不下连通结论，在线人数取上次的结果；恢复联网立即重测一次", async () => {
    pinned = [
      { name: "晨星", address: "play.example" },
      { name: "本地", address: "localhost" },
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
    expect(text()).toContain("127 / 500 在线");
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

  it("没有固定服务器：紧凑空状态", async () => {
    pinned = [];
    await mount();
    expect(text()).toContain("还没有固定服务器");
    expect(text()).toContain("把常去的服务器放这里");
  });
});

describe("主页：账户皮肤", () => {
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
});
