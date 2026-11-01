import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig, setGameDirectory, updateConfig } from "../config";
import { lastCrash, lastLaunchLog } from "../diagnostics";
import { installMod, installResource } from "../discover";
import { IpcError } from "../errors";
import { rollback } from "../history";
import {
  backupWorld,
  deleteInstance,
  getInstanceSettings,
  getSidebarPins,
  installVersion,
  listInstances,
  listWorldBackups,
  openFolder,
  previewInstanceDeletion,
  renameInstance,
  repairInstance,
  setInstanceSettings,
  setSidebarPins,
} from "../instances";
import { launchGame, onGameExit, onWorldBackup, playStats, type WorldBackupEvent } from "../launch";
import { exportModpack, type ModpackExportOptions } from "../modpack";
import { addLocalMods, checkUpdates, removeMod, setModEnabled, updateMod } from "../mods";
import { cancelTask } from "../tasks";
import { resetMocks } from ".";
import { clearMockEventListeners } from "./events";
import { acquireMockInstance, acquireMockInstanceWithBases, addMockInstance, addMockWorld, failNextMockBackupsMove, markMockSavesWritten, MOCK_INSTALL_STEPS, MOCK_STEP_MS } from "./handlers/instances";
import { endMockGame, failNextMockPlayRecords, pauseNextMockAutoBackup } from "./handlers/launch";
import { beginMockTask, endMockTask, isMockTaskCancelled } from "./handlers/tasks";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const MINUTE = 60_000;
/** 种子数据里玩过、装着 Fabric 与几个带平台来源的 Mod 的实例。 */
const FABRIC = "1.20.1-Fabric";

beforeEach(() => {
  resetMocks();
  clearMockEventListeners();
});

afterEach(() => {
  vi.useRealTimers();
});

async function rejection(promise: Promise<unknown>): Promise<IpcError> {
  const error = await promise.then(
    () => {
      throw new Error("本应失败却成功了");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(IpcError);
  return error as IpcError;
}

/** instance_busy 的形状与后端一致：detail 带实例 id 与正在做的事。 */
async function busy(promise: Promise<unknown>): Promise<[string, unknown]> {
  const error = await rejection(promise);
  expect(error.code).toBe("instance_busy");
  return [error.message, error.detail];
}

const offline = (versionId: string, taskId: string) => ({ taskId, versionId, accountUuid: null, offlineName: "Steve", offlineFallback: false, quickPlay: null });

async function baseBusyOf(id: string): Promise<unknown> {
  const found = (await listInstances()).find((i) => i.id === id);
  if (found === undefined) throw new Error(`列表里没有 ${id}`);
  return found.base_busy;
}

async function activityOf(id: string): Promise<string | null> {
  const found = (await listInstances()).find((i) => i.id === id);
  if (found === undefined) throw new Error(`列表里没有 ${id}`);
  return found.activity;
}

async function minutesOf(id: string): Promise<number | null> {
  const stats = await playStats({ from: "2000-01-01", to: "2099-12-31" });
  const row = stats.instances.find((i) => i.version_id === id);
  return row === undefined ? null : row.minutes;
}

describe("mock 的实例占用与后端同一张兼容表", () => {
  const ACTIVITIES = ["installing", "repairing", "renaming", "deleting", "launching", "running", "modifying", "inherited", "backing_up"] as const;
  type Activity = (typeof ACTIVITIES)[number];
  /** 已有 held 时还能再占的事：改名、删除、新建、补全与一切互斥。 */
  const COMPATIBLE: Readonly<Record<Activity, readonly Activity[]>> = {
    installing: [],
    repairing: [],
    renaming: [],
    deleting: [],
    launching: ["modifying"],
    running: ["modifying"],
    backing_up: ["modifying", "inherited"],
    modifying: ["modifying", "launching", "running", "backing_up", "inherited"],
    inherited: ["modifying", "backing_up", "inherited"],
  };
  /** inherited 只能经基底占用拿到：让另一个实例以 target 为基底。 */
  const take = (target: string, activity: Activity, user: string) =>
    activity === "inherited" ? acquireMockInstanceWithBases(user, "modifying", [target]) : acquireMockInstance(target, activity);

  it.each(ACTIVITIES)("已占着 %s 时九种事逐一判定，与后端 compatible_with 的矩阵一致；被拒时 detail 报占着的那件事", (held) => {
    for (const wanted of ACTIVITIES) {
      const first = take("矩阵", held, "用它的甲");
      if (COMPATIBLE[held].includes(wanted)) {
        take("矩阵", wanted, "用它的乙").release();
      } else {
        expect(() => take("矩阵", wanted, "用它的乙")).toThrow(
          expect.objectContaining({ code: "instance_busy", detail: held === "inherited" ? { id: "矩阵", activity: held, used_by: "用它的甲" } : { id: "矩阵", activity: held } }),
        );
      }
      first.release();
    }
  });

  it("游戏运行中：列表报 running；写设置、查更新、建工作子目录照常进行；改名与删除报 instance_busy", async () => {
    await launchGame(offline(FABRIC, "t-launch"));
    expect(await activityOf(FABRIC)).toBe("running");
    expect((await previewInstanceDeletion(FABRIC)).activity).toBe("running");

    const settings = await getInstanceSettings(FABRIC);
    await expect(setInstanceSettings(FABRIC, { ...settings, jvm_args: "-XX:+UseG1GC" })).resolves.toMatchObject({ jvm_args: "-XX:+UseG1GC" });
    await expect(checkUpdates(FABRIC)).resolves.toBeInstanceOf(Array);
    await expect(openFolder("mods", FABRIC)).resolves.toBeUndefined();

    expect(await busy(renameInstance(FABRIC, "改个名"))).toEqual([`实例 ${FABRIC} 正在运行，请稍后再试`, { id: FABRIC, activity: "running" }]);
    expect(await busy(deleteInstance(FABRIC))).toEqual([`实例 ${FABRIC} 正在运行，请稍后再试`, { id: FABRIC, activity: "running" }]);
    // 键不分大小写
    expect((await busy(deleteInstance(FABRIC.toUpperCase())))[1]).toEqual({ id: FABRIC.toUpperCase(), activity: "running" });

    endMockGame(0, MINUTE);
    expect(await activityOf(FABRIC)).toBeNull();
    await expect(renameInstance(FABRIC, "改个名")).resolves.toEqual({ id: "改个名" });
  });

  it("基底自己也在备份：被拒的删除报它自己的事，与列表一致，不随哪份占用先到而变", async () => {
    const chain = acquireMockInstanceWithBases(FABRIC, "running", ["1.21"]);
    const backup = acquireMockInstance("1.21", "backing_up");
    expect(await activityOf("1.21")).toBe("backing_up");
    expect(await busy(deleteInstance("1.21"))).toEqual(["实例 1.21 正在备份或恢复存档，请稍后再试", { id: "1.21", activity: "backing_up" }]);
    backup.release();
    expect(await busy(deleteInstance("1.21"))).toEqual([`实例 1.21 正在被实例 ${FABRIC} 使用，请稍后再试`, { id: "1.21", activity: "inherited", used_by: FABRIC }]);
    chain.release();
    expect(await activityOf("1.21")).toBeNull();
  });

  it("基底开着自己的游戏时补全它上面的实例报基底在运行；反过来实例在用基底时基底启动不了，占用槽没被留下", async () => {
    addMockInstance("导入的包", "1.21", { kind: "fabric", version: "0.16.10" }, null);
    await launchGame(offline("1.21", "t-base"));
    expect(await baseBusyOf("导入的包")).toEqual({ id: "1.21", activity: "running" });
    expect(await busy(repairInstance("t-repair", "导入的包"))).toEqual(["实例 1.21 正在运行，请稍后再试", { id: "1.21", activity: "running" }]);
    expect(await activityOf("导入的包")).toBeNull();
    endMockGame(0, MINUTE);
    expect(await baseBusyOf("导入的包")).toBeNull();

    const chain = acquireMockInstanceWithBases("导入的包", "repairing", ["1.21"]);
    expect(await busy(launchGame(offline("1.21", "t-blocked")))).toEqual([`实例 1.21 正在被实例 导入的包 使用，请稍后再试`, { id: "1.21", activity: "inherited", used_by: "导入的包" }]);
    chain.release();
    await launchGame(offline("1.21", "t-free"));
    endMockGame(0, MINUTE);
  });

  it("列表的 base_busy 与补全实际被拒的一致：基底只是在备份、改动时不算，基底自己与原版实例没有这一项", async () => {
    addMockInstance("导入的包", "1.21", { kind: "fabric", version: "0.16.10" }, null);
    const backup = acquireMockInstance("1.21", "backing_up");
    expect(await baseBusyOf("导入的包")).toBeNull();
    backup.release();
    const running = acquireMockInstance("1.21", "running");
    expect(await baseBusyOf("导入的包")).toEqual({ id: "1.21", activity: "running" });
    expect(await baseBusyOf("1.21")).toBeNull();
    running.release();
    expect(await baseBusyOf("导入的包")).toBeNull();
  });

  it("启动失败或被取消：占用随之放开", async () => {
    const launching = launchGame(offline("1.21", "t-cancel"));
    await cancelTask("t-cancel");
    expect((await rejection(launching)).code).toBe("cancelled");
    expect(await activityOf("1.21")).toBeNull();
    await expect(deleteInstance("1.21")).resolves.toEqual({ existed: true });
  });

  it("改名或删除进行中：写设置、查更新、建工作子目录与各项 Mod 改动都报 instance_busy；打开实例目录本身不占用", async () => {
    for (const activity of ["renaming", "deleting"] as const) {
      const hold = acquireMockInstance(FABRIC, activity);
      const settings = await getInstanceSettings(FABRIC);
      const expected = { id: FABRIC, activity };
      expect((await busy(setInstanceSettings(FABRIC, settings)))[1]).toEqual(expected);
      expect((await busy(checkUpdates(FABRIC)))[1]).toEqual(expected);
      expect((await busy(openFolder("mods", FABRIC)))[1]).toEqual(expected);
      expect((await busy(openFolder("screenshots", FABRIC)))[1]).toEqual(expected);
      expect((await busy(setModEnabled(FABRIC, "AANobbMI-0.5.3.jar", false)))[1]).toEqual(expected);
      expect((await busy(removeMod(FABRIC, "handmade-1.0.jar")))[1]).toEqual(expected);
      expect((await busy(addLocalMods(FABRIC, ["D:\\dl\\extra.jar"])))[1]).toEqual(expected);
      expect((await busy(updateMod("t-up", FABRIC, "handmade-1.0.jar", "v1")))[1]).toEqual(expected);
      expect((await busy(installMod("t-mod", FABRIC, "modrinth", "AANobbMI", "mr-sodium-0.5.11")))[1]).toEqual(expected);
      expect((await busy(rollback(FABRIC, "e1")))[1]).toEqual(expected);
      expect(
        (
          await busy(
            installResource({ taskId: "t-res", versionId: FABRIC, resourceType: "shader", world: null, platform: "modrinth", projectId: "x", fileVersionId: "y" }),
          )
        )[1],
      ).toEqual(expected);
      expect((await busy(launchGame(offline(FABRIC, "t-l"))))[1]).toEqual(expected);
      await expect(openFolder("instance", FABRIC)).resolves.toBeUndefined();
      hold.release();
      await expect(setInstanceSettings(FABRIC, settings)).resolves.toEqual(settings);
    }
  });

  it("改动彼此兼容：一处改动进行中，另一处改动照常；改名报 modifying；列表报 modifying", async () => {
    const hold = acquireMockInstance(FABRIC, "modifying");
    expect(await activityOf(FABRIC)).toBe("modifying");
    const settings = await getInstanceSettings(FABRIC);
    await expect(setInstanceSettings(FABRIC, settings)).resolves.toEqual(settings);
    await expect(checkUpdates(FABRIC)).resolves.toBeInstanceOf(Array);
    expect((await busy(renameInstance(FABRIC, "x")))[1]).toEqual({ id: FABRIC, activity: "modifying" });
    // 运行中的游戏与改动并存时报运行，界面关心的是它
    await launchGame(offline(FABRIC, "t-launch"));
    expect(await activityOf(FABRIC)).toBe("running");
    endMockGame(0, MINUTE);
    expect(await activityOf(FABRIC)).toBe("modifying");
    hold.release();
    expect(await activityOf(FABRIC)).toBeNull();
    expect(() => hold.release()).toThrow("已经放开");
  });

  it("补全进行中：写设置报 instance_busy（repairing）", async () => {
    vi.useFakeTimers();
    const repairing = repairInstance("t-repair", "1.21");
    await vi.advanceTimersByTimeAsync(MOCK_STEP_MS);
    const settings = await getInstanceSettings("1.21");
    expect((await busy(setInstanceSettings("1.21", settings)))[1]).toEqual({ id: "1.21", activity: "repairing" });
    await vi.advanceTimersByTimeAsync(MOCK_STEP_MS * (MOCK_INSTALL_STEPS + 1));
    await repairing;
    await expect(setInstanceSettings("1.21", settings)).resolves.toEqual(settings);
  });
});

describe("mock 改名与删除带上游玩记录、崩溃报告与会话日志", () => {
  it("改名：游玩时长、崩溃报告与会话日志迁到新名字，旧名字下不再有", async () => {
    const before = await minutesOf(FABRIC);
    if (before === null) throw new Error(`种子数据里 ${FABRIC} 应当玩过`);
    await launchGame(offline(FABRIC, "t-1"));
    endMockGame(3, 10 * MINUTE);

    await renameInstance(FABRIC, "旧档");
    const renamed = (await listInstances()).find((i) => i.id === "旧档");
    expect(renamed).toMatchObject({ playtime_min: before + 10 });
    expect(renamed?.last_crash_at).not.toBeNull();
    expect(await minutesOf("旧档")).toBe(before + 10);
    expect(await minutesOf(FABRIC)).toBeNull();
    expect((await lastCrash("旧档"))?.exit_code).toBe(3);
    expect(await lastCrash(FABRIC)).toBeNull();
    expect((await lastLaunchLog("旧档"))?.ended?.outcome).toBe("crashed");
    expect(await lastLaunchLog(FABRIC)).toBeNull();
  });

  it("删除：记录一并清掉，之后同名新建的实例从零开始", async () => {
    vi.useFakeTimers();
    await launchGame(offline("1.21", "t-1"));
    endMockGame(1, 5 * MINUTE);
    expect(await lastCrash("1.21")).not.toBeNull();

    await deleteInstance("1.21");
    expect(await minutesOf("1.21")).toBeNull();
    expect(await lastCrash("1.21")).toBeNull();
    expect(await lastLaunchLog("1.21")).toBeNull();

    const installing = installVersion("t-new", "1.21.1", null, null, "1.21");
    await vi.advanceTimersByTimeAsync(MOCK_STEP_MS * (MOCK_INSTALL_STEPS + 2));
    await installing;
    expect((await listInstances()).find((i) => i.id === "1.21")).toMatchObject({ playtime_min: 0, last_played_at: null, last_crash_at: null });
  });
});

describe("mock 改名与删除时配置引用与后端同一套规则", () => {
  it("当前选中跟着走：改名换成新名字，删除后不再选中；没选中它时不动", async () => {
    await updateConfig({ selectedVersion: FABRIC });
    await renameInstance(FABRIC, "旧档");
    expect((await getConfig()).selected_version).toBe("旧档");
    await deleteInstance("1.21");
    expect((await getConfig()).selected_version).toBe("旧档");
    await deleteInstance("旧档");
    expect((await getConfig()).selected_version).toBeNull();
  });

  it("游玩记录没跟上：改名报 play_records_failed，目录、侧栏固定与当前选中照样改好，记录随后读得到", async () => {
    const before = await minutesOf(FABRIC);
    if (before === null) throw new Error(`种子数据里 ${FABRIC} 应当玩过`);
    await setSidebarPins([FABRIC, "1.21.1"]);
    await updateConfig({ selectedVersion: FABRIC });
    failNextMockPlayRecords();
    const error = await rejection(renameInstance(FABRIC, "旧档"));
    expect([error.code, error.message, error.detail]).toEqual([
      "play_records_failed",
      "实例已改名为「旧档」，但游玩记录没能跟着改：拒绝访问。 (os error 5)",
      { id: FABRIC, renamed_to: "旧档", causes: ["拒绝访问。 (os error 5)"] },
    ]);
    expect((await listInstances()).map((i) => i.id)).toContain("旧档");
    expect(await getSidebarPins()).toEqual(["旧档", "1.21.1"]);
    expect((await getConfig()).selected_version).toBe("旧档");
    expect(await minutesOf("旧档")).toBe(before);
    // 只报一次：再改回去照常成功
    await expect(renameInstance("旧档", FABRIC)).resolves.toEqual({ id: FABRIC });
  });

  it("游玩记录没跟上：删除报 play_records_failed，实例与侧栏固定照样去掉", async () => {
    await setSidebarPins(["1.21", "1.21.1"]);
    failNextMockPlayRecords("磁盘已满");
    const error = await rejection(deleteInstance("1.21"));
    expect([error.code, error.message, error.detail]).toEqual(["play_records_failed", "实例已删除，但游玩记录没能跟着改：磁盘已满", { id: "1.21", causes: ["磁盘已满"] }]);
    expect((await listInstances()).map((i) => i.id)).not.toContain("1.21");
    expect(await getSidebarPins()).toEqual(["1.21.1"]);
  });
});

/** 种子数据的假磁盘上存在的另一个游戏目录。 */
const OTHER_DIR = "D:\\HMCL\\.minecraft";

describe("mock 的游玩记录与后端一样按游戏目录区分", () => {
  it("换到另一个游戏目录：同名实例从零算起；在那边玩、改名、删除都不动原目录的记录", async () => {
    const home = (await getConfig()).game_dir;
    const before = await minutesOf(FABRIC);
    const vanilla = await minutesOf("1.21");
    if (before === null || vanilla === null) throw new Error(`种子数据里 ${FABRIC} 与 1.21 应当玩过`);

    await setGameDirectory(OTHER_DIR);
    expect((await listInstances()).find((i) => i.id === FABRIC)).toMatchObject({ playtime_min: 0, last_played_at: null });
    expect(await playStats({ from: "2000-01-01", to: "2099-12-31" })).toMatchObject({ days: [], total_minutes: 0, instances: [] });

    await launchGame(offline(FABRIC, "t-other"));
    endMockGame(0, 10 * MINUTE);
    expect(await minutesOf(FABRIC)).toBe(10);
    await renameInstance(FABRIC, "那边的");
    expect(await minutesOf("那边的")).toBe(10);
    expect(await minutesOf(FABRIC)).toBeNull();

    await setGameDirectory(home);
    expect(await minutesOf(FABRIC)).toBe(before);
    expect(await minutesOf("那边的")).toBeNull();
    expect((await listInstances()).find((i) => i.id === "那边的")).toMatchObject({ playtime_min: 0, last_played_at: null });

    await setGameDirectory(OTHER_DIR);
    await deleteInstance("1.21");
    await setGameDirectory(home);
    expect(await minutesOf("1.21")).toBe(vanilla);
    expect(await minutesOf(FABRIC)).toBe(before);
  });

  it("游戏运行期间换了游戏目录：这一局记回启动时的游戏目录", async () => {
    const home = (await getConfig()).game_dir;
    const before = await minutesOf("1.21");
    if (before === null) throw new Error("种子数据里 1.21 应当玩过");

    await launchGame(offline("1.21", "t-run"));
    await setGameDirectory(OTHER_DIR);
    endMockGame(0, 7 * MINUTE);
    expect(await minutesOf("1.21")).toBeNull();

    await setGameDirectory(home);
    expect(await minutesOf("1.21")).toBe(before + 7);
  });

  it("游戏目录写法不同（大小写、斜杠方向、末尾分隔符）仍是同一本记录", async () => {
    const home = (await getConfig()).game_dir;
    await setGameDirectory("d:/hmcl/.minecraft/");
    await launchGame(offline("1.21", "t-alias"));
    endMockGame(0, 4 * MINUTE);

    await setGameDirectory(home);
    await setGameDirectory(OTHER_DIR);
    expect((await getConfig()).game_dir).toBe(OTHER_DIR);
    expect(await minutesOf("1.21")).toBe(4);
    expect((await listInstances()).find((i) => i.id === "1.21")).toMatchObject({ playtime_min: 4 });
  });
});

describe("mock 的游戏退出后自动备份与后端同序", () => {
  /** 樱花生存是隔离实例，种子里带着 New World 这个存档。 */
  const ISOLATED = "樱花生存";
  const WORLD = "New World";

  async function backupEvents(): Promise<WorldBackupEvent[]> {
    const events: WorldBackupEvent[] = [];
    await onWorldBackup((event) => events.push(event));
    return events;
  }

  it("退出事件先到，实例原地转成备份，备份做完才放开并推备份事件", async () => {
    const order: string[] = [];
    await onGameExit(() => order.push("exit"));
    const events = await backupEvents();
    await launchGame({ ...offline(ISOLATED, "t-auto"), quickPlay: { kind: "singleplayer", world_dir_name: WORLD } });
    const before = (await listWorldBackups(ISOLATED, WORLD)).backups.length;
    const finish = pauseNextMockAutoBackup();

    endMockGame(0, MINUTE);
    expect(order).toEqual(["exit"]);
    expect(await activityOf(ISOLATED)).toBe("backing_up");
    expect(await busy(renameInstance(ISOLATED, "改个名"))).toEqual([`实例 ${ISOLATED} 正在备份或恢复存档，请稍后再试`, { id: ISOLATED, activity: "backing_up" }]);
    expect((await rejection(launchGame(offline(ISOLATED, "t-again")))).detail).toEqual({ id: ISOLATED, activity: "backing_up" });
    expect(events).toEqual([]);

    finish();
    expect(await activityOf(ISOLATED)).toBeNull();
    expect(events).toEqual([{ instance_id: ISOLATED, backed_up: [WORLD], failed: [] }]);
    expect((await listWorldBackups(ISOLATED, WORLD)).backups).toHaveLength(before + 1);
    expect((await listWorldBackups(ISOLATED, WORLD)).backups[0].kind).toBe("auto");
  });

  it("加载器实例：转去备份时基底当即放开，这时能启动基底；实例自己占到备份做完", async () => {
    addMockInstance("导入的包", "1.21", { kind: "fabric", version: "0.16.10" }, null);
    await launchGame(offline("导入的包", "t-chain"));
    expect((await listInstances()).find((i) => i.id === "1.21")).toMatchObject({ activity: "inherited", used_by: "导入的包" });
    const finish = pauseNextMockAutoBackup();
    endMockGame(0, MINUTE);
    expect((await listInstances()).find((i) => i.id === "1.21")).toMatchObject({ activity: null, used_by: null });
    expect(await activityOf("导入的包")).toBe("backing_up");
    await launchGame(offline("1.21", "t-base"));
    expect(await activityOf("1.21")).toBe("running");
    finish();
    expect(await activityOf("导入的包")).toBeNull();
    endMockGame(0, MINUTE);
  });

  it("这一局没有进存档：没有要备份的，备份事件照样推，列表是空的", async () => {
    const events = await backupEvents();
    await launchGame(offline(ISOLATED, "t-none"));
    endMockGame(0, MINUTE);
    expect(events).toEqual([{ instance_id: ISOLATED, backed_up: [], failed: [] }]);
    expect(await activityOf(ISOLATED)).toBeNull();
  });

  it("关着自动备份：退出就放开，没有备份事件", async () => {
    const events = await backupEvents();
    await updateConfig({ worldBackup: { auto: false, keep_per_world: 5, max_total_gb: 20 } });
    await launchGame({ ...offline(ISOLATED, "t-off"), quickPlay: { kind: "singleplayer", world_dir_name: WORLD } });
    const before = (await listWorldBackups(ISOLATED, WORLD)).backups.length;
    endMockGame(0, MINUTE);
    expect(await activityOf(ISOLATED)).toBeNull();
    expect(events).toEqual([]);
    expect((await listWorldBackups(ISOLATED, WORLD)).backups).toHaveLength(before);
  });
});

describe("mock 的存档读写互斥与后端同序", () => {
  /** 樱花生存是隔离实例，种子里带着 New World 这个存档；1.21 与 1.21.1 不隔离，共用一份 saves。 */
  const ISOLATED = "樱花生存";
  const WORLD = "New World";
  const SHARED_A = "1.21";
  const SHARED_B = "1.21.1";
  const OPTIONS: ModpackExportOptions = { destination: "D:/分享/周末包.mrpack", name: "周末包", version: "1.0.0", summary: null, extras: [], include_disabled: false };

  const withSaves = (taskId: string, id = ISOLATED) => exportModpack(taskId, id, { ...OPTIONS, extras: ["saves"] });
  const dataPack = (taskId: string, versionId = ISOLATED) =>
    installResource({ taskId, versionId, resourceType: "data_pack", world: WORLD, platform: "modrinth", projectId: "x", fileVersionId: "y" });

  it.each(["launching", "running", "backing_up"] as const)("实例报着 %s：带存档的导出报 instance_busy，没勾存档的照常导出", async (activity) => {
    const hold = acquireMockInstance(ISOLATED, activity);
    expect((await rejection(withSaves("t-saves"))).detail).toEqual({ id: ISOLATED, activity });
    expect((await exportModpack("t-plain", ISOLATED, OPTIONS)).path).toBe(OPTIONS.destination);
    hold.release();
    expect((await withSaves("t-again")).path).toBe(OPTIONS.destination);
  });

  it("共用存档：别的实例开着游戏或在装数据包时带存档导出被挡，detail 指向它；隔离实例不受影响", async () => {
    const game = acquireMockInstance(SHARED_B, "running");
    expect((await rejection(withSaves("t-game", SHARED_A))).detail).toEqual({ id: SHARED_B, activity: "running" });
    expect((await withSaves("t-isolated")).path).toBe(OPTIONS.destination);
    game.release();

    const unmark = markMockSavesWritten(SHARED_B);
    const written = await rejection(withSaves("t-written", SHARED_A));
    expect([written.message, written.detail]).toEqual([`实例 ${SHARED_B} 正在往存档里装数据包，请稍后再试`, { id: SHARED_B, activity: "modifying" }]);
    unmark();
    expect((await withSaves("t-settled", SHARED_A)).path).toBe(OPTIONS.destination);
  });

  it("装数据包：备份中报 backing_up；存档正被读进整合包时报 modifying 并写明在导出；没勾存档的导出不挡", async () => {
    const backup = acquireMockInstance(ISOLATED, "backing_up");
    expect((await rejection(dataPack("t-backup"))).detail).toEqual({ id: ISOLATED, activity: "backing_up" });
    backup.release();

    const plain = exportModpack("t-plain", ISOLATED, OPTIONS);
    expect((await rejection(dataPack("t-beside-plain"))).code).not.toBe("instance_busy");
    await plain;

    const reading = withSaves("t-read");
    const blocked = await rejection(dataPack("t-beside-saves"));
    expect([blocked.message, blocked.detail]).toEqual([`实例 ${ISOLATED} 正在导出带存档的整合包，请稍后再试`, { id: ISOLATED, activity: "modifying" }]);
    await reading;
  });

  it("正在装数据包：备份与带存档的导出都报 instance_busy，写明在装数据包，结束后放开", async () => {
    const unmark = markMockSavesWritten(ISOLATED);
    const expected = [`实例 ${ISOLATED} 正在往存档里装数据包，请稍后再试`, { id: ISOLATED, activity: "modifying" }];
    expect(await busy(backupWorld("t-backup", ISOLATED, WORLD))).toEqual(expected);
    expect(await busy(withSaves("t-saves"))).toEqual(expected);
    unmark();
    vi.useFakeTimers();
    const done = backupWorld("t-after", ISOLATED, WORLD);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    await done;
  });

  it("存档正被读进整合包：本实例不能启动，报 modifying 并写明在导出；读完放开", async () => {
    const reading = withSaves("t-read");
    const blocked = await rejection(launchGame(offline(ISOLATED, "t-launch")));
    expect(blocked.message).toBe(`实例 ${ISOLATED} 正在导出带存档的整合包，请稍后再试`);
    expect(blocked.detail).toEqual({ id: ISOLATED, activity: "modifying" });
    await reading;
    await launchGame(offline(ISOLATED, "t-after"));
    endMockGame(0, MINUTE);
  });
});

describe("mock 的存档备份按作用域存放，与后端的备份目录一致", () => {
  const SHARED_A = "1.21";
  const SHARED_B = "1.21.1";

  it("不隔离的实例共用一份：在一个实例上备份，另一个实例也看得到，改名不搬它们，删除预览也不算它们", async () => {
    const world = "共用存档";
    addMockWorld(SHARED_A, world);
    addMockWorld(SHARED_B, world);
    vi.useFakeTimers();
    const done = backupWorld("t-shared", SHARED_A, world);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    await done;
    const seen = await listWorldBackups(SHARED_B, world);
    expect(seen).toMatchObject({ scope: "shared" });
    expect(seen.backups).toHaveLength(1);
    expect((await previewInstanceDeletion(SHARED_A)).backup_count).toBe(0);
    await renameInstance(SHARED_A, "改个名");
    expect((await listWorldBackups(SHARED_B, world)).backups).toHaveLength(1);
  });

  it("隔离实例改名把备份挪到新名字下；挪不动时报 world_backups_not_moved，备份留在旧名下，改名照样落盘", async () => {
    const ISOLATED = "樱花生存";
    failNextMockBackupsMove();
    const error = await rejection(renameInstance(ISOLATED, "樱花二号"));
    expect(error.code).toBe("world_backups_not_moved");
    expect(error.message).toBe("实例已改名为「樱花二号」，但存档备份没能跟着挪：拒绝访问。 (os error 5)");
    expect(error.detail).toEqual({
      id: ISOLATED,
      renamed_to: "樱花二号",
      path: `D:/Games/.minecraft/.petalfall/backups/instances/${ISOLATED}`,
      causes: ["拒绝访问。 (os error 5)"],
    });
    expect((await listInstances()).some((i) => i.id === "樱花二号")).toBe(true);
    expect((await listWorldBackups("樱花二号", "New World")).backups).toEqual([]);
  });

  it("新名字下留着同一存档的备份：改名是并进去，不把它们冲掉", async () => {
    const ISOLATED = "樱花生存";
    await renameInstance(ISOLATED, "临时");
    await renameInstance("临时", ISOLATED);
    expect((await listWorldBackups(ISOLATED, "New World")).backups).toHaveLength(3);
  });
});

describe("mock 的任务取消与后端同一套记账", () => {
  it("取消时正在运行：只作用于这一次登记，结束后同一个 id 再登记不是已取消", async () => {
    beginMockTask("t-1");
    expect(await cancelTask("t-1")).toBe(true);
    expect(isMockTaskCancelled("t-1")).toBe(true);
    endMockTask("t-1");
    beginMockTask("t-1");
    expect(isMockTaskCancelled("t-1")).toBe(false);
    endMockTask("t-1");
  });

  it("取消先于登记到达：记下的 id 在下一次登记时用掉，再下一次登记不受影响", async () => {
    expect(await cancelTask("t-2")).toBe(false);
    beginMockTask("t-2");
    expect(isMockTaskCancelled("t-2")).toBe(true);
    endMockTask("t-2");
    beginMockTask("t-2");
    expect(isMockTaskCancelled("t-2")).toBe(false);
    endMockTask("t-2");
  });

  it("只记最近 64 个先到的取消，更早的被挤掉", async () => {
    for (let i = 0; i <= 64; i++) await cancelTask(`early-${i}`);
    beginMockTask("early-0");
    expect(isMockTaskCancelled("early-0")).toBe(false);
    endMockTask("early-0");
    beginMockTask("early-1");
    expect(isMockTaskCancelled("early-1")).toBe(true);
    endMockTask("early-1");
  });
});
