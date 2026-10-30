import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

interface Block {
  selector: string;
  decls: Map<string, string>;
}

/** 只解析顶层「选择器 { 声明 }」与 @theme 块，足够本文件的结构。 */
function parseBlocks(css: string): Block[] {
  const blocks: Block[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (const m of css.matchAll(re)) {
    const decls = new Map<string, string>();
    for (const part of m[2].split(";")) {
      const at = part.indexOf(":");
      if (at < 0) continue;
      decls.set(part.slice(0, at).trim(), part.slice(at + 1).trim().replace(/\s+/g, " "));
    }
    // 选择器前可能有 @import 一类以分号结尾的语句
    blocks.push({ selector: (m[1].split(";").pop() as string).trim(), decls });
  }
  return blocks;
}

const tokenBlocks = parseBlocks(read("tokens.css"));
const themeBlocks = parseBlocks(read("theme.css"));
const block = (blocks: Block[], selector: string) => {
  const found = blocks.find((b) => b.selector === selector);
  if (!found) throw new Error(`缺少选择器 ${selector}`);
  return found.decls;
};

const ROOT = ":root";
const AMETHYST = ':root[data-sk-accent="amethyst"]';
const MOSS = ':root[data-sk-accent="moss"]';
const NIGHT = ':root[data-sk-mode="night"]';
const NIGHT_AMETHYST = ':root[data-sk-mode="night"][data-sk-accent="amethyst"]';
const NIGHT_MOSS = ':root[data-sk-mode="night"][data-sk-accent="moss"]';

const root = block(tokenBlocks, ROOT);
const inline = block(themeBlocks, "@theme inline");

/** 按层叠顺序合并：后面的块覆盖前面的。 */
function resolve(...selectors: string[]): Map<string, string> {
  const merged = new Map<string, string>();
  for (const selector of selectors) for (const [k, v] of block(tokenBlocks, selector)) merged.set(k, v);
  return merged;
}

const isColorValue = (name: string, value: string, seen = new Set<string>()): boolean => {
  if (/^(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|color-mix\(.*\))$/.test(value)) return true;
  const ref = value.match(/^var\((--sk-[a-z0-9-]+)\)$/);
  if (!ref || seen.has(ref[1])) return false;
  seen.add(name);
  const target = root.get(ref[1]);
  return target !== undefined && isColorValue(ref[1], target, seen);
};

const mapped = (prefix: string) =>
  new Map(
    [...inline]
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, v]) => {
        const ref = v.match(/^var\((--sk-[a-z0-9-]+)\)$/);
        if (!ref) throw new Error(`${k} 应直接引用令牌，实为 ${v}`);
        return [k, ref[1]] as const;
      }),
  );

describe("令牌声明骨架", () => {
  it("令牌只在 :root 系列选择器上声明，顺序为 根、强调色、夜樱、夜樱强调色", () => {
    expect(tokenBlocks.map((b) => b.selector)).toEqual([ROOT, AMETHYST, MOSS, NIGHT, NIGHT_AMETHYST, NIGHT_MOSS]);
  });

  it("强调色块只覆盖四个强调色基础令牌", () => {
    for (const selector of [AMETHYST, MOSS, NIGHT_AMETHYST, NIGHT_MOSS]) {
      expect([...block(tokenBlocks, selector).keys()].sort()).toEqual(["--sk-accent", "--sk-accent-2", "--sk-accent-ink", "--sk-accent-strong"]);
    }
  });

  it("夜樱块只覆盖根上已有的令牌（color-scheme 除外）", () => {
    const extra = [...block(tokenBlocks, NIGHT).keys()].filter((k) => k !== "color-scheme" && !root.has(k));
    expect(extra).toEqual([]);
  });
});

describe("六种强调色组合", () => {
  const combos: [string, string[], [string, string, string, string]][] = [
    ["日·樱粉", [ROOT], ["#CF3080", "#F7B6D2", "#B0296D", "#FFFFFF"]],
    ["日·紫水晶", [ROOT, AMETHYST], ["#8953DF", "#CDB6F5", "#793BDB", "#FFFFFF"]],
    ["日·青苔", [ROOT, MOSS], ["#3F7D49", "#B9DDB0", "#376D3F", "#FFFFFF"]],
    ["夜·樱粉", [ROOT, NIGHT], ["#F06AAE", "#B98CF0", "#FF8CC4", "#1B1620"]],
    ["夜·紫水晶", [ROOT, AMETHYST, NIGHT, NIGHT_AMETHYST], ["#B08CF5", "#E2D3FF", "#C7AAFC", "#1B1620"]],
    ["夜·青苔", [ROOT, MOSS, NIGHT, NIGHT_MOSS], ["#78C287", "#C9E9C0", "#93D6A0", "#1B1620"]],
  ];

  it.each(combos)("%s", (_name, selectors, [accent, accent2, strong, ink]) => {
    const values = resolve(...selectors);
    expect(values.get("--sk-accent")).toBe(accent);
    expect(values.get("--sk-accent-2")).toBe(accent2);
    expect(values.get("--sk-accent-strong")).toBe(strong);
    expect(values.get("--sk-accent-ink")).toBe(ink);
  });
});

describe("Tailwind 主题映射", () => {
  it("默认主题的颜色、圆角、阴影、字体、字号与断点全部清空", () => {
    const reset = block(themeBlocks, "@theme");
    for (const ns of ["color", "radius", "shadow", "font", "font-weight", "text", "leading", "tracking", "breakpoint"]) {
      expect(reset.get(`--${ns}-*`)).toBe("initial");
    }
  });

  it("每个颜色令牌都有 --color-sk-* 工具色，且同名", () => {
    const colorTokens = [...root].filter(([k, v]) => isColorValue(k, v)).map(([k]) => k).sort();
    const colors = mapped("--color-");
    expect(colorTokens.length).toBeGreaterThan(60);
    expect([...colors.values()].sort()).toEqual(colorTokens);
    for (const [utility, tokenName] of colors) expect(utility).toBe(tokenName.replace("--sk-", "--color-sk-"));
  });

  it("圆角、阴影、间距令牌全部映射", () => {
    const pick = (re: RegExp) => [...root.keys()].filter((k) => re.test(k)).sort();
    expect([...mapped("--radius-").values()].sort()).toEqual(pick(/^--sk-r(-|$)/));
    expect([...mapped("--shadow-").values()].sort()).toEqual(pick(/^--sk-shadow/));
    expect([...mapped("--spacing-").values()].sort()).toEqual(pick(/^--sk-(space-\d+|gap|page-.*)$/));
    expect(inline.get("--radius-sk")).toBe("var(--sk-r)");
    expect(inline.get("--spacing-sk-12")).toBe("var(--sk-space-12)");
  });

  it("每个字阶角色都有字号与行高，有字距的角色带字距", () => {
    const roles = [...root.keys()].filter((k) => k.startsWith("--sk-fs-")).map((k) => k.slice("--sk-fs-".length));
    expect(roles).toEqual(["display", "hero", "title", "lead", "heading", "section", "body", "small", "caption", "micro", "mono", "mono-sm", "mono-lg"]);
    for (const role of roles) {
      expect(inline.get(`--text-sk-${role}`)).toBe(`var(--sk-fs-${role})`);
      expect(inline.get(`--text-sk-${role}--line-height`)).toBe(`var(--sk-lh-${role})`);
      expect(inline.get(`--text-sk-${role}--letter-spacing`)).toBe(root.has(`--sk-ls-${role}`) ? `var(--sk-ls-${role})` : undefined);
    }
  });

  it("映射引用的令牌都已声明", () => {
    for (const [k, v] of inline) {
      for (const ref of v.matchAll(/var\((--sk-[a-z0-9-]+)\)/g)) expect(root.has(ref[1]), `${k} 引用了 ${ref[1]}`).toBe(true);
    }
  });

  it("尺寸分档、明暗与减少动画变体按 <html> 属性匹配", () => {
    const css = read("theme.css");
    expect(css).toContain('@custom-variant compact (&:where([data-sk-tier="compact"], [data-sk-tier="compact"] *));');
    expect(css).toContain('@custom-variant wide (&:where([data-sk-tier="wide"], [data-sk-tier="wide"] *));');
    expect(css).toContain('@custom-variant night (&:where([data-sk-mode="night"], [data-sk-mode="night"] *));');
    expect(css).toContain("@custom-variant reduced (&:where([data-sk-reduced], [data-sk-reduced] *));");
  });
});
