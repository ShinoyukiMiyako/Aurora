import { describe, expect, it } from "vitest";
import { APP_NAME_EN } from "../lib/app-info";
import type { DirCheck, Existing, ExistingKind, Failure, FailureCode, InstallMode, InstallPlan, Probe, Progress } from "./contract";
import { allowedModes, canCloseWindow, canOpenLegal, dirNotice, failureRecovery, initialState, installedDir, offersStandardInstaller, reduce, replay, withAppFolder, type SetupEvent, type SetupState, type View } from "./model";

const ALL_VIEWS: readonly View[] = ["boot", "welcome", "location", "installed", "blocked", "installing", "done", "failed", "legal", "fatal"];

const DEFAULT_DIR = String.raw`C:\Users\a\AppData\Local\app`;
const CHOSEN_DIR = String.raw`D:\游戏 目录\app`;

const probeOf = (existing: Existing | null, extra: Partial<Probe> = {}): Probe => ({ payloadVersion: "0.2.0", defaultDir: DEFAULT_DIR, requiredBytes: 41_943_040, existing, interrupted: false, elevated: false, ...extra });
const existingOf = (kind: ExistingKind): Existing => ({ kind, version: "0.1.0", dir: String.raw`E:\app` });
const checkOf = (extra: Partial<DirCheck> = {}): DirCheck => ({ normalized: CHOSEN_DIR, issue: null, hasConfig: false, notEmpty: false, freeBytes: 1 << 30, ...extra });
const FAILURE: Failure = { code: "payload_exit", detail: "2" };
const PROGRESS: Progress = { phase: "write", percent: 40, slow: false };

const probed = (existing: Existing | null = null, extra: Partial<Probe> = {}): SetupEvent => ({ type: "probed", probe: probeOf(existing, extra) });
const fresh = (running = false, check = checkOf()): SetupEvent => ({ type: "install_requested", mode: "fresh", running, check });
const upgrade = (running = false): SetupEvent => ({ type: "install_requested", mode: "upgrade", running });
const repair = (running = false): SetupEvent => ({ type: "install_requested", mode: "repair", running });

/** 每个视图各摆一份走到那里的状态。 */
const AT: Readonly<Record<View, SetupState>> = {
  boot: initialState,
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

  it.each<ExistingKind>(["upgrade", "same", "newer", "broken"])("现有安装 %s 进已安装页，目录锁定在原位置", (kind) => {
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

describe("发起安装", () => {
  it("首装计划带校验后规整过的目录和快捷方式选择", () => {
    const state = reduce(AT.location, { type: "shortcut_changed", value: false });
    const started = reduce(state, fresh(false, checkOf({ normalized: String.raw`D:\Long Name\app` })));
    expect(started.view).toBe("installing");
    expect(started.plan).toEqual<InstallPlan>({ mode: "fresh", dir: String.raw`D:\Long Name\app`, desktopShortcut: false });
    expect(started.origin).toBe("location");
    expect(started.run).toBe(1);
  });

  it("升级和修复都不带目录", () => {
    expect(replay([probed(existingOf("upgrade")), upgrade()]).plan).toEqual<InstallPlan>({ mode: "upgrade", dir: null, desktopShortcut: true });
    expect(replay([probed(existingOf("same")), repair()]).plan).toEqual<InstallPlan>({ mode: "repair", dir: null, desktopShortcut: true });
    expect(replay([probed(existingOf("broken")), repair()]).plan).toEqual<InstallPlan>({ mode: "repair", dir: null, desktopShortcut: true });
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

  it("目录问题优先于进程检查：两个都有时先解决目录", () => {
    expect(reduce(AT.welcome, fresh(true, checkOf({ issue: "bang" }))).view).toBe("location");
  });

  it("改目录后旧的校验结果作废", () => {
    const state = reduce(AT.welcome, fresh(false, checkOf({ issue: "unwritable" })));
    expect(reduce(state, { type: "dir_changed", dir: CHOSEN_DIR }).dirCheck).toBeNull();
    expect(reduce(state, { type: "use_default_dir" }).dirCheck).toBeNull();
  });

  it.each<[string, Existing | null, InstallMode[]]>([
    ["没有现有安装", null, ["fresh"]],
    ["upgrade", existingOf("upgrade"), ["upgrade"]],
    ["same", existingOf("same"), ["repair"]],
    ["broken", existingOf("broken"), ["repair"]],
    ["newer", existingOf("newer"), []],
  ])("%s 能走的安装种类", (_, existing, modes) => {
    expect(allowedModes(existing)).toEqual(modes);
  });

  it("已安装更新版本时任何安装请求都不生效", () => {
    const state = reduce(initialState, probed(existingOf("newer")));
    expect(reduce(state, upgrade())).toBe(state);
    expect(reduce(state, repair())).toBe(state);
    expect(reduce(state, fresh())).toBe(state);
  });

  it("有现有安装时不接受首装：那会把目录改走，旧目录成孤儿", () => {
    expect(reduce(AT.installed, fresh())).toBe(AT.installed);
  });

  it.each<View>(["boot", "blocked", "installing", "done", "legal", "fatal"])("在 %s 发起安装不生效", (view) => {
    expect(reduce(AT[view], fresh())).toBe(AT[view]);
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
  ])("%s 在 %s 下的主动作是 %s", (code, mode, recovery) => {
    expect(failureRecovery(code, { mode, dir: null, desktopShortcut: true })).toBe(recovery);
  });

  it.each<[FailureCode, boolean]>([
    ["dir_unwritable", false],
    ["disk_full", false],
    ["extract_failed", false],
    ["payload_exit", true],
    ["verify_failed", true],
  ])("%s 提供标准安装程序：%s", (code, offered) => {
    expect(offersStandardInstaller(code)).toBe(offered);
  });
});

describe("完成页的说明", () => {
  it("首装到空目录不提数据", () => {
    expect(replay([probed(), fresh()]).keptData).toBe(false);
  });

  it("首装到已有 config.json 的目录说数据还在", () => {
    expect(replay([probed(), fresh(false, checkOf({ hasConfig: true }))]).keptData).toBe(true);
  });

  it("升级和修复说数据还在", () => {
    expect(replay([probed(existingOf("upgrade")), upgrade()]).keptData).toBe(true);
    expect(replay([probed(existingOf("same")), repair()]).keptData).toBe(true);
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

describe("崩溃", () => {
  it.each(ALL_VIEWS)("%s 下都能进致命错误视图并带上原文", (view) => {
    const state = reduce(AT[view], { type: "crashed", detail: "IPC 断了" });
    expect(state.view).toBe("fatal");
    expect(state.fatal).toBe("IPC 断了");
  });
});

describe("dirNotice", () => {
  it("按优先级只给一条", () => {
    expect(dirNotice(checkOf({ issue: "no_space", hasConfig: true, notEmpty: true }))).toEqual({ kind: "issue", issue: "no_space" });
    expect(dirNotice(checkOf({ hasConfig: true, notEmpty: true }))).toEqual({ kind: "resume" });
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
