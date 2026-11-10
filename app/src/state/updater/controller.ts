// 更新状态机的执行者：把检查、下载、安装几条后端命令接到状态机上，供更新卡与更新面板共用一份状态。
// 与 React 无关（订阅接口照 useSyncExternalStore 的形状），测试可以直接实例化并注入假的后端。

import type { UpdateChannel } from "../../ipc/system";
import { describeError, networkFailureOf, sourceFailuresOf } from "../errors";
import type { UpdaterInfoDto } from "../queries/catalog";
import { INITIAL_UPDATER_STATE, updaterReducer, type DownloadRefusal, type DownloadSource, type UpdateInfo, type UpdaterEvent, type UpdaterState } from "./machine";

/** 更新相关的后端命令。语义与同名命令一致：download 的进度与换源来自带同一 taskId 的下载事件与换源事件。 */
export interface UpdaterPort {
  /** check_update：没有新版本为 null。 */
  check(): Promise<UpdateInfo | null>;
  /** download_update：下载最近一次检查到的版本并校验签名；被取消时以 cancelled 错误拒绝。每个下载源开始前调一次 onSource，第一个也调。 */
  download(taskId: string, onProgress: (bytes: number, totalBytes: number | null) => void, onSource: (source: DownloadSource) => void): Promise<UpdateInfo>;
  /** cancel_task：取消进行中的下载。 */
  cancel(taskId: string): Promise<void>;
  /** install_update：Windows 上安装程序拉起后进程退出，这个调用不会返回。 */
  install(): Promise<void>;
  /** set_install_on_exit。 */
  setInstallOnExit(enabled: boolean): Promise<void>;
  /** set_update_channel：写下更新通道偏好，返回写完之后的更新信息。 */
  setChannel(channel: UpdateChannel): Promise<UpdaterInfoDto>;
}

/**
 * 与后端错误码一致：用户取消、签名不符、检查期间改了更新通道、偏好通道给出的版本旧于本机记录、
 * 包读不了这台电脑上的数据。
 */
const CANCELLED_CODE = "cancelled";
const SIGNATURE_INVALID_CODE = "update_signature_invalid";
const SUPERSEDED_CODE = "update_superseded";
const SOURCE_STALE_CODE = "update_source_stale";
const DATA_TOO_NEW_CODE = "update_data_too_new";

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** update_source_stale 的 detail.channel：是哪个通道的更新源还没跟上。不成形是后端违约，抛出。 */
function staleChannelOf(error: unknown): UpdateChannel {
  const detail = typeof error === "object" && error !== null && "detail" in error ? (error as { detail: unknown }).detail : undefined;
  const channel = typeof detail === "object" && detail !== null ? (detail as Record<string, unknown>).channel : undefined;
  if (channel !== "dev" && channel !== "beta" && channel !== "stable") throw new Error(`后端错误 ${SOURCE_STALE_CODE} 的 detail.channel 不成形：${JSON.stringify(channel)}`);
  return channel;
}

let taskSeq = 0;
function freshTaskId(): string {
  taskSeq += 1;
  return `launcher-update-${Date.now().toString(36)}-${taskSeq}`;
}

export class UpdaterController {
  private state: UpdaterState = INITIAL_UPDATER_STATE;
  private readonly listeners = new Set<() => void>();
  /** 偏好代次：每次要改更新通道时加一。检查开始时记下，返回时变了，结果就是按旧偏好得出的。 */
  private preferenceGeneration = 0;
  /** 进行中的 download()：改更新通道要等它落定才写，否则后端报 update_busy。 */
  private inflightDownload: Promise<void> | null = null;
  /** 改更新通道的写入依次排队：连按方向键时按选的先后落盘，先发的结果不会晚到、盖掉后选的。 */
  private channelWrites: Promise<unknown> = Promise.resolve();

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
   * 检查更新。检查失败是更新卡的正式状态（卡内写明原因、留下原文并给出重试），所以这里落进状态而不再抛出；
   * 原错误照样写进控制台。检查期间改了更新通道时结果作废、回到 idle，不算失败：改通道之后另有一次检查。
   */
  async check(): Promise<void> {
    const before = this.state;
    const generation = this.preferenceGeneration;
    this.dispatch({ type: "check_start" });
    // 状态机不认这次开始时原样返回：已在检查中时也是这样，阶段虽然还是 checking，这一次不能再发请求
    if (this.state === before || this.state.phase.kind !== "checking") throw new Error(`当前阶段 ${before.phase.kind} 不能检查更新`);
    let update: UpdateInfo | null;
    try {
      update = await this.port.check();
    } catch (error) {
      // 后端在写偏好之后才收尾的检查报 update_superseded；写偏好之前就收尾的报的是旧偏好的结果，靠代次认出来
      if (generation !== this.preferenceGeneration || errorCode(error) === SUPERSEDED_CODE) {
        console.info("检查启动器更新的结果已作废：期间改了更新通道", error);
        this.dispatch({ type: "check_superseded" });
        return;
      }
      console.error("检查启动器更新失败", error);
      this.failCheck(error);
      return;
    }
    if (generation !== this.preferenceGeneration) {
      console.info("检查启动器更新的结果已作废：期间改了更新通道");
      this.dispatch({ type: "check_superseded" });
      return;
    }
    this.dispatch({ type: "check_done", update, at: this.now() });
  }

  private failCheck(error: unknown): void {
    const failed = (staleChannel: UpdateChannel | null) => this.dispatch({ type: "check_failed", message: describeError(error), network: networkFailureOf(error), staleChannel });
    if (errorCode(error) !== SOURCE_STALE_CODE) {
      failed(null);
      return;
    }
    let staleChannel: UpdateChannel;
    try {
      staleChannel = staleChannelOf(error);
    } catch (contract) {
      // 先落进检查失败（界面不停在检查中），再把违约抛给调用方（外层统一提示）
      failed(null);
      throw contract;
    }
    failed(staleChannel);
  }

  /**
   * 下载失败同样是面板的正式状态（显示原因与重试）；用户取消回到「有更新」。下好、验过签却读不了这台电脑上的数据时
   * 落进带 refusal 的下载失败，不能重试。
   */
  async download(): Promise<void> {
    const taskId = this.newTaskId();
    const before = this.state;
    this.dispatch({ type: "download_start", taskId });
    // 已在下载时再起一个会与进行中的那个抢同一个安装包，取消也只作用于状态里记着的那一个
    if (this.state === before || this.state.phase.kind !== "downloading") throw new Error(`当前阶段 ${before.phase.kind} 不能开始下载`);
    const run = this.runDownload(taskId);
    this.inflightDownload = run;
    try {
      await run;
    } finally {
      this.inflightDownload = null;
    }
  }

  private async runDownload(taskId: string): Promise<void> {
    try {
      const update = await this.port.download(
        taskId,
        (bytes, totalBytes) => this.dispatch({ type: "download_progress", taskId, bytes, totalBytes }),
        (source) => this.dispatch({ type: "download_source", taskId, ...source }),
      );
      this.dispatch({ type: "download_done", taskId, update });
    } catch (error) {
      const code = errorCode(error);
      if (code === CANCELLED_CODE) {
        console.info("启动器更新下载已取消");
        this.dispatch({ type: "download_cancelled", taskId });
        return;
      }
      const refusal: DownloadRefusal | null = code === DATA_TOO_NEW_CODE ? "data_too_new" : null;
      if (refusal === null) console.error("下载启动器更新失败", error);
      else console.warn("下好的启动器更新被拒装", error);
      const failed = (tried: number) =>
        this.dispatch({ type: "download_failed", taskId, reason: describeError(error), signature: code === SIGNATURE_INVALID_CODE, network: networkFailureOf(error), sourcesTried: tried, refusal });
      let sourcesTried: number;
      try {
        const failures = sourceFailuresOf(error);
        // 空列表只来自后端没列逐源失败（列了却为空时 sourceFailuresOf 已经抛出），这时与单源一样按 1 个算
        sourcesTried = failures.length > 0 ? failures.length : 1;
      } catch (contract) {
        // 逐源明细不成形是后端违约：先落进失败状态，界面才不会停在下载中，再把违约抛给调用方（外层统一提示）
        failed(1);
        throw contract;
      }
      failed(sourcesTried);
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

  /**
   * 改更新通道。下载中先取消、等下载命令真正返回（取消、失败或恰好下完）再写，否则后端报 update_busy；
   * 界面要在这之前先请用户确认。写成功后拿返回的更新信息同步，阶段按改偏好的规则落，并欠下一次检查（channelCheckDue）。
   * 写失败时这里不动状态（同时在进行的检查照样作废），原错误抛给调用方（外层统一提示）。
   */
  async setChannel(channel: UpdateChannel): Promise<void> {
    const { phase } = this.state;
    // 安装程序已在拉起，窗口马上就关；后端这时同样报 update_busy
    if (phase.kind === "installing") throw new Error(`当前阶段 ${phase.kind} 不能改更新通道`);
    // 先于写入加一：写入还在路上时返回的检查结果同样按旧偏好得出
    this.preferenceGeneration += 1;
    const generation = this.preferenceGeneration;
    const write = this.channelWrites.then(() => this.writeChannel(channel, generation));
    // 队尾只等它落定、不接它的错误：错误经 write 交给这次的调用方，下一次写照常排上
    this.channelWrites = Promise.allSettled([write]);
    await write;
  }

  private async writeChannel(channel: UpdateChannel, generation: number): Promise<void> {
    const { phase } = this.state;
    if (phase.kind === "downloading") {
      const inflight = this.inflightDownload;
      if (inflight === null) throw new Error("阶段是下载中，却没有进行中的下载");
      await this.port.cancel(phase.taskId);
      await Promise.allSettled([inflight]);
    }
    const info = await this.port.setChannel(channel);
    this.dispatch({ type: "preference_changed", info, generation });
  }

  /** 安装没能拉起时回到「已下载」并把原错误抛给调用方（外层统一提示）。 */
  async install(): Promise<void> {
    const before = this.state;
    this.dispatch({ type: "install_start" });
    if (this.state === before || this.state.phase.kind !== "installing") throw new Error(`当前阶段 ${before.phase.kind} 不能安装更新`);
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
