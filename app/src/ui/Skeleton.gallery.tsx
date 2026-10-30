import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { Card } from "./Card";
import { Skeleton } from "./Skeleton";

export const gallery: GalleryEntry = {
  title: "Skeleton",
  group: "反馈",
  order: 3,
  render: () => (
    <>
      <GalleryRow label="文字行">
        <span style={{ width: 160 }}>
          <Skeleton shape="text" />
        </span>
        <span style={{ width: 240 }}>
          <Skeleton shape="text" lines={3} />
        </span>
      </GalleryRow>
      <GalleryRow label="方块">
        <Skeleton shape="square" size={24} />
        <Skeleton shape="square" size={40} />
        <Skeleton shape="square" size={56} />
        <Skeleton shape="square" size={128} />
      </GalleryRow>
      <GalleryRow label="块">
        <Skeleton shape="block" width={120} height={36} radius="sm" />
        <Skeleton shape="block" width={220} height={56} radius="pill" />
        <Skeleton shape="block" width={160} height={90} radius="lg" />
      </GalleryRow>
      <GalleryRow label="卡片占位">
        <span style={{ width: 360 }}>
          <Card>
            <div aria-busy="true" style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <Skeleton shape="square" size={40} />
              <span style={{ flex: 1 }}>
                <Skeleton shape="text" lines={2} />
              </span>
            </div>
          </Card>
        </span>
      </GalleryRow>
    </>
  ),
};
