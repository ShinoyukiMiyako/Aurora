import { describe, expect, it } from "vitest";
import { SIDEBAR_PIN_LIMIT } from "../../domain/limits";
import { MODPACK_COPY } from "./copy";
import { packFactLines, type PackFacts } from "./PackForm";

const base: PackFacts = { mcVersion: "1.21.1", loader: "fabric", modCount: 214, downloadBytes: 3 * 1024 * 1024 };
const keys = (facts: PackFacts) => packFactLines(facts, false, 0).map((line) => line.key);

describe("packFactLines", () => {
  it("清单还在读：Mod 数与下载量各占一行骨架，读到后同一个 key 换成文字，内存与固定行的位置不变", () => {
    const pending = packFactLines({ ...base, modCount: null, downloadBytes: null, pending: true }, false, 0);
    expect(pending.map((line) => [line.key, line.text])).toEqual([
      ["mods", null],
      ["download", null],
      ["memory", "内存跟随全局设置"],
      ["pin", `装好后固定在侧栏（1/${SIDEBAR_PIN_LIMIT}）`],
    ]);
    const ready = packFactLines(base, false, 0);
    expect(ready.map((line) => line.key)).toEqual(pending.map((line) => line.key));
    expect(ready.slice(0, 2).map((line) => line.text)).toEqual(["214 个 Mod", MODPACK_COPY.download(3 * 1024 * 1024)]);
  });

  it("读完了读不出来的那一项不占行；额外行排在内存之前，key 带上自己的文字", () => {
    expect(keys({ ...base, modCount: null })).toEqual(["download", "memory", "pin"]);
    expect(keys({ ...base, downloadBytes: null, extra: [{ icon: "file", text: "12 个文件需要下载" }] })).toEqual(["mods", "extra:12 个文件需要下载", "memory", "pin"]);
  });

  it("内存按全局是否自动分配给说法；侧栏固定位满了换一句", () => {
    const auto = packFactLines(base, true, SIDEBAR_PIN_LIMIT);
    expect(auto.find((line) => line.key === "memory")?.text).toBe("内存跟随全局设置，会按大型整合包档位给足");
    expect(auto.find((line) => line.key === "pin")?.text).toBe(`侧栏固定位已满（${SIDEBAR_PIN_LIMIT}/${SIDEBAR_PIN_LIMIT}），这个实例不会自动固定`);
  });
});
