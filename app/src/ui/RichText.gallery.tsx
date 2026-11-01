import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { ExternalLinkProvider } from "./external-link";
import { RemoteImageProvider } from "./remote-image";
import { parseHtml, parseMarkdown } from "./richtext-parse";
import { RichText } from "./RichText";

const NOTES = parseMarkdown(`## 0.2.1

- 发现页支持按实例筛选
- 修复 \`config.json\` 损坏时无法启动的问题
- 下载任务页的总进度环在没有任务时显示「--」

详见 [发布页](https://example.com/releases)。

\`\`\`
-XX:+UseZGC -XX:+ZGenerational
\`\`\``);

const DESCRIPTION = parseHtml(`<h1>Sodium</h1><p>一款<strong>现代化</strong>的渲染引擎，<em>大幅</em>提升帧率。</p><ol><li>兼容 Fabric</li><li>开箱即用</li></ol><p><a href="https://modrinth.com/mod/sodium">项目主页</a></p>`);

// 陈列里没有外壳登记取图的通道：配图一律当取不到，不显示
const noImages = () => Promise.reject(new Error("陈列不取远程图"));

// 陈列跑在开发服务器的浏览器页里，链接直接开新标签页即可
const openInTab = (url: string) => {
  window.open(url, "_blank", "noopener,noreferrer");
};

export const gallery: GalleryEntry = {
  title: "RichText",
  group: "数据展示",
  order: 20,
  render: () => (
    <RemoteImageProvider resolve={noImages}>
      <ExternalLinkProvider open={openInTab}>
        <GalleryRow label="更新说明">
          <div style={{ width: 480 }}>
            <RichText blocks={NOTES} />
          </div>
        </GalleryRow>
        <GalleryRow label="介绍正文">
          <div style={{ width: 480 }}>
            <RichText blocks={DESCRIPTION} />
          </div>
        </GalleryRow>
      </ExternalLinkProvider>
    </RemoteImageProvider>
  ),
};
