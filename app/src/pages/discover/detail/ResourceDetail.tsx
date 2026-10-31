// 资源详情弹窗：头图、统计条、介绍与版本两个标签、右侧安装面板（普通资源）或新实例面板（整合包）。
// 前置可以在同一个弹窗里点进去看，头部出现「返回」；合并卡可以切换两个平台的来源。

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { hueOf } from "../../../art/illustrations/seed";
import { LOADER_NAME } from "../../../copy/flows";
import { formatBytes, formatCount, formatDate, formatRelative } from "../../../domain/format";
import type { Platform } from "../../../domain/types";
import { useLauncher, useNow } from "../../../state/launcher";
import { useManifest } from "../../../state/queries/catalog";
import { useModVersions, useProjectDetail, type DependencyProject, type HitSource, type ModVersionInfo, type ProjectDetail } from "../../../state/queries/discover";
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
import { DETAIL_COPY, KIND_LABEL, PLATFORM_LABEL, SEARCH_COPY } from "../copy";
import { categoryDisplay, entryHue, parsePlatformTime, resourceKindOf } from "../model";
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

interface StackEntry {
  platform: Platform;
  projectId: string;
  sources: readonly HitSource[];
}

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
  const [stack, setStack] = useState<StackEntry[]>([{ platform: target.platform, projectId: target.projectId, sources: target.sources }]);
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
      onOpenDependency={(dep) => setStack((s) => [...s, { platform: dep.platform, projectId: dep.project_id, sources: [] }])}
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

/** 合并卡默认看 Modrinth，可以切到 CurseForge；切换后统计、介绍、版本、安装面板全部换成那个平台的数据。 */
function DetailSources(props: DetailSourcesProps) {
  const { entry } = props;
  const platforms = entry.sources.map((s) => s.platform);
  const merged = platforms.includes("modrinth") && platforms.includes("curseforge");
  const [platform, setPlatform] = useState<Platform>(merged ? "modrinth" : entry.platform);
  const source = entry.sources.find((s) => s.platform === platform);
  const projectId = source === undefined ? entry.projectId : source.project_id;
  const detail = useProjectDetail(platform, projectId);
  const sourceSwitch = merged ? { value: platform, onChange: setPlatform } : null;

  if (detail.status === "loading") return <DetailSkeleton {...props} />;
  if (detail.status === "error") return <DetailError {...props} error={detail.error} retry={detail.reload} />;
  return <DetailBody key={`${platform}:${projectId}`} {...props} detail={detail.data} sourceSwitch={sourceSwitch} platforms={merged ? ["modrinth", "curseforge"] : [platform]} />;
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

interface DetailBodyProps extends DetailSourcesProps {
  detail: ProjectDetail;
  sourceSwitch: { value: Platform; onChange: (p: Platform) => void } | null;
  platforms: readonly Platform[];
}

function DetailBody({ entry, detail, back, onTitle, onClose, onOpenDependency, fitInstance, online, footerHost, sourceSwitch, platforms }: DetailBodyProps) {
  const tabsId = useId();
  // 点进前置后，返回按钮要写上一层的名字
  const titleKey = `${entry.platform}:${entry.projectId}`;
  useEffect(() => onTitle(titleKey, detail.title), [onTitle, titleKey, detail.title]);
  const [tab, setTab] = useState<DetailTab>("intro");
  const [pinned, setPinned] = useState<string | null>(null);
  const versions = useModVersions(detail.platform, detail.project_id, [], []);
  const kind = resourceKindOf(detail.resource_type);
  const isPack = kind === "modpack";

  return (
    <div className={styles.root}>
      <DetailHero detail={detail} platforms={platforms} back={back} onClose={onClose} />
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
              </div>
            )}
          </div>
          <TabPanel tabsId={tabsId} value={tab}>
            {tab === "intro" ? (
              <IntroTab detail={detail} onOpenDependency={onOpenDependency} />
            ) : (
              <VersionsTab detail={detail} versions={versions} pinned={pinned} onPin={setPinned} />
            )}
          </TabPanel>
        </div>
        <div className={styles.sideColumn}>
          {isPack ? (
            <ModpackPanel detail={detail} versions={versions} pinned={pinned} onPin={setPinned} online={online} footerHost={footerHost} onClose={onClose} />
          ) : (
            <InstallPanel detail={detail} versions={versions} pinned={pinned} onPin={setPinned} fitInstance={fitInstance} online={online} footerHost={footerHost} onClose={onClose} />
          )}
        </div>
      </div>
    </div>
  );
}

function DetailHero({ detail, platforms, back, onClose }: { detail: ProjectDetail; platforms: readonly Platform[]; back: DetailSourcesProps["back"]; onClose: () => void }) {
  const kind = resourceKindOf(detail.resource_type);
  const hue = entryHue(detail.hue, detail.project_id, hueOf);
  const gallery = kind === "modpack" && detail.gallery.length > 0 ? detail.gallery[0] : null;
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
              {detail.categories.slice(0, CATEGORY_TAGS).map((c) => (
                <Tag key={c} size="sm" tone="outline">
                  {categoryDisplay(c)}
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
  const { state } = useLauncher();
  const manifest = useManifest();
  const blocks = useMemo(() => parseBody(detail.body, detail.body_format), [detail.body, detail.body_format]);
  const kind = resourceKindOf(detail.resource_type);
  const order = manifest.status === "ready" ? manifest.data.versions.map((v) => v.id) : null;
  const gameVersions = sortGameVersions(detail.game_versions, order);
  const owned = new Set(state.instances.flatMap((i) => (i.status === "ready" && i.mcVersion !== null ? [i.mcVersion] : [])));
  const loaders = dotLoaders(detail.loaders);
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
      {detail.page_url !== null && (
        <a className={styles.pageLink} href={detail.page_url} target="_blank" rel="noreferrer noopener">
          <Icon name="external" size={14} />
          {DETAIL_COPY.externalPage}
        </a>
      )}
    </div>
  );
}

interface VersionsTabProps {
  detail: ProjectDetail;
  versions: ResourceResult<ModVersionInfo[]>;
  pinned: string | null;
  onPin: (versionId: string | null) => void;
}

function VersionsTab({ detail, versions, pinned, onPin }: VersionsTabProps) {
  const { state } = useLauncher();
  const manifest = useManifest();
  const [onlyFits, setOnlyFits] = useState<boolean | null>(null);
  const [shown, setShown] = useState(VERSION_PAGE);
  const releases = manifest.status === "ready" ? manifest.data.versions.filter((v) => v.release_type === "release").map((v) => v.id) : null;

  if (versions.status === "loading") return <Skeleton shape="text" lines={6} />;
  if (versions.status === "error") {
    return (
      <Callout tone="danger" action={<Button size="sm" variant="ghost" onClick={versions.reload}>{SEARCH_COPY.retry}</Button>}>
        <span className={styles.errorTitle}>{DETAIL_COPY.versionsFailed}</span>
        <span className={styles.errorText}>{versions.error.message}</span>
      </Callout>
    );
  }
  const all = versions.data;
  const anyFits = all.some((v) => fitsAnyInstance(v, state.instances, detail.resource_type));
  // 默认勾选「只看能装进我的实例的版本」；一个能装的都没有时默认不勾，免得列表是空的
  const filtering = onlyFits === null ? anyFits : onlyFits;
  const list = filtering ? all.filter((v) => fitsAnyInstance(v, state.instances, detail.resource_type)) : all;
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
    </div>
  );
}
