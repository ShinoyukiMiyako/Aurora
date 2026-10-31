// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { setRect } from "../test/dom";
import { styleBook, type StyleInit } from "./diag-test-kit";
import { measureAccentArea, rasterizedArea, resolveAccentFamily, type AccentFamily } from "./diagnostics";

const VIEWPORT = { width: 1000, height: 800 };
const ACCENT = "rgb(207, 48, 128)";
const SOFT = "rgba(207, 48, 128, 0.11)";
// 晕染里故意含一个强调色族的颜色：即使颜色撞上，氛围晕染也按规格不计
const AMBIENCE = "radial-gradient(60% 50% at 92% -8%, rgba(207, 48, 128, 0.11), rgba(0, 0, 0, 0) 70%)";

const FAMILY: AccentFamily = {
  colors: [
    { r: 207, g: 48, b: 128, a: 255 },
    { r: 247, g: 182, b: 210, a: 255 },
    { r: 207, g: 48, b: 128, a: 28 },
  ],
  ambienceImage: AMBIENCE,
};

afterEach(() => {
  document.body.replaceChildren();
});

function scene() {
  const book = styleBook();
  const root = document.createElement("div");
  document.body.append(root);
  setRect(root, { left: 0, top: 0, ...VIEWPORT });
  const box = (rect: { left: number; top: number; width: number; height: number }, style: StyleInit = {}, parent: Element = root, pseudos = {}) => {
    const el = document.createElement("div");
    parent.append(el);
    setRect(el, rect);
    book.set(el, style, pseudos);
    return el;
  };
  const measure = () => measureAccentArea({ root, viewport: VIEWPORT, family: FAMILY, styleOf: book.reader });
  return { root, box, measure };
}

describe("rasterizedArea", () => {
  it("两块重叠的强调色区域只计一次", () => {
    const a = { left: 0, top: 0, right: 80, bottom: 80 };
    const b = { left: 40, top: 40, right: 120, bottom: 120 };
    expect(rasterizedArea([a, b], VIEWPORT)).toBe(80 * 80 * 2 - 40 * 40);
    expect(rasterizedArea([a, a, a], VIEWPORT)).toBe(6400);
    expect(rasterizedArea([b, a], VIEWPORT)).toBe(11200);
  });

  it("按网格中心判定覆盖：中心在矩形内才计，矩形右下边不含", () => {
    expect(rasterizedArea([{ left: 3, top: 3, right: 13, bottom: 13 }], VIEWPORT)).toBe(4 * 64);
    expect(rasterizedArea([{ left: 5, top: 5, right: 11, bottom: 11 }], VIEWPORT)).toBe(0);
    expect(rasterizedArea([{ left: 4, top: 4, right: 12, bottom: 12 }], VIEWPORT)).toBe(64);
    expect(rasterizedArea([{ left: 4, top: 4, right: 12.01, bottom: 12.01 }], VIEWPORT)).toBe(4 * 64);
  });

  it("视口外的部分不计，视口边缘不足一格的单元按实际面积计", () => {
    const viewport = { width: 100, height: 100 };
    expect(rasterizedArea([{ left: -50, top: -50, right: 500, bottom: 500 }], viewport)).toBe(10_000);
    expect(rasterizedArea([{ left: 96, top: 0, right: 100, bottom: 8 }], viewport)).toBe(32);
    expect(rasterizedArea([{ left: 200, top: 200, right: 300, bottom: 300 }], viewport)).toBe(0);
  });
});

describe("measureAccentArea", () => {
  it("强调色实底与浅底整块计入，重叠只计一次；白底与透明底不计", () => {
    const { box, measure } = scene();
    const a = box({ left: 0, top: 0, width: 80, height: 80 }, { backgroundColor: ACCENT });
    box({ left: 40, top: 40, width: 80, height: 80 }, { backgroundColor: SOFT });
    box({ left: 400, top: 400, width: 200, height: 200 }, { backgroundColor: "rgb(255, 255, 255)" });
    box({ left: 600, top: 0, width: 200, height: 200 }, { backgroundColor: "rgba(207, 48, 128, 0.3)" });
    const report = measure();
    expect(report.coveredPx).toBe(11200);
    expect(report.viewportPx).toBe(800_000);
    expect(report.ratio).toBeCloseTo(0.014, 12);
    expect(report.boxes.map((b) => b.source)).toEqual(["background", "background"]);
    expect(report.boxes[0].element).toBe(a);
  });

  it("背景图里的强调色计入，窗口氛围晕染不计", () => {
    const { box, measure } = scene();
    box({ left: 0, top: 0, width: 160, height: 40 }, { backgroundImage: "linear-gradient(140deg, rgb(230, 120, 170) 0%, rgb(207, 48, 128) 30%, rgb(207, 48, 128) 100%)" });
    box({ left: 0, top: 0, width: 1000, height: 800 }, { backgroundImage: AMBIENCE });
    box({ left: 0, top: 400, width: 160, height: 40 }, { backgroundImage: "linear-gradient(rgb(10, 10, 10), rgb(20, 20, 20))" });
    expect(measure().coveredPx).toBe(160 * 40);
  });

  it("不超过 2 px 的强调色描边不计，更宽的只计描边条", () => {
    const { box, measure } = scene();
    const sides = (width: string) =>
      Object.fromEntries(["Top", "Right", "Bottom", "Left"].flatMap((s) => [[`border${s}Style`, "solid"], [`border${s}Width`, width], [`border${s}Color`, ACCENT]]));
    // 2 px 描边条恰好压在网格中心（y = 4、x = 4）上，计入的话面积会多出一圈
    box({ left: 3, top: 3, width: 400, height: 400 }, sides("2px"));
    box({ left: 496, top: 96, width: 96, height: 96 }, sides("8px"));
    const report = measure();
    expect(report.boxes.every((b) => b.source === "border")).toBe(true);
    // 12 × 12 格的外圈一格宽
    expect(report.coveredPx).toBe((12 * 12 - 10 * 10) * 64);
  });

  it("display: none 与 opacity: 0 的子树跳过；visibility: hidden 的元素自身不计、子元素照常", () => {
    const { box, measure } = scene();
    const gone = box({ left: 0, top: 0, width: 400, height: 400 }, { display: "none" });
    box({ left: 0, top: 0, width: 80, height: 80 }, { backgroundColor: ACCENT }, gone);
    const clear = box({ left: 0, top: 0, width: 400, height: 400 }, { opacity: "0" });
    box({ left: 0, top: 0, width: 80, height: 80 }, { backgroundColor: ACCENT }, clear);
    const hidden = box({ left: 400, top: 400, width: 80, height: 80 }, { visibility: "hidden", backgroundColor: ACCENT });
    box({ left: 600, top: 600, width: 16, height: 16 }, { backgroundColor: ACCENT }, hidden);
    expect(measure().coveredPx).toBe(256);
  });

  it("按祖先的 overflow 裁剪，fixed 定位只按视口裁剪", () => {
    const { box, measure } = scene();
    const scroller = box({ left: 0, top: 0, width: 80, height: 80 }, { overflowX: "hidden", overflowY: "auto" });
    box({ left: 40, top: 40, width: 200, height: 200 }, { backgroundColor: ACCENT }, scroller);
    expect(measure().coveredPx).toBe(40 * 40);

    const second = scene();
    const clip = second.box({ left: 0, top: 0, width: 80, height: 80 }, { overflowX: "hidden", overflowY: "hidden" });
    second.box({ left: 400, top: 400, width: 80, height: 80 }, { backgroundColor: ACCENT, position: "fixed" }, clip);
    expect(second.measure().coveredPx).toBe(6400);

    const third = scene();
    const horizontal = third.box({ left: 0, top: 0, width: 80, height: 80 }, { overflowX: "clip" });
    third.box({ left: 40, top: 40, width: 200, height: 200 }, { backgroundColor: ACCENT }, horizontal);
    expect(third.measure().coveredPx).toBe(40 * 200);
  });

  it("绝对定位的伪元素按计算样式还原外框；文档流里的伪元素列为无法测量", () => {
    const { box, measure } = scene();
    const host = box({ left: 200, top: 200, width: 160, height: 40 }, { position: "relative", borderLeftWidth: "8px", borderTopWidth: "0px" }, undefined, {
      "::before": { content: '""', position: "absolute", left: "0px", top: "8px", width: "16px", height: "24px", backgroundColor: ACCENT },
    });
    const flow = box({ left: 600, top: 600, width: 40, height: 40 }, {}, undefined, {
      "::after": { content: '""', display: "inline-block", backgroundColor: ACCENT },
    });
    box({ left: 0, top: 600, width: 40, height: 40 }, {}, undefined, {
      "::before": { content: "none", backgroundColor: ACCENT },
    });
    const ring = box({ left: 800, top: 600, width: 40, height: 40 }, {}, undefined, {
      "::before": { content: '""', borderTopStyle: "solid", borderTopWidth: "4px", borderTopColor: ACCENT },
    });
    const report = measure();
    expect(report.boxes).toHaveLength(1);
    expect(report.boxes[0]).toMatchObject({ element: host, pseudo: "::before", box: { left: 208, top: 208, right: 224, bottom: 232 } });
    expect(report.coveredPx).toBe(2 * 3 * 64);
    expect(report.unmeasured).toEqual([
      { element: flow, pseudo: "::after" },
      { element: ring, pseudo: "::before" },
    ]);
  });
});

describe("resolveAccentFamily", () => {
  it("逐个解析强调色族令牌，并取到氛围晕染的计算值；令牌缺失时报错", () => {
    const probe = document.createElement("span");
    document.body.append(probe);
    const resolved: string[] = [];
    vi.spyOn(window, "getComputedStyle").mockImplementation((el) => {
      const style = (el as HTMLElement).style;
      if (style.color !== "") resolved.push(style.color);
      return {
        color: "rgb(207, 48, 128)",
        backgroundImage: style.backgroundImage === "var(--sk-ambience)" ? AMBIENCE : "none",
        getPropertyValue: (name: string) => (name === "--sk-accent-ink" ? "" : "declared"),
      } as unknown as CSSStyleDeclaration;
    });
    const family = resolveAccentFamily(probe);
    expect(resolved).toEqual(
      ["--sk-accent", "--sk-accent-2", "--sk-accent-strong", "--sk-accent-soft", "--sk-accent-soft-2", "--sk-accent-line", "--sk-heat-1", "--sk-heat-2", "--sk-heat-3", "--sk-heat-4"].map((t) => `var(${t})`),
    );
    expect(family.colors).toHaveLength(10);
    expect(family.ambienceImage).toBe(AMBIENCE);
    expect(probe.getAttribute("style")).toBe("");

    vi.spyOn(window, "getComputedStyle").mockImplementation(() => ({ getPropertyValue: () => "" }) as unknown as CSSStyleDeclaration);
    expect(() => resolveAccentFamily(probe)).toThrow("--sk-accent 未声明");
  });
});
