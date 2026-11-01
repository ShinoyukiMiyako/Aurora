// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { render, type Rendered } from "../test/dom";
import { Button } from "./Button";
import { WarnNote } from "./WarnNote";

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

const css = readFileSync(resolve(__dirname, "WarnNote.module.css"), "utf8");

describe("WarnNote", () => {
  it("一行：警示图标、文字，不带按钮时没有按钮位", () => {
    view = render(<WarnNote>地址不是 https</WarnNote>);
    const note = view.container.firstElementChild as HTMLElement;
    expect(note.querySelector("svg")).not.toBeNull();
    expect(note.textContent).toBe("地址不是 https");
    expect(note.querySelector("button")).toBeNull();
  });

  it("按钮放在文字之后", () => {
    view = render(<WarnNote action={<Button size="sm">重试</Button>}>读不出来</WarnNote>);
    const note = view.container.firstElementChild as HTMLElement;
    expect(note.textContent).toBe("读不出来重试");
    expect(note.lastElementChild?.querySelector("button")?.textContent).toBe("重试");
  });

  it("文字与说明块的文字对齐：左内边距多出说明块那 1px 描边", () => {
    expect(css).toContain("padding: 0 calc(var(--sk-space-14) + 1px)");
  });

  it("放开任意处折行，长路径不被裁掉", () => {
    expect(css).toMatch(/\.text \{[^}]*overflow-wrap:\s*anywhere/);
  });
});
