// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { Rgb } from "../../mc/whitelist";
import { render, stubMatchMedia, type Rendered } from "../../test/dom";
import { stubCanvas, type CanvasStub } from "../illustrations/test-canvas";
import { TextureTile, tileFace, tileTexelDevicePx } from "./TextureTile";

let view: Rendered | undefined;
let canvas: CanvasStub;
let warn: MockInstance<typeof console.warn>;
/** 离屏画布 getImageData 读出的像素（前两个像素有值，其余为 0）。 */
const SIDE = new Uint8ClampedArray(16 * 16 * 4);
SIDE.set([200, 100, 50, 255, 255, 255, 255, 128]);
/** 写进离屏画布的像素：一格材质最终的样子。 */
let written: Uint8ClampedArray[];

beforeEach(() => {
  stubMatchMedia(false);
  canvas = stubCanvas();
  written = [];
  // 替身的离屏画布读出全 0：换成读出 SIDE、记下写入的像素，才看得出染色乘没乘
  const Base = globalThis.OffscreenCanvas as unknown as new (width: number, height: number) => { getContext(): Record<string, unknown> };
  class PixelCanvas extends Base {
    getContext() {
      const ctx = super.getContext();
      ctx.getImageData = (_x: number, _y: number, w: number, h: number) => {
        const image = new ImageData(w, h);
        image.data.set(SIDE);
        return image;
      };
      ctx.putImageData = (image: ImageData) => void written.push(new Uint8ClampedArray(image.data));
      return ctx;
    }
  }
  vi.stubGlobal("OffscreenCanvas", PixelCanvas);
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.unstubAllGlobals();
});

function side(height = 16): ImageBitmap {
  return { width: 16, height } as ImageBitmap;
}

const head = (pixels: Uint8ClampedArray | undefined) => (pixels === undefined ? [] : [...pixels.slice(0, 8)]);

describe("tileFace", () => {
  it("侧面染色先乘进像素：rgb × tint / 255，alpha 不变", () => {
    const tint: Rgb = [72, 181, 24];
    expect(tileFace({ key: "block|1.21.1|oak_leaves", side: side(), sideTint: tint })).not.toBeNull();
    expect(head(written.at(-1))).toEqual([56, 71, 5, 255, 72, 181, 24, 128]);
  });

  it("不染色的侧面原样平铺", () => {
    expect(tileFace({ key: "block|1.21.1|blue_ice", side: side(), sideTint: null })).not.toBeNull();
    expect(head(written.at(-1))).toEqual([200, 100, 50, 255, 255, 255, 255, 128]);
  });

  it("同一来源键只读一次像素；动画材质只取首帧 16 × 16", () => {
    const bitmap = side(48);
    const first = tileFace({ key: "block|1.21.1|prismarine", side: bitmap, sideTint: null });
    const again = tileFace({ key: "block|1.21.1|prismarine", side: bitmap, sideTint: null });
    expect(again).toBe(first);
    expect(canvas.sourceRects(bitmap)).toEqual(["0,0,16,16"]);
  });

  it("侧面不是宽 16 的方块材质：null，同一来源只警告一次", () => {
    const bitmap = { width: 32, height: 32 } as ImageBitmap;
    expect(tileFace({ key: "image|http://petalfall-tex.localhost/cover/big", side: bitmap, sideTint: null })).toBeNull();
    expect(tileFace({ key: "image|http://petalfall-tex.localhost/cover/big", side: bitmap, sideTint: null })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("32x32");
    expect(canvas.sourceRects(bitmap)).toEqual([]);
  });
});

describe("tileTexelDevicePx", () => {
  it("8 css px × dpr 取整到整数设备像素，最少 1", () => {
    expect([1, 1.1, 1.25, 1.5, 1.75, 2, 0.05].map(tileTexelDevicePx)).toEqual([8, 9, 10, 12, 14, 16, 1]);
  });
});

describe("TextureTile", () => {
  it("按 dpr 铺满画布：每格 16 × 取整后的像素，最近邻，CSS 尺寸写在画布上", () => {
    vi.stubGlobal("devicePixelRatio", 1.5);
    const face = { width: 16, height: 16 } as ImageBitmap;
    view = render(<TextureTile face={face} width={250} height={100} />);
    const el = view.container.querySelector("canvas") as HTMLCanvasElement;
    expect([el.style.width, el.style.height, el.width, el.height]).toEqual(["250px", "100px", 375, 150]);
    expect(el.getContext("2d")?.imageSmoothingEnabled).toBe(false);
    // 1.5 倍屏一格 16 × 12 = 192 设备像素：375 宽铺两列，150 高一行
    expect(canvas.draws.filter((d) => d.source === face).map((d) => d.args.join(","))).toEqual(["0,0,16,16,0,0,192,192", "0,0,16,16,192,0,192,192"]);
    expect(el.getAttribute("aria-hidden")).toBe("true");
  });
});
