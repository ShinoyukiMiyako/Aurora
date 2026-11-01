// 标题栏搜索入口的宽度预算。jsdom 不做布局，这里按样式表与字号算：regular 档要放得下完整的占位文字，
// 不能被省略号截成半句；一边加宽一边算上右列让出的宽度，最窄的 regular 窗口里左列还放得下后退前进与页面名。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TITLEBAR_COPY } from "../copy/shell";
import { TIER_REGULAR_MIN } from "./tier";

const titleBar = readFileSync(new URL("./TitleBar.module.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const tokens = readFileSync(new URL("../styles/tokens.css", import.meta.url), "utf8");

function token(name: string): number {
  const m = new RegExp(`--sk-${name}:\\s*(\\d+)px`).exec(tokens);
  if (m === null) throw new Error(`tokens.css 里没有 --sk-${name}`);
  return Number(m[1]);
}

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
    const SIDEBAR = 84;
    const ACCOUNT_CAPSULE = 140;
    const WINDOW_CONTROLS = 134;
    const ISLAND_MAX = 280;
    const ICON_BUTTON = 34;
    const HISTORY = 62;
    const right = SEARCH_WIDTH + token("space-8") + ICON_BUTTON + token("space-8") + ACCOUNT_CAPSULE + token("space-4") + WINDOW_CONTROLS;
    const padding = token("space-4");
    const gaps = 2 * token("space-12");
    const left = TIER_REGULAR_MIN - SIDEBAR - padding - gaps - right - ISLAND_MAX;
    expect(left).toBeGreaterThanOrEqual(HISTORY + token("space-8") + 4 * token("fs-heading"));
  });
});
