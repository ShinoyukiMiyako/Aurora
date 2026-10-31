import { describe, expect, it } from "vitest";
import { droppedFile } from "./ImportModpackDialog";

describe("droppedFile", () => {
  it("一次拖进几个文件时读第一个整合包，扩展名不分大小写", () => {
    expect(droppedFile(["D:\\a.png", "D:\\b.ZIP", "D:\\c.mrpack"])).toBe("D:\\b.ZIP");
    expect(droppedFile(["D:\\packs\\c.mrpack"])).toBe("D:\\packs\\c.mrpack");
  });

  it("一个整合包都没有时读第一个，交给后端说明只认哪两种；名字里带 .zip 但扩展名不是的不算整合包", () => {
    expect(droppedFile(["D:\\a.png", "D:\\b.jar"])).toBe("D:\\a.png");
    expect(droppedFile(["D:\\x.zip.txt", "D:\\y.mrpack"])).toBe("D:\\y.mrpack");
  });

  it("拖进来的不是文件（没有路径）时什么都不读", () => {
    expect(droppedFile([])).toBeNull();
  });
});
