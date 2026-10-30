import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { Icon } from "./Icon";
import { ICON_NAMES, ICON_PATHS, ICON_SIZES, type IconDef, type IconSize } from "./icon-paths";
import styles from "./Icon.gallery.module.css";

function sizesFor(def: IconDef): IconSize[] {
  if (def.only !== undefined) return [def.only];
  const min = def.min;
  return ICON_SIZES.filter((s) => min === undefined || s >= min);
}

/** 总览里统一用 18 档；只允许单一尺寸的窗口三键用它自己的尺寸。 */
function displaySize(def: IconDef): IconSize {
  return def.only !== undefined ? def.only : 18;
}

export const gallery: GalleryEntry = {
  title: "Icon",
  group: "原语",
  order: 1,
  render: () => (
    <>
      <GalleryRow label="全部 · 18">
        <div className={styles.grid}>
          {ICON_NAMES.map((name) => (
            <span key={name} className={styles.cell} title={name}>
              <Icon name={name} size={displaySize(ICON_PATHS[name])} />
              <span className={styles.name}>{name}</span>
            </span>
          ))}
        </div>
      </GalleryRow>
      <GalleryRow label="尺寸档">
        <div className={styles.sizes}>
          {(["settings", "download", "play", "win-close", "loader-fabric"] as const).map((name) => (
            <span key={name} className={styles.sizeRow}>
              {sizesFor(ICON_PATHS[name]).map((size) => (
                <Icon key={size} name={name} size={size} />
              ))}
            </span>
          ))}
        </div>
      </GalleryRow>
      <GalleryRow label="颜色继承">
        <span className={styles.tone} data-tone="text-2">
          <Icon name="home" />
        </span>
        <span className={styles.tone} data-tone="accent">
          <Icon name="home" />
        </span>
        <span className={styles.tone} data-tone="danger">
          <Icon name="x-circle" />
        </span>
        <span className={styles.tone} data-tone="disabled">
          <Icon name="trash" />
        </span>
      </GalleryRow>
    </>
  ),
};
