// @vitest-environment jsdom
// 左栏花瓣什么时候停：窗口不可见或失焦时都停，回到前台再走。
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, type Rendered } from "../test/dom";
import { usePetalsPaused } from "./art";

let view: Rendered | null = null;
const seen: boolean[] = [];

function Probe() {
  seen.push(usePetalsPaused());
  return null;
}

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

afterEach(() => {
  view?.unmount();
  view = null;
  seen.length = 0;
  Reflect.deleteProperty(document, "hidden");
});

describe("花瓣暂停", () => {
  it("失焦时停，重新拿到焦点时接着走", () => {
    const focused = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    view = render(<Probe />);
    expect(seen.at(-1)).toBe(false);

    focused.mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(seen.at(-1)).toBe(true);

    focused.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(seen.at(-1)).toBe(false);
  });

  it("有焦点但不可见（最小化）时也停", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    view = render(<Probe />);
    setHidden(true);
    expect(seen.at(-1)).toBe(true);
    setHidden(false);
    expect(seen.at(-1)).toBe(false);
  });
});
