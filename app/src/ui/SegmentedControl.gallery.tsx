import { useState } from "react";
import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { SegmentedControl, type SegmentOption } from "./SegmentedControl";

type Loader = "all" | "vanilla" | "fabric" | "forge" | "neoforge" | "quilt";
const LOADERS: SegmentOption<Loader>[] = [
  { value: "all", label: "全部", count: 12 },
  { value: "vanilla", label: "原版", count: 3, dot: "vanilla" },
  { value: "fabric", label: "Fabric", count: 5, dot: "fabric" },
  { value: "forge", label: "Forge", count: 2, dot: "forge" },
  { value: "neoforge", label: "NeoForge", count: 1, dot: "neoforge" },
  { value: "quilt", label: "Quilt", count: 0, dot: "quilt", disabled: true },
];

type Level = "all" | "warn" | "error";
const LEVELS: SegmentOption<Level>[] = [
  { value: "all", label: "全部" },
  { value: "warn", label: "警告", icon: "alert" },
  { value: "error", label: "错误", icon: "x-circle" },
];

function LoaderFilter() {
  const [value, setValue] = useState<Loader>("all");
  return <SegmentedControl value={value} onChange={setValue} options={LOADERS} ariaLabel="按加载器筛选" />;
}

function LevelFilter({ size }: { size: "sm" | "md" }) {
  const [value, setValue] = useState<Level>("all");
  return <SegmentedControl value={value} onChange={setValue} options={LEVELS} size={size} ariaLabel={`日志级别 ${size}`} />;
}

function MemoryMode() {
  const [value, setValue] = useState<"global" | "custom">("global");
  return (
    <div style={{ width: 360 }}>
      <SegmentedControl
        value={value}
        onChange={setValue}
        options={[
          { value: "global", label: "跟随全局" },
          { value: "custom", label: "单独设置" },
        ]}
        block
        ariaLabel="内存设置方式"
      />
    </div>
  );
}

export const gallery: GalleryEntry = {
  title: "SegmentedControl",
  group: "表单",
  order: 12,
  render: () => (
    <>
      <GalleryRow label="识别色 · 计数">
        <LoaderFilter />
      </GalleryRow>
      <GalleryRow label="图标 · md / sm">
        <LevelFilter size="md" />
        <LevelFilter size="sm" />
      </GalleryRow>
      <GalleryRow label="撑满">
        <MemoryMode />
      </GalleryRow>
      <GalleryRow label="整组禁用">
        <SegmentedControl value="warn" onChange={() => undefined} options={LEVELS} disabled ariaLabel="禁用" />
      </GalleryRow>
    </>
  ),
};
