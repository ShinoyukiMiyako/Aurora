import { describe, expect, it } from "vitest";
import { GAME_DIR_SWITCH_COPY } from "../../copy/flows";
import type { InstanceSummary } from "../../domain/adapt";
import { REFLOW_MAX_ITEMS } from "../../lib/reflow";
import type { GameDirectoryDto } from "../../state/queries/catalog";
import { switchSuggestion } from "../shared/switch-suggestion";
import { LIBRARY_COPY } from "./copy";
import {
  brokenInstances,
  CREATE_CELL_KEY,
  crowdedChange,
  DEFAULT_VIEW,
  directoryOptions,
  isFiltered,
  loaderCounts,
  matchesView,
  sortInstances,
  totalPlaytime,
  visibleInstances,
} from "./model";

function inst(id: string, overrides: Partial<InstanceSummary> = {}): InstanceSummary {
  return {
    id,
    name: id,
    mcVersion: "1.21.1",
    loader: "vanilla",
    loaderVersion: null,
    extraLoaders: [],
    releaseType: "release",
    javaMajor: 21,
    quickPlay: { singleplayer: true, multiplayer: true },
    description: null,
    cover: null,
    coverImage: null,
    background: "follow",
    backgroundImage: null,
    pinned: false,
    status: "ready",
    brokenReason: null,
    createdAt: 1_000,
    lastPlayedAt: null,
    playtimeMin: 0,
    playError: null,
    dirError: null,
    modCount: 0,
    worldCount: 0,
    resourcePackCount: 0,
    isolated: false,
    memoryMb: null,
    modpack: null,
    modpackError: null,
    lastCrashAt: null,
    lastCrashError: null,
    activity: null,
    usedBy: null,
    baseBusy: null,
    settingsError: null,
    incomplete: null,
    placeholder: false,
    ...overrides,
  };
}

const ids = (list: readonly InstanceSummary[]) => list.map((i) => i.id);

describe("loaderCounts", () => {
  it("按主加载器计数，没有的加载器为 0", () => {
    const list = [inst("a", { loader: "fabric" }), inst("b", { loader: "fabric" }), inst("c", { loader: "forge" }), inst("d")];
    expect(loaderCounts(list)).toEqual({ vanilla: 1, fabric: 2, quilt: 0, forge: 1, neoforge: 0 });
    expect(loaderCounts([])).toEqual({ vanilla: 0, fabric: 0, quilt: 0, forge: 0, neoforge: 0 });
  });
});

describe("筛选与搜索", () => {
  const list = [inst("机械动力", { loader: "forge" }), inst("Fabric 生存", { loader: "fabric" }), inst("原版空岛")];

  it("加载器筛选只留同加载器的实例", () => {
    expect(ids(visibleInstances(list, { ...DEFAULT_VIEW, loader: "forge" }))).toEqual(["机械动力"]);
    expect(ids(visibleInstances(list, { ...DEFAULT_VIEW, loader: "quilt" }))).toEqual([]);
  });

  it("搜索不分大小写、去首尾空白、按子串匹配，并与加载器筛选同时生效", () => {
    expect(ids(visibleInstances(list, { ...DEFAULT_VIEW, query: "  fabric " }))).toEqual(["Fabric 生存"]);
    expect(ids(visibleInstances(list, { ...DEFAULT_VIEW, query: "生存", loader: "vanilla" }))).toEqual([]);
    expect(matchesView(list[2], { ...DEFAULT_VIEW, query: "空" })).toBe(true);
  });

  it("只有空白的搜索词不算在搜索", () => {
    expect(isFiltered({ ...DEFAULT_VIEW, query: "   " })).toBe(false);
    expect(isFiltered({ ...DEFAULT_VIEW, query: "a" })).toBe(true);
    expect(isFiltered({ ...DEFAULT_VIEW, loader: "vanilla" })).toBe(true);
    expect(isFiltered(DEFAULT_VIEW)).toBe(false);
  });
});

describe("sortInstances", () => {
  it("最近游玩：按上次游玩倒序，没玩过的按创建时间算，两者都不知道的排最后", () => {
    const list = [
      inst("旧的", { lastPlayedAt: 100, createdAt: 10 }),
      inst("不知道", { lastPlayedAt: null, createdAt: null }),
      inst("刚新建", { lastPlayedAt: null, createdAt: 5_000 }),
      inst("昨天玩过", { lastPlayedAt: 4_000, createdAt: 20 }),
    ];
    expect(ids(sortInstances(list, "recent"))).toEqual(["刚新建", "昨天玩过", "旧的", "不知道"]);
  });

  it("名称：按中文排序规则升序；游玩时长：倒序", () => {
    const list = [inst("b", { playtimeMin: 5 }), inst("a", { playtimeMin: 0 }), inst("c", { playtimeMin: 300 })];
    expect(ids(sortInstances(list, "name"))).toEqual(["a", "b", "c"]);
    expect(ids(sortInstances(list, "playtime"))).toEqual(["c", "b", "a"]);
  });

  it("游玩时长：读不到的实例排在最后，彼此保持原序；不按 0 算", () => {
    const list = [inst("读不到甲", { playtimeMin: null }), inst("没玩过", { playtimeMin: 0 }), inst("读不到乙", { playtimeMin: null }), inst("玩过", { playtimeMin: 300 })];
    expect(ids(sortInstances(list, "playtime"))).toEqual(["玩过", "没玩过", "读不到甲", "读不到乙"]);
  });

  it("不改动传入的数组", () => {
    const list = [inst("b"), inst("a")];
    sortInstances(list, "name");
    expect(ids(list)).toEqual(["b", "a"]);
  });
});

describe("统计与签名", () => {
  it("累计时长求和、损坏实例按原顺序列出", () => {
    const list = [inst("a", { playtimeMin: 90 }), inst("b", { status: "broken", brokenReason: "缺少版本 JSON" }), inst("c", { playtimeMin: 30 })];
    expect(totalPlaytime(list)).toBe(120);
    expect(ids(brokenInstances(list))).toEqual(["b"]);
    expect(LIBRARY_COPY.subtitle(3, 2, totalPlaytime(list))).toBe("共 3 个实例 · 2 个固定在侧栏 · 累计 2 小时");
  });

  it("有实例的游玩记录读不出时加不出总数，页头明说读不到，不写 0 也不只加读得出的部分", () => {
    const list = [inst("a", { playtimeMin: 90 }), inst("b", { playtimeMin: null })];
    expect(totalPlaytime(list)).toBeNull();
    expect(LIBRARY_COPY.subtitle(2, 1, totalPlaytime(list))).toBe("共 2 个实例 · 1 个固定在侧栏 · 累计时长读不到");
    expect(totalPlaytime([])).toBe(0);
  });

  it("修复横幅不收整合包没导入完的实例：补全补不回来；其他种类的未完成照收", () => {
    const marker = (kind: "install" | "repair" | "modpack") => ({ kind, outcome: "failed" as const, startedAt: null, spec: null, error: null });
    const list = [
      inst("pack", { status: "broken", brokenReason: "整合包没有导入完", incomplete: marker("modpack") }),
      inst("install", { status: "broken", brokenReason: "安装没有完成", incomplete: marker("install") }),
      inst("repair", { status: "broken", brokenReason: "补全没有完成", incomplete: marker("repair") }),
      // 正在重新补全的不算损坏
      inst("busy", { status: "installing", incomplete: marker("modpack") }),
    ];
    expect(ids(brokenInstances(list))).toEqual(["install", "repair"]);
  });

});

describe("crowdedChange", () => {
  const range = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `i${from + i}`);

  it("格子没有增删换序时不算，哪怕格子很多", () => {
    expect(crowdedChange({ ids: range(60), create: true }, { ids: range(60), create: true })).toBe(false);
  });

  it("换排序：换了位置的格子超过让位上限才整片换上", () => {
    const n = REFLOW_MAX_ITEMS;
    expect(crowdedChange({ ids: range(n), create: true }, { ids: [...range(n)].reverse(), create: true })).toBe(false);
    expect(crowdedChange({ ids: range(n + 2), create: true }, { ids: [...range(n + 2)].reverse(), create: true })).toBe(true);
    // 只有一张从后面挪到最前（刚玩过的实例按「最近」排上来）：换了位置的 30 格，没超过上限
    expect(crowdedChange({ ids: range(30), create: true }, { ids: ["i29", ...range(29)], create: true })).toBe(false);
  });

  it("增删：新来的或走掉的有一边超过让位上限才整片换上，新建卡也算一格；实例再多，删一张也逐个播", () => {
    const n = REFLOW_MAX_ITEMS;
    // 很多个里删掉靠前的一张：其后几十张被挤动，交给让位
    expect(crowdedChange({ ids: range(n + 20), create: true }, { ids: range(n + 19, 1), create: true })).toBe(false);
    // 从很多筛到只剩一个别的：走掉的连新建卡超过上限
    expect(crowdedChange({ ids: range(n), create: true }, { ids: range(1, n), create: false })).toBe(true);
    // 走掉的连新建卡恰好在上限上：逐个播
    expect(crowdedChange({ ids: range(n - 1), create: true }, { ids: range(1, n), create: false })).toBe(false);
    // 从很少到很多：新来的超过上限
    expect(crowdedChange({ ids: range(1), create: false }, { ids: range(n + 1), create: true })).toBe(true);
    // 只有新建卡出没
    expect(crowdedChange({ ids: range(n), create: false }, { ids: range(n), create: true })).toBe(false);
  });

  it("整段换搜索词：前后各不超过上限、只是并集超过的不整片换上，进出各自逐个播，共同的卡片交给让位", () => {
    const n = REFLOW_MAX_ITEMS;
    // 前后各 25 格、只有 5 格相同：并集 45
    expect(crowdedChange({ ids: range(25), create: false }, { ids: range(25, 20), create: false })).toBe(false);
    // 前后各恰好上限、一格也不相同：并集是上限的两倍
    expect(crowdedChange({ ids: range(n), create: false }, { ids: range(n, n), create: false })).toBe(false);
    expect(crowdedChange({ ids: range(n + 1), create: false }, { ids: range(n + 1, n + 1), create: false })).toBe(true);
  });

  it("新建卡的格子键带「/」：任何系统的目录名里都不能有它，撞不上实例 id", () => {
    expect(CREATE_CELL_KEY).toContain("/");
  });
});

function dir(name: string, version_count: number | null, overrides: Partial<GameDirectoryDto> = {}): GameDirectoryDto {
  return { name, path: `D:\\${name}\\.minecraft`, is_current: false, available: true, version_count, ...overrides };
}

const current = dir("默认目录", 0, { is_current: true });

describe("switchSuggestion", () => {
  it("取其它目录里版本最多的，一样多时取记录在前的", () => {
    const list = [current, dir("官方", 3), dir("PCL2", 12), dir("HMCL", 12)];
    expect(switchSuggestion(list)).toEqual({ dir: list[2], versions: 12 });
  });

  it("当前目录再多也不算：已经在这里了", () => {
    expect(switchSuggestion([dir("默认目录", 40, { is_current: true }), dir("官方", 1)])?.dir.name).toBe("官方");
    expect(switchSuggestion([dir("默认目录", 40, { is_current: true })])).toBeNull();
  });

  it("访问不到的目录切不过去，版本数读不到与 0 个版本都不算有东西", () => {
    expect(switchSuggestion([current, dir("移动硬盘", 30, { available: false })])).toBeNull();
    expect(switchSuggestion([current, dir("读不到", null)])).toBeNull();
    expect(switchSuggestion([current, dir("空的", 0)])).toBeNull();
    expect(switchSuggestion([current, dir("移动硬盘", 30, { available: false }), dir("读不到", null), dir("官方", 1)])?.dir.name).toBe("官方");
  });

  it("没有目录记录时没有可推荐的", () => {
    expect(switchSuggestion([])).toBeNull();
  });
});

describe("directoryOptions", () => {
  const list = [dir("默认目录", 7, { is_current: true }), dir("PCL2", 12), dir("读不到", null), dir("移动硬盘", null, { available: false })];

  it("标签只写目录名，版本数放第二行，读不到时明说，不写 0", () => {
    expect(directoryOptions(list, false, null).map((o) => [o.label, o.hint, o.disabled])).toEqual([
      ["默认目录", "7 个版本", undefined],
      ["PCL2", "12 个版本", undefined],
      ["读不到", "版本数读不到", undefined],
      ["移动硬盘", "位置访问不到，无法切过去", true],
    ]);
  });

  it("值是路径：两个目录重名时也分得开", () => {
    const twins = [dir("HMCL", 1, { is_current: true, path: "D:\\a" }), dir("HMCL", 2, { path: "D:\\b" })];
    expect(directoryOptions(twins, false, null).map((o) => o.value)).toEqual(["D:\\a", "D:\\b"]);
  });

  it("当前目录的版本数跟实例列表走，别的目录不受影响；0 个实例不是读不到", () => {
    expect(directoryOptions(list, false, 9).slice(0, 2).map((o) => o.hint)).toEqual(["9 个版本", "12 个版本"]);
    expect(directoryOptions(list, false, 0)[0].hint).toBe("0 个版本");
  });

  it("有游戏或任务在进行时别的目录都切不了，原因优先于访问不到；当前目录不受影响", () => {
    expect(directoryOptions(list, true, 7).map((o) => [o.hint, o.disabled])).toEqual([
      ["7 个版本", undefined],
      ["有游戏或下载在进行，结束后再切换", true],
      ["有游戏或下载在进行，结束后再切换", true],
      ["有游戏或下载在进行，结束后再切换", true],
    ]);
  });

  it("当前目录访问不到也不禁用：它不是切过去的目标", () => {
    const [option] = directoryOptions([dir("默认目录", null, { is_current: true, available: false })], false, null);
    expect([option.hint, option.disabled]).toEqual(["版本数读不到", undefined]);
  });

  it("当前目录的版本数读不到时不跟实例列表走：盘拔掉时实例列表读到的是空，不等于 0 个版本", () => {
    const [option] = directoryOptions([dir("移动硬盘", null, { is_current: true, available: false }), dir("PCL2", 12)], false, 0);
    expect(option.hint).toBe("版本数读不到");
  });
});

describe("文案", () => {
  it("目录空状态的主按钮：中西文之间留空格，中文名不留", () => {
    expect(GAME_DIR_SWITCH_COPY.emptyAction("PCL2")).toBe("切到 PCL2");
    expect(GAME_DIR_SWITCH_COPY.emptyAction("官方启动器")).toBe("切到官方启动器");
    expect(GAME_DIR_SWITCH_COPY.emptyBody("PCL2", 12)).toBe("「PCL2」里有 12 个版本，切过去就能玩，文件不会被移动。");
  });

  it("筛选无结果的正文：带加载器时中西文之间留空格，原版不留", () => {
    expect(LIBRARY_COPY.noMatchQuery("abc", "fabric")).toBe("没有名字里带「abc」的 Fabric 实例。");
    expect(LIBRARY_COPY.noMatchQuery("abc", null)).toBe("没有名字里带「abc」的实例。");
    expect(LIBRARY_COPY.noMatchLoader("quilt")).toBe("还没有 Quilt 实例。");
    expect(LIBRARY_COPY.noMatchLoader("vanilla")).toBe("还没有原版实例。");
  });

  it("修复横幅逐个列出实例名", () => {
    expect(LIBRARY_COPY.repairBody(["GT: New Horizons", "RLCraft"])).toBe("「GT: New Horizons」「RLCraft」缺少游戏文件，补全后就能启动。");
  });
});
