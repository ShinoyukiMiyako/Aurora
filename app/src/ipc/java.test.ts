import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig, updateConfig } from "./config";
import { IpcError } from "./errors";
import { addJavaPath, detectJava, installJava, JAVA_PATH_INVALID, JAVA_RUNTIME_INCOMPLETE, removeJavaPath, switchToDedicatedGpu } from "./java";
import { resetMocks } from "./mock";
import { clearMockEventListeners } from "./mock/events";
import { onCoreEvent, type CoreEvent } from "./tasks";

async function settle<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true),
  );
  while (!done) await vi.advanceTimersByTimeAsync(50);
  return promise;
}

beforeEach(() => {
  resetMocks();
  clearMockEventListeners();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Java", () => {
  it("下载的运行时落在数据目录 runtime/<主版本>/ 下，之后探测为 managed，可设为默认 Java", async () => {
    expect((await detectJava()).map((j) => j.source)).toEqual(["registry", "registry"]);
    const events: CoreEvent[] = [];
    await onCoreEvent((e) => events.push(e));

    const runtime = await settle(installJava("j-1", 21));
    expect(runtime).toEqual({
      component: "java-runtime-delta",
      version: { major: 21, minor: 0, security: 7, build: 0, raw: "21.0.7" },
      java_executable: "D:\\Games\\Launcher\\runtime\\21\\bin\\java.exe",
    });
    const last = events[events.length - 1];
    expect(last).toMatchObject({ kind: "download", task_id: "j-1", total: 320, finished: 320 });

    const managed = (await detectJava()).filter((j) => j.source === "managed");
    expect(managed.map((j) => j.path)).toEqual([runtime.java_executable]);
    await updateConfig({ defaultJava: runtime.java_executable });
    expect((await getConfig()).default_java).toBe(runtime.java_executable);

    // 重装同一主版本不重复登记
    await settle(installJava("j-2", 21));
    expect((await detectJava()).filter((j) => j.source === "managed")).toHaveLength(1);
  });

  it("没有对应主版本的运行时报 java_failed", async () => {
    const error = await settle(installJava("j-3", 11)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IpcError);
    expect((error as IpcError).code).toBe("java_failed");
  });
});

describe("手动添加的 Java", () => {
  async function rejection(path: string): Promise<IpcError> {
    const error = await addJavaPath(path).catch((e: unknown) => e);
    if (!(error instanceof IpcError)) throw new Error(`添加 ${path} 应当失败`);
    return error;
  }

  it("路径不能用时按原因报 java_path_invalid，配置与探测结果都不动", async () => {
    const relative = await rejection("  jdk-21\\bin\\java.exe ");
    expect([relative.code, relative.message, relative.detail]).toEqual([
      JAVA_PATH_INVALID,
      "Java 路径须是绝对路径：jdk-21\\bin\\java.exe",
      { path: "jdk-21\\bin\\java.exe", reason: "not_absolute" },
    ]);
    const notJava = await rejection("D:\\Java\\jdk-21\\bin\\javac.exe");
    expect([notJava.code, notJava.detail]).toEqual([JAVA_PATH_INVALID, { path: "D:\\Java\\jdk-21\\bin\\javac.exe", reason: "not_java_executable" }]);
    const broken = await rejection("D:\\broken\\jdk-21\\bin\\javaw.exe");
    expect([broken.code, broken.detail]).toEqual([JAVA_RUNTIME_INCOMPLETE, { path: "D:\\broken\\jdk-21\\bin\\java.exe", missing: ["release", "lib/modules"] }]);
    expect((await getConfig()).extra_java_paths).toEqual([]);
    expect(await detectJava()).toHaveLength(2);
  });

  it("javaw.exe 按同目录的 java.exe 记，重复添加不重复登记；移除默认 Java 时默认改回 auto", async () => {
    const added = await addJavaPath("\\\\nas\\tools\\JDK17\\bin\\JAVAW.EXE");
    expect([added.path, added.source, added.version.major, added.missing_files]).toEqual(["\\\\nas\\tools\\JDK17\\bin\\java.exe", "manual", 17, []]);
    await addJavaPath("\\\\nas\\tools\\JDK17\\bin\\java.exe");
    expect((await getConfig()).extra_java_paths).toEqual([added.path]);
    expect((await detectJava()).filter((j) => j.source === "manual")).toHaveLength(1);

    await updateConfig({ defaultJava: added.path });
    expect(await removeJavaPath(added.path)).toEqual({ removed: true, default_reset: true });
    const config = await getConfig();
    expect([config.default_java, config.extra_java_paths]).toEqual(["auto", []]);
    expect((await detectJava()).some((j) => j.source === "manual")).toBe(false);
    expect(await removeJavaPath(added.path)).toEqual({ removed: false, default_reset: false });
  });
});

describe("改用独立显卡", () => {
  it("给出 java 时打开独显偏好；路径为空报 invalid_argument，偏好不动", async () => {
    expect((await getConfig()).prefer_dedicated_gpu).toBe(false);
    const empty = await switchToDedicatedGpu("  ").catch((e: unknown) => e);
    expect(empty).toBeInstanceOf(IpcError);
    expect((empty as IpcError).code).toBe("invalid_argument");
    expect((await getConfig()).prefer_dedicated_gpu).toBe(false);

    await switchToDedicatedGpu("C:/Program Files/Java/jdk-21/bin/java.exe");
    expect((await getConfig()).prefer_dedicated_gpu).toBe(true);
    // 设置页能照常关掉，两条路改的是同一个字段
    await updateConfig({ preferDedicatedGpu: false });
    expect((await getConfig()).prefer_dedicated_gpu).toBe(false);
  });
});
