import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RING_OUTSET } from "../launch/InstanceAvatar";

const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");
const css = strip(readFileSync(new URL("./Sidebar.module.css", import.meta.url), "utf8"));
const tokens = strip(readFileSync(new URL("../styles/tokens.css", import.meta.url), "utf8"));

function ruleOf(selector: string): string {
  const rule = new RegExp(`(?:^|\\n)${selector.replace(".", "\\.")} \\{([^}]*)\\}`).exec(css);
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

const PIN_AVATAR_SIZE = 40;

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
