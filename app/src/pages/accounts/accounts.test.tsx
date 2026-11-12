// @vitest-environment jsdom
// @module-tag heavy-page
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../art/illustrations/test-canvas";
import type { AccountDto } from "../../ipc/accounts";
import { IpcError } from "../../ipc/errors";
import { NO_ART, setArtStatus } from "../../mc/art";
import { clearArtCache } from "../../mc/useArt";
import { OverlayRoot } from "../../shell/overlay";
import { ShellProvider } from "../../shell/shell";
import { LauncherProvider, useLauncher, type LauncherApi } from "../../state/launcher";
import { drainFrames, render, stepFrames, stubMatchMedia, stubResizeObserver, type Rendered } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { accountDto, bootOverrides, callsOf, configDto, deferred, instanceDto, resetRecorder, settle } from "../../test/launcher";
import AccountsPage from "./index";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));

const NOW = new Date(2026, 9, 31, 12, 0, 0).getTime();
/** 假时钟会接管 setImmediate；等未处理的拒绝上报要用真的那一个。 */
const realSetImmediate = setImmediate;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const hanami = accountDto({
  uuid: "6a1f0c0e4b5d4c3e9f2a7b8c9d0e1f20",
  name: "Hanami",
  account_type: "microsoft",
  added_at: NOW - 3 * DAY,
  last_verified_at: NOW - HOUR,
});
const steve = accountDto({ uuid: "0f3c5a7e9b1d4f6a8c2e4a6b8d0f2a4c", name: "Steve", account_type: "offline" });
const yozakura = accountDto({
  uuid: "b7c2d3e4f5a64b7c8d9e0f1a2b3c4d5e",
  name: "Yozakura",
  account_type: "authlib_injector",
  auth_server: "Example Skin",
  server_url: "https://skin.example/api/yggdrasil/",
  username: "yozakura@example.com",
  status: "expired",
  last_verified_at: NOW - 9 * DAY,
});

let view: Rendered | undefined;
let launcher: LauncherApi;
let accounts: AccountDto[];
let currentUuid: string | null;
let net: { onLine: boolean; clipboard: { writeText: ReturnType<typeof vi.fn> }; userAgent: string };

function Probe() {
  launcher = useLauncher();
  return null;
}

/** 账户表由测试持有：写命令改它，读命令照它返回，和后端一样「改完再读」。 */
function useAccounts(list: AccountDto[], current: string | null) {
  accounts = list;
  currentUuid = current;
  bootOverrides(ipc, { accounts: list });
  ipc.overrides.set("list_accounts", () => accounts);
  ipc.overrides.set("current_account", () => accounts.find((a) => a.uuid === currentUuid) ?? null);
  ipc.overrides.set("set_current_account", (args) => {
    currentUuid = args.uuid as string;
    return null;
  });
  ipc.overrides.set("remove_account", (args) => {
    accounts = accounts.filter((a) => a.uuid !== args.uuid);
    if (currentUuid === args.uuid) currentUuid = accounts.length > 0 ? accounts[0].uuid : null;
    return null;
  });
}

const flush = () =>
  act(async () => {
    await settle();
  });

async function mount() {
  view = render(
    <LauncherProvider>
      <ShellProvider>
        <Probe />
        <AccountsPage route={{ page: "accounts" }} />
        <OverlayRoot />
      </ShellProvider>
    </LauncherProvider>,
  );
  await flush();
}

const page = () => view?.container as HTMLElement;
/** 页面上还在的文字：退场中（inert）的块已经让出位置、正在淡出，不算。 */
function liveText(): string | null {
  const clone = page().cloneNode(true) as HTMLElement;
  for (const leaving of clone.querySelectorAll("[inert]")) leaving.remove();
  return clone.textContent;
}
const subtitle = () => page().querySelector("header p")?.textContent;
const spotlightName = () => page().querySelector("section h2")?.textContent;
/** 不在退场中的元素：退场的卡、横幅还在 DOM 里淡出，但已经带上 inert。 */
const live = <T extends Element>(elements: Iterable<T>) => [...elements].filter((el) => el.closest("[inert]") === null);
const cardNames = () =>
  live(page().querySelectorAll("h3"))
    .map((h) => h.textContent)
    .filter((t) => t !== "添加账户");

function buttonIn(root: ParentNode, text: string): HTMLButtonElement {
  const el = live(root.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === text);
  if (el === undefined) throw new Error(`找不到按钮 ${text}`);
  return el;
}

function cardOf(name: string): HTMLElement {
  const heading = live(page().querySelectorAll("h3")).find((h) => h.textContent === name);
  if (heading === undefined) throw new Error(`找不到账户卡 ${name}`);
  return heading.closest("[data-pad]") as HTMLElement;
}

/** 加载占位的状态：pending 占着位置但不可见，shown 骨架可见，null 已换成内容。 */
function skeletonState(): "pending" | "shown" | null {
  const loading = page().querySelector('div[aria-busy="true"]');
  if (loading === null) return null;
  const bones = loading.querySelector(':scope > [aria-hidden="true"]');
  if (bones === null) throw new Error("加载中却没有骨架占位");
  return bones.hasAttribute("data-pending") ? "pending" : "shown";
}

/** 账户网格的格子（增删动画包在每张卡外面的那一层），按顺序；退场中的也在里面。 */
function gridCells(): HTMLElement[] {
  const add = [...page().querySelectorAll("h3")].find((h) => h.textContent === "添加账户");
  if (add === undefined) throw new Error("找不到添加卡");
  const grid = add.parentElement?.parentElement?.parentElement;
  if (grid === null || grid === undefined) throw new Error("添加卡不在网格里");
  return [...grid.children] as HTMLElement[];
}

const click = async (el: Element) => {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
  });
  await flush();
};

/** 打开 root 里的更多菜单；当前账户在聚光卡与账户卡上各有一个，按所在区域区分。 */
async function openMenu(label: string, root: ParentNode = document) {
  const trigger = root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (trigger === null) throw new Error(`找不到菜单按钮 ${label}`);
  act(() => trigger.focus());
  await click(trigger);
}

async function chooseMenuItem(text: string) {
  const item = [...document.querySelectorAll<HTMLElement>(':not([data-exiting]) > [role="menu"] [role="menuitem"]')].find((i) => i.textContent?.startsWith(text));
  if (item === undefined) throw new Error(`菜单里找不到 ${text}`);
  await click(item);
}

const menuLabels = () => [...document.querySelectorAll(':not([data-exiting]) > [role="menu"] [role="menuitem"]')].map((i) => i.textContent);
const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"], [role="dialog"]');
const toastTitles = () => launcher.state.toasts.map((t) => `${t.tone}:${t.title}`);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  resetRecorder(ipc);
  stubResizeObserver();
  stubMatchMedia(false);
  stubCanvas();
  net = { onLine: true, clipboard: { writeText: vi.fn(() => Promise.resolve()) }, userAgent: "Windows" };
  vi.stubGlobal("navigator", net);
  useAccounts([hanami, steve], hanami.uuid);
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("skin_info", () => null);
});

afterEach(async () => {
  view?.unmount();
  view = undefined;
  // 帧循环跟着假时钟走：换回真实计时器之前排空，同文件后面逐帧采样的用例才推得动
  await drainFrames();
  setArtStatus(NO_ART);
  clearArtCache();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("账户页：当前账户与列表", () => {
  it("聚光卡写出当前账户的类型、分段 UUID 与验证信息，账户卡按后端顺序排列", async () => {
    await mount();
    expect(subtitle()).toBe("2 个账户 · 启动游戏时使用「Hanami」");
    expect(spotlightName()).toBe("Hanami");
    const spot = page().querySelector("section") as HTMLElement;
    const kind = spot.querySelector("p[data-tone]") as HTMLElement;
    expect([kind.textContent, kind.dataset.tone]).toEqual(["微软账户 · 正版已验证", "ok"]);
    expect(spot.querySelector("code")?.textContent).toBe("6a1f0c0e-4b5d-4c3e-9f2a-7b8c9d0e1f20");
    expect([...spot.querySelectorAll("dd")].map((d) => d.textContent)).toEqual(["微软账户登录", "1 小时前", "2026年10月28日"]);
    expect(spot.textContent).toContain("添加于 3 天前");
    expect(cardNames()).toEqual(["Hanami", "Steve"]);
    expect(cardOf("Hanami").textContent).toContain("使用中");
    expect(cardOf("Hanami").hasAttribute("data-selected")).toBe(true);
    expect(cardOf("Steve").hasAttribute("data-selected")).toBe(false);
    expect(buttonIn(cardOf("Steve"), "切换到此账户")).toBeDefined();
  });

  it("离线账户的聚光卡只有更多菜单，没有上次验证", async () => {
    useAccounts([steve], steve.uuid);
    await mount();
    const spot = page().querySelector("section") as HTMLElement;
    expect([...spot.querySelectorAll("dt")].map((d) => d.textContent)).toEqual(["验证方式", "添加日期"]);
    expect([...spot.querySelectorAll("button")].map((b) => b.textContent)).not.toContain("刷新账户信息");
  });

  it("切换账户：调用 set_current_account，聚光卡与选中描边随之移动，不弹通知", async () => {
    await mount();
    await click(buttonIn(cardOf("Steve"), "切换到此账户"));
    expect(callsOf(ipc, "set_current_account")).toEqual([{ uuid: steve.uuid }]);
    expect(spotlightName()).toBe("Steve");
    expect(cardOf("Steve").hasAttribute("data-selected")).toBe(true);
    expect(cardOf("Hanami").hasAttribute("data-selected")).toBe(false);
    expect(launcher.state.toasts).toEqual([]);
  });

  it("切换账户：两张卡的底部原位交叉淡化，换下来的那一行淡出，换上去的那一行从透明落位", async () => {
    await mount();
    const rows = (name: string) => [...cardOf(name).querySelectorAll<HTMLElement>('[class*="footRow"]')];
    const [steveBefore] = rows("Steve");
    const [hanamiBefore] = rows("Hanami");
    await click(buttonIn(cardOf("Steve"), "切换到此账户"));
    expect(steveBefore.hasAttribute("inert")).toBe(true);
    expect(hanamiBefore.hasAttribute("inert")).toBe(true);
    const steveNow = rows("Steve").find((row) => !row.hasAttribute("inert")) as HTMLElement;
    const hanamiNow = rows("Hanami").find((row) => !row.hasAttribute("inert")) as HTMLElement;
    expect([steveNow.textContent, steveNow.style.opacity]).toEqual(["使用中", "0"]);
    expect([hanamiNow.textContent, hanamiNow.style.opacity]).toEqual(["切换到此账户", "0"]);
  });

  it("切换账户：聚光卡与信息列都还是原来的节点，信息列原地换人、从下方 6px 淡入；进页时的信息列不另播", async () => {
    await mount();
    const spot = page().querySelector("section") as HTMLElement;
    const info = () => spot.querySelector("h2")?.parentElement as HTMLElement;
    const before = info();
    await stepFrames(2);
    expect([before.style.opacity, before.style.transform]).toEqual(["", ""]);
    await click(buttonIn(cardOf("Steve"), "切换到此账户"));
    expect(page().querySelector("section")).toBe(spot);
    expect(info()).toBe(before);
    expect(before.querySelector("h2")?.textContent).toBe("Steve");
    // 第一帧画出来时已经走了这一帧的时长：从透明、下方 6px 起步，还在半路
    await stepFrames(1);
    const opacity = Number(before.style.opacity);
    const shift = Number(/^translateY\(([\d.]+)px\)$/.exec(before.style.transform)?.[1]);
    expect([opacity > 0 && opacity < 0.6, shift > 4 && shift <= 6]).toEqual([true, true]);
    await stepFrames(40);
    expect([before.style.opacity, before.style.transform]).toEqual(["1", "none"]);
  });

  it("从聚光卡的更多菜单删除当前账户：下一个账户顶上来时信息列不重挂，焦点留在同一个更多菜单触发器上", async () => {
    await mount();
    const spot = page().querySelector("section") as HTMLElement;
    const trigger = spot.querySelector<HTMLButtonElement>('button[aria-label="Hanami 的更多操作"]') as HTMLButtonElement;
    await openMenu("Hanami 的更多操作", spot);
    await chooseMenuItem("删除账户");
    await click(buttonIn(dialog() as HTMLElement, "删除账户"));
    expect(spotlightName()).toBe("Steve");
    expect([trigger.isConnected, trigger.getAttribute("aria-label")]).toEqual([true, "Steve 的更多操作"]);
    expect(document.activeElement).toBe(trigger);
  });

  it("切换账户：聚光卡的复制按钮不带着上一位的「已复制」", async () => {
    await mount();
    const spot = page().querySelector("section") as HTMLElement;
    await click(spot.querySelector('button[aria-label="复制 UUID"]') as HTMLButtonElement);
    expect(spot.querySelector('button[aria-label="已复制"]')).not.toBeNull();
    await click(buttonIn(cardOf("Steve"), "切换到此账户"));
    expect(spotlightName()).toBe("Steve");
    expect([spot.querySelector('button[aria-label="已复制"]'), spot.querySelector('button[aria-label="复制 UUID"]') !== null]).toEqual([null, true]);
  });

  it("当前账户卡的菜单没有「设为当前账户」，其余账户卡的这一项与切换按钮等效", async () => {
    await mount();
    await openMenu("Hanami 的更多操作", cardOf("Hanami"));
    expect(menuLabels()).toEqual(["刷新账户信息", "复制 UUID", "删除账户"]);
    await chooseMenuItem("复制 UUID");
    await openMenu("Steve 的更多操作");
    expect(menuLabels()).toEqual(["设为当前账户", "复制 UUID", "删除账户"]);
    await chooseMenuItem("设为当前账户");
    expect(callsOf(ipc, "set_current_account")).toEqual([{ uuid: steve.uuid }]);
  });
});

describe("账户页：皮肤", () => {
  it("聚光卡与账户卡用全身立绘（聚光卡 6 倍 96 x 192，账户卡 4 倍 64 x 128）；离线账户没有远程皮肤，画剪影", async () => {
    await mount();
    const figures = [...page().querySelectorAll<HTMLElement>('[data-sk-art="skin"]')];
    expect(figures.map((f) => [f.style.width, f.style.height])).toEqual([
      ["96px", "192px"],
      ["64px", "128px"],
      ["64px", "128px"],
    ]);
    const steveFigure = cardOf("Steve").querySelector('[data-sk-art="skin"]');
    expect(steveFigure?.getAttribute("data-art")).toBe("silhouette");
    // 离线账户同样问一次后端；后端对离线账户回 null（默认皮肤的推算规则未核对前不提供）
    expect(callsOf(ipc, "skin_info")).toContainEqual({ accountUuid: steve.uuid });
  });

  it("取到真皮肤时只有聚光卡的立绘能拖动转身，账户卡是静态的", async () => {
    ipc.overrides.set("skin_info", () => ({ kind: "remote", sha1: "ab".repeat(20), model: "wide", hat: true }));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(["skin"]) })));
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 64, height: 64 })));
    await mount();
    await flush();
    const figures = [...page().querySelectorAll<HTMLElement>('[data-sk-art="skin"]')];
    expect(figures.map((f) => f.dataset.art)).toEqual(["skin", "skin", "skin"]);
    expect(figures.map((f) => f.querySelector('canvas[data-tauri-drag-region="false"]') !== null)).toEqual([true, false, false]);
  });

  it("切换到皮肤信息还没读到的账户：聚光卡舞台留着上一位的立绘，读到「没有皮肤」才换成剪影", async () => {
    const steveSkin = deferred<null>();
    ipc.overrides.set("skin_info", (args) => (args.accountUuid === steve.uuid ? steveSkin.promise : { kind: "remote", sha1: "ab".repeat(20), model: "wide", hat: true }));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(["skin"]) })));
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 64, height: 64 })));
    await mount();
    await flush();
    const spotFigure = () => (page().querySelector("section") as HTMLElement).querySelector<HTMLElement>('[data-sk-art="skin"]');
    expect(spotFigure()?.dataset.art).toBe("skin");
    await click(buttonIn(cardOf("Steve"), "切换到此账户"));
    expect(spotlightName()).toBe("Steve");
    expect(spotFigure()?.dataset.art).toBe("skin");
    steveSkin.resolve(null);
    await flush();
    expect(spotFigure()?.dataset.art).toBe("silhouette");
  });

  it("皮肤查询失败：舞台照常画剪影立绘，不弹通知，原因写进控制台", async () => {
    ipc.overrides.set("skin_info", () => {
      throw new IpcError("io", "账户文件读不出来");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await mount();
    const figures = [...page().querySelectorAll('[data-sk-art="skin"]')];
    // 聚光卡一个，两张账户卡各一个
    expect(figures.map((f) => f.getAttribute("data-art"))).toEqual(["silhouette", "silhouette", "silhouette"]);
    expect(launcher.state.toasts).toEqual([]);
    expect(warn.mock.calls.some(([message]) => String(message).includes("皮肤信息读不出来"))).toBe(true);
  });
});

describe("账户页：删除", () => {
  it("删除当前微软账户：确认正文写清切到谁与要重新登录，确认后删除并由状态层通知", async () => {
    await mount();
    await openMenu("Hanami 的更多操作", page().querySelector("section") as HTMLElement);
    await chooseMenuItem("删除账户");
    const box = dialog() as HTMLElement;
    expect(box.querySelector("h2")?.textContent).toBe("删除账户 Hanami？");
    expect(box.textContent).toContain("只会移除登录信息，不影响任何存档。删除后切换到 Steve。以后再用要重新登录。");
    await click(buttonIn(box, "删除账户"));
    expect(callsOf(ipc, "remove_account")).toEqual([{ uuid: hanami.uuid }]);
    expect(spotlightName()).toBe("Steve");
    expect(cardNames()).toEqual(["Steve"]);
    expect(toastTitles()).toEqual(["info:已删除账户 Hanami"]);
  });

  it("取消确认不删除", async () => {
    await mount();
    await openMenu("Steve 的更多操作");
    await chooseMenuItem("删除账户");
    const box = dialog() as HTMLElement;
    expect(box.textContent).toContain("只会移除登录信息，不影响任何存档。");
    expect(box.textContent).not.toContain("删除后切换到");
    await click(buttonIn(box, "取消"));
    expect(callsOf(ipc, "remove_account")).toEqual([]);
    expect(cardNames()).toEqual(["Hanami", "Steve"]);
  });

  it("游戏正在用这个账户：确认正文说明正在运行的游戏不受影响", async () => {
    const launched = deferred<{ pid: number }>();
    ipc.overrides.set("list_instances", () => [instanceDto("生存")]);
    ipc.overrides.set("launch_game", () => launched.promise);
    await mount();
    act(() => {
      void launcher.actions.launch("生存");
    });
    await flush();
    expect(launcher.state.session?.accountUuid).toBe(hanami.uuid);
    await openMenu("Hanami 的更多操作", cardOf("Hanami"));
    await chooseMenuItem("删除账户");
    expect(dialog()?.textContent).toContain("以后再用要重新登录。正在运行的游戏不受影响。");
  });

  it("删除最后一个账户后回到空状态：聚光卡淡出让位、空状态淡入，「全部账户」分区还是原来那块", async () => {
    useAccounts([steve], steve.uuid);
    await mount();
    const allAccounts = () => live(page().querySelectorAll("section")).find((s) => s.textContent?.startsWith("全部账户"));
    const section = allAccounts();
    const spot = page().querySelector("section") as HTMLElement;
    await openMenu("Steve 的更多操作");
    await chooseMenuItem("删除账户");
    const box = dialog() as HTMLElement;
    expect(box.textContent).toContain("这是最后一个账户，删除后要重新添加才能启动游戏。");
    await click(buttonIn(box, "删除账户"));
    expect(subtitle()).toBe("还没有可用的账户");
    expect(liveText()).toContain("还没有账户");
    expect(spot.closest("[inert]")).not.toBeNull();
    const empty = [...page().querySelectorAll("h2")].find((h) => h.textContent === "还没有账户")?.closest("[data-pad]")?.parentElement as HTMLElement;
    expect([empty.style.opacity, empty.style.transform]).toEqual(["0", "scale(0.98)"]);
    expect(allAccounts()).toBe(section);
  });
});

describe("账户页：账户网格的增删", () => {
  it("删除一张卡：它原地淡出并带上 inert，其余卡与添加卡还是原来的节点，由网格让位滑过去", async () => {
    await mount();
    const [hanamiCell, steveCell, addCell] = gridCells();
    await openMenu("Steve 的更多操作");
    await chooseMenuItem("删除账户");
    await click(buttonIn(dialog() as HTMLElement, "删除账户"));
    expect(cardNames()).toEqual(["Hanami"]);
    expect(steveCell.hasAttribute("inert")).toBe(true);
    expect(gridCells().filter((cell) => !cell.hasAttribute("inert"))).toEqual([hanamiCell, addCell]);
  });

  it("新增一个账户：新卡从透明与 0.98 落位，原有的卡与添加卡不重挂、不重播", async () => {
    const alex = accountDto({ uuid: "3c4d5e6f7a8b4c9d8e7f6a5b4c3d2e1f", name: "Alex", account_type: "offline" });
    ipc.overrides.set("create_offline_account", () => {
      accounts = [...accounts, alex];
      return alex;
    });
    await mount();
    const before = gridCells();
    await act(async () => {
      await launcher.actions.addOfflineAccount("Alex");
    });
    await flush();
    expect(cardNames()).toEqual(["Hanami", "Steve", "Alex"]);
    const cells = gridCells();
    expect([cells[0], cells[1], cells[3]]).toEqual(before);
    expect(cells[2].textContent).toContain("Alex");
    expect([cells[2].style.opacity, cells[2].style.transform]).toEqual(["0", "scale(0.98)"]);
    // 挂载时就在的卡跟着页面入场走，格子自己一开始就是成品，不另播
    expect(before.map((cell) => cell.style.opacity)).toEqual(["1", "1", "1"]);
  });
});

describe("账户页：凭据失效、刷新与重新登录", () => {
  it("当前外置账户失效：类型行警示，重新登录是主按钮，页头添加微软账户降为次按钮", async () => {
    useAccounts([hanami, yozakura], yozakura.uuid);
    await mount();
    const spot = page().querySelector("section") as HTMLElement;
    const kind = spot.querySelector("p[data-tone]") as HTMLElement;
    expect([kind.textContent, kind.dataset.tone]).toEqual(["外置登录 · Example Skin · 需要重新登录", "warn"]);
    expect(buttonIn(spot, "重新登录").dataset.variant).toBe("primary");
    expect(buttonIn(page().querySelector("header") as HTMLElement, "添加微软账户").dataset.variant).toBe("secondary");
    expect(cardOf("Yozakura").textContent).toContain("使用中需要重新登录");
    await click(buttonIn(spot, "重新登录"));
    expect(launcher.state.login).toEqual({
      kind: "authlib",
      intent: { kind: "manual" },
      prefill: { serverUrl: "https://skin.example/api/yggdrasil/", serverName: "Example Skin", username: "yozakura@example.com" },
      dropped: null,
    });
  });

  it("非当前的失效账户：卡片底部给重新登录，菜单里不给必然失败的刷新", async () => {
    useAccounts([hanami, yozakura], hanami.uuid);
    await mount();
    expect(buttonIn(page().querySelector("header") as HTMLElement, "添加微软账户").dataset.variant).toBe("primary");
    expect(buttonIn(cardOf("Yozakura"), "重新登录")).toBeDefined();
    await openMenu("Yozakura 的更多操作");
    expect(menuLabels()).toEqual(["设为当前账户", "复制 UUID", "删除账户"]);
  });

  it("刷新账户信息：进行中按钮忙碌，成功后弹「账户信息已更新」并重新取皮肤", async () => {
    const refreshed = deferred<AccountDto>();
    ipc.overrides.set("refresh_account", () => refreshed.promise);
    await mount();
    const skinCalls = callsOf(ipc, "skin_info").length;
    const spot = page().querySelector("section") as HTMLElement;
    await click(buttonIn(spot, "刷新账户信息"));
    expect(callsOf(ipc, "refresh_account")).toEqual([{ uuid: hanami.uuid }]);
    expect(buttonIn(spot, "刷新账户信息").getAttribute("aria-busy")).toBe("true");
    refreshed.resolve({ ...hanami, last_verified_at: NOW });
    await flush();
    expect(buttonIn(spot, "刷新账户信息").hasAttribute("aria-busy")).toBe(false);
    expect(toastTitles()).toEqual(["success:账户信息已更新"]);
    expect(callsOf(ipc, "skin_info").slice(skinCalls)).toEqual([{ accountUuid: hanami.uuid }]);
  });

  it("刷新进行中再从账户卡菜单点刷新：不发第二次刷新，聚光卡按钮一直忙到这一次落定，只弹一次成功", async () => {
    const refreshed = deferred<AccountDto>();
    ipc.overrides.set("refresh_account", () => refreshed.promise);
    await mount();
    const spot = page().querySelector("section") as HTMLElement;
    await click(buttonIn(spot, "刷新账户信息"));
    await openMenu("Hanami 的更多操作", cardOf("Hanami"));
    const item = [...document.querySelectorAll<HTMLElement>(':not([data-exiting]) > [role="menu"] [role="menuitem"]')].find((i) => i.textContent === "刷新账户信息");
    if (item === undefined) throw new Error("账户卡菜单里没有刷新账户信息");
    expect(item.getAttribute("aria-disabled")).toBe("true");
    await click(item);
    expect(callsOf(ipc, "refresh_account")).toEqual([{ uuid: hanami.uuid }]);
    expect(buttonIn(spot, "刷新账户信息").getAttribute("aria-busy")).toBe("true");
    refreshed.resolve({ ...hanami, last_verified_at: NOW });
    await flush();
    expect(buttonIn(spot, "刷新账户信息").hasAttribute("aria-busy")).toBe(false);
    expect(toastTitles()).toEqual(["success:账户信息已更新"]);
  });

  it("刷新失败：错误通知带后端原文，按钮恢复", async () => {
    ipc.overrides.set("refresh_account", () => {
      throw new IpcError("Http", "无法连接到 api.minecraftservices.com");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await mount();
    const spot = page().querySelector("section") as HTMLElement;
    await click(buttonIn(spot, "刷新账户信息"));
    expect(launcher.state.toasts.map((t) => [t.tone, t.title, t.body])).toEqual([["error", "没能刷新账户", "无法连接到 api.minecraftservices.com"]]);
    expect(buttonIn(spot, "刷新账户信息").hasAttribute("aria-busy")).toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("当前微软账户失效时重新登录走设备码登录", async () => {
    useAccounts([{ ...hanami, status: "expired" }, steve], hanami.uuid);
    const login = deferred<AccountDto>();
    ipc.overrides.set("microsoft_login", () => login.promise);
    await mount();
    await click(buttonIn(page().querySelector("section") as HTMLElement, "重新登录"));
    expect(callsOf(ipc, "microsoft_login")).toEqual([{}]);
    expect(launcher.state.login?.kind).toBe("microsoft");
  });
});

describe("账户页：添加", () => {
  it("页头主按钮开设备码登录，「添加其他账户」菜单开离线与外置登录", async () => {
    ipc.overrides.set("microsoft_login", () => new Promise(() => undefined));
    await mount();
    const header = page().querySelector("header") as HTMLElement;
    await click(buttonIn(header, "添加微软账户"));
    expect(launcher.state.login?.kind).toBe("microsoft");
    await act(async () => {
      await launcher.actions.closeLogin();
    });
    const other = buttonIn(header, "添加其他账户");
    act(() => other.focus());
    await click(other);
    await chooseMenuItem("外置登录");
    expect(launcher.state.login).toEqual({ kind: "authlib", intent: { kind: "manual" }, prefill: null, dropped: null });
  });

  it("添加卡的三行分别打开三种登录", async () => {
    await mount();
    const add = [...page().querySelectorAll("h3")].find((h) => h.textContent === "添加账户")?.parentElement as HTMLElement;
    const rows = [...add.querySelectorAll<HTMLButtonElement>("li > button")];
    expect(rows.map((r) => r.textContent)).toEqual([
      "微软账户正版验证，能进所有在线服务器",
      "离线账户无需联网，单人与离线服使用",
      "外置登录LittleSkin 等第三方验证服务器",
    ]);
    await click(rows[1]);
    expect(launcher.state.login).toEqual({ kind: "offline", intent: { kind: "manual" } });
  });

  it("没有账户：空状态替代聚光卡，下方只剩添加卡", async () => {
    useAccounts([], null);
    await mount();
    expect(subtitle()).toBe("还没有可用的账户");
    expect(page().querySelector("h2")?.textContent).toBe("还没有账户");
    expect(page().textContent).toContain("启动游戏需要一个账户。正版玩家添加微软账户，单人游戏或离线服务器可以用离线账户。");
    expect(page().textContent).toContain("全部账户0 个");
    expect(cardNames()).toEqual([]);
    await click(buttonIn(page(), "添加离线账户"));
    expect(launcher.state.login).toEqual({ kind: "offline", intent: { kind: "manual" } });
  });
});

describe("账户页：复制 UUID", () => {
  it("菜单复制写入分段后的 UUID，成功不弹通知", async () => {
    await mount();
    await openMenu("Steve 的更多操作");
    await chooseMenuItem("复制 UUID");
    expect(net.clipboard.writeText).toHaveBeenCalledWith("0f3c5a7e-9b1d-4f6a-8c2e-4a6b8d0f2a4c");
    expect(launcher.state.toasts).toEqual([]);
  });

  it("剪贴板被拒绝：弹「复制失败」，正文为错误原文", async () => {
    net.clipboard.writeText.mockImplementation(() => Promise.reject(new Error("Document is not focused.")));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await mount();
    await openMenu("Steve 的更多操作");
    await chooseMenuItem("复制 UUID");
    expect(launcher.state.toasts.map((t) => [t.tone, t.title, t.body])).toEqual([["error", "复制失败", "Document is not focused."]]);
  });

  it("聚光卡的复制按钮遇到剪贴板被拒绝：只报一次「复制失败」，按钮不显示「已复制」，也不留下未处理的拒绝", async () => {
    net.clipboard.writeText.mockImplementation(() => Promise.reject(new Error("Document is not focused.")));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      await mount();
      const spot = page().querySelector("section") as HTMLElement;
      await click(spot.querySelector('button[aria-label="复制 UUID"]') as HTMLButtonElement);
      await flush();
      expect(net.clipboard.writeText).toHaveBeenCalledTimes(1);
      expect(spot.querySelector('button[aria-label="已复制"]')).toBeNull();
      expect(launcher.state.toasts.map((t) => [t.tone, t.title, t.body])).toEqual([["error", "复制失败", "Document is not focused."]]);
      // 未处理的拒绝在下一轮事件循环才上报
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
        await new Promise<void>((resolve) => realSetImmediate(resolve));
      });
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("聚光卡的复制按钮原位换成「已复制」，2000 ms 后复原", async () => {
    await mount();
    const spot = page().querySelector("section") as HTMLElement;
    const copy = spot.querySelector<HTMLButtonElement>('button[aria-label="复制 UUID"]') as HTMLButtonElement;
    await click(copy);
    expect(net.clipboard.writeText).toHaveBeenCalledWith("6a1f0c0e-4b5d-4c3e-9f2a-7b8c9d0e1f20");
    expect(spot.querySelector('button[aria-label="已复制"]')).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(spot.querySelector('button[aria-label="复制 UUID"]')).not.toBeNull();
    expect(launcher.state.toasts).toEqual([]);
  });
});

describe("账户页：断网、加载与读取失败", () => {
  it("断网：横幅出现，微软与外置登录入口置灰，离线账户照常可加；恢复后横幅消失", async () => {
    net.onLine = false;
    await mount();
    expect(page().textContent).toContain("没有网络连接");
    const header = page().querySelector("header") as HTMLElement;
    await click(buttonIn(header, "添加微软账户"));
    expect(buttonIn(header, "添加微软账户").getAttribute("aria-disabled")).toBe("true");
    expect(launcher.state.login).toBeNull();
    expect(buttonIn(page().querySelector("section") as HTMLElement, "刷新账户信息").getAttribute("aria-disabled")).toBe("true");
    const add = [...page().querySelectorAll("h3")].find((h) => h.textContent === "添加账户")?.parentElement as HTMLElement;
    const rows = [...add.querySelectorAll<HTMLButtonElement>("li > button")];
    expect(rows.map((r) => [r.textContent, r.disabled])).toEqual([
      ["微软账户联网后才能登录", true],
      ["离线账户无需联网，单人与离线服使用", false],
      ["外置登录联网后才能登录", true],
    ]);
    await click(rows[1]);
    expect(launcher.state.login?.kind).toBe("offline");
    net.onLine = true;
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(liveText()).not.toContain("没有网络连接");
  });

  it("停留期间断网：横幅从略小处淡入，恢复联网时淡出并让出位置，下面的内容由页面让位接住", async () => {
    await mount();
    const root = page().firstElementChild as HTMLElement;
    act(() => {
      net.onLine = false;
      window.dispatchEvent(new Event("offline"));
    });
    const banner = [...root.children].find((child) => child.textContent?.includes("没有网络连接")) as HTMLElement;
    // 横幅是页面的直接子项（页面的让位只认直接子项），挂上的那一刻从透明、0.98 起
    expect(banner.style.opacity).toBe("0");
    expect(banner.style.transform).toContain("scale(0.98)");
    act(() => {
      net.onLine = true;
      window.dispatchEvent(new Event("online"));
    });
    expect(liveText()).not.toContain("没有网络连接");
    expect(banner.hasAttribute("inert")).toBe(true);
  });

  it("构建里没有微软登录 client_id：标题栏按钮与添加卡的微软一行置灰，原因写明去设置里填，点了不发起；其余照常", async () => {
    ipc.overrides.set("get_config", () => configDto({ has_client_id: false, microsoft_login_available: false }));
    await mount();
    const header = page().querySelector("header") as HTMLElement;
    const microsoft = buttonIn(header, "添加微软账户");
    expect(microsoft.getAttribute("aria-disabled")).toBe("true");
    act(() => {
      microsoft.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const tipId = microsoft.getAttribute("aria-describedby");
    expect(tipId === null ? null : document.getElementById(tipId)?.textContent).toBe("这个版本没有内置微软登录，在设置里填入 client_id 后可用");
    await click(microsoft);
    expect(launcher.state.login).toBeNull();

    const add = [...page().querySelectorAll("h3")].find((h) => h.textContent === "添加账户")?.parentElement as HTMLElement;
    const rows = [...add.querySelectorAll<HTMLButtonElement>("li > button")];
    expect(rows.map((r) => [r.textContent, r.disabled])).toEqual([
      ["微软账户这个版本没有内置微软登录，在设置里填入 client_id 后可用", true],
      ["离线账户无需联网，单人与离线服使用", false],
      ["外置登录LittleSkin 等第三方验证服务器", false],
    ]);
    await click(rows[0]);
    expect(callsOf(ipc, "microsoft_login")).toEqual([]);
    await click(rows[1]);
    expect(launcher.state.login?.kind).toBe("offline");
  });

  it("断网：菜单里的刷新与外置登录只写标签并禁用，原因放进悬停的提示气泡；点了不发起", async () => {
    net.onLine = false;
    await mount();
    const menuItems = () => [...document.querySelectorAll<HTMLElement>(':not([data-exiting]) > [role="menu"] [role="menuitem"]')];
    const reasonOf = async (item: HTMLElement) => {
      act(() => {
        item.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      const tipId = item.getAttribute("aria-describedby");
      if (tipId === null) throw new Error(`「${item.textContent}」悬停后没有关联提示气泡`);
      return document.getElementById(tipId)?.textContent;
    };

    await openMenu("Hanami 的更多操作", cardOf("Hanami"));
    expect(menuLabels()).toEqual(["刷新账户信息", "复制 UUID", "删除账户"]);
    const refresh = menuItems()[0];
    expect(refresh.getAttribute("aria-disabled")).toBe("true");
    expect(await reasonOf(refresh)).toBe("联网后才能登录");
    await click(refresh);
    expect(callsOf(ipc, "refresh_account")).toEqual([]);
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flush();

    const other = buttonIn(page().querySelector("header") as HTMLElement, "添加其他账户");
    act(() => other.focus());
    await click(other);
    expect(menuLabels()).toEqual(["离线账户", "外置登录"]);
    const authlib = menuItems()[1];
    expect(authlib.getAttribute("aria-disabled")).toBe("true");
    expect(await reasonOf(authlib)).toBe("联网后才能登录");
    await click(authlib);
    expect(launcher.state.login).toBeNull();
  });

  it("加载超过 300 ms 才出现骨架，出现后至少保持 300 ms；等待期骨架占位但不可见，副标题先占一行", async () => {
    const list = deferred<AccountDto[]>();
    ipc.overrides.set("list_accounts", () => list.promise);
    await mount();
    const line = page().querySelector("header p");
    expect([skeletonState(), spotlightName(), line?.textContent]).toEqual(["pending", undefined, ""]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(skeletonState()).toBe("shown");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    list.resolve([hanami, steve]);
    await flush();
    // 数据在骨架出现 50 ms 后就到了，骨架仍要满 300 ms
    expect([skeletonState(), spotlightName()]).toEqual(["shown", undefined]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect([skeletonState(), spotlightName()]).toEqual([null, "Hanami"]);
    // 副标题是同一行填上文字，页头没有长出新的一行
    expect(page().querySelector("header p")).toBe(line);
    expect(line?.textContent).toBe("2 个账户 · 启动游戏时使用「Hanami」");
  });

  it("骨架照真实结构画：聚光卡的舞台、键值三行与动作，分区标题一行，两张账户卡加添加卡", async () => {
    ipc.overrides.set("list_accounts", () => new Promise(() => undefined));
    await mount();
    const bones = page().querySelector('div[aria-busy="true"] > [aria-hidden="true"]') as HTMLElement;
    expect(bones.querySelectorAll('[data-variant="spot"]')).toHaveLength(1);
    expect(bones.querySelectorAll("dt")).toHaveLength(3);
    expect(bones.querySelectorAll('[class*="sectionBone"]')).toHaveLength(1);
    expect(bones.querySelectorAll('[data-variant="card"]')).toHaveLength(2);
    expect(bones.querySelectorAll('[class*="cardFoot"]')).toHaveLength(2);
    expect(bones.querySelectorAll('[class*="addCard"]')).toHaveLength(1);
    // 骨架不带标题与按钮：淡出期间它还在 DOM 里，不能被当成真内容找到
    expect(bones.querySelectorAll("h1, h2, h3, section, button")).toHaveLength(0);
  });

  it("读了 10 s 还没读完：骨架下方补一行「比平时慢」，读完随骨架一起收起", async () => {
    const list = deferred<AccountDto[]>();
    ipc.overrides.set("list_accounts", () => list.promise);
    await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(skeletonState()).toBe("shown");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_699);
    });
    expect(page().textContent).not.toContain("比平时慢一些，仍在加载…");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    // 骨架在读屏里是隐藏的，说明不能放在骨架里
    const hint = [...page().querySelectorAll("p")].find((p) => p.textContent === "比平时慢一些，仍在加载…");
    expect(hint?.closest('[aria-hidden="true"]')).toBeNull();
    list.resolve([hanami]);
    await flush();
    expect(liveText()).not.toContain("比平时慢一些，仍在加载…");
    expect(spotlightName()).toBe("Hanami");
  });

  it("300 ms 内读完不出现骨架：等待期只占位，读完内容淡入", async () => {
    const list = deferred<AccountDto[]>();
    ipc.overrides.set("list_accounts", () => list.promise);
    await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(skeletonState()).toBe("pending");
    list.resolve([hanami]);
    await flush();
    expect(skeletonState()).toBeNull();
    expect(spotlightName()).toBe("Hanami");
    // 等过加载才挂上的正文整体淡入一次，里面的区块不再按页面序号各自入场
    const spot = page().querySelector("section") as HTMLElement;
    expect(spot.hasAttribute("data-entrance")).toBe(false);
    const content = page().querySelector('[class*="loadable"] > :not([aria-hidden])') as HTMLElement;
    expect(content.style.opacity).toBe("0");
  });

  /** 账户早已读到之后才进页：先只挂状态容器读完数据，再挂上页面，页面挂载那一刻正文就在。 */
  async function enterWithAccountsRead() {
    const tree = (withPage: boolean) => (
      <LauncherProvider>
        <ShellProvider>
          <Probe />
          {withPage && <AccountsPage route={{ page: "accounts" }} />}
          <OverlayRoot />
        </ShellProvider>
      </LauncherProvider>
    );
    view = render(tree(false));
    await flush();
    view.rerender(tree(true));
  }

  /** 页面里参与错开入场的元素：[标签, 入场序号]，按文档顺序。 */
  const entrances = () => [...page().querySelectorAll("[data-entrance]")].map((el) => [el.tagName.toLowerCase(), el.getAttribute("data-entrance")]);

  it("进页时账户早已读到：空的横幅槽不占序号，聚光卡与分区紧接着页头往下编号，错开入场", async () => {
    await enterWithAccountsRead();
    expect(entrances()).toEqual([
      ["header", "0"],
      ["section", "1"],
      ["section", "2"],
    ]);
    expect(spotlightName()).toBe("Hanami");
  });

  it("进页时账户早已读到且断网：横幅占页头之后的 1 号，聚光卡与分区往后顺一位", async () => {
    net.onLine = false;
    await enterWithAccountsRead();
    const banner = [...page().querySelectorAll<HTMLElement>("[data-entrance]")].find((el) => el.textContent?.includes("没有网络连接"));
    expect(banner?.getAttribute("data-entrance")).toBe("1");
    expect(entrances()).toEqual([
      ["header", "0"],
      ["div", "1"],
      ["section", "2"],
      ["section", "3"],
    ]);
    expect(spotlightName()).toBe("Hanami");
  });

  it("账户列表读不出来：错误卡给出原文，点重试重新读取", async () => {
    let fail = true;
    ipc.overrides.set("list_accounts", () => {
      if (fail) throw new IpcError("io", "accounts.json 读取失败：拒绝访问");
      return accounts;
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await mount();
    expect(page().textContent).toContain("账户列表读不出来");
    expect(page().textContent).toContain("accounts.json 读取失败：拒绝访问");
    expect(spotlightName()).toBeUndefined();
    fail = false;
    await click(buttonIn(page(), "重试"));
    expect(callsOf(ipc, "list_accounts").length).toBe(2);
    expect(spotlightName()).toBe("Hanami");
    expect(liveText()).not.toContain("账户列表读不出来");
  });

  it("读取失败后点重试成功：「全部账户」分区与聚光卡一样从透明与 0.98 落位，不同帧硬切出现，也不另领页面入场序号", async () => {
    let fail = true;
    ipc.overrides.set("list_accounts", () => {
      if (fail) throw new IpcError("io", "accounts.json 读取失败：拒绝访问");
      return accounts;
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await mount();
    fail = false;
    await click(buttonIn(page(), "重试"));
    const [spot, section] = live(page().querySelectorAll("section"));
    expect([spot.querySelector("h2")?.textContent, section.textContent?.startsWith("全部账户")]).toEqual(["Hanami", true]);
    const enter = (el: HTMLElement) => [el.parentElement?.style.opacity, el.parentElement?.style.transform, el.hasAttribute("data-entrance")];
    expect(enter(spot)).toEqual(["0", "scale(0.98)", false]);
    expect(enter(section)).toEqual(["0", "scale(0.98)", false]);
  });

  it("点重试：错误卡留在原处、重试按钮转圈，等多久都不换成骨架；又失败时同一张卡原位换上新原文", async () => {
    let attempt = 0;
    const second = deferred<AccountDto[]>();
    ipc.overrides.set("list_accounts", () => {
      attempt += 1;
      if (attempt === 1) throw new IpcError("io", "accounts.json 读取失败：拒绝访问");
      return second.promise;
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await mount();
    const errorCard = () => live(page().querySelectorAll('[data-pad="lg"]')).find((card) => card.textContent?.includes("账户列表读不出来"));
    const before = errorCard();
    expect(before).toBeDefined();
    await click(buttonIn(page(), "重试"));
    expect(buttonIn(page(), "重试").getAttribute("aria-busy")).toBe("true");
    expect(skeletonState()).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect([errorCard(), skeletonState(), subtitle()]).toEqual([before, null, ""]);
    second.reject(new IpcError("io", "accounts.json 被另一个程序占用"));
    await flush();
    expect(errorCard()).toBe(before);
    expect(before?.textContent).toContain("accounts.json 被另一个程序占用");
    expect(buttonIn(page(), "重试").hasAttribute("aria-busy")).toBe(false);
  });
});
