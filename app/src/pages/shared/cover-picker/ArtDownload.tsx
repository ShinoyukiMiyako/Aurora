// 「下载原版材质」部件：本机没有材质源时说明材质从哪来、多大，给出下载按钮，下载中显示阶段与字节进度。
// 有材质源（方块目录已载入）时什么都不渲染：下完后材质绑定载入目录，部件随之消失。
// 下载本身在状态层，全应用同一份进度；失败经统一错误处理报出，按钮换成重试。

import { useId, useState } from "react";
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
  const [failed, setFailed] = useState(false);
  // 下完到目录载入之间有一小段：不在这时把下载按钮又亮出来
  const [finishing, setFinishing] = useState(false);
  if (catalog !== null) return null;

  const start = async () => {
    setFailed(false);
    const result = await run(download, ART_DOWNLOAD_COPY.failed);
    if (result.ok) setFinishing(true);
    else setFailed(true);
  };

  const status = state.running ? (
    <DownloadProgress progress={state.progress} />
  ) : finishing ? (
    <p className={styles.finishing} role="status">
      <Spinner size={16} decorative />
      {ART_DOWNLOAD_COPY.finishing}
    </p>
  ) : (
    <div className={styles.actions}>
      <Button size="sm" icon={failed ? "refresh" : "download"} onClick={() => void start()}>
        {failed ? ART_DOWNLOAD_COPY.retry : ART_DOWNLOAD_COPY.download}
      </Button>
      {failed && <span className={styles.failed}>{ART_DOWNLOAD_COPY.failedNote}</span>}
    </div>
  );

  if (compact) {
    return (
      <div className={styles.compact}>
        {!state.running && !finishing && <p className={cx(styles.body, styles.compactBody)}>{ART_DOWNLOAD_COPY.compactBody}</p>}
        {status}
      </div>
    );
  }
  return (
    <Inset className={styles.full}>
      <p className={styles.title}>{ART_DOWNLOAD_COPY.title}</p>
      <p className={styles.body}>{ART_DOWNLOAD_COPY.body}</p>
      <div className={styles.status}>{status}</div>
    </Inset>
  );
}

function DownloadProgress({ progress }: { progress: ArtDownloadProgress | null }) {
  const stageId = useId();
  const stage = progress === null ? ART_DOWNLOAD_COPY.starting : ART_DOWNLOAD_COPY.stage[progress.stage];
  // 查清单与抽取阶段只有起止，没有字节可数：显示不定进度
  const counted = progress !== null && progress.downloaded > 0;
  const value = progress !== null && progress.total !== null && progress.total > 0 ? progress.downloaded / progress.total : null;
  return (
    <div className={styles.progress}>
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
