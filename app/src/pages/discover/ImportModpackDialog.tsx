// 导入本地整合包文件：选文件 -> 读取 -> 确认三步。读取失败留在第一步，按错误码给出原因。
// 确认的内容与资源详情里的整合包面板相同（共用 PackForm），版本只读。

import { useState, type DragEvent } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../art/Icon";
import { defaultModpackCover, type InstanceCover } from "../../art/iso/covers";
import { ACTION_ERROR } from "../../copy/flows";
import { instanceNameError } from "../../domain/rules";
import { useRunner } from "../../shell/useRunner";
import { errorRecord } from "../../state/errors";
import { useLauncher } from "../../state/launcher";
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

export interface ImportModpackDialogProps {
  open: boolean;
  onClose: () => void;
  online: boolean;
}

export function ImportModpackDialog({ open, onClose, online }: ImportModpackDialogProps) {
  const [input, setInput] = useState("");
  const [path, setPath] = useState<string | null>(null);
  const [footerHost, setFooterHost] = useState<HTMLElement | null>(null);
  const preview = useModpackPreview(path);

  const read = () => {
    const next = input.trim();
    if (next === "") return;
    if (next === path && preview.status === "error") preview.reload();
    else setPath(next);
  };
  const close = () => {
    setPath(null);
    setInput("");
    onClose();
  };

  const confirming = path !== null && preview.status === "ready";
  return (
    <Modal
      open={open}
      onClose={close}
      title={IMPORT_COPY.title}
      icon="upload"
      size="md"
      footer={confirming ? <div ref={setFooterHost} className={styles.footerHost} /> : undefined}
    >
      {confirming ? (
        <ImportConfirm key={path} path={path} preview={preview.data} online={online} footerHost={footerHost} onBack={() => setPath(null)} onDone={close} />
      ) : path !== null && preview.status === "loading" ? (
        <div className={styles.dropZone} data-state="reading" aria-busy="true">
          <Spinner size={24} />
          <span className={styles.dropTitle}>{IMPORT_COPY.reading(fileName(path))}</span>
        </div>
      ) : (
        <ChooseFile input={input} onInput={setInput} onRead={read} error={path !== null && preview.status === "error" ? previewErrorText(preview.error) : null} />
      )}
    </Modal>
  );
}

function ChooseFile({ input, onInput, onRead, error }: { input: string; onInput: (v: string) => void; onRead: () => void; error: string | null }) {
  // 文件拖进网页时浏览器默认会打开它，整个界面被换掉；投放区拦下默认行为
  const block = (event: DragEvent<HTMLDivElement>) => event.preventDefault();
  return (
    <div className={styles.choose}>
      <div className={styles.dropZone} onDragOver={block} onDrop={block}>
        <Icon name="upload" size={24} />
        <span className={styles.dropTitle}>{IMPORT_COPY.dropTitle}</span>
        <span className={styles.dropHint}>{IMPORT_COPY.dropHint}</span>
        <div className={styles.pathRow}>
          <TextInput
            size="sm"
            value={input}
            onChange={onInput}
            onEnter={onRead}
            placeholder={IMPORT_COPY.pathPlaceholder}
            aria-label={IMPORT_COPY.pathLabel}
            invalid={error !== null}
            {...{ [AUTOFOCUS_ATTR]: "" }}
          />
          <Button size="sm" variant="secondary" disabled={input.trim() === ""} onClick={onRead}>
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
  const { state, actions } = useLauncher();
  const run = useRunner();
  const existing = state.instances.map((i) => i.id);
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
          // 状态层要一个数字；清单里待下载的远程文件数是导入前能拿到的最接近 Mod 数的量
          modCount: preview.remote_files,
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
