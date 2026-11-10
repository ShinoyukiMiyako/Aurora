// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { keydown, render, waitForFrames, type Rendered } from "../test/dom";
import { IconButton } from "./IconButton";
import { List, ListRow, ROW_MOTION_LIMIT } from "./ListRow";

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

  it(`一次新增超过 ${ROW_MOTION_LIMIT} 行：行不逐个入场，整个列表淡入一次；不超过时照常逐行入场`, async () => {
    const batch = (prefix: string, count: number): Item[] => Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, name: `${prefix}${i}` }));
    const many = batch("多", ROW_MOTION_LIMIT + 1);
    const more = batch("再", ROW_MOTION_LIMIT);
    mount(<Changing initial={ITEMS.slice(0, 1)} />);
    const list = document.querySelector("ul") as HTMLElement;
    act(() => setItems([ITEMS[0], ...many]));
    expect(list.style.opacity).toBe("0");
    expect(items().map((li) => li.style.opacity)).toEqual(Array(1 + many.length).fill("1"));
    await waitForFrames(() => expect(list.style.opacity).toBe("1"));
    act(() => setItems([ITEMS[0], ...many, ...more]));
    expect(list.style.opacity).toBe("1");
    expect(items().map((li) => li.style.opacity)).toEqual([...Array(1 + many.length).fill("1"), ...Array(more.length).fill("0")]);
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
