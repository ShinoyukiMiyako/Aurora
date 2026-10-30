import { useState } from "react";
import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { Slider } from "./Slider";

const MARKS = [1, 8, 16, 32, 64].map((v) => ({ value: v, label: `${v}` }));

function Concurrency() {
  const [value, setValue] = useState(16);
  const [committed, setCommitted] = useState(16);
  return (
    <div style={{ width: 420 }}>
      <Slider value={value} onChange={setValue} onCommit={setCommitted} min={1} max={64} format={(v) => `${v} 个`} marks={MARKS} snapTo={MARKS.map((m) => m.value)} ariaLabel="同时下载的文件数" />
      <span style={{ color: "var(--sk-text-2)", fontSize: "var(--sk-fs-caption)" }}>已提交 {committed}</span>
    </div>
  );
}

export const gallery: GalleryEntry = {
  title: "Slider",
  group: "表单",
  order: 10,
  render: () => (
    <>
      <GalleryRow label="刻度 · 吸附">
        <Concurrency />
      </GalleryRow>
      <GalleryRow label="无读数 · 禁用">
        <div style={{ width: 300 }}>
          <Slider value={40} onChange={() => undefined} onCommit={() => undefined} min={0} max={100} format={(v) => `${v}%`} showValue={false} ariaLabel="音量" />
        </div>
        <div style={{ width: 300 }}>
          <Slider value={8} onChange={() => undefined} onCommit={() => undefined} min={1} max={64} format={(v) => `${v} 个`} disabled ariaLabel="禁用" />
        </div>
      </GalleryRow>
    </>
  ),
};
