import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IpcError, isCancelled } from "./errors";
import {
  checkInstanceName,
  clearTemplate,
  deleteInstance,
  getInstanceSettings,
  getSidebarPins,
  installVersion,
  listInstanceContent,
  listInstances,
  listLoaderVersions,
  listManifest,
  openFolder,
  previewInstanceDeletion,
  renameInstance,
  repairInstance,
  requiredJava,
  saveInstanceAsTemplate,
  setInstanceSettings,
  setSidebarPins,
  TEMPLATE_FILES,
  templateInfo,
  versionRequirements,
  type InstanceSettingsDto,
} from "./instances";
import { resetMocks } from "./mock";
import { clearMockEventListeners } from "./mock/events";
import { MOCK_INSTALL_STEPS, MOCK_STEP_MS } from "./mock/handlers/instances";
import { reset as resetLaunchMock } from "./mock/handlers/launch";
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
    ]);
  });
});

describe("mock：列表、内容与元数据", () => {
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
