// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { springAt, type SpringName } from "./motion";
import { playTrack, playTween, scaleTrack, Slide, springTrack } from "./slide";

const SAMPLE_S = 1 / 120;
const r2 = (value: number) => Math.round(value * 100) / 100;
const r4 = (value: number) => Math.round(value * 10000) / 10000;
const scalesOf = (frames: Keyframe[]) => frames.map((frame) => Number(frame.scale));

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

describe("scaleTrack：缩放轨迹", () => {
  it("从 from 出发、末帧恰好落在 1，帧在时间轴上等距，只写独立的 scale 属性", () => {
    const { frames, duration } = scaleTrack("pop", 0.6);
    expect(frames[0]).toEqual({ scale: "0.6" });
    expect(frames[frames.length - 1]).toEqual({ scale: "1" });
    // 只有 scale：与元素自己的 transform 叠加，不把它盖掉
    for (const frame of frames) expect(Object.keys(frame)).toEqual(["scale"]);
    expect(duration).toBeCloseTo(((frames.length - 1) * 1000) / 120, 6);
  });

  it("每一帧都是弹簧解析解在该时刻的缩放，保留四位小数", () => {
    const { frames } = scaleTrack("pop", 0.6);
    for (const i of [1, 5, 12, 24]) expect(Number(frames[i].scale)).toBe(r4(1 + springAt("pop", -0.4, 0, i * SAMPLE_S).x));
  });

  it("tap：临界阻尼，单调收拢到 1，不过冲", () => {
    const scales = scalesOf(scaleTrack("tap", 0.8).frames);
    expect(scales[0]).toBe(0.8);
    expect(Math.max(...scales)).toBe(1);
    for (let i = 1; i < scales.length; i++) expect(scales[i], `第 ${i} 帧`).toBeGreaterThanOrEqual(scales[i - 1]);
  });

  it("pop：过冲一点再落定，过冲看得出但有上限（20 px 的图标上不到 0.2 px）", () => {
    const scales = scalesOf(scaleTrack("pop", 0.6).frames);
    const peak = Math.max(...scales);
    expect(peak).toBeGreaterThan(1.004);
    expect(peak).toBeLessThan(1.008);
    // 过冲出现在中途，不是末尾那一跳
    expect(scales.indexOf(peak)).toBeLessThan(scales.length - 2);
  });

  it("停稳就收尾：tap 约 0.27 秒、pop 约 0.4 秒，都不长于对应的 CSS 弹簧时长（300 / 410 ms），末尾那一跳小于 0.002", () => {
    const tap = scaleTrack("tap", 0.8);
    const pop = scaleTrack("pop", 0.6);
    expect(tap.duration).toBeGreaterThan(230);
    expect(tap.duration).toBeLessThanOrEqual(300);
    expect(pop.duration).toBeGreaterThan(350);
    expect(pop.duration).toBeLessThanOrEqual(410);
    for (const { frames } of [tap, pop]) expect(Math.abs(Number(frames[frames.length - 2].scale) - 1)).toBeLessThan(0.002);
  });

  it("起点已经是 1：只有一段，首末都是 1", () => {
    const { frames, duration } = scaleTrack("pop", 1);
    expect(frames).toEqual([{ scale: "1" }, { scale: "1" }]);
    expect(duration).toBeCloseTo(1000 / 120, 6);
  });

  it("随机起点与弹簧：首帧是起点、末帧是 1，中途的帧取自那枚弹簧的解", () => {
    const names: SpringName[] = ["tap", "settle", "pop", "soft", "morph", "base"];
    for (let n = 0; n < 20; n++) {
      const name = names[Math.floor(Math.random() * names.length)];
      const from = r4(0.3 + Math.random() * 0.65);
      const { frames } = scaleTrack(name, from);
      const label = `${name} 从 ${from}`;
      expect(Number(frames[0].scale), label).toBe(from);
      expect(frames[frames.length - 1].scale, label).toBe("1");
      const i = 1 + Math.floor(Math.random() * (frames.length - 2));
      expect(Number(frames[i].scale), `${label} 第 ${i} 帧`).toBe(r4(1 + springAt(name, from - 1, 0, i * SAMPLE_S).x));
    }
  });
});

describe("playTrack", () => {
  it("整条轨迹原样交给 Web Animations：时长取轨迹的，帧之间线性相连", () => {
    const { el, calls } = animatable();
    const track = springTrack("morph", 24, 0, -8, 0);
    const animation = playTrack(el, track);
    expect(calls).toHaveLength(1);
    expect(calls[0].frames).toBe(track.frames);
    expect(calls[0].options).toEqual({ duration: track.duration, easing: "linear" });
    expect(animation).toBe(calls[0].animation);
  });
});

describe("playTween", () => {
  it("补间交给 Web Animations：帧原样，时长从秒换成毫秒，曲线写成 cubic-bezier 串", () => {
    const { el, calls } = animatable();
    const frames = [{ opacity: 0.35 }, { opacity: 1 }];
    const animation = playTween(el, frames, { duration: 0.2, ease: [0.16, 1, 0.3, 1] });
    expect(calls).toHaveLength(1);
    expect(calls[0].frames).toBe(frames);
    expect(calls[0].options).toEqual({ duration: 200, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
    expect(animation).toBe(calls[0].animation);
  });

  it("另一组时长与曲线：照搬，不套默认值", () => {
    const { el, calls } = animatable();
    playTween(el, [{ opacity: 1 }, { opacity: 0 }], { duration: 0.12, ease: [0.4, 0, 1, 1] });
    expect(calls[0].options).toEqual({ duration: 120, easing: "cubic-bezier(0.4, 0, 1, 1)" });
  });

  it("时长为 0：直接到位", () => {
    const { el, calls } = animatable();
    playTween(el, [{ opacity: 0 }, { opacity: 1 }], { duration: 0, ease: [0, 0, 1, 1] });
    expect(calls[0].options).toEqual({ duration: 0, easing: "cubic-bezier(0, 0, 1, 1)" });
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
