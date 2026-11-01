// 实例详情页的派生计算：纯函数，不碰 React 与状态容器，五个标签页与头图共用同一份判断。
// 输入一律是状态层给出的领域模型与 DTO；页面组件只负责把这里的结论画出来。

import { isForgeBuiltinProvider } from "../../copy/flows";
import type { InstanceSummary, Settings } from "../../domain/adapt";
import { samePath } from "../../domain/paths";
import { bestLocalRuntime, isHeapReserveFailure, javaMajorFromClassVersion, memoryLowerTarget, memoryTarget } from "../../domain/rules";
import type { Task, TaskError, TaskStatus } from "../../domain/types";
import type { LaunchView, LaunchViewKind } from "../../launch/launchView";
import type { JavaInstallationDto } from "../../state/queries/catalog";
import type { CrashReportDto, HistoryEvent, InstalledMod, RollbackCheck, UpdateCandidate, UpdateHold, WorldDto } from "../../state/queries/instance";
import { isActiveTask } from "../../state/tasks";
import type { TableSort } from "../../ui/Table";
import { MODS_COPY } from "./copy";

// ---------------------------------------------------------------- 上次崩溃

/**
 * 「上次崩溃」只在这次崩溃之后没有再正常玩过、且此刻不在启动或运行时提示。崩溃报告不会被后续正常启动清空，
 * 所以要拿它和上次游玩比：崩溃那一局的退出时刻同时写进两边，之后正常结束的一局会把上次游玩推到更晚。
 * 游玩记录读不出时比不了，按还没再玩过算：多提示一次，好过把崩溃藏起来。
 */
export function isCrashActive(crashAt: number | null, lastPlayedAt: number | null, view: LaunchViewKind): boolean {
  if (crashAt === null) return false;
  if (view === "loading" || view === "running") return false;
  return lastPlayedAt === null || crashAt >= lastPlayedAt;
}

// ---------------------------------------------------------------- 删除

/**
 * 删除时随实例一起移入回收站的存档数，读不出为 null。实例列表里的存档数按工作目录数：隔离的实例工作目录
 * 就是实例文件夹；不隔离的共用 .minecraft/saves，删除实例不碰它们（实例文件夹里有存档时后端会强制隔离）。
 */
export function deletableWorldCount(inst: Pick<InstanceSummary, "isolated" | "worldCount">): number | null {
  if (inst.isolated === null || inst.worldCount === null) return null;
  return inst.isolated ? inst.worldCount : 0;
}

// ---------------------------------------------------------------- 锁定

/** 打开工作子目录与写实例设置被什么挡住。 */
export type WorkLock = "installing" | "renaming" | "deleting";

/**
 * 打开 mods、saves、logs 这类工作子目录（缺了要先建出来）与写实例设置时，后端以「改动中」占住实例：
 * 与安装、补全、改名、删除互斥，与启动、运行和别的改动兼容。所以游戏运行中照常可用，只有这几种活动挡住它们；
 * 不提前禁用的话只能等后端以 instance_busy 拒绝后再报错。
 * installing：本实例的安装或补全任务在排队或进行中（前端任务表或后端报告的活动）。
 */
export function workLock(installing: boolean, activity: InstanceSummary["activity"]): WorkLock | null {
  if (installing) return "installing";
  return activity === "renaming" || activity === "deleting" ? activity : null;
}

// ---------------------------------------------------------------- 整页订阅的启动视图

/**
 * 整页按片订阅启动视图时的相等比较：只比页面自己画的判定（种类、加载阶段、结束原因、失败码、损坏原因、
 * 任务是哪一个、排没排上），不比进度。启动下载与安装、补全的进度每个任务约 100 ms 一次，
 * 每次都换一份会话或任务对象；按 launchViewEqual 比，头图、标签条与当前标签就跟着整页重渲染。
 * 所以页面拿到的视图里，会话与任务只是判定变化那一刻的快照：进度、速度、字节数可能是旧的，
 * 画进度的部件（胶囊、头图的安装标签、概览的安装横幅）各自订阅。
 */
export function pageViewEqual(a: LaunchView, b: LaunchView): boolean {
  switch (a.kind) {
    case "ready":
      return b.kind === "ready" && a.busyElsewhere === b.busyElsewhere;
    case "loading":
      return b.kind === "loading" && a.phase === b.phase;
    case "running":
    case "crashed":
      return b.kind === a.kind;
    case "stopped":
      return b.kind === "stopped" && a.reason === b.reason;
    case "failed":
      return b.kind === "failed" && a.code === b.code && a.params === b.params;
    case "installing": {
      if (b.kind !== "installing" || a.queuePosition !== b.queuePosition) return false;
      if (a.task === null || b.task === null) return a.task === b.task;
      return a.task.id === b.task.id && a.task.status === b.task.status;
    }
    case "broken":
      return b.kind === "broken" && a.reason === b.reason && a.reimport === b.reimport;
  }
}

// ---------------------------------------------------------------- 概览横幅

export type OverviewBannerKind = "failed" | "crashed" | "broken" | "installing";

/** 每页至多一条横幅，多个条件同时成立时取最高严重度：启动失败与上次崩溃（danger）> 损坏（warn）> 安装中（info）。 */
export function overviewBanner(view: LaunchViewKind, crashActive: boolean): OverviewBannerKind | null {
  if (view === "failed") return "failed";
  if (crashActive) return "crashed";
  if (view === "broken") return "broken";
  if (view === "installing") return "installing";
  return null;
}

// ---------------------------------------------------------------- 存档直达

export type EnterWorldBlock = "installing" | "broken" | "unknownVersion" | "legacy" | "backingUp" | "inherited" | "launching" | "running";

/**
 * 存档行「进入」此刻为什么不能点；能点为 null。自上而下取第一条：实例自身的状态先于版本能力，版本能力先于进行中的
 * 备份与这一局的会话。另一个实例占着游戏进程时照常能点，由启动拦截弹替换确认。
 *
 * 备份或恢复期间、别的实例正以它为基底时后端以 instance_busy 拒绝启动，这里提前禁用。worldTask 是前端排着或进行中的
 * 存档任务：后端还没报 backing_up 时就点进入，会正好撞上马上要占实例的那个任务。
 */
export function enterWorldBlock(inst: Pick<InstanceSummary, "status" | "quickPlay" | "activity" | "usedBy">, view: LaunchViewKind, worldTask: boolean): EnterWorldBlock | null {
  if (inst.status === "installing") return "installing";
  if (inst.status === "broken") return "broken";
  if (inst.quickPlay === null) return "unknownVersion";
  if (!inst.quickPlay.singleplayer) return "legacy";
  if (inst.activity === "backing_up" || worldTask) return "backingUp";
  if (inst.usedBy !== null) return "inherited";
  if (view === "loading") return "launching";
  if (view === "running") return "running";
  return null;
}

// ---------------------------------------------------------------- 新建与导入还没装好

/** 新建实例与导入整合包：它们的任务挂在一个还没装好的实例名下。补全不在其中，补全的实例原本就装好过、内容都在。 */
export const CREATE_COMMANDS: ReadonlySet<string> = new Set(["install_version", "install_modpack"]);

/**
 * 页面整份订阅时只取新建或导入任务的这几项。进度、速度每个任务约 100 ms 变一次，不在里面：
 * 概览的安装横幅自己订阅进度，头图、标签条与标签内容不随它重渲染。
 */
export interface CreationRef {
  id: string;
  status: TaskStatus;
  title: string;
  modpack: boolean;
  error: TaskError | null;
}

/** 挂在这个实例名下的新建或导入任务：进行中的优先（重试还是同一个任务）；都已结束时取最近建的那个。 */
export function creationRef(tasks: readonly Task[], instanceId: string): CreationRef | null {
  let pick: Task | null = null;
  for (const task of tasks) {
    if (task.instanceId !== instanceId || !CREATE_COMMANDS.has(task.spec.command)) continue;
    if (isActiveTask(task)) {
      pick = task;
      break;
    }
    if (pick === null || task.createdAt >= pick.createdAt) pick = task;
  }
  if (pick === null) return null;
  return { id: pick.id, status: pick.status, title: pick.title, modpack: pick.spec.command === "install_modpack", error: pick.error };
}

export function creationRefEqual(a: CreationRef | null, b: CreationRef | null): boolean {
  if (a === null || b === null) return a === b;
  const sameError = a.error === null || b.error === null ? a.error === b.error : a.error.code === b.error.code && a.error.message === b.error.message;
  return a.id === b.id && a.status === b.status && a.title === b.title && a.modpack === b.modpack && sameError;
}

/**
 * 实例详情的标签此刻能不能画正常内容。
 *
 * - queued / running：新建或导入任务还在排队或在跑。占位项盘上没有目录；扫到了目录的，那也只是装了一半的现场。
 * - landing：任务已经结束，结束后的那次重扫还没回来。扫到的是装好的实例、留着未完成标记的实例，还是什么都没有，扫完才知道。
 * - failed：状态层在任务失败后仍留着占位项（盘上什么都没留下），给原因与重试。
 * - none：实例装好了，或者是个扫得到的损坏实例（失败的新建会留下带未完成标记的目录，由损坏横幅给出原因与修复）。
 */
export type InstallStage =
  | { kind: "none" }
  | { kind: "queued" | "running"; title: string }
  | { kind: "landing" }
  | { kind: "failed"; taskId: string; modpack: boolean; error: TaskError };

export function installStage(inst: Pick<InstanceSummary, "id" | "placeholder" | "activity">, creation: CreationRef | null): InstallStage {
  if (creation !== null && (creation.status === "queued" || creation.status === "running")) return { kind: creation.status, title: creation.title };
  if (inst.placeholder) {
    if (creation === null) throw new Error(`占位实例「${inst.id}」没有对应的新建或导入任务`);
    if (creation.status !== "failed") return { kind: "landing" };
    if (creation.error === null) throw new Error(`失败的任务 ${creation.id} 没有记下失败原因`);
    return { kind: "failed", taskId: creation.id, modpack: creation.modpack, error: creation.error };
  }
  // 后端在新建、导入期间占着实例名，扫描结果里记着 installing；前端的任务却已经结束，说明这份扫描是任务结束前的
  if (inst.activity === "installing") return { kind: "landing" };
  return { kind: "none" };
}

// ---------------------------------------------------------------- 游玩

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** 平均每周游玩小时数：按创建至今的周数，不足一周按一周算。 */
export function weeklyHours(playtimeMin: number, createdAt: number, now: number): string {
  const weeks = Math.max(1, (now - createdAt) / WEEK_MS);
  return (playtimeMin / 60 / weeks).toFixed(1);
}

// ---------------------------------------------------------------- 内存

/**
 * 实际生效的最大内存，与启动时的取值同一条规则：实例单独设置优先；否则全局开启自动分配时取推荐值，
 * 关闭时取全局固定值。推荐值来自后端的内存建议，与自动分配共用一个来源。
 */
export function effectiveMemoryMb(instanceMb: number | null, global: Settings["memory"], recommendedMb: number): number {
  if (instanceMb !== null) return instanceMb;
  return global.auto ? recommendedMb : global.maxMb;
}

// ---------------------------------------------------------------- Java

export type JavaFit = "match" | "higher" | "lower";

/** 运行时与要求的匹配：相等能跑；更高多半能跑但旧版 Forge 会报错；更低无法启动。 */
export function javaFit(major: number, required: number): JavaFit {
  if (major === required) return "match";
  return major > required ? "higher" : "lower";
}

/**
 * 自动选择会落到哪个运行时，与后端的挑选同一条规则：全局设置里指定了默认 Java 时一律用它；
 * 否则在主版本相等、文件齐全的候选里先挑 64 位、再挑版本号最高的；一个都没有时启动阶段自动下载。
 */
export type AutoJavaPick =
  | { kind: "global"; path: string; runtime: JavaInstallationDto | null }
  | { kind: "local"; runtime: JavaInstallationDto }
  | { kind: "download" };

export function autoJavaPick(runtimes: readonly JavaInstallationDto[], required: number, defaultJava: string, javaAuto: string): AutoJavaPick {
  if (defaultJava !== javaAuto) {
    const runtime = runtimes.find((r) => samePath(r.path, defaultJava));
    return { kind: "global", path: defaultJava, runtime: runtime === undefined ? null : runtime };
  }
  const best = bestLocalRuntime(runtimes, required);
  return best === null ? { kind: "download" } : { kind: "local", runtime: best };
}

export type JavaChoice =
  | { auto: true; pick: AutoJavaPick }
  /** 固定了路径；runtime 为 null 表示那个 Java 已不在本机（被卸载或移动）。 */
  | { auto: false; path: string; runtime: JavaInstallationDto | null };

export function javaChoice(settingsJava: string, runtimes: readonly JavaInstallationDto[], required: number, defaultJava: string, javaAuto: string): JavaChoice {
  if (settingsJava === javaAuto) return { auto: true, pick: autoJavaPick(runtimes, required, defaultJava, javaAuto) };
  const runtime = runtimes.find((r) => samePath(r.path, settingsJava));
  return { auto: false, path: settingsJava, runtime: runtime === undefined ? null : runtime };
}

/** 这次会用到的运行时；自动且本机没有（要下载）、或固定的已不在本机时为 null。 */
export function chosenRuntime(choice: JavaChoice): JavaInstallationDto | null {
  if (!choice.auto) return choice.runtime;
  return choice.pick.kind === "download" ? null : choice.pick.runtime;
}

/** JVM 预设可用性判断用的主版本：实际生效的运行时；本机还没有时取要求版本（会下载的就是它）。 */
export function effectiveJavaMajor(choice: JavaChoice, required: number): number {
  const runtime = chosenRuntime(choice);
  return runtime === null ? required : runtime.version.major;
}

// ---------------------------------------------------------------- JVM 参数

export type JvmPresetKey = "g1" | "zgc" | "pretouch" | "utf8";

/** 分代 ZGC 从 Java 21 起可用；Java 23 起分代成为唯一模式，-XX:+ZGenerational 已被移除，再写会让 JVM 报错退出。 */
export const ZGC_MIN_JAVA = 21;
const ZGC_GENERATIONAL_DEFAULT_JAVA = 23;

/** 预设对应的参数片段；当前 Java 不支持时为 null。 */
export function presetFlags(key: JvmPresetKey, javaMajor: number): readonly string[] | null {
  switch (key) {
    case "g1":
      return ["-XX:+UseG1GC"];
    case "zgc":
      if (javaMajor < ZGC_MIN_JAVA) return null;
      return javaMajor >= ZGC_GENERATIONAL_DEFAULT_JAVA ? ["-XX:+UseZGC"] : ["-XX:+UseZGC", "-XX:+ZGenerational"];
    case "pretouch":
      return ["-XX:+AlwaysPreTouch"];
    case "utf8":
      return ["-Dfile.encoding=UTF-8"];
  }
}

export const JVM_PRESET_KEYS: readonly JvmPresetKey[] = ["g1", "zgc", "pretouch", "utf8"];

export function jvmTokens(text: string): string[] {
  return text.split(/\s+/).filter((t) => t !== "");
}

export function hasFlags(text: string, flags: readonly string[]): boolean {
  const tokens = jvmTokens(text);
  return flags.every((f) => tokens.includes(f));
}

/** 在参数里加入或移除一组片段；移除 ZGC 时连同可能残留的 -XX:+ZGenerational 一起去掉。 */
export function toggleFlags(text: string, flags: readonly string[]): string {
  const tokens = jvmTokens(text);
  if (flags.every((f) => tokens.includes(f))) {
    const drop = new Set(flags.includes("-XX:+UseZGC") ? [...flags, "-XX:+ZGenerational"] : flags);
    return tokens.filter((t) => !drop.has(t)).join(" ");
  }
  return [...tokens, ...flags.filter((f) => !tokens.includes(f))].join(" ");
}

/** 参数里自带堆大小：它们排在默认参数之后，会覆盖内存设置。 */
export function overridesHeap(text: string): boolean {
  // 只看 -Xmx、-Xms 本身：-Xmso 这类是别的选项，不碰堆大小
  return jvmTokens(text).some((t) => /^-Xm[xs](?![a-zA-Z])/.test(t));
}

// ---------------------------------------------------------------- 窗口

export const RESOLUTION_LIMITS = { width: { min: 320, max: 7680 }, height: { min: 240, max: 4320 } } as const;

export const RESOLUTION_PRESETS: readonly { width: number; height: number }[] = [
  { width: 854, height: 480 },
  { width: 1280, height: 720 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 },
];

/** 输入框里的像素值：只认十进制整数且在范围内，否则为 null（提交时恢复原值）。 */
export function parseDimension(text: string, limit: { min: number; max: number }): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= limit.min && value <= limit.max ? value : null;
}

// ---------------------------------------------------------------- 路径

/** 实例文件夹：<游戏目录>/versions/<实例 id>，分隔符沿用游戏目录自己的写法。 */
export function instanceFolderPath(gameDir: string, id: string): string {
  const sep = gameDir.includes("\\") ? "\\" : "/";
  const base = gameDir.endsWith(sep) ? gameDir.slice(0, -1) : gameDir;
  return `${base}${sep}versions${sep}${id}`;
}

// ---------------------------------------------------------------- Mod

const DISABLED_SUFFIX = ".disabled";

/** 启用态文件名：更新候选按它对齐，停用的文件在磁盘上多一个 .disabled。 */
export function enabledFileName(fileName: string): string {
  return fileName.endsWith(DISABLED_SUFFIX) ? fileName.slice(0, -DISABLED_SUFFIX.length) : fileName;
}

/** 停用后的文件名：后端把文件改名为 <文件名>.disabled。 */
export function disabledFileName(fileName: string): string {
  return fileName.endsWith(DISABLED_SUFFIX) ? fileName : `${fileName}${DISABLED_SUFFIX}`;
}

/** 换 Mod 版本的两种任务：单个更新，与「全部更新」合成的组合任务。 */
export const MOD_UPDATE_COMMANDS: ReadonlySet<string> = new Set(["update_mod", "update_mods"]);

/**
 * 这个实例上排队或进行中的 Mod 更新任务。有它在时「全部更新」不能再点：检查更新还会把正在换的文件列进去，
 * 组合任务按旧文件名再换一遍，同一个文件被两个任务同时改。
 */
export function isPendingModUpdate(task: Task, instanceId: string): boolean {
  return task.instanceId === instanceId && MOD_UPDATE_COMMANDS.has(task.spec.command) && isActiveTask(task);
}

function fileStem(fileName: string): string {
  return enabledFileName(fileName).replace(/\.jar$/i, "");
}

export interface ModRow {
  fileName: string;
  enabled: boolean;
  /** 元数据名 → 平台标题 → 文件名去掉扩展名。 */
  name: string;
  version: string | null;
  author: string | null;
  summary: string | null;
  iconUrl: string | null;
  /** 回落底座的色相种子：mod id 优先，没有元数据时用文件名。 */
  seed: string;
  platform: "modrinth" | "curseforge" | null;
  projectId: string | null;
  /** 作为谁的前置被带进来的（那个 Mod 的显示名）；对不上已装 Mod 时为 null。 */
  dependencyOf: string | null;
  /** 带它进来的工程 id（对不上已装 Mod 时也保留，用于移除确认里的说明）。 */
  dependencyOfProject: string | null;
  /** 已忽略更新的行恒为 null：设置刚改、可更新项还没重取时也不再给「更新」。 */
  update: UpdateCandidate | null;
  size: number;
  modId: string | null;
  /** 装进实例的时刻（毫秒）：有来源记录取卷宗里的原值，本地文件取文件修改时刻。 */
  addedAt: number;
  /** 检查更新时的处理；本地文件没有来源记录，恒为 null。 */
  hold: UpdateHold | null;
}

export function modName(mod: InstalledMod): string {
  if (mod.metadata !== null && mod.metadata.name !== null && mod.metadata.name.trim() !== "") return mod.metadata.name;
  if (mod.source !== null && mod.source.title !== null && mod.source.title.trim() !== "") return mod.source.title;
  return fileStem(mod.file_name);
}

/** 已装 Mod 的列表行，按名称（中文排序规则）升序。updates 为 null 表示还没查过更新。 */
export function modRows(mods: readonly InstalledMod[], updates: readonly UpdateCandidate[] | null): ModRow[] {
  const nameByProject = new Map<string, string>();
  for (const m of mods) if (m.source !== null) nameByProject.set(m.source.project_id, modName(m));
  const rows = mods.map((m): ModRow => {
    const meta = m.metadata;
    const source = m.source;
    const depProject = source === null ? null : source.dependency_of;
    const depName = depProject === null ? undefined : nameByProject.get(depProject);
    const hold = source === null ? null : source.update_hold;
    const ignored = hold !== null && hold.kind === "ignored";
    const update = updates === null || ignored ? undefined : updates.find((u) => u.file_name === enabledFileName(m.file_name));
    const version = meta !== null && meta.version !== null ? meta.version : source !== null ? source.version_number : null;
    return {
      fileName: m.file_name,
      enabled: m.enabled,
      name: modName(m),
      version,
      author: meta !== null && meta.authors.length > 0 ? meta.authors.join(", ") : null,
      summary: meta !== null && meta.description !== null && meta.description.trim() !== "" ? meta.description.trim() : null,
      iconUrl: m.icon_url,
      seed: meta !== null ? meta.mod_id : enabledFileName(m.file_name),
      platform: source === null ? null : source.platform,
      projectId: source === null ? null : source.project_id,
      dependencyOf: depName === undefined ? null : depName,
      dependencyOfProject: depProject,
      update: update === undefined ? null : update,
      size: m.size,
      modId: meta === null ? null : meta.mod_id,
      addedAt: source === null ? m.modified_ms : source.installed_at * 1000,
      hold,
    };
  });
  return rows.sort((a, b) => a.name.localeCompare(b.name, "zh-CN") || a.fileName.localeCompare(b.fileName));
}

/**
 * Mod 总数与列表是否不全。实例摘要里的 modCount 与列表同源（mods 目录里的 .jar 与 .jar.disabled），
 * 自建实例的列表就是全部，两者对不上只说明摘要是早些时候扫的，以刚扫出的列表为准。
 * 只有整合包实例的列表才可能只列出代表（其余由整合包统一管理），这时总数取摘要与列表中较大的一个。
 */
export function modTotals(inst: Pick<InstanceSummary, "modCount" | "modpack">, listed: number): { total: number; partial: boolean } {
  if (inst.modpack === null || inst.modCount === null) return { total: listed, partial: false };
  const total = Math.max(inst.modCount, listed);
  return { total, partial: total > listed };
}

export type ModFilter = "all" | "enabled" | "disabled" | "outdated" | "ignored";

function isIgnored(row: ModRow): boolean {
  return row.hold !== null && row.hold.kind === "ignored";
}

export function modCounts(rows: readonly ModRow[]): Readonly<Record<ModFilter, number>> {
  const enabled = rows.filter((r) => r.enabled).length;
  return {
    all: rows.length,
    enabled,
    disabled: rows.length - enabled,
    outdated: rows.filter((r) => r.update !== null).length,
    ignored: rows.filter(isIgnored).length,
  };
}

/** 名称、作者、文件名、简介里不分大小写的子串匹配，再叠加状态筛选。 */
export function filterMods(rows: readonly ModRow[], query: string, filter: ModFilter): ModRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => {
    if (filter === "enabled" && !r.enabled) return false;
    if (filter === "disabled" && r.enabled) return false;
    if (filter === "outdated" && r.update === null) return false;
    if (filter === "ignored" && !isIgnored(r)) return false;
    if (q === "") return true;
    return [r.name, r.author, r.fileName, r.summary].some((field) => field !== null && field.toLowerCase().includes(q));
  });
}

/** 移除确认要说明的两层关系：它带进来的前置会保留；把它当前置的 Mod 可能加载不了。 */
export function removalRelations(row: ModRow, rows: readonly ModRow[]): { broughtIn: string[]; dependents: string[] } {
  const broughtIn = row.projectId === null ? [] : rows.filter((r) => r.dependencyOfProject === row.projectId && r.fileName !== row.fileName).map((r) => r.name);
  const dependents = row.dependencyOf === null ? [] : [row.dependencyOf];
  return { broughtIn, dependents };
}

/**
 * 批量移除的两层关系，只说没被一起选中的：选中项带进来的前置会保留；把选中项当前置的 Mod 可能加载不了。
 * 一起选中的已经要一并移除，提醒它们没有意义。名字按出现顺序去重。
 */
export function batchRemovalRelations(selected: readonly ModRow[], rows: readonly ModRow[]): { broughtIn: string[]; dependents: string[] } {
  const chosen = new Set(selected.map((r) => r.fileName));
  const projects = new Set(selected.flatMap((r) => (r.projectId === null ? [] : [r.projectId])));
  const broughtIn = rows.filter((r) => !chosen.has(r.fileName) && r.dependencyOfProject !== null && projects.has(r.dependencyOfProject)).map((r) => r.name);
  const dependents = selected.flatMap((s) =>
    s.dependencyOfProject === null ? [] : rows.filter((r) => r.projectId === s.dependencyOfProject && !chosen.has(r.fileName)).map((r) => r.name),
  );
  return { broughtIn: [...new Set(broughtIn)], dependents: [...new Set(dependents)] };
}

/** 批量操作条四个按钮的禁用原因；undefined 为可用。锁住时四个都沿用单行操作的锁定原因。 */
export interface BatchAvailability {
  enable: string | undefined;
  disable: string | undefined;
  update: string | undefined;
  remove: string | undefined;
}

export function batchAvailability(selected: readonly ModRow[], lock: string | undefined, isUpdating: (row: ModRow) => boolean): BatchAvailability {
  if (selected.length === 0) throw new Error("没有选中的 Mod 时不显示批量操作条");
  if (lock !== undefined) return { enable: lock, disable: lock, update: lock, remove: lock };
  // 已在更新的不进更新预览：选中的可更新项全在更新时打开也是一张空表
  const updatable = selected.filter((r) => r.update !== null);
  return {
    enable: selected.every((r) => r.enabled) ? MODS_COPY.batchAllEnabled : undefined,
    disable: selected.every((r) => !r.enabled) ? MODS_COPY.batchAllDisabled : undefined,
    update: updatable.length === 0 ? MODS_COPY.batchNoUpdates : updatable.every(isUpdating) ? MODS_COPY.batchAllUpdating : undefined,
    remove: undefined,
  };
}

const NEW_MOD_MS = 7 * 24 * 60 * 60 * 1000;

/** 装进实例不满 7 天算新增；恰好满 7 天起不再算。时刻在将来（本机时钟被往回调过）也按刚装上算。 */
export function isNewMod(row: Pick<ModRow, "addedAt">, now: number): boolean {
  return now - row.addedAt < NEW_MOD_MS;
}

/** 表头点到「安装时间」时第一次按新到旧：想看的是最近装了什么；再点由表格照常翻转。 */
export function adjustModSort(previous: TableSort, next: TableSort): TableSort {
  if (next.key === "installed" && previous.key !== "installed") return { key: "installed", direction: "desc" };
  return next;
}

/** 列表排序：名称、来源、启用状态按文本比，同值按名称；安装时间按时刻比，同一时刻按名称（再按文件名）升序。 */
export function sortRows(rows: readonly ModRow[], sort: TableSort): ModRow[] {
  const dir = sort.direction === "asc" ? 1 : -1;
  const byName = (a: ModRow, b: ModRow) => a.name.localeCompare(b.name, "zh-CN") || a.fileName.localeCompare(b.fileName);
  if (sort.key === "installed") return [...rows].sort((a, b) => dir * (a.addedAt - b.addedAt) || byName(a, b));
  const key = (r: ModRow): string => {
    if (sort.key === "source") return r.platform === null ? "~" : r.platform;
    if (sort.key === "enabled") return r.enabled ? "0" : "1";
    return r.name;
  };
  return [...rows].sort((a, b) => dir * key(a).localeCompare(key(b), "zh-CN") || a.name.localeCompare(b.name, "zh-CN"));
}

// ---------------------------------------------------------------- Mod 速览

/** 速览图块的边长与间距（px），每行能放几个按卡片内宽计算。 */
export const PEEK_TILE = 44;
export const PEEK_GAP = 8;
export const PEEK_ROWS = 2;

export function peekPerRow(innerWidth: number): number {
  return Math.max(1, Math.floor((innerWidth + PEEK_GAP) / (PEEK_TILE + PEEK_GAP)));
}

/**
 * 速览至多两行：放得下全部时全部显示；放不下时第二行最后一格留给「+N」，N 为 Mod 总数（含整合包里未列出的）减去已显示数。
 */
export function peekLayout(listed: number, total: number, perRow: number): { shown: number; more: number } {
  const capacity = perRow * PEEK_ROWS;
  if (listed <= capacity && total <= listed) return { shown: listed, more: 0 };
  const shown = Math.min(listed, capacity - 1);
  return { shown, more: Math.max(total, listed) - shown };
}

// ---------------------------------------------------------------- 存档

/** 最近玩过的在前，没有记录的排最后；同一时刻按名称。 */
export function sortWorlds(worlds: readonly WorldDto[]): WorldDto[] {
  return [...worlds].sort((a, b) => {
    const at = a.last_played === null ? -Infinity : a.last_played;
    const bt = b.last_played === null ? -Infinity : b.last_played;
    if (at !== bt) return bt - at;
    return worldName(a).localeCompare(worldName(b), "zh-CN");
  });
}

export function worldName(world: WorldDto): string {
  return world.name === null ? world.dir_name : world.name;
}

export const WORLDS_PREVIEW = 5;

// ---------------------------------------------------------------- 变更历史

export interface HistoryItem {
  event: HistoryEvent;
  /** 后端的事件时刻是 unix 秒，这里换成毫秒。 */
  atMs: number;
  title: string;
  files: string[];
  from: string | null;
  to: string | null;
  /** 被之后的回滚撤销过的更新。 */
  reverted: boolean;
  canRollback: boolean;
  blockedReason: string | null;
}

export interface HistoryTitleCopy {
  installOne(name: string): string;
  installMany(name: string, n: number): string;
  updateOf(name: string): string;
  removeOne(name: string): string;
  removeMany(name: string, n: number): string;
  rollbackOf(name: string): string;
  rollbackUnknown: string;
}

function updateName(e: Extract<HistoryEvent, { kind: "update" }>): string {
  return e.title !== null && e.title.trim() !== "" ? e.title : fileStem(e.file_name);
}

function filesTitle(files: readonly string[], one: (n: string) => string, many: (n: string, k: number) => string): string {
  if (files.length === 0) throw new Error("安装与移除事件至少带一个文件");
  return files.length === 1 ? one(fileStem(files[0])) : many(fileStem(files[0]), files.length);
}

/** 时间线条目，最新的在前。checks 与事件按 id 对齐；对不上的事件说明两次查询之间历史变了，按不可回滚处理。 */
export function historyItems(events: readonly HistoryEvent[], checks: readonly RollbackCheck[], copy: HistoryTitleCopy): HistoryItem[] {
  const reverted = new Set(events.flatMap((e) => (e.kind === "rollback" ? [e.reverted_event] : [])));
  const byId = new Map(events.map((e) => [e.id, e]));
  const items = events.map((event): HistoryItem => {
    const check = checks.find((c) => c.event_id === event.id);
    const base = {
      event,
      atMs: event.at * 1000,
      reverted: reverted.has(event.id),
      canRollback: check !== undefined && check.can_rollback,
      blockedReason: check === undefined || check.can_rollback ? null : check.reason,
    };
    switch (event.kind) {
      case "install":
        return { ...base, title: filesTitle(event.files, copy.installOne, copy.installMany), files: event.files, from: null, to: null };
      case "remove":
        return { ...base, title: filesTitle(event.files, copy.removeOne, copy.removeMany), files: event.files, from: null, to: null };
      case "update":
        return {
          ...base,
          title: copy.updateOf(updateName(event)),
          files: [event.file_name],
          from: event.from_version_number === null ? event.from_version : event.from_version_number,
          to: event.to_version_number === null ? event.to_version : event.to_version_number,
        };
      case "rollback": {
        const target = byId.get(event.reverted_event);
        const title = target !== undefined && target.kind === "update" ? copy.rollbackOf(updateName(target)) : copy.rollbackUnknown;
        return { ...base, title, files: [], from: null, to: null };
      }
    }
  });
  return items.sort((a, b) => b.atMs - a.atMs || b.event.id.localeCompare(a.event.id));
}

export const HISTORY_PAGE = 30;

// ---------------------------------------------------------------- 崩溃：日志指向的 Mod

/** 日志点名的 Mod 对到已装列表：先按文件名（含停用态），再按 mod id。 */
export function matchSuspect(suspect: { mod_id: string; file_name: string | null }, mods: readonly InstalledMod[]): InstalledMod | null {
  if (suspect.file_name !== null) {
    const wanted = enabledFileName(suspect.file_name);
    const byFile = mods.find((m) => enabledFileName(m.file_name) === wanted);
    if (byFile !== undefined) return byFile;
  }
  const byId = mods.find((m) => m.metadata !== null && m.metadata.mod_id.toLowerCase() === suspect.mod_id.toLowerCase());
  return byId === undefined ? null : byId;
}

/** detail 里的 Mod id 或文件名对到的已装 Mod（可能多个）。只认完全相等：子串匹配会把「api」对到一串无关的 Mod。 */
export function modsByDetail(detail: string, mods: readonly InstalledMod[]): InstalledMod[] {
  const key = detail.trim().toLowerCase();
  if (key === "") return [];
  return mods.filter((m) => (m.metadata !== null && m.metadata.mod_id.toLowerCase() === key) || enabledFileName(m.file_name).toLowerCase() === key);
}

// ---------------------------------------------------------------- 崩溃：一键尝试

export type CrashFix =
  | { kind: "raise_memory"; currentMb: number; targetMb: number; followsGlobal: boolean }
  | { kind: "memory_at_cap"; totalMb: number }
  | { kind: "lower_memory"; currentMb: number; targetMb: number }
  | { kind: "use_64bit_java" }
  | { kind: "switch_java"; major: number; path: string }
  | { kind: "download_java"; major: number }
  | { kind: "enable_mod"; fileName: string; name: string }
  | { kind: "search_dependency"; category: "missing_dependency" | "missing_language_provider"; detail: string }
  | { kind: "find_dependency" }
  /** Mod 要求别的游戏或加载器版本、又对不上唯一一个已装 Mod：去发现页按 detail 找适配的版本，没有 detail 时不带关键词。 */
  | { kind: "find_mod_version"; detail: string | null }
  | { kind: "disable_mod"; category: "mixin_failure" | "corrupted_jar" | "game_version_mismatch" | "optifine_incompatible"; fileName: string; name: string }
  | { kind: "keep_latest"; disable: { fileName: string; name: string }[] }
  | { kind: "repair"; category: "native_library_missing" | "corrupted_jar"; changeGameDir: boolean }
  /** category 是这份报告里第一条显卡或本地崩溃类线索的类别，三类共用这一条。 */
  | { kind: "driver_steps"; category: "graphics_driver" | "intel_graphics_driver" | "native_crash"; javaPath: string | null }
  | { kind: "compare_log" };

export interface CrashFixContext {
  /** 实例当前生效的最大内存与是否跟随全局。 */
  memoryMb: number;
  followsGlobal: boolean;
  physicalMb: number;
  mods: readonly InstalledMod[];
  runtimes: readonly JavaInstallationDto[];
  /** 游戏版本要求的主版本（detail 推不出时用）；版本读不出时为 null。 */
  requiredJava: number | null;
}

/** mods 目录里的 jar：命中行里出现的路径落在 mods/ 下时，对到那个文件。 */
function corruptedModFile(matched: string, mods: readonly InstalledMod[]): InstalledMod | null {
  if (!/[\\/]mods[\\/]/i.test(matched)) return null;
  const hit = mods.find((m) => matched.includes(enabledFileName(m.file_name)));
  return hit === undefined ? null : hit;
}

function compareModVersion(a: InstalledMod, b: InstalledMod): number {
  const va = a.metadata === null || a.metadata.version === null ? "" : a.metadata.version;
  const vb = b.metadata === null || b.metadata.version === null ? "" : b.metadata.version;
  return va.localeCompare(vb, undefined, { numeric: true }) || a.modified_ms - b.modified_ms;
}

/** 文件名或 mod id 里带 optifine 的已启用 Mod。OptiFine 的 jar 不一定带加载器读得出的元数据，所以文件名也要看。 */
function enabledOptifine(mods: readonly InstalledMod[]): InstalledMod[] {
  return mods.filter(
    (m) => m.enabled && (m.file_name.toLowerCase().includes("optifine") || (m.metadata !== null && m.metadata.mod_id.toLowerCase().includes("optifine"))),
  );
}

/**
 * 按线索推出的一键尝试，同一类别只出一条（取第一条线索），末尾固定「对照完整日志」。
 * 不同类别推出同一个动作（比如两条线索都指向停用同一个文件）时只留第一条，键不重复。
 * 一键尝试只改实例设置（可撤销）或建任务（可在任务里取消），不改全局设置、不删除文件。
 */
export function crashFixes(report: CrashReportDto, ctx: CrashFixContext): CrashFix[] {
  const fixes: CrashFix[] = [];
  const keys = new Set<string>();
  const push = (fix: CrashFix) => {
    const key = crashFixKey(fix);
    if (keys.has(key)) return;
    keys.add(key);
    fixes.push(fix);
  };
  const seen = new Set<string>();
  for (const clue of report.diagnoses) {
    if (seen.has(clue.category)) continue;
    seen.add(clue.category);
    switch (clue.category) {
      case "out_of_memory": {
        if (isHeapReserveFailure(clue.matched)) {
          if (report.java !== null && !report.java.is_64bit) push({ kind: "use_64bit_java" });
          else push({ kind: "lower_memory", currentMb: ctx.memoryMb, targetMb: memoryLowerTarget(ctx.memoryMb) });
          break;
        }
        const target = memoryTarget(ctx.memoryMb, ctx.physicalMb);
        push(
          target.kind === "raise"
            ? { kind: "raise_memory", currentMb: ctx.memoryMb, targetMb: target.targetMb, followsGlobal: ctx.followsGlobal }
            : { kind: "memory_at_cap", totalMb: ctx.physicalMb },
        );
        break;
      }
      case "java_version_mismatch": {
        const fromDetail = javaMajorFromClassVersion(clue.detail);
        const major = fromDetail === null ? ctx.requiredJava : fromDetail;
        if (major === null) break;
        const runtime = bestLocalRuntime(ctx.runtimes, major);
        push(runtime === null ? { kind: "download_java", major } : { kind: "switch_java", major, path: runtime.path });
        break;
      }
      case "missing_dependency": {
        if (clue.detail === null) {
          push({ kind: "find_dependency" });
          break;
        }
        const installed = modsByDetail(clue.detail, ctx.mods);
        const disabled = installed.find((m) => !m.enabled);
        if (disabled !== undefined) push({ kind: "enable_mod", fileName: disabled.file_name, name: modName(disabled) });
        else if (installed.length === 0) push({ kind: "search_dependency", category: "missing_dependency", detail: clue.detail });
        break;
      }
      case "missing_language_provider":
        // Forge 自带的语言支持装不上：缺它说明 Mod 不是给这个版本的 Forge 做的，没有可搜的东西
        if (clue.detail !== null && !isForgeBuiltinProvider(clue.detail)) push({ kind: "search_dependency", category: "missing_language_provider", detail: clue.detail });
        break;
      case "game_version_mismatch": {
        const hits = clue.detail === null ? [] : modsByDetail(clue.detail, ctx.mods).filter((m) => m.enabled);
        if (hits.length === 1) push({ kind: "disable_mod", category: "game_version_mismatch", fileName: hits[0].file_name, name: modName(hits[0]) });
        else push({ kind: "find_mod_version", detail: clue.detail });
        break;
      }
      case "optifine_incompatible": {
        const hits = enabledOptifine(ctx.mods);
        if (hits.length === 1) push({ kind: "disable_mod", category: "optifine_incompatible", fileName: hits[0].file_name, name: modName(hits[0]) });
        break;
      }
      case "mixin_failure": {
        // 对应到多个或对应不上时不出按钮，交给「日志指向的 Mod」逐个开关
        if (clue.detail === null) break;
        const hits = modsByDetail(clue.detail, ctx.mods).filter((m) => m.enabled);
        if (hits.length === 1) push({ kind: "disable_mod", category: "mixin_failure", fileName: hits[0].file_name, name: modName(hits[0]) });
        break;
      }
      case "duplicate_mod": {
        if (clue.detail === null) break;
        const copies = modsByDetail(clue.detail, ctx.mods).filter((m) => m.enabled);
        if (copies.length < 2) break;
        const keep = copies.reduce((a, b) => (compareModVersion(b, a) > 0 ? b : a));
        push({ kind: "keep_latest", disable: copies.filter((m) => m !== keep).map((m) => ({ fileName: m.file_name, name: modName(m) })) });
        break;
      }
      case "native_library_missing":
        push({ kind: "repair", category: "native_library_missing", changeGameDir: report.warnings.includes("game_path") });
        break;
      case "graphics_driver":
      case "intel_graphics_driver":
      case "native_crash":
        // 三类的处理办法相同，键都是 driver_steps：只留第一条出现的类别
        push({ kind: "driver_steps", category: clue.category, javaPath: report.java === null ? null : report.java.path });
        break;
      case "corrupted_jar": {
        const mod = corruptedModFile(clue.matched, ctx.mods);
        if (mod !== null && mod.enabled) push({ kind: "disable_mod", category: "corrupted_jar", fileName: mod.file_name, name: modName(mod) });
        else push({ kind: "repair", category: "corrupted_jar", changeGameDir: false });
        break;
      }
      default:
        throw new Error(`未知的崩溃诊断类别：${String(clue.category)}`);
    }
  }
  fixes.push({ kind: "compare_log" });
  return fixes;
}

/** 一键尝试条目的稳定键：完成态与撤销按它记。 */
export function crashFixKey(fix: CrashFix): string {
  switch (fix.kind) {
    case "switch_java":
    case "download_java":
      return `${fix.kind}:${fix.major}`;
    case "enable_mod":
    case "disable_mod":
      return `${fix.kind}:${fix.fileName}`;
    case "search_dependency":
      return `${fix.kind}:${fix.detail.toLowerCase()}`;
    case "find_mod_version":
      return fix.detail === null ? fix.kind : `${fix.kind}:${fix.detail.toLowerCase()}`;
    case "repair":
      return `${fix.kind}:${fix.category}`;
    default:
      return fix.kind;
  }
}
