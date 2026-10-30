import { useState } from "react";
import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import type { ControlSize } from "./Button";
import { TextInput } from "./TextInput";

const SIZES: ControlSize[] = ["sm", "md", "lg"];

function Editable({ size }: { size: ControlSize }) {
  const [value, setValue] = useState("D:\\Games\\.minecraft");
  return <TextInput size={size} icon="folder" value={value} onChange={setValue} clearable aria-label={`游戏目录 ${size}`} />;
}

export const gallery: GalleryEntry = {
  title: "TextInput",
  group: "表单",
  order: 2,
  render: () => (
    <>
      {SIZES.map((size) => (
        <GalleryRow key={size} label={`可清空 · ${size}`}>
          <div style={{ width: 320 }}>
            <Editable size={size} />
          </div>
        </GalleryRow>
      ))}
      <GalleryRow label="单位 · 占位">
        <div style={{ width: 200 }}>
          <TextInput value="4096" onChange={() => undefined} suffix="MB" aria-label="最小内存" />
        </div>
        <div style={{ width: 200 }}>
          <TextInput value="" onChange={() => undefined} placeholder="例如 1920" aria-label="窗口宽度" />
        </div>
      </GalleryRow>
      <GalleryRow label="错误 · 只读 · 禁用">
        <div style={{ width: 200 }}>
          <TextInput value="1.21.4-fabric" onChange={() => undefined} invalid aria-label="错误" />
        </div>
        <div style={{ width: 200 }}>
          <TextInput value="0f3c9a7e" onChange={() => undefined} readOnly aria-label="只读" />
        </div>
        <div style={{ width: 200 }}>
          <TextInput value="游戏运行中" onChange={() => undefined} disabled aria-label="禁用" />
        </div>
      </GalleryRow>
    </>
  ),
};
