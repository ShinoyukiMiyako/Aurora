// 新建实例各步骤的右栏内容。状态全在流程组件里，这里只负责呈现与回调。
// 单选列表与单选卡用漫游焦点：组内一个 Tab 停靠点，方向键移动并立即选中，Enter 由流程组件统一当作「下一步」。

import type { ReactNode } from "react";
import { Icon } from "../../art/Icon";
import { COVER_PRESETS, type InstanceCover } from "../../art/iso/covers";
import { InstanceBlock } from "../../art/iso/InstanceBlock";
import { LoaderTile } from "../../art/illustrations/FeatureTile";
import { coverLabel, LOADER_NAME } from "../../copy/flows";
import type { Settings } from "../../domain/adapt";
import { bestLocalRuntime } from "../../domain/rules";
import type { LoaderKind } from "../../domain/types";
import { describeError } from "../../state/errors";
import { useJavaRuntimes, type LoaderVersionDto, type VersionRequirementsDto } from "../../state/queries/catalog";
import type { ResourceResult } from "../../state/resource";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Checkbox } from "../../ui/Checkbox";
import { Cover } from "../../ui/Cover";
import { EmptyState } from "../../ui/EmptyState";
import { Field } from "../../ui/Field";
import { Inset } from "../../ui/Inset";
import { KV } from "../../ui/KV";
import { LoaderDot } from "../../ui/LoaderTag";
import { AUTOFOCUS_ATTR } from "../../ui/Modal";
import { useRovingGroup } from "../../ui/roving";
import { SearchInput } from "../../ui/SearchInput";
import { Skeleton } from "../../ui/Skeleton";
import { Tag } from "../../ui/Tag";
import { TextInput } from "../../ui/TextInput";
import { CREATE_COPY, LOADER_DESCRIPTION, RELEASE_TYPE_LABEL } from "./copy";
import styles from "./create.module.css";
import { instancePath, loaderOptions, type GameVersion, type VersionFilter } from "./model";

/** 名称输入框的长度上限，与名称校验的上限一致（按 UTF-16 码元计）。 */
export const NAME_MAX = 32;

/** 列表加载中的骨架行数与行高。 */
const SKELETON_ROWS = 6;
const ROW_HEIGHT = 56;

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
    <div className={styles.list} aria-busy="true" aria-label={label}>
      {Array.from({ length: SKELETON_ROWS }, (_, i) => (
        <Skeleton key={i} shape="block" width="100%" height={ROW_HEIGHT} radius="md" />
      ))}
    </div>
  );
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
}

export function NameStep({ name, error, onChange }: NameStepProps) {
  const shownError = name.trim() === "" || error === null ? undefined : error;
  return (
    <>
      <StepHead title={CREATE_COPY.name.title} body={CREATE_COPY.name.body} />
      <Field label={CREATE_COPY.name.label} hint={CREATE_COPY.name.hint} error={shownError}>
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
  const count = staleSince === null ? CREATE_COPY.version.count(items.length) : `${CREATE_COPY.version.count(items.length)} · ${CREATE_COPY.version.stale(staleSince, now)}`;
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
        <Checkbox checked={filter.snapshots} onChange={(snapshots) => onFilter({ snapshots })} label={CREATE_COPY.version.snapshots} />
        <Checkbox checked={filter.old} onChange={(old) => onFilter({ old })} label={CREATE_COPY.version.old} />
        {status === "ready" && problem === null && <span className={styles.filterCount}>{count}</span>}
      </div>
      {problem !== null ? (
        <LoadError title={CREATE_COPY.version.loadError} error={problem} onRetry={onRetry} />
      ) : status !== "ready" ? (
        <SkeletonRows label={CREATE_COPY.version.loadingLabel} />
      ) : items.length === 0 ? (
        <EmptyState scene="search" compact titleAs="h4" title={CREATE_COPY.version.noMatch(filter.query.trim())} />
      ) : (
        <VersionList items={items} latestId={latestId} value={value} onChange={onChange} selectedJava={selectedJava} now={now} />
      )}
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
  const roving = useRovingGroup(
    items.map((v) => ({ value: v.id })),
    value,
    onChange,
    false,
  );
  return (
    <div role="radiogroup" aria-label={CREATE_COPY.version.listLabel} className={styles.list} onKeyDown={roving.onKeyDown}>
      {items.map((v, i) => {
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
      {missing.length > 0 && <Callout tone="info">{CREATE_COPY.loader.missing(version.id, missing)}</Callout>}
      {loaderErrors.map((e) => (
        <Callout key={e.loader} tone="warn">
          {CREATE_COPY.loader.unavailable(e.loader, e.message)}
        </Callout>
      ))}
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
  return (
    <>
      <StepHead title={CREATE_COPY.loaderVersion.title(loader)} body={CREATE_COPY.loaderVersion.body} />
      {versions.status === "error" && versions.data === undefined ? (
        <LoadError title={CREATE_COPY.loaderVersion.loadError(loader)} error={versions.error} onRetry={versions.reload} />
      ) : versions.data === undefined ? (
        <SkeletonRows label={CREATE_COPY.loaderVersion.loadingLabel} />
      ) : versions.data.length === 0 ? (
        <EmptyState icon="info" compact titleAs="h4" title={CREATE_COPY.loaderVersion.empty(loader, mcVersion)} body={CREATE_COPY.loaderVersion.emptyBody} />
      ) : (
        <LoaderVersionList loader={loader} items={versions.data} recommended={recommended} value={value} onChange={onChange} />
      )}
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
        const sub = i === 0 ? CREATE_COPY.loaderVersion.newest : v.stable ? CREATE_COPY.loaderVersion.older : CREATE_COPY.loaderVersion.betaNote;
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
  /** 上一次点「创建并开始安装」的错误；没有为 null。 */
  error: unknown;
}

export function ConfirmStep({ name, version, loader, loaderVersion, cover, settings, requirements, willPin, openAfter, onOpenAfter, error }: ConfirmStepProps) {
  const c = CREATE_COPY.confirm;
  const loaderValue = loader === "vanilla" ? c.vanilla : loaderVersion === null ? LOADER_NAME[loader] : `${LOADER_NAME[loader]} ${loaderVersion}`;
  return (
    <>
      {error !== null && (
        <Banner tone="danger" title={c.failed} announce>
          {describeError(error)}
        </Banner>
      )}
      <StepHead title={c.title} body={c.body} />
      <Inset className={styles.summary}>
        <KV
          rows={[
            { label: c.name, value: name },
            { label: c.version, value: c.versionValue(version.id, version.type) },
            { label: c.loader, value: loaderValue },
            { label: c.cover, value: coverLabel(cover.block) },
            { label: c.java, value: settings === null ? <Skeleton shape="text" width={180} /> : <JavaValue requirements={requirements} autoDownload={settings.autoDownloadJava} /> },
            // 体积只统计游戏本体（客户端、库、资源）；有库没标大小时后端给 null，宁可不写也不写一个偏小的数
            ...(requirements.status === "loading"
              ? [{ label: c.download, value: <Skeleton shape="text" width={120} /> }]
              : requirements.status === "ready" && requirements.data.download_bytes !== null
                ? [{ label: c.download, value: <DownloadValue bytes={requirements.data.download_bytes} withLoader={loader !== "vanilla"} /> }]
                : []),
            {
              label: c.path,
              value: settings === null ? <Skeleton shape="text" width={220} /> : <span className={styles.path}>{instancePath(settings.gameDir, name)}</span>,
            },
          ]}
        />
      </Inset>
      {version.type === "snapshot" && (
        <Callout tone="warn" icon="alert">
          {c.snapshotWarning}
        </Callout>
      )}
      <div className={styles.after}>
        <Checkbox checked={openAfter} onChange={onOpenAfter} label={c.openAfter} />
        <span className={styles.afterHint}>{willPin ? c.autoPin : c.pinFull}</span>
      </div>
    </>
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

function JavaValue({ requirements, autoDownload }: { requirements: ResourceResult<VersionRequirementsDto>; autoDownload: boolean }) {
  const runtimes = useJavaRuntimes();
  const c = CREATE_COPY.confirm;
  if (requirements.status === "error") return <>{c.javaUnknown(describeError(requirements.error))}</>;
  if (runtimes.status === "error") return <>{c.javaUnknown(describeError(runtimes.error))}</>;
  if (requirements.status === "loading" || runtimes.status === "loading") return <Skeleton shape="text" width={180} />;
  const major = requirements.data.java_major;
  const installed = bestLocalRuntime(runtimes.data, major);
  if (installed !== null) return <>{c.javaInstalled(major, installed.vendor)}</>;
  return <>{autoDownload ? c.javaAuto(major) : c.javaManual(major)}</>;
}
