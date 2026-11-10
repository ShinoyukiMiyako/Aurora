// 假 bridge：开发时在浏览器里看全部状态（pnpm dev:setup，?state=failed&code=disk_full&lang=en 直达），测试里断言调用。
// 不需要 Rust、不需要安装包。这个文件只经动态 import 进开发构建，生产产物里没有它。

import { APP_NAME_EN } from "../lib/app-info";
import type { SetupBridge, Unlisten } from "./bridge";
import type { Channel, DataBlock, DirCheck, Existing, ExistingKind, Failure, FailureCode, InstallMode, InstallPlan, NewerReason, Probe, Progress, UpdateLaunch } from "./contract";
import { initialState, replay, type SetupEvent, type SetupState, type View } from "./model";

const DEFAULT_DIR = `C:\\Users\\Player\\AppData\\Local\\${APP_NAME_EN}`;

export const FAKE_PROBE: Probe = {
  payloadVersion: "0.2.0",
  payloadChannel: "stable",
  defaultDir: DEFAULT_DIR,
  requiredBytes: 42 * 1024 * 1024,
  existing: null,
  interrupted: false,
  elevated: false,
  update: null,
  newerReason: null,
  allowedModes: ["fresh"],
  unattended: null,
  handoff: false,
  dataBlock: null,
};

/** 探测结果里由后端判定表算出的几项。 */
type Judged = "newerReason" | "allowedModes" | "unattended" | "handoff";

/** 通道快慢，数越大越快：预览版发得最勤，正式版最慢。 */
const CHANNEL_SPEED: Readonly<Record<Channel, number>> = { stable: 0, beta: 1, dev: 2 };

/** 安装包的通道相对已装的通道。 */
type Relation = "same" | "payload_faster" | "payload_slower" | "unknown";

function relationOf(installed: Channel | null, payload: Channel | null): Relation {
  if (installed === null || payload === null) return "unknown";
  const diff = CHANNEL_SPEED[payload] - CHANNEL_SPEED[installed];
  return diff === 0 ? "same" : diff > 0 ? "payload_faster" : "payload_slower";
}

const NEWER_REASON: Readonly<Record<Relation, NewerReason>> = { same: "same_channel", payload_faster: "faster_channel", payload_slower: "slower_channel", unknown: "unknown_channel" };

/**
 * 照后端的判定表补上 newerReason、allowedModes、unattended、handoff，造出来的探测结果与真后端同一情形下给的一致，
 * 测试和开发替身造探测结果都走这里，种类与允许的模式不会再对不上。种类由调用方定，这里不比版本；
 * 换通道开关从种类看得出：更新模式下是 switch 就是带了开关，是安装包更慢的 newer 就是没带。后端给不出的组合直接报错。
 */
export function judgedProbe(facts: Omit<Probe, Judged>): Probe {
  const { existing, update, dataBlock } = facts;
  if (existing === null) {
    if (dataBlock !== null) throw new Error("首装的数据关在选目录时核，探测结果不带数据拦截");
    return { ...facts, newerReason: null, allowedModes: ["fresh"], unattended: null, handoff: false };
  }
  const relation = relationOf(existing.channel, facts.payloadChannel);
  const interactive = update === null;
  if (existing.kind === "switch" && relation !== "payload_slower") throw new Error(`switch 只出自安装包通道严格更慢的情形，这里两边是 ${existing.channel} 与 ${facts.payloadChannel}`);
  if (existing.kind === "newer" && relation === "payload_slower" && interactive) throw new Error("交互启动遇到更慢通道上更早的包判 switch，不是 newer");
  const newerReason = existing.kind === "newer" ? NEWER_REASON[relation] : null;
  if (dataBlock !== null) return { ...facts, newerReason, allowedModes: [], unattended: null, handoff: false };
  switch (existing.kind) {
    case "upgrade":
      return { ...facts, newerReason, allowedModes: ["upgrade"], unattended: interactive ? null : "upgrade", handoff: interactive && relation === "payload_faster" };
    case "same":
    case "broken":
      return { ...facts, newerReason, allowedModes: ["repair"], unattended: null, handoff: false };
    case "switch":
      return { ...facts, newerReason, allowedModes: ["switch"], unattended: interactive ? null : "switch", handoff: interactive };
    case "newer":
      return { ...facts, newerReason, allowedModes: [], unattended: null, handoff: false };
  }
}

/** 一次走完三个阶段的进度。 */
export const FAKE_PROGRESS: readonly Progress[] = [
  { phase: "unpack", percent: 8, slow: false },
  { phase: "write", percent: 35, slow: false },
  { phase: "write", percent: 70, slow: false },
  { phase: "verify", percent: 96, slow: false },
];

export interface FakeScenario {
  probe: Probe;
  /** 落樱是否开着。可以中途改，blocked 的轮询读到的就是最新值。 */
  running: boolean;
  /** install 的结果；hang 表示一直不返回。 */
  outcome: "ok" | "hang" | Failure;
  /** install 期间依次发的进度。 */
  progress: readonly Progress[];
  /** 进度之间的间隔。 */
  stepMs: number;
  /** pickFolder 选回的目录，null 表示用户取消。 */
  picked: string | null;
  checkDir(path: string): DirCheck;
}

export type FakeCall = { name: string; args: readonly unknown[] };

export interface FakeBridge extends SetupBridge {
  readonly scenario: FakeScenario;
  /** 收到过的调用，按时间顺序。 */
  readonly calls: FakeCall[];
  callsOf(name: string): readonly (readonly unknown[])[];
  /** 模拟系统发来的关闭请求（Alt+F4、任务栏）：返回是否放行。 */
  requestClose(): boolean;
}

function okCheck(path: string): DirCheck {
  return { normalized: path, issue: path === "" ? "empty" : null, hasConfig: false, notEmpty: false, appended: false, freeBytes: 120 * 1024 * 1024 * 1024, dataBlock: null };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createFakeBridge(overrides: Partial<FakeScenario> = {}): FakeBridge {
  const scenario: FakeScenario = { probe: FAKE_PROBE, running: false, outcome: "ok", progress: FAKE_PROGRESS, stepMs: 0, picked: "D:\\Games", checkDir: okCheck, ...overrides };
  const calls: FakeCall[] = [];
  const progressHandlers = new Set<(progress: Progress) => void>();
  let allowClose: (() => boolean) | null = null;

  const record = (name: string, ...args: readonly unknown[]) => calls.push({ name, args });
  const requestClose = () => allowClose === null || allowClose();

  return {
    scenario,
    calls,
    callsOf: (name) => calls.filter((call) => call.name === name).map((call) => call.args),
    requestClose,
    probe: async () => {
      record("probe");
      return scenario.probe;
    },
    checkDir: async (path) => {
      record("checkDir", path);
      return scenario.checkDir(path);
    },
    launcherRunning: async () => {
      record("launcherRunning");
      return scenario.running;
    },
    install: async (plan: InstallPlan) => {
      record("install", plan);
      for (const progress of scenario.progress) {
        await sleep(scenario.stepMs);
        for (const handler of progressHandlers) handler(progress);
      }
      if (scenario.outcome === "hang") await new Promise<never>(() => undefined);
      if (scenario.outcome !== "ok") throw scenario.outcome;
    },
    openLauncher: async (dir) => {
      record("openLauncher", dir);
    },
    openLog: async () => {
      record("openLog");
    },
    runStandardInstaller: async () => {
      record("runStandardInstaller");
    },
    windowReady: async () => {
      record("windowReady");
    },
    onProgress: async (handler): Promise<Unlisten> => {
      progressHandlers.add(handler);
      return () => progressHandlers.delete(handler);
    },
    pickFolder: async (title, defaultPath) => {
      record("pickFolder", title, defaultPath);
      return scenario.picked;
    },
    openExternal: async (url) => {
      record("openExternal", url);
    },
    loadLicenseText: async () => {
      record("loadLicenseText");
      return "GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3, 19 November 2007\n";
    },
    loadAdditionalTerms: async () => {
      record("loadAdditionalTerms");
      return "# 附加条款\n\n- AGPL 第 7 条\n";
    },
    loadAssetLicense: async () => {
      record("loadAssetLicense");
      return "# 美术与品牌素材许可\n\nCC BY-NC-ND 4.0\n";
    },
    loadThirdParty: async () => {
      record("loadThirdParty");
      return { packages: [{ ecosystem: "npm", name: "react", version: "19.1.0", license: "MIT" }] };
    },
    minimize: async () => {
      record("minimize");
    },
    close: async () => {
      record("close", requestClose());
    },
    onCloseRequested: async (allow): Promise<Unlisten> => {
      allowClose = allow;
      return () => {
        allowClose = null;
      };
    },
  };
}

// ---------------------------------------------------------------- 按查询串选状态

export interface FakeRuntime {
  bridge: FakeBridge;
  /** 启动时的状态：?state= 指到后面的视图时已经走到那里。 */
  initial: SetupState;
  /** ?lang= 的值，没写为 null，由调用方用系统语言。 */
  lang: string | null;
}

const EXISTING_KINDS: readonly ExistingKind[] = ["upgrade", "same", "newer", "broken", "switch"];
const FAILURE_DETAIL: Readonly<Record<FailureCode, string>> = {
  dir_unwritable: "os error 5",
  disk_full: "os error 112",
  extract_failed: "os error 225",
  payload_exit: "2",
  verify_failed: "uninstall.exe missing",
};

function oneOf<T extends string>(raw: string, allowed: readonly T[]): T {
  const match = allowed.find((value) => value === raw);
  if (match === undefined) throw new Error(`查询参数 ${raw} 不是 ${allowed.join("、")} 之一`);
  return match;
}

function pick<T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T {
  return raw === null ? fallback : oneOf(raw, allowed);
}

function pickOptional<T extends string>(raw: string | null, allowed: readonly T[]): T | null {
  return raw === null ? null : oneOf(raw, allowed);
}

const EXISTING_DIR = `E:\\${APP_NAME_EN}`;

/** 两边的版本与通道。 */
interface Sides {
  installed: string;
  installedChannel: Channel | null;
  payload: string;
  payloadChannel: Channel | null;
}

/** 安装包默认是正式版 0.2.0，同通道的现有安装按种类取更旧、相同、更新的版本。 */
const PAYLOAD = { payload: "0.2.0", payloadChannel: "stable" } as const;

type Situation = "upgrade" | "cross_faster" | "cross_slower" | "same" | "broken" | "switch" | "newer_same" | "newer_faster" | "newer_slower" | "newer_unknown";

const SIDES: Readonly<Record<Situation, Sides>> = {
  upgrade: { installed: "0.1.0", installedChannel: "stable", ...PAYLOAD },
  // 已装测试版，双击预览版：换到更快的通道
  cross_faster: { installed: "1.0.0-beta.3", installedChannel: "beta", payload: "1.0.0-dev.60", payloadChannel: "dev" },
  // 已装测试版，双击同号正式版：普通升级
  cross_slower: { installed: "1.0.0-beta.4", installedChannel: "beta", payload: "1.0.0", payloadChannel: "stable" },
  same: { installed: "0.2.0", installedChannel: "stable", ...PAYLOAD },
  broken: { installed: "0.1.0", installedChannel: "stable", ...PAYLOAD },
  // 已装预览版，安装包是更慢通道上更早的测试版：交互或带开关时是 switch，不带开关的更新模式是 newer
  switch: { installed: "1.1.0-dev.61", installedChannel: "dev", payload: "1.0.0-beta.5", payloadChannel: "beta" },
  newer_same: { installed: "0.3.0", installedChannel: "stable", ...PAYLOAD },
  newer_faster: { installed: "1.0.0", installedChannel: "stable", payload: "1.0.0-beta.4", payloadChannel: "beta" },
  newer_slower: { installed: "1.1.0-dev.61", installedChannel: "dev", payload: "1.0.0-beta.5", payloadChannel: "beta" },
  // rc 不是落樱的通道，认不出
  newer_unknown: { installed: "0.3.0-rc.1", installedChannel: null, ...PAYLOAD },
};

const CROSS = ["faster", "slower"] as const;
const REASONS = ["same", "faster", "slower", "unknown"] as const;

function situationOf(kind: ExistingKind, cross: (typeof CROSS)[number] | null, reason: (typeof REASONS)[number] | null): Situation {
  if (cross !== null && kind !== "upgrade") throw new Error(`?cross= 只配升级，这里的现有安装是 ${kind}`);
  if (reason !== null && kind !== "newer") throw new Error(`?reason= 只配 newer，这里的现有安装是 ${kind}`);
  if (kind === "upgrade") return cross === null ? "upgrade" : `cross_${cross}`;
  if (kind === "newer") return reason === null ? "newer_same" : `newer_${reason}`;
  return kind;
}

/** ?data= 的三种：被更新的预览版写过、被版本号显示不了的更新版本写过、记号读不懂。号与真包一致，界面不显示。 */
const DATA = ["newer", "newer_unnamed", "unreadable"] as const;

function dataBlockOf(data: (typeof DATA)[number], root: string): DataBlock {
  const path = `${root}\\data-format.json`;
  switch (data) {
    case "newer":
      return { problem: "too_new", path, recorded: 2, supported: 1, reason: null, writtenBy: "1.1.0-dev.61", writtenByChannel: "dev" };
    case "newer_unnamed":
      return { problem: "too_new", path, recorded: 2, supported: 1, reason: null, writtenBy: null, writtenByChannel: null };
    case "unreadable":
      return { problem: "unreadable", path, recorded: null, supported: 1, reason: "缺 data_format", writtenBy: null, writtenByChannel: null };
  }
}

/** 首装时数据关在选目录这一步：目录本身没问题时报 data_incompatible，并带上同形的拦截详情。 */
function blockedCheck(data: (typeof DATA)[number]): (path: string) => DirCheck {
  return (path) => {
    const check = okCheck(path);
    return check.issue === null ? { ...check, issue: "data_incompatible", dataBlock: dataBlockOf(data, check.normalized) } : check;
  };
}

function requestOf(mode: InstallMode, running: boolean, check: DirCheck): SetupEvent {
  return mode === "fresh" ? { type: "install_requested", mode, running, check } : { type: "install_requested", mode, running };
}

const STATES = ["welcome", "location", "installed", "blocked", "installing", "slow", "done", "failed", "legal", "fatal"] as const;
const MODES: readonly InstallMode[] = ["fresh", "upgrade", "repair", "switch"];
const FAILURE_CODES = Object.keys(FAILURE_DETAIL) as FailureCode[];

/**
 * ?state= 视图；?kind= 现有安装（installed）；?mode= 安装种类；?code= 失败原因；?elevated=1；?interrupted=1；?lang=。
 * 现有安装的情形：?kind=switch 是已装更新、安装包在更慢通道上；?cross=faster|slower 配升级，是安装包在更快通道上
 * （换到更快的通道）或更慢通道上（普通升级）；?reason=same|faster|slower|unknown 配 newer 选不能装的原因，slower 只在
 * 不带开关的更新模式出现。?data=newer|newer_unnamed|unreadable 是数据关拦下（被认得出版本的更新落樱写过、版本号显示
 * 不了、记号读不懂）：有现有安装时拦在探测结果上，首装时拦在选目录上。?mode= 走到安装中、完成、失败页时种类随它定，
 * 升级可以再配 ?cross=。
 * ?update 模拟更新插件拉起（?norelaunch 是没带 /R，?switch 是带了换通道开关）：现有安装默认 upgrade，带开关时默认
 * switch，?kind= 可换成别的看退回交互流程。更新模式是 App 从 boot 自己走的，?state= 不写，或者写 blocked（落樱一直
 * 不退出）、failed（按 ?code= 装失败），这两种要后端判定能无人值守装。
 * 参数凑不成后端给得出、或走不到 ?state= 的组合时直接报错，不悄悄落到别的页。
 */
export function fakeFromQuery(search: string): FakeRuntime {
  const query = new URLSearchParams(search);
  const state = pick(query.get("state"), STATES, "welcome");
  const mode = pick(query.get("mode"), MODES, "fresh");
  const failure: Failure = { code: pick(query.get("code"), FAILURE_CODES, "payload_exit"), detail: "" };
  failure.detail = FAILURE_DETAIL[failure.code];
  const update: UpdateLaunch | null = query.has("update") ? { relaunch: !query.has("norelaunch") } : null;
  const channelSwitch = query.has("switch");
  if (channelSwitch && update === null) throw new Error("?switch 是换通道开关，只跟着 ?update 用");
  const cross = pickOptional(query.get("cross"), CROSS);
  const reason = pickOptional(query.get("reason"), REASONS);
  const data = pickOptional(query.get("data"), DATA);

  const kind: ExistingKind | null =
    state === "installed" || update !== null ? pick(query.get("kind"), EXISTING_KINDS, channelSwitch ? "switch" : "upgrade") : mode === "fresh" ? null : mode === "repair" ? "same" : mode;
  if (kind === null && (cross !== null || reason !== null)) throw new Error("?cross=、?reason= 要有现有安装");
  const situation = kind === null ? null : situationOf(kind, cross, reason);
  if (update !== null && kind === "switch" && !channelSwitch) throw new Error("不带开关的更新模式遇到更慢通道上更早的包判 newer，用 ?kind=newer&reason=slower");
  if (channelSwitch && situation === "newer_slower") throw new Error("带开关的更新模式遇到更慢通道上更早的包判 switch，用 ?kind=switch");

  const sides = situation === null ? null : SIDES[situation];
  const existing: Existing | null = kind === null || sides === null ? null : { kind, version: sides.installed, dir: EXISTING_DIR, channel: sides.installedChannel };
  const payload = sides === null ? PAYLOAD : sides;
  const probe = judgedProbe({
    ...FAKE_PROBE,
    payloadVersion: payload.payload,
    payloadChannel: payload.payloadChannel,
    existing,
    elevated: query.has("elevated"),
    interrupted: query.has("interrupted"),
    update,
    dataBlock: existing === null || data === null ? null : dataBlockOf(data, existing.dir),
  });
  const checkDir = existing === null && data !== null ? blockedCheck(data) : okCheck;

  if (update !== null) {
    if (state !== "welcome" && state !== "blocked" && state !== "failed") throw new Error(`?update 从 boot 开始走，?state= 只能不写或是 blocked、failed，不能是 ${state}`);
    if (state !== "welcome" && probe.unattended === null) throw new Error(`?update&state=${state} 要后端判定能无人值守装，这组参数下它退回交互流程`);
    // 没有人点按钮，安装得真的结束，才看得到完成页和自动打开
    const bridge = createFakeBridge({ probe, checkDir, running: state === "blocked", outcome: state === "failed" ? failure : "ok", progress: FAKE_PROGRESS, stepMs: 900 });
    return { bridge, initial: initialState, lang: query.get("lang") };
  }

  const probed: SetupEvent = { type: "probed", probe };
  const install = requestOf(mode, false, checkDir(DEFAULT_DIR));
  const events: Readonly<Record<(typeof STATES)[number], readonly SetupEvent[]>> = {
    welcome: [],
    installed: [],
    location: [probed, { type: "open_location" }],
    blocked: [probed, requestOf(mode, true, checkDir(DEFAULT_DIR))],
    installing: [probed, install],
    slow: [probed, install],
    done: [probed, install, { type: "install_succeeded" }],
    failed: [probed, install, { type: "install_failed", failure }],
    legal: [probed, { type: "open_legal" }],
    fatal: [{ type: "crashed", detail: "Error: 模拟的启动失败" }],
  };
  const initial = replay(events[state], initialState);
  // 欢迎页与已安装页由 App 从 boot 自己探测进去
  const expected: View = state === "welcome" || state === "installed" ? "boot" : state === "slow" ? "installing" : state;
  if (initial.view !== expected) throw new Error(`这组参数走不到 ?state=${state}，停在了 ${initial.view}`);

  const slowProgress: readonly Progress[] = [...FAKE_PROGRESS.slice(0, 2), { phase: "write", percent: 70, slow: true }];
  const bridge = createFakeBridge({ probe, checkDir, running: state === "blocked", outcome: "hang", progress: state === "slow" ? slowProgress : FAKE_PROGRESS, stepMs: 900 });
  return { bridge, initial, lang: query.get("lang") };
}
