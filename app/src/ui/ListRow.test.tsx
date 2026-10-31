// @vitest-environment jsdom
import { act, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { keydown, render, type Rendered } from "../test/dom";
import { IconButton } from "./IconButton";
import { List, ListRow } from "./ListRow";

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
