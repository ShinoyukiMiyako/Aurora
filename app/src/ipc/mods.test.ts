import { beforeEach, describe, expect, it, vi } from "vitest";
import { IpcError } from "./errors";
import { listHistory, rollback, rollbackChecks } from "./history";
import { resetMocks } from "./mock";
import { installMod } from "./discover";
import { clearMockEventListeners, subscribeMockEvent } from "./mock/events";
import { acquireMockInstance } from "./mock/handlers/instances";
import {
  MOCK_MOD_INSTANCE,
  mockModFileCount,
  setMockChangelog,
  setMockModFileBusy,
  setMockVersionChannel,
  setMockVersionListTruncated,
} from "./mock/handlers/mods";
import { beginMockTask, endMockTask } from "./mock/handlers/tasks";
import {
  checkUpdates,
  isModFileBusy,
  installedSources,
  listMods,
  matchInstances,
  modUpdateChangelog,
  modVersionList,
  planInstall,
  removeMod,
  setModEnabled,
  setModsEnabled,
  setModUpdateHold,
  updateMod,
  type UpdateHold,
} from "./mods";
import { CORE_EVENT, cancelTask } from "./tasks";
import { deleteInstance, listInstances, renameInstance } from "./instances";

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

/** 只看版本、不关心截断的断言用。 */
const versionsOf = async (...args: Parameters<typeof modVersionList>) => (await modVersionList(...args)).versions;

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
      // 种子里装上之后没再动过：装进实例的时刻就是文件修改时刻（秒）
      installed_at: 1_788_220_800,
      update_hold: null,
    });
    expect(sodium.modified_ms).toBe(1_788_220_800_000);
    expect(lithium.source?.installed_at).toBe(1_789_948_800);
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
    expect(error).toMatchObject({ code: "version_not_installed", message: "本地未安装版本 ghost", detail: { id: "ghost" } });
    // 版本 JSON 损坏的实例与后端一样按未安装处理。
    expect(await failure(listMods("没装完"))).toMatchObject({ code: "version_not_installed" });
  });

  it("实例以实例 mock 为准：列表里有、没种过 Mod 的实例是空 mods 目录，删掉后报未安装", async () => {
    expect(await listMods("1.21.1-Fabric")).toEqual([]);
    await deleteInstance("1.21.1-Fabric");
    expect(await failure(listMods("1.21.1-Fabric"))).toMatchObject({ code: "version_not_installed" });
  });

  it("实例列表的 mod_count 与 list_mods 数的是同一份文件：每个就绪实例都对得上，启停、移除、改名后依旧", async () => {
    const counts = async (): Promise<[string, number | null, number][]> => {
      const ready = (await listInstances()).filter((i) => i.status === "ready");
      return Promise.all(ready.map(async (i): Promise<[string, number | null, number]> => [i.id, i.mod_count, (await listMods(i.id)).length]));
    };
    for (const [id, listed, files] of await counts()) expect(listed, id).toBe(files);
    expect((await counts()).find(([id]) => id === "樱花生存")?.[1]).toBe(12);
    expect((await counts()).find(([id]) => id === "RLCraft")?.[1]).toBe(182);

    await setModEnabled(MOCK_MOD_INSTANCE, "handmade-1.0.jar", false);
    await removeMod(MOCK_MOD_INSTANCE, "AANobbMI-0.5.3.jar");
    await renameInstance("樱花生存", "樱花生存二周目");
    const after = await counts();
    for (const [id, listed, files] of after) expect(listed, id).toBe(files);
    // 停用的仍算一个 Mod，移除的不算；改名后 Mod 跟着实例走。
    expect(after.find(([id]) => id === MOCK_MOD_INSTANCE)?.[1]).toBe(3);
    expect(after.find(([id]) => id === "樱花生存二周目")?.[1]).toBe(12);

    // 删掉后 Mod 一侧的状态一并忘掉，同名新实例不会凭空带着旧 Mod。
    await deleteInstance("樱花生存二周目");
    expect(mockModFileCount("樱花生存二周目")).toBe(0);
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
    const matrix = await matchInstances("modrinth", "AANobbMI", "mod", null);
    expect(matrix.find((m) => m.version_id === MOCK_MOD_INSTANCE)?.state).toBe("compatible");
  });

  it("全部实例的已装来源一次取齐：禁用态也算，移除后随之消失", async () => {
    const sourcesOf = async (id: string) => {
      const row = (await installedSources()).find((r) => r.version_id === id);
      if (row === undefined || row.status !== "ready") throw new Error(`${id} 没有读出已装来源`);
      return row.sources.map((s) => `${s.platform}:${s.project_id}`);
    };
    const all = await installedSources();
    // 覆盖实例 mock 里全部可用的实例（损坏的不在其中），按实例 id 排序。
    expect(all.map((r) => r.version_id)).toEqual(["1.20.1-Fabric", "1.20.1-Forge", "1.21", "1.21.1", "1.21.1-Fabric", "RLCraft", "樱花生存"]);
    expect(all.every((r) => r.status === "ready")).toBe(true);
    // 种子里 Lithium 是禁用态，仍算装着；没有卷宗来源的手动 Mod 不出现。
    expect(await sourcesOf(MOCK_MOD_INSTANCE)).toEqual(["modrinth:AANobbMI", "modrinth:P7dR8mSH", "modrinth:gvQqBUqZ"]);
    expect(await sourcesOf("樱花生存")).toEqual([]);

    await removeMod(MOCK_MOD_INSTANCE, "AANobbMI-0.5.3.jar");
    expect(await sourcesOf(MOCK_MOD_INSTANCE)).toEqual(["modrinth:P7dR8mSH", "modrinth:gvQqBUqZ"]);
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

  it("全部更新的一项：update_mod 把调用时给的 step 标在每条事件上；单独调用的事件不带这个键", async () => {
    const events: Record<string, unknown>[] = [];
    subscribeMockEvent(CORE_EVENT, (payload) => events.push(payload as Record<string, unknown>));
    await updateMod("task-one", MOCK_MOD_INSTANCE, "P7dR8mSH-0.92.2.jar", "fapi-0927");
    await updateMod("task-all", MOCK_MOD_INSTANCE, "AANobbMI-0.5.3.jar", "sodium-060", 0);
    expect(events.map((e) => [e.task_id, "step" in e, e.step, e.message])).toEqual([
      ["task-one", false, undefined, "准备把 P7dR8mSH-0.92.2.jar 更新到版本 fapi-0927"],
      ["task-one", false, undefined, "模组 P7dR8mSH-0.92.7.jar 已安装"],
      ["task-all", true, 0, "准备把 AANobbMI-0.5.3.jar 更新到版本 sodium-060"],
      ["task-all", true, 0, "模组 AANobbMI-0.6.0.jar 已安装"],
    ]);
    expect(await failure(updateMod("task-bad", MOCK_MOD_INSTANCE, "P7dR8mSH-0.92.7.jar", "fapi-0927", -1))).toMatchObject({
      code: "unknown",
      message: "invalid args `step` for command `update_mod`: expected u32",
    });
  });

  it("来源不明的文件不能更新；被占用时报 mod_file_busy", async () => {
    const unknown = await failure(updateMod("task-u5", MOCK_MOD_INSTANCE, "handmade-1.0.jar", "x"));
    expect(unknown.detail).toEqual({ causes: ["handmade-1.0.jar 没有平台来源记录，无法自动更新（先检查更新让启动器识别它）"] });
    setMockModFileBusy(MOCK_MOD_INSTANCE, "AANobbMI-0.5.3.jar", true);
    expect(await failure(updateMod("task-u6", MOCK_MOD_INSTANCE, "AANobbMI-0.5.3.jar", "sodium-060"))).toMatchObject({ code: "mod_file_busy" });
  });
});

describe("批量启停", () => {
  const SODIUM = "AANobbMI-0.5.3.jar";
  const FABRIC_API = "P7dR8mSH-0.92.2.jar";
  const HANDMADE = "handmade-1.0.jar";
  const states = async () => (await listMods(MOCK_MOD_INSTANCE)).map((m) => [m.file_name, m.enabled]);

  it("三个文件其中一个被占用：其余两个照常停用，被占用的那项报 mod_file_busy 且文件不动，结果顺序同入参", async () => {
    setMockModFileBusy(MOCK_MOD_INSTANCE, FABRIC_API, true);
    const results = await setModsEnabled(MOCK_MOD_INSTANCE, [SODIUM, FABRIC_API, HANDMADE], false);

    expect(results.map((r) => [r.status, r.file_name])).toEqual([
      ["ok", SODIUM],
      ["error", FABRIC_API],
      ["ok", HANDMADE],
    ]);
    const [first, busy, third] = results;
    if (first.status !== "ok" || busy.status !== "error" || third.status !== "ok") throw new Error("结果的状态与断言不符");
    expect(first.path).toBe(`C:/Games/.minecraft/versions/${MOCK_MOD_INSTANCE}/mods/${SODIUM}.disabled`);
    expect(third.path).toBe(`C:/Games/.minecraft/versions/${MOCK_MOD_INSTANCE}/mods/${HANDMADE}.disabled`);
    expect(busy.error.code).toBe("mod_file_busy");
    expect(busy.error.detail).toEqual({ path: `C:/Games/.minecraft/versions/${MOCK_MOD_INSTANCE}/mods/${FABRIC_API}` });
    expect(await states()).toEqual([
      [`${SODIUM}.disabled`, false],
      [FABRIC_API, true],
      ["gvQqBUqZ-0.11.2.jar.disabled", false],
      [`${HANDMADE}.disabled`, false],
    ]);
  });

  it("已是目标状态的原样返回；名字不合法、文件不在的那一项各自报错，不影响别的文件", async () => {
    const results = await setModsEnabled(MOCK_MOD_INSTANCE, ["gvQqBUqZ-0.11.2.jar.disabled", HANDMADE, "config.toml", "ghost.jar.disabled"], true);
    expect(results.map((r) => (r.status === "ok" ? ["ok", r.path.split("/").pop()] : ["error", r.error.code]))).toEqual([
      ["ok", "gvQqBUqZ-0.11.2.jar"],
      ["ok", HANDMADE],
      ["error", "io"],
      ["error", "mod_platform_failed"],
    ]);
    const invalid = results[2];
    if (invalid.status !== "error") throw new Error("非模组文件名应当报错");
    expect(invalid.error.detail).toEqual({ causes: ["config.toml 不是 mods 目录里的模组文件名"] });
    expect(await states()).toEqual([
      [SODIUM, true],
      [FABRIC_API, true],
      ["gvQqBUqZ-0.11.2.jar", true],
      [HANDMADE, true],
    ]);
  });

  it("参数非法整次拒绝、一个文件都不动；实例在补全时整次以 instance_busy 拒绝", async () => {
    expect(await failure(setModsEnabled(MOCK_MOD_INSTANCE, [], false))).toMatchObject({ code: "invalid_argument", message: "file_names 不能为空" });
    expect(await failure(setModsEnabled(MOCK_MOD_INSTANCE, [SODIUM, " "], false))).toMatchObject({ code: "invalid_argument", message: "file_names 里有空文件名" });
    expect(await failure(setModsEnabled(MOCK_MOD_INSTANCE, [SODIUM, HANDMADE, SODIUM], false))).toMatchObject({
      code: "invalid_argument",
      message: `file_names 里有重复的 ${SODIUM}`,
    });
    const repairing = acquireMockInstance(MOCK_MOD_INSTANCE, "repairing");
    try {
      expect(await failure(setModsEnabled(MOCK_MOD_INSTANCE, [SODIUM], false))).toMatchObject({ code: "instance_busy", detail: { activity: "repairing" } });
    } finally {
      repairing.release();
    }
    expect((await states()).filter(([, enabled]) => !enabled)).toEqual([["gvQqBUqZ-0.11.2.jar.disabled", false]]);
  });
});

describe("忽略与锁定更新", () => {
  const SODIUM = "AANobbMI-0.5.3.jar";
  const updatable = async () => (await checkUpdates(MOCK_MOD_INSTANCE)).map((c) => [c.file_name, c.latest.version_id]);
  const holdOf = async (fileName: string) => (await listMods(MOCK_MOD_INSTANCE)).find((m) => m.file_name === fileName)?.source?.update_hold;

  it("忽略后检查更新不再含这一项，列表出参带上设置；恢复后重新出现", async () => {
    expect(await updatable()).toEqual([
      [SODIUM, "sodium-060"],
      ["P7dR8mSH-0.92.2.jar", "fapi-0927"],
    ]);
    await setModUpdateHold(MOCK_MOD_INSTANCE, SODIUM, { kind: "ignored" });
    expect(await holdOf(SODIUM)).toEqual({ kind: "ignored" });
    expect(await updatable()).toEqual([["P7dR8mSH-0.92.2.jar", "fapi-0927"]]);

    await setModUpdateHold(MOCK_MOD_INSTANCE, SODIUM, null);
    expect(await holdOf(SODIUM)).toBeNull();
    expect(await updatable()).toEqual([
      [SODIUM, "sodium-060"],
      ["P7dR8mSH-0.92.2.jar", "fapi-0927"],
    ]);
  });

  it("锁定版本是上限：锁在当前版本不报更新，锁在较新的版本报到它为止，锁的版本不在列表里不报", async () => {
    const pin = (version_id: string): UpdateHold => ({ kind: "pinned", version_id });
    await setModUpdateHold(MOCK_MOD_INSTANCE, SODIUM, pin("sodium-053"));
    expect(await updatable()).toEqual([["P7dR8mSH-0.92.2.jar", "fapi-0927"]]);
    await setModUpdateHold(MOCK_MOD_INSTANCE, SODIUM, pin("sodium-060"));
    expect(await updatable()).toEqual([
      [SODIUM, "sodium-060"],
      ["P7dR8mSH-0.92.2.jar", "fapi-0927"],
    ]);
    // sodium-121 只支持 1.21.1，不在这个实例能用的版本里
    await setModUpdateHold(MOCK_MOD_INSTANCE, SODIUM, pin("sodium-121"));
    expect(await updatable()).toEqual([["P7dR8mSH-0.92.2.jar", "fapi-0927"]]);
  });

  it("更新后新文件沿用装进实例的时刻与更新检查设置；禁用态文件名也能设置", async () => {
    await setModUpdateHold(MOCK_MOD_INSTANCE, SODIUM, { kind: "pinned", version_id: "sodium-060" });
    await updateMod("task-hold", MOCK_MOD_INSTANCE, SODIUM, "sodium-060");
    const updated = (await listMods(MOCK_MOD_INSTANCE)).find((m) => m.file_name === "AANobbMI-0.6.0.jar");
    expect(updated?.source).toMatchObject({ version_id: "sodium-060", installed_at: 1_788_220_800, update_hold: { kind: "pinned", version_id: "sodium-060" } });

    await setModUpdateHold(MOCK_MOD_INSTANCE, "gvQqBUqZ-0.11.2.jar.disabled", { kind: "ignored" });
    expect(await holdOf("gvQqBUqZ-0.11.2.jar.disabled")).toEqual({ kind: "ignored" });
  });

  it("新装的 Mod 装进实例的时刻是落位那一刻，设置为空", async () => {
    const before = Math.floor(Date.now() / 1000);
    await installMod("t-fresh", "1.21.1-Fabric", "modrinth", "YL57xq9U", "iris-181");
    const after = Math.floor(Date.now() / 1000);
    const iris = (await listMods("1.21.1-Fabric")).find((m) => m.source?.project_id === "YL57xq9U");
    if (iris === undefined || iris.source === null) throw new Error("Iris 没装上");
    expect(iris.source.installed_at).toBeGreaterThanOrEqual(before);
    expect(iris.source.installed_at).toBeLessThanOrEqual(after);
    expect(iris.source.update_hold).toBeNull();
  });

  it("参数与对象如实报错：空名、认不出的设置、空的锁定版本、没有来源、文件不在", async () => {
    expect(await failure(setModUpdateHold(MOCK_MOD_INSTANCE, " ", null))).toMatchObject({ code: "invalid_argument", message: "file_name 不能为空" });
    const frozen = { kind: "frozen" } as unknown as UpdateHold;
    expect(await failure(setModUpdateHold(MOCK_MOD_INSTANCE, SODIUM, frozen))).toMatchObject({ code: "invalid_argument", message: '未知的更新设置 {"kind":"frozen"}' });
    expect(await failure(setModUpdateHold(MOCK_MOD_INSTANCE, SODIUM, { kind: "pinned", version_id: "  " }))).toMatchObject({
      code: "invalid_argument",
      message: "hold.version_id 不能为空",
    });
    const local = await failure(setModUpdateHold(MOCK_MOD_INSTANCE, "handmade-1.0.jar", { kind: "ignored" }));
    expect(local).toMatchObject({ code: "io", detail: { causes: ["handmade-1.0.jar 没有平台来源记录，不能设置更新检查"] } });
    const gone = await failure(setModUpdateHold(MOCK_MOD_INSTANCE, "ghost.jar", { kind: "ignored" }));
    expect(gone).toMatchObject({ code: "io", detail: { causes: ["mods 目录里没有 ghost.jar，可能已被移除"] } });
    expect(await holdOf(SODIUM)).toBeNull();
  });
});

describe("更新候选按发布通道过滤", () => {
  const sodium = async () => (await checkUpdates(MOCK_MOD_INSTANCE)).find((c) => c.file_name === "AANobbMI-0.5.3.jar");

  it("当前是正式版、候选只有测试版：不报", async () => {
    setMockVersionChannel("modrinth", "sodium-060", "beta");
    expect(await sodium()).toBeUndefined();
  });

  it("当前是测试版：同为测试版的更新照报，预览版不报", async () => {
    setMockVersionChannel("modrinth", "sodium-053", "beta");
    setMockVersionChannel("modrinth", "sodium-060", "beta");
    const found = await sodium();
    expect(found?.latest).toMatchObject({ version_id: "sodium-060", release_channel: "beta" });
    setMockVersionChannel("modrinth", "sodium-060", "alpha");
    expect(await sodium()).toBeUndefined();
  });

  it("当前是预览版：正式版也报", async () => {
    setMockVersionChannel("modrinth", "sodium-053", "alpha");
    expect((await sodium())?.latest).toMatchObject({ version_id: "sodium-060", release_channel: "release" });
  });
});

describe("更新日志", () => {
  const SODIUM = "AANobbMI-0.5.3.jar";

  it("Modrinth 的版本给 Markdown：没登记时是固定的合成内容，登记了给原文，空白算没写", async () => {
    expect(await modUpdateChangelog(MOCK_MOD_INSTANCE, SODIUM, "sodium-060")).toEqual({
      version_id: "sodium-060",
      format: "markdown",
      body: "## 0.6.0\n\n- 修复与新版加载器的兼容问题\n- 降低区块加载时的内存占用\n",
    });
    setMockChangelog("modrinth", "sodium-060", "- 修好了夜视闪烁");
    expect(await modUpdateChangelog(MOCK_MOD_INSTANCE, SODIUM, "sodium-060")).toEqual({ version_id: "sodium-060", format: "markdown", body: "- 修好了夜视闪烁" });
    setMockChangelog("modrinth", "sodium-060", " \n ");
    expect((await modUpdateChangelog(MOCK_MOD_INSTANCE, SODIUM, "sodium-060")).body).toBeNull();
    setMockChangelog("modrinth", "sodium-060", null);
    expect((await modUpdateChangelog(MOCK_MOD_INSTANCE, SODIUM, "sodium-060")).body).toBeNull();
  });

  it("CurseForge 的文件给 HTML；补全进行中照样能读（只读，不占实例）", async () => {
    await installMod("t-cf", MOCK_MOD_INSTANCE, "curseforge", "394468", "4957843");
    const repairing = acquireMockInstance(MOCK_MOD_INSTANCE, "repairing");
    try {
      expect(await modUpdateChangelog(MOCK_MOD_INSTANCE, "394468-0.5.3.jar", "4957843")).toEqual({
        version_id: "4957843",
        format: "html",
        body: "<p>0.5.3 更新内容</p><ul><li>修复与新版加载器的兼容问题</li><li>降低区块加载时的内存占用</li></ul>",
      });
      setMockChangelog("curseforge", "4957843", "<p>Fixed crash</p>");
      expect((await modUpdateChangelog(MOCK_MOD_INSTANCE, "394468-0.5.3.jar", "4957843")).body).toBe("<p>Fixed crash</p>");
    } finally {
      repairing.release();
    }
  });

  it("没有来源记录报 io，平台上没有的版本报 mod_version_not_found 并带上平台、工程与版本", async () => {
    expect(await failure(modUpdateChangelog(MOCK_MOD_INSTANCE, "handmade-1.0.jar", "x"))).toMatchObject({
      code: "io",
      detail: { causes: ["handmade-1.0.jar 没有平台来源记录，取不到更新日志"] },
    });
    expect(await failure(modUpdateChangelog(MOCK_MOD_INSTANCE, SODIUM, "nope"))).toMatchObject({
      code: "mod_version_not_found",
      detail: { platform: "Modrinth", project_id: "AANobbMI", version_id: "nope" },
    });
    expect(await failure(modUpdateChangelog(MOCK_MOD_INSTANCE, SODIUM, ""))).toMatchObject({ code: "invalid_argument", message: "mod_version_id 不能为空" });
    expect(await failure(modUpdateChangelog("ghost", SODIUM, "sodium-060"))).toMatchObject({ code: "version_not_installed" });
  });
});

describe("下载页：版本列表、落位矩阵与安装计划", () => {
  it("版本列表按发布时间倒序，缺元数据的维度放行；非法入参与未知工程如实报错", async () => {
    const all = await versionsOf("modrinth", "AANobbMI", [], []);
    expect(all.map((v) => v.version_id)).toEqual(["sodium-121", "sodium-060", "sodium-053"]);
    const filtered = await versionsOf("modrinth", "AANobbMI", ["1.20.1"], ["fabric"]);
    expect(filtered.map((v) => v.version_id)).toEqual(["sodium-060", "sodium-053"]);
    // Mod Menu 的版本没标加载器：缺失不是证据，照样列出。
    expect(await versionsOf("modrinth", "mOgUt4GM", ["1.20.1"], ["forge"])).toHaveLength(1);
    expect(await failure(versionsOf("modrinth", "AANobbMI", [], ["optifine" as never]))).toMatchObject({ code: "invalid_argument" });
    expect(await failure(versionsOf("curseforge", "AANobbMI", [], []))).toMatchObject({ code: "mod_platform_failed" });
  });

  it("版本列表的出参带 truncated：不过滤的列表翻不完时为 true，带过滤的照常为 false", async () => {
    expect(await modVersionList("modrinth", "AANobbMI", [], [])).toEqual({
      versions: await versionsOf("modrinth", "AANobbMI", [], []),
      truncated: false,
    });
    setMockVersionListTruncated("modrinth", "AANobbMI", true);
    const truncated = await modVersionList("modrinth", "AANobbMI", [], []);
    expect(truncated.truncated).toBe(true);
    expect(truncated.versions.map((v) => v.version_id)).toEqual(["sodium-121", "sodium-060", "sodium-053"]);
    expect((await modVersionList("modrinth", "AANobbMI", ["1.20.1"], [])).truncated).toBe(false);
    expect((await modVersionList("modrinth", "mOgUt4GM", [], [])).truncated).toBe(false);
  });

  it("矩阵四态按档位排序，不兼容带原因，已装带出已装版本", async () => {
    const matrix = await matchInstances("modrinth", "AANobbMI", "mod", null);
    // 矩阵覆盖实例 mock 里全部可用的实例（损坏的「没装完」不在其中）。
    expect(matrix.map((m) => [m.version_id, m.state])).toEqual([
      ["1.21.1-Fabric", "compatible"],
      ["樱花生存", "compatible"],
      ["1.20.1-Fabric", "installed"],
      ["1.20.1-Forge", "incompatible"],
      ["1.21", "incompatible"],
      ["1.21.1", "incompatible"],
      ["RLCraft", "incompatible"],
    ]);
    expect(matrix[0].best_version?.version_id).toBe("sodium-121");
    expect(matrix[2].installed).toEqual({ file_name: "AANobbMI-0.5.3.jar", version_id: "sodium-053", version_number: "0.5.3", world: null });
    expect(matrix[2].best_version?.version_id).toBe("sodium-060");
    expect(matrix[3].compatibility).toEqual({ kind: "mismatch", reason: "需要 Fabric/NeoForge，该实例装的是 Forge" });
    expect(matrix[4].compatibility).toEqual({ kind: "mismatch", reason: "该实例未安装 Mod 加载器" });
    expect(matrix[4].best_version).toBeNull();
    expect(matrix[6].compatibility).toEqual({ kind: "mismatch", reason: "需要 Fabric/NeoForge，该实例装的是 Forge" });

    // 1.20.1 的 Fabric 实例只认 1.20.1 的版本：只有 1.21.1 版本的工程判为不支持这个 MC 版本
    const create = await matchInstances("modrinth", "LNytGWDc", "mod", "create-604");
    expect(create.find((m) => m.version_id === "1.21.1-Fabric")?.compatibility).toEqual({ kind: "mismatch", reason: "需要 NeoForge，该实例装的是 Fabric" });
    const lithium = await matchInstances("modrinth", "gvQqBUqZ", "mod", "lith-0143");
    expect(lithium.find((m) => m.version_id === "1.20.1-Fabric")?.compatibility).toEqual({ kind: "mismatch", reason: "不支持 MC 1.20.1" });

    // 指定版本：整个矩阵只按它判。
    const pinned = await matchInstances("modrinth", "mOgUt4GM", "mod", "mm-7");
    expect(pinned.map((m) => [m.version_id, m.state, m.compatibility.kind])).toEqual([
      ["1.20.1-Fabric", "maybe", "unknown"],
      ["1.20.1-Forge", "maybe", "unknown"],
      ["1.21", "incompatible", "mismatch"],
      ["1.21.1", "incompatible", "mismatch"],
      ["1.21.1-Fabric", "incompatible", "mismatch"],
      ["RLCraft", "incompatible", "mismatch"],
      ["樱花生存", "incompatible", "mismatch"],
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
