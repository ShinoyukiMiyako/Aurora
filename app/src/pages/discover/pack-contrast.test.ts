import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// 本地整合包投放区各状态的文字对比度：按令牌表在两套外观、三种强调色下逐一算出实际颜色，正文至少 4.5:1。
// 投放区放在导入弹窗里，弹窗底色是 --sk-surface；半透明的 accent-soft 叠在它上面。

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const tokensCss = stripComments(readFileSync(new URL("../../styles/tokens.css", import.meta.url), "utf8"));
const packCss = stripComments(readFileSync(new URL("./pack.module.css", import.meta.url), "utf8"));

/** 顶层「选择器 { 声明 }」：两个文件都没有嵌套块。 */
function blocks(css: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = new Map<string, string>();
    for (const part of m[2].split(";")) {
      const at = part.indexOf(":");
      if (at >= 0) decls.set(part.slice(0, at).trim(), part.slice(at + 1).trim().replace(/\s+/g, " "));
    }
    for (const selector of m[1].split(",")) out.set(selector.trim(), decls);
  }
  return out;
}

const tokenBlocks = blocks(tokensCss);
const packBlocks = blocks(packCss);

const APPEARANCES = {
  "日樱 · 樱粉": [":root"],
  "日樱 · 紫水晶": [":root", ':root[data-sk-accent="amethyst"]'],
  "日樱 · 青苔": [":root", ':root[data-sk-accent="moss"]'],
  "夜樱 · 樱粉": [":root", ':root[data-sk-mode="night"]'],
  "夜樱 · 紫水晶": [":root", ':root[data-sk-accent="amethyst"]', ':root[data-sk-mode="night"]', ':root[data-sk-mode="night"][data-sk-accent="amethyst"]'],
  "夜樱 · 青苔": [":root", ':root[data-sk-accent="moss"]', ':root[data-sk-mode="night"]', ':root[data-sk-mode="night"][data-sk-accent="moss"]'],
} as const;

type Rgb = readonly [number, number, number];

function tokensOf(selectors: readonly string[]): Map<string, string> {
  const merged = new Map<string, string>();
  for (const selector of selectors) {
    const decls = tokenBlocks.get(selector);
    if (decls === undefined) throw new Error(`令牌表缺少选择器 ${selector}`);
    for (const [k, v] of decls) merged.set(k, v);
  }
  return merged;
}

function hex(value: string): Rgb {
  const m = /^#([0-9a-fA-F]{6})$/.exec(value);
  if (m === null) throw new Error(`不是六位十六进制色值：${value}`);
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) as unknown as Rgb;
}

/** 把一个令牌值算成不透明色：纯色直接取，「某色 N% 与 transparent 混合」按 N% 不透明度叠到 backdrop 上。 */
function resolveColor(value: string, tokens: Map<string, string>, backdrop: Rgb): Rgb {
  const ref = /^var\((--sk-[a-z0-9-]+)\)$/.exec(value);
  if (ref !== null) {
    const next = tokens.get(ref[1]);
    if (next === undefined) throw new Error(`令牌 ${ref[1]} 没有定义`);
    return resolveColor(next, tokens, backdrop);
  }
  const blend = /^color-mix\(in srgb, (var\(--sk-[a-z0-9-]+\)) (\d+)%, (var\(--sk-[a-z0-9-]+\))\)$/.exec(value);
  if (blend !== null) {
    const first = resolveColor(blend[1], tokens, backdrop);
    const second = resolveColor(blend[3], tokens, backdrop);
    const weight = Number(blend[2]) / 100;
    return first.map((c, i) => c * weight + second[i] * (1 - weight)) as unknown as Rgb;
  }
  const mix = /^color-mix\(in srgb, (var\(--sk-[a-z0-9-]+\)) (\d+)%, transparent\)$/.exec(value);
  if (mix !== null) {
    const color = resolveColor(mix[1], tokens, backdrop);
    const alpha = Number(mix[2]) / 100;
    return color.map((c, i) => c * alpha + backdrop[i] * (1 - alpha)) as unknown as Rgb;
  }
  return hex(value);
}

const channel = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: Rgb) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function decl(selector: string, property: string): string {
  const value = packBlocks.get(selector)?.get(property);
  if (value === undefined) throw new Error(`pack.module.css 的 ${selector} 没有声明 ${property}`);
  return value;
}

const ZONE = ".dropZone";
const OVER = '.dropZone[data-state="over"]';
const READING = '.dropZone[data-state="reading"]';

/** 每种外观下投放区各状态的「前景 / 底色」对比度。 */
function ratios(selectors: readonly string[]) {
  const tokens = tokensOf(selectors);
  const surface = resolveColor("var(--sk-surface)", tokens, [0, 0, 0]);
  const zoneBg = resolveColor(decl(ZONE, "background"), tokens, surface);
  const overBg = resolveColor(decl(OVER, "background"), tokens, surface);
  const fg = (value: string) => resolveColor(value, tokens, surface);
  return {
    // 状态色写在投放区本身上：图标与没有自带颜色的文字都继承它
    over: contrast(fg(decl(OVER, "color")), overBg),
    overTitle: contrast(fg(decl(".dropTitle", "color")), overBg),
    overHint: contrast(fg(decl(".dropHint", "color")), overBg),
    reading: contrast(fg(decl(READING, "color")), zoneBg),
    readingTitle: contrast(fg(decl(".dropTitle", "color")), zoneBg),
  };
}

describe("本地整合包投放区的对比度", () => {
  it.each(Object.entries(APPEARANCES))("%s：拖到上方与读取中两态的前景对底色都不低于 4.5:1", (_name, selectors) => {
    const r = ratios(selectors);
    for (const [part, value] of Object.entries(r)) expect({ part, ok: value >= 4.5 }).toEqual({ part, ok: true });
  });

  it("拖到上方态的状态色取 accent-strong：日樱三色落在 accent-soft 上约 5.3:1，夜樱更高", () => {
    expect(decl(OVER, "color")).toBe("var(--sk-accent-strong)");
    expect(decl(READING, "color")).toBe("var(--sk-accent-strong)");
    const day = ratios(APPEARANCES["日樱 · 樱粉"]);
    expect(day.over).toBeCloseTo(5.29, 2);
    expect(day.reading).toBeCloseTo(5.4, 1);
    expect(ratios(APPEARANCES["日樱 · 紫水晶"]).over).toBeCloseTo(5.25, 2);
    expect(ratios(APPEARANCES["日樱 · 青苔"]).over).toBeCloseTo(5.33, 2);
    expect(ratios(APPEARANCES["夜樱 · 樱粉"]).over).toBeCloseTo(6.25, 2);
    expect(ratios(APPEARANCES["夜樱 · 紫水晶"]).over).toBeCloseTo(6.62, 2);
    expect(ratios(APPEARANCES["夜樱 · 青苔"]).over).toBeCloseTo(7.57, 2);
  });
});

// 需要手动下载的文件清单：「装到 mods/」副文字在弹窗正文（--sk-surface）上，底栏说明在弹窗页脚上。两处都是要被读到的
// 信息，不能用只给装饰与禁用的 text-3（日樱约 2.1:1）。
const modalCss = stripComments(readFileSync(new URL("../../ui/Modal.module.css", import.meta.url), "utf8"));
const modalBlocks = blocks(modalCss);

function modalFooterBackground(): string {
  const value = modalBlocks.get(".footer")?.get("background");
  if (value === undefined) throw new Error("Modal.module.css 的 .footer 没有声明 background");
  return value;
}

describe("需要手动下载的文件清单的说明文字", () => {
  it.each(Object.entries(APPEARANCES))("%s：落点副文字与底栏说明对各自底色都不低于 4.5:1", (_name, selectors) => {
    const tokens = tokensOf(selectors);
    const surface = resolveColor("var(--sk-surface)", tokens, [0, 0, 0]);
    const footer = resolveColor(modalFooterBackground(), tokens, surface);
    const dest = contrast(resolveColor(decl(".blockedDest", "color"), tokens, surface), surface);
    const foot = contrast(resolveColor(decl(".blockedFootNote", "color"), tokens, footer), footer);
    expect({ dest: dest >= 4.5, foot: foot >= 4.5 }).toEqual({ dest: true, foot: true });
  });

  it("两处都是 12 号字的 text-2", () => {
    expect(decl(".blockedDest", "color")).toBe("var(--sk-text-2)");
    expect(decl(".blockedDest", "font-size")).toBe("var(--sk-fs-caption)");
    expect(decl(".blockedFootNote", "color")).toBe("var(--sk-text-2)");
    expect(decl(".blockedFootNote", "font-size")).toBe("var(--sk-fs-caption)");
    expect(decl(".blockedFootNote", "line-height")).toBe("var(--sk-lh-caption)");
  });
});
