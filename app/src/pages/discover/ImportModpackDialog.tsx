// 导入本地整合包文件：选文件 -> 读取 -> 确认三步。读取失败留在第一步，按错误码给出原因。
// 文件有四个来源：拖进投放区（第一步期间独占窗口拖放）、「选择文件」的系统对话框、路径输入框，
// 以及外壳在没有接收方时把拖进窗口的整合包经路由带进来（打开弹窗即读取）。
// 确认的内容与资源详情里的整合包面板相同（共用 PackForm），版本只读；其后列出包内每个 Mod 与其他可选文件，
// 可选文件默认勾上，取消勾选的不下载。还有需要到 CurseForge 网页手动下载的文件时不能导入：打开清单认领完，
// 回到确认步原地重新读一次（名字、封面、勾选都保留），受限数为 0 后才能提交。

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../art/Icon";
import { defaultModpackCover, type InstanceCover } from "../../art/iso/covers";
import { ACTION_ERROR } from "../../copy/flows";
import { instanceNameError } from "../../domain/rules";
import { useShell } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import { errorRecord } from "../../state/errors";
import { useLauncherActions, useLauncherSelector } from "../../state/launcher";
import { useModpackPreview, type ModpackPreviewDto } from "../../state/queries/discover";
import type { PackModDto } from "../../state/store";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Checkbox } from "../../ui/Checkbox";
import { List, ListRow } from "../../ui/ListRow";
import { AUTOFOCUS_ATTR, Modal } from "../../ui/Modal";
import { Spinner } from "../../art/Spinner";
import { SectionTitle } from "../../ui/SectionTitle";
import { Tag } from "../../ui/Tag";
import { TextInput } from "../../ui/TextInput";
import { Tooltip } from "../../ui/Tooltip";
import { BlockedFilesModal } from "./BlockedFilesModal";
import { IMPORT_COPY, MODPACK_COPY, SEARCH_COPY } from "./copy";
import { uniqueName } from "./names";
import { PackForm, packFootNote, type PackFacts } from "./PackForm";
import styles from "./pack.module.css";

/** modpack_unsupported_compression 带着解码后的条目名（detail.entry）；没带说明后端违反了错误契约。 */
function compressionEntry(error: unknown): string {
  const detail = typeof error === "object" && error !== null && "detail" in error ? (error as { detail: unknown }).detail : undefined;
  const entry = typeof detail === "object" && detail !== null ? (detail as Record<string, unknown>).entry : undefined;
  if (typeof entry !== "string" || entry === "") throw new Error(`modpack_unsupported_compression 没有带条目名：${errorRecord(error).message}`);
  return entry;
}

/** 读取失败的原因：能归类的给统一说法，其余用后端原文。 */
export function previewErrorText(error: unknown): string {
  const record = errorRecord(error);
  switch (record.code) {
    case "modpack_unsupported_extension":
      return IMPORT_COPY.errorExtension;
    case "modpack_manifest_missing":
      return IMPORT_COPY.errorManifestMissing;
    case "modpack_manifest_invalid":
      return IMPORT_COPY.errorManifestInvalid(record.message);
    case "modpack_corrupt":
      return IMPORT_COPY.errorCorrupt;
    case "modpack_unsupported_compression":
      return IMPORT_COPY.errorCompression(compressionEntry(error));
    // 只有 CurseForge 包的预览会联网（清单不带落点与大小，要问平台）
    case "network_failed":
      return IMPORT_COPY.errorNetwork;
    default:
      return record.message;
  }
}

function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1];
}

const PACK_EXTENSION = /\.(mrpack|zip)$/i;

/**
 * 一次拖进几个文件时读哪一个：第一个整合包；一个整合包都没有时读第一个，由后端按扩展名说明只认哪两种。
 * 拖进来的不是文件（没有路径）时为 null。
 */
export function droppedFile(paths: readonly string[]): string | null {
  if (paths.length === 0) return null;
  const pack = paths.find((p) => PACK_EXTENSION.test(p));
  return pack === undefined ? paths[0] : pack;
}

/** 本地整合包的清单事实。Mod 数与平台摘要同一口径（落进 mods/ 的远程文件加上覆盖层 mods/ 下的 .jar）。 */
export function previewFacts(preview: ModpackPreviewDto): PackFacts {
  return {
    mcVersion: preview.minecraft,
    loader: preview.loader === null ? "vanilla" : preview.loader.kind,
    modCount: preview.mod_files,
    downloadBytes: preview.remote_bytes,
    extra: [
      { icon: "file", text: MODPACK_COPY.remoteFiles(preview.remote_files) },
      { icon: "box", text: MODPACK_COPY.overrides(preview.override_files, preview.override_bytes) },
    ],
  };
}

/** 提交时跳过的可选文件：按清单顺序，只取这一份清单里还是可选的（重新读取后清单可能变了）。 */
export function excludedPaths(preview: ModpackPreviewDto, excluded: ReadonlySet<string>): string[] {
  return [...preview.mods, ...preview.optional_extras].filter((m) => m.optional && excluded.has(m.path)).map((m) => m.path);
}

/** 打开导入弹窗的请求：带着文件时打开即读取它。每次打开都是新对象，弹窗据此重置。 */
export interface ImportRequest {
  file: string | null;
}

export interface ImportModpackDialogProps {
  /** null 为关闭。 */
  request: ImportRequest | null;
  onClose: () => void;
  online: boolean;
}

/** 一次「开始读这个文件」：每次开始都是新对象，同一个文件连着读两次也分得清。 */
interface FreshRead {
  file: string;
}

export function ImportModpackDialog({ request, onClose, online }: ImportModpackDialogProps) {
  const [input, setInput] = useState("");
  const [path, setPath] = useState<string | null>(null);
  // 预览缓存里可能还留着这个文件上次的结果：读失败的错误（文件当时没下载完）、文件换过之前的清单。
  // 所以每次开始读一个文件都重新发起请求，这一轮请求发出之前不看缓存里的旧结果
  const [fresh, setFresh] = useState<FreshRead | null>(null);
  const refreshed = useRef<FreshRead | null>(null);
  // 认领完回到确认步后的重新读取：确认步原地等新结果（名字、封面、勾选都保留），不退回读取页
  const [rereading, setRereading] = useState(false);
  const [footerHost, setFooterHost] = useState<HTMLElement | null>(null);
  const preview = useModpackPreview(path);

  const startRead = (file: string | null) => {
    setPath(file);
    setFresh(file === null ? null : { file });
    setRereading(false);
  };

  // 新的打开请求：带着文件就直接进入读取，否则从选文件开始
  const [handled, setHandled] = useState<ImportRequest | null>(null);
  if (request !== handled) {
    setHandled(request);
    if (request !== null) {
      startRead(request.file);
      setInput(request.file === null ? "" : request.file);
    }
  }

  const { status: previewStatus, reload: reloadPreview } = preview;
  useEffect(() => {
    // 开发构建的严格模式会把同一次 effect 再跑一遍：同一轮读取只重取一次
    if (fresh === null || refreshed.current === fresh) return;
    refreshed.current = fresh;
    // 缓存里没有这个文件时，订阅本身就会发出请求；留着旧结果时才需要重取
    if (previewStatus !== "loading") reloadPreview();
    setFresh(null);
  }, [fresh, previewStatus, reloadPreview]);

  const openFile = (file: string) => {
    setInput(file);
    startRead(file);
  };
  const read = () => {
    const next = input.trim();
    if (next !== "") openFile(next);
  };
  const close = () => {
    startRead(null);
    setInput("");
    onClose();
  };
  const reread = () => {
    setRereading(true);
    reloadPreview();
  };

  // 重取已读成功的文件时缓存保留旧清单并标记 refreshing：这期间同样算读取中，确认页等新结果出来再画；
  // 认领完的重新读取除外，确认页留着
  const reading = path !== null && (fresh !== null || preview.status === "loading" || (preview.refreshing && !rereading));
  const confirming = path !== null && !reading && preview.status === "ready";
  return (
    <Modal
      open={request !== null}
      onClose={close}
      title={IMPORT_COPY.title}
      icon="upload"
      size="md"
      footer={confirming ? <div ref={setFooterHost} className={styles.footerHost} /> : undefined}
    >
      {confirming ? (
        <ImportConfirm
          key={path}
          path={path}
          preview={preview.data}
          refreshing={preview.refreshing}
          online={online}
          footerHost={footerHost}
          onReread={reread}
          onBack={() => startRead(null)}
          onDone={close}
        />
      ) : path !== null && reading ? (
        <div className={styles.dropZone} data-state="reading" aria-busy="true">
          <Spinner size={24} />
          <span className={styles.dropTitle}>{IMPORT_COPY.reading(fileName(path))}</span>
        </div>
      ) : (
        <ChooseFile
          input={input}
          onInput={setInput}
          onRead={read}
          onFile={openFile}
          error={path !== null && preview.status === "error" ? previewErrorText(preview.error) : null}
        />
      )}
    </Modal>
  );
}

interface ChooseFileProps {
  input: string;
  onInput: (v: string) => void;
  onRead: () => void;
  /** 拖进来或在系统对话框里选中了一个文件。 */
  onFile: (path: string) => void;
  error: string | null;
}

function ChooseFile({ input, onInput, onRead, onFile, error }: ChooseFileProps) {
  const { registerFileDrop, pickFile } = useShell();
  const run = useRunner();
  const [over, setOver] = useState(false);

  // 第一步期间独占窗口拖放（外壳不再自己导航）；只登记一次，回调经 ref 取最新的，不随每次渲染注销重登
  const onFileRef = useRef(onFile);
  useLayoutEffect(() => {
    onFileRef.current = onFile;
  });
  useEffect(
    () =>
      registerFileDrop({
        onEnter: () => setOver(true),
        onLeave: () => setOver(false),
        onDrop: (paths) => {
          setOver(false);
          const file = droppedFile(paths);
          if (file !== null) onFileRef.current(file);
        },
      }),
    [registerFileDrop],
  );

  const pick = useCallback(
    () =>
      void run(async () => {
        const file = await pickFile("modpack");
        if (file !== null) onFileRef.current(file);
      }, IMPORT_COPY.pickFailed),
    [pickFile, run],
  );

  return (
    <div className={styles.choose}>
      <div className={styles.dropZone} data-drop-zone="" data-state={over ? "over" : undefined}>
        <Icon name="upload" size={24} />
        <span className={styles.dropTitle}>{IMPORT_COPY.dropTitle}</span>
        <span className={styles.dropHint}>{IMPORT_COPY.dropHint}</span>
        <span className={styles.dropAction}>
          <Button size="sm" variant="secondary" icon="folder-open" onClick={pick} {...{ [AUTOFOCUS_ATTR]: "" }}>
            {IMPORT_COPY.pick}
          </Button>
        </span>
      </div>
      <div className={styles.pathBlock}>
        <span className={styles.pathCaption}>{IMPORT_COPY.pathCaption}</span>
        <div className={styles.pathRow}>
          <TextInput
            size="sm"
            value={input}
            onChange={onInput}
            onEnter={onRead}
            placeholder={IMPORT_COPY.pathPlaceholder}
            aria-label={IMPORT_COPY.pathLabel}
            invalid={error !== null}
          />
          <Button size="sm" variant="ghost" disabled={input.trim() === ""} onClick={onRead}>
            {IMPORT_COPY.read}
          </Button>
        </div>
      </div>
      {error !== null && (
        <Callout tone="danger" announce>
          <span className={styles.selectable}>{error}</span>
        </Callout>
      )}
    </div>
  );
}

/** 清单行右侧的状态标签：照常下载的不标，可选文件标「可选」。 */
function availabilityTag(entry: PackModDto): { tone: "neutral" | "warn" | "ok"; text: string } | null {
  switch (entry.availability) {
    case "bundled":
      return { tone: "neutral", text: IMPORT_COPY.tagBundled };
    case "blocked":
      return { tone: "warn", text: IMPORT_COPY.tagBlocked };
    case "claimed":
      return { tone: "ok", text: IMPORT_COPY.tagFound };
    case "download":
      return entry.optional ? { tone: "neutral", text: IMPORT_COPY.tagOptional } : null;
  }
}

interface PackFileRowProps {
  entry: PackModDto;
  included: boolean;
  /** 窄档：状态标签放到文件名下一行，勾选框仍在行尾。 */
  narrow: boolean;
  disabled: boolean;
  onToggle: (path: string, include: boolean) => void;
}

function PackFileRow({ entry, included, narrow, disabled, onToggle }: PackFileRowProps) {
  const status = availabilityTag(entry);
  const tag =
    status === null ? null : (
      <Tag tone={status.tone} size="sm">
        {status.text}
      </Tag>
    );
  const checkbox = entry.optional ? (
    <Checkbox checked={included} disabled={disabled} onChange={(next) => onToggle(entry.path, next)} ariaLabel={IMPORT_COPY.optionalLabel(entry.file_name)} />
  ) : null;
  const trailingTag = narrow ? null : tag;
  return (
    <ListRow
      size="sm"
      title={
        <Tooltip content={entry.path}>
          <span className={styles.modName}>{entry.file_name}</span>
        </Tooltip>
      }
      meta={narrow && tag !== null ? <span className={styles.modTagBelow}>{tag}</span> : undefined}
      trailing={
        trailingTag === null && checkbox === null ? undefined : (
          <span className={styles.modTrailing}>
            {trailingTag}
            {checkbox}
          </span>
        )
      }
    />
  );
}

interface ImportConfirmProps {
  path: string;
  preview: ModpackPreviewDto;
  /** 认领完正在重新读取：先照旧显示清单，等新结果出来。 */
  refreshing: boolean;
  online: boolean;
  footerHost: HTMLElement | null;
  onReread: () => void;
  onBack: () => void;
  onDone: () => void;
}

function ImportConfirm({ path, preview, refreshing, online, footerHost, onReread, onBack, onDone }: ImportConfirmProps) {
  const instances = useLauncherSelector((s) => s.instances);
  const actions = useLauncherActions();
  const run = useRunner();
  const { tier } = useShell();
  const existing = instances.map((i) => i.id);
  const [name, setName] = useState(() => uniqueName(preview.name, existing));
  const [cover, setCover] = useState<InstanceCover>(() => defaultModpackCover(preview.name));
  const [submitting, setSubmitting] = useState(false);
  // 取消勾选的可选文件落点；默认全部勾上
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(() => new Set());
  const [blockedOpen, setBlockedOpen] = useState(false);
  const facts = previewFacts(preview);
  // 与平台整合包面板同理：校验与提交用同一个去掉首尾空格的名字
  const nameError = instanceNameError(name.trim(), existing);
  const blocked = preview.blocked_files;
  const narrow = tier === "compact";

  const toggle = (file: string, include: boolean) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      if (include) next.delete(file);
      else next.add(file);
      return next;
    });

  const submit = async () => {
    if (!online) {
      actions.toast("warning", SEARCH_COPY.offlineInstall, SEARCH_COPY.offlineInstallBody);
      return;
    }
    const finalName = name.trim();
    setSubmitting(true);
    const result = await run(
      () =>
        actions.installModpack({
          source: { kind: "file", path },
          name: finalName,
          cover: cover.block,
          packName: preview.name,
          packVersion: preview.version === null ? IMPORT_COPY.unversioned : preview.version,
          modCount: preview.mod_files,
          mcVersion: preview.minecraft,
          loader: facts.loader,
          loaderVersion: preview.loader === null ? null : preview.loader.version,
          excludedOptional: excludedPaths(preview, excluded),
        }),
      ACTION_ERROR.importModpack,
    );
    setSubmitting(false);
    if (!result.ok) return;
    actions.toast("info", IMPORT_COPY.started(result.value), IMPORT_COPY.startedBody);
    onDone();
  };

  return (
    <div className={styles.confirm}>
      <PackForm
        seed={preview.name}
        name={name}
        onName={setName}
        nameError={nameError}
        cover={cover}
        onCover={setCover}
        version={<span className={styles.readonlyVersion}>{IMPORT_COPY.versionReadonly(preview.version)}</span>}
        facts={facts}
        readOnly={false}
      />
      <section className={styles.modSection} aria-label={IMPORT_COPY.modsLabel}>
        <SectionTitle level={3}>{IMPORT_COPY.modsTitle(preview.mod_files)}</SectionTitle>
        <div className={styles.modList}>
          <List aria-label={IMPORT_COPY.modsLabel}>
            {preview.mods.map((entry) => (
              <PackFileRow key={entry.path} entry={entry} included={!excluded.has(entry.path)} narrow={narrow} disabled={submitting} onToggle={toggle} />
            ))}
          </List>
        </div>
      </section>
      {preview.optional_extras.length > 0 && (
        <section className={styles.modSection} aria-label={IMPORT_COPY.extrasTitle}>
          <SectionTitle level={3}>{IMPORT_COPY.extrasTitle}</SectionTitle>
          <List aria-label={IMPORT_COPY.extrasTitle}>
            {preview.optional_extras.map((entry) => (
              <PackFileRow key={entry.path} entry={entry} included={!excluded.has(entry.path)} narrow={narrow} disabled={submitting} onToggle={toggle} />
            ))}
          </List>
        </section>
      )}
      {refreshing ? (
        <div className={styles.rereading} aria-busy="true">
          <Spinner size={16} />
          <span>{IMPORT_COPY.rereading(fileName(path))}</span>
        </div>
      ) : (
        blocked.length > 0 && (
          <Callout
            tone="warn"
            action={
              <Button size="sm" variant="ghost" onClick={() => setBlockedOpen(true)}>
                {IMPORT_COPY.viewBlocked}
              </Button>
            }
          >
            {IMPORT_COPY.blockedNotice(blocked.length)}
          </Callout>
        )
      )}
      <BlockedFilesModal
        open={blockedOpen}
        files={blocked}
        origin="import"
        onClose={() => setBlockedOpen(false)}
        onAllFound={() => {
          setBlockedOpen(false);
          onReread();
        }}
      />
      {footerHost !== null && (
        <FooterButtons
          host={footerHost}
          note={packFootNote(facts)}
          onBack={onBack}
          onSubmit={() => void submit()}
          disabled={nameError !== null || refreshing}
          disabledReason={blocked.length > 0 ? IMPORT_COPY.submitBlocked(blocked.length) : undefined}
          loading={submitting}
        />
      )}
    </div>
  );
}

interface FooterButtonsProps {
  host: HTMLElement;
  note: string;
  onBack: () => void;
  onSubmit: () => void;
  disabled: boolean;
  /** 还有需要手动下载的文件：主按钮保持可聚焦，悬停说明还差几个。 */
  disabledReason: string | undefined;
  loading: boolean;
}

function FooterButtons({ host, note, onBack, onSubmit, disabled, disabledReason, loading }: FooterButtonsProps) {
  return createPortal(
    <>
      <span className={styles.footNote}>{note}</span>
      <Button variant="ghost" onClick={onBack}>
        {IMPORT_COPY.changeFile}
      </Button>
      <Button variant="primary" icon="upload" disabled={disabled} disabledReason={disabledReason} loading={loading} onClick={onSubmit}>
        {IMPORT_COPY.submit}
      </Button>
    </>,
    host,
  );
}
