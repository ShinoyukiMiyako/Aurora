// 素材接缝：引导程序用到的品牌图形都经这里。素材要换时只改这个文件，视图和 Frame 不用动。
// 左栏是固定盒，文字不压在图上，素材比例变化影响不到主列。

import { useSyncExternalStore } from "react";
import { BlossomBranch } from "../art/illustrations/BlossomBranch";
import { Logo } from "../art/Logo";
import type { PetalDowngrade } from "../art/petals/engine";
import { PetalCanvas } from "../art/petals/PetalCanvas";
import styles from "./setup.module.css";

const BRANCH_WIDTH = 248;
const BRANCH_HEIGHT = 200;

export function BrandMark() {
  return <Logo size={28} />;
}

function subscribeActivity(notify: () => void): () => void {
  document.addEventListener("visibilitychange", notify);
  window.addEventListener("focus", notify);
  window.addEventListener("blur", notify);
  return () => {
    document.removeEventListener("visibilitychange", notify);
    window.removeEventListener("focus", notify);
    window.removeEventListener("blur", notify);
  };
}

/** 窗口最小化（页面不可见）或失焦时花瓣停下，和启动器外壳一个口径：用户在看别的窗口时这里不该每帧跑着。 */
export function usePetalsPaused(): boolean {
  return useSyncExternalStore(subscribeActivity, () => document.hidden || !document.hasFocus());
}

function logDowngrade(event: PetalDowngrade): void {
  console.info("[setup] 花瓣层自动降级", event);
}

export interface StageArtProps {
  reduced: boolean;
}

/** 左栏的花枝和花瓣。 */
export function StageArt({ reduced }: StageArtProps) {
  const paused = usePetalsPaused();
  return (
    <div className={styles.stage} aria-hidden="true">
      <PetalCanvas show paused={paused} reduced={reduced} tier="regular" mode="day" accent="sakura" onDowngrade={logDowngrade} />
      <BlossomBranch className={styles.branch} width={BRANCH_WIDTH} height={BRANCH_HEIGHT} />
    </div>
  );
}
