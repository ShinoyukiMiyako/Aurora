// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { render, waitForFrames, type Rendered } from "../../test/dom";
import { ArtCrossfade } from "./ArtCrossfade";

let view: Rendered | undefined;

afterEach(() => {
  view?.unmount();
  view = undefined;
});

const tree = (real: string | null, realKey?: string) => (
  <ArtCrossfade fallback={<i data-fallback="" />} real={real === null ? null : <b data-real={real} />} realKey={realKey} />
);

/** 包着某张图的那一层。 */
const layerOf = (selector: string) => view?.container.querySelector(selector)?.parentElement ?? null;
const realLayers = () => [...(view?.container.querySelectorAll<HTMLElement>("[data-real]") ?? [])].map((el) => ({ src: el.dataset.real, layer: el.parentElement as HTMLElement }));

describe("ArtCrossfade", () => {
  it("首帧就有真图（缓存命中）：直接显示，回落件藏起，不播淡化", () => {
    view = render(tree("steve"));
    expect(layerOf("[data-real]")?.style.opacity).toBe("1");
    expect(layerOf("[data-fallback]")?.style.opacity).toBe("0");
  });

  it("真图晚到：从透明淡入", () => {
    view = render(tree(null));
    expect(layerOf("[data-fallback]")?.style.opacity).toBe("1");
    view.rerender(tree("steve"));
    expect(layerOf("[data-real]")?.style.opacity).toBe("0");
  });

  it("真图没了：真图层淡出后才卸下，不同帧留空；再来的真图照样淡入，不因挂载时有过真图就硬切", async () => {
    view = render(tree("steve"));
    view.rerender(tree(null));
    // 退场中还在
    expect(realLayers().map((r) => r.src)).toEqual(["steve"]);
    await waitForFrames(() => {
      expect(realLayers()).toEqual([]);
      expect(layerOf("[data-fallback]")?.style.opacity).toBe("1");
    });

    view.rerender(tree("alex"));
    expect(layerOf("[data-real]")?.style.opacity).toBe("0");
  });

  it("来源变了：旧图淡出、新图淡入，两层叠放交叉；没给来源标识时原地换图", async () => {
    view = render(tree("steve", "skin/aa"));
    view.rerender(tree("alex", "skin/bb"));
    const both = realLayers();
    expect(both.map((r) => r.src).sort()).toEqual(["alex", "steve"]);
    expect(both.find((r) => r.src === "alex")?.layer.style.opacity).toBe("0");
    await waitForFrames(() => expect(realLayers().map((r) => r.src)).toEqual(["alex"]));
    view.unmount();

    view = render(tree("steve"));
    const layer = layerOf("[data-real]");
    view.rerender(tree("alex"));
    expect(realLayers()).toEqual([{ src: "alex", layer }]);
  });

  it("挂载时的那张图换走之后又换回来：换回来的是新的一次，照样淡入", async () => {
    view = render(tree("steve", "skin/aa"));
    expect(layerOf("[data-real]")?.style.opacity).toBe("1");
    view.rerender(tree("alex", "skin/bb"));
    await waitForFrames(() => expect(realLayers().map((r) => r.src)).toEqual(["alex"]));

    view.rerender(tree("steve", "skin/aa"));
    expect(realLayers().find((r) => r.src === "steve")?.layer.style.opacity).toBe("0");
  });
});
