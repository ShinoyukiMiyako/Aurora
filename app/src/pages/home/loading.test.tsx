// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOADING_DELAY_MS, SLOW_HINT_MS } from "../../domain/limits";
import { render, type Rendered } from "../../test/dom";
import { useLoadingGate } from "./loading";

let view: Rendered | undefined;

function Probe({ loading }: { loading: boolean }) {
  const gate = useLoadingGate(loading);
  return <span data-view={gate.view} data-slow={gate.slow} />;
}

const state = () => {
  const el = view?.container.querySelector("span");
  if (!el) throw new Error("探针没有渲染");
  return { view: el.dataset.view, slow: el.dataset.slow };
};

const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
});

describe("useLoadingGate", () => {
  it("300 ms 内加载完：从不出现骨架", () => {
    view = render(<Probe loading />);
    expect(state().view).toBe("pending");
    advance(LOADING_DELAY_MS - 1);
    expect(state().view).toBe("pending");
    view.rerender(<Probe loading={false} />);
    expect(state().view).toBe("content");
    advance(LOADING_DELAY_MS * 2);
    expect(state().view).toBe("content");
  });

  it("超过 300 ms 出现骨架；数据到了骨架再保持到满 300 ms", () => {
    view = render(<Probe loading />);
    advance(LOADING_DELAY_MS);
    expect(state().view).toBe("skeleton");
    advance(100);
    view.rerender(<Probe loading={false} />);
    expect(state().view).toBe("skeleton");
    advance(LOADING_DELAY_MS - 101);
    expect(state().view).toBe("skeleton");
    advance(1);
    expect(state().view).toBe("content");
  });

  it("骨架已显示满 300 ms 后数据到达：立即换成内容", () => {
    view = render(<Probe loading />);
    advance(LOADING_DELAY_MS * 3);
    view.rerender(<Probe loading={false} />);
    expect(state().view).toBe("content");
  });

  it("超过 10 s 仍在加载时标为慢；重新开始加载时清掉", () => {
    view = render(<Probe loading />);
    advance(SLOW_HINT_MS - 1);
    expect(state().slow).toBe("false");
    advance(1);
    expect(state()).toEqual({ view: "skeleton", slow: "true" });
    view.rerender(<Probe loading={false} />);
    expect(state().slow).toBe("false");
    view.rerender(<Probe loading />);
    expect(state()).toEqual({ view: "pending", slow: "false" });
  });

  it("一开始就不在加载：直接是内容", () => {
    view = render(<Probe loading={false} />);
    expect(state().view).toBe("content");
  });
});
