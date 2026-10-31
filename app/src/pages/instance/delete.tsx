// 删除实例的「预览、确认、删除」：实例库卡片菜单、头图菜单与实例管理卡三个入口共用这一份，
// 确认框的内容、要不要先问后端、确认后的执行顺序完全一致。
// 放在页面目录里由实例库跨页引用：页面只能引入页面、组件、状态与文案这些目录，引入不了 flows/。

import { ACTION_ERROR, DELETE_INSTANCE_COPY } from "../../copy/flows";
import type { InstanceSummary } from "../../domain/adapt";
import { useShell } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import { useLauncher } from "../../state/launcher";
import type { WorldDto } from "../../state/queries/instance";
import { instanceTask } from "../../state/selectors";
import styles from "./delete.module.css";
import { worldName } from "./model";

/**
 * 返回的函数走完整个删除：先向后端要删除预览（会一起移入回收站的存档以它为准，共用目录里的存档不随实例删除），
 * 再弹危险确认，确认后删除。预览与删除的失败都经外层统一错误处理报告，确认框取消就什么也不做。
 */
export function useDeleteInstance(): (inst: InstanceSummary) => Promise<void> {
  const { state, actions } = useLauncher();
  const { confirm } = useShell();
  const run = useRunner();
  return async (inst) => {
    const { id, name } = inst;
    // 还没扫到目录的占位项（排队中的新建、导入）磁盘上什么都没有，不必问后端
    let worlds: readonly WorldDto[] = [];
    if (!inst.placeholder) {
      const preview = await run(() => actions.previewInstanceDeletion(id), ACTION_ERROR.deleteInstance(name));
      if (!preview.ok) return;
      worlds = preview.value.worlds;
    }
    const ok = await confirm({
      title: DELETE_INSTANCE_COPY.title(name),
      tone: "danger",
      confirmLabel: DELETE_INSTANCE_COPY.confirmLabel(worlds.length),
      body: <DeleteBody worlds={worlds} pendingTask={instanceTask(state, id) !== null} />,
    });
    if (!ok) return;
    await run(() => actions.deleteInstance(id, worlds.length), ACTION_ERROR.deleteInstance(name));
  };
}

function DeleteBody({ worlds, pendingTask }: { worlds: readonly WorldDto[]; pendingTask: boolean }) {
  const c = DELETE_INSTANCE_COPY;
  const bytes = worlds.reduce((sum, w) => sum + w.size_bytes, 0);
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
          <p>{c.backupHint}</p>
        </>
      ) : (
        <p>{c.noWorlds}</p>
      )}
      {pendingTask && <p>{c.pendingTask}</p>}
    </div>
  );
}
