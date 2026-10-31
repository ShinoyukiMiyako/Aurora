import { useId, useState } from "react";
import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { TabPanel, Tabs, type TabItem } from "./Tabs";

type Section = "overview" | "mods" | "settings" | "logs" | "crash";
const SECTIONS: TabItem<Section>[] = [
  { value: "overview", label: "概览", icon: "home" },
  { value: "mods", label: "Mod", icon: "mod" },
  { value: "settings", label: "设置", icon: "settings" },
  { value: "logs", label: "日志与历史", icon: "history" },
  { value: "crash", label: "崩溃诊断", icon: "bug" },
];

type Kind = "mod" | "modpack" | "resourcepack" | "shader" | "datapack";
const KINDS: TabItem<Kind>[] = [
  { value: "mod", label: "Mod" },
  { value: "modpack", label: "整合包" },
  { value: "resourcepack", label: "资源包" },
  { value: "shader", label: "光影" },
  { value: "datapack", label: "数据包", disabled: true },
];

function PageTabs() {
  const id = useId();
  const [value, setValue] = useState<Section>("overview");
  return (
    <div style={{ width: 640 }}>
      <Tabs id={id} value={value} onChange={setValue} items={SECTIONS} ariaLabel="实例详情" />
      <TabPanel tabsId={id} value={value}>
        <p style={{ color: "var(--sk-text-2)" }}>{SECTIONS.find((s) => s.value === value)?.label} 面板</p>
      </TabPanel>
    </div>
  );
}

function PillTabs({ size, width }: { size: "sm" | "md"; width: number }) {
  const id = useId();
  const [value, setValue] = useState<Kind>("mod");
  return (
    <div style={{ width }}>
      <Tabs id={id} value={value} onChange={setValue} items={KINDS} variant="pill" size={size} ariaLabel={`资源类型 ${size}`} />
      <TabPanel tabsId={id} value={value} motion="card">
        <p style={{ color: "var(--sk-text-2)" }}>{KINDS.find((k) => k.value === value)?.label}</p>
      </TabPanel>
    </div>
  );
}

export const gallery: GalleryEntry = {
  title: "Tabs",
  group: "导航",
  order: 1,
  render: () => (
    <>
      <GalleryRow label="underline">
        <PageTabs />
      </GalleryRow>
      <GalleryRow label="pill · md / sm">
        <PillTabs size="md" width={520} />
        <PillTabs size="sm" width={420} />
      </GalleryRow>
      <GalleryRow label="溢出 · 渐隐">
        <PillTabs size="md" width={260} />
      </GalleryRow>
    </>
  ),
};
