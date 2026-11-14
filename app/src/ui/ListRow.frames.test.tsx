// @vitest-environment jsdom
// 列表行逐帧看入场从哪一帧开始走的用例。整个文件走假时钟、用 stepFrames 一帧一帧地推：
// 每个用例开始前先在真实计时器上把帧循环排空再换假时钟，收尾先卸载、再排空、再换回真实计时器（见 test/dom 的 drainFrames）。
import { MotionConfig } from "framer-motion";
import { act, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { drainFrames, render, stepFrames, type Rendered } from "../test/dom";
import { List, ListRow, ROW_MOTION_LIMIT } from "./ListRow";

let view: Rendered | undefined;
let setItems: (next: string[]) => void = () => undefined;

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

const BASE = ["甲", "乙", "丙"];
const batch = (count: number) => Array.from({ length: count }, (_, i) => `多${i}`);

function Changing({ initial }: { initial: string[] }) {
  const [items, set] = useState(initial);
  setItems = set;
  return (
    <List variant="flush">
      {items.map((name) => (
        <ListRow key={name} title={name} />
      ))}
    </List>
  );
}

const tree = (reducedMotion: "never" | "always") => (
  <MotionConfig reducedMotion={reducedMotion}>
    <Changing initial={BASE} />
  </MotionConfig>
);

const row = (name: string): HTMLElement => {
  const found = [...document.querySelectorAll<HTMLElement>("ul > li:not([inert])")].filter((li) => li.textContent === name);
  if (found.length !== 1) throw new Error(`「${name}」应当恰好一行，实为 ${found.length}`);
  return found[0];
};

const shown = (li: HTMLElement) => [li.style.opacity, li.style.transform];

it.each([
  ["逐行入场的新行", "never", "scale(0.98)"],
  ["逐行入场的新行", "always", ""],
  ["整批换上的新行", "never", ""],
] as const)("%s（减少动画 %s）：第一帧画的仍是起点，画出来之后才开始入场，那次提交再长也不吃掉入场的开头", async (who, reducedMotion, from) => {
  view = render(tree(reducedMotion));
  const added = who === "逐行入场的新行" ? ["丁"] : batch(ROW_MOTION_LIMIT + 1);
  act(() => setItems([BASE[0], ...(who === "逐行入场的新行" ? BASE.slice(1) : []), ...added]));
  const arriving = row(added[0]);
  expect(shown(arriving)).toEqual(["0", from]);
  await stepFrames(1);
  expect(shown(arriving)).toEqual(["0", from]);
  // 放行排在绘制之后的任务里，假时钟要再推进一帧才到点
  await stepFrames(2);
  const opacity = Number(arriving.style.opacity);
  expect(opacity).toBeGreaterThan(0);
  expect(opacity).toBeLessThan(1);
  if (from === "") {
    // 减少动画与整批换上时只有透明度在走
    expect(arriving.style.transform).not.toMatch(/scale/);
  } else {
    const scale = /^scale\((.+)\)$/.exec(arriving.style.transform);
    if (scale === null) throw new Error(`新行没有在落到位的半路上：${arriving.style.transform}`);
    expect(Number(scale[1])).toBeGreaterThan(0.98);
    expect(Number(scale[1])).toBeLessThan(1);
  }
  await stepFrames(60);
  expect(arriving.style.opacity).toBe("1");
  expect(arriving.style.transform).toMatch(from === "" ? /^(none)?$/ : /^none$/);
  // 挂载时就在、留下来的那一行停在终点（目标里带着缩放时 framer-motion 写的是 none）
  expect(row(BASE[0]).style.opacity).toBe("1");
  expect(row(BASE[0]).style.transform).toMatch(/^(none)?$/);
});

it("新行画出来之前列表又渲染了一次：下一次渲染里它已不算新来的，入场照样等到画出来之后才起步", async () => {
  view = render(tree("never"));
  act(() => setItems([...BASE, "丁"]));
  const arriving = row("丁");
  // 同一刻又来一次更新（进度上报、换了别的数据）：这一次的行集合里丁已在上一次，List 不再把它算作新来的
  act(() => setItems([...BASE, "丁"]));
  await stepFrames(1);
  expect(shown(arriving)).toEqual(["0", "scale(0.98)"]);
  await stepFrames(2);
  const opacity = Number(arriving.style.opacity);
  expect(opacity).toBeGreaterThan(0);
  expect(opacity).toBeLessThan(1);
});
