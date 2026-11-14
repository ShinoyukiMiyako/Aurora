// 下载完成后的收尾一拍：关于页的更新卡与外壳的更新面板共用这一份规则。

import { useState } from "react";
import { useCompletionHold, useFinishing } from "../../lib/progress-display";
import type { UpdaterPhase } from "./machine";

type Downloading = Extract<UpdaterPhase, { kind: "downloading" }>;

/** 收尾要用的那一份下载阶段，与它换成已下好的时刻（还在下载时为 null）。 */
interface DownloadEnd {
  last: Downloading;
  finishedAt: number | null;
}

/**
 * 下载完成后在原处留住下载中的样子一拍（lib/progress-display 的收尾时长）再换成已下好：进度条与百分数沿平滑推满，
 * 已下大小到了总量、立即换成「总量 / 总量」。下载完成常与最后一条进度落在同一帧，不留这一拍的话，
 * 进度停在平滑追到的位置（常差两三成）、已下大小停在节流挂着的旧值上，就被整块换掉了。
 * 只留从下载中直接换到已下好的那一次；总量未知时没有满格可推、减少动画时收尾时长为 0，都不留。
 * holding 为 true 时实际阶段已是已下好，留住的下载中只是画法：按它去取消下载会被状态机拒绝。
 */
export function useDownloadHold(phase: UpdaterPhase): { phase: UpdaterPhase; holding: boolean } {
  const holdS = useCompletionHold();
  const [end, setEnd] = useState<DownloadEnd | null>(null);
  let next = end;
  if (phase.kind === "downloading") {
    // 只在任务、源与总量变了时记下：已下大小约 100 ms 一变，记它就要每条进度多渲染一次。留住时已下大小按总量画，用不着它
    if (next === null || next.finishedAt !== null || next.last.taskId !== phase.taskId || next.last.source !== phase.source || next.last.totalBytes !== phase.totalBytes) {
      next = { last: phase, finishedAt: null };
    }
  } else if (phase.kind === "ready") {
    if (next !== null && next.finishedAt === null) {
      const fills = holdS > 0 && next.last.totalBytes !== null && next.last.update.version === phase.update.version;
      next = fills ? { last: next.last, finishedAt: Date.now() } : null;
    }
  } else {
    next = null;
  }
  if (next !== end) setEnd(next);
  const finishing = useFinishing(next === null || next.finishedAt === null ? [] : [{ id: next.last.taskId, finishedAt: next.finishedAt }], holdS);
  if (phase.kind !== "ready" || next === null || !finishing.has(next.last.taskId)) return { phase, holding: false };
  const { last } = next;
  if (last.totalBytes === null) throw new Error("下载完成的收尾只留总量已知的下载");
  return { phase: { ...last, bytes: last.totalBytes }, holding: true };
}
