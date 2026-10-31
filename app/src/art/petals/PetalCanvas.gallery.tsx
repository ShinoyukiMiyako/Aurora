import { useState } from "react";
import type { GalleryEntry } from "../../dev/gallery-types";
import { GalleryRow } from "../../dev/GalleryKit";
import { useAppearance } from "../../state/appearance";
import { Button } from "../../ui/Button";
import { currentPetalStats, type PetalDowngrade, type PetalStats } from "./engine";
import { PetalCanvas } from "./PetalCanvas";
import type { PetalTier } from "./sim";
import styles from "./PetalCanvas.gallery.module.css";

const TIERS: readonly PetalTier[] = ["compact", "regular", "wide"];
const REGRESSION_SEED = 20231;

function PetalDemo() {
  const { appearance, reduced } = useAppearance();
  const [show, setShow] = useState(true);
  const [paused, setPaused] = useState(false);
  const [tier, setTier] = useState<PetalTier>("regular");
  const [fixedSeed, setFixedSeed] = useState(true);
  // null 为还没点过「读取」；{ value: null } 为读取时没有挂载花瓣层
  const [stats, setStats] = useState<{ value: PetalStats | null } | null>(null);
  const [downgrades, setDowngrades] = useState<PetalDowngrade[]>([]);

  return (
    <>
      <GalleryRow label="条件">
        <Button size="sm" aria-pressed={show} onClick={() => setShow((v) => !v)}>
          显示
        </Button>
        <Button size="sm" aria-pressed={paused} onClick={() => setPaused((v) => !v)}>
          暂停
        </Button>
        <Button size="sm" aria-pressed={fixedSeed} onClick={() => setFixedSeed((v) => !v)}>
          固定种子
        </Button>
      </GalleryRow>
      <GalleryRow label="档位">
        {TIERS.map((t) => (
          <Button key={t} size="sm" aria-pressed={tier === t} onClick={() => setTier(t)}>
            {t}
          </Button>
        ))}
      </GalleryRow>
      <div className={styles.stage}>
        <PetalCanvas
          show={show}
          paused={paused}
          reduced={reduced}
          tier={tier}
          mode={appearance.mode}
          accent={appearance.accent}
          seed={fixedSeed ? REGRESSION_SEED : undefined}
          onDowngrade={(event) => setDowngrades((list) => [...list, event])}
        />
        <div className={styles.card}>卡片保持微透底色，花瓣从卡片底下隐约透出；指针经过卡片时照样推开下面的花瓣。</div>
      </div>
      <GalleryRow label="运行状态">
        <Button size="sm" onClick={() => setStats({ value: currentPetalStats() })}>
          读取
        </Button>
        <span className={styles.stats}>{stats === null ? "尚未读取" : stats.value === null ? "没有挂载花瓣层" : JSON.stringify(stats.value)}</span>
      </GalleryRow>
      <GalleryRow label="降级记录">
        <span className={styles.stats}>{downgrades.length === 0 ? "无" : downgrades.map((d) => `${d.tier} → ${d.level}（${d.windowMediansMs.join(" / ")} ms）`).join("；")}</span>
      </GalleryRow>
    </>
  );
}

export const gallery: GalleryEntry = {
  title: "PetalCanvas",
  group: "美术件",
  order: 1,
  render: () => <PetalDemo />,
};
