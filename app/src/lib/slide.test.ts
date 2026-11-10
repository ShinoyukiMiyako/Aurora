// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { springAt } from "./motion";
import { Slide, springTrack } from "./slide";

const SAMPLE_S = 1 / 120;
const r2 = (value: number) => Math.round(value * 100) / 100;

interface Call {
  frames: Keyframe[];
  options: KeyframeAnimationOptions;
  animation: { currentTime: number | null; cancel: ReturnType<typeof vi.fn>; onfinish: (() => void) | null };
}

/** 带假 animate 的元素：jsdom 没有 Web Animations。 */
function animatable(): { el: HTMLElement; calls: Call[] } {
  const el = document.createElement("div");
  const calls: Call[] = [];
  Object.defineProperty(el, "animate", {
    value(frames: Keyframe[], options: KeyframeAnimationOptions) {
      const animation = { currentTime: 0, cancel: vi.fn(), onfinish: null };
      calls.push({ frames, options, animation });
      return animation;
    },
  });
  return { el, calls };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("springTrack：轨迹", () => {
  it("从位移出发、落在目标上，帧在时间轴上等距", () => {
    const { frames, duration } = springTrack("settle", 0, 0, -120, 0);
    expect(frames[0].translate).toBe("0px -120px");
    expect(frames[frames.length - 1].translate).toBe("0px 0px");
    expect(duration).toBeCloseTo(((frames.length - 1) * 1000) / 120, 6);
    // settle 弹簧约 0.2 秒到达，尾巴收在 0.5 秒以内
    expect(duration).toBeGreaterThan(150);
    expect(duration).toBeLessThan(500);
  });

  it("每一帧都是弹簧解析解在该时刻的位移", () => {
    const { frames } = springTrack("settle", 64, 0, -120, 0);
    for (const i of [1, 5, 12]) {
      expect(frames[i].translate).toBe(`${r2(springAt("settle", 64, 0, i * SAMPLE_S).x)}px ${r2(springAt("settle", -120, 0, i * SAMPLE_S).x)}px`);
    }
  });

  it("目标不在原点：各帧整体平移到目标处", () => {
    const { frames } = springTrack("settle", 0, 0, -150, 0, 0, 234);
    expect(frames[0].translate).toBe("0px 84px");
    expect(frames[frames.length - 1].translate).toBe("0px 234px");
  });

  it("带初速度：第二帧顺着速度方向走，不是从零速起步", () => {
    const { frames } = springTrack("settle", 0, 0, -50, -600);
    const second = Number(String(frames[1].translate).split(" ")[1].replace("px", ""));
    expect(second).toBeLessThan(-50);
    expect(second).toBeCloseTo(springAt("settle", -50, -600, SAMPLE_S).x, 1);
  });

  it("换一枚弹簧：帧取自那枚弹簧的解", () => {
    const { frames } = springTrack("pop", 0, 0, -100, 0);
    expect(frames[6].translate).toBe(`0px ${r2(springAt("pop", -100, 0, 6 * SAMPLE_S).x)}px`);
  });
});

describe("Slide", () => {
  it("jump：直接写到位，不起动画", () => {
    const { el, calls } = animatable();
    const slide = new Slide(el, "settle");
    slide.jump(0, 84);
    expect(el.style.translate).toBe("0px 84px");
    expect(calls).toHaveLength(0);
    expect(slide.at()).toEqual({ x: 0, y: 84 });
  });

  it("to：静止位置立刻写成目标，轨迹从原位置滑到目标", () => {
    const { el, calls } = animatable();
    const slide = new Slide(el, "settle");
    slide.jump(0, 84);
    slide.to(0, 234);
    expect(el.style.translate).toBe("0px 234px");
    expect(calls).toHaveLength(1);
    const { frames, options } = calls[0];
    expect(frames[0].translate).toBe("0px 84px");
    expect(frames[frames.length - 1].translate).toBe("0px 234px");
    expect(options.easing).toBe("linear");
    expect(options.duration).toBeCloseTo(((frames.length - 1) * 1000) / 120, 6);
  });

  it("目标就是当前位置且静止：不起动画", () => {
    const { el, calls } = animatable();
    const slide = new Slide(el, "settle");
    slide.jump(0, 84);
    slide.to(0, 84);
    expect(calls).toHaveLength(0);
  });

  it("途中转向：取消旧动画，新轨迹从此刻的位置出发并带着速度", () => {
    const { el, calls } = animatable();
    const slide = new Slide(el, "settle");
    slide.jump(0, 84);
    slide.to(0, 234);
    calls[0].animation.currentTime = 60;
    const mid = springAt("settle", -150, 0, 0.06);
    expect(slide.at().y).toBeCloseTo(234 + mid.x, 6);
    // 滑到一半改去 y = 134
    slide.to(0, 134);
    expect(calls[0].animation.cancel).toHaveBeenCalledTimes(1);
    const { frames } = calls[1];
    expect(frames[0].translate).toBe(`0px ${r2(234 + mid.x)}px`);
    const dy = 234 + mid.x - 134;
    expect(frames[1].translate).toBe(`0px ${r2(134 + springAt("settle", dy, mid.v, SAMPLE_S).x)}px`);
    expect(frames[frames.length - 1].translate).toBe("0px 134px");
  });

  it("途中回到原目标处但还有速度：照样接着滑，不当成已经停稳", () => {
    const { el, calls } = animatable();
    const slide = new Slide(el, "settle");
    slide.to(0, 300);
    calls[0].animation.currentTime = 40;
    const here = slide.at().y;
    slide.to(0, here);
    expect(calls).toHaveLength(2);
    expect(calls[1].frames[0].translate).toBe(`0px ${r2(here)}px`);
  });

  it("播完之后再滑：从静止出发", () => {
    const { el, calls } = animatable();
    const slide = new Slide(el, "settle");
    slide.to(0, 234);
    calls[0].animation.currentTime = 400;
    calls[0].animation.onfinish?.();
    slide.to(0, 84);
    expect(calls[0].animation.cancel).not.toHaveBeenCalled();
    expect(calls[1].frames[0].translate).toBe("0px 234px");
  });

  it("途中 jump：取消动画并落在指定位置", () => {
    const { el, calls } = animatable();
    const slide = new Slide(el, "settle");
    slide.to(0, 234);
    slide.jump(0, 50);
    expect(calls[0].animation.cancel).toHaveBeenCalledTimes(1);
    expect(slide.at()).toEqual({ x: 0, y: 50 });
    expect(el.style.translate).toBe("0px 50px");
  });

  it("没有 Web Animations 的环境：to 直接到位", () => {
    const el = document.createElement("div");
    const slide = new Slide(el, "settle");
    slide.to(0, 234);
    expect(el.style.translate).toBe("0px 234px");
    expect(slide.at()).toEqual({ x: 0, y: 234 });
  });
});
