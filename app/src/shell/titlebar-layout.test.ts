// 标题栏的宽度预算。jsdom 不做布局，这里按样式表与字号算：regular 档的搜索入口要放得下完整的占位文字，
// 不能被省略号截成半句；一边加宽一边算上右列让出的宽度，最窄的 regular 窗口里左列还放得下后退前进与页面名。
// 左内边距要让开伸出侧栏槽位的品牌字标，它加大多少，左列就少多少。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TITLEBAR_COPY } from "../copy/shell";
import { TIER_REGULAR_MIN } from "./tier";

const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");
const titleBar = stripComments(readFileSync(new URL("./TitleBar.module.css", import.meta.url), "utf8"));
const shell = stripComments(readFileSync(new URL("./AppShell.module.css", import.meta.url), "utf8"));
const logoCss = stripComments(readFileSync(new URL("../art/Logo.module.css", import.meta.url), "utf8"));
const tokens = readFileSync(new URL("../styles/tokens.css", import.meta.url), "utf8");

function token(name: string): number {
  const m = new RegExp(`--sk-${name}:\\s*(\\d+)px`).exec(tokens);
  if (m === null) throw new Error(`tokens.css 里没有 --sk-${name}`);
  return Number(m[1]);
}

/** 某条规则里写成 var(--sk-space-N) 的内边距。 */
function paddingLeft(css: string, selector: string): number {
  const rule = new RegExp(`(?:^|\\n)\\${selector}\\s*\\{([^}]*)\\}`).exec(css);
  if (rule === null) throw new Error(`没有 ${selector} 规则`);
  const m = /padding-left:\s*var\(--sk-(space-\d+)\)/.exec(rule[1]);
  if (m === null) throw new Error(`${selector} 的左内边距不是间距令牌`);
  return token(m[1]);
}

const BAR_PADDING = paddingLeft(titleBar, ".bar");
const SIDEBAR = 84;

const SEARCH_WIDTH = (() => {
  const m = /(?:^|\n)\.search\s*\{[^}]*?\n\s*width:\s*(\d+)px/.exec(titleBar);
  if (m === null) throw new Error("TitleBar.module.css 的 .search 没有写宽度");
  return Number(m[1]);
})();

/** 某条规则的声明块，选择器按字面匹配。 */
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (rule === null) throw new Error(`没有 ${selector} 规则`);
  return rule[1];
}

/** 规则里写成 Npx 或 var(--sk-space-N) 的长度；规则里没写这条属性时为 null。 */
function lengthOf(css: string, selector: string, property: string): number | null {
  const m = new RegExp(`(?:^|[\\s;])${property}:\\s*(?:(\\d+)px|var\\(--sk-(space-\\d+)\\))`).exec(ruleBody(css, selector));
  if (m === null) return null;
  return m[1] !== undefined ? Number(m[1]) : token(m[2]);
}

function requiredLength(css: string, selector: string, property: string): number {
  const value = lengthOf(css, selector, property);
  if (value === null) throw new Error(`${selector} 没有写 ${property}`);
  return value;
}

/** 窗口三键的几何：最小化与最大化的命中区宽、关闭键的命中区宽、圆的直径、关闭键的圆离命中区左缘的距离。 */
const WIN = {
  button: requiredLength(titleBar, ".winButton", "width"),
  close: requiredLength(titleBar, ".winButton[data-close]", "width"),
  face: requiredLength(titleBar, ".winFace", "width"),
  closeInset: requiredLength(titleBar, ".winButton[data-close] .winFace", "margin-left"),
};

/** 真机量出来的「Ctrl」「K」两枚键帽连间距的宽度，jsdom 量不了。 */
const KEY_HINT_WIDTH = 53;
const ICON_WIDTH = 16;
const BORDERS = 2;

/** 中文按整字宽算：比省略号实际占的宽，留出字体差异的余量。 */
const PLACEHOLDER_WIDTH = [...TITLEBAR_COPY.searchPlaceholder].length * token("fs-small");

/** 左右内边距、边框、放大镜、键帽与两道间距之后，留给占位文字的宽度。 */
const textRoom = (searchWidth: number) => searchWidth - BORDERS - token("space-10") - token("space-6") - ICON_WIDTH - KEY_HINT_WIDTH - 2 * token("space-8");

describe("标题栏搜索入口的宽度", () => {
  it("regular 档放得下完整的占位文字", () => {
    expect(textRoom(SEARCH_WIDTH)).toBeGreaterThanOrEqual(PLACEHOLDER_WIDTH);
  });

  it("最窄的 regular 窗口、状态岛开到最宽时，左列放得下两个历史键和四个字的页面名", () => {
    const ACCOUNT_CAPSULE = 140;
    const WINDOW_CONTROLS = 2 * WIN.button + WIN.close;
    const ISLAND_MAX = 280;
    const ICON_BUTTON = 34;
    const HISTORY = 62;
    const right = SEARCH_WIDTH + token("space-8") + ICON_BUTTON + token("space-8") + ACCOUNT_CAPSULE + token("space-4") + WINDOW_CONTROLS;
    const gaps = 2 * token("space-12");
    const left = TIER_REGULAR_MIN - SIDEBAR - BAR_PADDING - gaps - right - ISLAND_MAX;
    expect(left).toBeGreaterThanOrEqual(HISTORY + token("space-8") + 4 * token("fs-heading"));
  });
});

describe("左上角品牌与后退键", () => {
  /** 真机量出来的 <Logo size={20} /> 宽度（77.61）向上取整，jsdom 量不了。 */
  const LOGO_WIDTH = 78;

  it("后退键和字标之间至少留 8px", () => {
    const wordmarkEnd = paddingLeft(shell, ".brand") + LOGO_WIDTH;
    expect(SIDEBAR + BAR_PADDING - wordmarkEnd).toBeGreaterThanOrEqual(token("space-8"));
  });

  it("字标不写死颜色：外壳给 Logo 换的颜色要传得到文字，窗口失焦时才看得出来", () => {
    const wordmark = /(?:^|\n)\.wordmark\s*\{([^}]*)\}/.exec(logoCss);
    if (wordmark === null) throw new Error("Logo.module.css 没有 .wordmark");
    expect(/(?:^|\s)color:/.test(wordmark[1])).toBe(false);
    expect(/(?:^|\n)\.logo\s*\{[^}]*\scolor: var\(--sk-text\);/.test(logoCss)).toBe(true);
    expect(/\.brand\[data-blurred\] \.stripLogo\s*\{\s*color: var\(--sk-text-2\);/.test(shell)).toBe(true);
  });
});

describe("窗口三键", () => {
  it("三个圆之间等距，关闭键的圆离窗口右缘也是这个距离", () => {
    // 关闭键前面另加的空隙和在命中区里居中，正是三键看着不等距的来由
    expect(lengthOf(titleBar, ".winButton[data-close]", "margin-left")).toBeNull();
    expect(ruleBody(titleBar, ".winButton[data-close]")).toMatch(/\sjustify-items:\s*start;/);
    const side = (WIN.button - WIN.face) / 2;
    const minToMax = 2 * side;
    const maxToClose = side + WIN.closeInset;
    const toEdge = WIN.close - WIN.closeInset - WIN.face;
    expect(minToMax).toBe(token("space-8"));
    expect(maxToClose).toBe(minToMax);
    expect(toEdge).toBe(minToMax);
  });

  it("可见底色是正圆", () => {
    expect(requiredLength(titleBar, ".winFace", "height")).toBe(WIN.face);
    expect(ruleBody(titleBar, ".winFace")).toMatch(/\sborder-radius:\s*var\(--sk-r-pill\);/);
  });

  it("关闭键悬停只染浅红，按下才转正红", () => {
    const hover = ruleBody(titleBar, ".winButton[data-close]:hover .winFace");
    expect(hover).toMatch(/\sbackground:\s*var\(--sk-danger-soft\);/);
    expect(hover).toMatch(/\scolor:\s*var\(--sk-danger\);/);
    const active = ruleBody(titleBar, ".winButton[data-close]:active .winFace");
    expect(active).toMatch(/\sbackground:\s*var\(--sk-win-close\);/);
    expect(active).toMatch(/\scolor:\s*var\(--sk-win-close-ink\);/);
  });
});
