// 组件陈列（仅开发构建）：在六种外观组合（日樱 / 夜樱 × 三种强调色）与三档宽度下逐个检查组件的全部状态。
// 宽度档按陈列画框的宽度计算并写到 <html data-sk-tier>，与外壳按应用根宽度分档的方式一致。

import { useState } from "react";
import { ACCENT_NAMES, APPEARANCE_MODES, type AccentName, type AppearanceMode } from "../domain/types";
import { cx } from "../lib/util";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { useTier } from "../shell/tier";
import { useAppearance } from "../state/appearance";
import type { GalleryEntry, GalleryModule } from "./gallery-types";
import styles from "./Gallery.module.css";

const modules = import.meta.glob<GalleryModule>("../**/*.gallery.tsx", { eager: true });

const ENTRIES: GalleryEntry[] = Object.entries(modules)
  .map(([file, mod]) => {
    if (!mod.gallery) throw new Error(`${file} 没有导出 gallery`);
    return mod.gallery;
  })
  .sort((a, b) => a.group.localeCompare(b.group, "zh-CN") || a.order - b.order || a.title.localeCompare(b.title));

const MODE_LABEL: Record<AppearanceMode, string> = { day: "日樱", night: "夜樱" };
const ACCENT_LABEL: Record<AccentName, string> = { sakura: "樱粉", amethyst: "紫水晶", moss: "青苔" };

/** 画框宽度：auto 跟随窗口，其余为三档的代表宽度（compact 下限、默认窗口、wide 常见）。 */
const FRAME_WIDTHS = ["auto", 960, 1120, 1440] as const;
type FrameWidth = (typeof FRAME_WIDTHS)[number];

export default function Gallery() {
  return (
    <OverlayProvider>
      <GalleryBody />
    </OverlayProvider>
  );
}

function GalleryBody() {
  const { appearance, reduced, setAppearance } = useAppearance();
  const [frameWidth, setFrameWidth] = useState<FrameWidth>("auto");
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const tier = useTier(frame);
  const shown = filter === null ? ENTRIES : ENTRIES.filter((e) => e.title === filter);

  return (
    <div className={styles.app}>
      <header className={styles.toolbar}>
        <span className={styles.toolbarTitle}>组件陈列</span>
        <div className={styles.group} role="group" aria-label="明暗">
          {APPEARANCE_MODES.map((mode) => (
            <button key={mode} type="button" className={styles.chip} aria-pressed={appearance.mode === mode} onClick={() => void setAppearance({ mode })}>
              {MODE_LABEL[mode]}
            </button>
          ))}
        </div>
        <div className={styles.group} role="group" aria-label="强调色">
          {ACCENT_NAMES.map((accent) => (
            <button key={accent} type="button" className={styles.chip} aria-pressed={appearance.accent === accent} onClick={() => void setAppearance({ accent })}>
              {ACCENT_LABEL[accent]}
            </button>
          ))}
        </div>
        <div className={styles.group} role="group" aria-label="画框宽度">
          {FRAME_WIDTHS.map((w) => (
            <button key={w} type="button" className={styles.chip} aria-pressed={frameWidth === w} onClick={() => setFrameWidth(w)}>
              {w === "auto" ? "自适应" : `${w}`}
            </button>
          ))}
        </div>
        <button type="button" className={styles.chip} aria-pressed={appearance.reduceMotion} onClick={() => void setAppearance({ reduceMotion: !appearance.reduceMotion })}>
          减少动画
        </button>
        <span className={styles.meta}>
          {tier} · {reduced ? "减少动画生效" : "完整动画"}
        </span>
      </header>
      <div className={styles.body}>
        <nav className={styles.nav} aria-label="组件">
          <button type="button" className={styles.navItem} aria-pressed={filter === null} onClick={() => setFilter(null)}>
            全部
          </button>
          {ENTRIES.map((entry) => (
            <button key={entry.title} type="button" className={styles.navItem} aria-pressed={filter === entry.title} onClick={() => setFilter(entry.title)}>
              {entry.title}
              <span className={styles.navGroup}>{entry.group}</span>
            </button>
          ))}
        </nav>
        <main className={styles.scroll}>
          <div ref={setFrame} className={cx(styles.frame, frameWidth !== "auto" && styles.fixed)} style={frameWidth === "auto" ? undefined : { width: frameWidth }}>
            {shown.map((entry) => (
              <section key={entry.title} className={styles.section} aria-label={entry.title}>
                <h2 className={styles.sectionTitle}>
                  {entry.title}
                  <span className={styles.navGroup}>{entry.group}</span>
                </h2>
                {entry.render()}
              </section>
            ))}
          </div>
        </main>
      </div>
      <OverlayRoot />
    </div>
  );
}
