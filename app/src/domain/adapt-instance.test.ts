import { describe, expect, it } from "vitest";
import type { IncompleteDto, InstanceDto } from "../ipc/instances";
import { instanceFromDto } from "./adapt";

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
    mod_count: 0,
    description: null,
    cover: null,
    settings_error: null,
    incomplete: null,
    created_at: 1_700_000_000_000,
    activity: null,
    playtime_min: 0,
    last_played_at: null,
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

  it("未知加载器与未知版本类型抛错；old_alpha 归为 old", () => {
    expect(() => instanceFromDto(instanceDto("X", { loaders: [{ kind: "rift" as never, version: null }] }), idle)).toThrow("未知的加载器：rift");
    expect(() => instanceFromDto(instanceDto("X", { release_type: "pending" }), idle)).toThrow("未知的版本类型：pending");
    expect(instanceFromDto(instanceDto("Alpha", { release_type: "old_alpha" }), idle).releaseType).toBe("old");
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
      expect(inst).toMatchObject({ status: "broken", brokenReason: "整合包没有导入完，请删掉这个实例后重新导入" });
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
});
