// @vitest-environment jsdom
// @module-tag heavy-page
// 设置页「游戏」分区的加载与增删：内存卡按真实结构占位、内存提醒的进出、其他文件夹不放推测高度的骨架、目录行的进出。
// jsdom 不做布局、没有 Web Animations，让位在这里不跑；断言的是加载门的阶段、占位的结构、退场标记（inert）
// 与挂载那一刻的入场样式，以及骨架与内存滑杆等高的样式约定。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../../art/illustrations/test-canvas";
import { LOADING_DELAY_MS } from "../../../domain/limits";
import type { GameDirectoryDto } from "../../../ipc/config";
import { mockInvoke, resetMocks } from "../../../ipc/mock";
import type { MemoryAdviceDto } from "../../../ipc/system";
import { OverlayRoot } from "../../../shell/overlay";
import { ShellProvider, useNav, type NavApi } from "../../../shell/shell";
import { AppearanceProvider, DEFAULT_APPEARANCE } from "../../../state/appearance";
import { LauncherProvider } from "../../../state/launcher";
import { invalidate } from "../../../state/resource";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../../test/dom";
import type { IpcRecorder } from "../../../test/fake-bridge";
import { deferred, memoryAdviceDto, resetRecorder, settle } from "../../../test/launcher";
import { SETTINGS_COMMANDS, SettingsCommandsProvider, type SettingsCommands } from "../commands";
import SettingsPage from "../index";
import s from "../settings.module.css";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../../ipc/bridge", async (orig) => (await import("../../../test/fake-bridge")).fakeBridge(await orig(), ipc));

let view: Rendered | undefined;
let nav: NavApi;
let removed: string[];

const commands: SettingsCommands = {
  ...SETTINGS_COMMANDS,
  removeGameDirectory: async (path) => {
    removed.push(path);
  },
};

function Harness() {
  nav = useNav();
  return nav.route.page === "settings" ? <SettingsPage route={nav.route} /> : null;
}

const flush = () =>
  act(async () => {
    await settle(20);
  });

const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

/** reduced 为真时按外观里打开了「减少动画」渲染（外观层据此设根部的 MotionConfig）。 */
async function mountGame(reduced = false) {
  view = render(
    <AppearanceProvider initial={{ ...DEFAULT_APPEARANCE, reduceMotion: reduced }}>
      <LauncherProvider>
        <ShellProvider>
          <SettingsCommandsProvider value={commands}>
            <Harness />
          </SettingsCommandsProvider>
          <OverlayRoot />
        </ShellProvider>
      </LauncherProvider>
    </AppearanceProvider>,
  );
  await flush();
  act(() => nav.go({ page: "settings", section: "game" }));
  await flush();
}

/** 按卡头标题找卡片。 */
function card(title: string): HTMLElement {
  const heading = [...document.querySelectorAll("h2, h3")].find((h) => h.textContent === title);
  const found = heading?.closest<HTMLElement>("[data-pad]");
  if (found === undefined || found === null) throw new Error(`找不到卡片「${title}」`);
  return found;
}

function toggle(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find((el) => el.getAttribute("aria-label") === label);
  if (found === undefined) throw new Error(`找不到开关「${label}」`);
  return found;
}

function buttonIn(root: HTMLElement, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label);
  if (found === undefined) throw new Error(`找不到按钮「${label}」`);
  return found;
}

const click = async (el: HTMLElement) => {
  act(() => el.click());
  await flush();
};

/** 在场的元素：退场中的（inert）还在文档里淡出，假定时器下走不完，不算。 */
const live = <E extends Element>(root: ParentNode, selector: string): E[] => [...root.querySelectorAll<E>(selector)].filter((el) => el.closest("[inert]") === null);

beforeEach(() => {
  vi.useFakeTimers();
  resetMocks();
  resetRecorder(ipc);
  stubResizeObserver();
  stubMatchMedia(false);
  stubCanvas();
  removed = [];
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
});

describe("游戏 · 卡片之间的让位", () => {
  it("四张卡片直接排在载入门的分区卡片栈里：一张变高时由那一层的让位把下面的卡片滑过去，分区不再自己包一层", async () => {
    await mountGame();
    const cards = ["内存", "版本隔离", "游戏目录", "存档备份"].map(card);
    const stack = cards[0].parentElement;
    if (stack === null) throw new Error("内存卡片没有父元素");
    expect(stack.classList.contains(s.sectionFlow)).toBe(true);
    expect([...stack.children]).toEqual(cards);
  });
});

describe("游戏 · 内存卡的加载", () => {
  it("估算没到：卡头副标题占住一行、开关照常可用，说明与滑杆先放不可见的占位；300 ms 后占位露面，到了之后同一刻换成内容", async () => {
    const advice = deferred<MemoryAdviceDto>();
    ipc.overrides.set("memory_advice", () => advice.promise);
    await mountGame();
    const memory = card("内存");
    expect(memory.querySelector("[data-reserve]")).not.toBeNull();
    expect(toggle("自动分配").disabled).toBe(false);
    expect(memory.querySelector('input[type="range"]')).toBeNull();
    // 说明与滑杆两处占位都在、都还不可见：数据很快回来时界面不闪，也不是先 0 高再撑开
    expect(memory.querySelectorAll('[aria-busy="true"]')).toHaveLength(2);
    expect(memory.querySelectorAll("[data-pending]")).toHaveLength(2);
    expect(memory.querySelector(`.${s.memorySkeleton}`)).not.toBeNull();

    await wait(LOADING_DELAY_MS);
    expect(memory.querySelectorAll("[data-pending]")).toHaveLength(0);
    expect(memory.querySelectorAll('[aria-busy="true"]')).toHaveLength(2);

    // 数据在骨架露面后马上到：骨架至少停满 300 ms，期间卡头与说明也不提前换
    await act(async () => {
      advice.resolve(memoryAdviceDto({ total_mb: 16384, available_mb: 9000, recommended_mb: 4096 }));
      await settle(20);
    });
    expect(memory.querySelector('input[type="range"]')).toBeNull();
    expect(memory.querySelector("[data-reserve]")).not.toBeNull();

    await wait(LOADING_DELAY_MS);
    expect(memory.querySelector('input[type="range"]')).not.toBeNull();
    expect(memory.querySelector("[data-reserve]")).toBeNull();
    expect(memory.textContent).toContain("本机共 16 GB，这里是所有实例的默认值");
    expect(memory.textContent).toContain("按每个实例的 Mod 数量、整合包推荐值与视距估算；没有当前实例，按原版估算，建议 4 GB");
    expect(memory.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("读不到估算：副标题与说明的占位收起，滑杆的位置换成可重试的错误，开关禁用", async () => {
    ipc.overrides.set("memory_advice", () => {
      throw new Error("查询内存失败");
    });
    await mountGame();
    const memory = card("内存");
    expect(memory.querySelector("[data-reserve]")).toBeNull();
    expect(memory.querySelector('[data-tone="danger"]')?.textContent).toContain("读不到本机内存信息查询内存失败");
    expect(toggle("自动分配").disabled).toBe(true);
    expect(memory.querySelector('[aria-busy="true"]')).toBeNull();
  });
});

describe("游戏 · 内存提醒的进出", () => {
  it("开着自动分配被封顶时有封顶提示；关掉后它原地淡出（inert），超过空闲内存的提示作为后到的一项淡入", async () => {
    await mockInvoke("update_config", { memory: { max_mb: 6144, min_mb: null, auto: true } });
    ipc.overrides.set("memory_advice", () =>
      memoryAdviceDto({ total_mb: 16384, available_mb: 4096, need_mb: 13312, recommended_mb: 8192, limit: { mb: 8192, reason: "half_physical" } }),
    );
    await mountGame();
    const memory = card("内存");
    const notices = () => live<HTMLElement>(memory, '[data-tone="warn"]').map((el) => el.textContent);
    expect(notices()).toEqual(["需要 13 GB，本机最多给 8 GB（物理内存的一半），内存可能不够用。"]);

    await click(toggle("自动分配"));
    const leaving = [...memory.querySelectorAll<HTMLElement>("[inert]")];
    expect(leaving.map((el) => el.textContent)).toEqual(["需要 13 GB，本机最多给 8 GB（物理内存的一半），内存可能不够用。"]);
    expect(notices()).toEqual(["给游戏 6 GB 已经超过现在的空闲内存 4 GB，浏览器、语音软件开多了容易卡顿。"]);
    const entering = live<HTMLElement>(memory, '[data-tone="warn"]')[0].parentElement;
    expect(entering?.style.opacity).toBe("0");
  });
});

describe("游戏 · 其他文件夹", () => {
  const CURRENT = "D:\\Games\\Launcher\\.minecraft";
  const dir = (name: string, path: string, isCurrent = false): GameDirectoryDto => ({ name, path, is_current: isCurrent, available: true, version_count: 0 });

  it("目录还在读时不放推测高度的骨架；首次探测期间「重新探测」照样转圈，探测完停下", async () => {
    const dirs = deferred<GameDirectoryDto[]>();
    const found = deferred<{ name: string; path: string }[]>();
    ipc.overrides.set("list_game_directories", () => dirs.promise);
    ipc.overrides.set("discover_game_directories", () => found.promise);
    await mountGame();
    const games = card("游戏目录");
    await wait(LOADING_DELAY_MS * 2);
    expect(games.querySelector('[class*="skeleton"]')).toBeNull();
    expect(games.querySelector("ul")).toBeNull();
    expect(buttonIn(games, "重新探测").getAttribute("aria-busy")).toBe("true");

    await act(async () => {
      dirs.resolve([dir("默认目录", CURRENT, true), dir("HMCL", "D:\\HMCL\\.minecraft")]);
      found.resolve([]);
      await settle(20);
    });
    expect(buttonIn(games, "重新探测").getAttribute("aria-busy")).toBeNull();
    // 列表是读到之后才出现的一块：自己淡入，不是同帧插进来
    const list = games.querySelector("ul");
    expect(list?.parentElement?.style.opacity).toBe("0");
    expect(live(games, "li").map((li) => li.textContent)).toEqual([expect.stringContaining("HMCL")]);
  });

  it("探测结果晚到：「发现未记录的文件夹」整块作为后到的一项淡入；登记过的与当前目录不算", async () => {
    const found = deferred<{ name: string; path: string }[]>();
    ipc.overrides.set("list_game_directories", () => [dir("默认目录", CURRENT, true), dir("HMCL", "D:\\HMCL\\.minecraft")]);
    ipc.overrides.set("discover_game_directories", () => found.promise);
    await mountGame();
    const games = card("游戏目录");
    expect(games.textContent).not.toContain("发现未记录的文件夹");
    await act(async () => {
      found.resolve([
        { name: "PCL", path: "D:\\PCL\\.minecraft" },
        { name: "HMCL", path: "D:\\HMCL\\.minecraft" },
        { name: "当前", path: CURRENT },
      ]);
      await settle(20);
    });
    const block = games.querySelector<HTMLElement>(`.${s.discovered}`);
    if (block === null) throw new Error("没有出现「发现未记录的文件夹」");
    expect(block.parentElement?.style.opacity).toBe("0");
    expect([...block.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["PCLD:\\PCL\\.minecraft添加"]);
  });

  it("移除一个其他文件夹：那一行原地淡出并标 inert，剩下的行照常在场", async () => {
    let dirs = [dir("默认目录", CURRENT, true), dir("HMCL", "D:\\HMCL\\.minecraft"), dir("PCL", "D:\\PCL\\.minecraft")];
    ipc.overrides.set("list_game_directories", () => dirs);
    ipc.overrides.set("discover_game_directories", () => []);
    await mountGame();
    const games = card("游戏目录");
    const rows = () => live<HTMLLIElement>(games, "li").map((li) => li.querySelector(`.${s.dirName}`)?.textContent);
    expect(rows()).toEqual(["HMCL", "PCL"]);

    dirs = dirs.filter((d) => d.name !== "HMCL");
    const hmcl = [...games.querySelectorAll<HTMLLIElement>("li")].find((li) => li.textContent?.includes("HMCL"));
    if (hmcl === undefined) throw new Error("没有 HMCL 那一行");
    await click(buttonIn(hmcl, "移除"));
    expect(removed).toEqual(["D:\\HMCL\\.minecraft"]);
    expect(hmcl.isConnected).toBe(true);
    expect(hmcl.hasAttribute("inert")).toBe(true);
    expect(rows()).toEqual(["PCL"]);
  });

  describe("之后登记进来的行自己播入场，列表挂上时就在的行不单独入场", () => {
    /** 列表已经挂着时再登记一个目录，返回原有那一行与新来的那一行（挂载那一刻的样式）。 */
    async function addLater(reduced: boolean) {
      let dirs = [dir("默认目录", CURRENT, true), dir("HMCL", "D:\\HMCL\\.minecraft")];
      ipc.overrides.set("list_game_directories", () => dirs);
      ipc.overrides.set("discover_game_directories", () => []);
      await mountGame(reduced);
      const games = card("游戏目录");
      const row = (name: string) => {
        const found = live<HTMLLIElement>(games, "li").find((li) => li.querySelector(`.${s.dirName}`)?.textContent === name);
        if (found === undefined) throw new Error(`没有「${name}」那一行`);
        return found;
      };
      dirs = [...dirs, dir("PCL", "D:\\PCL\\.minecraft")];
      await act(async () => {
        invalidate("game-dirs");
        await settle(20);
      });
      return { kept: row("HMCL"), added: row("PCL") };
    }

    it("平常：新行淡入并从 0.98 落到位", async () => {
      const { kept, added } = await addLater(false);
      // 不播入场的行直接以终态挂上
      expect(kept.style.opacity).toBe("1");
      expect(added.style.opacity).toBe("0");
      expect(added.style.transform).toBe("scale(0.98)");
    });

    it("减少动画：新行只淡入，不缩放（缩放在减少动画下一步到位，退场会先缩一下再淡出）", async () => {
      const { kept, added } = await addLater(true);
      expect(kept.style.opacity).toBe("1");
      expect(added.style.opacity).toBe("0");
      expect(added.style.transform).toBe("");
    });
  });
});

describe("游戏 · 样式约定", () => {
  const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
  // jsdom 环境里 import.meta.url 不是 file: 地址，按本文件所在目录拼路径
  const read = (path: string) => strip(readFileSync(join(dirname(fileURLToPath(import.meta.url)), path), "utf8"));
  const settingsCss = read("../settings.module.css");
  const sliderCss = read("../../../ui/Slider.module.css");
  const memorySliderCss = read("../../../ui/MemorySlider.module.css");
  const tokensCss = read("../../../styles/tokens.css");

  function decl(css: string, selector: string, property: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const block = new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
    if (block === null) throw new Error(`样式表里没有 ${selector}`);
    const found = new RegExp(`(^|[;\\s])${property}\\s*:\\s*([^;]+);`).exec(block[2]);
    if (found === null) throw new Error(`${selector} 没有写 ${property}`);
    return found[2].trim();
  }

  /** 把 var(--sk-…) 换成令牌在 :root 上的取值。 */
  function resolve(value: string): string {
    return value.replace(/var\((--sk-[a-z0-9-]+)\)/g, (_, name: string) => {
      const found = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(tokensCss);
      if (found === null) throw new Error(`令牌表里没有 ${name}`);
      return found[1].trim();
    });
  }

  it("内存滑杆的占位与滑杆等高：命中区、刻度行、占用说明的上距与行高逐项对得上", () => {
    expect(decl(settingsCss, ".memorySkeletonTrack", "height")).toBe(decl(sliderCss, ".control", "height"));
    expect(resolve(decl(settingsCss, ".memorySkeletonTrack", "margin-bottom"))).toBe(decl(sliderCss, ".marks", "height"));
    expect(resolve(decl(settingsCss, ".memorySkeletonUsage", "margin-top"))).toBe(resolve(decl(memorySliderCss, ".usage", "margin")).split(" ")[0]);
    expect(decl(settingsCss, ".memorySkeletonUsage", "line-height")).toBe(decl(memorySliderCss, ".usage", "line-height"));
  });

  it("目录行之间的分隔线只画在在场的行之间：退场中的行（inert）不算", () => {
    expect(settingsCss).toContain(".dirRow:not([inert]) ~ .dirRow:not([inert])");
    expect(settingsCss).not.toMatch(/\.dirRow\s*\+\s*\.dirRow/);
    expect(decl(settingsCss, ".dirList", "position")).toBe("relative");
  });
});
