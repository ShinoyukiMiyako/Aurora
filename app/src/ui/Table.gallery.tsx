import { useMemo, useState } from "react";
import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { Button } from "./Button";
import { Card } from "./Card";
import { IconButton } from "./IconButton";
import { Skeleton } from "./Skeleton";
import { Table, type TableColumn, type TableDensity, type TableSort } from "./Table";
import { Tag } from "./Tag";

interface DemoMod {
  id: string;
  name: string;
  summary: string;
  version: string;
  update: string | null;
  source: "modrinth" | "curseforge" | "local";
  author: string;
  enabled: boolean;
}

const SOURCE = {
  modrinth: { tone: "ok", label: "Modrinth", icon: "globe" },
  curseforge: { tone: "warn", label: "CurseForge", icon: "globe" },
  local: { tone: "neutral", label: "本地文件", icon: "folder" },
} as const;

const BASE: DemoMod[] = [
  { id: "sodium", name: "Sodium", summary: "现代渲染引擎，大幅提升帧率", version: "0.6.12", update: "0.6.13", source: "modrinth", author: "JellySquid", enabled: true },
  { id: "lithium", name: "Lithium", summary: "通用优化，不改变游戏行为", version: "0.14.3", update: null, source: "modrinth", author: "CaffeineMC", enabled: true },
  { id: "jei", name: "Just Enough Items", summary: "物品与配方查看", version: "19.21.0", update: null, source: "curseforge", author: "mezz", enabled: false },
  { id: "custom", name: "自制小工具", summary: "放在 mods 目录里的本地 jar", version: "1.0.0", update: null, source: "local", author: "本机", enabled: true },
];

function useColumns(onToggle: (id: string) => void): TableColumn<DemoMod>[] {
  return useMemo(
    () => [
      {
        key: "select",
        width: 40,
        align: "center",
        header: ({ selection, toggleAll }) => (
          <input
            type="checkbox"
            aria-label="全选"
            checked={selection === "all"}
            ref={(el) => {
              if (el) el.indeterminate = selection === "some";
            }}
            onChange={toggleAll}
          />
        ),
        cell: (mod, { selected, toggleSelected }) => <input type="checkbox" aria-label={`选择 ${mod.name}`} checked={selected} onChange={toggleSelected} />,
      },
      {
        key: "name",
        header: "Mod",
        minWidth: 260,
        sortable: true,
        cell: (mod) => (
          <span style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
            <span data-media="">
              <Skeleton shape="square" size={40} />
            </span>
            <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
              <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{mod.name}</strong>
              <span style={{ display: "flex", gap: 6, alignItems: "center", minWidth: 0 }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{mod.summary}</span>
                {mod.id === "lithium" && (
                  <Tag tone="info" size="sm">
                    前置 · 由 Sodium 带入
                  </Tag>
                )}
              </span>
            </span>
          </span>
        ),
      },
      {
        key: "version",
        header: "版本",
        width: 150,
        tiers: ["regular", "wide"],
        cell: (mod) =>
          mod.update === null ? (
            mod.version
          ) : (
            <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {mod.version}
              <Tag tone="accent" size="sm">
                可更新到 {mod.update}
              </Tag>
            </span>
          ),
      },
      {
        key: "source",
        header: "来源",
        width: 120,
        sortable: true,
        tiers: ["regular", "wide"],
        cell: (mod) => (
          <Tag tone={SOURCE[mod.source].tone} size="sm" icon={SOURCE[mod.source].icon}>
            {SOURCE[mod.source].label}
          </Tag>
        ),
      },
      { key: "author", header: "作者", width: 140, tiers: ["wide"], cell: (mod) => mod.author },
      {
        key: "enabled",
        header: "启用",
        width: 64,
        sortable: true,
        keepOpaque: true,
        cell: (mod) => <IconButton icon={mod.enabled ? "check" : "minus"} label={`${mod.enabled ? "停用" : "启用"} ${mod.name}`} size="sm" pressed={mod.enabled} onClick={() => onToggle(mod.id)} />,
      },
      {
        key: "actions",
        header: "操作",
        width: 96,
        align: "end",
        keepOpaque: true,
        cell: (mod) => (
          <span style={{ display: "flex", gap: 4 }}>
            {mod.update !== null && <IconButton icon="download" label={`更新 ${mod.name}`} size="sm" />}
            <IconButton icon="trash" label={`移除 ${mod.name}`} size="sm" variant="danger" />
          </span>
        ),
      },
    ],
    [onToggle],
  );
}

function Demo({ count, height }: { count: number; height?: number }) {
  const [mods, setMods] = useState<DemoMod[]>(() =>
    Array.from({ length: count }, (_, i) => {
      const base = BASE[i % BASE.length];
      return i < BASE.length ? base : { ...base, id: `${base.id}-${i}`, name: `${base.name} ${i}` };
    }),
  );
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [sort, setSort] = useState<TableSort | null>({ key: "name", direction: "asc" });
  const [density, setDensity] = useState<TableDensity>("regular");
  const [opened, setOpened] = useState<string | null>(null);
  const onToggle = useMemo(() => (id: string) => setMods((all) => all.map((m) => (m.id === id ? { ...m, enabled: !m.enabled } : m))), []);
  const columns = useColumns(onToggle);
  const sorted = useMemo(() => {
    if (sort === null) return mods;
    const dir = sort.direction === "asc" ? 1 : -1;
    const value = (m: DemoMod) => (sort.key === "source" ? m.source : sort.key === "enabled" ? String(m.enabled) : m.name);
    return [...mods].sort((a, b) => value(a).localeCompare(value(b), "zh-CN") * dir);
  }, [mods, sort]);

  return (
    <>
      <GalleryRow label="状态">
        <Button size="sm" onClick={() => setDensity((d) => (d === "regular" ? "compact" : "regular"))}>
          行高：{density}
        </Button>
        <span>已选 {selected.size} 行</span>
        <span>最近打开：{opened === null ? "无" : opened}</span>
      </GalleryRow>
      <Card padding="none" clip>
        <div style={height === undefined ? undefined : { height }}>
          <Table
            label="已装 Mod"
            columns={columns}
            rows={sorted}
            rowKey={(m) => m.id}
            density={density}
            selection={{ selected, onChange: setSelected }}
            sort={sort}
            onSortChange={setSort}
            onActivate={(m) => setOpened(m.name)}
            isInactive={(m) => !m.enabled}
            empty={<span>还没有 Mod</span>}
          />
        </div>
      </Card>
    </>
  );
}

export const gallery: GalleryEntry = {
  title: "Table",
  group: "容器",
  order: 11,
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Demo count={6} />
      <GalleryRow label="500 行 · 虚拟化">
        <span>表格在 360 高的容器里自己滚动，表头吸顶</span>
      </GalleryRow>
      <Demo count={500} height={360} />
      <GalleryRow label="空表">
        <span style={{ width: "100%" }}>
          <Card padding="none">
            <Table label="已装 Mod" columns={[{ key: "n", header: "Mod", cell: () => "" }]} rows={[]} rowKey={() => ""} empty={<div style={{ padding: 20, textAlign: "center" }}>这个实例还没有装 Mod</div>} />
          </Card>
        </span>
      </GalleryRow>
    </div>
  ),
};
