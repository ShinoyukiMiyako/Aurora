import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { Badge, type BadgeTone } from "./Badge";
import { IconButton } from "./IconButton";

const TONES: BadgeTone[] = ["neutral", "accent", "danger"];

export const gallery: GalleryEntry = {
  title: "Badge",
  group: "数据展示",
  order: 2,
  render: () => (
    <>
      <GalleryRow label="计数">
        {TONES.map((tone) => (
          <Badge key={tone} tone={tone} count={3} />
        ))}
        <Badge count={0} />
        <Badge tone="accent" count={42} />
        <Badge tone="danger" count={128} />
      </GalleryRow>
      <GalleryRow label="提醒点">
        {TONES.map((tone) => (
          <Badge key={tone} tone={tone} />
        ))}
      </GalleryRow>
      <GalleryRow label="附着在角上">
        <IconButton icon="download" label="下载任务，3 个进行中" variant="secondary" badge={<Badge tone="accent" count={3} ring />} />
        <IconButton icon="bug" label="崩溃诊断，有新报告" badge={<Badge tone="danger" ring />} />
        <IconButton icon="news" label="资讯，超过 99 条未读" variant="secondary" badge={<Badge tone="neutral" count={150} ring />} />
      </GalleryRow>
    </>
  ),
};
