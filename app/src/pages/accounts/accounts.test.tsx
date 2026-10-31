// @vitest-environment jsdom
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
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { accountDto, bootOverrides, callsOf, deferred, instanceDto, resetRecorder, settle } from "../../test/launcher";
import AccountsPage from "./index";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));

const NOW = new Date(2026, 9, 31, 12, 0, 0).getTime();
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
const subtitle = () => page().querySelector("header p")?.textContent;
const spotlightName = () => page().querySelector("section h2")?.textContent;
const cardNames = () => [...page().querySelectorAll("h3")].map((h) => h.textContent).filter((t) => t !== "添加账户");

function buttonIn(root: ParentNode, text: string): HTMLButtonElement {
  const el = [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text);
  if (el === undefined) throw new Error(`找不到按钮 ${text}`);
  return el;
}

function cardOf(name: string): HTMLElement {
  const heading = [...page().querySelectorAll("h3")].find((h) => h.textContent === name);
  if (heading === undefined) throw new Error(`找不到账户卡 ${name}`);
  return heading.closest("[data-pad]") as HTMLElement;
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

afterEach(() => {
  view?.unmount();
  view = undefined;
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
    expect([...spot.querySelectorAll("dd")].map((d) => d.textContent)).toEqual(["微软设备码登录", "1 小时前", "2026年10月28日"]);
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

  it("删除最后一个账户后回到空状态", async () => {
    useAccounts([steve], steve.uuid);
    await mount();
    await openMenu("Steve 的更多操作");
    await chooseMenuItem("删除账户");
    const box = dialog() as HTMLElement;
    expect(box.textContent).toContain("这是最后一个账户，删除后要重新添加才能启动游戏。");
    await click(buttonIn(box, "删除账户"));
    expect(subtitle()).toBe("还没有可用的账户");
    expect(page().textContent).toContain("还没有账户");
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
    expect(launcher.state.login).toEqual({ kind: "authlib", intent: { kind: "manual" }, prefill: null });
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
    expect(launcher.state.login).toEqual({ kind: "authlib", intent: { kind: "manual" }, prefill: null });
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
    expect(page().textContent).not.toContain("没有网络连接");
  });

  it("加载超过 300 ms 才出现骨架，出现后至少保持 300 ms", async () => {
    const list = deferred<AccountDto[]>();
    ipc.overrides.set("list_accounts", () => list.promise);
    await mount();
    const busy = () => page().querySelector('[aria-busy="true"]') !== null;
    expect([busy(), spotlightName()]).toEqual([false, undefined]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(busy()).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    list.resolve([hanami, steve]);
    await flush();
    // 数据在骨架出现 50 ms 后就到了，骨架仍要满 300 ms
    expect([busy(), spotlightName()]).toEqual([true, undefined]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect([busy(), spotlightName()]).toEqual([false, "Hanami"]);
  });

  it("300 ms 内读完不出现骨架", async () => {
    const list = deferred<AccountDto[]>();
    ipc.overrides.set("list_accounts", () => list.promise);
    await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    list.resolve([hanami]);
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(page().querySelector('[aria-busy="true"]')).toBeNull();
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
    expect(page().textContent).not.toContain("账户列表读不出来");
  });
});
