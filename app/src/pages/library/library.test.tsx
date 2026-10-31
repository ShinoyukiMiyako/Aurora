// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../art/illustrations/test-canvas";
import { CONFIRM_COPY, DELETE_INSTANCE_COPY, TOAST_COPY } from "../../copy/flows";
import type { InstanceDto, WorldDto } from "../../ipc/instances";
import { OverlayRoot } from "../../shell/overlay";
import { ShellProvider, useNav, useShell, type NavApi, type ShellApi } from "../../shell/shell";
import { LauncherProvider, useLauncher, type LauncherApi } from "../../state/launcher";
import { keydown, render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { bootOverrides, callsOf, deferred, instanceDto, resetRecorder, settle } from "../../test/launcher";
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
    expect(card.textContent).toContain("整合包没有导入完，请删掉这个实例后重新导入");
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
    const item = menuItem(LIBRARY_COPY.menu.pin + LIBRARY_COPY.menu.pinFull);
    expect(item.getAttribute("aria-disabled")).toBe("true");
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
    click(byLabel("「周末生存」的更多操作"));
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
    const remove = menuItem(`${LIBRARY_COPY.menu.remove}游戏正在运行，先结束游戏`);
    expect(remove.getAttribute("aria-disabled")).toBe("true");
  });

  it("后端正在改动 Mod、资源或设置：删除入口提前禁用并写明原因，不发预览与删除", async () => {
    instances = instances.map((i) => (i.id === "原版" ? { ...i, activity: "modifying" } : i));
    await mount();
    click(byLabel("「原版」的更多操作"));
    const remove = menuItem(`${LIBRARY_COPY.menu.remove}正在改动这个实例的 Mod、资源或设置，完成后才能删除`);
    expect(remove.getAttribute("aria-disabled")).toBe("true");
    click(remove);
    await flush();
    expect(callsOf(ipc, "preview_instance_deletion")).toEqual([]);
    expect(callsOf(ipc, "delete_instance")).toEqual([]);
  });
});
