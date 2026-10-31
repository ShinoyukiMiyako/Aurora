import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { Card } from "./Card";
import { CardHeader } from "./CardHeader";
import { Inset } from "./Inset";

export const gallery: GalleryEntry = {
  title: "Inset",
  group: "容器",
  order: 5,
  render: () => (
    <GalleryRow label="卡内分组">
      <span style={{ width: 360 }}>
        <Card>
          <CardHeader icon="java" title="Java" subtitle="自动选择" />
          <Inset>
            <div>需要 Java 21</div>
            <div>匹配到 Temurin 21.0.5，64 位</div>
          </Inset>
        </Card>
      </span>
    </GalleryRow>
  ),
};
