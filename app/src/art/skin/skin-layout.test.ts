import { describe, expect, it } from "vitest";
import { AVATAR_SPECS, FACE_RECT, figureLayers, HAT_RECT, skinFormat, type AvatarSize } from "./layout";

describe("皮肤格式", () => {
  it("只接受 64 × 64 与 64 × 32", () => {
    expect(skinFormat(64, 64)).toBe("modern");
    expect(skinFormat(64, 32)).toBe("legacy");
    expect(skinFormat(128, 128)).toBeNull();
    expect(skinFormat(64, 48)).toBeNull();
    expect(skinFormat(32, 32)).toBeNull();
  });
});

describe("头像", () => {
  it("脸部是 8 的整数倍、四周留 4 px，圆角按 round(边长 × 0.3)", () => {
    for (const [size, spec] of Object.entries(AVATAR_SPECS)) {
      const edge = Number(size) as AvatarSize;
      expect(spec.face % 8).toBe(0);
      expect(edge - spec.face).toBe(8);
      expect(spec.radius).toBe(Math.round(edge * 0.3));
    }
    expect(FACE_RECT).toEqual({ x: 8, y: 8, w: 8, h: 8 });
    expect(HAT_RECT).toEqual({ x: 40, y: 8, w: 8, h: 8 });
  });
});

describe("立绘部件", () => {
  const key = (l: { sx: number; sy: number; w: number; h: number; dx: number; dy: number; mirror: boolean }) =>
    `${l.sx},${l.sy} ${l.w}x${l.h} -> ${l.dx},${l.dy}${l.mirror ? " 镜像" : ""}`;

  it("新格式宽体型：六个部件内外两层，内层先画", () => {
    expect(figureLayers("wide", "modern").map(key)).toEqual([
      "8,8 8x8 -> 4,0",
      "20,20 8x12 -> 4,8",
      "44,20 4x12 -> 0,8",
      "36,52 4x12 -> 12,8",
      "4,20 4x12 -> 4,20",
      "20,52 4x12 -> 8,20",
      "40,8 8x8 -> 4,0",
      "20,36 8x12 -> 4,8",
      "44,36 4x12 -> 0,8",
      "52,52 4x12 -> 12,8",
      "4,36 4x12 -> 4,20",
      "4,52 4x12 -> 8,20",
    ]);
  });

  it("细体型手臂宽 3，右臂（画面左）从 x = 1 开始", () => {
    const arms = figureLayers("slim", "modern").filter((l) => l.h === 12 && (l.dx === 1 || l.dx === 12) && l.dy === 8);
    expect(arms.map(key)).toEqual(["44,20 3x12 -> 1,8", "36,52 3x12 -> 12,8", "44,36 3x12 -> 1,8", "52,52 3x12 -> 12,8"]);
  });

  it("旧格式：左臂、左腿取右侧镜像，外层只有帽子，取片都不越出 64 × 32", () => {
    const layers = figureLayers("wide", "legacy");
    expect(layers.map(key)).toEqual([
      "8,8 8x8 -> 4,0",
      "20,20 8x12 -> 4,8",
      "44,20 4x12 -> 0,8",
      "44,20 4x12 -> 12,8 镜像",
      "4,20 4x12 -> 4,20",
      "4,20 4x12 -> 8,20 镜像",
      "40,8 8x8 -> 4,0",
    ]);
    for (const l of layers) expect(l.sy + l.h).toBeLessThanOrEqual(32);
  });

  it("所有部件落在 16 × 32 的立绘框内", () => {
    for (const model of ["wide", "slim"] as const) {
      for (const l of figureLayers(model, "modern")) {
        expect(l.dx).toBeGreaterThanOrEqual(0);
        expect(l.dx + l.w).toBeLessThanOrEqual(16);
        expect(l.dy + l.h).toBeLessThanOrEqual(32);
      }
    }
  });
});
