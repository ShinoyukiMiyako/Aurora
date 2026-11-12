import { describe, expect, it } from "vitest";
import { formatBytes } from "../../domain/format";
import { MAX_PARALLEL_TASKS } from "../../domain/limits";
import { TASK_KINDS, type InstallPhase, type Task, type TaskKind } from "../../domain/types";
import { APP_NAME } from "../../lib/app-info";
import { newTask } from "../../state/tasks";
import { CHART_MIN_CEILING_BPS, ETA_WINDOW_SAMPLES, THROUGHPUT_SAMPLES } from "./constants";
import { TASKS_COPY } from "./copy";
import {
  bucketTasks,
  cancelAllConfirm,
  cancelConfirm,
  chartCeiling,
  chartGeometry,
  durationText,
  etaSpeed,
  etaText,
  filterCounts,
  filterOf,
  filterRoute,
  laneSlots,
  listBuckets,
  NO_LANES,
  overviewOf,
  overviewTrack,
  overviewRemaining,
  pushSample,
  rowMeta,
  retryNeedsNetwork,
  sameTaskLayout,
  subtitleOf,
  takeSample,
  taskGroups,
  totalEtaSpeed,
  type ThroughputSample,
} from "./model";

const T0 = 1_730_000_000_000;
const MB = 1024 * 1024;

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    ...newTask({ id, kind: "java", title: `下载 Java ${id}`, detail: "Mojang 运行时 · 手动", instanceId: null, spec: { command: "install_java", args: { requiredMajor: 21 } } }, T0),
    ...overrides,
  };
}

const ctx = (over: Partial<Parameters<typeof rowMeta>[1]> = {}) => ({ queuePosition: null, etaSpeed: 0, speed: 0, bytes: 0, now: T0 + 10 * 60_000, ...over });

describe("剩余时间与用时", () => {
  it("剩余时间：秒按 5 向上取整，满 60 秒进到分钟，满 1 小时不再细说", () => {
    const cases: [number, string][] = [
      [0.2, "约 5 秒"],
      [5, "约 5 秒"],
      [5.01, "约 10 秒"],
      [54.9, "约 55 秒"],
      [55.1, "约 1 分钟"],
      [59.9, "约 1 分钟"],
      [60, "约 1 分钟"],
      [60.5, "约 2 分钟"],
      [3599, "约 60 分钟"],
      [3600, "超过 1 小时"],
      [86_400, "超过 1 小时"],
    ];
    for (const [seconds, text] of cases) expect([seconds, etaText(seconds)]).toEqual([seconds, text]);
  });

  it("剩余时间：已经下完、负数与无穷（速度为 0）都写即将完成，NaN 是调用方的错", () => {
    expect([etaText(0), etaText(-3), etaText(Number.POSITIVE_INFINITY)]).toEqual(["即将完成", "即将完成", "即将完成"]);
    expect(() => etaText(Number.NaN)).toThrow("NaN");
  });

  it("用时：不足 60 秒写秒且至少 1 秒，之后按时长写分钟与小时", () => {
    expect(durationText(0)).toBe("1 秒");
    expect(durationText(400)).toBe("1 秒");
    expect(durationText(59_400)).toBe("59 秒");
    // 四舍五入到 60 秒就该写成分钟，而不是「60 秒」
    expect(durationText(59_600)).toBe("1 分钟");
    expect(durationText(90_000)).toBe("2 分钟");
    expect(durationText(3_720_000)).toBe("1 小时 2 分钟");
    expect(() => durationText(-1)).toThrow("非负");
  });
});

describe("分组与筛选", () => {
  const running1 = task("r1", { status: "running" });
  const queued1 = task("q1");
  const running2 = task("r2", { status: "running" });
  const doneOld = task("d1", { status: "done", finishedAt: T0 + 1000 });
  const failed = task("f1", { status: "failed", finishedAt: T0 + 3000, error: { code: "network_failed", message: "dns" } });
  const cancelled = task("c1", { status: "cancelled", finishedAt: T0 + 2000 });
  const doneNew = task("d2", { status: "done", finishedAt: T0 + 4000 });
  const all = [running1, queued1, doneOld, failed, running2, cancelled, doneNew];

  it("运行中与排队中按队列顺序，已结束按结束时刻从新到旧", () => {
    const b = bucketTasks(all);
    expect(b.running.map((t) => t.id)).toEqual(["r1", "r2"]);
    expect(b.queued.map((t) => t.id)).toEqual(["q1"]);
    expect(b.done.map((t) => t.id)).toEqual(["d2", "d1"]);
    expect(b.ended.map((t) => t.id)).toEqual(["f1", "c1"]);
    expect(b.finished.map((t) => t.id)).toEqual(["d2", "f1", "c1", "d1"]);
    expect(filterCounts(b)).toEqual({ all: 7, active: 3, done: 2, failed: 2 });
  });

  it("「全部」分进行中与已结束两组并带数量，其余筛选不分组", () => {
    const b = bucketTasks(all);
    expect(taskGroups(b, "all").map((g) => [g.label, g.tasks.map((t) => t.id)])).toEqual([
      ["进行中 · 3", ["r1", "r2", "q1"]],
      ["已结束 · 4", ["d2", "f1", "c1", "d1"]],
    ]);
    expect(taskGroups(b, "active").map((g) => [g.label, g.tasks.length])).toEqual([[null, 3]]);
    expect(taskGroups(b, "done").map((g) => g.tasks.map((t) => t.id))).toEqual([["d2", "d1"]]);
    expect(taskGroups(b, "failed").map((g) => g.tasks.map((t) => t.id))).toEqual([["f1", "c1"]]);
    // 已完成、失败与取消都是已结束的子集，沿用同一个分组容器：换筛选时列表不重建
    expect((["all", "active", "done", "failed"] as const).map((f) => taskGroups(b, f).map((g) => g.key))).toEqual([["active", "finished"], ["active"], ["finished"], ["finished"]]);
  });

  it("空组不出现：只有已结束的任务时「全部」只剩一组，空筛选返回空数组", () => {
    const b = bucketTasks([doneOld]);
    expect(taskGroups(b, "all").map((g) => g.key)).toEqual(["finished"]);
    expect(taskGroups(b, "active")).toEqual([]);
    expect(taskGroups(b, "failed")).toEqual([]);
  });

  it("已结束却没有结束时刻是状态层的契约错误", () => {
    expect(() => bucketTasks([task("x", { status: "done", finishedAt: null }), doneOld])).toThrow("没有结束时刻");
  });

  it("筛选读写路由：不带参数即全部，写回全部时不带参数", () => {
    expect(filterOf({ page: "tasks" })).toBe("all");
    expect(filterOf({ page: "tasks", filter: "failed" })).toBe("failed");
    expect(filterRoute("all")).toEqual({ page: "tasks" });
    expect(filterRoute("done")).toEqual({ page: "tasks", filter: "done" });
  });

  const ids = (lanes: readonly (Task | null)[]) => lanes.map((t) => (t === null ? null : t.id));

  it("通道一开始按开始顺序依次放运行中的任务，空出的为 null；超过上限是调度的错", () => {
    expect(ids(laneSlots(NO_LANES, [running1], []))).toEqual(["r1", null, null]);
    expect(laneSlots(NO_LANES, [], []).every((t) => t === null)).toBe(true);
    expect(() => laneSlots(NO_LANES, [running1, running2, task("r3", { status: "running" }), task("r4", { status: "running" })], [])).toThrow("超过了上限 3");
    expect(() => laneSlots([null], [running1], [])).toThrow("应为 3 条");
  });

  it("通道粘住任务：前面的任务结束，后面的不换道；新任务填进编号最小的空通道", () => {
    const r3 = task("r3", { status: "running" });
    const r4 = task("r4", { status: "running" });
    // r1 在 1 号道结束：r2、r3 留在 2、3 号道，1 号道空出来
    expect(ids(laneSlots(["r1", "r2", "r3"], [running2, r3], []))).toEqual([null, "r2", "r3"]);
    // r4 开始：填进空出的 1 号道，而不是排到末尾
    expect(ids(laneSlots([null, "r2", "r3"], [running2, r3, r4], []))).toEqual(["r4", "r2", "r3"]);
    // 两条空道时按开始顺序先填小号
    expect(ids(laneSlots([null, "r2", null], [running2, r3, r4], []))).toEqual(["r3", "r2", "r4"]);
  });

  it("收尾的任务留在原通道把进度推满，没有空位的新任务先不画，等收尾结束再接上", () => {
    const r3 = task("r3", { status: "running" });
    const r4 = task("r4", { status: "running" });
    const finished = { ...running1, status: "done" as const, progress: 1, finishedAt: T0 };
    // r1 刚完成还在收尾、r4 同时开始：三条道都占着，r4 先不画
    expect(ids(laneSlots(["r1", "r2", "r3"], [running2, r3, r4], [finished]))).toEqual(["r1", "r2", "r3"]);
    // 收尾结束：r4 接进 1 号道
    expect(ids(laneSlots(["r1", "r2", "r3"], [running2, r3, r4], []))).toEqual(["r4", "r2", "r3"]);
    // 收尾的任务不会抢新通道：上一次不在通道里的不画
    expect(ids(laneSlots([null, null, null], [running2], [finished]))).toEqual(["r2", null, null]);
  });
});

describe("列表分组用的桶", () => {
  it("刚完成、还在收尾的任务留在运行中原来的位置，不进已结束；其余照真实状态分", () => {
    const r1 = task("r1", { status: "running" });
    const d1 = task("d1", { status: "done", finishedAt: T0 + 5000, progress: 1 });
    const r2 = task("r2", { status: "running" });
    const d0 = task("d0", { status: "done", finishedAt: T0 });
    const all = [r1, d1, r2, d0];
    const held = listBuckets(all, new Set(["d1"]));
    expect(held.running.map((t) => t.id)).toEqual(["r1", "d1", "r2"]);
    expect(held.done.map((t) => t.id)).toEqual(["d0"]);
    expect(held.finished.map((t) => t.id)).toEqual(["d0"]);
    expect(taskGroups(held, "all").map((g) => [g.label, g.tasks.length])).toEqual([
      ["进行中 · 3", 3],
      ["已结束 · 1", 1],
    ]);
    // 没有在收尾的与 bucketTasks 相同；收尾集合里的失败、取消不算（没有走满这回事）
    expect(listBuckets(all, new Set())).toEqual(bucketTasks(all));
    const failed = task("f1", { status: "failed", finishedAt: T0, error: { code: "network_failed", message: "dns" } });
    expect(listBuckets([failed], new Set(["f1"])).running).toEqual([]);
  });
});

describe("行内元信息", () => {
  it("运行中：已下 / 总量，速度 · 剩余时间（按平均速度估算）", () => {
    const t = task("r", { status: "running", bytes: 120 * MB, totalBytes: 612 * MB, speedBps: 12 * MB, progress: 0.2 });
    // 剩余 492 MB，平均 4 MB/s → 123 秒 → 约 3 分钟
    expect(rowMeta(t, ctx({ etaSpeed: 4 * MB, speed: 12 * MB, bytes: 120 * MB }))).toEqual({ left: "120 MB / 612 MB", right: "12.0 MB/s · 约 3 分钟", danger: false });
    // 平均速度还没有（0）时用瞬时速度：492 / 12 = 41 秒 → 约 45 秒
    expect(rowMeta(t, ctx({ etaSpeed: 0, speed: 12 * MB, bytes: 120 * MB })).right).toBe("12.0 MB/s · 约 45 秒");
  });

  it("运行中：写出来的是平滑过的显示速度，不是每 100 ms 一跳的瞬时值；等待数据仍按瞬时值判断", () => {
    const t = task("r", { status: "running", bytes: 120 * MB, totalBytes: 612 * MB, speedBps: 12 * MB, progress: 0.2 });
    expect(rowMeta(t, ctx({ etaSpeed: 0, speed: 10 * MB, bytes: 120 * MB })).right).toBe("10.0 MB/s · 约 45 秒");
    expect(rowMeta({ ...t, totalBytes: null }, ctx({ speed: 10 * MB, bytes: 120 * MB })).right).toBe("10.0 MB/s");
    expect(rowMeta({ ...t, speedBps: 0 }, ctx({ speed: 10 * MB, bytes: 120 * MB })).right).toBe("等待数据");
  });

  it("运行中：已下大小与剩余时间按写出来的已下字节算（按节拍换字的那个），不是任务里最新报上来的原值", () => {
    const t = task("r", { status: "running", bytes: 120 * MB, totalBytes: 612 * MB, speedBps: 12 * MB, progress: 0.2 });
    // 写出来的还停在 60 MB：剩余 552 MB / 12 MB/s = 46 秒 → 约 50 秒；按原值算会是 41 秒 → 约 45 秒
    expect(rowMeta(t, ctx({ speed: 12 * MB, bytes: 60 * MB }))).toEqual({ left: "60.0 MB / 612 MB", right: "12.0 MB/s · 约 50 秒", danger: false });
    // 总量未知时同样写写出来的那个；还没写出过任何字节时仍是大小待定
    expect(rowMeta({ ...t, totalBytes: null }, ctx({ speed: 12 * MB, bytes: 60 * MB })).left).toBe("60.0 MB / 大小待定");
    expect(rowMeta({ ...t, totalBytes: null }, ctx({ speed: 12 * MB, bytes: 0 })).left).toBe("大小待定");
  });

  it("运行中：速度为 0 写等待数据；总量未知时写大小待定，只报速度", () => {
    expect(rowMeta(task("r", { status: "running", bytes: 0, totalBytes: 612 * MB, speedBps: 0 }), ctx()).right).toBe("等待数据");
    expect(rowMeta(task("r", { status: "running", bytes: 0, totalBytes: null, speedBps: 0 }), ctx())).toMatchObject({ left: "大小待定", right: "等待数据" });
    expect(rowMeta(task("r", { status: "running", bytes: 3 * MB, totalBytes: null, speedBps: MB }), ctx({ speed: MB, bytes: 3 * MB }))).toMatchObject({ left: "3.0 MB / 大小待定", right: "1.0 MB/s" });
  });

  describe("运行中的分步任务", () => {
    const VANILLA: readonly InstallPhase[] = ["metadata", "libraries", "assets", "natives"];

    it("这一步还没认下下载：只写在第几步，上一批留下的字节与速度不写", () => {
      const t = task("r", { kind: "game", status: "running", bytes: 50e6, totalBytes: 50e6, speedBps: 3 * MB, phase: { plan: VANILLA, index: 3, batch: null } });
      expect(rowMeta(t, ctx({ etaSpeed: 2 * MB }))).toEqual({ left: "解压本地库 · 第 4/4 步", right: "", danger: false });
      expect(rowMeta({ ...t, attempt: 2 }, ctx()).left).toBe("解压本地库 · 第 4/4 步 · 第 2 次尝试");
    });

    it("认下了这一步的那批：在第几步之后写这一批的量，右侧照常是速度与剩余时间", () => {
      const t = task("r", { kind: "game", status: "running", bytes: 24_800_000, totalBytes: 124_000_000, speedBps: 4 * MB, phase: { plan: VANILLA, index: 2, batch: { total: 3000, totalBytes: 124_000_000 } } });
      const meta = rowMeta(t, ctx({ etaSpeed: 4 * MB, speed: 4 * MB, bytes: 24_800_000 }));
      expect(meta.left).toBe(`下载资源文件 · 第 3/4 步 · ${TASKS_COPY.row.transfer(formatBytes(24_800_000), formatBytes(124_000_000))}`);
      // 剩余 99.2 MB（这一批的），4 MB/s → 23.7 秒 → 约 25 秒
      expect(meta.right).toBe("4.0 MB/s · 约 25 秒");
    });
  });

  it("排队中：位次与总量；没有位次是调用方的错", () => {
    expect(rowMeta(task("q"), ctx({ queuePosition: 2 }))).toEqual({ left: "排队中 · 第 2 位", right: "大小待定", danger: false });
    expect(rowMeta(task("q", { totalBytes: 2048 }), ctx({ queuePosition: 1 })).right).toBe("2.0 KB");
    expect(() => rowMeta(task("q"), ctx())).toThrow("没有队列位次");
  });

  it("已完成：写这一次尝试跨批次的实际传输量，用时从开始运行算起、不含排队等待；右侧相对时间", () => {
    // 加入队列 90 秒后才开始跑，跑了 20 秒；最后一批只有 2 MB，累计传了 50 MB
    const done = task("d", { status: "done", createdAt: T0, startedAt: T0 + 90_000, finishedAt: T0 + 110_000, bytes: 2 * MB, totalBytes: 2 * MB, doneBytes: 52_400_000, transferredBytes: 52_400_000 });
    expect(rowMeta(done, ctx({ now: T0 + 5 * 60_000 + 110_000 }))).toEqual({ left: "50.0 MB · 用时 20 秒", right: "5 分钟前", danger: false });
    expect(rowMeta({ ...done, finishedAt: T0 + 90_000 + 125_000 }, ctx({ now: T0 + 215_000 })).left).toBe("50.0 MB · 用时 2 分钟");
    // 边界：刚开始就结束也写满 1 秒
    expect(rowMeta({ ...done, finishedAt: T0 + 90_000 }, ctx()).left).toBe("50.0 MB · 用时 1 秒");
  });

  it("已完成：补全时跳过的完整文件不算下载量，有效字节再多也只写实际传输的", () => {
    const repaired = task("d", { kind: "repair", status: "done", startedAt: T0, finishedAt: T0 + 2_000, bytes: 701 * MB, totalBytes: 701 * MB, doneBytes: 701 * MB, transferredBytes: 5.5 * MB });
    expect(rowMeta(repaired, ctx()).left).toBe("5.5 MB · 用时 2 秒");
    // 边界：只传了 1 字节也如实写，不算已就绪
    expect(rowMeta({ ...repaired, transferredBytes: 1 }, ctx()).left).toBe("1 B · 用时 2 秒");
  });

  it("已完成：一个字节都没传写文件已就绪；较早的任务记录没有开始时刻，不写用时", () => {
    const done = task("d", { status: "done", createdAt: T0, startedAt: T0 + 1_000, finishedAt: T0 + 4_000, doneBytes: 701 * MB, transferredBytes: 0 });
    expect(rowMeta(done, ctx()).left).toBe("文件已就绪 · 用时 3 秒");
    expect(rowMeta({ ...done, startedAt: null, transferredBytes: 4096 }, ctx()).left).toBe("4.0 KB");
    expect(rowMeta({ ...done, startedAt: null, transferredBytes: 0 }, ctx()).left).toBe("文件已就绪");
    // 重试过的任务照样写第几次尝试，用时只算最后这一次
    expect(rowMeta({ ...done, attempt: 3 }, ctx()).left).toBe("文件已就绪 · 用时 3 秒 · 第 3 次尝试");
  });

  it("已完成：较早的下载记录没有传输量，累计字节含跳过的文件，不拿它冒充下载量，也不说已就绪", () => {
    const old = task("d", { kind: "repair", status: "done", startedAt: T0, finishedAt: T0 + 2_000, doneBytes: 701 * MB, transferredBytes: null });
    expect(rowMeta(old, ctx()).left).toBe("用时 2 秒");
    expect(rowMeta({ ...old, startedAt: null }, ctx()).left).toBe("已完成");
  });

  it("已完成：导出、备份、恢复是本地任务，没有网络传输，写处理的字节，不说已就绪", () => {
    const kinds: readonly TaskKind[] = ["modpack_export", "world_backup", "world_restore"];
    for (const kind of kinds) {
      const done = task("l", { kind, status: "done", startedAt: T0, finishedAt: T0 + 3_000, doneBytes: 3 * MB, transferredBytes: 0 });
      expect(rowMeta(done, ctx()).left, kind).toBe("3.0 MB · 用时 3 秒");
      expect(rowMeta({ ...done, doneBytes: 0 }, ctx()).left, kind).toBe("用时 3 秒");
      expect(rowMeta({ ...done, doneBytes: 0, startedAt: null }, ctx()).left, kind).toBe("已完成");
      // 较早的本地任务记录没有传输量，处理的字节照写
      expect(rowMeta({ ...done, transferredBytes: null }, ctx()).left, kind).toBe("3.0 MB · 用时 3 秒");
    }
  });

  it("已完成：运行期间系统时钟往回调过（结束时刻早于开始时刻）算不出用时，不写用时，也不让整行抛错", () => {
    const done = task("d", { status: "done", createdAt: T0, startedAt: T0 + 5_000, finishedAt: T0 + 2_000, doneBytes: 3 * MB, transferredBytes: 3 * MB });
    expect(rowMeta(done, ctx()).left).toBe("3.0 MB");
    expect(rowMeta({ ...done, transferredBytes: null }, ctx()).left).toBe("已完成");
    // 边界：只早 1 毫秒同样不写
    expect(rowMeta({ ...done, finishedAt: T0 + 4_999 }, ctx()).left).toBe("3.0 MB");
  });

  it("失败：危险色的具体原因，能归类的用统一说法，其余用后端原文", () => {
    const failed = (code: string, message: string) => task("f", { status: "failed", finishedAt: T0, error: { code, message } });
    expect(rowMeta(failed("network_failed", "dns error"), ctx({ now: T0 + 30_000 }))).toEqual({ left: "失败：网络连接失败", right: "30 秒前", danger: true });
    expect(rowMeta(failed("interrupted", ""), ctx()).left).toBe(`失败：${APP_NAME}关闭时中断`);
    expect(rowMeta(failed("download_failed", "下载源上找不到这个文件（404）"), ctx()).left).toBe("失败：下载源上找不到这个文件（404）");
    expect(() => rowMeta(task("f", { status: "failed", finishedAt: T0, error: null }), ctx())).toThrow("没有失败原因");
  });

  it("已取消：取消时的进度", () => {
    expect(rowMeta(task("c", { status: "cancelled", progress: 0.374, finishedAt: T0 }), ctx({ now: T0 + 2 * 3_600_000 }))).toEqual({
      left: "取消于 37%",
      right: "2 小时前",
      danger: false,
    });
  });

  it("第 2 次及以后的尝试在左侧追加尝试次数，第 1 次不写", () => {
    expect(rowMeta(task("q", { attempt: 3 }), ctx({ queuePosition: 1 })).left).toBe("排队中 · 第 1 位 · 第 3 次尝试");
    expect(rowMeta(task("q", { attempt: 1 }), ctx({ queuePosition: 1 })).left).toBe("排队中 · 第 1 位");
  });
});

describe("吞吐采样与总览", () => {
  const sample = (total: number, tasks: Record<string, number> = {}): ThroughputSample => ({ total, tasks });

  it("采样记下每个运行中任务（按这一次尝试）的速度与总和，只留窗口 48 个再多一个（曲线左缘正滑出去的那一个）", () => {
    const s = takeSample([task("a", { status: "running", speedBps: 300 }), task("b", { status: "running", speedBps: 700, attempt: 2 })]);
    expect(s).toEqual({ total: 1000, tasks: { "a#1": 300, "b#2": 700 } });
    let history: ThroughputSample[] = [];
    for (let i = 0; i < THROUGHPUT_SAMPLES + 5; i++) history = pushSample(history, sample(i));
    expect(history).toHaveLength(THROUGHPUT_SAMPLES + 1);
    expect([history[0].total, history[THROUGHPUT_SAMPLES].total]).toEqual([4, THROUGHPUT_SAMPLES + 4]);
  });

  it("剩余时间速度取最近 5 秒里这一次尝试的平均；没有采样或平均为 0 时用瞬时速度", () => {
    const t = task("a", { status: "running", speedBps: 900 });
    const history = [sample(0, { "a#1": 9999 }), ...[100, 200, 300, 400, 500].map((v) => sample(v, { "a#1": v }))];
    expect(history.slice(-ETA_WINDOW_SAMPLES)).toHaveLength(5);
    expect(etaSpeed(history, t)).toBe(300);
    // 只在窗口里出现过两次：只平均这两次
    expect(etaSpeed([sample(0), sample(0), sample(0), sample(1, { "a#1": 100 }), sample(1, { "a#1": 300 })], t)).toBe(200);
    expect(etaSpeed([], t)).toBe(900);
    expect(etaSpeed([sample(0, { "a#1": 0 })], t)).toBe(900);
    // 重试后的新尝试不沿用上一次的速度
    expect(etaSpeed(history, { ...t, attempt: 2 })).toBe(900);
  });

  it("总览的剩余时间速度：最近 5 秒总速度的平均，规则同上", () => {
    expect(totalEtaSpeed([sample(10), sample(20), sample(30), sample(40), sample(50), sample(60)], 7)).toBe(40);
    expect(totalEtaSpeed([], 7)).toBe(7);
    expect(totalEtaSpeed([sample(0), sample(0)], 7)).toBe(7);
  });

  it("总览：总量已知的活动任务累计字节，超出总量的字节不计；标签随运行与排队变化", () => {
    const b = bucketTasks([
      task("r1", { status: "running", bytes: 300, totalBytes: 1000, speedBps: 50 }),
      task("r2", { status: "running", bytes: 1500, totalBytes: 1000, speedBps: 25 }),
      task("r3", { status: "running", bytes: 777, totalBytes: null, speedBps: 25 }),
      task("q1", { totalBytes: null }),
      task("d1", { status: "done", bytes: 5000, totalBytes: 5000, finishedAt: T0 }),
    ]);
    const o = overviewOf(b);
    expect(o).toEqual({ label: "running", speed: 100, downloaded: 1300, total: 2000, fraction: 0.65, localOnly: false });
    expect(overviewRemaining(o, o.downloaded, 0)).toBe("剩余 700 B · 约 10 秒");
    expect(overviewRemaining(o, o.downloaded, 10)).toBe("剩余 700 B · 约 2 分钟");
    expect(overviewRemaining({ ...o, speed: 0 }, o.downloaded, 0)).toBe("剩余 700 B · 等待数据");
    // 剩余字节与剩余时间按写出来的已下字节（按节拍换字的那个）算：停在 300 时剩 1700，1700 / 10 = 170 秒 → 约 3 分钟
    expect(overviewRemaining(o, 300, 10)).toBe("剩余 1.7 KB · 约 3 分钟");
    // 只有总量未知的排队任务、或没有任何活动任务：没有可显示的进度，而不是 0%
    expect(overviewOf(bucketTasks([task("q1")]))).toEqual({ label: "waiting", speed: 0, downloaded: 0, total: 0, fraction: null, localOnly: false });
    expect(overviewOf(bucketTasks([task("d1", { status: "done", finishedAt: T0 })]))).toEqual({ label: "idle", speed: 0, downloaded: 0, total: 0, fraction: null, localOnly: false });
    // 边界：总量已知但一个字节都还没下，是真实的 0
    expect(overviewOf(bucketTasks([task("r0", { status: "running", bytes: 0, totalBytes: 1 })])).fraction).toBe(0);
  });

  it("总进度环的标识：同一批活动任务进度怎么变都不变；有任务离开、加入或换批次就变，环直接跳到新值", () => {
    const a = task("a", { status: "running", bytes: 10, totalBytes: 100, batchFiles: 4 });
    const b = task("b", { status: "running", bytes: 100, totalBytes: 100, batchFiles: 2 });
    const base = overviewTrack([a, b]);
    // 顺序无关、进度无关
    expect(overviewTrack([{ ...b, bytes: 100 }, { ...a, bytes: 60, progress: 0.6 }])).toBe(base);
    // b 完成离开活动集：组成变了，不从 55% 倒扫回 10%
    expect(overviewTrack([a])).not.toBe(base);
    expect(overviewTrack([a, b, task("c")])).not.toBe(base);
    expect(overviewTrack([{ ...a, totalBytes: 300 }, b])).not.toBe(base);
    expect(overviewTrack([{ ...a, attempt: 2 }, b])).not.toBe(base);
  });

  it("曲线：画窗口再多一个点，不足时左侧补 0；最新的一点在右缘外一格，滑一格后正好落在右缘", () => {
    const step = 100 / (THROUGHPUT_SAMPLES - 1);
    const right = (THROUGHPUT_SAMPLES * step).toFixed(2);
    const empty = chartGeometry([], CHART_MIN_CEILING_BPS);
    expect(empty.line.split(" ")).toHaveLength(THROUGHPUT_SAMPLES + 1);
    expect(empty.line.startsWith("M0.00,30.00")).toBe(true);

    // 2 MB/s 在 4 MB/s 的上限下画到一半高度：30 - 25 × 0.5
    const low = chartGeometry([CHART_MIN_CEILING_BPS / 2], CHART_MIN_CEILING_BPS);
    expect(low.idle).toBe(false);
    expect(low.line.endsWith(`L${right},17.50`)).toBe(true);
    expect(low.area.endsWith(`L${right},30 L0,30 Z`)).toBe(true);

    // 按给的上限画：等于上限的画到顶（距顶 5），其余按比例
    const high = chartGeometry([8 * MB, 4 * MB], 8 * MB);
    const points = high.line.split(" ");
    expect(points[THROUGHPUT_SAMPLES - 1]).toBe(`L${(47 * step).toFixed(2)},5.00`);
    expect(points[THROUGHPUT_SAMPLES]).toBe(`L${right},17.50`);
    // 上限比要画的采样低是调用方的错：曲线会画出视图
    expect(() => chartGeometry([8 * MB], 4 * MB)).toThrow("低于要画的采样");
  });

  it("纵轴上限：至少 4 MB/s、不低于画着的采样；峰值滑出窗口后每个采样只回落一成，不一下落到新的最大值", () => {
    expect(chartCeiling(null, [])).toBe(CHART_MIN_CEILING_BPS);
    expect(chartCeiling(null, [MB, 20 * MB, 3 * MB])).toBe(20 * MB);
    // 峰值已经不在：上一次 20 MB/s，这一次只降到 18 MB/s
    expect(chartCeiling(20 * MB, [3 * MB, 2 * MB])).toBeCloseTo(18 * MB, 0);
    // 一直没有新峰值，一路回落到最低上限为止
    let ceiling = 20 * MB;
    for (let i = 0; i < 60; i++) ceiling = chartCeiling(ceiling, [MB]);
    expect(ceiling).toBe(CHART_MIN_CEILING_BPS);
    // 新的峰值比回落中的上限高：立刻抬上去
    expect(chartCeiling(10 * MB, [30 * MB])).toBe(30 * MB);
    // 左缘外正滑出去的那一个也还画着，也算
    expect(chartCeiling(null, [9 * MB, ...Array<number>(THROUGHPUT_SAMPLES).fill(0)])).toBe(9 * MB);
  });
});

describe("曲线空闲的判定", () => {
  const zeros = (count: number) => Array<number>(count).fill(0);

  it("采样不足一个窗口时不判空闲：采样从进页才开始，更早有没有流量不知道", () => {
    expect(chartGeometry([], CHART_MIN_CEILING_BPS).idle).toBe(false);
    expect(chartGeometry(zeros(1), CHART_MIN_CEILING_BPS).idle).toBe(false);
    expect(chartGeometry(zeros(THROUGHPUT_SAMPLES - 1), CHART_MIN_CEILING_BPS).idle).toBe(false);
  });

  it("采满一个窗口且全为 0 才判空闲；超出窗口的采样不算", () => {
    expect(chartGeometry(zeros(THROUGHPUT_SAMPLES), CHART_MIN_CEILING_BPS).idle).toBe(true);
    expect(chartGeometry([MB, ...zeros(THROUGHPUT_SAMPLES)], CHART_MIN_CEILING_BPS).idle).toBe(true);
  });

  it("窗口里任何一秒有流量都不算空闲", () => {
    const at = Math.floor(Math.random() * THROUGHPUT_SAMPLES);
    const window = zeros(THROUGHPUT_SAMPLES);
    window[at] = 1;
    expect(chartGeometry(window, CHART_MIN_CEILING_BPS).idle, `第 ${at} 秒有 1 B/s`).toBe(false);
    expect(chartGeometry([...zeros(THROUGHPUT_SAMPLES - 1), 1], CHART_MIN_CEILING_BPS).idle).toBe(false);
  });
});

describe("本地任务的措辞", () => {
  it("活动任务全是导出、备份时总览不说已下载；混着下载任务或空闲时照旧", () => {
    const backup = task("b", { kind: "world_backup", status: "running" });
    const exportPack = task("e", { kind: "modpack_export" });
    expect(overviewOf(bucketTasks([backup, exportPack])).localOnly).toBe(true);
    expect(overviewOf(bucketTasks([backup, task("m", { kind: "mod" })])).localOnly).toBe(false);
    expect(overviewOf(bucketTasks([])).localOnly).toBe(false);
  });

  it("并行通道的说明对下载和本地任务都成立", () => {
    expect(TASKS_COPY.lanes.subtitle).toBe(`同一时间最多 ${MAX_PARALLEL_TASKS} 个任务在跑`);
  });
});

describe("取消前的确认", () => {
  const instanceTask = (command: string, status: Task["status"], instanceId: string | null = "生存整合") =>
    task("i", { status, kind: command === "repair_instance" ? "repair" : "game", title: "安装 1.21.1", instanceId, spec: { command, args: {} } });

  it("只有运行中的新建、导入、修复要确认，确认键是取消任务、取消键是继续下载", () => {
    expect(cancelConfirm(instanceTask("install_version", "running"))).toEqual({
      title: "取消「安装 1.21.1」？",
      body: "「生存整合」还没装好，取消后这个实例会被删除。",
      confirmLabel: "取消任务",
      cancelLabel: "继续下载",
      tone: "danger",
    });
    expect(cancelConfirm(instanceTask("install_modpack", "running"))?.body).toBe("「生存整合」还没装好，取消后这个实例会被删除。");
    expect(cancelConfirm(instanceTask("repair_instance", "running"))?.body).toBe("「生存整合」会停在文件不完整的状态，之后可以再点「修复实例」。");
  });

  it("排队中的任意任务、运行中的 Mod / Java 任务直接取消", () => {
    expect(cancelConfirm(instanceTask("install_version", "queued"))).toBeNull();
    expect(cancelConfirm(instanceTask("repair_instance", "queued"))).toBeNull();
    expect(cancelConfirm(instanceTask("install_mods", "running"))).toBeNull();
    expect(cancelConfirm(task("j", { status: "running" }))).toBeNull();
  });

  it("实例级任务没有关联实例是状态层的契约错误", () => {
    expect(() => cancelConfirm(instanceTask("install_version", "running", null))).toThrow("没有关联实例");
  });

  it("全部取消：按新建（含导入）与修复分别计数，为 0 的分句省略", () => {
    const active = [
      instanceTask("install_version", "running"),
      instanceTask("install_modpack", "queued"),
      instanceTask("repair_instance", "queued"),
      task("j", { status: "running" }),
    ];
    expect(cancelAllConfirm(active)).toEqual({
      title: "取消全部 4 个任务？",
      body: "正在新建的 2 个实例会被删除，正在修复的 1 个实例会保持文件不完整。",
      confirmLabel: "全部取消",
      cancelLabel: "继续下载",
      tone: "danger",
    });
    expect(cancelAllConfirm([task("a", { status: "running" }), task("b")]).body).toBe("已下载的部分会被丢弃。");
    expect(cancelAllConfirm([instanceTask("repair_instance", "running"), task("b")]).body).toBe("正在修复的 1 个实例会保持文件不完整。");
  });

  it("全部取消：队列里只有本地任务时不提下载，取消键写「不取消」；混着下载类仍写「继续下载」", () => {
    const local = [task("e", { kind: "modpack_export", status: "running" }), task("w", { kind: "world_backup", status: "running" })];
    expect(cancelAllConfirm(local)).toEqual({
      title: "取消全部 2 个任务？",
      body: "还没完成的部分会被丢弃。",
      confirmLabel: "全部取消",
      cancelLabel: "不取消",
      tone: "danger",
    });
    expect(cancelAllConfirm([...local, task("m", { kind: "mod" })])).toMatchObject({ body: "已下载的部分会被丢弃。", cancelLabel: "继续下载" });
    expect(cancelAllConfirm([task("r", { kind: "world_restore" })])).toMatchObject({ body: "还没完成的部分会被丢弃。", cancelLabel: "不取消" });
  });
});

describe("任务表的结构比较", () => {
  const running = task("a", { status: "running", progress: 0.1, bytes: 1 * MB, totalBytes: 10 * MB, doneBytes: 1 * MB, transferredBytes: 1 * MB, batchTransferred: 1 * MB, speedBps: MB, startedAt: T0 });
  const queued = task("b");

  it("只换了下载进度的七个字段：结构相同", () => {
    const next = { ...running, progress: 0.9, bytes: 9 * MB, totalBytes: 12 * MB, doneBytes: 9 * MB, transferredBytes: 2 * MB, batchTransferred: 2 * MB, speedBps: 0 };
    expect(sameTaskLayout([running, queued], [next, queued])).toBe(true);
  });

  it("分步任务换了一步、认下了一批：只是进度，结构相同", () => {
    const stepped = { ...running, phase: { plan: ["metadata", "libraries"] as const, index: 1, batch: { total: 40, totalBytes: 10 * MB } } };
    expect(sameTaskLayout([running, queued], [stepped, queued])).toBe(true);
  });

  it("换了状态、尝试次数、结束时刻或标题：结构变了", () => {
    expect(sameTaskLayout([running], [{ ...running, status: "failed", finishedAt: T0 + 1 }])).toBe(false);
    expect(sameTaskLayout([running], [{ ...running, attempt: 2 }])).toBe(false);
    expect(sameTaskLayout([running], [{ ...running, title: "下载 Java 17" }])).toBe(false);
  });

  it("增删任务、换了顺序：结构变了；空表与空表相同", () => {
    expect(sameTaskLayout([running, queued], [running])).toBe(false);
    expect(sameTaskLayout([running, queued], [queued, running])).toBe(false);
    expect(sameTaskLayout([], [])).toBe(true);
  });

  it("不认识的字段一律算结构", () => {
    const extra = { ...running, note: "新字段" } as Task;
    expect(sameTaskLayout([running], [extra])).toBe(false);
  });
});

describe("页头副标题", () => {
  const running = (kind: TaskKind) => task(kind, { kind, status: "running" });
  const queued = (kind: TaskKind) => task(`queued-${kind}`, { kind, status: "queued" });

  it("没有活动任务：写队列空闲", () => {
    expect(subtitleOf(bucketTasks([task("d", { status: "done", finishedAt: T0 })]))).toBe("队列空闲 · 新建实例、装 Mod、导入整合包都会排到这里");
  });

  it("「下载中」只算下载类：导出整合包、备份与恢复存档夹在下载之间时不计入", () => {
    expect(subtitleOf(bucketTasks([running("game"), running("mod"), running("modpack_export")]))).toBe("2 个下载中，0 个排队 · 最多 3 个并行");
    expect(subtitleOf(bucketTasks([running("mod"), running("world_backup"), queued("mod")]))).toBe("1 个下载中，1 个排队 · 最多 3 个并行");
    expect(subtitleOf(bucketTasks([running("repair"), running("world_restore")]))).toBe("1 个下载中，0 个排队 · 最多 3 个并行");
  });

  it("除本地任务外的每一类运行时都算下载，修复补的是游戏文件", () => {
    const local: readonly TaskKind[] = ["world_backup", "world_restore", "modpack_export", "instance_move"];
    for (const kind of TASK_KINDS.filter((k) => !local.includes(k))) {
      expect(subtitleOf(bucketTasks([running(kind)])), kind).toBe("1 个下载中，0 个排队 · 最多 3 个并行");
    }
  });

  it("排队的不分类别，都还没开始：排着的导出照样算进排队", () => {
    expect(subtitleOf(bucketTasks([running("mod"), queued("modpack_export"), queued("world_backup")]))).toBe("1 个下载中，2 个排队 · 最多 3 个并行");
  });

  it("只有本地任务在跑、没有排队：不写「0 个下载中」，按进行中说", () => {
    expect(subtitleOf(bucketTasks([running("modpack_export")]))).toBe("1 个任务进行中 · 最多 3 个并行");
    expect(subtitleOf(bucketTasks([running("world_backup"), running("world_restore")]))).toBe("2 个任务进行中 · 最多 3 个并行");
  });

  it("只有本地任务在跑、后面还排着：照常写下载与排队的数量", () => {
    expect(subtitleOf(bucketTasks([running("modpack_export"), queued("mod")]))).toBe("0 个下载中，1 个排队 · 最多 3 个并行");
  });
});

describe("重试要不要联网", () => {
  it("备份与恢复存档、移到别的游戏目录只碰本机文件；导出要向平台反查 Mod，其余都要下载", () => {
    const local: readonly TaskKind[] = ["world_backup", "world_restore", "instance_move"];
    for (const kind of TASK_KINDS) expect(retryNeedsNetwork(task(kind, { kind })), kind).toBe(!local.includes(kind));
  });
});
