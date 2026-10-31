// 更新状态机的执行者：把检查、下载、安装几条后端命令接到状态机上，供更新卡与更新面板共用一份状态。
// 与 React 无关（订阅接口照 useSyncExternalStore 的形状），测试可以直接实例化并注入假的后端。

import { describeError } from "../errors";
import type { UpdaterInfoDto } from "../queries/catalog";
import { INITIAL_UPDATER_STATE, updaterReducer, type UpdateInfo, type UpdaterEvent, type UpdaterState } from "./machine";

/** 更新相关的后端命令。语义与同名命令一致：download 的进度来自带同一 taskId 的下载事件。 */
export interface UpdaterPort {
  /** check_update：已是最新为 null。 */
  check(): Promise<UpdateInfo | null>;
  /** download_update：下载最近一次检查到的版本并校验签名；被取消时以 cancelled 错误拒绝。 */
  download(taskId: string, onProgress: (bytes: number, totalBytes: number | null) => void): Promise<UpdateInfo>;
  /** cancel_task：取消进行中的下载。 */
  cancel(taskId: string): Promise<void>;
  /** install_update：Windows 上安装程序拉起后进程退出，这个调用不会返回。 */
  install(): Promise<void>;
  /** set_install_on_exit。 */
  setInstallOnExit(enabled: boolean): Promise<void>;
}

/** 与后端错误码一致：用户取消、签名不符。 */
const CANCELLED_CODE = "cancelled";
const SIGNATURE_INVALID_CODE = "update_signature_invalid";

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code: unknown }).code;
  return typeof code === "string" ? code : null;
}

let taskSeq = 0;
function freshTaskId(): string {
  taskSeq += 1;
  return `launcher-update-${Date.now().toString(36)}-${taskSeq}`;
}

export class UpdaterController {
  private state: UpdaterState = INITIAL_UPDATER_STATE;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly port: UpdaterPort,
    private readonly now: () => number = Date.now,
    private readonly newTaskId: () => string = freshTaskId,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): UpdaterState => this.state;

  private dispatch(event: UpdaterEvent): void {
    const next = updaterReducer(this.state, event);
    if (next === this.state) return;
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }

  /** 后端更新信息到达或刷新后同步进来。 */
  sync(info: UpdaterInfoDto): void {
    this.dispatch({ type: "info", info });
  }

  /**
   * 检查更新。检查失败是更新卡的正式状态（卡内原样显示原因并给出重试），所以这里落进状态而不再抛出；
   * 原错误照样写进控制台。
   */
  async check(): Promise<void> {
    const before = this.state;
    this.dispatch({ type: "check_start" });
    if (this.state.phase.kind !== "checking") throw new Error(`当前阶段 ${before.phase.kind} 不能检查更新`);
    try {
      const update = await this.port.check();
      this.dispatch({ type: "check_done", update, at: this.now() });
    } catch (error) {
      console.error("检查启动器更新失败", error);
      this.dispatch({ type: "check_failed", message: describeError(error) });
    }
  }

  /** 下载失败同样是面板的正式状态（显示原因与重试）；用户取消回到「有更新」。 */
  async download(): Promise<void> {
    const taskId = this.newTaskId();
    const before = this.state.phase.kind;
    this.dispatch({ type: "download_start", taskId });
    if (this.state.phase.kind !== "downloading") throw new Error(`当前阶段 ${before} 不能开始下载`);
    try {
      const update = await this.port.download(taskId, (bytes, totalBytes) => this.dispatch({ type: "download_progress", taskId, bytes, totalBytes }));
      this.dispatch({ type: "download_done", taskId, update });
    } catch (error) {
      const code = errorCode(error);
      if (code === CANCELLED_CODE) {
        console.info("启动器更新下载已取消");
        this.dispatch({ type: "download_cancelled", taskId });
        return;
      }
      console.error("下载启动器更新失败", error);
      this.dispatch({ type: "download_failed", taskId, reason: describeError(error), signature: code === SIGNATURE_INVALID_CODE });
    }
  }

  async cancelDownload(): Promise<void> {
    const { phase } = this.state;
    if (phase.kind !== "downloading") throw new Error(`当前阶段 ${phase.kind} 没有进行中的下载`);
    await this.port.cancel(phase.taskId);
  }

  async setInstallOnExit(enabled: boolean): Promise<void> {
    await this.port.setInstallOnExit(enabled);
    this.dispatch({ type: "install_on_exit", enabled });
  }

  /** 安装没能拉起时回到「已下载」并把原错误抛给调用方（外层统一提示）。 */
  async install(): Promise<void> {
    const before = this.state.phase.kind;
    this.dispatch({ type: "install_start" });
    if (this.state.phase.kind !== "installing") throw new Error(`当前阶段 ${before} 不能安装更新`);
    try {
      await this.port.install();
    } catch (error) {
      this.dispatch({ type: "install_failed" });
      throw error;
    }
    this.dispatch({ type: "install_done" });
  }

  markSeen(version: string): void {
    this.dispatch({ type: "panel_seen", version });
  }
}
