import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig, updateConfig } from "./config";
import { IpcError } from "./errors";
import { detectJava, installJava } from "./java";
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
