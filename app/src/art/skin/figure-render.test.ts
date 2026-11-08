import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { figureQuads, REST_POSE } from "./figure3d";
import { FIGURE_FRAME } from "./layout";
import { paintSkinFigure, silhouetteFigureCanvas, skinFigureCanvas, type LoadedSkin } from "./render";

// 这里的替身比 test-canvas 多做一件事：皮肤像素按坐标编码（R = x，G = y），
// putImageData 写进去的内容留在画布上，能断言每个面图切的是哪一块、乘了多少亮度。

interface Draw {
  source: FakeCanvas;
  args: number[];
  transform: number[] | null;
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

class FakeCanvas {
  image: FakeImageData | null = null;
  transform: number[] | null = null;
  readonly draws: Draw[] = [];
  readonly context = {
    imageSmoothingEnabled: true,
    setTransform: (...m: number[]) => {
      this.transform = m;
    },
    drawImage: (source: FakeCanvas, ...args: number[]) => {
      this.draws.push({ source, args, transform: this.transform });
    },
    putImageData: (image: FakeImageData) => {
      this.image = image;
    },
    getImageData: (x: number, y: number, w: number, h: number) => {
      const image = new FakeImageData(w, h);
      for (let row = 0; row < h; row++) {
        for (let col = 0; col < w; col++) {
          const i = (row * w + col) * 4;
          image.data[i] = x + col;
          image.data[i + 1] = y + row;
          image.data[i + 3] = 200;
        }
      }
      return image;
    },
  };
  constructor(
    public width: number,
    public height: number,
  ) {}
  getContext() {
    return this.context;
  }
}

const pixel = (canvas: FakeCanvas, x: number, y: number) => {
  if (canvas.image === null) throw new Error("面图没有写入像素");
  const i = (y * canvas.width + x) * 4;
  return [...canvas.image.data.slice(i, i + 4)];
};

function makeSkin(overrides: Partial<LoadedSkin> = {}): LoadedSkin {
  return { bitmap: { width: 64, height: 64 } as ImageBitmap, format: "modern", hat: true, model: "wide", ...overrides };
}

beforeEach(() => {
  vi.stubGlobal("OffscreenCanvas", FakeCanvas);
  vi.stubGlobal("ImageData", FakeImageData);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("paintSkinFigure", () => {
  it("按 figureQuads 的顺序每个面画一次，每次都是整张面图", () => {
    const target = new FakeCanvas(120, 216);
    const skin = makeSkin();
    paintSkinFigure(target.context as unknown as OffscreenCanvasRenderingContext2D, skin, REST_POSE, 6);
    const quads = figureQuads("modern", "wide", true, REST_POSE);
    expect(target.draws).toHaveLength(quads.length);
    target.draws.forEach((draw, i) => {
      const { w, h } = quads[i].uv;
      expect(draw.source.width).toBe(w);
      expect(draw.source.height).toBe(h);
      // 源矩形是整张图：Chromium 不把采样夹在源矩形内，只有整图作源时出界才不会读到别的面
      expect(draw.args.slice(0, 4)).toEqual([0, 0, w, h]);
    });
  });

  it("面图是从皮肤上切下来的那一块，亮度只乘 RGB，透明度不变", () => {
    const target = new FakeCanvas(120, 216);
    const skin = makeSkin();
    paintSkinFigure(target.context as unknown as OffscreenCanvasRenderingContext2D, skin, REST_POSE, 6);
    const quads = figureQuads("modern", "wide", true, REST_POSE);
    const index = quads.findIndex((q) => q.part === "body" && q.layer === "outer" && q.face === "front");
    const quad = quads[index];
    expect(quad.uv).toEqual({ x: 20, y: 36, w: 8, h: 12 });
    expect(quad.shade).toBeLessThan(1);
    const tile = target.draws[index].source;
    const expected = (x: number, y: number) => [Math.round(x * quad.shade), Math.round(y * quad.shade), 0, 200];
    expect(pixel(tile, 0, 0)).toEqual(expected(20, 36));
    expect(pixel(tile, 7, 0)).toEqual(expected(27, 36));
    expect(pixel(tile, 0, 11)).toEqual(expected(20, 47));
    expect(pixel(tile, 7, 11)).toEqual(expected(27, 47));
  });

  it("矩阵按 unit 放大，目标矩形向四周多画 0.75 设备像素，画完复位变换", () => {
    const target = new FakeCanvas(150, 270);
    const unit = 7.5;
    paintSkinFigure(target.context as unknown as OffscreenCanvasRenderingContext2D, makeSkin(), REST_POSE, unit);
    const quads = figureQuads("modern", "wide", true, REST_POSE);
    target.draws.forEach((draw, i) => {
      const [a, b, c, d, e, f] = quads[i].matrix;
      expect(draw.transform).toEqual([a * unit, b * unit, c * unit, d * unit, e * unit, f * unit]);
      const [, , , , dx, dy, dw, dh] = draw.args;
      const { w, h } = quads[i].uv;
      expect(-dx * Math.hypot(a, b) * unit).toBeCloseTo(0.75, 10);
      expect(-dy * Math.hypot(c, d) * unit).toBeCloseTo(0.75, 10);
      expect(dw).toBeCloseTo(w - 2 * dx, 10);
      expect(dh).toBeCloseTo(h - 2 * dy, 10);
    });
    expect(target.transform).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it("同一张皮肤转回同一亮度时复用面图，也只读一次像素", () => {
    const target = new FakeCanvas(120, 216);
    const read = vi.spyOn(FakeCanvas.prototype, "getContext");
    const skin = makeSkin();
    const ctx = target.context as unknown as OffscreenCanvasRenderingContext2D;
    paintSkinFigure(ctx, skin, REST_POSE, 6);
    const first = target.draws.map((d) => d.source);
    const contexts = read.mock.calls.length;
    paintSkinFigure(ctx, skin, REST_POSE, 6);
    expect(target.draws.slice(first.length).map((d) => d.source)).toEqual(first);
    expect(read.mock.calls.length).toBe(contexts);
    read.mockRestore();
  });
});

describe("默认姿态的缓存", () => {
  it("同一张皮肤多处出现只画一次", () => {
    const skin = makeSkin();
    expect(skinFigureCanvas(skin, 6, 1)).toBe(skinFigureCanvas(skin, 6, 1));
  });

  it("外框大小的画布，按 scale × dpr 放大", () => {
    const canvas = skinFigureCanvas(makeSkin(), 5, 1.5) as unknown as FakeCanvas;
    expect([canvas.width, canvas.height]).toEqual([FIGURE_FRAME.width * 5 * 1.5, FIGURE_FRAME.height * 5 * 1.5]);
    expect(canvas.context.imageSmoothingEnabled).toBe(false);
  });

  it("缓存键区分格式、体型、hat、scale、dpr", () => {
    const bitmap = { width: 64, height: 64 } as ImageBitmap;
    const base = makeSkin({ bitmap });
    const seen = new Set([
      skinFigureCanvas(base, 6, 1),
      skinFigureCanvas({ ...base, format: "legacy" }, 6, 1),
      skinFigureCanvas({ ...base, model: "slim" }, 6, 1),
      skinFigureCanvas({ ...base, hat: false }, 6, 1),
      skinFigureCanvas(base, 5, 1),
      skinFigureCanvas(base, 6, 2),
    ]);
    expect(seen.size).toBe(6);
  });

  it("hat 不同的两次画出来的面数不同：帽子真的少画了", () => {
    const bitmap = { width: 64, height: 64 } as ImageBitmap;
    const withHat = skinFigureCanvas(makeSkin({ bitmap }), 6, 1) as unknown as FakeCanvas;
    const noHat = skinFigureCanvas(makeSkin({ bitmap, hat: false }), 6, 1) as unknown as FakeCanvas;
    expect(withHat.draws.length - noHat.draws.length).toBe(6);
  });
});

describe("剪影", () => {
  it("2D 的 16 × 32 放在外框中央的布局方框上，底边是脚底基线", () => {
    const canvas = silhouetteFigureCanvas(123, "wide", 5, 1) as unknown as FakeCanvas;
    expect([canvas.width, canvas.height]).toEqual([100, 180]);
    expect(canvas.draws).toHaveLength(1);
    expect(canvas.draws[0].args).toEqual([0, 0, 16, 32, 10, 10, 80, 160]);
  });
});
