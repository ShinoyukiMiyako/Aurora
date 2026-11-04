// 下载原版材质：本机没有原版游戏时由玩家手动触发，不在启动时静默下载。整个应用同一时刻只有一次下载，
// 选择框与设置页的部件看的是同一份进度，关掉选择框再打开进度还在。下完后后端重选材质源并推送材质变化，
// 方块目录由材质绑定重新载入，这里不碰目录。失败原样抛给调用方，由最外层统一报错。

import { useSyncExternalStore } from "react";
import { artDownload, onArtDownload, type ArtDownloadProgressDto } from "../ipc/art";

export type ArtDownloadStage = ArtDownloadProgressDto["stage"];

export interface ArtDownloadProgress {
  readonly stage: ArtDownloadStage;
  /** 本阶段已下载的字节；查清单与抽取阶段为 0。 */
  readonly downloaded: number;
  /** 本阶段的总字节；不知道时为 null。 */
  readonly total: number | null;
}

/** 下载中时 progress 为最近一次进度，第一条进度到来之前为 null。 */
export type ArtDownloadState = { readonly running: false } | { readonly running: true; readonly progress: ArtDownloadProgress | null };

const IDLE: ArtDownloadState = { running: false };
const STAGES: ReadonlySet<string> = new Set<ArtDownloadStage>(["manifest", "client", "names", "extract"]);

let state: ArtDownloadState = IDLE;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function setState(next: ArtDownloadState): void {
  state = next;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getArtDownloadState(): ArtDownloadState {
  return state;
}

const isByteCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function progressFromDto(dto: ArtDownloadProgressDto): ArtDownloadProgress {
  if (typeof dto !== "object" || dto === null || !STAGES.has(dto.stage) || !isByteCount(dto.downloaded) || !(dto.total === null || isByteCount(dto.total))) {
    throw new Error(`art-download 进度形状不对：${JSON.stringify(dto)}`);
  }
  return { stage: dto.stage, downloaded: dto.downloaded, total: dto.total };
}

async function runDownload(): Promise<void> {
  setState({ running: true, progress: null });
  try {
    // 先订阅再调用：后端一开始就推进度，晚订阅会漏掉前几条
    const unlisten = await onArtDownload((dto) => {
      if (state.running) setState({ running: true, progress: progressFromDto(dto) });
    });
    try {
      const status = await artDownload();
      if (status.source === null) throw new Error("原版材质下载完成，后端却仍报告没有材质源");
    } finally {
      unlisten();
    }
  } finally {
    setState(IDLE);
  }
}

/** 开始下载并等它结束；已经在下时返回同一个 Promise，不会再调一次后端。 */
export function downloadArt(): Promise<void> {
  if (inflight === null) {
    inflight = runDownload().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

export interface ArtDownloadApi {
  state: ArtDownloadState;
  /** 交给 useRunner 调用：失败时 reject，状态回到未下载，可以再调一次重试。 */
  download: () => Promise<void>;
}

export function useArtDownload(): ArtDownloadApi {
  return { state: useSyncExternalStore(subscribe, getArtDownloadState, getArtDownloadState), download: downloadArt };
}
