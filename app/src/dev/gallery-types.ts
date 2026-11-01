// 组件陈列的登记约定：任何目录下的 X.gallery.tsx 导出一个 `gallery`，Gallery 用 import.meta.glob 自动收集，
// 新增组件只写自己的 gallery 文件，不改 Gallery.tsx。陈列只在开发构建里出现。

import type { ReactNode } from "react";

export interface GalleryEntry {
  /** 组件名，即生产代码的导出名。 */
  title: string;
  /** 分组：原语、操作、浮层、表单、容器、数据展示、反馈、美术件等。 */
  group: string;
  /** 组内排序，小的在前；同序再按标题排。 */
  order: number;
  /** 渲染该组件全部状态的陈列；可以使用 hook。 */
  render: () => ReactNode;
}

export interface GalleryModule {
  gallery: GalleryEntry;
}
