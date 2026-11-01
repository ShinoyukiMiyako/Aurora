import { describe, expect, it } from "vitest";
import { bestLocalRuntime, runtimeComplete } from "../../domain/rules";
import type { Task } from "../../domain/types";
import type { LaunchView } from "../../launch/launchView";
import type { JavaInstallationDto } from "../../state/queries/catalog";
import type { CrashClueDto, CrashReportDto, HistoryEvent, InstalledMod, UpdateCandidate, UpdateHold, WorldDto } from "../../state/queries/instance";
import { applyPhase, sessionLaunched, startSession } from "../../state/session";
import { newTask } from "../../state/tasks";
import { LOGS_COPY, MODS_COPY, OVERVIEW_COPY } from "./copy";
import {
  adjustModSort,
  autoJavaPick,
  batchAvailability,
  batchRemovalRelations,
  crashFixes,
  crashFixKey,
  creationRef,
  creationRefEqual,
  deletableWorldCount,
  enterWorldBlock,
  disabledFileName,
  effectiveJavaMajor,
  effectiveMemoryMb,
  enabledFileName,
  filterMods,
  hasFlags,
  historyItems,
  installStage,
  instanceFolderPath,
  isNewMod,
  isCrashActive,
  isPendingModUpdate,
  javaChoice,
  javaFit,
  matchSuspect,
  modCounts,
  modRows,
  modTotals,
  overridesHeap,
  overviewBanner,
  pageViewEqual,
  parseDimension,
  peekLayout,
  peekPerRow,
  presetFlags,
  RESOLUTION_LIMITS,
  removalRelations,
  sortRows,
  sortWorlds,
  playtimeNote,
  toggleFlags,
  weeklyHours,
  workLock,
  type CrashFixContext,
} from "./model";
import { isolationByPolicy } from "../../domain/rules";

function java(path: string, major: number, minor: number, is64 = true, vendor = "Microsoft"): JavaInstallationDto {
  return { path, version: { major, minor, security: 0, build: 0, raw: `${major}.${minor}` }, is_64bit: is64, vendor, source: "registry", missing_files: [] };
}

function mod(fileName: string, over: Partial<InstalledMod> = {}, meta: Partial<NonNullable<InstalledMod["metadata"]>> | null = {}): InstalledMod {
  return {
    path: `D:/mc/mods/${fileName}`,
    file_name: fileName,
    enabled: !fileName.endsWith(".disabled"),
    size: 1024,
    modified_ms: 1,
    metadata:
      meta === null
        ? null
        : {
            mod_id: fileName.split("-")[0],
            name: null,
            version: null,
            description: null,
            authors: [],
            depends: [],
            minecraft_version: null,
            icon: null,
            loader: "fabric",
            format: "fabric",
            ...meta,
          },
    icon_url: null,
    source: null,
    ...over,
  };
}

function candidate(fileName: string, version: string): UpdateCandidate {
  return {
    file_name: fileName,
    title: null,
    current_version_id: "old",
    current_version_number: null,
    latest: {
      version_id: `v-${version}`,
      project_id: "p",
      platform: "modrinth",
      name: version,
      version_number: version,
      release_channel: "release",
      game_versions: [],
      loaders: [],
      file_name: fileName,
      file_size: null,
      sha1: null,
      download_url: null,
      date_published: "",
      dependencies: [],
    },
  };
}

function clue(category: CrashClueDto["category"], over: Partial<CrashClueDto> = {}): CrashClueDto {
  return { category, summary: "", advice: "", detail: null, matched: "boom", line: 10, context: [], source: "session_log", ...over };
}

function report(diagnoses: CrashClueDto[], over: Partial<CrashReportDto> = {}): CrashReportDto {
  return {
    at: 1000,
    exit_code: -1,
    session_started_at: 0,
    log_path: "D:/mc/logs/latest.log",
    diagnoses,
    suspects: [],
    java: { major: 17, path: "C:/jdk/bin/java.exe", is_64bit: true },
    max_memory_mb: 4096,
    warnings: [],
    exit_code_note: null,
    scanned_files: [],
    ...over,
  };
}

const ctx = (over: Partial<CrashFixContext> = {}): CrashFixContext => ({
  memoryMb: 4096,
  followsGlobal: true,
  physicalMb: 32768,
  mods: [],
  jvmArgs: "",
  runtimes: [],
  requiredJava: 21,
  ...over,
});

describe("上次崩溃判定", () => {
  it("崩溃之后没有再玩过才提示，崩溃那一局与上次游玩同一时刻也算", () => {
    expect(isCrashActive(5000, 5000, "ready")).toBe(true);
    expect(isCrashActive(5000, null, "ready")).toBe(true);
    expect(isCrashActive(5000, 5001, "ready")).toBe(false);
    expect(isCrashActive(null, null, "ready")).toBe(false);
  });

  it("启动中与运行中一律不提示", () => {
    expect(isCrashActive(5000, 4000, "loading")).toBe(false);
    expect(isCrashActive(5000, 4000, "running")).toBe(false);
    expect(isCrashActive(5000, 4000, "crashed")).toBe(true);
  });
});

describe("工作目录与实例设置的锁", () => {
  it("安装中（含补全）锁住；后端在改名或删除时按活动锁住", () => {
    expect(workLock(true, null)).toBe("installing");
    expect(workLock(true, "repairing")).toBe("installing");
    expect(workLock(false, "renaming")).toBe("renaming");
    expect(workLock(false, "deleting")).toBe("deleting");
  });
  it("与启动、运行和改动中兼容：这些活动下照常可用", () => {
    for (const activity of [null, "launching", "running", "modifying"] as const) expect(workLock(false, activity)).toBeNull();
  });
});

describe("整页订阅的启动视图", () => {
  const T0 = 1_700_000_000_000;
  const account = { uuid: "u", name: "Steve", kind: "microsoft" as const };
  const repair = (status: Task["status"], progress: number, speedBps: number, id = "repair-1"): Task => ({
    ...newTask({ id, kind: "game", title: "补全 生存", detail: "", instanceId: "生存", spec: { command: "repair", args: { versionId: "生存" } } }, T0),
    status,
    progress,
    speedBps,
  });
  const installing = (task: Task | null, queuePosition: number | null): LaunchView => ({ kind: "installing", task, queuePosition });
  const downloading = (done: number) => {
    const session = applyPhase(startSession("生存", "launch-1", account, T0, null), { taskId: "launch-1", phase: "downloading", stageIndex: 3, download: { done, total: 100, bytes: 0, totalBytes: null, speedBps: 2048 } }, T0 + done);
    if (session.phase !== "downloading") throw new Error("应在下载阶段");
    return { kind: "loading", session, phase: session.phase } as const satisfies LaunchView;
  };

  it("只有进度、速度变了算相等：0% 到 100%、下载 0 到 100 个文件都不让页面重渲染", () => {
    expect(pageViewEqual(installing(repair("running", 0, 0), null), installing(repair("running", 1, 5_000_000), null))).toBe(true);
    expect(pageViewEqual(downloading(0), downloading(100))).toBe(true);
    const run = sessionLaunched(downloading(100).session, "launch-1", T0 + 1000);
    expect(pageViewEqual({ kind: "running", session: run }, { kind: "running", session: { ...run, progress: 1 } })).toBe(true);
  });

  it("任务换了一个、从排队转进行、名次变了，或有没有任务变了，都算不同", () => {
    expect(pageViewEqual(installing(repair("queued", 0, 0), 2), installing(repair("running", 0, 0), null))).toBe(false);
    expect(pageViewEqual(installing(repair("queued", 0, 0), 2), installing(repair("queued", 0, 0), 1))).toBe(false);
    expect(pageViewEqual(installing(repair("running", 0.5, 0), null), installing(repair("running", 0.5, 0, "repair-2"), null))).toBe(false);
    expect(pageViewEqual(installing(null, null), installing(repair("running", 0, 0), null))).toBe(false);
    expect(pageViewEqual(installing(repair("running", 0, 0), null), installing(null, null))).toBe(false);
    expect(pageViewEqual(installing(null, null), installing(null, null))).toBe(true);
  });

  it("种类、加载阶段、结束原因与损坏原因变了算不同", () => {
    const preparing = { ...downloading(0), phase: "preparing" } as const;
    expect(pageViewEqual(preparing, downloading(0))).toBe(false);
    expect(pageViewEqual(downloading(0), { kind: "ready", busyElsewhere: false })).toBe(false);
    expect(pageViewEqual({ kind: "ready", busyElsewhere: false }, { kind: "ready", busyElsewhere: true })).toBe(false);
    const ended = downloading(0).session;
    expect(pageViewEqual({ kind: "stopped", session: ended, reason: "exited" }, { kind: "stopped", session: ended, reason: "cancelled" })).toBe(false);
    expect(pageViewEqual({ kind: "broken", reason: "缺少版本文件", reimport: false }, { kind: "broken", reason: "缺少库文件", reimport: false })).toBe(false);
    expect(pageViewEqual({ kind: "broken", reason: "缺少版本文件", reimport: false }, { kind: "broken", reason: "缺少版本文件", reimport: true })).toBe(false);
  });
});

describe("存档行「进入」的禁用原因", () => {
  const both = { singleplayer: true, multiplayer: true };
  const legacy = { singleplayer: false, multiplayer: true };

  it("可用：就绪、版本支持、这一局没在跑；别的实例占着游戏进程不算", () => {
    expect(enterWorldBlock({ status: "ready", quickPlay: both, activity: null, usedBy: null }, "ready", false)).toBeNull();
    // 已结束、失败、崩溃的会话不挡再次进入
    for (const view of ["stopped", "failed", "crashed"] as const) expect(enterWorldBlock({ status: "ready", quickPlay: both, activity: null, usedBy: null }, view, false)).toBeNull();
  });

  it("自上而下取第一条：安装中 > 损坏 > 版本信息不完整 > 版本不支持 > 备份中 > 被当作基底 > 正在启动 > 正在运行", () => {
    expect(enterWorldBlock({ status: "installing", quickPlay: null, activity: null, usedBy: null }, "loading", false)).toBe("installing");
    expect(enterWorldBlock({ status: "broken", quickPlay: null, activity: null, usedBy: null }, "running", false)).toBe("broken");
    expect(enterWorldBlock({ status: "ready", quickPlay: null, activity: null, usedBy: null }, "running", false)).toBe("unknownVersion");
    expect(enterWorldBlock({ status: "ready", quickPlay: legacy, activity: "backing_up", usedBy: null }, "ready", true)).toBe("legacy");
    expect(enterWorldBlock({ status: "ready", quickPlay: both, activity: "backing_up", usedBy: "FAB" }, "running", false)).toBe("backingUp");
    expect(enterWorldBlock({ status: "ready", quickPlay: both, activity: null, usedBy: null }, "loading", true)).toBe("backingUp");
    expect(enterWorldBlock({ status: "ready", quickPlay: both, activity: "inherited", usedBy: "FAB" }, "ready", false)).toBe("inherited");
    expect(enterWorldBlock({ status: "ready", quickPlay: both, activity: null, usedBy: null }, "loading", false)).toBe("launching");
    expect(enterWorldBlock({ status: "ready", quickPlay: both, activity: null, usedBy: null }, "running", false)).toBe("running");
  });

  it("只看单人位：能加入服务器、不能进存档的版本照样禁用", () => {
    expect(enterWorldBlock({ status: "ready", quickPlay: { singleplayer: false, multiplayer: false }, activity: null, usedBy: null }, "ready", false)).toBe("legacy");
    expect(enterWorldBlock({ status: "ready", quickPlay: { singleplayer: true, multiplayer: false }, activity: null, usedBy: null }, "ready", false)).toBeNull();
  });

  it("备份中：后端报 backing_up，或前端已有排着、进行中的存档任务；改 Mod 不挡", () => {
    expect(enterWorldBlock({ status: "ready", quickPlay: both, activity: "backing_up", usedBy: null }, "ready", false)).toBe("backingUp");
    expect(enterWorldBlock({ status: "ready", quickPlay: both, activity: null, usedBy: null }, "ready", true)).toBe("backingUp");
    expect(enterWorldBlock({ status: "ready", quickPlay: both, activity: "modifying", usedBy: null }, "ready", false)).toBeNull();
  });
});

describe("删除时一起走的存档", () => {
  it("隔离的实例按存档数，不隔离的共用目录不算，读不出为 null", () => {
    expect(deletableWorldCount({ isolated: true, worldCount: 3 })).toBe(3);
    expect(deletableWorldCount({ isolated: true, worldCount: 0 })).toBe(0);
    expect(deletableWorldCount({ isolated: false, worldCount: 7 })).toBe(0);
    expect(deletableWorldCount({ isolated: null, worldCount: 7 })).toBeNull();
    expect(deletableWorldCount({ isolated: true, worldCount: null })).toBeNull();
  });
});

describe("Mod 总数", () => {
  const pack = { platform: "modrinth" as const, projectId: "rlc", versionId: "v1", name: "RLCraft", version: "2.9.3" };
  it("自建实例以列表为准，摘要数对不上也不算列表不全", () => {
    expect(modTotals({ modCount: 12, modpack: null }, 2)).toEqual({ total: 2, partial: false });
    expect(modTotals({ modCount: 0, modpack: null }, 3)).toEqual({ total: 3, partial: false });
    expect(modTotals({ modCount: null, modpack: null }, 0)).toEqual({ total: 0, partial: false });
  });
  it("整合包实例的列表比摘要少时才算只列出代表，总数取较大者", () => {
    expect(modTotals({ modCount: 168, modpack: pack }, 24)).toEqual({ total: 168, partial: true });
    expect(modTotals({ modCount: 24, modpack: pack }, 24)).toEqual({ total: 24, partial: false });
    expect(modTotals({ modCount: 20, modpack: pack }, 24)).toEqual({ total: 24, partial: false });
    expect(modTotals({ modCount: null, modpack: pack }, 5)).toEqual({ total: 5, partial: false });
  });
});


describe("概览横幅取最高严重度", () => {
  it("失败与崩溃（danger）压过损坏（warn）压过安装中（info）", () => {
    expect(overviewBanner("failed", true)).toBe("failed");
    expect(overviewBanner("broken", true)).toBe("crashed");
    expect(overviewBanner("broken", false)).toBe("broken");
    expect(overviewBanner("installing", false)).toBe("installing");
    expect(overviewBanner("ready", false)).toBeNull();
  });
});

describe("新建与导入还没装好", () => {
  const T0 = 1_700_000_000_000;
  const NAME = "周末生存";
  const task = (id: string, command: string, status: Task["status"], over: Partial<Task> = {}): Task => ({
    ...newTask({ id, kind: "game", title: `任务 ${id}`, detail: "", instanceId: NAME, spec: { command, args: {} } }, T0),
    status,
    ...over,
  });
  const failure = { code: "network_failed", message: "连接超时" };
  const placeholder = { id: NAME, placeholder: true, activity: "installing" as const };
  const scanned = (activity: "installing" | "repairing" | null) => ({ id: NAME, placeholder: false, activity });

  it("只认挂在这个实例名下的新建与导入：补全、装 Mod 与别的实例的任务都不算", () => {
    expect(creationRef([], NAME)).toBeNull();
    const others = [
      task("repair", "repair_instance", "running"),
      task("mod", "install_mod", "running"),
      task("other", "install_version", "running", { instanceId: "创造" }),
      task("java", "install_java", "running", { instanceId: null }),
    ];
    expect(creationRef(others, NAME)).toBeNull();
    expect(creationRef([...others, task("pack", "install_modpack", "queued")], NAME)).toEqual({ id: "pack", status: "queued", title: "任务 pack", modpack: true, error: null });
  });

  it("进行中的优先于更晚建的已结束任务；都结束时取最近建的，建的时刻相同取排在后面的", () => {
    const failed = task("old", "install_version", "failed", { createdAt: T0 + 5, error: failure });
    const running = task("now", "install_version", "running", { createdAt: T0 });
    expect(creationRef([failed, running], NAME)?.id).toBe("now");
    const done = task("done", "install_version", "done", { createdAt: T0 + 1 });
    expect(creationRef([failed, done], NAME)?.id).toBe("old");
    expect(creationRef([done, task("same", "install_version", "cancelled", { createdAt: T0 + 1 })], NAME)?.id).toBe("same");
  });

  it("页面订阅的那几项不变就算相等：进度、速度、字节数变了不让页面重渲染", () => {
    const before = creationRef([task("t", "install_version", "running", { progress: 0, speedBps: 0 })], NAME);
    const after = creationRef([task("t", "install_version", "running", { progress: 0.5, speedBps: 9_000_000, bytes: 4096 })], NAME);
    expect(creationRefEqual(before, after)).toBe(true);
    expect(creationRefEqual(before, creationRef([task("t", "install_version", "failed", { error: failure })], NAME))).toBe(false);
    const failedA = creationRef([task("t", "install_version", "failed", { error: failure })], NAME);
    const failedB = creationRef([task("t", "install_version", "failed", { error: { ...failure, message: "磁盘已满" } })], NAME);
    expect(creationRefEqual(failedA, failedB)).toBe(false);
    expect(creationRefEqual(null, null)).toBe(true);
    expect(creationRefEqual(before, null)).toBe(false);
  });

  it("任务在排队或在跑：占位项与扫到了半成品目录的实例一样只给说明", () => {
    const queued = creationRef([task("q", "install_version", "queued")], NAME);
    const running = creationRef([task("r", "install_modpack", "running")], NAME);
    expect(installStage(placeholder, queued)).toEqual({ kind: "queued", title: "任务 q" });
    expect(installStage(placeholder, running)).toEqual({ kind: "running", title: "任务 r" });
    expect(installStage(scanned("installing"), running)).toEqual({ kind: "running", title: "任务 r" });
  });

  it("占位项的任务结束、重扫还没回来：完成与取消都等扫描结果；失败给原因与要重试的任务", () => {
    expect(installStage(placeholder, creationRef([task("t", "install_version", "done")], NAME))).toEqual({ kind: "landing" });
    expect(installStage(placeholder, creationRef([task("t", "install_version", "cancelled")], NAME))).toEqual({ kind: "landing" });
    expect(installStage(placeholder, creationRef([task("t", "install_modpack", "failed", { error: failure })], NAME))).toEqual({
      kind: "failed",
      taskId: "t",
      modpack: true,
      error: failure,
    });
  });

  it("扫描里还记着后端在新建、导入，前端任务已经结束：这份扫描是旧的，等重扫", () => {
    expect(installStage(scanned("installing"), creationRef([task("t", "install_version", "done")], NAME))).toEqual({ kind: "landing" });
    expect(installStage(scanned("installing"), null)).toEqual({ kind: "landing" });
  });

  it("扫到的实例没有进行中的新建：装好的、失败留下的目录、正在补全的都画正常内容", () => {
    const failed = creationRef([task("t", "install_version", "failed", { error: failure })], NAME);
    expect(installStage(scanned(null), failed)).toEqual({ kind: "none" });
    expect(installStage(scanned(null), null)).toEqual({ kind: "none" });
    expect(installStage(scanned("repairing"), creationRef([task("t", "install_version", "done"), task("fix", "repair_instance", "running")], NAME))).toEqual({ kind: "none" });
  });

  it("占位项找不到它的任务、失败的任务没记原因：状态层的约定坏了，直接抛错", () => {
    expect(() => installStage(placeholder, null)).toThrow("占位实例「周末生存」没有对应的新建或导入任务");
    expect(() => installStage(placeholder, creationRef([task("t", "install_version", "failed")], NAME))).toThrow("失败的任务 t 没有记下失败原因");
  });
});

describe("游玩与内存", () => {
  it("平均每周时长按创建至今的周数，不足一周按一周", () => {
    const week = 7 * 24 * 3600 * 1000;
    expect(weeklyHours(120, 0, week * 4)).toBe("0.5");
    expect(weeklyHours(90, 0, 1000)).toBe("1.5");
  });

  it("累计游玩格的说明：没玩过说没开始，玩过不足一分钟不说没开始，缺创建时间时不算周均", () => {
    const week = 7 * 24 * 3600 * 1000;
    expect(playtimeNote({ playtimeMin: 0, lastPlayedAt: null, createdAt: 0 }, week)).toBe(OVERVIEW_COPY.notStarted);
    expect(playtimeNote({ playtimeMin: 0, lastPlayedAt: week - 1000, createdAt: 0 }, week)).toBe(OVERVIEW_COPY.underAMinute);
    expect(playtimeNote({ playtimeMin: 120, lastPlayedAt: 1000, createdAt: 0 }, week * 4)).toBe(OVERVIEW_COPY.perWeek("0.5"));
    expect(playtimeNote({ playtimeMin: 120, lastPlayedAt: 1000, createdAt: null }, week)).toBeNull();
  });

  it("实例设置优先，否则自动分配取推荐值、固定取全局值", () => {
    expect(effectiveMemoryMb(6144, { maxMb: 4096, minMb: null, auto: true }, 8192)).toBe(6144);
    expect(effectiveMemoryMb(null, { maxMb: 4096, minMb: null, auto: true }, 8192)).toBe(8192);
    expect(effectiveMemoryMb(null, { maxMb: 4096, minMb: null, auto: false }, 8192)).toBe(4096);
  });
});

describe("Java 选择", () => {
  const runtimes = [java("C:/j17a", 17, 0, false), java("C:/j17b", 17, 0, true), java("C:/j17c", 17, 9, true), java("C:/j21", 21, 3)];

  it("自动：同主版本里 64 位优先、再挑版本最高的", () => {
    expect(autoJavaPick(runtimes, 17, "auto", "auto")).toEqual({ kind: "local", runtime: runtimes[2] });
    expect(autoJavaPick(runtimes, 8, "auto", "auto")).toEqual({ kind: "download" });
  });

  it("自动挑选跳过缺运行时文件的：同主版本另有完整的就选它，全不完整就算本机没有", () => {
    const broken = { ...java("C:/j17-new", 17, 12, true), missing_files: ["lib/modules"] };
    const complete = java("C:/j17-old", 17, 1, true);
    expect(bestLocalRuntime([broken, complete], 17)).toBe(complete);
    expect(autoJavaPick([broken, complete], 17, "auto", "auto")).toEqual({ kind: "local", runtime: complete });
    expect(bestLocalRuntime([broken], 17)).toBeNull();
    expect(autoJavaPick([broken, { ...java("C:/j8", 8, 0), missing_files: ["release", "lib/rt.jar"] }], 17, "auto", "auto")).toEqual({ kind: "download" });
    expect(runtimeComplete(broken)).toBe(false);
    expect(runtimeComplete(complete)).toBe(true);
  });

  it("全局指定了默认 Java 时一律用它，找不到也照实报告", () => {
    expect(autoJavaPick(runtimes, 17, "C:/j21", "auto")).toEqual({ kind: "global", path: "C:/j21", runtime: runtimes[3] });
    expect(autoJavaPick(runtimes, 17, "C:/gone", "auto")).toEqual({ kind: "global", path: "C:/gone", runtime: null });
  });

  it("路径按路径规则比较：只差大小写或分隔符的是同一个 Java，不当成缺失", () => {
    const list = [java("D:/Java/jdk-21/bin/java.exe", 21, 0)];
    expect(autoJavaPick(list, 17, "d:\\java\\JDK-21\\bin\\java.exe", "auto")).toEqual({ kind: "global", path: "d:\\java\\JDK-21\\bin\\java.exe", runtime: list[0] });
    expect(javaChoice("D:\\Java/jdk-21\\bin/java.exe", list, 17, "auto", "auto")).toEqual({ auto: false, path: "D:\\Java/jdk-21\\bin/java.exe", runtime: list[0] });
    expect(javaChoice("D:/Java/jdk-17/bin/java.exe", list, 17, "auto", "auto")).toEqual({ auto: false, path: "D:/Java/jdk-17/bin/java.exe", runtime: null });
  });

  it("固定路径对不上本机列表时 runtime 为 null；JVM 预设判断回落到要求版本", () => {
    const missing = javaChoice("C:/gone/java.exe", runtimes, 17, "auto", "auto");
    expect(missing).toEqual({ auto: false, path: "C:/gone/java.exe", runtime: null });
    expect(effectiveJavaMajor(missing, 17)).toBe(17);
    expect(effectiveJavaMajor(javaChoice("C:/j21", runtimes, 17, "auto", "auto"), 17)).toBe(21);
  });

  it("匹配程度", () => {
    expect([javaFit(17, 17), javaFit(21, 17), javaFit(8, 17)]).toEqual(["match", "higher", "lower"]);
  });
});

describe("JVM 预设", () => {
  it("分代 ZGC：21-22 带 ZGenerational，23 起只写 UseZGC，低于 21 不可用", () => {
    expect(presetFlags("zgc", 20)).toBeNull();
    expect(presetFlags("zgc", 21)).toEqual(["-XX:+UseZGC", "-XX:+ZGenerational"]);
    expect(presetFlags("zgc", 22)).toEqual(["-XX:+UseZGC", "-XX:+ZGenerational"]);
    expect(presetFlags("zgc", 23)).toEqual(["-XX:+UseZGC"]);
  });

  it("切换片加入与移除，不重复、不动其他参数", () => {
    const on = toggleFlags("-Xss2m", ["-XX:+UseG1GC"]);
    expect(on).toBe("-Xss2m -XX:+UseG1GC");
    expect(toggleFlags(on, ["-XX:+UseG1GC"])).toBe("-Xss2m");
    expect(toggleFlags("  -XX:+UseZGC   -XX:+ZGenerational -Dx=1 ", ["-XX:+UseZGC"])).toBe("-Dx=1");
    expect(hasFlags("-XX:+UseZGC", ["-XX:+UseZGC", "-XX:+ZGenerational"])).toBe(false);
  });

  it("自带 -Xmx / -Xms 时提示会覆盖内存设置", () => {
    expect(overridesHeap("-XX:+UseG1GC -Xmx8G")).toBe(true);
    expect(overridesHeap("-Xms2g")).toBe(true);
    expect(overridesHeap("-Xmso256k")).toBe(false);
    expect(overridesHeap("-XX:MaxGCPauseMillis=50")).toBe(false);
  });
});

describe("窗口分辨率", () => {
  it("边界值内的整数才有效", () => {
    expect(parseDimension("320", RESOLUTION_LIMITS.width)).toBe(320);
    expect(parseDimension("319", RESOLUTION_LIMITS.width)).toBeNull();
    expect(parseDimension("7680", RESOLUTION_LIMITS.width)).toBe(7680);
    expect(parseDimension("7681", RESOLUTION_LIMITS.width)).toBeNull();
    expect(parseDimension(" 1080 ", RESOLUTION_LIMITS.height)).toBe(1080);
    expect(parseDimension("10.5", RESOLUTION_LIMITS.height)).toBeNull();
    expect(parseDimension("", RESOLUTION_LIMITS.height)).toBeNull();
  });
});

describe("版本隔离推断", () => {
  const vanillaRelease = { loader: "vanilla" as const, extraLoaders: [], releaseType: "release" as const };
  const fabric = { ...vanillaRelease, loader: "fabric" as const };
  const snapshot = { ...vanillaRelease, releaseType: "snapshot" as const };
  const optifine = { ...vanillaRelease, extraLoaders: [{ kind: "optifine" as const, version: null }] };

  it("按全局策略与实例类型，与后端的判定表一致", () => {
    expect(isolationByPolicy("mod_loaders_and_non_release", vanillaRelease)).toBe(false);
    expect(isolationByPolicy("mod_loaders_and_non_release", fabric)).toBe(true);
    expect(isolationByPolicy("mod_loaders_and_non_release", snapshot)).toBe(true);
    expect(isolationByPolicy("mod_loaders_only", snapshot)).toBe(false);
    expect(isolationByPolicy("mod_loaders_only", optifine)).toBe(true);
    expect(isolationByPolicy("non_release_only", fabric)).toBe(false);
    expect(isolationByPolicy("all", vanillaRelease)).toBe(true);
    expect(isolationByPolicy("disabled", fabric)).toBe(false);
  });
});

describe("路径", () => {
  it("沿用游戏目录的分隔符", () => {
    expect(instanceFolderPath("C:\\Users\\a\\.minecraft", "生存")).toBe("C:\\Users\\a\\.minecraft\\versions\\生存");
    expect(instanceFolderPath("D:/Games/.minecraft/", "RLCraft")).toBe("D:/Games/.minecraft/versions/RLCraft");
  });
});

describe("更新任务换掉的 Mod", () => {
  it("挡住「全部更新」的只有本实例排队或进行中的更新任务", () => {
    const task = (command: string, instanceId: string, status: Task["status"]): Task => ({
      ...newTask({ id: `${command}-${status}`, kind: "mod", title: "", detail: "", instanceId, spec: { command, args: {} } }, 0),
      status,
    });
    expect(isPendingModUpdate(task("update_mod", "生存", "queued"), "生存")).toBe(true);
    expect(isPendingModUpdate(task("update_mods", "生存", "running"), "生存")).toBe(true);
    expect(isPendingModUpdate(task("update_mod", "生存", "done"), "生存")).toBe(false);
    expect(isPendingModUpdate(task("update_mod", "生存", "failed"), "生存")).toBe(false);
    expect(isPendingModUpdate(task("update_mod", "创造", "running"), "生存")).toBe(false);
    expect(isPendingModUpdate(task("install_mods", "生存", "running"), "生存")).toBe(false);
  });
});

describe("Mod 列表", () => {
  const sodium = mod("sodium-0.6.jar", { source: { platform: "modrinth", project_id: "AANobbMI", version_id: "v1", version_number: "0.6.0", title: "Sodium", dependency_of: null, installed_at: 1_780_000_000, update_hold: null } }, { name: "Sodium", authors: ["JellySquid", "IMS"], description: "渲染优化" });
  const api = mod("fabric-api-0.1.jar.disabled", { source: { platform: "modrinth", project_id: "P7dR8mSH", version_id: "v2", version_number: "0.1", title: "Fabric API", dependency_of: "AANobbMI", installed_at: 1_780_000_000, update_hold: null } }, { name: null });
  const local = mod("ZZZ-local.jar", {}, null);

  it("名称回落：元数据名、平台标题、文件名；按名称排序", () => {
    const rows = modRows([local, sodium, api], null);
    expect(rows.map((r) => r.name)).toEqual(["Fabric API", "Sodium", "ZZZ-local"]);
    expect(rows[1]).toMatchObject({ author: "JellySquid, IMS", summary: "渲染优化", platform: "modrinth", version: "0.6.0", update: null });
    expect(rows[2]).toMatchObject({ platform: null, author: null, version: null, seed: "ZZZ-local.jar" });
  });

  it("前置来源对到带它进来的 Mod 的显示名；更新候选按启用态文件名对齐", () => {
    const rows = modRows([sodium, api], [candidate("fabric-api-0.1.jar", "0.2")]);
    const apiRow = rows.find((r) => r.fileName === api.file_name);
    expect(apiRow?.dependencyOf).toBe("Sodium");
    expect(apiRow?.update?.latest.version_number).toBe("0.2");
    expect(modCounts(rows)).toEqual({ all: 2, enabled: 1, disabled: 1, outdated: 1, ignored: 0 });
  });

  it("搜索不分大小写，匹配作者与文件名，并叠加状态筛选", () => {
    const rows = modRows([sodium, api, local], [candidate("fabric-api-0.1.jar", "0.2")]);
    expect(filterMods(rows, "jelly", "all").map((r) => r.name)).toEqual(["Sodium"]);
    expect(filterMods(rows, "ZZZ-LOCAL.JAR", "all").map((r) => r.name)).toEqual(["ZZZ-local"]);
    expect(filterMods(rows, "", "disabled").map((r) => r.name)).toEqual(["Fabric API"]);
    expect(filterMods(rows, "", "outdated").map((r) => r.name)).toEqual(["Fabric API"]);
    expect(filterMods(rows, "sodium", "disabled")).toEqual([]);
  });

  it("移除确认的两层关系", () => {
    const rows = modRows([sodium, api], null);
    const sodiumRow = rows.find((r) => r.name === "Sodium");
    const apiRow = rows.find((r) => r.name === "Fabric API");
    if (sodiumRow === undefined || apiRow === undefined) throw new Error("样本缺行");
    expect(removalRelations(sodiumRow, rows)).toEqual({ broughtIn: ["Fabric API"], dependents: [] });
    expect(removalRelations(apiRow, rows)).toEqual({ broughtIn: [], dependents: ["Sodium"] });
  });

  it("启用态与停用态文件名", () => {
    expect(enabledFileName("a.jar.disabled")).toBe("a.jar");
    expect(disabledFileName("a.jar")).toBe("a.jar.disabled");
    expect(disabledFileName("a.jar.disabled")).toBe("a.jar.disabled");
  });
});

describe("Mod 安装时间、新增标注与更新检查设置", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = 1_790_000_000_000;
  const source = (projectId: string, installedAt: number, hold: UpdateHold | null = null, dependencyOf: string | null = null) => ({
    platform: "modrinth" as const,
    project_id: projectId,
    version_id: `${projectId}-v1`,
    version_number: "1.0",
    title: null,
    dependency_of: dependencyOf,
    installed_at: installedAt,
    update_hold: hold,
  });
  const named = (fileName: string, name: string, over: Partial<InstalledMod> = {}) => mod(fileName, over, { name });

  it("装进实例的时刻：有来源取卷宗里的秒数换成毫秒，本地文件取文件修改时刻", () => {
    const rows = modRows(
      [named("a.jar", "Alpha", { source: source("pa", 1_789_000_000), modified_ms: 5 }), named("b.jar", "Beta", { modified_ms: 1_789_500_000_123 })],
      null,
    );
    expect(rows.map((r) => [r.name, r.addedAt])).toEqual([
      ["Alpha", 1_789_000_000_000],
      ["Beta", 1_789_500_000_123],
    ]);
  });

  it("按安装时间排序：首次点按新到旧，同一时刻按名称，本地文件按修改时刻参与；再点翻转为旧到新", () => {
    const rows = modRows(
      [
        named("c.jar", "Charlie", { source: source("pc", 1_789_000_000) }),
        named("b.jar", "Bravo", { source: source("pb", 1_789_000_000) }),
        named("local.jar", "Local", { modified_ms: 1_789_000_000_500 }),
        named("old.jar", "Oldest", { source: source("po", 1_700_000_000) }),
        named("a.jar", "Alpha", { source: source("pa", 1_789_000_000) }),
      ],
      null,
    );
    const first = adjustModSort({ key: "mod", direction: "asc" }, { key: "installed", direction: "asc" });
    expect(first).toEqual({ key: "installed", direction: "desc" });
    expect(sortRows(rows, first).map((r) => r.name)).toEqual(["Local", "Alpha", "Bravo", "Charlie", "Oldest"]);
    // 再点同一列由表格翻转方向，adjustModSort 不再干预；同一时刻仍按名称升序
    const flipped = adjustModSort(first, { key: "installed", direction: "asc" });
    expect(flipped).toEqual({ key: "installed", direction: "asc" });
    expect(sortRows(rows, flipped).map((r) => r.name)).toEqual(["Oldest", "Alpha", "Bravo", "Charlie", "Local"]);
    // 别的列照表格给的方向
    expect(adjustModSort(first, { key: "mod", direction: "asc" })).toEqual({ key: "mod", direction: "asc" });
    expect(sortRows(rows, { key: "mod", direction: "desc" }).map((r) => r.name)).toEqual(["Oldest", "Local", "Charlie", "Bravo", "Alpha"]);
  });

  it("新增：不满 7 天为真，恰好 7 天为假，时刻在将来按刚装上算", () => {
    expect(isNewMod({ addedAt: NOW - 7 * DAY + 1 }, NOW)).toBe(true);
    expect(isNewMod({ addedAt: NOW - 7 * DAY }, NOW)).toBe(false);
    expect(isNewMod({ addedAt: NOW - 30 * DAY }, NOW)).toBe(false);
    expect(isNewMod({ addedAt: NOW }, NOW)).toBe(true);
    expect(isNewMod({ addedAt: NOW + DAY }, NOW)).toBe(true);
  });

  it("忽略更新：筛选与计数只算 ignored，锁定的不算；被忽略的行即使还拿着旧的可更新项也不给更新", () => {
    const rows = modRows(
      [
        named("a.jar", "Alpha", { source: source("pa", 1, { kind: "ignored" }) }),
        named("b.jar", "Bravo", { source: source("pb", 1, { kind: "pinned", version_id: "pb-v1" }) }),
        named("c.jar.disabled", "Charlie", { source: source("pc", 1, { kind: "ignored" }) }),
        named("d.jar", "Delta"),
      ],
      [candidate("a.jar", "2.0"), candidate("b.jar", "1.1")],
    );
    expect(modCounts(rows)).toEqual({ all: 4, enabled: 3, disabled: 1, outdated: 1, ignored: 2 });
    expect(filterMods(rows, "", "ignored").map((r) => r.name)).toEqual(["Alpha", "Charlie"]);
    expect(filterMods(rows, "char", "ignored").map((r) => r.name)).toEqual(["Charlie"]);
    expect(rows.map((r) => [r.name, r.hold === null ? null : r.hold.kind, r.update === null ? null : r.update.latest.version_number])).toEqual([
      ["Alpha", "ignored", null],
      ["Bravo", "pinned", "1.1"],
      ["Charlie", "ignored", null],
      ["Delta", null, null],
    ]);
  });

  it("批量操作条的禁用原因：全启用、全停用、都没有更新、上锁", () => {
    const rows = modRows(
      [named("on1.jar", "On1"), named("on2.jar", "On2"), named("off1.jar.disabled", "Off1"), named("off2.jar.disabled", "Off2")],
      [candidate("on1.jar", "2.0")],
    );
    const pick = (...names: string[]) => rows.filter((r) => names.includes(r.name));
    const nothingUpdating = () => false;
    expect(batchAvailability(pick("On1", "On2"), undefined, nothingUpdating)).toEqual({ enable: MODS_COPY.batchAllEnabled, disable: undefined, update: undefined, remove: undefined });
    expect(batchAvailability(pick("Off1", "Off2"), undefined, nothingUpdating)).toEqual({
      enable: undefined,
      disable: MODS_COPY.batchAllDisabled,
      update: MODS_COPY.batchNoUpdates,
      remove: undefined,
    });
    expect(batchAvailability(pick("On2", "Off1"), undefined, nothingUpdating)).toEqual({ enable: undefined, disable: undefined, update: MODS_COPY.batchNoUpdates, remove: undefined });
    const lock = "游戏正在运行";
    expect(batchAvailability(pick("On1", "Off1"), lock, nothingUpdating)).toEqual({ enable: lock, disable: lock, update: lock, remove: lock });
    expect(() => batchAvailability([], undefined, nothingUpdating)).toThrow("没有选中的 Mod");
  });

  it("批量更新只看选中项里可更新的那些：它们都已在更新时带原因禁用，没有可更新的仍说没有可用的更新，还有一个没在更新就可用", () => {
    const rows = modRows([named("a.jar", "A"), named("b.jar", "B"), named("c.jar", "C")], [candidate("a.jar", "2.0"), candidate("b.jar", "2.0")]);
    const pick = (...names: string[]) => rows.filter((r) => names.includes(r.name));
    const updating = (r: { name: string }) => r.name === "A";
    expect(batchAvailability(pick("A"), undefined, updating).update).toBe(MODS_COPY.batchAllUpdating);
    expect(batchAvailability(pick("A", "C"), undefined, updating).update).toBe(MODS_COPY.batchAllUpdating);
    expect(batchAvailability(pick("A", "B"), undefined, updating).update).toBeUndefined();
    expect(batchAvailability(pick("C"), undefined, updating).update).toBe(MODS_COPY.batchNoUpdates);
    // 锁住时沿用锁定原因：结束游戏之前说不上「在更新」
    expect(batchAvailability(pick("A"), "游戏正在运行", updating).update).toBe("游戏正在运行");
  });

  it("批量移除的两层关系只说没被一起选中的", () => {
    const rows = modRows(
      [
        named("create.jar", "Create", { source: source("create", 1) }),
        named("flywheel.jar", "Flywheel", { source: source("flywheel", 1, null, "create") }),
        named("sodium.jar", "Sodium", { source: source("sodium", 1) }),
        named("api.jar", "Fabric API", { source: source("api", 1, null, "sodium") }),
        named("iris.jar", "Iris", { source: source("iris", 1, null, "sodium") }),
      ],
      null,
    );
    const pick = (...names: string[]) => rows.filter((r) => names.includes(r.name));
    // 选了 Sodium 与它带来的 Iris：只剩 Fabric API 会保留；Flywheel 是 Create 的前置，Create 没被选中
    expect(batchRemovalRelations(pick("Sodium", "Iris", "Flywheel"), rows)).toEqual({ broughtIn: ["Fabric API"], dependents: ["Create"] });
    expect(batchRemovalRelations(pick("Create", "Flywheel"), rows)).toEqual({ broughtIn: [], dependents: [] });
    expect(batchRemovalRelations(pick("Fabric API", "Iris"), rows)).toEqual({ broughtIn: [], dependents: ["Sodium"] });
  });
});

describe("Mod 速览", () => {
  it("每行个数按内宽：44 宽、8 间距", () => {
    expect(peekPerRow(44)).toBe(1);
    expect(peekPerRow(95)).toBe(1);
    expect(peekPerRow(96)).toBe(2);
    expect(peekPerRow(400)).toBe(7);
  });

  it("放得下全部就全部显示；放不下时最后一格留给 +N，N 按 Mod 总数算", () => {
    expect(peekLayout(14, 14, 7)).toEqual({ shown: 14, more: 0 });
    expect(peekLayout(15, 15, 7)).toEqual({ shown: 13, more: 2 });
    expect(peekLayout(24, 168, 7)).toEqual({ shown: 13, more: 155 });
    expect(peekLayout(5, 168, 7)).toEqual({ shown: 5, more: 163 });
  });
});

describe("存档排序", () => {
  const world = (dir: string, lastPlayed: number | null): WorldDto => ({
    dir_name: dir,
    level_status: "ok",
    level_error: null,
    name: dir,
    mode: "survival",
    last_played: lastPlayed,
    size_bytes: 0,
    modified_at: null,
  });
  it("最近玩过的在前，没记录的排最后", () => {
    expect(sortWorlds([world("b", null), world("a", 10), world("c", 20)]).map((w) => w.dir_name)).toEqual(["c", "a", "b"]);
  });
});

describe("变更历史", () => {
  const events: HistoryEvent[] = [
    { kind: "install", id: "100-000", at: 100, files: ["sodium-0.5.jar", "fabric-api.jar"] },
    {
      kind: "update",
      id: "200-000",
      at: 200,
      file_name: "sodium-0.6.jar",
      old_file: "sodium-0.5.jar",
      from_version: "v05",
      to_version: "v06",
      title: "Sodium",
      from_version_number: "0.5.0",
      to_version_number: null,
    },
    { kind: "rollback", id: "300-000", at: 300, reverted_event: "200-000" },
    { kind: "remove", id: "400-000", at: 400, files: ["lithium.jar"] },
  ];
  const checks = [
    { event_id: "100-000", can_rollback: false, reason: "安装事件不支持回滚" },
    { event_id: "200-000", can_rollback: false, reason: "该更新已经回滚过" },
    { event_id: "300-000", can_rollback: false, reason: "回滚事件本身不可再回滚" },
  ];

  it("最新在前，秒换毫秒，回滚指向的更新标为已撤销，版本号缺失时用版本标识", () => {
    const items = historyItems(events, checks, LOGS_COPY);
    expect(items.map((i) => i.title)).toEqual(["移除 lithium", "回滚 Sodium", "更新 Sodium", "安装 sodium-0.5 等 2 个文件"]);
    expect(items[0].atMs).toBe(400_000);
    const update = items[2];
    expect(update).toMatchObject({ reverted: true, from: "0.5.0", to: "v06", canRollback: false, blockedReason: "该更新已经回滚过", files: ["sodium-0.6.jar"] });
  });

  it("对不上检查结果的事件按不可回滚、没有原因处理", () => {
    const items = historyItems(events, checks, LOGS_COPY);
    expect(items[0]).toMatchObject({ canRollback: false, blockedReason: null });
  });
});

describe("日志指向的 Mod", () => {
  const mods = [mod("create-1.0.jar.disabled"), mod("jei-15.jar")];
  it("先按文件名（含停用态），再按 mod id", () => {
    expect(matchSuspect({ mod_id: "x", file_name: "create-1.0.jar" }, mods)?.file_name).toBe("create-1.0.jar.disabled");
    expect(matchSuspect({ mod_id: "JEI", file_name: null }, mods)?.file_name).toBe("jei-15.jar");
    expect(matchSuspect({ mod_id: "betterfoliage", file_name: null }, mods)).toBeNull();
  });
});

describe("一键尝试", () => {
  it("内存不足：在当前值上加 2 GB 取整，封顶物理内存一半；末尾固定对照日志", () => {
    expect(crashFixes(report([clue("out_of_memory")]), ctx({ memoryMb: 4096 }))).toEqual([
      { kind: "raise_memory", currentMb: 4096, targetMb: 6144, followsGlobal: true },
      { kind: "compare_log" },
    ]);
    expect(crashFixes(report([clue("out_of_memory")]), ctx({ memoryMb: 15000, physicalMb: 32768 }))[0]).toEqual({
      kind: "raise_memory",
      currentMb: 15000,
      targetMb: 16384,
      followsGlobal: true,
    });
  });

  it("已到上限时不给调整按钮", () => {
    expect(crashFixes(report([clue("out_of_memory")]), ctx({ memoryMb: 8192, physicalMb: 16384 }))[0]).toEqual({ kind: "memory_at_cap", totalMb: 16384 });
  });

  it("堆分配失败：32 位 Java 改用 64 位，64 位则调低（不低于 2 GB）", () => {
    const reserve = clue("out_of_memory", { matched: "Error: Could not reserve enough space for object heap" });
    expect(crashFixes(report([reserve], { java: { major: 8, path: "C:/j8/java.exe", is_64bit: false } }), ctx())[0]).toEqual({ kind: "use_64bit_java" });
    expect(crashFixes(report([reserve]), ctx({ memoryMb: 3072 }))[0]).toEqual({ kind: "lower_memory", currentMb: 3072, targetMb: 2048 });
    expect(crashFixes(report([reserve]), ctx({ memoryMb: 8192 }))[0]).toEqual({ kind: "lower_memory", currentMb: 8192, targetMb: 6144 });
  });

  it("Java 不匹配：从 class file version 推出主版本；本机有就切换，没有就下载", () => {
    const mismatch = clue("java_version_mismatch", { detail: "class file version 65" });
    const runtimes = [java("C:/j21/java.exe", 21, 1)];
    expect(crashFixes(report([mismatch]), ctx({ runtimes }))[0]).toEqual({ kind: "switch_java", major: 21, path: "C:/j21/java.exe" });
    expect(crashFixes(report([clue("java_version_mismatch")]), ctx({ requiredJava: 17 }))[0]).toEqual({ kind: "download_java", major: 17 });
  });

  it("缺少前置：停用着的启用它，没装的去搜索，没有 detail 去发现页", () => {
    const mods = [mod("cloth-config-1.jar.disabled")];
    expect(crashFixes(report([clue("missing_dependency", { detail: "cloth" })]), ctx({ mods }))[0]).toEqual({
      kind: "enable_mod",
      fileName: "cloth-config-1.jar.disabled",
      name: "cloth-config-1",
    });
    expect(crashFixes(report([clue("missing_dependency", { detail: "architectury" })]), ctx({ mods }))[0]).toEqual({
      kind: "search_dependency",
      category: "missing_dependency",
      detail: "architectury",
    });
    expect(crashFixes(report([clue("missing_dependency")]), ctx())[0]).toEqual({ kind: "find_dependency" });
  });

  it("Mixin 注入失败：恰好对上一个已启用的 Mod 才给停用按钮", () => {
    const mods = [mod("iris-1.jar"), mod("iris-2.jar")];
    expect(crashFixes(report([clue("mixin_failure", { detail: "sodium" })]), ctx({ mods: [mod("sodium-1.jar")] }))[0]).toEqual({
      kind: "disable_mod",
      category: "mixin_failure",
      fileName: "sodium-1.jar",
      name: "sodium-1",
    });
    expect(crashFixes(report([clue("mixin_failure", { detail: "iris" })]), ctx({ mods }))).toEqual([{ kind: "compare_log" }]);
  });

  it("重复的 Mod：停用其余同 id 的文件，留下版本最高的", () => {
    const mods = [mod("jei-1.jar", {}, { mod_id: "jei", version: "15.2.0" }), mod("jei-2.jar", {}, { mod_id: "jei", version: "15.10.1" })];
    expect(crashFixes(report([clue("duplicate_mod", { detail: "jei" })]), ctx({ mods }))[0]).toEqual({
      kind: "keep_latest",
      disable: [{ fileName: "jei-1.jar", name: "jei-1" }],
    });
  });

  it("本地库缺失带游戏路径提醒时多一个更换游戏目录；显卡驱动给这次用的 java.exe 路径；文件损坏落在 mods 下改为停用该文件", () => {
    expect(crashFixes(report([clue("native_library_missing")], { warnings: ["game_path"] }), ctx())[0]).toEqual({
      kind: "repair",
      category: "native_library_missing",
      changeGameDir: true,
      renameInstance: false,
    });
    // 只有实例名含中文：换游戏目录没用，给的是重命名
    expect(crashFixes(report([clue("native_library_missing")], { warnings: ["instance_name"] }), ctx())[0]).toEqual({
      kind: "repair",
      category: "native_library_missing",
      changeGameDir: false,
      renameInstance: true,
    });
    expect(crashFixes(report([clue("native_library_missing")], { warnings: ["game_path", "instance_name"] }), ctx())[0]).toEqual({
      kind: "repair",
      category: "native_library_missing",
      changeGameDir: true,
      renameInstance: true,
    });
    expect(crashFixes(report([clue("graphics_driver")]), ctx())[0]).toEqual({ kind: "driver_steps", category: "graphics_driver", javaPath: "C:/jdk/bin/java.exe" });
    const mods = [mod("badmod-1.jar")];
    expect(crashFixes(report([clue("corrupted_jar", { matched: "zip END header not found D:\\mc\\mods\\badmod-1.jar" })]), ctx({ mods }))[0]).toEqual({
      kind: "disable_mod",
      category: "corrupted_jar",
      fileName: "badmod-1.jar",
      name: "badmod-1",
    });
    expect(crashFixes(report([clue("corrupted_jar", { matched: "client.jar is corrupt" })]), ctx({ mods }))[0]).toEqual({
      kind: "repair",
      category: "corrupted_jar",
      changeGameDir: false,
      renameInstance: false,
    });
  });

  it("同一类别只出一条；没有线索时只剩对照日志", () => {
    expect(crashFixes(report([clue("out_of_memory"), clue("out_of_memory")]), ctx()).length).toBe(2);
    expect(crashFixes(report([]), ctx())).toEqual([{ kind: "compare_log" }]);
  });
});

describe("一键尝试：版本、语言支持、OptiFine 与本地崩溃", () => {
  const only = (fixes: ReturnType<typeof crashFixes>) => fixes.filter((f) => f.kind !== "compare_log");

  it("缺少语言支持：第三方语言支持去搜索；Forge 自带的 javafml / lowcodefml 与没有 detail 时不出按钮", () => {
    expect(crashFixes(report([clue("missing_language_provider", { detail: "kotlinforforge" })]), ctx())).toEqual([
      { kind: "search_dependency", category: "missing_language_provider", detail: "kotlinforforge" },
      { kind: "compare_log" },
    ]);
    expect(crashFixes(report([clue("missing_language_provider", { detail: "javafml" })]), ctx())).toEqual([{ kind: "compare_log" }]);
    expect(crashFixes(report([clue("missing_language_provider", { detail: "LowCodeFML" })]), ctx())).toEqual([{ kind: "compare_log" }]);
    expect(crashFixes(report([clue("missing_language_provider")]), ctx())).toEqual([{ kind: "compare_log" }]);
  });

  it("缺少语言支持与缺少前置指向同一个 Mod 时只留一条搜索，键不重复", () => {
    const fixes = crashFixes(
      report([clue("missing_language_provider", { detail: "kotlinforforge" }), clue("missing_dependency", { detail: "KotlinForForge" })]),
      ctx(),
    );
    expect(fixes).toEqual([{ kind: "search_dependency", category: "missing_language_provider", detail: "kotlinforforge" }, { kind: "compare_log" }]);
  });

  it("版本不符：detail 恰好对上一个已启用的 Mod 给停用按钮", () => {
    const mods = [mod("sodium-0.5.3.jar", {}, { name: "Sodium" }), mod("lithium-0.11.jar")];
    expect(crashFixes(report([clue("game_version_mismatch", { detail: "sodium" })]), ctx({ mods }))).toEqual([
      { kind: "disable_mod", category: "game_version_mismatch", fileName: "sodium-0.5.3.jar", name: "Sodium" },
      { kind: "compare_log" },
    ]);
  });

  it("版本不符：对不上、只对上停用着的、对上多个时改去发现页按 detail 查找；没有 detail 时不带关键词", () => {
    const category = "game_version_mismatch";
    expect(only(crashFixes(report([clue("game_version_mismatch", { detail: "iris" })]), ctx({ mods: [mod("sodium-1.jar")] })))).toEqual([
      { kind: "find_mod_version", category, detail: "iris" },
    ]);
    expect(only(crashFixes(report([clue("game_version_mismatch", { detail: "sodium" })]), ctx({ mods: [mod("sodium-1.jar.disabled")] })))).toEqual([
      { kind: "find_mod_version", category, detail: "sodium" },
    ]);
    expect(only(crashFixes(report([clue("game_version_mismatch", { detail: "sodium" })]), ctx({ mods: [mod("sodium-1.jar"), mod("sodium-2.jar")] })))).toEqual([
      { kind: "find_mod_version", category, detail: "sodium" },
    ]);
    expect(only(crashFixes(report([clue("game_version_mismatch")]), ctx({ mods: [mod("sodium-1.jar")] })))).toEqual([{ kind: "find_mod_version", category, detail: null }]);
  });

  describe("前置版本不对", () => {
    const api = mod("fabric-api-0.83.0.jar", {}, { mod_id: "fabric-api", name: "Fabric API" });

    it("前置装着：带去 Mod 页，不给停用", () => {
      expect(only(crashFixes(report([clue("dependency_version_mismatch", { detail: "fabric-api" })]), ctx({ mods: [api] })))).toEqual([
        { kind: "view_mod", category: "dependency_version_mismatch", fileName: "fabric-api-0.83.0.jar", name: "Fabric API" },
      ]);
    });

    it("前置不在 Mod 列表里（打包在别的 Mod 里）：去发现页按 detail 查找", () => {
      expect(only(crashFixes(report([clue("dependency_version_mismatch", { detail: "cloth-config" })]), ctx({ mods: [api] })))).toEqual([
        { kind: "find_mod_version", category: "dependency_version_mismatch", detail: "cloth-config" },
      ]);
    });

    it("同一个前置既被说版本不符又被说版本不对：只出一行，标题跟第一条线索", () => {
      const yacl = mod("yacl-3.6.6.jar", {}, { depends: ["fabric-api"] });
      const fixes = crashFixes(
        report([clue("game_version_mismatch", { detail: "fabric-api" }), clue("dependency_version_mismatch", { detail: "fabric-api" })]),
        ctx({ mods: [api, yacl] }),
      );
      expect(only(fixes)).toEqual([{ kind: "view_mod", category: "game_version_mismatch", fileName: "fabric-api-0.83.0.jar", name: "Fabric API" }]);
    });
  });

  describe("别的 Mod 的前置不给一键停用", () => {
    const cloth = mod("cloth-config-11.jar", {}, { mod_id: "cloth-config", name: "Cloth Config" });
    const viewCloth = { fileName: "cloth-config-11.jar", name: "Cloth Config" };

    it("有已启用的 Mod 声明依赖它：改成查看 Mod，不分大小写", () => {
      const rei = mod("rei-12.jar", {}, { depends: ["fabricloader", "Cloth-Config"] });
      expect(only(crashFixes(report([clue("game_version_mismatch", { detail: "cloth-config" })]), ctx({ mods: [cloth, rei] })))).toEqual([
        { kind: "view_mod", category: "game_version_mismatch", ...viewCloth },
      ]);
    });

    it("依赖它的 Mod 都停用着、或者只有它自己声明过：照旧给停用", () => {
      const parked = mod("rei-12.jar.disabled", {}, { depends: ["cloth-config"] });
      const self = mod("cloth-config-11.jar", {}, { mod_id: "cloth-config", name: "Cloth Config", depends: ["cloth-config"] });
      for (const mods of [[cloth, parked], [self]]) {
        expect(only(crashFixes(report([clue("game_version_mismatch", { detail: "cloth-config" })]), ctx({ mods })))).toEqual([
          { kind: "disable_mod", category: "game_version_mismatch", ...viewCloth },
        ]);
      }
    });

    it("Fabric API：Mod 常常只声明它拆出来的子模块，没人写 fabric-api 也不给停用", () => {
      const sodium = mod("sodium-0.5.jar", {}, { depends: ["fabric-rendering-v1", "fabricloader"] });
      for (const [id, fileName] of [
        ["fabric-api", "fabric-api-0.83.jar"],
        ["fabric", "fabric-0.40.jar"],
        ["quilted_fabric_api", "qfapi-7.jar"],
      ]) {
        const api = mod(fileName, {}, { mod_id: id, name: "Fabric API" });
        expect(only(crashFixes(report([clue("game_version_mismatch", { detail: id })]), ctx({ mods: [api, sodium] })))).toEqual([
          { kind: "view_mod", category: "game_version_mismatch", fileName, name: "Fabric API" },
        ]);
      }
    });

    it("Mixin 注入失败与文件损坏同样不给停用", () => {
      const rei = mod("rei-12.jar", {}, { depends: ["cloth-config"] });
      expect(only(crashFixes(report([clue("mixin_failure", { detail: "cloth-config" })]), ctx({ mods: [cloth, rei] })))).toEqual([
        { kind: "view_mod", category: "mixin_failure", ...viewCloth },
      ]);
      const corrupted = clue("corrupted_jar", { matched: "zip END header not found D:\\mc\\mods\\cloth-config-11.jar" });
      expect(only(crashFixes(report([corrupted]), ctx({ mods: [cloth, rei] })))).toEqual([{ kind: "view_mod", category: "corrupted_jar", ...viewCloth }]);
    });

    it("OptiFine 被别的 Mod 声明依赖时同样不给停用", () => {
      const optifine = mod("OptiFine_1.20.1_HD_U_I6.jar", {}, { mod_id: "optifine", name: "OptiFine" });
      const addon = mod("of-addon-1.jar", {}, { depends: ["optifine"] });
      expect(only(crashFixes(report([clue("optifine_incompatible")]), ctx({ mods: [optifine, addon] })))).toEqual([
        { kind: "view_mod", category: "optifine_incompatible", fileName: "OptiFine_1.20.1_HD_U_I6.jar", name: "OptiFine" },
      ]);
    });

    it("元数据读不出来的 Mod 说不清被谁依赖，也说不清依赖谁：照旧给停用", () => {
      const bare = mod("cloth-config", {}, null);
      const unreadable = mod("rei-12.jar", {}, null);
      expect(only(crashFixes(report([clue("game_version_mismatch", { detail: "cloth-config" })]), ctx({ mods: [bare, unreadable] })))).toEqual([
        { kind: "disable_mod", category: "game_version_mismatch", fileName: "cloth-config", name: "cloth-config" },
      ]);
    });
  });

  it("OptiFine 不兼容：文件名或 mod id 带 optifine 的已启用 Mod 恰好一个才给停用按钮", () => {
    const optifine = mod("OptiFine_1.20.1_HD_U_I6.jar", {}, null);
    expect(crashFixes(report([clue("optifine_incompatible")]), ctx({ mods: [optifine, mod("sodium-1.jar")] }))).toEqual([
      { kind: "disable_mod", category: "optifine_incompatible", fileName: "OptiFine_1.20.1_HD_U_I6.jar", name: "OptiFine_1.20.1_HD_U_I6" },
      { kind: "compare_log" },
    ]);
    // 文件名看不出、元数据里的 mod id 是 optifine 的也算
    const byId = mod("of-renamed.jar", {}, { mod_id: "optifine", name: "OptiFine" });
    expect(only(crashFixes(report([clue("optifine_incompatible")]), ctx({ mods: [byId] })))).toEqual([
      { kind: "disable_mod", category: "optifine_incompatible", fileName: "of-renamed.jar", name: "OptiFine" },
    ]);
    // 已经停用、一个都没有、装了两份：不出按钮
    expect(only(crashFixes(report([clue("optifine_incompatible")]), ctx({ mods: [mod("OptiFine_1.20.1_HD_U_I6.jar.disabled", {}, null)] })))).toEqual([]);
    expect(only(crashFixes(report([clue("optifine_incompatible")]), ctx({ mods: [mod("sodium-1.jar")] })))).toEqual([]);
    expect(only(crashFixes(report([clue("optifine_incompatible")]), ctx({ mods: [optifine, mod("OptiFine_1.20.1_HD_U_I5.jar", {}, null)] })))).toEqual([]);
    // 转接用的 OptiFabric 名字里没有 optifine，不算第二份
    expect(only(crashFixes(report([clue("optifine_incompatible")]), ctx({ mods: [optifine, mod("optifabric-1.7.jar")] })))).toEqual([
      { kind: "disable_mod", category: "optifine_incompatible", fileName: "OptiFine_1.20.1_HD_U_I6.jar", name: "OptiFine_1.20.1_HD_U_I6" },
    ]);
  });

  it("停用同一个文件的两条线索只出一行，标题跟第一条线索的类别", () => {
    const mods = [mod("sodium-1.jar")];
    const fixes = crashFixes(report([clue("game_version_mismatch", { detail: "sodium" }), clue("mixin_failure", { detail: "sodium" })]), ctx({ mods }));
    expect(fixes).toEqual([{ kind: "disable_mod", category: "game_version_mismatch", fileName: "sodium-1.jar", name: "sodium-1" }, { kind: "compare_log" }]);
  });

  it("最大内存写在 -Xmx 里：调内存设置不生效，一键尝试带去改参数", () => {
    const oom = clue("out_of_memory", { matched: "java.lang.OutOfMemoryError: Java heap space" });
    expect(crashFixes(report([oom], { max_memory_mb: 64 }), ctx({ jvmArgs: "-Xmx64M -XX:+UseG1GC" }))[0]).toEqual({ kind: "memory_in_jvm_args" });
    const reserve = clue("out_of_memory", { matched: "Could not reserve enough space for object heap" });
    expect(crashFixes(report([reserve]), ctx({ jvmArgs: "-Xmx32G" }))[0]).toEqual({ kind: "memory_in_jvm_args" });
    // 32 位 Java 分配不到是换 Java 的事，写在哪里都一样；-Xms 不决定上限，内存设置照样管用
    expect(crashFixes(report([reserve], { java: { major: 8, path: "C:/j8/bin/java.exe", is_64bit: false } }), ctx({ jvmArgs: "-Xmx4G" }))[0]).toEqual({ kind: "use_64bit_java" });
    expect(crashFixes(report([oom]), ctx({ jvmArgs: "-Xms1G" }))[0]).toMatchObject({ kind: "raise_memory" });
  });

  it("JVM 参数被拒：一键尝试带去实例设置，不替玩家改参数", () => {
    expect(crashFixes(report([clue("jvm_args_invalid", { detail: "NotARealFlag" })]), ctx())).toEqual([{ kind: "jvm_args" }, { kind: "compare_log" }]);
  });

  it("加载器写明要 Java 21：本机有就切过去，没有就下载", () => {
    const java21 = crashFixes(report([clue("java_version_mismatch", { detail: "java 21" })]), ctx({ requiredJava: 17, runtimes: [java("D:/jdk21/bin/java.exe", 21, 1)] }));
    expect(java21[0]).toEqual({ kind: "switch_java", major: 21, path: "D:/jdk21/bin/java.exe" });
    expect(crashFixes(report([clue("java_version_mismatch", { detail: "java 21" })]), ctx({ requiredJava: 17, runtimes: [] }))[0]).toEqual({ kind: "download_java", major: 21 });
  });

  it("Intel 显卡驱动与本地崩溃：给处理办法三步与 java.exe 路径；报告里没有 Java 时不给路径", () => {
    expect(crashFixes(report([clue("intel_graphics_driver", { detail: "ig9icd64.dll" })]), ctx())[0]).toEqual({
      kind: "driver_steps",
      category: "intel_graphics_driver",
      javaPath: "C:/jdk/bin/java.exe",
    });
    const nativeClue = clue("native_crash", { detail: "0xC0000005", matched: "", line: 0, source: "exit_code" });
    expect(crashFixes(report([nativeClue], { java: null }), ctx())).toEqual([{ kind: "driver_steps", category: "native_crash", javaPath: null }, { kind: "compare_log" }]);
  });

  it("显卡、Intel 显卡与本地崩溃同在一份报告里只出一条处理办法，取第一条出现的类别", () => {
    const fixes = crashFixes(report([clue("intel_graphics_driver"), clue("graphics_driver"), clue("native_crash", { source: "exit_code" })]), ctx());
    expect(fixes).toEqual([{ kind: "driver_steps", category: "intel_graphics_driver", javaPath: "C:/jdk/bin/java.exe" }, { kind: "compare_log" }]);
    const reversed = crashFixes(report([clue("graphics_driver"), clue("intel_graphics_driver")]), ctx());
    expect(reversed.map((f) => (f.kind === "driver_steps" ? f.category : f.kind))).toEqual(["graphics_driver", "compare_log"]);
  });

  it("全部 13 类线索同在一份报告里：每条一键尝试的键都不重复", () => {
    const mods = [mod("sodium-1.jar"), mod("jei-1.jar"), mod("jei-2.jar"), mod("OptiFine_HD_U_I6.jar", {}, null), mod("badmod-1.jar")];
    const fixes = crashFixes(
      report([
        clue("java_version_mismatch", { detail: "class file version 65" }),
        clue("out_of_memory"),
        clue("missing_language_provider", { detail: "kotlinforforge" }),
        clue("game_version_mismatch", { detail: "sodium" }),
        clue("missing_dependency", { detail: "architectury" }),
        clue("optifine_incompatible"),
        clue("mixin_failure", { detail: "sodium" }),
        clue("duplicate_mod", { detail: "jei" }),
        clue("native_library_missing"),
        clue("intel_graphics_driver"),
        clue("graphics_driver"),
        clue("corrupted_jar", { matched: "zip END header not found D:/mc/mods/badmod-1.jar" }),
        clue("native_crash", { source: "exit_code" }),
      ]),
      ctx({ mods }),
    );
    const keys = fixes.map(crashFixKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual([
      "download_java:21",
      "raise_memory",
      "search_dependency:kotlinforforge",
      "disable_mod:sodium-1.jar",
      "search_dependency:architectury",
      "disable_mod:OptiFine_HD_U_I6.jar",
      "keep_latest",
      "repair:native_library_missing",
      "driver_steps",
      "disable_mod:badmod-1.jar",
      "compare_log",
    ]);
  });
});
