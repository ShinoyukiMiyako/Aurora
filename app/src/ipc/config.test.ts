import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addGameDirectory,
  discoverGameDirectories,
  getConfig,
  inspectGameDirectory,
  listGameDirectories,
  removeGameDirectory,
  setGameDirectory,
  updateConfig,
} from "./config";
import { IpcError } from "./errors";
import { invoke } from "./bridge";
import { detectJava } from "./java";
import { resetMocks } from "./mock";

const DEFAULT_DIR = "D:\\Games\\Launcher\\.minecraft";
const OFFICIAL = "C:\\Users\\player\\AppData\\Roaming\\.minecraft";
const HMCL = "D:\\HMCL\\.minecraft";

async function rejection(promise: Promise<unknown>): Promise<IpcError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(IpcError);
  return error as IpcError;
}

beforeEach(() => {
  resetMocks();
});

describe("全局设置", () => {
  it("新字段有默认值，按补丁逐项写入", async () => {
    const seed = await getConfig();
    expect(seed).toMatchObject({
      after_launch: "minimize",
      check_updates: true,
      default_java: "auto",
      memory: { max_mb: 4096, min_mb: null, auto: true },
      default_game_dir: DEFAULT_DIR,
      skipped_update_version: null,
    });

    await updateConfig({
      afterLaunch: "close",
      checkUpdates: false,
      memory: { max_mb: 6144, min_mb: 1024, auto: false },
      downloadConcurrency: 256,
      skippedUpdateVersion: "0.2.0",
    });
    expect(await getConfig()).toMatchObject({
      after_launch: "close",
      check_updates: false,
      memory: { max_mb: 6144, min_mb: 1024, auto: false },
      download_concurrency: 256,
      skipped_update_version: "0.2.0",
    });
  });

  it("有一个字段不合法整次不生效", async () => {
    const before = await getConfig();
    const error = await rejection(updateConfig({ checkUpdates: false, afterLaunch: "hide" as never }));
    expect(error.code).toBe("invalid_argument");
    expect(error.message).toContain("hide");
    expect((await rejection(updateConfig({ downloadConcurrency: 257 }))).code).toBe("invalid_argument");
    expect((await rejection(updateConfig({ downloadConcurrency: 0 }))).code).toBe("invalid_argument");
    expect((await rejection(updateConfig({ memory: { max_mb: 1023, min_mb: null, auto: true } }))).code).toBe("invalid_argument");
    expect((await rejection(updateConfig({ memory: { max_mb: 2048, min_mb: 2049, auto: true } }))).code).toBe("invalid_argument");
    expect(await getConfig()).toEqual(before);
  });

  it("memory 缺字段或多字段是 Tauri 参数错误，归为 unknown", async () => {
    const missing = await rejection(invoke("update_config", { memory: { max_mb: 4096, min_mb: null } }));
    expect(missing.code).toBe("unknown");
    expect(missing.message).toContain("auto");
    const extra = await rejection(invoke("update_config", { memory: { max_mb: 4096, min_mb: null, auto: true, slider: 3 } }));
    expect(extra.code).toBe("unknown");
    expect((await getConfig()).memory.auto).toBe(true);
  });

  it("默认 Java 只接受 auto 或盘上存在的绝对路径", async () => {
    const [first] = await detectJava();
    await updateConfig({ defaultJava: first.path });
    expect((await getConfig()).default_java).toBe(first.path);
    expect((await rejection(updateConfig({ defaultJava: "bin\\java.exe" }))).code).toBe("invalid_argument");
    expect((await rejection(updateConfig({ defaultJava: "E:\\nope\\bin\\java.exe" }))).message).toContain("不存在");
    await updateConfig({ defaultJava: "auto" });
    expect((await getConfig()).default_java).toBe("auto");
  });
});

describe("跳过首次无障碍引导", () => {
  it("默认开，补丁改了读回一致；不带这个键的补丁不动它", async () => {
    expect((await getConfig()).skip_accessibility_onboarding).toBe(true);
    await updateConfig({ skipAccessibilityOnboarding: false });
    expect((await getConfig()).skip_accessibility_onboarding).toBe(false);
    await updateConfig({ checkUpdates: false });
    expect((await getConfig()).skip_accessibility_onboarding).toBe(false);
    await updateConfig({ skipAccessibilityOnboarding: true });
    expect((await getConfig()).skip_accessibility_onboarding).toBe(true);
  });

  it("不是布尔值是 Tauri 参数错误，归为 unknown，同一次补丁里的其它字段也不生效", async () => {
    const error = await rejection(invoke("update_config", { checkUpdates: false, skipAccessibilityOnboarding: "false" }));
    expect(error).toMatchObject({ code: "unknown", message: "invalid args `skipAccessibilityOnboarding` for command `update_config`: expected a boolean" });
    expect(await getConfig()).toMatchObject({ skip_accessibility_onboarding: true, check_updates: true });
  });
});

describe("游戏目录", () => {
  it("发现只报告盘上存在且未记录的目录，添加后不再出现", async () => {
    expect(await listGameDirectories()).toEqual([{ name: "默认目录", path: DEFAULT_DIR, is_current: true, available: true }]);
    expect(await discoverGameDirectories()).toEqual([
      { name: "官方启动器", path: OFFICIAL },
      { name: "HMCL", path: HMCL },
    ]);
    await addGameDirectory("HMCL", HMCL);
    expect((await discoverGameDirectories()).map((d) => d.path)).toEqual([OFFICIAL]);
    // 同路径（大小写、分隔符不同）只改名字
    await addGameDirectory("我的 HMCL", "d:/hmcl/.minecraft/");
    expect(await listGameDirectories()).toEqual([
      { name: "默认目录", path: DEFAULT_DIR, is_current: true, available: true },
      { name: "我的 HMCL", path: HMCL, is_current: false, available: true },
    ]);
  });

  it("切换后原目录收进额外目录，目标访问不到时拒绝", async () => {
    await setGameDirectory(OFFICIAL);
    expect((await getConfig()).game_dir).toBe(OFFICIAL);
    expect(await listGameDirectories()).toEqual([
      { name: "Roaming", path: OFFICIAL, is_current: true, available: true },
      { name: "默认目录", path: DEFAULT_DIR, is_current: false, available: true },
    ]);

    const unavailable = await rejection(setGameDirectory("E:\\Nope\\.minecraft"));
    expect(unavailable.code).toBe("invalid_game_directory");
    expect(unavailable.detail).toEqual({ path: "E:\\Nope\\.minecraft", problem: "unavailable" });
    expect((await rejection(setGameDirectory("D:\\a!b\\.minecraft"))).detail).toMatchObject({ problem: "contains_bang" });
    expect((await rejection(setGameDirectory("games\\.minecraft"))).detail).toMatchObject({ problem: "not_absolute" });
    expect((await rejection(setGameDirectory("   "))).detail).toEqual({ path: "", problem: "empty" });
    expect((await getConfig()).game_dir).toBe(OFFICIAL);
  });

  it("移除只摘记录，返回是否真的移除了一条", async () => {
    await addGameDirectory("HMCL", HMCL);
    expect(await removeGameDirectory(HMCL)).toBe(true);
    expect(await removeGameDirectory(HMCL)).toBe(false);
    expect(await listGameDirectories()).toHaveLength(1);
  });

  it("检查候选目录是否存在、是否已有游戏文件", async () => {
    expect(await inspectGameDirectory(HMCL)).toEqual({ exists: true, has_versions: true });
    expect(await inspectGameDirectory(DEFAULT_DIR)).toEqual({ exists: true, has_versions: false });
    expect(await inspectGameDirectory("F:\\New\\.minecraft")).toEqual({ exists: false, has_versions: false });
    expect((await rejection(inspectGameDirectory(""))).code).toBe("invalid_game_directory");
  });
});

/** 内存里的 Storage，代替浏览器的 localStorage。 */
class MemoryStorage implements Storage {
  [name: string]: unknown;
  private readonly items = new Map<string, string>();

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
    this.items.set(key, value);
  }
}

describe("界面语言", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("种子是 zh-CN，补丁切到 en-US 再切回", async () => {
    expect((await getConfig()).language).toBe("zh-CN");
    await updateConfig({ language: "en-US" });
    expect((await getConfig()).language).toBe("en-US");
    await updateConfig({ language: "zh-CN" });
    expect((await getConfig()).language).toBe("zh-CN");
  });

  it("不认识的语言报 invalid_argument，同一补丁里别的字段也不生效", async () => {
    await updateConfig({ language: "en-US" });
    for (const bad of ["fr-FR", "zh-cn", "en", ""]) {
      const error = await rejection(updateConfig({ afterLaunch: "keep", language: bad as never }));
      expect(error.code).toBe("invalid_argument");
      expect(error.message).toContain("界面语言");
    }
    expect(await getConfig()).toMatchObject({ language: "en-US", after_launch: "minimize" });
  });

  it("resetMocks 回到 zh-CN", async () => {
    await updateConfig({ language: "en-US" });
    resetMocks();
    expect((await getConfig()).language).toBe("zh-CN");
  });

  it("持久化：刷新后接着上次的语言；没有语言字段的旧版快照启用即报错", async () => {
    const storage = new MemoryStorage();
    vi.resetModules();
    const first = await import("./mock");
    first.enableMockPersistence(storage, "slug");
    await first.mockInvoke("update_config", { language: "en-US" });
    const saved = storage.getItem("slug.mock.config");
    if (saved === null) throw new Error("配置没有落盘");
    const snapshot = JSON.parse(saved) as { version: number; data: { config: Record<string, unknown> } };
    expect(snapshot.data.config.language).toBe("en-US");

    vi.resetModules();
    const second = await import("./mock");
    second.enableMockPersistence(storage, "slug");
    expect(await second.mockInvoke<{ language: string }>("get_config")).toMatchObject({ language: "en-US" });

    const oldConfig = { ...snapshot.data.config };
    delete oldConfig.language;
    const stale = new MemoryStorage();
    stale.setItem("slug.mock.config", JSON.stringify({ version: snapshot.version - 1, data: { ...snapshot.data, config: oldConfig } }));
    vi.resetModules();
    const third = await import("./mock");
    expect(() => third.enableMockPersistence(stale, "slug")).toThrow(`快照版本是 ${snapshot.version - 1}，当前是 ${snapshot.version}`);
    expect(snapshot.version).toBe(3);
  });
});

describe("存档备份设置", () => {
  it("种子：自动备份开着，每个存档留 5 份、总量上限 20 GB；补丁三项一起写", async () => {
    expect((await getConfig()).world_backup).toEqual({ auto: true, keep_per_world: 5, max_total_gb: 20 });
    await updateConfig({ worldBackup: { auto: false, keep_per_world: 10, max_total_gb: 50 } });
    expect((await getConfig()).world_backup).toEqual({ auto: false, keep_per_world: 10, max_total_gb: 50 });
  });

  it("取值范围的两端可以写，越界报 invalid_argument 并指明字段与收到的值，同一补丁里的别的字段也不生效", async () => {
    await updateConfig({ worldBackup: { auto: true, keep_per_world: 1, max_total_gb: 1000 } });
    await updateConfig({ worldBackup: { auto: true, keep_per_world: 50, max_total_gb: 1 } });
    expect((await getConfig()).world_backup).toEqual({ auto: true, keep_per_world: 50, max_total_gb: 1 });
    // 两项都越界时先报份数，与后端的校验顺序一致；正文照后端 validate_world_backup 的原文，设置页把它原样放进提示
    const keepText = (n: number) => `每个存档保留的自动备份份数须在 1 到 50 之间，收到 ${n}`;
    const totalText = (n: number) => `备份总量上限（GB）须在 1 到 1000 之间，收到 ${n}`;
    for (const [patch, field, value, message] of [
      [{ auto: true, keep_per_world: 0, max_total_gb: 20 }, "world_backup.keep_per_world", 0, keepText(0)],
      [{ auto: true, keep_per_world: 51, max_total_gb: 20 }, "world_backup.keep_per_world", 51, keepText(51)],
      [{ auto: true, keep_per_world: 5, max_total_gb: 0 }, "world_backup.max_total_gb", 0, totalText(0)],
      [{ auto: true, keep_per_world: 5, max_total_gb: 1001 }, "world_backup.max_total_gb", 1001, totalText(1001)],
      [{ auto: true, keep_per_world: 99, max_total_gb: 5000 }, "world_backup.keep_per_world", 99, keepText(99)],
    ] as const) {
      const error = await rejection(updateConfig({ afterLaunch: "close", worldBackup: patch }));
      expect(error.code, JSON.stringify(patch)).toBe("invalid_argument");
      expect(error.detail, JSON.stringify(patch)).toEqual({ field, value });
      expect(error.message, JSON.stringify(patch)).toBe(message);
    }
    expect(await getConfig()).toMatchObject({ after_launch: "minimize", world_backup: { auto: true, keep_per_world: 50, max_total_gb: 1 } });
  });

  it("缺字段、多字段或类型不对是 Tauri 参数错误，归为 unknown", async () => {
    for (const raw of [{ auto: true, keep_per_world: 5 }, { auto: true, keep_per_world: 5, max_total_gb: 20, extra: 1 }, { auto: "yes", keep_per_world: 5, max_total_gb: 20 }, { auto: true, keep_per_world: 2.5, max_total_gb: 20 }]) {
      const error = await rejection(invoke("update_config", { worldBackup: raw }));
      expect(error.code, JSON.stringify(raw)).toBe("unknown");
    }
    expect((await getConfig()).world_backup).toEqual({ auto: true, keep_per_world: 5, max_total_gb: 20 });
  });
});
