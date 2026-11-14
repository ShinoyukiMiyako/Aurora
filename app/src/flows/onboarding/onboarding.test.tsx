// @vitest-environment jsdom
// @module-tag heavy-page
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../art/illustrations/test-canvas";
import type { ConfigDto, GameDirectoryDto } from "../../ipc/config";
import { IpcError } from "../../ipc/errors";
import { APP_NAME } from "../../lib/app-info";
import { mockInvoke, resetMocks } from "../../ipc/mock";
import { clearArtCache } from "../../mc/useArt";
import { OverlayRoot } from "../../shell/overlay";
import { ShellProvider } from "../../shell/shell";
import type { Appearance } from "../../domain/types";
import { AppearanceProvider, DEFAULT_APPEARANCE } from "../../state/appearance";
import { LauncherProvider, useLauncher, type LauncherApi } from "../../state/launcher";
import { resources } from "../../state/resource";
import { drainFrames, render, stepFrames, stubMatchMedia, stubResizeObserver, stubSpanAnimations, type Rendered } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { accountDto, callsOf, resetRecorder, settle } from "../../test/launcher";
import OnboardingFlow from "./index";
import { PickDirectoryProvider, type PickDirectory } from "./platform";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));

const DEFAULT_DIR = "D:\\Games\\Launcher\\.minecraft";
const OFFICIAL_DIR = "C:\\Users\\player\\AppData\\Roaming\\.minecraft";

let view: Rendered | undefined;
let launcher: LauncherApi;
let picked: string | null;

function Harness() {
  launcher = useLauncher();
  // 与外壳的约定一致：firstRun 为 true 时挂向导，completeFirstRun 之后卸载
  return launcher.state.firstRun === true ? <OnboardingFlow /> : null;
}

const pick: PickDirectory = async () => picked;

const flush = () =>
  act(async () => {
    await settle(20);
  });

async function mount(appearance: Appearance = DEFAULT_APPEARANCE) {
  view = render(
    <AppearanceProvider initial={appearance}>
      <LauncherProvider>
        <ShellProvider>
          <PickDirectoryProvider value={pick}>
            <Harness />
          </PickDirectoryProvider>
          <OverlayRoot />
        </ShellProvider>
      </LauncherProvider>
    </AppearanceProvider>,
  );
  await flush();
}

function all<E extends Element = HTMLElement>(selector: string): E[] {
  return [...document.querySelectorAll<E>(selector)];
}

/** 读屏读得到的文字：主按钮的两条文案各放一层叠着，非当前的那层带 aria-hidden，不算。 */
function visibleText(el: Element): string {
  let out = "";
  for (const child of el.childNodes) {
    if (child instanceof Element) {
      if (child.getAttribute("aria-hidden") !== "true") out += visibleText(child);
    } else if (child instanceof Text) out += child.data;
  }
  return out.trim();
}

/** 在场的按钮：换步与增删时退场中的那一份（inert）还留在文档里淡出，假定时器下动画不走，它会一直留着。 */
function button(name: string): HTMLButtonElement {
  const found = all<HTMLButtonElement>("button").find((b) => b.closest("[inert]") === null && (b.getAttribute("aria-label") === name || visibleText(b) === name));
  if (found === undefined) throw new Error(`找不到按钮「${name}」`);
  return found;
}

function railItem(name: string): HTMLButtonElement {
  const found = all<HTMLButtonElement>('ol[aria-label="向导步骤"] button').find((b) => b.textContent?.includes(name));
  if (found === undefined) throw new Error(`步骤条上没有「${name}」`);
  return found;
}

const click = async (el: HTMLElement) => {
  act(() => el.click());
  await flush();
};

function dirInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>("input[type='text'], input:not([type])");
  if (input === null) throw new Error("没有游戏目录输入框");
  return input;
}

async function typePath(value: string) {
  const input = dirInput();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}

// 换步时旧步骤在退场动画里还留在文档中（假定时器下动画不走），它带 aria-hidden，读当前这一步
const title = () => document.querySelector("[data-step-pane]:not([aria-hidden]) h1")?.textContent;
const text = () => document.body.textContent ?? "";

beforeEach(() => {
  vi.useFakeTimers();
  resetMocks();
  resetRecorder(ipc);
  stubResizeObserver();
  stubMatchMedia(false);
  stubCanvas();
  picked = null;
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(async () => {
  view?.unmount();
  view = undefined;
  // 排在这一条假时钟上的帧要在换回真实计时器之前放掉：否则帧循环以为下一帧已经排着，后面用例里推进假时钟也走不动动画
  await drainFrames();
  document.documentElement.removeAttribute("data-sk-mode");
  document.documentElement.removeAttribute("data-sk-accent");
  document.documentElement.removeAttribute("data-sk-reduced");
  // 桩过的取图与已取到的皮肤位图不带到下一条用例
  clearArtCache();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("首次启动向导：第一步", () => {
  it("默认目录来自后端；其他启动器的文件夹默认全部收下", async () => {
    await mount();
    expect(title()).toBe("游戏文件放在哪");
    expect(text()).toContain("第 1 步，共 4 步");
    expect(dirInput().value).toBe(DEFAULT_DIR);
    const boxes = all('[role="checkbox"]');
    expect(boxes.map((b) => b.getAttribute("aria-checked"))).toEqual(["true", "true"]);
    expect(text()).toContain("2/2");
    // 收下的文件夹不会自动变成当前目录：说明里要讲清楚得去实例库切过去
    expect(text()).toContain("当前游戏目录不变。要玩里面的实例，到实例库切过去");
    // 第一步没有「跳过」也没有「上一步」
    expect(all("button").some((b) => b.textContent === "跳过" || b.textContent === "上一步")).toBe(false);
  });

  it("空目录与带「!」的目录在本地拒绝，原因写在输入框下", async () => {
    await mount();
    await typePath("   ");
    await click(button("下一步"));
    expect(title()).toBe("游戏文件放在哪");
    expect(text()).toContain("游戏目录不能为空");
    await typePath("D:\\Hi!\\.minecraft");
    expect(text()).not.toContain("游戏目录不能为空");
    await click(button("下一步"));
    expect(text()).toContain("路径里不能有「!」，Java 会读不出里面的游戏文件");
    expect(callsOf(ipc, "complete_first_run")).toEqual([]);
  });

  it("改成已有游戏文件的目录：提示会直接接管，同一目录不再作为额外文件夹；可以用回默认位置", async () => {
    await mount();
    await typePath("D:\\HMCL\\.minecraft");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    await flush();
    expect(text()).toContain("这个目录里已经有游戏文件，会直接接管");
    expect(text()).toContain("1/1");
    await click(button("用回默认位置"));
    expect(dirInput().value).toBe(DEFAULT_DIR);
  });

  it("浏览：选到的文件夹填进输入框；取消选择不改", async () => {
    await mount();
    picked = "E:\\Games\\.minecraft";
    await click(button("浏览"));
    expect(dirInput().value).toBe("E:\\Games\\.minecraft");
    picked = null;
    await click(button("浏览"));
    expect(dirInput().value).toBe("E:\\Games\\.minecraft");
  });
});

describe("首次启动向导：第一步的内容不跳", () => {
  const HAS_FILES = "这个目录里已经有游戏文件，会直接接管";
  const settleInput = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
  /** 在场（不在退场中）的元素里有没有这段文字。 */
  const shownText = (needle: string) => all("*").some((el) => el.children.length === 0 && el.textContent?.includes(needle) === true && el.closest("[inert]") === null);

  it("已有文件提示：改了路径、新的检查回来之前沿用上一次的结论，不先消失再闪回来；新结论回来才收起", async () => {
    await mount();
    await typePath("D:\\HMCL\\.minecraft");
    await settleInput();
    await flush();
    expect(shownText(HAS_FILES)).toBe(true);

    const pending: ((dto: { exists: boolean; has_versions: boolean }) => void)[] = [];
    ipc.overrides.set("inspect_game_directory", () => new Promise((resolve) => pending.push(resolve)));
    await typePath("D:\\Games\\Fresh");
    await settleInput();
    await flush();
    expect(pending).toHaveLength(1);
    expect(shownText(HAS_FILES)).toBe(true);

    act(() => pending[0]({ exists: false, has_versions: false }));
    await flush();
    expect(shownText(HAS_FILES)).toBe(false);
  });

  it("「用回默认位置」随改动淡入、改回默认后原地淡出；第一步里之后才挂上的块照常入场", async () => {
    await mount();
    await typePath("D:\\Games\\Petal");
    const wrapper = button("用回默认位置").closest("div");
    expect(wrapper?.style.opacity).toBe("0");
    await click(button("用回默认位置"));
    expect(dirInput().value).toBe(DEFAULT_DIR);
    expect(all("button").filter((b) => b.textContent?.trim() === "用回默认位置").every((b) => b.closest("[inert]") !== null)).toBe(true);
  });

  it("选中的游戏目录正好是探测到的文件夹：那一行原地淡出、不可再勾，计数随之变化", async () => {
    await mount();
    await typePath("D:\\HMCL\\.minecraft");
    const rows = all("li").filter((li) => li.textContent?.includes("D:\\HMCL\\.minecraft"));
    expect(rows).toHaveLength(1);
    expect(rows[0].hasAttribute("inert")).toBe(true);
    expect(text()).toContain("1/1");
  });

  it.each([false, true])("改回别的路径时接回来的文件夹行等第一帧画出来才淡入（减少动画 %s）：挂上之后的第一帧仍是透明的起点", async (reduceMotion) => {
    await mount({ ...DEFAULT_APPEARANCE, reduceMotion });
    const hmclRows = () => all("li").filter((li) => li.textContent?.includes("D:\\HMCL\\.minecraft"));
    await typePath("D:\\HMCL\\.minecraft");
    // 等那一行淡出播完、移出文档：接回来的才是新挂上的一行，不是把退场中的那一行原地拉回
    await stepFrames(30);
    expect(hmclRows()).toEqual([]);
    await click(button("用回默认位置"));
    const [row] = hmclRows();
    expect(hmclRows()).toHaveLength(1);
    expect(row.hasAttribute("inert")).toBe(false);
    const start = reduceMotion ? "" : "scale(0.98)";
    expect(row.style.opacity).toBe("0");
    expect(row.style.transform).toBe(start);
    await stepFrames(1);
    expect(row.style.opacity).toBe("0");
    expect(row.style.transform).toBe(start);
    // 放行排在绘制之后的任务里，假时钟要再推进一帧才到点
    await stepFrames(2);
    const opacity = Number(row.style.opacity);
    expect(opacity).toBeGreaterThan(0);
    expect(opacity).toBeLessThan(1);
    await stepFrames(60);
    expect(row.style.opacity).toBe("1");
    expect(row.style.transform).toBe(reduceMotion ? "" : "none");
  });

  it("配置还没读到：加载门内只占位不显示，到点才淡入照字段画的骨架；读到后换成输入框", async () => {
    let answer: () => void = () => undefined;
    ipc.overrides.set("get_config", () => new Promise((resolve) => (answer = () => void mockInvoke("get_config").then(resolve))));
    await mount();
    const skeleton = () => document.querySelector<HTMLElement>("[aria-busy='true'] > [aria-hidden='true']");
    expect(skeleton()?.hasAttribute("data-pending")).toBe(true);
    // 骨架照真实字段画：标签与常驻提示都在，输入行是 44 高的块
    expect(skeleton()?.textContent).toContain("目录不存在会自动创建");
    expect(skeleton()?.querySelector("[style*='height: 44px']")).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(skeleton()?.hasAttribute("data-pending")).toBe(false);
    act(() => answer());
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    await flush();
    expect(dirInput().value).toBe(DEFAULT_DIR);
  });

  it("配置过了等待期才到、文件夹探测更晚：文件夹骨架从外层骨架接过来一直显着，不先消失、再过 300ms 重新淡入", async () => {
    let answer: () => void = () => undefined;
    ipc.overrides.set("get_config", () => new Promise((resolve) => (answer = () => void mockInvoke("get_config").then(resolve))));
    ipc.overrides.set("discover_game_directories", () => new Promise(() => undefined));
    await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    act(() => answer());
    await flush();
    // 外层骨架显出来后至少停 300ms，到点才换成真实的第一步
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    await flush();
    expect(dirInput().value).toBe(DEFAULT_DIR);
    // 只剩文件夹区还在加载：它的骨架一挂上就是显出来的，不是等待期里看不见的占位
    const busy = all("[aria-busy='true']");
    expect(busy).toHaveLength(1);
    const others = busy[0].querySelector<HTMLElement>(":scope > [aria-hidden='true']");
    if (others === null) throw new Error("文件夹区没有骨架");
    expect(others.hasAttribute("data-pending")).toBe(false);
    expect(others.style.opacity).toBe("1");
  });
});

describe("首次启动向导：推进与收尾", () => {
  it("第二步的 Java 列表照样列出缺运行时文件的，并给它标「不完整」", async () => {
    const runtime = (major: number, missing: string[]) => ({
      path: `C:\\Java\\jdk-${major}\\bin\\java.exe`,
      version: { major, minor: 0, security: 2, build: 0, raw: `${major}.0.2` },
      is_64bit: true,
      vendor: "Eclipse Adoptium",
      source: "registry",
      missing_files: missing,
    });
    ipc.overrides.set("detect_java", () => [runtime(21, []), runtime(17, ["release", "lib/modules"])]);
    await mount();
    await click(button("下一步"));
    expect(title()).toBe("看看这台电脑上的 Java");
    const rows = [...document.querySelectorAll("li")].filter((li) => li.textContent?.startsWith("Java "));
    expect(rows.map((li) => [li.textContent?.slice(0, 7), li.textContent?.includes("不完整")])).toEqual([
      ["Java 21", false],
      ["Java 17", true],
    ]);
  });

  it("第二步的 Java 扫描：300ms 内只占位不显示，超过才淡入扫描行；结果回来后换成列表，开关行一直在", async () => {
    let found: (list: unknown[]) => void = () => undefined;
    ipc.overrides.set("detect_java", () => new Promise((resolve) => (found = resolve)));
    await mount();
    await click(button("下一步"));
    const scanning = () => all("[aria-busy='true'] > [aria-hidden='true']").find((el) => el.textContent?.includes("正在查找本机的 Java…"));
    // 扫描行在 aria-hidden 的骨架层里：读屏听到的是这一步里先挂好的状态区（不在任何 aria-hidden 之内）
    const announced = () => {
      const regions = all("[data-step-pane]:not([inert]) [role='status']").filter((el) => el.closest("[aria-hidden='true']") === null);
      expect(regions).toHaveLength(1);
      return regions[0].textContent;
    };
    expect(scanning()?.hasAttribute("data-pending")).toBe(true);
    expect(announced()).toBe("");
    expect(button("自动下载 Java").getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(scanning()?.hasAttribute("data-pending")).toBe(false);
    expect(announced()).toBe("正在查找本机的 Java…");
    act(() => found([]));
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    await flush();
    expect(text()).toContain("没有在本机找到 Java");
    expect(document.querySelector("[aria-busy='true']")).toBeNull();
    expect(announced()).toBe("");
  });

  it("第二步扫描 Java 并能关掉自动下载；跳过后步骤条标「已跳过」，只能点回到过的步", async () => {
    await mount();
    await click(button("下一步"));
    expect(title()).toBe("看看这台电脑上的 Java");
    expect(text()).toContain("Java 21");
    expect(text()).toContain("Java 8");
    await click(button("自动下载 Java"));
    expect(callsOf(ipc, "update_config")).toEqual([{ autoDownloadJava: false }]);
    await click(button("跳过"));
    expect(title()).toBe("用什么账户进游戏");
    expect(railItem("Java").textContent).toContain("已跳过");
    expect(railItem("外观").disabled).toBe(true);
    await click(railItem("游戏目录"));
    expect(title()).toBe("游戏文件放在哪");
  });

  it("第三步加上第一个账户：「已添加」区淡入，三张选项卡原地淡出、换成一行按钮；「继续添加」再交叉换回选项卡", async () => {
    ipc.overrides.set("list_accounts", () => []);
    ipc.overrides.set("current_account", () => null);
    await mount();
    await click(button("下一步"));
    await click(button("下一步"));
    expect(all("button[data-kind]").every((b) => b.closest("[inert]") === null)).toBe(true);

    // 登录弹窗里添加成功后账户切片重读
    ipc.overrides.delete("list_accounts");
    ipc.overrides.delete("current_account");
    await act(async () => {
      await launcher.actions.reload("accounts");
    });
    await flush();
    const added = all("section").find((section) => section.textContent?.startsWith("已添加"));
    if (added === undefined) throw new Error("没有「已添加」区");
    expect(added.parentElement?.style.opacity).toBe("0");
    expect(all("button[data-kind]").every((b) => b.closest("[inert]") !== null)).toBe(true);
    expect(button("离线账户").closest("div[style]")?.getAttribute("style")).toContain("opacity: 0");

    const addMore = button("继续添加");
    await click(addMore);
    expect(all("button").filter((b) => b.textContent?.trim() === "继续添加").every((b) => b.closest("[inert]") !== null)).toBe(true);
    // 点掉的按钮不离开布局：还是同一颗、留在标题行的常驻槽里淡出，行高由它撑着
    expect(addMore.isConnected).toBe(true);
    expect(addMore.closest("[data-spent]")?.hasAttribute("inert")).toBe(true);
    expect(all("button[data-kind]").some((b) => b.closest("[inert]") === null)).toBe(true);
  });

  it("第三步已添加的账户刷新后皮肤信息重取失败：头像沿用上次读到的皮肤，不退回剪影", async () => {
    const account = accountDto();
    ipc.overrides.set("list_accounts", () => [account]);
    ipc.overrides.set("current_account", () => account);
    ipc.overrides.set("refresh_account", () => account);
    ipc.overrides.set("skin_info", () => ({ kind: "remote", sha1: "ab".repeat(20), model: "wide", hat: true }));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(["skin"]) })));
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 64, height: 64 })));
    await mount();
    await click(button("下一步"));
    await click(button("下一步"));
    const avatar = () => {
      const added = all("section").find((section) => section.textContent?.startsWith("已添加"));
      if (added === undefined) throw new Error("没有「已添加」区");
      return added.querySelector<HTMLElement>('[data-sk-art="skin"]')?.dataset.art;
    };
    expect(avatar()).toBe("skin");
    const skinCalls = callsOf(ipc, "skin_info").length;

    ipc.overrides.set("skin_info", () => {
      throw new IpcError("io", "账户文件读不出来");
    });
    await act(async () => {
      await launcher.actions.refreshAccount(account.uuid);
    });
    await flush();
    // 重取确实发出且以失败落定：资源停在 error，而不是重取中还带着旧数据的 ready
    expect(callsOf(ipc, "skin_info").slice(skinCalls)).toEqual([{ accountUuid: account.uuid }]);
    expect(resources.snapshot(`skin:${account.uuid}`).status).toBe("error");
    expect(avatar()).toBe("skin");
  });

  it("第三步的选项打开同一个登录弹窗（由状态驱动）", async () => {
    await mount();
    await click(button("下一步"));
    await click(button("下一步"));
    const offline = all<HTMLButtonElement>("button").find((b) => b.textContent?.startsWith("离线账户"));
    if (offline === undefined) throw new Error("没有离线账户选项");
    await click(offline);
    expect(launcher.state.login).toMatchObject({ kind: "offline", intent: { kind: "manual" } });
  });

  describe("构建里没有微软登录 client_id", () => {
    // 向导期间主界面没挂上，失败卡的「打开设置」去不了设置页，所以要在这一步就拦下
    beforeEach(() => {
      ipc.overrides.set("get_config", async () => ({ ...(await mockInvoke<ConfigDto>("get_config")), has_client_id: false, microsoft_login_available: false }));
    });

    it("还没有账户：微软账户那张选项卡置灰并写原因，点了不发起登录；离线账户照常可加", async () => {
      ipc.overrides.set("list_accounts", () => []);
      ipc.overrides.set("current_account", () => null);
      await mount();
      await click(button("下一步"));
      await click(button("下一步"));
      const cards = all<HTMLButtonElement>("button[data-kind]");
      expect(cards.map((b) => [b.dataset.kind, b.disabled])).toEqual([
        ["microsoft", true],
        ["offline", false],
        ["authlib", false],
      ]);
      expect(cards[0].textContent).toContain("这个版本没有内置微软登录，先走完向导，再到设置里填入 client_id");
      await click(cards[0]);
      expect(launcher.state.login).toBeNull();
      expect(callsOf(ipc, "microsoft_login")).toEqual([]);
      await click(cards[1]);
      expect(launcher.state.login).toMatchObject({ kind: "offline" });
    });

    it("已有账户：收起后的按钮行里微软账户同样不可用，点了不发起登录", async () => {
      await mount();
      await click(button("下一步"));
      await click(button("下一步"));
      const microsoft = button("微软账户");
      expect([microsoft.getAttribute("aria-disabled"), button("离线账户").getAttribute("aria-disabled")]).toEqual(["true", null]);
      await click(microsoft);
      expect(launcher.state.login).toBeNull();
      expect(callsOf(ipc, "microsoft_login")).toEqual([]);
    });
  });

  it("直接开始：一次提交游戏目录与勾选的文件夹，向导随之卸载", async () => {
    await mount();
    const boxes = all<HTMLButtonElement>('[role="checkbox"]');
    await click(boxes[0]);
    await click(button("下一步"));
    await click(button("直接开始"));
    expect(callsOf(ipc, "complete_first_run")).toEqual([{ gameDir: DEFAULT_DIR, extraDirectories: [{ name: "HMCL", path: "D:\\HMCL\\.minecraft" }] }]);
    expect(launcher.state.firstRun).toBe(false);
    expect(document.querySelector("h1")).toBeNull();
  });

  it("后端拒绝游戏目录：停在第一步并把原因写在输入框下", async () => {
    await mount();
    await typePath("games");
    await click(button("下一步"));
    expect(callsOf(ipc, "complete_first_run").map((a) => a.gameDir)).toEqual(["games"]);
    expect(title()).toBe("游戏文件放在哪");
    expect(text()).toContain("游戏目录 games 不能用：不是绝对路径");
    expect(launcher.state.firstRun).toBe(true);
    expect(launcher.state.toasts.map((t) => t.title)).toContain("首次设置没有保存");
  });

  it("离开第一步就写下首次设置：向导接着走，下次启动不再进向导；第一步没改不重复提交，改了再离开重新提交", async () => {
    await mount();
    await click(button("下一步"));
    expect(callsOf(ipc, "complete_first_run").map((a) => a.gameDir)).toEqual([DEFAULT_DIR]);
    expect(title()).toBe("看看这台电脑上的 Java");
    expect(launcher.state.firstRun).toBe(true);
    // 此刻关掉窗口再打开：后端已记下向导走过
    expect(await mockInvoke<boolean>("is_first_run")).toBe(false);

    await click(button("上一步"));
    await click(button("下一步"));
    expect(callsOf(ipc, "complete_first_run")).toHaveLength(1);

    await click(button("上一步"));
    await typePath("D:\\Games\\Petal");
    await click(railItem("Java"));
    expect(callsOf(ipc, "complete_first_run").map((a) => a.gameDir)).toEqual([DEFAULT_DIR, "D:\\Games\\Petal"]);
    expect(title()).toBe("看看这台电脑上的 Java");

    await click(button("直接开始"));
    expect(callsOf(ipc, "complete_first_run")).toHaveLength(2);
    expect(launcher.state.firstRun).toBe(false);
    expect(document.querySelector("h1")).toBeNull();
  });

  it("回到第一步改了目录、取消了勾选再离开：这一次替换上一次，目录列表与只提交这一次时相同", async () => {
    await mount();
    await typePath("D:\\Games\\Foo");
    await click(button("下一步"));
    expect(title()).toBe("看看这台电脑上的 Java");
    await click(button("上一步"));
    await typePath("D:\\Games\\Petal");
    const boxes = all<HTMLButtonElement>('[role="checkbox"]');
    expect(boxes.map((b) => b.getAttribute("aria-checked"))).toEqual(["true", "true"]);
    await click(boxes[1]);
    await click(button("下一步"));
    expect(callsOf(ipc, "complete_first_run")).toEqual([
      { gameDir: "D:\\Games\\Foo", extraDirectories: [{ name: "官方启动器", path: OFFICIAL_DIR }, { name: "HMCL", path: "D:\\HMCL\\.minecraft" }] },
      { gameDir: "D:\\Games\\Petal", extraDirectories: [{ name: "官方启动器", path: OFFICIAL_DIR }] },
    ]);
    // 上一次选的 Foo 不被当成「原来的当前目录」留下，取消勾选的 HMCL 也不留；向导之前就有游戏文件的默认目录照常留着
    const listed = await mockInvoke<GameDirectoryDto[]>("list_game_directories");
    expect(listed.map((d) => [d.path, d.is_current])).toEqual([
      ["D:\\Games\\Petal", true],
      [DEFAULT_DIR, false],
      [OFFICIAL_DIR, false],
    ]);
  });

  it("第一步的提交还没回来时再按 Enter：只提交一次、只前进一步，不跳过 Java 这一步", async () => {
    await mount();
    const pending: (() => void)[] = [];
    ipc.overrides.set("complete_first_run", () => new Promise<null>((resolve) => pending.push(() => resolve(null))));
    const enter = () =>
      act(() => {
        dirInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
    enter();
    enter();
    enter();
    await flush();
    expect(callsOf(ipc, "complete_first_run")).toHaveLength(1);
    for (const resolve of pending) act(() => resolve());
    await flush();
    expect(title()).toBe("看看这台电脑上的 Java");
    expect(text()).toContain("第 2 步，共 4 步");
  });

  it("回到第一步改了目录、提交还没回来时点步骤条：不重复提交，提交回来后只前进到下一步", async () => {
    await mount();
    await click(button("下一步"));
    await click(button("跳过"));
    await click(railItem("游戏目录"));
    await typePath("D:\\Games\\Petal");
    const pending: (() => void)[] = [];
    ipc.overrides.set("complete_first_run", () => new Promise<null>((resolve) => pending.push(() => resolve(null))));
    act(() => button("下一步").click());
    await click(railItem("账户"));
    expect(callsOf(ipc, "complete_first_run").map((a) => a.gameDir)).toEqual([DEFAULT_DIR, "D:\\Games\\Petal"]);
    for (const resolve of pending) act(() => resolve());
    await flush();
    expect(title()).toBe("看看这台电脑上的 Java");
  });

  it("离开第一步时其他启动器的文件夹还没探测完：照当时提交、不收下，收尾也不按后来的探测结果补交", async () => {
    let found: (dirs: { name: string; path: string }[]) => void = () => undefined;
    ipc.overrides.set("discover_game_directories", () => new Promise((resolve) => (found = resolve)));
    await mount();
    await click(button("下一步"));
    expect(callsOf(ipc, "complete_first_run")).toEqual([{ gameDir: DEFAULT_DIR, extraDirectories: [] }]);
    act(() => found([{ name: "HMCL", path: "D:\\HMCL\\.minecraft" }]));
    await flush();
    await click(button("直接开始"));
    expect(callsOf(ipc, "complete_first_run")).toHaveLength(1);
    expect(launcher.state.firstRun).toBe(false);
  });

  it("第四步：明暗立即作用于整个窗口并写后端，「开始使用」收尾", async () => {
    await mount();
    for (let i = 0; i < 3; i++) await click(button("下一步"));
    // 与设置页同一组件：两张明暗预览都画真实颜色（各按自己的明暗、当前强调色），三枚色块各画各的强调色
    const previews = all('[role="radiogroup"][aria-label="明暗"] [data-mode]').map((p) => [p.getAttribute("data-mode"), p.getAttribute("data-tint")]);
    expect(previews).toEqual([
      ["day", "sakura"],
      ["night", "sakura"],
    ]);
    expect(all('[role="radiogroup"][aria-label="强调色"] [data-tint]').map((p) => p.getAttribute("data-tint"))).toEqual(["sakura", "amethyst", "moss"]);
    const night = all<HTMLButtonElement>('[role="radio"]').find((b) => b.textContent?.startsWith("夜樱"));
    if (night === undefined) throw new Error("没有夜樱选项");
    await click(night);
    expect(document.documentElement.getAttribute("data-sk-mode")).toBe("night");
    expect(callsOf(ipc, "set_appearance")).toEqual([{ patch: { mode: "night" } }]);
    await click(button("开始使用"));
    expect(callsOf(ipc, "complete_first_run")).toHaveLength(1);
    expect(launcher.state.firstRun).toBe(false);
  });
});

describe("首次启动向导：选到数据格式不合的游戏目录", () => {
  const PICKED = "D:\\Games\\.minecraft";
  const OTHER = "E:\\Games\\Petal";
  const tooNew = (written_by: string | null, written_by_channel: "dev" | "beta" | "stable" | null) =>
    new IpcError("game_dir_data_too_new", `游戏目录 ${PICKED} 的数据格式 3 比这一版认得的 2 新`, { path: PICKED, found: 3, supported: 2, written_by, written_by_channel });
  const unreadable = (reason: string) => new IpcError("data_format_unreadable", `游戏目录 ${PICKED} 的数据格式记号读不懂`, { path: PICKED, reason });
  const commitFailsWith = (error: Error) =>
    ipc.overrides.set("complete_first_run", () => {
      throw error;
    });

  /** 路径框下那一行的错误；没有错误时（显示常驻提示）为 null。换下去的提示带 inert 留在原处淡出，只认在场的那一块。 */
  const dirError = () => {
    const message = document.querySelector("[data-step-pane]:not([aria-hidden]) [data-error] > :not([inert])");
    return message === null ? null : message.textContent;
  };

  it.each([
    ["被预览版用过", () => tooNew("1.1.0-dev.57", "dev"), "这个文件夹已经被预览版 1.1.0-dev.57 用过，这个版本读不了里面的实例。换一个文件夹，或者装上预览版 1.1.0-dev.57 或更新的版本再来。"],
    ["被正式版用过", () => tooNew("1.3.0", "stable"), "这个文件夹已经被正式版 1.3.0 用过，这个版本读不了里面的实例。换一个文件夹，或者装上正式版 1.3.0 或更新的版本再来。"],
    ["不知道是哪一版用过", () => tooNew(null, null), `这个文件夹已经被更新的${APP_NAME}用过，这个版本读不了里面的实例。换一个文件夹，或者装上更新的版本再来。`],
    ["格式记录读不懂", () => unreadable("expected value at line 1 column 1"), "这个文件夹里的格式记录读不懂（expected value at line 1 column 1），换一个文件夹。"],
  ])("%s：停在第一步，路径框下是不带路径的说法，配置不变", async (_, error, expected) => {
    commitFailsWith(error());
    await mount();
    const config = await mockInvoke<ConfigDto>("get_config");
    await typePath(PICKED);
    await click(button("下一步"));
    expect(callsOf(ipc, "complete_first_run").map((a) => a.gameDir)).toEqual([PICKED]);
    expect(title()).toBe("游戏文件放在哪");
    expect(dirError()).toBe(expected);
    expect(dirInput().value).toBe(PICKED);
    expect(dirInput().getAttribute("aria-invalid")).toBe("true");
    expect(launcher.state.firstRun).toBe(true);
    expect(await mockInvoke<ConfigDto>("get_config")).toEqual(config);
    expect(await mockInvoke<boolean>("is_first_run")).toBe(true);
  });

  it("换一个文件夹：错误随改动收起，再按下一步提交新目录、向导前进", async () => {
    commitFailsWith(tooNew("1.1.0-dev.57", "dev"));
    await mount();
    await typePath(PICKED);
    await click(button("下一步"));
    expect(dirError()).toBe("这个文件夹已经被预览版 1.1.0-dev.57 用过，这个版本读不了里面的实例。换一个文件夹，或者装上预览版 1.1.0-dev.57 或更新的版本再来。");
    await typePath(OTHER);
    expect(dirError()).toBeNull();
    ipc.overrides.delete("complete_first_run");
    await click(button("下一步"));
    expect(callsOf(ipc, "complete_first_run").map((a) => a.gameDir)).toEqual([PICKED, OTHER]);
    expect(title()).toBe("看看这台电脑上的 Java");
    expect((await mockInvoke<ConfigDto>("get_config")).game_dir).toBe(OTHER);
  });

  it("别的失败不落进路径框：停在第一步，只由通知说明", async () => {
    commitFailsWith(new IpcError("io", "文件 IO 失败: config.json"));
    await mount();
    await click(button("下一步"));
    expect(title()).toBe("游戏文件放在哪");
    expect(dirError()).toBeNull();
    expect(launcher.state.toasts.map((t) => t.title)).toContain("首次设置没有保存");
  });
});

describe("首次启动向导：换步动效", () => {
  /** 在场的那一步（退场中的那一步带 inert 与 aria-hidden）。 */
  const presentPane = () => {
    const pane = document.querySelector<HTMLElement>("[data-step-pane]:not([inert])");
    if (pane === null) throw new Error("没有在场的步骤");
    return pane;
  };

  it("换步时退场的那一步把 ref 交给 popLayout，被量好尺寸抽出布局，新的一步不和它平分舞台", async () => {
    // jsdom 不做布局：给步骤报一个尺寸，popLayout 才会给退场的那一步打上抽出布局的标记
    const computed = window.getComputedStyle.bind(window);
    const spy = vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
      const style = computed(el, pseudo);
      if (!(el instanceof HTMLElement) || !el.hasAttribute("data-step-pane")) return style;
      return new Proxy(style, {
        get: (target, key) => {
          if (key === "width") return "520px";
          if (key === "height") return "360px";
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    try {
      await mount();
      await click(button("下一步"));
      const leaving = document.querySelector<HTMLElement>("[data-step-pane][inert]");
      if (leaving === null) throw new Error("换步后没有退场中的那一步");
      expect(leaving.querySelector("h1")?.textContent).toBe("游戏文件放在哪");
      expect(leaving.hasAttribute("data-motion-pop-id")).toBe(true);
      expect(presentPane().hasAttribute("data-motion-pop-id")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  // 后退的那一步在假定时器下还停在退场里，回去时沿用的是同一个节点，量不到新挂载的起点，这里只看前进
  it("向导挂上时的第一步直接就位；之后换上来的一步从前进一侧 16px 处淡入", async () => {
    await mount();
    expect(presentPane().style.opacity).toBe("1");
    expect(presentPane().style.transform).not.toContain("translateX");
    await click(button("下一步"));
    expect(presentPane().style.opacity).toBe("0");
    expect(presentPane().style.transform).toContain("translateX(16px)");
  });

  it.each([false, true])("换上来的一步等第一帧画出来才起步（减少动画 %s）：挂上之后的第一帧仍停在起点；挂载时就在的那一步之后重渲染也不退回起点", async (reduceMotion) => {
    await mount({ ...DEFAULT_APPEARANCE, reduceMotion });
    // 向导挂上之后的重渲染：挂载时就在的第一步不能因此当成新换上来的、退回起点再播一遍
    await typePath("D:\\Games\\Petal");
    await stepFrames(3);
    expect(presentPane().style.opacity).toBe("1");
    expect(presentPane().style.transform).not.toContain("translateX");

    await click(button("下一步"));
    expect(title()).toBe("看看这台电脑上的 Java");
    const pane = presentPane();
    const start = reduceMotion ? "" : "translateX(16px)";
    expect(pane.style.opacity).toBe("0");
    expect(pane.style.transform).toBe(start);
    await stepFrames(1);
    expect(pane.style.opacity).toBe("0");
    expect(pane.style.transform).toBe(start);
    // 放行排在绘制之后的任务里，假时钟要再推进一帧才到点
    await stepFrames(2);
    const opacity = Number(pane.style.opacity);
    expect(opacity).toBeGreaterThan(0);
    expect(opacity).toBeLessThan(1);
    if (reduceMotion) {
      expect(pane.style.transform).toBe("");
    } else {
      const x = /^translateX\((.+)px\)$/.exec(pane.style.transform);
      if (x === null) throw new Error(`新的一步没有在横移的半路上：${pane.style.transform}`);
      expect(Number(x[1])).toBeGreaterThan(0);
      expect(Number(x[1])).toBeLessThan(16);
    }
    await stepFrames(60);
    expect(pane.style.opacity).toBe("1");
    expect(pane.style.transform).toBe(reduceMotion ? "" : "none");
  });

  it("步骤条：走过的那一步序号换成勾号时勾号弹出、序号原地淡出；向导挂上时就在的序号不入场", async () => {
    const waapi = stubSpanAnimations();
    await mount();
    const dot = () => railItem("游戏目录").querySelector<HTMLElement>("[data-glyph]:not([data-leaving])");
    const leavingIndex = () => railItem("游戏目录").querySelector<HTMLElement>('[data-glyph="index"][data-leaving]');
    expect(dot()?.getAttribute("data-glyph")).toBe("index");
    expect(dot()?.hasAttribute("data-enter")).toBe(false);
    await click(button("下一步"));
    expect(dot()?.getAttribute("data-glyph")).toBe("check");
    expect(dot()?.getAttribute("data-enter")).toBe("pop");
    expect(Number(waapi.running(dot() as HTMLElement, "scale").frames[0].scale)).toBe(0.6);
    const index = leavingIndex();
    if (index === null) throw new Error("序号没有留在原处淡出");
    expect(index.textContent).toBe("1");
    expect(waapi.running(index, "opacity").frames).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    // 淡出播完才移除
    waapi.finish(waapi.running(index, "opacity"));
    expect(leavingIndex()).toBeNull();
    expect(dot()?.getAttribute("data-glyph")).toBe("check");
  });

  it.each([false, true])("步骤条「已跳过」（减少动画 %s）：跳过时等第一帧画出来才弹出，回到那一步时原地淡出，不一帧没了", async (reduceMotion) => {
    await mount({ ...DEFAULT_APPEARANCE, reduceMotion });
    const tag = () => railItem("Java").querySelector<HTMLElement>('[class*="_railSkipped_"]');
    await click(button("下一步"));
    await click(button("跳过"));
    expect(title()).toBe("用什么账户进游戏");
    const shown = tag();
    if (shown === null) throw new Error("跳过之后步骤条上没有「已跳过」");
    expect(shown.textContent).toBe("已跳过");
    // 平时从 0.6 弹出；减少动画时只淡入，不缩放
    const start = reduceMotion ? "" : "scale(0.6)";
    expect(shown.style.opacity).toBe("0");
    expect(shown.style.transform).toBe(start);
    await stepFrames(1);
    expect(shown.style.opacity).toBe("0");
    expect(shown.style.transform).toBe(start);
    await stepFrames(2);
    expect(Number(shown.style.opacity)).toBeGreaterThan(0);
    expect(Number(shown.style.opacity)).toBeLessThan(1);
    await stepFrames(60);
    expect(shown.style.opacity).toBe("1");
    expect(shown.style.transform).toBe(reduceMotion ? "" : "none");

    await click(railItem("Java"));
    expect(title()).toBe("看看这台电脑上的 Java");
    // 状态一离开「已跳过」，标签留在原处淡出，不在同一次提交里卸掉
    expect(tag()).toBe(shown);
    await stepFrames(3);
    expect(shown.isConnected).toBe(true);
    expect(Number(shown.style.opacity)).toBeGreaterThan(0);
    expect(Number(shown.style.opacity)).toBeLessThan(1);
    expect(shown.style.transform).toBe(reduceMotion ? "" : "none");
    await stepFrames(60);
    expect(shown.isConnected).toBe(false);
    expect(tag()).toBeNull();
  });

  it("底栏随步骤出现的按钮淡入，离开的原地淡出并且不可再点", async () => {
    await mount();
    await click(button("下一步"));
    // 出没包裹层是按钮外最近的 div：挂上那一刻从透明开始
    for (const name of ["上一步", "直接开始", "跳过"]) expect(button(name).closest("div")?.style.opacity).toBe("0");
    // 入场等第一帧画出来才起步。还停在起点时撤掉的那一项与退场目标相同、没有动画在走，不播退场、随即移除；
    // 先推几帧让淡入走起来，再后退，量的才是「已经在淡入的按钮被撤掉」
    await stepFrames(3);
    for (const name of ["上一步", "直接开始", "跳过"]) expect(Number(button(name).closest("div")?.style.opacity)).toBeGreaterThan(0);
    await click(button("上一步"));
    const leaving = all<HTMLButtonElement>("footer button").filter((b) => ["上一步", "直接开始", "跳过"].includes(b.textContent?.trim() ?? ""));
    expect(leaving).toHaveLength(3);
    expect(leaving.every((b) => b.closest("[inert]") !== null)).toBe(true);
  });

  describe("主按钮", () => {
    const primaries = () => all<HTMLButtonElement>('footer button[data-variant="primary"]');
    // 每层：[文字, 是否当前, aria-hidden]
    const faces = (primary: HTMLElement) =>
      [...primary.querySelectorAll<HTMLElement>('[class*="_primaryFace_"]')].map((face) => [face.textContent, face.hasAttribute("data-current"), face.getAttribute("aria-hidden")]);
    const arrows = (primary: HTMLElement) => [...primary.querySelectorAll('[class*="_primaryArrow_"]')];
    const ON_NEXT = [
      ["下一步", true, null],
      ["开始使用", false, "true"],
    ];
    const ON_FINISH = [
      ["下一步", false, "true"],
      ["开始使用", true, null],
    ];

    it("从头到尾是同一颗按钮，底栏里不垫隐形的按钮：两条文案各一层叠着，到第四步、退回来只换当前层，箭头常驻", async () => {
      await mount();
      const primary = button("下一步");
      expect(primaries()).toEqual([primary]);
      expect(primary.dataset.face).toBe("next");
      expect(faces(primary)).toEqual(ON_NEXT);
      // 后置箭头在「下一步」时也挂着（样式表让它透明）：到第四步时淡入，不随步骤一帧出没
      const arrow = arrows(primary);
      expect(arrow).toHaveLength(1);

      for (let i = 0; i < 3; i++) await click(button("下一步"));
      expect(title()).toBe("挑一个你喜欢的样子");
      expect(button("开始使用")).toBe(primary);
      expect(primaries()).toEqual([primary]);
      expect(primary.dataset.face).toBe("finish");
      expect(faces(primary)).toEqual(ON_FINISH);
      expect(arrows(primary)).toEqual(arrow);

      await click(button("上一步"));
      expect(title()).toBe("用什么账户进游戏");
      expect(button("下一步")).toBe(primary);
      expect(primary.dataset.face).toBe("next");
      expect(faces(primary)).toEqual(ON_NEXT);
      expect(arrows(primary)).toEqual(arrow);
    });

    it("第一步提交还没回来时原地转圈：仍是「下一步」那层，不换文案、不亮箭头", async () => {
      await mount();
      const pending: (() => void)[] = [];
      ipc.overrides.set("complete_first_run", () => new Promise<null>((resolve) => pending.push(() => resolve(null))));
      const primary = button("下一步");
      await click(primary);
      expect(primary.getAttribute("aria-busy")).toBe("true");
      expect(primary.dataset.face).toBe("next");
      expect(faces(primary)).toEqual(ON_NEXT);
      expect(visibleText(primary)).toBe("下一步");
      for (const resolve of pending) act(() => resolve());
      await flush();
      expect(title()).toBe("看看这台电脑上的 Java");
      expect(primary.getAttribute("aria-busy")).toBeNull();
      expect(button("下一步")).toBe(primary);
    });

    it("点下「开始使用」后按钮文案不换（换成更长的字会撑宽按钮、推走「跳过」），进行中的说法只给读屏", async () => {
      await mount();
      for (let i = 0; i < 3; i++) await click(button("下一步"));
      const primary = button("开始使用");
      let release: () => void = () => undefined;
      vi.spyOn(launcher.actions, "finishFirstRun").mockImplementation(() => new Promise<void>((resolve) => (release = resolve)));
      await click(primary);
      expect(primary.getAttribute("aria-busy")).toBe("true");
      expect(primary.dataset.face).toBe("finish");
      expect(faces(primary)).toEqual(ON_FINISH);
      expect(visibleText(primary)).toBe("开始使用");
      expect(primary.getAttribute("aria-label")).toBe("正在准备…");
      act(() => release());
      await flush();
    });
  });

  it("减少动画：换上来的一步只淡入，不带横移（根部只会把横移改成一步到位，旧步会先跳一下）", async () => {
    await mount({ ...DEFAULT_APPEARANCE, reduceMotion: true });
    await click(button("下一步"));
    expect(title()).toBe("看看这台电脑上的 Java");
    expect(presentPane().style.opacity).toBe("0");
    expect(presentPane().style.transform).not.toContain("translateX");
  });
});
