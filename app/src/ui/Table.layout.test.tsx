// @vitest-environment jsdom
// 行的布局动画何时量布局，与 Table.window.test.tsx 同理单独成文件：前面的用例播过退场，framer-motion 的布局投影根就不再在提交前取快照。
// 这里的用例都只插行、不删行，没有退场。前面的用例跑过布局动画也会这样，所以要断言「量了布局」的用例各自单独成文件
// （Table.batch.test.tsx），不排在别的用例后面。
import { MotionConfig } from "framer-motion";
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

it("减少动画时插进一行：被挤动的行不量布局（让位本来就一步到位），只有新行淡入", () => {
  const all = mods(0, 60);
  view = render(
    <MotionConfig reducedMotion="always">
      <Changing initial={all} />
    </MotionConfig>,
  );
  const measured = watchMeasures();
  act(() => setShownRows([{ id: "new", name: "Mod 900" }, ...all]));
  expect([...measured].filter((index) => index !== 900)).toEqual([]);
});
