import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { Logo, SakuraMark } from "./Logo";
import { PetalMark } from "./PetalMark";

export const gallery: GalleryEntry = {
  title: "PetalMark / SakuraMark / Logo",
  group: "原语",
  order: 3,
  render: () => (
    <>
      <GalleryRow label="花瓣徽记 16 母版">
        <PetalMark size={16} />
        <PetalMark size={20} />
      </GalleryRow>
      <GalleryRow label="花瓣徽记 12 母版">
        <PetalMark size={24} />
        <PetalMark size={28} />
      </GalleryRow>
      <GalleryRow label="花瓣徽记整数倍">
        <PetalMark size={32} />
        <PetalMark size={48} />
        <PetalMark size={64} />
      </GalleryRow>
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
