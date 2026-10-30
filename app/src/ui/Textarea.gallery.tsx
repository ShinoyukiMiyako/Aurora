import { useState } from "react";
import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { Field } from "./Field";
import { Textarea } from "./Textarea";

function JvmArgs() {
  const [value, setValue] = useState("-XX:+UseG1GC -XX:MaxGCPauseMillis=50 -Dfile.encoding=UTF-8");
  return (
    <div style={{ width: 420 }}>
      <Field label="JVM 参数" hint="Ctrl Enter 保存">
        <Textarea value={value} onChange={setValue} mono />
      </Field>
    </div>
  );
}

export const gallery: GalleryEntry = {
  title: "Textarea",
  group: "表单",
  order: 4,
  render: () => (
    <>
      <GalleryRow label="等宽">
        <JvmArgs />
      </GalleryRow>
      <GalleryRow label="错误 · 禁用">
        <div style={{ width: 300 }}>
          <Textarea value={'-Dlog.path="C:\\logs'} onChange={() => undefined} invalid aria-label="错误" />
        </div>
        <div style={{ width: 300 }}>
          <Textarea value="游戏运行中不能修改" onChange={() => undefined} disabled aria-label="禁用" />
        </div>
      </GalleryRow>
    </>
  ),
};
