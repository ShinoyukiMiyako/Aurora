// @vitest-environment jsdom
import { act, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOOLTIP_TIMING } from "../lib/motion";
import { OverlayProvider, OverlayRoot, useEscapeLayer } from "../shell/overlay";
import { focusByKeyboard, keydown, render, setRect, type Rendered } from "../test/dom";
import { Tooltip } from "./Tooltip";

let view: Rendered | undefined;
let now = 1_000_000;

beforeEach(() => {
  // Date 一并假：预热窗口按 Date.now() 计算
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now });
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
  now += 10_000_000;
});

function mount(ui: ReactNode) {
  view = render(
    <OverlayProvider>
      {ui}
      <OverlayRoot />
    </OverlayProvider>,
  );
  return view.container;
}

const button = (label: string) => {
  const el = [...document.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!el) throw new Error(`找不到按钮 ${label}`);
  return el;
};
const bubble = () => document.querySelector<HTMLElement>('[role="tooltip"]');
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

/** React 的 onPointerEnter / onPointerLeave 由 pointerover / pointerout 推导，直接派发 pointerenter 收不到。 */
function pointerEnter(el: Element, from: Element = document.body) {
  act(() => {
    el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: from }));
  });
}
function pointerLeave(el: Element, to: Element = document.body) {
  act(() => {
    el.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: to }));
  });
}

describe("悬停时机", () => {
  it("悬停 280 ms 后出现，并通过 aria-describedby 关联", () => {
    mount(
      <Tooltip content="打开文件夹">
        <button>A</button>
      </Tooltip>,
    );
    pointerEnter(button("A"));
    advance(TOOLTIP_TIMING.delay - 1);
    expect(bubble()).toBeNull();
    expect(button("A").hasAttribute("aria-describedby")).toBe(false);
    advance(1);
    expect(bubble()?.textContent).toBe("打开文件夹");
    expect(button("A").getAttribute("aria-describedby")).toBe(bubble()?.id);
  });

  it("出现前离开则不出现", () => {
    mount(
      <Tooltip content="提示">
        <button>A</button>
      </Tooltip>,
    );
    pointerEnter(button("A"));
    advance(200);
    pointerLeave(button("A"));
    advance(1000);
    expect(bubble()).toBeNull();
  });

  it("侧栏条目用较短的延迟", () => {
    mount(
      <Tooltip content="生存 1.21" side="right" delay={TOOLTIP_TIMING.sidebarDelay}>
        <button>A</button>
      </Tooltip>,
    );
    pointerEnter(button("A"));
    advance(TOOLTIP_TIMING.sidebarDelay);
    expect(bubble()?.textContent).toBe("生存 1.21");
  });

  it("离开后驻留 120 ms，期间移入气泡保持显示", () => {
    mount(
      <Tooltip content="可驻留">
        <button>A</button>
      </Tooltip>,
    );
    pointerEnter(button("A"));
    advance(TOOLTIP_TIMING.delay);
    const tip = bubble() as HTMLElement;
    pointerLeave(button("A"), tip);
    advance(TOOLTIP_TIMING.linger - 20);
    pointerEnter(tip, button("A"));
    advance(1000);
    expect(button("A").getAttribute("aria-describedby")).toBe(tip.id);

    pointerLeave(tip);
    advance(TOOLTIP_TIMING.linger - 1);
    expect(button("A").hasAttribute("aria-describedby")).toBe(true);
    advance(1);
    expect(button("A").hasAttribute("aria-describedby")).toBe(false);
  });

  it("预热：气泡消失后 400 ms 内移到另一个触发元素立即出现，超过则重新等待", () => {
    mount(
      <>
        <Tooltip content="甲">
          <button>A</button>
        </Tooltip>
        <Tooltip content="乙">
          <button>B</button>
        </Tooltip>
      </>,
    );
    pointerEnter(button("A"));
    advance(TOOLTIP_TIMING.delay);
    pointerLeave(button("A"));
    advance(TOOLTIP_TIMING.linger);
    expect(button("A").hasAttribute("aria-describedby")).toBe(false);

    advance(TOOLTIP_TIMING.warmWindow - 1);
    pointerEnter(button("B"));
    expect(button("B").getAttribute("aria-describedby")).toBeTruthy();

    pointerLeave(button("B"));
    advance(TOOLTIP_TIMING.linger + TOOLTIP_TIMING.warmWindow);
    pointerEnter(button("A"));
    expect(button("A").hasAttribute("aria-describedby")).toBe(false);
    advance(TOOLTIP_TIMING.delay);
    expect(button("A").hasAttribute("aria-describedby")).toBe(true);
  });
});

describe("立即消失", () => {
  const open = () => {
    pointerEnter(button("A"));
    advance(TOOLTIP_TIMING.delay);
    expect(button("A").hasAttribute("aria-describedby")).toBe(true);
  };

  it("指针按下", () => {
    mount(
      <Tooltip content="提示">
        <button>A</button>
      </Tooltip>,
    );
    open();
    act(() => {
      button("A").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(button("A").hasAttribute("aria-describedby")).toBe(false);
  });

  it("滚动", () => {
    mount(
      <Tooltip content="提示">
        <button>A</button>
      </Tooltip>,
    );
    open();
    act(() => {
      document.dispatchEvent(new Event("scroll"));
    });
    expect(button("A").hasAttribute("aria-describedby")).toBe(false);
  });

  it("Esc 收起气泡，同时照常关闭栈顶浮层", () => {
    const onEscape = vi.fn();
    function Layer() {
      useEscapeLayer(true, onEscape, { kind: "popover" });
      return null;
    }
    mount(
      <>
        <Layer />
        <Tooltip content="提示">
          <button>A</button>
        </Tooltip>
      </>,
    );
    open();
    keydown(button("A"), "Escape");
    expect(button("A").hasAttribute("aria-describedby")).toBe(false);
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("disabled 时不出现；打开中变为 disabled 立即收起", () => {
    let setDisabled!: (v: boolean) => void;
    function Host() {
      const [disabled, set] = useState(false);
      setDisabled = set;
      return (
        <Tooltip content="提示" disabled={disabled}>
          <button>A</button>
        </Tooltip>
      );
    }
    mount(<Host />);
    open();
    act(() => setDisabled(true));
    expect(button("A").hasAttribute("aria-describedby")).toBe(false);
    pointerEnter(button("A"));
    advance(5000);
    expect(button("A").hasAttribute("aria-describedby")).toBe(false);
  });

  // 标题栏的后退键按到历史尽头就变成禁用：浏览器把焦点挪走却不派发 blur，气泡要自己收起，不能一直挂着
  it("键盘聚焦打开后，触发元素自己变成禁用：立即收起", () => {
    let setOff!: (v: boolean) => void;
    function Host() {
      const [off, set] = useState(false);
      setOff = set;
      return (
        <Tooltip content="后退">
          <button disabled={off}>A</button>
        </Tooltip>
      );
    }
    mount(<Host />);
    focusByKeyboard(button("A"));
    expect(bubble()?.textContent).toBe("后退");
    act(() => setOff(true));
    expect(button("A").hasAttribute("aria-describedby")).toBe(false);
  });

  it("触发元素本来就是禁用的：悬停照常显示", () => {
    mount(
      <Tooltip content="后退">
        <button disabled>A</button>
      </Tooltip>,
    );
    pointerEnter(button("A"));
    advance(TOOLTIP_TIMING.delay);
    expect(bubble()?.textContent).toBe("后退");
    expect(button("A").getAttribute("aria-describedby")).toBe(bubble()?.id);
  });

  it("触发元素改的是别的属性：气泡照常留着", () => {
    let setTitle!: (v: string) => void;
    function Host() {
      const [title, set] = useState("a");
      setTitle = set;
      return (
        <Tooltip content="后退">
          <button title={title}>A</button>
        </Tooltip>
      );
    }
    mount(<Host />);
    focusByKeyboard(button("A"));
    act(() => setTitle("b"));
    expect(bubble()?.textContent).toBe("后退");
  });
});

describe("常驻的包裹层", () => {
  it("关着的提示不碰浮层体系：放在 OverlayProvider 之外也能渲染，开着的照样报错", () => {
    view = render(
      <Tooltip content="提示" disabled>
        <button>A</button>
      </Tooltip>,
    );
    expect(button("A").textContent).toBe("A");
    expect(() =>
      render(
        <Tooltip content="提示">
          <button>B</button>
        </Tooltip>,
      ),
    ).toThrow("浮层组件必须放在 OverlayProvider 之内");
  });

  it("从关到开：之后照常悬停出现", () => {
    let setDisabled!: (v: boolean) => void;
    function Host() {
      const [disabled, set] = useState(true);
      setDisabled = set;
      return (
        <Tooltip content="提示" disabled={disabled}>
          <button>A</button>
        </Tooltip>
      );
    }
    mount(<Host />);
    act(() => setDisabled(false));
    pointerEnter(button("A"));
    advance(TOOLTIP_TIMING.delay);
    expect(bubble()?.textContent).toBe("提示");
  });

  it("调用方连内容一起撤掉：退场中的气泡还是原来的字，不闪成空气泡", () => {
    let setReason!: (v: string | undefined) => void;
    function Host() {
      const [reason, set] = useState<string | undefined>("游戏运行中不能修改");
      setReason = set;
      return (
        <Tooltip content={reason} disabled={reason === undefined}>
          <button>A</button>
        </Tooltip>
      );
    }
    mount(<Host />);
    focusByKeyboard(button("A"));
    expect(bubble()?.textContent).toBe("游戏运行中不能修改");
    act(() => setReason(undefined));
    expect(button("A").hasAttribute("aria-describedby")).toBe(false);
    expect(bubble()?.textContent).toBe("游戏运行中不能修改");
  });

  // <Tooltip><Button /></Tooltip>：里层的包裹 display: contents，没有盒子，锚在它身上气泡会飞到左上角
  it("子元素自带一层包裹：气泡锚在里面的控件上，禁用判定也看控件", () => {
    const container = mount(
      <Tooltip content="外层" side="top">
        <Tooltip content="里层" disabled>
          <button disabled>A</button>
        </Tooltip>
      </Tooltip>,
    );
    const root = container.querySelector("[data-sk-overlay-root]") as HTMLElement;
    setRect(root, { left: 0, top: 0, width: 1000, height: 700 });
    setRect(button("A"), { left: 100, top: 300, width: 80, height: 30 });
    pointerEnter(button("A"));
    advance(TOOLTIP_TIMING.delay);
    const tip = bubble() as HTMLElement;
    expect(tip.textContent).toBe("外层");
    expect(tip.dataset.side).toBe("top");
    expect(tip.style.left).not.toBe("0px");
    expect(tip.style.top).toBe("292px");
  });
});

describe("键盘与关联", () => {
  it("键盘聚焦立即出现，失焦立即消失", () => {
    mount(
      <Tooltip content="命令面板" sub="Ctrl K">
        <button>A</button>
      </Tooltip>,
    );
    focusByKeyboard(button("A"));
    expect(bubble()?.textContent).toBe("命令面板Ctrl K");
    act(() => button("A").blur());
    expect(button("A").hasAttribute("aria-describedby")).toBe(false);
  });

  it("指针点击带来的聚焦不出现（不是 :focus-visible）", () => {
    mount(
      <Tooltip content="提示">
        <button>A</button>
      </Tooltip>,
    );
    // 真实浏览器里点击的顺序：pointerdown、mousedown、focus；jsdom 按最近的鼠标事件判定不是键盘聚焦
    act(() => {
      button("A").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      button("A").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      button("A").focus();
    });
    expect(bubble()).toBeNull();
    expect(button("A").hasAttribute("aria-describedby")).toBe(false);
  });

  it("保留子元素原有的 aria-describedby", () => {
    mount(
      <Tooltip content="提示">
        <button aria-describedby="hint">A</button>
      </Tooltip>,
    );
    expect(button("A").getAttribute("aria-describedby")).toBe("hint");
    focusByKeyboard(button("A"));
    expect(button("A").getAttribute("aria-describedby")).toBe(`hint ${bubble()?.id}`);
  });

  it("首选方位放不下时翻到对侧", () => {
    const container = mount(
      <Tooltip content="提示" side="top">
        <button>A</button>
      </Tooltip>,
    );
    const root = container.querySelector("[data-sk-overlay-root]") as HTMLElement;
    setRect(root, { left: 0, top: 0, width: 1000, height: 700 });
    setRect(button("A"), { left: 100, top: 4, width: 80, height: 30 });
    focusByKeyboard(button("A"));
    const tip = bubble() as HTMLElement;
    expect(tip.dataset.side).toBe("bottom");
    expect(tip.style.top).toBe("42px");
    expect(tip.style.visibility).toBe("visible");
  });
});
