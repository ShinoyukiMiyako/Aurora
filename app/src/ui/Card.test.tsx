// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
    // 卡内点缀（封面底纹、身份方块）靠这个属性认出悬停宿主。
    expect(card.hasAttribute("data-sk-hover-host")).toBe(true);
    const buttons = card.querySelectorAll("button");
    expect(buttons).toHaveLength(2);
    act(() => buttons[1].click());
    expect(more).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    act(() => buttons[0].click());
    expect(open).toHaveBeenCalledTimes(1);
    expect(buttons[0].getAttribute("type")).toBe("button");
  });

  it("只有带标题按钮的卡片是悬停宿主；标题按钮卸载后不再是；脱离卡片使用直接报错", () => {
    function Host({ titled }: { titled: boolean }) {
      return <Card>{titled ? <CardTitleButton onClick={() => undefined}>生存 1.21</CardTitleButton> : <p>静态</p>}</Card>;
    }
    const card = mount(<Host titled />);
    expect(card.hasAttribute("data-sk-hover-host")).toBe(true);
    view?.rerender(
      <OverlayProvider>
        <Host titled={false} />
        <OverlayRoot />
      </OverlayProvider>,
    );
    expect(card.hasAttribute("data-sk-hover-host")).toBe(false);
    view?.unmount();
    // 整卡按钮已有 role="button"，不另加宿主标记。
    const whole = mount(<Card onClick={() => undefined} ariaLabel="打开「生存」">生存</Card>);
    expect(whole.hasAttribute("data-sk-hover-host")).toBe(false);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<CardTitleButton onClick={() => undefined}>孤立</CardTitleButton>)).toThrow("CardTitleButton 只能放在 Card 里");
  });

  it("整卡可点与带标题按钮的卡片都自成层叠上下文，卡内的 z-index 不漏到页面上", () => {
    const css = readFileSync(resolve(__dirname, "Card.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const isolated = [...css.matchAll(/(?:^|\n)([^{}\n][^{}]*)\{([^}]*)\}/g)]
      .filter(([, , body]) => /\sisolation:\s*isolate;/.test(body))
      .flatMap(([, selectors]) => selectors.split(",").map((s) => s.trim()));
    expect(isolated).toEqual(expect.arrayContaining([".card[data-interactive]", ".card:has(.titleButton)"]));

    // 选择器要真的落在整卡可点的卡片上：Card 给它的就是 data-interactive。
    const whole = mount(<Card onClick={() => undefined} ariaLabel="打开「生存」">生存</Card>);
    expect(whole.hasAttribute("data-interactive")).toBe(true);
  });

  it("裁切卡片：子项包进唯一的裁切容器，卡片自己不裁", () => {
    const card = mount(
      <Card clip padding="none">
        <p>封面</p>
        <p>正文</p>
      </Card>,
    );
    expect(card.dataset.clip).toBe("true");
    expect(card.children).toHaveLength(1);
    const clipper = card.firstElementChild as HTMLElement;
    expect([...clipper.children].map((el) => el.textContent)).toEqual(["封面", "正文"]);

    // 不裁的卡片没有这一层
    view?.unmount();
    const plain = mount(<Card>正文</Card>);
    expect(plain.firstElementChild).toBeNull();
    expect(plain.textContent).toBe("正文");
  });
});

describe("Card 样式", () => {
  const css = readFileSync(resolve(__dirname, "Card.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  /** 选择器（逐个）到声明的映射；同一选择器出现在多条规则里时声明按出现顺序合并。 */
  const rules = new Map<string, Record<string, string>>();
  for (const [, selectors, body] of css.matchAll(/(?:^|\n)([^{}\n][^{}]*)\{([^}]*)\}/g)) {
    const decls = Object.fromEntries([...body.matchAll(/([a-z-]+)\s*:\s*([^;]+);/g)].map(([, prop, value]) => [prop, value.replace(/\s+/g, " ").trim()]));
    for (const selector of selectors.split(",").map((s) => s.trim())) rules.set(selector, { ...rules.get(selector), ...decls });
  }
  const rule = (selector: string) => {
    const found = rules.get(selector);
    if (found === undefined) throw new Error(`Card.module.css 里没有 ${selector}`);
    return found;
  };

  it("裁切交给内层：卡片不裁，悬停阴影叠层画在边框外也看得见；内层盖住卡片边框盒，按卡片的内边距排版", () => {
    expect(rule(".card[data-clip]")).toEqual({ padding: "0" });
    expect(rule(".clip")).toMatchObject({ position: "relative", overflow: "hidden", margin: "-1px", border: "1px solid transparent", "border-radius": "inherit" });
    expect(rule(".card[data-pad=\"md\"] > .clip").padding).toBe(rule(".card[data-pad=\"md\"]").padding);
    expect(rule(".card[data-pad=\"sm\"] > .clip").padding).toBe("var(--sk-space-12)");
    expect(rule(".card[data-pad=\"lg\"] > .clip").padding).toBe("var(--sk-space-22) var(--sk-space-24)");
    expect(rule(".card:has(.titleButton)::after")).toMatchObject({ "box-shadow": "var(--sk-shadow)", opacity: "0" });
  });

  it("按下：从悬停上浮落回原位、缩到 0.99、阴影叠层减半，这一程走 Tap", () => {
    for (const selector of [".card[data-interactive]:active", ".card:has(.titleButton:active)"]) {
      expect(rule(selector)).toMatchObject({ translate: "none", scale: "0.99" });
      expect(rule(selector).transition).toContain("translate var(--sk-spring-tap-dur) var(--sk-spring-tap)");
    }
    expect(rule(".card[data-interactive]:active::after").opacity).toBe("0.5");
    expect(rule(".card:has(.titleButton:active)::after").opacity).toBe("0.5");
  });

  it("选中外圈在 ::before 叠层上随透明度淡入淡出，卡片自己的阴影不变", () => {
    expect(rule(".card[data-selected]")).toEqual({ "border-color": "var(--sk-accent-line)" });
    expect(rule(".card::before")).toMatchObject({
      "box-shadow": "0 0 0 var(--card-ring-width, 3px) var(--sk-accent-soft)",
      opacity: "0",
      transition: "opacity var(--sk-dur-hover) var(--sk-ease)",
    });
    expect(rule(".card[data-selected]::before").opacity).toBe("1");
    expect(rule(".card[data-selected][data-interactive]:focus-visible::before").opacity).toBe("0");
  });

  it("不可点的选中卡：描边色在卡片基础规则上过渡，与外圈同一时长同一曲线；可点卡片也带着它", () => {
    const ring = /opacity (var\(--sk-dur-hover\) var\(--sk-ease\))/.exec(rule(".card::before").transition)?.[1];
    expect(ring).toBe("var(--sk-dur-hover) var(--sk-ease)");
    expect(rule(".card").transition).toBe(`border-color ${ring}`);
    // 可点卡片的过渡另写了一整条，里面同样有描边色
    expect(rule(".card[data-interactive]").transition).toContain(`border-color ${ring}`);
    expect(rule(".card:has(.titleButton)").transition).toContain(`border-color ${ring}`);
  });

  it("外圈宽度由页面经 --card-ring-width 改：组件只读不写，页面的声明不论特异性与先后都生效", () => {
    expect(rule(".card::before")["box-shadow"]).toBe("0 0 0 var(--card-ring-width, 3px) var(--sk-accent-soft)");
    // 组件自己一旦声明这个变量，页面要靠更高的特异性或更晚的顺序才盖得过，聚光卡就会退回 3px
    expect(css).not.toMatch(/--card-ring-width\s*:/);
    // 选中态不另写一圈固定宽度的外圈
    for (const [selector, decls] of rules) {
      if (selector.includes("data-selected")) expect(decls["box-shadow"], selector).toBeUndefined();
    }
  });

  it("带标题按钮的卡片：键盘焦点环画在卡片自己身上，不画在会被裁切内层裁掉的覆盖层上；选中外圈让位", () => {
    expect(rule(".card:has(.titleButton:focus-visible)")["box-shadow"]).toBe("var(--sk-focus), var(--sk-shadow)");
    expect(rule(".card[data-interactive]:focus-visible")["box-shadow"]).toBe("var(--sk-focus), var(--sk-shadow)");
    expect(rules.get(".titleButton:focus-visible::after")).toBeUndefined();
    expect(rule(".card[data-selected]:has(.titleButton:focus-visible)::before").opacity).toBe("0");

    // 裁切卡片里标题按钮在内层裁切容器里：覆盖层画在边框外的东西都会被它裁掉
    const card = mount(
      <Card clip padding="none" selected>
        <CardTitleButton onClick={() => undefined}>生存 1.21</CardTitleButton>
      </Card>,
    );
    const button = card.querySelector("button") as HTMLButtonElement;
    expect(button.parentElement).not.toBe(card);
    expect(button.parentElement?.parentElement).toBe(card);
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

  const tree = (subtitle: string | null | undefined) => <CardHeader icon="world" title="存档" subtitle={subtitle} />;
  const rerender = (ui: ReactNode) =>
    view?.rerender(
      <OverlayProvider>
        {ui}
        <OverlayRoot />
      </OverlayProvider>,
    );
  const subtitleOf = (header: HTMLElement) => header.querySelector("h3")?.nextElementSibling as HTMLElement | null;

  it("副标题为 null：先占一行、不朗读；文案到了从透明淡入，之后换文案不再重播", () => {
    const header = mount(tree(null));
    const slot = subtitleOf(header);
    expect(slot?.hasAttribute("data-reserve")).toBe(true);
    expect(slot?.getAttribute("aria-hidden")).toBe("true");
    expect(slot?.textContent).toBe("");

    rerender(tree("3 个存档 · 1.2 GB"));
    const arrived = subtitleOf(header) as HTMLElement;
    expect(arrived.hasAttribute("data-reserve")).toBe(false);
    expect(arrived.textContent).toBe("3 个存档 · 1.2 GB");
    expect(arrived.style.opacity).toBe("0");

    rerender(tree("4 个存档 · 1.3 GB"));
    expect(subtitleOf(header)).toBe(arrived);
  });

  it("挂载时就有副标题：不单独淡入；undefined 没有这一行", () => {
    const header = mount(tree("实时 · 游戏中"));
    expect(subtitleOf(header)?.textContent).toBe("实时 · 游戏中");
    expect(subtitleOf(header)?.style.opacity).toBe("");
    rerender(tree(undefined));
    expect(subtitleOf(header)).toBeNull();
  });

  it("占位行的高度就是副标题的行高", () => {
    const css = readFileSync(resolve(__dirname, "CardHeader.module.css"), "utf8");
    expect(css).toMatch(/\.subtitle\s*\{[^}]*line-height:\s*var\(--sk-lh-caption\);/);
    expect(css).toMatch(/\.subtitle\[data-reserve\]\s*\{\s*height:\s*var\(--sk-lh-caption\);\s*\}/);
  });
});

describe("Inset", () => {
  it("按 as 渲染元素", () => {
    const inset = mount(<Inset as="aside">当日详情</Inset>);
    expect(inset.tagName).toBe("ASIDE");
    expect(inset.textContent).toBe("当日详情");
  });
});
