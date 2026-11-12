// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type { ResourceResult } from "../../../state/resource";
import { render, type Rendered } from "../../../test/dom";
import { useKept, type Kept } from "./kept";

const noop = () => undefined;
const loading = (): ResourceResult<string[]> => ({ status: "loading", data: undefined, error: null, refreshing: false, reload: noop, refresh: noop });
const ready = (data: string[]): ResourceResult<string[]> => ({ status: "ready", data, error: null, refreshing: false, reload: noop, refresh: noop });
const failed = (message: string): ResourceResult<string[]> => ({ status: "error", data: undefined, error: new Error(message), refreshing: false, reload: noop, refresh: noop });

let view: Rendered | undefined;
let seen: Kept<string[]> | undefined;

function Probe({ result }: { result: ResourceResult<string[]> }) {
  seen = useKept(result);
  return null;
}

function show(result: ResourceResult<string[]>): Kept<string[]> {
  if (view === undefined) view = render(<Probe result={result} />);
  else view.rerender(<Probe result={result} />);
  if (seen === undefined) throw new Error("探针没有渲染");
  return seen;
}

afterEach(() => {
  view?.unmount();
  view = undefined;
  seen = undefined;
});

describe("useKept：换参数重取期间沿用上一份", () => {
  it("从没到过时加载中是空的；到过之后再加载（换了 key）接着给上一份并标为旧的，新的一到就换上", () => {
    expect(show(loading())).toEqual({ data: null, stale: false });
    const first = ["1.0.0", "0.9.0"];
    expect(show(ready(first))).toEqual({ data: first, stale: false });
    expect(show(loading())).toEqual({ data: first, stale: true });
    const second = ["2.0.0"];
    expect(show(ready(second))).toEqual({ data: second, stale: false });
    expect(show(loading())).toEqual({ data: second, stale: true });
  });

  it("出错时不拿上一份冒充：给空，由调用方原位报错；之后重试的加载中仍接着给最后到过的那一份", () => {
    const first = ["1.0.0"];
    show(ready(first));
    expect(show(failed("网络超时"))).toEqual({ data: null, stale: false });
    expect(show(loading())).toEqual({ data: first, stale: true });
  });
});
