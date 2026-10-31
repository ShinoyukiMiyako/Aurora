// 导入本地整合包文件：选文件 -> 读取 -> 确认三步。读取失败留在第一步，按错误码给出原因。
// 文件有四个来源：拖进投放区（第一步期间独占窗口拖放）、「选择文件」的系统对话框、路径输入框，
// 以及外壳在没有接收方时把拖进窗口的整合包经路由带进来（打开弹窗即读取）。
// 确认的内容与资源详情里的整合包面板相同（共用 PackForm），版本只读。

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
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { AUTOFOCUS_ATTR, Modal } from "../../ui/Modal";
import { Spinner } from "../../art/Spinner";
import { TextInput } from "../../ui/TextInput";
import { IMPORT_COPY, MODPACK_COPY, SEARCH_COPY } from "./copy";
import { uniqueName } from "./names";
import { PackForm, packFootNote, type PackFacts } from "./PackForm";
import styles from "./pack.module.css";

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

/** 本地整合包的清单事实。预览只给远程文件数与包内文件数，不区分其中有几个 Mod，Mod 数这一行不显示。 */
export function previewFacts(preview: ModpackPreviewDto): PackFacts {
  return {
    mcVersion: preview.minecraft,
    loader: preview.loader === null ? "vanilla" : preview.loader.kind,
    modCount: null,
    downloadBytes: preview.remote_bytes,
    extra: [
      { icon: "file", text: MODPACK_COPY.remoteFiles(preview.remote_files) },
      { icon: "box", text: MODPACK_COPY.overrides(preview.override_files, preview.override_bytes) },
    ],
  };
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
  const [footerHost, setFooterHost] = useState<HTMLElement | null>(null);
  const preview = useModpackPreview(path);

  const startRead = (file: string | null) => {
    setPath(file);
    setFresh(file === null ? null : { file });
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

  // 重取已读成功的文件时缓存保留旧清单并标记 refreshing：这期间同样算读取中，确认页等新结果出来再画
  const reading = path !== null && (fresh !== null || preview.status === "loading" || preview.refreshing);
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
        <ImportConfirm key={path} path={path} preview={preview.data} online={online} footerHost={footerHost} onBack={() => setPath(null)} onDone={close} />
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

interface ImportConfirmProps {
  path: string;
  preview: ModpackPreviewDto;
  online: boolean;
  footerHost: HTMLElement | null;
  onBack: () => void;
  onDone: () => void;
}

function ImportConfirm({ path, preview, online, footerHost, onBack, onDone }: ImportConfirmProps) {
  const instances = useLauncherSelector((s) => s.instances);
  const actions = useLauncherActions();
  const run = useRunner();
  const existing = instances.map((i) => i.id);
  const [name, setName] = useState(() => uniqueName(preview.name, existing));
  const [cover, setCover] = useState<InstanceCover>(() => defaultModpackCover(preview.name));
  const [submitting, setSubmitting] = useState(false);
  const facts = previewFacts(preview);
  const nameError = instanceNameError(name, existing);

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
          // 清单里待下载的远程文件不只是 Mod（还有资源包、光影），当不了 Mod 数：导入前不知道
          modCount: null,
          mcVersion: preview.minecraft,
          loader: facts.loader,
          loaderVersion: preview.loader === null ? null : preview.loader.version,
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
      {footerHost !== null && (
        <FooterButtons host={footerHost} note={packFootNote(facts)} onBack={onBack} onSubmit={() => void submit()} disabled={nameError !== null} loading={submitting} />
      )}
    </div>
  );
}

function FooterButtons({ host, note, onBack, onSubmit, disabled, loading }: { host: HTMLElement; note: string; onBack: () => void; onSubmit: () => void; disabled: boolean; loading: boolean }) {
  return createPortal(
    <>
      <span className={styles.footNote}>{note}</span>
      <Button variant="ghost" onClick={onBack}>
        {IMPORT_COPY.changeFile}
      </Button>
      <Button variant="primary" icon="upload" disabled={disabled} loading={loading} onClick={onSubmit}>
        {IMPORT_COPY.submit}
      </Button>
    </>,
    host,
  );
}
