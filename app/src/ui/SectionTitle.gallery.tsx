import type { GalleryEntry } from "../dev/gallery-types";
import { Button } from "./Button";
import { SectionTitle } from "./SectionTitle";

export const gallery: GalleryEntry = {
  title: "SectionTitle",
  group: "容器",
  order: 7,
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 720 }}>
      <SectionTitle
        hint="点卡片看详情，点右下角直接开玩"
        right={
          <Button variant="ghost" size="sm" iconRight="arrow-right">
            全部实例
          </Button>
        }
      >
        最近游玩
      </SectionTitle>
      <SectionTitle hint="改动立即生效">外观</SectionTitle>
      <SectionTitle level={3}>没有提示与插槽</SectionTitle>
    </div>
  ),
};
