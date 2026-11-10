import { describe, expect, it } from "vitest";
import { springs } from "../../lib/motion";
import { branchSway } from "./Toolbar";

describe("branchSway", () => {
  it("上浮与落回都走 settle，与卡片悬停同一条弹簧", () => {
    const { rest, hover } = branchSway(1) as Record<"rest" | "hover", { transition: unknown }>;
    expect(rest.transition).toBe(springs.settle);
    expect(hover.transition).toBe(springs.settle);
  });

  // 缩放比、上浮的设备像素：2 × dpr 四舍五入
  it.each([
    [1, 2],
    [1.25, 3],
    [1.5, 3],
    [1.75, 4],
    [2, 4],
    [2.5, 5],
    [3, 6],
  ])("缩放比 %d：悬停上浮整 %d 个设备像素，静止时归零", (dpr, device) => {
    const { rest, hover } = branchSway(dpr) as Record<"rest" | "hover", { y: number }>;
    expect(rest.y).toBe(0);
    expect(hover.y * dpr).toBeCloseTo(-device, 9);
    expect(Math.abs(hover.y + 2)).toBeLessThanOrEqual(0.5 / dpr + 1e-9);
  });
});
