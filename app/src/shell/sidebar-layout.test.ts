import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SIDEBAR_PIN_LIMIT } from "../domain/limits";
import { RING_OUTSET } from "../launch/InstanceAvatar";

const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");
const css = strip(readFileSync(new URL("./Sidebar.module.css", import.meta.url), "utf8"));
const shellCss = strip(readFileSync(new URL("./AppShell.module.css", import.meta.url), "utf8"));
const titleBarCss = strip(readFileSync(new URL("./TitleBar.module.css", import.meta.url), "utf8"));
const tokens = strip(readFileSync(new URL("../styles/tokens.css", import.meta.url), "utf8"));
const tauriConf = JSON.parse(readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8")) as { app: { windows: { minHeight: number }[] } };

function ruleOf(selector: string, source = css): string {
  const rule = new RegExp(`(?:^|\\n)${selector.replace(".", "\\.")} \\{([^}]*)\\}`).exec(source);
  if (rule === null) throw new Error(`没有 ${selector} 规则`);
  return rule[1];
}

function declaration(rule: string, property: string): string {
  const match = new RegExp(`(?:^|\\s)${property}: ([^;]+);`).exec(rule);
  if (match === null) throw new Error(`规则里没有 ${property}`);
  return match[1];
}

function spaceToken(value: string): number {
  const name = /var\((--sk-space-\d+)\)/.exec(value);
  if (name === null) throw new Error(`不是间距令牌：${value}`);
  const token = new RegExp(`${name[1]}: (\\d+)px;`).exec(tokens);
  if (token === null) throw new Error(`令牌表里没有 ${name[1]}`);
  return Number(token[1]);
}

const px = (value: string): number => {
  const match = /^(\d+)px$/.exec(value);
  if (match === null) throw new Error(`不是像素值：${value}`);
  return Number(match[1]);
};

function tokenPx(name: string): number {
  const token = new RegExp(`${name}: (\\d+)px;`).exec(tokens);
  if (token === null) throw new Error(`令牌表里没有 ${name}`);
  return Number(token[1]);
}

const PIN_AVATAR_SIZE = 40;

describe("胶囊与品牌行", () => {
  const brand = ruleOf(".brand", shellCss);
  const capsule = ruleOf(".capsule");
  const titleBarHeight = px(declaration(ruleOf(".bar", titleBarCss), "height"));
  const brandHeight = px(declaration(brand, "height"));

  const capsuleTop = (): number => {
    const top = /^calc\((\d+)px \+ var\((--sk-page-pad-top)\)\)$/.exec(declaration(capsule, "top"));
    if (top === null) throw new Error("胶囊的 top 不是品牌行加页面顶内边距");
    return Number(top[1]) + tokenPx(top[2]);
  };

  it("品牌行与标题栏同高，胶囊上沿让过它并落到内容区首行", () => {
    expect(brandHeight).toBe(titleBarHeight);
    expect(capsuleTop()).toBe(brandHeight + tokenPx("--sk-page-pad-top"));
  });

  it("徽记左缘对齐胶囊左缘，胶囊底部仍留原来的 10px", () => {
    expect(spaceToken(declaration(brand, "padding-left"))).toBe(spaceToken(declaration(capsule, "left")));
    expect(spaceToken(declaration(capsule, "bottom"))).toBe(10);
  });

  it("品牌行的宽度跟着内容走，伸出槽位的字标也在拖动区里", () => {
    expect(declaration(brand, "position")).toBe("absolute");
    expect(/(?:^|\s)width:/.test(brand)).toBe(false);
    expect(declaration(brand, "min-width")).toBe("100%");
  });

  it("最小窗口高度下，胶囊放得下固定满额的实例；再矮时列表能收缩滚动，不把设置挤出胶囊", () => {
    const minHeight = tauriConf.app.windows[0].minHeight;
    const gap = spaceToken(declaration(capsule, "gap"));
    const item = px(declaration(ruleOf(".pin"), "height"));
    // .create 的尺寸写在最后一条规则里，前面那条是 .item、.pin 共用的外观
    const create = [...css.matchAll(/\n\.create \{([^}]*)\}/g)].at(-1)?.[1];
    if (create === undefined) throw new Error("没有 .create 规则");
    const createHeight = px(declaration(create, "height")) + 2 * spaceToken(declaration(create, "margin"));
    const separator = px(declaration(ruleOf(".separator"), "height")) + 2 * spaceToken(declaration(ruleOf(".separator"), "margin"));
    const pinGutter = spaceToken(declaration(ruleOf(".pins"), "padding"));
    // 胶囊的直接子项：四个主导航、分隔线、固定列表、新建、留白、设置
    const fixed = 5 * item + separator + createHeight;
    const childGaps = 8 * gap;
    const chrome = 2 * spaceToken(declaration(capsule, "padding")) + 2;
    const room = minHeight - capsuleTop() - spaceToken(declaration(capsule, "bottom")) - chrome - fixed - childGaps + 2 * pinGutter;
    const pinsContent = SIDEBAR_PIN_LIMIT * item + (SIDEBAR_PIN_LIMIT - 1) * gap + 2 * pinGutter;
    expect(room).toBeGreaterThanOrEqual(pinsContent);

    const scroller = ruleOf(".pinScroll");
    expect(declaration(scroller, "flex")).toBe("0 1 auto");
    expect(declaration(scroller, "min-height")).toBe("0");
    expect(declaration(scroller, "overflow-y")).toBe("auto");
  });
});

describe("固定实例的滚动容器", () => {
  const pinSize = Number(/(\d+)px/.exec(declaration(ruleOf(".pin"), "height"))?.[1]);
  const gutter = spaceToken(declaration(ruleOf(".pins"), "padding"));

  it("上下留的余量放得下超出固定项的选中环、进度环与焦点环", () => {
    const avatarInset = (pinSize - PIN_AVATAR_SIZE) / 2;
    const focus = /--sk-focus: 0 0 0 \d+px [^,]+, 0 0 0 (\d+)px /.exec(tokens);
    if (focus === null) throw new Error("令牌表里没有 --sk-focus");
    expect(gutter).toBeGreaterThanOrEqual(RING_OUTSET - avatarInset);
    expect(gutter).toBeGreaterThanOrEqual(Number(focus[1]));
  });

  it("余量用负外边距抵消，胶囊里各行的位置不因此下移", () => {
    const margin = declaration(ruleOf(".pinScroll"), "margin");
    expect(margin).toMatch(/^calc\(-1 \* var\(--sk-space-\d+\)\) 0$/);
    expect(spaceToken(margin)).toBe(gutter);
  });
});
