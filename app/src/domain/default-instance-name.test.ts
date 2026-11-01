import { describe, expect, it } from "vitest";
import { checkInstanceName, ILLEGAL_NAME_CHARS, INSTANCE_NAME_MAX_UNITS } from "../ipc/instances";
import { defaultInstanceName } from "./rules";

const FALLBACK = "整合包";
const name = (raw: string, existing: readonly string[] = []) => defaultInstanceName(raw, existing, FALLBACK);

describe("外来名称整理成默认实例名", () => {
  it("合法的名字原样用", () => {
    expect(name("All the Mods 9")).toBe("All the Mods 9");
    expect(name("樱花　生存")).toBe("樱花　生存");
  });

  it("Windows 不允许的字符换成空格，连续空格并成一个", () => {
    expect(name("Create: Above and Beyond")).toBe("Create Above and Beyond");
    expect(name('A\\B/C:D*E?F"G<H>I|J')).toBe("A B C D E F G H I J");
    expect(name("Pack?")).toBe("Pack");
    expect(name("A\tB\nC\u0000D")).toBe("A B C D");
  });

  it("去掉开头的点与空白、结尾的点与空白", () => {
    expect(name("...Hidden Pack")).toBe("Hidden Pack");
    expect(name("  Pack. . .")).toBe("Pack");
    expect(name("Pack 1.0.")).toBe("Pack 1.0");
  });

  it("整理完什么都不剩时用后备名，后备名同样按重名追加序号", () => {
    expect(name("???")).toBe("整合包");
    expect(name(" . ")).toBe("整合包");
    expect(name("", ["整合包"])).toBe("整合包 2");
  });

  it("按 UTF-16 码元截到上限：32 个刚好不截，33 个截掉一个，截在空格上时把空格也去掉", () => {
    const exact = "a".repeat(INSTANCE_NAME_MAX_UNITS);
    expect(name(exact)).toBe(exact);
    expect(name(`${exact}b`)).toBe(exact);
    expect(name(`${"a".repeat(31)} b`)).toBe("a".repeat(31));
  });

  it("截断不切开代理对：放不下整个字就整个不要", () => {
    const astral = "\u{1D538}";
    expect(name(astral.repeat(17))).toBe(astral.repeat(16));
    expect(name(`a${astral.repeat(16)}`)).toBe(`a${astral.repeat(15)}`);
  });

  it("重名时追加序号，追加之后仍不超过上限：截短的是名字本身", () => {
    const long = "x".repeat(40);
    expect(name(long, ["x".repeat(32)])).toBe(`${"x".repeat(30)} 2`);
    const taken = ["x".repeat(32), ...Array.from({ length: 8 }, (_, i) => `${"x".repeat(30)} ${i + 2}`)];
    expect(name(long, taken)).toBe(`${"x".repeat(29)} 10`);
    expect(name(`${"y".repeat(29)}  .z`, ["Y".repeat(29) + " .z"])).toBe(`${"y".repeat(29)} 2`);
  });

  it("不分大小写比较重名，序号取最小可用的", () => {
    expect(name("ATM", ["atm", "ATM 2", "atm 4"])).toBe("ATM 3");
    expect(name("Create: Above and Beyond", ["create above and beyond"])).toBe("Create Above and Beyond 2");
  });

  it("Windows 保留的设备名：不带扩展名的追加序号，带扩展名的把点换成空格", () => {
    expect(name("CON")).toBe("CON 2");
    expect(name("nul", ["NUL 2"])).toBe("nul 3");
    expect(name("con.pack")).toBe("con pack");
    expect(name("COM1 .x")).toBe("COM1 x");
  });

  it("后备名本身整理完也是空的说明调用方传错了，直接报错", () => {
    expect(() => defaultInstanceName("???", [], "...")).toThrow("后备名");
  });

  it("随机名称与随机占用：结果总是合法、不超长、不与现有实例重名", () => {
    let seed = 20261031;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pieces = [...ILLEGAL_NAME_CHARS, ".", " ", "\t", "a", "Z", "樱", "\u{20BB7}", "\u{3000}", "CON", "lpt9", "-", "1"];
    const pick = () => pieces[Math.floor(rand() * pieces.length)];
    for (let round = 0; round < 300; round++) {
      const raw = Array.from({ length: Math.floor(rand() * 45) }, pick).join("");
      const first = name(raw);
      const existing = Array.from({ length: Math.floor(rand() * 4) }, (_, i) => (i === 0 ? first : `${first.slice(0, 28)} ${i + 1}`).toUpperCase());
      const result = name(raw, existing);
      expect(checkInstanceName(result, existing), `「${raw}」-> 「${result}」`).toBeNull();
      expect(result.length).toBeLessThanOrEqual(INSTANCE_NAME_MAX_UNITS);
    }
  });
});
