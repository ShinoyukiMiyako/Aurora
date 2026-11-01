import { describe, expect, it } from "vitest";
import type { JavaInstallationDto, ManifestDto } from "../../state/queries/catalog";
import { coverLabel } from "../../copy/flows";
import { CREATE_COPY } from "./copy";
import {
  confirmJava,
  effectiveLoaderVersion,
  filledCount,
  filterVersions,
  gameVersionsFromManifest,
  instancePath,
  latestRelease,
  loaderOptions,
  manifestProblem,
  recommendedLoaderVersion,
  supportsLoader,
  visibleSteps,
} from "./model";

function manifest(overrides: Partial<ManifestDto> = {}): ManifestDto {
  return {
    latest: { release: "1.21.1", snapshot: "24w14a" },
    versions: [
      { id: "24w14a", release_type: "snapshot", release_time: "2024-04-03T12:00:00+00:00", loaders: ["fabric"] },
      { id: "1.21.1", release_type: "release", release_time: "2024-08-08T12:00:00+00:00", loaders: ["fabric", "quilt", "forge", "neoforge"] },
      { id: "1.20.1", release_type: "release", release_time: "2023-06-12T12:00:00+00:00", loaders: ["fabric", "forge"] },
      { id: "b1.7.3", release_type: "old_beta", release_time: "2011-07-08T00:00:00+00:00", loaders: [] },
      { id: "a1.2.6", release_type: "old_alpha", release_time: "2010-12-03T00:00:00+00:00", loaders: [] },
    ],
    loader_errors: [],
    stale_since: null,
    fetch_error: null,
    ...overrides,
  };
}

describe("visibleSteps", () => {
  it("原版跳过加载器版本，共 5 步；带加载器 6 步", () => {
    expect(visibleSteps("vanilla")).toEqual(["name", "version", "loader", "cover", "confirm"]);
    expect(visibleSteps("neoforge")).toEqual(["name", "version", "loader", "loaderVersion", "cover", "confirm"]);
  });
});

describe("版本清单", () => {
  it("远古版本归为 old，发布时间换成毫秒时间戳", () => {
    const versions = gameVersionsFromManifest(manifest());
    expect(versions.map((v) => [v.id, v.type])).toEqual([
      ["24w14a", "snapshot"],
      ["1.21.1", "release"],
      ["1.20.1", "release"],
      ["b1.7.3", "old"],
      ["a1.2.6", "old"],
    ]);
    expect(versions[1].releasedAt).toBe(Date.UTC(2024, 7, 8, 12));
  });

  it("发布时间读不出来、版本类型不认识时抛错", () => {
    expect(() => gameVersionsFromManifest(manifest({ versions: [{ id: "x", release_type: "release", release_time: "昨天", loaders: [] }] }))).toThrow(/发布时间/);
    expect(() => gameVersionsFromManifest(manifest({ versions: [{ id: "x", release_type: "pending", release_time: "2024-01-01T00:00:00Z", loaders: [] }] }))).toThrow(
      /版本类型/,
    );
  });

  it("没有任何版本时给出后端原因；连原因也没有属于契约破坏", () => {
    expect(manifestProblem(manifest())).toBeNull();
    expect(manifestProblem(manifest({ versions: [], fetch_error: "连接超时" }))).toBe("连接超时");
    expect(() => manifestProblem(manifest({ versions: [] }))).toThrow(/空/);
  });

  it("最新正式版取清单标出的那个；不在列表里时取第一个正式版", () => {
    const m = manifest();
    expect(latestRelease(m, gameVersionsFromManifest(m)).id).toBe("1.21.1");
    const m2 = manifest({ latest: { release: "1.22", snapshot: "24w14a" } });
    expect(latestRelease(m2, gameVersionsFromManifest(m2)).id).toBe("1.21.1");
    const onlySnapshots = manifest({ versions: [m.versions[0]] });
    expect(() => latestRelease(onlySnapshots, gameVersionsFromManifest(onlySnapshots))).toThrow(/正式版/);
  });

  it("快照与远古版本按开关显示，搜索按版本号子串、不分大小写", () => {
    const versions = gameVersionsFromManifest(manifest());
    const ids = (f: Parameters<typeof filterVersions>[1]) => filterVersions(versions, f).map((v) => v.id);
    expect(ids({ snapshots: false, old: false, query: "" })).toEqual(["1.21.1", "1.20.1"]);
    expect(ids({ snapshots: true, old: false, query: "" })).toEqual(["24w14a", "1.21.1", "1.20.1"]);
    expect(ids({ snapshots: false, old: true, query: "" })).toEqual(["1.21.1", "1.20.1", "b1.7.3", "a1.2.6"]);
    expect(ids({ snapshots: true, old: true, query: " W14 " })).toEqual(["24w14a"]);
    expect(ids({ snapshots: false, old: false, query: "1.19.5" })).toEqual([]);
  });

  it("原版恒可选，其余按版本支持的加载器", () => {
    const [snapshot, , v1201] = gameVersionsFromManifest(manifest());
    expect(supportsLoader(snapshot, "vanilla")).toBe(true);
    expect(supportsLoader(snapshot, "forge")).toBe(false);
    expect(supportsLoader(v1201, "forge")).toBe(true);
    expect(loaderOptions(v1201)).toEqual(["vanilla", "fabric", "forge"]);
  });
});

describe("加载器版本", () => {
  it("推荐最新的稳定版；全是测试版时取最新的；空列表为 null", () => {
    expect(
      recommendedLoaderVersion([
        { version: "0.17.0-beta.2", stable: false },
        { version: "0.16.10", stable: true },
        { version: "0.16.9", stable: true },
      ]),
    ).toBe("0.16.10");
    expect(recommendedLoaderVersion([{ version: "0.27.2-beta.1", stable: false }])).toBe("0.27.2-beta.1");
    expect(recommendedLoaderVersion([])).toBeNull();
  });

  it("明确选过的版本只对当时的加载器与游戏版本有效，换了任一个回到推荐版", () => {
    const list = [
      { version: "0.16.10", stable: true },
      { version: "0.16.9", stable: true },
    ];
    const pick = { loader: "fabric" as const, mcVersion: "1.21.1", version: "0.16.9" };
    expect(effectiveLoaderVersion("fabric", "1.21.1", pick, list)).toBe("0.16.9");
    expect(effectiveLoaderVersion("fabric", "1.20.1", pick, list)).toBe("0.16.10");
    expect(effectiveLoaderVersion("quilt", "1.21.1", pick, list)).toBe("0.16.10");
    expect(effectiveLoaderVersion("fabric", "1.21.1", null, undefined)).toBeNull();
    expect(effectiveLoaderVersion("vanilla", "1.21.1", pick, list)).toBeNull();
  });
});

describe("确认与关闭", () => {
  it("存放位置的分隔符跟随游戏目录的写法，去掉末尾多余的分隔符", () => {
    expect(instancePath("C:\\Users\\me\\.minecraft", "周末生存")).toBe("C:\\Users\\me\\.minecraft\\versions\\周末生存");
    expect(instancePath("C:\\Games\\", "a")).toBe("C:\\Games\\versions\\a");
    expect(instancePath("D:/Games/.minecraft", "a")).toBe("D:/Games/.minecraft/versions/a");
  });

  it("填过几项：名称、改过的版本、加载器、改过的加载器版本、改过的封面各算一项", () => {
    const base = { name: "", versionChanged: false, loader: "vanilla" as const, loaderVersionChanged: false, coverChanged: false };
    expect(filledCount(base)).toBe(0);
    expect(filledCount({ ...base, name: "周末生存" })).toBe(1);
    expect(filledCount({ ...base, name: "周末生存", coverChanged: true })).toBe(2);
    expect(filledCount({ name: "a", versionChanged: true, loader: "fabric", loaderVersionChanged: true, coverChanged: true })).toBe(5);
  });
});

function runtime(path: string, major: number, vendor: string): JavaInstallationDto {
  return { path, version: { major, minor: 0, security: 1, build: 0, raw: `${major}.0.1` }, is_64bit: true, vendor, source: "registry" };
}

describe("确认步的 Java", () => {
  const jdk21 = runtime("C:/jdk-21/bin/java.exe", 21, "Eclipse Adoptium");
  const jre8 = runtime("C:/jre-8/bin/java.exe", 8, "Oracle Corporation");
  const all = [jdk21, jre8];

  it("自动选择：本机有要求的主版本算已安装，没有就要下载", () => {
    expect(confirmJava(21, all, "auto")).toEqual({ kind: "installed", major: 21, vendor: "Eclipse Adoptium" });
    expect(confirmJava(17, all, "auto")).toEqual({ kind: "download", major: 17 });
    expect(confirmJava(17, [], "auto")).toEqual({ kind: "download", major: 17 });
  });

  it("全局固定了默认 Java：只看固定的那一个，本机另有匹配的也不算数", () => {
    expect(confirmJava(21, all, jre8.path)).toEqual({ kind: "pinnedMismatch", pinned: 8, required: 21, requiredInstalled: true });
    expect(confirmJava(8, all, jdk21.path)).toEqual({ kind: "pinnedMismatch", pinned: 21, required: 8, requiredInstalled: true });
    expect(confirmJava(17, all, jdk21.path)).toEqual({ kind: "pinnedMismatch", pinned: 21, required: 17, requiredInstalled: false });
    // 主版本相等算已安装，发行方写固定的那个，不是本机第一个同主版本的
    const zulu21 = runtime("D:/zulu-21/bin/java.exe", 21, "Azul Systems");
    expect(confirmJava(21, [jdk21, zulu21], zulu21.path)).toEqual({ kind: "installed", major: 21, vendor: "Azul Systems" });
  });

  it("固定的路径不在扫描结果里：启动会失败，不当作已安装", () => {
    expect(confirmJava(21, all, "E:/gone/bin/java.exe")).toEqual({ kind: "pinnedMissing", required: 21, requiredInstalled: true });
    expect(confirmJava(21, [], "E:/gone/bin/java.exe")).toEqual({ kind: "pinnedMissing", required: 21, requiredInstalled: false });
  });
});

describe("文案", () => {
  it("十六块封面都有中文名，白名单外的 id 抛错", () => {
    expect(coverLabel("cherry_planks")).toBe("樱花木板");
    expect(coverLabel("end_stone_bricks")).toBe("末地石砖");
    expect(() => coverLabel("stone")).toThrow(/没有配中文名/);
  });

  it("加载器缺失注记与步骤副标题", () => {
    expect(CREATE_COPY.loader.missing("26.2", ["forge"])).toBe("26.2 没有 Forge 可用，换个游戏版本就能看到。");
    expect(CREATE_COPY.loader.missing("1.5.2", ["fabric", "quilt"])).toBe("1.5.2 没有 Fabric、Quilt 可用，换个游戏版本就能看到。");
    expect(CREATE_COPY.subtitle(2, 6, "version")).toBe("第 2 步，共 6 步 · 游戏版本");
    expect(CREATE_COPY.loaderVersion.title("neoforge")).toBe("选择 NeoForge 版本");
  });
});
