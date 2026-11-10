// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { CONFIRM_COPY } from "../copy/flows";
import type { InstanceSummary } from "../domain/adapt";
import type { Task } from "../domain/types";
import type { LauncherState } from "../state/store";
import { PEEK_COPY } from "../copy/shell";
import { formatSpeed, percent } from "../domain/format";
import { cancelTaskConfirm, overallProgress, overallTrack, peekRows, ROW_STATE_WIDEST } from "./DownloadPeek";

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
    doneBytes: 0,
    transferredBytes: 0,
    batchTransferred: 0,
    batchFiles: 0,
    phase: null,
    speedBps: 0,
    startedAt: null,
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

  it("环的标识：只随活动任务的集合与各自的批次变，进度与队列顺序变化不换标识", () => {
    const a = task("a", { totalBytes: 300, batchFiles: 3, progress: 0.2 });
    const b = task("b", { status: "queued" });
    const base = overallTrack([a, b]);
    expect(overallTrack([{ ...a, progress: 0.9 }, b])).toBe(base);
    expect(overallTrack([b, a])).toBe(base);
    expect(overallTrack([a, b, task("c", { status: "done" })])).toBe(base);
    expect(overallTrack([a])).not.toBe(base);
    expect(overallTrack([a, b, task("d")])).not.toBe(base);
    expect(overallTrack([{ ...a, totalBytes: 900, batchFiles: 40 }, b])).not.toBe(base);
  });
});

describe("快览的列表与失败点", () => {
  it("运行中在前、排队在后，各自保持队列顺序，已结束的不列", () => {
    const tasks = [task("q1", { status: "queued" }), task("r1"), task("d1", { status: "done" }), task("q2", { status: "queued" }), task("r2")];
    expect(peekRows(tasks).map((t) => t.id)).toEqual(["r1", "r2", "q1", "q2"]);
  });

  it("刚完成、还在收尾的任务仍按运行中排在原来的位置；收尾只留已完成的，失败的不留", () => {
    const tasks = [task("r1"), task("d1", { status: "done" }), task("q1", { status: "queued" }), task("r2"), task("f1", { status: "failed" }), task("d2", { status: "done" })];
    expect(peekRows(tasks, new Set(["d1", "f1"])).map((t) => t.id)).toEqual(["r1", "d1", "r2", "q1"]);
  });

  it("入口名称并入计数与失败数", () => {
    expect(PEEK_COPY.button(0, 0)).toBe("下载任务");
    expect(PEEK_COPY.button(2, 1)).toBe("下载任务，2 个进行中，1 个任务失败");
  });
});

/** 速度文字拆成数字与单位：「1.2 MB/s」为 ["1.2", "MB/s"]。 */
function splitSpeed(text: string): [string, string] {
  const m = /^(\d+(?:\.\d)?) ((?:[KMG])?B\/s)$/.exec(text);
  if (m === null) throw new Error(`速度文字的格式不认识：${text}`);
  return [m[1], m[2]];
}

describe("快览行状态文字的留宽字样", () => {
  it("每个单位下写得出的速度都不长于该单位的四位整数，满格的百分数也不长于留宽用的那个", () => {
    const KB = 1024;
    // 进位边界：99.95 起写成三位整数，四舍五入够 1024 就进到下一个单位；字节数不到 1 KB 时原样写（上报的速度是整数）
    const edges = [0, 1, 999, 1023, KB, 99.94 * KB, 99.96 * KB, 1023.4 * KB, 1023.6 * KB, 1023.4 * KB ** 2, 1023.4 * KB ** 3, KB ** 4 - 1];
    const random = Array.from({ length: 300 }, () => Math.floor(2 ** (Math.random() * 40)));
    for (const bps of [...edges, ...random]) {
      const [digits, unit] = splitSpeed(formatSpeed(bps));
      expect(digits.length, `${bps} 写成 ${formatSpeed(bps)}`).toBeLessThanOrEqual(4);
      expect(ROW_STATE_WIDEST).toContain(PEEK_COPY.progress(percent(1), `1023 ${unit}`));
    }
    for (const p of [0, 0.004, 0.096, 0.5, 0.994, 1, Math.random()]) expect(percent(p).length).toBeLessThanOrEqual(percent(1).length);
  });

  it("排队中的状态词也在留宽字样里：从排队轮到运行时这一格不变宽", () => {
    expect(ROW_STATE_WIDEST).toContain(PEEK_COPY.queued);
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
