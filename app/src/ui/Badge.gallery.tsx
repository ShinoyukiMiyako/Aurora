import { AnimatePresence } from "framer-motion";
import { useState } from "react";
import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { Badge, type BadgeTone } from "./Badge";
import { Button } from "./Button";
import { IconButton } from "./IconButton";

const TONES: BadgeTone[] = ["neutral", "accent", "danger"];

function Toggled() {
  const [count, setCount] = useState(0);
  return (
    <>
      <IconButton
        icon="download"
        label={`下载任务，${count} 个进行中`}
        variant="secondary"
        badge={<AnimatePresence initial={false}>{count > 0 && <Badge key="count" tone="accent" count={count} ring />}</AnimatePresence>}
      />
      <Button size="sm" variant="ghost" onClick={() => setCount((n) => n + 1)}>
        加一个
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setCount(0)}>
        清空
      </Button>
    </>
  );
}

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
      <GalleryRow label="出现与消失">
        <Toggled />
      </GalleryRow>
    </>
  ),
};
