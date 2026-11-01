import { useState } from "react";
import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { Checkbox } from "./Checkbox";

const MODS = ["Sodium", "Lithium", "Iris"];

/** 表头的全选框：部分选中时为半选。 */
function SelectAll() {
  const [picked, setPicked] = useState<string[]>(["Sodium"]);
  const all = picked.length === MODS.length ? true : picked.length === 0 ? false : "mixed";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sk-space-6)" }}>
      <Checkbox checked={all} onChange={(next) => setPicked(next ? MODS : [])} label="全选" />
      {MODS.map((mod) => (
        <Checkbox key={mod} checked={picked.includes(mod)} onChange={(next) => setPicked((p) => (next ? [...p, mod] : p.filter((m) => m !== mod)))} label={mod} />
      ))}
    </div>
  );
}

export const gallery: GalleryEntry = {
  title: "Checkbox",
  group: "表单",
  order: 7,
  render: () => (
    <>
      <GalleryRow label="三态">
        <SelectAll />
      </GalleryRow>
      <GalleryRow label="错误 · 禁用">
        <Checkbox checked={false} onChange={() => undefined} label="我已阅读并同意" invalid />
        <Checkbox checked onChange={() => undefined} label="原生禁用" disabled />
        <Checkbox checked={false} onChange={() => undefined} ariaLabel="选择 Sodium" disabledReason="游戏运行中不能修改" />
      </GalleryRow>
    </>
  ),
};
