// 组件测试用的 Canvas 替身（只被 *.test.tsx 引用）：jsdom 没有 2D 上下文、OffscreenCanvas 与 ImageData。
// 替身记录每一次 drawImage 的参数，测试据此断言画了哪张图的哪一块。

import { vi } from "vitest";

export interface DrawCall {
  canvas: { width: number; height: number };
  source: unknown;
  args: number[];
}

export interface CanvasStub {
  draws: DrawCall[];
  /** 某个源上取过的 (sx, sy, sw, sh) 矩形。 */
  sourceRects(source: unknown): string[];
}

class FakeImageData {
  readonly data: Uint8ClampedArray;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint8ClampedArray(width * height * 4);
  }
}

export function stubCanvas(): CanvasStub {
  const draws: DrawCall[] = [];
  const makeContext = (canvas: { width: number; height: number }) => ({
    canvas,
    imageSmoothingEnabled: true,
    imageSmoothingQuality: "low",
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    putImageData: vi.fn(),
    getImageData: (_x: number, _y: number, w: number, h: number) => new FakeImageData(w, h),
    drawImage: (source: unknown, ...args: number[]) => draws.push({ canvas, source, args }),
  });

  class FakeOffscreenCanvas {
    private ctx = makeContext(this);
    constructor(
      public width: number,
      public height: number,
    ) {}
    getContext() {
      return this.ctx;
    }
    transferToImageBitmap() {
      return { width: this.width, height: this.height, from: this };
    }
  }

  vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
  vi.stubGlobal("ImageData", FakeImageData);
  const contexts = new WeakMap<HTMLCanvasElement, ReturnType<typeof makeContext>>();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    let ctx = contexts.get(this);
    if (!ctx) {
      ctx = makeContext(this);
      contexts.set(this, ctx);
    }
    return ctx as unknown as CanvasRenderingContext2D;
  } as never);

  return {
    draws,
    sourceRects: (source) => draws.filter((d) => d.source === source).map((d) => d.args.slice(0, 4).join(",")),
  };
}
