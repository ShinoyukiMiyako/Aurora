// @vitest-environment jsdom
// 提示气泡里要等动画真的播完的用例：被顶替的气泡何时撤掉、入场从哪一侧浮出。整个文件走真实计时器：
// 假时钟下 framer-motion 的帧跟着假时钟走，与别的用例混在一个文件里换来换去，前面用例排着的帧会让后面的推不动。
import { act, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { focusByKeyboard, render, setRect, type Rendered } from "../test/dom";
import { resetTooltipState, Tooltip } from "./Tooltip";

let view: Rendered | undefined;

beforeEach(() => {
  // 在显示的气泡与预热时刻是全站共享的模块状态：前一个用例留下的不能带进来
  resetTooltipState();
});

afterEach(() => {
  view?.unmount();
  view = undefined;
});

function mount(ui: ReactNode) {
  view = render(
    <OverlayProvider>
      {ui}
      <OverlayRoot />
    </OverlayProvider>,
  );
  return view.container;
}

const button = (label: string) => {
  const el = [...document.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!el) throw new Error(`找不到按钮 ${label}`);
  return el;
};
/** 触发元素当前关联的那个气泡。 */
const bubbleOf = (label: string) => {
  const id = button(label).getAttribute("aria-describedby");
  return id === null ? null : document.getElementById(id);
};
const bubbleTexts = () => [...document.querySelectorAll('[role="tooltip"]')].map((el) => el.textContent);
/** 让 framer-motion 的帧循环走 n 帧，期间的重渲染在 act 收尾时提交。 */
const frames = (n: number) =>
  act(async () => {
    for (let i = 0; i < n; i++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
/** 等气泡完全显示出来：还停在入场起点（全透明）时退场无从播起，看不出区别。 */
const shownFully = (tip: HTMLElement) => vi.waitFor(() => expect(tip.style.opacity).toBe("1"), { timeout: 2000, interval: 5 });

/** React 的 onPointerEnter 由 pointerover 推导，直接派发 pointerenter 收不到。 */
function pointerEnter(el: Element, from: Element = document.body) {
  act(() => {
    el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: from }));
  });
}

function Row() {
  return (
    <>
      <Tooltip content="甲">
        <button>A</button>
      </Tooltip>
      <Tooltip content="乙">
        <button>B</button>
      </Tooltip>
    </>
  );
}

describe("被顶替的气泡", () => {
  // 两个相邻的气泡并存约 80ms、旧的还在淡出：扫视工具栏时一闪一闪
  it("被顶替的旧气泡不播退场，下一帧就撤掉", async () => {
    mount(<Row />);
    focusByKeyboard(button("A"));
    await shownFully(bubbleOf("A") as HTMLElement);
    pointerEnter(button("B"));
    // 照常退场要 80ms，两帧之内还在
    await frames(2);
    expect(bubbleTexts()).toEqual(["乙"]);
  });

  // 驻留已结束、旧气泡正在淡出时，它已不算「显示中」，顶替逻辑够不着它
  it("旧气泡已收起、还在淡出时移到下一个：旧气泡立即撤掉，不与新气泡并存到淡完", async () => {
    mount(<Row />);
    focusByKeyboard(button("A"));
    const first = bubbleOf("A") as HTMLElement;
    await shownFully(first);
    act(() => button("A").blur());
    expect(first.isConnected).toBe(true);
    pointerEnter(button("B"));
    expect(bubbleOf("B")?.hasAttribute("data-instant")).toBe(true);
    // 照常淡出要 80ms，两帧之内还在
    await frames(2);
    expect(first.isConnected).toBe(false);
    expect(bubbleTexts()).toEqual(["乙"]);
  });

  it("自己正在淡出时又被移回来：同一个气泡接着显示，不被当成别人的退场撤掉", async () => {
    mount(<Row />);
    focusByKeyboard(button("A"));
    const first = bubbleOf("A") as HTMLElement;
    await shownFully(first);
    act(() => button("A").blur());
    pointerEnter(button("A"));
    // 等过原本的淡出时长：还是原来那个元素、没被卸掉，并回到不透明
    await frames(8);
    expect(first.isConnected).toBe(true);
    expect(bubbleOf("A")).toBe(first);
    await shownFully(first);
  });

  // 键盘往回移时新格子的布局副作用先于旧格子：旧气泡随后的 open 转假若把退场改回 fade.quick，两个气泡会并存 80ms
  it.each([
    ["往回移到树里靠前的一格", 1, 0],
    ["往前移到树里靠后的一格", 0, 1],
  ] as const)("强制显示%s：下一帧只剩新的那个气泡", async (_, from, to) => {
    const handle: { at?: (i: number) => void } = {};
    function Cells() {
      const [at, setAt] = useState<number>(from);
      handle.at = setAt;
      return (
        <>
          <Tooltip content="甲" open={at === 0}>
            <button>A</button>
          </Tooltip>
          <Tooltip content="乙" open={at === 1}>
            <button>B</button>
          </Tooltip>
        </>
      );
    }
    mount(<Cells />);
    const labels = ["A", "B"];
    await shownFully(bubbleOf(labels[from]) as HTMLElement);
    act(() => handle.at?.(to));
    expect(bubbleOf(labels[to])?.hasAttribute("data-instant")).toBe(true);
    await frames(2);
    expect(bubbleTexts()).toEqual([["甲", "乙"][to]]);
  });
});

describe("入场方向", () => {
  // 挂载那一帧还没定位，起点按首选的上方给的话，翻到下方后气泡是从远离锚点的一侧往锚点浮
  it("翻到对侧时入场从锚点那一侧浮出", async () => {
    const container = mount(
      <Tooltip content="提示" side="top">
        <button>A</button>
      </Tooltip>,
    );
    setRect(container.querySelector("[data-sk-overlay-root]") as HTMLElement, { left: 0, top: 0, width: 1000, height: 700 });
    setRect(button("A"), { left: 100, top: 4, width: 80, height: 30 });
    focusByKeyboard(button("A"));
    const tip = document.querySelector<HTMLElement>('[role="tooltip"]') as HTMLElement;
    expect(tip.dataset.side).toBe("bottom");
    const firstY = await vi.waitFor(
      () => {
        const match = /translateY\((-?[\d.]+)px\)/.exec(tip.style.transform);
        if (match === null) throw new Error(`入场还没写到元素上：${tip.style.transform}`);
        return Number(match[1]);
      },
      { timeout: 2000, interval: 1 },
    );
    expect(firstY).toBeLessThan(0);
  });
});
