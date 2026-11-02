import { describe, expect, it } from "vitest";
import type { MemoryAdviceDto, MemoryNeedFactor } from "../ipc/system";
import type { InstanceSummary } from "./adapt";
import { memoryBasis } from "./memory";

type Inst = Pick<InstanceSummary, "loader" | "extraLoaders" | "mcVersion">;

const inst = (loader: Inst["loader"], mcVersion: string | null, extra: readonly ("optifine" | "liteloader")[] = []): Inst => ({
  loader,
  mcVersion,
  extraLoaders: extra.map((kind) => ({ kind, version: null })),
});

// 组成项的数值照后端的折算写（基数 2560 / 3072 / 2765，每 50 个 Mod 折 1024 MB，视距按多出的区块数），需求向上对齐到 512
const VANILLA: MemoryNeedFactor = { kind: "base", loader: "vanilla", mb: 2560 };
const OPTIFINE: MemoryNeedFactor = { kind: "base", loader: "optifine", mb: 3072 };
const MODDED: MemoryNeedFactor = { kind: "base", loader: "modded", mb: 2765 };

/** 建议值 = min(需求, 上限)，与后端同一口径。 */
function advice(factors: MemoryNeedFactor[], needMb: number, limit: MemoryAdviceDto["limit"] = { mb: 8192, reason: "half_physical" }): MemoryAdviceDto {
  return { total_mb: 16384, available_mb: 9000, version_id: "整合包A", need_mb: needMb, limit, recommended_mb: Math.min(needMb, limit.mb), factors };
}

describe("内存估算依据", () => {
  it("Forge 1.20.1、120 个 Mod、视距 16：加载器与版本打头，组成项按顺序跟上", () => {
    const basis = memoryBasis(
      advice(
        [
          MODDED,
          { kind: "mods", count: 120, mb: 2457 },
          { kind: "render_distance", distance: 16, mb: 46 },
        ],
        5632,
      ),
      inst("forge", "1.20.1"),
    );
    expect(basis).toEqual({
      parts: ["Forge 1.20.1", "120 个 Mod", "视距 16"],
      summary: "Forge 1.20.1 · 120 个 Mod · 视距 16，建议 5.5 GB",
      cap: null,
      sentence: "Forge 1.20.1 · 120 个 Mod · 视距 16，建议 5.5 GB",
    });
  });

  it("原版只有加载器与版本一片", () => {
    expect(memoryBasis(advice([VANILLA], 2560), inst("vanilla", "1.21.1")).sentence).toBe("原版 1.21.1，建议 2.5 GB");
  });

  it("只装 OptiFine 写 OptiFine；叠在 Forge 上时写 Forge；有 LiteLoader 时写 LiteLoader", () => {
    const noMods: MemoryNeedFactor = { kind: "mods", count: 0, mb: 0 };
    expect(memoryBasis(advice([OPTIFINE], 3072), inst("vanilla", "1.20.1", ["optifine"])).sentence).toBe("OptiFine 1.20.1，建议 3 GB");
    expect(memoryBasis(advice([MODDED, noMods], 3072), inst("forge", "1.20.1", ["optifine"])).sentence).toBe("Forge 1.20.1，建议 3 GB");
    expect(memoryBasis(advice([MODDED, noMods], 3072), inst("vanilla", "1.12.2", ["optifine", "liteloader"])).sentence).toBe("LiteLoader 1.12.2，建议 3 GB");
  });

  it("整合包写了推荐值：替代基数与 Mod 数，写成「整合包推荐」", () => {
    const basis = memoryBasis(
      advice(
        [
          { kind: "modpack", mb: 8192 },
          { kind: "render_distance", distance: 16, mb: 46 },
        ],
        8704,
        { mb: 16384, reason: "half_physical" },
      ),
      inst("neoforge", "1.21.1"),
    );
    expect(basis.parts).toEqual(["NeoForge 1.21.1", "整合包推荐 8 GB", "视距 16"]);
    expect(basis.sentence).toBe("NeoForge 1.21.1 · 整合包推荐 8 GB · 视距 16，建议 8.5 GB");
  });

  it("检测到 Distant Horizons 排在视距之后", () => {
    const basis = memoryBasis(
      advice(
        [
          MODDED,
          { kind: "mods", count: 40, mb: 819 },
          { kind: "render_distance", distance: 32, mb: 360 },
          { kind: "distant_horizons", floor_mb: 6144 },
        ],
        6144,
      ),
      inst("fabric", "1.21.1"),
    );
    expect(basis.sentence).toBe("Fabric 1.21.1 · 40 个 Mod · 视距 32 · Distant Horizons，建议 6 GB");
  });

  it("被物理内存的一半封顶：建议值是上限，整句补上需要多少与上限的来由", () => {
    const basis = memoryBasis(advice([MODDED, { kind: "mods", count: 1100, mb: 10437 }], 13312), inst("neoforge", "1.21.1"));
    expect(basis).toEqual({
      parts: ["NeoForge 1.21.1", "1100 个 Mod"],
      summary: "NeoForge 1.21.1 · 1100 个 Mod，建议 8 GB",
      cap: "需要 13 GB，本机最多给 8 GB（物理内存的一半）",
      sentence: "NeoForge 1.21.1 · 1100 个 Mod，建议 8 GB。需要 13 GB，本机最多给 8 GB（物理内存的一半）",
    });
  });

  it("被 32 位 Java 封顶：括号里写 32 位 Java 的上限", () => {
    const basis = memoryBasis(advice([VANILLA], 2560, { mb: 1024, reason: "java_32bit" }), inst("vanilla", "1.12.2"));
    expect(basis.cap).toBe("需要 2.5 GB，本机最多给 1 GB（32 位 Java 的上限）");
    expect(basis.sentence).toBe("原版 1.12.2，建议 1 GB。需要 2.5 GB，本机最多给 1 GB（32 位 Java 的上限）");
  });

  it("需求正好等于上限不算封顶", () => {
    const basis = memoryBasis(advice([MODDED, { kind: "mods", count: 265, mb: 5427 }], 8192), inst("forge", "1.20.1"));
    expect(basis.cap).toBeNull();
    expect(basis.sentence).toBe("Forge 1.20.1 · 265 个 Mod，建议 8 GB");
  });

  it("启用的 Mod 为 0 个时省略这一片，不写「0 个 Mod」", () => {
    const basis = memoryBasis(advice([MODDED, { kind: "mods", count: 0, mb: 0 }], 3072), inst("quilt", "1.20.4"));
    expect(basis.parts).toEqual(["Quilt 1.20.4"]);
    expect(basis.sentence).toBe("Quilt 1.20.4，建议 3 GB");
  });

  it("版本读不出来时只写加载器名，不编版本号", () => {
    expect(memoryBasis(advice([MODDED, { kind: "mods", count: 1, mb: 20 }], 3072), inst("forge", null)).sentence).toBe("Forge · 1 个 Mod，建议 3 GB");
  });

  describe("实例摘要拿不到", () => {
    it("原版与只装 OptiFine 能从基数项看出来，照写但不带版本", () => {
      expect(memoryBasis({ ...advice([VANILLA], 2560), version_id: null }, null).sentence).toBe("原版，建议 2.5 GB");
      expect(memoryBasis(advice([OPTIFINE], 3072), null).sentence).toBe("OptiFine，建议 3 GB");
    });

    it("装的哪个加载器看不出来：不写加载器，从 Mod 数写起", () => {
      const basis = memoryBasis(advice([MODDED, { kind: "mods", count: 120, mb: 2457 }], 5632), null);
      expect(basis.parts).toEqual(["120 个 Mod"]);
      expect(basis.sentence).toBe("120 个 Mod，建议 5.5 GB");
    });

    it("整合包推荐值替代了基数项：同样不写加载器", () => {
      expect(memoryBasis(advice([{ kind: "modpack", mb: 6144 }], 6144), null).sentence).toBe("整合包推荐 6 GB，建议 6 GB");
    });

    it("一片都写不出来时只说建议值，被封顶照样补上原因", () => {
      const factors: MemoryNeedFactor[] = [MODDED, { kind: "mods", count: 0, mb: 0 }];
      expect(memoryBasis(advice(factors, 3072), null)).toEqual({ parts: [], summary: "建议 3 GB", cap: null, sentence: "建议 3 GB" });
      expect(memoryBasis(advice(factors, 3072, { mb: 1024, reason: "java_32bit" }), null).sentence).toBe("建议 1 GB。需要 3 GB，本机最多给 1 GB（32 位 Java 的上限）");
    });
  });

  it("随机的 Mod 数与视距原样写进片段", () => {
    const count = 1 + Math.floor(Math.random() * 265);
    const distance = 13 + Math.floor(Math.random() * 20);
    const basis = memoryBasis(
      advice(
        [
          MODDED,
          { kind: "mods", count, mb: Math.floor((count * 1024) / 50) },
          { kind: "render_distance", distance, mb: Math.floor(((2 * distance + 1) ** 2 - 625) / 10) },
        ],
        9216,
        { mb: 16384, reason: "half_physical" },
      ),
      inst("fabric", "1.21.4"),
    );
    expect(basis.sentence, `count=${count} distance=${distance}`).toBe(`Fabric 1.21.4 · ${count} 个 Mod · 视距 ${distance}，建议 9 GB`);
  });
});
