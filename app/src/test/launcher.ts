// 状态容器测试的替身与样本：可计数、可逐条改写结果的 IPC 桥，以及 DTO 样本。只被 *.test.ts(x) 引用。
//
// 替身桥本身在 fake-bridge.ts（vi.mock 的工厂只能引入不依赖被替换模块的文件）。

import { vi } from "vitest";
import type { AccountDto } from "../ipc/accounts";
import type { ConfigDto } from "../ipc/config";
import { CANCELLED_ERROR_CODE, IpcError } from "../ipc/errors";
import type { InstanceDto } from "../ipc/instances";
import { clearMockEventListeners, emitMockEvent } from "../ipc/mock/events";
import type { TaskRecordDto } from "../ipc/tasks";
import { resources } from "../state/resource";
import { LauncherStore } from "../state/store";
import type { IpcArgs, IpcRecorder } from "./fake-bridge";

export type { IpcArgs, IpcRecorder } from "./fake-bridge";

/** 每个用例之前：清掉记录、改写、事件订阅与资源缓存。 */
export function resetRecorder(ipc: IpcRecorder): void {
  ipc.calls.length = 0;
  ipc.overrides.clear();
  clearMockEventListeners();
  resources.clear();
}

export function callsOf(ipc: IpcRecorder, cmd: string): IpcArgs[] {
  return ipc.calls.filter((c) => c.cmd === cmd).map((c) => c.args);
}

export function emit(event: string, payload: unknown): void {
  emitMockEvent(event, payload);
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export const cancelledError = (): IpcError => new IpcError(CANCELLED_ERROR_CODE, "已取消");

export function accountDto(overrides: Partial<AccountDto> = {}): AccountDto {
  return {
    uuid: "00000000-0000-0000-0000-00000000a001",
    name: "Steve",
    account_type: "offline",
    auth_server: null,
    server_url: null,
    username: null,
    added_at: 1_700_000_000_000,
    status: "ok",
    last_verified_at: null,
    ...overrides,
  };
}

export function instanceDto(id: string, overrides: Partial<InstanceDto> = {}): InstanceDto {
  return {
    id,
    status: "ready",
    broken_reason: null,
    mc_version: "1.21.1",
    loaders: [],
    release_type: "release",
    is_release: true,
    java_major: 21,
    quick_play: { singleplayer: true, multiplayer: true },
    mod_count: 0,
    world_count: 0,
    isolated: false,
    memory_mb: null,
    description: null,
    cover: null,
    modpack: null,
    modpack_error: null,
    last_crash_at: null,
    last_crash_error: null,
    settings_error: null,
    incomplete: null,
    created_at: 1_700_000_000_000,
    activity: null,
    used_by: null,
    playtime_min: 0,
    last_played_at: null,
    play_error: null,
    dir_error: null,
    ...overrides,
  };
}

export function configDto(overrides: Partial<ConfigDto> = {}): ConfigDto {
  return {
    game_dir: "D:/Games/.minecraft",
    default_game_dir: "D:/Games/.minecraft",
    data_dir: "D:/Games/data",
    download_source: "auto",
    version_list_source: "auto",
    download_concurrency: 64,
    memory: { max_mb: 4096, min_mb: null, auto: true },
    isolation_policy: "mod_loaders_and_non_release",
    has_client_id: true,
    auto_download_java: true,
    default_java: "auto",
    after_launch: "keep",
    check_updates: true,
    cache_directory: null,
    selected_version: null,
    skipped_update_version: null,
    notified_update_version: null,
    language: "zh-CN",
    extra_java_paths: [],
    prefer_dedicated_gpu: false,
    skip_accessibility_onboarding: true,
    world_backup: { auto: true, keep_per_world: 5, max_total_gb: 20 },
    ...overrides,
  };
}

export interface BootData {
  accounts?: AccountDto[];
  /** 缺省为 accounts 的第一个；显式 null 表示没有当前账户。 */
  current?: AccountDto | null;
  instances?: InstanceDto[];
  pins?: string[];
  journal?: TaskRecordDto[];
  /** 任务日志已落盘的序号，缺省为 0。 */
  journalSeq?: number;
  firstRun?: boolean;
  config?: ConfigDto;
}

/** 首查的六个切片与常用写命令改写成确定的样本。 */
export function bootOverrides(ipc: IpcRecorder, data: BootData = {}): void {
  const accounts = data.accounts === undefined ? [accountDto()] : data.accounts;
  const current = data.current === undefined ? (accounts.length === 0 ? null : accounts[0]) : data.current;
  ipc.overrides.set("get_config", () => (data.config === undefined ? configDto() : data.config));
  ipc.overrides.set("list_accounts", () => accounts);
  ipc.overrides.set("current_account", () => current);
  ipc.overrides.set("list_instances", () => (data.instances === undefined ? [instanceDto("生存"), instanceDto("创造")] : data.instances));
  ipc.overrides.set("get_sidebar_pins", () => (data.pins === undefined ? [] : data.pins));
  ipc.overrides.set("load_task_journal", () => ({
    seq: data.journalSeq === undefined ? 0 : data.journalSeq,
    tasks: data.journal === undefined ? [] : data.journal,
  }));
  ipc.overrides.set("is_first_run", () => (data.firstRun === undefined ? false : data.firstRun));
  ipc.overrides.set("save_task_journal", () => null);
  ipc.overrides.set("update_config", () => null);
}

/** 假定时器下把排队的微任务与零延时定时器都跑完。 */
export async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await vi.advanceTimersByTimeAsync(0);
}

/** 建一个状态容器并跑完首查。要求已启用假定时器。 */
export async function startedStore(): Promise<LauncherStore> {
  const store = new LauncherStore();
  store.start();
  await settle();
  return store;
}
