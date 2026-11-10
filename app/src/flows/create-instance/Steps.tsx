// 新建实例各步骤的右栏内容。状态全在流程组件里，这里只负责呈现与回调。
// 单选列表与单选卡用漫游焦点：组内一个 Tab 停靠点，方向键移动并立即选中，Enter 由流程组件统一当作「下一步」。

import { useAnimate, useReducedMotionConfig } from "framer-motion";
import { startTransition, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../../art/Icon";
import { COVER_PRESETS, type InstanceCover } from "../../art/iso/covers";
import { InstanceBlock } from "../../art/iso/InstanceBlock";
import { LoaderTile } from "../../art/illustrations/FeatureTile";
import { coverLabel, LOADER_NAME, SLOW_LOADING_HINT } from "../../copy/flows";
import type { Settings } from "../../domain/adapt";
import type { LoaderKind } from "../../domain/types";
import { useLoadingGate } from "../../lib/loading-gate";
import { fade, shake } from "../../lib/motion";
import { describeError } from "../../state/errors";
import { useJavaRuntimes, type LoaderVersionDto, type VersionRequirementsDto } from "../../state/queries/catalog";
import type { StarterModsDto, TemplateInfoDto } from "../../state/queries/starter";
import type { ResourceResult } from "../../state/resource";
import { Appear } from "../../ui/Appear";
import { Banner, BannerSlot } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Checkbox } from "../../ui/Checkbox";
import { Cover } from "../../ui/Cover";
import { EmptyState } from "../../ui/EmptyState";
import { Field } from "../../ui/Field";
import { Inset } from "../../ui/Inset";
import { KV } from "../../ui/KV";
import { Loadable } from "../../ui/Loadable";
import { LoaderDot } from "../../ui/LoaderTag";
import { AUTOFOCUS_ATTR } from "../../ui/Modal";
import { useRovingGroup } from "../../ui/roving";
import { SearchInput } from "../../ui/SearchInput";
import { Skeleton } from "../../ui/Skeleton";
import { Tag } from "../../ui/Tag";
import { TextInput } from "../../ui/TextInput";
import { WarnNote } from "../../ui/WarnNote";
import { CREATE_COPY, LOADER_DESCRIPTION, RELEASE_TYPE_LABEL } from "./copy";
import styles from "./create.module.css";
import {
  confirmJava,
  instancePath,
  loaderOptions,
  loaderVersionNote,
  STARTER_API,
  starterGroup,
  type ConfirmJava,
  type GameVersion,
  type StarterBlock,
  type StarterPicks,
  type TemplateBlock,
  type VersionFilter,
} from "./model";

/** 名称输入框的长度上限，与名称校验的上限一致（按 UTF-16 码元计）。 */
export const NAME_MAX = 32;

/** 列表加载中的骨架行数与行高（与真实的行同高，见样式表里的 .row）。 */
const SKELETON_ROWS = 6;
const ROW_HEIGHT = 56;
/**
 * 版本列表挂载时先画的行数：比列表区可见的行多一些。打开快照后版本有几百行，换步滑入的同时全部同步挂上会卡一下；
 * 其余的行交给 React 分片在后台渲染，做完再一次提交。
 */
const FIRST_PAINT_ROWS = 12;

const TYPE_TONE = { release: "ok", snapshot: "warn", old: "neutral" } as const;

/** 封面样本的色相区高度：4 × 4 的网格要放进固定高的右栏，方块宽 32 居中。 */
const SWATCH_ART_HEIGHT = 48;

function StepHead({ title, body, right }: { title: string; body: string; right?: ReactNode }) {
  return (
    <div className={styles.stepHead}>
      <div className={styles.stepHeadText}>
        <h3 className={styles.stepTitle}>{title}</h3>
        <p className={styles.stepBody}>{body}</p>
      </div>
      {right}
    </div>
  );
}

function SkeletonRows({ label }: { label: string }) {
  return (
    <div className={styles.list} aria-label={label}>
      {Array.from({ length: SKELETON_ROWS }, (_, i) => (
        <Skeleton key={i} shape="block" width="100%" height={ROW_HEIGHT} radius="md" className={styles.skeletonRow} />
      ))}
    </div>
  );
}

/** 列表区里不是列表的内容（加载失败、没有结果）：内边距与列表相同，和列表的行左右对齐。 */
function ListPad({ children }: { children: ReactNode }) {
  return <div className={styles.listPad}>{children}</div>;
}

function LoadError({ title, error, onRetry }: { title: string; error: Error | string; onRetry: () => void }) {
  return (
    <EmptyState
      scene="error"
      compact
      titleAs="h4"
      title={title}
      body={typeof error === "string" ? error : describeError(error)}
      action={<Button onClick={onRetry}>{CREATE_COPY.retry}</Button>}
    />
  );
}

// ---------------------------------------------------------------- 名称

export interface NameStepProps {
  name: string;
  /** 校验错误；名称为空时不显示（只禁用下一步）。 */
  error: string | null;
  onChange: (name: string) => void;
  /** 按 Enter 被拒的次数：每加一，输入框抖一次，告诉用户这一下没有前进。 */
  rejected: number;
}

export function NameStep({ name, error, onChange, rejected }: NameStepProps) {
  const shownError = name.trim() === "" || error === null ? undefined : error;
  const [shaker, animate] = useAnimate<HTMLDivElement>();
  const reduced = useReducedMotionConfig() === true;
  // 只认挂载之后的变化：回到这一步时不重播上一次的拒绝
  const seen = useRef(rejected);
  useEffect(() => {
    if (rejected === seen.current) return;
    seen.current = rejected;
    if (reduced) return;
    void animate(shaker.current, { x: [...shake.x] }, shake.transition);
  }, [rejected, reduced, animate, shaker]);
  return (
    <>
      <StepHead title={CREATE_COPY.name.title} body={CREATE_COPY.name.body} />
      <Field label={CREATE_COPY.name.label} hint={CREATE_COPY.name.hint} error={shownError}>
        <div ref={shaker} data-shaker="">
          <TextInput
            size="lg"
            value={name}
            onChange={onChange}
            placeholder={CREATE_COPY.name.placeholder}
            maxLength={NAME_MAX}
            autoFocus
            {...{ [AUTOFOCUS_ATTR]: "" }}
            suffix={`${name.length}/${NAME_MAX}`}
          />
        </div>
      </Field>
      <div className={styles.ideas}>
        <span className={styles.ideasLabel}>{CREATE_COPY.name.ideasLabel}</span>
        {CREATE_COPY.name.ideas.map((idea) => (
          <Button key={idea} size="sm" variant="ghost" onClick={() => onChange(idea)}>
            {idea}
          </Button>
        ))}
      </div>
      <Callout tone="info" icon="sparkle" className={styles.pushDown}>
        {CREATE_COPY.name.roadmap}
      </Callout>
    </>
  );
}

// ---------------------------------------------------------------- 游戏版本

export interface VersionStepProps {
  status: "loading" | "ready" | "error";
  /** 版本清单整份不可用的原因（拉取失败且没有缓存）。 */
  problem: Error | string | null;
  onRetry: () => void;
  /** 筛选后的版本。 */
  items: readonly GameVersion[];
  latestId: string | null;
  /** 有数据来自离线缓存时最旧那份的时刻。 */
  staleSince: number | null;
  value: string | null;
  onChange: (id: string) => void;
  filter: VersionFilter;
  onFilter: (patch: Partial<VersionFilter>) => void;
  /** 选中版本需要的 Java 主版本；还不知道时为 null。 */
  selectedJava: number | null;
  now: number;
}

export function VersionStep(props: VersionStepProps) {
  const { status, problem, onRetry, items, latestId, staleSince, value, onChange, filter, onFilter, selectedJava, now } = props;
  const gate = useLoadingGate(status === "loading");
  const counted = status === "ready" && problem === null;
  return (
    <>
      <StepHead title={CREATE_COPY.version.title} body={CREATE_COPY.version.body} />
      <div className={styles.filterRow}>
        <SearchInput
          size="sm"
          value={filter.query}
          onChange={(query) => onFilter({ query })}
          placeholder={CREATE_COPY.version.search}
          aria-label={CREATE_COPY.version.search}
          className={styles.versionSearch}
        />
        <Checkbox checked={filter.snapshots} onChange={(snapshots) => onFilter({ snapshots })} label={CREATE_COPY.version.snapshots} className={styles.filterFixed} />
        <Checkbox checked={filter.old} onChange={(old) => onFilter({ old })} label={CREATE_COPY.version.old} className={styles.filterFixed} />
        {/* 计数槽常驻：清单没到时透明占位，到了原位淡入，筛选行不会因它出现而重排 */}
        <span className={styles.filterCount} data-pending={!counted || undefined} aria-hidden={!counted || undefined}>
          {CREATE_COPY.version.count(items.length)}
        </span>
      </div>
      <Loadable view={gate.view} skeleton={<SkeletonRows label={CREATE_COPY.version.loadingLabel} />} className={styles.listArea} contentClassName={styles.listFill}>
        {() => (
          <Appear itemClassName={styles.listFill}>
            {problem !== null ? (
              <ListPad key="error">
                <LoadError title={CREATE_COPY.version.loadError} error={problem} onRetry={onRetry} />
              </ListPad>
            ) : items.length === 0 ? (
              <ListPad key="empty">
                <EmptyState scene="search" compact titleAs="h4" title={CREATE_COPY.version.noMatch(filter.query.trim())} />
              </ListPad>
            ) : (
              <VersionList key="list" items={items} latestId={latestId} value={value} onChange={onChange} selectedJava={selectedJava} now={now} />
            )}
          </Appear>
        )}
      </Loadable>
      {/* 列表区下方的一行说明：加载比平时慢、版本列表来自离线缓存。放在列表之下，出现时只缩短列表区，不推动上面的内容 */}
      <Appear itemClassName={styles.listNoteItem}>
        {gate.view !== "content" && gate.slow && (
          <p key="slow" className={styles.listNote}>
            {SLOW_LOADING_HINT}
          </p>
        )}
        {counted && staleSince !== null && (
          <p key="stale" className={styles.listNote}>
            {CREATE_COPY.version.stale(staleSince, now)}
          </p>
        )}
      </Appear>
    </>
  );
}

function VersionList({
  items,
  latestId,
  value,
  onChange,
  selectedJava,
  now,
}: Pick<VersionStepProps, "items" | "latestId" | "value" | "onChange" | "selectedJava" | "now">) {
  // 先画前一屏多一点（见 FIRST_PAINT_ROWS），其余的行在过渡更新里渲染：React 分片做完、不占住换步的滑入
  const [filled, setFilled] = useState(items.length <= FIRST_PAINT_ROWS);
  useEffect(() => {
    if (!filled) startTransition(() => setFilled(true));
  }, [filled]);
  const rows = filled ? items : items.slice(0, FIRST_PAINT_ROWS);

  // 筛选或搜索换了一批行：行直接换上，整个列表淡入一次。几十上百行逐行增删、让位既看不清谁在动，也不值那份开销
  const listRef = useRef<HTMLDivElement>(null);
  const [, animateList] = useAnimate<HTMLDivElement>();
  const signature = items.map((v) => v.id).join("\n");
  const shownSignature = useRef(signature);
  useLayoutEffect(() => {
    if (shownSignature.current === signature) return;
    shownSignature.current = signature;
    const list = listRef.current;
    if (list === null) throw new Error("版本列表尚未挂载");
    // 透明度先在提交时压到 0，首帧就看不到整批新行一闪
    list.style.opacity = "0";
    void animateList(list, { opacity: [0, 1] }, fade.in);
  }, [signature, animateList]);

  const roving = useRovingGroup(
    rows.map((v) => ({ value: v.id })),
    value,
    onChange,
    false,
  );
  return (
    <div ref={listRef} role="radiogroup" aria-label={CREATE_COPY.version.listLabel} className={styles.list} onKeyDown={roving.onKeyDown}>
      {rows.map((v, i) => {
        const on = v.id === value;
        const sub = on && selectedJava !== null ? `${CREATE_COPY.version.released(v.releasedAt, now)} · ${CREATE_COPY.version.java(selectedJava)}` : CREATE_COPY.version.released(v.releasedAt, now);
        return (
          <button
            key={v.id}
            ref={roving.register(i)}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={roving.tabIndexOf(i)}
            className={styles.row}
            onClick={() => {
              if (!on) onChange(v.id);
            }}
          >
            <span className={styles.radio} aria-hidden="true" />
            <span className={styles.rowMain}>
              <span className={styles.rowTitle}>
                <span className={styles.rowName}>{v.id}</span>
                <Tag size="sm" tone={TYPE_TONE[v.type]}>
                  {RELEASE_TYPE_LABEL[v.type]}
                </Tag>
                {v.id === latestId && (
                  <Tag size="sm" tone="accent">
                    {CREATE_COPY.version.latest}
                  </Tag>
                )}
              </span>
              <span className={styles.rowSub}>{sub}</span>
            </span>
            <span className={styles.rowLoaders} aria-label={v.loaders.length === 0 ? CREATE_COPY.version.onlyVanilla : CREATE_COPY.version.supports(v.loaders)}>
              {v.loaders.length === 0 ? (
                <span className={styles.onlyVanilla} aria-hidden="true">
                  {CREATE_COPY.version.onlyVanilla}
                </span>
              ) : (
                v.loaders.map((k) => (
                  <span key={k} className={styles.loaderChip} aria-hidden="true">
                    <LoaderDot loader={k} />
                    {LOADER_NAME[k]}
                  </span>
                ))
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- 加载器

export interface LoaderStepProps {
  version: GameVersion;
  value: LoaderKind;
  onChange: (loader: LoaderKind) => void;
  /** 拉不到、也没有缓存的加载器。 */
  loaderErrors: readonly { loader: LoaderKind; message: string }[];
}

export function LoaderStep({ version, value, onChange, loaderErrors }: LoaderStepProps) {
  const options = loaderOptions(version);
  const errored = new Set(loaderErrors.map((e) => e.loader));
  const missing = (["fabric", "quilt", "forge", "neoforge"] as const).filter((k) => !version.loaders.includes(k) && !errored.has(k));
  const roving = useRovingGroup(
    options.map((k) => ({ value: k })),
    value,
    onChange,
    false,
  );
  return (
    <>
      <StepHead title={CREATE_COPY.loader.title} body={CREATE_COPY.loader.body(version.id, options.length)} />
      <div role="radiogroup" aria-label={CREATE_COPY.loader.listLabel} className={styles.loaderGrid} onKeyDown={roving.onKeyDown}>
        {options.map((k, i) => {
          const on = k === value;
          return (
            <button
              key={k}
              ref={roving.register(i)}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={roving.tabIndexOf(i)}
              className={styles.loaderCard}
              onClick={() => {
                if (!on) onChange(k);
              }}
            >
              <LoaderTile loader={k} />
              <span className={styles.loaderText}>
                <span className={styles.loaderName}>
                  <LoaderDot loader={k} />
                  {LOADER_NAME[k]}
                </span>
                <span className={styles.loaderDesc}>{LOADER_DESCRIPTION[k]}</span>
              </span>
              <span className={styles.check} aria-hidden="true">
                <Icon name="check" size={12} />
              </span>
            </button>
          );
        })}
      </div>
      {loaderErrors.map((e) => (
        <WarnNote key={e.loader}>{CREATE_COPY.loader.unavailable(e.loader, e.message)}</WarnNote>
      ))}
      {missing.length > 0 && <Callout tone="info">{CREATE_COPY.loader.missing(version.id, missing)}</Callout>}
    </>
  );
}

// ---------------------------------------------------------------- 加载器版本

export interface LoaderVersionStepProps {
  loader: Exclude<LoaderKind, "vanilla">;
  mcVersion: string;
  versions: ResourceResult<LoaderVersionDto[]>;
  recommended: string | null;
  value: string | null;
  onChange: (version: string) => void;
}

export function LoaderVersionStep({ loader, mcVersion, versions, recommended, value, onChange }: LoaderVersionStepProps) {
  const gate = useLoadingGate(versions.status === "loading");
  return (
    <>
      <StepHead title={CREATE_COPY.loaderVersion.title(loader)} body={CREATE_COPY.loaderVersion.body} />
      <Loadable view={gate.view} skeleton={<SkeletonRows label={CREATE_COPY.loaderVersion.loadingLabel} />} className={styles.listArea} contentClassName={styles.listFill}>
        {() => {
          if (versions.data === undefined) {
            if (versions.status !== "error") throw new Error("加载器版本还在读取，不该画内容");
            return (
              <ListPad>
                <LoadError title={CREATE_COPY.loaderVersion.loadError(loader)} error={versions.error} onRetry={versions.reload} />
              </ListPad>
            );
          }
          return versions.data.length === 0 ? (
            <ListPad>
              <EmptyState icon="info" compact titleAs="h4" title={CREATE_COPY.loaderVersion.empty(loader, mcVersion)} body={CREATE_COPY.loaderVersion.emptyBody} />
            </ListPad>
          ) : (
            <LoaderVersionList loader={loader} items={versions.data} recommended={recommended} value={value} onChange={onChange} />
          );
        }}
      </Loadable>
    </>
  );
}

function LoaderVersionList({
  loader,
  items,
  recommended,
  value,
  onChange,
}: {
  loader: Exclude<LoaderKind, "vanilla">;
  items: readonly LoaderVersionDto[];
  recommended: string | null;
  value: string | null;
  onChange: (version: string) => void;
}) {
  const roving = useRovingGroup(
    items.map((v) => ({ value: v.version })),
    value,
    onChange,
    false,
  );
  return (
    <div role="radiogroup" aria-label={CREATE_COPY.loaderVersion.listLabel(loader)} className={styles.list} onKeyDown={roving.onKeyDown}>
      {items.map((v, i) => {
        const on = v.version === value;
        const sub = CREATE_COPY.loaderVersion[loaderVersionNote(v, recommended)];
        return (
          <button
            key={v.version}
            ref={roving.register(i)}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={roving.tabIndexOf(i)}
            className={styles.row}
            onClick={() => {
              if (!on) onChange(v.version);
            }}
          >
            <span className={styles.radio} aria-hidden="true" />
            <span className={styles.rowMain}>
              <span className={styles.rowTitle}>
                <span className={styles.rowName}>{CREATE_COPY.loaderVersion.item(loader, v.version)}</span>
                {v.version === recommended && (
                  <Tag size="sm" tone="accent">
                    {CREATE_COPY.loaderVersion.recommended}
                  </Tag>
                )}
                {!v.stable && (
                  <Tag size="sm" tone="warn">
                    {CREATE_COPY.loaderVersion.beta}
                  </Tag>
                )}
              </span>
              <span className={styles.rowSub}>{sub}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- 外观

export interface CoverStepProps {
  /** 画方块回落徽记用的实例 id（即将创建的实例名）。 */
  previewId: string;
  value: InstanceCover;
  onChange: (cover: InstanceCover) => void;
  /** 「随机一块」取的随机数，范围 [0, 1)；测试注入固定值。 */
  random: () => number;
}

export function CoverStep({ previewId, value, onChange, random }: CoverStepProps) {
  const roving = useRovingGroup(
    COVER_PRESETS.map((p) => ({ value: p.block })),
    value.block,
    (block) => onChange(presetOf(block)),
    false,
  );
  const shuffle = () => {
    const others = COVER_PRESETS.filter((p) => p.block !== value.block);
    onChange(others[Math.floor(random() * others.length)]);
  };
  return (
    <>
      <StepHead
        title={CREATE_COPY.cover.title}
        body={CREATE_COPY.cover.body}
        right={
          <Button size="sm" variant="ghost" icon="refresh" onClick={shuffle}>
            {CREATE_COPY.cover.shuffle}
          </Button>
        }
      />
      <div role="radiogroup" aria-label={CREATE_COPY.cover.listLabel} className={styles.coverGrid} onKeyDown={roving.onKeyDown}>
        {COVER_PRESETS.map((p, i) => {
          const on = p.block === value.block;
          const label = coverLabel(p.block);
          return (
            <button
              key={p.block}
              ref={roving.register(i)}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={label}
              tabIndex={roving.tabIndexOf(i)}
              className={styles.swatch}
              data-sk-hover-host=""
              onClick={() => {
                if (!on) onChange(p);
              }}
            >
              <Cover hue={p.hue} seed={p.block} height={SWATCH_ART_HEIGHT} className={styles.swatchArt}>
                <span className={styles.swatchBlock}>
                  <InstanceBlock instanceId={previewId} cover={p} width={32} lift />
                </span>
              </Cover>
              <span className={styles.swatchLabel} aria-hidden="true">
                {label}
              </span>
              <span className={styles.check} aria-hidden="true">
                <Icon name="check" size={12} />
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}

function presetOf(block: string): InstanceCover {
  const preset = COVER_PRESETS.find((p) => p.block === block);
  if (preset === undefined) throw new Error(`封面预设里没有 ${block}`);
  return preset;
}

// ---------------------------------------------------------------- 确认

export interface ConfirmStepProps {
  name: string;
  version: GameVersion;
  loader: LoaderKind;
  loaderVersion: string | null;
  cover: InstanceCover;
  settings: Settings | null;
  /** 这个游戏版本要的 Java 主版本与全新下载的字节数。 */
  requirements: ResourceResult<VersionRequirementsDto>;
  /** 侧栏还能再固定一个：新实例装好后会自动固定。 */
  willPin: boolean;
  openAfter: boolean;
  onOpenAfter: (open: boolean) => void;
  /** 键值表下方的「开局选项」。 */
  starter: StarterOptionsProps;
  /** 上一次点「创建并开始安装」的错误；没有为 null。 */
  error: unknown;
}

export function ConfirmStep({ name, version, loader, loaderVersion, cover, settings, requirements, willPin, openAfter, onOpenAfter, starter, error }: ConfirmStepProps) {
  const c = CREATE_COPY.confirm;
  const loaderValue = loader === "vanilla" ? c.vanilla : loaderVersion === null ? LOADER_NAME[loader] : `${LOADER_NAME[loader]} ${loaderVersion}`;
  const java = useConfirmJava(requirements, settings);
  const pinned = java.status === "ready" ? pinnedJava(java.java) : null;
  return (
    <>
      <BannerSlot itemClassName={styles.failed}>{error !== null && <CreateFailed key="failed" error={error} />}</BannerSlot>
      <StepHead title={c.title} body={c.body} />
      <Inset className={styles.summary}>
        <KV
          rows={[
            { label: c.name, value: name },
            { label: c.version, value: c.versionValue(version.id, version.type) },
            { label: c.loader, value: loaderValue },
            { label: c.cover, value: coverLabel(cover.block) },
            { label: c.java, value: settings === null ? <Skeleton shape="text" width={180} /> : <JavaValue state={java} autoDownload={settings.autoDownloadJava} /> },
            // 体积只统计游戏本体（客户端、库、资源）；有库没标大小时后端给 null，宁可写估不出也不写一个偏小的数。
            // 这一行一直在：读到之前是骨架，读不到或估不出写原因，下面的内容不因它删掉而上移
            {
              label: c.download,
              value:
                requirements.status === "loading" ? (
                  <Skeleton shape="text" width={120} />
                ) : requirements.status === "ready" && requirements.data.download_bytes !== null ? (
                  <DownloadValue bytes={requirements.data.download_bytes} withLoader={loader !== "vanilla"} />
                ) : (
                  c.downloadUnknown
                ),
            },
            {
              label: c.path,
              value: settings === null ? <Skeleton shape="text" width={220} /> : <span className={styles.path}>{instancePath(settings.gameDir, name)}</span>,
            },
          ]}
        />
      </Inset>
      {/* Java 的结论常在进了这一步之后才到：说明块淡入，下面的块由步骤容器的让位滑下去 */}
      <Appear>{pinned !== null && <PinnedJavaNote key="pinned-java" java={pinned} />}</Appear>
      {version.type === "snapshot" && <WarnNote>{c.snapshotWarning}</WarnNote>}
      <StarterOptions {...starter} />
      <div className={styles.after}>
        <Checkbox checked={openAfter} onChange={onOpenAfter} label={c.openAfter} />
        <span className={styles.afterHint}>{willPin ? c.autoPin : c.pinFull}</span>
      </div>
    </>
  );
}

/**
 * 创建失败的原因写在这一步最上面：开局选项让这一步常要滚动，出现时把滚动容器带回顶部，不让它停在视野之外。
 * 回顶是平滑滚动，看得出内容是往哪边去的；减少动画时瞬时到位。
 */
function CreateFailed({ error }: { error: unknown }) {
  const host = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotionConfig() === true;
  useLayoutEffect(() => {
    const pane = host.current === null ? null : host.current.closest<HTMLElement>(`.${styles.pane}`);
    if (pane === null) throw new Error("创建失败的横幅没有挂在步骤里");
    pane.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
  }, [error, reduced]);
  return (
    <div ref={host}>
      <Banner tone="danger" title={CREATE_COPY.confirm.failed} announce>
        {describeError(error)}
      </Banner>
    </div>
  );
}

// ---------------------------------------------------------------- 开局选项

export interface StarterOptionsProps {
  loader: LoaderKind;
  mcVersion: string;
  template: ResourceResult<TemplateInfoDto>;
  /** 「沿用默认设置」用不上的原因；用得上为 null。 */
  templateBlock: TemplateBlock | null;
  /** 开局 Mod 的查询；原版不查，也不出现这两项。 */
  starter: ResourceResult<StarterModsDto>;
  apiBlock: StarterBlock | null;
  performanceBlock: StarterBlock | null;
  checked: Readonly<Record<keyof StarterPicks, boolean>>;
  onPick: (key: keyof StarterPicks, value: boolean) => void;
  now: number;
}

/** 文本骨架的宽度：说明行读到之前占一行的位置。 */
const NOTE_SKELETON_WIDTH = 200;

function StarterOption({ label, checked, onChange, reason, children }: { label: string; checked: boolean; onChange: (next: boolean) => void; reason: string | undefined; children: ReactNode }) {
  return (
    <div className={styles.option}>
      <Checkbox checked={checked} onChange={onChange} label={label} disabledReason={reason} />
      <div className={styles.optionNote}>{children}</div>
    </div>
  );
}

/**
 * 确认步的「开局选项」：沿用默认设置一律出现；Fabric 与 Quilt 多一项 API；装了加载器的再多一项性能组合。
 * 用不上的项悬停与键盘高亮都能看到原因；沿用默认设置用不上时说明行直接写原因，告诉用户怎样才能用上。
 */
export function StarterOptions({ loader, mcVersion, template, templateBlock, starter, apiBlock, performanceBlock, checked, onPick, now }: StarterOptionsProps) {
  const s = CREATE_COPY.confirm.starter;
  const apiName = STARTER_API[loader];
  const modded = loader !== "vanilla";
  const ready = starter.status === "ready" ? starter.data : null;
  const api = ready === null ? null : starterGroup(ready, "api");
  const performance = ready === null ? null : starterGroup(ready, "performance");

  const templateReason = ((): string | undefined => {
    if (templateBlock === null) return undefined;
    if (templateBlock !== "unreadable") return s.templateBlocked[templateBlock];
    if (template.status !== "error") throw new Error("默认设置的查询没有失败，却按读不到禁用");
    return s.templateUnreadable(describeError(template.error));
  })();
  const templateNote =
    templateBlock === "loading" ? (
      <Skeleton shape="text" width={NOTE_SKELETON_WIDTH} />
    ) : templateBlock === null && template.status === "ready" ? (
      s.templateFrom(template.data.source_instance, template.data.saved_at, now)
    ) : (
      templateReason
    );

  const starterReason = (block: StarterBlock | null, none: () => string): string | undefined => {
    if (block === null) return undefined;
    if (block === "loading") return s.loading;
    if (block === "error") {
      if (starter.status !== "error") throw new Error("开局 Mod 的查询没有失败，却按失败禁用");
      return s.loadError(describeError(starter.error));
    }
    return none();
  };

  const apiMissing = api === null ? undefined : api.missing[0];
  const apiReason =
    apiName === undefined
      ? undefined
      : starterReason(apiBlock, () => {
          if (apiMissing === undefined) throw new Error(`${apiName} 既不能装也不在缺项里`);
          return apiMissing.reason === "not_found" ? s.apiNotFound(apiName) : s.apiMissing(apiName, mcVersion);
        });
  const performanceReason = starterReason(performanceBlock, () => s.noneAvailable(mcVersion));
  const performanceNames = performance === null ? [] : performance.available.map((m) => m.name);
  const footnoteHidden = !checked.api && !checked.performance;

  const retry =
    starter.status === "error" ? (
      <Button size="sm" variant="ghost" onClick={starter.reload}>
        {CREATE_COPY.retry}
      </Button>
    ) : null;

  return (
    <div className={styles.starter} role="group" aria-label={s.groupLabel}>
      <StarterOption label={s.template} checked={checked.template} onChange={(v) => onPick("template", v)} reason={templateReason}>
        <span className={styles.optionLine}>{templateNote}</span>
      </StarterOption>
      {apiName !== undefined && (
        <StarterOption label={s.api(apiName)} checked={checked.api} onChange={(v) => onPick("api", v)} reason={apiReason}>
          {starter.status === "loading" ? <Skeleton shape="text" width={NOTE_SKELETON_WIDTH} /> : <span className={styles.optionLine}>{s.apiNote(loader)}</span>}
        </StarterOption>
      )}
      {modded && (
        <StarterOption label={s.performance(performanceNames)} checked={checked.performance} onChange={(v) => onPick("performance", v)} reason={performanceReason}>
          {starter.status === "loading" ? (
            <Skeleton shape="text" width={NOTE_SKELETON_WIDTH} />
          ) : starter.status === "error" ? (
            <span className={styles.optionLine}>
              {s.loadError(describeError(starter.error))}
              {retry}
            </span>
          ) : (
            <>
              {performanceNames.length > 0 && <span className={styles.optionLine}>{s.names(performanceNames)}</span>}
              {performance !== null &&
                s.missing(performance.missing, mcVersion).map((line) => (
                  <span key={line} className={styles.optionWarn}>
                    {line}
                  </span>
                ))}
            </>
          )}
        </StarterOption>
      )}
      {/*
       * 脚注只要勾了任一个 Mod 项就显示。它在可滚动的步骤里、随勾选来回出没：常驻占位，只切透明度，
       * 下面「创建后打开」那一行不跟着跳，滚到底时取消勾选也不会被夹回的滚动位置带着整屏下移
       */}
      {modded && (
        <p className={styles.starterNote} data-hidden={footnoteHidden || undefined} aria-hidden={footnoteHidden || undefined}>
          {s.footnote}
        </p>
      )}
    </div>
  );
}

function DownloadValue({ bytes, withLoader }: { bytes: number; withLoader: boolean }) {
  const c = CREATE_COPY.confirm;
  return (
    <span className={styles.num}>
      {c.downloadValue(bytes)}
      {withLoader && <span className={styles.soft}>{c.downloadNoLoader}</span>}
    </span>
  );
}

type ConfirmJavaState = { status: "loading" } | { status: "error"; reason: string } | { status: "ready"; java: ConfirmJava };

/** Java 一行与它下面的说明共用一份结论：要求的主版本、本机运行时与全局默认 Java 都到齐了才下判断。 */
function useConfirmJava(requirements: ResourceResult<VersionRequirementsDto>, settings: Settings | null): ConfirmJavaState {
  const runtimes = useJavaRuntimes();
  if (requirements.status === "error") return { status: "error", reason: describeError(requirements.error) };
  if (runtimes.status === "error") return { status: "error", reason: describeError(runtimes.error) };
  if (requirements.status === "loading" || runtimes.status === "loading" || settings === null) return { status: "loading" };
  return { status: "ready", java: confirmJava(requirements.data.java_major, runtimes.data, settings.defaultJava) };
}

function JavaValue({ state, autoDownload }: { state: ConfirmJavaState; autoDownload: boolean }) {
  const c = CREATE_COPY.confirm;
  if (state.status === "error") return <>{c.javaUnknown(state.reason)}</>;
  if (state.status === "loading") return <Skeleton shape="text" width={180} />;
  const java = state.java;
  switch (java.kind) {
    case "installed":
      return <>{c.javaInstalled(java.major, java.vendor)}</>;
    case "download":
      return <>{autoDownload ? c.javaAuto(java.major) : c.javaManual(java.major)}</>;
    case "pinnedMismatch":
      return <span className={styles.warnText}>{c.javaPinnedMismatch(java.pinned, java.required)}</span>;
    case "pinnedMissing":
      return <span className={styles.warnText}>{c.javaPinnedMissing}</span>;
  }
}

type PinnedJava = Extract<ConfirmJava, { kind: "pinnedMismatch" | "pinnedMissing" }>;

/** 要在键值表下方补一段说明的 Java 结论；其余的为 null。 */
function pinnedJava(java: ConfirmJava): PinnedJava | null {
  return java.kind === "pinnedMismatch" || java.kind === "pinnedMissing" ? java : null;
}

/** 全局固定的默认 Java 用不了或与这个版本不符：一句后果，一句出路。新建流程里没有实例级的 Java 选项，出路指向创建后的实例设置。 */
function PinnedJavaNote({ java }: { java: PinnedJava }) {
  const c = CREATE_COPY.confirm;
  const effect = java.kind === "pinnedMissing" ? c.pinnedGone : java.pinned < java.required ? c.pinnedLower(java.pinned) : c.pinnedHigher(java.pinned);
  return (
    <Callout tone="warn" icon="alert">
      {effect}
      {java.requiredInstalled ? c.pinnedFix(java.required) : c.pinnedFixDownload(java.required)}
    </Callout>
  );
}
