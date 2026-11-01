// 假 bridge：开发时在浏览器里看全部状态（pnpm dev:setup，?state=failed&code=disk_full&lang=en 直达），测试里断言调用。
// 不需要 Rust、不需要安装包。这个文件只经动态 import 进开发构建，生产产物里没有它。

import { APP_NAME_EN } from "../lib/app-info";
import type { SetupBridge, Unlisten } from "./bridge";
import type { DirCheck, Existing, ExistingKind, Failure, FailureCode, InstallMode, InstallPlan, Probe, Progress } from "./contract";
import { initialState, replay, type SetupEvent, type SetupState } from "./model";

const DEFAULT_DIR = `C:\\Users\\Player\\AppData\\Local\\${APP_NAME_EN}`;

export const FAKE_PROBE: Probe = {
  payloadVersion: "0.2.0",
  defaultDir: DEFAULT_DIR,
  requiredBytes: 42 * 1024 * 1024,
  existing: null,
  interrupted: false,
  elevated: false,
};

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
  return { normalized: path, issue: path === "" ? "empty" : null, hasConfig: false, notEmpty: false, freeBytes: 120 * 1024 * 1024 * 1024 };
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

const EXISTING_KINDS: readonly ExistingKind[] = ["upgrade", "same", "newer", "broken"];
const FAILURE_DETAIL: Readonly<Record<FailureCode, string>> = {
  dir_unwritable: "os error 5",
  disk_full: "os error 112",
  extract_failed: "os error 225",
  payload_exit: "2",
  verify_failed: "uninstall.exe missing",
};

function pick<T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T {
  if (raw === null) return fallback;
  const match = allowed.find((value) => value === raw);
  if (match === undefined) throw new Error(`查询参数 ${raw} 不是 ${allowed.join("、")} 之一`);
  return match;
}

function existingOf(kind: ExistingKind): Existing {
  return { kind, version: kind === "newer" ? "0.3.0" : kind === "same" ? "0.2.0" : "0.1.0", dir: `E:\\${APP_NAME_EN}` };
}

function requestOf(mode: InstallMode, running: boolean): SetupEvent {
  return mode === "fresh" ? { type: "install_requested", mode, running, check: okCheck(DEFAULT_DIR) } : { type: "install_requested", mode, running };
}

const STATES = ["welcome", "location", "installed", "blocked", "installing", "slow", "done", "failed", "legal", "fatal"] as const;
const MODES: readonly InstallMode[] = ["fresh", "upgrade", "repair"];
const FAILURE_CODES = Object.keys(FAILURE_DETAIL) as FailureCode[];

/** ?state= 视图；?kind= 现有安装（installed）；?mode= 安装种类；?code= 失败原因；?elevated=1；?interrupted=1；?lang=。 */
export function fakeFromQuery(search: string): FakeRuntime {
  const query = new URLSearchParams(search);
  const state = pick(query.get("state"), STATES, "welcome");
  const mode = pick(query.get("mode"), MODES, "fresh");
  const failure: Failure = { code: pick(query.get("code"), FAILURE_CODES, "payload_exit"), detail: "" };
  failure.detail = FAILURE_DETAIL[failure.code];

  const kind = state === "installed" ? pick(query.get("kind"), EXISTING_KINDS, "upgrade") : mode === "upgrade" ? "upgrade" : mode === "repair" ? "same" : null;
  const probe: Probe = { ...FAKE_PROBE, existing: kind === null ? null : existingOf(kind), elevated: query.has("elevated"), interrupted: query.has("interrupted") };

  const probed: SetupEvent = { type: "probed", probe };
  const install = requestOf(mode, false);
  const events: Readonly<Record<(typeof STATES)[number], readonly SetupEvent[]>> = {
    welcome: [],
    installed: [],
    location: [probed, { type: "open_location" }],
    blocked: [probed, requestOf(mode, true)],
    installing: [probed, install],
    slow: [probed, install],
    done: [probed, install, { type: "install_succeeded" }],
    failed: [probed, install, { type: "install_failed", failure }],
    legal: [probed, { type: "open_legal" }],
    fatal: [{ type: "crashed", detail: "Error: 模拟的启动失败" }],
  };

  const slowProgress: readonly Progress[] = [...FAKE_PROGRESS.slice(0, 2), { phase: "write", percent: 70, slow: true }];
  const bridge = createFakeBridge({ probe, running: state === "blocked", outcome: "hang", progress: state === "slow" ? slowProgress : FAKE_PROGRESS, stepMs: 900 });
  return { bridge, initial: replay(events[state], initialState), lang: query.get("lang") };
}
