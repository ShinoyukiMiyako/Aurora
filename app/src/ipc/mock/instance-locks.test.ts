import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig, setGameDirectory, updateConfig } from "../config";
import { lastCrash, lastLaunchLog } from "../diagnostics";
import { installMod, installResource } from "../discover";
import { IpcError } from "../errors";
import { rollback } from "../history";
import {
  deleteInstance,
  getInstanceSettings,
  getSidebarPins,
  installVersion,
  listInstances,
  openFolder,
  previewInstanceDeletion,
  renameInstance,
  repairInstance,
  setInstanceSettings,
  setSidebarPins,
} from "../instances";
import { launchGame, playStats } from "../launch";
import { checkUpdates, removeMod, setModEnabled, updateMod } from "../mods";
import { cancelTask } from "../tasks";
import { resetMocks } from ".";
import { clearMockEventListeners } from "./events";
import { acquireMockInstance, MOCK_INSTALL_STEPS, MOCK_STEP_MS } from "./handlers/instances";
import { endMockGame, failNextMockPlayRecords } from "./handlers/launch";
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

const offline = (versionId: string, taskId: string) => ({ taskId, versionId, accountUuid: null, offlineName: "Steve" });

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
