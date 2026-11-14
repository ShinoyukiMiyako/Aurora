// @vitest-environment jsdom
// 依赖状态容器派生结果的选择器：用真实的状态容器走一遍任务结束与落地重扫，核对选择器与「清除已结束」实际清掉的对得上。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CANCELLED_ERROR_CODE, IpcError } from "../ipc/errors";
import type { InstanceDto } from "../ipc/instances";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, deferred, instanceDto, resetRecorder, settle, startedStore, type Deferred } from "../test/launcher";
import { clearableFinishedCount } from "./selectors";
import type { LauncherStore } from "./store";
import { isFinishedTask } from "./tasks";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

let instances: InstanceDto[];
let store: LauncherStore;
/** 非 null 时实例列表的下一次请求挂在它上面：落地重扫停在半路。 */
let scan: Deferred<InstanceDto[]> | null;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_720_000_000_000);
  resetRecorder(ipc);
  instances = [instanceDto("生存"), instanceDto("创造")];
  scan = null;
  bootOverrides(ipc);
  ipc.overrides.set("list_instances", () => (scan === null ? instances : scan.promise));
  ipc.overrides.set("set_sidebar_pins", (args) => args.pins);
  // 新建实例装好时要写封面：实例设置按传入的原样存下
  const settings = { description: null, cover: null, cover_image: null, background: "follow", background_image: null, isolation: "follow_global", memory_mb: null, java: "auto", jvm_args: "", resolution: { width: 854, height: 480 }, fullscreen: false };
  ipc.overrides.set("get_instance_settings", () => settings);
  ipc.overrides.set("set_instance_settings", (args) => args.settings);
  store = await startedStore();
});
afterEach(() => {
  store.stop();
  vi.useRealTimers();
});

const finished = () => store.getState().tasks.filter(isFinishedTask).length;
const clearable = () => clearableFinishedCount(store.getState());

/** 清掉已结束的之后，任务表里还剩几条已结束的。 */
function leftAfterClear(): number {
  store.actions.clearFinishedTasks();
  return finished();
}

describe("「清除已结束」能清掉的个数", () => {
  it("新建装好、落地重扫还没回来：这条已完成的不计（清除留着它）；重扫回来后计上，清除也清得掉", async () => {
    const install = deferred<{ id: string }>();
    ipc.overrides.set("install_version", () => install.promise);
    await store.actions.createInstance({ name: "新世界", mcVersion: "1.21.1", loader: "fabric", loaderVersion: "0.16.10", cover: "grass" });
    await settle();
    scan = deferred<InstanceDto[]>();
    install.resolve({ id: "新世界" });
    await settle();
    expect(store.getState().tasks.map((t) => t.status)).toEqual(["done"]);
    expect(finished()).toBe(1);
    expect(clearable()).toBe(0);
    expect(leftAfterClear()).toBe(1);
    expect(clearable()).toBe(0);

    instances = [...instances, instanceDto("新世界")];
    scan.resolve(instances);
    scan = null;
    await settle();
    expect(store.getState().instances.find((i) => i.id === "新世界")).toMatchObject({ status: "ready" });
    expect(clearable()).toBe(1);
    expect(leftAfterClear()).toBe(0);
    expect(clearable()).toBe(0);
  });

  it("补全成功、落地重扫还没回来：不计；重扫回来后计上", async () => {
    const repair = deferred<unknown>();
    ipc.overrides.set("repair_instance", () => repair.promise);
    await store.actions.repairInstance("生存");
    await settle();
    scan = deferred<InstanceDto[]>();
    repair.resolve({ reinstalled: false, libraries: 3, assets: 0, natives: 0 });
    await settle();
    expect(store.getState().tasks.map((t) => [t.status, t.spec.command])).toEqual([["done", "repair_instance"]]);
    expect(clearable()).toBe(0);
    expect(leftAfterClear()).toBe(1);

    scan.resolve(instances);
    scan = null;
    await settle();
    expect(clearable()).toBe(1);
    expect(leftAfterClear()).toBe(0);
  });

  it("新建失败、落地重扫还没回来：清除留着它，也就不计；重扫回来后计上，清除也清得掉", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const install = deferred<{ id: string }>();
    ipc.overrides.set("install_version", () => install.promise);
    await store.actions.createInstance({ name: "新世界", mcVersion: "1.21.1", loader: "fabric", loaderVersion: "0.16.10", cover: "grass" });
    await settle();
    scan = deferred<InstanceDto[]>();
    install.reject(new IpcError("network_failed", "连接超时"));
    await settle();
    expect(store.getState().tasks.map((t) => t.status)).toEqual(["failed"]);
    expect(clearable()).toBe(0);
    expect(leftAfterClear()).toBe(1);
    expect(clearable()).toBe(0);

    scan.resolve(instances);
    scan = null;
    await settle();
    expect(clearable()).toBe(1);
    expect(leftAfterClear()).toBe(0);
  });

  it("导入被取消、落地重扫还没回来：同样不计；重扫回来后计上", async () => {
    const run = deferred<unknown>();
    ipc.overrides.set("install_modpack", () => run.promise);
    await store.actions.installModpack({
      source: { kind: "local", path: "D:/包.mrpack" },
      name: "整合包",
      packName: "樱落",
      packVersion: "1.0.0",
      modCount: 3,
      cover: null,
      excludedOptional: [],
      mcVersion: "1.21.1",
      loader: "fabric",
      loaderVersion: "0.16.5",
    } as never);
    await settle();
    scan = deferred<InstanceDto[]>();
    run.reject(new IpcError(CANCELLED_ERROR_CODE, "已取消"));
    await settle();
    expect(store.getState().tasks.map((t) => t.status)).toEqual(["cancelled"]);
    expect(clearable()).toBe(0);
    expect(leftAfterClear()).toBe(1);

    scan.resolve(instances);
    scan = null;
    await settle();
    expect(clearable()).toBe(1);
    expect(leftAfterClear()).toBe(0);
  });

  it("补全失败不落地：结束那一刻就计上，清除清得掉", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const repair = deferred<unknown>();
    ipc.overrides.set("repair_instance", () => repair.promise);
    await store.actions.repairInstance("生存");
    await settle();
    scan = deferred<InstanceDto[]>();
    repair.reject(new IpcError("network_failed", "连接超时"));
    await settle();
    expect(store.getState().tasks.map((t) => t.status)).toEqual(["failed"]);
    expect(clearable()).toBe(1);
    expect(leftAfterClear()).toBe(0);
  });

  it("落地中的那条与别的已结束任务并存：只扣掉落地中的那一条，排队与进行中的不计", async () => {
    const java = deferred<unknown>();
    ipc.overrides.set("install_java", () => java.promise);
    await store.actions.installJava(21);
    await settle();
    java.resolve({ component: "java-runtime-delta", version: { major: 21, minor: 0, security: 1, build: 1, raw: "21.0.1" }, java_executable: "C:/java21.exe" });
    await settle();
    const repair = deferred<unknown>();
    ipc.overrides.set("repair_instance", () => repair.promise);
    await store.actions.repairInstance("生存");
    await settle();
    // 进行中的补全不算已结束
    expect(clearable()).toBe(1);

    scan = deferred<InstanceDto[]>();
    repair.resolve({ reinstalled: false, libraries: 3, assets: 0, natives: 0 });
    await settle();
    expect(finished()).toBe(2);
    expect(clearable()).toBe(1);
    expect(leftAfterClear()).toBe(1);
    expect(clearable()).toBe(0);
  });
});
