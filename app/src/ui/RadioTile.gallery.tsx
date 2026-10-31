import { useState } from "react";
import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { RadioTile, type RadioTileOption } from "./RadioTile";

type Source = "auto" | "official_first" | "mirror_first";
const SOURCES: RadioTileOption<Source>[] = [
  { value: "auto", title: "自动", description: "测速后选更快的源，失败时换另一个", icon: "zap" },
  { value: "official_first", title: "官方源优先", description: "直连官方服务器，海外网络更稳定", icon: "globe", note: "piston-meta.mojang.com" },
  { value: "mirror_first", title: "镜像源优先", description: "国内网络下载更快", icon: "server", note: "bmclapi2.bangbang93.com" },
];

type Isolation = "disabled" | "mod_loaders_only";
const ISOLATION: RadioTileOption<Isolation>[] = [
  { value: "disabled", title: "共用游戏目录", description: "所有实例共用存档、资源包与设置" },
  { value: "mod_loaders_only", title: "装了加载器的实例单独存放", description: "Mod 与配置互不影响", disabled: true },
];

function Live() {
  const [value, setValue] = useState<Source>("auto");
  return (
    <div style={{ width: 780 }}>
      <RadioTile value={value} onChange={setValue} options={SOURCES} ariaLabel="文件下载源" />
    </div>
  );
}

export const gallery: GalleryEntry = {
  title: "RadioTile",
  group: "表单",
  order: 9,
  render: () => (
    <>
      <GalleryRow label="三列（compact 两列）">
        <Live />
      </GalleryRow>
      <GalleryRow label="无图标 · 禁用项">
        <div style={{ width: 520 }}>
          <RadioTile value="disabled" onChange={() => undefined} options={ISOLATION} ariaLabel="版本隔离" />
        </div>
      </GalleryRow>
    </>
  ),
};
