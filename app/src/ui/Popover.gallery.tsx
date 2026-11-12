import { motion } from "framer-motion";
import { useRef, useState } from "react";
import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { springs } from "../lib/motion";
import type { Placement } from "../shell/overlay";
import { Appear } from "./Appear";
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

/** 开着的时候增删行、出没提示：外框随内容形变，底部跟着下沿走。 */
function Morphing({ placement, label }: { placement: Placement; label: string }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState([1, 2]);
  const [note, setNote] = useState(false);
  const next = useRef(3);
  const pad = { padding: "var(--sk-space-10) var(--sk-space-14)" };
  const layoutKey = `${rows.join(",")}|${note}`;
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
      <Popover
        open={open}
        anchor={anchor}
        onClose={() => setOpen(false)}
        placement={placement}
        aria-label={label}
        layoutKey={layoutKey}
        header={<div style={{ ...pad, fontWeight: "var(--sk-w-title)" }}>{rows.length} 行</div>}
        footer={
          <div style={pad}>
            <Appear>{note && <p style={{ margin: 0, color: "var(--sk-text-2)", fontSize: "var(--sk-fs-small)" }}>提示条出现时，底部的按钮跟着外框下沿往下走。</p>}</Appear>
            {/* 底部槽位里位置会变的块：与外框同一个布局键、同一条弹簧 */}
            <motion.div style={{ display: "flex", gap: "var(--sk-space-8)" }} layout="position" layoutDependency={layoutKey} transition={{ layout: springs.morph }}>
              <Button size="sm" onClick={() => setRows((r) => [...r, next.current++])}>
                加一行
              </Button>
              <Button size="sm" disabled={rows.length === 0} onClick={() => setRows((r) => r.slice(0, -1))}>
                删一行
              </Button>
              <Button size="sm" onClick={() => setNote((v) => !v)}>
                提示条
              </Button>
            </motion.div>
          </div>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sk-space-6)", ...pad }}>
          {rows.map((n) => (
            <span key={n} style={{ color: "var(--sk-text-2)", fontSize: "var(--sk-fs-small)" }}>
              第 {n} 行
            </span>
          ))}
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
      <GalleryRow label="随内容形变">
        <Morphing placement="bottom-start" label="向下展开" />
        <Morphing placement="top-start" label="向上展开" />
      </GalleryRow>
    </>
  ),
};
