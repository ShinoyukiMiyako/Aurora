// @vitest-environment jsdom
// 头像状态层的换场：角标、环、排队轨道之间不在一帧里硬切。
import { afterEach, describe, expect, it } from "vitest";
import { render, type Rendered } from "../test/dom";
import { AvatarIndicatorLayer, type AvatarIndicator } from "./InstanceAvatar";

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
});
