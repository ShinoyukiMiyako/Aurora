import { describe, expect, it } from "vitest";
import { normalizePath, samePath } from "./paths";

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
