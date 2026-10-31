import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke, listen } from "./bridge";
import { IpcError } from "./errors";
import { deleteInstance, getInstanceSettings, listInstances } from "./instances";
import { resetMocks } from "./mock";
import { clearMockEventListeners } from "./mock/events";
import { reset as resetLaunchMock } from "./mock/handlers/launch";
import { MOCK_DOWNLOADS_DIR, seedMockDownloads } from "./mock/handlers/modpack";
import {
  INSTANCE_NAME_MAX_CHARS,
  blockedFilesOf,
  claimBlockedFiles,
  downloadsFolder,
  installModpack,
  previewModpack,
  summarizePlatformModpack,
  type BlockedFileDto,
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

  it("认领与下载文件夹：folder、files 原样传，下载文件夹不带参数", async () => {
    vi.mocked(tauriInvoke).mockResolvedValueOnce({ claimed: [], missing: [5] }).mockResolvedValueOnce("C:\\Users\\a\\Downloads");
    const file: BlockedFileDto = { project_id: 1, file_id: 5, file_name: "a.jar", web_url: "https://x/files/5", destination: "mods/a.jar", sha1: null, fingerprint: 7, size: null };
    await claimBlockedFiles("D:\\dl", [file]);
    await downloadsFolder();
    expect(vi.mocked(tauriInvoke).mock.calls).toEqual([
      ["claim_blocked_files", { folder: "D:\\dl", files: [file] }],
      ["downloads_folder", undefined],
    ]);
  });

  it("source 是带 kind 的对象，内部字段为 snake_case", async () => {
    vi.mocked(tauriInvoke).mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await previewModpack("D:/a.zip");
    await summarizePlatformModpack("modrinth", "1KVo5zza", "v14");
    await installModpack("t-mp", platform, null, ["mods/a.jar"]);
    expect(vi.mocked(tauriInvoke).mock.calls).toEqual([
      ["preview_modpack", { path: "D:/a.zip" }],
      ["summarize_platform_modpack", { platform: "modrinth", projectId: "1KVo5zza", versionId: "v14" }],
      ["install_modpack", { taskId: "t-mp", source: { kind: "platform", platform: "modrinth", project_id: "1KVo5zza", version_id: "v14" }, name: null, excludedOptional: ["mods/a.jar"] }],
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
    const outcome = await installModpack("t-1", { ...platform, version_id: "fo-641" }, null, []);
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
    const again = await installModpack("t-2", { ...platform, version_id: "fo-641" }, "fabulously optimized", []).catch((e: unknown) => e);
    expect(again).toMatchObject({ code: "instance_name_invalid", detail: { name: "fabulously optimized", rule: "duplicate" } });
  });

  it("本地文件的整合包信息不带平台；去掉首尾空白后的名字作为实例名", async () => {
    const outcome = await installModpack("t-3", local, "  周末联机  ", []);
    expect(outcome.version_id).toBe("周末联机");
    expect(outcome.modpack).toMatchObject({ platform: null, project_id: null, version_id: null, name: "我的整合包", format: "modrinth" });
  });

  it("导入得到的实例不继承已经不在的同名旧实例留下的游玩记录，别的实例的记录不动", async () => {
    // 浏览器里刷新时实例从存储里恢复、游玩记录重新播种：删掉的 1.21 不在了，它的记录却又回来了
    await deleteInstance("1.21");
    resetLaunchMock();
    await installModpack("t-again", local, "1.21", []);
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
      const error = await installModpack(`t-${rule}-${name.length}`, local, name, []).catch((e: unknown) => e);
      expect(error, name).toBeInstanceOf(IpcError);
      expect(error, name).toMatchObject({ code: "instance_name_invalid", detail: { rule } });
    }
    expect((await installModpack("t-ok", local, "樱".repeat(INSTANCE_NAME_MAX_CHARS), [])).version_id).toHaveLength(INSTANCE_NAME_MAX_CHARS);
    expect((await installModpack("t-com0", local, "COM0", [])).version_id).toBe("COM0");
  });

  it("来源不对：平台上没有这个整合包报 mod_version_not_found，形状不对报 unknown，空字段报 invalid_argument", async () => {
    const notPack = await installModpack("t-a", { kind: "platform", platform: "modrinth", project_id: "AANobbMI", version_id: "v" }, null, []).catch(
      (e: unknown) => e,
    );
    expect(notPack).toMatchObject({ code: "mod_version_not_found", detail: { project_id: "AANobbMI" } });
    const malformed = await installModpack("t-b", { kind: "url" } as never, null, []).catch((e: unknown) => e);
    expect(malformed).toMatchObject({ code: "unknown" });
    const blank = await installModpack("t-c", { kind: "file", path: " " }, null, []).catch((e: unknown) => e);
    expect(blank).toMatchObject({ code: "invalid_argument" });
  });

  it("导入途中取消以 cancelled 结束，名字没有被占用", async () => {
    const running = installModpack("t-cancel", local, "取消的包", []).catch((e: unknown) => e);
    expect(await cancelTask("t-cancel")).toBe(true);
    expect(await running).toMatchObject({ code: "cancelled" });
    expect((await installModpack("t-retry", local, "取消的包", [])).version_id).toBe("取消的包");
  });
});

const FILE_A: BlockedFileDto = {
  project_id: 900001,
  file_id: 5000001,
  file_name: "blocked-a.jar",
  web_url: "https://www.curseforge.com/minecraft/mc-mods/blocked-a/files/5000001",
  destination: "mods/blocked-a.jar",
  sha1: "3f786850e387550fdab836ed7e6dc881de23001b",
  fingerprint: 0,
  size: 1024,
};

describe("blockedFilesOf", () => {
  it("只认 distribution_blocked：别的错误码与前端自身的错误都是 null", () => {
    expect(blockedFilesOf(new IpcError("network_failed", "x", { files: [FILE_A] }))).toBeNull();
    expect(blockedFilesOf(new Error("distribution_blocked"))).toBeNull();
    expect(blockedFilesOf("distribution_blocked")).toBeNull();
  });

  it("逐项校验并原样给出清单；可空字段可以是 null，指纹取到 u32 上限", () => {
    const b: BlockedFileDto = { ...FILE_A, project_id: 0, file_id: 4_294_967_295, file_name: "b.zip", destination: "resourcepacks/b.zip", sha1: null, fingerprint: 4_294_967_295, size: null };
    expect(blockedFilesOf(new IpcError("distribution_blocked", "m", { files: [FILE_A, b] }))).toEqual([FILE_A, b]);
  });

  it("形状不对就抛错：没有 detail、旧的文件名数组、空清单、缺字段、负数与小数", () => {
    const cases: [unknown, string][] = [
      [undefined, "没有带 detail"],
      [{ files: ["blocked-a.jar"] }, "[0] 应是对象"],
      [{ files: [] }, "是空的"],
      [{ files: "blocked-a.jar" }, "应是数组"],
      [{ files: [{ ...FILE_A, web_url: undefined }] }, "web_url 应是非空字符串"],
      [{ files: [(({ sha1: _, ...rest }) => rest)(FILE_A)] }, "缺少 sha1"],
      [{ files: [{ ...FILE_A, file_id: -1 }] }, "file_id 应是非负整数"],
      [{ files: [{ ...FILE_A, size: 1.5 }] }, "size 应是非负整数"],
      [{ files: [{ ...FILE_A, file_name: "" }] }, "file_name 应是非空字符串"],
    ];
    for (const [detail, message] of cases) {
      expect(() => blockedFilesOf(new IpcError("distribution_blocked", "m", detail)), message).toThrow(message);
    }
  });
});

describe("整合包 mock：可选文件与需要手动下载的文件", () => {
  const MRPACK: ModpackSource = { kind: "file", path: "D:\\Downloads\\生存.mrpack" };
  const BLOCKED: ModpackSource = { kind: "file", path: "D:\\Downloads\\Blocked-Pack.zip" };
  const capture = async () => {
    const events: CoreEvent[] = [];
    const off = await listen<CoreEvent>(CORE_EVENT, (e) => events.push(e));
    return { events, off };
  };

  it("预览：Mod 清单条数等于 mod_files，按落点排序；.mrpack 带一个可选 Mod 与一个可选资源包，CurseForge 包没有可选文件", async () => {
    const mrpack = await previewModpack("D:\\Downloads\\生存.mrpack");
    expect(mrpack.mods).toHaveLength(mrpack.mod_files);
    expect(mrpack.mods.map((m) => m.path)).toEqual([...mrpack.mods.map((m) => m.path)].sort());
    expect(mrpack.mods.filter((m) => m.optional).map((m) => m.path)).toEqual(["mods/optional-helper.jar"]);
    expect(mrpack.mods.filter((m) => m.availability === "bundled").map((m) => [m.path, m.origin])).toEqual([
      ["mods/config-helper.jar", "override"],
      ["mods/pack-tweaks.jar", "override"],
    ]);
    expect(mrpack.optional_extras).toEqual([
      { path: "resourcepacks/optional-pack.zip", file_name: "optional-pack.zip", origin: "remote", optional: true, project_id: null, file_id: null, availability: "download" },
    ]);
    expect(mrpack.blocked_files).toEqual([]);

    const zip = await previewModpack("D:\\Downloads\\Pack.zip");
    expect(zip.mods).toHaveLength(zip.mod_files);
    expect(zip.mods.some((m) => m.optional)).toBe(false);
    expect(zip.optional_extras).toEqual([]);
    expect(zip.blocked_files).toEqual([]);
  });

  it("带受限文件的包：两个文件进 blocked_files，Mod 清单里标 blocked；认领一个后只剩另一个，那一个标 claimed", async () => {
    const path = "D:\\Downloads\\Blocked-Pack.zip";
    const before = await previewModpack(path);
    expect(before.blocked_files.map((f) => [f.file_id, f.file_name, f.destination, f.web_url])).toEqual([
      [5000001, "blocked-a.jar", "mods/blocked-a.jar", "https://www.curseforge.com/minecraft/mc-mods/blocked-a/files/5000001"],
      [5000002, "blocked-b.jar", "mods/blocked-b.jar", "https://www.curseforge.com/minecraft/mc-mods/blocked-b/files/5000002"],
    ]);
    expect(before.mods).toHaveLength(before.mod_files);
    expect(before.mods.filter((m) => m.availability === "blocked").map((m) => [m.path, m.project_id, m.file_id])).toEqual([
      ["mods/blocked-a.jar", 900001, 5000001],
      ["mods/blocked-b.jar", 900002, 5000002],
    ]);

    seedMockDownloads(["BLOCKED-A.JAR"]);
    expect(await claimBlockedFiles(MOCK_DOWNLOADS_DIR.toUpperCase(), before.blocked_files)).toEqual({
      claimed: [{ file_id: 5000001, source_path: `${MOCK_DOWNLOADS_DIR.toUpperCase()}\\blocked-a.jar` }],
      missing: [5000002],
    });
    const after = await previewModpack(path);
    expect(after.blocked_files.map((f) => f.file_id)).toEqual([5000002]);
    expect(after.mods.filter((m) => m.availability !== "download" && m.availability !== "bundled").map((m) => [m.file_name, m.availability])).toEqual([
      ["blocked-a.jar", "claimed"],
      ["blocked-b.jar", "blocked"],
    ]);
  });

  it("认领：选的不是下载文件夹时都找不到；认领过的文件换个文件夹也算找到（暂存位里有）", async () => {
    seedMockDownloads(["blocked-a.jar", "blocked-b.jar"]);
    const files = (await previewModpack("D:\\Downloads\\blocked.zip")).blocked_files;
    expect(await claimBlockedFiles("D:\\别处", files)).toEqual({ claimed: [], missing: [5000001, 5000002] });
    await claimBlockedFiles(MOCK_DOWNLOADS_DIR, [files[0]]);
    seedMockDownloads([]);
    expect(await claimBlockedFiles("D:\\别处", files)).toEqual({
      claimed: [{ file_id: 5000001, source_path: "D:\\Games\\Launcher\\cache\\modpacks\\claims\\curseforge-5000001\\blocked-a.jar" }],
      missing: [5000002],
    });
  });

  it("认领的参数校验：文件夹为空、清单为空、文件名带路径、file_id 重复报 invalid_argument；清单形状不对是 Tauri 的参数错误", async () => {
    const err = (folder: string, files: unknown) => invoke("claim_blocked_files", { folder, files }).catch((e: unknown) => e);
    expect(await err("  ", [FILE_A])).toMatchObject({ code: "invalid_argument", message: "folder 不能为空" });
    expect(await err(MOCK_DOWNLOADS_DIR, [])).toMatchObject({ code: "invalid_argument", message: "files 不能为空" });
    expect(await err(MOCK_DOWNLOADS_DIR, [{ ...FILE_A, file_name: "..\\x.jar" }])).toMatchObject({ code: "invalid_argument" });
    expect(await err(MOCK_DOWNLOADS_DIR, [{ ...FILE_A, file_name: "a.jar." }])).toMatchObject({ code: "invalid_argument" });
    expect(await err(MOCK_DOWNLOADS_DIR, [FILE_A, { ...FILE_A, file_name: "other.jar" }])).toMatchObject({ code: "invalid_argument", message: "file_id 5000001 出现了不止一次" });
    expect(await err(MOCK_DOWNLOADS_DIR, ["blocked-a.jar"])).toMatchObject({ code: "unknown" });
    expect(await downloadsFolder()).toBe(MOCK_DOWNLOADS_DIR);
  });

  it("导入带受限文件的包：还有没认领的就以 distribution_blocked 失败，清单只列没认领的；都认领后放入手动下载的文件并导入成功", async () => {
    const first = await installModpack("t-b1", BLOCKED, "受限包", []).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(IpcError);
    expect(blockedFilesOf(first)?.map((f) => f.file_name)).toEqual(["blocked-a.jar", "blocked-b.jar"]);
    expect((first as IpcError).message).toBe("这些文件的作者不允许启动器直接下载，需要到 CurseForge 网页手动下载：blocked-a.jar、blocked-b.jar");
    expect((await listInstances()).map((i) => i.id)).not.toContain("受限包");

    seedMockDownloads(["blocked-a.jar"]);
    await claimBlockedFiles(MOCK_DOWNLOADS_DIR, blockedFilesOf(first) ?? []);
    const second = await installModpack("t-b2", BLOCKED, "受限包", []).catch((e: unknown) => e);
    expect(blockedFilesOf(second)?.map((f) => f.file_id)).toEqual([5000002]);

    seedMockDownloads(["blocked-b.jar"]);
    await claimBlockedFiles(MOCK_DOWNLOADS_DIR, blockedFilesOf(second) ?? []);
    const { events, off } = await capture();
    const outcome = await installModpack("t-b3", BLOCKED, "受限包", []);
    off();
    expect(outcome.version_id).toBe("受限包");
    expect(events.filter((e) => e.kind === "stage").map((e) => e.message)).toContain("放入 2 个手动下载的文件");
  });

  it("跳过可选文件：只能跳过包里的可选文件（落点不分大小写），空路径在登记任务前就拒绝；旧日志里没有这个参数照常导入", async () => {
    expect((await installModpack("t-o1", MRPACK, "可选一", ["MODS/Optional-Helper.jar", "resourcepacks/optional-pack.zip"])).version_id).toBe("可选一");
    const stray = await installModpack("t-o2", MRPACK, "可选二", ["mods/pack-mod-01.jar"]).catch((e: unknown) => e);
    expect(stray).toMatchObject({ code: "invalid_argument", detail: { path: "mods/pack-mod-01.jar" } });
    const zip = await installModpack("t-o3", { kind: "file", path: "D:\\Downloads\\Pack.zip" }, "可选三", ["mods/optional-helper.jar"]).catch((e: unknown) => e);
    expect(zip).toMatchObject({ code: "invalid_argument", detail: { path: "mods/optional-helper.jar" } });
    const platformPack = await installModpack("t-o4", { ...platform, version_id: "fo-641" }, "可选四", ["mods/optional-helper.jar"]).catch((e: unknown) => e);
    expect(platformPack).toMatchObject({ code: "invalid_argument" });

    // 空路径不占任务 id：同一个 id 随后照常登记
    const blank = await installModpack("t-o5", MRPACK, "可选五", [" "]).catch((e: unknown) => e);
    expect(blank).toMatchObject({ code: "invalid_argument", message: "excludedOptional 里有空路径" });
    expect((await installModpack("t-o5", MRPACK, "可选五", [])).version_id).toBe("可选五");

    expect((await invoke<{ version_id: string }>("install_modpack", { taskId: "t-o6", source: MRPACK, name: "旧日志" })).version_id).toBe("旧日志");
  });
});
