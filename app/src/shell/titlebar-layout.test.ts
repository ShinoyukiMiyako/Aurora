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
    const WINDOW_CONTROLS = 134;
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
