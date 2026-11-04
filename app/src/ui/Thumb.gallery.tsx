import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { Cover } from "./Cover";
import { RemoteImageProvider, type RemoteImageResolver } from "./remote-image";
import { Thumb, type ThumbKind, type ThumbSize } from "./Thumb";

const SIZES: ThumbSize[] = [32, 40, 44, 48, 64, 96];
const KINDS: ThumbKind[] = ["mod", "modpack", "resourcepack", "shader", "datapack", "news", "server"];

/** 陈列用的假图：用当前强调色现画，不依赖网络；颜色取自根上的令牌。 */
function sampleImage(kind: "pixel" | "wide"): string {
  const style = getComputedStyle(document.documentElement);
  const a = style.getPropertyValue("--sk-accent").trim();
  const b = style.getPropertyValue("--sk-accent-2").trim();
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("陈列假图需要 Canvas 2D");
  if (kind === "pixel") {
    canvas.width = 16;
    canvas.height = 16;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        ctx.fillStyle = (x + y) % 3 === 0 ? a : b;
        ctx.fillRect(x, y, 1, 1);
      }
    }
  } else {
    canvas.width = 640;
    canvas.height = 360;
    const gradient = ctx.createLinearGradient(0, 0, 640, 360);
    gradient.addColorStop(0, b);
    gradient.addColorStop(1, a);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 640, 360);
  }
  return canvas.toDataURL();
}

/** 陈列里的地址约定：pixel / wide 给假图，pending 永远在加载，其余一律失败。 */
const resolveSample: RemoteImageResolver = (url) => {
  if (url === "sample:pixel") return Promise.resolve(sampleImage("pixel"));
  if (url === "sample:wide") return Promise.resolve(sampleImage("wide"));
  if (url === "sample:pending") return new Promise<string>(() => undefined);
  return Promise.reject(new Error(`陈列里没有 ${url} 这张图`));
};

export const gallery: GalleryEntry = {
  title: "Thumb / Cover",
  group: "数据展示",
  order: 20,
  render: () => (
    <RemoteImageProvider resolve={resolveSample}>
      <GalleryRow label="无图回落：七种类型">
        {KINDS.map((kind, i) => (
          <Thumb key={kind} url={null} kind={kind} hue={i * 50} size={48} />
        ))}
      </GalleryRow>
      <GalleryRow label="五档尺寸：回落 / 像素风 / 平滑 / 加载中 / 失败">
        {SIZES.map((size) => (
          <Thumb key={`f${size}`} url={null} kind="mod" hue={150} size={size} />
        ))}
        <Thumb url="sample:pixel" kind="mod" hue={0} size={48} />
        <Thumb url="sample:wide" kind="modpack" hue={0} size={64} />
        <Thumb url="sample:pending" kind="mod" hue={0} size={48} />
        <Thumb url="sample:missing" kind="shader" hue={260} size={48} />
        <Thumb url="sample:pixel" kind="mod" hue={0} size={48} inactive />
      </GalleryRow>
      <GalleryRow label="卡面：art（带身份方块）/ remote（下方压暗）/ remote 失败回落 art">
        <span style={{ display: "block", width: 320 }}>
          <Cover hue={345} seed="周末生存" height={132} identity={{ instanceId: "周末生存", cover: { block: "cherry_planks", hue: 345, image: null } }} />
        </span>
        <span style={{ display: "block", width: 320 }}>
          <Cover hue={205} seed="整合包" height={132} remoteUrl="sample:wide" shade="bottom" />
        </span>
        <span style={{ display: "block", width: 320 }}>
          <Cover hue={118} seed="资讯" height={132} remoteUrl="sample:missing" />
        </span>
      </GalleryRow>
    </RemoteImageProvider>
  ),
};
