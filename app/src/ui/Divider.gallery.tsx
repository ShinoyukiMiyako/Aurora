import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { Divider } from "./Divider";

export const gallery: GalleryEntry = {
  title: "Divider",
  group: "原语",
  order: 5,
  render: () => (
    <GalleryRow label="默认">
      <Divider />
    </GalleryRow>
  ),
};
