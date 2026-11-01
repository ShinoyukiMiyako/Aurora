import { describe, expect, it } from "vitest";
import type { IncompleteDto, InstanceDto } from "../ipc/instances";
import { instanceFromDto, knownReleaseType } from "./adapt";

function instanceDto(id: string, overrides: Partial<InstanceDto> = {}): InstanceDto {
  return {
    id,
    status: "ready",
    broken_reason: null,
    mc_version: "1.21.1",
    loaders: [],
    release_type: "release",
    is_release: true,
    java_major: 21,
    quick_play: { singleplayer: true, multiplayer: true },
    mod_count: 0,
    world_count: 0,
    isolated: false,
    description: null,
    cover: null,
    memory_mb: null,
    settings_error: null,
    modpack: null,
    modpack_error: null,
    last_crash_at: null,
    last_crash_error: null,
    incomplete: null,
    created_at: 1_700_000_000_000,
    activity: null,
    used_by: null,
    playtime_min: 0,
    last_played_at: null,
    play_error: null,
    dir_error: null,
    ...overrides,
  };
}

const idle = { pins: [] as string[], busyTaskInstanceIds: new Set<string>() };

const incomplete = (overrides: Partial<IncompleteDto>): IncompleteDto => ({
  kind: "install",
  outcome: "failed",
  started_at: 1_700_000_000_000,
  spec: { mc_version: "1.20.1", loader: "forge", loader_version: "47.3.0" },
  error: { code: "network_failed", message: "连接超时" },
  ...overrides,
});

describe("实例 DTO 适配：加载器", () => {
  it("主加载器按 NeoForge > Forge > Fabric > Quilt 取第一个，OptiFine 与 LiteLoader 只作附加标签", () => {
    const loaders: InstanceDto["loaders"] = [
      { kind: "optifine", version: "HD_U_I6" },
      { kind: "fabric", version: "0.16.5" },
      { kind: "forge", version: "47.3.0" },
      { kind: "liteloader", version: null },
    ];
    const inst = instanceFromDto(instanceDto("Pack", { loaders }), idle);
    expect(inst.loader).toBe("forge");
    expect(inst.loaderVersion).toBe("47.3.0");
    expect(inst.extraLoaders).toEqual([
      { kind: "optifine", version: "HD_U_I6" },
      { kind: "liteloader", version: null },
    ]);
  });

  it("只有附加加载器时按原版算", () => {
    const inst = instanceFromDto(instanceDto("OF", { loaders: [{ kind: "optifine", version: "HD_U_J1" }] }), idle);
    expect(inst.loader).toBe("vanilla");
    expect(inst.loaderVersion).toBeNull();
  });

  it("未知加载器抛错；old_alpha 归为 old", () => {
    expect(() => instanceFromDto(instanceDto("X", { loaders: [{ kind: "rift" as never, version: null }] }), idle)).toThrow("未知的加载器：rift");
    expect(instanceFromDto(instanceDto("Alpha", { release_type: "old_alpha" }), idle).releaseType).toBe("old");
  });

  it("已装实例的版本类型来自它自己的 JSON，认不出时当不知道，其余字段照常；版本清单仍按契约抛错", () => {
    const inst = instanceFromDto(instanceDto("别的启动器装的", { release_type: "modified" }), idle);
    expect(inst).toMatchObject({ id: "别的启动器装的", status: "ready", releaseType: null, mcVersion: "1.21.1" });
    expect(knownReleaseType("pending")).toBeNull();
  });
});

describe("实例 DTO 适配：状态", () => {
  it("有排队或进行中的任务、或后端报告正在安装 / 修复时为安装中，即使目录里有未完成标记", () => {
    const marked = instanceDto("New", { incomplete: incomplete({ outcome: "pending", error: null }) });
    expect(instanceFromDto(marked, { pins: [], busyTaskInstanceIds: new Set(["New"]) })).toMatchObject({ status: "installing", brokenReason: null });
    expect(instanceFromDto(instanceDto("R", { activity: "repairing" }), idle).status).toBe("installing");
    expect(instanceFromDto(instanceDto("I", { activity: "installing" }), idle).status).toBe("installing");
  });

  it("后端报损坏时用它给的原因；没给原因时用未完成标记推出的原因；都没有抛错", () => {
    expect(instanceFromDto(instanceDto("B", { status: "broken", broken_reason: "版本 JSON 缺失" }), idle)).toMatchObject({ status: "broken", brokenReason: "版本 JSON 缺失" });
    const byMarker = instanceFromDto(instanceDto("C", { status: "broken", broken_reason: null, incomplete: incomplete({}) }), idle);
    expect(byMarker.brokenReason).toBe("安装没有完成：连接超时");
    expect(() => instanceFromDto(instanceDto("D", { status: "broken", broken_reason: null }), idle)).toThrow("实例 D 标为损坏却没有原因");
  });

  it("就绪但带未完成标记的按损坏处理（上次补全被取消）", () => {
    const inst = instanceFromDto(instanceDto("E", { incomplete: incomplete({ kind: "repair", outcome: "cancelled", error: null }) }), idle);
    expect(inst).toMatchObject({ status: "broken", brokenReason: "补全被取消，文件仍不完整" });
    expect(inst.incomplete).toMatchObject({ kind: "repair", outcome: "cancelled", spec: { mcVersion: "1.20.1", loader: "forge", loaderVersion: "47.3.0" } });
  });

  it("整合包导入中断的实例按损坏处理，原因指向删掉重新导入，不论结局是进行中还是失败", () => {
    for (const outcome of ["pending", "failed", "cancelled"] as const) {
      const inst = instanceFromDto(instanceDto("Pack", { incomplete: incomplete({ kind: "modpack", outcome, spec: null, error: null }) }), idle);
      expect(inst).toMatchObject({ status: "broken", brokenReason: "整合包没有导入完，删掉这个实例后重新导入" });
      expect(inst.incomplete).toMatchObject({ kind: "modpack", outcome, spec: null });
    }
    expect(() => instanceFromDto(instanceDto("X", { incomplete: incomplete({ kind: "rift" as never }) }), idle)).toThrow();
  });

  it("未知状态抛错", () => {
    expect(() => instanceFromDto(instanceDto("F", { status: "zombie" as InstanceDto["status"] }), idle)).toThrow("未知的实例状态：zombie");
  });

  it("固定与否由侧栏固定列表推出；名称就是 id；统计字段原样带过", () => {
    const inst = instanceFromDto(instanceDto("生存 1.21", { playtime_min: 754, last_played_at: 1_720_000_000_000, mod_count: 0 }), { pins: ["生存 1.21"], busyTaskInstanceIds: new Set() });
    expect(inst).toMatchObject({ id: "生存 1.21", name: "生存 1.21", pinned: true, playtimeMin: 754, lastPlayedAt: 1_720_000_000_000, modCount: 0, placeholder: false });
    expect(instanceFromDto(instanceDto("Other"), { pins: ["生存 1.21"], busyTaskInstanceIds: new Set() }).pinned).toBe(false);
  });

  it("存档数、隔离生效值、自定内存与最近崩溃原样带过，读不出的原因各自保留", () => {
    const inst = instanceFromDto(
      instanceDto("隔离", { world_count: 3, isolated: true, memory_mb: 6144, last_crash_at: 1_720_000_000_000, modpack_error: "整合包记录解析失败" }),
      idle,
    );
    expect(inst).toMatchObject({ worldCount: 3, isolated: true, memoryMb: 6144, lastCrashAt: 1_720_000_000_000, lastCrashError: null, modpack: null, modpackError: "整合包记录解析失败" });
    const unread = instanceFromDto(instanceDto("坏", { world_count: null, isolated: null, last_crash_error: "格式版本是 9" }), idle);
    expect(unread).toMatchObject({ worldCount: null, isolated: null, memoryMb: null, lastCrashAt: null, lastCrashError: "格式版本是 9" });
  });

  it("游玩记录读不出：时长为 null、原因带过；实例目录读不出的原因同样带过", () => {
    const unread = instanceFromDto(instanceDto("坏", { playtime_min: null, last_played_at: null, play_error: "解析 游玩记录 失败" }), idle);
    expect(unread).toMatchObject({ playtimeMin: null, lastPlayedAt: null, playError: "解析 游玩记录 失败", dirError: null });
    const dir = instanceFromDto(instanceDto("目录", { mod_count: null, world_count: null, isolated: null, dir_error: "文件 IO 失败: mods" }), idle);
    expect(dir).toMatchObject({ modCount: null, worldCount: null, isolated: null, dirError: "文件 IO 失败: mods", playtimeMin: 0, playError: null });
  });

  it("时长与读取错误对不上是契约破了：不让界面在 0 和读不到之间猜", () => {
    expect(() => instanceFromDto(instanceDto("X", { playtime_min: null }), idle)).toThrow("实例 X 的游玩时长与它的读取错误对不上");
    expect(() => instanceFromDto(instanceDto("Y", { playtime_min: 3, play_error: "坏了" }), idle)).toThrow("实例 Y 的游玩时长与它的读取错误对不上");
  });

  it("直达能力逐位带过：旧版只能加入服务器、读不出版本信息为 null", () => {
    expect(instanceFromDto(instanceDto("新版"), idle).quickPlay).toEqual({ singleplayer: true, multiplayer: true });
    expect(instanceFromDto(instanceDto("1.12.2", { quick_play: { singleplayer: false, multiplayer: true } }), idle).quickPlay).toEqual({ singleplayer: false, multiplayer: true });
    expect(instanceFromDto(instanceDto("1.5.2", { quick_play: { singleplayer: false, multiplayer: false } }), idle).quickPlay).toEqual({ singleplayer: false, multiplayer: false });
    expect(instanceFromDto(instanceDto("断链", { quick_play: null, java_major: null }), idle).quickPlay).toBeNull();
  });
});

describe("实例 DTO 适配：被当作基底", () => {
  it("正以它为基底的实例原样带过；它自己在运行时活动报运行，usedBy 仍在", () => {
    expect(instanceFromDto(instanceDto("1.20.1", { activity: "inherited", used_by: "FAB" }), idle)).toMatchObject({ activity: "inherited", usedBy: "FAB" });
    expect(instanceFromDto(instanceDto("1.20.1", { activity: "running", used_by: "FAB" }), idle)).toMatchObject({ activity: "running", usedBy: "FAB" });
    expect(instanceFromDto(instanceDto("1.20.1"), idle).usedBy).toBeNull();
  });

  it("报 inherited 却没说谁在用、说了谁在用却没有任何占用，都是契约破了，抛错", () => {
    expect(() => instanceFromDto(instanceDto("1.20.1", { activity: "inherited", used_by: null }), idle)).toThrow("实例 1.20.1 被当作基底占着，却没说是哪个实例在用");
    expect(() => instanceFromDto(instanceDto("1.20.1", { activity: null, used_by: "FAB" }), idle)).toThrow("实例 1.20.1 正被 FAB 使用，却没有报出占用");
  });
});

describe("实例 DTO 适配：整合包来源", () => {
  it("平台整合包带平台、工程与版本；本地文件导入的平台为 null", () => {
    const fromPlatform = instanceFromDto(
      instanceDto("FO", { modpack: { platform: "modrinth", project_id: "1KVo5zza", version_id: "abc123", name: "Fabulously Optimized", version: "6.4.0" } }),
      idle,
    );
    expect(fromPlatform.modpack).toEqual({ platform: "modrinth", projectId: "1KVo5zza", versionId: "abc123", name: "Fabulously Optimized", version: "6.4.0" });
    const fromFile = instanceFromDto(instanceDto("本地", { modpack: { platform: null, project_id: null, version_id: null, name: "私服整合包", version: null } }), idle);
    expect(fromFile.modpack).toEqual({ platform: null, projectId: null, versionId: null, name: "私服整合包", version: null });
  });

  it("未知平台抛错", () => {
    const dto = instanceDto("X", { modpack: { platform: "ftb" as never, project_id: "1", version_id: "2", name: "X", version: null } });
    expect(() => instanceFromDto(dto, idle)).toThrow("未知的整合包来源平台：ftb");
  });
});
