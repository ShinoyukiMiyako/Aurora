import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { Logo, SakuraMark } from "./Logo";

export const gallery: GalleryEntry = {
  title: "SakuraMark / Logo",
  group: "原语",
  order: 3,
  render: () => (
    <>
      <GalleryRow label="像素母版 16">
        <SakuraMark size={16} />
      </GalleryRow>
      <GalleryRow label="简化形">
        <SakuraMark size={20} />
        <SakuraMark size={24} />
        <SakuraMark size={27} />
      </GalleryRow>
      <GalleryRow label="完整形">
        <SakuraMark size={28} />
        <SakuraMark size={46} />
        <SakuraMark size={64} />
      </GalleryRow>
      <GalleryRow label="单色形">
        <SakuraMark size={20} mono />
        <SakuraMark size={32} mono />
      </GalleryRow>
      <GalleryRow label="组合 S / M">
        <Logo size={20} />
        <Logo size={28} />
      </GalleryRow>
    </>
  ),
};
