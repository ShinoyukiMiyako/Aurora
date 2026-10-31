import { useState } from "react";
import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { Button } from "./Button";
import type { ProgressTone } from "./ProgressBar";
import { ProgressRing, type ProgressRingSize } from "./ProgressRing";

const SIZES: ProgressRingSize[] = [16, 20, 24, 36, 48, 84];
const TONES: ProgressTone[] = ["accent", "ok", "info", "warn", "danger", "muted"];

function Live() {
  const [value, setValue] = useState(0.1);
  return (
    <GalleryRow label="平滑">
      <ProgressRing value={value} size={48} track="demo" capAt99 label="启动中" />
      <Button size="sm" onClick={() => setValue((v) => Math.min(1, v + 0.2))}>
        前进
      </Button>
    </GalleryRow>
  );
}

export const gallery: GalleryEntry = {
  title: "ProgressRing",
  group: "反馈",
  order: 2,
  render: () => (
    <>
      <GalleryRow label="尺寸">
        {SIZES.map((size) => (
          <ProgressRing key={size} value={0.37} size={size} label={`进度 ${size}`} />
        ))}
      </GalleryRow>
      <GalleryRow label="色调">
        {TONES.map((tone) => (
          <ProgressRing key={tone} value={0.66} size={36} tone={tone} label={`色调 ${tone}`} />
        ))}
      </GalleryRow>
      <GalleryRow label="边界">
        <ProgressRing value={0} size={36} label="排队中" />
        <ProgressRing value={0.999} size={36} capAt99 label="启动中封顶 99" />
        <ProgressRing value={1} size={36} tone="ok" label="完成" />
        <ProgressRing value={0.02} size={24} label="刚开始" />
      </GalleryRow>
      <GalleryRow label="无进度">
        <ProgressRing value={null} size={84} tone="muted" label="下载总进度" emptyText="没有进行中的下载" />
        <ProgressRing value={null} size={48} tone="muted" label="下载总进度" />
        <ProgressRing value={null} size={24} tone="muted" label="下载总进度" />
      </GalleryRow>
      <Live />
    </>
  ),
};
