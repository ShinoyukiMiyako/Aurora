// @vitest-environment jsdom
// 整合包表单里会动的几处：换封面时舞台方块的那一下、转成只读时几块的进出与让位。
// 舞台方块弹回的用例逐帧看途中的值，走假时钟（startFrameClock）；其余用例按真实时间等 framer-motion 的帧循环把动画播完。

import { MotionConfig } from "framer-motion";
import { act, useCallback, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COVER_PRESETS, type InstanceCover } from "../../art/iso/covers";
import type { SpringName } from "../../lib/motion";
import { OverlayProvider, OverlayRoot } from "../../shell/overlay";
import { drainFrames, render, stepFrames, stubResizeObserver, waitForFrames, type Rendered } from "../../test/dom";
import { PackForm, type PackFacts } from "./PackForm";

// 方块要读材质、画 canvas，和这里要验的位移无关：换成一个标着封面的占位
vi.mock("../../art/iso/InstanceAvatarBase", () => ({
  InstanceAvatarBase: ({ cover }: { cover: InstanceCover }) => <i data-avatar={cover.block} />,
}));
vi.mock("../../state/launcher", () => ({
  useLauncherSelector: <T,>(pick: (s: { sidebarPins: unknown[]; settings: null }) => T) => pick({ sidebarPins: [], settings: null }),
}));
// jsdom 没有布局，让位本身不动；记下哪些容器挂了让位
const reflowed = vi.hoisted(() => new Set<Element>());
vi.mock("../../lib/reflow", async (orig) => {
  const real = await orig<typeof import("../../lib/reflow")>();
  return {
    ...real,
    useReflow: <T extends HTMLElement>(spring?: SpringName) => {
      const ref = real.useReflow<T>(spring);
      return useCallback(
        (el: T | null) => {
          if (el !== null) reflowed.add(el);
          return ref(el);
        },
        [ref],
      );
    },
  };
});

const FACTS: PackFacts = { mcVersion: "1.21.1", loader: "fabric", modCount: 3, downloadBytes: 1024 };
const [FIRST, SECOND] = COVER_PRESETS;

let view: Rendered | null = null;
/** 这个用例的帧跟着假时钟走（startFrameClock）：收尾先卸载、再在假时钟上把帧循环排空，才换回真实计时器。 */
let frameClock = false;

afterEach(async () => {
  view?.unmount();
  view = null;
  if (frameClock) await drainFrames();
  frameClock = false;
  vi.useRealTimers();
  reflowed.clear();
});

/**
 * 断言弹回途中取值的用例让帧跟着假时钟走，用 stepFrames 逐帧推进。按真实时间走的话，机器满载时两帧之间可能隔得比
 * 整段弹回还长，下一帧直接写成落定的 none，录到的缩放里就没有走近原大的那几帧。录到的第一帧倒不受影响：
 * framer-motion 建动画与解析关键帧相隔超过 40 ms 时从解析的那一帧起算，第一帧最多走 40 ms。
 * 换之前先在真实计时器上把帧循环排空（见 test/dom 的 drainFrames）。
 */
async function startFrameClock() {
  await drainFrames();
  vi.useFakeTimers();
  frameClock = true;
}

interface FormOptions {
  reduced?: "always" | "never";
  readOnly?: boolean;
  version?: ReactNode;
}

function form(cover: InstanceCover, { reduced = "never", readOnly = false, version = null }: FormOptions = {}): ReactNode {
  return (
    <MotionConfig reducedMotion={reduced}>
      <OverlayProvider>
        <PackForm seed="pack" name="生存" onName={() => {}} nameError={null} cover={cover} onCover={() => {}} version={version} facts={FACTS} readOnly={readOnly} />
        <OverlayRoot />
      </OverlayProvider>
    </MotionConfig>
  );
}

/** 舞台方块那一层（方块占位的外层）。换封面面板关着，页面上只有这一个方块。 */
function stage(): HTMLElement {
  const avatar = document.querySelector("[data-avatar]");
  const el = avatar?.parentElement;
  if (el === null || el === undefined) throw new Error("没有舞台方块");
  return el;
}

/** 记下这一层的内联样式每次被写成什么。 */
function record(el: HTMLElement): { transforms: string[]; opacities: string[]; stop: () => void } {
  const transforms: string[] = [];
  const opacities: string[] = [];
  const watcher = new MutationObserver(() => {
    transforms.push(el.style.transform);
    opacities.push(el.style.opacity);
  });
  watcher.observe(el, { attributes: true, attributeFilter: ["style"] });
  return { transforms, opacities, stop: () => watcher.disconnect() };
}

const scales = (transforms: string[]) =>
  transforms.flatMap((t) => {
    const m = /scale\(([\d.]+)\)/.exec(t);
    return m === null ? [] : [Number(m[1])];
  });

/** 舞台方块的弹回（pop 弹簧）在这么多帧（约 1 秒）之内落定。 */
const SETTLE_FRAMES = 60;

describe("舞台方块换封面", () => {
  it("挂载时不动；换了封面从 0.94 弹回原大", async () => {
    await startFrameClock();
    view = render(form(FIRST));
    const el = stage();
    const written = record(el);
    await stepFrames(4);
    expect(written.transforms).toEqual([]);

    view.rerender(form(SECOND));
    await stepFrames(SETTLE_FRAMES);
    expect(written.transforms.at(-1)).toBe("none");
    written.stop();
    const seen = scales(written.transforms);
    // 帧一帧不落：录到的第一帧离提交只隔一帧，弹簧只走了一小截
    expect(seen[0]).toBeLessThan(0.95);
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(0.94);
    // 一帧帧弹回：走了好几帧才过 0.99，此前逐帧变大，不是一下跳到原大
    const near = seen.findIndex((s) => s > 0.99);
    expect(near).toBeGreaterThan(3);
    for (let i = 1; i <= near; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
  });

  it("减少动画时不缩放，只从透明淡入", async () => {
    view = render(form(FIRST, { reduced: "always" }));
    const el = stage();
    const written = record(el);
    view.rerender(form(SECOND, { reduced: "always" }));
    await waitForFrames(() => expect(written.opacities.at(-1)).toBe("1"));
    written.stop();
    expect(Number(written.opacities[0])).toBeLessThan(1);
    expect(scales(written.transforms)).toEqual([]);
  });
});

describe("换封面面板里的勾标", () => {
  // 浮层按面板尺寸重新定位，jsdom 没有 ResizeObserver
  beforeEach(() => {
    stubResizeObserver();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** 打开换封面面板，取此刻选中那一格的勾标。 */
  function openPicker(): HTMLElement {
    const button = [...document.querySelectorAll("button")].find((b) => b.textContent === "换封面");
    if (button === undefined) throw new Error("没有换封面按钮");
    act(() => button.click());
    const check = document.querySelector<HTMLElement>('[role="radio"][aria-checked="true"] [data-cover-check]');
    if (check === null) throw new Error("换封面面板里选中的那一格没有勾标");
    return check;
  }

  it("换到别的一格：旧格的勾标缩回 0.6 并淡出，新格的勾标从 0.6 弹出", async () => {
    view = render(form(FIRST));
    const old = openPicker();
    const written = record(old);
    view.rerender(form(SECOND));
    const fresh = document.querySelector<HTMLElement>('[role="radio"][aria-checked="true"] [data-cover-check]');
    expect(fresh).not.toBe(old);
    expect(fresh?.style.opacity).toBe("0");
    expect(fresh?.style.transform).toBe("scale(0.6)");

    await waitForFrames(() => expect(old.isConnected).toBe(false));
    written.stop();
    // 只淡出不缩小时（行内标签那一档的退场）这里一个缩放值都录不到
    const seen = scales(written.transforms);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toBeCloseTo(0.6, 6);
    expect(seen.every((s) => s >= 0.6 - 1e-6 && s <= 1)).toBe(true);
    expect(written.opacities.at(-1)).toBe("0");
  });

  it("减少动画时旧格的勾标只淡出，进出都不缩放", async () => {
    view = render(form(FIRST, { reduced: "always" }));
    const old = openPicker();
    const written = record(old);
    view.rerender(form(SECOND, { reduced: "always" }));
    const fresh = document.querySelector<HTMLElement>('[role="radio"][aria-checked="true"] [data-cover-check]');
    expect(fresh?.style.opacity).toBe("0");
    expect(fresh?.style.transform).toBe("");

    await waitForFrames(() => expect(old.isConnected).toBe(false));
    written.stop();
    expect(scales(written.transforms)).toEqual([]);
    expect(written.opacities.at(-1)).toBe("0");
  });
});

describe("转成只读", () => {
  const VERSION = <span data-version="">版本 2.0.0</span>;
  const nameInput = () => document.querySelector<HTMLInputElement>("input");
  const coverButton = () => [...document.querySelectorAll("button")].find((b) => b.textContent === "换封面");
  /** 在场（不在退场层里）的名称文字。 */
  const nameText = () => [...document.querySelectorAll("span")].find((s) => s.textContent === "生存" && s.closest("[inert]") === null);
  /** 包着元素、最近一层写了内联透明度的祖先（进出那一层）上的透明度；没有这一层为 null。 */
  const layerOpacity = (el: Element | null | undefined) => {
    for (let node = el?.parentElement; node !== null && node !== undefined; node = node.parentElement) if (node.style.opacity !== "") return node.style.opacity;
    return null;
  };
  /** 元素还在 DOM 里、且在正在淡出的退场层里。 */
  const leaving = (el: Element | null | undefined) => {
    if (el === null || el === undefined) throw new Error("该淡出的那一块已经不在 DOM 里");
    return el.closest("[inert]") !== null;
  };

  it("名称框、换封面与版本行原地淡出（退场层不可交互），名称文字淡入；名称与标签所在的栈挂着让位", () => {
    view = render(form(FIRST, { version: VERSION }));
    expect(nameText()).toBeUndefined();

    view.rerender(form(FIRST, { readOnly: true }));
    expect(leaving(nameInput())).toBe(true);
    expect(leaving(coverButton())).toBe(true);
    expect(leaving(document.querySelector("[data-version]"))).toBe(true);
    const shown = nameText();
    if (shown === undefined) throw new Error("转成只读后没有名称文字");
    const layer = shown.parentElement;
    expect(layerOpacity(shown)).toBe("0");
    // 名称那一层与标签同在一个让位容器里：名称框换成一行文字变矮时，标签滑上去
    const tags = [...document.querySelectorAll("span")].find((s) => s.textContent === "1.21.1")?.parentElement;
    expect(tags?.parentElement).toBe(layer?.parentElement);
    expect(reflowed.has(tags?.parentElement as Element)).toBe(true);
  });

  it("一开始就是只读：名称文字不另播入场，没有换封面与名称框", () => {
    view = render(form(FIRST, { readOnly: true }));
    expect(nameText()).toBeDefined();
    expect(layerOpacity(nameText())).not.toBe("0");
    expect(nameInput()).toBeNull();
    expect(coverButton()).toBeUndefined();
  });

  it("从只读回到可编辑（取消了安装）：换封面与名称框淡入", () => {
    view = render(form(FIRST, { readOnly: true }));
    view.rerender(form(FIRST));
    expect(leaving(coverButton())).toBe(false);
    expect(layerOpacity(coverButton())).toBe("0");
    expect(leaving(nameInput())).toBe(false);
    expect(layerOpacity(nameInput())).toBe("0");
  });
});
