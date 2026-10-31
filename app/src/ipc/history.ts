// 实例的 Mod 变更历史、回滚与备份占用。事件按时间正序；rollbackChecks 与 listHistory 逐条对齐。

import { invoke } from "./bridge";

export type HistoryEvent =
  | { kind: "install"; id: string; at: number; files: string[] }
  | {
      kind: "update";
      id: string;
      /** UNIX 秒。 */
      at: number;
      file_name: string;
      /** 已改名为 `<old_file>.old` 留在 mods 目录。 */
      old_file: string;
      /** 旧文件查无来源时为「未知」。 */
      from_version: string;
      to_version: string;
      title: string | null;
      from_version_number: string | null;
      to_version_number: string | null;
    }
  | { kind: "rollback"; id: string; at: number; reverted_event: string }
  | { kind: "remove"; id: string; at: number; files: string[] };

export interface RollbackCheck {
  event_id: string;
  can_rollback: boolean;
  /** 不可回滚时给玩家看的原因。 */
  reason: string | null;
}

export const listHistory = (versionId: string): Promise<HistoryEvent[]> => invoke<HistoryEvent[]>("list_history", { versionId });

export const rollbackChecks = (versionId: string): Promise<RollbackCheck[]> => invoke<RollbackCheck[]>("rollback_checks", { versionId });

/** 只有更新事件可回滚；文件被游戏占用时以 mod_file_busy 拒绝。 */
export const rollback = (versionId: string, eventId: string): Promise<void> => invoke<void>("rollback", { versionId, eventId });

/** mods 目录下全部 `.old` 备份占用的字节数。 */
export const backupSize = (versionId: string): Promise<number> => invoke<number>("backup_size", { versionId });
