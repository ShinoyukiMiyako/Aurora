import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listen } from "./bridge";
import { IpcError } from "./errors";
import { getInstanceSettings, listInstances } from "./instances";
import { resetMocks } from "./mock";
import { clearMockEventListeners } from "./mock/events";
import { INSTANCE_NAME_MAX_CHARS, installModpack, previewModpack, type ModpackSource } from "./modpack";
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

  it("source 是带 kind 的对象，内部字段为 snake_case", async () => {
    vi.mocked(tauriInvoke).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await previewModpack("D:/a.zip");
    await installModpack("t-mp", platform, null);
    expect(vi.mocked(tauriInvoke).mock.calls).toEqual([
      ["preview_modpack", { path: "D:/a.zip" }],
      ["install_modpack", { taskId: "t-mp", source: { kind: "platform", platform: "modrinth", project_id: "1KVo5zza", version_id: "v14" }, name: null }],
    ]);
  });
});

describe("整合包 mock", () => {
  it("预览按扩展名认格式，CurseForge 不带远程大小；其它扩展名报 modpack_unsupported_extension", async () => {
    expect(await previewModpack("D:/下载/我的整合包.mrpack")).toMatchObject({ format: "modrinth", name: "我的整合包", remote_bytes: 96_468_992 });
    expect(await previewModpack("D:/下载/Pack.ZIP")).toMatchObject({ format: "curseforge", name: "Pack", remote_bytes: null });
    const jar = await previewModpack("D:/下载/sodium.jar").catch((e: unknown) => e);
    expect(jar).toMatchObject({ code: "modpack_unsupported_extension", detail: { path: "D:/下载/sodium.jar" } });
    expect(await previewModpack(" ").catch((e: unknown) => e)).toMatchObject({ code: "invalid_argument" });
  });

  it("平台整合包导入为新实例：名字缺省取整合包名，记下来源，事件带本任务 id", async () => {
    const events: CoreEvent[] = [];
    const off = await listen<CoreEvent>(CORE_EVENT, (e) => events.push(e));
    const outcome = await installModpack("t-1", platform, null);
    off();
    expect(outcome.version_id).toBe("Fabulously Optimized");
    expect(outcome.version_dir).toBe("D:/Games/.minecraft/versions/Fabulously Optimized");
    expect(outcome.modpack).toMatchObject({ format: "modrinth", platform: "modrinth", project_id: "1KVo5zza", version_id: "v14", name: "Fabulously Optimized" });
    // 导入的实例出现在实例列表里，设置为强制隔离。
    expect((await listInstances()).map((i) => i.id)).toContain("Fabulously Optimized");
    expect((await getInstanceSettings("Fabulously Optimized")).isolation).toBe("enabled");
    expect(events.every((e) => e.task_id === "t-1")).toBe(true);
    expect(events.at(-1)).toEqual({ task_id: "t-1", kind: "stage", message: "整合包已导入为实例 Fabulously Optimized" });

    // 同名再导入一次：不区分大小写的重名。
    const again = await installModpack("t-2", platform, "fabulously optimized").catch((e: unknown) => e);
    expect(again).toMatchObject({ code: "instance_name_invalid", detail: { name: "fabulously optimized", rule: "duplicate" } });
  });

  it("本地文件的整合包信息不带平台；去掉首尾空白后的名字作为实例名", async () => {
    const outcome = await installModpack("t-3", local, "  周末联机  ");
    expect(outcome.version_id).toBe("周末联机");
    expect(outcome.modpack).toMatchObject({ platform: null, project_id: null, version_id: null, name: "我的整合包", format: "modrinth" });
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
