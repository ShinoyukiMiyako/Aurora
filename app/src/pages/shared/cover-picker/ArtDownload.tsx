// 「下载原版材质」部件：本机没有材质源时说明材质从哪来、多大，给出下载按钮，下载中显示阶段与字节进度。
// 有材质源（方块目录已载入）时什么都不渲染：下完后材质绑定载入目录，部件随之消失。
// 下载、下完后等目录与失败都在状态层，全应用同一份；下载失败经统一错误处理报出，目录载入失败由材质绑定报出，按钮都换成重试。

import { useIsPresent } from "framer-motion";
import { useId, useRef, useState, type ReactNode } from "react";
import { Spinner } from "../../../art/Spinner";
import { useBlockCatalog } from "../../../art/iso/catalog";
import { ART_DOWNLOAD_COPY } from "../../../copy/cover";
import { cx } from "../../../lib/util";
import { useRunner } from "../../../shell/useRunner";
import { useArtDownload, type ArtDownloadProgress } from "../../../state/art-download";
import { Button } from "../../../ui/Button";
import { Inset } from "../../../ui/Inset";
import { ProgressBar } from "../../../ui/ProgressBar";
import styles from "./ArtDownload.module.css";

export interface ArtDownloadProps {
  /** 紧凑档：不要标题，说明缩成一句，按钮放在右侧；给设置行这类窄处用。 */
  compact?: boolean;
}

export function ArtDownload({ compact = false }: ArtDownloadProps) {
  const catalog = useBlockCatalog();
  const { state, download } = useArtDownload();
  const run = useRunner();
  // 放在出入场容器（Appear）里时，目录一载入它就开始退场：退场期间留着最后一帧（多半是「正在载入材质…」）原地淡出，
  // 而不是先变空、再淡出一个空框。不在出入场容器里时恒为在场，照旧什么都不渲染
  const present = useIsPresent();
  const lastFrame = useRef<ReactNode>(null);
  // 挂载时的状态跟着所在弹窗或页面出现；之后每换一个阶段（开始下载、下完等载入、失败），换上来的状态淡入
  const [firstPhase] = useState(state.phase);
  const [phaseChanged, setPhaseChanged] = useState(false);
  if (!phaseChanged && state.phase !== firstPhase) setPhaseChanged(true);
  if (catalog !== null) return present ? null : lastFrame.current;

  const failed = state.phase === "failed";
  const enter = phaseChanged || undefined;
  // 各阶段的状态按阶段换 key：同一种外形（空闲与失败都是按钮）之间换也重新挂上，入场淡入才会重播
  const status = state.phase === "running" ? (
    <DownloadProgress key="running" progress={state.progress} enter={phaseChanged} />
  ) : state.phase === "finishing" ? (
    <p key="finishing" className={styles.finishing} role="status" data-enter={enter}>
      <Spinner size={16} decorative />
      {ART_DOWNLOAD_COPY.finishing}
    </p>
  ) : (
    <div key={state.phase} className={styles.actions} data-enter={enter}>
      <Button size="sm" icon={failed ? "refresh" : "download"} onClick={() => void run(download, ART_DOWNLOAD_COPY.failed)}>
        {failed ? ART_DOWNLOAD_COPY.retry : ART_DOWNLOAD_COPY.download}
      </Button>
      {state.phase === "failed" && (
        <span className={styles.failed}>{state.stage === "download" ? ART_DOWNLOAD_COPY.failedNote : ART_DOWNLOAD_COPY.catalogFailedNote}</span>
      )}
    </div>
  );

  const frame = compact ? (
    <div className={styles.compact}>
      {state.phase !== "running" && state.phase !== "finishing" && <p className={cx(styles.body, styles.compactBody)}>{ART_DOWNLOAD_COPY.compactBody}</p>}
      {status}
    </div>
  ) : (
    <Inset className={styles.full}>
      <p className={styles.title}>{ART_DOWNLOAD_COPY.title}</p>
      <p className={styles.body}>{ART_DOWNLOAD_COPY.body}</p>
      <div className={styles.status}>{status}</div>
    </Inset>
  );
  lastFrame.current = frame;
  return frame;
}

function DownloadProgress({ progress, enter }: { progress: ArtDownloadProgress | null; enter: boolean }) {
  const stageId = useId();
  const stage = progress === null ? ART_DOWNLOAD_COPY.starting : ART_DOWNLOAD_COPY.stage[progress.stage];
  // 查清单与抽取阶段只有起止，没有字节可数：显示不定进度
  const counted = progress !== null && progress.downloaded > 0;
  const value = progress !== null && progress.total !== null && progress.total > 0 ? progress.downloaded / progress.total : null;
  return (
    <div className={styles.progress} data-enter={enter || undefined}>
      <div className={styles.progressText}>
        <span id={stageId} role="status">
          {stage}
        </span>
        {counted && <span className={styles.bytes}>{ART_DOWNLOAD_COPY.bytes(progress.downloaded, progress.total)}</span>}
      </div>
      <ProgressBar value={value} size="sm" track={progress?.stage} labelledBy={stageId} />
    </div>
  );
}
