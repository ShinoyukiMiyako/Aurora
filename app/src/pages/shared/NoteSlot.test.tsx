// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, type Rendered } from "../../test/dom";
import { NoteSlot } from "./NoteSlot";

const A = "存档、配置与资源包放在实例自己的文件夹里。";
const B = "与其他未隔离的实例共用 .minecraft 下的存档与配置。";
const C = "跟随全局：仅快照与远古版本隔离。这个实例与其他未隔离的实例共用存档与配置。";

let view: Rendered | undefined;

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.restoreAllMocks();
});

const slot = () => {
  const el = view?.container.firstElementChild;
  if (!(el instanceof HTMLElement)) throw new Error("没有说明槽");
  return el;
};

describe("NoteSlot", () => {
  it("文本内容只有当前这条；其余候选写进伪元素取值的属性里占位，不进文本与读屏", () => {
    view = render(<NoteSlot current={B} options={[A, B, C]} />);
    expect(slot().textContent).toBe(B);
    expect([slot().dataset.reserveA, slot().dataset.reserveB]).toEqual([A, C]);
  });

  it("此刻没有说明（null）：文本为空，照样按全部候选占位", () => {
    view = render(<NoteSlot current={null} options={[A, C]} />);
    expect(slot().textContent).toBe("");
    expect([slot().dataset.reserveA, slot().dataset.reserveB]).toEqual([A, C]);
  });

  it("挂载时的说明不淡入；换过之后，换上来的说明重新挂上并淡入，备用跟着换成其余两条", () => {
    view = render(<NoteSlot current={A} options={[A, B, C]} />);
    const first = slot().firstElementChild;
    expect(first?.hasAttribute("data-enter")).toBe(false);
    view.rerender(<NoteSlot current={C} options={[A, B, C]} />);
    const next = slot().firstElementChild;
    expect(next).not.toBe(first);
    expect(next?.textContent).toBe(C);
    expect(next?.hasAttribute("data-enter")).toBe(true);
    expect([slot().dataset.reserveA, slot().dataset.reserveB]).toEqual([A, B]);
  });

  it("重复的候选只算一条", () => {
    view = render(<NoteSlot current={A} options={[A, B, B]} />);
    expect([slot().dataset.reserveA, slot().dataset.reserveB]).toEqual([B, undefined]);
  });

  it("当前说明不在候选里、备用超过两条，都直接报错", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<NoteSlot current="别的" options={[A, B]} />)).toThrow("NoteSlot 当前说明「别的」不在候选里");
    expect(() => render(<NoteSlot current={null} options={[A, B, C]} />)).toThrow("NoteSlot 备用说明最多 2 条，收到 3 条");
  });

  it("样式：当前说明与两个伪元素叠在同一格，伪元素取属性里的备用文案、不可见", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "NoteSlot.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = (selector: string) => {
      const found = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].find((m) => m[1].split(",").map((s) => s.trim()).includes(selector));
      if (found === undefined) throw new Error(`样式表里没有 ${selector}`);
      return found[2];
    };
    expect(rule(".slot")).toMatch(/display:\s*grid/);
    for (const part of [".slot::before", ".slot::after", ".current"]) expect(rule(part)).toMatch(/grid-area:\s*1 \/ 1/);
    const before = [...css.matchAll(/\.slot::before\s*\{([^}]*)\}/g)].map((m) => m[1]).join("");
    const after = [...css.matchAll(/\.slot::after\s*\{([^}]*)\}/g)].map((m) => m[1]).join("");
    expect(before).toMatch(/content:\s*attr\(data-reserve-a\)/);
    expect(before).toMatch(/visibility:\s*hidden/);
    expect(after).toMatch(/content:\s*attr\(data-reserve-b\)/);
    expect(after).toMatch(/visibility:\s*hidden/);
  });
});
