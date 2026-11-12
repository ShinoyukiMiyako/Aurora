// 受限富文本的渲染：只画 richtext-parse.ts 节点树里的几种节点，不注入原始 HTML。资源介绍正文与启动器更新说明共用。
// 链接的点击（含中键）一律拦下，交给外壳注入的打开方式：打开外部网址只有一个出口，打开失败有提示。
// 配图与平台图标走同一条远程取图路径（经外壳登记、解码成位图画进 Canvas）：WebView 不直接请求图床，动图只显示首帧。

import { useLayoutEffect, useRef, type MouseEvent, type ReactNode } from "react";
import { prepareDisplayCanvas, useDevicePixelRatio } from "../art/illustrations/canvas";
import { useReflow } from "../lib/reflow";
import { cx } from "../lib/util";
import { useExternalLinkOpener, type ExternalLinkOpener } from "./external-link";
import { useNearViewport, useRemoteImage } from "./remote-image";
import type { Block, ImageSize, Inline } from "./richtext-parse";
import styles from "./RichText.module.css";

/** 配图最宽画到这么宽（CSS px）：再宽也超出正文列，按需缩小显示。 */
export const RICH_IMAGE_MAX_WIDTH = 640;

/** 按原图比例缩到不超过最大宽度；小图不放大。 */
export function richImageSize(naturalWidth: number, naturalHeight: number): { width: number; height: number } {
  const width = Math.min(naturalWidth, RICH_IMAGE_MAX_WIDTH);
  return { width, height: Math.max(1, Math.round((naturalHeight * width) / naturalWidth)) };
}

/**
 * 配图位的显示尺寸。原文写了宽高的（HTML 正文常见）照写的显示，与浏览器对 <img width height> 的处理一致，
 * 取图之前就能把位置占好；没写的只能等解码出原图尺寸，在那之前为 null，不占高度。
 */
export function richImageBox(declared: ImageSize | undefined, natural: ImageSize | null): { width: number; height: number } | null {
  if (declared !== undefined) return richImageSize(declared.width, declared.height);
  return natural === null ? null : richImageSize(natural.width, natural.height);
}

function RichImage({ src, alt, size }: { src: string; alt: string; size: ImageSize | undefined }) {
  const ref = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dpr = useDevicePixelRatio();
  const near = useNearViewport(ref);
  const image = useRemoteImage(src, near, Math.ceil(RICH_IMAGE_MAX_WIDTH * dpr));
  const ready = image.status === "ready";
  const box = richImageBox(size, ready ? { width: image.naturalWidth, height: image.naturalHeight } : null);
  const width = box === null ? 0 : box.width;
  const height = box === null ? 0 : box.height;

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
    <span
      ref={ref}
      className={styles.image}
      data-reserved={size === undefined ? undefined : ""}
      data-ready={ready ? "" : undefined}
      role={ready ? "img" : undefined}
      aria-label={ready ? alt : undefined}
      style={box === null ? undefined : { width: box.width, aspectRatio: `${box.width} / ${box.height}` }}
    >
      {ready && <canvas ref={canvasRef} className={styles.canvas} />}
    </span>
  );
}

/** 中键点击在浏览器里是「新窗口打开」，同样算打开；右键是上下文菜单，不拦。 */
const MIDDLE_BUTTON = 1;

function linkHandlers(href: string, open: ExternalLinkOpener) {
  return {
    onClick(event: MouseEvent<HTMLAnchorElement>) {
      event.preventDefault();
      open(href);
    },
    onAuxClick(event: MouseEvent<HTMLAnchorElement>) {
      if (event.button !== MIDDLE_BUTTON) return;
      event.preventDefault();
      open(href);
    },
  };
}

function renderInline(nodes: readonly Inline[], prefix: string, open: ExternalLinkOpener): ReactNode[] {
  return nodes.map((node, i) => {
    const key = `${prefix}${i}`;
    switch (node.t) {
      case "text":
        return node.v;
      case "strong":
        return <strong key={key}>{renderInline(node.c, `${key}.`, open)}</strong>;
      case "em":
        return <em key={key}>{renderInline(node.c, `${key}.`, open)}</em>;
      case "code":
        return (
          <code key={key} className={styles.inlineCode}>
            {node.v}
          </code>
        );
      case "link":
        // target 只作兜底：万一有绕过点击的打开途径，也交给系统浏览器而不是在启动器窗口里跳走
        return (
          <a key={key} className={styles.link} href={node.href} target="_blank" rel="noreferrer noopener" {...linkHandlers(node.href, open)}>
            {renderInline(node.c, `${key}.`, open)}
          </a>
        );
      case "image":
        return <RichImage key={key} src={node.src} alt={node.alt} size={node.size} />;
      case "br":
        return <br key={key} />;
    }
  });
}

function renderBlocks(blocks: readonly Block[], prefix: string, open: ExternalLinkOpener): ReactNode[] {
  return blocks.map((block, i) => {
    const key = `${prefix}${i}`;
    switch (block.t) {
      case "heading":
        return (
          <h4 key={key} className={styles.heading}>
            {renderInline(block.c, `${key}.`, open)}
          </h4>
        );
      case "p":
        return (
          <p key={key} className={styles.paragraph}>
            {renderInline(block.c, `${key}.`, open)}
          </p>
        );
      case "code":
        return (
          <pre key={key} className={styles.codeBlock}>
            <code>{block.v}</code>
          </pre>
        );
      case "list": {
        const items = block.items.map((item, j) => <li key={`${key}.${j}`}>{renderBlocks(item, `${key}.${j}.`, open)}</li>);
        return block.ordered ? (
          <ol key={key} className={styles.list}>
            {items}
          </ol>
        ) : (
          <ul key={key} className={styles.list}>
            {items}
          </ul>
        );
      }
    }
  });
}

export interface RichTextProps {
  /** 由 parseMarkdown / parseHtml / parseBody 得到的节点树；解析放在调用方，便于按原文缓存。 */
  blocks: readonly Block[];
  className?: string;
}

export function RichText({ blocks, className }: RichTextProps) {
  const open = useExternalLinkOpener();
  // 没写尺寸的配图解码后才撑开所在的块：后面的段落、列表从原位置滑下去，而不是一帧跳过去
  const reflow = useReflow<HTMLDivElement>();
  return (
    <div ref={reflow} className={cx(styles.body, className)}>
      {renderBlocks(blocks, "b", open)}
    </div>
  );
}
