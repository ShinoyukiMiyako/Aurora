import type { GalleryEntry } from "../dev/gallery-types";
import { AccentSwatch, GalleryRow } from "../dev/GalleryKit";
import { Spinner } from "./Spinner";

export const gallery: GalleryEntry = {
  title: "Spinner",
  group: "原语",
  order: 2,
  render: () => (
    <>
      <GalleryRow label="四档">
        <Spinner size={16} />
        <Spinner size={20} />
        <Spinner size={24} />
        <Spinner size={32} />
      </GalleryRow>
      <GalleryRow label="强调实底上">
        <AccentSwatch>
          <Spinner size={20} tone="on-accent" />
        </AccentSwatch>
      </GalleryRow>
    </>
  ),
};
