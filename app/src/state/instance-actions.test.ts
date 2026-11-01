// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IpcError } from "../ipc/errors";
import type { InstanceDto } from "../ipc/instances";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, callsOf, cancelledError, deferred, instanceDto, resetRecorder, settle, startedStore, type Deferred } from "../test/launcher";
import { resources } from "./resource";
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

/** 新建实例装好时要写封面：实例设置按传入的原样存下。 */
function stubInstanceSettings(): void {
  const settings = { description: null, cover: null, isolation: "follow_global", memory_mb: null, java: "auto", jvm_args: "", resolution: { width: 854, height: 480 }, fullscreen: false };
  ipc.overrides.set("get_instance_settings", () => settings);
  ipc.overrides.set("set_instance_settings", (args) => args.settings);
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
    expect(store.getState().launchPrompt).toEqual({ instanceId: "生存", occupantId: "创造", occupantPhase: "running", quickPlay: null });

    renameOnDisk("生存", "生存二");
    await store.actions.renameInstance("生存", "生存二");
    expect(store.getState().launchPrompt).toEqual({ instanceId: "生存二", occupantId: "创造", occupantPhase: "running", quickPlay: null });
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

describe("切换游戏目录", () => {
  it("按实例划分的数据、游玩统计与多人游戏列表都重取，与游戏目录无关的不动", async () => {
    const fetched: string[] = [];
    const watch = (key: string) => resources.subscribe(key, async () => fetched.push(key), () => undefined);
    const keys = ["mods:生存", "content:生存", "settings:生存", "history:生存:checks", "play-stats:2024-07-01:2024-07-31", "installed-sources:[\"创造\",\"生存\"]", "match:modrinth:AANobbMI:mod:auto", "servers:known", "servers:pinned", "news"];
    const stops = keys.map(watch);
    await settle();
    expect(fetched.sort()).toEqual([...keys].sort());
    fetched.length = 0;
    ipc.overrides.set("set_game_directory", () => null);
    await store.actions.setGameDirectory("D:/Other/.minecraft");
    await settle();
    expect(fetched.sort()).toEqual(keys.filter((k) => k !== "servers:pinned" && k !== "news").sort());
    for (const stop of stops) stop();
  });
});

describe("侧栏固定的读改写按调用顺序串行", () => {
  let stored: string[];
  let failNextWrite: boolean;

  beforeEach(() => {
    stored = [];
    failNextWrite = false;
    ipc.overrides.set("set_sidebar_pins", (args) => {
      if (failNextWrite) {
        failNextWrite = false;
        throw new IpcError("config_write_failed", "配置写入失败");
      }
      stored = [...(args.pins as string[])];
      return stored;
    });
  });

  it("快速连续固定两个实例：两个都在，顺序与点击顺序一致", async () => {
    await Promise.all([store.actions.togglePin("生存"), store.actions.togglePin("创造")]);
    expect(stored).toEqual(["生存", "创造"]);
    expect(store.getState().sidebarPins).toEqual(["生存", "创造"]);
    expect(callsOf(ipc, "set_sidebar_pins").map((a) => a.pins)).toEqual([["生存"], ["生存", "创造"]]);
  });

  it("新建的实例装好时自动固定，同时取消固定另一个：两次改动都留下", async () => {
    await store.actions.togglePin("生存");
    const install = deferred<{ id: string }>();
    ipc.overrides.set("install_version", () => install.promise);
    stubInstanceSettings();
    await store.actions.createInstance({ name: "新世界", mcVersion: "1.21.1", loader: "vanilla", loaderVersion: null, cover: "grass" });
    await settle();
    // 写入按到达顺序挂起，逐个放行：取消固定还没写完时，装好的实例落地要写固定
    const held: (() => void)[] = [];
    ipc.overrides.set(
      "set_sidebar_pins",
      (args) =>
        new Promise<string[]>((resolve) =>
          held.push(() => {
            stored = [...(args.pins as string[])];
            resolve(stored);
          }),
        ),
    );
    const unpin = store.actions.togglePin("生存");
    instances = [...instances, instanceDto("新世界")];
    install.resolve({ id: "新世界" });
    await settle();
    while (held.length > 0) {
      const release = held.shift();
      if (release === undefined) throw new Error("没有挂起的写入");
      release();
      await settle();
    }
    await unpin;
    expect(stored).toEqual(["新世界"]);
    expect(store.getState().sidebarPins).toEqual(["新世界"]);
  });

  it("前一次写入失败：错误交给它的调用方，后一次照常在原列表上执行", async () => {
    failNextWrite = true;
    const results = await Promise.allSettled([store.actions.togglePin("生存"), store.actions.togglePin("创造")]);
    expect(results[0]).toMatchObject({ status: "rejected", reason: { code: "config_write_failed" } });
    expect(results[1]).toEqual({ status: "fulfilled", value: undefined });
    expect(stored).toEqual(["创造"]);
  });
});

describe("改名、删除后挂在原 id 上的按需数据与游玩统计失效", () => {
  const perInstance = [
    "mods:生存",
    "content:生存",
    "settings:生存",
    "history:生存",
    "history:生存:checks",
    "crash:生存",
    "log:生存",
    "mod-updates:生存",
    "plan:生存:modrinth:AANobbMI:v2",
    "memory-advice:生存",
  ];
  const stats = "play-stats:2024-07-01:2024-07-31";

  /** 先订阅再退订：条目留在缓存里没人订阅，之后有人按同一个 key 订阅时直接拿到它。 */
  async function cacheIdle(keys: readonly string[]): Promise<void> {
    const stops = keys.map((key) => resources.subscribe(key, async () => `「生存」改名或删除前的 ${key}`, () => undefined));
    await settle();
    for (const stop of stops) stop();
  }

  function watchStats(): { fetches: () => number; stop: () => void } {
    let fetches = 0;
    const stop = resources.subscribe(
      stats,
      async () => {
        fetches += 1;
        return fetches;
      },
      () => undefined,
    );
    return { fetches: () => fetches, stop };
  }

  const statuses = () => perInstance.map((key) => resources.snapshot(key).status);
  const allLoading = perInstance.map(() => "loading");

  it("改名后新建同名实例：装好时丢掉原 id 下留着的缓存，新实例页不会读到改名前那个实例的 Mod、设置、日志与安装计划", async () => {
    await cacheIdle(perInstance);
    renameOnDisk("生存", "生存二");
    await store.actions.renameInstance("生存", "生存二");
    expect(statuses()).toEqual(perInstance.map(() => "ready"));

    ipc.overrides.set("install_version", () => {
      instances = [...instances, instanceDto("生存")];
      return { id: "生存" };
    });
    ipc.overrides.set("set_sidebar_pins", (args) => args.pins);
    stubInstanceSettings();
    await store.actions.createInstance({ name: "生存", mcVersion: "1.21.1", loader: "vanilla", loaderVersion: null, cover: "grass" });
    await settle();

    expect(store.getState().toasts.map((t) => t.title)).toContain("「生存」已就绪");
    expect(statuses()).toEqual(allLoading);
  });

  it("把别的实例改成曾经用过的名字：同样丢掉这个名字下留着的缓存", async () => {
    await cacheIdle(perInstance);
    renameOnDisk("生存", "生存二");
    await store.actions.renameInstance("生存", "生存二");
    renameOnDisk("创造", "生存");
    await store.actions.renameInstance("创造", "生存");
    expect(statuses()).toEqual(allLoading);
  });

  it("改名：游玩统计按迁移到新名字下的记录重取，日历不把改了名的实例说成已删除", async () => {
    const watched = watchStats();
    await settle();
    expect(watched.fetches()).toBe(1);
    renameOnDisk("生存", "生存二");
    await store.actions.renameInstance("生存", "生存二");
    await settle();
    expect(watched.fetches()).toBe(2);
    watched.stop();
  });

  it("删除：同名新实例的安装计划与内存建议也从头取；游玩统计去掉已清掉的记录", async () => {
    await cacheIdle(perInstance);
    const watched = watchStats();
    await settle();
    ipc.overrides.set("delete_instance", () => {
      instances = instances.filter((i) => i.id !== "生存");
      return { existed: true };
    });

    await store.actions.deleteInstance("生存", 0);
    await settle();

    expect(statuses()).toEqual(allLoading);
    expect(watched.fetches()).toBe(2);
    watched.stop();
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

describe("新建与导入结束后，占位项留到这次结束触发的重扫落定", () => {
  const spec = { name: "新世界", mcVersion: "1.21.1", loader: "fabric" as const, loaderVersion: "0.16.10", cover: "grass" };
  let install: Deferred<{ id: string }>;
  /** 非 null 时实例列表的下一次请求挂在它上面。 */
  let scan: Deferred<InstanceDto[]> | null;

  beforeEach(() => {
    install = deferred<{ id: string }>();
    scan = null;
    ipc.overrides.set("install_version", () => install.promise);
    ipc.overrides.set("list_instances", () => (scan === null ? instances : scan.promise));
    ipc.overrides.set("set_sidebar_pins", (args) => args.pins);
    stubInstanceSettings();
  });

  const ids = () => store.getState().instances.map((i) => i.id);
  const entry = () => store.getState().instances.find((i) => i.id === "新世界");

  it("装好：任务已完成、落地重扫还没回来时占位项仍在；重扫回来在同一次更新里换成扫描项，不重复", async () => {
    await store.actions.createInstance(spec);
    await settle();
    scan = deferred<InstanceDto[]>();
    install.resolve({ id: "新世界" });
    await settle();
    expect(store.getState().tasks.map((t) => t.status)).toEqual(["done"]);
    expect(entry()).toMatchObject({ placeholder: true, status: "installing", mcVersion: "1.21.1", loader: "fabric" });

    const seen: (boolean | null)[] = [];
    const off = store.subscribe(() => {
      const current = entry();
      seen.push(current === undefined ? null : current.placeholder);
    });
    instances = [...instances, instanceDto("新世界", { mc_version: "1.21.1" })];
    scan.resolve(instances);
    await settle();
    off();
    // 中间没有一次是「列表里没有它」
    expect(seen).not.toContain(null);
    expect(entry()).toMatchObject({ placeholder: false, status: "ready" });
    expect(ids()).toEqual(["生存", "创造", "新世界"]);
    expect(store.getState().toasts.map((t) => t.title)).toContain("「新世界」已就绪");
  });

  it("失败且盘上没留目录：重扫回来之前占位项仍在，重扫回来后移除", async () => {
    await store.actions.createInstance(spec);
    await settle();
    scan = deferred<InstanceDto[]>();
    install.reject(new IpcError("download_failed", "下载源暂时不可用"));
    await settle();
    expect(store.getState().tasks.map((t) => t.status)).toEqual(["failed"]);
    expect(entry()).toMatchObject({ placeholder: true });
    scan.resolve(instances);
    await settle();
    expect(ids()).toEqual(["生存", "创造"]);
  });

  it("失败且盘上留了未完成的目录：由扫描项接替，实例一直在列表里", async () => {
    await store.actions.createInstance(spec);
    await settle();
    scan = deferred<InstanceDto[]>();
    install.reject(new IpcError("download_failed", "下载源暂时不可用"));
    await settle();
    expect(entry()).toMatchObject({ placeholder: true });
    instances = [...instances, instanceDto("新世界", { status: "broken", broken_reason: "安装没有完成" })];
    scan.resolve(instances);
    await settle();
    expect(entry()).toMatchObject({ placeholder: false, status: "broken" });
    expect(ids().filter((id) => id === "新世界")).toHaveLength(1);
  });

  it("落地重扫失败：占位项不再留着，失败照常报出", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await store.actions.createInstance(spec);
    await settle();
    scan = deferred<InstanceDto[]>();
    install.resolve({ id: "新世界" });
    await settle();
    expect(entry()).toMatchObject({ placeholder: true });
    scan.reject(new IpcError("io", "目录读不出来"));
    await settle();
    expect(entry()).toBeUndefined();
    expect(store.getState().toasts.map((t) => t.tone)).toContain("error");
  });

  it("导入整合包失败（后端已清理半成品）：同样留到重扫落定", async () => {
    const pack = deferred<unknown>();
    ipc.overrides.set("install_modpack", () => pack.promise);
    await store.actions.installModpack({
      source: { kind: "file", path: "C:/packs/pack.mrpack" },
      name: "整合包",
      cover: "grass",
      packName: "整合包",
      packVersion: "1.0.0",
      modCount: 12,
      mcVersion: "1.20.1",
      loader: "fabric",
      loaderVersion: "0.16.10",
      excludedOptional: [],
    });
    await settle();
    scan = deferred<InstanceDto[]>();
    pack.reject(new IpcError("modpack_invalid", "清单读不出来"));
    await settle();
    expect(store.getState().instances.find((i) => i.id === "整合包")).toMatchObject({ placeholder: true });
    scan.resolve(instances);
    await settle();
    expect(ids()).toEqual(["生存", "创造"]);
  });

  it("用户正在删除它时不留：取消一到占位项就撤下", async () => {
    ipc.overrides.set("cancel_task", () => {
      install.reject(cancelledError());
      return true;
    });
    await store.actions.createInstance(spec);
    await settle();
    scan = deferred<InstanceDto[]>();
    const deleting = store.actions.deleteInstance("新世界", 0);
    await settle();
    expect(entry()).toBeUndefined();
    scan.resolve(instances);
    scan = null;
    await deleting;
    await settle();
    expect(ids()).toEqual(["生存", "创造"]);
  });
});

describe("装到一半被重扫扫到半成品目录", () => {
  it("扫描项缺版本信息时沿用入队时的版本与加载器；装好重扫后换成扫描到的真实内容", async () => {
    const install = deferred<{ id: string }>();
    ipc.overrides.set("install_version", () => install.promise);
    ipc.overrides.set("set_sidebar_pins", (args) => args.pins);
    stubInstanceSettings();
    await store.actions.createInstance({ name: "新世界", mcVersion: "1.21.1", loader: "fabric", loaderVersion: "0.16.10", cover: "grass" });
    await settle();
    // 后端建好了目录、还没写版本 JSON：扫出来没有版本、没有加载器
    instances = [...instances, instanceDto("新世界", { status: "broken", mc_version: null, loaders: [], activity: "installing" })];
    await store.actions.reload("instances");
    await settle();
    expect(store.getState().instances.find((i) => i.id === "新世界")).toMatchObject({
      placeholder: false,
      status: "installing",
      mcVersion: "1.21.1",
      loader: "fabric",
      loaderVersion: "0.16.10",
    });

    instances = instances.map((i) => (i.id === "新世界" ? instanceDto("新世界", { mc_version: "1.21.1", loaders: [{ kind: "fabric", version: "0.16.11" }] }) : i));
    install.resolve({ id: "新世界" });
    await settle();
    // 装好后以盘上为准：这里故意让扫描结果的加载器版本与入队时不同
    expect(store.getState().instances.find((i) => i.id === "新世界")).toMatchObject({ status: "ready", mcVersion: "1.21.1", loader: "fabric", loaderVersion: "0.16.11" });
  });

  it("补全中的实例扫不出版本时不套用别的任务的内容", async () => {
    const repair = deferred<unknown>();
    ipc.overrides.set("repair_instance", () => repair.promise);
    instances = instances.map((i) => (i.id === "生存" ? instanceDto("生存", { status: "broken", broken_reason: "缺少版本 JSON", mc_version: null, loaders: [] }) : i));
    await store.actions.reload("instances");
    await settle();
    await store.actions.repairInstance("生存");
    await settle();
    expect(store.getState().instances.find((i) => i.id === "生存")).toMatchObject({ status: "installing", mcVersion: null, loader: "vanilla" });
  });
});

describe("重试失败的新建", () => {
  const spec = { name: "新世界", mcVersion: "1.21.1", loader: "fabric" as const, loaderVersion: "0.16.10", cover: "grass" };
  /** 后端失败时保留的目录：带着安装标记，结局是失败。 */
  const leftover = () =>
    instanceDto("新世界", {
      status: "broken",
      broken_reason: "缺少版本 JSON",
      mc_version: null,
      incomplete: { kind: "install", outcome: "failed", started_at: 1_720_000_000_000, spec: { mc_version: "1.21.1", loader: "fabric", loader_version: "0.16.10" }, error: { code: "network_failed", message: "连接超时" } },
    });

  beforeEach(() => {
    ipc.overrides.set("install_version", () => Promise.reject(new IpcError("network_failed", "连接超时")));
    ipc.overrides.set("repair_instance", () => new Promise(() => undefined));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  const commands = () => store.getState().tasks.map((t) => [t.spec.command, t.status]);

  it("盘上留下了带安装标记的目录：重试改排补全，失败的新建那一行撤下", async () => {
    // 失败后的那次重扫才会扫到它：先备好盘上的样子再入队（安装一入队就失败）
    instances = [...instances, leftover()];
    await store.actions.createInstance(spec);
    await settle();
    expect(commands()).toEqual([["install_version", "failed"]]);
    const failed = store.getState().tasks[0];

    store.actions.retryTask(failed.id);
    await settle();
    // 照原样重跑会以名称重复失败，所以不再调 install_version
    expect(callsOf(ipc, "install_version")).toHaveLength(1);
    expect(callsOf(ipc, "repair_instance").map((a) => a.id)).toEqual(["新世界"]);
    expect(commands()).toEqual([["repair_instance", "running"]]);
    expect(store.getState().tasks.some((t) => t.id === failed.id)).toBe(false);
  });

  it("「全部重试」同样改排补全，并计入重试个数", async () => {
    instances = [...instances, leftover()];
    await store.actions.createInstance(spec);
    await settle();
    expect(store.actions.retryFailedTasks()).toBe(1);
    await settle();
    expect(commands()).toEqual([["repair_instance", "running"]]);
    expect(callsOf(ipc, "install_version")).toHaveLength(1);
  });

  it("「全部重试」时补全已在跑：静默跳过，不逐条提示重复，失败的那一行留着", async () => {
    instances = [...instances, leftover()];
    await store.actions.createInstance(spec);
    await settle();
    await store.actions.repairInstance("新世界");
    await settle();
    const toasts = store.getState().toasts.length;
    expect(store.actions.retryFailedTasks()).toBe(0);
    expect(store.getState().toasts).toHaveLength(toasts);
    expect(commands()).toEqual([
      ["install_version", "failed"],
      ["repair_instance", "running"],
    ]);
  });

  it("盘上没留目录：重试照原样重跑 install_version", async () => {
    await store.actions.createInstance(spec);
    await settle();
    store.actions.retryTask(store.getState().tasks[0].id);
    await settle();
    expect(callsOf(ipc, "install_version")).toHaveLength(2);
    expect(callsOf(ipc, "repair_instance")).toEqual([]);
  });

  it("同名目录不是安装留下的（例如已有实例改名撞上）：不改排补全", async () => {
    instances = [...instances, instanceDto("新世界")];
    await store.actions.createInstance(spec);
    await settle();
    store.actions.retryTask(store.getState().tasks[0].id);
    await settle();
    expect(callsOf(ipc, "repair_instance")).toEqual([]);
    expect(callsOf(ipc, "install_version")).toHaveLength(2);
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
