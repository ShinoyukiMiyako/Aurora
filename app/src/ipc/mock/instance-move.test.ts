// 假后端的「移到另一个游戏目录」：预检的数字与拦截项、执行的步骤事件与提交后的盘面。全部落在内存里的假磁盘上，不碰真实目录。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addGameDirectory, getConfig, listGameDirectories } from "../config";
import { IpcError } from "../errors";
import { getSidebarPins, listInstances, moveBlockerOf, moveInstance, parseMoveBlocker, previewInstanceMove, renameInstance, type MoveOutcomeDto } from "../instances";
import { cancelTask, CORE_EVENT } from "../tasks";
import { resetMocks } from ".";
import { clearMockEventListeners, subscribeMockEvent } from "./events";
import { addMockInstance, failNextMockBackupsMove, failNextMockMoveConfig, MOCK_INSTALL_STEPS, MOCK_STEP_MS, setMockGameDirDataProblem } from "./handlers/instances";
import { failNextMockPlayRecords } from "./handlers/launch";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const MB = 1_048_576;
const GIB = 1024 * MB;
const SOURCE = "D:\\Games\\Launcher\\.minecraft";
const HMCL = "D:\\HMCL\\.minecraft";
const OFFICIAL = "C:\\Users\\player\\AppData\\Roaming\\.minecraft";
/** 一步假复制推几次进度，再加提交那一拍。 */
const PHASE_MS = MOCK_STEP_MS * MOCK_INSTALL_STEPS;

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

/** 记下一个任务的步骤事件（plan 与 index）和每一步里最后一条下载快照的总量。 */
function recordEvents(taskId: string): { phases: { plan: string[]; index: number }[]; totals: { files: number; bytes: number }[] } {
  const phases: { plan: string[]; index: number }[] = [];
  const totals: { files: number; bytes: number }[] = [];
  subscribeMockEvent(CORE_EVENT, (raw) => {
    const e = raw as { kind: string; task_id: string; plan?: string[]; index?: number; total?: number; total_bytes?: number; finished?: number };
    if (e.task_id !== taskId) return;
    if (e.kind === "phase" && e.plan !== undefined && e.index !== undefined) phases.push({ plan: e.plan, index: e.index });
    if (e.kind === "download" && e.finished === e.total && e.total !== undefined && e.total_bytes !== undefined) totals.push({ files: e.total, bytes: e.total_bytes });
  });
  return { phases, totals };
}

describe("预检", () => {
  it("同一个盘上、目标已有游戏文件：只补这个版本独有的共用文件，不额外占实例的空间", async () => {
    await addGameDirectory("HMCL", HMCL);
    const preview = await previewInstanceMove("1.20.1-Fabric", HMCL);
    expect(preview).toEqual({
      id: "1.20.1-Fabric",
      source: SOURCE,
      target: HMCL,
      target_name: "HMCL",
      target_registered: true,
      same_volume: true,
      instance_bytes: 96 * MB,
      instance_files: 410,
      backup_bytes: 0,
      backup_count: 0,
      dependency_files: 186,
      dependency_bytes: 94 * MB,
      bases_to_copy: [],
      reused_bases: [],
      missing_in_source: 0,
      required_bytes: 94 * MB,
      available_bytes: 120 * GIB,
      isolated: true,
      blockers: [],
    });
  });

  it("跨盘：实例与它的存档备份都算进要写的字节；没记过的新文件夹按文件夹名推出显示名", async () => {
    const preview = await previewInstanceMove("樱花生存", "C:\\Games\\新家\\.minecraft");
    expect(preview).toMatchObject({ target_name: "新家", target_registered: false, same_volume: false, backup_count: 3, backup_bytes: 500 * MB, dependency_files: 3460, dependency_bytes: 712 * MB });
    expect(preview.required_bytes).toBe(712 * MB + 420 * MB + 500 * MB);
    expect(preview.available_bytes).toBe(38 * GIB);
    expect(preview.blockers).toEqual([]);
  });

  it("目标里已有同名版本：name_taken（不分大小写）", async () => {
    await addGameDirectory("HMCL", HMCL);
    expect((await previewInstanceMove("樱花生存", HMCL)).blockers).toEqual([{ kind: "name_taken" }]);
    addMockInstance("Fabric-Loader-0.16.5-1.21.1", "1.21.1", null, null);
    expect((await previewInstanceMove("Fabric-Loader-0.16.5-1.21.1", HMCL)).blockers).toEqual([{ kind: "name_taken" }]);
  });

  it("目标就是现在的游戏目录、或在实例目录里面：只报这一项", async () => {
    expect((await previewInstanceMove("1.21", SOURCE)).blockers).toEqual([{ kind: "same_directory" }]);
    expect((await previewInstanceMove("1.21", "d:/games/launcher/.minecraft/")).blockers).toEqual([{ kind: "same_directory" }]);
    expect((await previewInstanceMove("1.21", `${SOURCE}\\versions\\1.21\\里面`)).blockers).toEqual([{ kind: "target_inside_source" }]);
  });

  it("目标盘放不下：needed 含 256 MiB 余量，available 是目标盘剩余", async () => {
    const preview = await previewInstanceMove("RLCraft", "E:\\小盘\\.minecraft");
    expect(preview.required_bytes).toBe(712 * MB + 1300 * MB);
    expect(preview.blockers).toEqual([{ kind: "insufficient_space", needed: 712 * MB + 1300 * MB + 256 * MB, available: 1536 * MB }]);
  });

  it("别的实例依赖它时拦下；依赖的版本目标里没有就一起带过去，已有就直接用", async () => {
    await addGameDirectory("HMCL", HMCL);
    addMockInstance("新 Fabric", "1.21", { kind: "fabric", version: "0.16.10" }, null);
    addMockInstance("老 Fabric", "1.21.1", { kind: "fabric", version: "0.16.10" }, null);
    expect((await previewInstanceMove("1.21", HMCL)).blockers).toEqual([{ kind: "has_dependents", dependents: ["新 Fabric"] }]);
    const carry = await previewInstanceMove("新 Fabric", HMCL);
    expect([carry.bases_to_copy, carry.reused_bases, carry.required_bytes]).toEqual([["1.21"], [], 94 * MB + 26 * MB]);
    const reuse = await previewInstanceMove("老 Fabric", HMCL);
    expect([reuse.bases_to_copy, reuse.reused_bases, reuse.required_bytes]).toEqual([[], ["1.21.1"], 94 * MB]);
  });

  it("不隔离的实例照实报 isolated: false；目标路径不合法、记过的目录访问不到都以 invalid_game_directory 拒绝", async () => {
    expect((await previewInstanceMove("1.21", HMCL)).isolated).toBe(false);
    expect((await rejection(previewInstanceMove("1.21", "relative\\dir"))).detail).toEqual({ path: "relative\\dir", problem: "not_absolute" });
    await addGameDirectory("移动硬盘", "F:\\拔掉了\\.minecraft");
    expect((await rejection(previewInstanceMove("1.21", "F:\\拔掉了\\.minecraft"))).detail).toEqual({ path: "F:\\拔掉了\\.minecraft", problem: "unavailable" });
  });

  it("版本 JSON 坏了的实例：预检照实报错", async () => {
    expect((await rejection(previewInstanceMove("没装完", HMCL))).code).toBe("instance_failed");
  });

  it("目标的数据格式记号比这一版新、或读不懂：列为拦截项而不是整次报错，与别的拦截项并列；同一目录再登记换成新的问题", async () => {
    await addGameDirectory("HMCL", HMCL);
    // 登记时的写法与预检时不同（大小写、斜杠、末尾分隔符），按同一路径的口径认作同一个目录
    setMockGameDirDataProblem("d:/hmcl/.minecraft/", { kind: "data_too_new", found: 2, written_by: "1.1.0-dev.57", written_by_channel: "dev" });
    expect((await previewInstanceMove("1.20.1-Fabric", HMCL)).blockers).toEqual([{ kind: "data_too_new", path: HMCL, found: 2, supported: 1, written_by: "1.1.0-dev.57", written_by_channel: "dev" }]);
    expect((await previewInstanceMove("樱花生存", HMCL)).blockers).toEqual([
      { kind: "data_too_new", path: HMCL, found: 2, supported: 1, written_by: "1.1.0-dev.57", written_by_channel: "dev" },
      { kind: "name_taken" },
    ]);
    setMockGameDirDataProblem(HMCL, { kind: "data_too_new", found: 9, written_by: null, written_by_channel: null });
    expect((await previewInstanceMove("1.20.1-Fabric", HMCL)).blockers).toEqual([{ kind: "data_too_new", path: HMCL, found: 9, supported: 1, written_by: null, written_by_channel: null }]);
    setMockGameDirDataProblem(HMCL, { kind: "data_format_unreadable", reason: "expected value at line 1 column 1" });
    expect((await previewInstanceMove("1.20.1-Fabric", HMCL)).blockers).toEqual([{ kind: "data_format_unreadable", path: HMCL, reason: "expected value at line 1 column 1" }]);
    // 没登记过的目录不受影响
    expect((await previewInstanceMove("1.20.1-Fabric", OFFICIAL)).blockers).toEqual([]);
  });

  it("登记的格式号不比这一版新是测试自己写错了：直接抛错", () => {
    expect(() => setMockGameDirDataProblem(HMCL, { kind: "data_too_new", found: 1, written_by: null, written_by_channel: null })).toThrow("登记的数据格式号 1 不比这一版的 1 新");
  });
});

describe("拦截项的形状", () => {
  it("逐项校验：认得的种类原样读回，种类不认识或字段类型不对都抛错", () => {
    expect(parseMoveBlocker({ kind: "links", paths: ["saves\联接"] }, "x")).toEqual({ kind: "links", paths: ["saves\联接"] });
    expect(parseMoveBlocker({ kind: "insufficient_space", needed: 10, available: 3 }, "x")).toEqual({ kind: "insufficient_space", needed: 10, available: 3 });
    expect(parseMoveBlocker({ kind: "source_changed" }, "x")).toEqual({ kind: "source_changed" });
    expect(() => parseMoveBlocker({ kind: "moved_away" }, "x")).toThrow("x 的种类不认识");
    expect(() => parseMoveBlocker({ kind: "base_conflict", bases: "1.21" }, "x")).toThrow("x.bases 应是字符串数组");
    expect(() => parseMoveBlocker({ kind: "insufficient_space", needed: -1, available: 3 }, "x")).toThrow("x.needed 应是非负整数");
  });

  it("目标游戏目录的数据格式两种：字段原样读回，版本与通道可以同为 null；字段缺失、类型不对或通道不认识都抛错", () => {
    const tooNew = { kind: "data_too_new", path: HMCL, found: 2, supported: 1, written_by: "1.1.0-dev.57", written_by_channel: "dev" };
    expect(parseMoveBlocker(tooNew, "x")).toEqual(tooNew);
    expect(parseMoveBlocker({ ...tooNew, written_by: null, written_by_channel: null }, "x")).toEqual({ ...tooNew, written_by: null, written_by_channel: null });
    expect(parseMoveBlocker({ kind: "data_format_unreadable", path: HMCL, reason: "expected value" }, "x")).toEqual({ kind: "data_format_unreadable", path: HMCL, reason: "expected value" });
    expect(() => parseMoveBlocker({ ...tooNew, written_by_channel: "preview" }, "x")).toThrow("x.written_by_channel 不认识");
    expect(() => parseMoveBlocker({ ...tooNew, found: 1.5 }, "x")).toThrow("x.found 应是非负整数");
    expect(() => parseMoveBlocker({ ...tooNew, supported: undefined }, "x")).toThrow("x.supported 应是非负整数");
    expect(() => parseMoveBlocker({ ...tooNew, path: 3 }, "x")).toThrow("x.path 应是字符串");
    expect(() => parseMoveBlocker({ kind: "data_format_unreadable", path: HMCL }, "x")).toThrow("x.reason 应是字符串");
  });

  it("moveBlockerOf 只认 instance_move_blocked；带着它却没有 detail 是契约破坏", () => {
    expect(moveBlockerOf(new IpcError("io", "磁盘满了"))).toBeNull();
    expect(moveBlockerOf(new Error("不是 IPC 错误"))).toBeNull();
    expect(() => moveBlockerOf(new IpcError("instance_move_blocked", "原文"))).toThrow("instance_move_blocked 没有带 detail");
  });
});

describe("执行", () => {
  it("跨盘：依次推四步，每步一批下载；提交后实例离开当前目录、侧栏固定去掉、备份带走，目标目录多一个版本", async () => {
    vi.useFakeTimers();
    await addGameDirectory("官方启动器", OFFICIAL);
    const events = recordEvents("t-cross");
    const pending = moveInstance("t-cross", "樱花生存", SOURCE, OFFICIAL);
    await vi.advanceTimersByTimeAsync(MOCK_STEP_MS);
    expect((await listInstances()).find((i) => i.id === "樱花生存")?.activity).toBe("moving");
    expect((await rejection(renameInstance("樱花生存", "换个名"))).detail).toEqual({ id: "樱花生存", activity: "moving" });
    await vi.advanceTimersByTimeAsync(3 * PHASE_MS + MOCK_STEP_MS);
    const outcome: MoveOutcomeDto = await pending;
    expect(outcome).toEqual({ id: "樱花生存", source: SOURCE, target: OFFICIAL, target_name: "官方启动器", registered: false, follow_ups: [] });
    const plan = ["move_dependencies", "move_copy", "move_verify", "move_commit"];
    expect(events.phases).toEqual(plan.map((_, index) => ({ plan, index })));
    // 官方目录里已有游戏文件，依赖只补一小批；复制与校验各一批，文件数含三份备份，字节含实例与备份
    expect(events.totals).toEqual([
      { files: 186, bytes: 186 * Math.round((94 * MB) / 186) },
      { files: 1833, bytes: 1833 * Math.round((920 * MB) / 1833) },
      { files: 1833, bytes: 1833 * Math.round((920 * MB) / 1833) },
    ]);
    expect((await listInstances()).map((i) => i.id)).not.toContain("樱花生存");
    expect(await getSidebarPins()).toEqual(["1.21.1"]);
    expect((await listGameDirectories()).find((d) => d.path === OFFICIAL)?.version_count).toBe(4);
  });

  it("同一个盘上只推两步；没记过的目标移动后记进游戏目录列表", async () => {
    vi.useFakeTimers();
    const target = "D:\\新家\\.minecraft";
    const events = recordEvents("t-same");
    const pending = moveInstance("t-same", "1.21", SOURCE, target);
    await vi.advanceTimersByTimeAsync(PHASE_MS + 2 * MOCK_STEP_MS);
    expect(await pending).toMatchObject({ target, target_name: "新家", registered: true, follow_ups: [] });
    expect(events.phases.map((p) => p.plan)).toEqual([
      ["move_dependencies", "move_commit"],
      ["move_dependencies", "move_commit"],
    ]);
    const dirs = await listGameDirectories();
    expect(dirs.find((d) => d.path === target)).toEqual({ name: "新家", path: target, is_current: false, available: true, version_count: 1 });
    // 当前目录没变：只是实例走了
    expect((await getConfig()).game_dir).toBe(SOURCE);
  });

  it("开工前重新预检：有拦截项时以 instance_move_blocked 拒绝，detail.blocker 是第一项，实例原样留着", async () => {
    await addGameDirectory("HMCL", HMCL);
    const error = await rejection(moveInstance("t-blocked", "樱花生存", SOURCE, HMCL));
    expect(error.code).toBe("instance_move_blocked");
    expect(error.detail).toEqual({ id: "樱花生存", blocker: { kind: "name_taken" } });
    expect(moveBlockerOf(error)).toEqual({ kind: "name_taken" });
    expect((await listInstances()).find((i) => i.id === "樱花生存")?.activity).toBeNull();
  });

  it("开工前重新预检时目标被更新的版本用过：以 instance_move_blocked 拒绝，blocker 带着用过它的版本，实例原样留着", async () => {
    setMockGameDirDataProblem(OFFICIAL, { kind: "data_too_new", found: 3, written_by: "1.2.0-beta.1", written_by_channel: "beta" });
    const error = await rejection(moveInstance("t-too-new", "樱花生存", SOURCE, OFFICIAL));
    const blocker = { kind: "data_too_new", path: OFFICIAL, found: 3, supported: 1, written_by: "1.2.0-beta.1", written_by_channel: "beta" };
    expect(error.code).toBe("instance_move_blocked");
    expect(error.detail).toEqual({ id: "樱花生存", blocker });
    expect(moveBlockerOf(error)).toEqual(blocker);
    expect((await listInstances()).find((i) => i.id === "樱花生存")?.activity).toBeNull();
  });

  it("发起时的源目录已不是当前游戏目录：以 instance_move_blocked 拒绝，blocker 为 source_changed，当前目录里的同名实例原样留着", async () => {
    const error = await rejection(moveInstance("t-source", "樱花生存", "E:\\旧家\\.minecraft", OFFICIAL));
    expect(error.code).toBe("instance_move_blocked");
    expect(error.detail).toEqual({ id: "樱花生存", blocker: { kind: "source_changed" } });
    expect(moveBlockerOf(error)).toEqual({ kind: "source_changed" });
    const kept = (await listInstances()).find((i) => i.id === "樱花生存");
    expect(kept?.activity).toBeNull();
    expect(await getSidebarPins()).toEqual(["樱花生存", "1.21.1"]);
  });

  it("源目录按同一路径的口径比：大小写、斜杠与末尾分隔符不同照样认作当前目录", async () => {
    vi.useFakeTimers();
    const pending = moveInstance("t-spelling", "1.21", "d:/games/launcher/.minecraft/", "D:\\新家\\.minecraft");
    await vi.advanceTimersByTimeAsync(PHASE_MS + 2 * MOCK_STEP_MS);
    expect(await pending).toMatchObject({ id: "1.21", source: SOURCE, follow_ups: [] });
  });

  it("复制途中取消：以 cancelled 拒绝，实例还在原处；进入提交后再取消不再生效", async () => {
    vi.useFakeTimers();
    const first = rejection(moveInstance("t-cancel", "1.21", SOURCE, OFFICIAL));
    await vi.advanceTimersByTimeAsync(MOCK_STEP_MS);
    expect(await cancelTask("t-cancel")).toBe(true);
    await vi.advanceTimersByTimeAsync(MOCK_STEP_MS);
    expect((await first).code).toBe("cancelled");
    expect((await listInstances()).map((i) => i.id)).toContain("1.21");

    const events = recordEvents("t-late");
    const second = moveInstance("t-late", "1.21", SOURCE, OFFICIAL);
    await vi.advanceTimersByTimeAsync(3 * PHASE_MS);
    expect(events.phases.at(-1)).toEqual({ plan: ["move_dependencies", "move_copy", "move_verify", "move_commit"], index: 3 });
    await cancelTask("t-late");
    await vi.advanceTimersByTimeAsync(MOCK_STEP_MS);
    expect((await second).id).toBe("1.21");
    expect((await listInstances()).map((i) => i.id)).not.toContain("1.21");
  });

  it("游玩记录、存档备份没跟过去：照成功返回，逐项记进 follow_ups", async () => {
    vi.useFakeTimers();
    failNextMockPlayRecords("记录文件被占用");
    failNextMockBackupsMove("拒绝访问。 (os error 5)");
    const pending = moveInstance("t-follow", "樱花生存", SOURCE, "C:\\新家\\.minecraft");
    await vi.advanceTimersByTimeAsync(3 * PHASE_MS + MOCK_STEP_MS);
    expect((await pending).follow_ups).toEqual([
      { kind: "play_records", reason: "记录文件被占用" },
      { kind: "world_backups", reason: "拒绝访问。 (os error 5)" },
    ]);
  });

  it("配置没存上：照成功返回，follow_ups 多一项 config；新目标没记进游戏目录列表，开关只管一次", async () => {
    vi.useFakeTimers();
    failNextMockMoveConfig("拒绝访问。 (os error 5)");
    const target = "D:\\新家\\.minecraft";
    const first = moveInstance("t-config", "1.21", SOURCE, target);
    await vi.advanceTimersByTimeAsync(PHASE_MS + 2 * MOCK_STEP_MS);
    expect(await first).toEqual({ id: "1.21", source: SOURCE, target, target_name: "新家", registered: false, follow_ups: [{ kind: "config", reason: "拒绝访问。 (os error 5)" }] });
    expect((await listInstances()).map((i) => i.id)).not.toContain("1.21");
    expect((await listGameDirectories()).map((d) => d.path)).not.toContain(target);

    const second = moveInstance("t-config-2", "1.21.1", SOURCE, target);
    await vi.advanceTimersByTimeAsync(PHASE_MS + 2 * MOCK_STEP_MS);
    expect(await second).toMatchObject({ registered: true, follow_ups: [] });
    expect((await listGameDirectories()).map((d) => d.path)).toContain(target);
  });
});
