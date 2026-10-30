import { useState } from "react";
import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { MemorySlider } from "./MemorySlider";

function Instance({ totalMb, initial }: { totalMb: number; initial: number }) {
  const [value, setValue] = useState(initial);
  const recommended = 6144;
  const low = value < recommended;
  return (
    <div style={{ width: 520 }}>
      <MemorySlider
        value={value}
        onChange={setValue}
        onCommit={() => undefined}
        totalMb={totalMb}
        recommended={{ mb: recommended, tip: "按 120 个 Mod 推荐 6 GB" }}
        notes={[low ? "120 个 Mod 建议至少 6 GB" : "建议值 6 GB，当前足够"]}
        notesTone={low ? "warn" : "default"}
        ariaLabel="最大内存"
      />
    </div>
  );
}

export const gallery: GalleryEntry = {
  title: "MemorySlider",
  group: "表单",
  order: 11,
  render: () => (
    <>
      <GalleryRow label="32 GB 本机">
        <Instance totalMb={32768} initial={8192} />
      </GalleryRow>
      <GalleryRow label="8 GB · 低于推荐">
        <Instance totalMb={8192} initial={2048} />
      </GalleryRow>
      <GalleryRow label="警示区">
        <Instance totalMb={16384} initial={10240} />
      </GalleryRow>
      <GalleryRow label="跟随全局">
        <div style={{ width: 520 }}>
          <MemorySlider value={6144} onChange={() => undefined} onCommit={() => undefined} totalMb={16384} notes={["现在空闲 9.2 GB"]} disabled ariaLabel="跟随全局" />
        </div>
      </GalleryRow>
    </>
  ),
};
