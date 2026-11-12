import { describe, expect, it } from "vitest";
import { RUNTIME_SKELETON_DEFAULT, RUNTIME_SKELETON_MAX, runtimeSkeletonTiles } from "./java-model";

describe("运行时列表骨架的块数", () => {
  it("本次会话还没扫过：按常见的 2 个画", () => {
    expect(runtimeSkeletonTiles(null)).toBe(2);
    expect(RUNTIME_SKELETON_DEFAULT).toBe(2);
  });

  it("扫过：上次扫到几个画几个，没扫到时只剩「自动选择」", () => {
    expect(runtimeSkeletonTiles(0)).toBe(0);
    expect(runtimeSkeletonTiles(1)).toBe(1);
    expect(runtimeSkeletonTiles(5)).toBe(5);
  });

  it("多于骨架列表的上限时只画到上限，再多的位置留空", () => {
    expect(RUNTIME_SKELETON_MAX).toBe(6);
    expect(runtimeSkeletonTiles(6)).toBe(6);
    expect(runtimeSkeletonTiles(7)).toBe(6);
    expect(runtimeSkeletonTiles(40)).toBe(6);
  });

  it("个数不是非负整数时报错，不悄悄画成别的", () => {
    expect(() => runtimeSkeletonTiles(-1)).toThrow("运行时个数必须是非负整数，收到 -1");
    expect(() => runtimeSkeletonTiles(2.5)).toThrow("运行时个数必须是非负整数，收到 2.5");
  });
});
