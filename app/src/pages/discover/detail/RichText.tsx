// 介绍正文的渲染：只画受限节点树里的几种节点，不注入原始 HTML。
// 链接以 target="_blank" 打开：桌面端由系统浏览器接管，不在启动器窗口里跳转。
// 配图与平台图标走同一条远程取图路径（经外壳登记、解码成位图画进 Canvas）：WebView 不直接请求平台图床，动图只显示首帧。

import { useLayoutEffect, useRef, type ReactNode } from "react";
import { prepareDisplayCanvas, useDevicePixelRatio } from "../../../art/illustrations/canvas";
import { useNearViewport, useRemoteImage } from "../../../ui/remote-image";
import type { Block, Inline } from "../richtext";
import styles from "./detail.module.css";

/** 配图最宽画到这么宽（CSS px）：再宽也超出正文列，按需缩小显示。 */
const BODY_IMAGE_MAX_WIDTH = 640;

/** 按原图比例缩到不超过最大宽度；小图不放大。 */
export function bodyImageSize(naturalWidth: number, naturalHeight: number): { width: number; height: number } {
  const width = Math.min(naturalWidth, BODY_IMAGE_MAX_WIDTH);
  return { width, height: Math.max(1, Math.round((naturalHeight * width) / naturalWidth)) };
}

function BodyImage({ src, alt }: { src: string; alt: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dpr = useDevicePixelRatio();
  const near = useNearViewport(ref);
  const image = useRemoteImage(src, near, Math.ceil(BODY_IMAGE_MAX_WIDTH * dpr));
  const size = image.status === "ready" ? bodyImageSize(image.naturalWidth, image.naturalHeight) : null;
  const width = size === null ? 0 : size.width;
  const height = size === null ? 0 : size.height;

  useLayoutEffect(() => {
    if (image.status !== "ready") return;
    const canvas = canvasRef.current;
    if (canvas === null) throw new Error("正文配图的 <canvas> 尚未挂载");
    const { bitmap } = image;
    prepareDisplayCanvas(canvas, width, height, dpr, true).drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, 0, canvas.width, canvas.height);
  }, [image, width, height, dpr]);

  // 取不到的图不占位、不显示裂图：当这张图不存在
  if (image.status === "failed") return null;
  return (
    <span ref={ref} className={styles.bodyImage} role={size === null ? undefined : "img"} aria-label={size === null ? undefined : alt}>
      {size !== null && <canvas ref={canvasRef} className={styles.bodyCanvas} style={{ width: size.width, aspectRatio: `${size.width} / ${size.height}` }} />}
    </span>
  );
}

function renderInline(nodes: readonly Inline[], prefix: string): ReactNode[] {
  return nodes.map((node, i) => {
    const key = `${prefix}${i}`;
    switch (node.t) {
      case "text":
        return node.v;
      case "strong":
        return <strong key={key}>{renderInline(node.c, `${key}.`)}</strong>;
      case "em":
        return <em key={key}>{renderInline(node.c, `${key}.`)}</em>;
      case "code":
        return (
          <code key={key} className={styles.inlineCode}>
            {node.v}
          </code>
        );
      case "link":
        return (
          <a key={key} className={styles.bodyLink} href={node.href} target="_blank" rel="noreferrer noopener">
            {renderInline(node.c, `${key}.`)}
          </a>
        );
      case "image":
        return <BodyImage key={key} src={node.src} alt={node.alt} />;
      case "br":
        return <br key={key} />;
    }
  });
}

function renderBlocks(blocks: readonly Block[], prefix: string): ReactNode[] {
  return blocks.map((block, i) => {
    const key = `${prefix}${i}`;
    switch (block.t) {
      case "heading":
        return (
          <h4 key={key} className={styles.bodyHeading}>
            {renderInline(block.c, `${key}.`)}
          </h4>
        );
      case "p":
        return (
          <p key={key} className={styles.bodyParagraph}>
            {renderInline(block.c, `${key}.`)}
          </p>
        );
      case "code":
        return (
          <pre key={key} className={styles.codeBlock}>
            <code>{block.v}</code>
          </pre>
        );
      case "list": {
        const items = block.items.map((item, j) => <li key={`${key}.${j}`}>{renderBlocks(item, `${key}.${j}.`)}</li>);
        return block.ordered ? (
          <ol key={key} className={styles.bodyList}>
            {items}
          </ol>
        ) : (
          <ul key={key} className={styles.bodyList}>
            {items}
          </ul>
        );
      }
    }
  });
}

export function RichText({ blocks }: { blocks: readonly Block[] }) {
  return <div className={styles.body}>{renderBlocks(blocks, "b")}</div>;
}
