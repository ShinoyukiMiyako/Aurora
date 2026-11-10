// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isMotionComponent, MotionConfig } from "framer-motion";
import { act, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { render, waitForFrames, type Rendered } from "../test/dom";
import { Appear } from "./Appear";
import { Banner } from "./Banner";
import { Bento } from "./Bento";
import { Card } from "./Card";
import { Page, PageArrivalProvider } from "./Page";
import { PageHeader } from "./PageHeader";
import { SectionTitle } from "./SectionTitle";

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

const entrances = () => [...(view?.container.querySelectorAll<HTMLElement>("[data-entrance]") ?? [])].map((el) => [el.tagName, el.dataset.entrance, el.textContent]);

function home(): ReactNode {
  return (
    <Page aria-labelledby="t">
      <PageHeader title="实例库" titleId="t" />
      <Bento>
        <Card span={8}>甲</Card>
        <Card span={4}>乙</Card>
      </Bento>
      <Card>
        丙
        <Banner tone="info" title="嵌套" />
      </Card>
    </Page>
  );
}

function homeWith(late: boolean): ReactNode {
  return (
    <Page>
      <PageHeader title="主页" />
      <Card className="block">甲</Card>
      {late && <Card className="block">晚到</Card>}
    </Page>
  );
}

interface FiberNode {
  type: unknown;
  return: FiberNode | null;
}

/**
 * 这个 DOM 元素是不是 motion 组件画出来的。motion 元素与普通元素在 DOM 上没有区别，只能沿 React fiber
 * 往上找到第一个组件（跳过 Context Provider 之类的对象节点）再判断。
 */
function renderedByMotion(el: Element): boolean {
  const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
  if (key === undefined) throw new Error("元素上没有 React fiber");
  let fiber = (el as unknown as Record<string, FiberNode>)[key].return;
  while (fiber !== null) {
    const { type } = fiber;
    if (typeof type === "function" || (typeof type === "object" && type !== null && "render" in type)) {
      return isMotionComponent(type as Parameters<typeof isMotionComponent>[0]);
    }
    fiber = fiber.return;
  }
  throw new Error("元素上方没有组件");
}

/** 等页面画完第一帧：入场窗口在这之后关上。 */
const nextFrame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

const block = (text: string): HTMLElement => {
  const el = [...(view?.container.querySelectorAll<HTMLElement>(".block") ?? [])].find((b) => b.textContent === text);
  if (el === undefined) throw new Error(`没有区块 ${text}`);
  return el;
};

describe("页面入场", () => {
  it("一级区块按序编号；Bento 不动自己，把序号转交给卡片，并按卡片数占号；嵌套的区块不再参与", () => {
    view = render(<MotionConfig reducedMotion="never">{home()}</MotionConfig>);
    expect(entrances()).toEqual([
      ["HEADER", "0", "实例库"],
      ["DIV", "1", "甲"],
      ["DIV", "2", "乙"],
      ["DIV", "3", "丙嵌套"],
    ]);
  });

  it("两个 Bento 夹着一个区块：序号自上而下不重号，条件渲染掉的卡片不占号", () => {
    const wide = false;
    view = render(
      <MotionConfig reducedMotion="never">
        <Page>
          <Bento>
            <Card span={6}>问候</Card>
            <Card span={6}>继续</Card>
            {wide && <Card span={4}>洞察</Card>}
          </Bento>
          <Card>最近</Card>
          <Bento>
            <Card span={6}>日历</Card>
            <Card span={6}>资讯</Card>
          </Bento>
        </Page>
      </MotionConfig>,
    );
    expect(entrances().map(([, index, text]) => [index, text])).toEqual([
      ["0", "问候"],
      ["1", "继续"],
      ["2", "最近"],
      ["3", "日历"],
      ["4", "资讯"],
    ]);
  });

  it("中途开关减少动画：已经在的区块不换元素、不重建子树", () => {
    const tree = (reduced: "never" | "always") => (
      <MotionConfig reducedMotion={reduced}>
        <Page>
          <Card className="block">
            <input data-field="" />
          </Card>
        </Page>
      </MotionConfig>
    );
    view = render(tree("never"));
    const card = block("");
    const field = view.container.querySelector("[data-field]");
    view.rerender(tree("always"));
    expect(block("")).toBe(card);
    expect(view.container.querySelector("[data-field]")).toBe(field);
    view.rerender(tree("never"));
    expect(block("")).toBe(card);
  });

  it("只有站在页面一级位置上的区块是 motion 元素；嵌套在区块里的、页面外的是普通元素，减少动画不影响类型", () => {
    const tree = (
      <>
        <Page>
          <Card className="block">
            外层
            <Card className="block">嵌套</Card>
          </Card>
          <Bento>
            <Card span={6} className="block">
              网格
            </Card>
          </Bento>
        </Page>
        <Card className="block">页外</Card>
      </>
    );
    for (const reduced of ["never", "always"] as const) {
      view = render(<MotionConfig reducedMotion={reduced}>{tree}</MotionConfig>);
      expect(renderedByMotion(block("外层嵌套"))).toBe(true);
      expect(renderedByMotion(block("网格"))).toBe(true);
      expect(renderedByMotion(block("嵌套"))).toBe(false);
      expect(renderedByMotion(block("页外"))).toBe(false);
      view.unmount();
      view = undefined;
    }
  });

  it("第一帧之内补挂的区块照常错开入场；第一帧之后挂上的只原地淡入，不位移、不等序号", async () => {
    const tree = (extra: string[]) => (
      <MotionConfig reducedMotion="never">
        <Page>
          <Card className="block">甲</Card>
          {extra.map((text) => (
            <Card key={text} className="block">
              {text}
            </Card>
          ))}
        </Page>
      </MotionConfig>
    );
    view = render(tree([]));
    view.rerender(tree(["同帧"]));
    expect(block("同帧").dataset.entrance).toBe("1");
    expect(block("同帧").style.transform).toBe("translateY(6px)");
    await nextFrame();
    view.rerender(tree(["同帧", "晚到"]));
    const late = block("晚到");
    expect(late.dataset.entrance).toBeUndefined();
    expect(late.style.opacity).toBe("0");
    expect(late.style.transform).toBe("");
    await waitForFrames(() => expect(late.style.opacity).toBe("1"));
  });

  it("减少动画时晚到的区块同样只淡入", async () => {
    const tree = (late: boolean) => (
      <MotionConfig reducedMotion="always">
        <Page>
          <Card className="block">甲</Card>
          {late && <Card className="block">晚到</Card>}
        </Page>
      </MotionConfig>
    );
    view = render(tree(false));
    expect(block("甲").style.opacity).toBe("");
    await nextFrame();
    view.rerender(tree(true));
    expect(block("晚到").style.opacity).toBe("0");
    expect(block("晚到").style.transform).toBe("");
  });

  it("后退前进回到的页面：只有根淡入，区块不位移不错开；晚到的区块照样淡入", async () => {
    const tree = (late: boolean) => (
      <MotionConfig reducedMotion="never">
        <PageArrivalProvider value="return">{homeWith(late)}</PageArrivalProvider>
      </MotionConfig>
    );
    view = render(tree(false));
    expect(entrances()).toEqual([]);
    const root = view.container.firstElementChild as HTMLElement;
    expect(root.style.opacity).toBe("0");
    expect(block("甲").style.transform).toBe("");
    await nextFrame();
    view.rerender(tree(true));
    expect(block("晚到").style.opacity).toBe("0");
  });

  it("应用启动的那一屏：根与区块挂上就是成品", () => {
    view = render(
      <MotionConfig reducedMotion="never">
        <PageArrivalProvider value="still">{homeWith(false)}</PageArrivalProvider>
      </MotionConfig>,
    );
    expect(entrances()).toEqual([]);
    expect((view.container.firstElementChild as HTMLElement).style.opacity).toBe("1");
    expect(block("甲").style.opacity).toBe("");
  });

  it("页面只在挂载那一刻读到达方式：之后变了也不重播", () => {
    const tree = (arrival: "enter" | "return") => (
      <MotionConfig reducedMotion="never">
        <PageArrivalProvider value={arrival}>{homeWith(false)}</PageArrivalProvider>
      </MotionConfig>
    );
    view = render(tree("return"));
    const card = block("甲");
    view.rerender(tree("enter"));
    expect(block("甲")).toBe(card);
    expect(entrances()).toEqual([]);
  });

  it("Appear 放在一级位置：挂载时就在的子项跟着页面入场，之后出现的只由 Appear 淡入，不叠页面淡入", async () => {
    const tree = (late: boolean) => (
      <MotionConfig reducedMotion="never">
        <Page>
          <Appear>
            <Banner key="first" tone="info" title="首屏" />
            {late && <Banner key="late" tone="warn" title="晚到" />}
          </Appear>
        </Page>
      </MotionConfig>
    );
    view = render(tree(false));
    expect(entrances()).toEqual([["DIV", "0", "首屏"]]);
    await nextFrame();
    view.rerender(tree(true));
    const late = [...view.container.querySelectorAll<HTMLElement>("[data-tone]")].find((el) => el.textContent === "晚到");
    if (late === undefined) throw new Error("晚到的横幅没有出现");
    expect(late.style.opacity).toBe("");
    expect(late.parentElement?.style.opacity).toBe("0");
  });

  it("减少动画：没有区块位移与错开", () => {
    view = render(<MotionConfig reducedMotion="always">{home()}</MotionConfig>);
    expect(entrances()).toEqual([]);
  });

  it("不在页面里的区块不参与入场", () => {
    view = render(
      <MotionConfig reducedMotion="never">
        <Bento>
          <Card span={6}>甲</Card>
        </Bento>
        <PageHeader title="独立" />
      </MotionConfig>,
    );
    expect(entrances()).toEqual([]);
  });
});

describe("Page", () => {
  it("宽度与锁高标记，页头标题命名页面", () => {
    view = render(
      <Page width="narrow" fill aria-labelledby="title">
        <PageHeader title="设置" subtitle="常规 · 改动立即生效" titleId="title" actions={<span>动作</span>} />
      </Page>,
    );
    const page = view.container.firstElementChild as HTMLElement;
    expect(page.dataset.width).toBe("narrow");
    expect(page.dataset.fill).toBe("true");
    expect(page.getAttribute("aria-labelledby")).toBe("title");
    expect(page.querySelector("h1")?.id).toBe("title");
    expect(page.querySelector("h1")?.textContent).toBe("设置");
    expect(page.querySelector("p")?.textContent).toBe("常规 · 改动立即生效");
  });

  it("页头副标题：不传就没有这一行；传 null 时占着一行高的空位，副标题到达时同一行填上文字", () => {
    view = render(<PageHeader title="账户" subtitle={null} />);
    const slot = view.container.querySelector("p");
    if (slot === null) throw new Error("副标题为 null 时没有占位行");
    expect(slot.textContent).toBe("");
    view.rerender(<PageHeader title="账户" subtitle="2 个账户" />);
    expect(view.container.querySelector("p")).toBe(slot);
    expect(slot.textContent).toBe("2 个账户");
    view.rerender(<PageHeader title="账户" />);
    expect(view.container.querySelector("p")).toBeNull();

    const css = readFileSync(resolve(__dirname, "PageHeader.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = /(?:^|\n)\.subtitle \{([^}]*)\}/.exec(css);
    if (rule === null) throw new Error("没有 .subtitle 规则");
    // 空着时的高度就是一行文字的高度
    expect(rule[1]).toContain("min-height: var(--sk-lh-body);");
    expect(rule[1]).toContain("line-height: var(--sk-lh-body);");
  });

  it("默认满宽、不锁高", () => {
    view = render(<Page>内容</Page>);
    const page = view.container.firstElementChild as HTMLElement;
    expect(page.dataset.width).toBe("full");
    expect(page.hasAttribute("data-fill")).toBe(false);
  });
});

describe("Bento", () => {
  it("固定行高写成私有变量", () => {
    view = render(
      <Bento rowHeight={120}>
        <Card span={4} rowSpan={2} />
      </Bento>,
    );
    const bento = view.container.firstElementChild as HTMLElement;
    expect(bento.dataset.fixedRows).toBe("");
    expect(bento.style.getPropertyValue("--bento-row")).toBe("120px");
  });

  it("行高必须为正", () => {
    expect(() => render(<Bento rowHeight={0}>x</Bento>)).toThrow(/正数/);
  });
});

describe("SectionTitle", () => {
  it("标题、提示与右侧插槽，层级可选", () => {
    view = render(<SectionTitle hint="点卡片看详情" right={<button type="button">全部实例</button>} level={3} id="recent">最近游玩</SectionTitle>);
    const root = view.container.firstElementChild as HTMLElement;
    expect(root.querySelector("h3")?.id).toBe("recent");
    expect(root.textContent).toBe("最近游玩点卡片看详情全部实例");
  });
});
