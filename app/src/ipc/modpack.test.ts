import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke, listen } from "./bridge";
import { IpcError } from "./errors";
import { deleteInstance, getInstanceSettings, listInstances } from "./instances";
import { resetMocks } from "./mock";
import { clearMockEventListeners } from "./mock/events";
import { acquireMockInstance } from "./mock/handlers/instances";
import { reset as resetLaunchMock } from "./mock/handlers/launch";
import { mockRevealedPaths } from "./mock/handlers/opener";
import {
  EXPORT_EXTRAS,
  INSTANCE_NAME_MAX_CHARS,
  exportModpack,
  installModpack,
  previewModpack,
  previewModpackExport,
  revealExportedPack,
  summarizePlatformModpack,
  type ModpackExportOptions,
  type ModpackSource,
} from "./modpack";
import { CORE_EVENT, cancelTask, type CoreEvent } from "./tasks";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const local: ModpackSource = { kind: "file", path: "D:/下载/我的整合包.mrpack" };
const platform: ModpackSource = { kind: "platform", platform: "modrinth", project_id: "1KVo5zza", version_id: "v14" };

beforeEach(() => {
  vi.clearAllMocks();
  resetMocks();
  clearMockEventListeners();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Tauri 里参数键与 Rust 形参一致", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  });

  it("导出：顶层键 camelCase，options 内部为 snake_case；在资源管理器里选中文件时参数键为 paths", async () => {
    vi.mocked(tauriInvoke).mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const options: ModpackExportOptions = {
      destination: "D:\\分享\\樱花 1.0.0.mrpack",
      name: "樱花",
      version: "1.0.0",
      summary: null,
      extras: ["config", "saves"],
      include_disabled: true,
    };
    await previewModpackExport("樱花生存");
    await exportModpack("t-ex", "樱花生存", options);
    await revealExportedPack("D:\\分享\\樱花 1.0.0.mrpack");
    expect(vi.mocked(tauriInvoke).mock.calls).toEqual([
      ["preview_modpack_export", { id: "樱花生存" }],
      ["export_modpack", { taskId: "t-ex", id: "樱花生存", options }],
      ["plugin:opener|reveal_item_in_dir", { paths: ["D:\\分享\\樱花 1.0.0.mrpack"] }],
    ]);
  });

  it("source 是带 kind 的对象，内部字段为 snake_case", async () => {
    vi.mocked(tauriInvoke).mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await previewModpack("D:/a.zip");
    await summarizePlatformModpack("modrinth", "1KVo5zza", "v14");
    await installModpack("t-mp", platform, null);
    expect(vi.mocked(tauriInvoke).mock.calls).toEqual([
      ["preview_modpack", { path: "D:/a.zip" }],
      ["summarize_platform_modpack", { platform: "modrinth", projectId: "1KVo5zza", versionId: "v14" }],
      ["install_modpack", { taskId: "t-mp", source: { kind: "platform", platform: "modrinth", project_id: "1KVo5zza", version_id: "v14" }, name: null }],
    ]);
  });
});

describe("整合包 mock", () => {
  it("平台整合包摘要：两种格式都给出 Mod 数与远程字节；目录里没有的工程报 mod_version_not_found", async () => {
    expect(await summarizePlatformModpack("modrinth", "1KVo5zza", "fo-641")).toEqual({
      format: "modrinth",
      name: "Fabulously Optimized",
      version: "6.4.1",
      minecraft: "1.21.1",
      loader: { kind: "fabric", version: "0.16.9" },
      pack_bytes: 2_412_544,
      remote_files: 48,
      mod_files: 41,
      remote_bytes: 96_468_992,
      override_files: 57,
      override_bytes: 364_233,
    });
    // 同一个包的旧版本是另一份清单
    expect(await summarizePlatformModpack("modrinth", "1KVo5zza", "fo-5120")).toMatchObject({ version: "5.12.0", minecraft: "1.20.1", mod_files: 38 });
    expect(await summarizePlatformModpack("curseforge", "396246", "5880001")).toMatchObject({ format: "curseforge", remote_files: 46, mod_files: 41, remote_bytes: 95_420_416 });
    expect(await summarizePlatformModpack("modrinth", "nope", "v1").catch((e: unknown) => e)).toMatchObject({ code: "mod_version_not_found" });
    expect(await summarizePlatformModpack("modrinth", "1KVo5zza", "nope").catch((e: unknown) => e)).toMatchObject({ code: "mod_version_not_found" });
  });

  it("预览按扩展名认格式，两种格式都给出 Mod 数与远程字节；其它扩展名报 modpack_unsupported_extension", async () => {
    expect(await previewModpack("D:/下载/我的整合包.mrpack")).toMatchObject({ format: "modrinth", name: "我的整合包", mod_files: 41, remote_bytes: 96_468_992 });
    expect(await previewModpack("D:/下载/Pack.ZIP")).toMatchObject({ format: "curseforge", name: "Pack", mod_files: 41, remote_bytes: 96_468_992 });
    const jar = await previewModpack("D:/下载/sodium.jar").catch((e: unknown) => e);
    expect(jar).toMatchObject({ code: "modpack_unsupported_extension", detail: { path: "D:/下载/sodium.jar" } });
    expect(await previewModpack(" ").catch((e: unknown) => e)).toMatchObject({ code: "invalid_argument" });
  });

  it("平台整合包导入为新实例：名字缺省取整合包名，记下来源，事件带本任务 id", async () => {
    const events: CoreEvent[] = [];
    const off = await listen<CoreEvent>(CORE_EVENT, (e) => events.push(e));
    const outcome = await installModpack("t-1", { ...platform, version_id: "fo-641" }, null);
    off();
    expect(outcome.version_id).toBe("Fabulously Optimized");
    expect(outcome.version_dir).toBe("D:/Games/.minecraft/versions/Fabulously Optimized");
    expect(outcome.modpack).toMatchObject({ format: "modrinth", platform: "modrinth", project_id: "1KVo5zza", version_id: "fo-641", name: "Fabulously Optimized", version: "6.4.1" });
    // 导入的实例出现在实例列表里，设置为强制隔离。
    expect((await listInstances()).map((i) => i.id)).toContain("Fabulously Optimized");
    expect((await getInstanceSettings("Fabulously Optimized")).isolation).toBe("enabled");
    expect(events.every((e) => e.task_id === "t-1")).toBe(true);
    expect(events.at(-1)).toEqual({ task_id: "t-1", kind: "stage", message: "整合包已导入为实例 Fabulously Optimized" });

    // 同名再导入一次：不区分大小写的重名。
    const again = await installModpack("t-2", { ...platform, version_id: "fo-641" }, "fabulously optimized").catch((e: unknown) => e);
    expect(again).toMatchObject({ code: "instance_name_invalid", detail: { name: "fabulously optimized", rule: "duplicate" } });
  });

  it("本地文件的整合包信息不带平台；去掉首尾空白后的名字作为实例名", async () => {
    const outcome = await installModpack("t-3", local, "  周末联机  ");
    expect(outcome.version_id).toBe("周末联机");
    expect(outcome.modpack).toMatchObject({ platform: null, project_id: null, version_id: null, name: "我的整合包", format: "modrinth" });
  });

  it("导入得到的实例不继承已经不在的同名旧实例留下的游玩记录，别的实例的记录不动", async () => {
    // 浏览器里刷新时实例从存储里恢复、游玩记录重新播种：删掉的 1.21 不在了，它的记录却又回来了
    await deleteInstance("1.21");
    resetLaunchMock();
    await installModpack("t-again", local, "1.21");
    const list = await listInstances();
    expect(list.find((i) => i.id === "1.21")).toMatchObject({ playtime_min: 0, last_played_at: null });
    expect(list.find((i) => i.id === "1.20.1-Fabric")?.playtime_min).toBe(180);
  });

  it("实例名规则与后端一致", async () => {
    const cases: [string, string][] = [
      ["", "empty"],
      ["   ", "empty"],
      ["樱".repeat(INSTANCE_NAME_MAX_CHARS + 1), "too_long"],
      ["a/b", "illegal_char"],
      ["a:b", "illegal_char"],
      [".hidden", "illegal_char"],
      ["pack.", "illegal_char"],
      ["CON", "reserved"],
      ["com1.txt", "reserved"],
      ["樱花生存", "duplicate"],
      ["1.21.1-fabric", "duplicate"],
      ["1.21.1", "duplicate"],
    ];
    for (const [name, rule] of cases) {
      const error = await installModpack(`t-${rule}-${name.length}`, local, name).catch((e: unknown) => e);
      expect(error, name).toBeInstanceOf(IpcError);
      expect(error, name).toMatchObject({ code: "instance_name_invalid", detail: { rule } });
    }
    expect((await installModpack("t-ok", local, "樱".repeat(INSTANCE_NAME_MAX_CHARS))).version_id).toHaveLength(INSTANCE_NAME_MAX_CHARS);
    expect((await installModpack("t-com0", local, "COM0")).version_id).toBe("COM0");
  });

  it("来源不对：平台上没有这个整合包报 mod_version_not_found，形状不对报 unknown，空字段报 invalid_argument", async () => {
    const notPack = await installModpack("t-a", { kind: "platform", platform: "modrinth", project_id: "AANobbMI", version_id: "v" }, null).catch(
      (e: unknown) => e,
    );
    expect(notPack).toMatchObject({ code: "mod_version_not_found", detail: { project_id: "AANobbMI" } });
    const malformed = await installModpack("t-b", { kind: "url" } as never, null).catch((e: unknown) => e);
    expect(malformed).toMatchObject({ code: "unknown" });
    const blank = await installModpack("t-c", { kind: "file", path: " " }, null).catch((e: unknown) => e);
    expect(blank).toMatchObject({ code: "invalid_argument" });
  });

  it("导入途中取消以 cancelled 结束，名字没有被占用", async () => {
    const running = installModpack("t-cancel", local, "取消的包").catch((e: unknown) => e);
    expect(await cancelTask("t-cancel")).toBe(true);
    expect(await running).toMatchObject({ code: "cancelled" });
    expect((await installModpack("t-retry", local, "取消的包")).version_id).toBe("取消的包");
  });
});

describe("导出整合包 mock", () => {
  const FABRIC = "1.20.1-Fabric";
  const DEST = "D:\\分享\\测试包 2.0.mrpack";
  const base: ModpackExportOptions = { destination: DEST, name: "测试包", version: "2.0", summary: null, extras: ["config", "options"], include_disabled: true };
  const errorOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

  it("预览按卷宗分组：Modrinth 来源的进索引，没有来源的打包进文件，停用的单列；额外项的默认勾选与后端同一规则", async () => {
    const preview = await previewModpackExport(FABRIC);
    expect(preview.name).toBe(FABRIC);
    expect(preview.version).toBe("1.0.0");
    expect(preview.minecraft).toBe("1.20.1");
    expect(preview.loader).toEqual({ kind: "fabric", version: "0.15.11" });
    expect(preview.indexed.map((m) => [m.file_name, m.project_id, m.version_id, m.title, m.matched_by])).toEqual([
      ["AANobbMI-0.5.3.jar", "AANobbMI", "sodium-053", "Sodium", "ledger"],
      ["P7dR8mSH-0.92.2.jar", "P7dR8mSH", "fapi-0922", "Fabric API", "ledger"],
    ]);
    expect(preview.bundled).toEqual([{ file_name: "handmade-1.0.jar", path: "C:/Games/.minecraft/versions/1.20.1-Fabric/mods/handmade-1.0.jar", size: 4096, reason: "unlisted" }]);
    expect(preview.disabled.map((m) => [m.file_name, m.size, m.reason])).toEqual([["gvQqBUqZ-0.11.2.jar.disabled", 524_288, "disabled"]]);
    expect(preview.extras.map((e) => e.extra)).toEqual([...EXPORT_EXTRAS]);
    expect(preview.extras.map((e) => [e.extra, e.files, e.default_selected])).toEqual([
      ["config", 37, true],
      ["defaultconfigs", 0, false],
      ["kubejs", 0, false],
      ["resourcepacks", 2, true],
      ["shaderpacks", 1, true],
      ["options", 1, true],
      // 这个实例没有存档：0 个文件，不勾
      ["saves", 0, false],
    ]);
    expect(preview.skipped).toEqual([]);
  });

  it("预览：整合包实例默认取记下的名字与版本；有存档时存档也不默认勾选", async () => {
    const pack = await previewModpackExport("RLCraft");
    expect([pack.name, pack.version]).toEqual(["RLCraft", "2.9.3"]);
    expect(pack.indexed).toEqual([]);
    expect(pack.bundled).toHaveLength(182);
    const worlds = await previewModpackExport("1.21.1-Fabric");
    expect(worlds.extras.find((e) => e.extra === "saves")).toEqual({ extra: "saves", files: 2, bytes: 80 * 1_048_576, default_selected: false });
  });

  it("预览：实例不存在报 version_not_installed，没装完的报 modpack_export_unsupported 与原因", async () => {
    expect(await errorOf(previewModpackExport("不存在"))).toMatchObject({ code: "version_not_installed", detail: { id: "不存在" } });
    expect(await errorOf(previewModpackExport("没装完"))).toMatchObject({
      code: "modpack_export_unsupported",
      message: "实例还没装完整，修复后再导出",
      detail: { id: "没装完", reason: "incomplete" },
    });
  });

  it("参数非法时报 invalid_argument，detail 给出 field 与 rule，不登记任务也不占实例", async () => {
    const cases: [Partial<ModpackExportOptions>, Record<string, unknown>][] = [
      [{ name: "   " }, { field: "name", rule: "empty" }],
      [{ name: "樱".repeat(65) }, { field: "name", rule: "too_long" }],
      [{ name: "a\tb" }, { field: "name", rule: "control_char" }],
      [{ version: "" }, { field: "version", rule: "empty" }],
      [{ version: "1".repeat(33) }, { field: "version", rule: "too_long" }],
      [{ version: "1.0\u0007x" }, { field: "version", rule: "control_char" }],
      [{ summary: "简".repeat(257) }, { field: "summary", rule: "too_long" }],
      [{ extras: ["config", "mods"] as never }, { field: "extras", rule: "unknown", value: "mods" }],
      [{ destination: "分享\\包.mrpack" }, { field: "destination", rule: "relative" }],
      [{ destination: "D:\\分享\\包.zip" }, { field: "destination", rule: "extension" }],
    ];
    for (const [patch, detail] of cases) {
      const error = await errorOf(exportModpack(`t-bad-${String(detail.field)}-${String(detail.rule)}`, FABRIC, { ...base, ...patch }));
      expect(error, JSON.stringify(patch)).toBeInstanceOf(IpcError);
      expect(error, JSON.stringify(patch)).toMatchObject({ code: "invalid_argument", detail });
    }
    // 参数非法的调用没有占住实例：随后改名照常占得到
    expect(() => acquireMockInstance(FABRIC, "renaming").release()).not.toThrow();
    // 边界值：正好到上限的名称、版本号与简介可以导出，大写扩展名与 UNC 路径都认，重复的打包项去重
    const edge = await exportModpack("t-edge", FABRIC, {
      ...base,
      name: "樱".repeat(64),
      version: "1".repeat(32),
      summary: "简".repeat(256),
      extras: ["options", "options"],
      include_disabled: false,
      destination: "\\\\nas\\share\\包.MRPACK",
    });
    expect(edge).toMatchObject({ name: "樱".repeat(64), version: "1".repeat(32), path: "\\\\nas\\share\\包.MRPACK", override_files: 2 });
  });

  it("options 的形状不对是 Tauri 的参数错误，归一为 unknown", async () => {
    const stray = await errorOf(invoke("export_modpack", { taskId: "t-x", id: FABRIC, options: { ...base, author: "我" } }));
    expect(stray).toMatchObject({ code: "unknown" });
    expect((stray as IpcError).message).toContain("unknown field `author`");
    const missing = await errorOf(invoke("export_modpack", { taskId: "t-y", id: FABRIC, options: { destination: DEST, name: "a", version: "1" } }));
    expect(missing).toMatchObject({ code: "unknown" });
  });

  it("同实例正在改名时报 instance_busy；导出进行中改名也报 instance_busy，活动为 modifying", async () => {
    const renaming = acquireMockInstance(FABRIC, "renaming");
    expect(await errorOf(exportModpack("t-busy", FABRIC, base))).toMatchObject({ code: "instance_busy", detail: { id: FABRIC, activity: "renaming" } });
    renaming.release();

    const running = exportModpack("t-hold", FABRIC, base);
    // 命令经异步的桥才到假后端：等它占住实例、停在第一段打包进度上
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(() => acquireMockInstance(FABRIC, "renaming")).toThrow(expect.objectContaining({ code: "instance_busy", detail: { id: FABRIC, activity: "modifying" } }));
    // 与游戏启动兼容
    expect(() => acquireMockInstance(FABRIC, "launching").release()).not.toThrow();
    await running;
    expect(() => acquireMockInstance(FABRIC, "renaming").release()).not.toThrow();
  });

  it("取消后以 cancelled 结束并放开实例", async () => {
    const running = errorOf(exportModpack("t-cancel", FABRIC, base));
    expect(await cancelTask("t-cancel")).toBe(true);
    expect(await running).toMatchObject({ code: "cancelled" });
    expect(() => acquireMockInstance(FABRIC, "renaming").release()).not.toThrow();
  });

  it("成功：打包进文件的是勾选的额外项、不在 Modrinth 上的 Mod 与带上的停用 Mod，事件都带本任务 id", async () => {
    const events: CoreEvent[] = [];
    const off = await listen<CoreEvent>(CORE_EVENT, (e) => events.push(e));
    const outcome = await exportModpack("t-ok", FABRIC, { ...base, name: "  测试包  ", summary: "  " });
    off();
    // config 37 个 412 KB + options 1 个 6 KB + handmade 4096 + 停用的 lithium 524288
    const bytes = 412 * 1024 + 6 * 1024 + 4096 + 524_288;
    expect(outcome).toEqual({
      path: DEST,
      name: "测试包",
      version: "2.0",
      bytes: bytes + 512 * 3,
      indexed_files: 2,
      override_files: 40,
      bundled_mods: ["handmade-1.0.jar"],
      disabled_mods: 1,
      skipped: [],
    });
    expect(events.every((e) => e.task_id === "t-ok")).toBe(true);
    expect(events.filter((e) => e.kind === "warning").map((e) => (e.kind === "warning" ? e.message : ""))).toEqual(["1 个 Mod 不在 Modrinth 上，已直接打包进文件"]);
    const progress = events.filter((e) => e.kind === "download");
    expect(progress).toHaveLength(5);
    expect(progress.at(-1)).toEqual({ task_id: "t-ok", kind: "download", total: 40, finished: 40, bytes, total_bytes: bytes, speed: 8 * 1_048_576 });
    expect(events.at(-1)).toEqual({ task_id: "t-ok", kind: "stage", message: `已导出到 ${DEST}` });

    // 不带停用的 Mod、不带额外项：只剩不在 Modrinth 上的那一个
    const without = await exportModpack("t-ok2", FABRIC, { ...base, include_disabled: false, extras: [] });
    expect([without.override_files, without.disabled_mods, without.bytes]).toEqual([1, 0, 4096 + 512 * 3]);
  });

  it("在资源管理器里选中：记下路径；参数不是字符串数组时照插件的参数错误拒绝", async () => {
    await revealExportedPack(DEST);
    expect(mockRevealedPaths).toEqual([DEST]);
    const bad = await errorOf(invoke("plugin:opener|reveal_item_in_dir", { paths: DEST }));
    expect(bad).toMatchObject({ code: "unknown" });
    expect((bad as IpcError).message).toContain("invalid args `paths` for command `reveal_item_in_dir`");
    expect(mockRevealedPaths).toEqual([DEST]);
    resetMocks();
    expect(mockRevealedPaths).toEqual([]);
  });
});
