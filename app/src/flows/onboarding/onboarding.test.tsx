// @vitest-environment jsdom
// @module-tag heavy-page
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../art/illustrations/test-canvas";
import type { ConfigDto, GameDirectoryDto } from "../../ipc/config";
import { mockInvoke, resetMocks } from "../../ipc/mock";
import { OverlayRoot } from "../../shell/overlay";
import { ShellProvider } from "../../shell/shell";
import { AppearanceProvider, DEFAULT_APPEARANCE } from "../../state/appearance";
import { LauncherProvider, useLauncher, type LauncherApi } from "../../state/launcher";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { callsOf, resetRecorder, settle } from "../../test/launcher";
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

async function mount() {
  view = render(
    <AppearanceProvider initial={DEFAULT_APPEARANCE}>
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

function button(name: string): HTMLButtonElement {
  const found = all<HTMLButtonElement>("button").find((b) => b.getAttribute("aria-label") === name || b.textContent?.trim() === name);
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

afterEach(() => {
  view?.unmount();
  view = undefined;
  document.documentElement.removeAttribute("data-sk-mode");
  document.documentElement.removeAttribute("data-sk-accent");
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
