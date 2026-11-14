// @vitest-environment jsdom
// @module-tag heavy-page
// 主页第一排与游玩卡的加载与动效：数据晚到时卡片不重挂、骨架与内容逐行对齐、晚到的内容淡入、加载前后是同一组元素。
// jsdom 不做布局也不跑完动画，这里断言结构、节点是否同一个、挂载那一刻的 initial 样式与让位挂在哪条弹簧上。
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../art/illustrations/test-canvas";
import { SLOW_LOADING_HINT } from "../../copy/flows";
import { LOADING_DELAY_MS, SLOW_HINT_MS } from "../../domain/limits";
import type { InstanceDto } from "../../ipc/instances";
import { IpcError } from "../../ipc/errors";
import type { PlayDayDto } from "../../state/queries/home";
import { OverlayRoot } from "../../shell/overlay";
import { ShellProvider } from "../../shell/shell";
import { AppearanceProvider, DEFAULT_APPEARANCE } from "../../state/appearance";
import { LauncherProvider, useLauncher, type LauncherApi } from "../../state/launcher";
import { DEFAULT_UI_SHAPE, UiShapeProvider } from "../../state/ui-shape";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../test/dom";
import type { IpcArgs, IpcRecorder } from "../../test/fake-bridge";
import { accountDto, bootOverrides, configDto, instanceDto, resetRecorder, settle } from "../../test/launcher";
import { RemoteImageProvider } from "../../ui/remote-image";
import HomePage from "./index";
import { SKELETON_SIZE } from "./layout";
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
      <UiShapeProvider initial={DEFAULT_UI_SHAPE}>
        <LauncherProvider>
          <ShellProvider>
            <RemoteImageProvider resolve={async (url) => url}>
              <Probe />
              {page && <HomePage route={{ page: "home" }} />}
            </RemoteImageProvider>
            <OverlayRoot />
          </ShellProvider>
        </LauncherProvider>
      </UiShapeProvider>
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

/** 页面上写着慢提示的那些节点（取最内层的文字节点所在元素）。 */
function slowHints(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`.${s.slowHint}`)].filter((el) => el.textContent === SLOW_LOADING_HINT);
}

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

  it("骨架逐行照大卡画：顶行是标签与小按钮，标题区是名称、标签、信息行三行", async () => {
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
    list.resolve(instances);
    await flush();
  });

  it("加载超过慢提示时长：提示在骨架层之外、读屏读得到，压在顶行标签与按钮之间那一格上，骨架的行与顶行都不变", async () => {
    const list = deferred<InstanceDto[]>();
    ipc.overrides.set("list_instances", () => list.promise);
    await mount();
    await advance(LOADING_DELAY_MS);
    const skeleton = heroSkeleton();
    const top = skeleton.querySelector<HTMLElement>(`.${s.heroTop}`);
    if (top === null) throw new Error("骨架缺顶行");
    const topCells = [...top.children];
    const rows = [...(skeleton.querySelector(`.${s.heroInner}`)?.children ?? [])];
    await advance(SLOW_HINT_MS - LOADING_DELAY_MS - 100);
    expect(slowHints()).toEqual([]);

    await advance(100);
    const [hint] = slowHints();
    if (hint === undefined) throw new Error("加载超过慢提示时长，慢提示没有出现");
    expect(hint.closest('[aria-hidden="true"]')).toBeNull();
    expect(skeleton.contains(hint)).toBe(false);
    expect(continueCard().contains(hint)).toBe(true);
    // 出现时从透明淡入
    expect(hint.style.opacity).toBe("0");
    // 骨架顶行仍是标签、留白、按钮三格，标题区与胶囊的行一个没多
    expect([...top.children]).toEqual(topCells);
    expect(topCells).toHaveLength(3);
    expect([...(skeleton.querySelector(`.${s.heroInner}`)?.children ?? [])]).toEqual(rows);
    // 定位层的左右边界照骨架顶行的标签宽与按钮宽、行高照小按钮高
    const slot = hint.closest<HTMLElement>(`.${s.heroSlowHint}`);
    expect(slot?.style.getPropertyValue("--hero-hint-start")).toBe(`${SKELETON_SIZE.continueTag}px`);
    expect(slot?.style.getPropertyValue("--hero-hint-end")).toBe(`${SKELETON_SIZE.switchButton}px`);
    expect(slot?.style.getPropertyValue("--hero-hint-height")).toBe(`${SKELETON_SIZE.buttonSm}px`);
    list.resolve(instances);
    await flush();
  });

  it("慢加载后内容到达：提示在内容开始淡入时已离开 DOM，不与顶行的「上次」叠在同一格里交叉淡化", async () => {
    const list = deferred<InstanceDto[]>();
    ipc.overrides.set("list_instances", () => list.promise);
    await mount();
    await advance(SLOW_HINT_MS);
    expect(slowHints()).toHaveLength(1);

    list.resolve(instances);
    await flush();
    const loaded = continueCard().querySelector<HTMLElement>(`.${s.heroLoaded}:not([inert])`);
    expect(loaded?.querySelector(`.${s.heroWhen}`)?.textContent).toBe("上次 2 分钟前");
    // 内容层还在淡入（jsdom 不跑完动画）：骨架正淡出，提示若跟着骨架退场，这时就会和「上次」叠着
    expect(loaded?.style.opacity).toBe("0");
    expect(text()).not.toContain(SLOW_LOADING_HINT);
  });

  it("没有实例、目录列表读得慢：同一句提示同样在骨架层之外，目录列表到了随即离开", async () => {
    instances = [];
    bootOverrides(ipc, { instances: [] });
    const dirs = deferred<unknown>();
    ipc.overrides.set("list_game_directories", () => dirs.promise);
    await mount();
    await advance(SLOW_HINT_MS);
    const [hint] = slowHints();
    if (hint === undefined) throw new Error("目录列表读得慢，慢提示没有出现");
    expect(hint.closest('[aria-hidden="true"]')).toBeNull();
    expect(continueCard().contains(hint)).toBe(true);

    dirs.resolve([{ name: "默认目录", path: "D:\\Games\\.minecraft", is_current: true, available: true, version_count: 0 }]);
    await flush();
    expect(continueCard().textContent).toContain("还没有可以继续的实例");
    expect(text()).not.toContain(SLOW_LOADING_HINT);
  });

  it("设置晚于实例列表：大卡占着骨架等设置里的当前实例，不先画最近玩的那个再换一面", async () => {
    instances = [...instances, instanceDto("创造", { mc_version: "1.20.1", playtime_min: 60, last_played_at: NOW - 120 * MINUTE })];
    const config = deferred<unknown>();
    ipc.overrides.set("get_config", () => config.promise);
    await mount();
    expect(launcher.state.status.instances.kind).toBe("ready");
    expect(launcher.state.status.settings.kind).toBe("loading");
    // 实例列表已到：照旧算的话这里画的是最近玩的「生存」
    expect(continueCard().querySelector("h2")).toBeNull();
    heroSkeleton();

    config.resolve(configDto({ selected_version: "创造" }));
    await flush();
    expect([...continueCard().querySelectorAll("h2")].map((h) => h.textContent)).toEqual(["创造"]);
  });

  it("骨架层与内容层都是加载区根上的直接子项、骨架层带 aria-hidden：样式表按这个层级把两层都撑满大卡", async () => {
    const list = deferred<InstanceDto[]>();
    ipc.overrides.set("list_instances", () => list.promise);
    await mount();
    await advance(LOADING_DELAY_MS);
    // 与 home.module.css 里撑满骨架层的选择器同一条路径：根（heroLoadable）> 骨架层 > 骨架的框体
    expect(continueCard().querySelector(`.${s.heroLoadable} > [aria-hidden="true"] > .${s.heroFrame}`)).toBe(heroSkeleton());

    list.resolve(instances);
    await flush();
    await advance(LOADING_DELAY_MS);
    const content = continueCard().querySelector(`.${s.heroLoadable} > .${s.heroLoaded}:not([inert])`);
    expect(content?.querySelector("h2")?.textContent).toBe("生存");
  });

  it("动作行的让位与启动胶囊同一条 morph 弹簧；「实例详情」与动作行之间只隔着提示气泡的 contents 包裹，让位越过它直接移动按钮", async () => {
    await mount();
    const details = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "实例详情");
    const row = details?.closest<HTMLElement>(`.${s.heroActions}`);
    if (details === undefined || row === null || row === undefined) throw new Error("找不到「实例详情」或动作行");
    // 中间每一层都是提示气泡的宿主（display: contents，没有盒子）：让位越过它，按钮本身就是被胶囊挤动的那一项
    const between: Element[] = [];
    for (let el = details.parentElement; el !== null && el !== row; el = el.parentElement) between.push(el);
    expect(between.length).toBeGreaterThan(0);
    expect(between.every((el) => el.hasAttribute("data-tooltip-host"))).toBe(true);
    expect(reflowSprings.get(row)).toBe("morph");
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
  it("账户还没读到：问候首帧就是页面的 h1，不在加载区与骨架里；名字一行在 h1 里不可见地占着位", async () => {
    const accounts = deferred<unknown>();
    ipc.overrides.set("list_accounts", () => accounts.promise);
    await mount();
    const h1 = document.querySelector("h1");
    if (h1 === null) throw new Error("账户还在读，页面上就没有 h1");
    expect(h1.textContent).toBe("下午好");
    expect(h1.closest('[aria-hidden="true"]')).toBeNull();
    expect(h1.closest('[aria-busy="true"]')).toBeNull();
    const reserve = h1.querySelector<HTMLElement>(`[aria-busy="true"] > [aria-hidden="true"][data-pending] > .${s.greetName}`);
    expect(reserve?.parentElement?.style.opacity).toBe("0");

    accounts.resolve([accountDto()]);
    await flush();
    expect(document.querySelector("h1")).toBe(h1);
    expect(h1.textContent).toBe("下午好，Steve");
  });

  it("账户晚到、骨架已出现：最短停留期间名字与立绘不提前露出，停满后与骨架同一刻换上，逗号随名字淡入", async () => {
    const accounts = deferred<unknown>();
    ipc.overrides.set("list_accounts", () => accounts.promise);
    await mount();
    await advance(LOADING_DELAY_MS);
    // 问候一直是真字；名字与账户标签是同高的块
    const h1 = document.querySelector("h1");
    expect(h1?.textContent).toBe("下午好");
    const nameSkeleton = h1?.querySelector<HTMLElement>(`[aria-hidden="true"] > .${s.greetName}`);
    expect(nameSkeleton?.querySelector<HTMLElement>('[style*="height"]')?.style.height).toBe("30px");

    accounts.resolve([accountDto()]);
    await flush();
    expect(launcher.state.status.accounts.kind).toBe("ready");
    expect(document.querySelector("h1")?.textContent).toBe("下午好");
    expect(document.querySelector('[aria-label="管理账户"]')).toBeNull();

    await advance(LOADING_DELAY_MS);
    expect(document.querySelector("h1")?.textContent).toBe("下午好，Steve");
    expect(document.querySelector('[aria-label="管理账户"]')).not.toBeNull();
    const comma = [...document.querySelectorAll<HTMLElement>(`.${s.greetHello} > span`)].find((el) => el.textContent === "，");
    expect(comma?.style.opacity).toBe("0");
  });

  it("账户读取出错后点重试：出错的那一行留在原处、重试按钮转圈，不退回骨架；读到后名字与账户标签原位淡入", async () => {
    let reply: () => Promise<unknown> = () => Promise.reject(new IpcError("io", "accounts.json 读不出来"));
    ipc.overrides.set("list_accounts", () => reply());
    await mount();
    /** 在场的出错行：重试成功后退场中的那一行（带 inert）不算。 */
    const issues = () => [...document.querySelectorAll<HTMLElement>(`.${s.greetIssue}`)].filter((el) => el.closest("[inert]") === null);
    const [issue] = issues();
    if (issue === undefined) throw new Error("账户读取出错，问候卡却没有出错的那一行");
    expect(issue.textContent).toContain("账户列表读不出来");
    const card = issue.closest<HTMLElement>("[data-span]") as HTMLElement;

    const retry = deferred<unknown>();
    reply = () => retry.promise;
    act(() => {
      (issue.querySelector("button") as HTMLButtonElement).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    });
    await flush();
    expect(launcher.state.status.accounts.kind).toBe("loading");
    await advance(LOADING_DELAY_MS * 2);
    // 一直是同一行、没有换成骨架；按钮转圈
    expect(issues()).toEqual([issue]);
    expect(issue.querySelector("button")?.getAttribute("aria-busy")).toBe("true");
    expect(card.querySelector('div[aria-busy="true"]')).toBeNull();
    expect(document.querySelector("h1")?.textContent).toBe("下午好");

    retry.resolve([accountDto()]);
    await flush();
    expect(document.querySelector("h1")?.textContent).toBe("下午好，Steve");
    expect(issue.closest("[inert]")).not.toBeNull();
    const name = [...card.querySelectorAll<HTMLElement>(`.${s.greetName}`)].find((el) => el.textContent === "Steve");
    expect(name?.parentElement?.style.opacity).toBe("0");
    const tag = [...card.querySelectorAll<HTMLElement>(`.${s.greetLine}`)].find((el) => el.textContent === "离线账户" && !el.hasAttribute("inert"));
    expect(tag?.style.opacity).toBe("0");
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

  it("游玩记录读取失败：问候卡底栏只剩下载那一行，数字那一块连同加载区一起离开、不占行距；重试时加载区回来", async () => {
    let reply: (args: IpcArgs) => unknown = () => {
      throw new IpcError("io", "playtime.json 读不出来");
    };
    ipc.overrides.set("play_stats", (args: IpcArgs) => reply(args));
    ipc.overrides.set("repair_instance", () => new Promise(() => undefined));
    await mount();
    await act(async () => {
      await launcher.actions.repairInstance("生存");
      await settle();
    });
    const foot = document.querySelector<HTMLElement>(`.${s.greetFoot}`);
    if (foot === null) throw new Error("找不到问候卡底栏");
    // 退场中的那一块（带 inert）已经抽出布局，不算
    const live = () => [...foot.children].filter((el) => !el.hasAttribute("inert"));
    expect(live()).toHaveLength(1);
    expect(live()[0].textContent).toContain("1 个下载进行中");

    const stats = deferred<ReturnType<typeof playStats>>();
    reply = () => stats.promise;
    const retry = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "重试");
    if (retry === undefined) throw new Error("找不到游玩记录的重试按钮");
    act(() => {
      retry.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    });
    await flush();
    // jsdom 不跑完退场，回来的是还在淡出的那一层（同一个 key 接着用），入场初值在这里看不到，只断言它回到了布局里
    expect(live()).toHaveLength(2);
    expect(live()[1].querySelector('[aria-busy="true"]')).not.toBeNull();
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
    // 时长没到时不给每一天贴「无记录」：整根不朗读，读屏只读到组的名称与 aria-busy
    expect(before.map((b) => [b.getAttribute("aria-hidden"), b.getAttribute("aria-label")])).toEqual(Array.from({ length: 7 }, () => ["true", null]));
    expect(before[0].parentElement?.getAttribute("aria-busy")).toBe("true");

    stats.resolve(playStats(pendingArgs));
    await flush();
    const after = weekBars();
    expect(after).toEqual(before);
    after.forEach((b, i) => expect(b).toBe(before[i]));
    expect(after.some((b) => b.disabled)).toBe(false);
    expect(after.some((b) => b.hasAttribute("aria-hidden"))).toBe(false);
    expect(after[6].getAttribute("aria-label")).toBe("10月30日 周五，游玩 1 小时 35 分钟，今天");
    expect(after[5].getAttribute("aria-label")).toBe("10月29日 周四，没有游玩");
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

// 游玩记录通常比实例列表（要扫盘）先到：按还空着的列表算，会先写出「暂无」「0 个实例」「已被删除」，列表一到再一帧换字
describe("游玩卡：要按实例列表算的几块等列表读完", () => {
  const WEEK = "近 7 天 2.1 小时，前 7 天没有记录";
  const STREAK = "连续游玩 1 天，继续保持";

  function insightsCard(): HTMLElement {
    const card = document.querySelector('[aria-label="近 7 天每日游玩时长"]')?.closest<HTMLElement>("[data-span]");
    if (card === null || card === undefined) throw new Error("找不到洞察卡");
    return card;
  }

  /** 洞察卡里在场的数据块名称：退场中的（在带 inert 的层里）与近 7 天柱那一组不算。 */
  const tileLabels = () =>
    [...insightsCard().querySelectorAll<HTMLElement>('[role="group"][aria-label]')]
      .filter((el) => el.closest("[inert]") === null && el.getAttribute("aria-label") !== "近 7 天每日游玩时长")
      .map((el) => el.getAttribute("aria-label"));

  function dayDetail(): HTMLElement {
    const el = document.querySelector<HTMLElement>(`.${s.dayDetail}`);
    if (el === null) throw new Error("找不到当日详情");
    return el;
  }

  /** 当日详情里在场的实例行。 */
  const dayLinks = () =>
    [...dayDetail().querySelectorAll<HTMLElement>('[aria-label^="打开「"]')].filter((el) => el.closest("[inert]") === null).map((el) => el.getAttribute("aria-label"));

  /** 推迟实例列表的读取，返回放行函数。 */
  function holdInstances() {
    const list = deferred<InstanceDto[]>();
    ipc.overrides.set("list_instances", () => list.promise);
    return async () => {
      list.resolve(instances);
      await flush();
    };
  }

  const failInstances = () =>
    ipc.overrides.set("list_instances", () => {
      throw new IpcError("io_failed", "versions 目录读不出来");
    });

  it("列表晚到：常玩加载器、累计时长与当天玩过的实例画骨架，不按空列表算；近 7 天、连续游玩与当天时长照常先出，列表到了再淡入", async () => {
    const release = holdInstances();
    await mount();
    expect(launcher.state.status.instances.kind).toBe("loading");
    expect(tileLabels()).toEqual([WEEK, STREAK]);
    const skeletons = [...insightsCard().querySelectorAll<HTMLElement>(`.${s.statSkeleton}`)];
    expect(skeletons).toHaveLength(2);
    for (const tile of skeletons) {
      expect(tile.children).toHaveLength(3);
      expect(tile.children[1].classList.contains(s.statSkeletonValue)).toBe(true);
    }
    expect(insightsCard().textContent).not.toContain("暂无");
    expect(insightsCard().textContent).not.toContain("个实例");
    expect(dayDetail().textContent).toContain("1 小时 35 分钟");
    expect(dayDetail().textContent).not.toContain("已被删除");
    expect(dayDetail().querySelectorAll(`[aria-hidden="true"] .${s.dayList} > li`)).toHaveLength(1);

    await release();
    expect(tileLabels()).toEqual([WEEK, STREAK, "常玩加载器 原版，近 30 天占 100%", "累计时长 41 小时，1 个实例"]);
    expect(insightsCard().querySelectorAll(`.${s.statSkeleton}`)).toHaveLength(0);
    const top = insightsCard().querySelector<HTMLElement>('[role="group"][aria-label^="常玩加载器"]');
    expect(top?.closest('[style*="opacity: 0"]')).not.toBeNull();
    expect(dayLinks()).toEqual(["打开「生存」"]);
    expect(dayDetail().querySelector('[aria-label="打开「生存」"]')?.closest('[style*="opacity: 0"]')).not.toBeNull();
  });

  it("当天玩过几个实例，列表骨架就画几行；读到后已删除的那个不列", async () => {
    const days: PlayDayDto[] = [
      {
        date: "2026-10-30",
        minutes: 125,
        instances: [
          { version_id: "生存", minutes: 95 },
          { version_id: "已删除", minutes: 30 },
        ],
      },
    ];
    ipc.overrides.set("play_stats", (args: IpcArgs) => ({ ...playStats(args), days }));
    const release = holdInstances();
    await mount();
    expect(dayDetail().querySelectorAll(`[aria-hidden="true"] .${s.dayList} > li`)).toHaveLength(2);
    await release();
    expect(dayLinks()).toEqual(["打开「生存」"]);
  });

  it("列表读取失败：这几块不停在骨架，写读不到，不说实例已被删除；错误由大卡原位报", async () => {
    failInstances();
    await mount();
    expect(launcher.state.status.instances.kind).toBe("error");
    await advance(LOADING_DELAY_MS);
    expect(insightsCard().querySelectorAll(`.${s.statSkeleton}`)).toHaveLength(0);
    expect(tileLabels()).toEqual([WEEK, STREAK, "常玩加载器 读不到", "累计时长 读不到，实例列表读不出来"]);
    expect(dayDetail().textContent).toContain("实例列表读不出来");
    expect(dayDetail().textContent).not.toContain("已被删除");
    expect(dayDetail().querySelector(`.${s.dayList}`)).toBeNull();
    expect(continueCard().textContent).toContain("实例列表读不出来");
  });

  it("读取失败后点重试：重读期间留着读不到、不退回骨架；读到后原位换上", async () => {
    failInstances();
    await mount();
    const retry = deferred<InstanceDto[]>();
    ipc.overrides.set("list_instances", () => retry.promise);
    const button = [...continueCard().querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "重试");
    if (button === undefined) throw new Error("大卡没有重试按钮");
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    });
    await flush();
    expect(launcher.state.status.instances.kind).toBe("loading");
    await advance(LOADING_DELAY_MS);
    expect(insightsCard().querySelectorAll(`.${s.statSkeleton}`)).toHaveLength(0);
    expect(dayDetail().querySelector(`[aria-hidden="true"] .${s.dayList}`)).toBeNull();
    expect(tileLabels()).toEqual([WEEK, STREAK, "常玩加载器 读不到", "累计时长 读不到，实例列表读不出来"]);

    retry.resolve(instances);
    await flush();
    expect(tileLabels()).toEqual([WEEK, STREAK, "常玩加载器 原版，近 30 天占 100%", "累计时长 41 小时，1 个实例"]);
    expect(dayLinks()).toEqual(["打开「生存」"]);
  });
});
