import { describe, expect, it } from "vitest";
import { entry, result, summary } from "./fixtures";
import {
  allPlatformsFailed,
  appendHits,
  clearFilters,
  conditionParts,
  curseForgeSkipNote,
  DEFAULT_FILTERS,
  fitCandidates,
  hasConditions,
  hitKey,
  installedCount,
  PAGE_SIZE,
  parsePlatformTime,
  partialFailure,
  popoverFilterCount,
  resetPopoverFilters,
  routeFilters,
  routeOfFilters,
  routeSignature,
  searchArgsOf,
  searchKey,
  toggleCategory,
  withFitInstance,
  withGameVersion,
  withKind,
  withLoader,
  type DiscoverFilters,
} from "./model";

const LABELS = {
  loaderName: { vanilla: "原版", fabric: "Fabric", quilt: "Quilt", forge: "Forge", neoforge: "NeoForge" },
  platformName: { modrinth: "Modrinth", curseforge: "CurseForge" },
} as const;

/** 可复现的伪随机：同一个种子给出同一串数。 */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("搜索参数", () => {
  it("首页参数：关键词去空白，空白关键词为 null，每页 24 条，游标为 null", () => {
    expect(searchArgsOf(DEFAULT_FILTERS, "  sodium  ")).toEqual({
      query: "sodium",
      resourceTypes: [],
      category: null,
      platform: null,
      loaders: [],
      gameVersions: [],
      sort: "relevance",
      limit: PAGE_SIZE,
      cursor: null,
    });
    expect(searchArgsOf(DEFAULT_FILTERS, "   ").query).toBeNull();
    expect(PAGE_SIZE).toBe(24);
  });

  it("类型换成后端资源类型；加载器只对全部、Mod、整合包生效", () => {
    const base: DiscoverFilters = { ...DEFAULT_FILTERS, loader: "forge", gameVersion: "1.20.1", platform: "curseforge", category: "vanilla-like" };
    expect(searchArgsOf({ ...base, kind: "mod" }, "").loaders).toEqual(["forge"]);
    expect(searchArgsOf({ ...base, kind: "modpack" }, "").resourceTypes).toEqual(["modpack"]);
    const shader = searchArgsOf({ ...base, kind: "shader" }, "");
    expect(shader.resourceTypes).toEqual(["shader"]);
    expect(shader.loaders).toEqual([]);
    expect(shader.gameVersions).toEqual(["1.20.1"]);
    expect(shader.platform).toBe("curseforge");
    expect(searchArgsOf({ ...base, kind: "resourcepack" }, "").resourceTypes).toEqual(["resource_pack"]);
    expect(searchArgsOf({ ...base, kind: "datapack" }, "").resourceTypes).toEqual(["data_pack"]);
  });

  it("缓存 key 与状态层的 search: 前缀写法一致", () => {
    const args = searchArgsOf(DEFAULT_FILTERS, "iris");
    expect(searchKey(args)).toBe(`search:${JSON.stringify(args)}`);
  });
});

describe("筛选状态的变换", () => {
  it("切类型：已选分类不在新类型的列表里就清掉，在的保留", () => {
    const withAdventure = toggleCategory(DEFAULT_FILTERS, "adventure");
    expect(withKind(withAdventure, "modpack").category).toBe("adventure");
    expect(withKind(withAdventure, "shader").category).toBeNull();
    expect(withKind(withAdventure, "shader").kind).toBe("shader");
  });

  it("分类再点一次取消；不在热门列表里的分类直接报错", () => {
    const on = toggleCategory(DEFAULT_FILTERS, "magic");
    expect(on.category).toBe("magic");
    expect(toggleCategory(on, "magic").category).toBeNull();
    expect(toggleCategory(on, "technology").category).toBe("technology");
    expect(() => toggleCategory(DEFAULT_FILTERS, "fonts")).toThrow(/fonts/);
  });

  it("选适配实例带入版本与加载器；原版实例加载器回到不限；认不出版本的实例不能选", () => {
    const fabric = withFitInstance(DEFAULT_FILTERS, summary("生存", { mcVersion: "1.20.4", loader: "quilt" }));
    expect([fabric.fitInstance, fabric.gameVersion, fabric.loader]).toEqual(["生存", "1.20.4", "quilt"]);
    const vanilla = withFitInstance(fabric, summary("原版", { mcVersion: "1.21", loader: "vanilla" }));
    expect([vanilla.fitInstance, vanilla.gameVersion, vanilla.loader]).toEqual(["原版", "1.21", null]);
    expect(() => withFitInstance(DEFAULT_FILTERS, summary("坏", { mcVersion: null }))).toThrow(/坏/);
    expect(withFitInstance(fabric, null).fitInstance).toBeNull();
  });

  it("手动改版本或加载器：适配实例回到不限，其余条件保留", () => {
    const fit = withFitInstance(DEFAULT_FILTERS, summary("生存"));
    const v = withGameVersion(fit, "1.19.2");
    expect([v.fitInstance, v.gameVersion, v.loader]).toEqual([null, "1.19.2", "fabric"]);
    const l = withLoader(fit, "neoforge");
    expect([l.fitInstance, l.gameVersion, l.loader]).toEqual([null, "1.21.1", "neoforge"]);
  });

  it("浮层重置只清浮层三项与适配；清除筛选另外清分类，都不动关键词、类型与排序", () => {
    const busy: DiscoverFilters = {
      ...DEFAULT_FILTERS,
      query: "地图",
      kind: "mod",
      category: "utility",
      platform: "modrinth",
      gameVersion: "1.21.1",
      loader: "forge",
      sort: "downloads",
      fitInstance: "生存",
    };
    const reset = resetPopoverFilters(busy);
    expect(reset).toEqual({ ...busy, platform: null, gameVersion: null, loader: null, fitInstance: null });
    expect(clearFilters(busy)).toEqual({ ...reset, category: null });
    expect(hasConditions(clearFilters(busy))).toBe(false);
    expect(hasConditions(busy)).toBe(true);
  });

  it("筛选按钮的条件数：资源包类型下加载器不算", () => {
    const f: DiscoverFilters = { ...DEFAULT_FILTERS, platform: "modrinth", gameVersion: "1.21.1", loader: "fabric" };
    expect(popoverFilterCount(f)).toBe(3);
    expect(popoverFilterCount({ ...f, kind: "resourcepack" })).toBe(2);
    expect(popoverFilterCount(DEFAULT_FILTERS)).toBe(0);
  });

  it("结果说明行按「版本 · 加载器 · 分类 · 平台」排列", () => {
    const f: DiscoverFilters = { ...DEFAULT_FILTERS, kind: "mod", platform: "curseforge", gameVersion: "1.20.1", loader: "forge", category: "technology" };
    expect(conditionParts(f, LABELS)).toEqual(["1.20.1", "Forge", "科技", "CurseForge"]);
    expect(conditionParts({ ...f, kind: "shader", category: null }, LABELS)).toEqual(["1.20.1", "CurseForge"]);
    expect(conditionParts(DEFAULT_FILTERS, LABELS)).toEqual([]);
  });
});

describe("分页累积", () => {
  it("后到的同一工程丢掉，先来的顺序不变", () => {
    const merged = appendHits([entry("A"), entry("B")], [entry("B"), entry("C"), entry("A", { platform: "curseforge" })]);
    expect(merged.map(hitKey)).toEqual(["modrinth:A", "modrinth:B", "modrinth:C", "curseforge:A"]);
  });

  it("随机页序列：结果没有重复，且每个键第一次出现的位置不变", () => {
    const rand = prng(20261031);
    for (let round = 0; round < 50; round++) {
      let acc: ReturnType<typeof entry>[] = [];
      const firstSeen: string[] = [];
      const pages = 1 + Math.floor(rand() * 6);
      for (let p = 0; p < pages; p++) {
        const size = Math.floor(rand() * 30);
        const page = Array.from({ length: size }, () => entry(`P${Math.floor(rand() * 40)}`, { platform: rand() < 0.5 ? "modrinth" : "curseforge" }));
        for (const e of page) if (!firstSeen.includes(hitKey(e))) firstSeen.push(hitKey(e));
        acc = appendHits(acc, page);
      }
      expect(acc.map(hitKey)).toEqual(firstSeen);
    }
  });
});

describe("平台结果的说明", () => {
  it("只有一个平台失败、另一个照常返回时给出部分失败说明", () => {
    const r = result([entry("A")], { errors: [{ platform: "curseforge", message: "503" }] });
    expect(partialFailure(r)).toEqual({ failed: "curseforge", other: "modrinth", message: "503" });
    expect(allPlatformsFailed(r)).toBe(false);
  });

  it("一个失败、另一个没参与：算全部失败，不算部分失败", () => {
    const r = result([], { errors: [{ platform: "modrinth", message: "超时" }], skipped: [{ platform: "curseforge", reason: "key_missing" }] });
    expect(partialFailure(r)).toBeNull();
    expect(allPlatformsFailed(r)).toBe(true);
  });

  it("两个都失败算全部失败；没有错误不算失败", () => {
    const both = result([], { errors: [{ platform: "modrinth", message: "x" }, { platform: "curseforge", message: "y" }] });
    expect(allPlatformsFailed(both)).toBe(true);
    expect(partialFailure(both)).toBeNull();
    expect(allPlatformsFailed(result([]))).toBe(false);
  });

  it("CurseForge 因分类换算不到或缺密钥没参与时说明；用户只选 Modrinth 时不说明", () => {
    expect(curseForgeSkipNote(result([], { skipped: [{ platform: "curseforge", reason: "category_unmapped" }] }))).toBe("category_unmapped");
    expect(curseForgeSkipNote(result([], { skipped: [{ platform: "curseforge", reason: "key_missing" }] }))).toBe("key_missing");
    expect(curseForgeSkipNote(result([], { skipped: [{ platform: "curseforge", reason: "filtered" }] }))).toBeNull();
    expect(curseForgeSkipNote(result([], { skipped: [{ platform: "modrinth", reason: "filtered" }] }))).toBeNull();
  });
});

describe("已装入实例数", () => {
  const installed = new Map<string, ReadonlySet<string>>([
    ["生存", new Set(["modrinth:A", "curseforge:999"])],
    ["创造", new Set(["curseforge:999"])],
    ["空", new Set<string>()],
  ]);

  it("合并卡的任一来源装在实例里就算一个实例，同一实例不重复计", () => {
    const merged = entry("A", {
      sources: [
        { platform: "modrinth", project_id: "A", slug: null, page_url: null, downloads: 1, follows: 1 },
        { platform: "curseforge", project_id: "999", slug: null, page_url: null, downloads: 1, follows: null },
      ],
    });
    expect(installedCount(merged, installed)).toBe(2);
  });

  it("没有来源列表的单平台卡按自身键计；没装过为 0", () => {
    expect(installedCount(entry("A"), installed)).toBe(1);
    expect(installedCount(entry("Z"), installed)).toBe(0);
    expect(installedCount(entry("A"), new Map())).toBe(0);
  });
});

describe("平台时间", () => {
  it("null 与空串是没给，合法 ISO 给出毫秒，解析不了即抛出", () => {
    expect(parsePlatformTime(null)).toBeNull();
    expect(parsePlatformTime("")).toBeNull();
    expect(parsePlatformTime("2026-10-31T00:00:00Z")).toBe(Date.UTC(2026, 9, 31));
    expect(() => parsePlatformTime("昨天")).toThrow(/昨天/);
  });
});

describe("路由参数", () => {
  const instances = [
    summary("生存", { mcVersion: "1.20.1", loader: "forge" }),
    summary("安装中", { status: "installing" }),
    summary("占位", { placeholder: true }),
    summary("无版本", { mcVersion: null }),
  ];

  it("能当适配实例的只有就绪、认得出版本、不是占位项的实例", () => {
    expect(fitCandidates(instances).map((i) => i.id)).toEqual(["生存"]);
  });

  it("进页参数叠到当前筛选上：关键词、类型、适配实例", () => {
    const next = routeFilters({ ...DEFAULT_FILTERS, category: "magic", sort: "newest" }, { page: "discover", query: "jei", kind: "mod", forInstance: "生存" }, instances);
    expect(next).toEqual({ ...DEFAULT_FILTERS, query: "jei", kind: "mod", category: "magic", sort: "newest", fitInstance: "生存", gameVersion: "1.20.1", loader: "forge" });
  });

  it("forInstance 指向不能适配的实例时不设适配，其余参数照常生效", () => {
    for (const id of ["安装中", "占位", "无版本", "不存在"]) {
      const next = routeFilters(DEFAULT_FILTERS, { page: "discover", kind: "shader", forInstance: id }, instances);
      expect([next.kind, next.fitInstance, next.gameVersion]).toEqual(["shader", null, null]);
    }
  });

  it("没带参数的路由不改动筛选", () => {
    const current = { ...DEFAULT_FILTERS, query: "地图", kind: "datapack" as const };
    expect(routeFilters(current, { page: "discover" }, instances)).toBe(current);
  });

  it("写回路由只带生效的关键词与类型，空关键词与「全部」不写", () => {
    expect(routeOfFilters("all", "  ")).toEqual({ page: "discover" });
    expect(routeOfFilters("modpack", " 冒险 ")).toEqual({ page: "discover", query: "冒险", kind: "modpack" });
  });

  it("签名区分每个参数，写回的路由与带同样参数的外部路由签名相同", () => {
    const a = routeSignature({ page: "discover", query: "x" });
    expect(routeSignature(routeOfFilters("all", "x"))).toBe(a);
    expect(routeSignature({ page: "discover", query: "x", forInstance: "生存" })).not.toBe(a);
    expect(routeSignature({ page: "discover", query: "x", open: { platform: "modrinth", projectId: "A" } })).not.toBe(a);
    expect(routeSignature({ page: "discover", query: "x", kind: "mod" })).not.toBe(a);
    expect(routeSignature({ page: "discover", query: "x", importFile: "D:\\a.mrpack" })).not.toBe(a);
  });
});
