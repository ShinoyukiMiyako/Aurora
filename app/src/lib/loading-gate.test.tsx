// @vitest-environment jsdom
import { act, useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOADING_DELAY_MS, SLOW_HINT_MS } from "../domain/limits";
import { render, type Rendered } from "../test/dom";
import { useLoadingGate, type LoadingView } from "./loading-gate";

let view: Rendered | undefined;

function Probe({ loading }: { loading: boolean }) {
  const gate = useLoadingGate(loading);
  return <span data-view={gate.view} data-slow={gate.slow} />;
}

const state = () => {
  const el = view?.container.querySelector("span");
  if (!el) throw new Error("探针没有渲染");
  return { view: el.dataset.view as LoadingView, slow: el.dataset.slow === "true" };
};

const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

const setLoading = (loading: boolean) => view?.rerender(<Probe loading={loading} />);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
});

describe("useLoadingGate：出现延迟", () => {
  it("延迟内加载完：从头到尾不出现骨架，等待期间是占位", () => {
    view = render(<Probe loading />);
    expect(state().view).toBe("pending");
    advance(LOADING_DELAY_MS - 1);
    expect(state().view).toBe("pending");
    setLoading(false);
    expect(state().view).toBe("content");
    advance(LOADING_DELAY_MS * 2);
    expect(state().view).toBe("content");
  });

  it("恰好到延迟仍在加载：出现骨架", () => {
    view = render(<Probe loading />);
    advance(LOADING_DELAY_MS);
    expect(state().view).toBe("skeleton");
  });

  it("一开始就不在加载：直接是内容", () => {
    view = render(<Probe loading={false} />);
    expect(state().view).toBe("content");
  });
});

describe("useLoadingGate：最短停留", () => {
  it("骨架出现 100 ms 后数据到达：骨架再停到满延迟时长，差 1 ms 都不收", () => {
    view = render(<Probe loading />);
    advance(LOADING_DELAY_MS);
    advance(100);
    setLoading(false);
    expect(state().view).toBe("skeleton");
    advance(LOADING_DELAY_MS - 101);
    expect(state().view).toBe("skeleton");
    advance(1);
    expect(state().view).toBe("content");
  });

  it("骨架已停满后数据到达：立即换成内容", () => {
    view = render(<Probe loading />);
    advance(LOADING_DELAY_MS * 3);
    setLoading(false);
    expect(state().view).toBe("content");
  });

  it("骨架停留期间又开始加载：骨架一直显示，不先消失再出现，也不重新计最短停留", () => {
    view = render(<Probe loading />);
    advance(LOADING_DELAY_MS);
    expect(state().view).toBe("skeleton");
    advance(50);
    setLoading(false);
    advance(50);
    setLoading(true);
    // 新一轮加载开始的这一帧仍是骨架，没有落回占位
    expect(state().view).toBe("skeleton");
    advance(LOADING_DELAY_MS);
    expect(state().view).toBe("skeleton");
    // 骨架从第一次出现算起已经停了 400 ms，超过最短停留：数据一到立即换成内容
    setLoading(false);
    expect(state().view).toBe("content");
  });

  it("内容已经换上后再开始加载：重新走一遍延迟", () => {
    view = render(<Probe loading />);
    advance(LOADING_DELAY_MS * 2);
    setLoading(false);
    expect(state().view).toBe("content");
    setLoading(true);
    expect(state().view).toBe("pending");
    advance(LOADING_DELAY_MS - 1);
    expect(state().view).toBe("pending");
    advance(1);
    expect(state().view).toBe("skeleton");
  });
});

describe("useLoadingGate：骨架出现的时刻", () => {
  // 同一组件里还有别的更新在排队时，状态更新函数要等到下一次渲染才求值；骨架出现的时刻得取定时器到点那一刻，
  // 不能取渲染那一刻，否则渲染被推迟多久，骨架就多停多久
  function Busy({ loading }: { loading: boolean }) {
    const gate = useLoadingGate(loading);
    const [, setTick] = useState(0);
    useEffect(() => {
      const timer = setTimeout(() => setTick((n) => n + 1), LOADING_DELAY_MS - 1);
      return () => clearTimeout(timer);
    }, []);
    return <span data-view={gate.view} data-slow={gate.slow} />;
  }

  it("渲染比定时器晚到：最短停留仍从定时器到点算起", () => {
    view = render(<Busy loading />);
    // 一次推进到延迟之后 200 ms：两个定时器都在这一步里触发，渲染在推进结束时才发生
    act(() => {
      vi.advanceTimersByTime(LOADING_DELAY_MS + 200);
    });
    expect(state().view).toBe("skeleton");
    view.rerender(<Busy loading={false} />);
    expect(state().view).toBe("skeleton");
    advance(LOADING_DELAY_MS - 200 - 1);
    expect(state().view).toBe("skeleton");
    advance(1);
    expect(state().view).toBe("content");
  });
});

describe("useLoadingGate：慢提示", () => {
  it("同一轮加载满 SLOW_HINT_MS 才标为慢；结束即清掉；新一轮重新计时", () => {
    view = render(<Probe loading />);
    advance(SLOW_HINT_MS - 1);
    expect(state()).toEqual({ view: "skeleton", slow: false });
    advance(1);
    expect(state()).toEqual({ view: "skeleton", slow: true });
    setLoading(false);
    expect(state().slow).toBe(false);
    setLoading(true);
    expect(state().slow).toBe(false);
    advance(SLOW_HINT_MS - 1);
    expect(state().slow).toBe(false);
    advance(1);
    expect(state().slow).toBe(true);
  });
});

/** 线性同余发生器：随机加载时长可复现，失败时能按种子重放。 */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

describe("useLoadingGate：随机加载时长", () => {
  it.each([7, 42, 20261031])("种子 %i：骨架出现当且仅当加载不短于延迟，且一旦出现至少停留延迟时长", (seed) => {
    const random = seeded(seed);
    for (let round = 0; round < 25; round++) {
      // 时长覆盖延迟两侧，并钉住延迟本身与它前后 1 ms
      const fixed = [LOADING_DELAY_MS - 1, LOADING_DELAY_MS, LOADING_DELAY_MS + 1];
      const duration = round < fixed.length ? fixed[round] : Math.floor(random() * LOADING_DELAY_MS * 4);
      view = render(<Probe loading />);
      let sawSkeleton = false;
      for (let t = 0; t < duration; t++) {
        advance(1);
        if (state().view === "skeleton") sawSkeleton = true;
      }
      setLoading(false);
      let visibleAfter = 0;
      while (state().view === "skeleton") {
        sawSkeleton = true;
        advance(1);
        visibleAfter++;
      }
      expect(state().view).toBe("content");
      expect(sawSkeleton, `加载 ${duration} ms`).toBe(duration >= LOADING_DELAY_MS);
      if (sawSkeleton) {
        const shownFor = duration - LOADING_DELAY_MS + visibleAfter;
        expect(shownFor, `加载 ${duration} ms`).toBeGreaterThanOrEqual(LOADING_DELAY_MS);
      } else {
        expect(visibleAfter).toBe(0);
      }
      view.unmount();
      view = undefined;
    }
  });
});
