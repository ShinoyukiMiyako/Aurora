// 资源详情弹窗：头图、统计条、介绍与版本两个标签、右侧安装面板（普通资源）或新实例面板（整合包）。
// 前置可以在同一个弹窗里点进去看，头部出现「返回」；合并卡可以切换两个平台的来源。

import { AnimatePresence, motion, useIsPresent, type Transition } from "framer-motion";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefCallback } from "react";
import { createPortal } from "react-dom";
import { hueOf } from "../../../art/illustrations/seed";
import { Spinner } from "../../../art/Spinner";
import { LOADER_NAME } from "../../../copy/flows";
import type { InstanceSummary } from "../../../domain/adapt";
import { formatBytes, formatCount, formatDate, formatRelative } from "../../../domain/format";
import { useLoadingGate } from "../../../lib/loading-gate";
import { fade, springs } from "../../../lib/motion";
import { REFLOW_PAUSED_ATTR, useReflow } from "../../../lib/reflow";
import { cx } from "../../../lib/util";
import type { Platform } from "../../../domain/types";
import { useRunner } from "../../../shell/useRunner";
import { useLauncherActions, useLauncherSelector, useNow } from "../../../state/launcher";
import { useManifest } from "../../../state/queries/catalog";
import { useModVersions, useProjectDetail, type DependencyProject, type HitSource, type ModVersionList, type ProjectDetail, type ResourceType } from "../../../state/queries/discover";
import type { ResourceResult } from "../../../state/resource";
import { Icon, type IconName } from "../../../art/Icon";
import { Appear } from "../../../ui/Appear";
import { Button } from "../../../ui/Button";
import { Callout } from "../../../ui/Callout";
import { Checkbox } from "../../../ui/Checkbox";
import { Cover } from "../../../ui/Cover";
import { EmptyState } from "../../../ui/EmptyState";
import { IconButton } from "../../../ui/IconButton";
import { Inset } from "../../../ui/Inset";
import { List, ListRow } from "../../../ui/ListRow";
import { Loadable } from "../../../ui/Loadable";
import { LoaderDot, LoaderTag } from "../../../ui/LoaderTag";
import { Modal } from "../../../ui/Modal";
import { SegmentedControl } from "../../../ui/SegmentedControl";
import { Skeleton } from "../../../ui/Skeleton";
import { TabPanel, Tabs } from "../../../ui/Tabs";
import { Tag } from "../../../ui/Tag";
import { RichText } from "../../../ui/RichText";
import { parseBody } from "../../../ui/richtext-parse";
import { Thumb } from "../../../ui/Thumb";
import { BLOCKED_COPY, DETAIL_COPY, INSTALL_COPY, KIND_LABEL, MODPACK_COPY, PLATFORM_LABEL, SEARCH_COPY } from "../copy";
import { categoryDisplay, entryHue, parsePlatformTime, projectOrigins, resourceKindOf } from "../model";
import { dotLoaders } from "../ResultCard";
import { fitsAnyInstance, gameVersionSummary, sortGameVersions } from "../versions";
import { InstallLabel, InstallPanel } from "./InstallPanel";
import { useKept } from "./kept";
import { ModpackPanel } from "./ModpackPanel";
import styles from "./detail.module.css";

/** 头图高度。 */
const HERO_HEIGHT = 176;
/** 支持的游戏版本最多列出的个数。 */
const GAME_VERSION_LIMIT = 24;
/** 版本标签每次多显示的行数。 */
const VERSION_PAGE = 30;
/** 标签行最多显示的分类数。 */
const CATEGORY_TAGS = 3;
/** 统计条的格数：骨架照它占位。 */
const STAT_COUNT = 5;
/** 版本列表骨架的行数（列表骨架至多 6 行）。 */
const VERSION_SKELETON_ROWS = 6;
/** 安装面板骨架里目标实例的行数。 */
const TARGET_SKELETON_ROWS = 2;
/** 新的一层从它在层级里那一侧滑进来的距离（px）：点进前置从右边来，返回从左边来。 */
const LAYER_SHIFT = 16;
/** 新一层的入场：位移走 soft，透明度走淡入补间。 */
const LAYER_ENTER: Transition = { ...springs.soft, opacity: fade.in };

export interface DetailTarget {
  platform: Platform;
  projectId: string;
  /** 合并卡的各平台来源；只有一个平台或从路由直接打开时为空。 */
  sources: readonly HitSource[];
  /** 结果卡上标的类型；不是从结果卡点开的（路由直开、前置）为 null。 */
  listedType: ResourceType | null;
}

export interface ResourceDetailProps {
  target: DetailTarget | null;
  onClose: () => void;
  fitInstance: string | null;
  online: boolean;
}

export function ResourceDetail({ target, onClose, fitInstance, online }: ResourceDetailProps) {
  const [footerHost, setFooterHost] = useState<HTMLElement | null>(null);
  return (
    <Modal
      open={target !== null}
      onClose={onClose}
      ariaLabel={DETAIL_COPY.tabsLabel}
      size="xl"
      padded={false}
      hideClose
      className={styles.dialog}
      footer={<div ref={setFooterHost} className={styles.footerHost} />}
    >
      {target !== null && (
        <DetailStack key={`${target.platform}:${target.projectId}`} target={target} onClose={onClose} fitInstance={fitInstance} online={online} footerHost={footerHost} />
      )}
    </Modal>
  );
}

type StackEntry = DetailTarget;

interface DetailStackProps {
  target: DetailTarget;
  onClose: () => void;
  fitInstance: string | null;
  online: boolean;
  footerHost: HTMLElement | null;
}

/** 「返回」按钮上的上一层名称：上一层的详情一定先加载过才能点进前置，标题拿不到时退回工程 id。 */
function parentLabel(parent: StackEntry, titles: ReadonlyMap<string, string>): string {
  const title = titles.get(`${parent.platform}:${parent.projectId}`);
  return title === undefined ? parent.projectId : title;
}

/** 最近的纵向滚动祖先（弹窗主体）；没有为 null。 */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let node = el === null ? null : el.parentElement; node !== null; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
  }
  return null;
}

/** 这一层是怎么来的：点进前置为 1，返回为 -1，弹窗打开时的第一层为 0（跟着弹窗入场，不另外滑）。 */
type LayerDir = 1 | -1 | 0;

/**
 * 前置的层层点进：栈顶是正在看的资源，返回回到上一层。
 * 换层时新的一层从它在层级里那一侧滑进来，看得出是进了一层还是退了一层；旧的一层同帧撤掉，不和新层叠着淡出
 * （它的底栏挂在弹窗页脚里，叠着就是两份底栏）。点进前置从新资源的开头看起，返回回到点进去之前看到的位置。
 */
function DetailStack({ target, onClose, fitInstance, online, footerHost }: DetailStackProps) {
  const [nav, setNav] = useState<{ stack: StackEntry[]; dir: LayerDir }>({ stack: [target], dir: 0 });
  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(() => new Map());
  const rememberTitle = useCallback((key: string, title: string) => setTitles((prev) => (prev.get(key) === title ? prev : new Map(prev).set(key, title))), []);
  const layerRef = useRef<HTMLDivElement>(null);
  // 点进前置时这一层的滚动位置，下标是层的深度减一；返回时按它恢复
  const scrolls = useRef<number[]>([]);
  const { stack, dir } = nav;
  const level = stack.length;
  const top = stack[level - 1];
  const parent = level > 1 ? stack[level - 2] : null;

  useLayoutEffect(() => {
    if (dir === 0) return;
    const scroller = scrollParent(layerRef.current);
    if (scroller === null) return;
    if (dir === 1) {
      scroller.scrollTop = 0;
      return;
    }
    const saved = scrolls.current[level - 1];
    if (saved === undefined) throw new Error(`返回到第 ${level} 层时没有它的滚动位置`);
    scroller.scrollTop = saved;
  }, [level, dir]);

  const openDependency = (dep: DependencyProject) => {
    const scroller = scrollParent(layerRef.current);
    if (scroller !== null) scrolls.current[level - 1] = scroller.scrollTop;
    setNav((n) => ({ stack: [...n.stack, { platform: dep.platform, projectId: dep.project_id, sources: [], listedType: null }], dir: 1 }));
  };
  const back = parent === null ? null : { label: DETAIL_COPY.back(parentLabel(parent, titles)), onBack: () => setNav((n) => ({ stack: n.stack.slice(0, -1), dir: -1 })) };
  return (
    <motion.div
      key={`${top.platform}:${top.projectId}:${level}`}
      ref={layerRef}
      data-layer-dir={dir}
      initial={dir === 0 ? false : { opacity: 0, x: LAYER_SHIFT * dir }}
      animate={{ opacity: 1, x: 0, transition: LAYER_ENTER }}
    >
      <DetailSources
        entry={top}
        back={back}
        onTitle={rememberTitle}
        onOpenDependency={openDependency}
        onClose={onClose}
        fitInstance={fitInstance}
        online={online}
        footerHost={footerHost}
      />
    </motion.div>
  );
}

interface DetailSourcesProps {
  entry: StackEntry;
  back: { label: string; onBack: () => void } | null;
  onTitle: (key: string, title: string) => void;
  onOpenDependency: (dep: DependencyProject) => void;
  onClose: () => void;
  fitInstance: string | null;
  online: boolean;
  footerHost: HTMLElement | null;
}

/** 合并卡：两个平台都有这个工程，可以切换来源。 */
function isMerged(entry: StackEntry): boolean {
  const platforms = entry.sources.map((s) => s.platform);
  return platforms.includes("modrinth") && platforms.includes("curseforge");
}

/**
 * 合并卡默认看 Modrinth，可以切到 CurseForge；切换后统计、介绍、版本、安装面板全部换成那个平台的数据。
 * 新平台的详情到达前接着显示上一份并标出正在切换，到达后原地换上：整块换成骨架会卸掉焦点所在的分段控件，
 * 安装面板的勾选也跟着丢。新平台没取到时上一份照样留着，原位报错，还能切回去。
 * 第一份详情经加载门：很快到的不闪骨架；慢的先出同尺寸的骨架，到达后骨架叠在正文上淡出、正文淡入，不整块硬切。
 * 头图上的关闭与返回不随这三态（骨架、正文、出错）换：骨架层对读屏隐藏、等待期透明，按钮放在里面读屏读不到、键盘却能
 * 落进去；正文到达时也不卸掉重挂，焦点留在原处，按钮不跟着正文淡入闪一下。
 */
function DetailSources(props: DetailSourcesProps) {
  const { entry, back, footerHost, onClose } = props;
  const merged = isMerged(entry);
  const [platform, setPlatform] = useState<Platform>(merged ? "modrinth" : entry.platform);
  const source = entry.sources.find((s) => s.platform === platform);
  const projectId = source === undefined ? entry.projectId : source.project_id;
  const detail = useProjectDetail(platform, projectId);
  const [shown, setShown] = useState<ProjectDetail | null>(null);
  if (detail.status === "ready" && detail.data !== shown) setShown(detail.data);
  // 只有切换来源时才接着显示上一份；同一个平台的详情没取到照旧整块报错
  const previous = merged && shown !== null && shown.platform !== platform ? shown : null;
  const gate = useLoadingGate(detail.status === "loading" && previous === null);
  const current = detail.status === "ready" ? detail.data : previous;
  const sourceSwitch = merged
    ? {
        value: platform,
        onChange: setPlatform,
        switching: detail.status === "loading",
        failed: detail.status === "error" ? { error: detail.error, retry: detail.reload } : null,
      }
    : null;

  return (
    <div className={styles.layer}>
      <HeroControls back={back} onClose={onClose} />
      <Loadable view={gate.view} skeleton={<DetailSkeleton {...props} />}>
        {() => {
          if (current !== null) return <DetailBody {...props} detail={current} sourceSwitch={sourceSwitch} platforms={merged ? ["modrinth", "curseforge"] : [platform]} />;
          if (detail.status !== "error") throw new Error("详情既没到也没报错，却不在加载态");
          return <DetailError {...props} error={detail.error} retry={detail.reload} />;
        }}
      </Loadable>
      {gate.view !== "content" && <FooterPlaceholder footerHost={footerHost} onClose={onClose} pack={entry.listedType === "modpack"} />}
    </div>
  );
}

function HeroControls({ back, onClose }: { back: DetailSourcesProps["back"]; onClose: () => void }) {
  return (
    <>
      {back !== null && (
        <span className={styles.heroBack}>
          <Button size="sm" variant="ghost" icon="arrow-left" onClick={back.onBack}>
            {back.label}
          </Button>
        </span>
      )}
      <span className={styles.heroClose}>
        <IconButton icon="x" label={DETAIL_COPY.close} variant="secondary" tooltip={false} onClick={onClose} />
      </span>
    </>
  );
}

/** 详情没取到时，底栏只有「关闭」。 */
function FooterClose({ footerHost, onClose }: { footerHost: HTMLElement | null; onClose: () => void }) {
  if (footerHost === null) return null;
  return createPortal(
    <Button variant="ghost" onClick={onClose}>
      {DETAIL_COPY.close}
    </Button>,
    footerHost,
  );
}

/**
 * 详情还没到时的底栏：照安装面板的底栏占位（空着的说明、取消、禁用的主按钮），详情到达时两个按钮不挪位置，
 * 也不会出现「关闭」被换成主按钮、手正落在那里的误触。整合包（结果卡标的类型）按新实例面板的文案占位。
 */
function FooterPlaceholder({ footerHost, onClose, pack }: { footerHost: HTMLElement | null; onClose: () => void; pack: boolean }) {
  const instanceCount = useLauncherSelector((s) => s.instances.length);
  if (footerHost === null) return null;
  return createPortal(
    <>
      <span className={styles.footNote} />
      <Button variant="ghost" onClick={onClose}>
        {pack ? MODPACK_COPY.cancel : INSTALL_COPY.cancel}
      </Button>
      <Button variant="primary" icon="download" disabled>
        {pack ? MODPACK_COPY.install : <InstallLabel current={INSTALL_COPY.install} instanceCount={instanceCount} />}
      </Button>
    </>,
    footerHost,
  );
}

/** 一行列表的骨架：与列表行同高，标题与元信息两条。 */
function RowSkeleton() {
  return (
    <span className={styles.rowSkeleton}>
      <Skeleton shape="block" width="45%" height={12} radius="xs" />
      <Skeleton shape="block" width="70%" height={10} radius="xs" />
    </span>
  );
}

/** 骨架按正文的结构占位：头图、统计条、标签行、正文与右栏，到达时各块落在原处，下面的不被推下去。 */
function DetailSkeleton({ entry }: DetailSourcesProps) {
  return (
    <div className={styles.root}>
      <div className={styles.heroSkeleton}>
        <div className={styles.heroInner}>
          <Skeleton shape="square" size={96} />
          <div className={styles.heroText}>
            <Skeleton shape="block" width="30%" height={18} radius="xs" />
            <Skeleton shape="block" width="50%" height={28} radius="xs" />
            <Skeleton shape="block" width="70%" height={14} radius="xs" />
          </div>
        </div>
      </div>
      <div className={styles.stats}>
        {Array.from({ length: STAT_COUNT }, (_, i) => (
          <div key={i} className={styles.stat}>
            <span className={styles.statLabel}>
              <Skeleton shape="text" width={52} />
            </span>
            <span className={styles.statValue}>
              <Skeleton shape="text" width="60%" />
            </span>
          </div>
        ))}
      </div>
      <div className={styles.bodyGrid}>
        <div className={styles.mainColumn}>
          <div className={styles.tabsRow}>
            <div className={styles.tabsSkeleton}>
              <Skeleton shape="block" width={28} height={12} radius="xs" />
              <Skeleton shape="block" width={28} height={12} radius="xs" />
            </div>
            {isMerged(entry) && <Skeleton shape="block" width={190} height={30} radius="pill" />}
          </div>
          <div className={styles.bodySkeleton}>
            <Skeleton shape="text" lines={6} />
          </div>
        </div>
        <div className={styles.sideColumn}>
          <Inset>
            <div className={styles.panel}>
              <div className={styles.panelHead}>
                <div className={styles.panelTitle}>
                  <Skeleton shape="text" width="40%" />
                </div>
                <div className={styles.panelHint}>
                  <Skeleton shape="text" width="60%" />
                </div>
              </div>
              <Skeleton shape="block" width="100%" height={30} radius="sm" />
              <div className={styles.rowSkeletons}>
                {Array.from({ length: TARGET_SKELETON_ROWS }, (_, i) => (
                  <RowSkeleton key={i} />
                ))}
              </div>
            </div>
          </Inset>
        </div>
      </div>
    </div>
  );
}

function DetailError({ onClose, footerHost, error, retry }: DetailSourcesProps & { error: Error; retry: () => void }) {
  return (
    <div className={styles.root}>
      {/* 给常驻的关闭与返回让出一条 */}
      <div className={styles.errorHero} />
      <EmptyState
        scene="error"
        title={DETAIL_COPY.loadFailed}
        body={<span className={styles.selectable}>{error.message}</span>}
        action={
          <Button variant="secondary" icon="refresh" onClick={retry}>
            {SEARCH_COPY.retry}
          </Button>
        }
      />
      <FooterClose footerHost={footerHost} onClose={onClose} />
    </div>
  );
}

type DetailTab = "intro" | "versions";

interface SourceSwitch {
  value: Platform;
  onChange: (p: Platform) => void;
  /** 选中的平台的详情还在路上，显示的是上一个平台的。 */
  switching: boolean;
  /** 选中的平台的详情没取到，显示的是上一个平台的。 */
  failed: { error: Error; retry: () => void } | null;
}

interface DetailBodyProps extends DetailSourcesProps {
  detail: ProjectDetail;
  sourceSwitch: SourceSwitch | null;
  platforms: readonly Platform[];
}

function DetailBody({ entry, detail, onTitle, onClose, onOpenDependency, fitInstance, online, footerHost, sourceSwitch, platforms }: DetailBodyProps) {
  const tabsId = useId();
  // 点进前置后，返回按钮要写上一层的名字
  const titleKey = `${entry.platform}:${entry.projectId}`;
  useEffect(() => onTitle(titleKey, detail.title), [onTitle, titleKey, detail.title]);
  const [tab, setTab] = useState<DetailTab>("intro");
  // 切换来源时本组件不重新挂载（标签、安装面板的勾选都留着），但选定的版本只属于它所在的平台：换了平台回到「自动」
  const detailKey = `${detail.platform}:${detail.project_id}`;
  const [pin, setPin] = useState<{ key: string; versionId: string | null }>({ key: detailKey, versionId: null });
  const pinned = pin.key === detailKey ? pin.versionId : null;
  const onPin = useCallback((versionId: string | null) => setPin({ key: detailKey, versionId }), [detailKey]);
  const versions = useModVersions(detail.platform, detail.project_id, [], []);
  const kind = resourceKindOf(detail.resource_type);
  const isPack = kind === "modpack";
  const switching = sourceSwitch !== null && sourceSwitch.switching;
  // 画的这份详情不属于选中的平台：新平台的还在路上，或者没取到。两种情况下版本列表与右栏都是上一个平台的，
  // 点选会记在旧平台上、安装会装错平台，所以按「是不是这个平台的」判，不按「是不是正在加载」判
  const showingPrevious = sourceSwitch !== null && detail.platform !== sourceSwitch.value;
  // 指示照全站的加载门延迟出现，切换很快时不闪；新详情一到就淡出，不等最短停留：要等的内容已经换上了
  const switchGate = useLoadingGate(switching);
  // 等得久时，要被换掉的统计、正文与右栏淡下去，看得出它们是旧的、马上要换；到达后换上新内容并淡回来。分段控件不淡
  const stale = switching && switchGate.view === "skeleton";
  // 切换失败的说明块进出时，下面的标签内容从原位置滑过去
  const mainReflow = useReflow<HTMLDivElement>();

  return (
    <div className={styles.root} aria-busy={switching || undefined}>
      <DetailHero detail={detail} listedType={detail.platform === entry.platform ? entry.listedType : null} platforms={platforms} stale={stale} />
      <StatsBar detail={detail} stale={stale} />
      <div className={styles.bodyGrid}>
        <div ref={mainReflow} className={styles.mainColumn}>
          <div className={styles.tabsRow}>
            <Tabs<DetailTab>
              id={tabsId}
              value={tab}
              onChange={setTab}
              ariaLabel={DETAIL_COPY.tabsLabel}
              items={[
                { value: "intro", label: DETAIL_COPY.tabIntro },
                { value: "versions", label: DETAIL_COPY.tabVersions },
              ]}
            />
            {sourceSwitch !== null && (
              <div className={styles.sourceSwitch}>
                <span className={styles.sourceLabel}>{DETAIL_COPY.source}</span>
                <SegmentedControl<Platform>
                  size="sm"
                  ariaLabel={DETAIL_COPY.source}
                  value={sourceSwitch.value}
                  onChange={sourceSwitch.onChange}
                  options={[
                    { value: "modrinth", label: PLATFORM_LABEL.modrinth },
                    { value: "curseforge", label: PLATFORM_LABEL.curseforge },
                  ]}
                />
                {/* 指示常驻一个槽位，只淡入淡出：出现、消失时刚点过的分段控件不被挤开 */}
                <span className={styles.switchSlot}>
                  <AnimatePresence>{switching && switchGate.view === "skeleton" && <SwitchSpinner key="spinner" />}</AnimatePresence>
                </span>
              </div>
            )}
          </div>
          <Appear>
            {sourceSwitch !== null && sourceSwitch.failed !== null && (
              <Callout
                key="switch-failed"
                tone="danger"
                action={
                  <Button size="sm" variant="ghost" onClick={sourceSwitch.failed.retry}>
                    {SEARCH_COPY.retry}
                  </Button>
                }
              >
                <span className={styles.errorTitle}>{DETAIL_COPY.loadFailed}</span>
                <span className={styles.errorText}>{sourceSwitch.failed.error.message}</span>
              </Callout>
            )}
          </Appear>
          <div className={styles.dimmable} data-stale={stale || undefined}>
            <TabPanel tabsId={tabsId} value={tab}>
              {tab === "intro" ? (
                // 换来源时整段重挂：正文的块按下标作 key，留着旧元素会被让位当成「同一段变高了」，段落与下面的小节一起滑
                <IntroTab key={detailKey} detail={detail} onOpenDependency={onOpenDependency} />
              ) : (
                <VersionsTab detail={detail} versions={versions} pinned={pinned} onPin={onPin} showingPrevious={showingPrevious} />
              )}
            </TabPanel>
          </div>
        </div>
        {/* 新平台的详情到达前或没取到时，右栏画的是上一个平台的那一份：装下去就装错了平台。这段时间右栏整块点不到（与沿用上一份的版本列表同一口径），
            来源切换控件与重试在左栏，焦点留在它们上面；切回原平台从缓存立刻换回来。底栏经 portal 挂在弹窗页脚、不在右栏里，主按钮由面板按 showingPrevious 禁用 */}
        <div className={cx(styles.sideColumn, styles.dimmable)} data-stale={stale || undefined} inert={showingPrevious || undefined}>
          {isPack ? (
            <ModpackPanel
              detail={detail}
              origins={projectOrigins({ platform: detail.platform, project_id: detail.project_id, sources: entry.sources })}
              versions={versions}
              pinned={pinned}
              onPin={onPin}
              online={online}
              showingPrevious={showingPrevious}
              footerHost={footerHost}
              onClose={onClose}
            />
          ) : (
            <InstallPanel
              detail={detail}
              versions={versions}
              pinned={pinned}
              onPin={onPin}
              fitInstance={fitInstance}
              online={online}
              showingPrevious={showingPrevious}
              footerHost={footerHost}
              onClose={onClose}
            />
          )}
        </div>
      </div>
    </div>
  );
}

interface DetailHeroProps {
  detail: ProjectDetail;
  /** 这份详情对应的结果卡类型；切到另一个平台后看的是那边的工程，为 null。 */
  listedType: ResourceType | null;
  platforms: readonly Platform[];
  /** 切换来源等得久：图标与文字淡下去（返回与关闭常驻在外层，不淡）。 */
  stale: boolean;
}

/** 来源切换的加载指示：淡入淡出。退场中的那一份不再是状态通告，读屏不会在内容到达后还报「加载中」。 */
function SwitchSpinner() {
  const present = useIsPresent();
  return (
    <motion.span className={styles.switchSpinner} initial={{ opacity: 0 }} animate={{ opacity: 1, transition: fade.in }} exit={{ opacity: 0, transition: fade.out }}>
      <Spinner size={16} decorative={!present} />
    </motion.span>
  );
}

/**
 * 类型标与结果卡一致：同时发布成 Mod 与数据包的工程，Modrinth 的详情说不出它也是数据包，
 * 从「数据包」点进来却标 Mod 就对不上卡。只改这个标：安装面板仍按详情的类型走，这类工程的版本里 jar 与 zip 混着。
 */
function DetailHero({ detail, listedType, platforms, stale }: DetailHeroProps) {
  const kind = resourceKindOf(listedType === null ? detail.resource_type : listedType);
  const hue = entryHue(detail.hue, detail.project_id, hueOf);
  const gallery = kind === "modpack" && detail.gallery.length > 0 ? detail.gallery[0] : null;
  // 先去掉没有中文名的再取前几个：平台新加的分类不占名额
  const categories = detail.categories
    .map(categoryDisplay)
    .filter((name) => name !== null)
    .slice(0, CATEGORY_TAGS);
  return (
    <div className={styles.hero}>
      <Cover hue={hue} seed={detail.project_id} height={HERO_HEIGHT} remoteUrl={gallery} shade="left">
        <div className={cx(styles.heroInner, styles.dimmable)} data-stale={stale || undefined}>
          <span className={styles.heroIcon}>
            <Thumb url={detail.icon_url} kind={kind} hue={hue} size={96} />
          </span>
          <div className={styles.heroText}>
            <div className={styles.heroTags}>
              <Tag size="sm" tone={kind === "modpack" ? "accent" : "neutral"}>
                {KIND_LABEL[kind]}
              </Tag>
              {platforms.map((p) => (
                <Tag key={p} size="sm" tone="outline">
                  {PLATFORM_LABEL[p]}
                </Tag>
              ))}
              {categories.map((name) => (
                <Tag key={name} size="sm" tone="outline">
                  {name}
                </Tag>
              ))}
            </div>
            <h2 className={styles.heroName}>{detail.title}</h2>
            <span className={styles.heroBy}>{DETAIL_COPY.by(detail.author, detail.summary)}</span>
          </div>
        </div>
      </Cover>
    </div>
  );
}

function Stat({ icon, label, value }: { icon: IconName; label: string; value: string }) {
  return (
    <div className={styles.stat}>
      <span className={styles.statLabel}>
        <Icon name={icon} size={12} />
        {label}
      </span>
      <span className={styles.statValue} title={value}>
        {value}
      </span>
    </div>
  );
}

function StatsBar({ detail, stale }: { detail: ProjectDetail; stale: boolean }) {
  const now = useNow(30_000);
  const isPack = detail.resource_type === "modpack";
  const modified = parsePlatformTime(detail.date_modified);
  const latest = detail.latest_version;
  return (
    <div className={cx(styles.stats, styles.dimmable)} data-stale={stale || undefined}>
      <Stat icon="download" label={DETAIL_COPY.statDownloads} value={formatCount(detail.downloads)} />
      <Stat icon="heart" label={DETAIL_COPY.statFollows} value={detail.follows === null ? DETAIL_COPY.notProvided : formatCount(detail.follows)} />
      <Stat icon="layers" label={DETAIL_COPY.statLatest} value={latest === null ? DETAIL_COPY.noVersion : latest.version_number} />
      <Stat icon="clock" label={DETAIL_COPY.statUpdated} value={modified === null ? DETAIL_COPY.notProvided : formatRelative(modified, now)} />
      <Stat
        icon="file"
        label={isPack ? DETAIL_COPY.statPackSize : DETAIL_COPY.statFileSize}
        value={latest === null || latest.file_size === null ? DETAIL_COPY.notProvided : formatBytes(latest.file_size)}
      />
    </div>
  );
}

function IntroTab({ detail, onOpenDependency }: { detail: ProjectDetail; onOpenDependency: (dep: DependencyProject) => void }) {
  const instances = useLauncherSelector((s) => s.instances);
  const actions = useLauncherActions();
  const run = useRunner();
  const manifest = useManifest();
  const blocks = useMemo(() => parseBody(detail.body, detail.body_format), [detail.body, detail.body_format]);
  const kind = resourceKindOf(detail.resource_type);
  const order = manifest.status === "ready" ? manifest.data.versions.map((v) => v.id) : null;
  const gameVersions = sortGameVersions(detail.game_versions, order);
  const owned = new Set(instances.flatMap((i) => (i.status === "ready" && i.mcVersion !== null ? [i.mcVersion] : [])));
  const loaders = dotLoaders(detail.loaders);
  const pageUrl = detail.page_url;
  // 正文里没写尺寸的配图解码后才撑开正文：后面的加载器、游戏版本、前置从原位置滑下去，而不是一帧跳过去
  const reflow = useReflow<HTMLDivElement>();
  return (
    <div ref={reflow} className={styles.intro}>
      {blocks.length > 0 ? <RichText blocks={blocks} /> : <p className={styles.bodyParagraph}>{detail.summary === "" ? DETAIL_COPY.noBody : detail.summary}</p>}
      {(kind === "mod" || kind === "modpack") && loaders.length > 0 && (
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>{DETAIL_COPY.loadersTitle}</h3>
          <div className={styles.chips}>
            {loaders.map((l) => (
              <LoaderTag key={l} loader={l} />
            ))}
          </div>
        </section>
      )}
      {gameVersions.length > 0 && (
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>{DETAIL_COPY.gameVersionsTitle}</h3>
          <div className={styles.chips}>
            {gameVersions.slice(0, GAME_VERSION_LIMIT).map((v) => (
              <span key={v} className={styles.versionChip} data-owned={owned.has(v) || undefined}>
                {owned.has(v) && <Icon name="check" size={12} />}
                {v}
              </span>
            ))}
            {gameVersions.length > GAME_VERSION_LIMIT && <span className={styles.moreVersions}>{DETAIL_COPY.moreVersions(gameVersions.length)}</span>}
          </div>
        </section>
      )}
      {detail.dependencies.length > 0 && (
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>{DETAIL_COPY.depsTitle}</h3>
          <List variant="inset">
            {detail.dependencies.map((dep) => (
              <ListRow
                key={`${dep.platform}:${dep.project_id}`}
                title={dep.title}
                meta={DETAIL_COPY.depMeta(dep.author, dep.latest_version)}
                leading={<Thumb url={dep.icon_url} kind="mod" hue={hueOf(dep.project_id)} size={40} />}
                onClick={() => onOpenDependency(dep)}
                ariaLabel={DETAIL_COPY.depOpen(dep.title)}
              />
            ))}
          </List>
        </section>
      )}
      {pageUrl !== null && (
        <Button className={styles.pageLink} size="sm" variant="ghost" icon="external" onClick={() => void run(() => actions.openExternal(pageUrl), BLOCKED_COPY.openFailed)}>
          {DETAIL_COPY.externalPage}
        </Button>
      )}
    </div>
  );
}

interface VersionsTabProps {
  detail: ProjectDetail;
  versions: ResourceResult<ModVersionList>;
  pinned: string | null;
  onPin: (versionId: string | null) => void;
  /** 整份详情是上一个平台的（新平台的详情在路上或没取到）：列表也是那边的。 */
  showingPrevious: boolean;
}

/** 版本标签的骨架：「只看能装的」勾选行加列表行，与真实列表同形，到达时首行落在原处。 */
function VersionsSkeleton() {
  return (
    <div className={styles.versions}>
      <span className={styles.checkSkeleton}>
        <Skeleton shape="block" width={18} height={18} radius="xs" />
        <Skeleton shape="block" width={180} height={12} radius="xs" />
      </span>
      <div className={styles.rowSkeletons}>
        {Array.from({ length: VERSION_SKELETON_ROWS }, (_, i) => (
          <RowSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}

function VersionsTab({ detail, versions, pinned, onPin, showingPrevious }: VersionsTabProps) {
  const instances = useLauncherSelector((s) => s.instances);
  const manifest = useManifest();
  const [onlyFits, setOnlyFits] = useState<boolean | null>(null);
  const [shown, setShown] = useState(VERSION_PAGE);
  // 「加载更多」在列表末尾一次接上一整页，新行出现在按钮原来的位置。这一批的让位暂停：按钮与截断说明直接落到新的末尾，
  // 不从指针下面滑过新来的几十行（途中还点得到）。提交之后就撤掉开关，之后的变化照常滑
  const [paging, setPaging] = useState(false);
  useEffect(() => {
    if (paging) setPaging(false);
  }, [paging]);
  // 换来源后新平台的列表到达前接着显示上一份：不塌成骨架再撑开，滚动位置也不被夹回。上一份是别的平台的版本，
  // 这段时间点不到；等得久了淡下去，新列表一到原地换上
  const kept = useKept(versions);
  const gate = useLoadingGate(versions.status === "loading" && !kept.stale);
  const staleGate = useLoadingGate(kept.stale);
  // 筛选改变列表高度时，「加载更多」与截断说明从原位置滑过去
  const reflow = useReflow<HTMLDivElement>();
  const releases = manifest.status === "ready" ? manifest.data.versions.filter((v) => v.release_type === "release").map((v) => v.id) : null;

  if (versions.status === "error") {
    return (
      <Callout tone="danger" fullText action={<Button size="sm" variant="ghost" onClick={versions.reload}>{SEARCH_COPY.retry}</Button>}>
        <span className={styles.errorTitle}>{DETAIL_COPY.versionsFailed}</span>
        <span className={styles.errorText}>{versions.error.message}</span>
      </Callout>
    );
  }
  return (
    <Loadable view={gate.view} skeleton={<VersionsSkeleton />}>
      {() => {
        if (kept.data === null) throw new Error("版本列表既没到也没有上一份，却不在加载态");
        return (
          <VersionsList
            detail={detail}
            data={kept.data}
            stale={kept.stale}
            showingPrevious={showingPrevious}
            dim={kept.stale && staleGate.view === "skeleton"}
            filter={{ value: onlyFits, onChange: setOnlyFits }}
            shown={shown}
            onMore={() => {
              setShown((n) => n + VERSION_PAGE);
              setPaging(true);
            }}
            paging={paging}
            releases={releases}
            instances={instances}
            pinned={pinned}
            onPin={onPin}
            listRef={reflow}
          />
        );
      }}
    </Loadable>
  );
}

interface VersionsListProps {
  detail: ProjectDetail;
  data: ModVersionList;
  /** 显示的是上一份（另一个平台的）列表，当前这份还在路上：点不到。 */
  stale: boolean;
  /**
   * 整份详情还是上一个平台的（新平台的详情在路上或没取到），列表随它也是那边的：点不到。
   * 点选会按旧平台记下选定的版本、发出旧平台的兼容判定，新详情一到就被丢掉。
   */
  showingPrevious: boolean;
  /** 等得久了，旧列表淡下去。 */
  dim: boolean;
  filter: { value: boolean | null; onChange: (next: boolean) => void };
  shown: number;
  onMore: () => void;
  /** 这一次提交是「加载更多」接上的一页：让位暂停。 */
  paging: boolean;
  releases: readonly string[] | null;
  instances: readonly InstanceSummary[];
  pinned: string | null;
  onPin: (versionId: string | null) => void;
  listRef: RefCallback<HTMLDivElement>;
}

function VersionsList({ detail, data, stale, showingPrevious, dim, filter, shown, onMore, paging, releases, instances, pinned, onPin, listRef }: VersionsListProps) {
  const all = data.versions;
  const anyFits = all.some((v) => fitsAnyInstance(v, instances, detail.resource_type));
  // 默认勾选「只看能装进我的实例的版本」；一个能装的都没有时默认不勾，免得列表是空的
  const filtering = filter.value === null ? anyFits : filter.value;
  const list = filtering ? all.filter((v) => fitsAnyInstance(v, instances, detail.resource_type)) : all;
  const showLoaders = detail.resource_type === "mod" || detail.resource_type === "modpack";

  return (
    <div
      ref={listRef}
      className={cx(styles.versions, styles.dimmable)}
      data-stale={dim || undefined}
      inert={stale || showingPrevious || undefined}
      // 详情在加载时外层整块已标 aria-busy；没取到时什么也不在加载，这里只认自己的列表在路上
      aria-busy={stale || undefined}
      {...(paging ? { [REFLOW_PAUSED_ATTR]: "" } : {})}
    >
      <Checkbox checked={filtering} onChange={filter.onChange} label={DETAIL_COPY.onlyFits} />
      <Appear>
        {list.length === 0 ? (
          <p key="empty" className={styles.panelHint}>
            {filtering ? DETAIL_COPY.versionsEmptyFit : DETAIL_COPY.versionsEmpty}
          </p>
        ) : (
          <List key="list" variant="inset" aria-label={DETAIL_COPY.versionsLabel} select={{ selected: pinned, onSelect: (id) => onPin(id) }}>
            {list.slice(0, shown).map((v) => {
              const published = parsePlatformTime(v.date_published);
              const meta = [gameVersionSummary(v.game_versions, releases), published === null ? null : formatDate(published), v.file_size === null ? null : formatBytes(v.file_size)]
                .filter((part): part is string => part !== null && part !== "")
                .join(" · ");
              const loaders = dotLoaders(v.loaders);
              return (
                <ListRow
                  key={v.version_id}
                  value={v.version_id}
                  title={
                    <span className={styles.versionTitle}>
                      {v.version_number}
                      {v.release_channel === "beta" && (
                        <Tag size="sm" tone="warn">
                          {DETAIL_COPY.beta}
                        </Tag>
                      )}
                      {v.release_channel === "alpha" && (
                        <Tag size="sm" tone="danger">
                          {DETAIL_COPY.alpha}
                        </Tag>
                      )}
                    </span>
                  }
                  meta={meta}
                  trailing={
                    showLoaders && loaders.length > 0 ? (
                      <span className={styles.versionLoaders} role="img" aria-label={loaders.map((l) => LOADER_NAME[l]).join("、")}>
                        {loaders.map((l) => (
                          <LoaderDot key={l} loader={l} />
                        ))}
                      </span>
                    ) : undefined
                  }
                />
              );
            })}
          </List>
        )}
      </Appear>
      {list.length > shown && (
        <Button className={styles.loadMore} variant="secondary" size="sm" onClick={onMore}>
          {DETAIL_COPY.loadMore}
        </Button>
      )}
      {data.truncated && <p className={styles.panelHint}>{DETAIL_COPY.versionsTruncated}</p>}
    </div>
  );
}
