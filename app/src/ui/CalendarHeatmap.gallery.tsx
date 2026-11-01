import { useState } from "react";
import { formatPlaytime } from "../domain/format";
import type { GalleryEntry } from "../dev/gallery-types";
import { addMonths, CalendarHeatmap } from "./CalendarHeatmap";
import { Card } from "./Card";
import { CardHeader } from "./CardHeader";
import { IconButton } from "./IconButton";
import { Inset } from "./Inset";

const TODAY = "2026-10-30";
const MIN_MONTH = "2026-08";
const MAX_MONTH = "2026-10";

/** 八月中旬起有记录，今天之后无记录；覆盖五档与边界值。 */
const MINUTES = new Map<string, number>();
for (let day = 15; day <= 31; day++) MINUTES.set(`2026-08-${day}`, (day * 37) % 260);
for (let day = 1; day <= 30; day++) MINUTES.set(`2026-09-${String(day).padStart(2, "0")}`, [0, 1, 59, 60, 119, 120, 199, 200, 315][day % 9]);
for (let day = 1; day <= 30; day++) MINUTES.set(`2026-10-${String(day).padStart(2, "0")}`, (day * 53) % 280);

function Demo() {
  const [month, setMonth] = useState(MAX_MONTH);
  const [selected, setSelected] = useState<string | null>(TODAY);
  const minutes = selected === null ? undefined : MINUTES.get(selected);
  return (
    <span style={{ width: 520 }}>
      <Card>
        <CardHeader
          icon="calendar"
          title="游玩日历"
          subtitle={month}
          actions={
            <>
              <IconButton icon="chevron-left" label="上个月" size="sm" disabled={month === MIN_MONTH} onClick={() => setMonth((m) => addMonths(m, -1))} />
              <IconButton icon="chevron-right" label="下个月" size="sm" disabled={month === MAX_MONTH} onClick={() => setMonth((m) => addMonths(m, 1))} />
            </>
          }
        />
        <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
          <CalendarHeatmap month={month} minutes={MINUTES} today={TODAY} selected={selected} onSelect={setSelected} onMonthChange={setMonth} minMonth={MIN_MONTH} maxMonth={MAX_MONTH} />
          <Inset>
            <div>{selected === null ? "未选择" : selected}</div>
            <div>{minutes === undefined ? "无记录" : minutes === 0 ? "这天没有游玩" : formatPlaytime(minutes)}</div>
          </Inset>
        </div>
      </Card>
    </span>
  );
}

export const gallery: GalleryEntry = {
  title: "CalendarHeatmap",
  group: "数据展示",
  order: 5,
  render: () => <Demo />,
};
