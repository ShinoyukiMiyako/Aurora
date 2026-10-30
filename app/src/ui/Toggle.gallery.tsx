import { useState } from "react";
import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { Toggle } from "./Toggle";

function Live({ initial, label, description }: { initial: boolean; label?: string; description?: string }) {
  const [on, setOn] = useState(initial);
  return <Toggle checked={on} onChange={setOn} label={label} description={description} ariaLabel={label === undefined ? "启用 Sodium" : undefined} />;
}

export const gallery: GalleryEntry = {
  title: "Toggle",
  group: "表单",
  order: 6,
  render: () => (
    <>
      <GalleryRow label="带标签">
        <Live initial={false} label="全屏启动" />
        <Live initial label="自动分配内存" description="按 Mod 数量与本机内存推荐" />
      </GalleryRow>
      <GalleryRow label="只有轨道">
        <Live initial />
        <Live initial={false} />
      </GalleryRow>
      <GalleryRow label="禁用">
        <Toggle checked onChange={() => undefined} ariaLabel="原生禁用" disabled />
        <Toggle checked={false} onChange={() => undefined} ariaLabel="带原因" disabledReason="游戏运行中不能修改" />
      </GalleryRow>
    </>
  ),
};
