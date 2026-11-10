// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { keydown, render, setRect, stubResizeObserver, type Rendered, type ResizeObserverStub } from "../test/dom";
import { KEY_COMMIT_DELAY_MS, SLIDER_THUMB, Slider, visibleMarks, type SliderMark, type SliderProps } from "./Slider";

let view: Rendered | undefined;
let observers: ResizeObserverStub;

beforeEach(() => {
  observers = stubResizeObserver();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  // jsdom 没有指针捕获
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value: () => undefined });
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
  delete (HTMLElement.prototype as { setPointerCapture?: unknown }).setPointerCapture;
});

interface Spies {
  changes: number[];
  commits: number[];
}

function mount(props: Partial<SliderProps> & { initial: number }, spies: Spies) {
  function Host() {
    const [value, setValue] = useState(props.initial);
    return (
      <Slider
        min={0}
        max={100}
        step={1}
        format={(v) => `${v} 个`}
        ariaLabel="同时下载的文件数"
        {...props}
        value={value}
        onChange={(v) => {
          spies.changes.push(v);
          setValue(v);
        }}
        onCommit={(v) => spies.commits.push(v)}
      />
    );
  }
  const wrap = (ui: ReactNode) => (
    <OverlayProvider>
      {ui}
      <OverlayRoot />
    </OverlayProvider>
  );
  view = render(wrap(<Host />));
  const input = document.querySelector<HTMLInputElement>('input[type="range"]') as HTMLInputElement;
  const control = input.parentElement as HTMLElement;
  return { input, control };
}

const spies = (): Spies => ({ changes: [], commits: [] });
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

/** 命中区 220 宽、从 x=0 开始：去掉两端各半个圆钮后可用 200px，值 v（0-100）在 x = 10 + 2v。 */
function layout(control: HTMLElement) {
  setRect(control, { left: 0, top: 0, width: 200 + SLIDER_THUMB, height: 22 });
}
const xOf = (v: number) => SLIDER_THUMB / 2 + v * 2;

function pointer(el: Element, type: "pointerdown" | "pointermove" | "pointerup", clientX: number) {
  act(() => {
    el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX, pointerId: 7, button: 0 }));
  });
}

describe("键盘：步进与边界钳制", () => {
  it("方向键一步、PageUp / PageDown 十步，Home / End 到两端", () => {
    const s = spies();
    const { input } = mount({ initial: 50, step: 2 }, s);
    keydown(input, "ArrowRight");
    keydown(input, "ArrowUp");
    keydown(input, "ArrowLeft");
    keydown(input, "PageUp");
    keydown(input, "PageDown");
    keydown(input, "PageDown");
    keydown(input, "End");
    keydown(input, "Home");
    expect(s.changes).toEqual([52, 54, 52, 72, 52, 32, 100, 0]);
    expect(input.getAttribute("aria-valuetext")).toBe("0 个");
  });

  it("到达两端后继续按不再变化，PageUp 越界时钳在最大值", () => {
    const s = spies();
    const { input } = mount({ initial: 95 }, s);
    keydown(input, "PageUp");
    keydown(input, "ArrowRight");
    keydown(input, "End");
    expect(s.changes).toEqual([100]);
    keydown(input, "Home");
    keydown(input, "ArrowLeft");
    keydown(input, "PageDown");
    expect(s.changes).toEqual([100, 0]);
  });

  it("非整步的最大值也能到达：步进结果超出上限时钳到上限", () => {
    const s = spies();
    const { input } = mount({ initial: 1024, min: 1024, max: 3000, step: 512 }, s);
    keydown(input, "PageUp");
    expect(s.changes).toEqual([3000]);
    keydown(input, "ArrowLeft");
    // 从 3000 退一步后落回步长网格：1024 + round((3000 − 512 − 1024) / 512) × 512 = 2560
    expect(s.changes).toEqual([3000, 2560]);
    keydown(input, "PageDown");
    expect(s.changes).toEqual([3000, 2560, 1024]);
  });

  it("键盘停顿 400 ms 后只提交最后一次的值", () => {
    const s = spies();
    const { input } = mount({ initial: 10 }, s);
    keydown(input, "ArrowRight");
    advance(KEY_COMMIT_DELAY_MS - 1);
    keydown(input, "ArrowRight");
    advance(KEY_COMMIT_DELAY_MS - 1);
    expect(s.commits).toEqual([]);
    advance(1);
    expect(s.commits).toEqual([12]);
  });

  it("尚未提交的键盘改动在卸载时立即提交", () => {
    const s = spies();
    const { input } = mount({ initial: 10 }, s);
    keydown(input, "ArrowLeft");
    view?.unmount();
    view = undefined;
    expect(s.commits).toEqual([9]);
  });
});

describe("指针：跟手、钳制与松手提交", () => {
  it("按下即跳到指针处，拖出轨道两端时钳在边界，松手只提交一次", () => {
    const s = spies();
    const { control } = mount({ initial: 0 }, s);
    layout(control);
    pointer(control, "pointerdown", xOf(30));
    pointer(control, "pointermove", xOf(64));
    pointer(control, "pointermove", 999);
    pointer(control, "pointermove", -50);
    expect(s.changes).toEqual([30, 64, 100, 0]);
    expect(s.commits).toEqual([]);
    pointer(control, "pointermove", xOf(41));
    pointer(control, "pointerup", xOf(41));
    expect(s.commits).toEqual([41]);
  });

  it("按下又在原值松手不提交", () => {
    const s = spies();
    const { control } = mount({ initial: 20 }, s);
    layout(control);
    pointer(control, "pointerdown", xOf(20));
    pointer(control, "pointerup", xOf(20));
    expect(s.changes).toEqual([]);
    expect(s.commits).toEqual([]);
  });

  it("按下的跳位仍走过渡；拖出新值后撤掉过渡 1:1 跟手，松手恢复；不改值的抖动不撤", () => {
    const s = spies();
    const { control } = mount({ initial: 0 }, s);
    layout(control);
    const root = control.closest("[data-tone]") as HTMLElement;
    pointer(control, "pointerdown", xOf(70));
    expect(s.changes).toEqual([70]);
    expect(root.hasAttribute("data-dragging")).toBe(true);
    expect(root.hasAttribute("data-following")).toBe(false);
    // 半个像素的抖动换算后还是 70：不算开始拖动
    pointer(control, "pointermove", xOf(70) + 0.5);
    expect(root.hasAttribute("data-following")).toBe(false);
    pointer(control, "pointermove", xOf(72));
    expect(s.changes).toEqual([70, 72]);
    expect(root.hasAttribute("data-following")).toBe(true);
    pointer(control, "pointerup", xOf(72));
    expect(root.hasAttribute("data-following")).toBe(false);
    expect(root.hasAttribute("data-dragging")).toBe(false);
    expect(s.commits).toEqual([72]);
  });

  it("禁用时指针与键盘都无效", () => {
    const s = spies();
    const { control, input } = mount({ initial: 20, disabled: true }, s);
    layout(control);
    pointer(control, "pointerdown", xOf(80));
    keydown(input, "ArrowRight");
    expect(s.changes).toEqual([]);
    expect(input.disabled).toBe(true);
  });
});

describe("吸附", () => {
  it("距吸附点 8px 内吸住，离开超过 12px 才脱开；键盘不吸附", () => {
    const s = spies();
    const { control, input } = mount({ initial: 0, snapTo: [50] }, s);
    layout(control);
    // 吸附半径 max(8, 220 × 2%) = 8：x 差 6px（值差 3）吸到 50
    pointer(control, "pointerdown", xOf(47));
    expect(s.changes).toEqual([50]);
    // 离吸附点 9px：已经吸住，未超过 12px，保持 50
    pointer(control, "pointermove", xOf(50) + 9);
    // 离吸附点 12px：仍保持
    pointer(control, "pointermove", xOf(50) - 12);
    expect(s.changes).toEqual([50]);
    // 离吸附点 14px：脱开，按指针位置取值 (124 − 10) / 2 = 57
    pointer(control, "pointermove", xOf(50) + 14);
    expect(s.changes).toEqual([50, 57]);
    // 脱开后再靠近到 10px：超出吸附半径 8，不会重新吸住
    pointer(control, "pointermove", xOf(50) + 10);
    expect(s.changes).toEqual([50, 57, 55]);
    pointer(control, "pointerup", xOf(50) + 10);
    expect(s.commits).toEqual([55]);

    keydown(input, "ArrowDown");
    keydown(input, "ArrowDown");
    keydown(input, "ArrowDown");
    keydown(input, "ArrowDown");
    keydown(input, "ArrowDown");
    // 54 → 50 一路逐步经过吸附点，不会被吸住或跳过
    expect(s.changes.slice(3)).toEqual([54, 53, 52, 51, 50]);
  });

  it("宽轨道上吸附半径按 2% 放大", () => {
    const s = spies();
    const { control } = mount({ initial: 0, snapTo: [50] }, s);
    // 宽 1020：可用 1000px，值 v 在 x = 10 + 10v；吸附半径 1020 × 2% = 20.4px
    setRect(control, { left: 0, top: 0, width: 1020, height: 22 });
    pointer(control, "pointerdown", 10 + 10 * 50 - 20);
    expect(s.changes).toEqual([50]);
    pointer(control, "pointerup", 10 + 10 * 50 - 20);
    pointer(control, "pointerdown", 10 + 10 * 50 - 21);
    expect(s.changes).toEqual([50, 48]);
  });
});

describe("刻度避让", () => {
  const marks: SliderMark[] = [0, 10, 20, 40, 100].map((v) => ({ value: v, label: `${v}` }));

  it("中心距不足 44px 时丢弃靠前的一个，终点刻度永远保留", () => {
    // 宽 200：中心分别在 0 / 20 / 40 / 80 / 200。从终点往前比：20 与 40 冲突丢 20；10 与 40 相距 60 保留；0 与 10 冲突丢 0
    expect(visibleMarks(marks, 0, 100, 200).map((m) => m.value)).toEqual([10, 40, 100]);
    // 宽 440：中心距 44 / 44 / 88 / 264，刚好都不冲突
    expect(visibleMarks(marks, 0, 100, 440).map((m) => m.value)).toEqual([0, 10, 20, 40, 100]);
    // 宽 0（尚未测量）：只剩终点
    expect(visibleMarks(marks, 0, 100, 0).map((m) => m.value)).toEqual([100]);
  });

  it("刻度行宽度变化时重新挑选", () => {
    const s = spies();
    mount({ initial: 0, marks }, s);
    const row = document.querySelector<HTMLElement>('[aria-hidden="true"]:not(span)') as HTMLElement;
    const labels = () => [...row.querySelectorAll("span")].map((el) => el.textContent);
    expect(labels()).toEqual(["100"]);
    observers.resize(row, 440);
    expect(labels()).toEqual(["0", "10", "20", "40", "100"]);
    observers.resize(row, 200);
    expect(labels()).toEqual(["10", "40", "100"]);
  });
});

describe("圆钮与填充的样式", () => {
  // 按 CRLF 检出时多行选择器里夹着 \r，先统一成 \n
  const css = readFileSync(resolve(__dirname, "Slider.module.css"), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  function ruleOf(selector: string): string {
    const escaped = selector.replace(/[.[\]()]/g, (ch) => `\\${ch}`);
    const rule = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
    if (rule === null) throw new Error(`没有 ${selector} 规则`);
    return rule[1];
  }

  it("位置只走 translate，不动 left / width", () => {
    const thumb = ruleOf(".thumb");
    const fill = ruleOf(".fill");
    expect(thumb).toContain("translate: calc(var(--slider-p) * (100% - var(--slider-thumb)) + var(--slider-thumb) - 100%) 0;");
    expect(fill).toContain("translate: calc(var(--slider-thumb) / 2 + var(--slider-p) * (100% - var(--slider-thumb)) - 100%) 0;");
    for (const rule of [thumb, fill]) {
      expect(rule).not.toMatch(/(^|\s)(left|width):[^;]*--slider-p/);
    }
    // 行程盒与命中区同宽、圆钮贴右端，圆钮自身按圆钮直径画
    expect(thumb).toContain("right: 0;");
    expect(thumb).toContain("left: 0;");
    expect(thumb).toContain("justify-content: flex-end;");
    expect(ruleOf(".knob")).toContain("width: var(--slider-thumb);");
  });

  it("行程盒任何取值下都不越过命中区右缘：只往起始边一侧伸，不撑出横向滚动", () => {
    // 按样式里的公式求行程盒在命中区坐标里的左右缘：盒宽 = 命中区宽 w，偏移 = p(w − T) + T − w
    const thumb = ruleOf(".thumb");
    const formula = /translate: calc\(var\(--slider-p\) \* \(100% - var\(--slider-thumb\)\) \+ var\(--slider-thumb\) - 100%\) 0;/;
    expect(thumb).toMatch(formula);
    for (const w of [SLIDER_THUMB * 3, 220, 500, 1020]) {
      for (const p of [0, 0.25, 0.5, 1]) {
        const shift = p * (w - SLIDER_THUMB) + SLIDER_THUMB - w;
        const box = { left: shift, right: shift + w };
        const knob = { left: box.right - SLIDER_THUMB, right: box.right };
        expect(box.right).toBeLessThanOrEqual(w);
        // 圆钮中心落在可用轨道上 p 处，与填充的右缘、刻度中心一致
        expect((knob.left + knob.right) / 2).toBeCloseTo(SLIDER_THUMB / 2 + p * (w - SLIDER_THUMB), 10);
      }
    }
  });

  it("非跟手时沿 settle 过渡，跟手与减少动画时不过渡；圆钮悬停与拿起的缩放走 tap", () => {
    expect(ruleOf(".thumb,\n.fill")).toContain("transition: translate var(--sk-spring-settle-dur) var(--sk-spring-settle);");
    expect(ruleOf(".slider[data-following] .thumb,\n.slider[data-following] .fill")).toContain("transition: none;");
    expect(ruleOf(":global([data-sk-reduced]) .thumb,\n:global([data-sk-reduced]) .fill")).toContain("transition: none;");
    expect(ruleOf(".knob")).toContain("transition: transform var(--sk-spring-tap-dur) var(--sk-spring-tap);");
  });
});

describe("参数校验", () => {
  it("max 不大于 min、step 非正、名称为空时抛错", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => mount({ initial: 5, min: 10, max: 10 }, spies())).toThrow("必须大于 min");
    expect(() => mount({ initial: 5, step: 0 }, spies())).toThrow("step 必须为正数");
    expect(() => mount({ initial: 5, ariaLabel: " " }, spies())).toThrow("ariaLabel 不能为空");
  });
});
