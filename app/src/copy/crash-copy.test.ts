import { describe, expect, it } from "vitest";
import { memoryCapMb, memoryLowerTarget, memoryTarget, javaMajorFromClassVersion, isHeapReserveFailure } from "../domain/rules";
import { CRASH_CATEGORIES, CRASH_CATEGORY, CRASH_COPY, crashCategoryLabel, joinCrashLabels, SESSION_COPY } from "./flows";

describe("崩溃诊断文案", () => {
  it("八类诊断各有标签与标题", () => {
    expect(CRASH_CATEGORIES).toHaveLength(8);
    expect(CRASH_CATEGORIES.map((c) => crashCategoryLabel(c))).toEqual([
      "Java 版本不匹配",
      "内存不足",
      "缺少前置",
      "Mixin 注入失败",
      "重复的 Mod",
      "本地库缺失",
      "显卡驱动",
      "文件损坏",
    ]);
    expect(CRASH_CATEGORY.out_of_memory.title).toBe("游戏内存不够用了");
    expect(CRASH_CATEGORY.graphics_driver.title).toBe("显卡驱动或 OpenGL 不可用");
  });

  it("未知类别直接抛错，不回落成「未知原因」", () => {
    expect(() => crashCategoryLabel("cosmic_ray")).toThrow("未知的崩溃诊断类别：cosmic_ray");
    expect(() => CRASH_COPY.headline(["out_of_memory", "cosmic_ray"])).toThrow("未知的崩溃诊断类别：cosmic_ray");
  });

  it("解释缺少必要插值时抛错，给了就写进句子", () => {
    expect(() => CRASH_CATEGORY.out_of_memory.explain({ detail: null, currentJava: null, requiredJava: null, maxMemoryMb: null })).toThrow("需要 最大内存");
    expect(CRASH_CATEGORY.java_version_mismatch.explain({ detail: null, currentJava: 17, requiredJava: 21, maxMemoryMb: null })).toBe(
      "这次用的是 Java 17，日志里有内容需要 Java 21。",
    );
  });

  it("标签拼接：一类、两类、三类、四类以上", () => {
    expect(joinCrashLabels(["内存不足"])).toBe("内存不足");
    expect(joinCrashLabels(["内存不足", "缺少前置"])).toBe("内存不足与缺少前置");
    expect(joinCrashLabels(["A", "B", "C"])).toBe("A、B 与 C");
    expect(joinCrashLabels(["A", "B", "C", "D"])).toBe("A、B 等 4 类问题");
    expect(() => joinCrashLabels([])).toThrow("类别列表为空");
  });

  it("头条与会话副行", () => {
    expect(CRASH_COPY.headline([])).toBe("没有匹配到已知原因");
    expect(CRASH_COPY.headline(["out_of_memory"])).toBe("找到 1 条线索，日志指向内存不足");
    expect(SESSION_COPY.crashClue(crashCategoryLabel("java_version_mismatch"))).toBe("日志指向 Java 版本不匹配");
  });
});

describe("一键尝试：内存目标", () => {
  it("当前 4096、本机 16384：加 2 GB 到 6144，上限 8192", () => {
    expect(memoryTarget(4096, 16384)).toEqual({ kind: "raise", targetMb: 6144, capMb: 8192 });
    expect(CRASH_COPY.raiseMemory(6144)).toBe("调到 6 GB");
  });

  it("当前 4096、本机 8192：上限就是 4096，不给调整按钮", () => {
    expect(memoryTarget(4096, 8192)).toEqual({ kind: "at_cap", capMb: 4096 });
  });

  it("目标被上限截住但仍高于当前值时照常给出", () => {
    expect(memoryTarget(7000, 16384)).toEqual({ kind: "raise", targetMb: 8192, capMb: 8192 });
    // 非整 GB 的当前值先加 2 GB 再向上取整
    expect(memoryTarget(3000, 32768)).toEqual({ kind: "raise", targetMb: 5120, capMb: 16384 });
  });

  it("上限取物理内存一半并向下取整到整 GB", () => {
    expect(memoryCapMb(16384)).toBe(8192);
    expect(memoryCapMb(15000)).toBe(7168);
    expect(memoryCapMb(1500)).toBe(0);
  });

  it("堆分配不到时往下调 2 GB，不低于 2 GB", () => {
    expect(memoryLowerTarget(6144)).toBe(4096);
    expect(memoryLowerTarget(3072)).toBe(2048);
    expect(isHeapReserveFailure("Error occurred during initialization of VM: Could not reserve enough space for object heap")).toBe(true);
    expect(isHeapReserveFailure("java.lang.OutOfMemoryError: Java heap space")).toBe(false);
  });

  it("class file version 推出 Java 主版本", () => {
    expect(javaMajorFromClassVersion("has been compiled by a more recent version (class file version 65.0)")).toBe(21);
    expect(javaMajorFromClassVersion("class file version 52")).toBe(8);
    expect(javaMajorFromClassVersion("no version here")).toBeNull();
    expect(javaMajorFromClassVersion(null)).toBeNull();
  });
});
