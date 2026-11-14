// @vitest-environment jsdom
// @module-tag heavy-page
import { MotionConfig } from "framer-motion";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IpcError } from "../../ipc/errors";
import { COMPLETION_HOLD_S, SPEED_REFRESH_MS } from "../../lib/progress-display";
import { MOCK_DOWNLOADS_DIR, reset as resetModpackMock, seedMockDownloads } from "../../ipc/mock/handlers/modpack";
import { CORE_EVENT, type TaskJournalDto, type TaskRecordDto } from "../../ipc/tasks";
import { OverlayRoot } from "../../shell/overlay";
import { ShellProvider, useNav, useShell, type NavApi, type ShellApi } from "../../shell/shell";
import { LauncherProvider, useLauncher, type LauncherApi } from "../../state/launcher";
import type { RouteOf } from "../../state/route";
import { render, stubResizeObserver, type Rendered } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import type { InstanceDto } from "../../ipc/instances";
import { bootOverrides, callsOf, cancelledError, deferred, emit, instanceDto, resetRecorder, settle, type Deferred } from "../../test/launcher";
import { PickFolderProvider } from "../discover/platform";
import TasksPage from "./index";
import styles from "./tasks.module.css";
import { TASK_ROW_ATTR } from "./TaskRow";

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

/** reduced：整页按「减少动画」画（与外观偏好经根部 MotionConfig 生效的口径相同）。 */
async function mount(route: RouteOf<"tasks"> = { page: "tasks" }, { reduced = false }: { reduced?: boolean } = {}) {
  const tree = (
    <PickFolderProvider value={() => Promise.resolve(MOCK_DOWNLOADS_DIR)}>
      <Host />
      <OverlayRoot />
    </PickFolderProvider>
  );
  view = render(
    <LauncherProvider>
      <ShellProvider>{reduced ? <MotionConfig reducedMotion="always">{tree}</MotionConfig> : tree}</ShellProvider>
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

/**
 * 在场的节点。正在退场的（换组的行、被清掉的整组、收起的横幅、通道里换下的那份内容）还在原处淡出，
 * 自己或某个祖先带着 inert，不算在场。
 */
const live = (el: Element) => el.closest("[inert]") === null;

/** 元素在场部分的文字：去掉正在退场的节点。 */
function liveText(el: Element): string {
  const copy = el.cloneNode(true);
  if (!(copy instanceof Element)) throw new Error("复制出的不是元素");
  for (const gone of copy.querySelectorAll("[inert]")) gone.remove();
  const text = copy.textContent;
  if (text === null) throw new Error("元素没有文字内容");
  return text;
}

/** 任务行（并行通道是 ol，任务列表是 ul）。 */
const rows = () => [...page().querySelectorAll<HTMLLIElement>("ul > li")].filter(live);

function row(title: string): HTMLLIElement {
  const found = rows().filter((r) => r.textContent?.includes(title));
  if (found.length !== 1) throw new Error(`标题含「${title}」的任务行有 ${found.length} 个`);
  return found[0];
}

/** 按钮上显示的文案：文案放在定宽槽（LabelSlot）里的，候选都在 DOM 里，只取当前那条。 */
function labelOf(button: HTMLButtonElement): string | null {
  const current = button.querySelector("[data-current]");
  return current === null ? button.textContent : current.textContent;
}

function buttonIn(root: ParentNode, text: string): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>("button")].filter(live).filter((b) => labelOf(b) === text);
  if (found.length !== 1) throw new Error(`文字为「${text}」的按钮有 ${found.length} 个`);
  return found[0];
}

const hasButton = (root: ParentNode, text: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].filter(live).some((b) => labelOf(b) === text);

/** 进度条（行内或通道里）报给读屏的百分数：百分数文字随平滑逐帧走，测试读它的目标值。 */
function progressOf(root: Element): string | null {
  const bar = root.querySelector('[role="progressbar"]');
  if (bar === null) throw new Error("这里没有进度条");
  return bar.getAttribute("aria-valuenow");
}

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

const headings = () => [...page().querySelectorAll("section h2")].filter(live).map((h) => h.textContent);

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
  // 排队 10 秒后开始，跑了 50 秒；最后一批 2 MB，这一次尝试累计传了 50 MB
  record("done-java", "done", {
    progress: 1,
    bytes: 2 * MB,
    total_bytes: 2 * MB,
    done_bytes: 52_400_000,
    transferred_bytes: 52_400_000,
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

  it("补全成功、落地重扫还没回来：这一行在已结束里，清除按钮却不算它、不可点（点了也清不掉）；重扫回来才计上", async () => {
    await mount();
    const repair = deferred<unknown>();
    ipc.overrides.set("repair_instance", () => repair.promise);
    await act(() => launcher.actions.repairInstance("生存"));
    await flush();
    const scan = deferred<InstanceDto[]>();
    ipc.overrides.set("list_instances", () => scan.promise);
    repair.resolve({ reinstalled: false, libraries: 3, assets: 0, natives: 0 });
    await flush();
    // 收尾那一拍过去，行换到已结束
    await advance(1000);
    expect(launcher.state.tasks.map((t) => t.status)).toEqual(["done"]);
    expect(headings()).toEqual(["已结束 · 1"]);
    expect(buttonIn(header(), "清除已结束").disabled).toBe(true);

    scan.resolve([instanceDto("生存"), instanceDto("创造")]);
    await flush();
    expect(buttonIn(header(), "清除已结束（1）").disabled).toBe(false);
  });

  it("清除按钮与筛选的计数按三位数定宽：首个任务结束、计数跨位数时按钮与分段都不变宽", async () => {
    bootOverrides(ipc, { journal: HISTORY });
    await mount();
    // 文案在定宽槽里：不带计数、当前计数、按历史上限（三位数）计的那条叠在同一格，宽度取最宽的
    const slot = buttonIn(header(), "清除已结束（3）").querySelector("[data-current]")?.parentElement;
    if (slot === null || slot === undefined) throw new Error("清除按钮的文案不在定宽槽里");
    expect([...slot.children].map((el) => el.textContent)).toEqual(["清除已结束", "清除已结束（3）", "清除已结束（100）"]);
    const filter = page().querySelector<HTMLElement>('[role="radiogroup"]');
    if (filter === null) throw new Error("页面没有状态筛选");
    expect(filter.style.getPropertyValue("--segment-count-digits")).toBe("3");
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

  it("上次关闭时中断的移动：行上写已在打开时收尾，不给重试；同样中断的下载照常给重试", async () => {
    bootOverrides(ipc, {
      journal: [
        record("move", "running", {
          kind: "instance_move",
          title: "移动「生存」",
          detail: "移到 HMCL · D:\\HMCL\\.minecraft",
          instance_id: "生存",
          spec: { command: "move_instance", args: { id: "生存", target: "D:\\HMCL\\.minecraft" } },
        }),
        record("java", "running"),
      ],
    });
    await mount();
    expect(row("移动「生存」").textContent).toContain("重新打开时已自动收尾：实例要么已在目标游戏目录，要么留在原处");
    expect([...row("移动「生存」").querySelectorAll("button")].map((b) => b.textContent)).not.toContain("重试");
    expect([...row("下载 Java java").querySelectorAll("button")].map((b) => b.textContent)).toContain("重试");
  });

  it("因需要手动下载的文件失败：行上是「查看这些文件」而不是重试，清单列出文件，都找到后重新安装这个任务", async () => {
    resetModpackMock();
    const file = (name: string, id: number) => ({
      project_id: 9,
      file_id: id,
      file_name: name,
      web_url: `https://www.curseforge.com/minecraft/mc-mods/locked/files/${id}`,
      destination: `mods/${name}`,
      sha1: "a".repeat(40),
      fingerprint: 0,
      size: 3,
    });
    const args = { id: "生存", platform: "curseforge", projectId: "9", versionId: "90" };
    bootOverrides(ipc, {
      journal: [
        record("failed-mod", "failed", {
          kind: "mod",
          title: "安装 Locked",
          instance_id: "生存",
          error: { code: "distribution_blocked", message: "原文", blocked_files: [file("locked.jar", 90), file("dep.jar", 91)] },
          spec: { command: "install_mod", args },
        }),
      ],
    });
    ipc.overrides.set("install_mod", () => new Promise(() => undefined));
    await mount();
    const failed = row("安装 Locked");
    expect(failed.textContent).toContain("失败：有 2 个文件需要到 CurseForge 网页手动下载");
    expect(hasButton(failed, "重试")).toBe(false);

    act(() => buttonIn(failed, "查看这些文件").click());
    await flush();
    expect(dialog().textContent).toContain("需要手动下载的文件");
    expect(dialog().textContent).toContain("locked.jar");
    expect(dialog().textContent).toContain("dep.jar");
    expect(hasButton(dialog(), "重新安装")).toBe(false);

    seedMockDownloads(["locked.jar", "dep.jar"]);
    act(() => buttonIn(dialog(), "我已下载，重新检查").click());
    await flush();
    expect(dialog().textContent).toContain("2 个文件都已找到。");
    act(() => buttonIn(dialog(), "重新安装").click());
    await flush();
    expect(callsOf(ipc, "install_mod")).toEqual([{ ...args, taskId: "failed-mod#2" }]);
    expect(row("安装 Locked").textContent).toContain("第 2 次尝试");
    expect(hasButton(row("安装 Locked"), "查看这些文件")).toBe(false);
  });
});

describe("下载任务页：断网", () => {
  it("断网：页头下出现离线横幅，失败任务的重试置灰且点了不发命令；恢复联网后横幅消失、重试可用", async () => {
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    bootOverrides(ipc, {
      journal: [record("failed-java", "failed", { error: { code: "network_failed", message: "dns" }, spec: { command: "install_java", args: { requiredMajor: 17 } } })],
    });
    await mount();
    const banner = () => [...page().querySelectorAll<HTMLElement>("[data-tone]")].filter(live).find((el) => el.textContent?.startsWith("没有网络连接"));
    expect(banner()?.textContent).toBe("没有网络连接进行中的下载会继续重试，重试用完仍连不上时记为失败；联网后可以再重试。");
    // 横幅在页头下的常驻槽位里，在任务列表之前：断网、联网时它进出，下面的内容让位
    expect(header().nextElementSibling?.firstElementChild).toBe(banner());
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

  it("断网：备份与恢复存档只碰本机文件，失败后的重试不置灰，点了照常重排", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const args = { id: "生存", world: "旧世界" };
    bootOverrides(ipc, {
      journal: [
        record("failed-backup", "failed", {
          kind: "world_backup",
          title: "备份「旧世界」",
          detail: "「生存」",
          instance_id: "生存",
          error: { code: "io", message: "磁盘已满" },
          spec: { command: "backup_world", args },
        }),
      ],
    });
    ipc.overrides.set("backup_world", () => new Promise(() => undefined));
    await mount();
    const retry = buttonIn(row("备份「旧世界」"), "重试");
    expect(retry.getAttribute("aria-disabled")).toBeNull();
    act(() => retry.click());
    await flush();
    expect(callsOf(ipc, "backup_world")).toEqual([{ ...args, taskId: "failed-backup#2" }]);
  });

  it("断网：要手动下载的文件都找到后「重新安装」只提示联网后再重试，不把任务重新排进队列", async () => {
    resetModpackMock();
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    const args = { id: "生存", platform: "curseforge", projectId: "9", versionId: "90" };
    bootOverrides(ipc, {
      journal: [
        record("failed-mod", "failed", {
          kind: "mod",
          title: "安装 Locked",
          instance_id: "生存",
          error: {
            code: "distribution_blocked",
            message: "原文",
            blocked_files: [
              { project_id: 9, file_id: 90, file_name: "locked.jar", web_url: "https://www.curseforge.com/minecraft/mc-mods/locked/files/90", destination: "mods/locked.jar", sha1: "a".repeat(40), fingerprint: 0, size: 3 },
            ],
          },
          spec: { command: "install_mod", args },
        }),
      ],
    });
    ipc.overrides.set("install_mod", () => new Promise(() => undefined));
    await mount();
    act(() => buttonIn(row("安装 Locked"), "查看这些文件").click());
    await flush();
    seedMockDownloads(["locked.jar"]);
    act(() => buttonIn(dialog(), "我已下载，重新检查").click());
    await flush();
    expect(dialog().textContent).toContain("1 个文件都已找到。");

    onLine.mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    act(() => buttonIn(dialog(), "重新安装").click());
    await flush();
    expect(callsOf(ipc, "install_mod")).toEqual([]);
    expect(launcher.state.tasks.map((t) => [t.status, t.attempt])).toEqual([["failed", 1]]);
    expect(launcher.state.toasts.map((t) => [t.tone, t.title, t.body])).toContainEqual(["warning", "没有网络连接", "联网后才能重试"]);
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
  async function fourJavaTasks(options?: { reduced?: boolean }): Promise<string[]> {
    await mount(undefined, options);
    for (const major of [8, 17, 21, 25]) await act(() => launcher.actions.installJava(major));
    await flush();
    return launcher.state.tasks.map((t) => t.id);
  }

  it("备份存档在跑：行与通道的进度条读屏只说进度，不说成下载", async () => {
    bootOverrides(ipc, {
      journal: [
        record("failed-backup", "failed", {
          kind: "world_backup",
          title: "备份「旧世界」",
          detail: "「生存」",
          instance_id: "生存",
          error: { code: "io", message: "磁盘已满" },
          spec: { command: "backup_world", args: { id: "生存", world: "旧世界" } },
        }),
      ],
    });
    ipc.overrides.set("backup_world", () => new Promise(() => undefined));
    await mount();
    act(() => buttonIn(row("备份「旧世界」"), "重试").click());
    await flush();
    const labels = [...page().querySelectorAll('[role="progressbar"]')].map((bar) => bar.getAttribute("aria-label"));
    expect(labels.filter((label) => label === "备份「旧世界」的进度")).toHaveLength(2);
    expect(labels.filter((label) => label !== null && label.includes("下载进度"))).toEqual([]);
  });

  it("三条通道各放一个运行中的任务，第四个排队；副标题与排队说明给出数量", async () => {
    const ids = await fourJavaTasks();
    expect(page().textContent).toContain("3 个下载中，1 个排队 · 最多 3 个并行");
    expect(page().textContent).toContain("还有 1 个在排队，空出通道后按加入顺序开始");
    const lanes = [...page().querySelectorAll("ol > li")];
    expect(lanes.map(liveText)).toEqual(["1下载 Java 80%", "2下载 Java 170%", "3下载 Java 210%"]);
    expect(row("Java 25").textContent).toContain("排队中 · 第 1 位");
    expect(row("Java 25").textContent).toContain("大小待定");
    // 排队中也占着百分数槽（空着、读屏不读）：轮到运行时尾部不变宽
    const slot = row("Java 25").querySelector(`.${styles.pct}`);
    expect([slot?.textContent, slot?.getAttribute("aria-hidden")]).toEqual(["", "true"]);
    expect(row("Java 8").querySelector(`.${styles.pct}`)?.textContent).toBe("0%");
    expect(headings()).toEqual(["进行中 · 4"]);
    expect(radio("进行中").getAttribute("aria-label")).toBe("进行中，4 个");
    // 有活动任务、但还没有一个报了总量：说明换成「大小还不知道」，不说成没有下载
    expect(totalRing().getAttribute("role")).toBe("img");
    expect(totalRing().getAttribute("aria-label")).toBe("全部活动任务的总进度：任务大小还不知道，暂无总进度");

    act(() => emit(CORE_EVENT, { kind: "download", task_id: `${ids[0]}#1`, total: 10, finished: 2, bytes: 120 * MB, total_bytes: 612 * MB, speed: 12 * MB }));
    // 剩余时间按最近 5 秒的平均速度：等窗口里全是这个速度
    await advance(5000);
    expect(liveText(lanes[0])).toContain("1下载 Java 8");
    expect(progressOf(lanes[0])).toBe("20");
    expect(row("Java 8").textContent).toContain("120 MB / 612 MB");
    expect(row("Java 8").textContent).toContain("12.0 MB/s · 约 45 秒");
    expect(progressOf(row("Java 8"))).toBe("20");
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

  it("任务进行中进页：采样从进页才开始，没采满 48 秒不说没有下载流量，一直没有流量才在采满时说", async () => {
    await fourJavaTasks();
    // 离开时采样丢弃，再进来时任务还在跑、这一刻速度为 0（比如正在校验文件）
    act(() => nav.go({ page: "discover" }));
    await flush();
    await advance(60_000);
    act(() => nav.go({ page: "tasks" }));
    await flush();
    expect(page().textContent).toContain("当前总速度");
    expect(page().textContent).not.toContain("最近 48 秒没有下载流量");
    // 进页时立刻采一个，之后每秒一个：第 47 秒才凑满 48 个
    await advance(46_000);
    expect(page().textContent).not.toContain("最近 48 秒没有下载流量");
    await advance(1000);
    expect(page().textContent).toContain("最近 48 秒没有下载流量");
  });

  it("完成行：写几批的实际传输量累计，用时从开始运行算起，排队等待不算", async () => {
    const ids = await fourJavaTasks();
    // 第四个任务排队 30 秒后才轮到
    await advance(30_000);
    javaRuns.get(`${ids[0]}#1`)?.resolve({ component: "java-runtime-delta", version: { major: 8, minor: 0, security: 1, build: 1, raw: "1.8.0_1" }, java_executable: "C:/java8.exe" });
    await flush();
    expect(launcher.state.tasks.find((t) => t.id === ids[3])?.status).toBe("running");

    const id = `${ids[3]}#1`;
    act(() => emit(CORE_EVENT, { kind: "download", task_id: id, total: 4, finished: 2, bytes: 60 * MB, total_bytes: 100 * MB, transferred: 60 * MB, speed: 10 * MB }));
    act(() => emit(CORE_EVENT, { kind: "download", task_id: id, total: 4, finished: 4, bytes: 100 * MB, total_bytes: 100 * MB, transferred: 100 * MB, speed: 10 * MB }));
    // 第二批从 0 重新计起
    act(() => emit(CORE_EVENT, { kind: "download", task_id: id, total: 3, finished: 3, bytes: 20 * MB, total_bytes: 20 * MB, transferred: 20 * MB, speed: 10 * MB }));
    await advance(12_000);
    javaRuns.get(id)?.resolve({ component: "java-runtime-delta", version: { major: 25, minor: 0, security: 1, build: 1, raw: "25.0.1" }, java_executable: "C:/java25.exe" });
    await flush();

    const finished = row("Java 25");
    expect(finished.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("Java，已完成");
    expect(finished.textContent).toContain("120 MB · 用时 12 秒");
  });

  it("任务完成：先在原处把进度推满、留一拍，再换到已结束；通道粘住任务，空出的那条让给排队的，其余通道不换人", async () => {
    const ids = await fourJavaTasks();
    act(() => emit(CORE_EVENT, { kind: "download", task_id: `${ids[0]}#1`, total: 10, finished: 6, bytes: 60 * MB, total_bytes: 100 * MB, speed: 5 * MB }));
    javaRuns.get(`${ids[0]}#1`)?.resolve({ component: "java-runtime-delta", version: { major: 8, minor: 0, security: 1, build: 1, raw: "1.8.0_1" }, java_executable: "C:/java8.exe" });
    await flush();
    expect(launcher.state.tasks.find((t) => t.id === ids[0])?.status).toBe("done");
    expect(launcher.state.tasks.find((t) => t.id === ids[3])?.status).toBe("running");

    const lanes = () => [...page().querySelectorAll("ol > li")];
    /** 各通道里在场的任务名；换下的那份还在原处淡出，不算。 */
    const laneTitles = () => lanes().map((l) => [...l.querySelectorAll("[title]")].filter(live).map((el) => el.getAttribute("title")));
    const [t8, t17, t21, t25] = ids.map((id) => launcher.state.tasks.find((t) => t.id === id)?.title);
    // 收尾：行还在进行中原来的位置，进度推到满格；1 号道也还是它，刚开始的第四个任务等这条道让出来
    expect(headings()).toEqual(["进行中 · 4"]);
    expect(progressOf(row("Java 8"))).toBe("100");
    expect(row("Java 8").querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("Java，已完成");
    expect(laneTitles()).toEqual([[t8], [t17], [t21]]);
    expect(progressOf(lanes()[0])).toBe("100");
    // 收尾期任务已经完成：取消键留在原位但不可用，还在跑的照常可用
    const cancelKey = (title: string) => row(title).querySelector('button[aria-label="取消任务"]');
    expect(cancelKey("Java 8")?.getAttribute("aria-disabled")).toBe("true");
    expect(cancelKey("Java 17")?.getAttribute("aria-disabled")).toBeNull();

    await advance(COMPLETION_HOLD_S * 1000);
    // 收尾结束：行换到已结束，1 号道让给第四个任务；2、3 号道的任务不因前面的结束而换道
    expect(headings()).toEqual(["进行中 · 3", "已结束 · 1"]);
    expect(laneTitles()).toEqual([[t25], [t17], [t21]]);
  });

  /** 这个任务的列表行：在场的那一行，与还在原处淡出的那些（自己或某个祖先带 inert）。 */
  function taskRows(id: string): { present: HTMLLIElement[]; leaving: HTMLLIElement[] } {
    const all = [...page().querySelectorAll(`ul [${TASK_ROW_ATTR}="${id}"]`)].map((mark) => {
      const li = mark.closest("li");
      if (li === null) throw new Error(`任务 ${id} 的标记不在列表行里`);
      return li;
    });
    return { present: all.filter(live), leaving: all.filter((li) => !live(li)) };
  }

  const JAVA_8 = { component: "java-runtime-delta", version: { major: 8, minor: 0, security: 1, build: 1, raw: "1.8.0_1" }, java_executable: "C:/java8.exe" };

  /** 换到已结束的新行是完成的样子；原处淡出的那份停在收尾：进度条满格，取消键留在原位但不可用，与有收尾这一拍时离开前的样子相同。 */
  function expectLeavingAsFinishing(id: string) {
    const { present, leaving } = taskRows(id);
    expect([present.length, leaving.length]).toEqual([1, 1]);
    expect(present[0].querySelector('[role="progressbar"]')).toBeNull();
    expect(present[0].querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("Java，已完成");
    expect(leaving[0].querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("100");
    expect(leaving[0].querySelector('button[aria-label="取消任务"]')?.getAttribute("aria-disabled")).toBe("true");
  }

  it("减少动画时任务完成：不留收尾这一拍，行立即换到已结束；进行中组里淡出的那份照收尾画满格，不在淡出时换成已结束的样子", async () => {
    const ids = await fourJavaTasks({ reduced: true });
    act(() => emit(CORE_EVENT, { kind: "download", task_id: `${ids[0]}#1`, total: 10, finished: 6, bytes: 60 * MB, total_bytes: 100 * MB, speed: 5 * MB }));
    expect(progressOf(row("Java 8"))).toBe("60");
    javaRuns.get(`${ids[0]}#1`)?.resolve(JAVA_8);
    await flush();
    expect(launcher.state.tasks.find((t) => t.id === ids[0])?.status).toBe("done");
    expect(headings()).toEqual(["进行中 · 3", "已结束 · 1"]);
    expectLeavingAsFinishing(ids[0]);
  });

  it("减少动画时最后一个进行中的任务完成：进行中整组在原处淡出，组里那一行同样停在收尾的满格", async () => {
    await mount(undefined, { reduced: true });
    await act(() => launcher.actions.installJava(8));
    await flush();
    const [id] = launcher.state.tasks.map((t) => t.id);
    act(() => emit(CORE_EVENT, { kind: "download", task_id: `${id}#1`, total: 10, finished: 6, bytes: 60 * MB, total_bytes: 100 * MB, speed: 5 * MB }));
    javaRuns.get(`${id}#1`)?.resolve(JAVA_8);
    await flush();
    expect(headings()).toEqual(["已结束 · 1"]);
    expectLeavingAsFinishing(id);
  });

  it("减少动画时任务完成：通道立即让给排队的任务，换下的那份按完成画满格淡出，不停在完成前的进度；淡出途中清除已结束也不倒回", async () => {
    const ids = await fourJavaTasks({ reduced: true });
    act(() => emit(CORE_EVENT, { kind: "download", task_id: `${ids[0]}#1`, total: 10, finished: 6, bytes: 60 * MB, total_bytes: 100 * MB, speed: 5 * MB }));
    const lane = () => page().querySelectorAll("ol > li")[0];
    expect(progressOf(lane())).toBe("60");
    javaRuns.get(`${ids[0]}#1`)?.resolve(JAVA_8);
    await flush();
    const t25 = launcher.state.tasks.find((t) => t.id === ids[3])?.title;
    expect([...lane().querySelectorAll("[title]")].filter(live).map((el) => el.getAttribute("title"))).toEqual([t25]);
    const leavingFace = () => {
      const faces = [...lane().querySelectorAll("[inert]")];
      expect(faces).toHaveLength(1);
      return faces[0];
    };
    expect(leavingFace().querySelector("[title]")?.getAttribute("title")).toBe(launcher.state.tasks.find((t) => t.id === ids[0])?.title);
    expect(progressOf(leavingFace())).toBe("100");

    act(() => buttonIn(header(), "清除已结束（1）").click());
    await flush();
    expect(launcher.state.tasks.map((t) => t.id)).toEqual(ids.slice(1));
    expect(progressOf(leavingFace())).toBe("100");
  });

  it("减少动画时任务完成、进行中那份还在淡出就点清除已结束：那份停在收尾的满格淡完，页面照常", async () => {
    const ids = await fourJavaTasks({ reduced: true });
    act(() => emit(CORE_EVENT, { kind: "download", task_id: `${ids[0]}#1`, total: 10, finished: 6, bytes: 60 * MB, total_bytes: 100 * MB, speed: 5 * MB }));
    javaRuns.get(`${ids[0]}#1`)?.resolve(JAVA_8);
    await flush();
    expectLeavingAsFinishing(ids[0]);

    act(() => buttonIn(header(), "清除已结束（1）").click());
    await flush();
    expect(launcher.state.tasks.map((t) => t.id)).toEqual(ids.slice(1));
    expect(headings()).toEqual(["进行中 · 3"]);
    // 已结束组里那一行也被清掉、在原处淡出；进行中组里先前那份仍是收尾的样子，不倒回完成前的进度
    const { present, leaving } = taskRows(ids[0]);
    expect(present).toEqual([]);
    const bars = leaving.map((li) => li.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow"));
    expect(bars.sort()).toEqual(["100", undefined]);
    const fading = leaving.find((li) => li.querySelector('[role="progressbar"]') !== null);
    expect(fading?.querySelector('button[aria-label="取消任务"]')?.getAttribute("aria-disabled")).toBe("true");
  });

  it("运行中的任务被取消、进行中那份还在淡出就点清除已结束：那份停在取消后的样子淡完，页面照常", async () => {
    const ids = await fourJavaTasks();
    act(() => row("Java 8").querySelector<HTMLButtonElement>('button[aria-label="取消任务"]')?.click());
    await flush();
    expect(callsOf(ipc, "cancel_task")).toEqual([{ taskId: `${ids[0]}#1` }]);
    javaRuns.get(`${ids[0]}#1`)?.reject(cancelledError());
    await flush();
    expect(headings()).toEqual(["进行中 · 3", "已结束 · 1"]);
    expect(taskRows(ids[0]).leaving).toHaveLength(1);

    act(() => buttonIn(header(), "清除已结束（1）").click());
    await flush();
    expect(launcher.state.tasks.map((t) => t.id)).toEqual(ids.slice(1));
    const { present, leaving } = taskRows(ids[0]);
    expect(present).toEqual([]);
    expect(leaving).toHaveLength(2);
    for (const li of leaving) {
      expect(li.textContent).toContain("取消于 0%");
      expect(li.querySelector('[role="progressbar"]')).toBeNull();
    }
  });

  it("补全完成行：进度按有效字节走满，说明只写实际下载的量；一个字节没传写文件已就绪", async () => {
    const ids = await fourJavaTasks();
    const repaired = `${ids[0]}#1`;
    const present = `${ids[1]}#1`;
    // 大部分文件本就完整：有效字节 701 MB、走网络的只有 5.5 MB
    act(() => emit(CORE_EVENT, { kind: "download", task_id: repaired, total: 900, finished: 450, bytes: 350 * MB, total_bytes: 701 * MB, transferred: 2 * MB, speed: MB }));
    expect(progressOf(row("Java 8"))).toBe("50");
    // 已下大小按节拍换字：等满一个间隔再读
    await advance(SPEED_REFRESH_MS);
    expect(row("Java 8").textContent).toContain("350 MB / 701 MB");
    act(() => emit(CORE_EVENT, { kind: "download", task_id: repaired, total: 900, finished: 900, bytes: 701 * MB, total_bytes: 701 * MB, transferred: 5.5 * MB, speed: MB }));
    act(() => emit(CORE_EVENT, { kind: "download", task_id: present, total: 900, finished: 900, bytes: 701 * MB, total_bytes: 701 * MB, transferred: 0, speed: 0 }));
    await advance(2_000 - SPEED_REFRESH_MS);
    const java = { component: "java-runtime-delta", version: { major: 8, minor: 0, security: 1, build: 1, raw: "1.8.0_1" }, java_executable: "C:/java8.exe" };
    javaRuns.get(repaired)?.resolve(java);
    javaRuns.get(present)?.resolve(java);
    await flush();

    expect(row("Java 8").textContent).toContain("5.5 MB · 用时 2 秒");
    expect(row("Java 8").textContent).not.toContain("701 MB");
    expect(row("Java 17").textContent).toContain("文件已就绪 · 用时 2 秒");
    expect(row("Java 17").textContent).not.toContain("701 MB");
  });

  it("已下大小按节拍换字：从 0 开始传的第一条立即换上；之后事件到达的那一刻行内、已下载与剩余都不换，满间隔才换上最新值，剩余时间同一拍；传到总量与任务完成立即到位", async () => {
    await mount();
    await act(() => launcher.actions.installJava(8));
    await flush();
    const taskId = launcher.state.tasks[0].id;
    const progress = (bytes: number, speed = 2 * MB) =>
      act(() => emit(CORE_EVENT, { kind: "download", task_id: `${taskId}#1`, total: 100, finished: bytes / MB, bytes, total_bytes: 100 * MB, speed }));
    const meta = () => row("Java 8").querySelector(`.${styles.rowMeta}`)?.textContent;
    const downloaded = () => [...page().querySelectorAll(`.${styles.miniValue}`)].filter(live)[0]?.textContent;
    const remaining = () => [...page().querySelectorAll(`.${styles.flowSub}`)].filter(live)[0]?.textContent;
    const shown = () => [meta(), downloaded(), remaining()];

    // 从 0 开始传：第一条事件的已下大小立即换上，不停在 0 B；剩余时间按这一刻的速度估（剩 90 MB / 4 MB/s）
    progress(10 * MB, 4 * MB);
    expect(shown()).toEqual(["10.0 MB / 100 MB4.0 MB/s · 约 25 秒", "10.0 MB", "剩余 90.0 MB · 约 25 秒"]);
    // 窗口里还没有采到这一次的速度，估速跟着瞬时速度走：已下大小没换字，剩余时间也不跟着跳（照算会是约 45 秒）
    await advance(100);
    progress(12 * MB);
    expect(shown()).toEqual(["10.0 MB / 100 MB4.0 MB/s · 约 25 秒", "10.0 MB", "剩余 90.0 MB · 约 25 秒"]);

    // 走到稳态：剩余时间的平均窗口里全是 2 MB/s，上一次换字已过了很久
    await advance(4_900);
    expect(shown()).toEqual(["12.0 MB / 100 MB2.0 MB/s · 约 45 秒", "12.0 MB", "剩余 88.0 MB · 约 45 秒"]);

    // 离上次换字已满间隔：这一条立即换上
    progress(30 * MB);
    expect(shown()).toEqual(["30.0 MB / 100 MB2.0 MB/s · 约 35 秒", "30.0 MB", "剩余 70.0 MB · 约 35 秒"]);

    // 不满间隔：进度条照事件走，字（连同剩余时间）都停在上一拍；照原值算剩余时间会是约 20 秒
    await advance(100);
    progress(60 * MB);
    expect(progressOf(row("Java 8"))).toBe("60");
    expect(shown()).toEqual(["30.0 MB / 100 MB2.0 MB/s · 约 35 秒", "30.0 MB", "剩余 70.0 MB · 约 35 秒"]);
    await advance(SPEED_REFRESH_MS - 101);
    expect(shown()).toEqual(["30.0 MB / 100 MB2.0 MB/s · 约 35 秒", "30.0 MB", "剩余 70.0 MB · 约 35 秒"]);
    // 间隔满：没有新事件也补上最后报上来的值，剩余时间同一拍换
    await advance(1);
    expect(shown()).toEqual(["60.0 MB / 100 MB2.0 MB/s · 约 20 秒", "60.0 MB", "剩余 40.0 MB · 约 20 秒"]);

    // 传到总量：不等间隔，与满格的进度条同时到位
    await advance(100);
    progress(100 * MB);
    expect(shown()).toEqual(["100 MB / 100 MB2.0 MB/s · 即将完成", "100 MB", "剩余 0 B · 即将完成"]);

    // 任务完成：总览立即不再计它，行换成完成说明
    javaRuns.get(`${taskId}#1`)?.resolve({ component: "java-runtime-delta", version: { major: 8, minor: 0, security: 1, build: 1, raw: "1.8.0_1" }, java_executable: "C:/java8.exe" });
    await flush();
    expect(downloaded()).toBe("0 B");
    expect(meta()).not.toContain("/ 100 MB");
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

    // 全部取消退场时按页头定位、留在原处淡出（规则见 header-layout.test）：页头带着那个类
    expect(header().classList.contains(styles.header)).toBe(true);
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
    // 错误卡收起时在原处淡出（已不在场），空状态换上来
    expect(liveText(page())).not.toContain("下载任务记录读不出来");
    expect(liveText(page())).toContain("下载队列是空的");
  });

  /** 加载区的骨架层：已换成内容（none）、占着位但看不见（等待期，pending）、显示中（shown）。 */
  function skeletonState(): "none" | "pending" | "shown" {
    const layer = page().querySelector('[aria-busy="true"] > [aria-hidden="true"]');
    if (layer === null) return "none";
    return layer.hasAttribute("data-pending") ? "pending" : "shown";
  }

  it("300 ms 内读完不出骨架但照样占位；超过才出，出了至少停留 300 ms", async () => {
    const journal = deferred<TaskJournalDto>();
    ipc.overrides.set("load_task_journal", () => journal.promise);
    await mount();
    // 等待期骨架已经按内容的形状占着位，只是看不见：数据一到不会从 0 高撑开
    expect(skeletonState()).toBe("pending");
    await advance(299);
    expect(skeletonState()).toBe("pending");
    await advance(1);
    expect(skeletonState()).toBe("shown");
    await advance(100);
    journal.resolve({ seq: 0, tasks: [] });
    await flush();
    // 数据已到，但骨架才出现 100 ms
    expect(skeletonState()).toBe("shown");
    expect(page().textContent).not.toContain("下载队列是空的");
    await advance(200);
    expect(skeletonState()).toBe("none");
    expect(page().textContent).toContain("下载队列是空的");
  });

  it("骨架出现之后才读到任务：同样停够最短时长才换成总览与列表，不是一到就把骨架撤掉", async () => {
    const journal = deferred<TaskJournalDto>();
    ipc.overrides.set("load_task_journal", () => journal.promise);
    await mount();
    await advance(300);
    expect(skeletonState()).toBe("shown");
    await advance(50);
    journal.resolve({ seq: 1, tasks: HISTORY });
    await flush();
    expect(launcher.state.tasks).toHaveLength(3);
    expect(skeletonState()).toBe("shown");
    expect(rows()).toHaveLength(0);
    await advance(250);
    expect(skeletonState()).toBe("none");
    expect(headings()).toEqual(["已结束 · 3"]);
    expect(rows()).toHaveLength(3);
  });

  it("读了 10 s 还没读完：骨架下方补一行「比平时慢」，读屏读得到；读完随骨架一起收起", async () => {
    const journal = deferred<TaskJournalDto>();
    ipc.overrides.set("load_task_journal", () => journal.promise);
    await mount();
    const hints = () => [...page().querySelectorAll("p")].filter(live).filter((p) => p.textContent === "比平时慢一些，仍在加载…");
    await advance(300);
    expect(skeletonState()).toBe("shown");
    await advance(9_699);
    expect(hints()).toHaveLength(0);
    await advance(1);
    expect(hints()).toHaveLength(1);
    // 骨架层对读屏隐藏，提示不在它里面
    expect(hints()[0].closest('[aria-hidden="true"]')).toBeNull();
    journal.resolve({ seq: 0, tasks: [] });
    await flush();
    // 骨架与提示一起退场：提示只剩正在原处淡出的那一份
    expect(skeletonState()).toBe("none");
    expect(hints()).toHaveLength(0);
    expect(page().textContent).toContain("下载队列是空的");
  });
});

describe("下载任务页：入场编号", () => {
  /** 领了页面入场序号的区块与序号，按文档顺序；正在退场的不算。 */
  const numbered = () =>
    [...page().querySelectorAll<HTMLElement>("[data-entrance]")].filter(live).map((el): [string, string | undefined] => {
      if (el.tagName === "HEADER") return ["header", el.dataset.entrance];
      if (el.classList.contains(styles.overview)) return ["overview", el.dataset.entrance];
      if (el.classList.contains(styles.listHead)) return ["filter", el.dataset.entrance];
      if (el.querySelector(`.${styles.groups}`) !== null) return ["list", el.dataset.entrance];
      if (el.textContent?.includes("下载队列是空的")) return ["empty", el.dataset.entrance];
      throw new Error(`领了入场序号的是一块认不出的元素：${el.outerHTML.slice(0, 80)}`);
    });

  it("进页时任务记录已在：总览、筛选、列表卡接着页头的序号逐块错开；空着的横幅槽不占号", async () => {
    bootOverrides(ipc, { journal: HISTORY });
    await mount();
    expect(numbered()).toEqual([
      ["header", "0"],
      ["overview", "1"],
      ["filter", "2"],
      ["list", "3"],
    ]);
  });

  it("进页时队列是空的：空状态卡接着页头领下一个序号", async () => {
    await mount();
    expect(numbered()).toEqual([
      ["header", "0"],
      ["empty", "1"],
    ]);
  });

  it("等过加载才读到任务：内容整层淡入，里面的总览、筛选、列表都不再各自领序号", async () => {
    const journal = deferred<TaskJournalDto>();
    ipc.overrides.set("load_task_journal", () => journal.promise);
    await mount();
    await advance(300);
    journal.resolve({ seq: 1, tasks: HISTORY });
    await flush();
    await advance(300);
    expect(headings()).toEqual(["已结束 · 3"]);
    expect(numbered()).toEqual([["header", "0"]]);
  });

  it("进页之后空状态换成列表：换上来的总览、筛选、列表整块淡入，不领序号", async () => {
    await mount();
    expect(numbered()).toEqual([
      ["header", "0"],
      ["empty", "1"],
    ]);
    await act(() => launcher.actions.installJava(8));
    await flush();
    expect(headings()).toEqual(["进行中 · 1"]);
    // 换下的空状态卡还在原处淡出（带 inert），不算
    expect(numbered()).toEqual([["header", "0"]]);
  });

  it("进页之后列表换成空状态：换上来的空状态卡整块淡入，不领序号", async () => {
    bootOverrides(ipc, { journal: HISTORY });
    await mount();
    act(() => buttonIn(page(), "清除已结束（3）").click());
    expect(liveText(page())).toContain("下载队列是空的");
    expect(numbered()).toEqual([["header", "0"]]);
  });
});
