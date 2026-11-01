import { describe, expect, it } from "vitest";
import { modVersion, summary } from "./fixtures";
import { uniqueName } from "./names";
import { fitsAnyInstance, fitsInstance, gameVersionSummary, sortGameVersions } from "./versions";

const RELEASES = ["1.21.1", "1.21", "1.20.6", "1.20.4", "1.20.1", "1.19.2"];

describe("版本行的游戏版本摘要", () => {
  it("在正式版清单里连成一段时写「旧 – 新」，单个版本只写它", () => {
    expect(gameVersionSummary(["1.20.4", "1.21", "1.20.6", "1.21.1"], RELEASES)).toBe("1.20.4 – 1.21.1");
    expect(gameVersionSummary(["1.20.1"], RELEASES)).toBe("1.20.1");
    expect(gameVersionSummary(["1.20.1", "1.20.1"], RELEASES)).toBe("1.20.1");
  });

  it("不连续时按新到旧列前 3 个，超过 3 个写总数", () => {
    expect(gameVersionSummary(["1.19.2", "1.21.1"], RELEASES)).toBe("1.21.1、1.19.2");
    expect(gameVersionSummary(["1.19.2", "1.20.1", "1.20.6", "1.21.1"], RELEASES)).toBe("1.21.1、1.20.6、1.20.1 等 4 个");
  });

  it("含清单外的版本（快照）或清单未到时按平台顺序列出；没有版本为空串", () => {
    expect(gameVersionSummary(["24w14a", "1.21"], RELEASES)).toBe("24w14a、1.21");
    expect(gameVersionSummary(["1.21", "1.20.6"], null)).toBe("1.21、1.20.6");
    expect(gameVersionSummary([], RELEASES)).toBe("");
  });
});

describe("能不能装进实例", () => {
  const fabric = summary("生存", { mcVersion: "1.21.1", loader: "fabric" });
  const vanilla = summary("原版", { mcVersion: "1.21.1", loader: "vanilla" });

  it("Mod 要游戏版本与加载器都对上，平台没标注的维度视为不限", () => {
    expect(fitsInstance(modVersion("a"), fabric, "mod")).toBe(true);
    expect(fitsInstance(modVersion("a", { loaders: ["forge"] }), fabric, "mod")).toBe(false);
    expect(fitsInstance(modVersion("a", { game_versions: ["1.20.1"] }), fabric, "mod")).toBe(false);
    expect(fitsInstance(modVersion("a", { loaders: [], game_versions: [] }), fabric, "mod")).toBe(true);
    expect(fitsInstance(modVersion("a"), vanilla, "mod")).toBe(false);
  });

  it("资源包、光影、数据包只看游戏版本", () => {
    const forgeOnly = modVersion("a", { loaders: ["forge"] });
    expect(fitsInstance(forgeOnly, vanilla, "resource_pack")).toBe(true);
    expect(fitsInstance(forgeOnly, fabric, "shader")).toBe(true);
    expect(fitsInstance(modVersion("a", { game_versions: ["1.19.2"] }), vanilla, "data_pack")).toBe(false);
  });

  it("不是就绪实例或认不出版本的实例一律不算", () => {
    expect(fitsInstance(modVersion("a"), summary("x", { status: "installing" }), "mod")).toBe(false);
    expect(fitsInstance(modVersion("a", { game_versions: [] }), summary("x", { mcVersion: null }), "resource_pack")).toBe(false);
    expect(fitsAnyInstance(modVersion("a", { loaders: ["quilt"] }), [fabric, vanilla], "mod")).toBe(false);
    expect(fitsAnyInstance(modVersion("a", { loaders: ["quilt", "fabric"] }), [vanilla, fabric], "mod")).toBe(true);
    expect(fitsAnyInstance(modVersion("a"), [], "mod")).toBe(false);
  });
});

describe("支持版本的排序", () => {
  it("按清单从新到旧，清单外的保持平台顺序放在后面并去重", () => {
    expect(sortGameVersions(["1.19.2", "24w14a", "1.21", "1.19.2", "1.21.1", "23w01b"], RELEASES)).toEqual(["1.21.1", "1.21", "1.19.2", "24w14a", "23w01b"]);
    expect(sortGameVersions(["1.20.1", "1.21"], null)).toEqual(["1.20.1", "1.21"]);
  });
});

describe("新实例的默认名", () => {
  it("不重名时原样；重名时依次追加序号，比较不分大小写", () => {
    expect(uniqueName("All the Mods", [])).toBe("All the Mods");
    expect(uniqueName("All the Mods", ["all the mods"])).toBe("All the Mods 2");
    expect(uniqueName("ATM", ["ATM", "atm 2", "ATM 3"])).toBe("ATM 4");
  });

  it("随机占用：结果总是不与任何现有名称撞车（不分大小写），且序号取最小可用值", () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let round = 0; round < 40; round++) {
      const existing = ["Pack", ...Array.from({ length: Math.floor(rand() * 8) }, () => `pack ${2 + Math.floor(rand() * 8)}`)];
      const name = uniqueName("Pack", existing);
      const taken = new Set(existing.map((e) => e.toLowerCase()));
      expect(taken.has(name.toLowerCase())).toBe(false);
      const n = Number(name.slice("Pack ".length));
      for (let k = 2; k < n; k++) expect(taken.has(`pack ${k}`)).toBe(true);
    }
  });
});
