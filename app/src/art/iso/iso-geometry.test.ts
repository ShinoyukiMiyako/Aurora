import { describe, expect, it } from "vitest";
import { applyMatrix, blueprintPath, faceCorners, faceMatrices, ISO_S, ISO_WIDTHS, isoLayout, type Matrix } from "./geometry";

const EPS = 0.001;

function bounds(matrices: Readonly<Record<string, Matrix>>, n: number) {
  const points = Object.values(matrices).flatMap((m) => faceCorners(m, n));
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

describe("等距投影", () => {
  it("√1.5 的数值", () => {
    expect(ISO_S).toBeCloseTo(1.224744871, 9);
  });

  it("外接 48 px 宽时（k = 1.5）：左右两面的竖向系数为 √1.5·k，顶面为 k/2", () => {
    const k = 48 / 32;
    const m = faceMatrices(16, k);
    expect(Math.abs(m.left[3] - ISO_S * k)).toBeLessThan(EPS);
    expect(Math.abs(m.right[3] - ISO_S * k)).toBeLessThan(EPS);
    expect(Math.abs(m.top[3] - k / 2)).toBeLessThan(EPS);
    // 横向系数不受影响：左面 a = k、b = k/2，右面 a = k、b = -k/2
    expect([m.left[0], m.left[1], m.right[0], m.right[1]]).toEqual([k, k / 2, k, -k / 2]);
  });

  it("外接框宽 48、高宽比 (1 + √1.5) / 2", () => {
    const k = 48 / 32;
    const box = bounds(faceMatrices(16, k), 16);
    expect(box.minX).toBeCloseTo(0, 9);
    expect(box.minY).toBeCloseTo(0, 9);
    expect(box.maxX - box.minX).toBeCloseTo(48, 9);
    expect(Math.abs((box.maxY - box.minY) / (box.maxX - box.minX) - (1 + ISO_S) / 2)).toBeLessThan(EPS);
  });

  it("顶面菱形宽高比 2:1；竖棱长 / 顶面菱形高 = √1.5", () => {
    for (const [n, k] of [
      [16, 1],
      [16, 4],
      [10, 1],
    ] as const) {
      const m = faceMatrices(n, k);
      const top = faceCorners(m.top, n);
      const topW = Math.max(...top.map((p) => p[0])) - Math.min(...top.map((p) => p[0]));
      const topH = Math.max(...top.map((p) => p[1])) - Math.min(...top.map((p) => p[1]));
      expect(topW / topH).toBeCloseTo(2, 9);
      // 左面右缘（u = n）就是中竖棱
      const [x0, y0] = applyMatrix(m.left, n, 0);
      const [x1, y1] = applyMatrix(m.left, n, n);
      expect(Math.hypot(x1 - x0, y1 - y0) / topH).toBeCloseTo(ISO_S, 9);
    }
  });

  it("三个面在共享棱上严丝合缝：左面右缘 = 右面左缘，顶面两条下棱 = 两侧面上缘", () => {
    const n = 16;
    const m = faceMatrices(n, 2);
    for (const v of [0, 5, 16]) expect(applyMatrix(m.left, n, v)).toEqual(applyMatrix(m.right, 0, v));
    for (const u of [0, 7, 16]) {
      expect(applyMatrix(m.top, u, n)).toEqual(applyMatrix(m.left, u, 0));
      const [x, y] = applyMatrix(m.top, n, n - u);
      const [rx, ry] = applyMatrix(m.right, u, 0);
      expect(x).toBeCloseTo(rx, 9);
      expect(y).toBeCloseTo(ry, 9);
    }
  });

  it("侧面材质 v = 0 一边在上：草边朝上", () => {
    const m = faceMatrices(16, 1);
    expect(applyMatrix(m.left, 8, 0)[1]).toBeLessThan(applyMatrix(m.left, 8, 16)[1]);
    expect(applyMatrix(m.right, 8, 0)[1]).toBeLessThan(applyMatrix(m.right, 8, 16)[1]);
  });
});

describe("isoLayout", () => {
  it("整数倍档：每材质像素 W/32 CSS px，高度 35.6 / 71.2 / 106.8 / 142.4，画布取整", () => {
    const expected = { 32: [35.6, 36], 64: [71.2, 72], 96: [106.8, 107], 128: [142.4, 143] } as const;
    for (const [w, [h, canvas]] of Object.entries(expected)) {
      const layout = isoLayout(Number(w));
      expect(layout.n).toBe(16);
      expect(layout.k).toBe(Number(w) / 32);
      expect(layout.height).toBeCloseTo(h, 1);
      expect(layout.canvasHeight).toBe(canvas);
    }
  });

  it("小尺寸档：每面 W/2 像素、每像素 1 CSS px，高度 W/2 × (1 + √1.5)", () => {
    for (const w of [12, 20, 28, 30]) {
      const layout = isoLayout(w);
      expect(layout.n).toBe(w / 2);
      expect(layout.k).toBe(1);
      expect(layout.height).toBeCloseTo((w / 2) * (1 + ISO_S), 9);
    }
    expect(isoLayout(20).canvasHeight).toBe(23);
    expect(isoLayout(28).canvasHeight).toBe(32);
  });

  it.each([0, 10, 11, 13, 31, 40, 48, 80, 160, -32, 32.5])("宽度 %d 不允许", (w) => {
    expect(() => isoLayout(w)).toThrow("不允许");
  });

  it("允许的宽度恰为 12-30 的偶数与 32 / 64 / 96 / 128", () => {
    expect([...ISO_WIDTHS]).toEqual([12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 64, 96, 128]);
  });
});

describe("蓝图", () => {
  it("W = 32 时顶点为 (16,0) (32,8) (32,8+16√1.5) (16,16+16√1.5) (0,8+16√1.5) (0,8)，内棱从 (16,16) 出发", () => {
    // 16√1.5 = 19.5959…，路径坐标保留两位小数
    expect(blueprintPath(32)).toBe("M16 0L32 8L32 27.6L16 35.6L0 27.6L0 8ZM16 16L0 8M16 16L32 8M16 16L16 35.6");
  });

  it("W = 28 的蓝图外框与方块外接框一致（宽 28、高 14(1 + √1.5)）", () => {
    const numbers = blueprintPath(28)
      .match(/-?\d+(\.\d+)?/g)
      ?.map(Number);
    if (!numbers) throw new Error("蓝图路径没有坐标");
    const xs = numbers.filter((_, i) => i % 2 === 0);
    const ys = numbers.filter((_, i) => i % 2 === 1);
    expect(Math.max(...xs)).toBe(28);
    expect(Math.max(...ys)).toBeCloseTo(isoLayout(28).height, 1);
  });
});
