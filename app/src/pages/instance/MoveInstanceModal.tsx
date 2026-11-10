// 移到其他游戏目录：选目标（记下的别的游戏目录，或经系统对话框选一个文件夹）-> 预检 -> 确认后入队移动任务。
// 头图菜单与实例库卡片菜单经 AnimatePresence 只在打开时挂载它；每选一次目标都重新预检，不用上次的结果。
// 实例此刻能不能移（实例与基底上的活动）由调用方经 lockReason 给出，打开期间被锁时主按钮据此禁用、选择保留。
//
// 弹窗面板随内容形变只在渲染 Modal 的这一层重渲染时才接得住：目录列表与预检的加载门、上一份预检结果都放在这一层。

import { useState } from "react";
import { Icon } from "../../art/Icon";
import { Spinner } from "../../art/Spinner";
import { ACTION_ERROR, moveBlockerReason } from "../../copy/flows";
import type { InstanceSummary } from "../../domain/adapt";
import { formatBytes } from "../../domain/format";
import { dirName, samePath } from "../../domain/paths";
import { useLoadingGate, type LoadingView } from "../../lib/loading-gate";
import { useReflow } from "../../lib/reflow";
import { useRunner } from "../../shell/useRunner";
import { errorRecord } from "../../state/errors";
import { useLauncherActions } from "../../state/launcher";
import { useGameDirectories, type GameDirectoryDto } from "../../state/queries/catalog";
import { useInstanceMovePreview, type MovePreviewDto } from "../../state/queries/instance";
import { Appear } from "../../ui/Appear";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Inset } from "../../ui/Inset";
import { KV, type KVRow } from "../../ui/KV";
import { List, ListRow } from "../../ui/ListRow";
import { Loadable } from "../../ui/Loadable";
import { Modal } from "../../ui/Modal";
import { SectionTitle } from "../../ui/SectionTitle";
import { Skeleton } from "../../ui/Skeleton";
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

/**
 * 预检区此刻画什么。held 是上一份已经摆出来的结果：换目标后新结果回来之前继续摆着它（加载门亮出加载态后压暗），
 * 不先塌成加载态再撑开。新结果、失败都要等加载门放行（骨架至少停留的那段时间）才换上。
 * stale 只管压暗（等待期不压，回得快时不闪）；busy 从换目标那一刻起就标：摆着的是上一个目标的结果，
 * 读屏不能把它当成这一次的。
 */
export function moveCheckView(
  gate: LoadingView,
  preview: { status: "loading" | "ready" | "error"; data?: MovePreviewDto },
  held: MovePreviewDto | null,
): { view: LoadingView; shown: MovePreviewDto | null; failed: boolean; stale: boolean; busy: boolean } {
  const settled = gate === "content";
  const shown = settled ? (preview.status === "ready" && preview.data !== undefined ? preview.data : null) : held;
  const failed = settled && preview.status === "error";
  return { view: shown !== null || failed ? "content" : gate, shown, failed, stale: gate === "skeleton" && shown !== null, busy: !settled && shown !== null };
}

export function MoveInstanceModal({ inst, lockReason, onRename, onClose }: MoveInstanceModalProps) {
  const run = useRunner();
  const actions = useLauncherActions();
  const pickFolder = usePickFolder();
  const dirs = useGameDirectories();
  const dirsGate = useLoadingGate(dirs.status === "loading");
  const [target, setTarget] = useState<string | null>(null);
  // 经对话框选的、不在列表里的文件夹：列在别的目录之后，选别的目录时也留着，方便选回来
  const [picked, setPicked] = useState<string | null>(null);
  const preview = useInstanceMovePreview(inst.id, target);
  // 还没选目标时不算在加载：否则选中的那一刻加载门早已过了等待期，骨架会立刻亮出来
  const checkGate = useLoadingGate(target !== null && preview.status === "loading");
  const [held, setHeld] = useState<MovePreviewDto | null>(null);
  const check = moveCheckView(checkGate.view, preview, held);
  if (checkGate.view === "content" && held !== check.shown) setHeld(check.shown);

  // 让位：目录列表多出一行时「选择其他文件夹」滑下去；目标区变高时预检区滑下去
  const bodyReflow = useReflow<HTMLDivElement>();
  const targetsReflow = useReflow<HTMLDivElement>();

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

  // 能确认的只有已经摆出来的那份结果：加载门还亮着加载态时（含骨架至少停留的那段）不算回来
  const ready = checkGate.view === "content" && target !== null ? check.shown : null;
  const submitReason = moveSubmitReason(target, checkGate.view === "content" ? preview : { status: "loading" }, lockReason);

  const submit = async () => {
    if (ready === null) throw new Error("没有预检结果时不能移动");
    onClose();
    await run(() => actions.moveInstance(inst.id, ready.source, ready.target, ready.target_name), ACTION_ERROR.moveInstance);
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
      <div ref={bodyReflow} className={styles.body}>
        <section className={styles.block}>
          <SectionTitle level={3}>{MOVE_COPY.targetsLabel}</SectionTitle>
          <Loadable view={dirsGate.view} skeleton={<TargetsSkeleton />}>
            {() =>
              dirs.status === "error" ? (
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
              ) : (
                <div ref={targetsReflow} className={styles.block}>
                  <Appear>
                    {others.length === 0 && pickedRow === null ? (
                      <p key="none" className={styles.hint}>
                        {MOVE_COPY.noOthers}
                      </p>
                    ) : (
                      <List key="dirs" select={{ selected: target, onSelect: setTarget }} aria-label={MOVE_COPY.targetsLabel}>
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
                  </Appear>
                  <Button variant="secondary" size="sm" icon="folder-open" className={styles.pick} onClick={() => void pick()}>
                    {MOVE_COPY.pickFolder}
                  </Button>
                </div>
              )
            }
          </Loadable>
        </section>

        <Appear>
          {target !== null && (
            <section key="check" className={styles.block} aria-live="polite">
              <Loadable view={check.view} skeleton={<PreviewSkeleton />}>
                {() => {
                  if (check.failed && preview.status === "error") {
                    return (
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
                    );
                  }
                  if (check.shown === null) throw new Error("预检区画内容时既没有结果也没有失败");
                  return <MovePreview preview={check.shown} stale={check.stale} busy={check.busy} pinned={inst.pinned} onRename={onRename} />;
                }}
              </Loadable>
              {/* 骨架里的「正在检查」对读屏隐藏：播报区随这一块预先挂好、先空着，加载态亮出（含摆着上一份结果时）才写字，
                  读屏才念得出来；回得快时不播，与看得见的骨架同一时机 */}
              <div role="status" className={styles.status}>
                {checkGate.view === "skeleton" ? MOVE_COPY.checking : ""}
              </div>
            </section>
          )}
        </Appear>
      </div>
    </Modal>
  );
}

/** 目录列表读取中：一行目录与「选择其他文件夹」按钮的占位，行高、按钮高与真实内容一致。 */
function TargetsSkeleton() {
  return (
    <div className={styles.block}>
      <List>
        <ListRow
          key="dir"
          leading={<Skeleton shape="block" width={20} height={20} radius="xs" />}
          title={<Skeleton shape="text" width="32%" />}
          meta={<Skeleton shape="text" width="64%" />}
        />
      </List>
      <Skeleton shape="block" width={PICK_SKELETON_WIDTH} height={30} radius="sm" className={styles.pick} />
    </div>
  );
}

/** 「选择其他文件夹…」小号按钮的大致宽度。 */
const PICK_SKELETON_WIDTH = 140;

/** 每份预检都有的几行；版本两行（要带过去的、目标里已有的）看目标而定，骨架不画。 */
const PREVIEW_SKELETON_LABELS = [MOVE_COPY.instance, MOVE_COPY.backups, MOVE_COPY.shared, MOVE_COPY.write, MOVE_COPY.free] as const;

/** 预检进行中：摘要的键照常写出、值画成骨架，说明块的位置写「正在检查」，与回来的结果同一个排布。 */
function PreviewSkeleton() {
  return (
    <div className={styles.preview}>
      <Inset>
        <KV rows={PREVIEW_SKELETON_LABELS.map((label) => ({ label, value: <Skeleton shape="text" width={96} /> }))} />
      </Inset>
      <div className={styles.checking}>
        <Spinner size={20} decorative />
        <span>{MOVE_COPY.checking}</span>
      </div>
    </div>
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

/** busy：这是上一个目标的结果，新目标的预检还没回来；stale：加载态已经亮出，压暗摆着。 */
function MovePreview({ preview, stale, busy, pinned, onRename }: { preview: MovePreviewDto; stale: boolean; busy: boolean; pinned: boolean; onRename(): void }) {
  // 换目标后说明块、拦截项与提醒行会增减：排在后面的从原位置滑过去
  const reflow = useReflow<HTMLDivElement>();
  const blocked = preview.blockers.length > 0;
  const nameTaken = preview.blockers.some((b) => b.kind === "name_taken");
  return (
    <div ref={reflow} className={styles.preview} data-stale={stale || undefined} aria-busy={busy || undefined}>
      <Inset>
        <KV rows={summaryRows(preview)} />
      </Inset>
      <Appear>
        {blocked ? (
          <Callout
            key="blocked"
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
        ) : (
          <Callout key="volume" tone="info">
            {preview.same_volume ? MOVE_COPY.sameVolume : MOVE_COPY.crossVolume}
          </Callout>
        )}
        {blocked && (
          <ul key="blockers" className={styles.blockers} aria-label={MOVE_COPY.blockedTitle}>
            {preview.blockers.map((blocker) => (
              <li key={blocker.kind}>
                <WarnNote>{moveBlockerReason(blocker)}</WarnNote>
              </li>
            ))}
          </ul>
        )}
        {!preview.isolated && <WarnNote key="isolated">{MOVE_COPY.notIsolated}</WarnNote>}
        {preview.missing_in_source > 0 && <WarnNote key="missing">{MOVE_COPY.missingInSource(preview.missing_in_source)}</WarnNote>}
        {pinned && !blocked && <WarnNote key="pinned">{MOVE_COPY.pinned}</WarnNote>}
      </Appear>
    </div>
  );
}
