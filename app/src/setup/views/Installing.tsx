import { Appear } from "../../ui/Appear";
import { ProgressBar } from "../../ui/ProgressBar";
import type { InstallMode, Progress } from "../contract";
import type { SetupCopy } from "../copy";
import { Frame } from "../Frame";
import styles from "./Installing.module.css";

/** 第一个进度事件到之前阶段行的内容：占住一行文字的高度与基线，读屏读到的仍是空白。 */
export const NO_PHASE_YET = " ";

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

/** 缓动和减少动画都由 ProgressBar 跟随 App 的 MotionConfig。没有取消按钮：中途结束安装包只会留下半套文件。 */
export function Installing({ copy, mode, version, run, progress }: InstallingProps) {
  if (mode === "switch") throw new Error("没有发起换通道安装的入口，不该装 switch");
  const text = copy.installing;
  return (
    <Frame title={text.title[mode](version)}>
      <div className={styles.meter}>
        {/* 第一个事件之前确实是 0，还没开始：空轨道就是实情 */}
        <ProgressBar value={progress === null ? 0 : progress.percent / 100} track={String(run)} size="lg" label={text.progressLabel} />
        <div className={styles.caption}>
          {/* 这一块从一开始就挂着：读屏只播报已有区域里的变化，等事件到了才挂上去，第一个阶段就念不出来 */}
          <div className={styles.status} role="status">
            {/*
              阶段这一行从一开始就在，没字时放一个不换行空格：这一行和右边的关闭说明按文字基线对齐，
              空着的块没有基线、按底边对齐，第一个阶段到达时关闭说明会上跳几像素
            */}
            <p className={styles.phase}>{progress === null ? NO_PHASE_YET : text.phase[progress.phase]}</p>
            <Appear>{progress?.slow === true && <p className={styles.slow}>{text.slow}</p>}</Appear>
          </div>
          {/* 关闭键的气泡在按下时就收起，Alt+F4 更是什么反馈都没有，原因得常驻在这里 */}
          <p className={styles.closeNote}>{copy.frame.closeBlocked}</p>
        </div>
      </div>
    </Frame>
  );
}
