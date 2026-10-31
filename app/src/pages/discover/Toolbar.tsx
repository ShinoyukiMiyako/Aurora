// 搜索头图与吸顶工具条：搜索框、热门分类、类型标签、适配实例、筛选浮层、排序。

import { motion, useReducedMotionConfig, type Variants } from "framer-motion";
import { useState, type Ref } from "react";
import { BlossomBranch } from "../../art/illustrations/BlossomBranch";
import { Icon } from "../../art/Icon";
import { LOADER_NAME } from "../../copy/flows";
import type { InstanceSummary } from "../../domain/adapt";
import type { Platform } from "../../domain/types";
import { springs } from "../../lib/motion";
import { useShell } from "../../shell/shell";
import { useManifest, type LoaderChoice } from "../../state/queries/catalog";
import type { SortField } from "../../state/queries/discover";
import type { DiscoverKind } from "../../state/route";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { Checkbox } from "../../ui/Checkbox";
import { Popover } from "../../ui/Popover";
import { SearchInput } from "../../ui/SearchInput";
import { SegmentedControl } from "../../ui/SegmentedControl";
import { Select, type SelectOption } from "../../ui/Select";
import { Tabs } from "../../ui/Tabs";
import { KIND_LABEL, PLATFORM_LABEL, SEARCH_COPY, SORT_LABEL } from "./copy";
import styles from "./discover.module.css";
import {
  DISCOVER_KINDS,
  FILTER_LOADERS,
  HOT_CATEGORIES,
  loaderFilterApplies,
  popoverFilterCount,
  resetPopoverFilters,
  SORT_FIELDS,
  toggleCategory,
  withGameVersion,
  withLoader,
  type DiscoverFilters,
} from "./model";

/** 头图右侧花枝插画的尺寸，按尺寸档。 */
const BRANCH_SIZE = { compact: { width: 150, height: 110 }, regular: { width: 210, height: 150 }, wide: { width: 260, height: 170 } } as const;

/** 悬停头图时花枝轻轻摆一下，离开时回正；不循环。 */
const branchSway: Variants = {
  rest: { rotate: 0, y: 0, transition: springs.soft },
  hover: { rotate: -3, y: -2, transition: springs.soft },
};

export interface SearchHeroProps {
  filters: DiscoverFilters;
  onFilters: (next: DiscoverFilters) => void;
  /** 输入框内容变化（未防抖）。 */
  onQuery: (query: string) => void;
  /** 回车立即搜索。 */
  onSubmit: () => void;
  onImport: () => void;
  inputRef: Ref<HTMLInputElement>;
  /** 页面根用它命名。 */
  titleId: string;
}

export function SearchHero({ filters, onFilters, onQuery, onSubmit, onImport, inputRef, titleId }: SearchHeroProps) {
  const { tier } = useShell();
  const reduced = useReducedMotionConfig() === true;
  const size = BRANCH_SIZE[tier];
  return (
    <Card as="section" padding="lg" className={styles.heroCard}>
      <motion.div className={styles.hero} initial="rest" animate="rest" whileHover={reduced ? undefined : "hover"}>
        <div className={styles.heroMain}>
          <div className={styles.eyebrowRow}>
            <span className={styles.eyebrow}>
              <Icon name="compass" size={14} />
              {SEARCH_COPY.eyebrow}
            </span>
            <Button size="sm" variant="secondary" icon="upload" onClick={onImport}>
              {SEARCH_COPY.importButton}
            </Button>
          </div>
          <h1 id={titleId} className={styles.heroTitle}>{SEARCH_COPY.heroTitle}</h1>
          <SearchInput
            ref={inputRef}
            size="lg"
            value={filters.query}
            onChange={onQuery}
            onEnter={onSubmit}
            placeholder={SEARCH_COPY.placeholder}
            aria-label={SEARCH_COPY.label}
            shortcut={["Ctrl", "F"]}
            className={styles.heroSearch}
          />
          <div className={styles.chips} role="group" aria-label={SEARCH_COPY.hotCategories}>
            <span className={styles.chipsLabel}>{SEARCH_COPY.hotCategories}</span>
            {HOT_CATEGORIES[filters.kind].map((c) => {
              const on = filters.category === c.key;
              // 选中态除了按钮变体还带对勾，状态不只靠颜色区分
              return (
                <Button key={c.key} size="sm" variant={on ? "secondary" : "ghost"} icon={on ? "check" : undefined} aria-pressed={on} onClick={() => onFilters(toggleCategory(filters, c.key))}>
                  {c.label}
                </Button>
              );
            })}
          </div>
        </div>
        <motion.div className={styles.heroArt} variants={branchSway} style={{ width: size.width, height: size.height }}>
          <BlossomBranch width={size.width} height={size.height} />
        </motion.div>
      </motion.div>
    </Card>
  );
}

const FIT_ANY = "__any__";

export interface ToolbarProps {
  tabsId: string;
  filters: DiscoverFilters;
  onKind: (kind: DiscoverKind) => void;
  onFit: (instanceId: string | null) => void;
  onFilters: (next: DiscoverFilters) => void;
  /** 可作为「适配实例」的实例：就绪且认得出游戏版本。 */
  fitCandidates: readonly InstanceSummary[];
}

export function Toolbar({ tabsId, filters, onKind, onFit, onFilters, fitCandidates }: ToolbarProps) {
  const [anchor, setAnchor] = useState<Element | null>(null);
  const count = popoverFilterCount(filters);
  const fitOptions: SelectOption<string>[] = [
    { value: FIT_ANY, label: SEARCH_COPY.fitAny },
    ...fitCandidates.map((inst) => ({
      value: inst.id,
      label: SEARCH_COPY.fitOption(inst.name),
      hint: [inst.mcVersion, LOADER_NAME[inst.loader]].filter((s): s is string => s !== null).join(" · "),
    })),
  ];
  return (
    <div className={styles.toolbar}>
      <Tabs<DiscoverKind>
        id={tabsId}
        variant="pill"
        size="sm"
        ariaLabel={SEARCH_COPY.kindTabs}
        value={filters.kind}
        onChange={onKind}
        items={DISCOVER_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))}
      />
      <div className={styles.toolbarRight}>
        <Select<string>
          size="sm"
          ariaLabel={SEARCH_COPY.fitLabel}
          value={filters.fitInstance === null ? FIT_ANY : filters.fitInstance}
          options={fitOptions}
          onChange={(v) => onFit(v === FIT_ANY ? null : v)}
          className={styles.fitSelect}
        />
        <Button
          size="sm"
          variant="secondary"
          icon="filter"
          aria-expanded={anchor !== null}
          aria-label={count > 0 ? SEARCH_COPY.filterWithCount(count) : SEARCH_COPY.filter}
          onClick={(e) => setAnchor(anchor === null ? e.currentTarget : null)}
        >
          <span className={styles.filterLabel}>
            {SEARCH_COPY.filter}
            {count > 0 && <Badge count={count} tone="accent" />}
          </span>
        </Button>
        <Select<SortField>
          size="sm"
          ariaLabel={SEARCH_COPY.sortLabel}
          value={filters.sort}
          options={SORT_FIELDS.map((s) => ({ value: s, label: SORT_LABEL[s] }))}
          onChange={(sort) => onFilters({ ...filters, sort })}
        />
      </div>
      <Popover open={anchor !== null} anchor={anchor} onClose={() => setAnchor(null)} placement="bottom-end" aria-label={SEARCH_COPY.filterPanel} className={styles.filterPanel}>
        <FilterPanel filters={filters} onFilters={onFilters} />
      </Popover>
    </div>
  );
}

const PLATFORM_ANY = "all" as const;
const VERSION_ANY = "__any__";
const LOADER_ANY = "any" as const;

function FilterPanel({ filters, onFilters }: { filters: DiscoverFilters; onFilters: (next: DiscoverFilters) => void }) {
  const manifest = useManifest();
  const versions =
    manifest.status === "ready"
      ? manifest.data.versions.filter((v) => v.release_type === "release" || (filters.showSnapshots && v.release_type === "snapshot")).map((v) => v.id)
      : [];
  // 当前选中的版本不在列表里（快照被隐藏、清单还没到）时仍列出它，下拉不显示成「未选择」
  const listed = filters.gameVersion !== null && !versions.includes(filters.gameVersion) ? [filters.gameVersion, ...versions] : versions;
  return (
    <div className={styles.filterBody}>
      <div className={styles.filterRow}>
        <span className={styles.filterRowLabel}>{SEARCH_COPY.platformRow}</span>
        <SegmentedControl<Platform | typeof PLATFORM_ANY>
          size="sm"
          ariaLabel={SEARCH_COPY.platformRow}
          value={filters.platform === null ? PLATFORM_ANY : filters.platform}
          onChange={(v) => onFilters({ ...filters, platform: v === PLATFORM_ANY ? null : v })}
          options={[
            { value: PLATFORM_ANY, label: SEARCH_COPY.platformAll },
            { value: "modrinth", label: PLATFORM_LABEL.modrinth },
            { value: "curseforge", label: PLATFORM_LABEL.curseforge },
          ]}
        />
      </div>
      <div className={styles.filterRow}>
        <span className={styles.filterRowLabel}>{SEARCH_COPY.gameVersionRow}</span>
        <Select<string>
          size="sm"
          block
          ariaLabel={SEARCH_COPY.gameVersionRow}
          value={filters.gameVersion === null ? VERSION_ANY : filters.gameVersion}
          options={[{ value: VERSION_ANY, label: SEARCH_COPY.gameVersionAny }, ...listed.map((id) => ({ value: id, label: id }))]}
          onChange={(v) => onFilters(withGameVersion(filters, v === VERSION_ANY ? null : v))}
        />
        <Checkbox checked={filters.showSnapshots} onChange={(showSnapshots) => onFilters({ ...filters, showSnapshots })} label={SEARCH_COPY.showSnapshots} />
      </div>
      {loaderFilterApplies(filters.kind) && (
        <div className={styles.filterRow}>
          <span className={styles.filterRowLabel}>{SEARCH_COPY.loaderRow}</span>
          <SegmentedControl<LoaderChoice | typeof LOADER_ANY>
            size="sm"
            ariaLabel={SEARCH_COPY.loaderRow}
            value={filters.loader === null ? LOADER_ANY : filters.loader}
            onChange={(v) => onFilters(withLoader(filters, v === LOADER_ANY ? null : v))}
            options={[{ value: LOADER_ANY, label: SEARCH_COPY.loaderAny }, ...FILTER_LOADERS.map((l) => ({ value: l, label: LOADER_NAME[l], dot: l }))]}
          />
        </div>
      )}
      <div className={styles.filterFoot}>
        <Button size="sm" variant="ghost" onClick={() => onFilters(resetPopoverFilters(filters))}>
          {SEARCH_COPY.reset}
        </Button>
      </div>
    </div>
  );
}
