// @vitest-environment jsdom
// Field 提示行里提示与错误怎么交接，逐帧看。整个文件走假时钟、用 stepFrames 一帧一帧地推：
// 每个用例开始前先在真实计时器上把帧循环排空再换假时钟，收尾先卸载、再排空、再换回真实计时器（见 test/dom 的 drainFrames）。
import { MotionConfig } from "framer-motion";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertItem } from "../lib/motion";
import { drainFrames, render, stepFrames, type Rendered } from "../test/dom";
import { Field } from "./Field";

let view: Rendered | undefined;

beforeEach(async () => {
  await drainFrames();
  vi.useFakeTimers();
});

afterEach(async () => {
  view?.unmount();
  view = undefined;
  await drainFrames();
  vi.useRealTimers();
});

const HINT = "目录不存在会自动创建";
const ERROR = "路径里不能有「!」";

interface Shape {
  hint?: ReactNode;
  error?: string;
  reserve?: boolean;
  reduced?: boolean;
}

const tree = ({ hint, error, reserve = false, reduced = false }: Shape) => (
  <MotionConfig reducedMotion={reduced ? "always" : "never"}>
    <Field label="游戏目录" hint={hint} error={error} reserve={reserve}>
      <input />
    </Field>
  </MotionConfig>
);

const message = (): HTMLElement => {
  const el = view?.container.querySelector<HTMLElement>("[aria-live]");
  if (el === null || el === undefined) throw new Error("播报区没有挂上");
  return el;
};

/** 提示行里写着这句话的那一层（播报区的直接子元素）。 */
const layerOf = (text: string): HTMLElement => {
  const el = [...message().children].find((child) => child.textContent === text);
  if (!(el instanceof HTMLElement)) throw new Error(`提示行里没有单独一层写着「${text}」：${message().innerHTML}`);
  return el;
};

/** 在流内、没在退场的层。 */
const shown = (): HTMLElement[] => [...message().querySelectorAll<HTMLElement>(":scope > :not([inert])")];

/** jsdom 不做布局：给这一层一个尺寸，popLayout 量得到它才会把它抽出布局。 */
const sized = (el: HTMLElement): HTMLElement => {
  el.style.width = "320px";
  el.style.height = "18px";
  return el;
};

const scaleOf = (el: HTMLElement): number => {
  const scale = /^scale\((.+)\)$/.exec(el.style.transform);
  if (scale === null) throw new Error(`这一层没有在缩放的半路上：${el.style.transform}`);
  return Number(scale[1]);
};

const midway = (value: string) => {
  const n = Number(value);
  expect(n).toBeGreaterThan(0);
  expect(n).toBeLessThan(1);
};

describe.each([
  ["默认", false],
  ["减少动画", true],
] as const)("%s", (_, reduced) => {
  it.each([
    ["提示换成错误", { hint: HINT }, { hint: HINT, error: ERROR }, HINT, ERROR],
    ["错误换回提示", { hint: HINT, error: ERROR }, { hint: HINT }, ERROR, HINT],
  ] as const)("%s：换下去的一层带 inert 抽出布局、留在原处淡出；换上来的一层第一帧画的仍是起点，画出来之后才入场", async (_, before, after, leavingText, enteringText) => {
    view = render(tree({ ...before, reduced }));
    const leaving = sized(layerOf(leavingText));
    view.rerender(tree({ ...after, reduced }));
    // 换的那次提交里旧的一层还在，不一帧消失；它已让出位置，叠在新的一层上淡出
    expect(leaving.isConnected).toBe(true);
    expect(leaving.hasAttribute("inert")).toBe(true);
    expect(leaving.dataset.motionPopId).toBeDefined();
    const entering = layerOf(enteringText);
    expect(shown()).toEqual([entering]);

    await stepFrames(1);
    expect(entering.style.opacity).toBe("0");
    // 减少动画时换成只动透明度的参数，不留一个一步到位的缩放
    expect(entering.style.transform).toBe(reduced ? "" : `scale(${insertItem.initial.scale})`);

    // 放行排在绘制之后的任务里，假时钟要再推进一帧才到点
    await stepFrames(2);
    midway(entering.style.opacity);
    midway(leaving.style.opacity);
    if (reduced) {
      expect(entering.style.transform).toBe("");
      expect(leaving.style.transform).toBe("");
    } else {
      expect(scaleOf(entering)).toBeGreaterThan(insertItem.initial.scale);
      expect(scaleOf(leaving)).toBeLessThan(1);
    }

    await stepFrames(60);
    expect(leaving.isConnected).toBe(false);
    expect(entering.style.opacity).toBe("1");
    expect(entering.style.transform).toBe(reduced ? "" : "none");
  });

  it.each([
    ["提示", { hint: HINT }, HINT],
    ["错误", { error: ERROR }, ERROR],
  ] as const)("预留一行、%s时有时无：后出现时画出第一帧之后才淡入；撤掉时原地淡出，播报区仍是同一个节点、仍占着那一行", async (_, shape, text) => {
    view = render(tree({ reserve: true, reduced }));
    const region = message();
    expect(region.childNodes.length).toBe(0);

    view.rerender(tree({ ...shape, reserve: true, reduced }));
    const layer = sized(layerOf(text));
    await stepFrames(1);
    expect(layer.style.opacity).toBe("0");
    await stepFrames(2);
    midway(layer.style.opacity);
    await stepFrames(60);
    expect(layer.style.opacity).toBe("1");

    view.rerender(tree({ reserve: true, reduced }));
    expect(message()).toBe(region);
    expect(region.dataset.reserve).toBe("true");
    expect(layer.hasAttribute("inert")).toBe(true);
    expect(layer.dataset.motionPopId).toBeDefined();
    await stepFrames(3);
    midway(layer.style.opacity);
    await stepFrames(60);
    expect(layer.isConnected).toBe(false);
    expect(region.childNodes.length).toBe(0);
  });
});

it("提示淡出途中错误又被改好：同一块提示从当前透明度淡回来，不先跳回透明；没站稳的错误随之原地淡出", async () => {
  view = render(tree({ hint: HINT }));
  const hint = sized(layerOf(HINT));
  view.rerender(tree({ hint: HINT, error: ERROR }));
  const error = sized(layerOf(ERROR));
  await stepFrames(4);
  const halfway = Number(hint.style.opacity);
  expect(halfway).toBeGreaterThan(0);
  expect(halfway).toBeLessThan(1);

  view.rerender(tree({ hint: HINT }));
  expect(layerOf(HINT)).toBe(hint);
  expect(hint.hasAttribute("inert")).toBe(false);
  expect(error.hasAttribute("inert")).toBe(true);
  await stepFrames(1);
  expect(Number(hint.style.opacity)).toBeGreaterThanOrEqual(halfway);
  await stepFrames(60);
  expect(hint.style.opacity).toBe("1");
  expect(error.isConnected).toBe(false);
  expect(shown()).toEqual([hint]);
});

it.each([
  ["提示", { hint: HINT }, HINT],
  ["错误", { hint: HINT, error: ERROR }, ERROR],
] as const)("挂载时就在的%s跟着所在页面或弹窗入场，自己不播", async (_, shape, text) => {
  view = render(tree(shape));
  const layer = layerOf(text);
  expect(layer.style.opacity).toBe("1");
  await stepFrames(3);
  expect(layer.style.opacity).toBe("1");
  expect(shown()).toEqual([layer]);
});

it("提示与错误各自原地换字：同一层，不退场、不重播入场", async () => {
  view = render(tree({ hint: <span data-tone="ok">可以用</span> }));
  const hint = layerOf("可以用");
  view.rerender(tree({ hint: <span data-tone="warn">不太标准</span> }));
  expect(layerOf("不太标准")).toBe(hint);
  expect(message().children.length).toBe(1);
  await stepFrames(3);
  expect(hint.style.opacity).toBe("1");

  view.rerender(tree({ hint: HINT, error: ERROR }));
  await stepFrames(60);
  const error = layerOf(ERROR);
  view.rerender(tree({ hint: HINT, error: "这个文件夹不能写" }));
  expect(layerOf("这个文件夹不能写")).toBe(error);
  expect(message().children.length).toBe(1);
  await stepFrames(3);
  expect(error.style.opacity).toBe("1");
});

it.each([
  ["不给", undefined],
  ["null", null],
  ["false", false],
  ["空串", ""],
] as const)("提示%s、也没有错误：播报区里什么都不画，不占上距", (_, hint) => {
  view = render(tree({ hint }));
  expect(message().childNodes.length).toBe(0);
});

it("播报区是常驻的同一个节点：错误出现、消失时 id、aria-live 与 data-reserve 不变，data-error 跟着错误走", async () => {
  view = render(tree({ hint: HINT, reserve: true }));
  const region = message();
  const id = region.id;
  expect(region.getAttribute("aria-live")).toBe("polite");
  expect(region.hasAttribute("data-error")).toBe(false);

  view.rerender(tree({ hint: HINT, error: ERROR, reserve: true }));
  expect(message()).toBe(region);
  expect(region.id).toBe(id);
  expect(region.getAttribute("aria-live")).toBe("polite");
  expect(region.dataset.error).toBe("true");
  expect(region.dataset.reserve).toBe("true");
  await stepFrames(60);

  view.rerender(tree({ hint: HINT, reserve: true }));
  expect(message()).toBe(region);
  expect(region.hasAttribute("data-error")).toBe(false);
  expect(shown().map((layer) => layer.textContent)).toEqual([HINT]);
});

/** Field.module.css 里的规则：[选择器, 声明块]，注释已去掉。 */
const fieldCssRules = () => {
  const css = readFileSync(resolve(__dirname, "Field.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  return [...css.matchAll(/(?:^|\n)([^{}\n]+)\{([^}]*)\}/g)].map((m) => [m[1].trim(), m[2]] as const);
};

it("样式：播报区是退场层的定位基准；错误色写在错误层自己身上，交接时退场的提示不变红、退场的错误不变灰", () => {
  const rules = fieldCssRules();
  const body = (selector: string) => {
    const found = rules.find(([s]) => s === selector);
    if (found === undefined) throw new Error(`Field.module.css 没有 ${selector} 规则`);
    return found[1];
  };
  expect(body(".message")).toContain("position: relative;");
  expect(body(".error")).toContain("color: var(--sk-danger);");
  // 播报区上不再按错误态整体改色：那会连正在淡出的提示一起染红
  expect(rules.filter(([selector, decl]) => selector.startsWith(".message") && decl.includes("--sk-danger"))).toEqual([]);
});

it("样式：减少动画时有一层在退场，播报区纵向裁到自己的下沿；平时不裁，横向也不裁", () => {
  // 换下去的一块比换上来的高时，抽出布局的退场层按旧高度伸出播报区。减少动画时下面的内容不让位、一步到位上移，
  // 伸出的那一行会整段压在它上面淡出；平时下面的内容从旧位置滑上来，退场层淡得差不多了才碰到，裁了反而让那一行一帧消失
  const clipping = fieldCssRules().filter(([selector, decl]) => selector.includes(".message") && decl.includes("overflow"));
  expect(clipping.map(([selector]) => selector)).toEqual([":global([data-sk-reduced]) .message:has(> [inert])"]);
  const [[, decl]] = clipping;
  expect(decl).toContain("overflow-y: clip;");
  // 只裁纵向：overflow 简写或 overflow-x 会连横向一起裁，hidden 还会把播报区变成滚动容器
  expect(decl).not.toMatch(/overflow(-x)?\s*:/);
});
