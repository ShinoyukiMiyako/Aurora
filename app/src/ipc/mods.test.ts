import { beforeEach, describe, expect, it, vi } from "vitest";
import { IpcError } from "./errors";
import { backupSize, listHistory, rollback, rollbackChecks } from "./history";
import { resetMocks } from "./mock";
import { clearMockEventListeners, subscribeMockEvent } from "./mock/events";
import { MOCK_MOD_INSTANCE, setMockModFileBusy } from "./mock/handlers/mods";
import { beginMockTask, endMockTask } from "./mock/handlers/tasks";
import {
  checkUpdates,
  isModFileBusy,
  listMods,
  listModVersions,
  matchInstances,
  planInstall,
  removeMod,
  setModEnabled,
  updateMod,
} from "./mods";
import { CORE_EVENT, cancelTask } from "./tasks";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

beforeEach(() => {
  resetMocks();
  clearMockEventListeners();
});

const failure = (p: Promise<unknown>): Promise<IpcError> => p.then(
  () => {
    throw new Error("期望失败却成功了");
  },
  (e: unknown) => e as IpcError,
);

describe("实例 Mod 列表", () => {
  it("按文件名排序，卷宗 join 出来源与图标，来源不明的为 null", async () => {
    const mods = await listMods(MOCK_MOD_INSTANCE);
    expect(mods.map((m) => m.file_name)).toEqual(["AANobbMI-0.5.3.jar", "P7dR8mSH-0.92.2.jar", "gvQqBUqZ-0.11.2.jar.disabled", "handmade-1.0.jar"]);
    const [sodium, fabricApi, lithium, handmade] = mods;
    expect(sodium.source).toEqual({
      platform: "modrinth",
      project_id: "AANobbMI",
      version_id: "sodium-053",
      version_number: "0.5.3",
      title: "Sodium",
      dependency_of: null,
    });
    expect(sodium.icon_url).toBe("https://cdn.modrinth.com/data/AANobbMI/icon.png");
    expect(fabricApi.source?.dependency_of).toBe("AANobbMI");
    // 禁用态按启用态名字与卷宗 join。
    expect(lithium.enabled).toBe(false);
    expect(lithium.source?.title).toBe("Lithium");
    expect(handmade.source).toBeNull();
    expect(handmade.icon_url).toBeNull();
    expect(handmade.metadata?.mod_id).toBe("handmade");
  });

  it("未安装的实例报 version_not_installed", async () => {
    const error = await failure(listMods("ghost"));
    expect(error).toMatchObject({ code: "version_not_installed", message: "本地未安装版本 ghost" });
  });

  it("启停改文件名并返回新路径；已是目标状态不动；文件不在如实报错", async () => {
    const path = await setModEnabled(MOCK_MOD_INSTANCE, "gvQqBUqZ-0.11.2.jar.disabled", true);
    expect(path.endsWith("/1.20.1-Fabric/mods/gvQqBUqZ-0.11.2.jar")).toBe(true);
    expect((await listMods(MOCK_MOD_INSTANCE))[2]).toMatchObject({ file_name: "gvQqBUqZ-0.11.2.jar", enabled: true });

    const same = await setModEnabled(MOCK_MOD_INSTANCE, "handmade-1.0.jar", true);
    expect(same.endsWith("/mods/handmade-1.0.jar")).toBe(true);
    expect((await listMods(MOCK_MOD_INSTANCE))[3].enabled).toBe(true);
    expect(await failure(setModEnabled(MOCK_MOD_INSTANCE, "ghost.jar", false))).toMatchObject({ code: "mod_platform_failed" });
  });
});

describe("移除", () => {
  it("删文件、摘卷宗、在历史末尾追加一条移除事件", async () => {
    const before = await listHistory(MOCK_MOD_INSTANCE);
    await removeMod(MOCK_MOD_INSTANCE, "AANobbMI-0.5.3.jar");

    const names = (await listMods(MOCK_MOD_INSTANCE)).map((m) => m.file_name);
    expect(names).not.toContain("AANobbMI-0.5.3.jar");
    expect(names).toHaveLength(3);
    const history = await listHistory(MOCK_MOD_INSTANCE);
    expect(history).toHaveLength(before.length + 1);
    expect(history[history.length - 1]).toMatchObject({ kind: "remove", files: ["AANobbMI-0.5.3.jar"] });
    expect((await rollbackChecks(MOCK_MOD_INSTANCE)).at(-1)).toEqual({
      event_id: history[history.length - 1].id,
      can_rollback: false,
      reason: "移除事件不支持回滚，文件已从磁盘删除",
    });
    // 卷宗条目已摘：同工程在落位矩阵里不再是「已安装」。
    const matrix = await matchInstances("modrinth", "AANobbMI", null);
    expect(matrix.find((m) => m.version_id === MOCK_MOD_INSTANCE)?.state).toBe("compatible");
  });

  it("空名报 invalid_argument，非模组文件名与不存在的文件报 io 且不记历史", async () => {
    expect(await failure(removeMod(MOCK_MOD_INSTANCE, " "))).toMatchObject({ code: "invalid_argument", message: "file_name 不能为空" });
    const notMod = await failure(removeMod(MOCK_MOD_INSTANCE, "config.toml"));
    expect(notMod.code).toBe("io");
    expect(notMod.detail).toEqual({ causes: ["config.toml 不是 mods 目录里的模组文件名"] });
    const gone = await failure(removeMod(MOCK_MOD_INSTANCE, "ghost.jar"));
    expect(gone.detail).toEqual({ causes: ["mods 目录里没有 ghost.jar，可能已被移除"] });
    expect(await listHistory(MOCK_MOD_INSTANCE)).toHaveLength(1);
  });

  it("文件被游戏占用时以 mod_file_busy 拒绝，什么都不改", async () => {
    setMockModFileBusy(MOCK_MOD_INSTANCE, "AANobbMI-0.5.3.jar", true);
    const error = await failure(removeMod(MOCK_MOD_INSTANCE, "AANobbMI-0.5.3.jar"));
    expect(isModFileBusy(error)).toBe(true);
    expect((error.detail as { path: string }).path.endsWith("/mods/AANobbMI-0.5.3.jar")).toBe(true);
    expect(await listMods(MOCK_MOD_INSTANCE)).toHaveLength(4);
    expect(isModFileBusy(new IpcError("io", "x"))).toBe(false);
  });
});

describe("更新检查与更新", () => {
  it("只报本实例 MC 版本与加载器下真正更新的版本，按文件名排序", async () => {
    const found = await checkUpdates(MOCK_MOD_INSTANCE);
    expect(found.map((c) => [c.file_name, c.current_version_id, c.latest.version_id])).toEqual([
      ["AANobbMI-0.5.3.jar", "sodium-053", "sodium-060"],
      ["P7dR8mSH-0.92.2.jar", "fapi-0922", "fapi-0927"],
    ]);
    expect(found[0]).toMatchObject({ title: "Sodium", current_version_number: "0.5.3", latest: { version_number: "0.6.0" } });
    // 原版实例没有加载器，一个都不查。
    expect(await checkUpdates("1.21")).toEqual([]);
  });

  it("更新留 .old 备份并记更新事件；可回滚，回滚后旧版与卷宗身份复原", async () => {
    const stages: string[] = [];
    subscribeMockEvent(CORE_EVENT, (payload) => stages.push((payload as { message: string }).message));

    const outcome = await updateMod("task-u1", MOCK_MOD_INSTANCE, "AANobbMI-0.5.3.jar", "sodium-060");
    expect(outcome).toMatchObject({ file_name: "AANobbMI-0.6.0.jar", platform: "modrinth" });
    expect(stages[0]).toBe("准备把 AANobbMI-0.5.3.jar 更新到版本 sodium-060");

    const names = (await listMods(MOCK_MOD_INSTANCE)).map((m) => m.file_name);
    expect(names).toContain("AANobbMI-0.6.0.jar");
    expect(names).not.toContain("AANobbMI-0.5.3.jar");
    expect(await backupSize(MOCK_MOD_INSTANCE)).toBe(1_048_576);

    const history = await listHistory(MOCK_MOD_INSTANCE);
    const update = history[history.length - 1];
    expect(update).toMatchObject({
      kind: "update",
      file_name: "AANobbMI-0.6.0.jar",
      old_file: "AANobbMI-0.5.3.jar",
      from_version: "sodium-053",
      to_version: "sodium-060",
      title: "Sodium",
      from_version_number: "0.5.3",
      to_version_number: "0.6.0",
    });
    expect((await rollbackChecks(MOCK_MOD_INSTANCE)).at(-1)).toEqual({ event_id: update.id, can_rollback: true, reason: null });
    // 前置已装着：不重复安装，只有这一条更新事件。
    expect(history.filter((e) => e.kind === "install")).toHaveLength(1);

    await rollback(MOCK_MOD_INSTANCE, update.id);
    const restored = await listMods(MOCK_MOD_INSTANCE);
    expect(restored[0]).toMatchObject({ file_name: "AANobbMI-0.5.3.jar", source: { version_id: "sodium-053", version_number: "0.5.3" } });
    expect(await backupSize(MOCK_MOD_INSTANCE)).toBe(0);
    const checks = await rollbackChecks(MOCK_MOD_INSTANCE);
    expect(checks.find((c) => c.event_id === update.id)).toEqual({ event_id: update.id, can_rollback: false, reason: "该更新已经回滚过" });
    const twice = await failure(rollback(MOCK_MOD_INSTANCE, update.id));
    expect(twice.detail).toEqual({ causes: [`事件 ${update.id} 已经回滚过，不能重复回滚`] });
  });

  it("参数非法先于登记任务拒绝；任务 id 冲突与取消和后端同码", async () => {
    expect(await failure(updateMod("task-u2", MOCK_MOD_INSTANCE, "AANobbMI-0.5.3.jar", ""))).toMatchObject({
      code: "invalid_argument",
      message: "mod_version_id 不能为空",
    });
    beginMockTask("task-u3");
    expect(await failure(updateMod("task-u3", MOCK_MOD_INSTANCE, "AANobbMI-0.5.3.jar", "sodium-060"))).toMatchObject({ code: "task_conflict" });
    endMockTask("task-u3");

    const pending = updateMod("task-u4", MOCK_MOD_INSTANCE, "AANobbMI-0.5.3.jar", "sodium-060");
    expect(await cancelTask("task-u4")).toBe(true);
    expect(await failure(pending)).toMatchObject({ code: "cancelled" });
    // 取消后一个文件都没动。
    expect((await listMods(MOCK_MOD_INSTANCE)).map((m) => m.file_name)).toContain("AANobbMI-0.5.3.jar");
  });

  it("来源不明的文件不能更新；被占用时报 mod_file_busy", async () => {
    const unknown = await failure(updateMod("task-u5", MOCK_MOD_INSTANCE, "handmade-1.0.jar", "x"));
    expect(unknown.detail).toEqual({ causes: ["handmade-1.0.jar 没有平台来源记录，无法自动更新（先检查更新让启动器识别它）"] });
    setMockModFileBusy(MOCK_MOD_INSTANCE, "AANobbMI-0.5.3.jar", true);
    expect(await failure(updateMod("task-u6", MOCK_MOD_INSTANCE, "AANobbMI-0.5.3.jar", "sodium-060"))).toMatchObject({ code: "mod_file_busy" });
  });
});

describe("下载页：版本列表、落位矩阵与安装计划", () => {
  it("版本列表按发布时间倒序，缺元数据的维度放行；非法入参与未知工程如实报错", async () => {
    const all = await listModVersions("modrinth", "AANobbMI", [], []);
    expect(all.map((v) => v.version_id)).toEqual(["sodium-121", "sodium-060", "sodium-053"]);
    const filtered = await listModVersions("modrinth", "AANobbMI", ["1.20.1"], ["fabric"]);
    expect(filtered.map((v) => v.version_id)).toEqual(["sodium-060", "sodium-053"]);
    // Mod Menu 的版本没标加载器：缺失不是证据，照样列出。
    expect(await listModVersions("modrinth", "mOgUt4GM", ["1.20.1"], ["forge"])).toHaveLength(1);
    expect(await failure(listModVersions("modrinth", "AANobbMI", [], ["optifine" as never]))).toMatchObject({ code: "invalid_argument" });
    expect(await failure(listModVersions("curseforge", "AANobbMI", [], []))).toMatchObject({ code: "mod_platform_failed" });
  });

  it("矩阵四态按档位排序，不兼容带原因，已装带出已装版本", async () => {
    const matrix = await matchInstances("modrinth", "AANobbMI", null);
    expect(matrix.map((m) => [m.version_id, m.state])).toEqual([
      ["1.20.1-Fabric", "installed"],
      ["1.20.1-Forge", "incompatible"],
      ["1.21", "incompatible"],
    ]);
    expect(matrix[0].installed).toEqual({ file_name: "AANobbMI-0.5.3.jar", version_id: "sodium-053", version_number: "0.5.3" });
    expect(matrix[0].best_version?.version_id).toBe("sodium-060");
    expect(matrix[1].compatibility).toEqual({ kind: "mismatch", reason: "需要 Fabric/NeoForge，该实例装的是 Forge" });
    expect(matrix[2].compatibility).toEqual({ kind: "mismatch", reason: "该实例未安装 Mod 加载器" });
    expect(matrix[2].best_version).toBeNull();

    // 指定版本：整个矩阵只按它判。
    const pinned = await matchInstances("modrinth", "mOgUt4GM", "mm-7");
    expect(pinned.map((m) => [m.version_id, m.state, m.compatibility.kind])).toEqual([
      ["1.20.1-Fabric", "maybe", "unknown"],
      ["1.20.1-Forge", "maybe", "unknown"],
      ["1.21", "incompatible", "mismatch"],
    ]);
    expect(pinned[2].compatibility).toEqual({ kind: "mismatch", reason: "不支持 MC 1.21" });
  });

  it("计划列出必需前置并跳过已装的；找不到适配版本的前置进跳过说明", async () => {
    const plan = await planInstall(MOCK_MOD_INSTANCE, "modrinth", "AANobbMI", "sodium-060");
    expect(plan.items.map((i) => [i.version.version_id, i.required_by, i.already_satisfied, i.title])).toEqual([
      ["sodium-060", null, false, "Sodium"],
      // 实例里已有 Fabric API（旧版）：沿用，不擅自升级。
      ["fapi-0922", "AANobbMI", true, "Fabric API"],
    ]);
    expect(plan.skipped).toEqual(["可选依赖 Mod Menu 未自动安装，需要时请手动添加"]);

    const forge = await planInstall("1.20.1-Forge", "modrinth", "AANobbMI", "sodium-060");
    expect(forge.items).toHaveLength(1);
    expect(forge.skipped).toEqual(["依赖 Fabric API 没有适配该实例的版本，未加入计划", "可选依赖 Mod Menu 未自动安装，需要时请手动添加"]);

    const same = await planInstall(MOCK_MOD_INSTANCE, "modrinth", "gvQqBUqZ", "lith-060");
    expect(same.items[0].already_satisfied).toBe(true);
    expect(await failure(planInstall(MOCK_MOD_INSTANCE, "modrinth", "AANobbMI", "nope"))).toMatchObject({ code: "mod_version_not_found" });
  });
});
