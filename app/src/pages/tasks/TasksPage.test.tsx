// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IpcError } from "../../ipc/errors";
import { CORE_EVENT, type TaskJournalDto, type TaskRecordDto } from "../../ipc/tasks";
import { OverlayRoot } from "../../shell/overlay";
import { ShellProvider, useNav, useShell, type NavApi, type ShellApi } from "../../shell/shell";
import { LauncherProvider, useLauncher, type LauncherApi } from "../../state/launcher";
import type { RouteOf } from "../../state/route";
import { render, stubResizeObserver, type Rendered } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { bootOverrides, callsOf, cancelledError, deferred, emit, resetRecorder, settle, type Deferred } from "../../test/launcher";
import TasksPage from "./index";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));

const T0 = 1_730_000_000_000;
const MB = 1024 * 1024;

let view: Rendered | undefined;
let nav: NavApi;
let shell: ShellApi;
let launcher: LauncherApi;

function Host() {
  nav = useNav();
  shell = useShell();
  launcher = useLauncher();
  return nav.route.page === "tasks" ? <TasksPage route={nav.route} /> : null;
}

const flush = () =>
  act(async () => {
    await settle();
  });

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

async function mount(route: RouteOf<"tasks"> = { page: "tasks" }) {
  view = render(
    <LauncherProvider>
      <ShellProvider>
        <Host />
        <OverlayRoot />
      </ShellProvider>
    </LauncherProvider>,
  );
  await flush();
  act(() => nav.go(route));
  await flush();
}

function page(): HTMLElement {
  if (view === undefined) throw new Error("页面还没有挂载");
  return view.container;
}

/** 任务行（并行通道是 ol，任务列表是 ul）。 */
const rows = () => [...page().querySelectorAll<HTMLLIElement>("ul > li")];

function row(title: string): HTMLLIElement {
  const found = rows().filter((r) => r.textContent?.includes(title));
  if (found.length !== 1) throw new Error(`标题含「${title}」的任务行有 ${found.length} 个`);
  return found[0];
}

function buttonIn(root: ParentNode, text: string): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.textContent === text);
  if (found.length !== 1) throw new Error(`文字为「${text}」的按钮有 ${found.length} 个`);
  return found[0];
}

const hasButton = (root: ParentNode, text: string) => [...root.querySelectorAll("button")].some((b) => b.textContent === text);

/** 最新打开的确认框（上一个可能还在退场动画里）。 */
function dialog(): HTMLElement {
  const all = document.querySelectorAll<HTMLElement>('[role="dialog"]');
  if (all.length === 0) throw new Error("没有打开的确认框");
  return all[all.length - 1];
}

function header(): HTMLElement {
  const el = page().querySelector("header");
  if (el === null) throw new Error("页面没有页头");
  return el;
}

const radio = (label: string) => {
  const el = [...page().querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.getAttribute("aria-label")?.startsWith(`${label}，`));
  if (el === undefined) throw new Error(`筛选里没有「${label}」`);
  return el;
};

const headings = () => [...page().querySelectorAll("section > h2")].map((h) => h.textContent);

/** 吞吐卡的总进度环：有进度时是 progressbar，没有可算的进度时是带说明的图形，名称都以 ringLabel 开头。 */
function totalRing(): HTMLElement {
  const el = page().querySelector<HTMLElement>('[data-size="84"][aria-label^="全部活动任务的总进度"]');
  if (el === null) throw new Error("吞吐卡没有总进度环");
  return el;
}

function record(id: string, status: TaskRecordDto["status"], overrides: Partial<TaskRecordDto> = {}): TaskRecordDto {
  return {
    id,
    kind: "java",
    title: `下载 Java ${id}`,
    detail: "Mojang 运行时 · 手动",
    instance_id: null,
    status,
    progress: 0.4,
    bytes: 4096,
    total_bytes: 10240,
    speed_bps: 0,
    attempt: 1,
    error: null,
    created_at: T0 - 120_000,
    finished_at: status === "queued" || status === "running" ? null : T0 - 60_000,
    spec: { command: "install_java", args: { requiredMajor: 21 } },
    ...overrides,
  };
}

/** 一条完成、一条失败（关联现存实例）、一条取消（关联已不存在的实例）。 */
const HISTORY: TaskRecordDto[] = [
  // 排队 10 秒后开始，跑了 50 秒；最后一批 2 MB，这一次尝试累计下了 50 MB
  record("done-java", "done", {
    progress: 1,
    bytes: 2 * MB,
    total_bytes: 2 * MB,
    done_bytes: 52_400_000,
    created_at: T0 - 300_000,
    started_at: T0 - 290_000,
    finished_at: T0 - 240_000,
  }),
  record("failed-create", "failed", {
    kind: "game",
    title: "安装 1.21.1",
    detail: "新实例「生存」",
    instance_id: "生存",
    finished_at: T0 - 30_000,
    error: { code: "network_failed", message: "dns lookup failed" },
    spec: { command: "install_version", args: { id: "1.21.1", loader: null, loaderVersion: null, targetName: "生存" } },
  }),
  record("cancelled-create", "cancelled", {
    kind: "game",
    title: "安装 1.20.1",
    detail: "新实例「旧世界」",
    instance_id: "旧世界",
    progress: 0.374,
    finished_at: T0 - 90_000,
    spec: { command: "install_version", args: { id: "1.20.1", loader: null, loaderVersion: null, targetName: "旧世界" } },
  }),
];

let javaRuns: Map<string, Deferred<unknown>>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetRecorder(ipc);
  stubResizeObserver();
  bootOverrides(ipc);
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("cancel_task", () => true);
  javaRuns = new Map();
  ipc.overrides.set("install_java", (args) => {
    const d = deferred<unknown>();
    javaRuns.set(String(args.taskId), d);
    return d.promise;
  });
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
});

describe("下载任务页：空队列", () => {
  it("从未有过任务：只放一张空状态卡，清除已结束禁用且不带数字", async () => {
    await mount();
    expect(page().textContent).toContain("下载队列是空的");
    expect(page().textContent).toContain("新建实例、导入整合包、安装 Mod 时，任务会排在这里，最多 3 个同时进行。");
    expect(page().textContent).toContain("队列空闲 · 新建实例、装 Mod、导入整合包都会排到这里");
    expect(buttonIn(page(), "清除已结束").disabled).toBe(true);
    expect(hasButton(page(), "全部取消")).toBe(false);
    // 总览卡与筛选都不出现
    expect(page().textContent).not.toContain("并行通道");
    expect(page().querySelectorAll('[role="radio"]')).toHaveLength(0);
  });

  it("空状态的两个出口：去发现压栈跳转，新建实例打开新建流程", async () => {
    await mount();
    act(() => buttonIn(page(), "新建实例").click());
    expect(shell.createInstance).toEqual({ open: true, preset: null });
    act(() => buttonIn(page(), "去发现").click());
    expect(nav.route).toEqual({ page: "discover" });
    expect(nav.canBack).toBe(true);
  });
});

describe("下载任务页：历史", () => {
  it("已结束组按结束时刻从新到旧，每行写清结局与原因", async () => {
    bootOverrides(ipc, { journal: HISTORY });
    await mount();
    expect(headings()).toEqual(["已结束 · 3"]);
    expect(rows().map((r) => r.querySelector('[role="img"]')?.getAttribute("aria-label"))).toEqual(["游戏，失败", "游戏，已取消", "Java，已完成"]);

    const failed = row("安装 1.21.1");
    expect(failed.textContent).toContain("失败：网络连接失败");
    expect(failed.textContent).toContain("30 秒前");
    expect(hasButton(failed, "重试")).toBe(true);
    // 关联的实例还在：可以查看
    expect(hasButton(failed, "查看实例")).toBe(true);

    const cancelled = row("安装 1.20.1");
    expect(cancelled.textContent).toContain("取消于 37%");
    expect(hasButton(cancelled, "重试")).toBe(false);
    // 新建被取消，实例已经不在了
    expect(hasButton(cancelled, "查看实例")).toBe(false);

    // 没有活动任务：总进度环是 84 档的空环，圆心写「--」，不报一个没有意义的百分数；
    // 读屏不把它当成不定进度，念名称加一句「没有进行中的下载」
    expect(totalRing().dataset.size).toBe("84");
    expect(totalRing().dataset.tone).toBe("muted");
    expect(totalRing().getAttribute("role")).toBe("img");
    expect(totalRing().getAttribute("aria-label")).toBe("全部活动任务的总进度：没有进行中的下载");
    expect(totalRing().hasAttribute("aria-valuetext")).toBe(false);
    expect(totalRing().hasAttribute("aria-valuenow")).toBe(false);
    expect(totalRing().textContent).toBe("--");

    const done = row("下载 Java done-java");
    expect(done.textContent).toContain("50.0 MB · 用时 50 秒");
    expect(done.textContent).toContain("4 分钟前");
    expect(hasButton(done, "查看实例")).toBe(false);

    act(() => buttonIn(failed, "查看实例").click());
    expect(nav.route).toEqual({ page: "instance", id: "生存", tab: "overview" });
  });

  it("清除已结束：不确认，记录全部清掉回到空状态，并写回任务日志", async () => {
    bootOverrides(ipc, { journal: HISTORY });
    await mount();
    act(() => buttonIn(page(), "清除已结束（3）").click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(rows()).toHaveLength(0);
    expect(page().textContent).toContain("下载队列是空的");
    await advance(1000);
    expect(callsOf(ipc, "save_task_journal").at(-1)).toEqual({ seq: 1, tasks: [] });
  });

  it("重试：同一任务换下一次尝试的 taskId 重新开始，行内写第几次尝试", async () => {
    bootOverrides(ipc, {
      journal: [record("failed-java", "failed", { error: { code: "hash_mismatch", message: "sha1" }, spec: { command: "install_java", args: { requiredMajor: 17 } } })],
    });
    await mount();
    expect(row("failed-java").textContent).toContain("失败：下载到的文件和官方记录不一致");
    act(() => buttonIn(row("failed-java"), "重试").click());
    await flush();
    expect(callsOf(ipc, "install_java")).toEqual([{ requiredMajor: 17, taskId: "failed-java#2" }]);
    expect(headings()).toEqual(["进行中 · 1"]);
    expect(row("failed-java").textContent).toContain("第 2 次尝试");
    expect(row("failed-java").textContent).toContain("等待数据");
  });
});

describe("下载任务页：断网", () => {
  it("断网：页头下出现离线横幅，失败任务的重试置灰且点了不发命令；恢复联网后横幅消失、重试可用", async () => {
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    bootOverrides(ipc, {
      journal: [record("failed-java", "failed", { error: { code: "network_failed", message: "dns" }, spec: { command: "install_java", args: { requiredMajor: 17 } } })],
    });
    await mount();
    const banner = () => [...page().querySelectorAll<HTMLElement>("[data-tone]")].find((el) => el.textContent?.startsWith("没有网络连接"));
    expect(banner()?.textContent).toBe("没有网络连接进行中的下载会继续重试，重试用完仍连不上时记为失败；联网后可以再重试。");
    // 横幅紧跟页头，在任务列表之前
    expect(header().nextElementSibling).toBe(banner());
    const retry = buttonIn(row("failed-java"), "重试");
    expect(retry.getAttribute("aria-disabled")).toBe("true");
    act(() => retry.click());
    await flush();
    expect(callsOf(ipc, "install_java")).toEqual([]);
    expect(launcher.state.tasks[0].status).toBe("failed");

    onLine.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(banner()).toBeUndefined();
    expect(buttonIn(row("failed-java"), "重试").getAttribute("aria-disabled")).toBeNull();
    act(() => buttonIn(row("failed-java"), "重试").click());
    await flush();
    expect(callsOf(ipc, "install_java")).toEqual([{ requiredMajor: 17, taskId: "failed-java#2" }]);
  });
});

describe("下载任务页：筛选", () => {
  it("筛选来自路由；切换筛选替换当前历史项，全部写回不带参数的路由", async () => {
    bootOverrides(ipc, { journal: HISTORY });
    await mount({ page: "tasks", filter: "failed" });
    expect(radio("失败与取消").getAttribute("aria-checked")).toBe("true");
    expect(radio("失败与取消").getAttribute("aria-label")).toBe("失败与取消，2 个");
    // 非「全部」筛选不分组
    expect(headings()).toEqual([]);
    expect(rows().map((r) => r.querySelector('[role="img"]')?.getAttribute("aria-label"))).toEqual(["游戏，失败", "游戏，已取消"]);

    act(() => radio("已完成").click());
    expect(nav.route).toEqual({ page: "tasks", filter: "done" });
    expect(rows()).toHaveLength(1);

    act(() => radio("进行中").click());
    expect(rows()).toHaveLength(0);
    expect(page().textContent).toContain("没有进行中的任务");

    act(() => radio("全部").click());
    expect(nav.route).toEqual({ page: "tasks" });
    expect(headings()).toEqual(["已结束 · 3"]);

    // 筛选切换没有压栈：后退直接回到进页之前
    act(() => nav.back());
    expect(nav.route).toEqual({ page: "home" });
  });

  it("已完成筛选为空时补一句说明", async () => {
    bootOverrides(ipc, { journal: [HISTORY[1]] });
    await mount({ page: "tasks", filter: "done" });
    expect(page().textContent).toContain("还没有完成的任务");
    expect(page().textContent).toContain("或者已经被清除了。");
  });
});

describe("下载任务页：进行中", () => {
  async function fourJavaTasks(): Promise<string[]> {
    await mount();
    for (const major of [8, 17, 21, 25]) await act(() => launcher.actions.installJava(major));
    await flush();
    return launcher.state.tasks.map((t) => t.id);
  }

  it("三条通道各放一个运行中的任务，第四个排队；副标题与排队说明给出数量", async () => {
    const ids = await fourJavaTasks();
    expect(page().textContent).toContain("3 个下载中，1 个排队 · 最多 3 个并行");
    expect(page().textContent).toContain("还有 1 个在排队，空出通道后按加入顺序开始");
    const lanes = [...page().querySelectorAll("ol > li")];
    expect(lanes.map((l) => l.textContent)).toEqual(["1下载 Java 80%", "2下载 Java 170%", "3下载 Java 210%"]);
    expect(row("Java 25").textContent).toContain("排队中 · 第 1 位");
    expect(row("Java 25").textContent).toContain("大小待定");
    expect(headings()).toEqual(["进行中 · 4"]);
    expect(radio("进行中").getAttribute("aria-label")).toBe("进行中，4 个");
    // 有活动任务、但还没有一个报了总量：说明换成「大小还不知道」，不说成没有下载
    expect(totalRing().getAttribute("role")).toBe("img");
    expect(totalRing().getAttribute("aria-label")).toBe("全部活动任务的总进度：任务大小还不知道，暂无总进度");

    act(() => emit(CORE_EVENT, { kind: "download", task_id: `${ids[0]}#1`, total: 10, finished: 2, bytes: 120 * MB, total_bytes: 612 * MB, speed: 12 * MB }));
    // 剩余时间按最近 5 秒的平均速度：等窗口里全是这个速度
    await advance(5000);
    expect(lanes[0].textContent).toBe("1下载 Java 820%");
    expect(row("Java 8").textContent).toContain("120 MB / 612 MB");
    expect(row("Java 8").textContent).toContain("12.0 MB/s · 约 45 秒");
    expect(row("Java 8").textContent).toContain("20%");
    expect(page().textContent).toContain("当前总速度");
    expect(page().textContent).toContain("剩余 492 MB · 约 45 秒");
    // 只有这一个任务报了总量：总进度就是它的 120 / 612
    expect(totalRing().dataset.tone).toBe("accent");
    expect(totalRing().getAttribute("role")).toBe("progressbar");
    expect(totalRing().getAttribute("aria-label")).toBe("全部活动任务的总进度");
    expect(totalRing().getAttribute("aria-valuenow")).toBe("20");
    expect(totalRing().hasAttribute("aria-valuetext")).toBe(false);
    expect(page().textContent).not.toContain("最近 48 秒没有下载流量");
  });

  it("完成行：总量是几批下载的累计，用时从开始运行算起，排队等待不算", async () => {
    const ids = await fourJavaTasks();
    // 第四个任务排队 30 秒后才轮到
    await advance(30_000);
    javaRuns.get(`${ids[0]}#1`)?.resolve({ component: "java-runtime-delta", version: { major: 8, minor: 0, security: 1, build: 1, raw: "1.8.0_1" }, java_executable: "C:/java8.exe" });
    await flush();
    expect(launcher.state.tasks.find((t) => t.id === ids[3])?.status).toBe("running");

    const id = `${ids[3]}#1`;
    act(() => emit(CORE_EVENT, { kind: "download", task_id: id, total: 4, finished: 2, bytes: 60 * MB, total_bytes: 100 * MB, speed: 10 * MB }));
    act(() => emit(CORE_EVENT, { kind: "download", task_id: id, total: 4, finished: 4, bytes: 100 * MB, total_bytes: 100 * MB, speed: 10 * MB }));
    // 第二批从 0 重新计起
    act(() => emit(CORE_EVENT, { kind: "download", task_id: id, total: 3, finished: 3, bytes: 20 * MB, total_bytes: 20 * MB, speed: 10 * MB }));
    await advance(12_000);
    javaRuns.get(id)?.resolve({ component: "java-runtime-delta", version: { major: 25, minor: 0, security: 1, build: 1, raw: "25.0.1" }, java_executable: "C:/java25.exe" });
    await flush();

    const finished = row("Java 25");
    expect(finished.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("Java，已完成");
    expect(finished.textContent).toContain("120 MB · 用时 12 秒");
  });

  it("取消排队中的任务不确认、不发命令；全部取消要确认，继续下载则什么都不做", async () => {
    const ids = await fourJavaTasks();
    act(() => row("Java 25").querySelector<HTMLButtonElement>('button[aria-label="取消任务"]')?.click());
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(callsOf(ipc, "cancel_task")).toEqual([]);
    expect(row("Java 25").textContent).toContain("取消于 0%");
    expect(headings()).toEqual(["进行中 · 3", "已结束 · 1"]);
    expect(launcher.state.toasts.map((t) => t.title)).toContain("已取消：下载 Java 25");

    act(() => buttonIn(header(), "全部取消").click());
    await flush();
    expect(dialog().querySelector("h2")?.textContent).toBe("取消全部 3 个任务？");
    expect(dialog().textContent).toContain("已下载的部分会被丢弃。");
    act(() => buttonIn(dialog(), "继续下载").click());
    await flush();
    expect(callsOf(ipc, "cancel_task")).toEqual([]);

    act(() => buttonIn(header(), "全部取消").click());
    await flush();
    act(() => buttonIn(dialog(), "全部取消").click());
    await flush();
    expect(callsOf(ipc, "cancel_task")).toEqual(ids.slice(0, 3).map((id) => ({ taskId: `${id}#1` })));
    // 运行中的任务以 cancelled 返回后才落态
    for (const id of ids.slice(0, 3)) javaRuns.get(`${id}#1`)?.reject(cancelledError());
    await flush();
    expect(headings()).toEqual(["已结束 · 4"]);
    expect(page().textContent).toContain("全部下载已完成");
  });

  it("运行中的新建实例取消前确认：继续下载保留任务，确认后以这一次尝试的 taskId 取消", async () => {
    const install = deferred<unknown>();
    ipc.overrides.set("install_version", () => install.promise);
    await mount();
    await act(() => launcher.actions.createInstance({ name: "新的世界", mcVersion: "1.21.1", loader: "vanilla", loaderVersion: null, cover: "grass" }));
    await flush();
    const id = launcher.state.tasks[0].id;
    const cancelButton = () => {
      const el = row("安装 1.21.1").querySelector<HTMLButtonElement>('button[aria-label="取消任务"]');
      if (el === null) throw new Error("任务行没有取消按钮");
      return el;
    };

    act(() => cancelButton().click());
    await flush();
    expect(dialog().querySelector("h2")?.textContent).toBe("取消「安装 1.21.1」？");
    expect(dialog().textContent).toContain("「新的世界」还没装好，取消后这个实例会被删除。");
    act(() => buttonIn(dialog(), "继续下载").click());
    await flush();
    expect(callsOf(ipc, "cancel_task")).toEqual([]);
    expect(launcher.state.tasks[0].status).toBe("running");

    act(() => cancelButton().click());
    await flush();
    act(() => buttonIn(dialog(), "取消任务").click());
    await flush();
    expect(callsOf(ipc, "cancel_task")).toEqual([{ taskId: `${id}#1` }]);

    install.reject(cancelledError());
    await flush();
    expect(row("安装 1.21.1").textContent).toContain("取消于 0%");
    // 占位实例随取消撤掉，不给「查看实例」
    expect(hasButton(row("安装 1.21.1"), "查看实例")).toBe(false);
  });
});

describe("下载任务页：任务记录读取", () => {
  it("读不出来时给错误与重试，不说队列是空的；重试成功后回到正常呈现", async () => {
    let fail = true;
    ipc.overrides.set("load_task_journal", () => {
      if (fail) throw new IpcError("task_journal_invalid", "任务日志第 0 项缺少字符串 id");
      return { seq: 0, tasks: [] };
    });
    await mount();
    expect(page().textContent).toContain("下载任务记录读不出来");
    expect(page().textContent).toContain("任务日志第 0 项缺少字符串 id");
    expect(page().textContent).not.toContain("下载队列是空的");

    fail = false;
    act(() => buttonIn(page(), "重试").click());
    await flush();
    expect(callsOf(ipc, "load_task_journal")).toHaveLength(2);
    expect(page().textContent).not.toContain("下载任务记录读不出来");
    expect(page().textContent).toContain("下载队列是空的");
  });

  it("300 ms 内读完不出骨架；超过才出，出了至少停留 300 ms", async () => {
    const journal = deferred<TaskJournalDto>();
    ipc.overrides.set("load_task_journal", () => journal.promise);
    await mount();
    const busy = () => page().querySelector('[aria-busy="true"]') !== null;
    await advance(299);
    expect(busy()).toBe(false);
    await advance(1);
    expect(busy()).toBe(true);
    await advance(100);
    journal.resolve({ seq: 0, tasks: [] });
    await flush();
    // 数据已到，但骨架才出现 100 ms
    expect(busy()).toBe(true);
    expect(page().textContent).not.toContain("下载队列是空的");
    await advance(200);
    expect(busy()).toBe(false);
    expect(page().textContent).toContain("下载队列是空的");
  });

  it("读了 10 s 还没读完：骨架下方补一行「比平时慢」，读完随骨架一起收起", async () => {
    const journal = deferred<TaskJournalDto>();
    ipc.overrides.set("load_task_journal", () => journal.promise);
    await mount();
    await advance(300);
    expect(page().querySelector('[aria-busy="true"]')).not.toBeNull();
    await advance(9_699);
    expect(page().textContent).not.toContain("比平时慢一些，仍在加载…");
    await advance(1);
    expect(page().textContent).toContain("比平时慢一些，仍在加载…");
    journal.resolve({ seq: 0, tasks: [] });
    await flush();
    expect(page().textContent).not.toContain("比平时慢一些，仍在加载…");
    expect(page().textContent).toContain("下载队列是空的");
  });
});
