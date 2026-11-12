// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, type Rendered } from "../../test/dom";
import { Fade } from "./BlockedFilesModal";

let view: Rendered | undefined;

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.restoreAllMocks();
});

/**
 * jsdom 不做布局，popLayout 量退场项时读到的宽高是空的，就不会把它抽出布局。给装着探针的那一层一个非零的宽高，
 * 退场项能不能被抽出来就只取决于 ref 有没有接到这一层。
 */
function sizeProbedBoxes() {
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
    const style = real(el, pseudo);
    if (!(el instanceof HTMLElement) || el.firstElementChild?.hasAttribute("data-probe") !== true) return style;
    return { width: "60px", height: "20px", direction: "ltr", getPropertyValue: (name: string) => style.getPropertyValue(name) } as unknown as CSSStyleDeclaration;
  });
}

const box = (text: string) => {
  const probe = view?.container.querySelector(`[data-probe="${text}"]`);
  if (probe === null || probe === undefined) throw new Error(`没有 ${text}`);
  const el = probe.parentElement;
  if (el === null) throw new Error(`${text} 没有外层`);
  return el;
};

describe("清单的状态淡入淡出", () => {
  it.each([
    ["行内的标签", false],
    ["说明块", true],
  ])("%s换内容：旧的一层被抽出布局（ref 接到了这一层）、不可交互，标上 data-exiting；新的一层照常在流里", (_name, block) => {
    sizeProbedBoxes();
    const tree = (id: string) => (
      <Fade id={id} block={block}>
        <b data-probe={id}>{id}</b>
      </Fade>
    );
    view = render(tree("missing"));
    expect(box("missing").hasAttribute("data-exiting")).toBe(false);

    view.rerender(tree("found"));
    const old = box("missing");
    expect(old.dataset.motionPopId).toBeDefined();
    expect(old.hasAttribute("inert")).toBe(true);
    expect(old.hasAttribute("data-exiting")).toBe(true);
    expect(box("found").dataset.motionPopId).toBeUndefined();
    expect(box("found").hasAttribute("inert")).toBe(false);
  });

  it("挂载时就在的不播入场；之后出现的从透明淡入", () => {
    const tree = (id: string | null) => (
      <Fade id={id}>
        <b data-probe={id === null ? "" : id}>{id}</b>
      </Fade>
    );
    view = render(tree("open"));
    expect(box("open").style.opacity).toBe("1");
    view.rerender(tree("found"));
    expect(box("found").style.opacity).toBe("0");
  });
});
