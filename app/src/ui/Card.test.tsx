// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Tier } from "../shell/tier";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { keydown, render, type Rendered } from "../test/dom";
import { Card, CardTitleButton, resolveResponsive, resolveRowSpan, resolveSpan, SPAN_MIN, type TierName } from "./Card";
import { CardHeader } from "./CardHeader";
import { IconButton } from "./IconButton";
import { Inset } from "./Inset";

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

function mount(ui: ReactNode) {
  view = render(
    <OverlayProvider>
      {ui}
      <OverlayRoot />
    </OverlayProvider>,
  );
  return view.container.firstElementChild as HTMLElement;
}

const keyup = (target: Element, key: string) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
  });

describe("按档取值", () => {
  it("档位名与外壳的尺寸档一致", () => {
    const tiers: TierName[] = ["compact", "regular", "wide"] satisfies Tier[];
    expect(tiers).toHaveLength(3);
  });

  it("缺的档向下继承", () => {
    expect(resolveResponsive(6)).toEqual({ compact: 6, regular: 6, wide: 6 });
    expect(resolveResponsive({ compact: 12 })).toEqual({ compact: 12, regular: 12, wide: 12 });
    expect(resolveResponsive({ compact: 8, wide: 6 })).toEqual({ compact: 8, regular: 8, wide: 6 });
    expect(resolveResponsive({ compact: 12, regular: 7 })).toEqual({ compact: 12, regular: 7, wide: 7 });
  });

  it("跨列下限：compact / regular 4 列，wide 3 列，上限 12", () => {
    expect(SPAN_MIN).toEqual({ compact: 4, regular: 4, wide: 3 });
    expect(resolveSpan({ compact: 4, wide: 3 })).toEqual({ compact: 4, regular: 4, wide: 3 });
    expect(() => resolveSpan(3)).toThrow(/compact 档跨 3 列/);
    expect(() => resolveSpan({ compact: 6, regular: 3 })).toThrow(/regular 档跨 3 列/);
    expect(() => resolveSpan({ compact: 6, wide: 2 })).toThrow(/wide 档跨 2 列/);
    expect(() => resolveSpan(13)).toThrow(/compact 档跨 13 列/);
    expect(() => resolveSpan(4.5)).toThrow(/整数/);
  });

  it("跨行必须是正整数", () => {
    expect(resolveRowSpan({ compact: 2, wide: 1 })).toEqual({ compact: 2, regular: 2, wide: 1 });
    expect(() => resolveRowSpan(0)).toThrow(/正整数/);
  });
});

describe("Card", () => {
  it("默认 md 内边距、不可点、无 role", () => {
    const card = mount(<Card>内容</Card>);
    expect(card.dataset.pad).toBe("md");
    expect(card.getAttribute("role")).toBeNull();
    expect(card.hasAttribute("tabindex")).toBe(false);
    expect(card.hasAttribute("data-span")).toBe(false);
  });

  it("跨列与跨行写成三档私有变量", () => {
    const card = mount(<Card span={{ compact: 8, wide: 6 }} rowSpan={2} />);
    expect(card.dataset.span).toBe("");
    expect(card.dataset.rows).toBe("");
    expect(card.style.getPropertyValue("--card-span-compact")).toBe("8");
    expect(card.style.getPropertyValue("--card-span-regular")).toBe("8");
    expect(card.style.getPropertyValue("--card-span-wide")).toBe("6");
    expect(card.style.getPropertyValue("--card-rows-wide")).toBe("2");
  });

  it("非法跨列在渲染时抛错", () => {
    expect(() => mount(<Card span={2} />)).toThrow(/compact 档跨 2 列/);
  });

  it("整卡可点：role=button、可聚焦，Enter 按下即触发", () => {
    const onClick = vi.fn();
    const card = mount(
      <Card onClick={onClick} ariaLabel="打开「生存 1.21」">
        生存 1.21
      </Card>,
    );
    expect(card.getAttribute("role")).toBe("button");
    expect(card.tabIndex).toBe(0);
    expect(card.getAttribute("aria-label")).toBe("打开「生存 1.21」");
    expect(card.dataset.interactive).toBe("true");
    const enter = keydown(card, "Enter");
    expect(enter.defaultPrevented).toBe(true);
    expect(onClick).toHaveBeenCalledTimes(1);
    act(() => card.click());
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("Space 按下只阻止滚动，抬起才触发；没有按下的抬起不触发", () => {
    const onClick = vi.fn();
    const card = mount(<Card onClick={onClick} ariaLabel="打开" />);
    keyup(card, " ");
    expect(onClick).not.toHaveBeenCalled();
    const down = keydown(card, " ");
    expect(down.defaultPrevented).toBe(true);
    expect(onClick).not.toHaveBeenCalled();
    keyup(card, " ");
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("可点卡片没有名称时抛错", () => {
    expect(() => mount(<Card onClick={() => undefined} />)).toThrow(/ariaLabel/);
    expect(() => mount(<Card onClick={() => undefined} ariaLabel="  " />)).toThrow(/ariaLabel/);
  });

  it("卡内有控件：标题按钮承担点击，卡片不加 role，内部控件独立触发", () => {
    const open = vi.fn();
    const more = vi.fn();
    const card = mount(
      <Card selected>
        <CardHeader title={<CardTitleButton onClick={open}>生存 1.21</CardTitleButton>} actions={<IconButton icon="more" label="更多操作" size="sm" onClick={more} />} />
      </Card>,
    );
    expect(card.getAttribute("role")).toBeNull();
    expect(card.dataset.selected).toBe("true");
    const buttons = card.querySelectorAll("button");
    expect(buttons).toHaveLength(2);
    act(() => buttons[1].click());
    expect(more).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    act(() => buttons[0].click());
    expect(open).toHaveBeenCalledTimes(1);
    expect(buttons[0].getAttribute("type")).toBe("button");
  });
});

describe("CardHeader", () => {
  it("图标名放进底座（18px），默认 h3", () => {
    const header = mount(<CardHeader icon="terminal" title="启动日志" subtitle="实时 · 游戏中" />);
    expect(header.querySelector("h3")?.textContent).toBe("启动日志");
    expect(header.querySelector("svg")?.getAttribute("width")).toBe("18");
    expect(header.textContent).toBe("启动日志实时 · 游戏中");
  });

  it("可传任意节点作图标，标题层级可选 h2", () => {
    const header = mount(<CardHeader icon={<span data-testid="avatar" />} title="生存" level={2} />);
    expect(header.querySelector("h2")?.textContent).toBe("生存");
    expect(header.querySelector('[data-testid="avatar"]')).not.toBeNull();
    expect(header.querySelector("svg")).toBeNull();
  });
});

describe("Inset", () => {
  it("按 as 渲染元素", () => {
    const inset = mount(<Inset as="aside">当日详情</Inset>);
    expect(inset.tagName).toBe("ASIDE");
    expect(inset.textContent).toBe("当日详情");
  });
});
