import type { GalleryEntry } from "../../dev/gallery-types";
import { GalleryRow } from "../../dev/GalleryKit";
import { KindTile, LoaderTile, WorldModeTile, type TileLoader, type WorldMode } from "./FeatureTile";

const LOADERS: TileLoader[] = ["vanilla", "fabric", "quilt", "forge", "neoforge"];
const MODES: WorldMode[] = ["survival", "creative", "hardcore", "adventure"];

export const gallery: GalleryEntry = {
  title: "功能图块",
  group: "美术件",
  order: 3,
  render: () => (
    <>
      <GalleryRow label="加载器 46">
        {LOADERS.map((loader) => (
          <LoaderTile key={loader} loader={loader} />
        ))}
      </GalleryRow>
      <GalleryRow label="存档模式 44">
        {MODES.map((mode) => (
          <WorldModeTile key={mode} mode={mode} />
        ))}
      </GalleryRow>
      <GalleryRow label="资源与未知 40">
        <KindTile kind="shader" />
        <KindTile kind="resource-pack" />
        <KindTile kind="unknown" />
      </GalleryRow>
    </>
  ),
};
