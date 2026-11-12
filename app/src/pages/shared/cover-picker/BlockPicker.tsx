// 封面方块选择框：仿创造模式物品栏的版式与手感（顶部分类页签、搜索框、9 列固定格子网格），全部用设计系统画，
// 不用任何原版界面贴图。网格只渲染可见行（上下带余量），视口高度固定，换页签、搜索时弹窗不跳动。
// 焦点留在网格上，当前格由 aria-activedescendant 指出：方向键移动、Enter / 空格选中、在网格里直接打字跳到搜索框，
// Esc 由弹窗关闭（搜索框里有字时先清空）。选中只回调 onPick，关不关由调用方定。
// 没有材质源时只有推荐与我的图片两页，推荐方块画成徽记，框内顶部放下载原版材质的部件。

import { motion } from "framer-motion";
import { memo, useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { blockDisplayName, useBlockCatalog, type BlockCatalog, type CatalogBlock } from "../../../art/iso/catalog";
import { COVER_PRESETS, type InstanceCover } from "../../../art/iso/covers";
import { InstanceBlock } from "../../../art/iso/InstanceBlock";
import { BLOCK_PICKER_COPY } from "../../../copy/cover";
import { coverLabel } from "../../../copy/flows";
import { fade } from "../../../lib/motion";
import { useReflow } from "../../../lib/reflow";
import { clamp, cssVars, isImeComposing, isTypingTarget } from "../../../lib/util";
import { Appear } from "../../../ui/Appear";
import { Button } from "../../../ui/Button";
import { EmptyState } from "../../../ui/EmptyState";
import { AUTOFOCUS_ATTR, Modal } from "../../../ui/Modal";
import { SearchInput } from "../../../ui/SearchInput";
import { TabPanel, Tabs, type TabItem } from "../../../ui/Tabs";
import { Tooltip } from "../../../ui/Tooltip";
import { isTypeaheadKey } from "../../../ui/typeahead";
import { ArtDownload } from "./ArtDownload";
import styles from "./BlockPicker.module.css";
import { blockPages, categoryOf, pagesInOrder, searchBlocks, type BlockCategory } from "./categories";

export interface BlockPickerProps {
  open: boolean;
  /** 实例 id：材质读不到时画实例徽记用。 */
  instanceId: string;
  /** 当前方块 id，与方块是否正在用玩家图片。 */
  value: { block: string; image: boolean };
  onPick(block: string): void;
  /** 「我的图片」页的「选一张图片」：由调用方打开文件对话框并导入。 */
  onPickImage(): void;
  /** 调用方的选图与导入还没结束：按钮转圈、点了无效，免得连点弹出第二个选图框。 */
  imageBusy: boolean;
  onClose(): void;
}

// ---------------------------------------------------------------- 网格几何

/** 每行 9 格，与原版物品栏同宽。 */
export const GRID_COLUMNS = 9;
/** 可见 6 行。 */
export const GRID_VISIBLE_ROWS = 6;
/** 可见范围上下各多渲染 2 行：滚动时新露出的行已经画好。 */
export const GRID_OVERSCAN_ROWS = 2;
/** 格子边长与间距（px）：格里放 32 宽的等距方块（高 36）。 */
const CELL = 48;
const GAP = 4;
const PITCH = CELL + GAP;
/** 网格四周的留白：当前格的焦点环外扩 4px，贴着视口边时不被裁掉。 */
const INSET = 4;
const VIEWPORT_HEIGHT = INSET * 2 + GRID_VISIBLE_ROWS * PITCH - GAP;
const GRID_WIDTH = INSET * 2 + GRID_COLUMNS * PITCH - GAP;

const spacerHeight = (rowCount: number) => INSET * 2 + rowCount * PITCH - GAP;

/**
 * 导航键之后的当前格，不是导航键返回 null。到边就停、不绕回：←→ 逐格（跨行接续），↑↓ 隔一行，
 * 下面一行不满时 ↓ 落到最后一格；Home / End 到本行首尾，带 Ctrl 到全部首尾；PageUp / PageDown 翻一屏（6 行），
 * 翻不满一屏时停在首行或末行的同一列。
 */
export function gridMove(index: number, count: number, key: string, ctrl: boolean): number | null {
  if (count <= 0) return null;
  const col = index % GRID_COLUMNS;
  const rowStart = index - col;
  const lastRowStart = Math.floor((count - 1) / GRID_COLUMNS) * GRID_COLUMNS;
  const page = GRID_COLUMNS * GRID_VISIBLE_ROWS;
  switch (key) {
    case "ArrowLeft":
      return Math.max(0, index - 1);
    case "ArrowRight":
      return Math.min(count - 1, index + 1);
    case "ArrowUp":
      return index >= GRID_COLUMNS ? index - GRID_COLUMNS : index;
    case "ArrowDown":
      return rowStart === lastRowStart ? index : Math.min(count - 1, index + GRID_COLUMNS);
    case "Home":
      return ctrl ? 0 : rowStart;
    case "End":
      return ctrl ? count - 1 : Math.min(count - 1, rowStart + GRID_COLUMNS - 1);
    case "PageUp":
      return index - page >= 0 ? index - page : col;
    case "PageDown":
      return index + page <= count - 1 ? index + page : Math.max(index, Math.min(count - 1, lastRowStart + col));
    default:
      return null;
  }
}

/** 要渲染的行：可见行上下各加余量，再加上当前格所在的行（滚到别处时 aria-activedescendant 仍指得到它）。 */
export function renderedRows(scrollTop: number, rowCount: number, activeRow: number): number[] {
  const first = Math.max(0, Math.floor((scrollTop - INSET) / PITCH) - GRID_OVERSCAN_ROWS);
  const last = Math.min(rowCount - 1, Math.floor((scrollTop + VIEWPORT_HEIGHT - INSET) / PITCH) + GRID_OVERSCAN_ROWS);
  const rows: number[] = [];
  for (let r = first; r <= last; r++) rows.push(r);
  if (activeRow >= 0 && activeRow < rowCount && (activeRow < first || activeRow > last)) rows.push(activeRow);
  return rows.sort((a, b) => a - b);
}

/** 打开时让选中格所在的行落在视口中部。 */
function centeredScrollTop(row: number, rowCount: number): number {
  if (row < 0) return 0;
  return clamp(row * PITCH - Math.floor((GRID_VISIBLE_ROWS - 1) / 2) * PITCH, 0, Math.max(0, spacerHeight(rowCount) - VIEWPORT_HEIGHT));
}

/** 键盘移到 row 时要滚到的位置：已经整行可见就不动。 */
function scrollTopToShow(row: number, scrollTop: number): number {
  const top = row * PITCH;
  const bottom = top + CELL + INSET * 2;
  if (top < scrollTop) return top;
  if (bottom > scrollTop + VIEWPORT_HEIGHT) return bottom - VIEWPORT_HEIGHT;
  return scrollTop;
}

// ---------------------------------------------------------------- 页与格

type GridView = "recommended" | BlockCategory | "search";
type PickerView = GridView | "image";

const CATALOG_VIEWS: readonly PickerView[] = ["recommended", "building", "colored", "natural", "functional", "search", "image"];
const BARE_VIEWS: readonly PickerView[] = ["recommended", "image"];

interface PickerItem {
  /** 格里画的方块；对象在目录不变时保持同一个，格子的记忆化与位图取用都靠它。 */
  cover: InstanceCover;
  name: string;
}

const PRESET_ITEMS: readonly PickerItem[] = COVER_PRESETS.map((cover) => ({ cover, name: coverLabel(cover.block) }));

interface CatalogLists {
  pages: Readonly<Record<BlockCategory, readonly PickerItem[]>>;
  /** 四页首尾相接的顺序，搜索在它上面过滤。 */
  ordered: readonly CatalogBlock[];
  itemOf: ReadonlyMap<string, PickerItem>;
}

function catalogLists(catalog: BlockCatalog): CatalogLists {
  const itemOf = new Map(catalog.blocks.map((b) => [b.id, { cover: { block: b.id, hue: b.hue, image: null }, name: blockDisplayName(b) }]));
  const item = (b: CatalogBlock): PickerItem => {
    const found = itemOf.get(b.id);
    if (found === undefined) throw new Error(`方块目录里没有 ${b.id}`);
    return found;
  };
  const pages = blockPages(catalog.blocks);
  return {
    pages: { building: pages.building.map(item), colored: pages.colored.map(item), natural: pages.natural.map(item), functional: pages.functional.map(item) },
    ordered: pagesInOrder(pages),
    itemOf,
  };
}

function initialView(value: BlockPickerProps["value"], catalog: BlockCatalog | null): PickerView {
  if (value.image) return "image";
  if (COVER_PRESETS.some((p) => p.block === value.block)) return "recommended";
  const listed = catalog?.byId.get(value.block);
  return listed === undefined ? "recommended" : categoryOf(listed);
}

/** 选择框的版式只随有没有材质源变：没有时顶部是下载部件、两个页签；有了换成搜索框与七个页签。 */
export function pickerLayoutKey(catalog: BlockCatalog | null): string {
  return catalog === null ? "bare" : "catalog";
}

export function BlockPicker({ open, instanceId, value, onPick, onPickImage, imageBusy, onClose }: BlockPickerProps) {
  // 目录在这一层读：材质下完、目录载入时弹窗自己跟着重渲染，面板才量得到新尺寸、沿弹簧形变过去，
  // 而不是上下沿各瞬跳高度差的一半。形变只认版式键，其余重渲染不量布局
  const catalog = useBlockCatalog();
  return (
    <Modal open={open} onClose={onClose} title={BLOCK_PICKER_COPY.title} size="md" layoutKey={pickerLayoutKey(catalog)}>
      <PickerBody catalog={catalog} instanceId={instanceId} value={value} onPick={onPick} onPickImage={onPickImage} imageBusy={imageBusy} />
    </Modal>
  );
}

function PickerBody({ catalog, instanceId, value, onPick, onPickImage, imageBusy }: Omit<BlockPickerProps, "open" | "onClose"> & { catalog: BlockCatalog | null }) {
  // 下载部件淡出、搜索框淡入时，页签与网格从旧位置滑过去
  const reflow = useReflow<HTMLDivElement>();
  const lists = useMemo(() => (catalog === null ? null : catalogLists(catalog)), [catalog]);
  const [view, setView] = useState<PickerView>(() => initialView(value, catalog));
  const [query, setQuery] = useState("");
  const tabsId = useId();
  const searchRef = useRef<HTMLInputElement>(null);

  const views = lists === null ? BARE_VIEWS : CATALOG_VIEWS;
  // 打开期间材质源没了（目录变回 null）时，分类页与搜索页随之撤掉
  const shown = views.includes(view) ? view : "recommended";
  const tabs: TabItem<PickerView>[] = views.map((v) => ({ value: v, label: BLOCK_PICKER_COPY.tab[v] }));

  const items = useMemo((): readonly PickerItem[] => {
    if (shown === "recommended") return PRESET_ITEMS;
    if (lists === null || shown === "image") return [];
    if (shown === "search") {
      return searchBlocks(lists.ordered, query).map((b) => {
        const found = lists.itemOf.get(b.id);
        if (found === undefined) throw new Error(`方块目录里没有 ${b.id}`);
        return found;
      });
    }
    return lists.pages[shown];
  }, [shown, query, lists]);

  const changeQuery = (next: string) => {
    setQuery(next);
    if (next !== "") setView("search");
  };
  // 换到别的页就清掉搜索词：搜索框一直在，留着字会让人以为网格是按它过滤的
  const changeView = (next: PickerView) => {
    setView(next);
    if (next !== "search") setQuery("");
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (lists === null || event.defaultPrevented || isTypingTarget(event.target)) return;
    // 中文输入法起笔的那一下：没有字符可补，只把焦点交给搜索框，接下来的组字落在那里
    if (event.key === "Process") {
      setView("search");
      searchRef.current?.focus();
      return;
    }
    if (isImeComposing(event) || !isTypeaheadKey(event)) return;
    event.preventDefault();
    changeQuery(query + event.key);
    searchRef.current?.focus();
  };

  return (
    <div ref={reflow} className={styles.body} onKeyDown={onKeyDown}>
      <Appear>{catalog === null && <ArtDownload key="art-download" />}</Appear>
      <Tabs id={tabsId} value={shown} onChange={changeView} items={tabs} variant="pill" size="sm" ariaLabel={BLOCK_PICKER_COPY.tabsLabel} />
      <Appear>
        {lists !== null && (
          <SearchInput
            key="search"
            ref={searchRef}
            size="sm"
            value={query}
            onChange={changeQuery}
            placeholder={BLOCK_PICKER_COPY.searchPlaceholder}
            aria-label={BLOCK_PICKER_COPY.searchLabel}
          />
        )}
      </Appear>
      <TabPanel tabsId={tabsId} value={shown} motion="card" className={styles.panel}>
        {shown === "image" ? (
          <div className={styles.page} style={{ minHeight: VIEWPORT_HEIGHT }}>
            <EmptyState
              icon="image"
              title={value.image ? BLOCK_PICKER_COPY.image.currentTitle : BLOCK_PICKER_COPY.image.title}
              body={value.image ? `${BLOCK_PICKER_COPY.image.currentBody}${BLOCK_PICKER_COPY.image.body}` : BLOCK_PICKER_COPY.image.body}
              action={
                <Button icon="upload" loading={imageBusy} onClick={() => onPickImage()} {...{ [AUTOFOCUS_ATTR]: "" }}>
                  {value.image ? BLOCK_PICKER_COPY.image.replace : BLOCK_PICKER_COPY.image.pick}
                </Button>
              }
            />
          </div>
        ) : (
          <ResultSwap empty={items.length === 0}>
            {items.length === 0 ? (
              <div className={styles.page} style={{ minHeight: VIEWPORT_HEIGHT }}>
                <EmptyState icon="search" title={BLOCK_PICKER_COPY.noMatch(query.trim())} body={BLOCK_PICKER_COPY.noMatchBody} />
              </div>
            ) : (
              <BlockGrid
                key={`${shown}|${query}`}
                items={items}
                instanceId={instanceId}
                selected={value.image ? null : value.block}
                label={BLOCK_PICKER_COPY.gridLabel[shown]}
                onPick={onPick}
              />
            )}
          </ResultSwap>
        )}
      </TabPanel>
    </div>
  );
}

/**
 * 搜索结果在「有」与「没有匹配」之间换：两面同高，换上来的那面只淡入、不位移（同卡内页签的切换）。
 * 打开选择框、换页签时跟着弹窗与面板的入场走，不单独再淡一次；每打一个字刷新网格也不淡，只有有无互换才淡。
 */
function ResultSwap({ empty, children }: { empty: boolean; children: ReactNode }) {
  const [first] = useState(empty);
  const [swapped, setSwapped] = useState(false);
  if (!swapped && empty !== first) setSwapped(true);
  return (
    <motion.div
      key={empty ? "empty" : "grid"}
      className={styles.swap}
      data-results={empty ? "empty" : "grid"}
      initial={swapped ? { opacity: 0 } : false}
      animate={{ opacity: 1, transition: fade.in }}
    >
      {children}
    </motion.div>
  );
}

// ---------------------------------------------------------------- 网格

interface BlockGridProps {
  items: readonly PickerItem[];
  instanceId: string;
  /** 主色描边的那一格；方块正在用玩家图片时没有。 */
  selected: string | null;
  label: string;
  onPick(block: string): void;
}

function BlockGrid({ items, instanceId, selected, label, onPick }: BlockGridProps) {
  const domId = useId();
  const viewportRef = useRef<HTMLDivElement>(null);
  const count = items.length;
  const rowCount = Math.max(Math.ceil(count / GRID_COLUMNS), GRID_VISIBLE_ROWS);
  const selectedIndex = items.findIndex((item) => item.cover.block === selected);
  const [active, setActive] = useState(selectedIndex >= 0 ? selectedIndex : 0);
  const [scrollTop, setScrollTop] = useState(() => centeredScrollTop(Math.floor(selectedIndex / GRID_COLUMNS), rowCount));
  // 键盘在操作网格：当前格画焦点环并弹出名称提示；指针一按下就收起
  const [keyboard, setKeyboard] = useState(false);
  const activeIndex = Math.min(active, count - 1);

  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const pickAt = useCallback((index: number) => {
    setActive(index);
    pickRef.current(itemsRef.current[index].cover.block);
  }, []);

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (el !== null) el.scrollTop = scrollTop;
    // 只在挂载时把选中格滚进视口；之后的滚动由用户与键盘驱动
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isImeComposing(event)) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      pickAt(activeIndex);
      return;
    }
    const next = gridMove(activeIndex, count, event.key, event.ctrlKey || event.metaKey);
    if (next === null) return;
    event.preventDefault();
    setKeyboard(true);
    setActive(next);
    const el = viewportRef.current;
    if (el === null) return;
    const top = scrollTopToShow(Math.floor(next / GRID_COLUMNS), el.scrollTop);
    if (top !== el.scrollTop) {
      el.scrollTop = top;
      setScrollTop(top);
    }
  };

  const optionId = (index: number) => `${domId}-option-${index}`;
  const rows = renderedRows(scrollTop, rowCount, Math.floor(activeIndex / GRID_COLUMNS));

  return (
    <div
      ref={viewportRef}
      role="listbox"
      aria-label={label}
      aria-activedescendant={optionId(activeIndex)}
      tabIndex={0}
      className={styles.viewport}
      style={{ ...cssVars({ "--picker-columns": GRID_COLUMNS, "--picker-cell": `${CELL}px`, "--picker-gap": `${GAP}px` }), height: VIEWPORT_HEIGHT }}
      data-keyboard={keyboard || undefined}
      onKeyDown={onKeyDown}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      onPointerDown={() => setKeyboard(false)}
      onFocus={(event) => {
        if (event.target === event.currentTarget && event.currentTarget.matches(":focus-visible")) setKeyboard(true);
      }}
      onBlur={() => setKeyboard(false)}
      {...{ [AUTOFOCUS_ATTR]: "" }}
    >
      <div className={styles.spacer} style={{ width: GRID_WIDTH, height: spacerHeight(rowCount) }}>
        {rows.map((row) => (
          <div key={row} role="presentation" className={styles.row} style={{ top: INSET + row * PITCH, left: INSET }}>
            {Array.from({ length: GRID_COLUMNS }, (_, col) => {
              const index = row * GRID_COLUMNS + col;
              if (index >= count) return <span key={`slot-${col}`} className={styles.slot} aria-hidden="true" />;
              const item = items[index];
              return (
                <Cell
                  key={item.cover.block}
                  item={item}
                  index={index}
                  count={count}
                  optionId={optionId(index)}
                  instanceId={instanceId}
                  selected={item.cover.block === selected}
                  active={index === activeIndex}
                  tooltip={keyboard && index === activeIndex}
                  onPick={pickAt}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

interface CellProps {
  item: PickerItem;
  index: number;
  count: number;
  optionId: string;
  instanceId: string;
  selected: boolean;
  active: boolean;
  /** 键盘移到这一格时直接弹出提示（焦点在网格上，格子自己从不获得焦点）。 */
  tooltip: boolean;
  onPick(index: number): void;
}

const Cell = memo(function Cell({ item, index, count, optionId, instanceId, selected, active, tooltip, onPick }: CellProps) {
  const id = item.cover.block;
  return (
    <Tooltip content={item.name} sub={item.name === id ? undefined : id} open={tooltip}>
      <div
        id={optionId}
        role="option"
        aria-selected={selected}
        aria-label={item.name}
        aria-posinset={index + 1}
        aria-setsize={count}
        className={styles.cell}
        data-block={id}
        data-active={active || undefined}
        data-sk-hover-host=""
        onClick={() => onPick(index)}
      >
        <InstanceBlock instanceId={instanceId} cover={item.cover} width={32} lift />
      </div>
    </Tooltip>
  );
});
