// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { motion } from "framer-motion";
import { act, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { keydown, render, setRect, stubResizeObserver, waitForFrames, type Rendered } from "../test/dom";
import {
  columnTemplate,
  nextSort,
  rowChurn,
  rowShift,
  selectionState,
  swapsWholeTable,
  Table,
  validateColumns,
  visibleColumns,
  VIRTUALIZE_ABOVE,
  type TableColumn,
  type TableSort,
} from "./Table";

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

/** 行集合可从外面换：增删、排序时表格怎么过渡。 */
let setShownRows: (next: readonly Mod[]) => void;

function Changing({ initial }: { initial: readonly Mod[] }) {
  const [shown, setShown] = useState(initial);
  setShownRows = setShown;
  return <Table label="已装 Mod" columns={columns()} rows={shown} rowKey={(m) => m.id} onSortChange={() => undefined} empty={<span>没有 Mod</span>} />;
}

const someMods = (n: number): Mod[] => Array.from({ length: n }, (_, i) => ({ id: `mod-${i}`, name: `Mod ${i}`, version: "1", enabled: true }));

const waitFrames = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });

describe("行的增删", () => {
  it("一次变化涉及多少行：增删的行数，集合没变时是换了位置的行数；其余行让位不算", () => {
    const keys = someMods(50).map((m) => m.id);
    expect(rowChurn(keys, keys)).toBe(0);
    expect(rowChurn(keys, keys.filter((k) => !["mod-0", "mod-1", "mod-2"].includes(k)))).toBe(3);
    expect(rowChurn(keys, [...keys, "new"])).toBe(1);
    expect(rowChurn(keys, [...keys.slice(1), "new"])).toBe(2);
    expect(rowChurn(keys, [...keys].reverse())).toBe(50);
    expect(rowChurn(["a", "b", "c"], ["a", "c", "b"])).toBe(2);
    expect(rowChurn([], [])).toBe(0);
  });

  it("移除一行：它留在原处淡出，这段时间不可交互、不算表格的行，其余行的序号立刻接上，放完后才离开文档", async () => {
    mount(<Changing initial={MODS} />);
    act(() => setShownRows([MODS[0], MODS[2]]));
    const leaving = rows().find((r) => r.textContent?.includes("Lithium"));
    if (leaving === undefined) throw new Error("移除的行应该还在淡出");
    expect(leaving.hasAttribute("inert")).toBe(true);
    expect(leaving.hasAttribute("data-row-index")).toBe(false);
    expect(leaving.tabIndex).toBe(-1);
    expect(rows().filter((r) => r.hasAttribute("data-row-index")).map((r) => [r.textContent?.includes("Iris"), r.dataset.rowIndex])).toEqual([
      [false, "0"],
      [true, "1"],
    ]);

    await waitFrames();
    expect(rows().map((r) => r.textContent?.includes("Lithium"))).toEqual([false, false]);
  });

  it("删掉末行：新的末行当场不画分隔线，正在淡出的退场行不算末行、也不跟着变样", () => {
    mount(<Changing initial={MODS} />);
    expect(rows().map((r) => r.hasAttribute("data-last"))).toEqual([false, false, true]);
    act(() => setShownRows(MODS.slice(0, 2)));
    // 退场的 Iris 抽出布局后仍排在文档末尾
    expect(rows().map((r) => [r.textContent?.includes("Iris"), r.hasAttribute("inert"), r.hasAttribute("data-last")])).toEqual([
      [false, false, false],
      [false, false, true],
      [true, true, true],
    ]);
    // 末尾追加一行：末行标记交给新行
    act(() => setShownRows([...MODS.slice(0, 2), { id: "new", name: "New", version: "1", enabled: true }]));
    expect(rows().filter((r) => !r.hasAttribute("inert")).map((r) => r.hasAttribute("data-last"))).toEqual([false, false, true]);
  });

  it("新增的行留在表里，序号与内容都对", async () => {
    mount(<Changing initial={[MODS[0]]} />);
    act(() => setShownRows([MODS[0], MODS[1]]));
    await waitFrames();
    expect(rows().map((r) => [r.dataset.rowIndex, r.hasAttribute("inert")])).toEqual([
      ["0", false],
      ["1", false],
    ]);
    expect(rows()[1].textContent).toContain("Lithium");
  });

  it("一次变化超过 40 项：行不逐个淡出，下一帧就换好", async () => {
    const all = someMods(60);
    mount(<Changing initial={all} />);
    act(() => setShownRows(all.slice(0, 10)));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(rows()).toHaveLength(10);
  });

  it("虚拟化的表不做行退场", async () => {
    const all = someMods(VIRTUALIZE_ABOVE + 20);
    mount(<Changing initial={all} />);
    await waitFrames();
    expect(rows().every((r) => r.hasAttribute("data-virtual"))).toBe(true);
    act(() => setShownRows(all.slice(1)));
    expect(rows().every((r) => r.hasAttribute("data-virtual") && !r.textContent?.includes("Mod 0版本"))).toBe(true);
  });

  it("前后都在、下标变了的行数：删掉头一行时其后每行都算，删掉末行时一行不算", () => {
    const keys = someMods(50).map((m) => m.id);
    expect(rowShift(keys, keys)).toBe(0);
    expect(rowShift(keys, keys.slice(1))).toBe(49);
    expect(rowShift(keys, keys.slice(0, -1))).toBe(0);
    expect(rowShift(keys, ["new", ...keys])).toBe(50);
    expect(rowShift(["a", "b", "c"], ["c", "b", "a"])).toBe(2);
  });

  it("整表换上的判定：虚拟化或跨过阈值时行集合一变就整表换；不虚拟化时只有换了一批（增删换位超过 40、又不是末尾追加）才整表换", () => {
    const keys = someMods(60).map((m) => m.id);
    const plain = (k: readonly string[]) => ({ keys: k, virtual: false });
    const big = someMods(VIRTUALIZE_ABOVE + 5).map((m) => m.id);
    const virtualShape = (k: readonly string[]) => ({ keys: k, virtual: true });
    const extra = Array.from({ length: 41 }, (_, i) => `extra-${i}`);

    expect(swapsWholeTable(virtualShape(big), virtualShape(big))).toBe(false);
    expect(swapsWholeTable(virtualShape(big), virtualShape(big.slice(1)))).toBe(true);
    expect(swapsWholeTable(virtualShape(big), plain(big.slice(0, VIRTUALIZE_ABOVE)))).toBe(true);
    expect(swapsWholeTable(plain(keys), plain(keys.slice(0, -1)))).toBe(false);
    // 换筛选：一次走掉 45 行
    expect(swapsWholeTable(plain(keys), plain(keys.slice(0, 15)))).toBe(true);
    // 只删靠前的一行：其后 59 行都被挤动，但被挤动的行不计
    expect(swapsWholeTable(plain(keys), plain(keys.slice(1)))).toBe(false);
    expect(swapsWholeTable(plain(keys), plain(keys.filter((k) => k !== "mod-18")))).toBe(false);
    // 排序：60 行全换了位置
    expect(swapsWholeTable(plain(keys), plain([...keys].reverse()))).toBe(true);
    // 末尾追加 41 行：已有的行一动不动，不算换了一批；同样多的行插在最前面就算
    expect(swapsWholeTable(plain(keys.slice(0, 50)), plain([...keys.slice(0, 50), ...extra]))).toBe(false);
    expect(swapsWholeTable(plain(keys.slice(0, 50)), plain([...extra, ...keys.slice(0, 50)]))).toBe(true);
  });

  /** 表格限高 640、自己滚动；表体上沿在视口里的位置由滚动位置决定（表头 36 高）。 */
  function placeTable(scrollTop: number) {
    const grid = document.querySelector<HTMLElement>('[role="grid"]') as HTMLElement;
    const body = document.querySelector<HTMLElement>('[role="rowgroup"] + [role="rowgroup"]') as HTMLElement;
    setRect(grid, { left: 0, top: 0, width: 800, height: 640 });
    setRect(body, { left: 0, top: 36 - scrollTop, width: 800, height: 0 });
    return body;
  }

  /** 行的名称列写着「Mod n」，取出 n。 */
  const modIndex = (row: Element) => {
    const name = row.querySelectorAll('[role="gridcell"]')[1].textContent;
    const match = /^Mod (\d+)$/.exec(name === null ? "" : name);
    if (match === null) throw new Error(`认不出这一行：${row.textContent}`);
    return Number(match[1]);
  };

  // 哪些被挤动的行量了布局，见 Table.window.test.tsx（要在没跑过布局动画的新文件里断言）
  it("41 到 100 行的表删掉靠前的一行：不整表淡入，删掉的行原地淡出，其余行的序号立刻接上", () => {
    const all = someMods(60);
    mount(<Changing initial={all} />);
    const body = placeTable(640);
    act(() => setShownRows(all.slice(1)));

    expect(body.style.opacity).not.toBe("0");
    const leaving = rows().filter((r) => r.hasAttribute("inert"));
    expect(leaving.map(modIndex)).toEqual([0]);
    expect(rows().filter((r) => r.hasAttribute("data-row-index")).map((r) => [modIndex(r), r.dataset.rowIndex])[0]).toEqual([1, "0"]);
  });

  it("新来的行只有落在可见范围附近的播入场，远处的直接出现", () => {
    const all = someMods(50);
    mount(<Changing initial={all} />);
    // 没有滚动：可见的是第 0 到 9 行，加余量到第 13 行
    placeTable(0);
    const near = { id: "near", name: "Mod 900", version: "1", enabled: true };
    const far = { id: "far", name: "Mod 901", version: "1", enabled: true };
    act(() => setShownRows([...all.slice(0, 2), near, ...all.slice(2, 45), far, ...all.slice(45)]));
    const opacityOf = (id: number) => rows().find((r) => modIndex(r) === id)?.style.opacity;
    expect(opacityOf(900)).toBe("0");
    expect(opacityOf(901)).toBe("1");
  });

  it("换了一批（排序）：行直接换上，表体在提交时先压到透明再淡入一次", async () => {
    const all = someMods(60);
    mount(<Changing initial={all} />);
    const body = document.querySelector<HTMLElement>('[role="rowgroup"] + [role="rowgroup"]') as HTMLElement;
    act(() => setShownRows([...all].reverse()));
    expect(body.style.opacity).toBe("0");
    expect(rows().filter((r) => r.hasAttribute("inert"))).toHaveLength(0);
    await waitForFrames(() => expect(body.style.opacity).toBe("1"));
  });

  it("挂载时就在的行不播入场，之后新增的行从透明淡入", () => {
    mount(<Changing initial={[MODS[0]]} />);
    expect(rows()[0].style.opacity).toBe("1");
    act(() => setShownRows([MODS[0], MODS[1]]));
    expect(rows()[1].style.opacity).toBe("0");
  });

  it("挂载时就在的行里，之后才出现的部件照常播自己的入场", () => {
    let showBadge: (show: boolean) => void = () => undefined;
    function WithBadge() {
      const [badge, setBadge] = useState(false);
      showBadge = setBadge;
      const cols: TableColumn<Mod>[] = [
        { key: "name", header: "Mod", cell: (mod) => (badge ? <motion.span data-badge="" initial={{ opacity: 0 }} animate={{ opacity: 1 }} /> : mod.name) },
      ];
      return <Table label="x" columns={cols} rows={[MODS[0]]} rowKey={(m) => m.id} empty="空" />;
    }
    mount(<WithBadge />);
    act(() => showBadge(true));
    expect(document.querySelector<HTMLElement>("[data-badge]")?.style.opacity).toBe("0");
  });

  it("筛到零行：剩下的行留在原处淡出，空状态同时淡入，放完后只剩空状态", async () => {
    mount(<Changing initial={MODS} />);
    act(() => setShownRows([]));
    const leaving = rows().filter((r) => r.hasAttribute("inert"));
    expect(leaving.map((r) => MODS.find((m) => r.textContent?.includes(m.name))?.id)).toEqual(["sodium", "lithium", "iris"]);
    const emptyRow = rows().find((r) => r.textContent === "没有 Mod");
    if (emptyRow === undefined) throw new Error("空状态应该同时出现");
    expect(emptyRow.hasAttribute("inert")).toBe(false);
    expect(emptyRow.style.opacity).toBe("0");

    await waitFrames();
    expect(rows().map((r) => r.textContent)).toEqual(["没有 Mod"]);
  });

  it("从零行恢复：空状态淡出，行淡入", async () => {
    mount(<Changing initial={[]} />);
    expect(rows().map((r) => [r.textContent, r.style.opacity])).toEqual([["没有 Mod", "1"]]);
    act(() => setShownRows([MODS[0]]));
    const emptyRow = rows().find((r) => r.textContent === "没有 Mod");
    expect(emptyRow?.hasAttribute("inert")).toBe(true);
    const back = rows().find((r) => r.textContent?.includes("Sodium"));
    expect(back?.style.opacity).toBe("0");
    expect(back?.dataset.rowIndex).toBe("0");

    await waitFrames();
    expect(rows().map((r) => r.textContent?.includes("Sodium"))).toEqual([true]);
  });
});

describe("列定义", () => {
  it("按档生成列模板：固定列像素宽，弹性列按最小宽分剩余空间，隐藏列不占位", () => {
    const cols = columns();
    expect(columnTemplate(cols, "compact")).toBe("40px minmax(260px, 1fr) 96px");
    expect(columnTemplate(cols, "regular")).toBe("40px minmax(260px, 1fr) 150px 96px");
    expect(columnTemplate(cols, "wide")).toBe("40px minmax(260px, 1fr) 150px 96px");
  });

  it("按档取可见的列：照表格画骨架的页面与表格用同一个判断，顺序不变", () => {
    const cols: TableColumn<Mod>[] = [...columns(), { key: "author", header: "作者", width: 140, tiers: ["wide"], cell: () => "" }];
    expect(visibleColumns(cols, "compact").map((c) => c.key)).toEqual(["select", "name", "actions"]);
    expect(visibleColumns(cols, "regular").map((c) => c.key)).toEqual(["select", "name", "version", "actions"]);
    expect(visibleColumns(cols, "wide").map((c) => c.key)).toEqual(["select", "name", "version", "actions", "author"]);
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

  it("空状态里的按钮不受漫游 tabindex 管：筛到零行时「清除筛选」仍在 Tab 序列里", () => {
    function Filtering() {
      const [shown, setShown] = useState<readonly Mod[]>(MODS);
      setShownRows = setShown;
      return (
        <Table
          label="已装 Mod"
          columns={columns()}
          rows={shown}
          rowKey={(m) => m.id}
          onSortChange={() => undefined}
          empty={
            <button type="button" data-clear="">
              清除筛选
            </button>
          }
        />
      );
    }
    mount(<Filtering />);
    act(() => setShownRows([]));
    const clear = () => document.querySelector<HTMLButtonElement>("[data-clear]") as HTMLButtonElement;
    expect(clear().hasAttribute("tabindex")).toBe(false);
    expect(clear().hasAttribute("data-table-tabindex")).toBe(false);
    // 剩下的行退场、表格再提交一次之后也一样
    act(() => setShownRows([]));
    expect(clear().hasAttribute("tabindex")).toBe(false);
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

  it("排序箭头常驻同一个元素：翻转方向只换标记（由样式转半圈），不重挂", () => {
    mount(<Harness />);
    const button = () => document.querySelectorAll<HTMLElement>('[role="columnheader"]')[1].querySelector("button") as HTMLButtonElement;
    const arrow = button().querySelector("svg");
    expect(button().dataset.sorted).toBe("asc");
    act(() => button().click());
    expect(button().dataset.sorted).toBe("desc");
    expect(button().querySelector("svg")).toBe(arrow);
  });

  it("未排序的可排序列也留着箭头的位置", () => {
    mount(<Table label="x" columns={columns()} rows={MODS} rowKey={(m) => m.id} sort={null} onSortChange={() => undefined} empty="空" />);
    const button = document.querySelectorAll<HTMLElement>('[role="columnheader"]')[1].querySelector("button") as HTMLButtonElement;
    expect(button.hasAttribute("data-sorted")).toBe(false);
    expect(button.querySelectorAll("svg")).toHaveLength(1);
  });
});

describe("Table 样式", () => {
  // 工作树按 CRLF 检出时规则之间是 \r\n：先统一成 \n 再按行匹配
  const strip = (text: string) => text.replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "");
  const css = strip(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "Table.module.css"), "utf8"));
  const rule = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 换行前是逗号的是组合选择器的后半截：「.headCell,\n.cell」不能当成「.cell」
    const match = new RegExp(`(?<!,)(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(css);
    if (match === null) throw new Error(`没有 ${selector} 规则`);
    return match[1];
  };

  it("滚动条槽常驻，行右不再另留内边距（右侧由槽占住）", () => {
    expect(rule(".table")).toMatch(/scrollbar-gutter: stable;/);
    expect(rule(".headRow,\n.row")).toMatch(/padding: 0 0 0 var\(--sk-space-6\);/);
  });

  it("悬停底色不带过渡；只有选中底色淡入；启停淡化走透明度过渡", () => {
    expect(rule(".row")).not.toMatch(/transition/);
    expect(rule(".row:hover")).not.toMatch(/transition/);
    expect(rule(".row[data-selected],\n.row[data-selected]:hover")).toMatch(/transition: background-color var\(--sk-dur-hover\)/);
    expect(rule(".cell")).toMatch(/transition: opacity var\(--sk-dur-hover\)/);
  });

  it("末行按数据标记去掉分隔线，不按文档里的最后一个子项认", () => {
    expect(rule(".row")).toMatch(/border-bottom: 1px solid var\(--sk-line\);/);
    expect(rule(".row[data-last]")).toMatch(/border-bottom: 0;/);
    expect(css).not.toMatch(/:last-child/);
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
