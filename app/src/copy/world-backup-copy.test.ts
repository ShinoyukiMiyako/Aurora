// 存档备份相关的流程文案：任务类别、任务标题、失败原因的统一说法、通知与恢复确认。
import { describe, expect, it } from "vitest";
import { TASK_KINDS } from "../domain/types";
import { CONFIRM_COPY, DELETE_INSTANCE_COPY, TASK_KIND_LABEL, TASK_TEXT, TASK_TOAST, TOAST_COPY, taskFailureReason } from "./flows";

describe("任务类别与标题", () => {
  it("备份与恢复都归在「存档」名下，每个类别都有标签", () => {
    expect(TASK_KINDS).toContain("world_backup");
    expect(TASK_KINDS).toContain("world_restore");
    expect(TASK_KIND_LABEL.world_backup).toBe("存档");
    expect(TASK_KIND_LABEL.world_restore).toBe("存档");
    for (const kind of TASK_KINDS) expect(TASK_KIND_LABEL[kind], kind).not.toBe("");
  });

  it("标题写存档名，详情写实例名", () => {
    expect(TASK_TEXT.backupTitle("新的世界")).toBe("备份「新的世界」");
    expect(TASK_TEXT.exportTitle("新的世界")).toBe("导出「新的世界」");
    expect(TASK_TEXT.restoreTitle("新的世界")).toBe("恢复「新的世界」");
    expect(TASK_TEXT.backupDetail("樱花生存")).toBe("「樱花生存」");
  });
});

describe("失败原因", () => {
  it("存档被占用、备份损坏、备份不在了给统一说法", () => {
    expect(taskFailureReason({ code: "world_in_use", message: "这个存档正被游戏打开，退出游戏后再试" })).toBe("这个存档正被游戏打开");
    expect(taskFailureReason({ code: "world_backup_corrupt", message: "备份里有越出存档目录的条目 ../level.dat" })).toBe("备份文件已损坏，无法恢复");
    expect(taskFailureReason({ code: "world_backup_not_found", message: "「w1」的备份 1-auto.zip 已经不在了" })).toBe("这份备份已经不在了");
  });

  it("恢复没做完用后端原文：原存档与恢复出的副本各在哪，只有原文里有", () => {
    const message = "原来的存档已移入回收站，恢复出的副本在 D:/saves/w1.petalfall-restore，请手动改名为 w1";
    expect(taskFailureReason({ code: "world_restore_incomplete", message })).toBe(message);
  });

  it("别的码照旧：认识的给统一说法，不认识的用原文", () => {
    expect(taskFailureReason({ code: "network_failed", message: "x" })).toBe("网络连接失败");
    expect(taskFailureReason({ code: "io", message: "磁盘已满" })).toBe("磁盘已满");
  });
});

describe("通知与确认", () => {
  it("手动备份完成：正文写大小，清理过旧备份时追加份数", () => {
    expect(TASK_TOAST.worldBackedUp("新的世界", 412 * 1_048_576, 0)).toEqual({ title: "已备份「新的世界」", body: "412 MB" });
    expect(TASK_TOAST.worldBackedUp("新的世界", 412 * 1_048_576, 3)).toEqual({ title: "已备份「新的世界」", body: "412 MB · 清理了 3 份旧的自动备份" });
  });

  it("恢复完成：原存档没进回收站时不带正文", () => {
    expect(TASK_TOAST.worldRestored("新的世界", true)).toEqual({ title: "已恢复「新的世界」", body: "原来的存档已移入回收站" });
    expect(TASK_TOAST.worldRestored("新的世界", false)).toEqual({ title: "已恢复「新的世界」" });
  });

  it("恢复确认：标题不超过 20 字、时刻写在正文里，确认键是「恢复备份」", () => {
    const copy = CONFIRM_COPY.restoreWorld("十个字的存档名字啊啊", "2026年10月31日 14:02");
    expect(copy.title).toBe("恢复「十个字的存档名字啊啊」的备份？");
    expect([...copy.title].length).toBeLessThanOrEqual(20);
    expect(copy.body).toBe("存档会回到 2026年10月31日 14:02 备份时的样子，现在的存档会移入回收站，需要时可以从回收站找回。");
    expect(copy.confirmLabel).toBe("恢复备份");
  });

  it("自动备份没完成、改名后备份没跟上、删除一份备份", () => {
    expect(TOAST_COPY.autoBackupFailed("樱花生存", "磁盘已满")).toEqual({ title: "「樱花生存」的自动备份没有完成", body: "磁盘已满" });
    expect(TOAST_COPY.backupsNotMoved("生存二", "D:/b/instances/生存")).toEqual({ title: "「生存二」的存档备份没能跟着改名", body: "备份还在 D:/b/instances/生存" });
    expect(TOAST_COPY.backupDeleted).toEqual({ title: "已删除一份备份", body: "已移入回收站" });
  });

  it("删除实例确认的末句：有备份时说备份留在哪，没有时指向存档菜单", () => {
    expect(`${DELETE_INSTANCE_COPY.backupsKeptLead(4)}D:/b${DELETE_INSTANCE_COPY.backupsKeptTail}`).toBe("这些存档已有 4 份备份，保留在 D:/b，不会随实例删除。");
    expect(DELETE_INSTANCE_COPY.backupHint).toBe("想留着存档的话，先在概览的存档菜单里选「备份存档」。");
  });
});
