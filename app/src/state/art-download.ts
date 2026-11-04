// 下载原版材质：本机没有原版游戏时由玩家手动触发，不在启动时静默下载。整个应用同一时刻只有一次下载，
// 选择框与设置页的部件看的是同一份状态，关掉选择框再打开，进度、「正在载入」与失败都还在。下完后后端重选材质源并推送
// 材质变化，方块目录由材质绑定重新载入，这里不碰目录：下完时经登记的入口请绑定重查一次，再等绑定经 settleArtDownload
// 报告载入结果。下载失败原样抛给调用方，由最外层统一报错；目录载入失败由材质绑定报错，这里只转为可重试，重试只重查、不重下。

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

/**
 * idle：没在下，也没有要重试的。running：下载中，progress 为最近一次进度，第一条进度到来之前为 null。
 * finishing：下完了，等材质绑定载入新材质源的方块目录。failed：可以重试，stage 指出败在下载还是下完后的目录载入。
 */
export type ArtDownloadState =
  | { readonly phase: "idle" }
  | { readonly phase: "running"; readonly progress: ArtDownloadProgress | null }
  | { readonly phase: "finishing" }
  | { readonly phase: "failed"; readonly stage: "download" | "catalog" };

const IDLE: ArtDownloadState = { phase: "idle" };
const FINISHING: ArtDownloadState = { phase: "finishing" };
const STAGES: ReadonlySet<string> = new Set<ArtDownloadStage>(["manifest", "client", "names", "extract"]);

let state: ArtDownloadState = IDLE;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();
/** 材质绑定登记的「立刻重查状态与目录」；绑定建立之前为 null。 */
let reloadCatalog: (() => void) | null = null;

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

/** 材质绑定登记重查入口，返回注销；注销时入口已换成别的就不动。 */
export function registerCatalogReload(reload: () => void): () => void {
  reloadCatalog = reload;
  return () => {
    if (reloadCatalog === reload) reloadCatalog = null;
  };
}

/**
 * 进入「正在载入」并请绑定重查：下载命令返回之前后端已推过变化事件，绑定那次查询可能早已结束、结果在下载中被忽略。
 * 绑定还没建立时不必请求，它建立时的首查同样会报告结果。
 */
function awaitCatalog(): void {
  setState(FINISHING);
  if (reloadCatalog !== null) reloadCatalog();
}

const isByteCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function progressFromDto(dto: ArtDownloadProgressDto): ArtDownloadProgress {
  if (typeof dto !== "object" || dto === null || !STAGES.has(dto.stage) || !isByteCount(dto.downloaded) || !(dto.total === null || isByteCount(dto.total))) {
    throw new Error(`art-download 进度形状不对：${JSON.stringify(dto)}`);
  }
  return { stage: dto.stage, downloaded: dto.downloaded, total: dto.total };
}

async function runDownload(): Promise<void> {
  setState({ phase: "running", progress: null });
  let downloaded = false;
  try {
    // 先订阅再调用：后端一开始就推进度，晚订阅会漏掉前几条
    const unlisten = await onArtDownload((dto) => {
      if (state.phase === "running") setState({ phase: "running", progress: progressFromDto(dto) });
    });
    try {
      const status = await artDownload();
      if (status.source === null) throw new Error("原版材质下载完成，后端却仍报告没有材质源");
      downloaded = true;
    } finally {
      unlisten();
    }
  } finally {
    if (downloaded) awaitCatalog();
    else setState({ phase: "failed", stage: "download" });
  }
}

/**
 * 开始下载，等到后端下完（不等目录载入）；已经在下时返回同一个 Promise，不会再调一次后端。
 * 上次是下完了、目录没载入：材质已在缓存里，只请绑定重查，不再整包重下。
 */
export function downloadArt(): Promise<void> {
  if (state.phase === "failed" && state.stage === "catalog") {
    awaitCatalog();
    return Promise.resolve();
  }
  if (inflight === null) {
    inflight = runDownload().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/**
 * 材质绑定每次载入方块目录后报告结果：载入了目录为 true；状态查询失败、目录查询失败或校验被拒为 false。
 * 下完后的等待由它结束：载入了回到 idle，失败转为可重试。下载失败后目录载入了（比如玩家另装了游戏）也回到 idle，
 * 不必再下。其余时候什么都不做：下载中的结果说的是下载之前的材质源。
 */
export function settleArtDownload(catalogLoaded: boolean): void {
  if (state.phase === "finishing") setState(catalogLoaded ? IDLE : { phase: "failed", stage: "catalog" });
  else if (state.phase === "failed" && catalogLoaded) setState(IDLE);
}

export interface ArtDownloadApi {
  state: ArtDownloadState;
  /** 交给 useRunner 调用：下载失败时 reject，状态转为可重试，可以再调一次。 */
  download: () => Promise<void>;
}

export function useArtDownload(): ArtDownloadApi {
  return { state: useSyncExternalStore(subscribe, getArtDownloadState, getArtDownloadState), download: downloadArt };
}
