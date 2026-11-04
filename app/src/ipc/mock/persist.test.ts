import { afterEach, describe, expect, it, vi } from "vitest";
// 整个假后端几十个模块：静态导入让首次转换在收集测试文件时完成，不计入用例的超时。否则第一个用例里的
// reload() 要现场转换整张模块图，CPU 满载时这一步就要四五秒，用例在 5 秒超时边上随机失败；之后的 reload()
// 只是重新求值，几十毫秒。
import "./index";

/** 内存里的 Storage：可以让写入失败，模拟配额满或站点数据被禁用。 */
class MemoryStorage implements Storage {
  [name: string]: unknown;
  private readonly items = new Map<string, string>();
  writeError: Error | null = null;

  get length(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }

  getItem(key: string): string | null {
    const value = this.items.get(key);
    return value === undefined ? null : value;
  }

  key(index: number): string | null {
    const key = [...this.items.keys()][index];
    return key === undefined ? null : key;
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }

  setItem(key: string, value: string): void {
    if (this.writeError !== null) throw this.writeError;
    this.items.set(key, value);
  }

  keys(): string[] {
    return [...this.items.keys()].sort();
  }
}

type MockCore = typeof import("./index");

/** 重新加载整个假后端，相当于刷新页面：各领域的内存状态回到种子。 */
async function reload(): Promise<MockCore> {
  vi.resetModules();
  return import("./index");
}

const PREFIX = "slug";

afterEach(() => {
  vi.resetModules();
});

describe("mock 持久化", () => {
  it("刷新后首次启动是否完成、外观、配置、账户、实例与 Mod 都接着上次的状态", async () => {
    const storage = new MemoryStorage();
    const first = await reload();
    first.enableMockPersistence(storage, PREFIX);
    await first.mockInvoke("complete_first_run", { gameDir: "D:\\Games\\Launcher\\.minecraft", extraDirectories: [] });
    await first.mockInvoke("set_appearance", { patch: { mode: "night", accent: "moss", petals: false, panorama: true, reduce_motion: true } });
    await first.mockInvoke("update_config", { downloadConcurrency: 16 });
    await first.mockInvoke("create_offline_account", { name: "Steve" });
    await first.mockInvoke("rename_instance", { id: "樱花生存", newName: "樱花二周目" });
    await first.mockInvoke("remove_mod", { versionId: "1.20.1-Fabric", fileName: "handmade-1.0.jar" });
    await first.mockInvoke("install_resource", {
      taskId: "t-rp",
      versionId: "1.21.1-Fabric",
      resourceType: "resource_pack",
      world: null,
      platform: "modrinth",
      projectId: "faithful-32x",
      fileVersionId: "f32-1211",
    });
    await first.mockInvoke("add_java_path", { path: "D:\\Portable\\jdk-17\\bin\\javaw.exe" });
    expect(storage.keys()).toEqual([
      "slug.mock.accounts",
      "slug.mock.appearance",
      "slug.mock.config",
      "slug.mock.discover",
      "slug.mock.instances",
      "slug.mock.java",
      "slug.mock.mods",
      "slug.mock.system",
    ]);

    const second = await reload();
    // 没启用持久化之前就是种子：证明下面读到的确实来自存储。
    expect(await second.mockInvoke("is_first_run")).toBe(true);
    second.enableMockPersistence(storage, PREFIX);
    expect(await second.mockInvoke("is_first_run")).toBe(false);
    expect(await second.mockInvoke("get_appearance")).toEqual({ mode: "night", accent: "moss", petals: false, panorama: true, reduce_motion: true, cover_background: "texture" });
    expect(await second.mockInvoke<{ download_concurrency: number }>("get_config")).toMatchObject({ download_concurrency: 16 });
    // 手动添加的 Java 在配置与探测结果里都还在，不会刷新后变成识别不出。
    const manualExe = "D:\\Portable\\jdk-17\\bin\\java.exe";
    expect(await second.mockInvoke<{ extra_java_paths: string[] }>("get_config")).toMatchObject({ extra_java_paths: [manualExe] });
    const detected = await second.mockInvoke<{ path: string; source: string; version: { major: number } }[]>("detect_java");
    expect(detected.filter((j) => j.source === "manual").map((j) => [j.path, j.version.major])).toEqual([[manualExe, 17]]);
    expect(detected).toHaveLength(3);
    expect((await second.mockInvoke<{ name: string }>("current_account"))?.name).toBe("Steve");
    const ids = (await second.mockInvoke<{ id: string; mod_count: number | null }[]>("list_instances")).map((i) => [i.id, i.mod_count]);
    expect(ids).toContainEqual(["樱花二周目", 12]);
    expect(ids).toContainEqual(["1.20.1-Fabric", 3]);
    expect(ids.some(([id]) => id === "樱花生存")).toBe(false);
    // 装过的资源包刷新后仍认作已装。
    const matrix = await second.mockInvoke<{ version_id: string; state: string }[]>("match_instances", {
      platform: "modrinth",
      projectId: "faithful-32x",
      resourceType: "resource_pack",
      modVersionId: null,
    });
    expect(matrix.find((m) => m.version_id === "1.21.1-Fabric")?.state).toBe("installed");
  });

  it("跳过首次无障碍引导：关掉后刷新仍是关；早先的快照没有这个键时按默认开读入", async () => {
    type StoredConfig = { data: { config: Record<string, unknown> } };
    const KEY = "slug.mock.config";
    const storage = new MemoryStorage();
    const first = await reload();
    first.enableMockPersistence(storage, PREFIX);
    await first.mockInvoke("update_config", { skipAccessibilityOnboarding: false, downloadConcurrency: 16 });

    const second = await reload();
    second.enableMockPersistence(storage, PREFIX);
    const expected = { skip_accessibility_onboarding: false, download_concurrency: 16 };
    expect(await second.mockInvoke("get_config")).toMatchObject(expected);

    const raw = storage.getItem(KEY);
    if (raw === null) throw new Error(`存储里没有 ${KEY}`);
    const saved = JSON.parse(raw) as StoredConfig;
    delete saved.data.config.skip_accessibility_onboarding;
    storage.setItem(KEY, JSON.stringify(saved));

    const third = await reload();
    third.enableMockPersistence(storage, PREFIX);
    expect(await third.mockInvoke("get_config")).toMatchObject({ ...expected, skip_accessibility_onboarding: true });
  });

  it("resetMockData 回到种子并清掉存下的状态，刷新后仍是种子", async () => {
    const storage = new MemoryStorage();
    const first = await reload();
    first.enableMockPersistence(storage, PREFIX);
    await first.mockInvoke("set_appearance", { patch: { mode: "night", accent: "moss", petals: true, panorama: false, reduce_motion: false } });
    first.resetMockData();
    expect(storage.length).toBe(0);
    expect(await first.mockInvoke<{ mode: string }>("get_appearance")).toMatchObject({ mode: "day" });

    const second = await reload();
    second.enableMockPersistence(storage, PREFIX);
    expect(await second.mockInvoke<{ mode: string }>("get_appearance")).toMatchObject({ mode: "day" });
  });

  it("写入失败按真实错误抛给调用方，不当作没存上悄悄继续", async () => {
    const storage = new MemoryStorage();
    const core = await reload();
    core.enableMockPersistence(storage, PREFIX);
    const quota = new Error("QuotaExceededError：存储已满");
    storage.writeError = quota;
    await expect(core.mockInvoke("set_appearance", { patch: { mode: "night", accent: "sakura", petals: true, panorama: false, reduce_motion: false } })).rejects.toBe(quota);
  });

  it("命令本身失败时改过的状态照样落盘，错误仍是命令的错误", async () => {
    const storage = new MemoryStorage();
    const core = await reload();
    core.enableMockPersistence(storage, PREFIX);
    const install = core.mockInvoke("install_version", { taskId: "t-fail", id: "9.9.9", loader: null, loaderVersion: null, targetName: "装不上" });
    await expect(install).rejects.toMatchObject({ code: "install_failed" });
    const text = storage.getItem("slug.mock.instances");
    if (text === null) throw new Error("实例状态没有落盘");
    const saved = JSON.parse(text) as { data: { instances: { dto: { id: string; incomplete: { outcome: string } | null } }[] } };
    expect(saved.data.instances.find((i) => i.dto.id === "装不上")?.dto.incomplete?.outcome).toBe("failed");
  });

  it("存下的数据损坏或快照版本对不上时启用即报错，不丢掉重来", async () => {
    const corrupt = new MemoryStorage();
    corrupt.setItem("slug.mock.appearance", "{oops");
    await expect(reload().then((core) => core.enableMockPersistence(corrupt, PREFIX))).rejects.toThrow(SyntaxError);

    const stale = new MemoryStorage();
    stale.setItem("slug.mock.appearance", JSON.stringify({ version: 0, data: {} }));
    await expect(reload().then((core) => core.enableMockPersistence(stale, PREFIX))).rejects.toThrow("快照版本是 0，当前是 1");
  });

  it("存下的数据读不出时，resetMockData 照样能清掉存储，刷新后从种子开始", async () => {
    const corrupt = new MemoryStorage();
    corrupt.setItem("slug.mock.appearance", "{oops");
    corrupt.setItem("slug.mock.config", JSON.stringify({ version: 0, data: {} }));
    corrupt.setItem("other.key", "kept");
    const broken = await reload();
    expect(() => broken.enableMockPersistence(corrupt, PREFIX)).toThrow(SyntaxError);
    broken.resetMockData();
    expect(corrupt.keys()).toEqual(["other.key"]);

    const next = await reload();
    next.enableMockPersistence(corrupt, PREFIX);
    expect(await next.mockInvoke<{ mode: string }>("get_appearance")).toMatchObject({ mode: "day" });
  });

  it("只能启用一次，前缀不能为空", async () => {
    const core = await reload();
    expect(() => core.enableMockPersistence(new MemoryStorage(), "")).toThrow("键前缀为空");
    core.enableMockPersistence(new MemoryStorage(), PREFIX);
    expect(() => core.enableMockPersistence(new MemoryStorage(), PREFIX)).toThrow("已经启用过");
  });
});
