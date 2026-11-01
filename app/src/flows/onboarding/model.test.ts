import { describe, expect, it } from "vitest";
import {
  advance,
  back,
  backToStart,
  canJumpTo,
  canSkip,
  canStartNow,
  dirProblem,
  extraCandidates,
  INITIAL_WIZARD,
  jumpTo,
  pickedExtras,
  stepStatus,
} from "./model";

describe("向导步骤推进", () => {
  it("第一步不能跳过，第二、三步有「直接开始」", () => {
    expect([0, 1, 2, 3].map(canSkip)).toEqual([false, true, true, true]);
    expect([0, 1, 2, 3].map(canStartNow)).toEqual([false, true, true, false]);
    expect(() => advance(INITIAL_WIZARD, "skip")).toThrow("第一步不能跳过");
  });

  it("下一步与跳过分别记作完成与已跳过；后来用下一步离开时不再算跳过", () => {
    const s1 = advance(INITIAL_WIZARD, "next");
    const s2 = advance(s1, "skip");
    expect([0, 1, 2, 3].map((i) => stepStatus(s2, i))).toEqual(["done", "skipped", "current", "future"]);
    const again = advance(jumpTo(s2, 1), "next");
    expect(stepStatus(again, 1)).toBe("done");
    expect(again.index).toBe(2);
  });

  it("只能点回到过的步，后退与点回方向为 -1", () => {
    const s = advance(advance(INITIAL_WIZARD, "next"), "next");
    expect([0, 1, 2, 3].map((i) => canJumpTo(s, i))).toEqual([true, true, false, false]);
    const jumped = jumpTo(s, 0);
    expect([jumped.index, jumped.direction, jumped.reached]).toEqual([0, -1, 2]);
    expect(canJumpTo(jumped, 2)).toBe(true);
    expect(jumpTo(jumped, 2).direction).toBe(1);
    expect(() => jumpTo(s, 3)).toThrow();
    expect(back(s)).toMatchObject({ index: 1, direction: -1 });
    expect(() => back(INITIAL_WIZARD)).toThrow("第一步没有上一步");
  });

  it("最后一步不前进；收尾失败时回到第一步", () => {
    const last = advance(advance(advance(INITIAL_WIZARD, "next"), "skip"), "skip");
    expect(last.index).toBe(3);
    expect(() => advance(last, "next")).toThrow("最后一步");
    expect(backToStart(last)).toMatchObject({ index: 0, direction: -1, reached: 3 });
  });
});

describe("第一步：游戏目录", () => {
  it("空白与「!」在本地拒绝", () => {
    expect(dirProblem("   ")).toBe("empty");
    expect(dirProblem("D:/Hi!/.minecraft")).toBe("bang");
    expect(dirProblem("D:/Games/.minecraft")).toBeNull();
  });

  it("与所选目录相同的探测结果不作为额外文件夹；默认全收，只去掉取消勾选的", () => {
    const found = [
      { name: "官方启动器", path: "C:\\Users\\me\\AppData\\Roaming\\.minecraft" },
      { name: "PCL2", path: "D:/Games/.minecraft" },
      { name: "HMCL", path: "E:/HMCL/.minecraft" },
    ];
    const candidates = extraCandidates(found, "d:\\games\\.minecraft\\");
    expect(candidates.map((c) => c.name)).toEqual(["官方启动器", "HMCL"]);
    expect(pickedExtras(candidates, new Set())).toEqual(candidates);
    expect(pickedExtras(candidates, new Set(["E:/HMCL/.minecraft"]))).toEqual([found[0]]);
  });
});
