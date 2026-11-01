// 删除实例的「预览、确认、删除」：实例库卡片菜单、头图菜单与实例管理卡三个入口共用这一份，
// 确认框的内容、要不要先问后端、确认后的执行顺序完全一致。
// 放在页面目录里由实例库跨页引用：页面只能引入页面、组件、状态与文案这些目录，引入不了 flows/。

import { ACTION_ERROR, DELETE_INSTANCE_COPY } from "../../copy/flows";
import type { InstanceSummary } from "../../domain/adapt";
import { useShell } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import { shallowArrayEqual, useLauncherActions, useLauncherSelector } from "../../state/launcher";
import type { WorldDto } from "../../state/queries/instance";
import { activeTasks } from "../../state/selectors";
import styles from "./delete.module.css";
import instanceStyles from "./instance.module.css";
import { worldName } from "./model";

/** 备份目录这一行的路径超过这么多字时从中间省略，首尾（盘符与实例名）都留着；悬停显示全文。 */
const PATH_INLINE_MAX = 56;

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
 * 返回的函数走完整个删除：先向后端要删除预览（会一起移入回收站的存档以它为准，共用目录里的存档不随实例删除），
 * 再弹危险确认，确认后删除。预览里有实例依赖它时后端一定拒绝，这时只说明原因，不弹确认框让玩家白确认一次。
 * 预览与删除的失败都经外层统一错误处理报告，确认框取消就什么也不做。
 */
export function useDeleteInstance(): (inst: InstanceSummary) => Promise<void> {
  // 只订阅挂着未完成任务的实例 id：实例库每张卡都调用这个钩子，订阅任务本身会让它们随下载进度重渲染
  const withTask = useLauncherSelector((s) => activeTasks(s).flatMap((t) => (t.instanceId === null ? [] : [t.instanceId])), shallowArrayEqual);
  const actions = useLauncherActions();
  const { confirm } = useShell();
  const run = useRunner();
  return async (inst) => {
    const { id, name } = inst;
    // 还没扫到目录的占位项（排队中的新建、导入）磁盘上什么都没有，不必问后端
    let worlds: readonly WorldDto[] = [];
    let backups: KeptBackups | null = null;
    if (!inst.placeholder) {
      const preview = await run(() => actions.previewInstanceDeletion(id), ACTION_ERROR.deleteInstance(name));
      if (!preview.ok) return;
      if (preview.value.dependents.length > 0) {
        const copy = DELETE_INSTANCE_COPY.hasDependents(name, preview.value.dependents);
        actions.toast("warning", copy.title, copy.body);
        return;
      }
      worlds = preview.value.worlds;
      backups = { count: preview.value.backup_count, dir: preview.value.backups_dir };
    }
    const ok = await confirm({
      title: DELETE_INSTANCE_COPY.title(name),
      tone: "danger",
      confirmLabel: DELETE_INSTANCE_COPY.confirmLabel(worlds.length),
      body: <DeleteBody worlds={worlds} backups={backups} pendingTask={withTask.includes(id)} />,
    });
    if (!ok) return;
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

/** backups 为 null：还没扫到目录的占位项，没问过后端（这时也没有存档）。 */
function DeleteBody({ worlds, backups, pendingTask }: { worlds: readonly WorldDto[]; backups: KeptBackups | null; pendingTask: boolean }) {
  const c = DELETE_INSTANCE_COPY;
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
