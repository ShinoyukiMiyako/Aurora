import { describe, expect, it } from "vitest";
import { dirName, hasBang, normalizePath, samePath } from "./paths";

describe("路径比较", () => {
  it("统一分隔符与末尾斜杠，Windows 盘符路径不分大小写，其余区分", () => {
    expect(normalizePath("D:\\Games\\.minecraft\\")).toBe("d:/games/.minecraft");
    expect(normalizePath("  D:/Games/  ")).toBe("d:/games");
    expect(samePath("D:\\Games\\.minecraft", "d:/games/.minecraft/")).toBe(true);
    expect(samePath("/a/b/", "/a/b")).toBe(true);
    expect(samePath("/home/a/.minecraft", "/home/A/.minecraft")).toBe(false);
    expect(samePath("D:/a", "D:/a/b")).toBe(false);
  });
});

describe("游戏目录路径", () => {
  it("「!」会被拒绝", () => {
    expect(hasBang("D:/Games/Hi!/.minecraft")).toBe(true);
    expect(hasBang("D:/Games/.minecraft")).toBe(false);
  });

  it("显示名取最后一段，.minecraft 取上一级；空路径抛错", () => {
    expect(dirName("D:\\Games\\PCL\\.minecraft\\")).toBe("PCL");
    expect(dirName("D:\\Games\\Modded")).toBe("Modded");
    expect(dirName("E:/.minecraft")).toBe("E:");
    expect(dirName("E:/")).toBe("E:");
    expect(() => dirName("  ")).toThrow("没有可显示的名称");
  });
});
