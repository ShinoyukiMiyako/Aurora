import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { Button, type ButtonVariant, type ControlSize } from "./Button";

const VARIANTS: { variant: ButtonVariant; label: string }[] = [
  { variant: "primary", label: "新建实例" },
  { variant: "secondary", label: "打开文件夹" },
  { variant: "ghost", label: "取消" },
  { variant: "danger", label: "删除实例" },
];

const SIZES: ControlSize[] = ["sm", "md", "lg"];

export const gallery: GalleryEntry = {
  title: "Button",
  group: "操作",
  order: 1,
  render: () => (
    <>
      {SIZES.map((size) => (
        <GalleryRow key={size} label={`默认 · ${size}`}>
          {VARIANTS.map(({ variant, label }) => (
            <Button key={variant} variant={variant} size={size}>
              {label}
            </Button>
          ))}
        </GalleryRow>
      ))}
      <GalleryRow label="带图标">
        <Button variant="primary" icon="plus">
          新建实例
        </Button>
        <Button icon="folder">打开文件夹</Button>
        <Button variant="ghost" iconRight="arrow-right">
          全部任务
        </Button>
        <Button variant="danger" icon="trash">
          删除实例
        </Button>
      </GalleryRow>
      <GalleryRow label="禁用">
        {VARIANTS.map(({ variant, label }) => (
          <Button key={variant} variant={variant} disabled>
            {label}
          </Button>
        ))}
        <Button disabledReason="游戏运行中不能修改">带原因的禁用</Button>
      </GalleryRow>
      <GalleryRow label="加载 · 有图标">
        {VARIANTS.map(({ variant, label }) => (
          <Button key={variant} variant={variant} icon="refresh" loading>
            {label}
          </Button>
        ))}
      </GalleryRow>
      <GalleryRow label="加载 · 无图标">
        {VARIANTS.map(({ variant, label }) => (
          <Button key={variant} variant={variant} loading>
            {label}
          </Button>
        ))}
      </GalleryRow>
      <GalleryRow label="撑满">
        <Button variant="primary" size="lg" block>
          登录
        </Button>
      </GalleryRow>
    </>
  ),
};
