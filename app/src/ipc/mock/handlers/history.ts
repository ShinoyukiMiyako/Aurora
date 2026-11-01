// 变更历史的假后端。实例状态（文件表、卷宗、事件）归 mods.ts 所有，这里只读写同一份，状态恢复也由它负责。
// 回滚的前置检查与后端同序：事件存在、是更新事件、没回滚过、备份还在、目标名没被占、文件没被占用。

import { IpcError } from "../../errors";
import type { HistoryEvent, RollbackCheck } from "../../history";
import type { MockHandlers } from "../types";
import { withMockInstance } from "./instances";
import {
  BACKUP_SUFFIX,
  DISABLED_SUFFIX,
  assertNotBusy,
  hasFile,
  mockHistoryPath,
  mockInstance,
  mockModsDir,
  nextEventId,
  nowSeconds,
  refuse,
  requireString,
  type MockInstance,
} from "./mods";

function revertedIds(history: HistoryEvent[]): Set<string> {
  return new Set(history.flatMap((e) => (e.kind === "rollback" ? [e.reverted_event] : [])));
}

type UpdateEvent = Extract<HistoryEvent, { kind: "update" }>;

function backupName(event: UpdateEvent): string {
  return event.backup_file === undefined ? `${event.old_file}${BACKUP_SUFFIX}` : event.backup_file;
}

/** 与后端同一判据：之后还有一条没回滚的更新把本条装上的文件当旧文件换掉了。 */
function supersededIds(history: HistoryEvent[], reverted: Set<string>): Set<string> {
  const live = history.flatMap((e, index) => (e.kind === "update" && !reverted.has(e.id) ? [{ index, e }] : []));
  return new Set(live.filter(({ index, e }) => live.some((later) => later.index > index && later.e.old_file === e.file_name)).map(({ e }) => e.id));
}

function checks(instance: MockInstance): RollbackCheck[] {
  const reverted = revertedIds(instance.history);
  const superseded = supersededIds(instance.history, reverted);
  return instance.history.map((event): RollbackCheck => {
    switch (event.kind) {
      case "update":
        if (reverted.has(event.id)) return { event_id: event.id, can_rollback: false, reason: "该更新已经回滚过" };
        if (superseded.has(event.id)) return { event_id: event.id, can_rollback: false, reason: `${event.file_name} 之后又更新过，先回滚之后的那次更新` };
        if (hasFile(instance, backupName(event))) return { event_id: event.id, can_rollback: true, reason: null };
        return { event_id: event.id, can_rollback: false, reason: `备份文件 ${backupName(event)} 已不在 mods 目录里` };
      case "install":
        return { event_id: event.id, can_rollback: false, reason: "安装事件不支持回滚，直接移除对应文件" };
      case "remove":
        return { event_id: event.id, can_rollback: false, reason: "移除事件不支持回滚，文件已从磁盘删除" };
      case "rollback":
        return { event_id: event.id, can_rollback: false, reason: "回滚事件本身不可再回滚" };
    }
  });
}

function rollback(versionId: string, instance: MockInstance, eventId: string): void {
  const historyPath = mockHistoryPath(versionId);
  const event = instance.history.find((e) => e.id === eventId);
  if (!event) throw refuse(historyPath, `历史中不存在事件 ${eventId}，无法回滚`);
  if (event.kind !== "update") throw refuse(historyPath, `事件 ${eventId} 不是更新事件，只有更新事件留有 .old 备份可回滚`);
  const reverted = revertedIds(instance.history);
  if (reverted.has(eventId)) throw refuse(historyPath, `事件 ${eventId} 已经回滚过，不能重复回滚`);
  if (supersededIds(instance.history, reverted).has(eventId)) {
    throw refuse(historyPath, `事件 ${eventId} 装上的 ${event.file_name} 之后又更新过，先回滚之后的那次更新`);
  }
  const dir = mockModsDir(versionId);
  const backup = backupName(event);
  if (!hasFile(instance, backup)) {
    throw refuse(`${dir}/${backup}`, `回滚事件 ${eventId} 需要备份文件 ${backup}，它已不在 mods 目录里`);
  }
  if (event.old_file !== event.file_name && hasFile(instance, event.old_file)) {
    throw refuse(`${dir}/${event.old_file}`, `回滚目标 ${event.old_file} 已存在于 mods 目录，拒绝覆盖它`);
  }
  assertNotBusy(versionId, [event.file_name, `${event.file_name}${DISABLED_SUFFIX}`, backup]);

  instance.files = instance.files.filter((f) => f.file_name !== event.file_name && f.file_name !== `${event.file_name}${DISABLED_SUFFIX}`);
  const restored = instance.files.find((f) => f.file_name === backup);
  if (!restored) throw new Error(`mock 状态不一致：${backup} 刚检查过却不在文件表里`);
  restored.file_name = event.old_file;
  const row = instance.ledger.find((r) => r.file_name === event.file_name);
  if (row) {
    row.file_name = event.old_file;
    row.version_id = event.from_version;
    row.version_number = event.from_version_number;
  }
  const at = nowSeconds();
  instance.history.push({ kind: "rollback", id: nextEventId(instance.history, at), at, reverted_event: eventId });
}

export const handlers: MockHandlers = {
  list_history: (args) => mockInstance(args.versionId).history,
  rollback_checks: (args) => checks(mockInstance(args.versionId)),
  rollback: (args) => {
    const versionId = requireString(args.versionId, "versionId");
    const eventId = requireString(args.eventId, "eventId");
    if (eventId.trim() === "") throw new IpcError("invalid_argument", "event_id 不能为空");
    // 与后端一样以「改动 Mod 与资源」占住实例，与改名、删除互斥
    withMockInstance(versionId, "modifying", () => rollback(versionId, mockInstance(versionId), eventId));
  },
};
