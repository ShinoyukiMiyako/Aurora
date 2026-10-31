import { describe, expect, it } from "vitest";
import { probeWindow, type ProbeProgress } from "./probes";

const of = (table: Record<string, ProbeProgress>) => (id: string) => (id in table ? table[id] : null);

describe("probeWindow", () => {
  it("没回报过的按顺序补到在读数达到上限；读完的不占名额、照旧挂着", () => {
    const ids = ["a", "b", "c", "d", "e"];
    expect(probeWindow(ids, of({}), 2)).toEqual(["a", "b"]);
    expect(probeWindow(ids, of({ a: "settled", b: "loading" }), 2)).toEqual(["a", "b", "c"]);
    expect(probeWindow(ids, of({ a: "settled", b: "settled", c: "settled", d: "settled", e: "settled" }), 2)).toEqual(ids);
  });

  it("失效后重取的探针拦不住，但占着名额：新的不再补上", () => {
    const ids = ["a", "b", "c"];
    expect(probeWindow(ids, of({ a: "loading", b: "loading" }), 2)).toEqual(["a", "b"]);
    expect(probeWindow(ids, of({ a: "loading", b: "loading", c: "loading" }), 2)).toEqual(ids);
  });

  it("上限为 1 时严格逐个；没有实例时什么都不挂", () => {
    expect(probeWindow(["a", "b"], of({}), 1)).toEqual(["a"]);
    expect(probeWindow(["a", "b"], of({ a: "settled" }), 1)).toEqual(["a", "b"]);
    expect(probeWindow([], of({}), 2)).toEqual([]);
  });
});
