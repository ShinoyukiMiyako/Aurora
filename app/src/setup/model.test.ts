import { describe, expect, it } from "vitest";
import { APP_NAME_EN } from "../lib/app-info";
import type { Channel, DataBlock, DirCheck, Existing, ExistingKind, Failure, FailureCode, InstallMode, InstallPlan, Probe, Progress } from "./contract";
import {
  allowedModes,
  canCloseWindow,
  canOpenLegal,
  dirNotice,
  failureRecovery,
  initialState,
  installedCase,
  installedDir,
  offersStandardInstaller,
  reduce,
  relaunchesAfterUpdate,
  remindsChannelRevert,
  replay,
  stepDirection,
  stepKey,
  switchingTo,
  unattendedMode,
  withAppFolder,
  type InstalledCase,
  type SetupEvent,
  type SetupState,
  type View,
} from "./model";

const ALL_VIEWS: readonly View[] = ["boot", "preparing", "welcome", "location", "installed", "blocked", "installing", "done", "failed", "legal", "fatal"];

const DEFAULT_DIR = String.raw`C:\Users\a\AppData\Local\app`;
const CHOSEN_DIR = String.raw`D:\游戏 目录\app`;

/** 交互启动、数据放行时后端给每种现有安装的允许模式。更新模式、数据拦截和故意与种类对不上的情形由用例自己写。 */
const INTERACTIVE_MODES: Readonly<Record<ExistingKind, readonly InstallMode[]>> = { upgrade: ["upgrade"], same: ["repair"], broken: ["repair"], newer: [], switch: ["switch"] };

const probeOf = (existing: Existing | null, extra: Partial<Probe> = {}): Probe => ({
  payloadVersion: "0.2.0",
  payloadChannel: "stable",
  defaultDir: DEFAULT_DIR,
  requiredBytes: 41_943_040,
  existing,
  interrupted: false,
  elevated: false,
  update: null,
  newerReason: existing?.kind === "newer" ? "same_channel" : null,
  allowedModes: existing === null ? ["fresh"] : [...INTERACTIVE_MODES[existing.kind]],
  unattended: null,
  handoff: existing?.kind === "switch",
  dataBlock: null,
  ...extra,
});
const existingOf = (kind: ExistingKind, channel: Channel | null = "stable"): Existing => ({ kind, version: "0.1.0", dir: String.raw`E:\app`, channel });
const checkOf = (extra: Partial<DirCheck> = {}): DirCheck => ({ normalized: CHOSEN_DIR, issue: null, hasConfig: false, notEmpty: false, appended: false, freeBytes: 1 << 30, dataBlock: null, ...extra });
const FAILURE: Failure = { code: "payload_exit", detail: "2" };
const PROGRESS: Progress = { phase: "write", percent: 40, slow: false };

/** 更新插件带 /R 拉起。 */
const RELAUNCH: Partial<Probe> = { update: { relaunch: true } };
/** 更新模式下后端判定能无人值守升级。 */
const UPDATE_UPGRADE: Partial<Probe> = { ...RELAUNCH, unattended: "upgrade" };
/** 带换通道开关的更新模式：无人值守换通道，更新模式不写交接记录。 */
const UPDATE_SWITCH: Partial<Probe> = { ...RELAUNCH, unattended: "switch", handoff: false };
/** 已装预览版，安装包是更慢通道上更早的测试版。 */
const switchProbe = (extra: Partial<Probe> = {}): Probe => probeOf(existingOf("switch", "dev"), { payloadChannel: "beta", ...extra });
/** 已装测试版，安装包是更快通道上更新的预览版，交互确认后写交接记录。 */
const fasterProbe = (extra: Partial<Probe> = {}): Probe => probeOf(existingOf("upgrade", "beta"), { payloadChannel: "dev", handoff: true, ...extra });

const TOO_NEW: DataBlock = { problem: "too_new", path: String.raw`E:\app\data-format.json`, recorded: 2, supported: 1, reason: null, writtenBy: "1.1.0-dev.61", writtenByChannel: "dev" };
const UNREADABLE: DataBlock = { problem: "unreadable", path: String.raw`E:\app\data-format.json`, recorded: null, supported: 1, reason: "缺 data_format", writtenBy: null, writtenByChannel: null };
/** 数据关拦下时后端给的：允许的模式为空、不无人值守、不写交接记录。 */
const blockedBy = (block: DataBlock): Partial<Probe> => ({ dataBlock: block, allowedModes: [], unattended: null, handoff: false });

const IN_PLACE = (mode: "upgrade" | "repair" | "switch"): InstallPlan => ({ mode, dir: null, desktopShortcut: false });

const probed = (existing: Existing | null = null, extra: Partial<Probe> = {}): SetupEvent => ({ type: "probed", probe: probeOf(existing, extra) });
const fresh = (running = false, check = checkOf()): SetupEvent => ({ type: "install_requested", mode: "fresh", running, check });
const upgrade = (running = false): SetupEvent => ({ type: "install_requested", mode: "upgrade", running });
const repair = (running = false): SetupEvent => ({ type: "install_requested", mode: "repair", running });
const switchTo = (running = false): SetupEvent => ({ type: "install_requested", mode: "switch", running });
const updateStarted = (running: boolean): SetupEvent => ({ type: "update_started", running });

/** 每个视图各摆一份走到那里的状态。 */
const AT: Readonly<Record<View, SetupState>> = {
  boot: initialState,
  preparing: replay([probed(existingOf("upgrade"), UPDATE_UPGRADE)]),
  welcome: replay([probed()]),
  location: replay([probed(), { type: "open_location" }]),
  installed: replay([probed(existingOf("upgrade"))]),
  blocked: replay([probed(), fresh(true)]),
  installing: replay([probed(), fresh()]),
  done: replay([probed(), fresh(), { type: "install_succeeded" }]),
  failed: replay([probed(), fresh(), { type: "install_failed", failure: FAILURE }]),
  legal: replay([probed(), { type: "open_legal" }]),
  fatal: replay([{ type: "crashed", detail: "x" }]),
};

describe("探测结果到视图", () => {
  it("没有现有安装进欢迎页，目录取默认位置", () => {
    const state = reduce(initialState, probed());
    expect(state.view).toBe("welcome");
    expect(state.dir).toBe(DEFAULT_DIR);
    expect(state.probe?.payloadVersion).toBe("0.2.0");
  });

  it.each<ExistingKind>(["upgrade", "same", "newer", "broken", "switch"])("现有安装 %s 进已安装页，目录锁定在原位置", (kind) => {
    const state = reduce(initialState, probed(existingOf(kind)));
    expect(state.view).toBe("installed");
    expect(state.dir).toBe(String.raw`E:\app`);
  });

  it("半装且没有现有安装时仍进欢迎页，probe 给的目录就是上次的目录", () => {
    const state = reduce(initialState, probed(null, { interrupted: true, defaultDir: CHOSEN_DIR }));
    expect(state.view).toBe("welcome");
    expect(state.dir).toBe(CHOSEN_DIR);
    expect(state.probe?.interrupted).toBe(true);
  });

  it("探测结果只在 boot 接受，晚到的不改视图", () => {
    expect(reduce(AT.installing, probed(existingOf("same")))).toBe(AT.installing);
  });
});

describe("探测结果的契约", () => {
  it.each<[string, Existing | null, Partial<Probe>, string]>([
    ["交互启动却带了无人值守的模式", existingOf("upgrade"), { unattended: "upgrade" }, "交互启动的探测结果带了无人值守的模式 upgrade"],
    ["无人值守的模式不在允许的模式里", existingOf("upgrade"), { ...RELAUNCH, unattended: "switch" }, "无人值守的模式 switch 不在允许的模式 [upgrade] 里"],
    ["无人值守给了首装", null, { ...RELAUNCH, unattended: "fresh" }, "无人值守只会是 upgrade 或 switch，探测结果给的是 fresh"],
    ["无人值守给了修复", existingOf("same"), { ...RELAUNCH, unattended: "repair" }, "无人值守只会是 upgrade 或 switch，探测结果给的是 repair"],
    ["数据关拦下却仍允许升级", existingOf("upgrade"), { dataBlock: TOO_NEW }, "数据关拦下了，探测结果却允许 [upgrade]"],
    ["没有现有安装却带了数据拦截", null, { dataBlock: TOO_NEW, allowedModes: [] }, "没有现有安装时探测结果不该带数据拦截"],
  ])("%s 时报错进致命错误页，不照着走", (_, existing, extra, message) => {
    expect(() => reduce(initialState, probed(existing, extra))).toThrow(message);
  });
});

describe("发起安装", () => {
  it("首装计划带校验后规整过的目录和快捷方式选择", () => {
    const state = reduce(AT.location, { type: "shortcut_changed", value: false });
    const started = reduce(state, fresh(false, checkOf({ normalized: String.raw`D:\Long Name\app` })));
    expect(started.view).toBe("installing");
    expect(started.plan).toEqual<InstallPlan>({ mode: "fresh", dir: String.raw`D:\Long Name\app`, desktopShortcut: false });
    expect(started.origin).toBe("location");
    expect(started.run).toBe(1);
  });

  it("升级、修复和换通道都不带目录，也不要快捷方式：用户删过的不能被装回来", () => {
    expect(replay([probed(existingOf("upgrade")), upgrade()]).plan).toEqual<InstallPlan>({ mode: "upgrade", dir: null, desktopShortcut: false });
    expect(replay([probed(existingOf("same")), repair()]).plan).toEqual<InstallPlan>({ mode: "repair", dir: null, desktopShortcut: false });
    expect(replay([probed(existingOf("broken")), repair()]).plan).toEqual<InstallPlan>({ mode: "repair", dir: null, desktopShortcut: false });
    expect(replay([{ type: "probed", probe: switchProbe() }, switchTo()]).plan).toEqual<InstallPlan>({ mode: "switch", dir: null, desktopShortcut: false });
  });

  it("启动器还开着时停在 blocked，不开始安装", () => {
    const state = reduce(AT.welcome, fresh(true));
    expect(state.view).toBe("blocked");
    expect(state.run).toBe(0);
    expect(state.plan?.dir).toBe(CHOSEN_DIR);
  });

  it("目录没过校验退回选目录页并带上这次的问题，不开始安装", () => {
    const bad = checkOf({ issue: "unwritable" });
    const state = reduce(AT.welcome, fresh(false, bad));
    expect(state.view).toBe("location");
    expect(state.dirCheck).toEqual(bad);
    expect(state.plan).toBeNull();
    expect(state.run).toBe(0);
  });

  it("首装目录被数据关拦下时同样退回选目录页，带着拦截详情", () => {
    const bad = checkOf({ issue: "data_incompatible", dataBlock: { ...TOO_NEW, path: String.raw`D:\游戏 目录\app\data-format.json` } });
    const state = reduce(AT.welcome, fresh(false, bad));
    expect(state.view).toBe("location");
    expect(state.dirCheck?.dataBlock?.writtenBy).toBe("1.1.0-dev.61");
    expect(state.run).toBe(0);
  });

  it("目录问题优先于进程检查：两个都有时先解决目录", () => {
    expect(reduce(AT.welcome, fresh(true, checkOf({ issue: "bang" }))).view).toBe("location");
  });

  it("改目录后旧的校验结果作废", () => {
    const state = reduce(AT.welcome, fresh(false, checkOf({ issue: "unwritable" })));
    expect(reduce(state, { type: "dir_changed", dir: CHOSEN_DIR }).dirCheck).toBeNull();
    expect(reduce(state, { type: "use_default_dir" }).dirCheck).toBeNull();
  });

  it.each<[string, InstallMode[]]>([
    ["首装", ["fresh"]],
    ["升级", ["upgrade"]],
    ["修复", ["repair"]],
    ["换通道", ["switch"]],
    ["什么都不能装", []],
  ])("允许的模式原样取自探测结果：%s", (_, modes) => {
    expect(allowedModes(probeOf(existingOf("upgrade"), { allowedModes: modes }))).toEqual(modes);
  });

  it("种类能升级、后端却一种都不允许时，升级请求不生效：界面不按种类自己推", () => {
    const state = reduce(initialState, probed(existingOf("upgrade"), { allowedModes: [] }));
    expect(state.view).toBe("installed");
    expect(reduce(state, upgrade())).toBe(state);
  });

  it("种类是 same、后端允许升级时接受升级：放行只看允许的模式", () => {
    const state = reduce(initialState, probed(existingOf("same"), { allowedModes: ["upgrade"] }));
    expect(reduce(state, upgrade()).plan).toEqual(IN_PLACE("upgrade"));
    expect(reduce(state, repair())).toBe(state);
  });

  it.each<[string, Probe, "upgrade" | "repair" | "switch"]>([
    ["升级", probeOf(existingOf("upgrade")), "upgrade"],
    ["修复", probeOf(existingOf("same")), "repair"],
    ["换通道", switchProbe(), "switch"],
  ])("已安装页只接受允许的那一种：%s", (_, probe, allowed) => {
    const state = reduce(initialState, { type: "probed", probe });
    const requests = { upgrade: upgrade(), repair: repair(), switch: switchTo() };
    for (const [mode, request] of Object.entries(requests)) {
      const next = reduce(state, request);
      expect(next.plan).toEqual(mode === allowed ? IN_PLACE(allowed) : null);
    }
  });

  it("已安装更新版本时任何安装请求都不生效", () => {
    const state = reduce(initialState, probed(existingOf("newer")));
    expect(reduce(state, upgrade())).toBe(state);
    expect(reduce(state, repair())).toBe(state);
    expect(reduce(state, switchTo())).toBe(state);
    expect(reduce(state, fresh())).toBe(state);
  });

  it("有现有安装时不接受首装：那会把目录改走，旧目录成孤儿", () => {
    expect(reduce(AT.installed, fresh())).toBe(AT.installed);
  });

  it.each<View>(["boot", "preparing", "blocked", "installing", "done", "legal", "fatal"])("在 %s 发起安装不生效", (view) => {
    expect(reduce(AT[view], fresh())).toBe(AT[view]);
  });
});

describe("更新模式", () => {
  const updateProbed = (extra: Partial<Probe> = {}) => probed(existingOf("upgrade"), { ...UPDATE_UPGRADE, ...extra });
  const UPGRADE_PLAN = IN_PLACE("upgrade");

  it("能升级时探测后直接进准备页，探测结果和登记目录已经记下，还没开始安装", () => {
    const state = reduce(initialState, updateProbed());
    expect(state.view).toBe("preparing");
    expect(state.probe?.update).toEqual({ relaunch: true });
    expect(state.dir).toBe(String.raw`E:\app`);
    expect(state.plan).toBeNull();
    expect(state.run).toBe(0);
  });

  it("等到启动器退出后直接进安装：升级、装回登记目录、不要快捷方式，按已安装页发起", () => {
    const state = replay([updateProbed(), updateStarted(false)]);
    expect(state.view).toBe("installing");
    expect(state.run).toBe(1);
    expect(state.plan).toEqual(UPGRADE_PLAN);
    expect(state.origin).toBe("installed");
    expect(state.keptData).toBe(true);
    expect(installedDir(state)).toBe(String.raw`E:\app`);
  });

  it("启动器一直不退出时进 blocked 不开始安装，进程消失后接着装", () => {
    const blocked = replay([updateProbed(), updateStarted(true)]);
    expect(blocked.view).toBe("blocked");
    expect(blocked.run).toBe(0);
    expect(blocked.plan).toEqual(UPGRADE_PLAN);
    const resumed = reduce(blocked, { type: "launcher_gone" });
    expect(resumed.view).toBe("installing");
    expect(resumed.run).toBe(1);
  });

  it("拦截页返回落在已安装页，那里还能手动升级", () => {
    const back = reduce(replay([updateProbed(), updateStarted(true)]), { type: "blocked_back" });
    expect(back.view).toBe("installed");
    expect(back.plan).toBeNull();
    expect(reduce(back, upgrade()).plan).toEqual(UPGRADE_PLAN);
  });

  it("失败后重试仍是升级，轮次加一；返回落在已安装页", () => {
    const failed = replay([updateProbed(), updateStarted(false), { type: "install_failed", failure: FAILURE }]);
    expect(failed.view).toBe("failed");
    const retried = reduce(failed, upgrade());
    expect(retried.view).toBe("installing");
    expect(retried.run).toBe(2);
    expect(retried.plan).toEqual(UPGRADE_PLAN);
    expect(retried.origin).toBe("installed");
    expect(reduce(failed, { type: "failed_back" }).view).toBe("installed");
  });

  it.each<[string, Existing | null, View]>([
    ["same", existingOf("same"), "installed"],
    ["newer", existingOf("newer"), "installed"],
    ["broken", existingOf("broken"), "installed"],
    ["没有现有安装", null, "welcome"],
  ])("后端不给无人值守的模式（现有安装是 %s）时退回交互流程，开始事件不生效", (_, existing, view) => {
    const state = reduce(initialState, probed(existing, RELAUNCH));
    expect(state.view).toBe(view);
    expect(reduce(state, updateStarted(false))).toBe(state);
    expect(reduce(state, updateStarted(true))).toBe(state);
  });

  it("种类能升级、后端却不给无人值守的模式时也退回已安装页：进不进准备页只看后端", () => {
    const state = reduce(initialState, probed(existingOf("upgrade"), RELAUNCH));
    expect(state.view).toBe("installed");
    expect(reduce(state, updateStarted(false))).toBe(state);
  });

  it("交互启动时照旧进已安装页，开始事件不生效", () => {
    expect(reduce(AT.installed, updateStarted(false))).toBe(AT.installed);
  });

  it("探测之前和已经开始之后都不接受：晚到的结果不会让安装再跑一轮", () => {
    expect(reduce(initialState, updateStarted(false))).toBe(initialState);
    const installing = replay([updateProbed(), updateStarted(false)]);
    expect(reduce(installing, updateStarted(false))).toBe(installing);
    const blocked = replay([updateProbed(), updateStarted(true)]);
    expect(reduce(blocked, updateStarted(false))).toBe(blocked);
  });

  it("等待期间界面上的安装请求不生效：发起安装只认更新流程这一条", () => {
    const waiting = reduce(initialState, updateProbed());
    expect(reduce(waiting, upgrade())).toBe(waiting);
  });

  it.each<[string, Probe, "upgrade" | "switch" | null]>([
    ["更新模式、后端判定能升级", probeOf(existingOf("upgrade"), UPDATE_UPGRADE), "upgrade"],
    ["带开关的更新模式、更慢通道上更早的包", switchProbe(UPDATE_SWITCH), "switch"],
    ["更新模式、后端判定退回交互", probeOf(existingOf("upgrade"), RELAUNCH), null],
    ["交互启动", probeOf(existingOf("upgrade")), null],
  ])("%s 时无人值守的模式是 %s", (_, probe, mode) => {
    expect(unattendedMode(probe)).toBe(mode);
  });

  it.each<[string, boolean, Probe]>([
    ["无人值守升级、带了 /R", true, probeOf(existingOf("upgrade"), UPDATE_UPGRADE)],
    ["无人值守换通道、带了 /R", true, switchProbe(UPDATE_SWITCH)],
    ["没带 /R", false, probeOf(existingOf("upgrade"), { ...UPDATE_UPGRADE, update: { relaunch: false } })],
    ["换通道没带 /R", false, switchProbe({ ...UPDATE_SWITCH, update: { relaunch: false } })],
    ["提权运行", false, probeOf(existingOf("upgrade"), { ...UPDATE_UPGRADE, elevated: true })],
    ["换通道时提权运行", false, switchProbe({ ...UPDATE_SWITCH, elevated: true })],
    ["更新模式退回交互流程", false, probeOf(existingOf("same"), RELAUNCH)],
    ["交互启动", false, probeOf(existingOf("upgrade"))],
  ])("%s 时装完替用户打开：%s", (_, expected, probe) => {
    expect(relaunchesAfterUpdate(probe)).toBe(expected);
  });
});

describe("换通道", () => {
  const SWITCH_PLAN = IN_PLACE("switch");

  it("交互启动进已安装页等用户确认；确认后按 switch 装回登记目录，说数据还在", () => {
    const state = reduce(initialState, { type: "probed", probe: switchProbe() });
    expect(state.view).toBe("installed");
    expect(state.plan).toBeNull();
    const installing = reduce(state, switchTo());
    expect(installing.view).toBe("installing");
    expect(installing.plan).toEqual(SWITCH_PLAN);
    expect(installing.keptData).toBe(true);
    expect(installing.origin).toBe("installed");
    expect(installedDir(installing)).toBe(String.raw`E:\app`);
  });

  it("交互的换到更快通道也进已安装页，确认后按 upgrade 装", () => {
    const state = reduce(initialState, { type: "probed", probe: fasterProbe() });
    expect(state.view).toBe("installed");
    expect(reduce(state, upgrade()).plan).toEqual(IN_PLACE("upgrade"));
    expect(reduce(state, switchTo())).toBe(state);
  });

  it("交互确认时启动器还开着：停在 blocked，进程消失后按 switch 接着装", () => {
    const blocked = replay([{ type: "probed", probe: switchProbe() }, switchTo(true)]);
    expect(blocked.view).toBe("blocked");
    expect(blocked.plan).toEqual(SWITCH_PLAN);
    expect(reduce(blocked, { type: "launcher_gone" }).view).toBe("installing");
  });

  it("带开关的更新模式直接进准备页，启动器退出后按 switch 装回登记目录，装完重开", () => {
    const probe = switchProbe(UPDATE_SWITCH);
    const preparing = reduce(initialState, { type: "probed", probe });
    expect(preparing.view).toBe("preparing");
    expect(preparing.plan).toBeNull();
    const installing = reduce(preparing, updateStarted(false));
    expect(installing.view).toBe("installing");
    expect(installing.plan).toEqual(SWITCH_PLAN);
    expect(installing.origin).toBe("installed");
    expect(installing.keptData).toBe(true);
    expect(reduce(installing, { type: "install_succeeded" }).view).toBe("done");
    expect(relaunchesAfterUpdate(probe)).toBe(true);
  });

  it("带开关的更新模式：启动器不退出时进 blocked，失败后重试仍按 switch，返回落在已安装页", () => {
    const probe = switchProbe(UPDATE_SWITCH);
    const blocked = replay([{ type: "probed", probe }, updateStarted(true)]);
    expect(blocked.view).toBe("blocked");
    expect(blocked.plan).toEqual(SWITCH_PLAN);
    const failed = replay([{ type: "probed", probe }, updateStarted(false), { type: "install_failed", failure: FAILURE }]);
    const retried = reduce(failed, switchTo());
    expect(retried.plan).toEqual(SWITCH_PLAN);
    expect(retried.run).toBe(2);
    expect(reduce(failed, upgrade())).toBe(failed);
    expect(reduce(failed, { type: "failed_back" }).view).toBe("installed");
  });

  it("不带开关的更新模式遇到更慢通道上更早的包（后端判 newer）：停在已安装页，什么都不装", () => {
    const probe = probeOf(existingOf("newer", "dev"), { ...RELAUNCH, payloadChannel: "beta", newerReason: "slower_channel" });
    const state = reduce(initialState, { type: "probed", probe });
    expect(state.view).toBe("installed");
    expect(reduce(state, updateStarted(false))).toBe(state);
    expect(reduce(state, switchTo())).toBe(state);
    expect(relaunchesAfterUpdate(probe)).toBe(false);
  });
});

describe("数据拦截", () => {
  it.each<[string, Existing, Partial<Probe>]>([
    ["upgrade", existingOf("upgrade"), {}],
    ["same", existingOf("same"), {}],
    ["broken", existingOf("broken"), {}],
    ["newer", existingOf("newer"), {}],
    ["switch", existingOf("switch", "dev"), { payloadChannel: "beta" }],
  ])("交互启动、现有安装是 %s：停在已安装页，任何安装请求都不生效", (_, existing, extra) => {
    for (const block of [TOO_NEW, UNREADABLE]) {
      const probe = probeOf(existing, { ...extra, ...blockedBy(block) });
      const state = reduce(initialState, { type: "probed", probe });
      expect(state.view).toBe("installed");
      for (const request of [upgrade(), repair(), switchTo(), fresh()]) expect(reduce(state, request)).toBe(state);
      expect(installedCase(probe)).toEqual<InstalledCase>({ kind: "data_blocked", block, closedForUpdate: false });
    }
  });

  it.each<[string, DataBlock]>([
    ["数据太新", TOO_NEW],
    ["记号读不懂", UNREADABLE],
  ])("更新模式下%s：不进准备页、停在已安装页，开始事件不生效，说明要提启动器是为更新关掉的", (_, block) => {
    const probe = probeOf(existingOf("upgrade"), { ...RELAUNCH, ...blockedBy(block) });
    const state = reduce(initialState, { type: "probed", probe });
    expect(state.view).toBe("installed");
    expect(reduce(state, updateStarted(false))).toBe(state);
    expect(reduce(state, upgrade())).toBe(state);
    expect(relaunchesAfterUpdate(probe)).toBe(false);
    expect(installedCase(probe)).toEqual<InstalledCase>({ kind: "data_blocked", block, closedForUpdate: true });
  });
});

describe("已安装页的情形", () => {
  it.each<[string, Probe, InstalledCase]>([
    ["同通道升级", probeOf(existingOf("upgrade")), { kind: "upgrade" }],
    ["认不出已装通道的升级", probeOf(existingOf("upgrade", null)), { kind: "upgrade" }],
    ["认不出安装包通道的升级", probeOf(existingOf("upgrade", "beta"), { payloadChannel: null }), { kind: "upgrade" }],
    ["交互的换到更快通道", fasterProbe(), { kind: "switch_to", mode: "upgrade", channels: { installed: "beta", payload: "dev" } }],
    ["升到更慢通道上更新的版本", probeOf(existingOf("upgrade", "beta"), { payloadChannel: "stable" }), { kind: "cross_upgrade", channels: { installed: "beta", payload: "stable" } }],
    [
      "更新模式里跟到更快通道的升级不说「换到」",
      probeOf(existingOf("upgrade", "beta"), { ...UPDATE_UPGRADE, payloadChannel: "dev" }),
      { kind: "cross_upgrade", channels: { installed: "beta", payload: "dev" } },
    ],
    ["交互的换到更慢通道", switchProbe(), { kind: "switch_to", mode: "switch", channels: { installed: "dev", payload: "beta" } }],
    ["带开关的更新模式退回已安装页", switchProbe(UPDATE_SWITCH), { kind: "switch_to", mode: "switch", channels: { installed: "dev", payload: "beta" } }],
    ["same", probeOf(existingOf("same")), { kind: "same" }],
    ["更新模式退回的 same", probeOf(existingOf("same"), RELAUNCH), { kind: "same" }],
    ["broken", probeOf(existingOf("broken")), { kind: "broken" }],
    ["newer，同通道", probeOf(existingOf("newer")), { kind: "newer", reason: "same_channel", closedForUpdate: false }],
    [
      "newer，安装包在更快通道",
      probeOf(existingOf("newer", "stable"), { payloadChannel: "beta", newerReason: "faster_channel" }),
      { kind: "newer", reason: "faster_channel", channels: { installed: "stable", payload: "beta" }, closedForUpdate: false },
    ],
    [
      "newer，更新模式不带开关遇到更慢通道",
      probeOf(existingOf("newer", "dev"), { ...RELAUNCH, payloadChannel: "beta", newerReason: "slower_channel" }),
      { kind: "newer", reason: "slower_channel", channels: { installed: "dev", payload: "beta" }, closedForUpdate: true },
    ],
    ["newer，认不出通道", probeOf(existingOf("newer", null), { newerReason: "unknown_channel" }), { kind: "newer", reason: "unknown_channel", closedForUpdate: false }],
    ["更新模式停在 newer", probeOf(existingOf("newer"), RELAUNCH), { kind: "newer", reason: "same_channel", closedForUpdate: true }],
    ["数据太新盖过换通道", switchProbe(blockedBy(TOO_NEW)), { kind: "data_blocked", block: TOO_NEW, closedForUpdate: false }],
    ["记号读不懂盖过 newer", probeOf(existingOf("newer"), blockedBy(UNREADABLE)), { kind: "data_blocked", block: UNREADABLE, closedForUpdate: false }],
  ])("%s", (_, probe, expected) => {
    expect(installedCase(probe)).toEqual(expected);
  });

  it.each<[string, Probe, string]>([
    ["没有现有安装", probeOf(null), "没有现有安装，不该进已安装页"],
    ["newer 没给原因", probeOf(existingOf("newer"), { newerReason: null }), "种类是 newer，探测结果却没给原因"],
    ["换到更快通道却认不出已装的通道", fasterProbe({ existing: existingOf("upgrade", null) }), "换到更快的通道要两边的通道都认得"],
    ["换到更慢通道却认不出安装包的通道", switchProbe({ payloadChannel: null }), "换到更慢的通道要两边的通道都认得"],
    ["跨通道的 newer 认不出通道", probeOf(existingOf("newer", null), { newerReason: "faster_channel" }), "newer 的原因 faster_channel 要两边的通道都认得"],
  ])("%s 时报错，不让页面猜", (_, probe, message) => {
    expect(() => installedCase(probe)).toThrow(message);
  });
});

describe("安装中与完成页说不说「换到」", () => {
  it.each<[string, InstallMode, Probe, Channel | null]>([
    ["交互的换到更慢通道", "switch", switchProbe(), "beta"],
    ["带开关的更新模式", "switch", switchProbe(UPDATE_SWITCH), "beta"],
    ["交互的换到更快通道", "upgrade", fasterProbe(), "dev"],
    ["升到更慢通道上更新的版本", "upgrade", probeOf(existingOf("upgrade", "beta"), { payloadChannel: "stable" }), null],
    ["更新模式跟到另一个通道", "upgrade", probeOf(existingOf("upgrade", "beta"), { ...UPDATE_UPGRADE, payloadChannel: "dev" }), null],
    ["同通道升级", "upgrade", probeOf(existingOf("upgrade")), null],
    ["修复", "repair", probeOf(existingOf("same")), null],
    ["首装", "fresh", probeOf(null), null],
  ])("%s：%s 计划换到 %s", (_, mode, probe, channel) => {
    expect(switchingTo(mode, probe)).toBe(channel);
  });

  it("换通道却认不出安装包的通道时报错", () => {
    expect(() => switchingTo("switch", switchProbe({ payloadChannel: null }))).toThrow("按 switch 换通道却认不出安装包的通道");
  });
});

describe("启动器还开着", () => {
  it("进程消失后进入安装，沿用发起时的计划", () => {
    const state = reduce(AT.blocked, { type: "launcher_gone" });
    expect(state.view).toBe("installing");
    expect(state.run).toBe(1);
    expect(state.plan?.dir).toBe(CHOSEN_DIR);
  });

  it("返回发起安装的视图并丢掉计划", () => {
    const fromLocation = replay([probed(), { type: "open_location" }, fresh(true)]);
    const state = reduce(fromLocation, { type: "blocked_back" });
    expect(state.view).toBe("location");
    expect(state.plan).toBeNull();
  });

  it("返回之后晚到的进程结果不再开始安装", () => {
    const state = reduce(AT.blocked, { type: "blocked_back" });
    expect(reduce(state, { type: "launcher_gone" })).toBe(state);
  });
});

describe("安装中", () => {
  it("进度只增不减，阶段和慢提示取最新的", () => {
    const first = reduce(AT.installing, { type: "progress", progress: PROGRESS });
    const second = reduce(first, { type: "progress", progress: { phase: "verify", percent: 12, slow: true } });
    expect(second.progress).toEqual<Progress>({ phase: "verify", percent: 40, slow: true });
  });

  it("进度事件晚到时不改视图", () => {
    expect(reduce(AT.done, { type: "progress", progress: PROGRESS })).toBe(AT.done);
  });

  it("成功进完成页，失败进失败页并带上原因", () => {
    expect(reduce(AT.installing, { type: "install_succeeded" }).view).toBe("done");
    const failed = reduce(AT.installing, { type: "install_failed", failure: FAILURE });
    expect(failed.view).toBe("failed");
    expect(failed.failure).toEqual(FAILURE);
  });

  it.each<View>(["welcome", "location", "blocked", "done", "failed"])("安装结果只在 installing 接受：%s 不受影响", (view) => {
    expect(reduce(AT[view], { type: "install_succeeded" })).toBe(AT[view]);
    expect(reduce(AT[view], { type: "install_failed", failure: FAILURE })).toBe(AT[view]);
  });
});

describe("失败之后", () => {
  it("重试走同一个发起视图，轮次加一，清掉上次的失败和进度", () => {
    const withProgress = reduce(AT.installing, { type: "progress", progress: PROGRESS });
    const failed = reduce(withProgress, { type: "install_failed", failure: FAILURE });
    const retried = reduce(failed, fresh());
    expect(retried.view).toBe("installing");
    expect(retried.run).toBe(2);
    expect(retried.failure).toBeNull();
    expect(retried.progress).toBeNull();
    expect(retried.origin).toBe("welcome");
  });

  it("换位置进选目录页", () => {
    const state = reduce(AT.failed, { type: "open_location" });
    expect(state.view).toBe("location");
    expect(state.failure).toBeNull();
  });

  it("覆盖安装失败后不能进选目录页", () => {
    const failed = replay([probed(existingOf("upgrade")), upgrade(), { type: "install_failed", failure: FAILURE }]);
    expect(reduce(failed, { type: "open_location" })).toBe(failed);
  });

  it("返回发起安装的视图", () => {
    const failed = replay([probed(existingOf("upgrade")), upgrade(), { type: "install_failed", failure: FAILURE }]);
    expect(reduce(failed, { type: "failed_back" }).view).toBe("installed");
    expect(reduce(AT.failed, { type: "failed_back" }).view).toBe("welcome");
  });

  it.each<[FailureCode, InstallMode, "change_location" | "retry"]>([
    ["dir_unwritable", "fresh", "change_location"],
    ["disk_full", "fresh", "change_location"],
    ["extract_failed", "fresh", "retry"],
    ["payload_exit", "fresh", "retry"],
    ["verify_failed", "fresh", "retry"],
    ["dir_unwritable", "upgrade", "retry"],
    ["disk_full", "repair", "retry"],
    ["dir_unwritable", "switch", "retry"],
    ["disk_full", "switch", "retry"],
  ])("%s 在 %s 下的主动作是 %s", (code, mode, recovery) => {
    expect(failureRecovery(code, { mode, dir: null, desktopShortcut: true })).toBe(recovery);
  });

  const FAILURE_CODES: readonly FailureCode[] = ["dir_unwritable", "disk_full", "extract_failed", "payload_exit", "verify_failed"];
  const OFFERED: ReadonlySet<FailureCode> = new Set(["payload_exit", "verify_failed"]);
  const MODES: readonly InstallMode[] = ["fresh", "upgrade", "repair", "switch"];

  it.each(FAILURE_CODES.flatMap((code) => MODES.map((mode): [FailureCode, InstallMode, boolean] => [code, mode, mode !== "switch" && OFFERED.has(code)])))(
    "%s 在 %s 下提供标准安装程序：%s",
    (code, mode, offered) => {
      expect(offersStandardInstaller(code, { mode, dir: null, desktopShortcut: false })).toBe(offered);
    },
  );

  it.each<[string, InstallMode, Probe, boolean]>([
    ["带开关的更新模式按 switch 装", "switch", switchProbe(UPDATE_SWITCH), true],
    ["交互的换到更慢通道", "switch", switchProbe(), false],
    ["交互的换到更快通道", "upgrade", fasterProbe(), false],
    ["更新模式的升级", "upgrade", probeOf(existingOf("upgrade"), UPDATE_UPGRADE), false],
    ["首装", "fresh", probeOf(null), false],
  ])("%s 失败时补不补回到原来通道的说明：%s", (_, mode, probe, reminds) => {
    expect(remindsChannelRevert({ mode, dir: null, desktopShortcut: false }, probe)).toBe(reminds);
  });
});

describe("完成页的说明", () => {
  it("首装到空目录不提数据", () => {
    expect(replay([probed(), fresh()]).keptData).toBe(false);
  });

  it("首装到已有 config.json 的目录说数据还在", () => {
    expect(replay([probed(), fresh(false, checkOf({ hasConfig: true }))]).keptData).toBe(true);
  });

  it("升级、修复和换通道说数据还在", () => {
    expect(replay([probed(existingOf("upgrade")), upgrade()]).keptData).toBe(true);
    expect(replay([probed(existingOf("same")), repair()]).keptData).toBe(true);
    expect(replay([{ type: "probed", probe: switchProbe() }, switchTo()]).keptData).toBe(true);
  });
});

describe("欢迎页与选目录页", () => {
  it("互通，返回时丢掉没用上的校验结果", () => {
    const state = reduce(AT.welcome, fresh(false, checkOf({ issue: "bang" })));
    const back = reduce(state, { type: "leave_location" });
    expect(back.view).toBe("welcome");
    expect(back.dirCheck).toBeNull();
    expect(reduce(back, { type: "open_location" }).view).toBe("location");
  });

  it("用回默认位置", () => {
    const state = reduce(AT.location, { type: "dir_changed", dir: CHOSEN_DIR });
    expect(state.dir).toBe(CHOSEN_DIR);
    expect(reduce(state, { type: "use_default_dir" }).dir).toBe(DEFAULT_DIR);
  });

  it.each<View>(["welcome", "installed", "installing", "done"])("目录和快捷方式只在选目录页能改：%s 不受影响", (view) => {
    expect(reduce(AT[view], { type: "dir_changed", dir: "x" })).toBe(AT[view]);
    expect(reduce(AT[view], { type: "use_default_dir" })).toBe(AT[view]);
    expect(reduce(AT[view], { type: "shortcut_changed", value: false })).toBe(AT[view]);
  });

  it("已安装页不能进选目录页：换位置等于搬数据目录", () => {
    expect(reduce(AT.installed, { type: "open_location" })).toBe(AT.installed);
  });
});

describe("协议页", () => {
  it.each<View>(["welcome", "location", "installed", "blocked", "done", "failed"])("从 %s 进去再回到原处", (view) => {
    const legal = reduce(AT[view], { type: "open_legal" });
    expect(legal.view).toBe("legal");
    expect(reduce(legal, { type: "close_legal" }).view).toBe(view);
  });

  it.each<View>(["boot", "installing", "legal", "fatal"])("%s 不能进协议页", (view) => {
    expect(canOpenLegal(view)).toBe(false);
    expect(reduce(AT[view], { type: "open_legal" })).toBe(AT[view]);
  });
});

describe("打开启动器", () => {
  it("完成页和已安装页转加载态", () => {
    expect(reduce(AT.done, { type: "opening_launcher" }).opening).toBe(true);
    expect(reduce(AT.installed, { type: "opening_launcher" }).opening).toBe(true);
  });

  it("别的视图不接受", () => {
    expect(reduce(AT.welcome, { type: "opening_launcher" })).toBe(AT.welcome);
  });

  it("首装打开计划里的目录，覆盖安装打开探测到的目录", () => {
    expect(installedDir(AT.done)).toBe(CHOSEN_DIR);
    expect(installedDir(AT.installed)).toBe(String.raw`E:\app`);
    expect(installedDir(replay([probed(existingOf("upgrade")), upgrade(), { type: "install_succeeded" }]))).toBe(String.raw`E:\app`);
  });

  it("不知道目录时抛错而不是打开空路径", () => {
    expect(() => installedDir(AT.welcome)).toThrow("不知道程序装在哪里");
  });
});

describe("关窗", () => {
  it("只有安装中不能关", () => {
    expect(ALL_VIEWS.filter((view) => !canCloseWindow(view))).toEqual(["installing"]);
  });
});

describe("换步", () => {
  it("准备页和安装中是同一页，换过去不算换步", () => {
    expect(stepKey("preparing")).toBe(stepKey("installing"));
    expect(stepDirection("preparing", "installing")).toBe(0);
    expect(ALL_VIEWS.filter((view) => view !== "preparing" && stepKey(view) !== view)).toEqual([]);
  });

  it("欢迎页与选目录页之间原地换，路径行不横移", () => {
    expect(stepDirection("welcome", "location")).toBe(0);
    expect(stepDirection("location", "welcome")).toBe(0);
  });

  it.each([
    ["welcome", "installing"],
    ["location", "installing"],
    ["installed", "installing"],
    ["welcome", "blocked"],
    ["preparing", "blocked"],
    ["blocked", "installing"],
    ["installing", "done"],
    ["installing", "failed"],
    ["failed", "installing"],
    ["failed", "blocked"],
    ["done", "legal"],
    ["welcome", "legal"],
  ] as const)("%s 到 %s 往前走", (from, to) => {
    expect(stepDirection(from, to)).toBe(1);
  });

  it.each([
    ["blocked", "welcome"],
    ["blocked", "installed"],
    ["failed", "welcome"],
    ["failed", "location"],
    ["failed", "installed"],
    ["legal", "welcome"],
    ["legal", "done"],
  ] as const)("%s 退回 %s", (from, to) => {
    expect(stepDirection(from, to)).toBe(-1);
  });

  it.each(ALL_VIEWS.filter((view) => view !== "fatal"))("%s 崩进致命错误页时原地换", (view) => {
    expect(stepDirection(view, "fatal")).toBe(0);
  });

  it("探测完的第一页不算换步", () => {
    expect(stepDirection("boot", "welcome")).toBe(0);
    expect(stepDirection("boot", "preparing")).toBe(0);
  });
});

describe("崩溃", () => {
  it.each(ALL_VIEWS)("%s 下都能进致命错误视图并带上原文", (view) => {
    const state = reduce(AT[view], { type: "crashed", detail: "IPC 断了" });
    expect(state.view).toBe("fatal");
    expect(state.fatal).toBe("IPC 断了");
  });
});

describe("dirNotice", () => {
  it("按优先级只给一条", () => {
    expect(dirNotice(checkOf({ issue: "no_space", hasConfig: true, notEmpty: true, appended: true }))).toEqual({ kind: "issue", issue: "no_space" });
    expect(dirNotice(checkOf({ hasConfig: true, notEmpty: true, appended: true }))).toEqual({ kind: "resume" });
    expect(dirNotice(checkOf({ notEmpty: true, appended: true }))).toEqual({ kind: "nested" });
    expect(dirNotice(checkOf({ notEmpty: true }))).toEqual({ kind: "not_empty" });
    expect(dirNotice(checkOf())).toEqual({ kind: "ok" });
  });
});

describe("withAppFolder", () => {
  const app = APP_NAME_EN;
  it.each([
    ["D:\\Games", `D:\\Games\\${app}`],
    ["D:\\Games\\", `D:\\Games\\${app}`],
    ["D:/Games/", `D:/Games\\${app}`],
    ["D:\\游戏 目录", `D:\\游戏 目录\\${app}`],
    ["D:\\", `D:\\${app}`],
    [`D:\\Games\\${app}`, `D:\\Games\\${app}`],
    [`D:\\Games\\${app.toUpperCase()}\\`, `D:\\Games\\${app.toUpperCase()}`],
    [`D:\\${app}-old`, `D:\\${app}-old\\${app}`],
  ])("%s 补成 %s", (picked, expected) => {
    expect(withAppFolder(picked)).toBe(expected);
  });
});
