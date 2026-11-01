import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha1Hex } from "./sha1";

const reference = (text: string) => createHash("sha1").update(text, "utf8").digest("hex");

describe("sha1Hex", () => {
  it("FIPS 180 标准向量", () => {
    expect(sha1Hex("")).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
    expect(sha1Hex("abc")).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
    expect(sha1Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe("84983e441c3bd26ebaae4aa1f95129e5e54670f1");
  });

  it("按 UTF-8 字节计算（中文与路径字符）", () => {
    expect(sha1Hex("樱花林")).toBe(reference("樱花林"));
    expect(sha1Hex("https://cdn.modrinth.com/data/P7dR8mSH/icon.png")).toBe(reference("https://cdn.modrinth.com/data/P7dR8mSH/icon.png"));
  });

  it("填充边界：55、56、63、64、65 字节与多块消息", () => {
    for (const length of [55, 56, 63, 64, 65, 119, 120, 1000]) {
      const text = "x".repeat(length);
      expect(sha1Hex(text)).toBe(reference(text));
    }
  });

  it("随机字符串与 Node 实现一致", () => {
    for (let i = 0; i < 50; i++) {
      const length = Math.floor(Math.random() * 300);
      const text = Array.from({ length }, () => String.fromCodePoint(32 + Math.floor(Math.random() * 20000))).join("");
      expect(sha1Hex(text)).toBe(reference(text));
    }
  });
});
