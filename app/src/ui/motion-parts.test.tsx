// @vitest-environment jsdom
import { motion, MotionConfig } from "framer-motion";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, waitForFrames, type Rendered } from "../test/dom";
import { Appear } from "./Appear";
import { LabelSlot } from "./LabelSlot";
import { Loadable } from "./Loadable";
import type { LoadingView } from "../lib/loading-gate";

let view: Rendered | undefined;

afterEach(() => {
  view?.unmount();
  view = undefined;
});

const one = (selector: string): HTMLElement => {
  const el = view?.container.querySelector<HTMLElement>(selector);
  if (el === null || el === undefined) throw new Error(`没有 ${selector}`);
  return el;
};
const has = (selector: string) => view?.container.querySelector(selector) !== null;

describe("Loadable", () => {
  const content = vi.fn(() => <p data-content="">内容</p>);
  const tree = (state: LoadingView) => (
    <Loadable view={state} skeleton={<span data-skeleton="" />}>
      {content}
    </Loadable>
  );

  afterEach(() => content.mockClear());

  it("等待期：骨架占位但标成不可见，容器在忙，内容不求值", () => {
    view = render(tree("pending"));
    expect(one("[data-skeleton]").parentElement?.hasAttribute("data-pending")).toBe(true);
    expect(one("[aria-busy]").getAttribute("aria-busy")).toBe("true");
    expect(has("[data-content]")).toBe(false);
    expect(content).not.toHaveBeenCalled();
  });

  it("到了出现的时刻：同一个骨架摘掉不可见标记，不重挂", () => {
    view = render(tree("pending"));
    const skeleton = one("[data-skeleton]");
    view.rerender(tree("skeleton"));
    expect(one("[data-skeleton]")).toBe(skeleton);
    expect(skeleton.parentElement?.hasAttribute("data-pending")).toBe(false);
    expect(content).not.toHaveBeenCalled();
  });

  it("一挂上就是内容：不单独淡入，容器不在忙", () => {
    view = render(tree("content"));
    expect(one("[data-content]").parentElement?.style.opacity).toBe("1");
    expect(has("[aria-busy]")).toBe(false);
    expect(has("[data-skeleton]")).toBe(false);
  });

  it("等过之后内容到达：内容从透明淡入，骨架退场后移除", async () => {
    view = render(tree("skeleton"));
    view.rerender(tree("content"));
    expect(one("[data-content]").parentElement?.style.opacity).toBe("0");
    expect(has("[aria-busy]")).toBe(false);
    await waitForFrames(() => {
      expect(has("[data-skeleton]")).toBe(false);
      expect(one("[data-content]").parentElement?.style.opacity).toBe("1");
    });
  });

  it("contentClassName 落在包住内容的那一层上", () => {
    view = render(
      <Loadable view="content" skeleton={<span />} contentClassName="fill">
        {content}
      </Loadable>,
    );
    expect(one("[data-content]").parentElement?.classList.contains("fill")).toBe(true);
  });

  it("重新加载再回来：内容照样淡入", () => {
    view = render(tree("content"));
    view.rerender(tree("pending"));
    expect(has("[data-content]")).toBe(false);
    view.rerender(tree("content"));
    expect(one("[data-content]").parentElement?.style.opacity).toBe("0");
  });
});

describe("Appear", () => {
  const tree = (show: boolean, initial?: boolean) => (
    <Appear initial={initial} itemClassName="item">
      {show && <p data-note="">提示</p>}
    </Appear>
  );

  it("挂载时就在的子项不播入场", () => {
    view = render(tree(true));
    const wrap = one("[data-note]").parentElement;
    expect(wrap?.className).toBe("item");
    expect(wrap?.style.opacity).toBe("1");
  });

  it("initial 为真时，挂载时就在的子项也从入场起点开始", () => {
    view = render(tree(true, true));
    expect(one("[data-note]").parentElement?.style.opacity).toBe("0");
  });

  it("之后才出现的子项：从透明、略小处入场", () => {
    view = render(tree(false));
    expect(has("[data-note]")).toBe(false);
    view.rerender(tree(true));
    const wrap = one("[data-note]").parentElement;
    expect(wrap?.style.opacity).toBe("0");
    expect(wrap?.style.transform).toBe("scale(0.98)");
  });

  it("条件变假：播完退场再移除；退场期间那一层是 inert，在场时不是", async () => {
    view = render(tree(true));
    expect(one("[data-note]").parentElement?.hasAttribute("inert")).toBe(false);
    view.rerender(tree(false));
    // 退场中还在，但已经点不到、聚焦不到，按 :not([inert]) 也筛得掉
    expect(one("[data-note]").parentElement?.hasAttribute("inert")).toBe(true);
    expect(has(".item:not([inert])")).toBe(false);
    await waitForFrames(() => expect(has("[data-note]")).toBe(false));
  });

  it("退场途中条件又变真：同一层接着用，摘掉 inert", () => {
    view = render(tree(true));
    const wrap = one("[data-note]").parentElement;
    view.rerender(tree(false));
    view.rerender(tree(true));
    expect(one("[data-note]").parentElement).toBe(wrap);
    expect(wrap?.hasAttribute("inert")).toBe(false);
  });

  it("减少动画：进出只动透明度，不带缩放", () => {
    const reduced = (show: boolean) => <MotionConfig reducedMotion="always">{tree(show)}</MotionConfig>;
    view = render(reduced(false));
    view.rerender(reduced(true));
    const wrap = one("[data-note]").parentElement;
    expect(wrap?.style.opacity).toBe("0");
    expect(wrap?.style.transform).toBe("");
  });

  it("不封住子项内部的入场：挂载时就在的子项里，之后才挂上的元素照常从起点入场", () => {
    const inner = (late: boolean) => (
      <Appear>
        <div data-host="">{late && <motion.i data-late="" initial={{ opacity: 0 }} animate={{ opacity: 1 }} />}</div>
      </Appear>
    );
    view = render(inner(false));
    view.rerender(inner(true));
    expect(one("[data-late]").style.opacity).toBe("0");
  });
});

describe("LabelSlot", () => {
  it("全部候选都在同一格里，只有当前这条标成显示", () => {
    view = render(<LabelSlot current="全部更新 · 3" options={["检查更新", "全部更新 · 3", "全部更新 · 999"]} />);
    const options = [...(view.container.querySelectorAll("span > span") as NodeListOf<HTMLElement>)];
    expect(options.map((el) => el.textContent)).toEqual(["检查更新", "全部更新 · 3", "全部更新 · 999"]);
    expect(options.map((el) => el.hasAttribute("data-current"))).toEqual([false, true, false]);
  });

  it("重复的候选只留一条", () => {
    view = render(<LabelSlot current="检查" options={["检查", "检查", "检查中"]} />);
    expect(view.container.querySelectorAll("span > span")).toHaveLength(2);
  });

  it("对齐方式标在槽上：默认居中，正文里的说明可以靠左", () => {
    view = render(<LabelSlot current="检查" options={["检查", "检查中"]} />);
    expect(one("span").dataset.align).toBe("center");
    view.rerender(<LabelSlot current="检查" options={["检查", "检查中"]} align="start" />);
    expect(one("span").dataset.align).toBe("start");
    const css = readFileSync(resolve(__dirname, "LabelSlot.module.css"), "utf8");
    expect(/\.slot\[data-align="start"\]\s*\{\s*justify-items: start;/.test(css)).toBe(true);
  });

  it("当前文案不在候选里：直接抛错，不悄悄撑宽", () => {
    expect(() => render(<LabelSlot current="重试" options={["检查", "检查中"]} />)).toThrow("不在候选里");
  });
});
