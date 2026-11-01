// @vitest-environment jsdom
// 改名后留着的通知：动作跟着实例走。闭包里的启动、修复与路由里的实例页都落到新名字；旧名字被别的实例用上时，
// 留着的通知仍指向改了名的那个实例，新发的通知指向现在叫这个名字的实例。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IpcError } from "../ipc/errors";
import type { BackupResultDto, InstanceDto } from "../ipc/instances";
import { GAME_EXIT_EVENT } from "../ipc/launch";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, callsOf, emit, instanceDto, resetRecorder, settle, startedStore } from "../test/launcher";
import type { LauncherStore } from "./store";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

const JDK_21 = { component: "java-runtime-delta", version: { major: 21, minor: 0, security: 5, build: 11, raw: "21.0.5" }, java_executable: "C:/jdk21/bin/java.exe" };

let instances: InstanceDto[];
let store: LauncherStore;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_720_000_000_000);
  resetRecorder(ipc);
  instances = [instanceDto("生存"), instanceDto("创造")];
  bootOverrides(ipc);
  ipc.overrides.set("list_instances", () => instances);
  ipc.overrides.set("launch_game", () => ({ pid: 1 }));
  ipc.overrides.set("last_crash", () => null);
  ipc.overrides.set("repair_instance", () => ({ reinstalled: true, libraries: 1, assets: 0, natives: 0 }));
  store = await startedStore();
});

afterEach(() => {
  store.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function rename(from: string, to: string): Promise<void> {
  ipc.overrides.set("rename_instance", () => {
    instances = instances.map((i) => (i.id === from ? { ...i, id: to } : i));
    return { id: to };
  });
  await store.actions.renameInstance(from, to);
  await settle();
}

async function remove(id: string): Promise<void> {
  ipc.overrides.set("delete_instance", () => {
    instances = instances.filter((i) => i.id !== id);
    return { existed: true };
  });
  await store.actions.deleteInstance(id, 0);
  await settle();
}

async function create(id: string): Promise<void> {
  ipc.overrides.set("install_version", () => {
    instances = [...instances, instanceDto(id)];
    return { id };
  });
  ipc.overrides.set("set_sidebar_pins", (args) => args.pins);
  const settings = { description: null, cover: null, isolation: "follow_global", memory_mb: null, java: "auto", jvm_args: "", resolution: { width: 854, height: 480 }, fullscreen: false };
  ipc.overrides.set("get_instance_settings", () => settings);
  ipc.overrides.set("set_instance_settings", (args) => args.settings);
  await store.actions.createInstance({ name: id, mcVersion: "1.21.1", loader: "vanilla", loaderVersion: null, cover: "grass" });
  await settle();
}

/** 补全完成：发一条带「启动」的「已修复」通知。 */
async function repaired(id: string): Promise<void> {
  await store.actions.repairInstance(id);
  await settle();
}

function toast(title: string) {
  const found = store.getState().toasts.find((t) => t.title === title);
  if (found === undefined) throw new Error(`没有标题为「${title}」的通知`);
  return found;
}

function routeOf(title: string) {
  const action = toast(title).action;
  if (action === undefined || !("to" in action)) throw new Error(`「${title}」没有导航动作`);
  return action.to;
}

/** 与外壳的 runToastAction 一样，先关掉这条再执行。 */
async function click(title: string): Promise<void> {
  const found = toast(title);
  const action = found.action;
  if (action === undefined || !("run" in action)) throw new Error(`「${title}」没有可执行的动作`);
  store.actions.dismissToast(found.id);
  await action.run();
  await settle();
}

/** 点通知上的「启动」，返回实际启动的实例；再让这一局结束，下一次点击不撞替换确认。 */
async function launchedBy(title: string): Promise<unknown> {
  await click(title);
  const launched = callsOf(ipc, "launch_game").at(-1);
  if (launched === undefined) throw new Error(`点「${title}」没有发起启动`);
  emit(GAME_EXIT_EVENT, { version_id: launched.versionId, exit_code: 0, crashed: false, killed: false, duration_ms: 1000 });
  await settle();
  return launched.versionId;
}

describe("改名后点击留着的通知：闭包动作", () => {
  it("新建已就绪的「启动」：启动新名字，不报实例不存在", async () => {
    await create("新世界");
    await rename("新世界", "老世界");
    expect(await launchedBy("「新世界」已就绪")).toBe("老世界");
    expect(store.getState().session).toMatchObject({ instanceId: "老世界" });
  });

  it("已修复的「启动」：启动新名字", async () => {
    await repaired("生存");
    await rename("生存", "生存二");
    expect(await launchedBy("「生存」已修复")).toBe("生存二");
  });

  it("Java 下载完的「启动」：启动新名字", async () => {
    ipc.overrides.set("install_java", () => JDK_21);
    await store.actions.installJava(21, { launchAfter: "生存" });
    await settle();
    const title = store.getState().toasts.find((t) => t.action?.label === "启动")?.title;
    if (title === undefined) throw new Error("Java 装好后应有带「启动」的通知");
    await rename("生存", "生存二");
    expect(await launchedBy(title)).toBe("生存二");
  });

  it("动作自己失败时的通知标题也写新名字", async () => {
    await repaired("生存");
    await rename("生存", "生存二");
    expect(toast("「生存」已修复").action).toMatchObject({ label: "启动", errorTitle: "「生存二」启动失败" });
  });
});

describe("改名后点击留着的通知：启动失败的修复动作", () => {
  const failLaunch = async (id: string, code: string, detail: unknown): Promise<void> => {
    ipc.overrides.set("launch_game", () => {
      throw new IpcError(code, "启动失败", detail);
    });
    await store.actions.launch(id);
    await settle();
    ipc.overrides.set("launch_game", () => ({ pid: 1 }));
  };

  it("重试：按新名字再启动一次，直达目标照旧带上", async () => {
    ipc.overrides.set("launch_game", () => {
      throw new IpcError("files_offline", "启动失败", { count: 3 });
    });
    await store.actions.quickPlay("生存", { kind: "singleplayer", world_dir_name: "w1" });
    await settle();
    ipc.overrides.set("launch_game", () => ({ pid: 1 }));
    await rename("生存", "生存二");

    await click("「生存」启动失败");

    expect(callsOf(ipc, "launch_game").at(-1)).toMatchObject({ versionId: "生存二", quickPlay: { kind: "singleplayer", world_dir_name: "w1" } });
    expect(store.getState().session).toMatchObject({ instanceId: "生存二", phase: "running" });
  });

  it("修复实例：补全任务排在新名字上", async () => {
    await failLaunch("生存", "version_broken", {});
    await rename("生存", "生存二");

    await click("「生存」启动失败");

    expect(callsOf(ipc, "repair_instance").map((a) => a.id)).toEqual(["生存二"]);
  });

  it("下载 Java：装好后「启动」的还是新名字", async () => {
    await failLaunch("生存", "java_missing", { major: 21, mc_version: "1.21.1" });
    await rename("生存", "生存二");
    ipc.overrides.set("install_java", () => JDK_21);

    await click("「生存」启动失败");

    const done = store.getState().toasts.find((t) => t.action?.label === "启动");
    if (done === undefined) throw new Error("Java 装好后应有带「启动」的通知");
    expect(await launchedBy(done.title)).toBe("生存二");
  });

  it("改为自动选择 Java：写新名字的实例设置，接着启动新名字", async () => {
    const settings = { description: null, cover: null, isolation: "follow_global", memory_mb: null, java: "D:/jdk/bin/java.exe", jvm_args: "", resolution: { width: 854, height: 480 }, fullscreen: false };
    ipc.overrides.set("get_instance_settings", () => settings);
    ipc.overrides.set("set_instance_settings", (args) => args.settings);
    await failLaunch("生存", "java_pinned_missing", { path: "D:/jdk/bin/java.exe", pinned_by: "instance" });
    await rename("生存", "生存二");

    await click("「生存」启动失败");

    expect(callsOf(ipc, "set_instance_settings").map((a) => a.id)).toEqual(["生存二"]);
    expect(callsOf(ipc, "launch_game").at(-1)).toMatchObject({ versionId: "生存二" });
  });

  it("完整日志：导航到新名字的日志页", async () => {
    await failLaunch("生存", "spawn_failed", { message: "拒绝访问" });
    await rename("生存", "生存二");
    expect(routeOf("「生存」启动失败")).toEqual({ page: "instance", id: "生存二", tab: "logs" });
  });

  it("别的实例改名不动这一条", async () => {
    await failLaunch("生存", "spawn_failed", { message: "拒绝访问" });
    await rename("创造", "创造二");
    expect(routeOf("「生存」启动失败")).toEqual({ page: "instance", id: "生存", tab: "logs" });
  });
});

describe("改名后点击留着的通知：路由动作", () => {
  it("查看备份：指向新名字的实例页", async () => {
    const result: BackupResultDto = { backup: { file: "1720000000000-manual.zip", kind: "manual", created_at: 1_720_000_000_000, size_bytes: 1024, level_name: "旧世界" }, pruned: 0 };
    ipc.overrides.set("backup_world", () => result);
    await store.actions.backupWorld("生存", "w1", "旧世界");
    await settle();

    await rename("生存", "生存二");

    expect(routeOf("已备份「旧世界」")).toEqual({ page: "instance", id: "生存二", tab: "overview" });
  });

  it("查看诊断：指向新名字的崩溃页", async () => {
    await store.actions.launch("生存");
    emit(GAME_EXIT_EVENT, { version_id: "生存", exit_code: 1, crashed: true, killed: false, duration_ms: 1000 });
    await settle();

    await rename("生存", "生存二");

    expect(routeOf("「生存」崩溃了")).toEqual({ page: "instance", id: "生存二", tab: "crash" });
  });
});

describe("旧名字被别的实例用上：不跳到错的实例", () => {
  it("新建同名实例：留着的通知启动改了名的那个，新通知启动新建的这个", async () => {
    await repaired("生存");
    await rename("生存", "生存二");
    await create("生存");

    expect(await launchedBy("「生存」已修复")).toBe("生存二");
    expect(await launchedBy("「生存」已就绪")).toBe("生存");
  });

  it("把别的实例改成旧名字：两条通知各跟各的实例", async () => {
    await repaired("生存");
    await repaired("创造");
    await rename("生存", "生存二");
    await rename("创造", "生存");

    expect(await launchedBy("「生存」已修复")).toBe("生存二");
    expect(await launchedBy("「创造」已修复")).toBe("生存");
  });

  it("连着改两次：跟到最后的名字", async () => {
    await repaired("生存");
    await rename("生存", "生存二");
    await rename("生存二", "生存三");
    expect(await launchedBy("「生存」已修复")).toBe("生存三");
  });

  it("经中间名互换两个实例的名字：各跟各的实例", async () => {
    await repaired("生存");
    await repaired("创造");
    await rename("生存", "临时");
    await rename("创造", "生存");
    await rename("临时", "创造");

    expect(await launchedBy("「生存」已修复")).toBe("创造");
    expect(await launchedBy("「创造」已修复")).toBe("生存");
  });
});

describe("实例删除后留着的通知", () => {
  it("动作摘掉、正文留着：之后新建同名实例，点不到它身上", async () => {
    await repaired("生存");
    await repaired("创造");

    await remove("生存");
    await create("生存");

    expect(toast("「生存」已修复").action).toBeUndefined();
    expect(toast("「创造」已修复").action?.label).toBe("启动");
  });

  it("改名之后再删：通知跟到了新名字，动作同样摘掉", async () => {
    await store.actions.launch("生存");
    emit(GAME_EXIT_EVENT, { version_id: "生存", exit_code: 1, crashed: true, killed: false, duration_ms: 1000 });
    await settle();
    await rename("生存", "生存二");

    await remove("生存二");

    expect(toast("「生存」崩溃了").action).toBeUndefined();
  });
});
