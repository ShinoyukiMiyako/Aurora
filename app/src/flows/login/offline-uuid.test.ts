import { describe, expect, it } from "vitest";
import { hyphenateUuid, md5, offlineUuid } from "./offline-uuid";

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const md5Hex = (text: string) => hex(md5(new TextEncoder().encode(text)));

describe("MD5", () => {
  it("RFC 1321 附录的测试向量：空串、单块、跨块", () => {
    expect(md5Hex("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5Hex("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(md5Hex("message digest")).toBe("f96b697d7cb7938d525a2f31aaf161d0");
    expect(md5Hex("12345678901234567890123456789012345678901234567890123456789012345678901234567890")).toBe("57edf4a22be3c955ac49da2e2107b67a");
  });

  it("恰好 55、56 字节是补位的边界：长度字段落在同一块或下一块", () => {
    expect(md5Hex("a".repeat(55))).toBe("ef1772b6dff9a122358552954ad0df65");
    expect(md5Hex("a".repeat(56))).toBe("3b0c8ac703f828b04c6c197006d17218");
  });
});

describe("离线 UUID", () => {
  it("与游戏和后端同一算法（版本 3、变体位）", () => {
    expect(offlineUuid("Steve")).toBe("5627dd98e6be3c21b8a8e92344183641");
    expect(offlineUuid("Notch")).toBe("b50ad385829d3141a2167e7d7539ba7f");
    expect(offlineUuid("jeb_")).toBe("a762f5604fce3236812ab80efff0b62b");
    expect(offlineUuid("Dev")).toBe("380df991f603344ca090369bad2a924a");
  });

  it("按 UTF-8 字节计算，大小写不同就是不同的人", () => {
    expect(offlineUuid("樱花")).toBe("3dc60c16fbf53c2ca2a58d0151156d78");
    expect(offlineUuid("steve")).not.toBe(offlineUuid("Steve"));
  });

  it("展示写法为 8-4-4-4-12；不是 32 位十六进制时抛错", () => {
    expect(hyphenateUuid("5627dd98e6be3c21b8a8e92344183641")).toBe("5627dd98-e6be-3c21-b8a8-e92344183641");
    expect(() => hyphenateUuid("5627dd98-e6be")).toThrow("不是 32 位十六进制");
  });
});
