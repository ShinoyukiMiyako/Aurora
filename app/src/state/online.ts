// 全应用唯一的联网状态。两条离线判据：浏览器报告断网（navigator.onLine 与 online / offline 事件）；或者某个联网请求
// 以连接类错误失败（DNS 失败、连接被拒、超时），随后的连通性探测也失败（网卡在线但路由不通，WebView 里常见）。
// 离线期间每 OFFLINE_PROBE_MS 探测一次，成功即恢复在线；由离线转回在线时通知订阅方一次（状态容器据此发「网络已恢复」）。
//
// 联网请求本身失败时照常报错，这里只是另外记下「可能断网了」。探测走后端命令，量的是后端实际下载用的那条网络路径。

import { useSyncExternalStore } from "react";
import { OFFLINE_PROBE_MS } from "../domain/limits";
import { isIpcError } from "../ipc/errors";
import { probeNetwork } from "../ipc/system";

/** 连通性探测：能连上后端下载用的源时 resolve true，连不上 resolve false；探测本身出错（命令缺失等）时 reject。 */
export type ConnectionProbe = () => Promise<boolean>;

/** 启动失败码里本身就表示「连不上」的两个（后端已判定是网络原因）。 */
const OFFLINE_FAILURE_CODES = new Set(["files_offline", "account_refresh_network"]);
/** 微软登录可重试的网络故障。 */
const AUTH_NETWORK_CODE = "Http";
/** 后端在原因链里认出连接类错误时，在 detail.network 里标明是哪一种。 */
const CONNECTION_KINDS = new Set(["connect", "dns", "timeout"]);

/** 这个错误是不是连接类的：只有它才值得去探测一次连通性。 */
export function isConnectionError(error: unknown): boolean {
  if (!isIpcError(error)) return false;
  if (OFFLINE_FAILURE_CODES.has(error.code) || error.code === AUTH_NETWORK_CODE) return true;
  const detail = error.detail;
  if (typeof detail !== "object" || detail === null) return false;
  const kind = (detail as Record<string, unknown>).network;
  return typeof kind === "string" && CONNECTION_KINDS.has(kind);
}

export interface NetworkHooks {
  /** 离线结束、重新在线的那一刻。 */
  onRecovered(): void;
  /** 探测命令自己出了错（不是「连不上」）。 */
  onProbeError(error: unknown): void;
}

type EventSource = Pick<EventTarget, "addEventListener" | "removeEventListener">;

/** 取浏览器状态的入口都是函数：模块加载时不碰 window，非浏览器环境里引入这个模块也不出错。 */
export interface NetworkEnv {
  navigatorOnline(): boolean;
  /** online / offline 事件的来源。 */
  target(): EventSource;
}

export class NetworkMonitor {
  /** 接上事件之后由事件维护；接上之前每次直接读浏览器。 */
  private browserOnline: boolean | null = null;
  /** 探测确认连不上；浏览器报告的断网不算在这里。 */
  private unreachable = false;
  private probing = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<() => void>();
  private hooks: NetworkHooks | null = null;
  private attachedTo: EventSource | null = null;

  constructor(
    private readonly probe: ConnectionProbe,
    private readonly env: NetworkEnv,
  ) {}

  private browser(): boolean {
    return this.browserOnline === null ? this.env.navigatorOnline() : this.browserOnline;
  }

  readonly isOnline = (): boolean => this.browser() && !this.unreachable;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.attach();
    return () => {
      this.listeners.delete(listener);
      this.detachIfIdle();
    };
  };

  /** 状态容器启动时接上：恢复通知与探测出错都交给它。同一时刻只接一个。 */
  start(hooks: NetworkHooks): void {
    if (this.hooks !== null) throw new Error("联网状态已经接到一个状态容器上了");
    this.hooks = hooks;
    this.attach();
  }

  stop(): void {
    this.hooks = null;
    this.detachIfIdle();
  }

  /** 联网请求失败时调用。连接类错误、且此刻还认为在线时立即探测一次；不是连接类的不理会。 */
  reportFailure(error: unknown): void {
    if (!isConnectionError(error) || !this.isOnline()) return;
    void this.check();
  }

  private readonly onBrowserChange = (): void => {
    const before = this.isOnline();
    const online = this.env.navigatorOnline();
    this.browserOnline = online;
    // 浏览器说回来了，但之前是探测判的离线：马上再探测一次，不等下一轮
    if (online && this.unreachable) void this.check();
    this.changed(before);
  };

  private attach(): void {
    if (this.attachedTo !== null) return;
    const target = this.env.target();
    target.addEventListener("online", this.onBrowserChange);
    target.addEventListener("offline", this.onBrowserChange);
    this.attachedTo = target;
    this.browserOnline = this.env.navigatorOnline();
    this.changed(this.isOnline());
  }

  private detachIfIdle(): void {
    if (this.listeners.size > 0 || this.hooks !== null || this.attachedTo === null) return;
    this.attachedTo.removeEventListener("online", this.onBrowserChange);
    this.attachedTo.removeEventListener("offline", this.onBrowserChange);
    this.attachedTo = null;
    this.browserOnline = null;
    this.stopPolling();
  }

  private async check(): Promise<void> {
    if (this.probing) return;
    this.probing = true;
    const before = this.isOnline();
    try {
      const reachable = await this.probe();
      this.unreachable = !reachable;
    } catch (error) {
      // 探测本身坏了不等于断网：状态不变，错误交给状态容器报告；没接状态容器时原样抛出
      if (this.hooks === null) throw error;
      this.hooks.onProbeError(error);
    } finally {
      this.probing = false;
    }
    this.changed(before);
  }

  private changed(before: boolean): void {
    const now = this.isOnline();
    if (now) this.stopPolling();
    else if (this.timer === null) this.timer = setInterval(() => this.poll(), OFFLINE_PROBE_MS);
    if (now === before) return;
    for (const listener of [...this.listeners]) listener();
    if (now && this.hooks !== null) this.hooks.onRecovered();
  }

  /** 离线期间的定时探测。浏览器自己报告断网时探测必然失败，等它的 online 事件。 */
  private poll(): void {
    if (!this.browser()) return;
    void this.check();
  }

  private stopPolling(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}

/** 应用唯一的联网状态。探测命令由后端提供（向下载源发一个极小的请求），见 ipc 的系统命令。 */
export const network = new NetworkMonitor(probeNetwork, {
  navigatorOnline: () => navigator.onLine,
  target: () => window,
});

/** 此刻是否在线：断网时页面预先置灰必然失败的联网入口（登录、下载运行时、检查更新、安装资源），并显示离线提示。 */
export function useOnline(): boolean {
  return useSyncExternalStore(network.subscribe, network.isOnline, network.isOnline);
}
