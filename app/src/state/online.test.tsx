// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, type Rendered } from "../test/dom";
import { useOnline } from "./online";

let view: Rendered | undefined;
let online: boolean;
const seen: boolean[] = [];

function Probe() {
  seen.push(useOnline());
  return null;
}

beforeEach(() => {
  online = true;
  seen.length = 0;
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
});

afterEach(() => {
  view?.unmount();
  view = undefined;
});

describe("联网状态", () => {
  it("按 navigator.onLine 取值，随 offline / online 事件刷新", () => {
    online = false;
    view = render(<Probe />);
    expect(seen.at(-1)).toBe(false);

    online = true;
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(seen.at(-1)).toBe(true);

    online = false;
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(seen.at(-1)).toBe(false);
  });

  it("卸载后退订：之后的事件不再触发渲染", () => {
    view = render(<Probe />);
    view.unmount();
    view = undefined;
    const renders = seen.length;
    online = false;
    window.dispatchEvent(new Event("offline"));
    expect(seen).toHaveLength(renders);
  });
});
