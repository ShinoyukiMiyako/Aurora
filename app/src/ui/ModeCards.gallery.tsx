import { useState } from "react";
import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { ModeCards, type ModeOption, type PreviewAccent, type PreviewMode } from "./ModeCards";

const OPTIONS: readonly ModeOption[] = [
  { value: "day", label: "日樱", desc: "浅粉白底，适合白天" },
  { value: "night", label: "夜樱", desc: "深紫灰底与紫水晶点缀" },
];

const ACCENTS: readonly PreviewAccent[] = ["sakura", "amethyst", "moss"];

/** 陈列里只切这一组卡片的选中项，不改整页外观：两张预览始终画各自明暗的真实样子。 */
function Demo({ accent }: { accent: PreviewAccent }) {
  const [mode, setMode] = useState<PreviewMode>("day");
  return (
    <div style={{ width: 460 }}>
      <ModeCards value={mode} accent={accent} options={OPTIONS} onChange={setMode} ariaLabel="明暗" />
    </div>
  );
}

export const gallery: GalleryEntry = {
  title: "ModeCards",
  group: "表单",
  order: 30,
  render: () => (
    <>
      {ACCENTS.map((accent) => (
        <GalleryRow key={accent} label={`强调色 ${accent}`}>
          <Demo accent={accent} />
        </GalleryRow>
      ))}
    </>
  ),
};
