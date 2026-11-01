// @vitest-environment jsdom
import { MotionConfig } from "framer-motion";
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NO_ART, setArtStatus } from "../../mc/art";
import { clearArtCache } from "../../mc/useArt";
import { render, stubMatchMedia, type Rendered } from "../../test/dom";
import { stubCanvas, type CanvasStub } from "../illustrations/test-canvas";
import { AccountFigure } from "./AccountFigure";
import { skinFigureCanvas, type LoadedSkin } from "./render";

const REMOTE = { kind: "remote", sha1: "ee".repeat(20), model: "wide", hat: true } as const;

let view: Rendered | undefined;
let canvas: CanvasStub;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let clock: number;
let bitmap: { width: number; height: number } | null;

/** 跑完当前排队的一帧；jsdom 没有 requestAnimationFrame，帧由测试手动推进。 */
function runFrame(ms = 16) {
  clock += ms;
  const pending = [...frames.values()];
  frames.clear();
  act(() => {
    for (const callback of pending) callback(clock);
  });
}

beforeEach(() => {
  stubMatchMedia(false);
  canvas = stubCanvas();
  frames = new Map();
  nextFrame = 1;
  clock = 1000;
  bitmap = null;
  vi.stubGlobal("navigator", { userAgent: "Windows" });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(["skin"]) })));
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => {
      bitmap = { width: 64, height: 64 };
      return bitmap;
    }),
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  HTMLCanvasElement.prototype.setPointerCapture = vi.fn();
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  setArtStatus(NO_ART);
  clearArtCache();
  vi.unstubAllGlobals();
});

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

const spinCanvas = () => view?.container.querySelector<HTMLCanvasElement>('canvas[data-tauri-drag-region="false"]') ?? null;

function requireCanvas() {
  const element = spinCanvas();
  if (element === null) throw new Error("没有可拖动的立绘画布");
  return element;
}

function pointer(type: string, clientX: number, init: PointerEventInit = {}) {
  act(() => {
    requireCanvas().dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX, ...init }));
  });
}

const figure = (extra: { interactive?: boolean; label?: string } = { interactive: true }) => <AccountFigure uuid="u1" skin={REMOTE} scale={6} {...extra} />;

async function mount(ui: ReactNode = figure()) {
  view = render(ui);
  await settle();
}

const onDisplay = () => canvas.draws.filter((d) => d.canvas === spinCanvas());
const cachedDrawn = () => onDisplay().filter((d) => d.source === skinFigureCanvas(loaded(), 6, 1));

function loaded(): LoadedSkin {
  if (bitmap === null) throw new Error("皮肤还没取到");
  return { bitmap: bitmap as ImageBitmap, format: "modern", hat: true, model: "wide" };
}

/** 按下、拖动 dx，再推进一帧把这次姿态画出来。 */
function dragBy(dx: number) {
  pointer("pointerdown", 100);
  pointer("pointermove", 100 + dx);
  runFrame();
}

describe("AccountFigure：可拖动的立绘", () => {
  it("没传 interactive 时贴缓存位图，没有可拖动的画布", async () => {
    await mount(figure({}));
    expect(view?.container.querySelector("[data-art]")?.getAttribute("data-art")).toBe("skin");
    expect(spinCanvas()).toBeNull();
  });

  it("剪影不响应拖动：皮肤取不到时 interactive 也没有可拖动的画布", async () => {
    view = render(<AccountFigure uuid="u2" skin={null} scale={6} interactive />);
    await settle();
    expect(spinCanvas()).toBeNull();
  });

  it("不进键盘焦点序列，也不是窗口拖动区；label 时根元素仍是 role=img", async () => {
    await mount(figure({ interactive: true, label: "Steve 的立绘" }));
    const element = requireCanvas();
    expect(element.hasAttribute("tabindex")).toBe(false);
    expect(element.getAttribute("aria-hidden")).toBe("true");
    const root = view?.container.firstElementChild;
    expect(root?.getAttribute("role")).toBe("img");
    expect(root?.getAttribute("aria-label")).toBe("Steve 的立绘");
  });

  it("静止时不跑循环：挂载后只贴一次缓存位图，帧队列是空的", async () => {
    await mount();
    expect(frames.size).toBe(0);
    expect(cachedDrawn()).toHaveLength(1);
    expect(onDisplay()).toHaveLength(1);
  });

  it("拖动时只在姿态变化后申请一帧，画完不再排下一帧", async () => {
    await mount();
    pointer("pointerdown", 100);
    expect(frames.size).toBe(0);
    pointer("pointermove", 160);
    pointer("pointermove", 170);
    expect(frames.size).toBe(1);
    const before = onDisplay().length;
    runFrame();
    expect(frames.size).toBe(0);
    // 转动中的姿态现画，不走默认姿态的缓存
    expect(onDisplay().length).toBeGreaterThan(before);
    expect(cachedDrawn()).toHaveLength(1);
  });

  it("移动不到判定距离不算拖动，也不重画", async () => {
    await mount();
    pointer("pointerdown", 100);
    pointer("pointermove", 103);
    expect(frames.size).toBe(0);
    pointer("pointerup", 103);
    expect(frames.size).toBe(0);
    expect(onDisplay()).toHaveLength(1);
  });

  it("松手后缓动回默认姿态：逐帧重画，到位后贴回缓存位图并停下", async () => {
    await mount();
    dragBy(60);
    pointer("pointerup", 160);
    expect(frames.size).toBe(1);
    let steps = 0;
    while (frames.size > 0) {
      runFrame();
      expect(++steps).toBeLessThan(120);
    }
    // 不是一帧跳回去：中间确实走了好几帧
    expect(steps).toBeGreaterThan(5);
    expect(cachedDrawn()).toHaveLength(2);
    expect(onDisplay()[onDisplay().length - 1].source).toBe(skinFigureCanvas(loaded(), 6, 1));
  });

  it("减少动画：松手直接回位，不排帧", async () => {
    await mount(<MotionConfig reducedMotion="always">{figure()}</MotionConfig>);
    dragBy(60);
    const before = cachedDrawn().length;
    pointer("pointerup", 160);
    expect(frames.size).toBe(0);
    expect(cachedDrawn()).toHaveLength(before + 1);
  });

  it("回位途中按住又原地松手：继续回位，不会停在半路", async () => {
    await mount();
    dragBy(60);
    pointer("pointerup", 160);
    runFrame();
    runFrame();
    pointer("pointerdown", 300);
    runFrame();
    expect(frames.size).toBe(0);
    pointer("pointerup", 300);
    expect(frames.size).toBe(1);
    while (frames.size > 0) runFrame();
    expect(onDisplay()[onDisplay().length - 1].source).toBe(skinFigureCanvas(loaded(), 6, 1));
  });

  it("指针被系统收走时按松手处理", async () => {
    await mount();
    dragBy(60);
    pointer("pointercancel", 160);
    expect(frames.size).toBe(1);
  });

  it("只响应主键，别的指针的移动不算", async () => {
    await mount();
    pointer("pointerdown", 100, { button: 2 });
    pointer("pointermove", 200);
    expect(frames.size).toBe(0);
    pointer("pointerdown", 100);
    pointer("pointermove", 200, { pointerId: 2 });
    expect(frames.size).toBe(0);
  });

  it("捕获指针：拖出画布范围照样跟手", async () => {
    await mount();
    pointer("pointerdown", 100);
    expect(HTMLCanvasElement.prototype.setPointerCapture).toHaveBeenCalledWith(1);
  });

  it("卸载时取消排着的帧", async () => {
    await mount();
    dragBy(60);
    pointer("pointerup", 160);
    expect(frames.size).toBe(1);
    view?.unmount();
    view = undefined;
    expect(frames.size).toBe(0);
  });

  describe("放在按钮里（主页的立绘是「管理账户」按钮）", () => {
    let onClick: Mock<() => void>;

    const inButton = async () => {
      onClick = vi.fn<() => void>();
      await mount(
        <button type="button" onClick={onClick}>
          {figure()}
        </button>,
      );
    };

    const click = () => act(() => requireCanvas().click());

    it("拖完松手产生的 click 不触发按钮", async () => {
      await inButton();
      dragBy(60);
      pointer("pointerup", 160);
      click();
      expect(onClick).not.toHaveBeenCalled();
    });

    it("手抖的短按仍是点按钮", async () => {
      await inButton();
      pointer("pointerdown", 100);
      pointer("pointermove", 102);
      pointer("pointerup", 102);
      click();
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("只吞一次：拖完的下一次点按恢复正常", async () => {
      await inButton();
      dragBy(60);
      pointer("pointerup", 160);
      click();
      pointer("pointerdown", 100);
      pointer("pointerup", 100);
      click();
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("拖完没有产生 click 时，吞 click 的标记不留到下一次", async () => {
      await inButton();
      dragBy(60);
      pointer("pointercancel", 160);
      pointer("pointerdown", 100);
      pointer("pointerup", 100);
      click();
      expect(onClick).toHaveBeenCalledTimes(1);
    });
  });
});
