import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { LoaderDot, LoaderTag, type LoaderTagKind } from "./LoaderTag";

const SAMPLES: { loader: LoaderTagKind; version: string | null }[] = [
  { loader: "vanilla", version: null },
  { loader: "fabric", version: "0.16.9" },
  { loader: "quilt", version: "0.27.1" },
  { loader: "forge", version: "52.0.31" },
  { loader: "neoforge", version: "21.1.77" },
];

export const gallery: GalleryEntry = {
  title: "LoaderTag",
  group: "数据展示",
  order: 3,
  render: () => (
    <>
      {(["md", "sm"] as const).map((size) => (
        <GalleryRow key={size} label={`带版本 · ${size}`}>
          {SAMPLES.map(({ loader, version }) => (
            <LoaderTag key={loader} loader={loader} version={version} size={size} />
          ))}
        </GalleryRow>
      ))}
      <GalleryRow label="只有名称">
        {SAMPLES.map(({ loader }) => (
          <LoaderTag key={loader} loader={loader} />
        ))}
      </GalleryRow>
      <GalleryRow label="圆点 7 / 6">
        {SAMPLES.map(({ loader }) => (
          <LoaderDot key={loader} loader={loader} />
        ))}
        {SAMPLES.map(({ loader }) => (
          <LoaderDot key={`${loader}-6`} loader={loader} size={6} />
        ))}
      </GalleryRow>
    </>
  ),
};
