// @vitest-environment jsdom
import { act, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { keydown, render, stubResizeObserver, type Rendered } from "../test/dom";
import { columnTemplate, nextSort, selectionState, Table, validateColumns, VIRTUALIZE_ABOVE, type TableColumn, type TableSort } from "./Table";

interface Mod {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
}

const MODS: Mod[] = [
  { id: "sodium", name: "Sodium", version: "0.6.13", enabled: true },
  { id: "lithium", name: "Lithium", version: "0.14.3", enabled: false },
  { id: "iris", name: "Iris", version: "1.8.1", enabled: true },
];

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

const rows = () => [...document.querySelectorAll<HTMLElement>('[role="rowgroup"] + [role="rowgroup"] > [role="row"]')];

function columns(onRemove: (id: string) => void = () => undefined): TableColumn<Mod>[] {
  return [
    {
      key: "select",
      width: 40,
      align: "center",
      header: ({ selection, toggleAll }) => (
        <button type="button" data-select-all={selection} onClick={toggleAll}>
          全选
        </button>
      ),
      cell: (_mod, { selected, toggleSelected }) => (
        <button type="button" aria-pressed={selected} onClick={toggleSelected}>
          选择
        </button>
      ),
    },
    { key: "name", header: "Mod", minWidth: 260, sortable: true, cell: (mod) => mod.name },
    { key: "version", header: "版本", width: 150, tiers: ["regular", "wide"], cell: (mod) => mod.version },
    {
      key: "actions",
      header: "操作",
      width: 96,
      keepOpaque: true,
      align: "end",
      cell: (mod) => (
        <button type="button" onClick={() => onRemove(mod.id)}>
          移除
        </button>
      ),
    },
  ];
}

function Harness({ onActivate, onRemove, initial = [] }: { onActivate?: (mod: Mod) => void; onRemove?: (id: string) => void; initial?: string[] }) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set(initial));
  const [sort, setSort] = useState<TableSort | null>({ key: "name", direction: "asc" });
  return (
    <Table
      label="已装 Mod"
      columns={columns(onRemove)}
      rows={MODS}
      rowKey={(m) => m.id}
      onActivate={onActivate}
      selection={{ selected, onChange: setSelected }}
      sort={sort}
      onSortChange={setSort}
      isInactive={(m) => !m.enabled}
      empty={<span>没有 Mod</span>}
    />
  );
}

describe("列定义", () => {
  it("按档生成列模板：固定列像素宽，弹性列按最小宽分剩余空间，隐藏列不占位", () => {
    const cols = columns();
    expect(columnTemplate(cols, "compact")).toBe("40px minmax(260px, 1fr) 96px");
    expect(columnTemplate(cols, "regular")).toBe("40px minmax(260px, 1fr) 150px 96px");
    expect(columnTemplate(cols, "wide")).toBe("40px minmax(260px, 1fr) 150px 96px");
  });

  it("key 重复、宽度非正、tiers 为空、某档没有列都抛错", () => {
    const base = { header: "x", cell: () => "x" };
    expect(() => validateColumns([{ ...base, key: "a" }, { ...base, key: "a" }])).toThrow(/重复/);
    expect(() => validateColumns([{ ...base, key: "a", width: 0 }])).toThrow(/正数/);
    expect(() => validateColumns([{ ...base, key: "a", tiers: [] }])).toThrow(/不能为空/);
    expect(() => validateColumns([{ ...base, key: "a", tiers: ["wide"] }])).toThrow(/compact 档没有可见的列/);
  });

  it("全选三态与排序推演", () => {
    expect(selectionState(new Set(), ["a", "b"])).toBe("none");
    expect(selectionState(new Set(["a"]), ["a", "b"])).toBe("some");
    expect(selectionState(new Set(["a", "b", "zombie"]), ["a", "b"])).toBe("all");
    expect(nextSort({ key: "name", direction: "asc" }, "name")).toEqual({ key: "name", direction: "desc" });
    expect(nextSort({ key: "name", direction: "desc" }, "name")).toEqual({ key: "name", direction: "asc" });
    expect(nextSort({ key: "name", direction: "desc" }, "source")).toEqual({ key: "source", direction: "asc" });
    expect(nextSort(null, "name")).toEqual({ key: "name", direction: "asc" });
  });

  it("有可排序列却没给 onSortChange 时抛错", () => {
    expect(() =>
      mount(<Table label="x" columns={[{ key: "n", header: "名", sortable: true, cell: () => "x" }]} rows={[]} rowKey={() => "x"} empty="空" />),
    ).toThrow(/onSortChange/);
  });
});

describe("Table 结构", () => {
  it("grid 语义；文字单元格单行省略；分档隐藏的列打上标记", () => {
    mount(<Harness />);
    const grid = document.querySelector('[role="grid"]') as HTMLElement;
    expect(grid.getAttribute("aria-label")).toBe("已装 Mod");
    expect(grid.getAttribute("aria-multiselectable")).toBe("true");
    expect(grid.style.getPropertyValue("--table-cols-compact")).toBe("40px minmax(260px, 1fr) 96px");
    expect(grid.style.getPropertyValue("--table-row")).toBe("64px");
    expect(rows()).toHaveLength(3);
    const versionCell = rows()[0].querySelectorAll<HTMLElement>('[role="gridcell"]')[2];
    expect(versionCell.dataset.hideCompact).toBe("");
    expect(versionCell.hasAttribute("data-hide-regular")).toBe(false);
    expect(versionCell.querySelector("span")?.textContent).toBe("0.6.13");
    expect(rows()[1].dataset.inactive).toBe("");
    expect(rows()[0].hasAttribute("data-inactive")).toBe(false);
    expect(rows()[1].querySelectorAll<HTMLElement>('[role="gridcell"]')[3].dataset.keep).toBe("");
  });

  it("空表在表体里放空状态", () => {
    mount(<Table label="x" columns={columns()} rows={[]} rowKey={(m) => m.id} empty={<span>没有 Mod</span>} onSortChange={() => undefined} />);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].textContent).toBe("没有 Mod");
  });

  it("rowKey 重复时抛错", () => {
    expect(() => mount(<Table label="x" columns={columns()} rows={[MODS[0], MODS[0]]} rowKey={(m) => m.id} empty="空" onSortChange={() => undefined} />)).toThrow(/唯一/);
  });
});

describe("Table 键盘", () => {
  it("只有当前行在 Tab 序列里；↑↓ / Home / End 移动当前行并聚焦", () => {
    mount(<Harness />);
    expect(rows().map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    act(() => rows()[0].focus());
    keydown(rows()[0], "ArrowDown");
    expect(document.activeElement).toBe(rows()[1]);
    expect(rows().map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
    keydown(rows()[1], "End");
    expect(document.activeElement).toBe(rows()[2]);
    keydown(rows()[2], "ArrowDown");
    expect(document.activeElement).toBe(rows()[2]);
    keydown(rows()[2], "Home");
    expect(document.activeElement).toBe(rows()[0]);
    keydown(rows()[0], "ArrowUp");
    expect(document.activeElement).toBe(rows()[0]);
  });

  it("非当前行的行内控件退出 Tab 序列，当前行换了就换回来", () => {
    mount(<Harness />);
    const controls = (i: number) => [...rows()[i].querySelectorAll("button")];
    expect(controls(0).map((b) => b.getAttribute("tabindex"))).toEqual([null, null]);
    expect(controls(1).map((b) => b.getAttribute("tabindex"))).toEqual(["-1", "-1"]);
    act(() => rows()[0].focus());
    keydown(rows()[0], "ArrowDown");
    expect(controls(0).map((b) => b.getAttribute("tabindex"))).toEqual(["-1", "-1"]);
    expect(controls(1).map((b) => b.getAttribute("tabindex"))).toEqual([null, null]);
  });

  it("Enter 执行行的主动作，Space 切换行选择", () => {
    const onActivate = vi.fn();
    mount(<Harness onActivate={onActivate} />);
    act(() => rows()[1].focus());
    const enter = keydown(rows()[1], "Enter");
    expect(enter.defaultPrevented).toBe(true);
    expect(onActivate).toHaveBeenCalledWith(MODS[1]);
    const space = keydown(rows()[1], " ");
    expect(space.defaultPrevented).toBe(true);
    expect(rows()[1].getAttribute("aria-selected")).toBe("true");
    expect(rows()[1].dataset.selected).toBe("true");
    keydown(rows()[1], " ");
    expect(rows()[1].getAttribute("aria-selected")).toBe("false");
  });

  it("按键来自行内控件时不当作行的操作", () => {
    const onActivate = vi.fn();
    mount(<Harness onActivate={onActivate} />);
    const remove = rows()[0].querySelectorAll("button")[1];
    keydown(remove, "Enter");
    keydown(remove, "ArrowDown");
    expect(onActivate).not.toHaveBeenCalled();
    expect(rows()[0].tabIndex).toBe(0);
  });

  it("点击行内控件只触发控件，点击行的其他位置执行主动作", () => {
    const onActivate = vi.fn();
    const onRemove = vi.fn();
    mount(<Harness onActivate={onActivate} onRemove={onRemove} />);
    act(() => rows()[2].querySelectorAll("button")[1].click());
    expect(onRemove).toHaveBeenCalledWith("iris");
    expect(onActivate).not.toHaveBeenCalled();
    act(() => rows()[2].querySelectorAll<HTMLElement>('[role="gridcell"]')[1].click());
    expect(onActivate).toHaveBeenCalledWith(MODS[2]);
  });
});

describe("Table 选择与排序", () => {
  it("全选框三态：none → 全选 → 全不选；部分选中时为 some", () => {
    mount(<Harness initial={["iris"]} />);
    const all = () => document.querySelector<HTMLButtonElement>("[data-select-all]") as HTMLButtonElement;
    expect(all().dataset.selectAll).toBe("some");
    act(() => all().click());
    expect(all().dataset.selectAll).toBe("all");
    expect(rows().map((r) => r.getAttribute("aria-selected"))).toEqual(["true", "true", "true"]);
    act(() => all().click());
    expect(all().dataset.selectAll).toBe("none");
    act(() => rows()[0].querySelector("button")?.click());
    expect(all().dataset.selectAll).toBe("some");
  });

  it("可排序表头是按钮，aria-sort 跟随状态，点击翻转方向", () => {
    mount(<Harness />);
    const header = () => document.querySelectorAll<HTMLElement>('[role="columnheader"]')[1];
    expect(header().getAttribute("aria-sort")).toBe("ascending");
    expect(document.querySelectorAll<HTMLElement>('[role="columnheader"]')[2].hasAttribute("aria-sort")).toBe(false);
    act(() => header().querySelector("button")?.click());
    expect(header().getAttribute("aria-sort")).toBe("descending");
    expect(header().querySelector("svg")).not.toBeNull();
  });
});

describe("Table 虚拟化", () => {
  it(`超过 ${VIRTUALIZE_ABOVE} 行只渲染可视范围，并标出总行数与行号`, () => {
    stubResizeObserver();
    const clientHeight = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "grid" ? 440 : 0;
    });
    const many: Mod[] = Array.from({ length: 300 }, (_, i) => ({ id: `m${i}`, name: `Mod ${i}`, version: "1.0.0", enabled: true }));
    mount(<Table label="大列表" columns={columns()} rows={many} rowKey={(m) => m.id} density="compact" empty="空" onSortChange={() => undefined} />);
    const grid = document.querySelector('[role="grid"]') as HTMLElement;
    expect(grid.getAttribute("aria-rowcount")).toBe("301");
    const rendered = rows();
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(40);
    expect(rendered[0].getAttribute("aria-rowindex")).toBe("2");
    expect(rendered[1].style.transform).toBe("translateY(44px)");
    expect((document.querySelector('[role="rowgroup"] + [role="rowgroup"]') as HTMLElement).style.height).toBe(`${300 * 44}px`);
    expect(rendered[0].tabIndex).toBe(0);
    clientHeight.mockRestore();
  });

  it(`不超过 ${VIRTUALIZE_ABOVE} 行全部渲染，不写行号`, () => {
    const some: Mod[] = Array.from({ length: VIRTUALIZE_ABOVE }, (_, i) => ({ id: `m${i}`, name: `Mod ${i}`, version: "1.0.0", enabled: true }));
    mount(<Table label="列表" columns={columns()} rows={some} rowKey={(m) => m.id} empty="空" onSortChange={() => undefined} />);
    expect(rows()).toHaveLength(VIRTUALIZE_ABOVE);
    expect(rows()[0].hasAttribute("aria-rowindex")).toBe(false);
    expect(document.querySelector('[role="grid"]')?.hasAttribute("aria-rowcount")).toBe(false);
  });
});
