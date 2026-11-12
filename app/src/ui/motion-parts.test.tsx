// @vitest-environment jsdom
import { motion, MotionConfig } from "framer-motion";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, waitForFrames, type Rendered } from "../test/dom";
import { Appear } from "./Appear";
import { Bento } from "./Bento";
import { Card } from "./Card";
import { LabelSlot } from "./LabelSlot";
import { Loadable } from "./Loadable";
import loadableStyles from "./Loadable.module.css";
import { Page } from "./Page";
import type { LoadingView } from "../lib/loading-gate";
import { REFLOW_SKIP_ATTR } from "../lib/reflow";

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
/** 等页面画完第一帧：入场窗口在这之后关上，再挂上的一级区块按晚到处理。 */
const nextFrame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

describe("Loadable", () => {
  const content = vi.fn(() => <p data-content="">内容</p>);
  const tree = (state: LoadingView) => (
    <Loadable view={state} skeleton={<span data-skeleton="" />}>
      {content}
    </Loadable>
  );

  afterEach(() => content.mockClear());

  it("等待期：骨架占位但不可见，容器在忙，内容不求值", () => {
    view = render(tree("pending"));
    expect(one("[data-skeleton]").parentElement?.hasAttribute("data-pending")).toBe(true);
    expect(one("[data-skeleton]").parentElement?.style.opacity).toBe("0");
    expect(one("[aria-busy]").getAttribute("aria-busy")).toBe("true");
    expect(has("[data-content]")).toBe(false);
    expect(content).not.toHaveBeenCalled();
  });

  it("到了出现的时刻：同一个骨架摘掉不可见标记，不重挂，从透明淡入到不透明", async () => {
    view = render(tree("pending"));
    const skeleton = one("[data-skeleton]");
    view.rerender(tree("skeleton"));
    expect(one("[data-skeleton]")).toBe(skeleton);
    expect(skeleton.parentElement?.hasAttribute("data-pending")).toBe(false);
    expect(content).not.toHaveBeenCalled();
    await waitForFrames(() => expect(skeleton.parentElement?.style.opacity).toBe("1"));
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

  it("等待期里内容就到了：骨架没显出来过，同一次提交里直接拿掉，不留在内容上退场", () => {
    view = render(tree("pending"));
    view.rerender(tree("content"));
    expect(has("[data-skeleton]")).toBe(false);
    expect(one("[data-content]").parentElement?.style.opacity).toBe("0");
  });

  it("骨架显出来过：内容到达时它留在原处退场，不同一次提交里拿掉", () => {
    view = render(tree("pending"));
    view.rerender(tree("skeleton"));
    view.rerender(tree("content"));
    expect(has("[data-skeleton]")).toBe(true);
  });

  it("骨架层整个不接收指针事件，不只是等待期：退场时它叠在内容上，淡出那一段不能截住点击", () => {
    const css = readFileSync(resolve(__dirname, "Loadable.module.css"), "utf8");
    const layer = /(?:^|\n)\.skeleton\s*\{([^}]*)\}/.exec(css);
    if (layer === null) throw new Error("Loadable.module.css 里没有 .skeleton 规则");
    expect(layer[1]).toMatch(/\bpointer-events:\s*none;/);
    view = render(tree("skeleton"));
    expect(one("[data-skeleton]").parentElement?.classList.contains(loadableStyles.skeleton)).toBe(true);
  });

  it("contentClassName 落在包住内容的那一层上", () => {
    view = render(
      <Loadable view="content" skeleton={<span />} contentClassName="fill">
        {content}
      </Loadable>,
    );
    expect(one("[data-content]").parentElement?.classList.contains("fill")).toBe(true);
  });

  const labelled = (state: LoadingView) => (
    <Loadable view={state} skeleton={<span data-skeleton="">正在读取</span>} busyLabel="正在读取">
      {content}
    </Loadable>
  );

  it("不传加载说明：只有根元素一个节点，没有播报区", () => {
    view = render(tree("skeleton"));
    expect(view.container.children).toHaveLength(1);
    expect(has('[role="status"]')).toBe(false);
  });

  it("加载说明：播报区先挂好、先空着，骨架显出来时写进说明，内容到达后清空，始终是同一个节点", () => {
    view = render(labelled("pending"));
    const status = one('[role="status"]');
    expect(status.textContent).toBe("");
    view.rerender(labelled("skeleton"));
    expect(one('[role="status"]')).toBe(status);
    expect(status.textContent).toBe("正在读取");
    view.rerender(labelled("content"));
    expect(one('[role="status"]')).toBe(status);
    expect(status.textContent).toBe("");
    view.rerender(labelled("pending"));
    expect(status.textContent).toBe("");
  });

  it("加载说明的播报区在带 aria-busy 的根外面、不在骨架的 aria-hidden 里，视觉隐藏且不参与让位", () => {
    view = render(labelled("skeleton"));
    const status = one('[role="status"]');
    expect(status.closest("[aria-busy]")).toBeNull();
    expect(status.closest('[aria-hidden="true"]')).toBeNull();
    expect(status.nextElementSibling?.getAttribute("aria-busy")).toBe("true");
    expect(status.hasAttribute(REFLOW_SKIP_ATTR)).toBe(true);
    expect(status.classList.contains(loadableStyles.status)).toBe(true);
    const css = readFileSync(resolve(__dirname, "Loadable.module.css"), "utf8");
    const rule = /(?:^|\n)\.status\s*\{([^}]*)\}/.exec(css);
    if (rule === null) throw new Error("Loadable.module.css 里没有 .status 规则");
    expect(rule[1]).toMatch(/\bposition:\s*absolute;/);
    expect(rule[1]).toMatch(/\bclip-path:\s*inset\(50%\);/);
  });

  it("加载说明中途撤掉：根元素与里面的内容层不重挂", () => {
    view = render(labelled("content"));
    const layer = one("[data-content]").parentElement;
    view.rerender(tree("content"));
    expect(has('[role="status"]')).toBe(false);
    expect(one("[data-content]").parentElement).toBe(layer);
  });

  it("第一次挂载就是骨架：直接不透明，跟着所在页面的入场走", () => {
    view = render(tree("skeleton"));
    expect(one("[data-skeleton]").parentElement?.style.opacity).toBe("1");
  });

  it("从内容退回等待期：内容留在原处淡出、标成 inert，骨架不可见地占位", () => {
    view = render(tree("content"));
    const shown = one("[data-content]");
    view.rerender(tree("pending"));
    expect(one("[data-content]")).toBe(shown);
    expect(shown.parentElement?.hasAttribute("inert")).toBe(true);
    const layer = one("[data-skeleton]").parentElement;
    expect(layer?.hasAttribute("data-pending")).toBe(true);
    expect(layer?.style.opacity).toBe("0");
    expect(one("[aria-busy]").getAttribute("aria-busy")).toBe("true");
  });

  it("从内容直接退回骨架：内容淡出、标成 inert，骨架从透明淡入，不一下子不透明地盖上", () => {
    view = render(tree("content"));
    view.rerender(tree("skeleton"));
    expect(one("[data-content]").parentElement?.hasAttribute("inert")).toBe(true);
    const layer = one("[data-skeleton]").parentElement;
    expect(layer?.hasAttribute("data-pending")).toBe(false);
    expect(layer?.style.opacity).toBe("0");
  });

  it("淡完之前内容又回来：同一层接着用，摘掉 inert，不从透明重来", () => {
    view = render(tree("content"));
    const layer = one("[data-content]").parentElement;
    view.rerender(tree("pending"));
    view.rerender(tree("content"));
    expect(one("[data-content]").parentElement).toBe(layer);
    expect(layer?.hasAttribute("inert")).toBe(false);
    expect(layer?.style.opacity).toBe("1");
    expect(has("[data-skeleton]")).toBe(false);
  });

  it("减少动画：交叉淡化照常（骨架从透明淡入到不透明，旧内容标成 inert），两层都不带位移或缩放", async () => {
    const reduced = (state: LoadingView) => <MotionConfig reducedMotion="always">{tree(state)}</MotionConfig>;
    view = render(reduced("content"));
    const contentLayer = one("[data-content]").parentElement;
    view.rerender(reduced("skeleton"));
    const skeletonLayer = one("[data-skeleton]").parentElement;
    if (contentLayer === null || skeletonLayer === null) throw new Error("骨架层或内容层没有挂上");
    expect(contentLayer.hasAttribute("inert")).toBe(true);
    expect(skeletonLayer.style.opacity).toBe("0");
    expect(contentLayer.style.transform).toBe("");
    expect(skeletonLayer.style.transform).toBe("");
    await waitForFrames(() => expect(skeletonLayer.style.opacity).toBe("1"));
    expect(skeletonLayer.style.transform).toBe("");
  });
});

describe("Loadable 在页面一级位置上", () => {
  const page = (state: LoadingView) => (
    <MotionConfig reducedMotion="never">
      <Page>
        <Loadable view={state} skeleton={<Card className="bone">骨架</Card>}>
          {() => <Card className="block">内容</Card>}
        </Loadable>
      </Page>
    </MotionConfig>
  );

  it("挂载时就是内容：里面的区块照常领页面分来的序号入场", () => {
    view = render(page("content"));
    expect(one(".block").dataset.entrance).toBe("0");
    expect(one(".block").style.transform).toBe("translateY(6px)");
  });

  it("页面入场完之后才等到内容：里面的区块是普通元素，不再自己淡入，只由内容层整层淡入", async () => {
    view = render(page("pending"));
    await nextFrame();
    view.rerender(page("content"));
    const block = one(".block");
    expect(block.dataset.entrance).toBeUndefined();
    expect(block.style.opacity).toBe("");
    expect(block.parentElement?.style.opacity).toBe("0");
  });

  it("页面首帧之内就等到了内容：同样只由内容层淡入，区块不按序号错开上移", () => {
    view = render(page("pending"));
    view.rerender(page("content"));
    const block = one(".block");
    expect(block.dataset.entrance).toBeUndefined();
    expect(block.style.transform).toBe("");
    expect(block.parentElement?.style.opacity).toBe("0");
  });

  it("内容出现过之后退回骨架：骨架里的区块不再自己淡入，只由骨架层整层淡入", async () => {
    view = render(page("content"));
    await nextFrame();
    view.rerender(page("skeleton"));
    const bone = one(".bone");
    expect(bone.dataset.entrance).toBeUndefined();
    expect(bone.style.opacity).toBe("");
    expect(bone.parentElement?.style.opacity).toBe("0");
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

describe("Appear 在页面编号里占几个号", () => {
  const entranceOf = (text: string): string | undefined => {
    if (view === undefined) throw new Error("还没有渲染");
    const el = [...view.container.querySelectorAll<HTMLElement>(".block")].find((b) => b.textContent === text);
    if (el === undefined) throw new Error(`没有区块 ${text}`);
    return el.dataset.entrance;
  };

  it("Page 的直接子项：false、null、undefined、空数组都算空，不占号；有子项时占一个号", () => {
    const tree = (note: ReactNode) => (
      <MotionConfig reducedMotion="never">
        <Page>
          <Card className="block">上面</Card>
          <Appear>{note}</Appear>
          <Card className="block">下面</Card>
        </Page>
      </MotionConfig>
    );
    for (const empty of [false, null, undefined, []]) {
      view = render(tree(empty));
      expect(entranceOf("下面")).toBe("1");
      view.unmount();
      view = undefined;
    }
    view = render(
      tree([
        <Card key="a" className="block">
          甲
        </Card>,
        <Card key="b" className="block">
          乙
        </Card>,
      ]),
    );
    expect([entranceOf("上面"), entranceOf("甲"), entranceOf("乙"), entranceOf("下面")]).toEqual(["0", "1", "1", "2"]);
  });

  it("Bento 的直接子项：空的不占号，后面的卡片不晚一拍", () => {
    const tree = (show: boolean) => (
      <MotionConfig reducedMotion="never">
        <Page>
          <Bento>
            <Appear>{show && <Card className="block">提示</Card>}</Appear>
            <Card span={6} className="block">
              卡片
            </Card>
          </Bento>
        </Page>
      </MotionConfig>
    );
    view = render(tree(false));
    expect(entranceOf("卡片")).toBe("0");
    view.unmount();
    view = render(tree(true));
    expect([entranceOf("提示"), entranceOf("卡片")]).toEqual(["0", "1"]);
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
