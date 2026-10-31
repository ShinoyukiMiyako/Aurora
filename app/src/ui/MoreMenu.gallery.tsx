import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import type { MenuEntry } from "./Menu";
import { MoreMenu } from "./MoreMenu";

const MOD_ACTIONS: MenuEntry[] = [
  { label: "打开 mods 文件夹", icon: "folder-open", onSelect: () => undefined },
  { label: "在发现页查看", icon: "compass", onSelect: () => undefined },
  { label: "复制文件名", icon: "copy", onSelect: () => undefined },
  { kind: "separator" },
  { label: "移除", icon: "trash", danger: true, onSelect: () => undefined },
];

export const gallery: GalleryEntry = {
  title: "MoreMenu",
  group: "浮层",
  order: 5,
  render: () => (
    <>
      <GalleryRow label="md">
        <MoreMenu items={MOD_ACTIONS} />
      </GalleryRow>
      <GalleryRow label="sm · 行内">
        <MoreMenu items={MOD_ACTIONS} size="sm" />
      </GalleryRow>
    </>
  ),
};
