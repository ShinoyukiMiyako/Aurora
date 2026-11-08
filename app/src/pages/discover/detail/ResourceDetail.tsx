// 资源详情弹窗：头图、统计条、介绍与版本两个标签、右侧安装面板（普通资源）或新实例面板（整合包）。
// 前置可以在同一个弹窗里点进去看，头部出现「返回」；合并卡可以切换两个平台的来源。

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { hueOf } from "../../../art/illustrations/seed";
import { Spinner } from "../../../art/Spinner";
import { LOADER_NAME } from "../../../copy/flows";
import { formatBytes, formatCount, formatDate, formatRelative } from "../../../domain/format";
import { useLoadingGate } from "../../../lib/loading-gate";
import type { Platform } from "../../../domain/types";
import { useRunner } from "../../../shell/useRunner";
import { useLauncherActions, useLauncherSelector, useNow } from "../../../state/launcher";
import { useManifest } from "../../../state/queries/catalog";
import { useModVersions, useProjectDetail, type DependencyProject, type HitSource, type ModVersionList, type ProjectDetail, type ResourceType } from "../../../state/queries/discover";
import type { ResourceResult } from "../../../state/resource";
import { Icon, type IconName } from "../../../art/Icon";
import { Button } from "../../../ui/Button";
import { Callout } from "../../../ui/Callout";
import { Checkbox } from "../../../ui/Checkbox";
import { Cover } from "../../../ui/Cover";
import { EmptyState } from "../../../ui/EmptyState";
import { IconButton } from "../../../ui/IconButton";
import { List, ListRow } from "../../../ui/ListRow";
import { LoaderDot, LoaderTag } from "../../../ui/LoaderTag";
import { Modal } from "../../../ui/Modal";
import { SegmentedControl } from "../../../ui/SegmentedControl";
import { Skeleton } from "../../../ui/Skeleton";
import { TabPanel, Tabs } from "../../../ui/Tabs";
import { Tag } from "../../../ui/Tag";
import { RichText } from "../../../ui/RichText";
import { parseBody } from "../../../ui/richtext-parse";
import { Thumb } from "../../../ui/Thumb";
import { BLOCKED_COPY, DETAIL_COPY, KIND_LABEL, PLATFORM_LABEL, SEARCH_COPY } from "../copy";
import { categoryDisplay, entryHue, parsePlatformTime, projectOrigins, resourceKindOf } from "../model";
import { dotLoaders } from "../ResultCard";
import { fitsAnyInstance, gameVersionSummary, sortGameVersions } from "../versions";
import { InstallPanel } from "./InstallPanel";
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

/** 前置的层层点进：栈顶是正在看的资源，返回回到上一层。 */
function DetailStack({ target, onClose, fitInstance, online, footerHost }: DetailStackProps) {
  const [stack, setStack] = useState<StackEntry[]>([target]);
  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(() => new Map());
  const rememberTitle = useCallback((key: string, title: string) => setTitles((prev) => (prev.get(key) === title ? prev : new Map(prev).set(key, title))), []);
  const top = stack[stack.length - 1];
  const parent = stack.length > 1 ? stack[stack.length - 2] : null;
  const back = parent === null ? null : { label: DETAIL_COPY.back(parentLabel(parent, titles)), onBack: () => setStack((s) => s.slice(0, -1)) };
  return (
    <DetailSources
      key={`${top.platform}:${top.projectId}:${stack.length}`}
      entry={top}
      back={back}
      onTitle={rememberTitle}
      onOpenDependency={(dep) => setStack((s) => [...s, { platform: dep.platform, projectId: dep.project_id, sources: [], listedType: null }])}
      onClose={onClose}
      fitInstance={fitInstance}
      online={online}
      footerHost={footerHost}
    />
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

/**
 * 合并卡默认看 Modrinth，可以切到 CurseForge；切换后统计、介绍、版本、安装面板全部换成那个平台的数据。
 * 新平台的详情到达前接着显示上一份并标出正在切换，到达后原地换上：整块换成骨架会卸掉焦点所在的分段控件，
 * 安装面板的勾选也跟着丢。新平台没取到时上一份照样留着，原位报错，还能切回去。
 */
function DetailSources(props: DetailSourcesProps) {
  const { entry } = props;
  const platforms = entry.sources.map((s) => s.platform);
  const merged = platforms.includes("modrinth") && platforms.includes("curseforge");
  const [platform, setPlatform] = useState<Platform>(merged ? "modrinth" : entry.platform);
  const source = entry.sources.find((s) => s.platform === platform);
  const projectId = source === undefined ? entry.projectId : source.project_id;
  const detail = useProjectDetail(platform, projectId);
  const [shown, setShown] = useState<ProjectDetail | null>(null);
  if (detail.status === "ready" && detail.data !== shown) setShown(detail.data);
  // 只有切换来源时才接着显示上一份；同一个平台的详情没取到照旧整块报错
  const previous = merged && shown !== null && shown.platform !== platform ? shown : null;

  if (detail.status !== "ready" && previous === null) {
    if (detail.status === "loading") return <DetailSkeleton {...props} />;
    return <DetailError {...props} error={detail.error} retry={detail.reload} />;
  }
  const current = detail.status === "ready" ? detail.data : previous;
  if (current === null) throw new Error("切换来源期间没有可接着显示的详情");
  const sourceSwitch = merged
    ? {
        value: platform,
        onChange: setPlatform,
        switching: detail.status === "loading",
        failed: detail.status === "error" ? { error: detail.error, retry: detail.reload } : null,
      }
    : null;
  return <DetailBody {...props} detail={current} sourceSwitch={sourceSwitch} platforms={merged ? ["modrinth", "curseforge"] : [platform]} />;
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

/** 详情还没到或没取到时，底栏只有「关闭」。 */
function FooterClose({ footerHost, onClose }: { footerHost: HTMLElement | null; onClose: () => void }) {
  if (footerHost === null) return null;
  return createPortal(
    <Button variant="ghost" onClick={onClose}>
      {DETAIL_COPY.close}
    </Button>,
    footerHost,
  );
}

function DetailSkeleton({ back, onClose, footerHost }: DetailSourcesProps) {
  return (
    <div className={styles.root} aria-busy="true">
      <div className={styles.heroSkeleton}>
        <HeroControls back={back} onClose={onClose} />
        <div className={styles.heroInner}>
          <Skeleton shape="square" size={96} />
          <div className={styles.heroText}>
            <Skeleton shape="block" width="30%" height={18} radius="xs" />
            <Skeleton shape="block" width="50%" height={28} radius="xs" />
            <Skeleton shape="block" width="70%" height={14} radius="xs" />
          </div>
        </div>
      </div>
      <div className={styles.bodyGrid}>
        <Skeleton shape="text" lines={6} />
        <Skeleton shape="block" width="100%" height={240} radius="lg" />
      </div>
      <FooterClose footerHost={footerHost} onClose={onClose} />
    </div>
  );
}

function DetailError({ back, onClose, footerHost, error, retry }: DetailSourcesProps & { error: Error; retry: () => void }) {
  return (
    <div className={styles.root}>
      <div className={styles.errorHero}>
        <HeroControls back={back} onClose={onClose} />
      </div>
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

function DetailBody({ entry, detail, back, onTitle, onClose, onOpenDependency, fitInstance, online, footerHost, sourceSwitch, platforms }: DetailBodyProps) {
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
  // 指示照全站的加载门延迟出现，切换很快时不闪；新详情一到就收起，不等最短停留：要等的内容已经换上了
  const switchGate = useLoadingGate(switching);

  return (
    <div className={styles.root} aria-busy={switching || undefined}>
      <DetailHero detail={detail} listedType={detail.platform === entry.platform ? entry.listedType : null} platforms={platforms} back={back} onClose={onClose} />
      <StatsBar detail={detail} />
      <div className={styles.bodyGrid}>
        <div className={styles.mainColumn}>
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
                {switching && switchGate.view === "skeleton" && <Spinner size={16} />}
              </div>
            )}
          </div>
          {sourceSwitch !== null && sourceSwitch.failed !== null && (
            <Callout
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
          <TabPanel tabsId={tabsId} value={tab}>
            {tab === "intro" ? (
              <IntroTab detail={detail} onOpenDependency={onOpenDependency} />
            ) : (
              <VersionsTab detail={detail} versions={versions} pinned={pinned} onPin={onPin} />
            )}
          </TabPanel>
        </div>
        <div className={styles.sideColumn}>
          {isPack ? (
            <ModpackPanel
              detail={detail}
              origins={projectOrigins({ platform: detail.platform, project_id: detail.project_id, sources: entry.sources })}
              versions={versions}
              pinned={pinned}
              onPin={onPin}
              online={online}
              footerHost={footerHost}
              onClose={onClose}
            />
          ) : (
            <InstallPanel detail={detail} versions={versions} pinned={pinned} onPin={onPin} fitInstance={fitInstance} online={online} footerHost={footerHost} onClose={onClose} />
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
  back: DetailSourcesProps["back"];
  onClose: () => void;
}

/**
 * 类型标与结果卡一致：同时发布成 Mod 与数据包的工程，Modrinth 的详情说不出它也是数据包，
 * 从「数据包」点进来却标 Mod 就对不上卡。只改这个标：安装面板仍按详情的类型走，这类工程的版本里 jar 与 zip 混着。
 */
function DetailHero({ detail, listedType, platforms, back, onClose }: DetailHeroProps) {
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
        <HeroControls back={back} onClose={onClose} />
        <div className={styles.heroInner}>
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

function StatsBar({ detail }: { detail: ProjectDetail }) {
  const now = useNow(30_000);
  const isPack = detail.resource_type === "modpack";
  const modified = parsePlatformTime(detail.date_modified);
  const latest = detail.latest_version;
  return (
    <div className={styles.stats}>
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
  return (
    <div className={styles.intro}>
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
}

function VersionsTab({ detail, versions, pinned, onPin }: VersionsTabProps) {
  const instances = useLauncherSelector((s) => s.instances);
  const manifest = useManifest();
  const [onlyFits, setOnlyFits] = useState<boolean | null>(null);
  const [shown, setShown] = useState(VERSION_PAGE);
  const releases = manifest.status === "ready" ? manifest.data.versions.filter((v) => v.release_type === "release").map((v) => v.id) : null;

  if (versions.status === "loading") return <Skeleton shape="text" lines={6} />;
  if (versions.status === "error") {
    return (
      <Callout tone="danger" fullText action={<Button size="sm" variant="ghost" onClick={versions.reload}>{SEARCH_COPY.retry}</Button>}>
        <span className={styles.errorTitle}>{DETAIL_COPY.versionsFailed}</span>
        <span className={styles.errorText}>{versions.error.message}</span>
      </Callout>
    );
  }
  const all = versions.data.versions;
  const anyFits = all.some((v) => fitsAnyInstance(v, instances, detail.resource_type));
  // 默认勾选「只看能装进我的实例的版本」；一个能装的都没有时默认不勾，免得列表是空的
  const filtering = onlyFits === null ? anyFits : onlyFits;
  const list = filtering ? all.filter((v) => fitsAnyInstance(v, instances, detail.resource_type)) : all;
  const showLoaders = detail.resource_type === "mod" || detail.resource_type === "modpack";

  return (
    <div className={styles.versions}>
      <Checkbox checked={filtering} onChange={(next) => setOnlyFits(next)} label={DETAIL_COPY.onlyFits} />
      {list.length === 0 ? (
        <p className={styles.panelHint}>{filtering ? DETAIL_COPY.versionsEmptyFit : DETAIL_COPY.versionsEmpty}</p>
      ) : (
        <List variant="inset" aria-label={DETAIL_COPY.versionsLabel} select={{ selected: pinned, onSelect: (id) => onPin(id) }}>
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
      {list.length > shown && (
        <Button variant="secondary" size="sm" onClick={() => setShown((n) => n + VERSION_PAGE)}>
          {DETAIL_COPY.loadMore}
        </Button>
      )}
      {versions.data.truncated && <p className={styles.panelHint}>{DETAIL_COPY.versionsTruncated}</p>}
    </div>
  );
}
