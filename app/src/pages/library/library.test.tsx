// @vitest-environment jsdom
// @module-tag heavy-page
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { stubCanvas } from "../../art/illustrations/test-canvas";
import { CONFIRM_COPY, DELETE_INSTANCE_COPY, SLOW_LOADING_HINT, TOAST_COPY } from "../../copy/flows";
import type { GameDirectoryDto } from "../../ipc/config";
import type { InstanceDto, WorldDto } from "../../ipc/instances";
import { OverlayRoot } from "../../shell/overlay";
import { ShellProvider, useNav, useShell, type NavApi, type ShellApi } from "../../shell/shell";
import { LauncherProvider, useLauncher, type LauncherApi } from "../../state/launcher";
import { keydown, render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../test/dom";
import { emulateFocusFixup } from "../../test/focus-fixup";
import type { IpcRecorder } from "../../test/fake-bridge";
import { CORE_EVENT } from "../../ipc/tasks";
import { bootOverrides, callsOf, deferred, emit, instanceDto, resetRecorder, settle } from "../../test/launcher";
import { LIBRARY_COPY } from "./copy";
import LibraryPage from "./index";
import { resetLibraryView } from "./view-state";

// jsdom 没有 requestAnimationFrame，动画库在模块加载时取不到就把帧循环设成空操作，退场永远放不完。
// 在任何模块加载之前补一个走 setTimeout 的版本：调用时取的是当时的 setTimeout，假定时器推进即可驱动动画。
vi.hoisted(() => {
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16) as unknown as number;
  globalThis.cancelAnimationFrame = (handle: number) => clearTimeout(handle);
});
const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));

let view: Rendered | undefined;
let nav: NavApi;
let shell: ShellApi;
let launcher: LauncherApi;

function Probe() {
  nav = useNav();
  shell = useShell();
  launcher = useLauncher();
  return null;
}

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 31, 12);

function sample(): InstanceDto[] {
  return [
    instanceDto("樱花生存", { loaders: [{ kind: "fabric", version: "0.16.10" }], playtime_min: 120, last_played_at: NOW - 2 * HOUR, mod_count: 34 }),
    instanceDto("机械动力", { mc_version: "1.20.1", loaders: [{ kind: "forge", version: "47.3.0" }], playtime_min: 600, last_played_at: NOW - 48 * HOUR, mod_count: 0 }),
    instanceDto("原版", { created_at: NOW - 24 * HOUR }),
    instanceDto("坏掉的", { status: "broken", broken_reason: "缺少版本 JSON", mc_version: null, created_at: NOW - 400 * 24 * HOUR }),
  ];
}

let instances: InstanceDto[];

async function mount() {
  view = render(
    <LauncherProvider>
      <ShellProvider>
        <Probe />
        <LibraryPage />
        <OverlayRoot />
      </ShellProvider>
    </LauncherProvider>,
  );
  await flush();
}

const flush = () =>
  act(async () => {
    await settle();
  });

/** 等退场动画放完：被筛掉的卡片在退场期间仍留在 DOM 里。 */
const afterMotion = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
  });
}

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("jsdom 没有 input.value 的 setter");
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function byText<T extends HTMLElement>(selector: string, text: string, root: ParentNode = document): T {
  const el = [...root.querySelectorAll<T>(selector)].find((e) => e.textContent === text);
  if (el === undefined) throw new Error(`找不到文字为「${text}」的 ${selector}`);
  return el;
}

function byLabel<T extends HTMLElement>(label: string): T {
  const el = document.querySelector<T>(`[aria-label="${label}"]`);
  if (el === null) throw new Error(`找不到 aria-label 为「${label}」的元素`);
  return el;
}

/** 网格里各卡片的实例名，按显示顺序。 */
const cardNames = () => [...document.querySelectorAll<HTMLButtonElement>("article button[aria-label^='打开「']")].map((b) => b.textContent);
const createTile = () => [...document.querySelectorAll("section button")].find((b) => b.textContent === LIBRARY_COPY.createTileTitle + LIBRARY_COPY.createTileBody);
const toastTitles = () => launcher.state.toasts.map((t) => `${t.tone}:${t.title}`);
const menuItem = (text: string) => byText<HTMLElement>('[role="menuitem"]', text);

/** 菜单项悬停后关联的提示气泡写着什么：禁用原因不占标签，放在气泡里。 */
async function reasonOf(item: HTMLElement): Promise<string | null | undefined> {
  act(() => {
    item.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body }));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  const tipId = item.getAttribute("aria-describedby");
  if (tipId === null) throw new Error(`「${item.textContent}」悬停后没有关联提示气泡`);
  return document.getElementById(tipId)?.textContent;
}
const dialogButton = (text: string) => byText<HTMLButtonElement>('[role="dialog"] button', text);

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  resetRecorder(ipc);
  resetLibraryView();
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
  instances = sample();
  bootOverrides(ipc, { instances, pins: ["樱花生存"] });
  ipc.overrides.set("list_instances", () => instances);
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("set_sidebar_pins", (args) => args.pins);
  // 空实例库要等目录列表才定说法，假后端的命令又带模拟延迟：默认立即给回只有当前目录的列表
  ipc.overrides.set("list_game_directories", (): GameDirectoryDto[] => [{ name: "默认目录", path: "D:\\Games\\Launcher\\.minecraft", is_current: true, available: true, version_count: 0 }]);
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  // 帧循环排了下一帧就不会再排：换回真实时钟前把排在假时钟上的帧放掉，否则下一个用例的动画永远等不到这一帧
  act(() => {
    vi.advanceTimersByTime(200);
  });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("实例库：列表与页头", () => {
  it("每个实例一张卡，按最近活动排序，末尾是新建卡；页头写总数、固定数与累计时长", async () => {
    await mount();
    // 樱花生存 2 小时前玩过、原版昨天新建、机械动力 2 天前玩过、坏掉的 400 天前新建
    expect(cardNames()).toEqual(["樱花生存", "原版", "机械动力", "坏掉的"]);
    expect(createTile()).toBeDefined();
    expect(document.querySelector("header p")?.textContent).toBe("共 4 个实例 · 1 个固定在侧栏 · 累计 12 小时");
  });

  it("卡片显示加载器、版本与统计；损坏的卡片用原因替换统计行", async () => {
    await mount();
    const card = byText<HTMLButtonElement>("article button", "樱花生存").closest("article");
    if (card === null) throw new Error("找不到卡片");
    expect(card.textContent).toContain("Fabric0.16.10");
    expect(card.textContent).toContain("1.21.1");
    expect([...card.querySelectorAll("li")].map((li) => li.getAttribute("aria-label"))).toEqual(["上次游玩 2 小时前", "累计时长 2h", "Mod 数 34", "存档数 0"]);
    expect(card.textContent).toContain(LIBRARY_COPY.noDescription);
    const broken = byText<HTMLButtonElement>("article button", "坏掉的").closest("article");
    expect(broken?.textContent).toContain("缺少版本 JSON");
    expect(broken?.querySelector("ul")).toBeNull();
  });

  it("游玩记录读不出：卡片统计写读不到，不写从未游玩与 0m；页头不写累计 0", async () => {
    instances = instances.map((i) => ({ ...i, playtime_min: null, last_played_at: null, play_error: "解析 游玩记录 失败" }));
    await mount();
    const card = byText<HTMLButtonElement>("article button", "樱花生存").closest("article");
    if (card === null) throw new Error("找不到卡片");
    expect([...card.querySelectorAll("li")].map((li) => li.getAttribute("aria-label"))).toEqual(["上次游玩 读不到", "累计时长 读不到", "Mod 数 34", "存档数 0"]);
    expect(card.textContent).not.toContain("从未游玩");
    expect(card.textContent).not.toContain("0m");
    expect(document.querySelector("header p")?.textContent).toBe("共 4 个实例 · 1 个固定在侧栏 · 累计时长读不到");
  });

  it("整合包实例的介绍行写整合包名与版本，统计行带存档数；读不出存档数时不写", async () => {
    instances = [
      ...instances,
      instanceDto("我的冒险", {
        description: "自己写的介绍",
        world_count: 3,
        mod_count: 168,
        modpack: { platform: "curseforge", project_id: "285109", version_id: "4", name: "RLCraft", version: "2.9.3" },
      }),
      instanceDto("本地导入", { modpack: { platform: null, project_id: null, version_id: null, name: "空岛生存", version: null }, world_count: null }),
    ];
    await mount();
    const card = byText<HTMLButtonElement>("article button", "我的冒险").closest("article");
    if (card === null) throw new Error("找不到卡片");
    expect(card.querySelector("p")?.textContent).toBe("RLCraft 2.9.3");
    expect([...card.querySelectorAll("li")].map((li) => li.getAttribute("aria-label"))).toContain("存档数 3");
    const local = byText<HTMLButtonElement>("article button", "本地导入").closest("article");
    expect(local?.querySelector("p")?.textContent).toBe("空岛生存");
    expect([...(local?.querySelectorAll("li") ?? [])].map((li) => li.getAttribute("aria-label")).some((l) => l !== null && l.startsWith("存档数"))).toBe(false);
  });

  it("点卡片标题进实例概览", async () => {
    await mount();
    click(byLabel("打开「机械动力」"));
    expect(nav.route).toEqual({ page: "instance", id: "机械动力", tab: "overview" });
  });

  it("新建实例：页头主按钮与新建卡都打开新建流程；导入整合包跳发现页的整合包", async () => {
    await mount();
    click(byText("header button", LIBRARY_COPY.create));
    expect(shell.createInstance.open).toBe(true);
    act(() => shell.closeCreateInstance());
    const tile = createTile();
    if (tile === undefined) throw new Error("找不到新建卡");
    click(tile);
    expect(shell.createInstance).toEqual({ open: true, preset: null });
    click(byText("header button", LIBRARY_COPY.importModpack));
    expect(nav.route).toEqual({ page: "discover", kind: "modpack" });
  });
});

describe("实例库：筛选、搜索与空状态", () => {
  it("加载器筛选带数量；只剩一类时新建卡隐藏；清除筛选复原", async () => {
    await mount();
    click(byLabel("Forge，1 个"));
    await afterMotion();
    expect(cardNames()).toEqual(["机械动力"]);
    expect(createTile()).toBeUndefined();
    click(byLabel("Quilt，0 个"));
    await afterMotion();
    expect(cardNames()).toEqual([]);
    expect(document.body.textContent).toContain(LIBRARY_COPY.noMatchTitle);
    expect(document.body.textContent).toContain("还没有 Quilt 实例。");
    click(byText("button", LIBRARY_COPY.clearFilter));
    expect(cardNames()).toHaveLength(4);
  });

  it("搜索按名称子串过滤，没有结果时说明关键词；离开再回来保留筛选", async () => {
    await mount();
    const input = byLabel<HTMLInputElement>(LIBRARY_COPY.searchPlaceholder);
    setInput(input, "机械");
    await afterMotion();
    expect(cardNames()).toEqual(["机械动力"]);
    setInput(input, "不存在");
    expect(document.body.textContent).toContain("没有名字里带「不存在」的实例。");
    setInput(input, "生存");
    view?.unmount();
    await mount();
    expect(byLabel<HTMLInputElement>(LIBRARY_COPY.searchPlaceholder).value).toBe("生存");
    expect(cardNames()).toEqual(["樱花生存"]);
    expect(createTile()).toBeUndefined();
  });

  it("搜索也匹配整合包的名字", async () => {
    instances = [...instances, instanceDto("周末", { modpack: { platform: "modrinth", project_id: "x", version_id: "y", name: "Better MC", version: "v20" } })];
    await mount();
    setInput(byLabel<HTMLInputElement>(LIBRARY_COPY.searchPlaceholder), "better");
    await afterMotion();
    expect(cardNames()).toEqual(["周末"]);
  });

  it("Ctrl+F 聚焦搜索框", async () => {
    await mount();
    keydown(window, "f", { ctrlKey: true });
    expect(document.activeElement).toBe(byLabel(LIBRARY_COPY.searchPlaceholder));
  });

  it("没有实例：空状态的按钮去发现页导入整合包", async () => {
    instances = [];
    await mount();
    expect(document.querySelector("header p")?.textContent).toBe(LIBRARY_COPY.subtitleEmpty);
    click(byText("button", LIBRARY_COPY.emptyAction));
    expect(nav.route).toEqual({ page: "discover", kind: "modpack" });
  });

  it("列表 300 ms 内读到：不出现骨架；读得慢才出骨架，出现后至少停留 300 ms", async () => {
    const list = deferred<InstanceDto[]>();
    ipc.overrides.set("list_instances", () => list.promise);
    await mount();
    const skeletons = () => {
      const grid = document.querySelector(`[aria-label="${LIBRARY_COPY.loadingLabel}"]`);
      return grid === null ? 0 : grid.children.length;
    };
    expect(document.querySelector(`[aria-label="${LIBRARY_COPY.loadingLabel}"]`)).not.toBeNull();
    expect(skeletons()).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(299);
    });
    expect(skeletons()).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    // jsdom 里没有宽度，按 compact 档铺满两行
    expect(skeletons()).toBe(6);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
      list.resolve(instances);
      await settle();
    });
    expect(skeletons()).toBe(6);
    expect(cardNames()).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(skeletons()).toBe(0);
    expect(cardNames()).toHaveLength(4);
  });

  it("列表超过 10 秒还没读到：骨架下方追加「比平时慢一些」", async () => {
    ipc.overrides.set("list_instances", () => deferred<InstanceDto[]>().promise);
    await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_999);
    });
    expect(document.body.textContent).not.toContain(SLOW_LOADING_HINT);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(document.body.textContent).toContain(SLOW_LOADING_HINT);
  });

  it("列表读取失败：显示原因，重试重新读取", async () => {
    let fail = true;
    ipc.overrides.set("list_instances", () => {
      if (fail) throw new Error("扫描 versions 目录失败");
      return instances;
    });
    await mount();
    expect(document.body.textContent).toContain(LIBRARY_COPY.loadErrorTitle);
    expect(document.body.textContent).toContain("扫描 versions 目录失败");
    const before = callsOf(ipc, "list_instances").length;
    fail = false;
    click(byText("button", LIBRARY_COPY.retry));
    await flush();
    expect(callsOf(ipc, "list_instances").length).toBe(before + 1);
    expect(cardNames()).toHaveLength(4);
  });
});

describe("实例库：游戏目录", () => {
  const HOME = "D:\\Games\\Launcher\\.minecraft";
  const PCL = "E:\\Plain Craft Launcher 2\\.minecraft";
  const HMCL = "D:\\HMCL\\.minecraft";
  const directory = (name: string, path: string, version_count: number | null, overrides: Partial<GameDirectoryDto> = {}): GameDirectoryDto => ({
    name,
    path,
    is_current: false,
    available: true,
    version_count,
    ...overrides,
  });
  const home = directory("默认目录", HOME, 0, { is_current: true });
  const pcl = directory("PCL2", PCL, 12);
  const hmcl = directory("HMCL", HMCL, 3);
  const unplugged = directory("移动硬盘", "F:\\.minecraft", null, { available: false });

  const dirsAre = (dirs: GameDirectoryDto[]) => ipc.overrides.set("list_game_directories", () => dirs);
  const picker = () => document.querySelector<HTMLButtonElement>(`[role="combobox"][aria-label="${LIBRARY_COPY.directoryLabel}"]`);
  const openPicker = () => {
    const trigger = picker();
    if (trigger === null) throw new Error("工具条上没有目录选择");
    click(trigger);
  };
  const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
  const dialogTitle = () => document.querySelector('[role="dialog"] h2')?.textContent;

  beforeEach(() => {
    ipc.overrides.set("set_game_directory", () => null);
  });

  it("当前目录没有实例、别的目录有版本：空状态点名版本最多的目录和版本数，主按钮切过去，去发现降为次按钮", async () => {
    instances = [];
    dirsAre([home, hmcl, unplugged, pcl]);
    await mount();
    const text = document.body.textContent;
    expect(text).toContain(LIBRARY_COPY.switchEmptyTitle);
    expect(text).toContain("「PCL2」里有 12 个版本，切过去就能玩，文件不会被移动。");
    expect(text).not.toContain(LIBRARY_COPY.emptyTitle);
    expect(text).not.toContain(LIBRARY_COPY.emptyBody);
    expect(byText("button", "切到 PCL2").getAttribute("data-variant")).toBe("primary");
    const discover = byText("button", LIBRARY_COPY.emptyAction);
    expect(discover.getAttribute("data-variant")).toBe("secondary");
    click(discover);
    expect(nav.route).toEqual({ page: "discover", kind: "modpack" });
  });

  it("空状态的主按钮沿用切换流程：确认后切到那个目录并刷新目录列表", async () => {
    instances = [];
    dirsAre([home, pcl]);
    await mount();
    const listed = callsOf(ipc, "list_game_directories").length;
    click(byText("button", "切到 PCL2"));
    await flush();
    expect(dialogTitle()).toBe("切换到「PCL2」？");
    expect(callsOf(ipc, "set_game_directory")).toEqual([]);
    instances = sample();
    dirsAre([{ ...pcl, is_current: true }, { ...home, is_current: false }]);
    click(dialogButton("切换"));
    await flush();
    expect(callsOf(ipc, "set_game_directory")).toEqual([{ path: PCL }]);
    expect(callsOf(ipc, "list_game_directories").length).toBeGreaterThan(listed);
    await afterMotion();
    expect(cardNames()).toHaveLength(4);
    expect(picker()?.textContent).toBe("PCL2");
  });

  it("确认框点取消不切", async () => {
    instances = [];
    dirsAre([home, pcl]);
    await mount();
    click(byText("button", "切到 PCL2"));
    await flush();
    click(dialogButton(CONFIRM_COPY.cancel));
    await flush();
    expect(callsOf(ipc, "set_game_directory")).toEqual([]);
  });

  it("切换被后端拒绝：通知说明原因，空状态还在", async () => {
    instances = [];
    dirsAre([home, pcl]);
    ipc.overrides.set("set_game_directory", () => {
      throw new Error("这个位置现在访问不到");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await mount();
    click(byText("button", "切到 PCL2"));
    await flush();
    click(dialogButton("切换"));
    await flush();
    expect(toastTitles()).toContain("error:没能切换游戏目录");
    expect(document.body.textContent).toContain(LIBRARY_COPY.switchEmptyTitle);
    vi.restoreAllMocks();
  });

  it("路径带「!」：不弹确认，直接报错，不发切换", async () => {
    instances = [];
    dirsAre([home, directory("Hi!", "D:\\Hi!\\.minecraft", 2)]);
    await mount();
    click(byText("button", "切到 Hi!"));
    await flush();
    expect(dialogTitle()).toBeUndefined();
    expect(launcher.state.toasts.map((t) => [t.tone, t.title, t.body])).toEqual([["error", "没能切换游戏目录", "路径里不能有「!」，Java 会读不出里面的游戏文件"]]);
    expect(callsOf(ipc, "set_game_directory")).toEqual([]);
  });

  it("有下载在进行：主按钮带原因禁用，点了不弹确认；目录选择里别的目录也切不了", async () => {
    instances = [];
    dirsAre([home, pcl]);
    ipc.overrides.set("install_java", () => new Promise(() => undefined));
    await mount();
    await act(async () => {
      await launcher.actions.installJava(17);
    });
    await flush();
    const primary = byText<HTMLButtonElement>("button", "切到 PCL2");
    expect(primary.getAttribute("aria-disabled")).toBe("true");
    expect(await reasonOf(primary)).toBe("有游戏或下载在进行，结束后再切换");
    click(primary);
    await flush();
    expect(dialogTitle()).toBeUndefined();
    openPicker();
    const target = options()[1];
    expect(target.textContent).toBe("PCL2有游戏或下载在进行，结束后再切换");
    expect(target.getAttribute("aria-disabled")).toBe("true");
    click(target);
    await flush();
    expect(dialogTitle()).toBeUndefined();
    expect(callsOf(ipc, "set_game_directory")).toEqual([]);
  });

  it.each([
    ["别的目录是空的", [home, directory("空的", "D:\\Empty", 0)]],
    ["别的目录访问不到", [home, unplugged]],
    ["别的目录读不到版本数", [home, directory("读不到", "D:\\Locked", null)]],
    ["只有当前目录", [home]],
  ])("%s：空状态还是「实例库还是空的」，没有切换入口", async (_label, dirs) => {
    instances = [];
    dirsAre(dirs);
    await mount();
    expect(document.body.textContent).toContain(LIBRARY_COPY.emptyTitle);
    expect(document.body.textContent).toContain(LIBRARY_COPY.emptyBody);
    expect(document.body.textContent).not.toContain(LIBRARY_COPY.switchEmptyTitle);
    expect([...document.querySelectorAll("button")].filter((b) => b.textContent?.startsWith("切到"))).toEqual([]);
    expect(byText("button", LIBRARY_COPY.emptyAction)).toBeDefined();
  });

  it("目录列表还没回来：先不下结论，不闪「实例库还是空的」；回来后直接给切换入口", async () => {
    instances = [];
    const list = deferred<GameDirectoryDto[]>();
    ipc.overrides.set("list_game_directories", () => list.promise);
    await mount();
    expect(document.body.textContent).not.toContain(LIBRARY_COPY.emptyTitle);
    expect(document.querySelector(`[aria-label="${LIBRARY_COPY.loadingLabel}"]`)).not.toBeNull();
    await act(async () => {
      list.resolve([home, pcl]);
      await settle();
    });
    expect(document.body.textContent).toContain(LIBRARY_COPY.switchEmptyTitle);
  });

  it("目录列表读不出来：页面照常，退回普通空状态，没有目录选择", async () => {
    instances = [];
    ipc.overrides.set("list_game_directories", () => {
      throw new Error("读不出配置");
    });
    await mount();
    expect(document.body.textContent).toContain(LIBRARY_COPY.emptyTitle);
    expect(picker()).toBeNull();
  });

  it("目录列表读得慢不耽误有实例的目录：卡片先出来", async () => {
    ipc.overrides.set("list_game_directories", () => deferred<GameDirectoryDto[]>().promise);
    await mount();
    expect(cardNames()).toHaveLength(4);
    expect(picker()).toBeNull();
  });

  it("回到实例库时后台重读目录列表：别的启动器后来装的版本能看到", async () => {
    instances = [];
    dirsAre([home, { ...pcl, version_count: 0 }]);
    await mount();
    expect(document.body.textContent).toContain(LIBRARY_COPY.emptyTitle);
    view?.unmount();
    dirsAre([home, pcl]);
    await mount();
    expect(document.body.textContent).toContain(LIBRARY_COPY.switchEmptyTitle);
  });

  it("只登记了一个目录：工具条上没有目录选择", async () => {
    dirsAre([home]);
    await mount();
    expect(picker()).toBeNull();
  });

  it("登记了不止一个目录：工具条显示当前目录名，选项带版本数，当前目录的数跟实例列表走，访问不到的禁用并说明原因", async () => {
    dirsAre([home, pcl, directory("读不到", "D:\\Locked", null), unplugged]);
    await mount();
    expect(picker()?.textContent).toBe("默认目录");
    openPicker();
    expect(options().map((o) => [o.textContent, o.getAttribute("aria-disabled"), o.getAttribute("aria-selected")])).toEqual([
      ["默认目录4 个版本", null, "true"],
      ["PCL212 个版本", null, "false"],
      ["读不到版本数读不到", null, "false"],
      ["移动硬盘位置访问不到，无法切过去", "true", "false"],
    ]);
    click(options()[3]);
    await flush();
    expect(dialogTitle()).toBeUndefined();
  });

  it("目录选择选中别的目录：用登记的名字问确认，切换前显示的还是原目录，确认后切过去", async () => {
    dirsAre([home, directory("我的 HMCL", HMCL, 3)]);
    await mount();
    openPicker();
    click(options()[1]);
    await flush();
    expect(dialogTitle()).toBe("切换到「我的 HMCL」？");
    expect(picker()?.textContent).toBe("默认目录");
    click(dialogButton("切换"));
    await flush();
    expect(callsOf(ipc, "set_game_directory")).toEqual([{ path: HMCL }]);
  });

  it("目录选择再选当前目录：什么都不做", async () => {
    dirsAre([home, pcl]);
    await mount();
    openPicker();
    click(options()[0]);
    await flush();
    expect(dialogTitle()).toBeUndefined();
    expect(callsOf(ipc, "set_game_directory")).toEqual([]);
  });
});

describe("实例库：动作", () => {
  it("修复横幅列出损坏实例，「立即修复」为它排一个补全任务", async () => {
    await mount();
    expect(document.body.textContent).toContain("1 个实例需要修复「坏掉的」缺少游戏文件，补全后就能启动。");
    click(byText("button", LIBRARY_COPY.repairOne));
    await flush();
    const repairs = launcher.state.tasks.filter((t) => t.spec.command === "repair_instance");
    expect(repairs.map((t) => t.spec.args)).toEqual([{ id: "坏掉的" }]);
    expect(callsOf(ipc, "repair_instance").map((a) => a.id)).toEqual(["坏掉的"]);
  });

  it("补全连跑两批下载：卡片底栏的进度条第二批从当批进度重新走，不停在上一批的满格", async () => {
    ipc.overrides.set("repair_instance", () => new Promise(() => undefined));
    await mount();
    click(byText("button", LIBRARY_COPY.repairOne));
    await flush();
    const [task] = launcher.state.tasks;
    const bar = () => {
      const card = byText<HTMLButtonElement>("article button", "坏掉的").closest("article");
      const el = card === null ? null : card.querySelector<HTMLElement>('[role="progressbar"]');
      if (el === null) throw new Error("卡片上没有进度条");
      return el;
    };
    act(() => emit(CORE_EVENT, { kind: "download", task_id: `${task.id}#1`, total: 3, finished: 3, bytes: 3_000, total_bytes: 3_000, speed: 1_000 }));
    await flush();
    expect(bar().getAttribute("aria-valuenow")).toBe("100");
    act(() => emit(CORE_EVENT, { kind: "download", task_id: `${task.id}#1`, total: 40, finished: 2, bytes: 5_000, total_bytes: 100_000, speed: 1_000 }));
    await flush();
    expect(bar().getAttribute("aria-valuenow")).toBe("5");
    // 换批时进度条与卡片底栏的动画还在帧循环里：放完再收尾，免得排在假时钟上的帧留给下一个用例
    await afterMotion();
  });

  it("整合包没导入完的实例不进修复横幅，卡片底栏给「重新导入」与「删除」而不是「修复并启动」", async () => {
    const incomplete = { kind: "modpack" as const, outcome: "failed" as const, started_at: NOW - HOUR, spec: null, error: { code: "network_failed", message: "连接被重置" } };
    instances = [
      ...instances,
      instanceDto("RLCraft", {
        status: "broken",
        broken_reason: null,
        incomplete,
        modpack: { platform: "modrinth", project_id: "rlc", version_id: "v293", name: "RLCraft", version: "2.9.3" },
      }),
      instanceDto("本地包", { status: "broken", broken_reason: null, incomplete, modpack: null }),
    ];
    await mount();
    // 横幅只数补全能修好的那一个
    expect(document.body.textContent).toContain("1 个实例需要修复「坏掉的」缺少游戏文件，补全后就能启动。");
    const card = byText<HTMLButtonElement>("article button", "RLCraft").closest("article");
    if (card === null) throw new Error("找不到卡片");
    expect(card.textContent).toContain("整合包没有导入完，删掉这个实例后重新导入");
    expect([...card.querySelectorAll("button")].map((b) => b.textContent)).not.toContain("修复并启动");
    click(byText("button", LIBRARY_COPY.repairOne));
    await flush();
    expect(callsOf(ipc, "repair_instance").map((a) => a.id)).toEqual(["坏掉的"]);
    click(byText("button", "重新导入", card));
    expect(nav.route).toEqual({ page: "discover", kind: "modpack", open: { platform: "modrinth", projectId: "rlc" } });
    const local = byText<HTMLButtonElement>("article button", "本地包").closest("article");
    if (local === null) throw new Error("找不到卡片");
    click(byText("button", "重新导入", local));
    expect(nav.route).toEqual({ page: "discover", kind: "modpack" });
    ipc.overrides.set("preview_instance_deletion", (args) => ({ id: args.id, worlds: [], size_bytes: 0, file_count: 0, dependents: [], activity: null }));
    click(byText("button", "删除", local));
    await flush();
    expect(callsOf(ipc, "preview_instance_deletion")).toEqual([{ id: "本地包" }]);
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe("删除「本地包」？");
  });

  it("图钉：追加到固定列表末尾并通知；已固定的取消固定", async () => {
    await mount();
    click(byLabel("把「机械动力」固定到侧栏"));
    await flush();
    expect(callsOf(ipc, "set_sidebar_pins").map((a) => a.pins)).toEqual([["樱花生存", "机械动力"]]);
    expect(toastTitles()).toContain("success:已把「机械动力」固定到侧栏");
    click(byLabel("从侧栏取消固定「樱花生存」"));
    await flush();
    expect(callsOf(ipc, "set_sidebar_pins").map((a) => a.pins)).toEqual([["樱花生存", "机械动力"], ["机械动力"]]);
    expect(toastTitles()).toContain("success:已从侧栏取消固定「樱花生存」");
  });

  it("侧栏从满到不满：聚焦着的图钉不重挂，焦点留在它上面", async () => {
    instances = ["a", "b", "c", "d", "e", "f"].map((id) => instanceDto(id));
    bootOverrides(ipc, { instances, pins: ["a", "b", "c", "d", "e"] });
    ipc.overrides.set("list_instances", () => instances);
    await mount();
    const pin = byLabel("把「f」固定到侧栏");
    act(() => pin.focus());
    await act(async () => {
      await launcher.actions.togglePin("a");
    });
    await flush();
    expect(byLabel("把「f」固定到侧栏")).toBe(pin);
    expect(document.activeElement).toBe(pin);
    expect(pin.getAttribute("aria-disabled")).toBeNull();
  });

  it("侧栏已满 5 个：图钉不写固定列表，只给上限提示；菜单项禁用并说明原因", async () => {
    instances = ["a", "b", "c", "d", "e", "f"].map((id) => instanceDto(id));
    bootOverrides(ipc, { instances, pins: ["a", "b", "c", "d", "e"] });
    ipc.overrides.set("list_instances", () => instances);
    await mount();
    const pin = byLabel("把「f」固定到侧栏");
    expect(pin.getAttribute("aria-disabled")).toBe("true");
    click(pin);
    await flush();
    expect(callsOf(ipc, "set_sidebar_pins")).toEqual([]);
    expect(toastTitles()).toEqual([`warning:${TOAST_COPY.pinLimit}`]);
    click(byLabel("「f」的更多操作"));
    const item = menuItem(LIBRARY_COPY.menu.pin);
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(await reasonOf(item)).toBe(LIBRARY_COPY.menu.pinFull);
  });

  it("设为当前实例：写配置并通知；之后卡片标出「当前」、菜单项禁用", async () => {
    await mount();
    click(byLabel("「原版」的更多操作"));
    click(menuItem(LIBRARY_COPY.menu.select));
    await flush();
    expect(callsOf(ipc, "update_config")).toEqual([{ selectedVersion: "原版" }]);
    expect(toastTitles()).toContain("info:「原版」已设为当前实例");
    const card = byText<HTMLButtonElement>("article button", "原版").closest("article");
    expect(card?.textContent).toContain(LIBRARY_COPY.current);
    click(byLabel("「原版」的更多操作"));
    expect(menuItem(LIBRARY_COPY.menu.selected).getAttribute("aria-disabled")).toBe("true");
  });

  it("删除：先问后端有几个存档，确认框照实列出并说明移入回收站，确认后删除", async () => {
    const world = (dir: string, name: string | null, size: number): WorldDto => ({
      dir_name: dir,
      level_status: "ok",
      level_error: null,
      name,
      mode: "survival",
      last_played: null,
      size_bytes: size,
      modified_at: null,
    });
    ipc.overrides.set("preview_instance_deletion", (args) => ({
      id: args.id,
      worlds: [world("w1", "新的世界", 512 * 1024), world("生存", null, 512 * 1024)],
      size_bytes: 4096 * 1024,
      file_count: 3,
      dependents: [],
      activity: null,
    }));
    ipc.overrides.set("delete_instance", (args) => {
      instances = instances.filter((i) => i.id !== args.id);
      return { existed: true };
    });
    await mount();
    click(byLabel("「原版」的更多操作"));
    click(menuItem(LIBRARY_COPY.menu.remove));
    await flush();
    expect(callsOf(ipc, "preview_instance_deletion")).toEqual([{ id: "原版" }]);
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.querySelector("h2")?.textContent).toBe("删除「原版」？");
    expect(dialog?.textContent).toContain("实例文件夹会移入回收站，其中的 2 个存档（共 1.0 MB）也会一起删除：");
    expect([...(dialog?.querySelectorAll("li") ?? [])].map((li) => li.textContent)).toEqual(["新的世界", "生存"]);
    expect(dialog?.textContent).toContain(DELETE_INSTANCE_COPY.backupHint);
    expect(dialog?.textContent).not.toContain(DELETE_INSTANCE_COPY.pendingTask);
    click(dialogButton("删除实例和 2 个存档"));
    await flush();
    expect(callsOf(ipc, "delete_instance")).toEqual([{ id: "原版" }]);
    expect(toastTitles()).toContain("info:已删除「原版」");
  });

  it("删除排队中的新建实例：磁盘上还没有目录，不问后端预览，确认框说明会先取消任务", async () => {
    ipc.overrides.set("install_version", () => new Promise(() => undefined));
    await mount();
    await act(async () => {
      await launcher.actions.createInstance({ name: "周末生存", mcVersion: "1.21.1", loader: "vanilla", loaderVersion: null, cover: "cherry_planks" });
      await settle();
    });
    // 安装命令已经发出、任务在跑：原因不能说「还没开始安装」，与实例详情页同一句
    expect(launcher.state.tasks.filter((t) => t.spec.command === "install_version").map((t) => t.status)).toEqual(["running"]);
    click(byLabel("「周末生存」的更多操作"));
    // 占位项盘上可能还没有目录：打开文件夹只写标签并禁用，原因在悬停气泡里，点了不发起
    const folder = menuItem(LIBRARY_COPY.menu.openFolder);
    expect(folder.getAttribute("aria-disabled")).toBe("true");
    expect(await reasonOf(folder)).toBe("新建的实例还没装好，装完后才能打开文件夹");
    click(folder);
    expect(callsOf(ipc, "open_folder")).toEqual([]);
    click(menuItem(LIBRARY_COPY.menu.remove));
    await flush();
    expect(callsOf(ipc, "preview_instance_deletion")).toEqual([]);
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain(DELETE_INSTANCE_COPY.noWorlds);
    expect(dialog?.textContent).toContain(DELETE_INSTANCE_COPY.pendingTask);
  });

  it("「崩溃诊断」只给崩溃过的实例；之后没再正常玩过才提示「上次崩溃」", async () => {
    instances = instances.map((i) => {
      if (i.id === "樱花生存") return { ...i, last_crash_at: NOW - HOUR, last_played_at: NOW - HOUR };
      if (i.id === "机械动力") return { ...i, last_crash_at: NOW - 72 * HOUR };
      return i;
    });
    await mount();
    const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((el) => el.textContent);
    click(byLabel("「樱花生存」的更多操作"));
    expect(items()).toContain(LIBRARY_COPY.menu.crash + LIBRARY_COPY.menu.crashActive);
    click(menuItem(LIBRARY_COPY.menu.crash + LIBRARY_COPY.menu.crashActive));
    expect(nav.route).toEqual({ page: "instance", id: "樱花生存", tab: "crash" });
    act(() => nav.go({ page: "library" }));
    await afterMotion();
    click(byLabel("「机械动力」的更多操作"));
    expect(items()).toContain(LIBRARY_COPY.menu.crash);
    keydown(document, "Escape");
    await afterMotion();
    click(byLabel("「原版」的更多操作"));
    expect(items().some((t) => t !== null && t.startsWith(LIBRARY_COPY.menu.crash))).toBe(false);
  });

  it("取消删除确认不删", async () => {
    ipc.overrides.set("preview_instance_deletion", (args) => ({ id: args.id, worlds: [], size_bytes: 0, file_count: 0, dependents: [], activity: null }));
    await mount();
    click(byLabel("「原版」的更多操作"));
    click(menuItem(LIBRARY_COPY.menu.remove));
    await flush();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("这个实例没有存档。实例文件夹、Mod 与配置会一起移入回收站。");
    expect(dialogButton("删除实例")).toBeDefined();
    click(dialogButton(CONFIRM_COPY.cancel));
    await flush();
    expect(callsOf(ipc, "delete_instance")).toEqual([]);
  });

  it("加载态按下「取消启动」后进入正在结束：按钮保持可聚焦，焦点留在它上面，再按不重复发取消", async () => {
    onTestFinished(emulateFocusFixup());
    const launch = deferred<{ pid: number | null }>();
    ipc.overrides.set("launch_game", () => launch.promise);
    const cancel = deferred<boolean>();
    ipc.overrides.set("cancel_task", () => cancel.promise);
    await mount();
    const card = byText<HTMLButtonElement>("article button", "原版").closest("article");
    if (card === null) throw new Error("找不到卡片");
    click(byText("button", "启动", card));
    await flush();
    const stop = card.querySelector<HTMLButtonElement>('[aria-label="取消启动"]');
    if (stop === null) throw new Error("加载态没有「取消启动」");
    act(() => stop.focus());
    click(stop);
    await flush();
    expect(callsOf(ipc, "cancel_task")).toHaveLength(1);
    expect(card.querySelector('[aria-label="取消启动"]')).toBe(stop);
    expect(stop.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(stop);
    click(stop);
    await flush();
    expect(callsOf(ipc, "cancel_task")).toHaveLength(1);
  });

  it("启动：卡片底栏进入加载态，别的卡注明另一个游戏在运行；运行中的实例不能删除", async () => {
    const launch = deferred<{ pid: number | null }>();
    ipc.overrides.set("launch_game", () => launch.promise);
    await mount();
    const card = byText<HTMLButtonElement>("article button", "原版").closest("article");
    if (card === null) throw new Error("找不到卡片");
    click(byText("button", "启动", card));
    await flush();
    expect(callsOf(ipc, "launch_game").map((a) => a.versionId)).toEqual(["原版"]);
    expect(card.querySelector('[aria-label="取消启动"]')).not.toBeNull();
    const other = byText<HTMLButtonElement>("article button", "樱花生存").closest("article");
    expect(other?.textContent).toContain("另一个游戏在运行");
    click(byLabel("「原版」的更多操作"));
    const remove = menuItem(LIBRARY_COPY.menu.remove);
    expect(remove.getAttribute("aria-disabled")).toBe("true");
    expect(await reasonOf(remove)).toBe("游戏正在运行，先结束游戏");
  });

  it("后端在备份或恢复存档（含游戏退出后的自动备份）：底栏「启动」与菜单里的删除都带原因禁用，点了不发 launch_game 与删除预览", async () => {
    instances = instances.map((i) => (i.id === "原版" ? { ...i, activity: "backing_up" } : i));
    await mount();
    const card = byText<HTMLButtonElement>("article button", "原版").closest("article");
    if (card === null) throw new Error("找不到卡片");
    const launch = byText<HTMLButtonElement>("button", "启动", card);
    expect(launch.getAttribute("aria-disabled")).toBe("true");
    expect(await reasonOf(launch)).toBe("正在备份或恢复存档，完成后再启动");
    click(launch);
    await flush();
    expect(callsOf(ipc, "launch_game")).toEqual([]);
    click(byLabel("「原版」的更多操作"));
    const remove = menuItem(LIBRARY_COPY.menu.remove);
    expect(remove.getAttribute("aria-disabled")).toBe("true");
    expect(await reasonOf(remove)).toBe("正在备份或恢复这个实例的存档，完成后才能删除");
    click(remove);
    await flush();
    expect(callsOf(ipc, "preview_instance_deletion")).toEqual([]);
    // 别的实例不受影响
    const other = byText<HTMLButtonElement>("article button", "樱花生存").closest("article");
    if (other === null) throw new Error("找不到卡片");
    expect(byText<HTMLButtonElement>("button", "启动", other).getAttribute("aria-disabled")).toBeNull();
  });

  it("损坏的实例被别的实例当作基底：底栏「修复并启动」与修复横幅都带原因禁用，点了不排补全", async () => {
    instances = instances.map((i) => (i.id === "坏掉的" ? { ...i, activity: "inherited", used_by: "Fabric 整合" } : i));
    await mount();
    const card = byText<HTMLButtonElement>("article button", "坏掉的").closest("article");
    if (card === null) throw new Error("找不到卡片");
    const repair = byText<HTMLButtonElement>("button", "修复并启动", card);
    expect(repair.getAttribute("aria-disabled")).toBe("true");
    expect(await reasonOf(repair)).toBe("实例「Fabric 整合」正在使用它，结束后才能补全");
    click(repair);
    await flush();
    const banner = byText<HTMLButtonElement>("button", LIBRARY_COPY.repairOne);
    expect(banner.getAttribute("aria-disabled")).toBe("true");
    expect(await reasonOf(banner)).toBe("实例「Fabric 整合」正在使用它，结束后才能补全");
    click(banner);
    await flush();
    expect(callsOf(ipc, "repair_instance")).toEqual([]);
    expect(launcher.state.tasks).toEqual([]);
  });

  it("修复横幅的「全部修复」：被占着的实例这轮不排，其余照排", async () => {
    instances = [...instances, instanceDto("也坏了", { status: "broken", broken_reason: "缺少客户端 jar", activity: "backing_up" })];
    await mount();
    const repairAll = byText<HTMLButtonElement>("button", LIBRARY_COPY.repairAll);
    expect(repairAll.getAttribute("aria-disabled")).toBeNull();
    click(repairAll);
    await flush();
    expect(callsOf(ipc, "repair_instance").map((a) => a.id)).toEqual(["坏掉的"]);
  });

  it("整合包没导入完的实例在备份或恢复存档：底栏「删除」带原因禁用，不发删除预览", async () => {
    const incomplete = { kind: "modpack" as const, outcome: "failed" as const, started_at: NOW - HOUR, spec: null, error: { code: "network_failed", message: "连接被重置" } };
    instances = [...instances, instanceDto("本地包", { status: "broken", broken_reason: null, incomplete, modpack: null, activity: "backing_up" })];
    await mount();
    const card = byText<HTMLButtonElement>("article button", "本地包").closest("article");
    if (card === null) throw new Error("找不到卡片");
    const remove = byText<HTMLButtonElement>("button", "删除", card);
    expect(remove.getAttribute("aria-disabled")).toBe("true");
    expect(await reasonOf(remove)).toBe("正在备份或恢复这个实例的存档，完成后才能删除");
    click(remove);
    await flush();
    expect(callsOf(ipc, "preview_instance_deletion")).toEqual([]);
  });

  it("后端正在改动 Mod、资源或设置：删除入口提前禁用并写明原因，不发预览与删除", async () => {
    instances = instances.map((i) => (i.id === "原版" ? { ...i, activity: "modifying" } : i));
    await mount();
    click(byLabel("「原版」的更多操作"));
    const remove = menuItem(LIBRARY_COPY.menu.remove);
    expect(remove.getAttribute("aria-disabled")).toBe("true");
    expect(await reasonOf(remove)).toBe("正在改动这个实例的 Mod、资源或设置，完成后才能删除");
    click(remove);
    await flush();
    expect(callsOf(ipc, "preview_instance_deletion")).toEqual([]);
    expect(callsOf(ipc, "delete_instance")).toEqual([]);
  });

  it("别的实例正以它为基底：删除入口提前禁用，原因写明是哪个实例在用，不发预览与删除", async () => {
    instances = instances.map((i) => (i.id === "原版" ? { ...i, activity: "inherited", used_by: "Fabric 整合" } : i));
    await mount();
    click(byLabel("「原版」的更多操作"));
    const remove = menuItem(LIBRARY_COPY.menu.remove);
    expect(remove.getAttribute("aria-disabled")).toBe("true");
    expect(await reasonOf(remove)).toBe("实例「Fabric 整合」正在使用它，结束后才能删除");
    click(remove);
    await flush();
    expect(callsOf(ipc, "preview_instance_deletion")).toEqual([]);
    expect(callsOf(ipc, "delete_instance")).toEqual([]);
  });
});
