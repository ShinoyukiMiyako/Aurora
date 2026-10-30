import { useState } from "react";
import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import type { ControlSize } from "./Button";
import { IconButton, type IconButtonVariant } from "./IconButton";

const VARIANTS: IconButtonVariant[] = ["ghost", "secondary", "danger"];
const SIZES: ControlSize[] = ["sm", "md", "lg"];

function ToggleDemo() {
  const [on, setOn] = useState(false);
  return <IconButton icon="eye" label={on ? "隐藏密码" : "显示密码"} pressed={on} onClick={() => setOn((v) => !v)} />;
}

export const gallery: GalleryEntry = {
  title: "IconButton",
  group: "操作",
  order: 2,
  render: () => (
    <>
      {SIZES.map((size) => (
        <GalleryRow key={size} label={`默认 · ${size}`}>
          {VARIANTS.map((variant) => (
            <IconButton key={variant} icon={variant === "danger" ? "trash" : "copy"} label={variant === "danger" ? "移除" : "复制路径"} variant={variant} size={size} />
          ))}
        </GalleryRow>
      ))}
      <GalleryRow label="切换型">
        <ToggleDemo />
        <IconButton icon="pin" label="固定到侧栏" pressed />
      </GalleryRow>
      <GalleryRow label="菜单展开中">
        <IconButton icon="more" label="更多操作" aria-haspopup="menu" aria-expanded data-open="" />
      </GalleryRow>
      <GalleryRow label="禁用">
        {VARIANTS.map((variant) => (
          <IconButton key={variant} icon="folder" label="打开文件夹" variant={variant} disabled />
        ))}
      </GalleryRow>
      <GalleryRow label="无提示">
        <IconButton icon="x" label="关闭通知" size="sm" tooltip={false} />
      </GalleryRow>
    </>
  ),
};
