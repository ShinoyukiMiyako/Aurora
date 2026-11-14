// @vitest-environment jsdom
// 头像状态层的换场：角标、环、排队轨道之间不在一帧里硬切。
import { MotionConfig } from "framer-motion";
import { afterEach, describe, expect, it } from "vitest";
import { render, waitForFrames, type Rendered } from "../test/dom";
import { AvatarIndicatorLayer, ringGeometry, type AvatarIndicator } from "./InstanceAvatar";

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

const layer = (indicator: AvatarIndicator) => <AvatarIndicatorLayer indicator={indicator} size={40} />;
const badges = () => [...(view?.container.querySelectorAll<HTMLElement>("[data-badge]") ?? [])];
const rings = () => [...(view?.container.querySelectorAll<SVGElement>("svg") ?? [])];

describe("头像状态层", () => {
  it("挂载时就在的角标直接显示，不从 0 弹出", () => {
    view = render(layer({ type: "badge", tone: "danger" }));
    const [badge] = badges();
    expect(badge.dataset.badge).toBe("danger");
    expect(badge.style.transform).not.toBe("scale(0)");
    expect(badge.style.opacity).not.toBe("0");
  });

  it("进入运行后出现的绿点从 0 弹出；运行转崩溃时绿点退场、红色角标另起一枚弹出", () => {
    view = render(layer({ type: "none" }));
    view.rerender(layer({ type: "badge", tone: "ok" }));
    const [ok] = badges();
    expect(ok.dataset.badge).toBe("ok");
    expect(ok.style.transform).toBe("scale(0)");
    expect(ok.style.opacity).toBe("0");

    view.rerender(layer({ type: "badge", tone: "danger" }));
    expect(badges().map((b) => b.dataset.badge)).toEqual(["ok", "danger"]);
    expect(badges()[1].style.transform).toBe("scale(0)");
  });

  it("减少动画时角标只淡入淡出：之后出现的不从 0 弹出，消失时不先跳小再淡", async () => {
    const reduced = (indicator: AvatarIndicator) => <MotionConfig reducedMotion="always">{layer(indicator)}</MotionConfig>;
    view = render(reduced({ type: "none" }));
    view.rerender(reduced({ type: "badge", tone: "danger" }));
    const [entering] = badges();
    expect(entering.style.opacity).toBe("0");
    expect(entering.style.transform).not.toContain("scale");
    view.unmount();

    view = render(reduced({ type: "badge", tone: "warn" }));
    const [leaving] = badges();
    view.rerender(reduced({ type: "none" }));
    await waitForFrames(() => expect(Number(leaving.style.opacity)).toBeLessThan(1));
    expect(leaving.style.transform).not.toContain("scale");
  });

  it("减少动画时排队轨道换成进度环：两者的出没都只动透明度，退场的轨道不带缩放与位移", async () => {
    const reduced = (indicator: AvatarIndicator) => <MotionConfig reducedMotion="always">{layer(indicator)}</MotionConfig>;
    view = render(reduced({ type: "queued" }));
    const leaving = view.container.querySelector<SVGElement>("svg[data-queued]");
    if (leaving === null) throw new Error("没有排队轨道");
    view.rerender(reduced({ type: "ring", tone: "info", progress: 0.3, track: "install-1" }));
    const entering = view.container.querySelector<SVGElement>('svg[data-tone="info"]');
    if (entering === null) throw new Error("没有进度环");
    expect(entering.style.opacity).toBe("0");
    expect(entering.style.transform).toBe("");
    await waitForFrames(() => expect(Number(leaving.style.opacity)).toBeLessThan(1));
    expect(leaving.style.transform).toBe("");
  });

  it("游戏退出角标消失、启动进入运行环消失时，都先演退场，不在那一帧移除", () => {
    view = render(layer({ type: "badge", tone: "warn" }));
    view.rerender(layer({ type: "none" }));
    expect(badges().map((b) => b.dataset.badge)).toEqual(["warn"]);

    view.rerender(layer({ type: "ring", tone: "accent", progress: 0.9, track: "launch-1" }));
    expect(rings()).toHaveLength(1);
    view.rerender(layer({ type: "badge", tone: "ok" }));
    expect(rings()).toHaveLength(1);
    expect(badges().map((b) => b.dataset.badge)).toContain("ok");
  });

  // 减少动画下平滑值直接跳到目标，补满与否在下一帧就看得出；同屏另一枚走失败的环作对照，说明那一帧已经渲染过
  it("启动进入运行：退场的进度环先补满再走，不带着缺口消失；启动失败时停在原处淡出", async () => {
    const pair = (ok: AvatarIndicator, failed: AvatarIndicator) => (
      <MotionConfig reducedMotion="always">
        <span data-avatar="ok">
          <AvatarIndicatorLayer indicator={ok} size={40} />
        </span>
        <span data-avatar="failed">
          <AvatarIndicatorLayer indicator={failed} size={40} />
        </span>
      </MotionConfig>
    );
    const fillOf = (name: string) => {
      const fill = view?.container.querySelectorAll(`[data-avatar="${name}"] path`)[1];
      if (fill === undefined) throw new Error(`头像 ${name} 的进度环没有填充`);
      return fill;
    };
    const offsetOf = (el: Element) => Number(el.getAttribute("stroke-dashoffset"));
    const { length } = ringGeometry(40);
    view = render(pair({ type: "ring", tone: "accent", progress: 0.4, track: "launch-1" }, { type: "ring", tone: "accent", progress: 0.4, track: "launch-2" }));
    const ok = fillOf("ok");
    const failed = fillOf("failed");
    expect(offsetOf(ok)).toBeCloseTo(length * 0.6, 3);

    view.rerender(pair({ type: "badge", tone: "ok" }, { type: "badge", tone: "danger" }));
    expect(fillOf("ok")).toBe(ok);
    await waitForFrames(() => expect(offsetOf(ok)).toBeCloseTo(0, 3));
    expect(offsetOf(failed)).toBeCloseTo(length * 0.6, 3);
  });

  // 最少显示长度要是加在逐帧平滑之后，弹簧离开 0 的第一帧就一下冒出 2% 的弧
  it("进度从 0 起步：填充弧从空一帧帧长到最少显示的 2%，不一下冒出那一截", async () => {
    const at = (progress: number) => (
      <MotionConfig reducedMotion="never">
        <AvatarIndicatorLayer indicator={{ type: "ring", tone: "accent", progress, track: "launch-1" }} size={40} />
      </MotionConfig>
    );
    const { length } = ringGeometry(40);
    view = render(at(0));
    expect(view.container.querySelectorAll("path")).toHaveLength(1);
    view.rerender(at(0.005));
    const fill = view.container.querySelectorAll("path")[1];
    if (fill === undefined) throw new Error("进度大于 0 时应画出填充弧");
    const offsetOf = () => Number(fill.getAttribute("stroke-dashoffset"));
    const offsets: number[] = [];
    const observer = new MutationObserver(() => offsets.push(offsetOf()));
    observer.observe(fill, { attributes: true, attributeFilter: ["stroke-dashoffset"] });
    await waitForFrames(() => expect(offsetOf()).toBeCloseTo(length * 0.98, 3));
    observer.disconnect();
    expect(offsets.filter((o) => o < length && o > length * 0.98 + 0.01).length).toBeGreaterThan(2);
  });
});
