// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../../art/illustrations/test-canvas";
import { COVER_PRESETS } from "../../../art/iso/covers";
import { coverLabel } from "../../../copy/flows";
import type { ArtDownloadProgressDto, ArtStatusDto, CatalogBlockDto } from "../../../ipc/art";
import { catalogFromDto, setBlockCatalog } from "../../../mc/catalog";
import { OverlayProvider, OverlayRoot } from "../../../shell/overlay";
import { keydown, render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../../test/dom";
import { BlockPicker, gridMove, pickerLayoutKey, renderedRows, type BlockPickerProps } from "./BlockPicker";

const art = vi.hoisted(() => ({ reported: [] as string[] }));

// 无源时框里有下载部件：后端与统一错误处理都换成替身，这里只看选择框本身
vi.mock("../../../ipc/art", async (orig) => ({
  ...(await orig<typeof import("../../../ipc/art")>()),
  onArtDownload: async (_handler: (p: ArtDownloadProgressDto) => void) => () => undefined,
  artDownload: () => new Promise<ArtStatusDto>(() => undefined),
}));
vi.mock("../../../shell/useRunner", async (orig) => {
  const actual = await orig<typeof import("../../../shell/useRunner")>();
  return {
    ...actual,
    useRunner: () => (work: () => unknown, title: string) => actual.runGuarded(work, title, { error: (t, body) => art.reported.push(`${t}：${body}`) }),
  };
});
// 弹窗每次渲染收到的版式键：jsdom 不做布局，形变本身在这里测不了，只核对选择框把版式键交给了弹窗；弹窗照常用真实现
const modal = vi.hoisted(() => ({ layoutKeys: [] as unknown[] }));
vi.mock("../../../ui/Modal", async (orig) => {
  const actual = await orig<typeof import("../../../ui/Modal")>();
  const { createElement } = await import("react");
  return {
    ...actual,
    Modal: (props: Parameters<typeof actual.Modal>[0]) => {
      modal.layoutKeys.push(props.layoutKey);
      return createElement(actual.Modal, props);
    },
  };
});

function dto(id: string, en: string | null = null, zh: string | null = null, front: string | null = null): CatalogBlockDto {
  return { id, top: `block/${id}`, side: `block/${id}`, front, top_tint: null, side_tint: null, hue: 30, name_en: en, name_zh: zh };
}

/** 建筑页恰好是 400 块按编号排好的填充方块，其余几页各有几块带名字的方块。 */
const FILLERS = Array.from({ length: 400 }, (_, i) => `filler_${String(i).padStart(3, "0")}`);

function catalog() {
  return catalogFromDto({
    version_id: "1.21.4",
    blocks: [
      ...FILLERS.map((id) => dto(id)),
      dto("red_wool", "Red Wool", "红色羊毛"),
      dto("white_wool", "White Wool", "白色羊毛"),
      dto("red_concrete", "Red Concrete", "红色混凝土"),
      dto("grass_block", "Grass Block", "草方块"),
      dto("furnace", "Furnace", "熔炉", "block/furnace_front"),
    ],
  });
}

let view: Rendered | undefined;
let props: BlockPickerProps;

beforeEach(() => {
  art.reported.length = 0;
  modal.layoutKeys.length = 0;
  stubMatchMedia(false);
  stubCanvas();
  stubResizeObserver();
  setBlockCatalog(null);
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  setBlockCatalog(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mount(value: BlockPickerProps["value"], imageBusy = false) {
  props = { open: true, instanceId: "周末生存", value, onPick: vi.fn(), onPickImage: vi.fn(), imageBusy, onClose: vi.fn() };
  view = render(
    <OverlayProvider>
      <BlockPicker {...props} />
      <OverlayRoot />
    </OverlayProvider>,
  );
}

const dialog = () => {
  const el = document.querySelector<HTMLElement>('[role="dialog"]');
  if (el === null) throw new Error("选择框没有打开");
  return el;
};
const tabs = () => [...dialog().querySelectorAll<HTMLElement>('[role="tab"]')].map((t) => t.textContent);
const selectedTab = () => dialog().querySelector('[role="tab"][aria-selected="true"]')?.textContent;
const tab = (label: string) => {
  const el = [...dialog().querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === label);
  if (el === undefined) throw new Error(`没有页签 ${label}`);
  return el;
};
const grid = () => {
  const el = dialog().querySelector<HTMLElement>('[role="listbox"]');
  if (el === null) throw new Error("没有网格");
  return el;
};
const options = () => [...grid().querySelectorAll<HTMLElement>('[role="option"]')];
const blocksShown = () => options().map((o) => o.dataset.block);
const activeBlock = () => {
  const id = grid().getAttribute("aria-activedescendant");
  return id === null ? null : document.getElementById(id)?.dataset.block;
};
const search = () => dialog().querySelector<HTMLInputElement>('input[aria-label="搜索方块"]');
const renderedRowIndexes = () => [...new Set(options().map((o) => Math.floor((Number(o.getAttribute("aria-posinset")) - 1) / 9)))];

/** 像用户逐字输入一样改 input：走原生 value setter 再派发 input，React 的 onChange 才收得到。 */
function typeInto(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("jsdom 没有 input.value 的 setter");
  for (const ch of text) {
    act(() => {
      setter.call(input, input.value + ch);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
}

function scrollGrid(top: number) {
  act(() => {
    grid().scrollTop = top;
    grid().dispatchEvent(new Event("scroll"));
  });
}

describe("网格导航（纯函数）", () => {
  it("←→ 逐格且到边就停，↑↓ 隔一行，下面一行不满时 ↓ 落到最后一格", () => {
    expect(gridMove(0, 20, "ArrowLeft", false)).toBe(0);
    expect(gridMove(8, 20, "ArrowRight", false)).toBe(9);
    expect(gridMove(19, 20, "ArrowRight", false)).toBe(19);
    expect(gridMove(3, 20, "ArrowUp", false)).toBe(3);
    expect(gridMove(12, 20, "ArrowUp", false)).toBe(3);
    expect(gridMove(3, 20, "ArrowDown", false)).toBe(12);
    expect(gridMove(10, 20, "ArrowDown", false)).toBe(19);
    expect(gridMove(8, 15, "ArrowDown", false)).toBe(14);
    expect(gridMove(19, 20, "ArrowDown", false)).toBe(19);
  });

  it("Home / End 到本行首尾，带 Ctrl 到全部首尾；最后一行不满时 End 停在最后一格", () => {
    expect(gridMove(13, 20, "Home", false)).toBe(9);
    expect(gridMove(13, 20, "End", false)).toBe(17);
    expect(gridMove(19, 20, "Home", false)).toBe(18);
    expect(gridMove(18, 20, "End", false)).toBe(19);
    expect(gridMove(13, 20, "Home", true)).toBe(0);
    expect(gridMove(3, 20, "End", true)).toBe(19);
  });

  it("PageUp / PageDown 翻 6 行，不满一屏时停在首行或末行的同一列", () => {
    expect(gridMove(60, 400, "PageUp", false)).toBe(6);
    expect(gridMove(40, 400, "PageUp", false)).toBe(4);
    expect(gridMove(4, 400, "PageDown", false)).toBe(58);
    expect(gridMove(380, 400, "PageDown", false)).toBe(398);
    expect(gridMove(372, 400, "PageDown", false)).toBe(399);
    expect(gridMove(360, 400, "PageDown", false)).toBe(396);
  });

  it("不是导航键、或网格是空的，返回 null", () => {
    expect(gridMove(0, 20, "a", false)).toBeNull();
    expect(gridMove(0, 0, "ArrowRight", false)).toBeNull();
  });

  it("渲染可见的 6 行与上下各 2 行余量，当前格所在的行即使滚出去也渲染", () => {
    expect(renderedRows(0, 45, 0)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(renderedRows(52 * 30, 45, 31)).toEqual([27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38]);
    expect(renderedRows(52 * 30, 45, 2)).toEqual([2, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38]);
    expect(renderedRows(52 * 39, 45, 44)).toEqual([36, 37, 38, 39, 40, 41, 42, 43, 44]);
    expect(renderedRows(0, 6, 0)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("有材质源", () => {
  beforeEach(() => setBlockCatalog(catalog()));

  it("七个页签，按方块所在的页打开，选中格标为已选", () => {
    mount({ block: "white_wool", image: false });
    expect(tabs()).toEqual(["推荐", "建筑", "彩色", "自然", "功能", "搜索", "我的图片"]);
    expect(selectedTab()).toBe("彩色");
    expect(blocksShown()).toEqual(["white_wool", "red_wool", "red_concrete"]);
    expect(options().filter((o) => o.getAttribute("aria-selected") === "true").map((o) => o.dataset.block)).toEqual(["white_wool"]);
    expect(document.activeElement).toBe(grid());
    expect(activeBlock()).toBe("white_wool");
    // 不满一屏时补空槽位：6 行 × 9 格
    expect(grid().querySelectorAll('[role="presentation"] > [aria-hidden="true"]').length).toBe(6 * 9 - 3);
  });

  it("有正面的熔炉在功能页，草方块在自然页", () => {
    mount({ block: "furnace", image: false });
    expect(selectedTab()).toBe("功能");
    expect(blocksShown()).toEqual(["furnace"]);
    act(() => tab("自然").click());
    expect(blocksShown()).toEqual(["grass_block"]);
  });

  it("当前方块是预设：从推荐页打开，16 种预设顺序不变、名称用预设中文名", () => {
    mount({ block: "honeycomb_block", image: false });
    expect(selectedTab()).toBe("推荐");
    expect(blocksShown()).toEqual(COVER_PRESETS.map((p) => p.block));
    expect(options().map((o) => o.getAttribute("aria-label"))).toEqual(COVER_PRESETS.map((p) => coverLabel(p.block)));
    expect(options()[0].getAttribute("aria-label")).toBe("樱花木板");
    expect(activeBlock()).toBe("honeycomb_block");
  });

  it("方向键移动当前格并弹出名称与 id，Enter 与空格选中，点击也选中", () => {
    mount({ block: "cherry_planks", image: false });
    const g = grid();
    keydown(g, "ArrowRight");
    expect(activeBlock()).toBe("cherry_leaves");
    const bubble = document.querySelector<HTMLElement>('[role="tooltip"]');
    expect(bubble?.textContent).toBe("樱花树叶cherry_leaves");
    expect(g.hasAttribute("data-keyboard")).toBe(true);
    keydown(g, "ArrowDown");
    expect(activeBlock()).toBe(COVER_PRESETS[10].block);
    keydown(g, "ArrowDown");
    expect(activeBlock()).toBe(COVER_PRESETS[10].block);
    keydown(g, "End");
    expect(activeBlock()).toBe("end_stone_bricks");
    keydown(g, "Home", { ctrlKey: true });
    expect(activeBlock()).toBe("cherry_planks");
    keydown(g, "Enter");
    keydown(g, "ArrowRight");
    keydown(g, " ");
    expect(props.onPick).toHaveBeenNthCalledWith(1, "cherry_planks");
    expect(props.onPick).toHaveBeenNthCalledWith(2, "cherry_leaves");

    act(() => options()[5].click());
    expect(props.onPick).toHaveBeenLastCalledWith(COVER_PRESETS[5].block);
    expect(activeBlock()).toBe(COVER_PRESETS[5].block);
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("在网格里直接打字：跳到搜索框、字落进去、切到搜索页", () => {
    mount({ block: "cherry_planks", image: false });
    const event = keydown(grid(), "w");
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(search());
    expect(search()?.value).toBe("w");
    expect(selectedTab()).toBe("搜索");
    expect(grid().getAttribute("aria-label")).toBe("搜索结果");
    expect(blocksShown()).toEqual(["white_wool", "red_wool"]);
  });

  it("搜索按中文名匹配；换到别的页签时清掉搜索词", () => {
    mount({ block: "cherry_planks", image: false });
    const input = search();
    if (input === null) throw new Error("没有搜索框");
    typeInto(input, "羊毛");
    expect(selectedTab()).toBe("搜索");
    expect(blocksShown()).toEqual(["white_wool", "red_wool"]);
    act(() => tab("彩色").click());
    expect(input.value).toBe("");
    expect(blocksShown()).toEqual(["white_wool", "red_wool", "red_concrete"]);
  });

  it("搜索框为空的搜索页列出全部方块，搜不到时说明怎么搜", () => {
    mount({ block: "cherry_planks", image: false });
    act(() => tab("搜索").click());
    expect(grid().getAttribute("aria-label")).toBe("搜索结果");
    expect(options()[0].getAttribute("aria-setsize")).toBe(String(FILLERS.length + 5));
    const input = search();
    if (input === null) throw new Error("没有搜索框");
    typeInto(input, "钻石");
    expect(dialog().querySelector('[role="listbox"]')).toBeNull();
    expect(dialog().textContent).toContain("没有找到「钻石」");
    expect(dialog().textContent).toContain("中文名、英文名和方块 id 都能搜");
  });

  it("四百块的页只渲染可见行与余量，滚动后换成新的行", () => {
    mount({ block: "filler_000", image: false });
    expect(selectedTab()).toBe("建筑");
    expect(options()[0].getAttribute("aria-setsize")).toBe("400");
    expect(renderedRowIndexes()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(options()).toHaveLength(81);

    scrollGrid(52 * 30);
    // 当前格（第 0 行）滚出去了也留着，aria-activedescendant 才指得到
    expect(renderedRowIndexes()).toEqual([0, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38]);
    expect(options()[9].dataset.block).toBe("filler_243");
    expect(activeBlock()).toBe("filler_000");
  });

  it("选中格在下面时打开就滚到它；键盘往下走出视口时跟着滚", () => {
    mount({ block: "filler_300", image: false });
    // 第 33 行放在视口第 3 行：(33 - 2) × 52
    expect(grid().scrollTop).toBe(31 * 52);
    expect(activeBlock()).toBe("filler_300");
    expect(blocksShown()).toContain("filler_300");

    act(() => tab("推荐").click());
    act(() => tab("建筑").click());
    const g = grid();
    expect(g.scrollTop).toBe(31 * 52);
    keydown(g, "Home", { ctrlKey: true });
    expect(g.scrollTop).toBe(0);
    for (let i = 0; i < 5; i++) keydown(g, "ArrowDown");
    expect(g.scrollTop).toBe(0);
    keydown(g, "ArrowDown");
    expect(activeBlock()).toBe("filler_054");
    expect(g.scrollTop).toBe(52);
  });

  it("方块在用玩家图片：从我的图片页打开，没有已选格，按钮交给调用方选图", () => {
    mount({ block: "white_wool", image: true });
    expect(selectedTab()).toBe("我的图片");
    expect(dialog().textContent).toContain("正在用你的图片");
    act(() => tab("彩色").click());
    expect(options().some((o) => o.getAttribute("aria-selected") === "true")).toBe(false);
    act(() => tab("我的图片").click());
    const button = [...dialog().querySelectorAll("button")].find((b) => b.textContent === "换一张图片");
    if (button === undefined) throw new Error("没有换图按钮");
    act(() => button.click());
    expect(props.onPickImage).toHaveBeenCalledTimes(1);
    expect(props.onPick).not.toHaveBeenCalled();
  });

  it("调用方的选图与导入还没结束：选图按钮转圈，点了不再交给调用方", () => {
    mount({ block: "cherry_planks", image: false }, true);
    act(() => tab("我的图片").click());
    const button = [...dialog().querySelectorAll("button")].find((b) => b.textContent === "选一张图片");
    if (button === undefined) throw new Error("没有选图按钮");
    expect(button.getAttribute("aria-busy")).toBe("true");
    act(() => button.click());
    expect(props.onPickImage).not.toHaveBeenCalled();
  });

  it("Esc 关闭选择框", () => {
    mount({ block: "cherry_planks", image: false });
    keydown(grid(), "Escape");
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});

describe("没有材质源", () => {
  it("只有推荐与我的图片两页，没有搜索框，顶部是下载部件，预设画成徽记", () => {
    mount({ block: "cherry_planks", image: false });
    expect(tabs()).toEqual(["推荐", "我的图片"]);
    expect(search()).toBeNull();
    const text = dialog().textContent ?? "";
    expect(text).toContain("本机还没有原版材质");
    expect(text.indexOf("本机还没有原版材质")).toBeLessThan(text.indexOf("推荐"));
    expect(blocksShown()).toEqual(COVER_PRESETS.map((p) => p.block));
    expect([...grid().querySelectorAll<HTMLElement>("[data-sk-art='iso']")].every((b) => b.dataset.art === "emblem")).toBe(true);
  });

  it("打字不跳搜索：没有搜索框可跳", () => {
    mount({ block: "cherry_planks", image: false });
    const event = keydown(grid(), "r");
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(grid());
  });

  it("不是预设的方块从推荐页打开，没有已选格", () => {
    mount({ block: "white_wool", image: false });
    expect(selectedTab()).toBe("推荐");
    expect(options().some((o) => o.getAttribute("aria-selected") === "true")).toBe(false);
    expect(activeBlock()).toBe("cherry_planks");
  });

  it("打开期间目录载入：分类页与搜索框出现，下载部件原地淡出、不再可交互；弹窗的版式键跟着变，面板据此形变", () => {
    mount({ block: "cherry_planks", image: false });
    // 挂载时就在的下载部件跟着弹窗出现，不另外播入场
    expect(dialog().querySelector("[inert]")).toBeNull();
    expect(modal.layoutKeys.at(-1)).toBe(pickerLayoutKey(null));
    act(() => setBlockCatalog(catalog()));
    // 目录载入的那次渲染里弹窗就拿到新的版式键：面板在这一次量布局、形变过去
    expect(modal.layoutKeys.at(-1)).toBe(pickerLayoutKey(catalog()));
    expect(tabs()).toEqual(["推荐", "建筑", "彩色", "自然", "功能", "搜索", "我的图片"]);
    expect(search()).not.toBeNull();
    // 退场中的部件留着最后一帧淡出：它在不可交互的退场层里，框里其余部分已经没有它
    const leaving = [...dialog().querySelectorAll<HTMLElement>("[inert]")];
    expect(leaving).toHaveLength(1);
    expect(leaving[0].textContent).toContain("本机还没有原版材质");
    const live = dialog().cloneNode(true) as HTMLElement;
    for (const node of live.querySelectorAll("[inert]")) node.remove();
    expect(live.textContent).not.toContain("本机还没有原版材质");
    // 之后才出现的搜索框淡入并从略小处落到位
    const searchItem = search()?.closest<HTMLElement>('[style*="opacity"]');
    expect(searchItem?.style.opacity).toBe("0");
    expect(pickerLayoutKey(null)).not.toBe(pickerLayoutKey(catalog()));
  });
});

describe("搜索结果有无互换", () => {
  beforeEach(() => setBlockCatalog(catalog()));

  const results = () => dialog().querySelector<HTMLElement>("[data-results]");

  it("打开时的网格跟着弹窗出现；搜到没有匹配时无结果那面淡入，再搜到时网格那面淡入", () => {
    mount({ block: "cherry_planks", image: false });
    act(() => tab("搜索").click());
    expect(results()?.dataset.results).toBe("grid");
    expect(results()?.style.opacity).not.toBe("0");
    const input = search();
    if (input === null) throw new Error("没有搜索框");
    typeInto(input, "钻");
    expect(results()?.dataset.results).toBe("empty");
    expect(results()?.style.opacity).toBe("0");
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (!setter) throw new Error("jsdom 没有 input.value 的 setter");
      setter.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(results()?.dataset.results).toBe("grid");
    expect(results()?.style.opacity).toBe("0");
  });

  it("同为有结果时逐字刷新网格不淡入：只有有无互换才淡", () => {
    mount({ block: "cherry_planks", image: false });
    const input = search();
    if (input === null) throw new Error("没有搜索框");
    typeInto(input, "羊");
    typeInto(input, "毛");
    expect(blocksShown()).toEqual(["white_wool", "red_wool"]);
    expect(results()?.style.opacity).not.toBe("0");
  });
});

describe("下载部件退场的定位基准（读样式表）", () => {
  it("选择框正文自己是定位祖先：退场的部件按它量、按它摆，弹窗形变期间主体带 transform 也不会把它挪走", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "BlockPicker.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const body = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].find((m) => m[1].trim() === ".body");
    expect(body?.[2]).toMatch(/position:\s*relative/);
  });
});

describe("方块格的按压反馈（读样式表）", () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "BlockPicker.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (selector: string) => {
    const found = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].find((m) => m[1].trim() === selector);
    if (found === undefined) throw new Error(`样式表里没有 ${selector}`);
    return found[2];
  };

  it("按下时格子缩到 0.94，缩放走独立的 scale 属性与按压弹簧", () => {
    expect(rule(".cell:active")).toMatch(/scale:\s*0\.94/);
    expect(rule(".cell")).toMatch(/scale var\(--sk-spring-tap-dur\) var\(--sk-spring-tap\)/);
  });

  it("减少动画时不缩放，改为瞬时降不透明度", () => {
    const reduced = rule(":global([data-sk-reduced]) .cell:active");
    expect(reduced).toMatch(/scale:\s*none/);
    expect(reduced).toMatch(/opacity:\s*0\.85/);
    expect(reduced).toMatch(/transition:\s*none/);
  });
});
