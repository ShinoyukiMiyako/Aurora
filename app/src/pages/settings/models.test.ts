import { describe, expect, it } from "vitest";
import { instanceFromDto } from "../../domain/adapt";
import { runtimeComplete } from "../../domain/rules";
import type { GpuAdapterDto, JavaInstallationDto } from "../../state/queries/catalog";
import { instanceDto } from "../../test/launcher";
import { overAvailable, unrecorded } from "./game-model";
import {
  defaultDownloadMajor,
  gpuSummary,
  hasManaged,
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

describe("下载运行时的默认主版本", () => {
  const need = (...majors: (number | null)[]) => majors.map((major, i) => instance(`实例 ${i}`, major));
  const have = (...majors: number[]) => majors.map((major) => runtime(`C:/jdk-${major}/bin/java.exe`, major));

  it("缺一个：选缺的那个，哪怕更高的主版本已经装了", () => {
    expect(defaultDownloadMajor(need(21, 17), have(21))).toBe(17);
  });

  it("缺多个：选缺的里最高的，而不是实例要求里最高的", () => {
    expect(defaultDownloadMajor(need(25, 21, 17, 8), have(25, 21))).toBe(17);
    expect(defaultDownloadMajor(need(8, 17, 21), [])).toBe(21);
  });

  it("都不缺：实例要求里最高的", () => {
    expect(defaultDownloadMajor(need(21, 17, 8), have(21, 17, 8))).toBe(21);
  });

  it("本机多装的、没有实例要的主版本不算数", () => {
    expect(defaultDownloadMajor(need(21, 17), have(25, 21))).toBe(17);
    expect(defaultDownloadMajor(need(17), have(25, 21, 17))).toBe(17);
  });

  it("只有不完整的运行时算缺：重新下载就是修复", () => {
    const broken = runtime("C:/jdk-17/bin/java.exe", 17, { missing_files: ["lib/modules"] });
    expect(defaultDownloadMajor(need(21, 17), [...have(21), broken])).toBe(17);
  });

  it("同一主版本有完整的就不缺，不完整的那份不影响判断", () => {
    const broken = runtime("D:/jdk-17/bin/java.exe", 17, { missing_files: ["release"] });
    expect(defaultDownloadMajor(need(21, 17), [...have(21, 17), broken])).toBe(21);
  });

  it("没有实例要求时为 null；认不出版本的实例不计", () => {
    expect(defaultDownloadMajor([], have(21))).toBeNull();
    expect(defaultDownloadMajor(need(null), [])).toBeNull();
    expect(defaultDownloadMajor(need(null, 17), have(21))).toBe(17);
  });

  it("一次成功的扫描都还没有：按都不缺算，取实例要求里最高的", () => {
    expect(defaultDownloadMajor(need(17, 21), undefined)).toBe(21);
    expect(defaultDownloadMajor([], undefined)).toBeNull();
  });

  it("随机的需求与安装组合：结果与实例顺序、重复无关", () => {
    const pool = [8, 11, 16, 17, 21, 25];
    const subset = () => pool.filter(() => Math.random() < 0.5);
    for (let round = 0; round < 200; round++) {
      const needed = subset();
      const installed = subset();
      const missing = needed.filter((major) => !installed.includes(major));
      const expected = missing.length > 0 ? Math.max(...missing) : needed.length > 0 ? Math.max(...needed) : null;
      const shuffled = [...needed, ...needed].sort(() => Math.random() - 0.5);
      expect(defaultDownloadMajor(need(...shuffled), have(...installed))).toBe(expected);
    }
  });
});

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
    expect(javaNotes("auto", all.slice(0, 2), instances, false)).toEqual([{ kind: "missing", majors: [8], remedy: "manual" }]);
    // 固定的路径已不在探测结果里：换成带路径的「找不到」提醒，通用的「固定」提醒不再出现，也不臆测位数
    expect(javaNotes("D:/gone/java.exe", all, instances, true)).toEqual([{ kind: "pinnedMissing", path: "D:/gone/java.exe" }]);
    expect(selectedRuntime("D:/gone/java.exe", all)).toBeNull();
    expect(selectedRuntime("auto", all)).toBeNull();
  });

  it("固定的默认 Java 找不到时与缺版本提醒并存；一个运行时都没扫到也照样报出路径", () => {
    const gone = "E:\\portable\\jdk-17\\bin\\java.exe";
    const all = [runtime("C:/jdk25/java.exe", 25), runtime("C:/jdk21/java.exe", 21)];
    expect(javaNotes(gone, all, instances, false)).toEqual([
      { kind: "pinnedMissing", path: gone },
      { kind: "missing", majors: [8], remedy: "pinned" },
    ]);
    expect(javaNotes(gone, [], [], true)).toEqual([{ kind: "pinnedMissing", path: gone }]);
  });

  it("固定的路径与扫描结果只差大小写或分隔符：Windows 上是同一个文件，不报找不到，也不把它当不完整的外人", () => {
    const jdk = runtime("C:\\Program Files\\Java\\JDK-21\\bin\\java.exe", 21, { missing_files: ["release"] });
    const pinned = "c:/program files/java/jdk-21/bin/java.exe";
    expect(selectedRuntime(pinned, [jdk])).toBe(jdk);
    expect(javaNotes(pinned, [jdk], [], true)).toEqual([{ kind: "pinned" }]);
    expect(selectableAsDefault(jdk, pinned)).toBe(true);
  });

  it("提醒按后果从重到轻排：固定的提醒在前，缺版本次之，32 位最后；自动选择下只可能有缺版本这一条", () => {
    const x86 = runtime("C:/x86/java.exe", 8, { is_64bit: false });
    expect(javaNotes(x86.path, [x86], instances, true)).toEqual([{ kind: "pinned" }, { kind: "missing", majors: [25, 21], remedy: "pinned" }, { kind: "bits32" }]);
    expect(javaNotes("auto", [x86], instances, true)).toEqual([{ kind: "missing", majors: [25, 21], remedy: "auto" }]);
  });

  it("固定了默认 Java 时缺版本不再指望自动下载：启动一律按固定路径走，开着自动下载也不会下", () => {
    const jdk21 = runtime("C:/jdk21/java.exe", 21);
    for (const autoDownload of [true, false]) {
      expect(javaNotes(jdk21.path, [jdk21], instances, autoDownload)).toEqual([{ kind: "pinned" }, { kind: "missing", majors: [25, 8], remedy: "pinned" }]);
    }
  });

  it("托管运行时只认 managed 来源", () => {
    const list = [runtime("a", 21), runtime("b", 17, { source: "managed" })];
    expect(hasManaged(list, 21)).toBe(false);
    expect(hasManaged(list, 17)).toBe(true);
  });

  it("不完整的运行时：不算已有的主版本、不算装了托管的，只有当前默认值才能留在可选里", () => {
    const broken = runtime("C:/rt/21/bin/java.exe", 21, { source: "managed", missing_files: ["release", "lib/modules"] });
    const complete = runtime("C:/jdk8/bin/java.exe", 8);
    expect(runtimeComplete(broken)).toBe(false);
    expect(runtimeComplete(complete)).toBe(true);
    expect(missingMajors(instances, [broken, complete])).toEqual([25, 21]);
    expect(javaNotes("auto", [broken, complete], instances, true)).toEqual([{ kind: "missing", majors: [25, 21], remedy: "auto" }]);
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
  it("未登记的探测结果去掉当前目录与已登记的目录", () => {
    const discovered = [
      { name: "当前", path: "D:/Games/.minecraft" },
      { name: "PCL", path: "E:\\PCL\\.minecraft" },
      { name: "官方", path: "C:/Users/me/AppData/Roaming/.minecraft" },
    ];
    const known = [{ name: "PCL", path: "e:/pcl/.minecraft", is_current: false, available: true, version_count: 3 }];
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
