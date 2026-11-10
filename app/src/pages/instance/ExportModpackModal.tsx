// 导出整合包：读取此刻的盘面 -> 确认名称、版本号与一起打包的内容 -> 系统保存对话框选位置 -> 入队导出任务。
// 头图经 AnimatePresence 只在打开时挂载它；它自己只订阅导出预览，实例的名字、状态与锁定原因由头图经 props 给出，
// 任务进度一概不订阅。每次打开都重新读取，不用上次的结果。
//
// 弹窗面板随内容形变（读取态换成表单、展开清单、跳过说明出没）只在渲染 Modal 的这一层重渲染时才接得住，
// 所以会改变布局的状态（读取的加载门、清单展开）都放在这一层，不放进表单自己的 state。

import { useState } from "react";
import { Spinner } from "../../art/Spinner";
import { ACTION_ERROR, LOADER_NAME } from "../../copy/flows";
import type { InstanceSummary } from "../../domain/adapt";
import { useLoadingGate } from "../../lib/loading-gate";
import { useReflow } from "../../lib/reflow";
import { useShell } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import { errorRecord } from "../../state/errors";
import { useLauncherActions } from "../../state/launcher";
import {
  EXPORT_EXTRAS,
  useModpackExportPreview,
  type ExportExtra,
  type ExportExtraStatDto,
  type ModpackExportOptions,
  type ModpackExportPreviewDto,
} from "../../state/queries/instance";
import { Appear } from "../../ui/Appear";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Checkbox } from "../../ui/Checkbox";
import { Field } from "../../ui/Field";
import { Inset } from "../../ui/Inset";
import { KV } from "../../ui/KV";
import { Loadable } from "../../ui/Loadable";
import { Modal } from "../../ui/Modal";
import { SectionTitle } from "../../ui/SectionTitle";
import { Textarea } from "../../ui/Textarea";
import { TextInput } from "../../ui/TextInput";
import { EXPORT_COPY } from "./copy";
import styles from "./export.module.css";

/** 与后端的参数上限一致（按 UTF-16 码元计，与 maxLength 的计法相同）。 */
const NAME_MAX = 64;
const VERSION_MAX = 32;
const SUMMARY_MAX = 256;

// Windows 文件名里不允许的字符与控制字符
const UNSAFE_FILE_CHARS = /[\\/:*?"<>|\p{Cc}]/gu;

/** 保存对话框的默认文件名：「<名称> <版本号>.mrpack」，文件名里不能用的字符换成「_」。 */
export function defaultExportFileName(name: string, version: string): string {
  return `${`${name.trim()} ${version.trim()}`.replace(UNSAFE_FILE_CHARS, "_")}.mrpack`;
}

interface Draft {
  name: string;
  version: string;
  summary: string;
  extras: ReadonlySet<ExportExtra>;
  includeDisabled: boolean;
}

function initialDraft(preview: ModpackExportPreviewDto): Draft {
  return {
    name: preview.name,
    version: preview.version,
    summary: "",
    extras: new Set(preview.extras.filter((e) => e.default_selected).map((e) => e.extra)),
    includeDisabled: false,
  };
}

function statOf(preview: ModpackExportPreviewDto, extra: ExportExtra): ExportExtraStatDto {
  const stat = preview.extras.find((e) => e.extra === extra);
  if (stat === undefined) throw new Error(`导出预览缺少 ${extra} 的统计`);
  return stat;
}

/** 打包进文件的部分：勾选的额外项 + 不在 Modrinth 上的 Mod + 勾选时的停用 Mod。 */
export function bundledTotals(preview: ModpackExportPreviewDto, draft: Pick<Draft, "extras" | "includeDisabled">): { files: number; bytes: number } {
  const extras = preview.extras.filter((e) => draft.extras.has(e.extra));
  const mods = draft.includeDisabled ? [...preview.bundled, ...preview.disabled] : preview.bundled;
  return {
    files: extras.reduce((n, e) => n + e.files, 0) + mods.length,
    bytes: extras.reduce((n, e) => n + e.bytes, 0) + mods.reduce((n, m) => n + m.size, 0),
  };
}

/** 这次带不带停用的 Mod：一个能带的都没有时不给勾选框，勾选留在草稿里也不算。 */
function carriesDisabled(preview: ModpackExportPreviewDto, draft: Pick<Draft, "includeDisabled">): boolean {
  return draft.includeDisabled && preview.disabled.length > 0;
}

/**
 * 这次导出会跳过的文件数，与导出结果的 skipped 同一口径：启用的 jar 总算，停用的 jar 带上才算，额外项的只算勾上的。
 */
export function skippedCount(preview: ModpackExportPreviewDto, extras: ReadonlySet<ExportExtra>, includeDisabled: boolean): number {
  const mods = preview.mod_skipped.length + (includeDisabled ? preview.disabled_skipped.length : 0);
  return preview.extras.filter((e) => extras.has(e.extra)).reduce((n, e) => n + e.skipped.length, mods);
}

/** 这次实际打包的额外项：存档被占着时勾选留在草稿里，放开后恢复，这一次不算。 */
export function effectiveExtras(extras: ReadonlySet<ExportExtra>, savesReason: string | undefined): ReadonlySet<ExportExtra> {
  if (savesReason === undefined || !extras.has("saves")) return extras;
  const next = new Set(extras);
  next.delete("saves");
  return next;
}

export interface ExportModpackModalProps {
  inst: InstanceSummary;
  /** 实例此刻不能导出的原因（与头图菜单项同一条）；打开期间实例被锁时主按钮据此禁用，已填的内容保留。 */
  lockReason: string | undefined;
  /** 此刻不能带上存档的原因：只禁用存档这一项，别的内容照常导出。 */
  savesReason: string | undefined;
  onClose(): void;
}

export function ExportModpackModal({ inst, lockReason, savesReason, onClose }: ExportModpackModalProps) {
  const { saveFile } = useShell();
  const run = useRunner();
  const actions = useLauncherActions();
  const preview = useModpackExportPreview(inst.id);
  // 读取很快回来时不出转圈；转圈一旦出现至少停留一会儿，表单等它收起再换上
  const gate = useLoadingGate(preview.status === "loading");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [picking, setPicking] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  // 第一次读到盘面时按它的默认值起草；读取失败后重试成功也从这里起草
  if (draft === null && preview.status === "ready") setDraft(initialDraft(preview.data));

  const loader = inst.loader === "vanilla" ? null : inst.loaderVersion === null ? LOADER_NAME[inst.loader] : `${LOADER_NAME[inst.loader]} ${inst.loaderVersion}`;

  const settled = gate.view === "content";
  const confirming = settled && preview.status === "ready" && draft !== null;
  // 主按钮常驻：读取中、读取失败时带原因禁用，读到后原位变成可用；不在读到时才插进底栏，把「取消」挤开
  const submitReason = !confirming
    ? settled && preview.status === "error"
      ? errorRecord(preview.error).message
      : EXPORT_COPY.reading
    : draft.name.trim() === ""
      ? EXPORT_COPY.needName
      : draft.version.trim() === ""
        ? EXPORT_COPY.needVersion
        : lockReason;
  const skipped = confirming ? skippedCount(preview.data, effectiveExtras(draft.extras, savesReason), carriesDisabled(preview.data, draft)) : 0;

  const submit = async () => {
    if (!confirming) throw new Error("没读到导出预览时不能导出");
    setPicking(true);
    const picked = await run(() => saveFile("mrpack", defaultExportFileName(draft.name, draft.version)), ACTION_ERROR.exportModpack);
    setPicking(false);
    // 对话框被取消：留在弹窗里，什么都不做
    if (!picked.ok || picked.value === null) return;
    const summary = draft.summary.trim();
    const options: ModpackExportOptions = {
      destination: picked.value,
      name: draft.name.trim(),
      version: draft.version.trim(),
      summary: summary === "" ? null : summary,
      extras: EXPORT_EXTRAS.filter((e) => effectiveExtras(draft.extras, savesReason).has(e)),
      include_disabled: carriesDisabled(preview.data, draft),
    };
    onClose();
    await run(() => actions.exportModpack(inst.id, options), ACTION_ERROR.exportModpack);
  };

  const footer = (
    <>
      <Button variant="ghost" onClick={onClose}>
        {EXPORT_COPY.cancel}
      </Button>
      <Button variant="primary" icon="modpack" loading={picking} disabledReason={submitReason} onClick={() => void submit()}>
        {EXPORT_COPY.submit}
      </Button>
    </>
  );

  // 名称、版本号、简介逐字输入时这一层每次都重渲染：面板只在会改变布局的状态变了时才量尺寸、形变
  const layoutKey = `${gate.view}:${preview.status}:${listOpen ? "list" : ""}:${skipped > 0 ? "skipped" : ""}`;
  return (
    <Modal
      open
      onClose={onClose}
      title={EXPORT_COPY.title}
      icon="modpack"
      subtitle={EXPORT_COPY.subtitle(inst.name, inst.mcVersion, loader)}
      size="md"
      footer={footer}
      layoutKey={layoutKey}
    >
      <Loadable
        view={gate.view}
        skeleton={
          <div className={styles.reading}>
            <Spinner size={24} decorative />
            <span>{EXPORT_COPY.reading}</span>
          </div>
        }
      >
        {() => {
          if (preview.status === "error") {
            return (
              <Callout
                tone="danger"
                announce
                action={
                  <Button variant="ghost" size="sm" onClick={preview.reload}>
                    {EXPORT_COPY.retry}
                  </Button>
                }
              >
                {errorRecord(preview.error).message}
              </Callout>
            );
          }
          if (preview.status !== "ready" || draft === null) throw new Error("导出预览已经读到，却没有按它起草");
          return <ExportForm preview={preview.data} draft={draft} savesReason={savesReason} skipped={skipped} listOpen={listOpen} onListOpen={setListOpen} onDraft={setDraft} />;
        }}
      </Loadable>
    </Modal>
  );
}

interface ExportFormProps {
  preview: ModpackExportPreviewDto;
  draft: Draft;
  savesReason: string | undefined;
  /** 这次会跳过的文件数（见 skippedCount）。 */
  skipped: number;
  /** 不在 Modrinth 上的 Mod 清单是否展开。 */
  listOpen: boolean;
  onListOpen(open: boolean): void;
  onDraft(next: Draft): void;
}

function ExportForm({ preview, draft, savesReason, skipped, listOpen, onListOpen, onDraft }: ExportFormProps) {
  const { tier } = useShell();
  const compact = tier === "compact";
  // 清单展开、跳过说明出没时，排在后面的块从原位置滑过去
  const reflow = useReflow<HTMLDivElement>();
  const extras = effectiveExtras(draft.extras, savesReason);
  const totals = bundledTotals(preview, { extras, includeDisabled: draft.includeDisabled });

  const toggleExtra = (extra: ExportExtra, on: boolean) => {
    const next = new Set(draft.extras);
    if (on) next.add(extra);
    else next.delete(extra);
    onDraft({ ...draft, extras: next });
  };

  return (
    <div ref={reflow} className={styles.form}>
      <div className={styles.basics} data-compact={compact ? "" : undefined}>
        <Field label={EXPORT_COPY.nameLabel}>
          <TextInput value={draft.name} onChange={(name) => onDraft({ ...draft, name })} size="md" maxLength={NAME_MAX} data-autofocus="" />
        </Field>
        <Field label={EXPORT_COPY.versionLabel}>
          <TextInput value={draft.version} onChange={(version) => onDraft({ ...draft, version })} size="md" maxLength={VERSION_MAX} />
        </Field>
      </div>
      <Field label={EXPORT_COPY.summaryLabel} optional>
        <Textarea value={draft.summary} onChange={(summary) => onDraft({ ...draft, summary })} rows={2} maxLength={SUMMARY_MAX} placeholder={EXPORT_COPY.summaryPlaceholder} />
      </Field>

      <section className={styles.block}>
        <SectionTitle level={3}>{EXPORT_COPY.bundleTitle}</SectionTitle>
        <ul className={styles.extras}>
          {EXPORT_EXTRAS.map((extra) => {
            const stat = statOf(preview, extra);
            const present = stat.files > 0;
            const missing = extra === "options" ? EXPORT_COPY.missingOptions : EXPORT_COPY.missingFolder;
            const held = extra === "saves" ? savesReason : undefined;
            return (
              <li key={extra} className={styles.extraRow} data-compact={compact ? "" : undefined}>
                <Checkbox
                  checked={present && extras.has(extra)}
                  onChange={(on) => toggleExtra(extra, on)}
                  label={EXPORT_COPY.extra[extra]}
                  disabledReason={present ? held : missing}
                />
                <span className={styles.extraStat}>{present ? EXPORT_COPY.fileStat(stat.files, stat.bytes) : EXPORT_COPY.none}</span>
                {extra === "saves" && <span className={styles.extraHint}>{EXPORT_COPY.savesHint}</span>}
              </li>
            );
          })}
        </ul>
      </section>

      {preview.disabled.length > 0 && (
        <div className={styles.disabledBlock}>
          <Checkbox
            checked={draft.includeDisabled}
            onChange={(includeDisabled) => onDraft({ ...draft, includeDisabled })}
            label={EXPORT_COPY.disabledMods(preview.disabled.length)}
          />
          <span className={styles.extraHint}>{EXPORT_COPY.disabledHint}</span>
        </div>
      )}

      <Inset as="section">
        <KV
          rows={[
            {
              label: (
                <span className={styles.kvLabel}>
                  {EXPORT_COPY.indexedLabel}
                  <span className={styles.kvHint}>{EXPORT_COPY.indexedHint}</span>
                </span>
              ),
              value: EXPORT_COPY.indexedValue(preview.indexed.length),
            },
            { label: EXPORT_COPY.bundledLabel, value: EXPORT_COPY.fileStat(totals.files, totals.bytes) },
          ]}
        />
      </Inset>

      {preview.bundled.length > 0 && (
        <div className={styles.block}>
          <Callout
            tone="warn"
            action={
              <Button variant="ghost" size="sm" aria-expanded={listOpen} onClick={() => onListOpen(!listOpen)}>
                {listOpen ? EXPORT_COPY.hideList : EXPORT_COPY.showList}
              </Button>
            }
          >
            {EXPORT_COPY.unlisted(preview.bundled.length)}
          </Callout>
          <Appear>
            {listOpen && (
              <ul key="unlisted" className={styles.unlistedList} aria-label={EXPORT_COPY.unlistedListLabel}>
                {preview.bundled.map((mod) => (
                  <li key={mod.path} title={mod.file_name}>
                    {mod.file_name}
                  </li>
                ))}
              </ul>
            )}
          </Appear>
        </div>
      )}
      <Appear>{skipped > 0 && <Callout key="skipped" tone="info">{EXPORT_COPY.skipped(skipped)}</Callout>}</Appear>
    </div>
  );
}
