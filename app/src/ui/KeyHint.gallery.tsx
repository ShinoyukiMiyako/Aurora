import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { KeyHint } from "./KeyHint";

export const gallery: GalleryEntry = {
  title: "KeyHint",
  group: "原语",
  order: 4,
  render: () => (
    <>
      <GalleryRow label="单键">
        <KeyHint keys={["Esc"]} />
        <KeyHint keys={["F2"]} />
        <KeyHint keys={["↑"]} />
      </GalleryRow>
      <GalleryRow label="组合键">
        <KeyHint keys={["Ctrl", "K"]} />
        <KeyHint keys={["Ctrl", "Shift", "R"]} />
        <KeyHint keys={["Alt", "←"]} />
      </GalleryRow>
    </>
  ),
};
