import { useState } from "react";
import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import type { Placement } from "../shell/overlay";
import { Button } from "./Button";
import { Popover } from "./Popover";

function Anchored({ placement, label }: { placement: Placement; label: string }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        aria-expanded={open}
        onClick={(event) => {
          setAnchor(event.currentTarget);
          setOpen((v) => !v);
        }}
      >
        {label}
      </Button>
      <Popover open={open} anchor={anchor} onClose={() => setOpen(false)} placement={placement} aria-label={label}>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sk-space-12)", padding: "var(--sk-space-14)" }}>
          <span style={{ color: "var(--sk-text-2)", fontSize: "var(--sk-fs-small)" }}>面板里可以放任意交互内容；Tab 移出面板即关闭。</span>
          <Button size="sm" onClick={() => setOpen(false)}>
            完成
          </Button>
        </div>
      </Popover>
    </>
  );
}

export const gallery: GalleryEntry = {
  title: "Popover",
  group: "浮层",
  order: 2,
  render: () => (
    <>
      <GalleryRow label="方位">
        <Anchored placement="bottom-start" label="bottom-start" />
        <Anchored placement="bottom" label="bottom" />
        <Anchored placement="bottom-end" label="bottom-end" />
        <Anchored placement="top-start" label="top-start" />
        <Anchored placement="right-start" label="right-start" />
        <Anchored placement="left" label="left" />
      </GalleryRow>
    </>
  ),
};
