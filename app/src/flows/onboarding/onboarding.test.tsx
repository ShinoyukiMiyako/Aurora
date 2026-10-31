// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../art/illustrations/test-canvas";
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
