// @vitest-environment jsdom
import { useCallback, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, setRect, stubResizeObserver, type Rendered } from "../test/dom";
import { applyTier, tierOf, TIER_REGULAR_MIN, TIER_WIDE_MIN, useTier, type Tier } from "./tier";

const html = document.documentElement;

describe("tierOf", () => {
  it.each([
    [960, "compact"],
    [1099, "compact"],
    [1099.5, "compact"],
    [1100, "regular"],
    [1379, "regular"],
    [1380, "wide"],
    [2560, "wide"],
  ] as const)("%d px -> %s", (width, tier) => {
    expect(tierOf(width)).toBe(tier);
  });

  it("阈值 1100 / 1380", () => {
    expect([TIER_REGULAR_MIN, TIER_WIDE_MIN]).toEqual([1100, 1380]);
  });

  it("随机宽度与阈值比较一致", () => {
    for (let i = 0; i < 300; i++) {
      const width = 600 + Math.random() * 1600;
      const expected: Tier = width < 1100 ? "compact" : width < 1380 ? "regular" : "wide";
      expect(tierOf(width)).toBe(expected);
    }
  });

  it("applyTier 写到 <html>", () => {
    applyTier("wide");
    expect(html.getAttribute("data-sk-tier")).toBe("wide");
  });
});

describe("useTier", () => {
  let view: Rendered | undefined;
  afterEach(() => {
    view?.unmount();
    view = undefined;
    vi.unstubAllGlobals();
    html.removeAttribute("data-sk-tier");
  });

  let shown: Tier | undefined;
  function Frame({ width }: { width: number }) {
    const [el, setEl] = useState<HTMLDivElement | null>(null);
    shown = useTier(el);
    // 回调 ref 必须稳定：每次渲染换新函数会先回调 null 再回调节点，触发无限重渲染
    const ref = useCallback(
      (node: HTMLDivElement | null) => {
        if (node) setRect(node, { left: 0, top: 0, width, height: 720 });
        setEl(node);
      },
      [width],
    );
    return <div ref={ref} />;
  }

  it("挂载即按元素宽度分档，随尺寸变化更新 <html>，卸载时断开观察", () => {
    const ro = stubResizeObserver();
    view = render(<Frame width={1200} />);
    expect(shown).toBe("regular");
    expect(html.getAttribute("data-sk-tier")).toBe("regular");

    const el = ro.observed()[0];
    expect(el).toBeInstanceOf(HTMLDivElement);
    ro.resize(el, 1000);
    expect(shown).toBe("compact");
    expect(html.getAttribute("data-sk-tier")).toBe("compact");
    ro.resize(el, 1500);
    expect(shown).toBe("wide");
    expect(html.getAttribute("data-sk-tier")).toBe("wide");

    view.unmount();
    view = undefined;
    expect(ro.disconnects()).toBe(1);
    expect(ro.observed()).toEqual([]);
  });

  it("元素未挂载前按窗口宽度估计", () => {
    stubResizeObserver();
    vi.stubGlobal("innerWidth", 1400);
    let first: Tier | undefined;
    function Detached() {
      first = useTier(null);
      return null;
    }
    view = render(<Detached />);
    expect(first).toBe("wide");
    expect(html.hasAttribute("data-sk-tier")).toBe(false);
  });
});
