// @vitest-environment jsdom
// 整表换上时挂载的那一批行，之后被挤动还量不量布局。单独成文件：同一文件里排在前面的用例只要跑过布局动画（退场或让位），
// framer-motion 的布局投影根就不再在提交前取快照，这里会断言不到测量、无故失败。
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

const mods = (from: number, count: number): Mod[] => Array.from({ length: count }, (_, i) => ({ id: `mod-${from + i}`, name: `Mod ${from + i}` }));

/** 行的名称写着「Mod n」，取出 n。 */
function modIndex(row: Element): number {
  const match = /^Mod (\d+)$/.exec(row.textContent === null ? "" : row.textContent);
  if (match === null) throw new Error(`认不出这一行：${row.textContent}`);
  return Number(match[1]);
}

/** 表格限高 640、没有滚动：露出来的是第 0 到 9 行，加余量到第 13 行。记下此后量过布局的行。 */
function watchMeasures(): Set<number> {
  setRect(document.querySelector('[role="grid"]') as HTMLElement, { left: 0, top: 0, width: 800, height: 640 });
  setRect(document.querySelector('[role="rowgroup"] + [role="rowgroup"]') as HTMLElement, { left: 0, top: 36, width: 800, height: 0 });
  const measured = new Set<number>();
  const real = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.getAttribute("role") === "row") measured.add(modIndex(this));
    return real.call(this);
  });
  return measured;
}

it("整表换上时挂载的那一批行，之后被挤动照样量布局、走让位：布局动画在挂载时就登记了", () => {
  // 在最前面一次插进 45 行：增删超过 40、又不是末尾追加，整表换上，这一批行在「直接换上」的模式下挂载
  view = render(<Changing initial={mods(1000, 1)} />);
  const batch = mods(0, 45);
  act(() => setShownRows([...batch, ...mods(1000, 1)]));
  const measured = watchMeasures();
  act(() => setShownRows([{ id: "new", name: "Mod 900" }, ...batch, ...mods(1000, 1)]));
  // 旧位置或新位置落在第 13 行以内的（Mod 0 到 Mod 13）走让位
  expect([...measured].filter((index) => index !== 900).sort((a, b) => a - b)).toEqual(Array.from({ length: 14 }, (_, i) => i));
});
