import { describe, expect, it } from "vitest";
import { TASK_KINDS, type Task, type TaskKind } from "../../domain/types";
import { APP_NAME } from "../../lib/app-info";
import { newTask } from "../../state/tasks";
import { CHART_MIN_CEILING_BPS, ETA_WINDOW_SAMPLES, THROUGHPUT_SAMPLES } from "./constants";
import {
  bucketTasks,
  cancelAllConfirm,
  cancelConfirm,
  chartGeometry,
  durationText,
  etaSpeed,
  etaText,
  filterCounts,
  filterOf,
  filterRoute,
  laneSlots,
  overviewOf,
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

const ctx = (over: Partial<Parameters<typeof rowMeta>[1]> = {}) => ({ queuePosition: null, etaSpeed: 0, now: T0 + 10 * 60_000, ...over });

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

  it("三条通道依次放运行中的任务，空出的为 null；超过上限是调度的错", () => {
    expect(laneSlots([running1]).map((t) => (t === null ? null : t.id))).toEqual(["r1", null, null]);
    expect(laneSlots([]).every((t) => t === null)).toBe(true);
    expect(() => laneSlots([running1, running2, task("r3", { status: "running" }), task("r4", { status: "running" })])).toThrow("超过了上限 3");
  });
});

describe("行内元信息", () => {
  it("运行中：已下 / 总量，速度 · 剩余时间（按平均速度估算）", () => {
    const t = task("r", { status: "running", bytes: 120 * MB, totalBytes: 612 * MB, speedBps: 12 * MB, progress: 0.2 });
    // 剩余 492 MB，平均 4 MB/s → 123 秒 → 约 3 分钟；显示的速度仍是瞬时值
    expect(rowMeta(t, ctx({ etaSpeed: 4 * MB }))).toEqual({ left: "120 MB / 612 MB", right: "12.0 MB/s · 约 3 分钟", danger: false });
    // 平均速度还没有（0）时用瞬时速度：492 / 12 = 41 秒 → 约 45 秒
    expect(rowMeta(t, ctx({ etaSpeed: 0 })).right).toBe("12.0 MB/s · 约 45 秒");
  });

  it("运行中：速度为 0 写等待数据；总量未知时写大小待定，只报速度", () => {
    expect(rowMeta(task("r", { status: "running", bytes: 0, totalBytes: 612 * MB, speedBps: 0 }), ctx()).right).toBe("等待数据");
    expect(rowMeta(task("r", { status: "running", bytes: 0, totalBytes: null, speedBps: 0 }), ctx())).toMatchObject({ left: "大小待定", right: "等待数据" });
    expect(rowMeta(task("r", { status: "running", bytes: 3 * MB, totalBytes: null, speedBps: MB }), ctx())).toMatchObject({ left: "3.0 MB / 大小待定", right: "1.0 MB/s" });
  });

  it("排队中：位次与总量；没有位次是调用方的错", () => {
    expect(rowMeta(task("q"), ctx({ queuePosition: 2 }))).toEqual({ left: "排队中 · 第 2 位", right: "大小待定", danger: false });
    expect(rowMeta(task("q", { totalBytes: 2048 }), ctx({ queuePosition: 1 })).right).toBe("2.0 KB");
    expect(() => rowMeta(task("q"), ctx())).toThrow("没有队列位次");
  });

  it("已完成：总量是这一次尝试跨批次累计的字节，用时从开始运行算起、不含排队等待；右侧相对时间", () => {
    // 加入队列 90 秒后才开始跑，跑了 20 秒；最后一批只有 2 MB，累计下了 50 MB
    const done = task("d", { status: "done", createdAt: T0, startedAt: T0 + 90_000, finishedAt: T0 + 110_000, bytes: 2 * MB, totalBytes: 2 * MB, doneBytes: 52_400_000 });
    expect(rowMeta(done, ctx({ now: T0 + 5 * 60_000 + 110_000 }))).toEqual({ left: "50.0 MB · 用时 20 秒", right: "5 分钟前", danger: false });
    expect(rowMeta({ ...done, finishedAt: T0 + 90_000 + 125_000 }, ctx({ now: T0 + 215_000 })).left).toBe("50.0 MB · 用时 2 分钟");
    // 边界：刚开始就结束也写满 1 秒
    expect(rowMeta({ ...done, finishedAt: T0 + 90_000 }, ctx()).left).toBe("50.0 MB · 用时 1 秒");
  });

  it("已完成：一个字节都没下（文件都已就绪）不写总量；较早的任务记录没有开始时刻，不写用时", () => {
    const done = task("d", { status: "done", createdAt: T0, startedAt: T0 + 1_000, finishedAt: T0 + 4_000, doneBytes: 0 });
    expect(rowMeta(done, ctx()).left).toBe("用时 3 秒");
    expect(rowMeta({ ...done, startedAt: null, doneBytes: 4096 }, ctx()).left).toBe("4.0 KB");
    expect(rowMeta({ ...done, startedAt: null, doneBytes: 0 }, ctx()).left).toBe("已完成");
    // 重试过的任务照样写第几次尝试，用时只算最后这一次
    expect(rowMeta({ ...done, attempt: 3 }, ctx()).left).toBe("用时 3 秒 · 第 3 次尝试");
  });

  it("已完成：运行期间系统时钟往回调过（结束时刻早于开始时刻）算不出用时，不写用时，也不让整行抛错", () => {
    const done = task("d", { status: "done", createdAt: T0, startedAt: T0 + 5_000, finishedAt: T0 + 2_000, doneBytes: 3 * MB });
    expect(rowMeta(done, ctx()).left).toBe("3.0 MB");
    expect(rowMeta({ ...done, doneBytes: 0 }, ctx()).left).toBe("已完成");
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

  it("采样记下每个运行中任务（按这一次尝试）的速度与总和，只留最近 48 个", () => {
    const s = takeSample([task("a", { status: "running", speedBps: 300 }), task("b", { status: "running", speedBps: 700, attempt: 2 })]);
    expect(s).toEqual({ total: 1000, tasks: { "a#1": 300, "b#2": 700 } });
    let history: ThroughputSample[] = [];
    for (let i = 0; i < THROUGHPUT_SAMPLES + 5; i++) history = pushSample(history, sample(i));
    expect(history).toHaveLength(THROUGHPUT_SAMPLES);
    expect([history[0].total, history[THROUGHPUT_SAMPLES - 1].total]).toEqual([5, THROUGHPUT_SAMPLES + 4]);
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
    expect(o).toEqual({ label: "running", speed: 100, downloaded: 1300, total: 2000, fraction: 0.65 });
    expect(overviewRemaining(o, 0)).toBe("剩余 700 B · 约 10 秒");
    expect(overviewRemaining(o, 10)).toBe("剩余 700 B · 约 2 分钟");
    expect(overviewRemaining({ ...o, speed: 0 }, 0)).toBe("剩余 700 B · 等待数据");
    // 只有总量未知的排队任务、或没有任何活动任务：没有可显示的进度，而不是 0%
    expect(overviewOf(bucketTasks([task("q1")]))).toEqual({ label: "waiting", speed: 0, downloaded: 0, total: 0, fraction: null });
    expect(overviewOf(bucketTasks([task("d1", { status: "done", finishedAt: T0 })]))).toEqual({ label: "idle", speed: 0, downloaded: 0, total: 0, fraction: null });
    // 边界：总量已知但一个字节都还没下，是真实的 0
    expect(overviewOf(bucketTasks([task("r0", { status: "running", bytes: 0, totalBytes: 1 })])).fraction).toBe(0);
  });

  it("曲线：不足 48 个采样左侧补 0；纵轴上限至少 4 MB/s，超过时按样本最大值", () => {
    const empty = chartGeometry([]);
    expect(empty.idle).toBe(true);
    expect(empty.line.split(" ")).toHaveLength(THROUGHPUT_SAMPLES);
    expect(empty.line.startsWith("M0.00,30.00")).toBe(true);

    // 2 MB/s 在 4 MB/s 的上限下画到一半高度：30 - 25 × 0.5
    const low = chartGeometry([CHART_MIN_CEILING_BPS / 2]);
    expect(low.idle).toBe(false);
    expect(low.line.endsWith("L100.00,17.50")).toBe(true);
    expect(low.area.endsWith("L100,30 L0,30 Z")).toBe(true);

    // 上限随样本最大值抬高：最大的那个画到顶（距顶 5）
    const high = chartGeometry([8 * MB, 4 * MB]);
    const points = high.line.split(" ");
    expect(points[THROUGHPUT_SAMPLES - 2]).toBe(`L${((46 / 47) * 100).toFixed(2)},5.00`);
    expect(points[THROUGHPUT_SAMPLES - 1]).toBe("L100.00,17.50");
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
});

describe("任务表的结构比较", () => {
  const running = task("a", { status: "running", progress: 0.1, bytes: 1 * MB, totalBytes: 10 * MB, doneBytes: 1 * MB, speedBps: MB, startedAt: T0 });
  const queued = task("b");

  it("只换了下载进度的五个字段：结构相同", () => {
    const next = { ...running, progress: 0.9, bytes: 9 * MB, totalBytes: 12 * MB, doneBytes: 9 * MB, speedBps: 0 };
    expect(sameTaskLayout([running, queued], [next, queued])).toBe(true);
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
    const local: readonly TaskKind[] = ["world_backup", "world_restore", "modpack_export"];
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
  it("备份与恢复存档只碰本机文件；导出要向平台反查 Mod，其余都要下载", () => {
    const local: readonly TaskKind[] = ["world_backup", "world_restore"];
    for (const kind of TASK_KINDS) expect(retryNeedsNetwork(task(kind, { kind })), kind).toBe(!local.includes(kind));
  });
});
