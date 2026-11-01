import { useState } from "react";
import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { AccentSwatches, type AccentOption } from "./AccentSwatches";
import type { PreviewAccent } from "./ModeCards";

const OPTIONS: readonly AccentOption[] = [
  { value: "sakura", label: "樱粉" },
  { value: "amethyst", label: "紫水晶" },
  { value: "moss", label: "青苔" },
];

/** 陈列里只切这一组色块的选中项，不改整页外观：三枚色块始终画各自的真实颜色。 */
function Demo({ initial }: { initial: PreviewAccent }) {
  const [accent, setAccent] = useState<PreviewAccent>(initial);
  return (
    <div style={{ width: 420 }}>
      <AccentSwatches value={accent} options={OPTIONS} onChange={setAccent} ariaLabel="强调色" />
    </div>
  );
}

export const gallery: GalleryEntry = {
  title: "AccentSwatches",
  group: "表单",
  order: 31,
  render: () => (
    <>
      <GalleryRow label="选中樱粉">
        <Demo initial="sakura" />
      </GalleryRow>
      <GalleryRow label="选中青苔">
        <Demo initial="moss" />
      </GalleryRow>
    </>
  ),
};
