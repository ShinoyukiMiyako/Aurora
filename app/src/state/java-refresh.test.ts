// @vitest-environment jsdom
// 新建、导入、补全碰到 Forge 系加载器时，缺 Java 后端会自己下载运行时：不重读的话确认页和设置页还说缺它。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IpcError } from "../ipc/errors";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, cancelledError, deferred, instanceDto, resetRecorder, settle, startedStore } from "../test/launcher";
import { resources } from "./resource";
import type { LauncherStore } from "./store";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

const SPEC = { name: "老版本", mcVersion: "1.12.2", loader: "forge", loaderVersion: "14.23.5.2864", cover: "grass" } as const;

let store: LauncherStore;
let majors: number[];
const java = () => Promise.resolve(majors);

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_720_000_000_000);
  resetRecorder(ipc);
  bootOverrides(ipc, { instances: [instanceDto("生存")] });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  store = await startedStore();
  majors = [17];
  expect(await resources.read("java", java)).toEqual([17]);
});
afterEach(() => {
  store.stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("可能顺带下载 Java 的任务落定后", () => {
  it.each([
    ["成功", (done: ReturnType<typeof deferred<{ id: string }>>) => done.resolve({ id: SPEC.name })],
    ["失败", (done: ReturnType<typeof deferred<{ id: string }>>) => done.reject(new IpcError("network_failed", "连接超时"))],
    ["取消", (done: ReturnType<typeof deferred<{ id: string }>>) => done.reject(cancelledError())],
  ])("新建%s：Java 列表重新请求", async (_name, finish) => {
    const install = deferred<{ id: string }>();
    ipc.overrides.set("install_version", () => install.promise);
    ipc.overrides.set("list_instances", () => [instanceDto("生存"), instanceDto(SPEC.name)]);
    await store.actions.createInstance(SPEC);
    await settle();

    majors = [17, 8];
    expect(await resources.read("java", java), "任务还没落定时不重读").toEqual([17]);
    finish(install);
    await settle();

    expect(await resources.read("java", java)).toEqual([17, 8]);
  });

  it("不碰 Java 的任务不让列表重读", async () => {
    const backup = deferred<unknown>();
    ipc.overrides.set("backup_world", () => backup.promise);
    await store.actions.backupWorld("生存", "world", "新的世界");
    await settle();

    majors = [17, 8];
    backup.resolve({ file: "b.zip" });
    await settle();

    expect(await resources.read("java", java)).toEqual([17]);
  });
});
