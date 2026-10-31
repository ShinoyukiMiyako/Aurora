import { describe, expect, it } from "vitest";
import { instanceFromDto } from "../../domain/adapt";
import type { GpuAdapterDto, JavaInstallationDto } from "../../state/queries/catalog";
import { instanceDto } from "../../test/launcher";
import { dirName, hasBang, normalizePath, overAvailable, samePath, unrecorded } from "./game-model";
import {
  gpuSummary,
  hasManaged,
  isComplete,
  javaNotes,
  joinMajors,
  majorsInUse,
  manualJavas,
  missingMajors,
  scanDiff,
  selectableAsDefault,
  selectedRuntime,
  sortRuntimes,
} from "./java-model";

function runtime(path: string, major: number, overrides: Partial<JavaInstallationDto> = {}): JavaInstallationDto {
  return {
    path,
    version: { major, minor: 0, security: 0, build: 0, raw: `${major}.0.0` },
    is_64bit: true,
    vendor: "Eclipse Adoptium",
    source: "registry",
    missing_files: [],
    ...overrides,
  };
}

function instance(id: string, javaMajor: number | null) {
  return instanceFromDto(instanceDto(id, { java_major: javaMajor }), { pins: [], busyTaskInstanceIds: new Set() });
}

describe("Java 分区推导", () => {
  const instances = [instance("生存", 21), instance("老版本", 8), instance("新快照", 25), instance("同版本", 21), instance("认不出", null)];

  it("实例用到的主版本去重降序，认不出版本的实例不计", () => {
    expect(majorsInUse(instances)).toEqual([25, 21, 8]);
    expect(majorsInUse([])).toEqual([]);
  });

  it("本机缺的主版本：有实例要、一个运行时都没有", () => {
    expect(missingMajors(instances, [runtime("C:/jdk21/bin/java.exe", 21)])).toEqual([25, 8]);
    expect(missingMajors(instances, [runtime("a", 25), runtime("b", 21), runtime("c", 8)])).toEqual([]);
    expect(joinMajors([25, 8])).toBe("Java 25、Java 8");
  });

  it("运行时排序：主版本、小版本、补丁号降序，最后按路径", () => {
    const list = [
      runtime("z", 17),
      runtime("b", 21, { version: { major: 21, minor: 0, security: 3, build: 0, raw: "21.0.3" } }),
      runtime("a", 21, { version: { major: 21, minor: 0, security: 3, build: 0, raw: "21.0.3" } }),
      runtime("c", 21, { version: { major: 21, minor: 0, security: 7, build: 0, raw: "21.0.7" } }),
    ];
    expect(sortRuntimes(list).map((r) => r.path)).toEqual(["c", "a", "b", "z"]);
  });

  it("默认 Java 的提醒按条件出现：固定、缺版本（分自动下载开关）、32 位", () => {
    const x86 = runtime("C:/x86/java.exe", 8, { is_64bit: false });
    const all = [runtime("C:/jdk25/java.exe", 25), runtime("C:/jdk21/java.exe", 21), x86];
    expect(javaNotes("auto", all, instances, true)).toEqual([]);
    expect(javaNotes("C:/x86/java.exe", all, instances, true)).toEqual([{ kind: "pinned" }, { kind: "bits32" }]);
    expect(javaNotes("auto", all.slice(0, 2), instances, false)).toEqual([{ kind: "missing", majors: [8], autoDownload: false }]);
    // 固定的路径已不在探测结果里：只有「固定」提醒，不臆测位数
    expect(javaNotes("D:/gone/java.exe", all, instances, true)).toEqual([{ kind: "pinned" }]);
    expect(selectedRuntime("D:/gone/java.exe", all)).toBeNull();
    expect(selectedRuntime("auto", all)).toBeNull();
  });

  it("托管运行时只认 managed 来源", () => {
    const list = [runtime("a", 21), runtime("b", 17, { source: "managed" })];
    expect(hasManaged(list, 21)).toBe(false);
    expect(hasManaged(list, 17)).toBe(true);
  });

  it("不完整的运行时：不算已有的主版本、不算装了托管的，只有当前默认值才能留在可选里", () => {
    const broken = runtime("C:/rt/21/bin/java.exe", 21, { source: "managed", missing_files: ["release", "lib/modules"] });
    const complete = runtime("C:/jdk8/bin/java.exe", 8);
    expect(isComplete(broken)).toBe(false);
    expect(isComplete(complete)).toBe(true);
    expect(missingMajors(instances, [broken, complete])).toEqual([25, 21]);
    expect(javaNotes("auto", [broken, complete], instances, true)).toEqual([{ kind: "missing", majors: [25, 21], autoDownload: true }]);
    expect(hasManaged([broken], 21)).toBe(false);
    expect(selectableAsDefault(broken, "auto")).toBe(false);
    expect(selectableAsDefault(broken, broken.path)).toBe(true);
    expect(selectableAsDefault(complete, "auto")).toBe(true);
  });

  it("手动添加的记录按路径不分大小写配上探测结果，配不上的识别不出", () => {
    const found = runtime("D:\\Java\\JDK-17\\bin\\java.exe", 17, { source: "manual" });
    const managed = runtime("D:\\Games\\runtime\\21\\bin\\java.exe", 21, { source: "managed" });
    const entries = manualJavas(["d:\\java\\jdk-17\\bin\\java.exe", "E:\\gone\\bin\\java.exe", "D:\\Games\\runtime\\21\\bin\\java.exe"], [found, managed]);
    expect(entries).toEqual([
      { path: "d:\\java\\jdk-17\\bin\\java.exe", runtime: found },
      { path: "E:\\gone\\bin\\java.exe", runtime: null },
      { path: "D:\\Games\\runtime\\21\\bin\\java.exe", runtime: managed },
    ]);
    expect(manualJavas([], [found])).toEqual([]);
  });

  it("重新扫描的差异按路径比较", () => {
    expect(scanDiff([runtime("a", 8), runtime("b", 17)], [runtime("b", 17), runtime("c", 21), runtime("d", 25)])).toEqual({ added: 2, removed: 1 });
    expect(scanDiff([runtime("a", 8)], [runtime("a", 8)])).toEqual({ added: 0, removed: 0 });
  });
});

describe("显卡说明", () => {
  function adapter(name: string, over: Partial<GpuAdapterDto> = {}): GpuAdapterDto {
    return { name, vendor_id: 0x10de, dedicated_video_memory_mb: 8192, high_performance: false, power_saving: false, ...over };
  }

  it("可切换时取高性能与省电偏好各自的首选", () => {
    const dgpu = adapter("RTX 4060", { high_performance: true });
    const igpu = adapter("UHD 770", { vendor_id: 0x8086, power_saving: true });
    expect(gpuSummary({ adapters: [dgpu, igpu], switchable: true })).toEqual({ kind: "switchable", highPerformance: dgpu, powerSaving: igpu });
  });

  it("只有一块是 single；没有显卡或几块都挑同一块时说不出会换到哪块", () => {
    const only = adapter("RX 7800 XT", { high_performance: true, power_saving: true });
    expect(gpuSummary({ adapters: [only], switchable: false })).toEqual({ kind: "single", adapter: only });
    expect(gpuSummary({ adapters: [], switchable: false })).toEqual({ kind: "other" });
    expect(gpuSummary({ adapters: [only, adapter("RTX A2000")], switchable: false })).toEqual({ kind: "other" });
  });

  it("标了可切换却缺首选时直接报错，不编一个名字", () => {
    expect(() => gpuSummary({ adapters: [adapter("A", { high_performance: true }), adapter("B")], switchable: true })).toThrow("显卡信息自相矛盾");
  });
});

describe("游戏目录推导", () => {
  it("「!」会被拒绝", () => {
    expect(hasBang("D:/Games/Hi!/.minecraft")).toBe(true);
    expect(hasBang("D:/Games/.minecraft")).toBe(false);
  });

  it("路径比较：统一分隔符与末尾斜杠，Windows 盘符路径不分大小写，其余区分", () => {
    expect(normalizePath("D:\\Games\\.minecraft\\")).toBe("d:/games/.minecraft");
    expect(samePath("D:\\Games\\.minecraft", "d:/games/.minecraft/")).toBe(true);
    expect(samePath("/home/a/.minecraft", "/home/A/.minecraft")).toBe(false);
  });

  it("显示名取最后一段，.minecraft 取上一级；空路径抛错", () => {
    expect(dirName("D:\\Games\\PCL\\.minecraft\\")).toBe("PCL");
    expect(dirName("D:\\Games\\Modded")).toBe("Modded");
    expect(dirName("E:/.minecraft")).toBe("E:");
    expect(dirName("E:/")).toBe("E:");
    expect(() => dirName("  ")).toThrow("没有可显示的名称");
  });

  it("未登记的探测结果去掉当前目录与已登记的目录", () => {
    const discovered = [
      { name: "当前", path: "D:/Games/.minecraft" },
      { name: "PCL", path: "E:\\PCL\\.minecraft" },
      { name: "官方", path: "C:/Users/me/AppData/Roaming/.minecraft" },
    ];
    const known = [{ name: "PCL", path: "e:/pcl/.minecraft", is_current: false, available: true }];
    expect(unrecorded(discovered, known, "d:\\games\\.minecraft")).toEqual([discovered[2]]);
  });

  it("超出空闲内存的提醒只在没进入「超过物理内存一半」警示区时出现", () => {
    // 16 GB 物理内存、6 GB 空闲
    expect(overAvailable(6144, 6144, 16384)).toBe(false);
    expect(overAvailable(6656, 6144, 16384)).toBe(true);
    expect(overAvailable(8192, 6144, 16384)).toBe(true);
    expect(overAvailable(8704, 6144, 16384)).toBe(false);
  });
});
