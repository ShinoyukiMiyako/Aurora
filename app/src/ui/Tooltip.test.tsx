// @vitest-environment jsdom
import { act, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOOLTIP_TIMING } from "../lib/motion";
import { OverlayProvider, OverlayRoot, useEscapeLayer } from "../shell/overlay";
import { focusByKeyboard, keydown, render, setRect, stubResizeObserver, type Rendered } from "../test/dom";
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
/** 触发元素当前关联的那个气泡。 */
const bubbleOf = (label: string) => {
  const id = button(label).getAttribute("aria-describedby");
  return id === null ? null : document.getElementById(id);
};
/** 让 framer-motion 的帧循环（真实时间上的 requestAnimationFrame）走 n 帧，期间的重渲染在 act 收尾时提交。 */
const frames = (n: number) =>
  act(async () => {
    for (let i = 0; i < n; i++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });

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

describe("连续扫过", () => {
  function Row() {
    return (
      <>
        <Tooltip content="甲">
          <button>A</button>
        </Tooltip>
        <Tooltip content="乙">
          <button>B</button>
        </Tooltip>
      </>
    );
  }

  it("一轮里第一个气泡带入场；旧气泡还在驻留时移到下一个：新气泡立即出现、不播入场，旧气泡同时撤掉", () => {
    mount(<Row />);
    pointerEnter(button("A"));
    advance(TOOLTIP_TIMING.delay);
    expect(bubbleOf("A")?.hasAttribute("data-instant")).toBe(false);

    pointerLeave(button("A"), button("B"));
    pointerEnter(button("B"), button("A"));
    expect(button("A").hasAttribute("aria-describedby")).toBe(false);
    expect(bubbleOf("B")?.textContent).toBe("乙");
    expect(bubbleOf("B")?.hasAttribute("data-instant")).toBe(true);
    // 旧气泡的驻留计时已随它一起撤掉，新气泡不受影响
    advance(TOOLTIP_TIMING.linger);
    expect(bubbleOf("B")?.textContent).toBe("乙");
  });

  it("旧气泡已收起、仍在预热窗口里：新气泡同样原地出现、不播入场", () => {
    mount(<Row />);
    pointerEnter(button("A"));
    advance(TOOLTIP_TIMING.delay);
    pointerLeave(button("A"));
    advance(TOOLTIP_TIMING.linger + 100);
    pointerEnter(button("B"));
    expect(bubbleOf("B")?.hasAttribute("data-instant")).toBe(true);
  });

  // 两个相邻的气泡并存约 80ms、旧的还在淡出：扫视工具栏时一闪一闪
  it("被顶替的旧气泡不播退场，下一帧就撤掉", async () => {
    vi.useRealTimers();
    mount(<Row />);
    focusByKeyboard(button("A"));
    // 等甲完全显示出来：还停在入场起点（全透明）时退场无从播起，看不出区别
    const first = bubbleOf("A") as HTMLElement;
    await vi.waitFor(() => expect(first.style.opacity).toBe("1"), { timeout: 2000, interval: 5 });
    pointerEnter(button("B"));
    // 照常退场要 80ms，两帧之内还在
    await frames(2);
    expect([...document.querySelectorAll('[role="tooltip"]')].map((el) => el.textContent)).toEqual(["乙"]);
  });

  // 驻留已结束、旧气泡正在淡出时，它已不算「显示中」，顶替逻辑够不着它
  it("旧气泡已收起、还在淡出时移到下一个：旧气泡立即撤掉，不与新气泡并存到淡完", async () => {
    vi.useRealTimers();
    mount(<Row />);
    focusByKeyboard(button("A"));
    const first = bubbleOf("A") as HTMLElement;
    await vi.waitFor(() => expect(first.style.opacity).toBe("1"), { timeout: 2000, interval: 5 });
    act(() => button("A").blur());
    expect(first.isConnected).toBe(true);
    pointerEnter(button("B"));
    expect(bubbleOf("B")?.hasAttribute("data-instant")).toBe(true);
    // 照常淡出要 80ms，两帧之内还在
    await frames(2);
    expect(first.isConnected).toBe(false);
    expect([...document.querySelectorAll('[role="tooltip"]')].map((el) => el.textContent)).toEqual(["乙"]);
  });

  it("自己正在淡出时又被移回来：同一个气泡接着显示，不被当成别人的退场撤掉", async () => {
    vi.useRealTimers();
    mount(<Row />);
    focusByKeyboard(button("A"));
    const first = bubbleOf("A") as HTMLElement;
    await vi.waitFor(() => expect(first.style.opacity).toBe("1"), { timeout: 2000, interval: 5 });
    act(() => button("A").blur());
    pointerEnter(button("A"));
    // 等过原本的淡出时长：还是原来那个元素、没被卸掉，并回到不透明
    await frames(8);
    expect(first.isConnected).toBe(true);
    expect(bubbleOf("A")).toBe(first);
    await vi.waitFor(() => expect(first.style.opacity).toBe("1"), { timeout: 2000, interval: 5 });
  });
});

describe("由 open 强制显示的气泡", () => {
  it("指针移到别的提示上：不被顶替，也不让别的提示借它预热", () => {
    let setForced!: (v: boolean) => void;
    function Host() {
      const [forced, set] = useState(false);
      setForced = set;
      return (
        <>
          <Tooltip content="游戏运行中不能删除" open={forced}>
            <button>A</button>
          </Tooltip>
          <Tooltip content="乙">
            <button>B</button>
          </Tooltip>
        </>
      );
    }
    mount(<Host />);
    // 先让乙显示一次再收起、等过预热窗口：预热时刻落在假时钟上（前面用真实计时器的用例把它留在了真实时间上）
    pointerEnter(button("B"));
    advance(TOOLTIP_TIMING.delay);
    pointerLeave(button("B"));
    advance(TOOLTIP_TIMING.linger + TOOLTIP_TIMING.warmWindow);
    expect(bubbleOf("B")).toBeNull();

    act(() => setForced(true));
    expect(bubbleOf("A")?.textContent).toBe("游戏运行中不能删除");
    pointerEnter(button("B"));
    advance(TOOLTIP_TIMING.delay - 1);
    expect(bubbleOf("B")).toBeNull();
    advance(1);
    expect(bubbleOf("B")?.textContent).toBe("乙");
    expect(bubbleOf("A")?.textContent).toBe("游戏运行中不能删除");
    // 别的提示收起后，强制的那个照旧挂着
    pointerLeave(button("B"));
    advance(TOOLTIP_TIMING.linger);
    expect(bubbleOf("B")).toBeNull();
    expect(bubbleOf("A")?.textContent).toBe("游戏运行中不能删除");
  });

  it("悬停打开后才转成强制显示：同样不被别的提示顶替", () => {
    let setForced!: (v: boolean) => void;
    function Host() {
      const [forced, set] = useState(false);
      setForced = set;
      return (
        <>
          <Tooltip content="石头" open={forced}>
            <button>A</button>
          </Tooltip>
          <Tooltip content="乙">
            <button>B</button>
          </Tooltip>
        </>
      );
    }
    mount(<Host />);
    pointerEnter(button("A"));
    advance(TOOLTIP_TIMING.delay);
    act(() => setForced(true));
    pointerEnter(button("B"));
    advance(TOOLTIP_TIMING.delay);
    expect(bubbleOf("B")?.textContent).toBe("乙");
    expect(bubbleOf("A")?.textContent).toBe("石头");
  });
});

describe("按在带原因禁用的控件上", () => {
  it("点击被挡掉的那一刻立即显示原因，不收起", () => {
    mount(
      <Tooltip content="游戏正在运行，先结束游戏">
        <button aria-disabled="true">A</button>
      </Tooltip>,
    );
    act(() => {
      button("A").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(bubble()?.textContent).toBe("游戏正在运行，先结束游戏");
    expect(button("A").getAttribute("aria-describedby")).toBe(bubble()?.id);
    act(() => {
      button("A").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(button("A").getAttribute("aria-describedby")).toBe(bubble()?.id);
  });
});

describe("显示中重新定位", () => {
  it("气泡尺寸变了（文案换成「已复制」、多出一行原因）：按新尺寸重新贴到锚点旁", () => {
    const sizes = stubResizeObserver();
    const container = mount(
      <Tooltip content="复制链接" side="top">
        <button>A</button>
      </Tooltip>,
    );
    setRect(container.querySelector("[data-sk-overlay-root]") as HTMLElement, { left: 0, top: 0, width: 1000, height: 700 });
    setRect(button("A"), { left: 100, top: 300, width: 80, height: 30 });
    focusByKeyboard(button("A"));
    const tip = bubble() as HTMLElement;
    // jsdom 量不出尺寸：按 0 × 0 贴在锚点上方正中
    expect([tip.style.left, tip.style.top]).toEqual(["140px", "292px"]);
    Object.defineProperty(tip, "offsetWidth", { configurable: true, value: 60 });
    Object.defineProperty(tip, "offsetHeight", { configurable: true, value: 28 });
    sizes.resize(tip, 60);
    // 横向居中：100 + (80 − 60) / 2；上方：300 − 8 − 28
    expect([tip.style.left, tip.style.top]).toEqual(["110px", "264px"]);
  });

  it("由 open 强制显示的气泡：滚动时不收起，跟着锚点走", () => {
    const container = mount(
      <Tooltip content="石头" open>
        <button>A</button>
      </Tooltip>,
    );
    setRect(container.querySelector("[data-sk-overlay-root]") as HTMLElement, { left: 0, top: 0, width: 1000, height: 700 });
    setRect(button("A"), { left: 100, top: 300, width: 80, height: 30 });
    act(() => {
      document.dispatchEvent(new Event("scroll"));
    });
    const tip = bubble() as HTMLElement;
    expect(button("A").getAttribute("aria-describedby")).toBe(tip.id);
    expect([tip.style.left, tip.style.top]).toEqual(["140px", "292px"]);
  });

  // 滚轮滚动方块网格：锚点被滚出网格的可视区后，气泡被夹在窗口里、脱离锚点浮在别的内容上
  it("由 open 强制显示的气泡：锚点被滚出所在滚动容器的可视区时藏起，滚回来再出现", () => {
    const container = mount(
      <div data-testid="grid" style={{ overflowY: "auto" }}>
        <Tooltip content="石头" open>
          <button>A</button>
        </Tooltip>
      </div>,
    );
    setRect(container.querySelector("[data-sk-overlay-root]") as HTMLElement, { left: 0, top: 0, width: 1000, height: 700 });
    setRect(container.querySelector('[data-testid="grid"]') as HTMLElement, { left: 0, top: 100, width: 400, height: 200 });
    const scrollTo = (top: number) => {
      setRect(button("A"), { left: 100, top, width: 80, height: 30 });
      act(() => {
        document.dispatchEvent(new Event("scroll"));
      });
    };
    scrollTo(150);
    const tip = bubble() as HTMLElement;
    expect(tip.style.visibility).toBe("visible");
    // 部分露在可视区里时照常显示
    scrollTo(290);
    expect(tip.style.visibility).toBe("visible");
    scrollTo(320);
    expect(tip.style.visibility).toBe("hidden");
    // 只是藏起，提示仍关联着、仍跟着锚点
    expect(button("A").getAttribute("aria-describedby")).toBe(tip.id);
    scrollTo(60);
    expect(tip.style.visibility).toBe("hidden");
    scrollTo(160);
    expect(tip.style.visibility).toBe("visible");
    expect(tip.style.top).toBe("152px");
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

  // 挂载那一帧还没定位，起点按首选的上方给的话，翻到下方后气泡是从远离锚点的一侧往锚点浮
  it("翻到对侧时入场从锚点那一侧浮出", async () => {
    vi.useRealTimers();
    const container = mount(
      <Tooltip content="提示" side="top">
        <button>A</button>
      </Tooltip>,
    );
    setRect(container.querySelector("[data-sk-overlay-root]") as HTMLElement, { left: 0, top: 0, width: 1000, height: 700 });
    setRect(button("A"), { left: 100, top: 4, width: 80, height: 30 });
    focusByKeyboard(button("A"));
    const tip = bubble() as HTMLElement;
    expect(tip.dataset.side).toBe("bottom");
    const firstY = await vi.waitFor(
      () => {
        const match = /translateY\((-?[\d.]+)px\)/.exec(tip.style.transform);
        if (match === null) throw new Error(`入场还没写到元素上：${tip.style.transform}`);
        return Number(match[1]);
      },
      { timeout: 2000, interval: 1 },
    );
    expect(firstY).toBeLessThan(0);
  });
});
