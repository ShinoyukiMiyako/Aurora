// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { springAt } from "../../lib/motion";
import { springTrack } from "../../lib/slide";
import { render, stubSpanAnimations, type Rendered } from "../../test/dom";
import { coverPetals, CoverPattern } from "./CoverPattern";
import type { PetalGlyphName } from "./petal-glyphs";

// jsdom 环境里的 URL 是 jsdom 自己的实现，node:fs 不认，按文件路径读
const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "CoverPattern.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function ruleOf(selector: string): string {
  const rule = new RegExp(`(?:^|\\n)${selector.replace(".", "\\.")} \\{([^}]*)\\}`).exec(CSS);
  if (rule === null) throw new Error(`没有 ${selector} 规则`);
  return rule[1];
}

let view: Rendered | undefined;

afterEach(() => {
  view?.unmount();
  view = undefined;
  document.documentElement.removeAttribute("data-sk-reduced");
});

function pattern(): HTMLElement {
  const el = view?.container.firstElementChild;
  if (!(el instanceof HTMLElement)) throw new Error("底纹没有渲染");
  return el;
}

/** jsdom 不做布局：给底纹一个尺寸。640 × 128 时缩放取 max(640 / 320, 128 / 120) = 2。 */
function size(el: HTMLElement, width: number, height: number): void {
  Object.defineProperty(el, "clientWidth", { configurable: true, value: width });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: height });
}

function laneOf(glyph: PetalGlyphName): HTMLElement {
  const lane = pattern().querySelector<HTMLElement>(`[data-lane="${glyph}"]`);
  if (lane === null) throw new Error(`底纹里没有花瓣 ${glyph} 的外层`);
  return lane;
}

const ui = (seed: string, hue = 345) => <CoverPattern hue={hue} seed={seed} />;

describe("CoverPattern 换种子", () => {
  it("挂载时不滑；种子一变，每片花瓣的外层沿 settle 弹簧从旧位置滑到新位置，位移按底纹缩放换算", () => {
    const waapi = stubSpanAnimations();
    view = render(ui("inst-1"));
    size(pattern(), 640, 128);
    expect(waapi.played).toHaveLength(0);

    view.rerender(ui("inst-2"));
    const from = coverPetals("inst-1");
    const to = coverPetals("inst-2");
    expect(waapi.played).toHaveLength(4);
    to.forEach((p, i) => {
      const lane = laneOf(p.glyph);
      const animation = waapi.running(lane, "translate");
      const dx = (from[i].x - p.x) * 2;
      const dy = (from[i].y - p.y) * 2;
      expect(Math.hypot(dx, dy)).toBeGreaterThan(0);
      const track = springTrack("settle", dx, 0, dy, 0);
      // 起点是旧位置（相对新位置的位移），终点回到 0：看上去是同一片花瓣滑过去
      expect(animation.frames[0]).toEqual({ translate: `${dx}px ${dy}px` });
      expect(animation.frames.at(-1)).toEqual({ translate: "0px 0px" });
      expect(animation.frames).toEqual(track.frames);
      expect(animation.options).toEqual({ duration: track.duration, easing: "linear" });
      // 花瓣自己按新坐标摆，换色调
      const petal = lane.querySelector<SVGElement>("svg[data-glyph]");
      expect(petal?.style.getPropertyValue("--px")).toBe(String(p.x));
      expect(petal?.style.getPropertyValue("--py")).toBe(String(p.y));
      expect(petal?.getAttribute("data-tone")).toBe(p.tone);
    });
  });

  it("途中再换种子：带着此刻的位移与速度转向，旧的那一段取消", () => {
    const waapi = stubSpanAnimations();
    view = render(ui("inst-1"));
    size(pattern(), 640, 128);
    view.rerender(ui("inst-2"));
    const [a, b, c] = [coverPetals("inst-1")[0], coverPetals("inst-2")[0], coverPetals("inst-3")[0]];
    const first = waapi.running(laneOf("P2"), "translate");
    // 第一段播了 100 ms
    first.currentTime = 100;

    view.rerender(ui("inst-3"));
    expect(first.cancelled).toBe(true);
    const second = waapi.running(laneOf("P2"), "translate");
    const x = springAt("settle", (a.x - b.x) * 2, 0, 0.1);
    const y = springAt("settle", (a.y - b.y) * 2, 0, 0.1);
    expect(Math.hypot(x.v, y.v)).toBeGreaterThan(0);
    expect(second.frames).toEqual(springTrack("settle", x.x + (b.x - c.x) * 2, x.v, y.x + (b.y - c.y) * 2, y.v).frames);
  });

  it("同一种子重渲染（只换色相）不滑", () => {
    const waapi = stubSpanAnimations();
    view = render(ui("inst-1"));
    size(pattern(), 640, 128);
    view.rerender(ui("inst-1", 120));
    expect(waapi.played).toHaveLength(0);
  });

  it("减少动画时换种子直接到位，还在滑的也一并落到新位置", () => {
    const waapi = stubSpanAnimations();
    view = render(ui("inst-1"));
    size(pattern(), 640, 128);
    view.rerender(ui("inst-2"));
    const flying = [...waapi.played];
    expect(flying).toHaveLength(4);

    document.documentElement.setAttribute("data-sk-reduced", "");
    view.rerender(ui("inst-3"));
    expect(waapi.played).toHaveLength(4);
    for (const animation of flying) expect(animation.cancelled).toBe(true);
    expect(laneOf("P2").querySelector<SVGElement>("svg[data-glyph]")?.style.getPropertyValue("--px")).toBe(String(coverPetals("inst-3")[0].x));
  });

  it("底纹还没排版（尺寸为 0）时没有可滑的距离，直接到位", () => {
    const waapi = stubSpanAnimations();
    view = render(ui("inst-1"));
    view.rerender(ui("inst-2"));
    expect(waapi.played).toHaveLength(0);
  });

  it("定位层与底纹同大；色调随滑动只过渡填充色，时长与曲线取令牌", () => {
    const lane = ruleOf(".lane");
    expect(lane).toMatch(/(?:^|\s)position: absolute;/);
    expect(lane).toMatch(/(?:^|\s)inset: 0;/);
    expect(ruleOf(".petal path")).toMatch(/(?:^|\s)transition: fill var\(--sk-dur-hover\) var\(--sk-ease\);/);
  });
});
