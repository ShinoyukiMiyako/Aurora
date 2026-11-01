import { useState } from "react";
import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { SearchInput } from "./SearchInput";

function PageSearch() {
  const [query, setQuery] = useState("");
  return (
    <div style={{ width: 320 }}>
      <SearchInput value={query} onChange={setQuery} shortcut={["Ctrl", "F"]} aria-label="搜索 Mod" placeholder="搜索 Mod" />
    </div>
  );
}

function DiscoverSearch() {
  const [query, setQuery] = useState("sodium");
  const [submitted, setSubmitted] = useState<string | null>(null);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--sk-space-12)", width: 560 }}>
      <SearchInput size="lg" value={query} onChange={setQuery} onEnter={() => setSubmitted(query)} aria-label="搜索资源" />
      <span style={{ flex: "none", color: "var(--sk-text-2)" }}>{submitted === null ? "回车提交" : `已提交：${submitted}`}</span>
    </div>
  );
}

export const gallery: GalleryEntry = {
  title: "SearchInput",
  group: "表单",
  order: 3,
  render: () => (
    <>
      <GalleryRow label="快捷键提示">
        <PageSearch />
      </GalleryRow>
      <GalleryRow label="页面级 · lg">
        <DiscoverSearch />
      </GalleryRow>
    </>
  ),
};
