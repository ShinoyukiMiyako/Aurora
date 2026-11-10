// 角色立绘的三维几何：六个部位的内外两层盒子、每个面的皮肤 UV、正交投影、可见面与绘制顺序。
// 全部是纯函数，真正落笔在 render.ts。世界坐标以皮肤像素为单位，脚底中心是原点：
// x 指向玩家左手（玩家面朝屏幕时的画面右侧）、y 向上、z 指向玩家正前方。

import { springAt } from "../../lib/motion";
import { armWidth } from "../illustrations/silhouette";
import { FACE_SHADE, type Matrix } from "../iso/geometry";
import { FIGURE_FRAME, FIGURE_FRAME_PAD, type SkinModel } from "./layout";

export type Vec3 = readonly [x: number, y: number, z: number];

export type SkinFormat = "modern" | "legacy";
export type FigurePartName = "head" | "body" | "rightArm" | "leftArm" | "rightLeg" | "leftLeg";
/** 盒子的六个面；left、right 指玩家自己的左右，和皮肤格式的叫法一致。 */
export type BoxFace = "top" | "bottom" | "right" | "front" | "left" | "back";
export type BoxLayer = "inner" | "outer";

export interface SkinRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FigureBox {
  layer: BoxLayer;
  min: Vec3;
  max: Vec3;
  /** 按世界里的朝向取：uv.left 就是贴在 +x 一面上的矩形。 */
  uv: Readonly<Record<BoxFace, SkinRect>>;
  /** 贴图水平翻转：旧格式的左臂、左腿是右侧沿 x = 0 的镜像。 */
  mirror: boolean;
}

export interface FigurePart {
  name: FigurePartName;
  /** 内层在前，外层（有的话）在后。 */
  boxes: readonly FigureBox[];
  /** 绕 z 轴的外张角与转轴。 */
  splay: number;
  pivot: Vec3;
}

export interface FigurePose {
  /** 绕 y 轴，弧度：正值让玩家转向画面右侧。 */
  yaw: number;
  /** 绕 x 轴的俯视角，弧度，不能为负：partOrder 按从上往下看排序。 */
  pitch: number;
}

const radians = (degrees: number) => (degrees * Math.PI) / 180;

/** 默认姿态：转向画面左侧，主页问候卡里立绘站在右下角，这样正对着左边的文字。 */
export const REST_POSE: FigurePose = { yaw: radians(-30), pitch: radians(12) };

/** 手臂外张角：垂直贴身时身体和手臂连成一块平板，张开一点才看得出是分开的盒子。 */
const ARM_SPLAY = radians(4);

/** 外层膨胀量取自原版 PlayerModel：头 0.5，身体与四肢 0.25。 */
const HEAD_GROW = 0.5;
const LIMB_GROW = 0.25;

type SkinOrigin = readonly [u: number, v: number];

/** Minecraft 盒子展开：(u, v) 是展开图包围框的左上角，w、h、d 为盒子的宽、高、深。 */
export function boxUv(u: number, v: number, w: number, h: number, d: number): Record<BoxFace, SkinRect> {
  return {
    top: { x: u + d, y: v, w, h: d },
    bottom: { x: u + d + w, y: v, w, h: d },
    right: { x: u, y: v + d, w: d, h },
    front: { x: u + d, y: v + d, w, h },
    left: { x: u + d + w, y: v + d, w: d, h },
    back: { x: u + 2 * d + w, y: v + d, w, h },
  };
}

function partBoxes(min: Vec3, size: Vec3, grow: number, inner: SkinOrigin, outer: SkinOrigin | null, mirror = false): FigureBox[] {
  const [w, h, d] = size;
  const box = (layer: BoxLayer, [u, v]: SkinOrigin, g: number): FigureBox => {
    const uv = boxUv(u, v, w, h, d);
    return {
      layer,
      min: [min[0] - g, min[1] - g, min[2] - g],
      max: [min[0] + w + g, min[1] + h + g, min[2] + d + g],
      // 镜像后右侧贴图的外侧面落在 +x，左右两个面的矩形要对调
      uv: mirror ? { ...uv, left: uv.right, right: uv.left } : uv,
      mirror,
    };
  };
  return outer === null ? [box("inner", inner, 0)] : [box("inner", inner, 0), box("outer", outer, grow)];
}

const STILL = { splay: 0, pivot: [0, 0, 0] as Vec3 };

/**
 * 六个部位。旧格式没有身体与四肢外层，左臂左腿取右侧镜像；hat 为假时头部只有内层，
 * 外层全不透明的旧皮肤靠它避免一整块色板盖住脸。
 */
export function figureParts(format: SkinFormat, model: SkinModel, hat: boolean): FigurePart[] {
  const a = armWidth(model);
  const modern = format === "modern";
  // 原版细手臂的挂点比宽手臂低半格，转轴也跟着低半格
  const armLow = model === "slim" ? 0.5 : 0;
  const armY = 12 - armLow;
  const armPivotY = 22 - armLow;
  const armSize: Vec3 = [a, 12, 4];
  const legSize: Vec3 = [4, 12, 4];
  const leftArmBoxes = modern ? partBoxes([4, armY, -2], armSize, LIMB_GROW, [32, 48], [48, 48]) : partBoxes([4, armY, -2], armSize, LIMB_GROW, [40, 16], null, true);
  const leftLegBoxes = modern ? partBoxes([0, 0, -2], legSize, LIMB_GROW, [16, 48], [0, 48]) : partBoxes([0, 0, -2], legSize, LIMB_GROW, [0, 16], null, true);
  return [
    { name: "head", boxes: partBoxes([-4, 24, -4], [8, 8, 8], HEAD_GROW, [0, 0], hat ? [32, 0] : null), ...STILL },
    { name: "body", boxes: partBoxes([-4, 12, -2], [8, 12, 4], LIMB_GROW, [16, 16], modern ? [16, 32] : null), ...STILL },
    { name: "rightArm", boxes: partBoxes([-4 - a, armY, -2], armSize, LIMB_GROW, [40, 16], modern ? [40, 32] : null), splay: ARM_SPLAY, pivot: [-5, armPivotY, 0] },
    { name: "leftArm", boxes: leftArmBoxes, splay: -ARM_SPLAY, pivot: [5, armPivotY, 0] },
    { name: "rightLeg", boxes: partBoxes([-4, 0, -2], legSize, LIMB_GROW, [0, 16], modern ? [0, 32] : null), ...STILL },
    { name: "leftLeg", boxes: leftLegBoxes, ...STILL },
  ];
}

// ---------------------------------------------------------------- 投影

function viewRotation({ yaw, pitch }: FigurePose): (v: Vec3) => Vec3 {
  const sy = Math.sin(yaw);
  const cy = Math.cos(yaw);
  const sp = Math.sin(pitch);
  const cp = Math.cos(pitch);
  return ([x, y, z]) => {
    const depth = z * cy - x * sy;
    return [x * cy + z * sy, y * cp - depth * sp, y * sp + depth * cp];
  };
}

/** 世界坐标里指向观察者的单位向量。 */
export function viewDirection({ yaw, pitch }: FigurePose): Vec3 {
  return [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
}

function splayVector(part: FigurePart, [x, y, z]: Vec3): Vec3 {
  const s = Math.sin(part.splay);
  const c = Math.cos(part.splay);
  return [x * c + y * s, y * c - x * s, z];
}

function splayPoint(part: FigurePart, [x, y, z]: Vec3): Vec3 {
  const [px, py] = part.pivot;
  const [dx, dy] = splayVector(part, [x - px, y - py, 0]);
  return [px + dx, py + dy, z];
}

/** 视图坐标 -> 外框坐标（皮肤像素，左上角为原点）：脚底中心落在外框水平中线、距底边 FIGURE_FRAME_PAD 处。 */
function toFrame([x, up]: Vec3): [x: number, y: number] {
  return [FIGURE_FRAME.width / 2 + x, FIGURE_FRAME.height - FIGURE_FRAME_PAD - up];
}

// ---------------------------------------------------------------- 明暗

/** 正对观察者时的亮度：不沿用 FACE_SHADE 的 0.8，否则皮肤最大的一面整体发灰。 */
const FACING_SHADE = 0.96;
const BOTTOM_SHADE = 0.5;
/** 外层内壁：同朝向外表面的亮度再乘这个系数，透过破洞看到的部分才有纵深。 */
const INTERIOR_SHADE = 0.7;
/** 亮度量化级数：render.ts 每一级生成一张贴图，转动时不能无限增长。 */
const SHADE_STEPS = 32;

function rawShade([x, y, z]: Vec3): number {
  const side = x < 0 ? FACE_SHADE.left : FACE_SHADE.right;
  const vertical = y > 0 ? FACE_SHADE.top : BOTTOM_SHADE;
  return x * x * side + y * y * vertical + z * z * FACING_SHADE;
}

const quantize = (shade: number) => Math.round(shade * SHADE_STEPS) / SHADE_STEPS;

/**
 * 视图空间单位法线 -> 亮度。三个分量的平方和为 1，亮度是三个方向系数的加权：
 * 顶面最亮，面向画面左侧的光源一边比右侧亮，和 FACE_SHADE 同一思路，转动时连续变化。
 */
export function faceShade(normal: Vec3): number {
  return quantize(rawShade(normal));
}

// ---------------------------------------------------------------- 可见面与绘制顺序

interface FaceAxes {
  normal: Vec3;
  /** 贴图左上角所在的盒角，各分量 0 取 min、1 取 max。 */
  origin: Vec3;
  /** 贴图向右、向下对应的盒轴方向。 */
  s: Vec3;
  t: Vec3;
}

/**
 * 把皮肤展开图按原版折回盒子：四个侧面沿 s 方向首尾相接，top、bottom 的 t 都指向玩家前方，
 * 也就是顶面贴图下缘挨着正面上缘，底面贴图下缘同样朝前（从下往上看时像是上下颠倒）。
 */
const FACE_AXES: Readonly<Record<BoxFace, FaceAxes>> = {
  top: { normal: [0, 1, 0], origin: [0, 1, 0], s: [1, 0, 0], t: [0, 0, 1] },
  bottom: { normal: [0, -1, 0], origin: [0, 0, 0], s: [1, 0, 0], t: [0, 0, 1] },
  right: { normal: [-1, 0, 0], origin: [0, 1, 0], s: [0, 0, 1], t: [0, -1, 0] },
  front: { normal: [0, 0, 1], origin: [0, 1, 1], s: [1, 0, 0], t: [0, -1, 0] },
  left: { normal: [1, 0, 0], origin: [1, 1, 1], s: [0, 0, -1], t: [0, -1, 0] },
  back: { normal: [0, 0, -1], origin: [1, 1, 0], s: [-1, 0, 0], t: [0, -1, 0] },
};

const BOX_FACES = Object.keys(FACE_AXES) as BoxFace[];

/** 法线几乎垂直视线的面投影退化成一条线，两边都不画。 */
const EDGE_ON = 1e-3;

export interface FigureQuad {
  part: FigurePartName;
  layer: BoxLayer;
  face: BoxFace;
  /** front：朝向观察者；back：外层背对观察者的一面，从破洞里看到的是它的内壁。 */
  side: "front" | "back";
  uv: SkinRect;
  /** 把贴图像素 (0, 0)-(w, h) 映射到外框坐标，皮肤像素为单位。 */
  matrix: Matrix;
  shade: number;
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const negate = ([x, y, z]: Vec3): Vec3 => [-x, -y, -z];

function boxQuads(part: FigurePart, box: FigureBox, rotate: (v: Vec3) => Vec3, side: FigureQuad["side"]): FigureQuad[] {
  const corner = (c: Vec3): Vec3 => [
    box.min[0] + c[0] * (box.max[0] - box.min[0]),
    box.min[1] + c[1] * (box.max[1] - box.min[1]),
    box.min[2] + c[2] * (box.max[2] - box.min[2]),
  ];
  const project = (c: Vec3) => toFrame(rotate(splayPoint(part, corner(c))));
  const quads: FigureQuad[] = [];
  for (const face of BOX_FACES) {
    const axes = FACE_AXES[face];
    const normal = rotate(splayVector(part, axes.normal));
    const facing = normal[2];
    if (side === "front" ? facing <= EDGE_ON : facing >= -EDGE_ON) continue;
    const uv = box.uv[face];
    const sEnd = add(axes.origin, axes.s);
    // 镜像只把贴图 s 方向反过来：原点换到 s 的另一端，折叠方向不变
    const [o, s] = box.mirror ? [sEnd, axes.origin] : [axes.origin, sEnd];
    const p0 = project(o);
    const ps = project(s);
    const pt = project(add(o, axes.t));
    quads.push({
      part: part.name,
      layer: box.layer,
      face,
      side,
      uv,
      matrix: [(ps[0] - p0[0]) / uv.w, (ps[1] - p0[1]) / uv.w, (pt[0] - p0[0]) / uv.h, (pt[1] - p0[1]) / uv.h, p0[0], p0[1]],
      shade: side === "front" ? faceShade(normal) : quantize(rawShade(negate(normal)) * INTERIOR_SHADE),
    });
  }
  return quads;
}

/**
 * 部位从后往前的顺序。不按部位中心的深度排：俯视时头的中心比近侧手臂远，
 * 中心深度排序会让手臂盖住头。这里用部位之间天然的分离平面：左右两侧隔着 x = ±4，
 * 头在 y = 24 之上、腿在 y = 12 之下。手臂和腿之间也按 x 定序，细手臂比腿低半格，y 分不开它们。
 */
export function partOrder(pose: FigurePose): FigurePartName[] {
  if (pose.pitch < 0) throw new Error(`立绘只支持俯视，pitch 不能为负：${pose.pitch}`);
  const leftIsNear = viewDirection(pose)[0] >= 0;
  return leftIsNear ? ["rightArm", "rightLeg", "leftLeg", "body", "leftArm", "head"] : ["leftArm", "leftLeg", "rightLeg", "body", "rightArm", "head"];
}

/** 一帧要画的全部面，已按绘制顺序排好：每个部位内依次是外层背面、内层可见面、外层正面。 */
export function figureQuads(format: SkinFormat, model: SkinModel, hat: boolean, pose: FigurePose): FigureQuad[] {
  const parts = figureParts(format, model, hat);
  const rotate = viewRotation(pose);
  return partOrder(pose).flatMap((name) => {
    const part = parts.find((p) => p.name === name);
    if (part === undefined) throw new Error(`立绘缺少部位 ${name}`);
    const inner = part.boxes.find((b) => b.layer === "inner");
    if (inner === undefined) throw new Error(`部位 ${name} 没有内层盒子`);
    const outer = part.boxes.find((b) => b.layer === "outer");
    return [...(outer ? boxQuads(part, outer, rotate, "back") : []), ...boxQuads(part, inner, rotate, "front"), ...(outer ? boxQuads(part, outer, rotate, "front") : [])];
  });
}

// ---------------------------------------------------------------- 松手回位

/** 剩下不足 0.25 度、角速度也不足 2 度每秒时吸附到默认姿态，让循环能停下来。只看角度会在回弹的半路停住。 */
const SETTLE_SNAP = radians(0.25);
const SETTLE_SNAP_SPEED = radians(2);

/** 松手时的角速度只看松手前这么久里的拖动：更早的移动已经不代表手上的速度，停住再松手就是零。 */
const RELEASE_WINDOW_MS = 80;
/** 窗口里的拖动不足这么久时不算甩动：一两个挨得很近的事件，时刻差太小，算出的速度不可信。 */
const RELEASE_MIN_SPAN_MS = 16;
/** 甩动角速度的上限（弧度每秒）：带着它回位最多先多转约 23 度，不会甩成整圈。 */
const MAX_RELEASE_SPEED = radians(1080);

/** 拖动过程中的一次姿态：事件时刻（毫秒）与当时的 yaw。 */
export interface YawSample {
  t: number;
  yaw: number;
}

/** 角度折算到 (-π, π]。 */
export function wrapAngle(angle: number): number {
  const turn = 2 * Math.PI;
  const wrapped = angle - turn * Math.floor(angle / turn);
  return wrapped > Math.PI ? wrapped - turn : wrapped;
}

/**
 * 松手那一刻的角速度（弧度每秒）：窗口内最早的一次拖动到松手时的平均速度。samples 按时刻升序；
 * 松手前停住不动的那段也算在里面，所以停一会儿再松手速度自然变小，停够一个窗口就是零。
 */
export function releaseVelocity(samples: readonly YawSample[], releaseAt: number, releaseYaw: number): number {
  const first = samples.find((sample) => releaseAt - sample.t <= RELEASE_WINDOW_MS);
  if (first === undefined) return 0;
  const span = releaseAt - first.t;
  if (span < RELEASE_MIN_SPAN_MS) return 0;
  const speed = ((releaseYaw - first.yaw) / span) * 1000;
  return Math.max(-MAX_RELEASE_SPEED, Math.min(MAX_RELEASE_SPEED, speed));
}

/**
 * 松手 t 秒后的 yaw：从 from 带着松手时的角速度沿 pop 弹簧回到 rest，走最短方向。甩动中松手先顺着手的方向
 * 带一段再折回，不会从最大速度起步猛然掉头。足够近又足够慢时精确返回 rest。
 */
export function releaseYaw(from: number, rest: number, velocity: number, t: number): number {
  const { x, v } = springAt("pop", wrapAngle(from - rest), velocity, t);
  return Math.abs(x) < SETTLE_SNAP && Math.abs(v) < SETTLE_SNAP_SPEED ? rest : rest + x;
}
