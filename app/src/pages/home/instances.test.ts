import { describe, expect, it } from "vitest";
import { HERO_TAG_LIMIT, SWITCH_MENU_LIMIT, continueTarget, heroTags, latestWorld, recencyOf, recentInstances, sortByRecency, switchOptions, worldName } from "./instances";
import { summary, world } from "./test-data";

describe("新近度与排序", () => {
  it("玩过按上次游玩，没玩过按创建时刻，两者都没有排最后", () => {
    expect(recencyOf(summary("a", { lastPlayedAt: 50, createdAt: 900 }))).toBe(50);
    expect(recencyOf(summary("b", { createdAt: 900 }))).toBe(900);
    const sorted = sortByRecency([
      summary("未知", { createdAt: null }),
      summary("旧", { lastPlayedAt: 100 }),
      summary("新建", { createdAt: 300 }),
      summary("刚玩", { lastPlayedAt: 500 }),
    ]);
    expect(sorted.map((i) => i.id)).toEqual(["刚玩", "新建", "旧", "未知"]);
  });
});

describe("继续游玩指向的实例", () => {
  const list = [summary("旧", { lastPlayedAt: 100 }), summary("近", { lastPlayedAt: 900 }), summary("新建", { createdAt: 500, lastPlayedAt: null })];

  it("配置里设过当前实例就用它，哪怕它不是最近玩的", () => {
    expect(continueTarget(list, "旧")?.id).toBe("旧");
  });

  it("没设过或设过的已被删除：取最近玩过或最新建的", () => {
    expect(continueTarget(list, null)?.id).toBe("近");
    expect(continueTarget(list, "已删除")?.id).toBe("近");
  });

  it("一个实例都没有为 null", () => {
    expect(continueTarget([], null)).toBeNull();
  });
});

describe("继续游玩大卡的信息标签", () => {
  const pack = { platform: "modrinth" as const, projectId: "1KVo5zza", versionId: "v6", name: "Fabulously Optimized", version: "6.2.0" };

  it("自建 Mod 实例：版本、加载器、Mod 数", () => {
    expect(heroTags(summary("生存", { loader: "fabric", loaderVersion: "0.16.9", modCount: 78 }))).toEqual([
      { kind: "version", mcVersion: "1.21.1" },
      { kind: "loader" },
      { kind: "mods", count: 78 },
    ]);
  });

  it("整合包实例：版本、加载器、整合包名与版本，四样都有时让出 Mod 数，不超过上限", () => {
    const tags = heroTags(summary("FO", { loader: "fabric", modCount: 92, modpack: pack }));
    expect(tags).toEqual([{ kind: "version", mcVersion: "1.21.1" }, { kind: "loader" }, { kind: "modpack", name: "Fabulously Optimized", version: "6.2.0" }]);
    expect(tags).toHaveLength(HERO_TAG_LIMIT);
  });

  it("版本识别不出时，整合包与 Mod 数都放得下；本地文件导入的整合包可以没有版本号", () => {
    expect(heroTags(summary("坏", { mcVersion: null, modCount: 3, modpack: { ...pack, platform: null, projectId: null, versionId: null, version: null } }))).toEqual([
      { kind: "loader" },
      { kind: "modpack", name: "Fabulously Optimized", version: null },
      { kind: "mods", count: 3 },
    ]);
  });

  it("Mod 数为 0 或数不出来时不挂", () => {
    expect(heroTags(summary("原版", { modCount: 0 }))).toEqual([{ kind: "version", mcVersion: "1.21.1" }, { kind: "loader" }]);
    expect(heroTags(summary("损坏", { modCount: null }))).toEqual([{ kind: "version", mcVersion: "1.21.1" }, { kind: "loader" }]);
  });
});

describe("最近游玩", () => {
  it("排除大卡上的实例与没玩过的，按上次游玩倒序截到档位张数", () => {
    const list = [
      summary("a", { lastPlayedAt: 10 }),
      summary("b", { lastPlayedAt: 50 }),
      summary("当前", { lastPlayedAt: 99 }),
      summary("没玩过"),
      summary("c", { lastPlayedAt: 30 }),
      summary("d", { lastPlayedAt: 40 }),
      summary("e", { lastPlayedAt: 20 }),
    ];
    expect(recentInstances(list, "当前", 4).map((i) => i.id)).toEqual(["b", "d", "c", "e"]);
    expect(recentInstances(list, null, 6).map((i) => i.id)).toEqual(["当前", "b", "d", "c", "e", "a"]);
    expect(recentInstances([summary("没玩过")], null, 4)).toEqual([]);
  });
});

describe("「换一个」菜单", () => {
  const many = Array.from({ length: 11 }, (_, i) => summary(`实例${i}`, { lastPlayedAt: 1000 - i, mcVersion: i === 3 ? null : `1.${i}` }));

  it("按新近度最多 8 个，当前项标出，版本识别不出时没有版本", () => {
    const options = switchOptions(many, "实例0");
    expect(options).toHaveLength(SWITCH_MENU_LIMIT);
    expect(options[0]).toEqual({ id: "实例0", name: "实例0", current: true, mcVersion: "1.0" });
    expect(options[3]).toEqual({ id: "实例3", name: "实例3", current: false, mcVersion: null });
    expect(options.filter((o) => o.current)).toHaveLength(1);
  });

  it("当前实例排不进前 8 时替换掉第 8 个，总数不变", () => {
    const options = switchOptions(many, "实例10");
    expect(options.map((o) => o.id)).toEqual(["实例0", "实例1", "实例2", "实例3", "实例4", "实例5", "实例6", "实例10"]);
    expect(options[7].current).toBe(true);
  });

  it("当前实例不在列表里是调用错误", () => {
    expect(() => switchOptions(many, "已删除")).toThrow("不在实例列表里");
  });
});

describe("信息行的存档", () => {
  it("取最后游玩时刻最新的存档", () => {
    const pick = latestWorld([world("一", { last_played: 100 }), world("二", { last_played: 300 }), world("三", { last_played: 200, modified_at: 999 })]);
    expect(pick?.dir_name).toBe("二");
  });

  it("都没有游玩时刻时按目录修改时刻；两者都没有为 null", () => {
    expect(latestWorld([world("一", { modified_at: 5 }), world("二", { modified_at: 9 })])?.dir_name).toBe("二");
    expect(latestWorld([world("一")])).toBeNull();
    expect(latestWorld([])).toBeNull();
  });

  it("显示名读不出时用目录名", () => {
    expect(worldName(world("New World", { name: "海岛据点" }))).toBe("海岛据点");
    expect(worldName(world("New World", { name: null }))).toBe("New World");
  });
});
