import { describe, expect, it } from "vitest";
import type { InstanceSummary } from "../../domain/adapt";
import { LIBRARY_COPY } from "./copy";
import { brokenInstances, DEFAULT_VIEW, isFiltered, loaderCounts, matchesView, orderSignature, sortInstances, totalPlaytime, visibleInstances } from "./model";

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
    description: null,
    cover: null,
    pinned: false,
    status: "ready",
    brokenReason: null,
    createdAt: 1_000,
    lastPlayedAt: null,
    playtimeMin: 0,
    modCount: 0,
    worldCount: 0,
    isolated: false,
    memoryMb: null,
    modpack: null,
    modpackError: null,
    lastCrashAt: null,
    lastCrashError: null,
    activity: null,
    usedBy: null,
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

  it("顺序签名随顺序变化、不随实例的其他字段变化", () => {
    const a = [inst("x"), inst("y")];
    expect(orderSignature(a)).toBe(orderSignature([inst("x", { playtimeMin: 9 }), inst("y")]));
    expect(orderSignature(a)).not.toBe(orderSignature([inst("y"), inst("x")]));
  });
});

describe("文案", () => {
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
