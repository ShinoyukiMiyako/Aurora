import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "./bridge";
import { IpcError, isCancelled } from "./errors";
import { updateConfig } from "./config";
import {
  backupWorld,
  checkInstanceName,
  clearTemplate,
  deleteInstance,
  deleteWorldBackup,
  exportWorld,
  getInstanceSettings,
  getSidebarPins,
  importCoverImage,
  installVersion,
  listInstanceContent,
  listInstances,
  listLoaderVersions,
  listManifest,
  listWorldBackups,
  openFolder,
  previewInstanceDeletion,
  renameInstance,
  repairInstance,
  requiredJava,
  saveInstanceAsTemplate,
  restoreWorldBackup,
  setInstanceSettings,
  setSidebarPins,
  TEMPLATE_FILES,
  templateInfo,
  versionRequirements,
  type InstanceSettingsDto,
} from "./instances";
import { resetMocks } from "./mock";
import { clearMockEventListeners } from "./mock/events";
import { acquireMockInstance, addMockInstance, loseMockCoverImage, loseMockLoaderLibrary, MOCK_INSTALL_STEPS, MOCK_STEP_MS } from "./mock/handlers/instances";
import { endMockGame, reset as resetLaunchMock, setMockPlayRecordsUnreadable } from "./mock/handlers/launch";
import { launchGame, playStats } from "./launch";
import { exportModpack } from "./modpack";
import { cancelTask, onCoreEvent, type CoreEvent } from "./tasks";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

/** 一次假安装从开始到结束的总时长（查找原版一步 + 下载各步），多给一步余量。 */
const INSTALL_SPAN_MS = MOCK_STEP_MS * (MOCK_INSTALL_STEPS + 2);

beforeEach(() => {
  vi.clearAllMocks();
  resetMocks();
  clearMockEventListeners();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function rejection(promise: Promise<unknown>): Promise<IpcError> {
  const error = await promise.then(
    () => {
      throw new Error("本应失败却成功了");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(IpcError);
  return error as IpcError;
}

function detail(error: IpcError): Record<string, unknown> {
  return error.detail as Record<string, unknown>;
}

describe("实例名称规则", () => {
  const existing = ["周末生存", "RLCraft"];

  it("按顺序报第一条不满足的规则", () => {
    expect(checkInstanceName("", existing)).toBe("empty");
    expect(checkInstanceName("   ", existing)).toBe("empty");
    expect(checkInstanceName("?".repeat(33), existing)).toBe("too_long");
    expect(checkInstanceName("a:b.", existing)).toBe("illegal_char");
    expect(checkInstanceName("con", ["CON"])).toBe("reserved");
  });

  it("长度按 UTF-16 码元计，32 个以内可用", () => {
    expect(checkInstanceName("樱".repeat(32), existing)).toBeNull();
    expect(checkInstanceName("樱".repeat(33), existing)).toBe("too_long");
    expect(checkInstanceName("\u{1F338}".repeat(16), existing)).toBeNull();
    expect(checkInstanceName("\u{1F338}".repeat(17), existing)).toBe("too_long");
  });

  it("Windows 设备名（含带扩展名的）、结尾的点与空格、控制字符都不行", () => {
    for (const name of ["CON", "com1", "Prn", "LPT9", "CON.txt", "nul.tar.gz", "AUX .x", "生存.", "生存 ", "a\tb"]) {
      expect(checkInstanceName(name, existing), name).toBe("reserved");
    }
    for (const name of ["CONSOLE", "COM10", "COM0", "NULL", "生存.CON", "1.21 生存"]) {
      expect(checkInstanceName(name, existing), name).toBeNull();
    }
  });

  it("以点开头不行：扫描实例时会跳过点开头的目录", () => {
    expect(checkInstanceName(".hidden", existing)).toBe("leading_dot");
  });

  it("重名不分大小写，但改名时自己不算", () => {
    expect(checkInstanceName("rlcraft", existing)).toBe("duplicate");
    expect(checkInstanceName("周末生存", existing)).toBe("duplicate");
    expect(checkInstanceName("rlcraft", existing, "RLCraft")).toBeNull();
    expect(checkInstanceName("周末生存", existing, "RLCraft")).toBe("duplicate");
  });
});

describe("Tauri 窗口里参数键与 Rust 形参一致", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  });

  it("每条命令的名字与 camelCase 参数", async () => {
    vi.mocked(tauriInvoke).mockResolvedValue(null);
    const settings: InstanceSettingsDto = {
      description: null,
      cover: null,
      cover_image: null,
      background: "follow",
      background_image: null,
      isolation: "follow_global",
      memory_mb: null,
      java: "auto",
      jvm_args: "",
      resolution: { width: 1280, height: 720 },
      fullscreen: false,
    };
    await listInstances();
    await getInstanceSettings("a");
    await setInstanceSettings("a", settings);
    await listInstanceContent("a");
    await getSidebarPins();
    await setSidebarPins(["a"]);
    await installVersion("t1", "1.21.1", "fabric", "0.16.10", "周末生存", true);
    await repairInstance("t2", "a");
    await previewInstanceDeletion("a");
    await deleteInstance("a");
    await renameInstance("a", "b");
    await listManifest();
    await listLoaderVersions("neoforge", "1.21.1");
    await requiredJava("1.21.1");
    await versionRequirements("1.21.1");
    await openFolder("world", "a", "New World");
    await openFolder("game_dir", null);
    await templateInfo();
    await saveInstanceAsTemplate("a");
    await clearTemplate();
    await importCoverImage("a", "block", "C:\\图片\\a.png");
    expect(vi.mocked(tauriInvoke).mock.calls).toEqual([
      ["list_instances", undefined],
      ["get_instance_settings", { id: "a" }],
      ["set_instance_settings", { id: "a", settings }],
      ["list_instance_content", { id: "a" }],
      ["get_sidebar_pins", undefined],
      ["set_sidebar_pins", { pins: ["a"] }],
      ["install_version", { taskId: "t1", id: "1.21.1", loader: "fabric", loaderVersion: "0.16.10", targetName: "周末生存", useTemplate: true }],
      ["repair_instance", { taskId: "t2", id: "a" }],
      ["preview_instance_deletion", { id: "a" }],
      ["delete_instance", { id: "a" }],
      ["rename_instance", { id: "a", newName: "b" }],
      ["list_manifest", undefined],
      ["list_loader_versions", { loader: "neoforge", mcVersion: "1.21.1" }],
      ["required_java", { mcVersion: "1.21.1" }],
      ["version_requirements", { mcVersion: "1.21.1" }],
      ["open_folder", { target: "world", id: "a", world: "New World" }],
      ["open_folder", { target: "game_dir", id: null, world: null }],
      ["template_info", undefined],
      ["save_instance_as_template", { id: "a" }],
      ["clear_template", undefined],
      ["import_cover_image", { id: "a", slot: "block", path: "C:\\图片\\a.png" }],
    ]);
  });

  it("存档备份五条命令：长任务带 taskId，其余只带实例、存档与备份文件名", async () => {
    vi.mocked(tauriInvoke).mockResolvedValue(null);
    await backupWorld("t-b", "a", "New World");
    await listWorldBackups("a", "New World");
    await restoreWorldBackup("t-r", "a", "New World", "1730000000000-auto.zip");
    await deleteWorldBackup("a", "New World", "1730000000000-auto.zip");
    await exportWorld("t-e", "a", "New World", "D:\\导出\\New World.zip");
    expect(vi.mocked(tauriInvoke).mock.calls).toEqual([
      ["backup_world", { taskId: "t-b", id: "a", world: "New World" }],
      ["list_world_backups", { id: "a", world: "New World" }],
      ["restore_world_backup", { taskId: "t-r", id: "a", world: "New World", file: "1730000000000-auto.zip" }],
      ["delete_world_backup", { id: "a", world: "New World", file: "1730000000000-auto.zip" }],
      ["export_world", { taskId: "t-e", id: "a", world: "New World", dest: "D:\\导出\\New World.zip" }],
    ]);
  });
});

describe("mock：列表、内容与元数据", () => {
  it("游玩记录读不懂：列表照常、每个实例带原因且时长为 null，统计报错；恢复后时长回来", async () => {
    setMockPlayRecordsUnreadable("解析 游玩记录 失败");
    const list = await listInstances();
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((i) => i.playtime_min === null && i.last_played_at === null && i.play_error === "解析 游玩记录 失败")).toBe(true);
    await expect(playStats({ from: "2026-01-01", to: "2026-01-31" })).rejects.toMatchObject({ code: "instance_failed" });
    setMockPlayRecordsUnreadable(null);
    const restored = await listInstances();
    expect(restored.find((i) => i.id === "1.21")).toMatchObject({ playtime_min: 175, play_error: null, dir_error: null });
    setMockPlayRecordsUnreadable("解析 游玩记录 失败");
    resetLaunchMock();
    expect((await listInstances()).find((i) => i.id === "1.21")?.play_error).toBeNull();
  });

  it("列表按小写 id 排序，就绪与损坏的实例字段各自成立", async () => {
    const list = await listInstances();
    // 码位顺序：数字 < 拉丁字母 < 汉字（樱 U+6A31 在 没 U+6CA1 之前），与后端一致，不按语言区域排。
    expect(list.map((i) => i.id)).toEqual(["1.20.1-Fabric", "1.20.1-Forge", "1.21", "1.21.1", "1.21.1-Fabric", "RLCraft", "樱花生存", "没装完"]);
    // 游玩时长取自启动 mock 的种子：1.20.1-Fabric 玩过 95 + 30 + 55 分钟，1.21 玩过 40 + 120 + 15 分钟。
    expect(list.find((i) => i.id === "1.20.1-Fabric")?.playtime_min).toBe(180);
    expect(list.find((i) => i.id === "1.21")?.playtime_min).toBe(175);
    expect(list.find((i) => i.id === "1.21")?.last_played_at).toBeGreaterThan(0);
    const fabric = list.find((i) => i.id === "樱花生存");
    expect(fabric).toMatchObject({
      status: "ready",
      mc_version: "1.21.1",
      loaders: [{ kind: "fabric", version: "0.16.10" }],
      java_major: 21,
      mod_count: 12,
      world_count: 2,
      isolated: true,
      description: "和朋友的周末服务器",
      cover: "cherry_planks",
      memory_mb: 6144,
      modpack: null,
      last_crash_at: null,
      activity: null,
      playtime_min: 0,
      last_played_at: null,
    });
    // 原版正式版跟随全局时不隔离；整合包实例带上整合包自己的名字与版本。
    expect(list.find((i) => i.id === "1.21.1")).toMatchObject({ isolated: false, world_count: 0, memory_mb: null });
    expect(list.find((i) => i.id === "RLCraft")?.modpack).toEqual({
      platform: "curseforge",
      project_id: "285109",
      version_id: "4612979",
      name: "RLCraft",
      version: "2.9.3",
    });
    const broken = list.find((i) => i.id === "没装完");
    expect(broken).toMatchObject({ status: "broken", mod_count: null, world_count: null, isolated: null, mc_version: null });
    expect(broken?.incomplete).toMatchObject({ kind: "install", outcome: "failed", spec: { loader: "neoforge" } });
  });

  it("内容：资源包顺序、当前光影与读不出 level.dat 的存档；损坏实例报 instance_failed", async () => {
    const content = await listInstanceContent("樱花生存");
    expect(content.resource_packs.map((p) => [p.file_name, p.load_order])).toEqual([
      ["Faithful 32x.zip", 1],
      ["旧材质", null],
    ]);
    expect(content.shader_packs[0].active).toBe(true);
    expect(content.worlds.map((w) => [w.dir_name, w.level_status, w.name])).toEqual([
      ["New World", "ok", "樱花谷"],
      ["坏档", "unreadable", null],
    ]);
    const error = await rejection(listInstanceContent("没装完"));
    expect(error.code).toBe("instance_failed");
    expect(detail(error).id).toBe("没装完");
    expect((await rejection(listInstanceContent("ghost"))).code).toBe("version_not_installed");
  });

  it("版本清单附带每个版本可装的加载器，加载器版本新的在前，所需 Java 按版本给出", async () => {
    const manifest = await listManifest();
    expect(manifest.latest.release).toBe("1.21.1");
    expect(manifest.versions.find((v) => v.id === "1.12.2")?.loaders).toEqual(["forge"]);
    expect(manifest.versions.find((v) => v.id === "1.5.2")?.loaders).toEqual([]);
    expect(manifest.stale_since).toBeNull();

    expect(await listLoaderVersions("neoforge", "1.21.1")).toEqual([
      { version: "21.1.77", stable: true },
      { version: "21.1.9-beta", stable: false },
    ]);
    expect(await listLoaderVersions("quilt", "1.12.2")).toEqual([]);
    const unknown = await rejection(listLoaderVersions("rift" as never, "1.21.1"));
    expect(unknown.code).toBe("invalid_argument");
    expect(detail(unknown)).toMatchObject({ field: "loader", reason: "unknown" });

    expect(await requiredJava("1.20.1")).toBe(17);
    expect(await requiredJava("1.5.2")).toBe(8);
    expect((await rejection(requiredJava("9.9.9"))).code).toBe("install_failed");

    // 下载体积与 Java 同一份清单派生；给不出体积的版本是 null 而不是 0。
    expect(await versionRequirements("1.20.1")).toEqual({ java_major: 17, download_bytes: 655 * 1_048_576 });
    expect(await versionRequirements("1.5.2")).toEqual({ java_major: 8, download_bytes: null });
    expect((await rejection(versionRequirements("9.9.9"))).code).toBe("install_failed");
  });

  it("打开文件夹的参数校验与后端一致", async () => {
    await openFolder("game_dir", null);
    // 数据目录与启动器日志目录不属于任何实例，不需要 id。
    await openFolder("data_dir", null);
    await openFolder("launcher_logs", null);
    await openFolder("mods", "樱花生存");
    await openFolder("world", "樱花生存", "New World");
    await openFolder("instance", "没装完");
    const field = async (promise: Promise<unknown>) => {
      const error = await rejection(promise);
      return [error.code, detail(error).field, detail(error).reason];
    };
    expect(await field(openFolder("mods", null))).toEqual(["invalid_argument", "id", "missing"]);
    expect(await field(openFolder("desktop" as never, "a"))).toEqual(["invalid_argument", "target", "unknown"]);
    expect(await field(openFolder("world", "樱花生存", "..\\x"))).toEqual(["invalid_argument", "world", "unsafe"]);
    expect(await field(openFolder("world", "樱花生存", "Nope"))).toEqual(["invalid_argument", "world", "not_found"]);
    expect((await rejection(openFolder("mods", "没装完"))).code).toBe("instance_failed");
  });
});

describe("mock：新建与补全", () => {
  it("新建按实例名装好，进度事件带 task_id，进行中列表里显示 installing", async () => {
    vi.useFakeTimers();
    const events: CoreEvent[] = [];
    await onCoreEvent((e) => events.push(e));
    const done = installVersion("t-new", "1.21.1", "fabric", null, "周末生存");

    await vi.advanceTimersByTimeAsync(MOCK_STEP_MS * 2);
    const during = (await listInstances()).find((i) => i.id === "周末生存");
    expect(during).toMatchObject({ activity: "installing", status: "broken", incomplete: { kind: "install", outcome: "pending" } });
    // 正在新建的实例不能删、不能改名，也不能再用同名新建。
    expect((await rejection(deleteInstance("周末生存"))).code).toBe("instance_busy");
    expect(detail(await rejection(renameInstance("周末生存", "x")))).toMatchObject({ activity: "installing" });

    await vi.advanceTimersByTimeAsync(INSTALL_SPAN_MS);
    expect(await done).toEqual({
      id: "周末生存",
      mc_version: "1.21.1",
      loader: { kind: "fabric", version: "0.16.10" },
      libraries: 40,
      assets: 0,
      natives: 0,
      template: null,
    });
    const after = (await listInstances()).find((i) => i.id === "周末生存");
    expect(after).toMatchObject({ status: "ready", activity: null, incomplete: null, mc_version: "1.21.1", java_major: 21 });
    expect(events.length).toBeGreaterThan(MOCK_INSTALL_STEPS);
    expect(events.every((e) => e.task_id === "t-new")).toBe(true);
    const last = events.filter((e) => e.kind === "download").at(-1);
    expect(last).toMatchObject({ finished: 40, total: 40 });
  });

  it("新建与补全按后端的步骤表逐步报出：每条都带整份表，本体与库那一步在下载之前，之后各步在下载之后", async () => {
    vi.useFakeTimers();
    const events: CoreEvent[] = [];
    await onCoreEvent((e) => events.push(e));
    const run = async <T>(promise: Promise<T>) => {
      await vi.advanceTimersByTimeAsync(INSTALL_SPAN_MS);
      return promise;
    };
    /** 这个任务报出的步骤（按 plan[index] 换成键），并核对每条的表都是同一份、下标从 0 依次加一。 */
    const steps = (taskId: string) => {
      const phases = events.flatMap((e) => (e.kind === "phase" && e.task_id === taskId ? [e] : []));
      const plan = phases.length === 0 ? [] : phases[0].plan;
      expect(phases.map((e) => [e.plan, e.index]), taskId).toEqual(plan.map((_, i) => [plan, i]));
      return phases.map((e) => e.plan[e.index]);
    };
    await run(installVersion("t-fabric", "1.21.1", "fabric", null, "周末生存"));
    expect(steps("t-fabric")).toEqual(["metadata", "loader_profile", "libraries", "assets", "natives"]);
    const order = events.flatMap((e) => (e.task_id !== "t-fabric" ? [] : e.kind === "phase" ? [e.plan[e.index]] : e.kind === "download" ? ["download"] : []));
    expect(order.indexOf("libraries")).toBeLessThan(order.indexOf("download"));
    expect(order.lastIndexOf("download")).toBeLessThan(order.indexOf("assets"));

    await run(installVersion("t-vanilla", "1.21.1", null, null, "原版", true));
    expect(steps("t-vanilla")).toEqual(["metadata", "libraries", "assets", "natives", "template"]);
    await run(installVersion("t-forge", "1.20.1", "forge", "47.2.0", "锻造"));
    expect(steps("t-forge")).toEqual(["metadata", "libraries", "assets", "natives", "java", "loader_installer", "loader_libraries", "loader_processors", "verify"]);
    // 只补全的实例走三步；照未完成标记重装的走新建那一份表，不套模板
    await run(repairInstance("t-complete", "樱花生存"));
    expect(steps("t-complete")).toEqual(["libraries", "assets", "natives"]);
    await run(repairInstance("t-reinstall", "没装完"));
    expect(steps("t-reinstall")).toEqual(["metadata", "libraries", "assets", "natives", "java", "loader_installer", "loader_libraries", "loader_processors", "verify"]);
  });

  it("新建的实例不继承已经不在的同名旧实例留下的游玩记录，别的实例的记录不动", async () => {
    vi.useFakeTimers();
    // 浏览器里刷新时实例从存储里恢复、游玩记录重新播种：删掉的 1.21 不在了，它的记录却又回来了
    await deleteInstance("1.21");
    resetLaunchMock();
    const done = installVersion("t-again", "1.21.1", null, null, "1.21");
    await vi.advanceTimersByTimeAsync(INSTALL_SPAN_MS);
    await done;
    const list = await listInstances();
    expect(list.find((i) => i.id === "1.21")).toMatchObject({ status: "ready", playtime_min: 0, last_played_at: null });
    expect(list.find((i) => i.id === "1.20.1-Fabric")?.playtime_min).toBe(180);
  });

  it("名称、加载器问题在登记任务之前就拒绝", async () => {
    for (const [name, rule] of [
      ["CON", "reserved"],
      ["com1", "reserved"],
      ["生存 ", "reserved"],
      ["rlcraft", "duplicate"],
      [".x", "leading_dot"],
    ] as const) {
      const error = await rejection(installVersion("t-same", "1.21.1", null, null, name));
      expect(error.code, name).toBe("invalid_argument");
      expect(detail(error), name).toMatchObject({ field: "name", rule, name });
    }
    const forge = await rejection(installVersion("t-same", "1.21.1", "forge", null, "新的"));
    expect(forge.code).toBe("loader_version_not_found");
    // 一直没有登记过，所以同一个 taskId 也不会撞上 task_conflict。
    expect((await listInstances()).some((i) => i.id === "新的")).toBe(false);
  });

  it("取消后新建到一半的实例整个消失，以 cancelled 拒绝", async () => {
    vi.useFakeTimers();
    const pending = installVersion("t-cancel", "1.20.1", "neoforge", "47.1.106", "半路").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(MOCK_STEP_MS * 2);
    expect(await cancelTask("t-cancel")).toBe(true);
    await vi.advanceTimersByTimeAsync(INSTALL_SPAN_MS);
    expect(isCancelled(await pending)).toBe(true);
    expect((await listInstances()).some((i) => i.id === "半路")).toBe(false);
  });

  it("失败的新建留下未完成标记；补全照记下的内容重装后标记清除", async () => {
    vi.useFakeTimers();
    const failed = installVersion("t-fail", "1.21.1", "fabric", "9.9.9", "坏版本").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(INSTALL_SPAN_MS);
    expect(await failed).toMatchObject({ code: "loader_version_not_found" });
    const left = (await listInstances()).find((i) => i.id === "坏版本");
    expect(left?.incomplete).toMatchObject({ kind: "install", outcome: "failed", error: { code: "loader_version_not_found" } });

    const repaired = repairInstance("t-repair", "没装完");
    await vi.advanceTimersByTimeAsync(INSTALL_SPAN_MS);
    expect(await repaired).toEqual({ reinstalled: true, libraries: 12, assets: 0, natives: 0 });
    const fixed = (await listInstances()).find((i) => i.id === "没装完");
    expect(fixed).toMatchObject({ status: "ready", incomplete: null, mc_version: "1.20.1", loaders: [{ kind: "neoforge", version: "47.1.106" }] });
  });

  describe("重新安装加载器", () => {
    const FABRIC = "樱花生存";
    const find = async (id: string) => {
      const found = (await listInstances()).find((i) => i.id === id);
      if (found === undefined) throw new Error(`mock 里没有实例 ${id}`);
      return found;
    };

    it("版本号与存档都不变，标记清掉，结果记作重装；期间占着实例，报的是 repairing", async () => {
      vi.useFakeTimers();
      const before = await find(FABRIC);
      const worlds = (await listInstanceContent(FABRIC)).worlds;
      expect(worlds.length).toBeGreaterThan(0);

      const done = repairInstance("t-loader", FABRIC, { reinstallLoader: true });
      await vi.advanceTimersByTimeAsync(MOCK_STEP_MS);
      expect(await find(FABRIC)).toMatchObject({ activity: "repairing", incomplete: { kind: "install", outcome: "pending", spec: { mc_version: "1.21.1", loader: "fabric", loader_version: "0.16.10" } } });
      await vi.advanceTimersByTimeAsync(INSTALL_SPAN_MS);

      expect(await done).toEqual({ reinstalled: true, libraries: 12, assets: 0, natives: 0 });
      const after = await find(FABRIC);
      expect(after).toMatchObject({ status: "ready", incomplete: null, activity: null, mc_version: before.mc_version, loaders: before.loaders, mod_count: before.mod_count, world_count: before.world_count });
      expect((await listInstanceContent(FABRIC)).worlds).toEqual(worlds);
    });

    it("不带参数的普通补全仍按版本 JSON 补，结果不算重装", async () => {
      vi.useFakeTimers();
      const done = repairInstance("t-plain", FABRIC);
      await vi.advanceTimersByTimeAsync(INSTALL_SPAN_MS);
      expect(await done).toMatchObject({ reinstalled: false });
    });

    it("上次补全败在加载器自带的库上：普通补全直接换成重装", async () => {
      vi.useFakeTimers();
      loseMockLoaderLibrary(FABRIC, "fabric-loader-0.16.10.jar");
      expect(await find(FABRIC)).toMatchObject({ incomplete: { kind: "repair", outcome: "failed", error: { code: "loader_library_missing" } } });
      const done = repairInstance("t-stuck", FABRIC);
      await vi.advanceTimersByTimeAsync(INSTALL_SPAN_MS);
      expect(await done).toMatchObject({ reinstalled: true });
      expect((await find(FABRIC)).incomplete).toBeNull();

      // 装不回的（这里是原版）照旧补全，不把补全也报成不可补全
      loseMockLoaderLibrary("1.21.1", "x.jar");
      const plain = repairInstance("t-plain", "1.21.1");
      await vi.advanceTimersByTimeAsync(INSTALL_SPAN_MS);
      expect(await plain).toMatchObject({ reinstalled: false });
    });

    it("中途取消：标记记成安装并带着读出的版本号，之后普通补全接着重装", async () => {
      vi.useFakeTimers();
      const cancelled = repairInstance("t-cancel", FABRIC, { reinstallLoader: true }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(MOCK_STEP_MS);
      await cancelTask("t-cancel");
      await vi.advanceTimersByTimeAsync(INSTALL_SPAN_MS);
      expect(isCancelled(await cancelled)).toBe(true);
      expect(await find(FABRIC)).toMatchObject({ activity: null, incomplete: { kind: "install", outcome: "cancelled", spec: { loader: "fabric", loader_version: "0.16.10" } } });

      const resumed = repairInstance("t-resume", FABRIC);
      await vi.advanceTimersByTimeAsync(INSTALL_SPAN_MS);
      expect(await resumed).toMatchObject({ reinstalled: true });
      expect(await find(FABRIC)).toMatchObject({ incomplete: null, loaders: [{ kind: "fabric", version: "0.16.10" }] });
    });

    it("原版没有可装的加载器：与后端同码同文，实例不留标记、不留占用", async () => {
      const error = await rejection(repairInstance("t-vanilla", "1.21.1", { reinstallLoader: true }));
      expect(error).toMatchObject({
        code: "instance_failed",
        message: "实例 1.21.1 无法补全：没有装加载器，不需要重新安装",
        detail: { id: "1.21.1", reason: "没有装加载器，不需要重新安装" },
      });
      expect(await find("1.21.1")).toMatchObject({ incomplete: null, activity: null });
    });

    it("参数不是布尔时与后端一样报参数错误", async () => {
      const error = await rejection(invoke("repair_instance", { taskId: "t-bad", id: FABRIC, reinstallLoader: "yes" }));
      expect(error).toMatchObject({ code: "invalid_argument", detail: { field: "reinstallLoader", reason: "type" } });
    });

    it("运行中与别的实例占着基底时都报 instance_busy", async () => {
      await launchGame({ taskId: "t-run", versionId: FABRIC, accountUuid: null, offlineName: "Steve", offlineFallback: false, quickPlay: null });
      expect((await rejection(repairInstance("t-busy", FABRIC, { reinstallLoader: true }))).detail).toEqual({ id: FABRIC, activity: "running" });
      endMockGame(0, MOCK_STEP_MS);

      addMockInstance("叠在原版上", "1.21", { kind: "fabric", version: "0.16.10" }, null);
      const hold = acquireMockInstance("1.21", "deleting");
      const error = await rejection(repairInstance("t-base", "叠在原版上", { reinstallLoader: true }));
      hold.release();
      expect(error).toMatchObject({ code: "instance_busy", detail: { id: "1.21", activity: "deleting" } });
      expect((await find("叠在原版上")).incomplete).toBeNull();
    });
  });

  it("补全被取消时标记记为 cancelled", async () => {
    vi.useFakeTimers();
    const pending = repairInstance("t-r", "1.21.1").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(MOCK_STEP_MS);
    await cancelTask("t-r");
    await vi.advanceTimersByTimeAsync(INSTALL_SPAN_MS);
    expect(isCancelled(await pending)).toBe(true);
    const instance = (await listInstances()).find((i) => i.id === "1.21.1");
    expect(instance?.incomplete).toMatchObject({ kind: "repair", outcome: "cancelled" });
    expect(instance?.activity).toBeNull();
  });
});

describe("mock：删除、改名与侧栏固定", () => {
  it("删除后从列表与侧栏固定里消失，重复删除 existed 为 false", async () => {
    const preview = await previewInstanceDeletion("樱花生存");
    expect(preview).toMatchObject({ id: "樱花生存", dependents: [], activity: null });
    expect(preview.worlds).toHaveLength(2);
    expect(await deleteInstance("樱花生存")).toEqual({ existed: true });
    expect((await listInstances()).some((i) => i.id === "樱花生存")).toBe(false);
    expect(await getSidebarPins()).toEqual(["1.21.1"]);
    expect(await deleteInstance("樱花生存")).toEqual({ existed: false });
    expect((await rejection(previewInstanceDeletion("樱花生存"))).code).toBe("version_not_installed");
    // 固定列表里确实删掉了：别的实例改用这个名字后不会被当成固定项。
    await renameInstance("RLCraft", "樱花生存");
    expect(await getSidebarPins()).toEqual(["1.21.1"]);
  });

  it("改名同步侧栏固定；新名字按规则校验，只改大小写可以", async () => {
    expect(await renameInstance("樱花生存", "樱花谷")).toEqual({ id: "樱花谷" });
    expect(await getSidebarPins()).toEqual(["樱花谷", "1.21.1"]);
    expect((await listInstances()).find((i) => i.id === "樱花谷")?.mod_count).toBe(12);

    const dup = await rejection(renameInstance("樱花谷", "rlcraft"));
    expect(dup.code).toBe("invalid_argument");
    expect(detail(dup)).toMatchObject({ field: "name", rule: "duplicate" });
    expect(await renameInstance("RLCraft", "rlcraft")).toEqual({ id: "rlcraft" });
    const unsafe = await rejection(renameInstance("../x", "y"));
    expect(detail(unsafe)).toMatchObject({ field: "id", reason: "unsafe_id" });
    expect((await rejection(renameInstance("ghost", "y"))).code).toBe("version_not_installed");
  });

  it("侧栏固定：第 6 个、重复、不存在都拒绝且不生效", async () => {
    const pinError = async (pins: string[]) => {
      const error = await rejection(setSidebarPins(pins));
      expect(error.code).toBe("invalid_argument");
      return [detail(error).reason, detail(error).id];
    };
    expect(await pinError(["1.21.1", "RLCraft", "樱花生存", "没装完", "a", "b"])).toEqual(["too_many", null]);
    expect(await pinError(["RLCraft", "RLCraft"])).toEqual(["duplicate", "RLCraft"]);
    expect(await pinError(["RLCraft", "ghost"])).toEqual(["not_found", "ghost"]);
    expect(await getSidebarPins()).toEqual(["樱花生存", "1.21.1"]);
    expect(await setSidebarPins(["RLCraft", "没装完"])).toEqual(["RLCraft", "没装完"]);
    expect(await getSidebarPins()).toEqual(["RLCraft", "没装完"]);
  });
});

describe("mock：实例设置", () => {
  it("整份写入并读回；多出字段、非法取值整次拒绝且不改动", async () => {
    const current = await getInstanceSettings("1.21.1");
    const next: InstanceSettingsDto = { ...current, memory_mb: 6144, isolation: "enabled", java: "C:\\Java\\jdk-21\\bin\\javaw.exe" };
    expect(await setInstanceSettings("1.21.1", next)).toEqual(next);
    expect(await getInstanceSettings("1.21.1")).toEqual(next);

    const extra = await rejection(setInstanceSettings("1.21.1", { ...next, colour: "pink" } as never));
    expect(detail(extra)).toMatchObject({ field: "settings", reason: "malformed" });
    for (const [patch, field] of [
      [{ memory_mb: 1000 }, "memory_mb"],
      [{ memory_mb: 1537 }, "memory_mb"],
      [{ description: "  " }, "description"],
      [{ cover: "Cherry" }, "cover"],
      [{ java: "java.exe" }, "java"],
      [{ resolution: { width: 319, height: 720 } }, "resolution"],
    ] as const) {
      const error = await rejection(setInstanceSettings("1.21.1", { ...next, ...patch }));
      expect(error.code, field).toBe("invalid_argument");
      expect(detail(error).field, JSON.stringify(patch)).toBe(field);
    }
    expect(await getInstanceSettings("1.21.1")).toEqual(next);
    expect((await rejection(setInstanceSettings("ghost", next))).code).toBe("version_not_installed");
  });

  it("卡面图片文件名与后端同一条规则：前缀、16 位小写十六进制、各位置认的扩展名；背景设为图片必须有图", async () => {
    const current = await getInstanceSettings("1.21.1");
    const ok: InstanceSettingsDto = { ...current, cover_image: "block-0123456789abcdef.png", background: "image", background_image: "background-fedcba9876543210.jpg" };
    expect(await setInstanceSettings("1.21.1", ok)).toEqual(ok);
    expect(await setInstanceSettings("1.21.1", { ...ok, background_image: "background-0123456789abcdef.png" })).toMatchObject({ background_image: "background-0123456789abcdef.png" });
    for (const [patch, field] of [
      [{ cover_image: "block-0123456789abcdef.jpg" }, "cover_image"],
      [{ cover_image: "../block-0123456789abcdef.png" }, "cover_image"],
      [{ cover_image: "background-0123456789abcdef.png" }, "cover_image"],
      [{ background_image: "background-0123456789ABCDEF.png" }, "background_image"],
      [{ background_image: "background-0123456789abcde.png" }, "background_image"],
      [{ background_image: "background-0123456789abcdefa.png" }, "background_image"],
      [{ background_image: "background-0123456789abcdef.webp" }, "background_image"],
      [{ background_image: "block-0123456789abcdef.png" }, "background_image"],
      [{ background_image: null }, "background"],
    ] as const) {
      const error = await rejection(setInstanceSettings("1.21.1", { ...ok, ...patch }));
      expect(error.code, JSON.stringify(patch)).toBe("invalid_argument");
      expect(detail(error).field, JSON.stringify(patch)).toBe(field);
    }
    // 背景不是图片时图片可以留着，换回来不用重选
    expect(await setInstanceSettings("1.21.1", { ...ok, background: "texture" })).toMatchObject({ background: "texture", background_image: "background-fedcba9876543210.jpg" });
  });
});

describe("mock：卡面图片导入", () => {
  const ID = "樱花生存";
  const listed = async () => {
    const found = (await listInstances()).find((i) => i.id === ID);
    if (found === undefined) throw new Error(`列表里没有 ${ID}`);
    return found;
  };

  it("背景位：按原图格式起名、把背景设为图片并写进设置；列表给出 40 位小写十六进制的取图键", async () => {
    const saved = await importCoverImage(ID, "background", "C:\\图片\\落日.JPEG");
    expect(saved.background).toBe("image");
    expect(saved.background_image).toMatch(/^background-[0-9a-f]{16}\.jpg$/);
    expect(saved).toMatchObject({ cover: "cherry_planks", cover_image: null, memory_mb: 6144 });
    expect(await getInstanceSettings(ID)).toEqual(saved);
    const dto = await listed();
    expect(dto.background).toBe("image");
    expect(dto.background_image).toMatch(/^[0-9a-f]{40}$/);
    expect(dto.cover_image).toBeNull();
    // 可能带透明的格式存 PNG
    expect((await importCoverImage(ID, "background", "C:\\图片\\a.webp")).background_image).toMatch(/^background-[0-9a-f]{16}\.png$/);
    expect((await importCoverImage(ID, "background", "C:\\图片\\a.png")).background_image).toMatch(/^background-[0-9a-f]{16}\.png$/);
  });

  it("方块位：一律存 PNG，只写 cover_image，背景不动；同一张图重复导入得同一个名字与键", async () => {
    const first = await importCoverImage(ID, "block", "D:/素材/方块.jpg");
    expect(first.cover_image).toMatch(/^block-[0-9a-f]{16}\.png$/);
    expect(first).toMatchObject({ background: "follow", background_image: null, cover: "cherry_planks" });
    const key = (await listed()).cover_image;
    expect(key).toMatch(/^[0-9a-f]{40}$/);
    const again = await importCoverImage(ID, "block", "D:/素材/方块.jpg");
    expect(again.cover_image).toBe(first.cover_image);
    expect((await listed()).cover_image).toBe(key);
    const other = await importCoverImage(ID, "block", "D:/素材/另一张.png");
    expect(other.cover_image).not.toBe(first.cover_image);
    expect((await listed()).cover_image).not.toBe(key);
  });

  it("换图与清除：被换下、不再被引用的旧图随保存清掉，之后再写回旧名字也拿不到取图键", async () => {
    const old = await importCoverImage(ID, "background", "C:\\a.png");
    const replaced = await importCoverImage(ID, "background", "C:\\b.png");
    expect(replaced.background_image).not.toBe(old.background_image);
    // 拿改图之前读到的设置写回：名字合法、写得进去，但文件已经不在了
    await setInstanceSettings(ID, old);
    expect(await getInstanceSettings(ID)).toEqual(old);
    expect((await listed()).background_image).toBeNull();

    const kept = await importCoverImage(ID, "background", "C:\\c.png");
    await setInstanceSettings(ID, { ...kept, background: "follow" });
    expect((await listed()).background_image).toMatch(/^[0-9a-f]{40}$/);
    await setInstanceSettings(ID, { ...kept, background: "follow", background_image: null });
    await setInstanceSettings(ID, { ...kept, background: "follow" });
    expect((await listed()).background_image).toBeNull();
  });

  it("文件在启动器外被删：设置照旧，列表的取图键为 null", async () => {
    const saved = await importCoverImage(ID, "block", "C:\\a.png");
    const file = saved.cover_image;
    if (file === null) throw new Error("导入没写下文件名");
    loseMockCoverImage(ID, file);
    expect((await getInstanceSettings(ID)).cover_image).toBe(file);
    expect((await listed()).cover_image).toBeNull();
  });

  it("不是 PNG、JPEG、WebP 报 invalid_argument（field 为 path），设置不动；实例忙碌报 instance_busy；不存在报 version_not_installed", async () => {
    const before = await getInstanceSettings(ID);
    for (const path of ["C:\\图片\\a.gif", "C:\\图片\\png", "C:\\图片\\a.png.txt", "C:\\图片\\a"]) {
      const error = await rejection(importCoverImage(ID, "background", path));
      expect(error.code, path).toBe("invalid_argument");
      expect(detail(error).field, path).toBe("path");
    }
    const hold = acquireMockInstance(ID, "repairing");
    const busy = await rejection(importCoverImage(ID, "block", "C:\\a.png"));
    expect(busy.code).toBe("instance_busy");
    expect(detail(busy)).toMatchObject({ id: ID, activity: "repairing" });
    hold.release();
    expect(await getInstanceSettings(ID)).toEqual(before);
    // 与改设置一样和运行中的游戏兼容
    const running = acquireMockInstance(ID, "running");
    expect((await importCoverImage(ID, "block", "C:\\a.png")).cover_image).toMatch(/^block-/);
    running.release();
    expect((await rejection(importCoverImage("ghost", "block", "C:\\a.png"))).code).toBe("version_not_installed");
  });
});

describe("mock：新实例的默认设置", () => {
  /** 装完一个实例并拿到结果；假时钟推进到安装结束。 */
  async function install(name: string, mcVersion: string, loader: "fabric" | null, useTemplate: boolean | undefined) {
    vi.useFakeTimers();
    const done = installVersion(`t-${name}`, mcVersion, loader, null, name, useTemplate);
    await vi.advanceTimersByTimeAsync(INSTALL_SPAN_MS);
    return done;
  }

  it("种子里没有默认设置；没进过游戏的实例保存时报 template_source_empty，detail 带实例 id 与白名单，模板不变", async () => {
    expect(await templateInfo()).toEqual({ present: false, files: [], source_instance: null, saved_at: null, enabled: true });
    const error = await rejection(saveInstanceAsTemplate("樱花生存"));
    expect(error.code).toBe("template_source_empty");
    expect(detail(error)).toEqual({ id: "樱花生存", files: ["options.txt", "servers.dat", "optionsof.txt", "optionsshaders.txt"] });
    expect(TEMPLATE_FILES).toEqual(detail(error).files);
    expect(error.message).toContain("进一次游戏后再保存");
    expect((await templateInfo()).present).toBe(false);
    expect((await rejection(saveInstanceAsTemplate("ghost"))).code).toBe("version_not_installed");
  });

  it("玩过的实例存为默认设置：记下来源与时刻；清除后回到没有", async () => {
    vi.useFakeTimers({ now: 1_790_000_000_000 });
    const saved = await saveInstanceAsTemplate("1.21");
    expect(saved).toEqual({
      present: true,
      files: [
        { name: "options.txt", size: 2048 },
        { name: "servers.dat", size: 512 },
      ],
      source_instance: "1.21",
      saved_at: 1_790_000_000_000,
      enabled: true,
    });
    expect(await templateInfo()).toEqual(saved);
    expect(await clearTemplate()).toEqual({ present: false, files: [], source_instance: null, saved_at: null, enabled: true });
    expect((await templateInfo()).present).toBe(false);
  });

  it("新建时沿用：隔离的 Fabric 实例补上模板里的文件；原版正式版不隔离、跳过；没请求为 null；模板为空时跳过", async () => {
    await saveInstanceAsTemplate("1.21");
    expect((await install("Fabric 生存", "1.21.1", "fabric", true)).template).toEqual({ status: "applied", copied: ["options.txt", "servers.dat"], kept: [] });
    expect((await install("原版生存", "1.21.1", null, true)).template).toEqual({ status: "skipped", reason: "shared_working_dir" });
    expect((await install("不沿用", "1.21.1", "fabric", false)).template).toBeNull();
    expect((await install("旧任务", "1.21.1", "fabric", undefined)).template).toBeNull();
    await clearTemplate();
    expect((await install("没有模板", "1.21.1", "fabric", true)).template).toEqual({ status: "skipped", reason: "empty" });
  });

  it("useTemplate 只收布尔：别的类型在登记任务之前就以 invalid_argument 拒绝", async () => {
    const error = await rejection(installVersion("t-bad", "1.21.1", null, null, "坏参数", "yes" as never));
    expect(error.code).toBe("invalid_argument");
    expect(detail(error).field).toBe("useTemplate");
    expect((await listInstances()).some((i) => i.id === "坏参数")).toBe(false);
  });

  it("保存要占住实例：安装进行中报 instance_busy，游戏运行这类 modifying 兼容的活动不挡", async () => {
    vi.useFakeTimers();
    const pending = installVersion("t-busy", "1.21.1", "fabric", null, "装着呢");
    await vi.advanceTimersByTimeAsync(MOCK_STEP_MS);
    const busy = await rejection(saveInstanceAsTemplate("装着呢"));
    expect(busy.code).toBe("instance_busy");
    expect(detail(busy)).toMatchObject({ id: "装着呢", activity: "installing" });
    await vi.advanceTimersByTimeAsync(INSTALL_SPAN_MS);
    await pending;
  });
});

describe("mock：存档备份", () => {
  /** 一次假打包（MOCK_INSTALL_STEPS 步）走完，多给一步余量。 */
  const PACK_SPAN_MS = MOCK_STEP_MS * (MOCK_INSTALL_STEPS + 1);
  const MB = 1_048_576;
  const ID = "樱花生存";
  const WORLD = "New World";

  async function backupDone(taskId: string): Promise<Awaited<ReturnType<typeof backupWorld>>> {
    const done = backupWorld(taskId, ID, WORLD);
    await vi.advanceTimersByTimeAsync(PACK_SPAN_MS);
    return done;
  }

  it("种子：两份自动一份手动，新的在前；隔离实例的备份在 instances/<id>/<存档> 下", async () => {
    const list = await listWorldBackups(ID, WORLD);
    expect(list.scope).toBe("instance");
    expect(list.dir).toBe(`D:/Games/.minecraft/.petalfall/backups/instances/${ID}/${WORLD}`);
    expect(list.backups.map((b) => b.kind)).toEqual(["auto", "manual", "auto"]);
    const times = list.backups.map((b) => b.created_at);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(new Set(times).size).toBe(3);
    expect(list.total_bytes).toBe((172 + 168 + 160) * MB);
    expect(list.backups.map((b) => b.level_name)).toEqual(["樱花谷", "樱花谷", "樱花村"]);
  });

  it("没有备份的存档、已经不在的存档都列出空表；不隔离的实例归在 shared 下；文件夹名不安全报 invalid_argument", async () => {
    expect(await listWorldBackups("1.21.1-Fabric", "生存")).toMatchObject({ backups: [], total_bytes: 0, scope: "instance" });
    expect((await listWorldBackups(ID, "删掉了的存档")).backups).toEqual([]);
    // 1.21.1 是原版正式版，跟随全局时不隔离
    expect(await listWorldBackups("1.21.1", "x")).toMatchObject({ scope: "shared", dir: "D:/Games/.minecraft/.petalfall/backups/shared/x" });
    for (const world of ["../New World", "a/b", "", ".hidden"]) {
      const error = await rejection(listWorldBackups(ID, world));
      expect(error.code, world).toBe("invalid_argument");
      expect(detail(error).field, world).toBe("world");
    }
    expect((await rejection(listWorldBackups("ghost", WORLD))).code).toBe("version_not_installed");
  });

  it("手动备份：进度事件带 task_id，结束后多一份 manual，记下当时的存档名；不存在的存档报 world_not_found", async () => {
    vi.useFakeTimers();
    const events: CoreEvent[] = [];
    await onCoreEvent((e) => events.push(e));
    const outcome = await backupDone("t-backup");
    expect(outcome.pruned).toBe(0);
    expect(outcome.backup).toMatchObject({ kind: "manual", level_name: "樱花谷", size_bytes: Math.round(180 * MB * 0.9) });
    expect(outcome.backup.file).toBe(`${outcome.backup.created_at}-manual.zip`);
    const list = await listWorldBackups(ID, WORLD);
    expect(list.backups).toHaveLength(4);
    expect(list.backups[0]).toEqual(outcome.backup);
    const downloads = events.filter((e) => e.kind === "download");
    expect(downloads).toHaveLength(MOCK_INSTALL_STEPS);
    expect(events.every((e) => e.task_id === "t-backup")).toBe(true);
    expect(downloads.at(-1)).toMatchObject({ finished: 24, total: 24 });

    const error = await rejection(backupWorld("t-missing", ID, "没有这个存档"));
    expect(error.code).toBe("world_not_found");
    expect(detail(error)).toEqual({ version_id: ID, world: "没有这个存档" });
  });

  it("游戏运行中：备份、恢复、导出都报 instance_busy，activity 为 running；与改动 Mod 并行不报错", async () => {
    vi.useFakeTimers();
    const running = acquireMockInstance(ID, "running");
    const [first] = (await listWorldBackups(ID, WORLD)).backups;
    for (const attempt of [backupWorld("t1", ID, WORLD), restoreWorldBackup("t2", ID, WORLD, first.file), exportWorld("t3", ID, WORLD, "D:\\out\\a.zip")]) {
      const error = await rejection(attempt);
      expect(error.code).toBe("instance_busy");
      expect(detail(error)).toMatchObject({ id: ID, activity: "running" });
    }
    running.release();

    const done = backupWorld("t4", ID, WORLD);
    await vi.advanceTimersByTimeAsync(MOCK_STEP_MS);
    // 备份进行中：改动 Mod 照样能占，两件并行时列表里报 backing_up；改名与第二份备份被挡
    const modifying = acquireMockInstance(ID, "modifying");
    expect((await listInstances()).find((i) => i.id === ID)?.activity).toBe("backing_up");
    expect(detail(await rejection(renameInstance(ID, "x")))).toMatchObject({ activity: "backing_up" });
    expect(detail(await rejection(backupWorld("t5", ID, WORLD)))).toMatchObject({ activity: "backing_up" });
    await vi.advanceTimersByTimeAsync(PACK_SPAN_MS);
    expect((await done).backup.kind).toBe("manual");
    expect((await listInstances()).find((i) => i.id === ID)?.activity).toBe("modifying");
    modifying.release();
    expect((await listInstances()).find((i) => i.id === ID)?.activity).toBeNull();
  });

  it("删除备份占住实例：改名、删除、新建、补全进行中报 instance_busy，备份留着；与运行中的游戏、备份、Mod 改动并行", async () => {
    const [first, second, third] = (await listWorldBackups(ID, WORLD)).backups;
    for (const activity of ["renaming", "deleting", "installing", "repairing"] as const) {
      const hold = acquireMockInstance(ID, activity);
      const error = await rejection(deleteWorldBackup(ID, WORLD, first.file));
      expect(error.code, activity).toBe("instance_busy");
      expect(detail(error), activity).toMatchObject({ id: ID, activity });
      hold.release();
    }
    expect((await listWorldBackups(ID, WORLD)).backups).toHaveLength(3);

    const running = acquireMockInstance(ID, "running");
    await deleteWorldBackup(ID, WORLD, first.file);
    running.release();
    const modifying = acquireMockInstance(ID, "modifying");
    await deleteWorldBackup(ID, WORLD, second.file);
    modifying.release();
    const backing = acquireMockInstance(ID, "backing_up");
    await deleteWorldBackup(ID, WORLD, third.file);
    backing.release();
    expect((await listWorldBackups(ID, WORLD)).backups).toEqual([]);
  });

  it("共用存档跨实例互斥：另一个不隔离的实例开着游戏时备份、恢复、导出报 instance_busy（指向那个实例），不占任务 id；任一方隔离就不挡", async () => {
    vi.useFakeTimers();
    // 1.21.1 是原版正式版，跟随全局时不隔离；樱花生存是 Fabric 实例，关掉隔离后与它共用存档
    const OTHER = "1.21.1";
    const settings = await getInstanceSettings(ID);
    const [first] = (await listWorldBackups(ID, WORLD)).backups;
    await setInstanceSettings(ID, { ...settings, isolation: "disabled" });
    for (const activity of ["launching", "running"] as const) {
      const game = acquireMockInstance(OTHER, activity);
      for (const attempt of [backupWorld("s1", ID, WORLD), restoreWorldBackup("s2", ID, WORLD, first.file), exportWorld("s3", ID, WORLD, "D:\\out\\a.zip")]) {
        const error = await rejection(attempt);
        expect(error.code).toBe("instance_busy");
        expect(detail(error)).toEqual({ id: OTHER, activity });
      }
      expect((await listInstances()).find((i) => i.id === ID)?.activity).toBeNull();
      game.release();
    }

    // 自己隔离：别的实例开着游戏也照常备份，被拒的那几次没占住任务 id
    const game = acquireMockInstance(OTHER, "running");
    await setInstanceSettings(ID, { ...settings, isolation: "enabled" });
    const done = backupWorld("s1", ID, WORLD);
    await vi.advanceTimersByTimeAsync(PACK_SPAN_MS);
    expect((await done).backup.kind).toBe("manual");
    game.release();
  });

  it("勾了存档的导出整合包进行中：恢复报 instance_busy（指向导出的实例，活动为 modifying），不登记任务；备份照常；共用存档的另一个实例同样被挡", async () => {
    vi.useFakeTimers();
    const [first] = (await listWorldBackups(ID, WORLD)).backups;
    const exporting = exportModpack("ex", ID, { destination: "D:/out/樱花.mrpack", name: "樱花", version: "1.0.0", summary: null, extras: ["saves"], include_disabled: false });
    const refused = await rejection(restoreWorldBackup("rs", ID, WORLD, first.file));
    expect(refused.code).toBe("instance_busy");
    expect(refused.message).toBe(`实例 ${ID} 正在导出带存档的整合包，请稍后再试`);
    expect(detail(refused)).toEqual({ id: ID, activity: "modifying" });
    expect(await cancelTask("rs")).toBe(false);
    // 备份只读存档，照常进行
    const backup = backupWorld("bk", ID, WORLD);
    await vi.advanceTimersByTimeAsync(PACK_SPAN_MS);
    expect((await backup).backup.kind).toBe("manual");
    await vi.advanceTimersByTimeAsync(1000);
    await exporting;

    // 共用存档：另一个不隔离的实例在导出带存档的整合包时，恢复同样被挡
    const OTHER = "1.21.1";
    const settings = await getInstanceSettings(ID);
    await setInstanceSettings(ID, { ...settings, isolation: "disabled" });
    // 关了隔离就换到共用的那一层备份：先备一份共用的再恢复它
    const sharedBackup = backupWorld("bk-shared", ID, WORLD);
    await vi.advanceTimersByTimeAsync(PACK_SPAN_MS);
    const { file } = (await sharedBackup).backup;
    const sharedExport = exportModpack("ex-2", OTHER, { destination: "D:/out/原版.mrpack", name: "原版", version: "1.0.0", summary: null, extras: ["saves"], include_disabled: false });
    expect(detail(await rejection(restoreWorldBackup("rs-2", ID, WORLD, file)))).toEqual({ id: OTHER, activity: "modifying" });
    await vi.advanceTimersByTimeAsync(1000);
    await sharedExport;
    const restored = restoreWorldBackup("rs-3", ID, WORLD, file);
    await vi.advanceTimersByTimeAsync(PACK_SPAN_MS);
    expect((await restored).world).toBe(WORLD);
  });

  it("共用存档跨实例互斥的反方向：不隔离的实例在备份时，另一个不隔离的实例启动报 instance_busy（backing_up），不登记任务；隔离的实例照常启动", async () => {
    vi.useFakeTimers();
    const OTHER = "1.21.1";
    const settings = await getInstanceSettings(ID);
    await setInstanceSettings(ID, { ...settings, isolation: "disabled" });
    const shared = backupWorld("b-shared", ID, WORLD);
    await vi.advanceTimersByTimeAsync(MOCK_STEP_MS);
    const refused = await rejection(launchGame({ taskId: "l-1", versionId: OTHER, accountUuid: null, offlineName: "Steve", offlineFallback: false, quickPlay: null }));
    expect(refused.code).toBe("instance_busy");
    expect(detail(refused)).toEqual({ id: ID, activity: "backing_up" });
    expect((await listInstances()).find((i) => i.id === OTHER)?.activity).toBeNull();
    // 隔离的实例不碰共用存档
    await expect(launchGame({ taskId: "l-2", versionId: "1.20.1-Fabric", accountUuid: null, offlineName: "Steve", offlineFallback: false, quickPlay: null })).resolves.toEqual({ pid: 4242, offline: false });
    endMockGame(0, 1000);
    await vi.advanceTimersByTimeAsync(PACK_SPAN_MS);
    await shared;
    // 备份完了就放行，被拒的那次没占住任务 id
    await expect(launchGame({ taskId: "l-1", versionId: OTHER, accountUuid: null, offlineName: "Steve", offlineFallback: false, quickPlay: null })).resolves.toEqual({ pid: 4242, offline: false });
    endMockGame(0, 1000);
  });

  it("清理：每个存档的自动备份超过保留份数时删最旧的，手动备份不动", async () => {
    vi.useFakeTimers();
    await updateConfig({ worldBackup: { auto: true, keep_per_world: 1, max_total_gb: 20 } });
    const [newestAuto, manual, oldestAuto] = (await listWorldBackups(ID, WORLD)).backups;
    const outcome = await backupDone("t-keep");
    expect(outcome.pruned).toBe(1);
    expect((await listWorldBackups(ID, WORLD)).backups.map((b) => b.file)).toEqual([outcome.backup.file, newestAuto.file, manual.file]);
    expect(oldestAuto.kind).toBe("auto");
  });

  it("清理：总量超过上限时从最旧的自动备份删起，删到不超为止；手动备份再多也不删", async () => {
    vi.useFakeTimers();
    await updateConfig({ worldBackup: { auto: true, keep_per_world: 50, max_total_gb: 1 } });
    const [newestAuto, , oldestAuto] = (await listWorldBackups(ID, WORLD)).backups;
    // 种子 500 MB，每份手动 162 MB：前三份写完 986 MB 不超 1 GB，第四份写完 1148 MB 超了，删掉最旧的那份自动（160 MB）就够
    for (const taskId of ["t-1", "t-2", "t-3"]) expect((await backupDone(taskId)).pruned).toBe(0);
    expect((await backupDone("t-4")).pruned).toBe(1);
    const list = await listWorldBackups(ID, WORLD);
    expect(list.backups.map((b) => b.kind)).toEqual(["manual", "manual", "manual", "manual", "auto", "manual"]);
    expect(list.backups.map((b) => b.file)).toContain(newestAuto.file);
    expect(list.backups.map((b) => b.file)).not.toContain(oldestAuto.file);
    expect(list.total_bytes).toBeLessThanOrEqual(1024 * MB);
    // 手动备份撑着总量：再写一份只能删那唯一的自动备份，删完就停，手动备份一份不少
    expect((await backupDone("t-5")).pruned).toBe(1);
    expect((await backupDone("t-6")).pruned).toBe(0);
    const left = (await listWorldBackups(ID, WORLD)).backups;
    expect(left.map((b) => b.kind)).toEqual(Array.from({ length: 7 }, () => "manual"));
  });

  it("自动备份关着时手动备份不清理：份数与总量都超了，以前的自动备份也一份不少", async () => {
    vi.useFakeTimers();
    await updateConfig({ worldBackup: { auto: false, keep_per_world: 1, max_total_gb: 1 } });
    const before = (await listWorldBackups(ID, WORLD)).backups.map((b) => b.file);
    // 种子 500 MB 加四份手动 648 MB 超过 1 GB，种子里的两份自动备份也超过每个存档 1 份
    for (const taskId of ["t-1", "t-2", "t-3", "t-4"]) expect((await backupDone(taskId)).pruned).toBe(0);
    const list = await listWorldBackups(ID, WORLD);
    expect(list.backups).toHaveLength(7);
    expect(list.backups.filter((b) => b.kind === "auto").map((b) => b.file)).toEqual(before.filter((_, i) => i !== 1));
  });

  it("恢复：备份表里没有这一份报 world_backup_not_found；成功后存档换成备份时的样子，原存档进回收站", async () => {
    vi.useFakeTimers();
    const error = await rejection(restoreWorldBackup("t-gone", ID, WORLD, "1-auto.zip"));
    expect(error.code).toBe("world_backup_not_found");
    expect(detail(error)).toEqual({ id: ID, world: WORLD, file: "1-auto.zip" });

    const oldest = (await listWorldBackups(ID, WORLD)).backups[2];
    const done = restoreWorldBackup("t-restore", ID, WORLD, oldest.file);
    await vi.advanceTimersByTimeAsync(PACK_SPAN_MS);
    expect(await done).toEqual({ world: WORLD, previous_in_recycle_bin: true });
    expect((await listInstanceContent(ID)).worlds.find((w) => w.dir_name === WORLD)).toMatchObject({ name: "樱花村", last_played: oldest.created_at });
    // 恢复不动备份表
    expect((await listWorldBackups(ID, WORLD)).backups).toHaveLength(3);
  });

  it("取消：进行中的备份以 cancelled 拒绝，备份表不变、实例放开", async () => {
    vi.useFakeTimers();
    const failed = rejection(backupWorld("t-cancel", ID, WORLD));
    await vi.advanceTimersByTimeAsync(MOCK_STEP_MS);
    expect(await cancelTask("t-cancel")).toBe(true);
    await vi.advanceTimersByTimeAsync(MOCK_STEP_MS);
    expect(isCancelled(await failed)).toBe(true);
    expect((await listWorldBackups(ID, WORLD)).backups).toHaveLength(3);
    expect((await listInstances()).find((i) => i.id === ID)?.activity).toBeNull();
  });

  it("删除一份备份：从表里摘掉，再删同一份报 world_backup_not_found；不占实例，游戏运行中也能删", async () => {
    const [first, second, third] = (await listWorldBackups(ID, WORLD)).backups;
    const running = acquireMockInstance(ID, "running");
    await deleteWorldBackup(ID, WORLD, first.file);
    running.release();
    expect((await listWorldBackups(ID, WORLD)).backups.map((b) => b.file)).toEqual([second.file, third.file]);
    const again = await rejection(deleteWorldBackup(ID, WORLD, first.file));
    expect(again.code).toBe("world_backup_not_found");
    expect(detail(again)).toEqual({ id: ID, world: WORLD, file: first.file });
  });

  it("导出：目标不是 .zip 或不是绝对路径报 invalid_argument（field 为 dest），不登记任务；成功给出路径与大小", async () => {
    vi.useFakeTimers();
    for (const dest of ["D:\\out\\a.rar", "out\\a.zip"]) {
      const error = await rejection(exportWorld("t-bad", ID, WORLD, dest));
      expect(error.code, dest).toBe("invalid_argument");
      expect(detail(error).field, dest).toBe("dest");
    }
    // 参数错的那两次没登记任务：同一个 taskId 还能用
    const done = exportWorld("t-bad", ID, WORLD, "D:\\out\\樱花谷.ZIP");
    await vi.advanceTimersByTimeAsync(PACK_SPAN_MS);
    expect(await done).toEqual({ path: "D:\\out\\樱花谷.ZIP", size_bytes: Math.round(180 * MB * 0.9) });
    expect((await listWorldBackups(ID, WORLD)).backups).toHaveLength(3);
  });

  it("删除预览带上备份目录与份数；删除实例不动备份，改名时备份跟着挪到新名字下", async () => {
    expect(await previewInstanceDeletion(ID)).toMatchObject({ backups_dir: `D:/Games/.minecraft/.petalfall/backups/instances/${ID}`, backup_count: 3 });
    expect(await previewInstanceDeletion("1.21")).toMatchObject({ backups_dir: "D:/Games/.minecraft/.petalfall/backups/instances/1.21", backup_count: 0 });
    await renameInstance(ID, "樱花谷存档");
    expect((await listWorldBackups("樱花谷存档", WORLD)).backups).toHaveLength(3);
    expect((await previewInstanceDeletion("樱花谷存档")).backup_count).toBe(3);
    await deleteInstance("樱花谷存档");
    // 备份留在原处：别的实例改成这个名字后，预览里数到的就是留下的那几份
    await renameInstance("RLCraft", "樱花谷存档");
    expect((await previewInstanceDeletion("樱花谷存档")).backup_count).toBe(3);
  });
});
