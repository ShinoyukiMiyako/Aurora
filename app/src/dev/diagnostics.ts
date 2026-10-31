// 开发诊断（仅开发构建）：在开发者工具控制台里用 window.__sk 做视觉验收的机械检查。
//   __sk.accentArea()        当前窗口里强调色填充的面积占比，上限 0.10；accentAreaDetail() 给出逐个元素的明细
//   __sk.textureAudit()      所有取自游戏本机材质的元素及其所在点缀位，ok 为 false 的就是越界使用
//   __sk.petals()            主页花瓣的运行状态：是否在跑 rAF、降级等级、数量与每帧耗时
// 这些检查都是近似测量，口径写在各函数的注释里；它们不进生产构建。

import { parseComputedColor, resolveColorToken, sameColor, type Rgba } from "../art/petals/color";
import { currentPetalStats, type PetalStats } from "../art/petals/engine";

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export type Pseudo = "::before" | "::after";

/** 读计算样式；默认是 getComputedStyle，测试替换成可控的版本（jsdom 不做层叠与布局）。 */
export type StyleReader = (element: Element, pseudo: Pseudo | null) => CSSStyleDeclaration;

const readStyle: StyleReader = (element, pseudo) => getComputedStyle(element, pseudo);

const PSEUDOS: readonly Pseudo[] = ["::before", "::after"];

function intersect(a: Box, b: Box): Box | null {
  const box = { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
  return box.right > box.left && box.bottom > box.top ? box : null;
}

function px(value: string, what: string): number {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) throw new Error(`${what}「${value}」不是像素值`);
  return n;
}

// ---------------------------------------------------------------- 粉色面积

/** 栅格边长 px：面积按 8 px 网格栅格化求并集，重叠的强调色区域只计一次。 */
export const ACCENT_GRID = 8;

/**
 * 计入粉色面积的强调色族：强调色本身与它派生的实色、浅底、描边色，以及游玩热力的四阶。
 * 不含 --sk-accent-ink：它是强调实底上的文字色（白或深墨），计入会把所有白底都算成粉色。
 * --sk-accent-grad 是渐变，按背景图里出现的颜色识别，它的色标里含 --sk-accent。
 */
export const ACCENT_FILL_TOKENS = [
  "--sk-accent",
  "--sk-accent-2",
  "--sk-accent-strong",
  "--sk-accent-soft",
  "--sk-accent-soft-2",
  "--sk-accent-line",
  "--sk-heat-1",
  "--sk-heat-2",
  "--sk-heat-3",
  "--sk-heat-4",
] as const;

/** 窗口氛围晕染规格固定，不计入粉色面积。 */
export const AMBIENCE_TOKEN = "--sk-ambience";

/** 不超过 2 px 的强调色描边不计入（容器的强调描边与聚焦环本来就是为了替代大面积铺色）。 */
export const THIN_BORDER_MAX = 2;

export interface AccentFamily {
  colors: readonly Rgba[];
  /** --sk-ambience 解析后的 background-image 计算值。 */
  ambienceImage: string;
}

/** 在当前外观下解析强调色族。probe 必须在文档内。 */
export function resolveAccentFamily(probe: HTMLElement): AccentFamily {
  const colors = ACCENT_FILL_TOKENS.map((name) => resolveColorToken(probe, name));
  if (getComputedStyle(probe).getPropertyValue(AMBIENCE_TOKEN).trim() === "") throw new Error(`令牌 ${AMBIENCE_TOKEN} 未声明`);
  probe.style.backgroundImage = `var(${AMBIENCE_TOKEN})`;
  try {
    return { colors, ambienceImage: getComputedStyle(probe).backgroundImage };
  } finally {
    probe.style.removeProperty("background-image");
  }
}

/** 网格第 i 格在视口内的起点、终点与中心；视口边缘不足一格的单元按实际范围算。 */
function gridCell(i: number, cell: number, limit: number): { start: number; end: number; center: number } {
  const start = i * cell;
  const end = Math.min(start + cell, limit);
  return { start, end, center: (start + end) / 2 };
}

/**
 * 栅格化求并集：网格单元的中心落在某个矩形内（含左上边、不含右下边）即记为覆盖，与像素光栅化同一规则，
 * 大块面积无偏；返回被覆盖单元的面积和。
 */
export function rasterizedArea(boxes: readonly Box[], viewport: Viewport, cell = ACCENT_GRID): number {
  const cols = Math.ceil(viewport.width / cell);
  const rows = Math.ceil(viewport.height / cell);
  const covered = new Uint8Array(cols * rows);
  for (const box of boxes) {
    const left = Math.max(0, box.left);
    const right = Math.min(viewport.width, box.right);
    const top = Math.max(0, box.top);
    const bottom = Math.min(viewport.height, box.bottom);
    if (right <= left || bottom <= top) continue;
    const i1 = Math.min(cols - 1, Math.floor(right / cell));
    const j1 = Math.min(rows - 1, Math.floor(bottom / cell));
    for (let j = Math.floor(top / cell); j <= j1; j++) {
      const cy = gridCell(j, cell, viewport.height).center;
      if (cy < top || cy >= bottom) continue;
      for (let i = Math.floor(left / cell); i <= i1; i++) {
        const cx = gridCell(i, cell, viewport.width).center;
        if (cx >= left && cx < right) covered[j * cols + i] = 1;
      }
    }
  }
  let area = 0;
  for (let j = 0; j < rows; j++) {
    const y = gridCell(j, cell, viewport.height);
    for (let i = 0; i < cols; i++) {
      if (covered[j * cols + i] === 0) continue;
      const x = gridCell(i, cell, viewport.width);
      area += (x.end - x.start) * (y.end - y.start);
    }
  }
  return area;
}

export interface AccentBox {
  element: Element;
  pseudo: Pseudo | null;
  /** background：整块按外框计；border：只计超过 2 px 的强调色描边条。 */
  source: "background" | "border";
  box: Box;
}

export interface AccentAreaReport {
  ratio: number;
  coveredPx: number;
  viewportPx: number;
  boxes: AccentBox[];
  /**
   * 带强调色填充或粗描边、但量不出位置的伪元素：只有绝对定位且宿主已定位的伪元素能从计算样式还原外框，
   * 文档流里的伪元素没有可读的布局矩形。列出来而不是静默跳过，结果偏小时先看这里。
   */
  unmeasured: { element: Element; pseudo: Pseudo }[];
}

export interface MeasureAccentOptions {
  root: Element;
  viewport: Viewport;
  family: AccentFamily;
  styleOf?: StyleReader;
}

const COLOR_IN_IMAGE = /\b(?:rgba?|color)\([^()]*\)/g;

const SIDES = [
  { side: "Top", strip: (b: Box, w: number): Box => ({ ...b, bottom: b.top + w }) },
  { side: "Right", strip: (b: Box, w: number): Box => ({ ...b, left: b.right - w }) },
  { side: "Bottom", strip: (b: Box, w: number): Box => ({ ...b, top: b.bottom - w }) },
  { side: "Left", strip: (b: Box, w: number): Box => ({ ...b, right: b.left + w }) },
] as const;

/**
 * 遍历 root 下的可见元素，把背景色或背景图里的颜色落在强调色族的元素外框、以及宽于 2 px 的强调色描边条
 * 收集起来，按 8 px 网格求并集再除以视口面积。
 * 可见性口径：display: none 与 opacity: 0 的子树整体跳过；visibility 不为 visible 的元素自身不计、子元素照常；
 * 外框按祖先的 overflow 裁剪（fixed 定位的元素只按视口裁剪）。不处理 clip-path 与遮挡。
 */
export function measureAccentArea({ root, viewport, family, styleOf = readStyle }: MeasureAccentOptions): AccentAreaReport {
  const view: Box = { left: 0, top: 0, right: viewport.width, bottom: viewport.height };
  const boxes: AccentBox[] = [];
  const unmeasured: { element: Element; pseudo: Pseudo }[] = [];

  const inFamily = (value: string): boolean => {
    const color = parseComputedColor(value);
    return color.a > 0 && family.colors.some((c) => sameColor(c, color));
  };
  const hasAccentFill = (style: CSSStyleDeclaration): boolean => {
    if (inFamily(style.backgroundColor)) return true;
    const image = style.backgroundImage;
    if (image === "none" || image === family.ambienceImage) return false;
    return [...image.matchAll(COLOR_IN_IMAGE)].some((m) => inFamily(m[0]));
  };
  /** 宽于 2 px 的强调色描边：每条返回从外框切出描边条的函数。 */
  const accentBorders = (style: CSSStyleDeclaration): ((outer: Box) => Box)[] =>
    SIDES.flatMap(({ side, strip }) => {
      const name = side.toLowerCase();
      const borderStyle = style.getPropertyValue(`border-${name}-style`);
      if (borderStyle === "none" || borderStyle === "hidden") return [];
      const width = px(style.getPropertyValue(`border-${name}-width`), "描边宽度");
      if (width <= THIN_BORDER_MAX || !inFamily(style.getPropertyValue(`border-${name}-color`))) return [];
      return [(outer: Box) => strip(outer, width)];
    });
  const collect = (element: Element, pseudo: Pseudo | null, style: CSSStyleDeclaration, outer: Box, clip: Box): void => {
    if (hasAccentFill(style)) {
      const box = intersect(outer, clip);
      if (box) boxes.push({ element, pseudo, source: "background", box });
      return;
    }
    for (const cut of accentBorders(style)) {
      const box = intersect(cut(outer), clip);
      if (box) boxes.push({ element, pseudo, source: "border", box });
    }
  };

  const visit = (element: Element, inheritedClip: Box): void => {
    const style = styleOf(element, null);
    if (style.display === "none" || style.opacity === "0") return;
    const clip = style.position === "fixed" ? view : inheritedClip;
    const rect = element.getBoundingClientRect();
    const outer: Box = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    if (style.visibility === "visible") {
      collect(element, null, style, outer, clip);
      for (const pseudo of PSEUDOS) {
        const ps = styleOf(element, pseudo);
        if (ps.content === "none" || ps.content === "normal" || ps.display === "none" || ps.visibility !== "visible" || ps.opacity === "0") continue;
        if (!hasAccentFill(ps) && accentBorders(ps).length === 0) continue;
        if ((ps.position !== "absolute" && ps.position !== "fixed") || (ps.position === "absolute" && style.position === "static")) {
          unmeasured.push({ element, pseudo });
          continue;
        }
        const originX = ps.position === "fixed" ? 0 : rect.left + px(style.borderLeftWidth, "宿主左描边");
        const originY = ps.position === "fixed" ? 0 : rect.top + px(style.borderTopWidth, "宿主上描边");
        const left = originX + px(ps.left, "伪元素 left");
        const top = originY + px(ps.top, "伪元素 top");
        collect(element, pseudo, ps, { left, top, right: left + px(ps.width, "伪元素宽"), bottom: top + px(ps.height, "伪元素高") }, ps.position === "fixed" ? view : clip);
      }
    }
    const clipX = style.overflowX !== "visible";
    const clipY = style.overflowY !== "visible";
    const childClip = clipX || clipY
      ? { left: clipX ? Math.max(clip.left, outer.left) : clip.left, right: clipX ? Math.min(clip.right, outer.right) : clip.right, top: clipY ? Math.max(clip.top, outer.top) : clip.top, bottom: clipY ? Math.min(clip.bottom, outer.bottom) : clip.bottom }
      : clip;
    for (const child of element.children) visit(child, childClip);
  };

  visit(root, view);
  const coveredPx = rasterizedArea(boxes.map((b) => b.box), viewport);
  const viewportPx = viewport.width * viewport.height;
  if (!(viewportPx > 0)) throw new Error(`视口尺寸无效：${viewport.width}×${viewport.height}`);
  return { ratio: coveredPx / viewportPx, coveredPx, viewportPx, boxes, unmeasured };
}

// ---------------------------------------------------------------- 原版材质审计

// sk-guard-allow T7: 审计要识别材质协议的地址才能列出取图的元素，本身不取任何材质
export const TEXTURE_PROTOCOL = "aurora-tex";

/** 允许出现游戏本机材质的点缀位：实例方块、玩家皮肤、樱花林全景。 */
export const TEXTURE_SLOTS = ["iso", "skin", "panorama"] as const;

/** 不属于游戏本机材质、不在审计范围的路径：Mod 作者自带的图标与远程缩略图的磁盘缓存。 */
export const TEXTURE_EXEMPT_PREFIXES = ["/modicon/", "/thumb/"] as const;

/**
 * 若 url 指向材质协议，返回它的路径；否则返回 null。Windows 上协议以 http(s)://<协议>.localhost/ 提供，
 * 其余平台是 <协议>://localhost/。
 */
export function textureProtocolPath(url: string, base: string): string | null {
  const parsed = new URL(url, base);
  if (parsed.protocol === `${TEXTURE_PROTOCOL}:` || parsed.hostname === `${TEXTURE_PROTOCOL}.localhost`) return parsed.pathname;
  return null;
}

export interface TextureAuditEntry {
  element: Element;
  pseudo: Pseudo | null;
  /** img：<img> 或 SVG <image> 的地址；background：背景图；mask：遮罩图。 */
  source: "img" | "background" | "mask";
  url: string;
  path: string;
  /** 最近的 data-sk-art 值；元素不在任何点缀位里时为 null。 */
  art: string | null;
  ok: boolean;
}

export interface AuditTexturesOptions {
  root: Element;
  /** 解析相对地址的基准，默认是文档地址。 */
  base?: string;
  styleOf?: StyleReader;
}

const CSS_URL = /url\(\s*(["']?)(.*?)\1\s*\)/g;
const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

function cssUrls(value: string): string[] {
  if (value === "none" || value === "") return [];
  return [...value.matchAll(CSS_URL)].map((m) => m[2]);
}

/** 列出 root 下所有取自材质协议（豁免路径除外）的元素，不论是否可见。 */
export function auditTextures({ root, base = root.ownerDocument.baseURI, styleOf = readStyle }: AuditTexturesOptions): TextureAuditEntry[] {
  const entries: TextureAuditEntry[] = [];
  const add = (element: Element, pseudo: Pseudo | null, source: TextureAuditEntry["source"], url: string): void => {
    const path = textureProtocolPath(url, base);
    if (path === null || TEXTURE_EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix))) return;
    const slot = element.closest("[data-sk-art]");
    const art = slot === null ? null : slot.getAttribute("data-sk-art");
    entries.push({ element, pseudo, source, url, path, art, ok: art !== null && (TEXTURE_SLOTS as readonly string[]).includes(art) });
  };
  const fromStyle = (element: Element, pseudo: Pseudo | null): void => {
    const style = styleOf(element, pseudo);
    for (const url of cssUrls(style.backgroundImage)) add(element, pseudo, "background", url);
    const masks = new Set([...cssUrls(style.getPropertyValue("mask-image")), ...cssUrls(style.getPropertyValue("-webkit-mask-image"))]);
    for (const url of masks) add(element, pseudo, "mask", url);
  };
  const visit = (element: Element): void => {
    if (element instanceof HTMLImageElement) {
      // currentSrc 是 srcset 选中的候选，src 是属性本身；两者都查，同一地址只记一次
      for (const url of new Set([element.currentSrc, element.src].filter((u) => typeof u === "string" && u !== ""))) add(element, null, "img", url);
    } else if (element.namespaceURI === SVG_NS && element.localName === "image") {
      const href = element.hasAttribute("href") ? element.getAttribute("href") : element.getAttributeNS(XLINK_NS, "href");
      if (href !== null && href !== "") add(element, null, "img", href);
    }
    fromStyle(element, null);
    for (const pseudo of PSEUDOS) fromStyle(element, pseudo);
    for (const child of element.children) visit(child);
  };
  visit(root);
  return entries;
}

// ---------------------------------------------------------------- 安装

export interface SkDiagnostics {
  /** 强调色面积占视口的比例。 */
  accentArea(): number;
  accentAreaDetail(): AccentAreaReport;
  textureAudit(): TextureAuditEntry[];
  /** 当前花瓣层的运行状态；没有挂载花瓣层（不在主页或开关已关）时为 null。 */
  petals(): PetalStats | null;
}

declare global {
  interface Window {
    __sk?: SkDiagnostics;
  }
}

/** 在 target 上挂 __sk。只应在开发构建调用。 */
export function installDevDiagnostics(target: Window = window): SkDiagnostics {
  const doc = target.document;
  const accentAreaDetail = (): AccentAreaReport => {
    const probe = doc.createElement("span");
    probe.hidden = true;
    doc.body.append(probe);
    try {
      const family = resolveAccentFamily(probe);
      return measureAccentArea({ root: doc.documentElement, viewport: { width: target.innerWidth, height: target.innerHeight }, family });
    } finally {
      probe.remove();
    }
  };
  const api: SkDiagnostics = {
    accentArea: () => accentAreaDetail().ratio,
    accentAreaDetail,
    textureAudit: () => auditTextures({ root: doc.documentElement }),
    petals: currentPetalStats,
  };
  target.__sk = api;
  return api;
}
