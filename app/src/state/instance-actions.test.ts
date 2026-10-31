// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IpcError } from "../ipc/errors";
import type { InstanceDto } from "../ipc/instances";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, callsOf, cancelledError, deferred, instanceDto, resetRecorder, settle, startedStore, type Deferred } from "../test/launcher";
import { isActiveTask } from "./tasks";
import type { LauncherStore } from "./store";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

let instances: InstanceDto[];
let store: LauncherStore;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_720_000_000_000);
  resetRecorder(ipc);
  instances = [instanceDto("生存"), instanceDto("创造")];
  bootOverrides(ipc);
  ipc.overrides.set("list_instances", () => instances);
  store = await startedStore();
});
afterEach(() => {
  store.stop();
  vi.useRealTimers();
});

function renameOnDisk(from: string, to: string): void {
  ipc.overrides.set("rename_instance", () => {
    instances = instances.map((i) => (i.id === from ? { ...i, id: to } : i));
    return { id: to };
  });
}

describe("改实例设置后按需重扫实例列表", () => {
  const settings = { description: null, cover: null, isolation: "follow_global", memory_mb: null, java: "auto", jvm_args: "", resolution: { width: 854, height: 480 }, fullscreen: false };

  it.each([
    ["隔离（换工作目录，存档数与 Mod 数跟着变）", { isolation: "enabled" as const }, 1],
    ["自定内存", { memoryMb: 4096 }, 1],
    ["简介", { description: "生存服" }, 1],
    ["封面", { cover: "grass" }, 1],
    ["JVM 参数（列表里没有它）", { jvmArgs: "-XX:+UseG1GC" }, 0],
    ["分辨率（列表里没有它）", { resolution: { width: 1280, height: 720 } }, 0],
  ])("%s", async (_name, patch, rescans) => {
    ipc.overrides.set("get_instance_settings", () => settings);
    ipc.overrides.set("set_instance_settings", (args) => args.settings);
    const before = callsOf(ipc, "list_instances").length;
    await store.actions.updateInstanceSettings("生存", patch);
    expect(callsOf(ipc, "list_instances").length - before).toBe(rescans);
    expect(callsOf(ipc, "set_instance_settings")).toHaveLength(1);
  });
});

describe("改名迁移启动会话", () => {
  it("启动失败的会话随改名换成新 id：重试按新名字启动，查看日志也落到新名字", async () => {
    ipc.overrides.set("launch_game", () => {
      throw new IpcError("version_broken", "找不到启动入口");
    });
    await store.actions.launch("生存");
    expect(store.getState().session).toMatchObject({ instanceId: "生存", phase: "failed" });

    renameOnDisk("生存", "生存二");
    expect(await store.actions.renameInstance("生存", "生存二")).toBe("生存二");
    expect(store.getState().session).toMatchObject({ instanceId: "生存二", phase: "failed" });

    expect(store.actions.failureFix("open_logs")).toEqual({ to: { page: "instance", id: "生存二", tab: "logs" } });
    const retry = store.actions.failureFix("retry");
    if (!("run" in retry)) throw new Error("重试应是命令类修复动作");
    ipc.overrides.set("launch_game", () => ({ pid: 4242 }));
    await retry.run();
    expect(callsOf(ipc, "launch_game").map((a) => a.versionId)).toEqual(["生存", "生存二"]);
  });

  it("替换确认里的两个实例也换成新 id；与改名无关的会话不动", async () => {
    ipc.overrides.set("launch_game", () => ({ pid: 1 }));
    await store.actions.launch("创造");
    await store.actions.launch("生存");
    expect(store.getState().launchPrompt).toEqual({ instanceId: "生存", occupantId: "创造", occupantPhase: "running" });

    renameOnDisk("生存", "生存二");
    await store.actions.renameInstance("生存", "生存二");
    expect(store.getState().launchPrompt).toEqual({ instanceId: "生存二", occupantId: "创造", occupantPhase: "running" });
    expect(store.getState().session).toMatchObject({ instanceId: "创造", phase: "running" });
    await settle();
  });
});

describe("游玩记录没跟上时改名、删除照成功处理", () => {
  const lagged = (message: string, detail: Record<string, unknown>) => new IpcError("play_records_failed", message, { ...detail, causes: ["拒绝访问。 (os error 5)"] });

  it("改名：按 detail.renamed_to 迁移界面上挂在旧 id 上的状态，再提示记录之后补上", async () => {
    ipc.overrides.set("launch_game", () => {
      throw new IpcError("version_broken", "找不到启动入口");
    });
    await store.actions.launch("生存");
    ipc.overrides.set("rename_instance", () => {
      instances = instances.map((i) => (i.id === "生存" ? { ...i, id: "生存二" } : i));
      throw lagged("实例已改名为「生存二」，但游玩记录没能跟着改：拒绝访问。 (os error 5)", { id: "生存", renamed_to: "生存二" });
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await store.actions.renameInstance("生存", "生存二")).toBe("生存二");
    expect(store.getState().session).toMatchObject({ instanceId: "生存二", phase: "failed" });
    expect(store.getState().instances.map((i) => i.id).sort()).toEqual(["创造", "生存二"]);
    expect(store.getState().toasts.map((t) => [t.tone, t.title, t.body])).toContainEqual(["warning", "「生存二」的游玩记录没能跟着改", "之后会自动补上"]);
    expect(warn.mock.calls[0][0]).toBe("实例已改名为「生存二」，但游玩记录没能跟着改：拒绝访问。 (os error 5)");
  });

  it("改名报别的错照常抛出，界面状态不迁移；报这个码却缺 renamed_to 是契约被破坏", async () => {
    ipc.overrides.set("launch_game", () => {
      throw new IpcError("version_broken", "找不到启动入口");
    });
    await store.actions.launch("生存");
    ipc.overrides.set("rename_instance", () => {
      throw new IpcError("instance_busy", "「生存」正在补全文件", { id: "生存", activity: "installing" });
    });
    await expect(store.actions.renameInstance("生存", "生存二")).rejects.toMatchObject({ code: "instance_busy" });
    ipc.overrides.set("rename_instance", () => {
      throw lagged("实例已改名为「生存二」，但游玩记录没能跟着改：拒绝访问。 (os error 5)", { id: "生存" });
    });
    await expect(store.actions.renameInstance("生存", "生存二")).rejects.toThrow("改名报 play_records_failed 却没给出 detail.renamed_to");
    expect(store.getState().session).toMatchObject({ instanceId: "生存", phase: "failed" });
    expect(store.getState().toasts.map((t) => t.title)).not.toContain("「生存二」的游玩记录没能跟着改");
  });

  it("删除：照删除成功清理并通知，另提示记录之后补上", async () => {
    ipc.overrides.set("delete_instance", () => {
      instances = instances.filter((i) => i.id !== "生存");
      throw lagged("实例已删除，但游玩记录没能跟着改：拒绝访问。 (os error 5)", { id: "生存" });
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await store.actions.deleteInstance("生存", 2);
    expect(store.getState().instances.map((i) => i.id)).toEqual(["创造"]);
    expect(store.getState().toasts.map((t) => [t.tone, t.title, t.body])).toEqual(
      expect.arrayContaining([
        ["info", "已删除「生存」", "2 个存档已移入回收站"],
        ["warning", "「生存」的游玩记录没能跟着改", "之后会自动补上"],
      ]),
    );
  });

  it("删除报别的错照常抛出，不弹「已删除」", async () => {
    ipc.overrides.set("delete_instance", () => {
      throw new IpcError("io", "拒绝访问");
    });
    await expect(store.actions.deleteInstance("生存", 0)).rejects.toMatchObject({ code: "io" });
    expect(store.getState().toasts.map((t) => t.title)).not.toContain("已删除「生存」");
  });
});

describe("改名迁移任务", () => {
  it("失败的任务重试时按新名字调用命令，落地通知写新名字；下载中的 Java 装好后固定给新名字", async () => {
    let fail = true;
    ipc.overrides.set("install_resource", () => {
      if (fail) throw new IpcError("download_failed", "下载源暂时不可用");
      return { resource_type: "shader", world: null, file_name: "bsl.zip" };
    });
    await store.actions.installResource({
      resourceType: "shader",
      platform: "modrinth",
      projectId: "bsl",
      name: "BSL",
      targets: [{ instanceId: "生存", fileVersionId: "b1", world: null }],
    });
    const java = deferred<unknown>();
    ipc.overrides.set("install_java", () => java.promise);
    await store.actions.installJava(21, { pinFor: "生存" });
    await settle();
    const [failed] = store.getState().tasks;
    expect(failed.status).toBe("failed");

    renameOnDisk("生存", "生存二");
    await store.actions.renameInstance("生存", "生存二");
    expect(store.getState().tasks[0]).toMatchObject({ instanceId: "生存二", spec: { args: { versionId: "生存二" } } });

    fail = false;
    store.actions.retryTask(failed.id);
    await settle();
    expect(callsOf(ipc, "install_resource").map((a) => a.versionId)).toEqual(["生存", "生存二"]);
    expect(store.getState().toasts.map((t) => t.body)).toContain("已设为「生存二」的当前光影");

    const settings = { description: null, cover: null, isolation: "follow_global", memory_mb: null, java: "auto", jvm_args: "", resolution: { width: 854, height: 480 }, fullscreen: false };
    ipc.overrides.set("get_instance_settings", () => settings);
    ipc.overrides.set("set_instance_settings", (args) => args.settings);
    java.resolve({ component: "java-runtime-delta", version: { major: 21, minor: 0, security: 5, build: 11, raw: "21.0.5" }, java_executable: "C:/jdk21/bin/java.exe" });
    await settle();
    expect(callsOf(ipc, "set_instance_settings").map((a) => a.id)).toEqual(["生存二"]);
  });
});

describe("删除实例时取消它的全部任务", () => {
  it("3 个运行中、2 个排队：排队的不再被拉起，运行中的都取消并落定后才删除目录", async () => {
    const running = new Map<string, Deferred<unknown>>();
    ipc.overrides.set("install_resource", (args) => {
      const d = deferred<unknown>();
      running.set(String(args.taskId), d);
      return d.promise;
    });
    ipc.overrides.set("cancel_task", (args) => {
      const d = running.get(String(args.taskId));
      if (d === undefined) return false;
      d.reject(cancelledError());
      return true;
    });
    let activeAtDelete: number | null = null;
    ipc.overrides.set("delete_instance", () => {
      activeAtDelete = store.getState().tasks.filter(isActiveTask).length;
      instances = instances.filter((i) => i.id !== "生存");
      return null;
    });
    for (const project of ["a", "b", "c", "d", "e"]) {
      await store.actions.installResource({
        resourceType: "resource_pack",
        platform: "modrinth",
        projectId: project,
        name: `材质 ${project}`,
        targets: [{ instanceId: "生存", fileVersionId: `${project}-1`, world: null }],
      });
    }
    // 另一个实例的任务不受影响
    await store.actions.installResource({
      resourceType: "resource_pack",
      platform: "modrinth",
      projectId: "f",
      name: "材质 f",
      targets: [{ instanceId: "创造", fileVersionId: "f-1", world: null }],
    });
    await settle();
    expect(store.getState().tasks.map((t) => t.status)).toEqual(["running", "running", "running", "queued", "queued", "queued"]);

    await store.actions.deleteInstance("生存", 0);
    await settle();

    expect(activeAtDelete).toBe(1);
    expect(callsOf(ipc, "cancel_task")).toHaveLength(3);
    // 排队的两个从没发出过命令；另一个实例的任务在通道空出后开始
    expect(callsOf(ipc, "install_resource").map((a) => a.versionId)).toEqual(["生存", "生存", "生存", "创造"]);
    const byInstance = store.getState().tasks.map((t) => [t.instanceId, t.status]);
    expect(byInstance).toEqual([
      ["生存", "cancelled"],
      ["生存", "cancelled"],
      ["生存", "cancelled"],
      ["生存", "cancelled"],
      ["生存", "cancelled"],
      ["创造", "running"],
    ]);
    expect(store.getState().instances.map((i) => i.id)).toEqual(["创造"]);
  });
});

describe("新建实例入队即成为当前实例，侧栏有空位时安装期间就固定", () => {
  const spec = { name: "新世界", mcVersion: "1.21.1", loader: "vanilla" as const, loaderVersion: null, cover: "grass" };
  let install: Deferred<{ id: string }>;

  async function restart(pins: string[]): Promise<void> {
    store.stop();
    resetRecorder(ipc);
    bootOverrides(ipc, { pins });
    instances = [instanceDto("生存"), instanceDto("创造")];
    ipc.overrides.set("list_instances", () => instances);
    install = deferred<{ id: string }>();
    ipc.overrides.set("install_version", () => install.promise);
    ipc.overrides.set("set_sidebar_pins", (args) => args.pins);
    const settings = { description: null, cover: null, isolation: "follow_global", memory_mb: null, java: "auto", jvm_args: "", resolution: { width: 854, height: 480 }, fullscreen: false };
    ipc.overrides.set("get_instance_settings", () => settings);
    ipc.overrides.set("set_instance_settings", (args) => args.settings);
    store = await startedStore();
  }

  async function finish(): Promise<void> {
    instances = [...instances, instanceDto("新世界")];
    install.resolve({ id: "新世界" });
    await settle();
  }

  it("有空位：占位项排在侧栏末尾并设为当前实例；装好后写进固定列表", async () => {
    await restart(["生存"]);
    await store.actions.createInstance(spec);
    expect(store.getState().selectedInstanceId).toBe("新世界");
    expect(callsOf(ipc, "update_config")).toEqual([{ selectedVersion: "新世界" }]);
    expect(store.getState().sidebarPins).toEqual(["生存", "新世界"]);
    expect(store.getState().instances.find((i) => i.id === "新世界")).toMatchObject({ placeholder: true, pinned: true, status: "installing" });
    // 实例目录装好前后端不认这个 id，不写固定列表
    expect(callsOf(ipc, "set_sidebar_pins")).toEqual([]);

    await finish();
    expect(callsOf(ipc, "set_sidebar_pins")).toEqual([{ pins: ["生存", "新世界"] }]);
    expect(store.getState().sidebarPins).toEqual(["生存", "新世界"]);
  });

  it("侧栏已满 5 个：不固定，装好后也不固定", async () => {
    await restart(["a", "b", "c", "d", "e"]);
    await store.actions.createInstance(spec);
    expect(store.getState().sidebarPins).toEqual(["a", "b", "c", "d", "e"]);
    await finish();
    expect(callsOf(ipc, "set_sidebar_pins")).toEqual([]);
  });

  it("安装期间取消固定：只改装好后的打算，不调后端；拖动排序不把占位项写进固定列表", async () => {
    await restart(["生存"]);
    await store.actions.createInstance(spec);
    await store.actions.setSidebarPins(["新世界", "生存"]);
    expect(callsOf(ipc, "set_sidebar_pins")).toEqual([{ pins: ["生存"] }]);
    await store.actions.togglePin("新世界");
    expect(store.getState().sidebarPins).toEqual(["生存"]);
    expect(callsOf(ipc, "set_sidebar_pins")).toHaveLength(1);
    await finish();
    expect(callsOf(ipc, "set_sidebar_pins")).toHaveLength(1);
  });

  it("新建流程收尾再设一次当前实例时不重复写配置", async () => {
    await restart([]);
    await store.actions.createInstance(spec);
    await store.actions.selectInstance("新世界");
    expect(callsOf(ipc, "update_config")).toEqual([{ selectedVersion: "新世界" }]);
    await store.actions.selectInstance("生存");
    expect(callsOf(ipc, "update_config")).toEqual([{ selectedVersion: "新世界" }, { selectedVersion: "生存" }]);
  });

  it("占位项占着第 5 个位置时，再固定别的实例按已满处理", async () => {
    await restart(["a", "b", "c", "d"]);
    await store.actions.createInstance(spec);
    await store.actions.togglePin("创造");
    expect(callsOf(ipc, "set_sidebar_pins")).toEqual([]);
    expect(store.getState().toasts.map((t) => t.tone)).toContain("warning");
  });
});

describe("删除还在安装的新建实例", () => {
  const spec = { name: "新世界", mcVersion: "1.21.1", loader: "vanilla" as const, loaderVersion: null, cover: "grass" };
  let install: Deferred<{ id: string }>;

  beforeEach(() => {
    install = deferred<{ id: string }>();
    ipc.overrides.set("install_version", () => install.promise);
    ipc.overrides.set("set_sidebar_pins", (args) => args.pins);
    const settings = { description: null, cover: null, isolation: "follow_global", memory_mb: null, java: "auto", jvm_args: "", resolution: { width: 854, height: 480 }, fullscreen: false };
    ipc.overrides.set("get_instance_settings", () => settings);
    ipc.overrides.set("set_instance_settings", (args) => args.settings);
    ipc.overrides.set("delete_instance", (args) => {
      const existed = instances.some((i) => i.id === args.id);
      instances = instances.filter((i) => i.id !== args.id);
      return { existed };
    });
  });

  it("安装恰好在取消宽限期内做完：接着删掉装好的实例，不写封面、不固定、不弹「已就绪」", async () => {
    // 取消到达时安装正在运行；它没观察到令牌就做完了，后端照常返回成功
    ipc.overrides.set("cancel_task", () => true);
    await store.actions.createInstance(spec);
    await settle();
    expect(store.getState().tasks.map((t) => t.status)).toEqual(["running"]);

    const deleting = store.actions.deleteInstance("新世界", 0);
    await settle();
    instances = [...instances, instanceDto("新世界")];
    install.resolve({ id: "新世界" });
    await deleting;
    await settle();

    expect(callsOf(ipc, "delete_instance")).toEqual([{ id: "新世界" }]);
    expect(instances.map((i) => i.id)).toEqual(["生存", "创造"]);
    expect(store.getState().instances.map((i) => i.id)).toEqual(["生存", "创造"]);
    expect(callsOf(ipc, "set_instance_settings")).toEqual([]);
    expect(callsOf(ipc, "set_sidebar_pins")).toEqual([]);
    const titles = store.getState().toasts.map((t) => t.title);
    expect(titles).toContain("已删除「新世界」");
    expect(titles).not.toContain("「新世界」已就绪");
  });

  it("取消到达前安装就失败、留下了未完成的实例：同样删掉它", async () => {
    ipc.overrides.set("cancel_task", () => false);
    await store.actions.createInstance(spec);
    await settle();
    const deleting = store.actions.deleteInstance("新世界", 0);
    instances = [...instances, instanceDto("新世界", { status: "broken", broken_reason: "缺少版本 JSON" })];
    install.reject(new IpcError("download_failed", "下载源暂时不可用"));
    await deleting;
    await settle();
    expect(callsOf(ipc, "delete_instance")).toEqual([{ id: "新世界" }]);
    expect(store.getState().instances.map((i) => i.id)).toEqual(["生存", "创造"]);
  });

  it("取消赶上了：后端已经删掉半成品，不再调删除命令", async () => {
    ipc.overrides.set("cancel_task", () => {
      install.reject(cancelledError());
      return true;
    });
    await store.actions.createInstance(spec);
    await settle();
    await store.actions.deleteInstance("新世界", 0);
    await settle();
    expect(callsOf(ipc, "delete_instance")).toEqual([]);
    expect(store.getState().tasks.map((t) => t.status)).toEqual(["cancelled"]);
    expect(store.getState().instances.map((i) => i.id)).toEqual(["生存", "创造"]);
    expect(store.getState().toasts.map((t) => t.title)).toContain("已删除「新世界」");
  });

  it("删除已有实例时补全恰好做完：不弹「已修复」，照常删除", async () => {
    const repair = deferred<unknown>();
    ipc.overrides.set("repair_instance", () => repair.promise);
    ipc.overrides.set("cancel_task", () => true);
    await store.actions.repairInstance("生存");
    await settle();
    const deleting = store.actions.deleteInstance("生存", 0);
    await settle();
    repair.resolve({ reinstalled: false, libraries: 0, assets: 0, natives: 0 });
    await deleting;
    await settle();
    expect(callsOf(ipc, "delete_instance")).toEqual([{ id: "生存" }]);
    const titles = store.getState().toasts.map((t) => t.title);
    expect(titles).not.toContain("「生存」已修复");
    expect(titles).toContain("已删除「生存」");
  });
});
