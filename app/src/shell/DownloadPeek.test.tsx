// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { CONFIRM_COPY } from "../copy/flows";
import type { InstanceSummary } from "../domain/adapt";
import type { Task } from "../domain/types";
import type { LauncherState } from "../state/store";
import { PEEK_COPY } from "./copy";
import { cancelTaskConfirm, overallProgress, peekRows, unseenFailures } from "./DownloadPeek";

function task(id: string, patch: Partial<Task> = {}): Task {
  return {
    id,
    kind: "mod",
    title: `安装 ${id}`,
    detail: "",
    instanceId: null,
    status: "running",
    progress: 0,
    bytes: 0,
    totalBytes: null,
    speedBps: 0,
    attempt: 1,
    error: null,
    createdAt: 0,
    finishedAt: null,
    spec: { command: "install_resource", args: { id } },
    ...patch,
  };
}

function stateWith(instances: Pick<InstanceSummary, "id" | "name">[]): LauncherState {
  return { instances } as unknown as LauncherState;
}

describe("下载入口的总进度", () => {
  it("按声明大小加权：大文件的进度占大头", () => {
    const tasks = [task("a", { totalBytes: 300, progress: 1 }), task("b", { totalBytes: 100, progress: 0 })];
    expect(overallProgress(tasks)).toBe(0.75);
  });

  it("大小未知的任务不参与加权；全都未知时为 null", () => {
    expect(overallProgress([task("a", { totalBytes: 200, progress: 0.5 }), task("b", { totalBytes: null, progress: 0.9 })])).toBe(0.5);
    expect(overallProgress([task("a", { totalBytes: null, progress: 0.9 })])).toBeNull();
  });

  it("已结束的任务不算", () => {
    expect(overallProgress([task("a", { status: "done", totalBytes: 100, progress: 1 }), task("b", { totalBytes: 100, progress: 0.2 })])).toBeCloseTo(0.2);
  });
});

describe("快览的列表与失败点", () => {
  it("运行中在前、排队在后，各自保持队列顺序，已结束的不列", () => {
    const tasks = [task("q1", { status: "queued" }), task("r1"), task("d1", { status: "done" }), task("q2", { status: "queued" }), task("r2")];
    expect(peekRows(tasks).map((t) => t.id)).toEqual(["r1", "r2", "q1", "q2"]);
  });

  it("只认外壳挂载之后失败、还没看过的尝试；重试后再失败算新的一次", () => {
    const tasks = [
      task("old", { status: "failed", finishedAt: 99 }),
      task("seen", { status: "failed", finishedAt: 150 }),
      task("again", { status: "failed", finishedAt: 160, attempt: 2 }),
    ];
    const seen = new Set(["seen#1", "again#1"]);
    expect(unseenFailures(tasks, 100, seen).map((t) => t.id)).toEqual(["again"]);
  });

  it("入口名称并入计数与失败数", () => {
    expect(PEEK_COPY.button(0, 0)).toBe("下载任务");
    expect(PEEK_COPY.button(2, 1)).toBe("下载任务，2 个进行中，1 个任务失败");
  });
});

describe("取消任务前的确认", () => {
  it("排队中的任务与运行中的装 Mod 直接取消", () => {
    const state = stateWith([]);
    expect(cancelTaskConfirm(state, task("q", { status: "queued", kind: "game", instanceId: "新实例" }))).toBeNull();
    expect(cancelTaskConfirm(state, task("m", { kind: "mod", instanceId: "生存" }))).toBeNull();
  });

  it("运行中的新建与导入：取消后实例会被删除，取消键是「继续下载」", () => {
    const state = stateWith([{ id: "整合包", name: "整合包" }]);
    const create = task("c", { kind: "game", title: "安装 1.21.1", instanceId: "新实例" });
    expect(cancelTaskConfirm(state, create)).toEqual({ ...CONFIRM_COPY.cancelCreate("安装 1.21.1", "新实例"), cancelLabel: CONFIRM_COPY.keepDownloading, tone: "danger" });
    const pack = task("p", { kind: "modpack", title: "导入整合包 X", instanceId: "整合包" });
    expect(cancelTaskConfirm(state, pack)?.body).toBe(CONFIRM_COPY.cancelCreate("导入整合包 X", "整合包").body);
  });

  it("运行中的修复：说明实例会停在文件不完整的状态", () => {
    const state = stateWith([{ id: "生存", name: "生存" }]);
    expect(cancelTaskConfirm(state, task("r", { kind: "repair", title: "补全", instanceId: "生存" }))?.body).toBe(CONFIRM_COPY.cancelRepair("补全", "生存").body);
  });

  it("新建、修复任务没有目标实例是状态坏了，直接抛错", () => {
    expect(() => cancelTaskConfirm(stateWith([]), task("c", { kind: "game", instanceId: null }))).toThrow("没有目标实例");
  });
});
