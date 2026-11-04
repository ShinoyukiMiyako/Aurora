import { describe, expect, it } from "vitest";
import { AVATAR_SPECS, FACE_RECT, HAT_RECT, skinFormat, type AvatarSize } from "./layout";

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
