// 移到其他游戏目录：选目标（记下的别的游戏目录，或经系统对话框选一个文件夹）-> 预检 -> 确认后入队移动任务。
// 头图菜单与实例库卡片菜单经 AnimatePresence 只在打开时挂载它；每选一次目标都重新预检，不用上次的结果。
// 实例此刻能不能移（实例与基底上的活动）由调用方经 lockReason 给出，打开期间被锁时主按钮据此禁用、选择保留。

import { motion } from "framer-motion";
import { useState } from "react";
import { Icon } from "../../art/Icon";
import { Spinner } from "../../art/Spinner";
import { ACTION_ERROR, moveBlockerReason } from "../../copy/flows";
import type { InstanceSummary } from "../../domain/adapt";
import { formatBytes } from "../../domain/format";
import { dirName, samePath } from "../../domain/paths";
import { tabPanel } from "../../lib/motion";
import { useRunner } from "../../shell/useRunner";
import { errorRecord } from "../../state/errors";
import { useLauncherActions } from "../../state/launcher";
import { useGameDirectories, type GameDirectoryDto } from "../../state/queries/catalog";
import { useInstanceMovePreview, type MovePreviewDto } from "../../state/queries/instance";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Inset } from "../../ui/Inset";
import { KV, type KVRow } from "../../ui/KV";
import { List, ListRow } from "../../ui/ListRow";
import { Modal } from "../../ui/Modal";
import { SectionTitle } from "../../ui/SectionTitle";
import { WarnNote } from "../../ui/WarnNote";
import { usePickFolder } from "../discover/platform";
import { MOVE_COPY } from "./copy";
import styles from "./move.module.css";

export interface MoveInstanceModalProps {
  inst: InstanceSummary;
  /** 实例此刻不能移的原因（与菜单项同一条）；能移为 undefined。 */
  lockReason: string | undefined;
  /** 目标里已有同名版本时的「去重命名」：头图就地改名，实例库去设置页。 */
  onRename(): void;
  onClose(): void;
}

/** 目录列表里能选作目标的：别的游戏目录（当前所在的不算）。 */
function otherDirectories(dirs: readonly GameDirectoryDto[]): GameDirectoryDto[] {
  return dirs.filter((d) => !d.is_current);
}

/** 选的文件夹若就是列表里的某个目录，用列表里的写法，选中的仍是那一行。 */
function listedPath(dirs: readonly GameDirectoryDto[], picked: string): string | null {
  const found = dirs.find((d) => samePath(d.path, picked));
  return found === undefined ? null : found.path;
}

/** 主按钮此刻为什么不能点；能点为 undefined。没选目标、预检没回来或没成、有拦截项都不能移，实例被锁排在最后。 */
export function moveSubmitReason(target: string | null, preview: { status: "loading" | "ready" | "error"; data?: MovePreviewDto }, lockReason: string | undefined): string | undefined {
  if (target === null) return MOVE_COPY.needTarget;
  if (preview.status === "loading") return MOVE_COPY.checkingReason;
  if (preview.status === "error" || preview.data === undefined) return MOVE_COPY.previewFailedReason;
  if (preview.data.blockers.length > 0) return MOVE_COPY.blockedReason;
  return lockReason;
}

export function MoveInstanceModal({ inst, lockReason, onRename, onClose }: MoveInstanceModalProps) {
  const run = useRunner();
  const actions = useLauncherActions();
  const pickFolder = usePickFolder();
  const dirs = useGameDirectories();
  const [target, setTarget] = useState<string | null>(null);
  // 经对话框选的、不在列表里的文件夹：列在别的目录之后，选别的目录时也留着，方便选回来
  const [picked, setPicked] = useState<string | null>(null);
  const preview = useInstanceMovePreview(inst.id, target);

  const listed = dirs.status === "ready" ? dirs.data : [];
  const others = otherDirectories(listed);
  const current = listed.find((d) => d.is_current);

  const pick = async () => {
    // 对话框从当前游戏目录打开：目标多半与它相邻（同一个盘上的另一个启动器目录）
    const from = current === undefined ? "" : current.path;
    const outcome = await run(() => pickFolder(from, MOVE_COPY.pickTitle(inst.name)), MOVE_COPY.pickError);
    if (!outcome.ok || outcome.value === null) return;
    const known = listedPath(others, outcome.value);
    if (known === null) setPicked(outcome.value);
    setTarget(known === null ? outcome.value : known);
  };

  const ready = preview.status === "ready" && target !== null ? preview.data : null;
  const submitReason = moveSubmitReason(target, preview, lockReason);

  const submit = async () => {
    if (ready === null) throw new Error("没有预检结果时不能移动");
    onClose();
    await run(() => actions.moveInstance(inst.id, ready.target, ready.target_name), ACTION_ERROR.moveInstance);
  };

  const footer = (
    <>
      <Button variant="ghost" onClick={onClose}>
        {MOVE_COPY.cancel}
      </Button>
      <Button variant="primary" icon="folder-open" disabledReason={submitReason} onClick={() => void submit()}>
        {MOVE_COPY.confirm}
      </Button>
    </>
  );

  const pickedRow = picked !== null && listedPath(others, picked) === null ? picked : null;
  const pickedIsCurrent = pickedRow !== null && current !== undefined && samePath(pickedRow, current.path);

  return (
    <Modal open onClose={onClose} closeOnScrim={false} title={MOVE_COPY.title} icon="folder-open" subtitle={MOVE_COPY.subtitle(inst.name)} size="md" footer={footer}>
      <div className={styles.body}>
        <section className={styles.block}>
          <SectionTitle level={3}>{MOVE_COPY.targetsLabel}</SectionTitle>
          {dirs.status === "error" ? (
            <Callout
              tone="danger"
              announce
              action={
                <Button variant="ghost" size="sm" onClick={dirs.reload}>
                  {MOVE_COPY.retry}
                </Button>
              }
            >
              {errorRecord(dirs.error).message}
            </Callout>
          ) : dirs.status === "loading" ? (
            <div className={styles.checking} aria-busy="true">
              <Spinner size={20} />
            </div>
          ) : (
            <>
              {others.length === 0 && pickedRow === null && <p className={styles.hint}>{MOVE_COPY.noOthers}</p>}
              {(others.length > 0 || pickedRow !== null) && (
                <List select={{ selected: target, onSelect: setTarget }} aria-label={MOVE_COPY.targetsLabel}>
                  {others.map((dir) => (
                    <ListRow
                      key={dir.path}
                      value={dir.path}
                      leading={<Icon name="folder" size={20} />}
                      title={dir.name}
                      meta={<span className={styles.path}>{dir.available ? dir.path : `${dir.path} · ${MOVE_COPY.unavailable}`}</span>}
                      disabled={!dir.available}
                    />
                  ))}
                  {pickedRow !== null && (
                    <ListRow
                      key={pickedRow}
                      value={pickedRow}
                      leading={<Icon name="folder-open" size={20} />}
                      title={dirName(pickedRow)}
                      meta={<span className={styles.path}>{`${pickedRow} · ${pickedIsCurrent ? MOVE_COPY.pickedCurrent : MOVE_COPY.pickedNew}`}</span>}
                    />
                  )}
                </List>
              )}
              <Button variant="secondary" size="sm" icon="folder-open" className={styles.pick} onClick={() => void pick()}>
                {MOVE_COPY.pickFolder}
              </Button>
            </>
          )}
        </section>

        {target !== null && (
          <motion.section key={target} className={styles.block} variants={tabPanel} initial="hidden" animate="show" aria-live="polite">
            {preview.status === "error" ? (
              <Callout
                tone="danger"
                announce
                action={
                  <Button variant="ghost" size="sm" onClick={preview.reload}>
                    {MOVE_COPY.retry}
                  </Button>
                }
              >
                {`${MOVE_COPY.previewError}：${errorRecord(preview.error).message}`}
              </Callout>
            ) : ready === null ? (
              <div className={styles.checking} aria-busy="true">
                <Spinner size={20} />
                <span>{MOVE_COPY.checking}</span>
              </div>
            ) : (
              <MovePreview preview={ready} pinned={inst.pinned} onRename={onRename} />
            )}
          </motion.section>
        )}
      </div>
    </Modal>
  );
}

function summaryRows(preview: MovePreviewDto): KVRow[] {
  const rows: KVRow[] = [
    { label: MOVE_COPY.instance, value: MOVE_COPY.instanceValue(preview.instance_bytes, preview.instance_files) },
    { label: MOVE_COPY.backups, value: MOVE_COPY.backupsValue(preview.backup_count, preview.backup_bytes) },
    { label: MOVE_COPY.shared, value: MOVE_COPY.sharedValue(preview.dependency_files, preview.dependency_bytes) },
  ];
  if (preview.bases_to_copy.length > 0) rows.push({ label: MOVE_COPY.bases, value: preview.bases_to_copy.join("、") });
  if (preview.reused_bases.length > 0) rows.push({ label: MOVE_COPY.reused, value: preview.reused_bases.join("、") });
  rows.push({ label: MOVE_COPY.write, value: formatBytes(preview.required_bytes) }, { label: MOVE_COPY.free, value: formatBytes(preview.available_bytes) });
  return rows;
}

function MovePreview({ preview, pinned, onRename }: { preview: MovePreviewDto; pinned: boolean; onRename(): void }) {
  const blocked = preview.blockers.length > 0;
  const nameTaken = preview.blockers.some((b) => b.kind === "name_taken");
  return (
    <>
      <Inset>
        <KV rows={summaryRows(preview)} />
      </Inset>
      {blocked ? (
        <>
          <Callout
            tone="danger"
            announce
            action={
              nameTaken ? (
                <Button variant="ghost" size="sm" onClick={onRename}>
                  {MOVE_COPY.renameAction}
                </Button>
              ) : undefined
            }
          >
            {MOVE_COPY.blockedTitle}
          </Callout>
          <ul className={styles.blockers} aria-label={MOVE_COPY.blockedTitle}>
            {preview.blockers.map((blocker) => (
              <li key={blocker.kind}>
                <WarnNote>{moveBlockerReason(blocker)}</WarnNote>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <Callout tone="info">{preview.same_volume ? MOVE_COPY.sameVolume : MOVE_COPY.crossVolume}</Callout>
      )}
      {!preview.isolated && <WarnNote>{MOVE_COPY.notIsolated}</WarnNote>}
      {preview.missing_in_source > 0 && <WarnNote>{MOVE_COPY.missingInSource(preview.missing_in_source)}</WarnNote>}
      {pinned && !blocked && <WarnNote>{MOVE_COPY.pinned}</WarnNote>}
    </>
  );
}
