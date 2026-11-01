// 计算样式里的颜色解析。Canvas 读不到 CSS 变量，派生色令牌又是 color-mix() 公式，
// 只能让浏览器把它算成计算值再在这里拆成通道。计算值只会是 rgb / rgba 函数或 color(srgb …) 两类写法，
// 其余写法说明令牌改用了别的色彩空间，直接报错，不猜。

/** 0-255 的整数通道，a 同样按 0-255 存，便于直接写进 ImageData。 */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const FUNCTION = /^([a-z]+)\((.*)\)$/;

function channel(raw: string, unit: number, what: string, source: string): number {
  const text = raw.trim();
  const percent = text.endsWith("%");
  const value = Number(percent ? text.slice(0, -1) : text);
  if (text === "" || !Number.isFinite(value)) throw new Error(`颜色「${source}」的${what}「${raw}」不是数值`);
  const scaled = percent ? (value / 100) * 255 : value * unit;
  return Math.round(Math.min(255, Math.max(0, scaled)));
}

/** 拆分「a b c / d」或「a, b, c, d」两种参数写法。 */
function splitArgs(body: string, source: string): { components: string[]; alpha: string | null } {
  if (body.includes(",")) {
    const parts = body.split(",");
    if (parts.length !== 3 && parts.length !== 4) throw new Error(`颜色「${source}」的参数个数不对`);
    return { components: parts.slice(0, 3), alpha: parts.length === 4 ? parts[3] : null };
  }
  const [main, alpha, extra] = body.split("/");
  if (extra !== undefined) throw new Error(`颜色「${source}」含多个「/」`);
  return { components: main.trim().split(/\s+/), alpha: alpha === undefined ? null : alpha };
}

/** 解析计算样式给出的颜色；无法识别的写法抛错。 */
export function parseComputedColor(value: string): Rgba {
  const source = value.trim();
  const m = FUNCTION.exec(source);
  if (!m) throw new Error(`无法识别的计算颜色「${value}」`);
  const [, fn, body] = m;
  if (fn === "rgb" || fn === "rgba") {
    const { components, alpha } = splitArgs(body, source);
    if (components.length !== 3) throw new Error(`颜色「${source}」应有 3 个通道`);
    return {
      r: channel(components[0], 1, "红色通道", source),
      g: channel(components[1], 1, "绿色通道", source),
      b: channel(components[2], 1, "蓝色通道", source),
      a: alpha === null ? 255 : channel(alpha, 255, "透明度", source),
    };
  }
  if (fn === "color") {
    const { components, alpha } = splitArgs(body, source);
    const [space, ...rgb] = components;
    if (space !== "srgb") throw new Error(`颜色「${source}」不在 sRGB 空间，花瓣与诊断只认 sRGB`);
    if (rgb.length !== 3) throw new Error(`颜色「${source}」应有 3 个通道`);
    return {
      r: channel(rgb[0], 255, "红色通道", source),
      g: channel(rgb[1], 255, "绿色通道", source),
      b: channel(rgb[2], 255, "蓝色通道", source),
      a: alpha === null ? 255 : channel(alpha, 255, "透明度", source),
    };
  }
  throw new Error(`无法识别的计算颜色「${value}」`);
}

/** 两个颜色在每个通道上相差不超过 tolerance（0-255 刻度）即视为同色，用来吸收不同写法换算时的舍入。 */
export function sameColor(a: Rgba, b: Rgba, tolerance = 1): boolean {
  return Math.abs(a.r - b.r) <= tolerance && Math.abs(a.g - b.g) <= tolerance && Math.abs(a.b - b.b) <= tolerance && Math.abs(a.a - b.a) <= tolerance;
}

/**
 * 在 probe 元素上把 color 设成 var(name) 后读计算值，得到令牌在当前外观下的实际颜色。
 * 用元素自身做探针，令牌沿根元素继承下来，不需要往文档里插临时节点。
 */
export function resolveColorToken(probe: HTMLElement, name: `--${string}`): Rgba {
  // 未声明的令牌让 var() 在计算期失效，color 会静默继承父元素的文字色，必须先确认令牌存在
  if (getComputedStyle(probe).getPropertyValue(name).trim() === "") throw new Error(`令牌 ${name} 未声明`);
  probe.style.color = `var(${name})`;
  try {
    return parseComputedColor(getComputedStyle(probe).color);
  } finally {
    probe.style.removeProperty("color");
  }
}
