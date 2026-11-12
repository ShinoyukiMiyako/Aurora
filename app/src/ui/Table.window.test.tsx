// @vitest-environment jsdom
// 哪些被挤动的行量了布局。单独成文件：framer-motion 的布局投影树根是全局的，同一文件里前面的用例播过退场后，
// 根上的更新调度停在半路，之后挂载的行一直带着「布局已脏」的标记，再也不在提交前取快照，断言不到测量。
import { act, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { render, setRect, type Rendered } from "../test/dom";
import { Table, type TableColumn } from "./Table";

interface Mod {
  id: string;
  name: string;
}

const COLUMNS: TableColumn<Mod>[] = [{ key: "name", header: "Mod", cell: (mod) => mod.name }];

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.restoreAllMocks();
});

let setShownRows: (next: readonly Mod[]) => void = () => undefined;

function Changing({ initial }: { initial: readonly Mod[] }) {
  const [shown, setShown] = useState(initial);
  setShownRows = setShown;
  return <Table label="已装 Mod" columns={COLUMNS} rows={shown} rowKey={(m) => m.id} empty="没有 Mod" />;
}

/** 行的名称写着「Mod n」，取出 n。 */
function modIndex(row: Element): number {
  const match = /^Mod (\d+)$/.exec(row.textContent === null ? "" : row.textContent);
  if (match === null) throw new Error(`认不出这一行：${row.textContent}`);
  return Number(match[1]);
}

it("41 到 100 行的表删掉靠前的一行：只有可见范围附近被挤动的行量布局、走让位，视口外的几十行直接到位", () => {
  const all = Array.from({ length: 60 }, (_, i) => ({ id: `mod-${i}`, name: `Mod ${i}` }));
  view = render(<Changing initial={all} />);
  // 表格限高 640、自己滚动，已滚过 640（表头 36 高）：露出来的是第 9 到 19 行，上下各留 4 行，
  // 旧位置或新位置落在第 5 到 23 行之内的才动
  setRect(document.querySelector('[role="grid"]') as HTMLElement, { left: 0, top: 0, width: 800, height: 640 });
  setRect(document.querySelector('[role="rowgroup"] + [role="rowgroup"]') as HTMLElement, { left: 0, top: 36 - 640, width: 800, height: 0 });
  const measured = new Set<number>();
  const real = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.getAttribute("role") === "row") measured.add(modIndex(this));
    return real.call(this);
  });

  act(() => setShownRows(all.slice(1)));

  // 新下标 4 到 23 的行（Mod 5 到 Mod 24）走让位，再加上正在退场的 Mod 0
  expect([...measured].sort((a, b) => a - b)).toEqual([0, ...Array.from({ length: 20 }, (_, i) => i + 5)]);
});
