// @vitest-environment jsdom
import { MotionConfig } from "framer-motion";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { render, type Rendered } from "../test/dom";
import { Banner } from "./Banner";
import { Bento } from "./Bento";
import { Card } from "./Card";
import { Page } from "./Page";
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

describe("页面入场", () => {
  it("一级区块按序编号；Bento 不动自己，把序号转交给卡片；嵌套的区块不再参与", () => {
    view = render(<MotionConfig reducedMotion="never">{home()}</MotionConfig>);
    expect(entrances()).toEqual([
      ["HEADER", "0", "实例库"],
      ["DIV", "1", "甲"],
      ["DIV", "2", "乙"],
      ["DIV", "2", "丙嵌套"],
    ]);
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
