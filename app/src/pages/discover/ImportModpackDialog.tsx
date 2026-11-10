// 导入本地整合包文件：选文件 -> 读取 -> 确认三步。读取失败留在第一步，按错误码给出原因。
// 文件有四个来源：拖进投放区（第一步期间独占窗口拖放）、「选择文件」的系统对话框、路径输入框，
// 以及外壳在没有接收方时把拖进窗口的整合包经路由带进来（打开弹窗即读取）。
// 确认的内容与资源详情里的整合包面板相同（共用 PackForm），版本只读；其后列出包内每个 Mod 与其他可选文件，
// 可选文件默认勾上，取消勾选的不下载。还有需要到 CurseForge 网页手动下载的文件时不能导入：打开清单认领完，
// 回到确认步原地重新读一次（名字、封面、勾选都保留），受限数为 0 后才能提交。

import { AnimatePresence, motion, useIsPresent } from "framer-motion";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../art/Icon";
import { defaultModpackCover, type InstanceCover } from "../../art/iso/covers";
import { ACTION_ERROR, taskFailureReason } from "../../copy/flows";
import { instanceNameError } from "../../domain/rules";
import { useLoadingGate, type LoadingView } from "../../lib/loading-gate";
import { fade, tabPanel } from "../../lib/motion";
import { useMounted } from "../../lib/useMounted";
import { useShell } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import { errorRecord } from "../../state/errors";
import { useLauncherActions, useLauncherSelector } from "../../state/launcher";
import { useModpackPreview, type ModpackPreviewDto } from "../../state/queries/discover";
import type { PackModDto } from "../../state/store";
import { Appear } from "../../ui/Appear";
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
import { BlockedFilesModal, Fade } from "./BlockedFilesModal";
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
    // 后端原文写给排查用，与任务失败同一说法才告诉玩家怎么办
    case "curseforge_key_missing":
    case "curseforge_key_rejected":
      return taskFailureReason(record);
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

/** 路径框里的文字：资源管理器「复制文件地址」带着一对双引号，照原样读只会报扩展名不对。 */
export function typedPath(input: string): string {
  const text = input.trim();
  return text.length >= 2 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1).trim() : text;
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

/** 读取面与「正在重新读取」的样子：pending 刚开始读，占着位但看不见；shown 读了一阵还没完，淡入。 */
export type ReadFace = "pending" | "shown";

/**
 * 加载门（lib/loading-gate）下的读取面：正在读，或读完了门还留着读取面（一旦露出至少停留同样久）时有，其余为 null。
 * 本地包常在 300 ms 内读完：门开着时读取面只占位不可见，界面照旧，不闪一下读取面再换结果。
 */
export function readFace(loading: boolean, gate: LoadingView): ReadFace | null {
  if (gate === "skeleton") return "shown";
  return loading ? "pending" : null;
}

/**
 * 选文件步显示的错误。settled 是读完时这一次的错误，held 是上一次读完时的错误。
 * 等待期界面照旧，上一次的错误先留着：读得快又失败时错误条不先收起再冒出来，弹窗也不一缩一涨；
 * 读取面露出时收起；读完按这一次的结果。
 */
export function shownChooseError(face: ReadFace | null, settled: string | null, held: string | null): string | null {
  if (face === null) return settled;
  return face === "pending" ? held : null;
}

/** 确认步里随重读与认领变化的那一处、以及包里有没有其他可选文件；选文件步时为 null。 */
export interface ConfirmShape {
  /** 那一处已换成「正在重新读取」（重读过了等待期才换，等待期照旧是受限说明）。 */
  reread: boolean;
  blocked: number;
  extras: number;
}

/**
 * 弹窗的布局签名，交给 Modal 的 layoutKey：弹窗随输入与读取频繁重渲染，只在步骤、确认步底部那一处说明、
 * 有没有其他可选文件、选文件步的错误变了时才量布局、播形变。
 */
export function importLayoutKey(confirm: ConfirmShape | null, error: string | null): string {
  if (confirm === null) return `choose:${error === null ? "" : error}`;
  return `confirm:${confirm.reread ? "reread" : `blocked:${confirm.blocked}`}:${confirm.extras > 0}`;
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
    const next = typedPath(input);
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
  // 读取面不换掉选文件这一步，叠在投放区里：路径区照常占位，读取开始时弹窗不先缩一截再被确认步撑高。
  // 读取面露着时结果先不画，等门收起再换成确认步或错误
  const readGate = useLoadingGate(reading);
  const face = path === null ? null : readFace(reading, readGate.view);
  const settled = face === null;
  const confirming = path !== null && settled && preview.status === "ready";
  // 认领完的原地重读同样过一道门：快读完时不闪「正在重新读取」
  const rereadGate = useLoadingGate(confirming && preview.refreshing);
  const rereadFace = confirming ? readFace(preview.refreshing, rereadGate.view) : null;
  const settledError = path !== null && settled && preview.status === "error" ? previewErrorText(preview.error) : null;
  // 读完时的错误记下来，下一次读取的等待期里照旧显示它
  const [heldError, setHeldError] = useState<string | null>(null);
  if (settled && heldError !== settledError) setHeldError(settledError);
  const chooseError = shownChooseError(face, settledError, heldError);
  const layoutKey = importLayoutKey(
    confirming ? { reread: rereadFace === "shown", blocked: preview.data.blocked_files.length, extras: preview.data.optional_extras.length } : null,
    chooseError,
  );
  const step = confirming ? "confirm" : "choose";
  return (
    <Modal
      open={request !== null}
      onClose={close}
      title={IMPORT_COPY.title}
      icon="upload"
      size="md"
      layoutKey={layoutKey}
      // 换步时旧的一步整个卸掉，焦点若在里面（「选择文件」、路径框、底栏的「换一个文件」）会掉回 body：
      // 每换一步按打开时的规则重做一次初始聚焦，落到新一步带 data-autofocus 的控件上
      requestKey={step}
      footer={confirming ? <div ref={setFooterHost} className={styles.footerHost} /> : undefined}
    >
      <ImportStep step={step}>
        {confirming ? (
          <ImportConfirm
            key={path}
            path={path}
            preview={preview.data}
            refreshing={preview.refreshing}
            rereadFace={rereadFace}
            online={online}
            footerHost={footerHost}
            onReread={reread}
            onBack={() => startRead(null)}
            onDone={close}
          />
        ) : (
          <ChooseFile
            input={input}
            onInput={setInput}
            onRead={read}
            onFile={openFile}
            reading={path === null || face === null ? null : { face, name: fileName(path) }}
            error={chooseError}
          />
        )}
      </ImportStep>
    </Modal>
  );
}

/**
 * 一步的内容。换步时新的一步淡入并从下方落到位（与标签面板同一套），旧的一步同一帧移走；弹窗随内容变高变矮由
 * Modal 的形变接住（layoutKey 随步骤变）。弹窗打开时就在的那一步跟着弹窗的入场走，不另播一次。
 */
function ImportStep({ step, children }: { step: "choose" | "confirm"; children: ReactNode }) {
  const mounted = useMounted();
  return (
    <motion.div key={step} variants={tabPanel} initial={mounted.current ? "hidden" : false} animate="show">
      {children}
    </motion.div>
  );
}

interface ChooseFileProps {
  input: string;
  onInput: (v: string) => void;
  onRead: () => void;
  /** 拖进来或在系统对话框里选中了一个文件。 */
  onFile: (path: string) => void;
  /** 正在读的文件与读取面的样子；不在读时为 null。 */
  reading: { face: ReadFace; name: string } | null;
  error: string | null;
}

function ChooseFile({ input, onInput, onRead, onFile, reading, error }: ChooseFileProps) {
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

  // 读取期间不再从这里另起一次读取（拖进新文件除外：那是明确换了一个文件）。等待期界面照旧，按钮不先变暗，只挡住点击；
  // 读取面露出后才显示为不可用。控件一直可聚焦，焦点不掉回 body
  const busy = reading !== null;
  const shown = reading !== null && reading.face === "shown";
  const submit = () => {
    if (!busy) onRead();
  };
  const choose = () => {
    if (!busy) pick();
  };

  return (
    <div className={styles.choose}>
      <div className={styles.dropZone} data-drop-zone="" data-state={over ? "over" : shown ? "reading" : undefined} aria-busy={busy || undefined}>
        {/* 选文件面与读取面叠在同一格：换面时投放区不变高 */}
        <motion.div className={styles.dropFace} initial={false} animate={shown ? { opacity: 0, transition: fade.out } : { opacity: 1, transition: fade.in }}>
          <Icon name="upload" size={24} />
          <span className={styles.dropTitle}>{IMPORT_COPY.dropTitle}</span>
          <span className={styles.dropHint}>{IMPORT_COPY.dropHint}</span>
          <span className={styles.dropAction}>
            <Button size="sm" variant="secondary" icon="folder-open" disabled={shown} focusableWhenDisabled onClick={choose} {...{ [AUTOFOCUS_ATTR]: "" }}>
              {IMPORT_COPY.pick}
            </Button>
          </span>
        </motion.div>
        <AnimatePresence>
          {reading !== null && (
            <motion.div
              key="reading"
              className={styles.dropFace}
              aria-hidden={shown ? undefined : true}
              initial={{ opacity: 0 }}
              animate={{ opacity: shown ? 1 : 0, transition: fade.in }}
              exit={{ opacity: 0, transition: fade.out }}
            >
              <Spinner size={24} />
              <span className={styles.dropTitle}>{IMPORT_COPY.reading(reading.name)}</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <div className={styles.pathBlock}>
        <span className={styles.pathCaption}>{IMPORT_COPY.pathCaption}</span>
        <div className={styles.pathRow}>
          <TextInput
            size="sm"
            value={input}
            onChange={onInput}
            onEnter={submit}
            placeholder={IMPORT_COPY.pathPlaceholder}
            aria-label={IMPORT_COPY.pathLabel}
            invalid={error !== null}
          />
          <Button size="sm" variant="ghost" disabled={input.trim() === "" || shown} focusableWhenDisabled={busy} onClick={submit}>
            {IMPORT_COPY.read}
          </Button>
        </div>
      </div>
      <Appear>
        {error !== null && (
          <Callout key="error" tone="danger" announce>
            <span className={styles.selectable}>{error}</span>
          </Callout>
        )}
      </Appear>
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
  const badge =
    status === null ? null : (
      <Tag tone={status.tone} size="sm">
        {status.text}
      </Tag>
    );
  // 认领完重新读取后变的只有受限文件的标签（需手动下载换成已找到）：与清单弹窗里同一种交叉淡化。其余的行不多挂这一层
  const tag = badge !== null && (entry.availability === "blocked" || entry.availability === "claimed") ? <Fade id={entry.availability}>{badge}</Fade> : badge;
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
  /** 「正在重新读取」那一行的样子（过了加载门才露出、露出后至少停留同样久）；不在重读时为 null。 */
  rereadFace: ReadFace | null;
  online: boolean;
  footerHost: HTMLElement | null;
  onReread: () => void;
  onBack: () => void;
  onDone: () => void;
}

function ImportConfirm({ path, preview, refreshing, rereadFace, online, footerHost, onReread, onBack, onDone }: ImportConfirmProps) {
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

  // 重读的等待期里说明还留着，但它列的是旧清单：这时不再打开，免得新结果到了清单在开着时换掉
  const openBlocked = () => {
    if (!refreshing) setBlockedOpen(true);
  };
  // 确认步的焦点落点：换到这一步时初始聚焦的那个控件（名称框）
  const root = useRef<HTMLDivElement>(null);
  const focusAnchor = useCallback(() => {
    const anchor = root.current?.querySelector<HTMLElement>(`[${AUTOFOCUS_ATTR}]`);
    if (anchor === null || anchor === undefined) throw new Error("确认步没有焦点落点");
    anchor.focus();
  }, []);

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
    <div ref={root} className={styles.confirm}>
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
        nameAutoFocus
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
      {/* 受限文件的说明与「正在重新读取」轮流占底部这一处，弹窗随之形变（layoutKey）。重读的等待期界面照旧，说明连同按钮
          留着：读得快时只在结果出来（受限数归零）后收起一次；读得慢时等待期过了才换成重读行 */}
      <Appear>
        {rereadFace === "shown" ? (
          <RereadLine key="reread" name={fileName(path)} />
        ) : blocked.length > 0 ? (
          <Callout key="blocked" tone="warn" action={<ViewBlockedButton onClick={openBlocked} onLeave={focusAnchor} />}>
            {IMPORT_COPY.blockedNotice(blocked.length)}
          </Callout>
        ) : null}
      </Appear>
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

/** 「正在重新读取」一行。 */
function RereadLine({ name }: { name: string }) {
  return (
    <div className={styles.rereading} aria-busy="true">
      <Spinner size={16} />
      <span>{IMPORT_COPY.rereading(name)}</span>
    </div>
  );
}

/**
 * 受限说明里的「查看这些文件」。说明块退场时它留在块里一起淡出：先拿掉的话，说明文字会在淡出途中铺进它让出的位置。
 * 退场层不可交互，它若正聚焦着（清单关上时焦点还给了它，说明随后才收起），焦点交给确认步的落点（onLeave），不掉回 body。
 */
function ViewBlockedButton({ onClick, onLeave }: { onClick: () => void; onLeave: () => void }) {
  const present = useIsPresent();
  const ref = useRef<HTMLButtonElement>(null);
  // 在布局阶段接走：浏览器要到之后才把留在 inert 子树里的焦点挪回 body，这时焦点还在按钮上。
  // 只接按钮自己身上的焦点：整个弹窗关上时退场也会传到这里，那时焦点已由弹窗还给打开它的地方，不能再拉回来
  useLayoutEffect(() => {
    if (present || document.activeElement !== ref.current) return;
    onLeave();
  }, [present, onLeave]);
  return (
    <Button ref={ref} size="sm" variant="ghost" onClick={onClick}>
      {IMPORT_COPY.viewBlocked}
    </Button>
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
