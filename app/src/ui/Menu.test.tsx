// @vitest-environment jsdom
import { act, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { keydown, render, setRect, stubResizeObserver, type Rendered } from "../test/dom";
import { Button } from "./Button";
import { Menu, type MenuEntry } from "./Menu";
import { MenuButton } from "./MenuButton";
import { MoreMenu } from "./MoreMenu";
import { enterShift, originTowardAnchor, Popover } from "./Popover";

let view: Rendered | undefined;

beforeEach(() => {
  stubResizeObserver();
});

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
  return view;
}

const trigger = () => document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]') as HTMLButtonElement;
/** 退场动画期间旧菜单还在文档里，取未在退场的那一个。 */
const menu = () => document.querySelector<HTMLElement>(':not([data-exiting]) > [role="menu"]');
const highlighted = () => {
  const id = menu()?.getAttribute("aria-activedescendant");
  return id ? document.getElementById(id)?.textContent : null;
};
const click = (el: Element, detail: number) =>
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail }));
  });
const press = (key: string, init: KeyboardEventInit = {}) => keydown(document.activeElement as Element, key, init);
/** 像真实点击一样先让触发器获得焦点再派发 click；detail 0 是键盘 Enter / Space 激活产生的点击。 */
const openMenu = (detail: number) => {
  act(() => trigger().focus());
  click(trigger(), detail);
};

/** 把带 data-side 的浮层面板量出的尺寸固定下来：面板挂载那一刻就要量到，来不及在元素上逐个定义。返回还原函数。 */
function stubPanelSize(size: { width: number; height: number }): () => void {
  const proto = HTMLElement.prototype;
  const width = Object.getOwnPropertyDescriptor(proto, "offsetWidth");
  const height = Object.getOwnPropertyDescriptor(proto, "offsetHeight");
  if (width === undefined || height === undefined) throw new Error("jsdom 没有 offsetWidth / offsetHeight");
  const sized = (value: number) => ({
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute("data-side") ? value : 0;
    },
  });
  Object.defineProperty(proto, "offsetWidth", sized(size.width));
  Object.defineProperty(proto, "offsetHeight", sized(size.height));
  return () => {
    Object.defineProperty(proto, "offsetWidth", width);
    Object.defineProperty(proto, "offsetHeight", height);
  };
}

/** 入场动画第一次写到元素上的纵向位移（px）。framer-motion 的帧循环跑在真实时间上，只能轮询。 */
function firstTranslateY(el: HTMLElement): Promise<number> {
  return vi.waitFor(
    () => {
      const match = /translateY\((-?[\d.]+)px\)/.exec(el.style.transform);
      if (match === null) throw new Error(`入场还没写到元素上：${el.style.transform}`);
      return Number(match[1]);
    },
    { timeout: 2000, interval: 1 },
  );
}

function entries(spy: (name: string) => void): MenuEntry[] {
  return [
    { kind: "group", label: "实例" },
    { label: "打开实例文件夹", icon: "folder", onSelect: () => spy("folder") },
    { label: "复制实例", icon: "copy", hint: "Ctrl D", onSelect: () => spy("copy") },
    { label: "导出整合包", disabled: true, onSelect: () => spy("export") },
    { label: "固定到侧栏", icon: "pin", onSelect: () => spy("pin") },
    { kind: "separator" },
    { label: "删除实例", icon: "trash", danger: true, onSelect: () => spy("delete") },
  ];
}

describe("打开与高亮", () => {
  it("指针打开不高亮、焦点进菜单；键盘（Enter / Space 触发的点击）打开高亮第一项", () => {
    mount(<MoreMenu items={entries(() => undefined)} />);
    openMenu(1);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(trigger().hasAttribute("data-open")).toBe(true);
    expect(document.activeElement).toBe(menu());
    expect(highlighted()).toBeNull();
    press("Escape");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    openMenu(0);
    // 分组标题不可操作，第一项是「打开实例文件夹」
    expect(highlighted()).toBe("打开实例文件夹");
    expect(menu()?.getAttribute("aria-labelledby")).toBe(trigger().id);
  });

  it("触发器上 ↓ 打开高亮第一项，↑ 打开高亮最后一项", () => {
    mount(<MoreMenu items={entries(() => undefined)} />);
    act(() => trigger().focus());
    press("ArrowUp");
    expect(highlighted()).toBe("删除实例");
    press("Escape");
    expect(document.activeElement).toBe(trigger());
    press("ArrowDown");
    expect(highlighted()).toBe("打开实例文件夹");
  });
});

describe("键盘", () => {
  it("↑↓ 跳过分隔线、分组标题与禁用项并首尾循环；Home / End 到首尾", () => {
    mount(<MoreMenu items={entries(() => undefined)} />);
    openMenu(0);
    press("ArrowDown");
    expect(highlighted()).toBe("复制实例Ctrl D");
    press("ArrowDown");
    // 「导出整合包」禁用，直接到「固定到侧栏」
    expect(highlighted()).toBe("固定到侧栏");
    press("ArrowDown");
    expect(highlighted()).toBe("删除实例");
    press("ArrowDown");
    expect(highlighted()).toBe("打开实例文件夹");
    press("ArrowUp");
    expect(highlighted()).toBe("删除实例");
    press("Home");
    expect(highlighted()).toBe("打开实例文件夹");
    press("End");
    expect(highlighted()).toBe("删除实例");
  });

  // 原因只挂在指针悬停上时，键盘与读屏用户只看到一项变灰、不知道为什么，也没有别的地方能看到原因
  it("写明原因的禁用项键盘能高亮到：高亮时提示气泡写出原因并关联到该项，Enter 不执行也不关菜单；没写原因的禁用项照旧跳过", () => {
    const spy = vi.fn();
    mount(
      <MoreMenu
        items={[
          { label: "打开实例文件夹", onSelect: () => spy("folder") },
          { label: "导出整合包", disabled: true, onSelect: () => spy("export") },
          { label: "重命名", disabled: true, disabledReason: "游戏正在运行，先结束游戏", onSelect: () => spy("rename") },
          { label: "固定到侧栏", onSelect: () => spy("pin") },
        ]}
      />,
    );
    openMenu(0);
    expect(highlighted()).toBe("打开实例文件夹");
    press("ArrowDown");
    expect(highlighted()).toBe("重命名");
    const item = document.getElementById(menu()?.getAttribute("aria-activedescendant") ?? "") as HTMLElement;
    expect(item.getAttribute("aria-disabled")).toBe("true");
    const tip = document.querySelector<HTMLElement>('[role="tooltip"]');
    expect(tip?.textContent).toBe("游戏正在运行，先结束游戏");
    expect(item.getAttribute("aria-describedby")).toBe(tip?.id);

    press("Enter");
    press(" ");
    expect(spy).not.toHaveBeenCalled();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");

    press("ArrowDown");
    expect(highlighted()).toBe("固定到侧栏");
    expect(item.hasAttribute("aria-describedby")).toBe(false);
    press("ArrowUp");
    expect(highlighted()).toBe("重命名");
    press("ArrowUp");
    expect(highlighted()).toBe("打开实例文件夹");
    press("重");
    expect(highlighted()).toBe("重命名");
    press("导");
    expect(highlighted()).toBe("重命名");
  });

  it("写明原因的禁用项排在首尾时，键盘打开与 Home / End 也停在它上面", () => {
    mount(
      <MoreMenu
        items={[
          { label: "重命名", disabled: true, disabledReason: "游戏正在运行，先结束游戏", onSelect: () => undefined },
          { label: "固定到侧栏", onSelect: () => undefined },
          { label: "导出整合包", disabled: true, onSelect: () => undefined },
        ]}
      />,
    );
    openMenu(0);
    expect(highlighted()).toBe("重命名");
    press("End");
    expect(highlighted()).toBe("固定到侧栏");
    press("Home");
    expect(highlighted()).toBe("重命名");
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("游戏正在运行，先结束游戏");
  });

  // 气泡在浮层根里自成一层，不跟着面板淡出：面板卸载时它连退场一起被直接拿掉，整块突然消失
  it("菜单关闭时，键盘高亮着的禁用原因气泡跟着开始收起，不等面板卸载", () => {
    mount(
      <MoreMenu
        items={[
          { label: "打开实例文件夹", onSelect: () => undefined },
          { label: "重命名", disabled: true, disabledReason: "游戏正在运行，先结束游戏", onSelect: () => undefined },
        ]}
      />,
    );
    openMenu(0);
    press("ArrowDown");
    const item = document.getElementById(menu()?.getAttribute("aria-activedescendant") ?? "") as HTMLElement;
    expect(item.getAttribute("aria-describedby")).toBe(document.querySelector('[role="tooltip"]')?.id);
    press("Escape");
    expect(item.closest("[data-exiting]")).not.toBeNull();
    expect(item.hasAttribute("aria-describedby")).toBe(false);
  });

  it("Enter 先关闭菜单再执行动作，焦点回到触发器", () => {
    const spy = vi.fn();
    mount(<MoreMenu items={entries(spy)} />);
    openMenu(0);
    press("ArrowDown");
    press("Enter");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("copy");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger());
  });

  it("键入字符按首字跳转", () => {
    mount(<MoreMenu items={entries(() => undefined)} />);
    openMenu(1);
    press("固");
    expect(highlighted()).toBe("固定到侧栏");
    press("删");
    // 两次键入相隔不到 500 ms，前缀合并成「固删」，没有匹配，高亮不变
    expect(highlighted()).toBe("固定到侧栏");
  });

  it("Tab 关闭菜单，焦点前进到触发器之后的元素；Shift+Tab 回到触发器", () => {
    mount(
      <>
        <MoreMenu items={entries(() => undefined)} />
        <Button>下一个</Button>
      </>,
    );
    openMenu(0);
    const tab = press("Tab");
    expect(tab.defaultPrevented).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement?.textContent).toBe("下一个");
    openMenu(0);
    press("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(trigger());
  });

  it("点菜单项执行并关闭；点禁用项无效", () => {
    const spy = vi.fn();
    mount(<MoreMenu items={entries(spy)} />);
    openMenu(1);
    const items = [...(menu() as HTMLElement).querySelectorAll<HTMLElement>('[role="menuitem"]')];
    click(items.find((i) => i.textContent === "导出整合包") as HTMLElement, 1);
    expect(spy).not.toHaveBeenCalled();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    click(items.find((i) => i.textContent === "固定到侧栏") as HTMLElement, 1);
    expect(spy).toHaveBeenCalledWith("pin");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });
});

describe("点外部", () => {
  it("按在面板与触发器之外即关闭，焦点不拉回触发器；按在触发器上由触发器自己切换", () => {
    const spy = vi.fn();
    mount(
      <>
        <MoreMenu items={entries(spy)} />
        <Button>别处</Button>
      </>,
    );
    openMenu(1);
    const elsewhere = [...document.querySelectorAll("button")].find((b) => b.textContent === "别处") as HTMLButtonElement;
    act(() => {
      elsewhere.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      // 真实浏览器里按下之后焦点落到被按的按钮上
      elsewhere.focus();
    });
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(elsewhere);

    openMenu(1);
    act(() => {
      trigger().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    openMenu(1);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(spy).not.toHaveBeenCalled();
  });

  it("按在面板里弹出的下一层浮层上不算外部", () => {
    function Nested() {
      const [outer, setOuter] = useState<HTMLElement | null>(null);
      const [inner, setInner] = useState<HTMLElement | null>(null);
      const [outerOpen, setOuterOpen] = useState(true);
      return (
        <>
          <button ref={setOuter}>筛选</button>
          <Popover open={outerOpen} anchor={outer} onClose={() => setOuterOpen(false)} aria-label="筛选">
            <button ref={setInner}>排序</button>
            <Popover open={inner !== null} anchor={inner} onClose={() => undefined} aria-label="排序方式">
              <button>按下载量</button>
            </Popover>
          </Popover>
          <span data-testid="outer-open">{String(outerOpen)}</span>
        </>
      );
    }
    mount(<Nested />);
    const deep = [...document.querySelectorAll("button")].find((b) => b.textContent === "按下载量") as HTMLButtonElement;
    act(() => {
      deep.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(document.querySelector('[data-testid="outer-open"]')?.textContent).toBe("true");
  });
});

describe("定位", () => {
  it("下方放不下时翻到上方，夹在窗口内 8px", () => {
    function Anchored() {
      const [anchor, setAnchor] = useState<HTMLElement | null>(null);
      return (
        <>
          <button ref={setAnchor}>下载</button>
          <Popover open={anchor !== null} anchor={anchor} onClose={() => undefined} placement="bottom-end" aria-label="下载快览">
            <p>内容</p>
          </Popover>
        </>
      );
    }
    const { container } = mount(<Anchored />);
    const root = container.querySelector("[data-sk-overlay-root]") as HTMLElement;
    const anchor = container.querySelector("button") as HTMLButtonElement;
    const panel = document.querySelector<HTMLElement>('[role="dialog"]') as HTMLElement;
    setRect(root, { left: 0, top: 0, width: 960, height: 720 });
    setRect(anchor, { left: 900, top: 680, width: 36, height: 30 });
    Object.defineProperty(panel, "offsetWidth", { configurable: true, value: 300 });
    Object.defineProperty(panel, "offsetHeight", { configurable: true, value: 200 });
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(panel.dataset.side).toBe("top");
    // 右对齐锚点：936 − 300 = 636；上方：680 − 8 − 200 = 472
    expect(panel.style.left).toBe("636px");
    expect(panel.style.top).toBe("472px");
    // 缩放原点在面板底边、正对锚点中心：918 − 636 = 282
    expect(panel.style.transformOrigin).toBe("282px 200px");
  });

  // 可筛选的下拉向上展开后键入筛选词：面板变矮，下方又放得下了，也不能整块瞬移到触发器下方
  it("打开后沿用已采用的方位：面板变矮、首选一侧又放得下时不翻回去，底边仍贴着锚点", () => {
    function Anchored() {
      const [anchor, setAnchor] = useState<HTMLElement | null>(null);
      return (
        <>
          <button ref={setAnchor}>版本</button>
          <Popover open={anchor !== null} anchor={anchor} onClose={() => undefined} placement="bottom-start" aria-label="版本">
            <p>内容</p>
          </Popover>
        </>
      );
    }
    const { container } = mount(<Anchored />);
    const root = container.querySelector("[data-sk-overlay-root]") as HTMLElement;
    const anchor = container.querySelector("button") as HTMLButtonElement;
    const panel = document.querySelector<HTMLElement>('[role="dialog"]') as HTMLElement;
    setRect(root, { left: 0, top: 0, width: 960, height: 720 });
    setRect(anchor, { left: 100, top: 600, width: 200, height: 30 });
    Object.defineProperty(panel, "offsetWidth", { configurable: true, value: 200 });
    Object.defineProperty(panel, "offsetHeight", { configurable: true, value: 300 });
    const reposition = () =>
      act(() => {
        window.dispatchEvent(new Event("scroll"));
      });
    reposition();
    expect(panel.dataset.side).toBe("top");
    expect(panel.style.top).toBe(`${600 - 8 - 300}px`);

    // 变成 50 高：下方 600 + 30 + 8 + 50 = 688 ≤ 712 放得下，但面板留在上方
    Object.defineProperty(panel, "offsetHeight", { configurable: true, value: 50 });
    reposition();
    expect(panel.dataset.side).toBe("top");
    expect(panel.style.top).toBe(`${600 - 8 - 50}px`);

    // 当前一侧放不下了才翻：锚点挪到顶上
    setRect(anchor, { left: 100, top: 20, width: 200, height: 30 });
    reposition();
    expect(panel.dataset.side).toBe("bottom");
    expect(panel.style.top).toBe(`${20 + 30 + 8}px`);
  });

  it("右键菜单以指针为锚点：缩放原点就在指针处", () => {
    const { container } = mount(<Menu open anchor={{ clientX: 300, clientY: 200 }} onClose={() => undefined} items={entries(() => undefined)} openedBy="pointer" aria-label="实例" />);
    const root = container.querySelector("[data-sk-overlay-root]") as HTMLElement;
    const panel = menu()?.parentElement as HTMLElement;
    setRect(root, { left: 0, top: 0, width: 960, height: 720 });
    Object.defineProperty(panel, "offsetWidth", { configurable: true, value: 200 });
    Object.defineProperty(panel, "offsetHeight", { configurable: true, value: 240 });
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    // 菜单左上角落在指针下方 8px：原点在面板顶边、横向正是指针所在
    expect(panel.style.left).toBe("300px");
    expect(panel.style.top).toBe("208px");
    expect(panel.style.transformOrigin).toBe("0px 0px");
  });

  it("originTowardAnchor：原点在朝向锚点的那条边上、正对锚点中心，锚点超出面板时夹到端点", () => {
    const panel = { left: 100, top: 300, width: 200, height: 120 };
    expect(originTowardAnchor({ left: 250, top: 260, width: 36, height: 30 }, panel, "bottom")).toBe("168px 0px");
    expect(originTowardAnchor({ left: 250, top: 430, width: 36, height: 30 }, panel, "top")).toBe("168px 120px");
    expect(originTowardAnchor({ left: 20, top: 340, width: 40, height: 40 }, panel, "right")).toBe("0px 60px");
    expect(originTowardAnchor({ left: 320, top: 280, width: 40, height: 10 }, panel, "left")).toBe("200px 0px");
    expect(originTowardAnchor({ left: 900, top: 260, width: 36, height: 30 }, panel, "bottom")).toBe("200px 0px");
  });

  it("enterShift：起点朝锚点一侧偏移", () => {
    expect(enterShift("bottom", 4)).toEqual({ x: 0, y: -4 });
    expect(enterShift("top", 4)).toEqual({ x: 0, y: 4 });
    expect(enterShift("right", 3)).toEqual({ x: -3, y: 0 });
    expect(enterShift("left", 3)).toEqual({ x: 3, y: 0 });
  });

  // 挂载那一帧还不知道会翻侧：入场起点按首选的下方给，翻到上方后面板是从远离锚点的一侧往锚点滑
  it("首选方位放不下而翻到上方：入场从锚点那一侧（下方）滑上来", async () => {
    const restore = stubPanelSize({ width: 300, height: 200 });
    try {
      function Anchored() {
        const [anchor, setAnchor] = useState<HTMLElement | null>(null);
        const [open, setOpen] = useState(false);
        return (
          <>
            <button ref={setAnchor} onClick={() => setOpen(true)}>
              下载
            </button>
            <Popover open={open && anchor !== null} anchor={anchor} onClose={() => undefined} placement="bottom-end" aria-label="下载快览">
              <p>内容</p>
            </Popover>
          </>
        );
      }
      const { container } = mount(<Anchored />);
      setRect(container.querySelector("[data-sk-overlay-root]") as HTMLElement, { left: 0, top: 0, width: 960, height: 720 });
      const anchor = container.querySelector("button") as HTMLButtonElement;
      setRect(anchor, { left: 900, top: 680, width: 36, height: 30 });
      click(anchor, 1);
      const panel = document.querySelector<HTMLElement>('[role="dialog"]') as HTMLElement;
      expect(panel.dataset.side).toBe("top");
      expect(await firstTranslateY(panel)).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });
});

describe("间距与禁用原因", () => {
  const noop = () => undefined;

  /** 把菜单面板放到 960 x 720 的浮层根里、锚点在 (100, 100) 起 36 x 30 处，返回面板。 */
  function placeMenu(container: HTMLElement) {
    const root = container.querySelector("[data-sk-overlay-root]") as HTMLElement;
    const panel = menu()?.parentElement as HTMLElement;
    setRect(root, { left: 0, top: 0, width: 960, height: 720 });
    setRect(trigger(), { left: 100, top: 100, width: 36, height: 30 });
    Object.defineProperty(panel, "offsetWidth", { configurable: true, value: 200 });
    Object.defineProperty(panel, "offsetHeight", { configurable: true, value: 120 });
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    return panel;
  }

  it.each([
    [undefined, 138],
    [0, 130],
    [4, 134],
    [12, 142],
  ] as const)("offset=%s：菜单顶边落在锚点底边 130 之下 %s", (offset, top) => {
    const { container } = mount(<MoreMenu items={entries(noop)} placement="bottom-start" offset={offset} />);
    openMenu(1);
    const panel = placeMenu(container);
    expect(panel.style.left).toBe("100px");
    expect(panel.style.top).toBe(`${top}px`);
  });

  it("禁用项给了原因：指针停留后以提示气泡写明，并经 aria-describedby 关联到该项", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      mount(
        <MoreMenu
          items={[
            { label: "打开实例文件夹", onSelect: noop },
            { label: "重命名", disabled: true, disabledReason: "游戏正在运行，先结束游戏", onSelect: noop },
          ]}
        />,
      );
      openMenu(1);
      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent === "重命名") as HTMLElement;
      expect(item.getAttribute("aria-disabled")).toBe("true");
      act(() => {
        item.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body }));
      });
      act(() => vi.advanceTimersByTime(1000));
      const tip = document.querySelector<HTMLElement>('[role="tooltip"]');
      expect(tip?.textContent).toBe("游戏正在运行，先结束游戏");
      expect(item.getAttribute("aria-describedby")).toBe(tip?.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("没有原因的禁用项与可用项不挂提示气泡", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      mount(<MoreMenu items={entries(noop)} />);
      openMenu(1);
      for (const item of document.querySelectorAll('[role="menuitem"]')) {
        act(() => {
          item.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body }));
        });
      }
      act(() => vi.advanceTimersByTime(1000));
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("菜单形状约束", () => {
  const noop = () => undefined;
  const assertThrows = (items: MenuEntry[], message: string) => {
    vi.spyOn(console, "error").mockImplementation(noop);
    expect(() => mount(<Menu open anchor={document.body} onClose={noop} items={items} openedBy="pointer" aria-label="菜单" />)).toThrow(message);
  };

  it("危险项必须在最后，且前面有分隔线", () => {
    assertThrows([{ label: "删除", danger: true, onSelect: noop }, { label: "复制", onSelect: noop }], "危险项必须集中放在菜单最后");
    assertThrows([{ label: "复制", onSelect: noop }, { label: "删除", danger: true, onSelect: noop }], "危险项前面必须有一条分隔线");
  });

  it("禁用原因只能给禁用项", () => {
    assertThrows([{ label: "重命名", disabledReason: "游戏正在运行", onSelect: noop }], "菜单项「重命名」给了禁用原因却没有禁用");
  });

  it("可操作项不超过 10 个", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => ({ label: `动作 ${i}`, onSelect: noop }));
    assertThrows(eleven, "不能超过 10 个，收到 11 个");
  });

  it("勾选项输出 menuitemradio 与 aria-checked，已选项打勾", () => {
    mount(
      <MenuButton
        items={[
          { label: "最近游玩", checked: true, onSelect: noop },
          { label: "名称", checked: false, onSelect: noop },
        ]}
        trigger={(props) => <Button {...props}>排序</Button>}
      />,
    );
    openMenu(1);
    const radios = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    expect(radios[0].querySelectorAll("svg")).toHaveLength(1);
    expect(radios[1].querySelectorAll("svg")).toHaveLength(0);
  });
});
