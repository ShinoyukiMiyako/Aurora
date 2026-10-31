// 诊断测试共用的样式替身：jsdom 不做层叠与布局，计算样式按元素逐个登记。只被 *.test.ts 引用。

import type { Pseudo, StyleReader } from "./diagnostics";

export type StyleInit = Readonly<Record<string, string>>;

const DEFAULTS: StyleInit = {
  display: "block",
  opacity: "1",
  visibility: "visible",
  position: "static",
  overflowX: "visible",
  overflowY: "visible",
  backgroundColor: "color(srgb 0 0 0 / 0)",
  backgroundImage: "none",
  maskImage: "none",
  WebkitMaskImage: "none",
  content: "none",
  left: "0px",
  top: "0px",
  width: "0px",
  height: "0px",
  ...Object.fromEntries(["Top", "Right", "Bottom", "Left"].flatMap((s) => [[`border${s}Style`, "none"], [`border${s}Width`, "0px"], [`border${s}Color`, "color(srgb 0 0 0)"]])),
};

const camel = (name: string) => name.replace(/^-/, "").replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()).replace(/^webkit/, "Webkit");

export function fakeStyle(init: StyleInit = {}): CSSStyleDeclaration {
  const values: Record<string, string> = { ...DEFAULTS, ...init };
  return {
    ...values,
    getPropertyValue: (name: string) => {
      const key = camel(name);
      if (!(key in values)) throw new Error(`样式替身没有登记 ${name}`);
      return values[key];
    },
  } as unknown as CSSStyleDeclaration;
}

export interface StyleBook {
  set(element: Element, self: StyleInit, pseudos?: Partial<Record<Pseudo, StyleInit>>): void;
  reader: StyleReader;
}

export function styleBook(): StyleBook {
  const book = new Map<Element, { self: StyleInit; pseudos: Partial<Record<Pseudo, StyleInit>> }>();
  return {
    set(element, self, pseudos = {}) {
      book.set(element, { self, pseudos });
    },
    reader(element, pseudo) {
      const entry = book.get(element);
      if (entry === undefined) return fakeStyle();
      if (pseudo === null) return fakeStyle(entry.self);
      const init = entry.pseudos[pseudo];
      return fakeStyle(init === undefined ? {} : init);
    },
  };
}
