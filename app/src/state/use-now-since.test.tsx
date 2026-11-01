// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, type Rendered } from "../test/dom";
import { useNowSince } from "./launcher";

const COARSE_MS = 30_000;
const T0 = new Date(2026, 9, 31, 12, 0, 0).getTime();

let seen: number[];
let view: Rendered | undefined;

function Clock({ ts }: { ts: number | null }) {
  seen.push(useNowSince(ts, COARSE_MS));
  return null;
}

const last = () => seen[seen.length - 1];

const pass = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

/** 这段时间里时钟换了几次值。逐秒推进：一个 act 里的几次更新会并成一次渲染。 */
async function ticksDuring(ms: number): Promise<number> {
  const before = new Set(seen).size;
  for (let left = ms; left > 0; left -= 1000) await pass(Math.min(left, 1000));
  return new Set(seen).size - before;
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  seen = [];
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
});

describe("useNowSince", () => {
  it("时刻早已过去或没有时刻：只按粗间隔走", async () => {
    view = render(<Clock ts={T0 - 3_600_000} />);
    expect(await ticksDuring(COARSE_MS - 1)).toBe(0);
    expect(await ticksDuring(1)).toBe(1);
    expect(last()).toBe(T0 + COARSE_MS);

    view.rerender(<Clock ts={null} />);
    expect(await ticksDuring(COARSE_MS - 1)).toBe(0);
  });

  it("时刻变了当场重取，不等下一跳", async () => {
    view = render(<Clock ts={T0 - 3_600_000} />);
    await pass(10_000);
    expect(last()).toBe(T0);

    view.rerender(<Clock ts={T0 + 10_000} />);
    expect(last()).toBe(T0 + 10_000);
  });

  it("不到一分钟按秒走，到了一分钟回到粗间隔", async () => {
    view = render(<Clock ts={T0} />);
    expect(await ticksDuring(59_000)).toBe(59);
    expect(last()).toBe(T0 + 59_000);

    await pass(1_000);
    expect(last()).toBe(T0 + 60_000);
    expect(await ticksDuring(COARSE_MS - 1)).toBe(0);
    expect(await ticksDuring(1)).toBe(1);
  });

  it("卸载后不再走表", async () => {
    view = render(<Clock ts={T0} />);
    await pass(1_000);
    view.unmount();
    view = undefined;
    expect(vi.getTimerCount()).toBe(0);
  });
});
