import type { InstallMode, Progress } from "../contract";
import type { SetupCopy } from "../copy";
import { Frame } from "../Frame";

export interface InstallingProps {
  copy: SetupCopy;
  mode: InstallMode;
  /** 载荷版本，升级时进标题。 */
  version: string;
  /** 第几次安装：做 ProgressBar 的 track，重试时进度条从头开始而不是往回动画。 */
  run: number;
  /** 第一个进度事件到之前是 null。percent 已经过只增不减处理。 */
  progress: Progress | null;
}

export function Installing({ copy, mode, version, progress }: InstallingProps) {
  return <Frame title={copy.installing.title[mode](version)} lead={progress === null ? undefined : copy.installing.phase[progress.phase]} />;
}
