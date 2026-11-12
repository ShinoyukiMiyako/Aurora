import { describe, expect, it } from "vitest";
import { applyMatrix } from "../iso/geometry";
import {
  boxUv,
  faceShade,
  figureParts,
  figureQuads,
  partOrder,
  releaseVelocity,
  releaseYaw,
  REST_POSE,
  viewDirection,
  wrapAngle,
  type BoxFace,
  type FigurePartName,
  type FigurePose,
  type FigureQuad,
  type SkinFormat,
  type Vec3,
} from "./figure3d";
import { FIGURE_FRAME, FIGURE_FRAME_PAD, FIGURE_SIZE, type SkinModel } from "./layout";

const deg = (d: number) => (d * Math.PI) / 180;

type Rects = Readonly<Record<BoxFace, readonly [x: number, y: number, w: number, h: number]>>;

// 下面的矩形按 Minecraft 皮肤格式逐个手抄，不经过 boxUv 计算：测试和实现共用一个公式就什么也没验证
const HEAD: Rects = { top: [8, 0, 8, 8], bottom: [16, 0, 8, 8], right: [0, 8, 8, 8], front: [8, 8, 8, 8], left: [16, 8, 8, 8], back: [24, 8, 8, 8] };
const HAT: Rects = { top: [40, 0, 8, 8], bottom: [48, 0, 8, 8], right: [32, 8, 8, 8], front: [40, 8, 8, 8], left: [48, 8, 8, 8], back: [56, 8, 8, 8] };
const BODY: Rects = { top: [20, 16, 8, 4], bottom: [28, 16, 8, 4], right: [16, 20, 4, 12], front: [20, 20, 8, 12], left: [28, 20, 4, 12], back: [32, 20, 8, 12] };
const JACKET: Rects = { top: [20, 32, 8, 4], bottom: [28, 32, 8, 4], right: [16, 36, 4, 12], front: [20, 36, 8, 12], left: [28, 36, 4, 12], back: [32, 36, 8, 12] };
const RIGHT_LEG: Rects = { top: [4, 16, 4, 4], bottom: [8, 16, 4, 4], right: [0, 20, 4, 12], front: [4, 20, 4, 12], left: [8, 20, 4, 12], back: [12, 20, 4, 12] };
const RIGHT_PANTS: Rects = { top: [4, 32, 4, 4], bottom: [8, 32, 4, 4], right: [0, 36, 4, 12], front: [4, 36, 4, 12], left: [8, 36, 4, 12], back: [12, 36, 4, 12] };
const LEFT_LEG: Rects = { top: [20, 48, 4, 4], bottom: [24, 48, 4, 4], right: [16, 52, 4, 12], front: [20, 52, 4, 12], left: [24, 52, 4, 12], back: [28, 52, 4, 12] };
const LEFT_PANTS: Rects = { top: [4, 48, 4, 4], bottom: [8, 48, 4, 4], right: [0, 52, 4, 12], front: [4, 52, 4, 12], left: [8, 52, 4, 12], back: [12, 52, 4, 12] };

const WIDE_RIGHT_ARM: Rects = { top: [44, 16, 4, 4], bottom: [48, 16, 4, 4], right: [40, 20, 4, 12], front: [44, 20, 4, 12], left: [48, 20, 4, 12], back: [52, 20, 4, 12] };
const WIDE_RIGHT_SLEEVE: Rects = { top: [44, 32, 4, 4], bottom: [48, 32, 4, 4], right: [40, 36, 4, 12], front: [44, 36, 4, 12], left: [48, 36, 4, 12], back: [52, 36, 4, 12] };
const WIDE_LEFT_ARM: Rects = { top: [36, 48, 4, 4], bottom: [40, 48, 4, 4], right: [32, 52, 4, 12], front: [36, 52, 4, 12], left: [40, 52, 4, 12], back: [44, 52, 4, 12] };
const WIDE_LEFT_SLEEVE: Rects = { top: [52, 48, 4, 4], bottom: [56, 48, 4, 4], right: [48, 52, 4, 12], front: [52, 52, 4, 12], left: [56, 52, 4, 12], back: [60, 52, 4, 12] };

const SLIM_RIGHT_ARM: Rects = { top: [44, 16, 3, 4], bottom: [47, 16, 3, 4], right: [40, 20, 4, 12], front: [44, 20, 3, 12], left: [47, 20, 4, 12], back: [51, 20, 3, 12] };
const SLIM_RIGHT_SLEEVE: Rects = { top: [44, 32, 3, 4], bottom: [47, 32, 3, 4], right: [40, 36, 4, 12], front: [44, 36, 3, 12], left: [47, 36, 4, 12], back: [51, 36, 3, 12] };
const SLIM_LEFT_ARM: Rects = { top: [36, 48, 3, 4], bottom: [39, 48, 3, 4], right: [32, 52, 4, 12], front: [36, 52, 3, 12], left: [39, 52, 4, 12], back: [43, 52, 3, 12] };
const SLIM_LEFT_SLEEVE: Rects = { top: [52, 48, 3, 4], bottom: [55, 48, 3, 4], right: [48, 52, 4, 12], front: [52, 52, 3, 12], left: [55, 52, 4, 12], back: [59, 52, 3, 12] };

/** 旧格式左侧：右侧贴图镜像后，外侧面落在 +x，左右两个面的矩形对调。 */
const swapSides = (r: Rects): Rects => ({ ...r, left: r.right, right: r.left });

const rectsOf = (format: SkinFormat, model: SkinModel, hat: boolean, name: FigurePartName, layer: "inner" | "outer") => {
  const box = figureParts(format, model, hat)
    .find((p) => p.name === name)
    ?.boxes.find((b) => b.layer === layer);
  if (!box) return null;
  return Object.fromEntries(Object.entries(box.uv).map(([face, r]) => [face, [r.x, r.y, r.w, r.h]]));
};

describe("皮肤 UV 对照 Minecraft 布局", () => {
  const modern: [model: SkinModel, name: FigurePartName, inner: Rects, outer: Rects][] = [
    ["wide", "head", HEAD, HAT],
    ["wide", "body", BODY, JACKET],
    ["wide", "rightArm", WIDE_RIGHT_ARM, WIDE_RIGHT_SLEEVE],
    ["wide", "leftArm", WIDE_LEFT_ARM, WIDE_LEFT_SLEEVE],
    ["wide", "rightLeg", RIGHT_LEG, RIGHT_PANTS],
    ["wide", "leftLeg", LEFT_LEG, LEFT_PANTS],
    ["slim", "head", HEAD, HAT],
    ["slim", "body", BODY, JACKET],
    ["slim", "rightArm", SLIM_RIGHT_ARM, SLIM_RIGHT_SLEEVE],
    ["slim", "leftArm", SLIM_LEFT_ARM, SLIM_LEFT_SLEEVE],
    ["slim", "rightLeg", RIGHT_LEG, RIGHT_PANTS],
    ["slim", "leftLeg", LEFT_LEG, LEFT_PANTS],
  ];

  it.each(modern)("新格式 %s 体型的 %s：内外两层六个面", (model, name, inner, outer) => {
    expect(rectsOf("modern", model, true, name, "inner")).toEqual(inner);
    expect(rectsOf("modern", model, true, name, "outer")).toEqual(outer);
  });

  const legacy: [model: SkinModel, name: FigurePartName, inner: Rects][] = [
    ["wide", "head", HEAD],
    ["wide", "body", BODY],
    ["wide", "rightArm", WIDE_RIGHT_ARM],
    ["wide", "leftArm", swapSides(WIDE_RIGHT_ARM)],
    ["wide", "rightLeg", RIGHT_LEG],
    ["wide", "leftLeg", swapSides(RIGHT_LEG)],
    ["slim", "rightArm", SLIM_RIGHT_ARM],
    ["slim", "leftArm", swapSides(SLIM_RIGHT_ARM)],
  ];

  it.each(legacy)("旧格式 %s 体型的 %s：左侧取右侧贴图", (model, name, inner) => {
    expect(rectsOf("legacy", model, true, name, "inner")).toEqual(inner);
  });

  it("所有矩形都落在各自格式的贴图内", () => {
    for (const [format, height] of [["modern", 64], ["legacy", 32]] as const) {
      for (const model of ["wide", "slim"] as const) {
        for (const part of figureParts(format, model, true)) {
          for (const box of part.boxes) {
            for (const r of Object.values(box.uv)) {
              expect(r.x).toBeGreaterThanOrEqual(0);
              expect(r.y).toBeGreaterThanOrEqual(0);
              expect(r.x + r.w).toBeLessThanOrEqual(64);
              expect(r.y + r.h).toBeLessThanOrEqual(height);
            }
          }
        }
      }
    }
  });

  it("boxUv 的六个面在展开图上首尾相接", () => {
    const uv = boxUv(0, 0, 8, 8, 8);
    expect(uv.right.x + uv.right.w).toBe(uv.front.x);
    expect(uv.front.x + uv.front.w).toBe(uv.left.x);
    expect(uv.left.x + uv.left.w).toBe(uv.back.x);
    expect(uv.top.y + uv.top.h).toBe(uv.front.y);
  });
});

describe("盒子尺寸与外层膨胀", () => {
  const size = (min: Vec3, max: Vec3) => [max[0] - min[0], max[1] - min[1], max[2] - min[2]];

  it("内层尺寸：头 8x8x8、身体 8x12x4、手臂宽 4 或窄 3、腿 4x12x4", () => {
    const inner = (model: SkinModel) =>
      Object.fromEntries(figureParts("modern", model, true).map((p) => [p.name, size(p.boxes[0].min, p.boxes[0].max)]));
    expect(inner("wide")).toEqual({
      head: [8, 8, 8],
      body: [8, 12, 4],
      rightArm: [4, 12, 4],
      leftArm: [4, 12, 4],
      rightLeg: [4, 12, 4],
      leftLeg: [4, 12, 4],
    });
    expect(inner("slim").rightArm).toEqual([3, 12, 4]);
    expect(inner("slim").leftArm).toEqual([3, 12, 4]);
  });

  it.each([
    ["head", 0.5],
    ["body", 0.25],
    ["rightArm", 0.25],
    ["leftArm", 0.25],
    ["rightLeg", 0.25],
    ["leftLeg", 0.25],
  ] as const)("%s 外层每个方向比内层大 %s", (name, grow) => {
    const part = figureParts("modern", "wide", true).find((p) => p.name === name);
    if (!part) throw new Error(name);
    const [inner, outer] = part.boxes;
    for (const axis of [0, 1, 2]) {
      expect(inner.min[axis] - outer.min[axis]).toBeCloseTo(grow, 10);
      expect(outer.max[axis] - inner.max[axis]).toBeCloseTo(grow, 10);
    }
  });

  it("身体站在脚底原点上，总高 32，宽体型双臂到 x = ±8", () => {
    const parts = figureParts("modern", "wide", false);
    const inner = Object.fromEntries(parts.map((p) => [p.name, p.boxes[0]]));
    expect(inner.rightLeg.min).toEqual([-4, 0, -2]);
    expect(inner.leftLeg.max).toEqual([4, 12, 2]);
    expect(inner.head.max[1]).toBe(32);
    expect(inner.rightArm.min[0]).toBe(-8);
    expect(inner.leftArm.max[0]).toBe(8);
  });

  it("旧格式只有帽子层，身体与四肢没有外层，左臂左腿标记镜像", () => {
    const parts = figureParts("legacy", "wide", true);
    expect(parts.filter((p) => p.boxes.some((b) => b.layer === "outer")).map((p) => p.name)).toEqual(["head"]);
    expect(parts.filter((p) => p.boxes.some((b) => b.mirror)).map((p) => p.name)).toEqual(["leftArm", "leftLeg"]);
    expect(figureParts("modern", "wide", true).some((p) => p.boxes.some((b) => b.mirror))).toBe(false);
  });

  it("hat 为假时没有帽子盒，新格式其余外层照旧", () => {
    expect(rectsOf("modern", "wide", false, "head", "outer")).toBeNull();
    expect(rectsOf("legacy", "wide", false, "head", "outer")).toBeNull();
    expect(rectsOf("modern", "wide", false, "body", "outer")).toEqual(JACKET);
    const quads = figureQuads("modern", "wide", false, REST_POSE);
    expect(quads.filter((q) => q.part === "head").map((q) => q.layer)).toEqual(["inner", "inner", "inner"]);
    expect(quads.some((q) => q.uv.x >= 32 && q.uv.y < 16)).toBe(false);
  });
});

const quadOf = (quads: FigureQuad[], part: FigurePartName, layer: "inner" | "outer", face: BoxFace, side: FigureQuad["side"] = "front") => {
  const quad = quads.find((q) => q.part === part && q.layer === layer && q.face === face && q.side === side);
  if (!quad) throw new Error(`${part} ${layer} ${face} ${side} 不在绘制列表里`);
  return quad;
};

describe("面的方向", () => {
  it("正对观察者：头部正面贴图左上角在外框 (6, 2)，一像素对一单位，不翻转", () => {
    const quads = figureQuads("modern", "wide", true, { yaw: 0, pitch: 0 });
    const [a, b, c, d, e, f] = quadOf(quads, "head", "inner", "front").matrix;
    expect([a, b, c, d]).toEqual([1, 0, 0, 1]);
    expect(e).toBeCloseTo(FIGURE_FRAME.width / 2 - 4, 10);
    expect(f).toBeCloseTo(FIGURE_FRAME.height - FIGURE_FRAME_PAD - 32, 10);
  });

  it.each([
    ["front", 0],
    ["left", -90],
    ["back", 180],
    ["right", 90],
  ] as const)("转到正对 %s 面时贴图不是镜像的（yaw %s 度）", (face, yaw) => {
    const quads = figureQuads("modern", "wide", true, { yaw: deg(yaw), pitch: 0 });
    const [a, , , d] = quadOf(quads, "head", "inner", face).matrix;
    expect(a).toBeCloseTo(1, 10);
    expect(d).toBeCloseTo(1, 10);
  });

  it("正上方俯视：顶面贴图向右是玩家左手方向，贴图下缘朝玩家前方", () => {
    const quads = figureQuads("modern", "wide", true, { yaw: 0, pitch: deg(90) });
    const [a, , , d] = quadOf(quads, "head", "inner", "top").matrix;
    expect(a).toBeCloseTo(1, 10);
    expect(d).toBeCloseTo(1, 10);
  });

  it("底面和顶面同向：贴图下缘同样朝前，从下往上看时才是上下颠倒的", () => {
    const quads = figureQuads("modern", "wide", true, { yaw: 0, pitch: deg(90) });
    const bottom = quadOf(quads, "head", "outer", "bottom", "back");
    expect(bottom.uv).toEqual({ x: 48, y: 0, w: 8, h: 8 });
    // 帽子盒比贴图大：9 个单位铺 8 格贴图
    expect(bottom.matrix[0]).toBeCloseTo(9 / 8, 10);
    expect(bottom.matrix[3]).toBeCloseTo(9 / 8, 10);
  });
});

describe("旧格式镜像", () => {
  const corners = (q: FigureQuad) => [applyMatrix(q.matrix, 0, 0), applyMatrix(q.matrix, q.uv.w, 0), applyMatrix(q.matrix, q.uv.w, q.uv.h), applyMatrix(q.matrix, 0, q.uv.h)];

  it("正面：同一块贴图，贴图向右变成世界 -x", () => {
    const quads = figureQuads("legacy", "wide", true, { yaw: 0, pitch: 0 });
    const right = quadOf(quads, "rightArm", "inner", "front");
    const left = quadOf(quads, "leftArm", "inner", "front");
    expect(left.uv).toEqual(right.uv);
    expect(right.matrix[0]).toBeGreaterThan(0);
    expect(left.matrix[0]).toBeLessThan(0);
  });

  it.each([
    ["leftArm", "rightArm"],
    ["leftLeg", "rightLeg"],
  ] as const)("%s 的每个贴图角都是 %s 对应角沿中线的镜像", (mirrored, source) => {
    const quads = figureQuads("legacy", "wide", true, { yaw: 0, pitch: deg(12) });
    const center = FIGURE_FRAME.width / 2;
    for (const face of ["front", "top"] as const) {
      const from = corners(quadOf(quads, source, "inner", face));
      const to = corners(quadOf(quads, mirrored, "inner", face));
      from.forEach(([x, y], i) => {
        expect(to[i][0]).toBeCloseTo(2 * center - x, 8);
        expect(to[i][1]).toBeCloseTo(y, 8);
      });
    }
  });

  it("外侧面用右侧贴图的外侧：左臂朝 +x 的面取 (40, 20)", () => {
    const quads = figureQuads("legacy", "wide", true, { yaw: deg(-90), pitch: 0 });
    expect(quadOf(quads, "leftArm", "inner", "left").uv).toEqual({ x: 40, y: 20, w: 4, h: 12 });
  });

  it("新格式的左臂不翻转", () => {
    const quads = figureQuads("modern", "wide", true, { yaw: 0, pitch: 0 });
    expect(quadOf(quads, "leftArm", "inner", "front").matrix[0]).toBeGreaterThan(0);
  });
});

describe("可见面", () => {
  const visible = (pose: FigurePose) =>
    figureQuads("modern", "wide", true, pose)
      .filter((q) => q.part === "head" && q.layer === "inner")
      .map((q) => q.face)
      .sort();

  it.each([
    [0, ["front", "top"]],
    [180, ["back", "top"]],
    [90, ["right", "top"]],
    [-90, ["left", "top"]],
    [-30, ["front", "left", "top"]],
    [30, ["front", "right", "top"]],
    [150, ["back", "right", "top"]],
    [-150, ["back", "left", "top"]],
  ])("yaw %s 度", (yaw, faces) => {
    expect(visible({ yaw: deg(yaw), pitch: deg(12) })).toEqual(faces);
  });

  it("俯视时底面永远看不到；不俯视时顶面退化成线，两边都不画", () => {
    expect(figureQuads("modern", "wide", true, REST_POSE).some((q) => q.layer === "inner" && q.face === "bottom")).toBe(false);
    const flat = figureQuads("modern", "wide", true, { yaw: 0, pitch: 0 });
    expect(flat.some((q) => q.face === "top" || q.face === "bottom")).toBe(false);
  });

  it("外层背面正好是内层看不到的三个面", () => {
    const quads = figureQuads("modern", "wide", true, REST_POSE).filter((q) => q.part === "head");
    expect(quads.filter((q) => q.side === "back").map((q) => q.face).sort()).toEqual(["back", "bottom", "right"]);
    expect(quads.filter((q) => q.side === "back").every((q) => q.layer === "outer")).toBe(true);
  });
});

describe("绘制顺序", () => {
  it("默认姿态：远侧手臂、远腿、近腿、身体、近侧手臂、头", () => {
    expect(partOrder(REST_POSE)).toEqual(["rightArm", "rightLeg", "leftLeg", "body", "leftArm", "head"]);
  });

  it("转向另一侧时左右对调，头永远最后", () => {
    expect(partOrder({ yaw: deg(30), pitch: deg(12) })).toEqual(["leftArm", "leftLeg", "rightLeg", "body", "rightArm", "head"]);
    expect(partOrder({ yaw: deg(150), pitch: deg(12) })).toEqual(["leftArm", "leftLeg", "rightLeg", "body", "rightArm", "head"]);
    expect(partOrder({ yaw: deg(-150), pitch: deg(12) })).toEqual(["rightArm", "rightLeg", "leftLeg", "body", "leftArm", "head"]);
  });

  it("不是按中心深度排的：近侧手臂中心比头近，仍要先画，否则手臂盖住脸", () => {
    const v = viewDirection(REST_POSE);
    const depth = ([x, y, z]: Vec3) => x * v[0] + y * v[1] + z * v[2];
    expect(depth([6, 18, 0])).toBeGreaterThan(depth([0, 28, 0]));
    const order = partOrder(REST_POSE);
    expect(order.indexOf("leftArm")).toBeLessThan(order.indexOf("head"));
  });

  it("每个部位内：外层背面 -> 内层可见面 -> 外层正面", () => {
    const quads = figureQuads("modern", "wide", true, REST_POSE);
    for (const part of ["head", "body", "rightArm", "leftArm", "rightLeg", "leftLeg"] as const) {
      const steps = quads.filter((q) => q.part === part).map((q) => `${q.layer}/${q.side}`);
      expect(steps).toEqual(["outer/back", "outer/back", "outer/back", "inner/front", "inner/front", "inner/front", "outer/front", "outer/front", "outer/front"]);
    }
  });

  it("绘制列表按部位连续排列，顺序与 partOrder 一致", () => {
    const seen: FigurePartName[] = [];
    for (const q of figureQuads("modern", "slim", true, REST_POSE)) if (seen[seen.length - 1] !== q.part) seen.push(q.part);
    expect(seen).toEqual(partOrder(REST_POSE));
  });

  it("旧格式没有身体外层：只有帽子有背面", () => {
    const quads = figureQuads("legacy", "wide", true, REST_POSE);
    expect(new Set(quads.filter((q) => q.side === "back").map((q) => q.part))).toEqual(new Set(["head"]));
    expect(quads).toHaveLength(6 * 3 + 3 + 3);
  });

  it("仰视没有对应的遮挡关系，直接报错", () => {
    expect(() => partOrder({ yaw: 0, pitch: -0.1 })).toThrow("pitch");
  });
});

describe("外框", () => {
  const skins = [
    ["modern", "wide", true],
    ["modern", "slim", true],
    ["legacy", "wide", true],
    ["modern", "wide", false],
  ] as const;

  /** 接缝重叠向外多画 0.75 设备像素，最小的 4 倍档、dpr 1 时折合 3/16 皮肤像素。 */
  const SEAM = 0.1875;

  const bounds = (quads: FigureQuad[]) => {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const q of quads) {
      for (const [u, v] of [[0, 0], [q.uv.w, 0], [q.uv.w, q.uv.h], [0, q.uv.h]]) {
        const [x, y] = applyMatrix(q.matrix, u, v);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
    return { minX, maxX, minY, maxY };
  };

  it("外框比布局方框四周各大 2 皮肤像素：20 × 36", () => {
    expect(FIGURE_FRAME).toEqual({ width: FIGURE_SIZE.width + 4, height: FIGURE_SIZE.height + 4 });
    expect(FIGURE_FRAME).toEqual({ width: 20, height: 36 });
  });

  it.each(skins)("%s %s hat=%s：yaw 转满一圈都不越出外框", (format, model, hat) => {
    let widest = 0;
    for (let yaw = 0; yaw < 720; yaw++) {
      const b = bounds(figureQuads(format, model, hat, { yaw: deg(yaw / 2), pitch: REST_POSE.pitch }));
      expect(b.minX).toBeGreaterThanOrEqual(SEAM);
      expect(b.maxX).toBeLessThanOrEqual(FIGURE_FRAME.width - SEAM);
      expect(b.minY).toBeGreaterThanOrEqual(SEAM);
      expect(b.maxY).toBeLessThanOrEqual(FIGURE_FRAME.height - SEAM);
      widest = Math.max(widest, b.maxX - b.minX);
    }
    // 外框不能大得离谱：转满一圈时真的用到了大部分宽度
    expect(widest).toBeGreaterThan(14);
  });

  it("脚底中心落在布局方框的底边中点上：基线和 2D 时代一致", () => {
    const quads = figureQuads("modern", "wide", true, { yaw: 0, pitch: 0 });
    const leg = quadOf(quads, "leftLeg", "inner", "front");
    const [x, y] = applyMatrix(leg.matrix, 0, leg.uv.h);
    expect(x).toBeCloseTo(FIGURE_FRAME_PAD + FIGURE_SIZE.width / 2, 10);
    expect(y).toBeCloseTo(FIGURE_FRAME_PAD + FIGURE_SIZE.height, 10);
  });

  it("手臂外张：手比肩膀更靠外，默认姿态下两臂不对称地露出侧面", () => {
    const flat = { yaw: 0, pitch: 0 };
    const front = quadOf(figureQuads("modern", "wide", true, flat), "rightArm", "inner", "front");
    const [shoulderX] = applyMatrix(front.matrix, 0, 0);
    const [handX] = applyMatrix(front.matrix, 0, 12);
    expect(handX).toBeLessThan(shoulderX - 0.5);
  });
});

describe("明暗", () => {
  const head = figureQuads("modern", "wide", true, REST_POSE);

  it("默认姿态：顶面最亮，正面不发灰，背光的侧面最暗", () => {
    const top = quadOf(head, "head", "inner", "top").shade;
    const front = quadOf(head, "head", "inner", "front").shade;
    const side = quadOf(head, "head", "inner", "left").shade;
    expect(top).toBe(1);
    expect(front).toBe(0.90625);
    expect(side).toBe(0.6875);
  });

  it("朝左的面比朝右的亮：光从画面左上方来", () => {
    expect(faceShade([-1, 0, 0])).toBeGreaterThan(faceShade([1, 0, 0]));
    expect(faceShade([0, 1, 0])).toBe(1);
    expect(faceShade([0, -1, 0])).toBe(0.5);
  });

  it("亮度量化到 1/32：转动时贴图数量有上限", () => {
    for (let i = 0; i < 360; i += 7) {
      for (const q of figureQuads("modern", "wide", true, { yaw: deg(i), pitch: REST_POSE.pitch })) {
        expect(q.shade * 32).toBe(Math.round(q.shade * 32));
        expect(q.shade).toBeGreaterThan(0);
        expect(q.shade).toBeLessThanOrEqual(1);
      }
    }
  });

  it("外层内壁比朝向相同的外表面暗", () => {
    const interior = quadOf(head, "head", "outer", "back", "back");
    const outerFront = quadOf(head, "head", "outer", "front");
    expect(interior.shade).toBeLessThan(outerFront.shade);
  });
});

describe("回位缓动", () => {
  const rest = REST_POSE.yaw;

  it("wrapAngle 折算到 (-π, π]", () => {
    expect(wrapAngle(deg(350))).toBeCloseTo(deg(-10), 10);
    expect(wrapAngle(deg(-190))).toBeCloseTo(deg(170), 10);
    expect(wrapAngle(Math.PI)).toBeCloseTo(Math.PI, 10);
    expect(wrapAngle(0)).toBe(0);
  });

  /** 按 60 Hz 逐帧取 releaseYaw，直到精确落在 rest；返回每帧的 yaw。 */
  function track(from: number, velocity: number): number[] {
    const out: number[] = [];
    for (let frame = 1; ; frame++) {
      const yaw = releaseYaw(from, rest, velocity, (frame * 16) / 1000);
      out.push(yaw);
      if (yaw === rest) return out;
      if (frame > 120) throw new Error("两秒内没有回到默认姿态");
    }
  }

  it("静止松手：沿 pop 弹簧回位，第一帧就在动、几帧之内不会到位，最后精确落在 rest 上", () => {
    const from = rest + deg(120);
    const yaws = track(from, 0);
    expect(releaseYaw(from, rest, 0, 0)).toBeCloseTo(from, 10);
    expect(yaws[0]).toBeLessThan(from);
    expect(yaws.length).toBeGreaterThan(10);
    expect(yaws.length).toBeLessThan(60);
    expect(yaws[yaws.length - 1]).toBe(rest);
  });

  it("甩动中松手：先顺着手的方向带一段再折回，不从最大速度起步猛然掉头", () => {
    const from = rest + deg(60);
    // 往远离默认姿态的方向甩，每秒 600 度
    const yaws = track(from, deg(600));
    expect(yaws[0]).toBeGreaterThan(from);
    const peak = Math.max(...yaws);
    expect(peak - from).toBeGreaterThan(deg(3));
    expect(peak - from).toBeLessThan(deg(30));
    // 静止松手同一位置时第一帧就往回走
    expect(track(from, 0)[0]).toBeLessThan(from);
  });

  it("走最短方向：转过将近一圈的 yaw 只差 10 度，不会倒着绕回去", () => {
    const offset = wrapAngle(releaseYaw(rest + deg(350), rest, 0, 0.016) - rest);
    expect(offset).toBeGreaterThan(deg(-10));
    expect(offset).toBeLessThan(0);
  });

  it("隔了很久（窗口卡顿）的一帧直接到位", () => {
    expect(releaseYaw(rest + deg(170), rest, deg(900), 5)).toBe(rest);
  });

  it("回弹经过默认姿态时速度还大，不会在半路吸附停下", () => {
    const yaws = track(rest + deg(170), deg(-1080));
    const crossings = yaws.slice(0, -1).filter((yaw, i) => Math.sign(yaw - rest) !== Math.sign(yaws[i + 1] - rest) && yaws[i + 1] !== rest);
    expect(crossings.length).toBeGreaterThan(0);
    expect(yaws[yaws.length - 1]).toBe(rest);
  });
});

describe("松手速度", () => {
  const sample = (t: number, degrees: number) => ({ t, yaw: deg(degrees) });

  it("取松手前 80 ms 内最早一次拖动到松手的平均角速度", () => {
    const samples = [sample(0, 0), sample(50, 10), sample(100, 20), sample(150, 30)];
    // 窗口从 80 起：最早的是 100 ms 时的 20 度，到 180 ms 松手时 36 度
    expect(releaseVelocity(samples, 180, deg(36))).toBeCloseTo(deg(200), 10);
  });

  it("停住一个窗口再松手：速度为零", () => {
    expect(releaseVelocity([sample(0, 0), sample(20, 40)], 200, deg(40))).toBe(0);
  });

  it("停了一会儿再松手：停住的那段把平均速度拉低", () => {
    const moving = releaseVelocity([sample(0, 0), sample(40, 40)], 40, deg(40));
    const paused = releaseVelocity([sample(0, 0), sample(40, 40)], 70, deg(40));
    expect(paused).toBeGreaterThan(0);
    expect(paused).toBeLessThan(moving);
  });

  it("窗口里只有挨得很近的事件时不算甩动", () => {
    expect(releaseVelocity([sample(100, 0), sample(105, 30)], 108, deg(30))).toBe(0);
  });

  it("算出的速度封顶在每秒 1080 度，两个方向都封", () => {
    expect(releaseVelocity([sample(0, 0), sample(20, 180)], 20, deg(180))).toBeCloseTo(deg(1080), 10);
    expect(releaseVelocity([sample(0, 0), sample(20, -180)], 20, deg(-180))).toBeCloseTo(deg(-1080), 10);
  });
});
