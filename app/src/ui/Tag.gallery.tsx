import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { Tag, type TagTone } from "./Tag";

const TONES: { tone: TagTone; label: string }[] = [
  { tone: "neutral", label: "本地文件" },
  { tone: "accent", label: "可更新到 0.6.13" },
  { tone: "ok", label: "Modrinth" },
  { tone: "warn", label: "CurseForge" },
  { tone: "danger", label: "不兼容" },
  { tone: "info", label: "前置" },
  { tone: "outline", label: "已撤销" },
];

export const gallery: GalleryEntry = {
  title: "Tag",
  group: "数据展示",
  order: 1,
  render: () => (
    <>
      {(["md", "sm"] as const).map((size) => (
        <GalleryRow key={size} label={`色调 · ${size}`}>
          {TONES.map(({ tone, label }) => (
            <Tag key={tone} tone={tone} size={size}>
              {label}
            </Tag>
          ))}
        </GalleryRow>
      ))}
      {(["md", "sm"] as const).map((size) => (
        <GalleryRow key={size} label={`带图标 · ${size}`}>
          <Tag tone="ok" size={size} icon="globe">
            Modrinth
          </Tag>
          <Tag tone="warn" size={size} icon="globe">
            CurseForge
          </Tag>
          <Tag size={size} icon="folder">
            本地文件
          </Tag>
          <Tag tone="info" size={size} icon="link">
            前置 · 由 Sodium 带入
          </Tag>
        </GalleryRow>
      ))}
    </>
  ),
};
