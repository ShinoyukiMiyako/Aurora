// @vitest-environment jsdom
// 日志与历史标签的加载与换数据：控制台在会话结束、留底读回的交接里不闪骨架、不重挂；加载占位与控制台同一框架；
// 变更历史两份查询落定后一起换，新条目从入场起点出现。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, type ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../art/illustrations/test-canvas";
import { SLOW_LOADING_HINT } from "../../copy/flows";
import type { LaunchLogDto } from "../../ipc/diagnostics";
import { IpcError } from "../../ipc/errors";
import type { HistoryEvent, RollbackCheck } from "../../ipc/history";
import type { InstanceSettingsDto } from "../../ipc/instances";
import { GAME_EXIT_EVENT, GAME_LOG_EVENT } from "../../ipc/launch";
import { OverlayRoot } from "../../shell/overlay";
import { ShellProvider, useNav, type NavApi } from "../../shell/shell";
import { AppearanceProvider, DEFAULT_APPEARANCE } from "../../state/appearance";
import { LauncherProvider, useLauncher, type LauncherApi } from "../../state/launcher";
import { routeKey } from "../../state/route";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { bootOverrides, callsOf, configDto, deferred, emit, instanceDto, memoryAdviceDto, resetRecorder, settle, type Deferred } from "../../test/launcher";
import { RemoteImageProvider } from "../../ui/remote-image";
import InstancePage from "./index";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));
// 让位挂到了哪些容器上：jsdom 不做布局，让位本身在这里测不了，只核对它挂对了地方；挂载照常交给真实现
const reflowed = vi.hoisted(() => new Set<Element>());
vi.mock("../../lib/reflow", async (orig) => {
  const mod = await orig<typeof import("../../lib/reflow")>();
  const { useCallback } = await import("react");
  return {
    ...mod,
    useReflow: <T extends HTMLElement>(spring: Parameters<typeof mod.useReflow>[0] = "settle") => {
      const real = mod.useReflow<T>(spring);
      return useCallback(
        (el: T | null) => {
          if (el !== null) reflowed.add(el);
          return real(el);
        },
        [real],
      );
    },
  };
});

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "instance.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** 选择器恰好是 selector 的那条规则的声明块。 */
function rule(selector: string): string {
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) if (m[1].trim() === selector) return m[2];
  throw new Error(`样式表里没有 ${selector}`);
}

const ID = "樱花生存";
const DAY = 24 * 3600 * 1000;
const NOW = new Date(2026, 9, 31, 12, 0, 0).getTime();

const SETTINGS: InstanceSettingsDto = {
  description: null,
  cover: null,
  cover_image: null,
  background: "follow",
  background_image: null,
  isolation: "follow_global",
  memory_mb: null,
  java: "auto",
  jvm_args: "",
  resolution: { width: 854, height: 480 },
  fullscreen: false,
};

let view: Rendered | undefined;
let nav: NavApi;
let launcher: LauncherApi;
let history: HistoryEvent[];
/** 非空时可回滚检查等它放行再回答：模拟两份查询先后到达。 */
let checksGate: Deferred<void> | null;

function Probe() {
  nav = useNav();
  launcher = useLauncher();
  return null;
}

function Routed() {
  const { route } = useNav();
  return route.page === "instance" ? <InstancePage key={routeKey(route)} route={route} /> : null;
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <AppearanceProvider initial={DEFAULT_APPEARANCE}>
      <LauncherProvider>
        <ShellProvider>
          <RemoteImageProvider resolve={(url) => Promise.resolve(url)}>
            {children}
            <OverlayRoot />
          </RemoteImageProvider>
        </ShellProvider>
      </LauncherProvider>
    </AppearanceProvider>
  );
}

const flush = () =>
  act(async () => {
    await settle(20);
  });

async function pass(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
  await flush();
}

async function open() {
  view = render(
    <Providers>
      <Probe />
      <Routed />
    </Providers>,
  );
  await flush();
  act(() => nav.go({ page: "instance", id: ID, tab: "logs" }));
  await flush();
}

function textOf(node: Node): string {
  const t = node.textContent;
  if (t === null) throw new Error("节点没有文本内容");
  return t;
}

/** 标题为 title 的那张卡（卡头的标题是 h3）。 */
function card(title: string): HTMLElement {
  const heading = [...document.querySelectorAll("h3")].find((h) => h.textContent === title && h.closest("[inert]") === null && h.closest('[aria-hidden="true"]') === null);
  const found = heading?.closest<HTMLElement>("[data-pad]");
  if (found === undefined || found === null) throw new Error(`找不到「${title}」卡`);
  return found;
}

/** 控制台卡：加载占位里也有同名标题，按卡片根找，不按标题。 */
function consoleCard(): HTMLElement {
  const grid = document.querySelector<HTMLElement>('[role="tabpanel"] [data-pad]');
  if (grid === null) throw new Error("日志标签里没有卡片");
  return grid;
}

function logArea(): HTMLElement | null {
  return consoleCard().querySelector<HTMLElement>('[role="log"]');
}

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === name || b.textContent === name);
  if (found === undefined) throw new Error(`找不到按钮「${name}」`);
  return found;
}

function launchLog(texts: readonly string[], startedAt: number): LaunchLogDto {
  return {
    path: "latest.log",
    started_at: startedAt,
    lines: texts.map((text, i) => ({ at: startedAt + i * 1000, level: "info", source: "game", text })),
    omitted: 0,
    ended: { at: startedAt + 60_000, outcome: "exited" },
  };
}

function checksOf(events: readonly HistoryEvent[]): RollbackCheck[] {
  const reverted = new Set(events.flatMap((e) => (e.kind === "rollback" ? [e.reverted_event] : [])));
  return events.map((e) => {
    const can = e.kind === "update" && !reverted.has(e.id);
    return { event_id: e.id, can_rollback: can, reason: can ? null : e.kind === "update" ? "已经回滚过" : "安装事件不支持回滚" };
  });
}

beforeAll(async () => {
  await import("../../ipc/mock");
});

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  resetRecorder(ipc);
  reflowed.clear();
  stubMatchMedia(false);
  stubResizeObserver();
  stubCanvas();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  history = [
    { kind: "install", id: "100-000", at: Math.floor(NOW / 1000) - 3600, files: ["sodium-0.5.jar"] },
    {
      kind: "update",
      id: "200-000",
      at: Math.floor(NOW / 1000) - 60,
      file_name: "sodium.jar",
      old_file: "sodium-0.5.jar",
      from_version: "v05",
      to_version: "v06",
      title: "Sodium",
      from_version_number: "0.5.0",
      to_version_number: "0.6.0",
    },
  ];
  checksGate = null;
  bootOverrides(ipc, {
    instances: [instanceDto(ID, { loaders: [{ kind: "fabric", version: "0.16.10" }], mod_count: 0, last_played_at: NOW - DAY })],
    config: configDto({ memory: { max_mb: 4096, min_mb: null, auto: false } }),
  });
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("launch_game", () => ({ pid: 4242 }));
  ipc.overrides.set("get_instance_settings", () => SETTINGS);
  ipc.overrides.set("list_mods", () => []);
  ipc.overrides.set("check_updates", () => []);
  ipc.overrides.set("list_instance_content", () => ({ resource_packs: [], shader_packs: [], worlds: [] }));
  ipc.overrides.set("detect_java", () => []);
  ipc.overrides.set("memory_advice", () => memoryAdviceDto({ version_id: ID }));
  ipc.overrides.set("last_crash", () => null);
  ipc.overrides.set("last_launch_log", () => launchLog(["上一局的第一行", "上一局的第二行"], NOW - DAY));
  ipc.overrides.set("list_history", () => history);
  ipc.overrides.set("rollback_checks", () => {
    const answer = () => checksOf(history);
    return checksGate === null ? answer() : checksGate.promise.then(answer);
  });
  ipc.overrides.set("rollback", (args) => {
    history = [...history, { kind: "rollback", id: "300-000", at: Math.floor(Date.now() / 1000), reverted_event: String(args.eventId) }];
    return null;
  });
  ipc.overrides.set("open_folder", () => null);
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("日志控制台：会话结束与留底的交接", () => {
  async function playAndExit() {
    await act(async () => {
      await launcher.actions.launch(ID);
      await settle(20);
    });
    expect(launcher.state.session).toMatchObject({ instanceId: ID, phase: "running" });
    act(() => emit(GAME_LOG_EVENT, { version_id: ID, lines: [{ level: "info", source: "game", text: "这一局的输出" }] }));
    await flush();
  }

  it("正常退出：一离开实时就去读留底；停留期满会话清空、留底还没回来时接着画这一局，控制台不重挂、换行开关不复位", async () => {
    await open();
    click(button("自动换行"));
    const area = logArea();
    if (area === null) throw new Error("控制台没有画出来");
    await playAndExit();
    const log = deferred<LaunchLogDto>();
    ipc.overrides.set("last_launch_log", () => log.promise);
    const before = callsOf(ipc, "last_launch_log").length;

    act(() => emit(GAME_EXIT_EVENT, { version_id: ID, exit_code: 0, crashed: false, killed: false, duration_ms: 60_000 }));
    await flush();
    expect(callsOf(ipc, "last_launch_log")).toHaveLength(before + 1);

    await pass(2000);
    expect(launcher.state.session).toBeNull();
    expect(consoleCard().querySelector('[aria-busy="true"]')).toBeNull();
    expect(logArea()).toBe(area);
    expect(textOf(consoleCard())).toContain("本次会话 · 已结束");

    log.resolve(launchLog(["这一局的输出"], NOW));
    await flush();
    expect(logArea()).toBe(area);
    expect(textOf(consoleCard())).toContain("最近一次启动 · ");
    expect(button("自动换行").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("日志控制台：加载占位", () => {
  it("留底读得慢：卡片从一开始就是控制台的无内边距框架，副标题先占一行；骨架过加载门后换成控制台", async () => {
    const log = deferred<LaunchLogDto>();
    ipc.overrides.set("last_launch_log", () => log.promise);
    await open();
    const frame = consoleCard();
    expect(frame.dataset.pad).toBe("none");
    const layer = () => frame.querySelector<HTMLElement>('[aria-busy="true"] > [aria-hidden="true"]');
    expect(layer()?.hasAttribute("data-pending")).toBe(true);
    expect(layer()?.querySelector("[data-reserve]")).not.toBeNull();
    await pass(300);
    expect(layer()?.hasAttribute("data-pending")).toBe(false);

    log.resolve(launchLog(["上一局的第一行"], NOW - DAY));
    await flush();
    await pass(300);
    expect(consoleCard()).toBe(frame);
    expect(frame.dataset.pad).toBe("none");
    expect(frame.querySelector('[aria-busy="true"]')).toBeNull();
    expect(logArea()).not.toBeNull();
  });

  it("加载期间读屏仍读得到卡片标题：占位整层隐藏，占位外面另有一个同名标题；控制台到了只剩它自己的卡头", async () => {
    const log = deferred<LaunchLogDto>();
    ipc.overrides.set("last_launch_log", () => log.promise);
    await open();
    const headings = () => [...consoleCard().querySelectorAll("h3")].filter((h) => h.closest('[aria-hidden="true"]') === null && h.closest("[inert]") === null).map(textOf);
    expect(headings()).toEqual(["启动日志"]);
    // 占位外面的那个只给读屏：套全局的视觉隐藏类，不占卡头的位置
    expect([...consoleCard().querySelectorAll("h3")].filter((h) => h.closest('[aria-hidden="true"]') === null).map((h) => h.className)).toEqual(["sk-sr-only"]);
    await pass(300);
    expect(headings()).toEqual(["启动日志"]);

    log.resolve(launchLog(["上一局的第一行"], NOW - DAY));
    await flush();
    await pass(300);
    expect(logArea()).not.toBeNull();
    expect(headings()).toEqual(["启动日志"]);
  });

  it("读了 10 s 还没读完：两张卡的「比平时慢」都在占位外面，读屏读得到；读到后撤走", async () => {
    const log = deferred<LaunchLogDto>();
    const events = deferred<HistoryEvent[]>();
    ipc.overrides.set("last_launch_log", () => log.promise);
    ipc.overrides.set("list_history", () => events.promise);
    await open();
    const hints = (root: HTMLElement) => [...root.querySelectorAll("p")].filter((p) => p.textContent === SLOW_LOADING_HINT);
    expect(hints(consoleCard())).toEqual([]);
    expect(hints(card("变更历史"))).toEqual([]);

    await pass(10_000);
    for (const root of [consoleCard(), card("变更历史")]) {
      const found = hints(root);
      expect(found).toHaveLength(1);
      expect(found[0].closest('[aria-hidden="true"]')).toBeNull();
    }

    log.resolve(launchLog(["上一局的第一行"], NOW - DAY));
    events.resolve(history);
    await flush();
    await pass(300);
    expect(hints(consoleCard())).toEqual([]);
    expect(hints(card("变更历史"))).toEqual([]);
  });

  it("级别计数槽按四位定宽，来源组不带计数照默认", async () => {
    await open();
    const group = (label: string) => {
      const el = document.querySelector<HTMLElement>(`[role="radiogroup"][aria-label="${label}"]`);
      if (el === null) throw new Error(`找不到「${label}」`);
      return el;
    };
    expect(group("按级别筛选").style.getPropertyValue("--segment-count-digits")).toBe("4");
    expect(group("按来源筛选").style.getPropertyValue("--segment-count-digits")).toBe("2");
  });
});

describe("变更历史：换数据", () => {
  /** 时间线上在场的条目：标题文字与挂载那一刻是否从入场起点（透明）开始。 */
  function timeline(): [string, boolean][] {
    return [...card("变更历史").querySelectorAll<HTMLElement>("ol > li")].map((li) => [textOf(li), li.style.opacity === "0"]);
  }

  it("加载中副标题先占一行，读到后填上文案", async () => {
    const events = deferred<HistoryEvent[]>();
    ipc.overrides.set("list_history", () => events.promise);
    await open();
    const header = card("变更历史");
    expect(header.querySelector("[data-reserve]")).not.toBeNull();
    events.resolve(history);
    await flush();
    await pass(300);
    expect(header.querySelector("[data-reserve]")).toBeNull();
    expect(textOf(header)).toContain("2 条记录 · 1 条可回滚");
  });

  it("骨架显出来之后才读不出：副标题那一行照旧占着，卡头不缩、错误块不上移；重试读到后文案填进同一行", async () => {
    const events = deferred<HistoryEvent[]>();
    ipc.overrides.set("list_history", () => events.promise);
    await open();
    await pass(300);
    const header = card("变更历史");
    expect(header.querySelector("[data-reserve]")).not.toBeNull();

    events.reject(new IpcError("io", "history.json 读不出来"));
    await flush();
    await pass(300);
    expect(textOf(header)).toContain("读不到变更历史");
    expect(header.querySelector("[data-reserve]")).not.toBeNull();

    ipc.overrides.set("list_history", () => history);
    click(button("重试"));
    await flush();
    await pass(300);
    expect(header.querySelector("[data-reserve]")).toBeNull();
    expect(textOf(header)).toContain("2 条记录 · 1 条可回滚");
  });

  it("回滚后历史先到、可回滚检查后到：两份都落定之前时间线不动，之后新事件从入场起点出现，挂载时就在的不入场", async () => {
    await open();
    expect(timeline().map(([, entering]) => entering)).toEqual([false, false]);

    // 回滚动作自己先核对一次可回滚（这一次不等）；回滚落盘之后两份查询失效重取，检查那份被拦住
    const gate = deferred<void>();
    ipc.overrides.set("rollback", (args) => {
      history = [...history, { kind: "rollback", id: "300-000", at: Math.floor(Date.now() / 1000), reverted_event: String(args.eventId) }];
      checksGate = gate;
      return null;
    });
    click(button("回滚到 0.5.0"));
    await flush();
    expect(callsOf(ipc, "rollback")).toEqual([{ versionId: ID, eventId: "200-000" }]);
    expect(callsOf(ipc, "list_history").length).toBeGreaterThanOrEqual(2);
    expect(timeline()).toHaveLength(2);
    expect(textOf(card("变更历史"))).toContain("2 条记录 · 1 条可回滚");

    gate.resolve();
    await flush();
    const after = timeline();
    expect(after).toHaveLength(3);
    expect(after[0][1]).toBe(true);
    expect(after.slice(1).map(([, entering]) => entering)).toEqual([false, false]);
    expect(textOf(card("变更历史"))).toContain("3 条记录 · 0 条可回滚");
  });
});

describe("变更历史：「显示更早」与滚动区", () => {
  it("超过一页时「显示更早」与时间线同在一个让位容器里：顶上插进新事件时它跟着条目滑，不一帧跳下去", async () => {
    history = Array.from({ length: 31 }, (_, i) => ({ kind: "install" as const, id: `${100 + i}-000`, at: Math.floor(NOW / 1000) - 3600 - i, files: [`mod-${i}.jar`] }));
    await open();
    const more = button("显示更早的 1 条");
    const list = card("变更历史").querySelector<HTMLElement>("ol");
    if (list === null) throw new Error("时间线没有画出来");
    const scroller = list.parentElement;
    if (scroller === null) throw new Error("时间线没有滚动区");
    expect(scroller.contains(more)).toBe(true);
    expect(more.closest("ol")).toBeNull();
    expect(reflowed.has(list)).toBe(true);
    expect(reflowed.has(scroller)).toBe(true);
  });

  it("滚动条槽常驻并伸进卡片右内边距：时间线越过最大高度时条目不收窄，居中的「显示更早」不横移", () => {
    const decl = rule(".timelineScroll");
    expect(decl).toMatch(/overflow:\s*auto;/);
    expect(decl).toMatch(/scrollbar-gutter:\s*stable;/);
    expect(decl).toMatch(/margin-right:\s*calc\(-1 \* var\(--sk-scrollbar-size\)\);/);
  });
});

function click(el: HTMLElement) {
  act(() => el.click());
}
