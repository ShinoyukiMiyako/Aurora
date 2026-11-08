import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { GalleryEntry } from "../../dev/gallery-types";
import { GalleryRow } from "../../dev/GalleryKit";
import { prepareDisplayCanvas, useDevicePixelRatio } from "../illustrations/canvas";
import { figureParts, REST_POSE, type BoxFace, type SkinFormat, type SkinRect } from "./figure3d";
import { FIGURE_FRAME, type FigureScale, type SkinModel } from "./layout";
import { paintSkinFigure, type LoadedSkin } from "./render";
import { SpinningFigure } from "./SpinningFigure";

// 演示皮肤全部由代码画出，不用原版材质。左右、前后都故意不对称（只有玩家左胸有徽章、只有帽子左侧有发带、
// 只有左袖有袖标），UV 方向或镜像错了一眼能看出来；外层带透明洞，用来检查洞里露出的内层与外层内壁。

type Rgba = readonly [r: number, g: number, b: number, a: number];

const CLEAR: Rgba = [0, 0, 0, 0];
const SKIN_TONE: Rgba = [232, 190, 160, 255];
const HAIR: Rgba = [84, 52, 44, 255];
const SHIRT: Rgba = [207, 48, 128, 255];
const SHIRT_BACK: Rgba = [150, 34, 96, 255];
const PANTS: Rgba = [62, 74, 120, 255];
const SHOE: Rgba = [46, 40, 44, 255];
const WHITE: Rgba = [244, 244, 240, 255];
const IRIS: Rgba = [50, 110, 190, 255];
const MOUTH: Rgba = [170, 90, 90, 255];
const BADGE: Rgba = [250, 210, 80, 255];
const JACKET: Rgba = [50, 150, 120, 255];
const CUFF: Rgba = [240, 240, 120, 255];
const RIBBON: Rgba = [240, 120, 170, 255];

function makeCanvas(width: number, height: number) {
  const data = new Uint8ClampedArray(width * height * 4);
  const dot = (x: number, y: number, color: Rgba) => data.set(color, (y * width + x) * 4);
  const fill = (r: SkinRect, color: Rgba) => {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) dot(x, y, color);
  };
  return { data, dot, fill };
}

function demoSkin(format: SkinFormat, model: SkinModel): ImageData {
  const height = format === "modern" ? 64 : 32;
  const { data, dot, fill } = makeCanvas(64, height);
  const uvOf = (name: string, layer: "inner" | "outer"): Readonly<Record<BoxFace, SkinRect>> | null => {
    const part = figureParts(format, model, true).find((p) => p.name === name);
    return part?.boxes.find((b) => b.layer === layer)?.uv ?? null;
  };
  const allFaces = (uv: Readonly<Record<BoxFace, SkinRect>>, color: Rgba) => {
    for (const r of Object.values(uv)) fill(r, color);
  };
  const required = (name: string, layer: "inner" | "outer") => {
    const uv = uvOf(name, layer);
    if (uv === null) throw new Error(`演示皮肤缺少 ${name} 的 ${layer}`);
    return uv;
  };

  const head = required("head", "inner");
  allFaces(head, SKIN_TONE);
  fill(head.top, HAIR);
  fill(head.back, HAIR);
  for (const face of ["front", "left", "right"] as const) fill({ ...head[face], h: 2 }, HAIR);
  dot(head.front.x + 1, head.front.y + 4, WHITE);
  dot(head.front.x + 2, head.front.y + 4, IRIS);
  dot(head.front.x + 5, head.front.y + 4, IRIS);
  dot(head.front.x + 6, head.front.y + 4, WHITE);
  fill({ x: head.front.x + 3, y: head.front.y + 6, w: 2, h: 1 }, MOUTH);

  const body = required("body", "inner");
  allFaces(body, SHIRT);
  fill(body.back, SHIRT_BACK);
  // 玩家左胸：正面贴图的右半边
  fill({ x: body.front.x + 5, y: body.front.y + 2, w: 2, h: 2 }, BADGE);

  for (const arm of ["rightArm", "leftArm"]) {
    const uv = required(arm, "inner");
    allFaces(uv, SKIN_TONE);
    for (const face of ["front", "left", "right", "back"] as const) fill({ ...uv[face], h: 4 }, SHIRT);
    fill(uv.top, SHIRT);
  }

  for (const leg of ["rightLeg", "leftLeg"]) {
    const uv = required(leg, "inner");
    allFaces(uv, PANTS);
    for (const face of ["front", "left", "right", "back"] as const) fill({ x: uv[face].x, y: uv[face].y + 9, w: uv[face].w, h: 3 }, SHOE);
    fill(uv.bottom, SHOE);
  }

  // 帽子层：一圈带缺口的刘海，顶上棋盘格漏洞，只有玩家左侧有发带
  const hat = required("head", "outer");
  for (const face of ["front", "left", "right", "back"] as const) {
    const r = hat[face];
    for (let x = r.x; x < r.x + r.w; x++) if ((x - r.x) % 3 !== 2) dot(x, r.y + 1, HAIR);
  }
  for (let y = hat.top.y; y < hat.top.y + hat.top.h; y++) for (let x = hat.top.x; x < hat.top.x + hat.top.w; x++) if ((x + y) % 2 === 0) dot(x, y, HAIR);
  fill({ x: hat.left.x + 2, y: hat.left.y + 2, w: 4, h: 2 }, RIBBON);

  if (format === "modern") {
    // 敞开的外套：门襟留空，露出里面的衬衫和徽章；背面开一个大洞
    const jacket = required("body", "outer");
    allFaces(jacket, JACKET);
    fill({ x: jacket.front.x + 3, y: jacket.front.y, w: 2, h: 12 }, CLEAR);
    fill({ x: jacket.front.x + 5, y: jacket.front.y + 1, w: 3, h: 4 }, CLEAR);
    fill({ x: jacket.back.x + 2, y: jacket.back.y + 3, w: 4, h: 6 }, CLEAR);

    const rightSleeve = required("rightArm", "outer");
    const leftSleeve = required("leftArm", "outer");
    for (const face of ["front", "left", "right", "back"] as const) {
      fill({ ...rightSleeve[face], h: 3 }, JACKET);
      fill({ ...leftSleeve[face], h: 3 }, JACKET);
    }
    fill({ x: leftSleeve.left.x, y: leftSleeve.left.y + 6, w: leftSleeve.left.w, h: 2 }, CUFF);

    for (const leg of ["rightLeg", "leftLeg"]) {
      const uv = required(leg, "outer");
      for (const face of ["front", "left", "right", "back"] as const) {
        const r = uv[face];
        for (let y = r.y; y < r.y + r.h; y += 4) fill({ x: r.x, y, w: r.w, h: 1 }, WHITE);
      }
    }
  }
  const image = new ImageData(64, height);
  image.data.set(data);
  return image;
}

function useDemoSkin(format: SkinFormat, model: SkinModel, hat: boolean): LoadedSkin | null {
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  useEffect(() => {
    let live = true;
    void createImageBitmap(demoSkin(format, model)).then((next) => {
      if (live) setBitmap(next);
    });
    return () => {
      live = false;
    };
  }, [format, model]);
  return bitmap === null ? null : { bitmap, format, hat, model };
}

function DraggableFigure({ skin, scale }: { skin: LoadedSkin | null; scale: FigureScale }) {
  const dpr = useDevicePixelRatio();
  return skin === null ? null : <SpinningFigure skin={skin} scale={scale} dpr={dpr} />;
}

function PosedFigure({ skin, yaw, scale }: { skin: LoadedSkin | null; yaw: number; scale: FigureScale }) {
  const dpr = useDevicePixelRatio();
  const ref = useRef<HTMLCanvasElement>(null);
  const width = FIGURE_FRAME.width * scale;
  const height = FIGURE_FRAME.height * scale;
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (canvas === null || skin === null) return;
    paintSkinFigure(prepareDisplayCanvas(canvas, width, height, dpr, false), skin, { yaw, pitch: REST_POSE.pitch }, scale * dpr);
  }, [dpr, height, scale, skin, width, yaw]);
  return <canvas ref={ref} style={{ width, height }} aria-hidden="true" />;
}

function Figures() {
  const modern = useDemoSkin("modern", "wide", true);
  const legacy = useDemoSkin("legacy", "wide", true);
  const slim = useDemoSkin("modern", "slim", true);
  const noHat = useDemoSkin("modern", "wide", false);
  const scales: FigureScale[] = [4, 5, 6];
  const yaws = [-180, -135, -90, -45, 0, 45, 90, 135];
  return (
    <>
      <GalleryRow label="modern / legacy / slim / 无帽子，可拖动转身">
        <DraggableFigure skin={modern} scale={6} />
        <DraggableFigure skin={legacy} scale={6} />
        <DraggableFigure skin={slim} scale={6} />
        <DraggableFigure skin={noHat} scale={6} />
      </GalleryRow>
      <GalleryRow label="4 / 5 / 6 档">
        {scales.map((scale) => (
          <DraggableFigure key={scale} skin={modern} scale={scale} />
        ))}
      </GalleryRow>
      <GalleryRow label="一圈朝向：背面看外套破洞，左袖袖标与胸前徽章只在玩家左侧">
        {yaws.map((deg) => (
          <PosedFigure key={deg} skin={modern} yaw={(deg * Math.PI) / 180} scale={4} />
        ))}
      </GalleryRow>
      <GalleryRow label="旧格式一圈朝向：左臂左腿是右侧的镜像">
        {yaws.map((deg) => (
          <PosedFigure key={deg} skin={legacy} yaw={(deg * Math.PI) / 180} scale={4} />
        ))}
      </GalleryRow>
    </>
  );
}

export const gallery: GalleryEntry = {
  title: "AccountFigure 3D 立绘",
  group: "美术件",
  order: 6,
  render: () => <Figures />,
};
