// @vitest-environment jsdom
// @module-tag heavy-page
// 主页第一排与游玩卡的加载与动效：数据晚到时卡片不重挂、骨架与内容逐行对齐、晚到的内容淡入、加载前后是同一组元素。
// jsdom 不做布局也不跑完动画，这里断言结构、节点是否同一个、挂载那一刻的 initial 样式与让位挂在哪条弹簧上。
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../art/illustrations/test-canvas";
import { LOADING_DELAY_MS, SLOW_HINT_MS } from "../../domain/limits";
import type { InstanceDto } from "../../ipc/instances";
import { IpcError } from "../../ipc/errors";
import type { PlayDayDto } from "../../state/queries/home";
import { OverlayRoot } from "../../shell/overlay";
import { ShellProvider } from "../../shell/shell";
import { AppearanceProvider, DEFAULT_APPEARANCE } from "../../state/appearance";
import { LauncherProvider, useLauncher, type LauncherApi } from "../../state/launcher";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../test/dom";
import type { IpcArgs, IpcRecorder } from "../../test/fake-bridge";
import { accountDto, bootOverrides, configDto, instanceDto, resetRecorder, settle } from "../../test/launcher";
import { RemoteImageProvider } from "../../ui/remote-image";
import HomePage from "./index";
import { world } from "./test-data";
import s from "./home.module.css";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));

// 记下每个让位容器挂的是哪条弹簧；实际的观察照常交给 lib/reflow（jsdom 里它什么也不做）
const reflowSprings = vi.hoisted(() => new Map<Element, string>());
vi.mock("../../lib/reflow", async (orig) => {
  const actual = await orig<typeof import("../../lib/reflow")>();
  return {
    ...actual,
    useReflow: <T extends HTMLElement>(spring: Parameters<typeof actual.useReflow>[0] = "settle") => {
      const ref = actual.useReflow<T>(spring);
      return (el: T | null) => {
        if (el !== null) reflowSprings.set(el, spring);
        return ref(el);
      };
    },
  };
});

const MINUTE = 60_000;
/** 2026-10-30 是星期五，下午三点。 */
const NOW = new Date(2026, 9, 30, 15, 0, 0).getTime();

const PLAY_DAYS: PlayDayDto[] = [
  { date: "2026-10-28", minutes: 30, instances: [{ version_id: "生存", minutes: 30 }] },
  { date: "2026-10-30", minutes: 95, instances: [{ version_id: "生存", minutes: 95 }] },
];

let view: Rendered | undefined;
let launcher: LauncherApi;
let instances: InstanceDto[];

function Probe() {
  launcher = useLauncher();
  return null;
}

const flush = () =>
  act(async () => {
    await settle();
  });

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function playStats(args: IpcArgs) {
  const range = args.range as { from: string; to: string };
  return { from: range.from, to: range.to, days: PLAY_DAYS, total_minutes: 125, instances: [] };
}

/** page 为假时只有外层与状态容器：离开主页再回来，状态容器里的数据都还在。 */
function Shell({ page }: { page: boolean }) {
  return (
    <AppearanceProvider initial={DEFAULT_APPEARANCE}>
      <LauncherProvider>
        <ShellProvider>
          <RemoteImageProvider resolve={async (url) => url}>
            <Probe />
            {page && <HomePage route={{ page: "home" }} />}
          </RemoteImageProvider>
          <OverlayRoot />
        </ShellProvider>
      </LauncherProvider>
    </AppearanceProvider>
  );
}

async function mount() {
  view = render(<Shell page />);
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  resetRecorder(ipc);
  reflowSprings.clear();
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
  instances = [instanceDto("生存", { mc_version: "1.21.1", playtime_min: 2480, last_played_at: NOW - 2 * MINUTE, world_count: 1 })];
  bootOverrides(ipc, { instances, config: configDto({ selected_version: "生存" }) });
  ipc.overrides.set("list_instances", () => instances);
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("skin_info", () => null);
  ipc.overrides.set("play_stats", playStats);
  ipc.overrides.set("list_news", () => ({ items: [], fetched_at: NOW, offline: false, launcher_error: null }));
  ipc.overrides.set("list_pinned_servers", () => []);
  ipc.overrides.set("list_known_servers", () => []);
  ipc.overrides.set("ping_servers", () => []);
  ipc.overrides.set("list_instance_content", () => ({ resource_packs: [], shader_packs: [], worlds: [world("New World", { name: "海岛据点", last_played: NOW - 2 * MINUTE })] }));
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const text = () => document.body.textContent as string;

/** 「继续游玩」这张卡：加载区的根在卡里，往上找到卡片。 */
function continueCard(): HTMLElement {
  const card = document.querySelector(`.${s.heroLoadable}`)?.closest<HTMLElement>("[data-span]");
  if (card === null || card === undefined) throw new Error("找不到继续游玩大卡");
  return card;
}

function heroSkeleton(): HTMLElement {
  const el = continueCard().querySelector<HTMLElement>(`[aria-hidden="true"] > .${s.heroFrame}`);
  if (el === null) throw new Error("大卡骨架不在");
  return el;
}

const heights = (els: Iterable<Element>) => [...els].map((el) => (el as HTMLElement).style.height);

function weekBars(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('[aria-label="近 7 天每日游玩时长"] > button')];
}

describe("继续游玩大卡：加载、空态与实例之间始终是同一张卡", () => {
  it("实例列表晚到且一个都没有：骨架换成紧凑空状态，卡片节点不换（不重挂、不重播入场）", async () => {
    const list = deferred<InstanceDto[]>();
    bootOverrides(ipc, { instances: [] });
    ipc.overrides.set("list_instances", () => list.promise);
    await mount();
    await advance(LOADING_DELAY_MS);
    const card = continueCard();
    heroSkeleton();

    list.resolve([]);
    await flush();
    await advance(LOADING_DELAY_MS);
    expect(continueCard()).toBe(card);
    expect(card.isConnected).toBe(true);
    expect(card.textContent).toContain("还没有可以继续的实例");
    // 紧凑档空状态落在第一排的最小高度之内
    expect(card.querySelector("[data-compact]")?.textContent).toContain("还没有可以继续的实例");
  });

  it("实例列表读取失败：错误面也在同一张卡里，空状态是紧凑档", async () => {
    const list = deferred<InstanceDto[]>();
    ipc.overrides.set("list_instances", () => list.promise);
    await mount();
    const card = continueCard();
    list.reject(new IpcError("io", "instances 目录读不出来"));
    await flush();
    expect(continueCard()).toBe(card);
    const empty = card.querySelector<HTMLElement>("[data-compact]");
    expect(empty?.textContent).toContain("instances 目录读不出来");
  });

  it("骨架逐行照大卡画：顶行是标签与小按钮，标题区是名称、标签、信息行三行；慢提示落在顶行里，不另起一行", async () => {
    const list = deferred<InstanceDto[]>();
    ipc.overrides.set("list_instances", () => list.promise);
    await mount();
    await advance(LOADING_DELAY_MS);
    const skeleton = heroSkeleton();
    const top = skeleton.querySelector<HTMLElement>(`.${s.heroTop}`);
    const title = skeleton.querySelector<HTMLElement>(`.${s.heroTitle}`);
    if (top === null || title === null) throw new Error("骨架缺顶行或标题区");
    // compact 档（jsdom 默认 1024 宽）：「继续游玩」标签 18 高，「换一个」小按钮 30 高
    expect(heights(top.querySelectorAll('[style*="height"]'))).toEqual(["18px", "30px"]);
    expect([...title.children].map((el) => (el as HTMLElement).style.height)).toEqual(["34px", "18px", ""]);
    expect(title.children[2].classList.contains(s.heroLine)).toBe(true);

    const rows = skeleton.querySelector(`.${s.heroInner}`)?.children.length;
    await advance(SLOW_HINT_MS);
    const hint = [...skeleton.querySelectorAll<HTMLElement>(`.${s.slowHint}`)].find((el) => el.textContent?.includes("比平时慢一些"));
    expect(hint?.closest(`.${s.heroTop}`)).toBe(top);
    expect(skeleton.querySelector(`.${s.heroInner}`)?.children.length).toBe(rows);
    list.resolve(instances);
    await flush();
  });

  it("动作行的让位与启动胶囊同一条 morph 弹簧；「实例详情」垫在一层真实的盒子里，是让位能移动的直接子项", async () => {
    await mount();
    const details = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "实例详情");
    const box = details?.closest<HTMLElement>(`.${s.heroDetails}`);
    if (box === null || box === undefined || box.parentElement === null) throw new Error("找不到「实例详情」的盒子");
    expect(box.parentElement.classList.contains(s.heroActions)).toBe(true);
    expect(reflowSprings.get(box.parentElement)).toBe("morph");
  });

  it("存档名晚于大卡到达：整段淡入，追加在信息行末尾", async () => {
    const content = deferred<unknown>();
    ipc.overrides.set("list_instance_content", () => content.promise);
    await mount();
    expect(text()).not.toContain("存档「");
    content.resolve({ resource_packs: [], shader_packs: [], worlds: [world("New World", { name: "海岛据点", last_played: NOW })] });
    await flush();
    const name = [...document.querySelectorAll<HTMLElement>(`.${s.heroWorld}`)].find((el) => el.textContent?.includes("存档「海岛据点」"));
    if (name === undefined) throw new Error("存档名没有出现");
    expect(name.parentElement?.classList.contains(s.heroLine)).toBe(true);
    expect(name.style.opacity).toBe("0");
  });
});

describe("问候卡：账户与下载", () => {
  it("账户晚到、骨架已出现：最短停留期间名字与立绘不提前露出，停满后与骨架同一刻换上", async () => {
    const accounts = deferred<unknown>();
    ipc.overrides.set("list_accounts", () => accounts.promise);
    await mount();
    await advance(LOADING_DELAY_MS);
    // 骨架里的问候是真字，名字与标签是块；标题本身还不在
    expect(document.querySelector("h1")).toBeNull();
    expect(document.querySelector(`[aria-hidden="true"] .${s.greetTitle}`)?.textContent).toBe("下午好");

    accounts.resolve([accountDto()]);
    await flush();
    expect(launcher.state.status.accounts.kind).toBe("ready");
    expect(document.querySelector("h1")).toBeNull();
    expect(document.querySelector('[aria-label="管理账户"]')).toBeNull();

    await advance(LOADING_DELAY_MS);
    expect(document.querySelector("h1")?.textContent).toBe("下午好，Steve");
    expect(document.querySelector('[aria-label="管理账户"]')).not.toBeNull();
  });

  it("立绘随账户晚到时淡入；回到主页时账户已在，立绘跟着页面入场，不另播淡入", async () => {
    await mount();
    const late = document.querySelector<HTMLElement>('[aria-label="管理账户"]')?.closest<HTMLElement>(`.${s.figureSlot}`);
    if (late === null || late === undefined) throw new Error("立绘不在定位层里");
    expect(late.style.opacity).toBe("0");

    view?.rerender(<Shell page={false} />);
    await flush();
    view?.rerender(<Shell page />);
    await flush();
    const present = document.querySelector<HTMLElement>('[aria-label="管理账户"]')?.closest<HTMLElement>(`.${s.figureSlot}`);
    if (present === null || present === undefined) throw new Error("立绘不在定位层里");
    expect(present).not.toBe(late);
    expect(present.style.opacity).not.toBe("0");
  });

  it("下载开始：问候卡底栏的下载行淡入并从略小处落到位", async () => {
    ipc.overrides.set("repair_instance", () => new Promise(() => undefined));
    await mount();
    await act(async () => {
      await launcher.actions.repairInstance("生存");
      await settle();
    });
    const row = [...document.querySelectorAll<HTMLElement>("ul")].find((ul) => ul.textContent?.includes("1 个下载进行中"));
    const item = row?.parentElement;
    if (item === null || item === undefined) throw new Error("下载行没有出现");
    expect(item.closest(`.${s.greetFoot}`)).not.toBeNull();
    expect(item.style.opacity).toBe("0");
    expect(item.style.transform).toContain("scale(0.98)");
  });
});

describe("游玩卡：加载前后是同一组元素，换内容只淡化", () => {
  it("近 7 天柱：加载期间就是这 7 根，星期是真的、不可点；数据到了原地填上数值与填充", async () => {
    const stats = deferred<ReturnType<typeof playStats>>();
    let pendingArgs: IpcArgs = {};
    ipc.overrides.set("play_stats", (args: IpcArgs) => {
      pendingArgs = args;
      return stats.promise;
    });
    await mount();
    const before = weekBars();
    expect(before.map((b) => b.querySelector(`.${s.barLabel}`)?.textContent)).toEqual(["六", "日", "一", "二", "三", "四", "今"]);
    expect(before.every((b) => b.disabled)).toBe(true);
    expect(before.every((b) => b.querySelector(`.${s.barValue}`)?.hasAttribute("data-empty"))).toBe(true);

    stats.resolve(playStats(pendingArgs));
    await flush();
    const after = weekBars();
    expect(after).toEqual(before);
    after.forEach((b, i) => expect(b).toBe(before[i]));
    expect(after.some((b) => b.disabled)).toBe(false);
    const today = after[6];
    expect(today.querySelector(`.${s.barValue}`)?.textContent).toBe("1.6h");
    expect(today.querySelector(`.${s.barValue}`)?.hasAttribute("data-empty")).toBe(false);
    expect(today.querySelector<HTMLElement>(`.${s.barFill}`)?.style.getPropertyValue("--fill")).toBe("1");
  });

  it("洞察数据块骨架每块三行（标签、数值、环比）", async () => {
    const stats = deferred<ReturnType<typeof playStats>>();
    ipc.overrides.set("play_stats", () => stats.promise);
    await mount();
    const tiles = [...document.querySelectorAll<HTMLElement>(`.${s.statSkeleton}`)];
    expect(tiles).toHaveLength(4);
    for (const tile of tiles) {
      expect(tile.children).toHaveLength(3);
      expect(tile.children[1].classList.contains(s.statSkeletonValue)).toBe(true);
    }
  });

  it("日历：加载中副标题先占住一行，到了原位淡入；当日详情骨架是时长与说明两行", async () => {
    const stats = deferred<ReturnType<typeof playStats>>();
    let pendingArgs: IpcArgs = {};
    ipc.overrides.set("play_stats", (args: IpcArgs) => {
      pendingArgs = args;
      return stats.promise;
    });
    await mount();
    const reserve = document.querySelector("[data-reserve]");
    expect(reserve).not.toBeNull();
    const daySkeleton = document.querySelector(`.${s.dayDetail} [aria-hidden="true"] .${s.dayBody}`);
    expect([...(daySkeleton?.children ?? [])].map((el) => el.className)).toEqual([s.dayTime, s.dayHint]);

    stats.resolve(playStats(pendingArgs));
    await flush();
    const subtitle = [...document.querySelectorAll<HTMLElement>("span")].find((el) => el.textContent === "2026年10月 · 2 天 · 共 2 小时 5 分钟");
    expect(subtitle?.style.opacity).toBe("0");
  });

  it("改选日期：当日详情新的一天淡入；挂载时就在的那天不另播", async () => {
    await mount();
    const first = document.querySelector<HTMLElement>(`.${s.dayDetail} .${s.dayBody}`);
    expect(first?.style.opacity).not.toBe("0");
    const bar = weekBars().find((b) => b.getAttribute("aria-label")?.startsWith("10月28日"));
    if (bar === undefined) throw new Error("找不到 10月28日 的柱子");
    act(() => {
      bar.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    });
    const days = [...document.querySelectorAll<HTMLElement>(`.${s.dayDetail} .${s.dayBody}`)];
    const next = days.find((el) => el.textContent?.includes("30 分钟"));
    expect(next?.style.opacity).toBe("0");
  });
});
