// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MotionConfig } from "framer-motion";
import { act, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { fade } from "../lib/motion";
import { REFLOW_PAUSED_ATTR } from "../lib/reflow";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { fakeAnimate, keydown, render, setRect, stubResizeObserver, waitForFrames, type Rendered } from "../test/dom";
import { IconButton } from "./IconButton";
import { appendsOnly, EVERY_ROW, List, ListRow, measuredRowWindow, ROW_MOTION_LIMIT, ROW_WINDOW_MARGIN, rowsInWindow, rowWindow } from "./ListRow";

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.restoreAllMocks();
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

const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];

describe("List / ListRow", () => {
  it("ListRow 必须放在 List 里", () => {
    expect(() => mount(<ListRow title="孤行" />)).toThrow(/必须放在 List 里/);
  });

  it("静态行：ul / li，无按钮；档位与排布写到行上", () => {
    const container = mount(
      <List variant="flush">
        <ListRow title="Java 21" meta="Temurin · 64 位" trailing="已装" size="lg" inactive />
      </List>,
    );
    const ul = container.querySelector("ul");
    expect(ul?.dataset.variant).toBe("flush");
    expect(ul?.getAttribute("role")).toBeNull();
    const row = container.querySelector<HTMLElement>("li > div");
    expect(row?.dataset.size).toBe("lg");
    expect(row?.dataset.variant).toBe("flush");
    expect(row?.dataset.inactive).toBe("true");
    expect(row?.hasAttribute("data-interactive")).toBe(false);
    expect(container.querySelector("button")).toBeNull();
    expect(row?.textContent).toBe("Java 21Temurin · 64 位已装");
  });

  it("可点且没有尾部：整行是一个按钮", () => {
    const onClick = vi.fn();
    const container = mount(
      <List>
        <ListRow title="生存 1.21" meta="2 小时前" onClick={onClick} />
      </List>,
    );
    const buttons = container.querySelectorAll("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toBe("生存 1.212 小时前");
    act(() => buttons[0].click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("可点且尾部有操作：标题是按钮，尾部按钮各自触发、不冒泡成打开", () => {
    const open = vi.fn();
    const cancel = vi.fn();
    const container = mount(
      <List>
        <ListRow title="下载 Fabric" size="lg" onClick={open} trailing={<IconButton icon="x" label="取消任务" size="sm" onClick={cancel} />} />
      </List>,
    );
    const [title, action] = [...container.querySelectorAll("button")];
    expect(title.textContent).toBe("下载 Fabric");
    expect(action.getAttribute("aria-label")).toBe("取消任务");
    act(() => action.click());
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    act(() => title.click());
    expect(open).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLElement>("li > div")?.dataset.overlay).toBe("");
  });

  it("禁用的可点行：按钮原生禁用", () => {
    const onClick = vi.fn();
    const container = mount(
      <List>
        <ListRow title="实例正在安装" onClick={onClick} disabled />
      </List>,
    );
    const button = container.querySelector("button");
    expect(button?.disabled).toBe(true);
  });
});

describe("可选择的 List", () => {
  function Picker({ onSelect }: { onSelect?: (v: string) => void }) {
    const [selected, setSelected] = useState<string | null>("b");
    return (
      <List
        aria-label="选择安装目标"
        select={{
          selected,
          onSelect: (v) => {
            setSelected(v);
            onSelect?.(v);
          },
        }}
      >
        <ListRow value="a" title="甲" />
        <ListRow value="b" title="乙" />
        <ListRow value="c" title="丙" disabled />
        <ListRow value="d" title="丁" />
      </List>
    );
  }

  it("listbox 语义：Tab 停在已选项，禁用项不可达", () => {
    const container = mount(<Picker />);
    expect(container.querySelector("ul")?.getAttribute("role")).toBe("listbox");
    expect(container.querySelector("ul")?.getAttribute("aria-label")).toBe("选择安装目标");
    expect(options().map((o) => [o.dataset.value, o.tabIndex, o.getAttribute("aria-selected")])).toEqual([
      ["a", -1, "false"],
      ["b", 0, "true"],
      ["c", -1, "false"],
      ["d", -1, "false"],
    ]);
    expect(options()[2].getAttribute("aria-disabled")).toBe("true");
  });

  it("↓ 跳过禁用项，Home / End 到首尾，焦点与 Tab 停点一起移动", () => {
    mount(<Picker />);
    act(() => options()[1].focus());
    keydown(options()[1], "ArrowDown");
    expect(document.activeElement).toBe(options()[3]);
    expect(options()[3].tabIndex).toBe(0);
    expect(options()[1].tabIndex).toBe(-1);
    keydown(options()[3], "ArrowDown");
    expect(document.activeElement).toBe(options()[3]);
    keydown(options()[3], "Home");
    expect(document.activeElement).toBe(options()[0]);
    keydown(options()[0], "ArrowUp");
    expect(document.activeElement).toBe(options()[0]);
    keydown(options()[0], "End");
    expect(document.activeElement).toBe(options()[3]);
  });

  it("Enter 与 Space 选中当前项，点击也选中；禁用项点击无效", () => {
    const onSelect = vi.fn();
    mount(<Picker onSelect={onSelect} />);
    act(() => options()[0].focus());
    const enter = keydown(options()[0], "Enter");
    expect(enter.defaultPrevented).toBe(true);
    expect(onSelect).toHaveBeenLastCalledWith("a");
    expect(options()[0].getAttribute("aria-selected")).toBe("true");
    keydown(options()[0], "ArrowDown");
    keydown(options()[1], " ");
    expect(onSelect).toHaveBeenLastCalledWith("b");
    act(() => options()[3].click());
    expect(onSelect).toHaveBeenLastCalledWith("d");
    act(() => options()[2].click());
    expect(onSelect).toHaveBeenCalledTimes(3);
  });

  it("没有已选项时 Tab 停在第一个可用项", () => {
    mount(
      <List aria-label="账户" select={{ selected: null, onSelect: () => undefined }}>
        <ListRow value="x" title="禁用" disabled />
        <ListRow value="y" title="可用" />
      </List>,
    );
    expect(options().map((o) => o.tabIndex)).toEqual([-1, 0]);
  });

  it("退场中的选项不再是键盘的落点：↓ 越过它", () => {
    let setShown: (values: string[]) => void = () => undefined;
    function Shrinking() {
      const [shown, set] = useState(["a", "b", "c"]);
      setShown = set;
      return (
        <List aria-label="目标" select={{ selected: "a", onSelect: () => undefined }}>
          {shown.map((v) => (
            <ListRow key={v} value={v} title={v} />
          ))}
        </List>
      );
    }
    mount(<Shrinking />);
    act(() => options()[0].focus());
    act(() => setShown(["a", "c"]));
    expect(options().map((o) => [o.dataset.value, o.hasAttribute("inert")])).toEqual([
      ["a", false],
      ["b", true],
      ["c", false],
    ]);
    keydown(options()[0], "ArrowDown");
    expect(document.activeElement).toBe(options()[2]);
  });

  it("可选择列表缺名称、缺 value、用了 onClick 都抛错", () => {
    expect(() =>
      mount(
        <List select={{ selected: null, onSelect: () => undefined }}>
          <ListRow value="a" title="甲" />
        </List>,
      ),
    ).toThrow(/aria-label/);
    view?.unmount();
    expect(() =>
      mount(
        <List aria-label="x" select={{ selected: null, onSelect: () => undefined }}>
          <ListRow title="甲" />
        </List>,
      ),
    ).toThrow(/必须有 value/);
    view?.unmount();
    expect(() =>
      mount(
        <List aria-label="x" select={{ selected: null, onSelect: () => undefined }}>
          <ListRow value="a" title="甲" onClick={() => undefined} />
        </List>,
      ),
    ).toThrow(/不用 onClick/);
  });
});

describe("行的增删", () => {
  interface Item {
    id: string;
    name: string;
  }
  const ITEMS: Item[] = [
    { id: "a", name: "甲" },
    { id: "b", name: "乙" },
    { id: "c", name: "丙" },
  ];
  let setItems: (next: Item[]) => void = () => undefined;

  /** 页面常见的写法：行被自己的组件包着，列表的直接子项不是 ListRow。 */
  function TaskRow({ item }: { item: Item }) {
    return <ListRow title={item.name} meta="进行中" />;
  }

  function Changing({ initial }: { initial: Item[] }) {
    const [items, set] = useState(initial);
    setItems = set;
    return (
      <List variant="flush">
        {items.map((item) => (
          <TaskRow key={item.id} item={item} />
        ))}
      </List>
    );
  }

  const items = () => [...document.querySelectorAll<HTMLElement>("ul > li")];

  it("挂载时就在的行不播入场，之后新增的行从透明处淡入", () => {
    mount(<Changing initial={ITEMS.slice(0, 2)} />);
    expect(items().map((li) => li.style.opacity)).toEqual(["1", "1"]);
    act(() => setItems(ITEMS));
    expect(items().map((li) => [li.textContent, li.style.opacity])).toEqual([
      ["甲进行中", "1"],
      ["乙进行中", "1"],
      ["丙进行中", "0"],
    ]);
  });

  const batch = (prefix: string, count: number): Item[] => Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, name: `${prefix}${i}` }));
  const liveItems = () => items().filter((li) => !li.hasAttribute("inert"));

  it(`换了一批、一次来了超过 ${ROW_MOTION_LIMIT} 行：新行只淡入，已在场的行不跟着闪，这一趟让位暂停；之后不超过时照常逐行入场`, () => {
    const many = batch("多", ROW_MOTION_LIMIT + 1);
    const more = batch("再", ROW_MOTION_LIMIT);
    mount(<Changing initial={ITEMS} />);
    const list = document.querySelector("ul") as HTMLElement;
    // 暂停开关的每一次增删：让位的观察者把同一批记录里出现过开关的那一趟按暂停处理
    const toggles = new MutationObserver(() => undefined);
    toggles.observe(list, { attributes: true, attributeFilter: [REFLOW_PAUSED_ATTR], attributeOldValue: true });
    onTestFinished(() => toggles.disconnect());
    act(() => setItems([ITEMS[0], ...many]));
    // 整个列表不再压到透明：留下来的那一行一直是不透明的
    expect(list.style.opacity).toBe("");
    // 提交时打上又撤掉：暂停只盖住这一批，不留到之后
    expect(toggles.takeRecords().map((record) => record.oldValue)).toEqual([null, ""]);
    expect(list.hasAttribute(REFLOW_PAUSED_ATTR)).toBe(false);
    const swapped = liveItems();
    expect(swapped[0].textContent).toBe("甲进行中");
    expect(swapped[0].style.opacity).toBe("1");
    // 新行只从透明淡入，不从略小处落位
    expect(swapped.slice(1).map((li) => [li.style.opacity, li.style.transform])).toEqual(Array(many.length).fill(["0", ""]));
    act(() => setItems([ITEMS[0], ...many, ...more]));
    expect(toggles.takeRecords()).toEqual([]);
    const appended = liveItems().slice(many.length + 1);
    expect(appended.map((li) => [li.style.opacity, li.style.transform])).toEqual(Array(more.length).fill(["0", "scale(0.98)"]));
  });

  it("换了一批时让位只暂停那一趟：紧接着删掉一行，其后的行照常从原位置滑上去", async () => {
    // jsdom 不做布局、没有 ResizeObserver 与 Web Animations：每行 56 高，按在流里的先后排开，被 popLayout 抽出去的行留在原位；
    // 让位起的动画记在 played 里
    const ROW = 56;
    const sizes = stubResizeObserver();
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const played: { el: Element; frames: Keyframe[] }[] = [];
    for (const proto of [HTMLUListElement.prototype, HTMLLIElement.prototype]) {
      Object.defineProperty(proto, "animate", {
        configurable: true,
        writable: true,
        value: fakeAnimate((el, frames) => played.push({ el, frames })),
      });
      onTestFinished(() => {
        Reflect.deleteProperty(proto, "animate");
      });
    }
    const tops = new WeakMap<Element, number>();
    const topOf = (el: HTMLElement): number => {
      if (el.tagName !== "LI") return 0;
      const list = el.parentElement;
      if (list === null) throw new Error("行不在列表里");
      if (el.dataset.motionPopId === undefined) {
        const flow = [...list.children].filter((li) => li instanceof HTMLElement && li.dataset.motionPopId === undefined);
        tops.set(el, flow.indexOf(el) * ROW);
      }
      const top = tops.get(el);
      if (top === undefined) throw new Error("抽出布局的行没有量过位置");
      return top;
    };
    vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockImplementation(function (this: HTMLElement) {
      return this.tagName === "LI" ? this.parentElement : document.body;
    });
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
      return topOf(this);
    });
    vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockReturnValue(0);
    // popLayout 量得到行的尺寸才把退场的行钉成绝对定位
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element, pseudo?: string | null) => {
      const style = real(el, pseudo);
      if (el.tagName !== "LI") return style;
      return new Proxy(style, {
        get(target, prop) {
          if (prop === "height") return `${ROW}px`;
          if (prop === "width") return "320px";
          const value: unknown = Reflect.get(target, prop, target);
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });
    });
    const many = batch("多", ROW_MOTION_LIMIT + 1);
    mount(<Changing initial={ITEMS} />);
    const list = document.querySelector("ul") as HTMLElement;
    // 第一趟只记位置
    sizes.resize(list, 320);
    act(() => setItems([ITEMS[0], ...many]));
    // 增删的记录在微任务里交给让位
    await Promise.resolve();
    expect(played).toEqual([]);
    // 删掉留下来的那一行：其后每行上移一行
    act(() => setItems(many));
    await Promise.resolve();
    const first = liveItems()[0];
    expect(first.textContent).toBe("多0进行中");
    expect(played.filter((p) => p.el === first).map((p) => p.frames[0].translate)).toEqual([`0px ${ROW}px`]);
  });

  it(`原先一行也没有、一次来了超过 ${ROW_MOTION_LIMIT} 行：整个列表淡入一次，行不各自起动画`, () => {
    const played: { frames: Keyframe[]; options: KeyframeAnimationOptions }[] = [];
    Object.defineProperty(HTMLUListElement.prototype, "animate", {
      configurable: true,
      writable: true,
      value: fakeAnimate((_el, frames, options) => played.push({ frames, options })),
    });
    onTestFinished(() => {
      Reflect.deleteProperty(HTMLUListElement.prototype, "animate");
    });
    const many = batch("多", ROW_MOTION_LIMIT + 1);
    mount(<Changing initial={[]} />);
    act(() => setItems(many));
    expect(items().map((li) => li.style.opacity)).toEqual(Array(many.length).fill("1"));
    expect(played.map((p) => p.frames)).toEqual([[{ opacity: 0 }, { opacity: 1 }]]);
    expect(played[0].options.duration).toBe(fade.in.duration * 1000);
    expect(played[0].options.easing).toContain(fade.in.ease.join(", "));
  });

  it("换了一批时被换掉的行直接拿掉，不在原处与落到同一位置的新行叠着淡出", async () => {
    mount(<Changing initial={ITEMS} />);
    act(() => setItems([ITEMS[0], ...batch("多", ROW_MOTION_LIMIT + 1)]));
    // 平常的淡出要 fade.out 那么久；这里下一帧就拿掉了
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(items().filter((li) => li.hasAttribute("inert"))).toEqual([]);
    expect(items()).toHaveLength(ROW_MOTION_LIMIT + 2);
  });

  it(`在末尾一次追加超过 ${ROW_MOTION_LIMIT} 行：已有的行不跟着淡入，新行里只有可见范围附近的播入场`, () => {
    const many = batch("多", ROW_MOTION_LIMIT + 1);
    mount(<Changing initial={ITEMS.slice(0, 1)} />);
    const list = document.querySelector("ul") as HTMLElement;
    // 一行 56 高、列表顶在视口最上沿：768 高的视口里露出第 0 到 13 行，再多留 4 行，第 0 到 17 行算在范围内
    expect(window.innerHeight).toBe(768);
    setRect(list, { left: 0, top: 0, width: 320, height: 56 });
    setRect(items()[0], { left: 0, top: 0, width: 320, height: 56 });
    // 追加不算换了一批：让位不暂停，暂停开关一次也不动
    const toggles = new MutationObserver(() => undefined);
    toggles.observe(list, { attributes: true, attributeFilter: [REFLOW_PAUSED_ATTR] });
    onTestFinished(() => toggles.disconnect());
    act(() => setItems([ITEMS[0], ...many]));
    expect(list.style.opacity).toBe("");
    expect(toggles.takeRecords()).toEqual([]);
    const opacities = items().map((li) => li.style.opacity);
    expect(opacities[0]).toBe("1");
    expect(opacities.slice(1, 18)).toEqual(Array(17).fill("0"));
    expect(opacities.slice(18)).toEqual(Array(many.length - 17).fill("1"));
  });

  it("行高不一：按每一行实际的位置找可见范围，不按平均行距估，视口顶上插进来的新行照样播入场", () => {
    const rows = batch("行", 40);
    mount(<Changing initial={rows} />);
    // 前 5 行各 200 高（带进度的大行），已滚出视口上方；其后 35 行各 56 高，从视口顶端排起，露出来的是第 5 到 18 行。
    // 按平均行距（2960 / 40 = 74）估，露出来的会被算成第 13 行起，插在第 5 行（视口顶端）的新行落在余量之外
    const list = document.querySelector("ul") as HTMLElement;
    setRect(list, { left: 0, top: -1000, width: 320, height: 2960 });
    items().forEach((li, i) => setRect(li, { left: 0, top: i < 5 ? -1000 + 200 * i : 56 * (i - 5), width: 320, height: i < 5 ? 200 : 56 }));
    const near = { id: "near", name: "近" };
    const far = { id: "far", name: "远" };
    act(() => setItems([...rows.slice(0, 5), near, ...rows.slice(5), far]));
    const opacityOf = (name: string) => items().find((li) => li.textContent === `${name}进行中`)?.style.opacity;
    expect(opacityOf("近")).toBe("0");
    expect(opacityOf("远")).toBe("1");
  });

  it("减少动画时新增的行只淡入，不从略小处落位", () => {
    view = render(
      <MotionConfig reducedMotion="always">
        <Changing initial={ITEMS.slice(0, 2)} />
      </MotionConfig>,
    );
    act(() => setItems(ITEMS));
    const added = items()[2];
    expect([added.style.opacity, added.style.transform]).toEqual(["0", ""]);
  });

  it("移除一行：它留在原处淡出，这段时间不可交互，放完后才离开文档", async () => {
    mount(<Changing initial={ITEMS} />);
    act(() => setItems([ITEMS[0], ITEMS[2]]));
    expect(items().map((li) => [li.textContent, li.hasAttribute("inert")])).toEqual([
      ["甲进行中", false],
      ["乙进行中", true],
      ["丙进行中", false],
    ]);
    await waitForFrames(() => {
      expect(items().map((li) => li.textContent)).toEqual(["甲进行中", "丙进行中"]);
    });
  });

  it("行被页面的组件包着也能把退场的行抽出布局：presence 塞的 ref 落到行的 li 上", () => {
    // jsdom 不做布局：给 li 一个尺寸，popLayout 才会把它钉成绝对定位
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element, pseudo?: string | null) => {
      const style = real(el, pseudo);
      if (el.tagName !== "LI") return style;
      return new Proxy(style, {
        get(target, prop) {
          if (prop === "height") return "56px";
          if (prop === "width") return "320px";
          const value: unknown = Reflect.get(target, prop, target);
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });
    });
    mount(<Changing initial={ITEMS} />);
    act(() => setItems([ITEMS[0], ITEMS[2]]));
    const leaving = items().find((li) => li.hasAttribute("inert"));
    expect(leaving?.textContent).toBe("乙进行中");
    expect(leaving?.dataset.motionPopId).toBeDefined();
    expect(items().filter((li) => li.dataset.motionPopId !== undefined)).toHaveLength(1);
  });

  it("连点两下：第二下落在正退场的行上不再触发", () => {
    const picked = vi.fn();
    let setShown: (next: string[]) => void = () => undefined;
    function Picker() {
      const [shown, set] = useState(["a", "b"]);
      setShown = set;
      return (
        <List>
          {shown.map((v) => (
            <ListRow
              key={v}
              title={v}
              onClick={() => {
                picked(v);
                setShown(shown.filter((s) => s !== v));
              }}
            />
          ))}
        </List>
      );
    }
    mount(<Picker />);
    const first = document.querySelector("ul > li > button") as HTMLButtonElement;
    act(() => first.click());
    act(() => first.click());
    expect(picked.mock.calls).toEqual([["a"]]);
    expect(first.closest("li")?.hasAttribute("inert")).toBe(true);
  });

  it("直接放文字是装配错误", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => mount(<List>{"孤零零的字"}</List>)).toThrow(/不能直接放文字/);
  });
});

describe("可见范围（List 与 Table 共用）", () => {
  it("等距的行里落在可见带之内的行号，上下各多留几行；半行露出来也算", () => {
    // 第 0 行上沿在 -640、行距 64、可见带 0 到 640：露出来的是第 10 到 19 行
    expect(rowWindow(-640, 0, 640, 64)).toEqual({ first: 10 - ROW_WINDOW_MARGIN, last: 19 + ROW_WINDOW_MARGIN });
    // 往回 40：第 9 行露出下半截
    expect(rowWindow(-600, 0, 640, 64)).toEqual({ first: 9 - ROW_WINDOW_MARGIN, last: 19 + ROW_WINDOW_MARGIN });
    // 整块在可见带下方远处：范围里没有行号不小于 0 的行
    expect(rowWindow(2000, 0, 640, 64).last).toBeLessThan(0);
    expect(() => rowWindow(0, 0, 640, 0)).toThrow(/行距/);
  });

  it("按每行实际上下沿找可见范围：等高时与按行距算的一致，越过首末行的部分按行距推算；高矮不一时不累积偏差", () => {
    const even = (top: number, pitch: number) => (i: number) => ({ top: top + i * pitch, bottom: top + (i + 1) * pitch });
    // 等高的行：首尾都在可见带里、整块在可见带下方、整块已滚出上方，三种都与 rowWindow 同口径
    for (const top of [-640, -600, 0, 100, 2000, -5000]) {
      expect(measuredRowWindow(30, even(top, 64), 0, 640, 64)).toEqual(rowWindow(top, 0, 640, 64));
    }
    // 前 5 行各 200 高、已滚出上方，之后各 56 高从可见带顶端排起：露出来的是第 5 到 16 行
    const tall = (i: number) => (i < 5 ? { top: -1000 + 200 * i, bottom: -800 + 200 * i } : { top: 56 * (i - 5), bottom: 56 * (i - 4) });
    expect(measuredRowWindow(20, tall, 0, 640, 92)).toEqual({ first: 5 - ROW_WINDOW_MARGIN, last: 16 + ROW_WINDOW_MARGIN });
    // 末行之下还有可见的空：末尾追加的行按行距推下去
    expect(measuredRowWindow(20, tall, 0, 1000, 92)).toEqual({ first: 5 - ROW_WINDOW_MARGIN, last: 19 + Math.ceil((1000 - 840) / 92) + ROW_WINDOW_MARGIN });
    expect(() => measuredRowWindow(0, tall, 0, 640, 92)).toThrow(/行数/);
  });

  it("只在末尾追加：上一次的行都在、原样排在最前面；首次填充、插在中间、删行都不算", () => {
    expect(appendsOnly(["a", "b"], ["a", "b", "c"])).toBe(true);
    expect(appendsOnly(["a", "b"], ["x", "a", "b"])).toBe(false);
    expect(appendsOnly(["a", "b"], ["a", "x", "b"])).toBe(false);
    expect(appendsOnly(["a", "b"], ["a", "b"])).toBe(false);
    expect(appendsOnly(["a", "b"], ["a"])).toBe(false);
    expect(appendsOnly([], ["a"])).toBe(false);
  });

  it("要逐行动画的行：新行看新位置，被挤动的行看旧位置或新位置，落在范围内才算", () => {
    const keys = Array.from({ length: 30 }, (_, i) => `k${i}`);
    const range = { first: 5, last: 12 };
    // 删掉第 0 行：k5 到 k13 的旧位置或新位置在 5 到 12 之内
    const removed = rowsInWindow(keys, keys.slice(1), range);
    expect([...removed.moving]).toEqual(keys.slice(5, 14));
    expect(removed.entering.size).toBe(0);
    // 新行一个插在第 6 位、一个插在第 26 位：只有前一个在范围内
    const inserted = rowsInWindow(keys, [...keys.slice(0, 6), "near", ...keys.slice(6, 25), "far", ...keys.slice(25)], range);
    expect([...inserted.entering]).toEqual(["near"]);
    // 没有布局可量时按每一行都在范围内
    expect(rowsInWindow(keys, keys.slice(1), EVERY_ROW).moving.size).toBe(29);
  });
});

describe("ListRow 样式", () => {
  const strip = (text: string) => text.replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "");
  const css = strip(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "ListRow.module.css"), "utf8"));
  const rule = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 换行前是逗号的是组合选择器的后半截，不当成独立的规则
    const match = new RegExp(`(?<!,)(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(css);
    if (match === null) throw new Error(`没有 ${selector} 规则`);
    return match[1];
  };

  it("悬停底色不带过渡，只有选中底色淡入；按下换深一档底色且瞬时", () => {
    expect(rule(".row")).not.toMatch(/transition/);
    expect(rule(".row[data-interactive]:hover")).not.toMatch(/transition/);
    expect(rule(".row[data-selected],\n.row[data-selected]:hover")).toMatch(/transition: background-color var\(--sk-dur-hover\)/);
    expect(rule(".row[data-interactive]:not([data-overlay], [data-disabled]):active,\n.row[data-overlay]:has(.titleButton:active)")).toMatch(
      /background: var\(--sk-bg-3\);\s*transition: none;/,
    );
  });

  it("贴边列表的分隔线不算退场中的行；列表是退场行的定位基准", () => {
    expect(rule('.list[data-variant="flush"] > .item:not([inert]) ~ .item:not([inert])')).toMatch(/border-top: 1px solid var\(--sk-line\);/);
    expect(rule(".list")).toMatch(/position: relative;/);
  });
});
