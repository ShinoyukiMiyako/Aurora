import { useState } from "react";
import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { Menu, type MenuEntry } from "./Menu";

const INSTANCE_ACTIONS: MenuEntry[] = [
  { kind: "group", label: "实例" },
  { label: "打开实例文件夹", icon: "folder-open", onSelect: () => undefined },
  { label: "复制实例", icon: "copy", hint: "Ctrl D", onSelect: () => undefined },
  { label: "导出整合包", icon: "upload", disabled: true, onSelect: () => undefined },
  { label: "重命名", icon: "edit", disabled: true, disabledReason: "游戏正在运行，先结束游戏", onSelect: () => undefined },
  { label: "固定到侧栏", icon: "pin", onSelect: () => undefined },
  { kind: "separator" },
  { label: "删除实例", icon: "trash", danger: true, onSelect: () => undefined },
];

/** 右键菜单：锚点是指针位置，内容与同一对象的「更多操作」一致。 */
function ContextMenuDemo() {
  const [point, setPoint] = useState<{ clientX: number; clientY: number } | null>(null);
  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 320,
          height: 96,
          border: "1px dashed var(--sk-line-2)",
          borderRadius: "var(--sk-r)",
          color: "var(--sk-text-2)",
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          setPoint({ clientX: event.clientX, clientY: event.clientY });
        }}
      >
        在这里点右键
      </div>
      <Menu open={point !== null} anchor={point} onClose={() => setPoint(null)} items={INSTANCE_ACTIONS} openedBy="pointer" aria-label="生存 1.21" />
    </>
  );
}

export const gallery: GalleryEntry = {
  title: "Menu",
  group: "浮层",
  order: 3,
  render: () => (
    <GalleryRow label="右键菜单">
      <ContextMenuDemo />
    </GalleryRow>
  ),
};
