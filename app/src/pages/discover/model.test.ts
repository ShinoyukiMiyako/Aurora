import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CATEGORY_NAME } from "./copy";
import { entry, result, summary } from "./fixtures";
import {
  allPlatformsFailed,
  appendHits,
  categoryDisplay,
  clearFilters,
  conditionParts,
  curseForgeSkipNote,
  DEFAULT_FILTERS,
  fitCandidates,
  hasConditions,
  hitKey,
  HOT_CATEGORIES,
  installedCount,
  instancesFromPack,
  PAGE_SIZE,
  parsePlatformTime,
  partialFailure,
  popoverFilterCount,
  projectOrigins,
  resetPopoverFilters,
  routeFilters,
  routeOfFilters,
  routeSignature,
  searchArgsOf,
  searchKey,
  stalledPage,
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

describe("分类显示名", () => {
  // Modrinth /v2/tag/category 的响应原样；服务器目录的分类不在发现页的搜索范围里，详情也打不开那类工程
  const tags = JSON.parse(readFileSync(new URL("../../../../crates/aurora-modplatform/tests/fixtures/modrinth-tag-category.json", import.meta.url), "utf8")) as { name: string; project_type: string }[];
  const reachable = tags.filter((t) => t.project_type !== "minecraft_java_server");

  it("Mod、整合包、资源包、光影的全部分类都有中文名，表里也没有接口之外的键", () => {
    expect(reachable.map((t) => t.project_type).filter((p, i, all) => all.indexOf(p) === i).sort()).toEqual(["mod", "modpack", "resourcepack", "shader"]);
    expect(reachable.filter((t) => categoryDisplay(t.name) === null).map((t) => `${t.project_type}/${t.name}`)).toEqual([]);
    expect(Object.keys(CATEGORY_NAME).sort()).toEqual([...new Set(reachable.map((t) => t.name))].sort());
  });

  it("显示名不漏英文原文：要么含中文，要么是分辨率这种本身不用翻译的写法", () => {
    expect(Object.entries(CATEGORY_NAME).filter(([, name]) => !/[㐀-鿿]/.test(name) && !/^\d+x$/.test(name))).toEqual([]);
  });

  it("资源详情里见过的分类写成中文，同一个键在各类型下只有一个名字", () => {
    expect(["equipment", "game-mechanics", "entities", "tweaks", "colored-lighting", "bloom", "low"].map(categoryDisplay)).toEqual(["装备", "游戏机制", "实体", "微调", "彩色光照", "泛光", "低负载"]);
    expect(["potato", "screenshot", "8x-", "512x+", "16x"].map(categoryDisplay)).toEqual(["低配友好", "截图向", "8x 及以下", "512x 及以上", "16x"]);
  });

  it("不认识的分类没有显示名：平台新加的键、加载器标签、CurseForge 的英文分类名、对象原型上的名字", () => {
    expect(["brand-new-tag", "datapack", "Technology", "Armor, Tools, and Weapons", "", "constructor", "__proto__"].map(categoryDisplay)).toEqual([null, null, null, null, null, null, null]);
  });

  it("热门分类与详情标签用同一份中文名，每种类型固定 7 枚", () => {
    for (const list of Object.values(HOT_CATEGORIES)) {
      expect(list).toHaveLength(7);
      for (const c of list) expect(c.label).toBe(categoryDisplay(c.key));
    }
    expect(HOT_CATEGORIES.mod.map((c) => c.label)).toEqual(["优化", "科技", "魔法", "冒险", "装饰", "实用", "世界生成"]);
    expect(HOT_CATEGORIES.modpack.map((c) => c.label)).toEqual(["冒险", "科技", "魔法", "轻量", "任务", "多人", "优化"]);
    expect(HOT_CATEGORIES.resourcepack.map((c) => c.label)).toEqual(["原版风", "简约", "写实", "主题", "界面", "字体", "音效"]);
    expect(HOT_CATEGORIES.shader.map((c) => c.label)).toEqual(["原版风", "写实", "半写实", "卡通", "幻想", "低配友好", "截图向"]);
  });
});

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

  it("原地踏步：有平台失败、下一页游标与请求的完全相同才算；没失败、到底了、游标动了一点都不算", () => {
    const cursor = {
      modrinth: { offset: 24, exhausted: true, total: 24, absorbed: [] },
      curseforge: { offset: 0, exhausted: false, total: null, absorbed: [] },
    };
    const request = { ...searchArgsOf(DEFAULT_FILTERS, ""), cursor };
    const failed = [{ platform: "curseforge" as const, message: "503" }];
    expect(stalledPage(request, result([], { errors: failed, next_cursor: structuredClone(cursor) }))).toBe(true);
    expect(stalledPage(request, result([], { next_cursor: structuredClone(cursor) }))).toBe(false);
    expect(stalledPage(request, result([], { errors: failed, next_cursor: null }))).toBe(false);
    expect(stalledPage(request, result([], { errors: failed, next_cursor: { ...cursor, modrinth: { ...cursor.modrinth, offset: 25 } } }))).toBe(false);
    expect(stalledPage(request, result([], { errors: failed, next_cursor: { ...cursor, curseforge: { ...cursor.curseforge, absorbed: ["X"] } } }))).toBe(false);
    // 首页请求不带游标，给回的游标总是新的
    expect(stalledPage(searchArgsOf(DEFAULT_FILTERS, ""), result([], { errors: failed, next_cursor: cursor }))).toBe(false);
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

describe("来自整合包的实例", () => {
  const pack = (platform: "modrinth" | "curseforge" | null, projectId: string | null) => ({ platform, projectId, versionId: null, name: "包", version: null });
  const instances = [
    summary("甲", { modpack: pack("modrinth", "FO") }),
    summary("乙", { modpack: pack("curseforge", "396246") }),
    // 本地文件导入的实例没有平台来源，同名也不算
    summary("丙", { modpack: pack(null, null) }),
    summary("丁"),
    summary("戊", { modpack: pack("curseforge", "FO") }),
  ];

  it("合并卡两个平台的来源都认；平台与工程 id 都对上才算", () => {
    const merged = entry("FO", {
      resource_type: "modpack",
      sources: [
        { platform: "modrinth", project_id: "FO", slug: null, page_url: null, downloads: 1, follows: 1 },
        { platform: "curseforge", project_id: "396246", slug: null, page_url: null, downloads: 1, follows: null },
      ],
    });
    expect(instancesFromPack(projectOrigins(merged), instances).map((i) => i.id)).toEqual(["甲", "乙"]);
  });

  it("单平台卡只认自己；一个都没有时为空", () => {
    expect(projectOrigins(entry("FO", { resource_type: "modpack" }))).toEqual([{ platform: "modrinth", projectId: "FO" }]);
    expect(instancesFromPack(projectOrigins(entry("FO", { resource_type: "modpack" })), instances).map((i) => i.id)).toEqual(["甲"]);
    expect(instancesFromPack(projectOrigins(entry("BMC", { platform: "curseforge", resource_type: "modpack" })), instances)).toEqual([]);
    expect(instancesFromPack([], instances)).toEqual([]);
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
