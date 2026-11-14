// 删除实例的「预览、确认、删除」：实例库卡片菜单、头图菜单与实例管理卡三个入口共用这一份，
// 确认框的内容、要不要先问后端、确认后的执行顺序完全一致。
// 放在页面目录里由实例库跨页引用：页面只能引入页面、组件、状态与文案这些目录，引入不了 flows/。
// 点了删除先开框再问后端：预览是一次扫盘，大实例要等一会儿，不能让点击到弹框之间什么反应都没有。等的时候正文占位、
// 确认键不可按；预览到了在同一个框里原位换成真实内容，正文由加载容器交叉淡化，框的高度经弹窗形变过去。
// 确认键的文案与可按、取消键改叫「关闭」，都等正文真的换成结果的那一刻才换（骨架出现过的要停够最短时长）。

import { motion, type Transition } from "framer-motion";
import { useLayoutEffect } from "react";
import { ACTION_ERROR, DELETE_INSTANCE_COPY } from "../../copy/flows";
import type { InstanceSummary } from "../../domain/adapt";
import { useLoadingGate } from "../../lib/loading-gate";
import { springs } from "../../lib/motion";
import { useShell } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import { describeError } from "../../state/errors";
import { shallowArrayEqual, useLauncherActions, useLauncherSelector } from "../../state/launcher";
import type { WorldDto } from "../../state/queries/instance";
import { activeTasks } from "../../state/selectors";
import { Loadable } from "../../ui/Loadable";
import { Skeleton } from "../../ui/Skeleton";
import styles from "./delete.module.css";
import instanceStyles from "./instance.module.css";
import { worldName } from "./model";

/** 备份目录这一行的路径超过这么多字时从中间省略，首尾（盘符与实例名）都留着；悬停显示全文。 */
const PATH_INLINE_MAX = 56;

/** 正文换外形时与弹窗面板的形变同一条弹簧。 */
const MORPH: Transition = { layout: springs.morph };

function middleEllipsis(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${chars.slice(0, head).join("")}…${chars.slice(chars.length - (keep - head)).join("")}`;
}

/** 删除预览里这个实例已有的存档备份：份数与目录。备份不随实例删除，确认框据此说明它们还在哪里。 */
interface KeptBackups {
  count: number;
  dir: string;
}

/**
 * 确认框正文此刻能说什么。ready 的 backups 为 null：还没扫到目录的占位项，没问过后端（这时也没有存档）。
 * failed 与 blocked 时删不了，确认键一直不可按。
 */
type DeletePreview =
  | { kind: "loading" }
  | { kind: "ready"; worlds: readonly WorldDto[]; backups: KeptBackups | null }
  | { kind: "failed"; reason: string }
  | { kind: "blocked"; text: string };

/**
 * 返回的函数走完整个删除：先开危险确认、同时向后端要删除预览（会一起移入回收站的存档以它为准，共用目录里的存档不随实例删除），
 * 预览到了确认键才可按，确认后删除。预览里有实例依赖它时后端一定拒绝，这时框里说明原因，确认键一直不可按，不让玩家白确认一次。
 * 预览与删除的失败都经外层统一错误处理报告，预览失败时框里也写明原因；确认框取消就什么也不做。
 */
export function useDeleteInstance(): (inst: InstanceSummary) => Promise<void> {
  // 只订阅挂着未完成任务的实例 id：实例库每张卡都调用这个钩子，订阅任务本身会让它们随下载进度重渲染
  const withTask = useLauncherSelector((s) => activeTasks(s).flatMap((t) => (t.instanceId === null ? [] : [t.instanceId])), shallowArrayEqual);
  const actions = useLauncherActions();
  const { confirm, openConfirm } = useShell();
  const run = useRunner();
  return async (inst) => {
    const { id, name } = inst;
    const c = DELETE_INSTANCE_COPY;
    const pendingTask = withTask.includes(id);
    const body = (preview: DeletePreview, onSettled?: () => void) => <DeleteBody preview={preview} pendingTask={pendingTask} onSettled={onSettled} />;
    // 还没扫到目录的占位项（排队中的新建、导入）磁盘上什么都没有，不必问后端，框里一开始就是最终内容
    if (inst.placeholder) {
      const ok = await confirm({ title: c.title(name), tone: "danger", confirmLabel: c.confirmLabel(0), body: body({ kind: "ready", worlds: [], backups: null }) });
      if (ok) await run(() => actions.deleteInstance(id, 0), ACTION_ERROR.deleteInstance(name));
      return;
    }
    const dialog = openConfirm({ title: c.title(name), tone: "danger", confirmLabel: c.confirmLabel(0), confirmDisabled: true, body: body({ kind: "loading" }) });
    const preview = await run(() => actions.previewInstanceDeletion(id), ACTION_ERROR.deleteInstance(name));
    // 预览一到就放开确认键、换文案的话，骨架还要停够最短时长：这段时间里按得到删除，玩家却还没看到要删哪些存档；
    // 按钮与正文先后各换一次，框也要先后形变两趟，后一趟打断前一趟。所以这里只换正文，按钮等正文换上结果时再换。
    // 框已经关掉（清点期间点了取消）时这几次 update 什么都不做，之后 result 也已经是 false
    if (!preview.ok) {
      dialog.update({ body: body({ kind: "failed", reason: describeError(preview.error) }, () => dialog.update({ cancelLabel: c.close })) });
      return;
    }
    if (preview.value.dependents.length > 0) {
      dialog.update({ body: body({ kind: "blocked", text: c.blocked(name, preview.value.dependents) }, () => dialog.update({ cancelLabel: c.close })) });
      return;
    }
    const worlds = preview.value.worlds;
    const backups = { count: preview.value.backup_count, dir: preview.value.backups_dir };
    const settled = () => dialog.update({ confirmLabel: c.confirmLabel(worlds.length), confirmDisabled: false });
    dialog.update({ body: body({ kind: "ready", worlds, backups }, settled) });
    if (!(await dialog.result)) return;
    await run(() => actions.deleteInstance(id, worlds.length), ACTION_ERROR.deleteInstance(name));
  };
}

function KeptBackupsLine({ lead, dir }: { lead: string; dir: string }) {
  return (
    <p>
      {lead}
      <span className={instanceStyles.path} title={dir}>
        {middleEllipsis(dir, PATH_INLINE_MAX)}
      </span>
      {DELETE_INSTANCE_COPY.backupsKeptTail}
    </p>
  );
}

interface DeleteBodyProps {
  preview: DeletePreview;
  pendingTask: boolean;
  /** 正文换上预览结果的那一刻调用（加载门给出内容时，骨架出现过的已停够），确认框的按钮跟着这一刻换。 */
  onSettled?: () => void;
}

/**
 * 确认框的正文。预览到达前后是同一个组件：确认框原地换内容时它不重挂，加载门接着算，
 * 等待期内就到了的不闪骨架，骨架出现过的至少停留一段再交叉淡化成内容。
 */
function DeleteBody({ preview, pendingTask, onSettled }: DeleteBodyProps) {
  const gate = useLoadingGate(preview.kind === "loading");
  // 正文的外形：骨架到点换成内容时确认框这一层不重渲染，靠这一块换了外形经确认框的布局组带着面板一起形变。
  // 等待期与骨架同尺寸，算一种
  const shape = gate.view === "content" ? preview.kind : "loading";
  const settled = gate.view === "content";
  // 布局副作用里换按钮：这次更新在本次提交收尾时同步提交，与正文换内容落在同一帧、同一次布局测量里，
  // 框与确认键一起形变一趟；放到常规副作用里会晚一帧，按钮的形变再把正文那一趟打断重起
  useLayoutEffect(() => {
    if (settled) onSettled?.();
  }, [settled, onSettled]);
  return (
    <motion.div layout="position" layoutDependency={shape} transition={MORPH}>
      <Loadable view={gate.view} busyLabel={DELETE_INSTANCE_COPY.previewLoading} skeleton={<DeleteSkeleton pendingTask={pendingTask} />}>
        {() => <DeleteSettled preview={preview} pendingTask={pendingTask} />}
      </Loadable>
    </motion.div>
  );
}

/** 按最常见的结果（没有存档的一段说明）占位；结果更长时由弹窗形变接住。 */
function DeleteSkeleton({ pendingTask }: { pendingTask: boolean }) {
  return (
    <div className={styles.body}>
      <Skeleton shape="text" lines={2} />
      {pendingTask && <Skeleton shape="text" />}
    </div>
  );
}

function DeleteSettled({ preview, pendingTask }: { preview: DeletePreview; pendingTask: boolean }) {
  const c = DELETE_INSTANCE_COPY;
  if (preview.kind === "loading") throw new Error("加载门给出内容时删除预览一定已经到了");
  if (preview.kind === "failed")
    return (
      <div className={styles.body}>
        <p>{c.previewFailed(preview.reason)}</p>
      </div>
    );
  if (preview.kind === "blocked")
    return (
      <div className={styles.body}>
        <p>{preview.text}</p>
      </div>
    );
  const { worlds, backups } = preview;
  const bytes = worlds.reduce((sum, w) => sum + w.size_bytes, 0);
  const kept = backups !== null && backups.count > 0 ? backups : null;
  return (
    <div className={styles.body}>
      {worlds.length > 0 ? (
        <>
          <p>
            {c.worldsLead}
            <strong>{c.worldsCount(worlds.length)}</strong>
            <span className={styles.num}>{c.worldsTail(bytes)}</span>
          </p>
          <ul className={styles.list}>
            {worlds.map((w) => (
              <li key={w.dir_name}>{worldName(w)}</li>
            ))}
          </ul>
          {kept !== null ? <KeptBackupsLine lead={c.backupsKeptLead(kept.count)} dir={kept.dir} /> : <p>{c.backupHint}</p>}
        </>
      ) : (
        <>
          <p>{c.noWorlds}</p>
          {/* 存档已经删光或挪走，备份还留在游戏目录里：同样说明它们在哪，不随实例删除 */}
          {kept !== null && <KeptBackupsLine lead={c.backupsLeftLead(kept.count)} dir={kept.dir} />}
        </>
      )}
      {pendingTask && <p>{c.pendingTask}</p>}
    </div>
  );
}
