// @vitest-environment jsdom
// 崩溃诊断标签跑在假后端上：先在 mock 里启动并让游戏以指定退出码崩掉，再打开诊断页看报告怎么画出来。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ICON_PATHS } from "../../art/icon-paths";
import { stubCanvas } from "../../art/illustrations/test-canvas";
import { SLOW_LOADING_HINT } from "../../copy/flows";
import { getConfig, updateConfig } from "../../ipc/config";
import { lastCrash, type CrashClueDto, type CrashReportDto } from "../../ipc/diagnostics";
import { IpcError } from "../../ipc/errors";
import type { InstanceDto } from "../../ipc/instances";
import { GAME_EXIT_EVENT, launchGame } from "../../ipc/launch";
import type { InstalledMod } from "../../ipc/mods";
import { mockInvoke, resetMocks } from "../../ipc/mock";
import { setMockGpuAdapters } from "../../ipc/mock/handlers/java";
import { endMockGame, mockCrashReport, setMockLaunchWarnings } from "../../ipc/mock/handlers/launch";
import { OverlayRoot } from "../../shell/overlay";
import { ShellProvider, useNav, type NavApi } from "../../shell/shell";
import { AppearanceProvider, DEFAULT_APPEARANCE } from "../../state/appearance";
import { LauncherProvider, useLauncher, type LauncherApi } from "../../state/launcher";
import { routeKey, type InstanceTab } from "../../state/route";
import { render, stubMatchMedia, stubResizeObserver, stubSpanAnimations, type Rendered } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { callsOf, deferred, emit, memoryAdviceDto, resetRecorder, settle } from "../../test/launcher";
import { RemoteImageProvider } from "../../ui/remote-image";
import InstancePage from "./index";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));

/** mock 的种子实例，原版、没有 Mod。 */
const ID = "1.21";
const LOG_PATH = `D:/mc/versions/${ID}/logs/latest.log`;
const CRASH_REPORT_PATH = `D:/mc/versions/${ID}/crash-reports/crash-2026-10-31_11.58.00-client.txt`;
const NOW = new Date(2026, 9, 31, 12, 0, 0).getTime();

let view: Rendered | undefined;
let nav: NavApi;
let launcher: LauncherApi;

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

async function open(tab: InstanceTab, id = ID) {
  view = render(
    <Providers>
      <Probe />
      <Routed />
    </Providers>,
  );
  await flush();
  act(() => nav.go({ page: "instance", id, tab }));
  await flush();
}

/** 在假后端里跑一局，以 exitCode 崩掉；崩溃报告由 mock 按会话日志与退出码生成。 */
async function crashWith(exitCode: number) {
  await launchGame({ taskId: `t-${exitCode}`, versionId: ID, accountUuid: null, offlineName: "Steve", offlineFallback: false, quickPlay: null });
  vi.setSystemTime(NOW - 60_000);
  endMockGame(exitCode, 30 * 60_000);
  vi.setSystemTime(NOW);
}

function textOf(node: Node): string {
  const t = node.textContent;
  if (t === null) throw new Error("节点没有文本内容");
  return t;
}

const text = () => textOf(document.body);

function buttons(name: string): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.getAttribute("aria-label") === name || b.textContent === name);
}

function button(name: string): HTMLButtonElement {
  const found = buttons(name);
  if (found.length !== 1) throw new Error(`按钮「${name}」有 ${found.length} 个`);
  return found[0];
}

function section(label: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`section[aria-label="${label}"]`);
  if (el === null) throw new Error(`找不到「${label}」一块`);
  return el;
}

function click(el: HTMLElement) {
  act(() => el.click());
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  resetRecorder(ipc);
  resetMocks();
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
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("崩溃诊断：停在本页重新运行", () => {
  const RUNNING = "游戏正在运行；如果再次崩溃，这里会换成新的诊断。";
  const STALE = "这是1 分钟前的崩溃，之后已经正常启动过。";

  /** 摘要卡顶部在场的说明（退场中的那层带 inert，不算）。 */
  function notes(): string[] {
    return [...document.querySelectorAll<HTMLElement>("[data-tone]")].filter((el) => el.closest("[inert]") === null && el.textContent !== null && /游戏正在运行|之后已经正常启动过/.test(el.textContent)).map(textOf);
  }

  async function relaunch() {
    ipc.overrides.set("launch_game", () => ({ pid: 42 }));
    await act(async () => {
      await launcher.actions.launch(ID);
      await settle(20);
    });
    expect(launcher.state.session?.phase).toBe("running");
  }

  function exit(crashed: boolean) {
    act(() => emit(GAME_EXIT_EVENT, { version_id: ID, exit_code: crashed ? 1 : 0, crashed, killed: false, duration_ms: 60_000 }));
  }

  it("正常退出后、实例列表还没报上新的上次游玩：说明直接换成过期态，不先撤走", async () => {
    await crashWith(1);
    await open("crash");
    expect(notes()).toEqual([]);
    await relaunch();
    expect(notes()).toEqual([RUNNING]);
    // 这里的假后端不知道这一局，重扫回来的上次游玩还是崩溃那一刻：正是重扫落定之前的那段空档
    exit(false);
    await flush();
    expect(notes()).toEqual([STALE]);
    // 会话停留期满被清空之后照旧
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    await flush();
    expect(launcher.state.session).toBeNull();
    expect(notes()).toEqual([STALE]);
  });

  it("又崩了一次：不说「之后已经正常启动过」，等新报告", async () => {
    await crashWith(1);
    await open("crash");
    await relaunch();
    exit(true);
    await flush();
    expect(notes()).toEqual([]);
  });

  it("又崩了一次、实例列表先于新报告回来：列表里的上次崩溃与上次游玩同为这次退出的时刻，同样不说「之后已经正常启动过」", async () => {
    await crashWith(1);
    await open("crash");
    await relaunch();
    // 后端在推送退出事件之前写好游玩记录与崩溃报告，两者都记这次退出的时刻；新报告的读取悬着，列表先回来
    ipc.overrides.set("list_instances", async () => {
      const list = await mockInvoke<InstanceDto[]>("list_instances");
      return list.map((i) => (i.id === ID ? { ...i, last_played_at: NOW, last_crash_at: NOW } : i));
    });
    const fresh = deferred<CrashReportDto | null>();
    ipc.overrides.set("last_crash", () => fresh.promise);
    exit(true);
    await flush();
    expect(launcher.state.instances.find((i) => i.id === ID)?.lastPlayedAt).toBe(NOW);
    expect(notes()).toEqual([]);
  });
});

describe("崩溃诊断：报告读得慢", () => {
  async function pass(ms: number) {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
    await flush();
  }

  function panel(): HTMLElement {
    const el = document.querySelector<HTMLElement>('[role="tabpanel"]');
    if (el === null) throw new Error("找不到标签面板");
    return el;
  }

  /** 面板里不在隐藏层、也不在退场层里的卡片。 */
  const liveCards = () => [...panel().querySelectorAll<HTMLElement>("[data-pad]")].filter((c) => c.closest('[aria-hidden="true"]') === null && c.closest("[inert]") === null);
  const hints = () => [...panel().querySelectorAll("p")].filter((p) => p.textContent === SLOW_LOADING_HINT);

  it("等待期里骨架卡不可见地占位，不先画一张空卡；读了 10 s 慢提示在骨架层外面；读到后原位换成摘要", async () => {
    await crashWith(1);
    const report = deferred<CrashReportDto | null>();
    ipc.overrides.set("last_crash", () => report.promise);
    await open("crash");
    const layer = panel().querySelector<HTMLElement>('[aria-busy="true"] > [aria-hidden="true"]');
    if (layer === null) throw new Error("报告没读到时应有骨架层");
    expect(layer.hasAttribute("data-pending")).toBe(true);
    expect(layer.querySelector("[data-pad]")).not.toBeNull();
    expect(liveCards()).toEqual([]);

    await pass(300);
    expect(layer.hasAttribute("data-pending")).toBe(false);
    expect(hints()).toEqual([]);
    await pass(10_000);
    expect(hints()).toHaveLength(1);
    expect(hints()[0].closest('[aria-hidden="true"]')).toBeNull();

    report.resolve(mockCrashReport(ID));
    await flush();
    await pass(300);
    expect(hints()).toEqual([]);
    const titles = [...panel().querySelectorAll("h2")].filter((h) => h.closest('[aria-hidden="true"]') === null && h.closest("[inert]") === null).map(textOf);
    expect(titles).toEqual([expect.stringContaining("找到 1 条线索")]);
  });
});

describe("崩溃诊断：一键尝试与「日志指向的 Mod」的加载占位", () => {
  /** 标题为 title 的卡片里那层加载容器；已经换成内容时为 null。 */
  function busy(title: string): HTMLElement | null {
    const heading = [...document.querySelectorAll("h3")].find((h) => h.textContent === title);
    const card = heading?.closest<HTMLElement>("[data-pad]");
    if (card === undefined || card === null) throw new Error(`找不到「${title}」卡`);
    return card.querySelector<HTMLElement>('[aria-busy="true"]');
  }

  /** 骨架层：是否还在等待期（看不见），以及按行画了几行。 */
  function skeleton(title: string): { pending: boolean; rows: number } {
    const layer = busy(title)?.querySelector<HTMLElement>(':scope > [aria-hidden="true"]');
    if (layer === undefined || layer === null || layer.firstElementChild === null) throw new Error(`「${title}」卡上没有骨架`);
    return { pending: layer.hasAttribute("data-pending"), rows: layer.firstElementChild.children.length };
  }

  /** 卡片里画出来的行（退场中的不算）。 */
  function rows(title: string): HTMLElement[] {
    const heading = [...document.querySelectorAll("h3")].find((h) => h.textContent === title);
    const card = heading?.closest<HTMLElement>("[data-pad]");
    if (card === undefined || card === null) throw new Error(`找不到「${title}」卡`);
    return [...card.querySelectorAll<HTMLElement>("ul > li:not([inert])")];
  }

  async function pass(ms: number) {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
    await flush();
  }

  function clue(category: CrashClueDto["category"]): CrashClueDto {
    return { category, summary: "", advice: "", detail: null, matched: "", line: 1, context: [], source: "session_log" };
  }

  it("一键尝试：300 ms 内只按行占位不显示，之后骨架行数与推出来的行一致，同类与共用处理办法的线索只算一行", async () => {
    await crashWith(-1073741819);
    ipc.overrides.set("last_crash", (args) => {
      const base = mockCrashReport(String(args.versionId));
      if (base === null) throw new Error("mock 里应有崩溃报告");
      // 内存一行；Intel 显卡驱动与进程异常退出共用一行处理办法；本机连接没有可做的；末尾对照完整日志
      const report: CrashReportDto = { ...base, diagnoses: [clue("out_of_memory"), clue("intel_graphics_driver"), clue("native_crash"), clue("loopback_unavailable"), clue("out_of_memory")] };
      return report;
    });
    const advice = deferred<ReturnType<typeof memoryAdviceDto>>();
    ipc.overrides.set("memory_advice", () => advice.promise);
    await open("crash");

    expect(skeleton("一键尝试")).toEqual({ pending: true, rows: 3 });
    await pass(300);
    expect(skeleton("一键尝试")).toEqual({ pending: false, rows: 3 });

    advice.resolve(memoryAdviceDto({ version_id: ID }));
    await flush();
    // 骨架出现后至少停留 300 ms
    expect(rows("一键尝试")).toHaveLength(0);
    await pass(300);
    expect(busy("一键尝试")).toBeNull();
    expect(rows("一键尝试")).toHaveLength(3);
  });

  it("日志指向的 Mod：扫盘没回来时按报告点名的条数画骨架，回来后行数不变", async () => {
    await crashWith(1);
    const PACK = "RLCraft";
    ipc.overrides.set("last_crash", () => {
      const base = mockCrashReport(ID);
      if (base === null) throw new Error("mock 里应有崩溃报告");
      const report: CrashReportDto = { ...base, diagnoses: [clue("mixin_failure")], suspects: [{ mod_id: "sodium", file_name: "sodium.jar" }, { mod_id: "ghost", file_name: null }] };
      return report;
    });
    const mods = deferred<InstalledMod[]>();
    ipc.overrides.set("list_mods", () => mods.promise);
    await open("crash", PACK);
    await pass(300);
    expect(skeleton("日志指向的 Mod")).toEqual({ pending: false, rows: 2 });

    mods.resolve([]);
    await pass(300);
    expect(busy("日志指向的 Mod")).toBeNull();
    expect(rows("日志指向的 Mod")).toHaveLength(2);
  });
});

describe("崩溃诊断：处理办法、完成态与「已停用」的进出", () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "instance.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  /** 选择器恰好是 selector 的那条规则的声明块。 */
  function rule(selector: string): string {
    for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) if (m[1].trim() === selector) return m[2];
    throw new Error(`样式表里没有 ${selector}`);
  }

  /** 文字里含 text 的那一行一键尝试。 */
  function fixRow(text: string): HTMLElement {
    const found = [...document.querySelectorAll<HTMLElement>("li:not([inert])")].filter((li) => li.querySelector(":scope > div") !== null && textOf(li).includes(text));
    if (found.length !== 1) throw new Error(`含「${text}」的一键尝试有 ${found.length} 行`);
    return found[0];
  }

  it("处理办法：展开时步骤从淡出处入场，收起后退场层不可交互；箭头始终是同一个朝下的图标，靠样式翻转", async () => {
    await crashWith(-1073741819);
    await open("crash");
    const toggle = button("查看处理办法");
    const arrow = () => {
      const path = toggle.querySelector(":scope > svg > path");
      if (path === null) throw new Error("处理办法按钮没有后置图标");
      return path.getAttribute("d");
    };
    expect(arrow()).toBe(ICON_PATHS["chevron-down"].s);

    click(toggle);
    await flush();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(arrow()).toBe(ICON_PATHS["chevron-down"].s);
    const steps = fixRow("没有自动修复").querySelector<HTMLElement>("ol");
    if (steps === null) throw new Error("展开后没有步骤");
    // 挂载那一刻是 insertItem 的起点：淡入、从略小处落到位
    expect(steps.parentElement?.style.opacity).toBe("0");

    click(toggle);
    await flush();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(steps.closest("[inert]")).not.toBeNull();

    expect(rule('.stepsToggle[aria-expanded="true"] > svg')).toMatch(/rotate:\s*180deg/);
    expect(rule(".stepsToggle > svg")).toMatch(/transition:\s*rotate var\(--sk-spring-settle-dur\) var\(--sk-spring-settle\)/);
    expect(rule(":global([data-sk-reduced]) .stepsToggle > svg")).toMatch(/transition:\s*none/);
  });

  it("一键尝试完成：图标位换成对勾、从 0.6 弹出，原图标原位淡出；颜色过渡到成功色", async () => {
    const waapi = stubSpanAnimations();
    await crashWith(-1073741819);
    ipc.overrides.set("last_crash", (args) => {
      const base = mockCrashReport(String(args.versionId));
      if (base === null) throw new Error("mock 里应有崩溃报告");
      const report: CrashReportDto = {
        ...base,
        diagnoses: [{ category: "intel_graphics_driver", summary: "", advice: "", detail: "ig9icd64.dll", matched: "# C  [ig9icd64.dll+0x57a41c]", line: 11, context: [], source: "hs_err" }],
      };
      return report;
    });
    await open("crash");
    const glyphs = () => [...fixRow("改用独立显卡").querySelectorAll<HTMLElement>("[data-glyph]")].map((g) => [g.dataset.glyph, g.dataset.enter, g.hasAttribute("data-leaving")]);
    // 挂载时就在的图标不单独入场
    expect(glyphs()).toEqual([["monitor", undefined, false]]);

    click(button("改用独立显卡"));
    await flush();
    expect(glyphs()).toEqual([
      ["monitor", undefined, true],
      ["check", "pop", false],
    ]);
    const layer = (glyph: string) => fixRow("改用独立显卡").querySelector(`[data-glyph="${glyph}"]`) as HTMLElement;
    expect(Number(waapi.running(layer("check"), "scale").frames[0].scale)).toBe(0.6);
    const fadeOut = waapi.running(layer("monitor"), "opacity");
    expect(fadeOut.frames).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    // 淡出播完才移除原图标
    waapi.finish(fadeOut);
    expect(glyphs()).toEqual([["check", "pop", false]]);
    expect(rule(".fixIcon")).toMatch(/transition:\s*color var\(--sk-dur-hover\) var\(--sk-ease\)/);
  });

  it("日志指向的 Mod：停用时「已停用」从淡出处弹入；挂载时就停用着的不弹", async () => {
    await crashWith(1);
    ipc.overrides.set("last_crash", () => {
      const base = mockCrashReport(ID);
      if (base === null) throw new Error("mock 里应有崩溃报告");
      const report: CrashReportDto = {
        ...base,
        diagnoses: [{ category: "mixin_failure", summary: "", advice: "", detail: null, matched: "", line: 1, context: [], source: "session_log" }],
        suspects: [
          { mod_id: "sodium", file_name: "sodium.jar" },
          { mod_id: "lithium", file_name: "lithium.jar" },
        ],
      };
      return report;
    });
    const mod = (fileName: string, name: string): InstalledMod => ({
      path: `D:/mc/versions/RLCraft/mods/${fileName}`,
      file_name: fileName,
      enabled: !fileName.endsWith(".disabled"),
      size: 1024,
      modified_ms: 1,
      metadata: { mod_id: name.toLowerCase(), name, version: "1.0.0", description: null, authors: [], depends: [], minecraft_version: null, icon: null, loader: "forge", format: "forge_toml" },
      icon_url: null,
      source: null,
    });
    ipc.overrides.set("list_mods", () => [mod("sodium.jar", "Sodium"), mod("lithium.jar.disabled", "Lithium")]);
    ipc.overrides.set("set_mod_enabled", (args) => `${String(args.fileName)}.disabled`);
    await open("crash", "RLCraft");

    /** 在场的「已停用」：属于哪一行、挂载那一刻是不是从透明起（入场的起点）。 */
    const tags = () =>
      [...document.querySelectorAll<HTMLElement>("li:not([inert])")]
        .flatMap((li) => [...li.querySelectorAll<HTMLElement>("span")].filter((s) => s.textContent === "已停用" && s.children.length === 0))
        .map((tag) => [textOf(tag.closest("li") as HTMLElement).includes("Sodium") ? "Sodium" : "Lithium", tag.parentElement?.style.opacity === "0"]);
    expect(tags()).toEqual([["Lithium", false]]);

    const toggle = document.querySelector<HTMLElement>('[role="switch"][aria-label="停用 Sodium"]');
    if (toggle === null) throw new Error("Sodium 那一行没有开关");
    click(toggle);
    await flush();
    expect(callsOf(ipc, "set_mod_enabled")).toEqual([{ versionId: "RLCraft", fileName: "sodium.jar", enabled: false }]);
    expect(tags()).toEqual([
      ["Sodium", true],
      ["Lithium", false],
    ]);
  });
});

describe("崩溃诊断：日志路径", () => {
  it("路径旁的「打开」去日志文件所在的目录，不是游戏自己的 logs：那里找不到这个文件", async () => {
    await crashWith(1);
    await open("crash");
    // 无线索的建议里还有一个同名按钮，跳到日志页；摘要卡在前
    click(buttons("打开")[0]);
    await flush();
    expect(callsOf(ipc, "open_folder")).toEqual([{ target: "session_logs", id: ID, world: null }]);
  });
});

describe("崩溃诊断：退出码兜底", () => {
  it("访问冲突且日志没有命中：一条进程异常退出线索，页头括注退出码说明，线索卡写退出码而不画日志框", async () => {
    await crashWith(-1073741819);
    await open("crash");
    expect(text()).toContain("1 分钟前崩溃 · 退出码 -1073741819（0xC0000005 访问冲突）");
    expect(text()).toContain("找到 1 条线索，退出码指向进程异常退出");
    expect(text()).not.toContain("日志指向进程异常退出");
    expect(text()).toContain("游戏进程异常退出");
    expect(text()).toContain(
      "退出码 0xC0000005（访问冲突），日志里没有匹配到已知原因。常见于显卡驱动、Java 本体或带本地库的 Mod，可以先更新显卡驱动，再换一个 Java 版本试试。",
    );
    const exitLine = [...document.querySelectorAll("code")].filter((c) => c.textContent === "退出码 -1073741819（0xC0000005）");
    expect(exitLine).toHaveLength(1);
    expect(text()).not.toContain("命中的日志行");
    // 一键尝试与显卡驱动共用处理办法，行标题是这条线索的类别
    expect(button("查看处理办法").getAttribute("aria-expanded")).toBe("false");
    expect(text()).toContain("进程异常退出没有自动修复，按下面三步排查");
  });

  it("紧急中止同样兜底；退出码 1 保留内存耗尽线索，只括注通用短语，行号不写来源名", async () => {
    await crashWith(-1073740791);
    const overrun = await lastCrash(ID);
    expect(overrun?.diagnoses.map((d) => [d.category, d.source, d.detail, d.line, d.matched])).toEqual([["native_crash", "exit_code", "0xC0000409", 0, ""]]);
    expect(overrun?.exit_code_note).toMatchObject({ code: -1073740791, hex: "0xC0000409", kind: "stack_buffer_overrun" });

    await crashWith(1);
    await open("crash");
    expect(text()).toContain("1 分钟前崩溃 · 退出码 1（0x00000001 报错退出）");
    expect(text()).toContain("找到 1 条线索，日志指向内存不足");
    const report = await lastCrash(ID);
    if (report === null) throw new Error("崩溃后应有报告");
    const clue = report.diagnoses[0];
    expect([clue.category, clue.source]).toEqual(["out_of_memory", "session_log"]);
    expect(text()).toContain(`命中的日志行 · 第 ${clue.line} 行`);
    expect(text()).not.toContain("0xC0000409");
  });

  it("表外的退出码：没有说明，页头照旧", async () => {
    await crashWith(3);
    const report = await lastCrash(ID);
    expect(report?.exit_code_note).toBeNull();
    await open("crash");
    expect(text()).toContain("1 分钟前崩溃 · 退出码 3");
    expect(text()).not.toContain("退出码 3（");
  });
});

describe("概览的崩溃横幅", () => {
  it("线索只来自退出码：写「退出码指向」，不说日志指向", async () => {
    await crashWith(-1073741819);
    await open("overview");
    expect(text()).toContain("退出码指向进程异常退出，诊断里有可以一键尝试的办法。");
    expect(text()).not.toContain("日志指向进程异常退出");
  });

  it("线索来自日志：照旧写「日志指向」", async () => {
    await crashWith(1);
    await open("overview");
    expect(text()).toContain("日志指向内存不足，诊断里有可以一键尝试的办法。");
  });
});

describe("崩溃诊断：手动触发的崩溃", () => {
  beforeEach(async () => {
    await crashWith(1);
    ipc.overrides.set("last_crash", (args) => {
      const base = mockCrashReport(String(args.versionId));
      if (base === null) throw new Error("mock 里应有崩溃报告");
      const report: CrashReportDto = {
        ...base,
        suspects: [],
        diagnoses: [
          {
            category: "manual_debug_crash",
            summary: "",
            advice: "",
            detail: null,
            matched: "Description: Manually triggered debug crash",
            line: 5,
            context: [],
            source: "crash_report",
          },
        ],
      };
      return report;
    });
  });

  it("页头写彩蛋，不画线索卡和一键尝试", async () => {
    await open("crash");
    expect(text()).toContain("你认真的吗...? 这是按住 F3+C 十秒手动触发的崩溃，游戏本身没有问题。");
    expect(text()).not.toContain("找到 1 条线索");
    expect(text()).not.toContain("日志指向");
    expect(text()).not.toContain("一键尝试");
    expect(text()).not.toContain("线索 1");
  });

  it("概览横幅不提一键尝试", async () => {
    await open("overview");
    expect(text()).toContain("这是按住 F3+C 十秒手动触发的崩溃，游戏本身没有问题。");
    expect(text()).not.toContain("诊断里有可以一键尝试的办法");
  });
});

describe("崩溃诊断：JVM 参数被拒", () => {
  it("点名被拒的参数，一键尝试把人带到实例设置", async () => {
    await crashWith(1);
    ipc.overrides.set("last_crash", (args) => {
      const base = mockCrashReport(String(args.versionId));
      if (base === null) throw new Error("mock 里应有崩溃报告");
      const report: CrashReportDto = {
        ...base,
        diagnoses: [
          {
            category: "jvm_args_invalid",
            summary: "",
            advice: "",
            detail: "NotARealFlag",
            matched: "Unrecognized VM option 'NotARealFlag'",
            line: 9,
            context: [],
            source: "session_log",
          },
        ],
      };
      return report;
    });
    await open("crash");
    expect(text()).toContain("找到 1 条线索，日志指向 JVM 参数有误");
    expect(text()).toContain("日志指向 JVM 参数 NotARealFlag，Java 不认它");
    click(button("打开实例设置"));
    await flush();
    expect(nav.route).toMatchObject({ page: "instance", id: ID, tab: "settings" });
  });
});

describe("崩溃诊断：Java 建不起本机连接", () => {
  it("线索卡照常画出解释与命中行，一键尝试只有对照完整日志，点了去日志页", async () => {
    await crashWith(1);
    ipc.overrides.set("last_crash", (args) => {
      const base = mockCrashReport(String(args.versionId));
      if (base === null) throw new Error("mock 里应有崩溃报告");
      const report: CrashReportDto = {
        ...base,
        diagnoses: [
          {
            category: "loopback_unavailable",
            summary: "",
            advice: "",
            detail: null,
            matched: "java.io.IOException: Unable to establish loopback connection",
            line: 42,
            context: [],
            source: "session_log",
          },
        ],
      };
      return report;
    });
    await open("crash");
    expect(text()).toContain("找到 1 条线索，日志指向本机连接失败");
    expect(text()).toContain("Java 建不起本机连接");
    expect(text()).toContain("写进临时目录的文件会被系统重定向，Java 连不上自己");
    expect(text()).toContain("java.io.IOException: Unable to establish loopback connection");
    expect(text()).toContain("命中的日志行 · 第 42 行");

    const fixes = [...document.querySelectorAll("li")].filter((li) => textOf(li).includes("对照完整日志"));
    expect(fixes).toHaveLength(1);
    const rows = [...(fixes[0].parentElement as HTMLElement).children];
    expect(rows).toHaveLength(1);
    click(fixes[0].querySelector("button") as HTMLButtonElement);
    await flush();
    expect(nav.route).toEqual({ page: "instance", id: ID, tab: "logs" });
  });
});

describe("崩溃诊断：参与扫描的文件", () => {
  it("两份文件各占一行、各有复制按钮，复制的是对应的完整路径；来源不是会话日志的线索写出来源名", async () => {
    await crashWith(-1073741819);
    // mock 不模拟 crash-reports 与 hs_err：在它生成的报告上补一份崩溃报告与一条 JVM 错误日志的线索
    ipc.overrides.set("last_crash", (args) => {
      const base = mockCrashReport(String(args.versionId));
      if (base === null) throw new Error("mock 里应有崩溃报告");
      const report: CrashReportDto = {
        ...base,
        scanned_files: [...base.scanned_files, { kind: "crash_report", path: CRASH_REPORT_PATH }],
        diagnoses: [
          {
            category: "intel_graphics_driver",
            summary: "",
            advice: "",
            detail: "ig9icd64.dll",
            matched: "C  [ig9icd64.dll+0x1a2b3]",
            line: 9,
            context: ["# Problematic frame:"],
            source: "hs_err",
          },
          ...base.diagnoses,
        ],
      };
      return report;
    });
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    await open("crash");

    const scanned = section("参与扫描的文件");
    const rows = [...scanned.querySelectorAll("li")];
    expect(rows.map((li) => [textOf(li.querySelector("span") as Element), textOf(li.querySelector("code") as Element)])).toEqual([
      ["会话日志", LOG_PATH],
      ["崩溃报告", CRASH_REPORT_PATH],
    ]);
    const copies = buttons("复制路径");
    expect(copies).toHaveLength(2);
    click(copies[1]);
    await flush();
    expect(writeText).toHaveBeenLastCalledWith(CRASH_REPORT_PATH);
    click(copies[0]);
    await flush();
    expect(writeText.mock.calls).toEqual([[CRASH_REPORT_PATH], [LOG_PATH]]);

    expect(text()).toContain("命中的日志行 · JVM 错误日志 第 9 行");
    // Intel 显卡驱动与进程异常退出只共用一条处理办法，标题取先出现的那一类；mock 是双显卡笔记本，这一行先提改用独立显卡
    expect(buttons("查看处理办法")).toHaveLength(1);
    expect(buttons("改用独立显卡")).toHaveLength(1);
    expect(text()).toContain("Intel 显卡驱动游戏可能跑在核显上，可以先改用独立显卡");
  });

  it("对粘贴文本的诊断没有扫描文件：整块不出现", async () => {
    await crashWith(-1073741819);
    ipc.overrides.set("last_crash", (args) => {
      const base = mockCrashReport(String(args.versionId));
      if (base === null) throw new Error("mock 里应有崩溃报告");
      return { ...base, scanned_files: [] };
    });
    await open("crash");
    expect(document.querySelector('section[aria-label="参与扫描的文件"]')).toBeNull();
    expect(buttons("复制路径")).toHaveLength(0);
  });
});

describe("崩溃诊断：这次启动时的提醒", () => {
  it("游戏目录在 OneDrive 里：标题、正文与「更换游戏目录」，点了去设置的游戏分区", async () => {
    setMockLaunchWarnings(["onedrive_folder"]);
    await crashWith(-1073741819);
    await open("crash");
    const warnings = section("这次启动时的提醒");
    expect(textOf(warnings)).toContain("游戏目录在 OneDrive 里");
    expect(textOf(warnings)).toContain("OneDrive 同步时会占用或替换正在读写的文件，存档与 Mod 可能读不全。可以换一个不在 OneDrive 里的游戏目录。");
    click(button("更换游戏目录"));
    await flush();
    expect(nav.route).toEqual({ page: "settings", section: "game" });
  });

  it("只有实例名含中文：按钮是「重命名实例」，点了就地改名，不去设置的游戏分区", async () => {
    setMockLaunchWarnings(["instance_name"]);
    await crashWith(-1073741819);
    await open("crash");
    expect(textOf(section("这次启动时的提醒"))).toContain("实例名含中文或特殊字符");
    expect(buttons("更换游戏目录")).toHaveLength(0);
    click(button("重命名实例"));
    await flush();
    expect(nav.route).toEqual({ page: "instance", id: ID, tab: "crash" });
    const input = document.querySelector<HTMLInputElement>('input[aria-label="实例名称"]');
    if (input === null) throw new Error("没有进入改名");
    expect(document.activeElement).toBe(input);
  });

  it("游戏又跑起来时改不了名：按钮带原因禁用，点了不进改名", async () => {
    setMockLaunchWarnings(["instance_name"]);
    await crashWith(-1073741819);
    await open("crash");
    ipc.overrides.set("launch_game", () => ({ pid: 42 }));
    await act(async () => {
      await launcher.actions.launch(ID);
      await settle(20);
    });
    expect(launcher.state.session?.phase).toBe("running");
    const rename = button("重命名实例");
    expect(rename.dataset.disabled).toBe("true");
    click(rename);
    await flush();
    expect(document.querySelector('input[aria-label="实例名称"]')).toBeNull();
  });

  it("本地库缺失又有实例名提醒：一键尝试里也给重命名，不给更换游戏目录", async () => {
    ipc.overrides.set("last_crash", (args) => {
      const base = mockCrashReport(String(args.versionId));
      if (base === null) throw new Error("应已有崩溃报告");
      const report: CrashReportDto = {
        ...base,
        warnings: ["instance_name"],
        diagnoses: [{ category: "native_library_missing", summary: "", advice: "", detail: null, matched: "UnsatisfiedLinkError", line: 3, context: [], source: "session_log" }],
      };
      return report;
    });
    await crashWith(-1073741819);
    await open("crash");
    expect(buttons("重命名实例")).toHaveLength(2);
    expect(buttons("更换游戏目录")).toHaveLength(0);
  });

  it("角色名过长去账户页，JVM 内存写法去实例的设置标签", async () => {
    setMockLaunchWarnings(["long_player_name", "jvm_max_too_low"]);
    await crashWith(-1073741819);
    await open("crash");
    expect(textOf(section("这次启动时的提醒"))).toContain("最大内存低于 512 MB");
    click(button("打开实例设置"));
    await flush();
    expect(nav.route).toEqual({ page: "instance", id: ID, tab: "settings" });
    act(() => nav.go({ page: "instance", id: ID, tab: "crash" }));
    await flush();
    click(button("管理账户"));
    await flush();
    expect(nav.route).toEqual({ page: "accounts" });
  });

  it("多条提醒逐行列出、不用局部提示框：一张卡片至多一条局部提示，留给过期与再次运行的说明", async () => {
    setMockLaunchWarnings(["onedrive_folder", "long_player_name", "jvm_min_over_max"]);
    await crashWith(-1073741819);
    await open("crash");
    const warnings = section("这次启动时的提醒");
    expect(warnings.querySelectorAll("div[data-tone]")).toHaveLength(0);
    const rows = [...warnings.querySelectorAll("li")];
    expect(rows.map((li) => [li.querySelector("svg") !== null, textOf(li.querySelector("button") as Element)])).toEqual([
      [true, "更换游戏目录"],
      [true, "管理账户"],
      [true, "打开实例设置"],
    ]);
    expect(textOf(rows[2])).toContain("最小内存大于最大内存");
    expect(textOf(rows[2])).toContain("JVM 参数里 -Xms 比 -Xmx 大，Java 会拒绝启动。");
  });

  it("提醒只跟下一份报告走：再崩一次就没有了，整块不出现", async () => {
    setMockLaunchWarnings(["icloud_folder"]);
    await crashWith(-1073741819);
    expect((await lastCrash(ID))?.warnings).toEqual(["icloud_folder"]);
    await crashWith(-1073741819);
    expect((await lastCrash(ID))?.warnings).toEqual([]);
    await open("crash");
    expect(document.querySelector('section[aria-label="这次启动时的提醒"]')).toBeNull();
    expect(buttons("更换游戏目录")).toHaveLength(0);
  });
});

describe("崩溃诊断：改用独立显卡", () => {
  /** mock 崩溃报告里记的那个 java。 */
  const JAVA = "C:/Program Files/Java/jdk-21/bin/java.exe";
  const MANUAL_STEP = "把 java.exe 设为「高性能」";
  const CLUES: Readonly<Record<"graphics_driver" | "intel_graphics_driver", CrashClueDto>> = {
    graphics_driver: {
      category: "graphics_driver",
      summary: "",
      advice: "",
      detail: null,
      matched: "[LWJGL] GLFW_API_UNAVAILABLE error: WGL: The driver does not appear to support OpenGL",
      line: 57,
      context: [],
      source: "session_log",
    },
    intel_graphics_driver: {
      category: "intel_graphics_driver",
      summary: "",
      advice: "",
      detail: "ig9icd64.dll",
      matched: "# C  [ig9icd64.dll+0x57a41c]",
      line: 11,
      context: [],
      source: "hs_err",
    },
  };

  /** 下一次读到的崩溃报告只有这一条显卡线索，其余照 mock 生成的报告。 */
  function crashOnGraphics(category: keyof typeof CLUES) {
    ipc.overrides.set("last_crash", (args) => {
      const base = mockCrashReport(String(args.versionId));
      if (base === null) throw new Error("mock 里应有崩溃报告");
      const report: CrashReportDto = { ...base, diagnoses: [CLUES[category]] };
      return report;
    });
  }

  function toasts() {
    return launcher.state.toasts.map((t) => [t.tone, t.title, t.body]);
  }

  it("Intel 核显驱动崩溃、双显卡、独显偏好没开：点了写下这次的 java、打开独显偏好，行变完成态，处理办法还留着", async () => {
    await crashWith(-1073741819);
    crashOnGraphics("intel_graphics_driver");
    await open("crash");
    expect(text()).toContain("游戏可能跑在核显上，可以先改用独立显卡");

    click(button("改用独立显卡"));
    await flush();

    expect(callsOf(ipc, "switch_to_dedicated_gpu")).toEqual([{ javaPath: JAVA }]);
    expect((await getConfig()).prefer_dedicated_gpu).toBe(true);
    // 设置跟着重读：设置页的开关会是开着的
    expect(launcher.state.settings?.preferDedicatedGpu).toBe(true);
    expect(toasts()).toContainEqual([
      "success",
      "已改用独立显卡",
      "下次启动游戏时用 NVIDIA GeForce RTX 4060 Laptop GPU。要改回，见设置 Java 分区的「显卡」。",
    ]);
    expect(text()).toContain("已改用独立显卡，下次启动生效");
    expect(buttons("改用独立显卡")).toHaveLength(0);
    // 改设置的一键尝试才给撤销；这一条要改回走设置页的开关
    expect(buttons("撤销")).toHaveLength(0);

    click(button("查看处理办法"));
    await flush();
    expect(text()).toContain("到显卡厂商官网更新驱动");
    expect(text()).not.toContain(MANUAL_STEP);
    expect(buttons("复制 java.exe 路径")).toHaveLength(0);
  });

  it("系统偏好写不进去：报出原因，不进完成态，独显偏好保持关着", async () => {
    await crashWith(-1073741819);
    crashOnGraphics("graphics_driver");
    ipc.overrides.set("switch_to_dedicated_gpu", () => {
      throw new IpcError("io", `写入 ${JAVA} 的显卡偏好失败`, { path: JAVA, causes: ["拒绝访问。 (os error 5)"] });
    });
    await open("crash");

    click(button("改用独立显卡"));
    await flush();

    expect(callsOf(ipc, "switch_to_dedicated_gpu")).toEqual([{ javaPath: JAVA }]);
    expect(toasts()).toContainEqual(["error", "没能改用独立显卡", `写入 ${JAVA} 的显卡偏好失败`]);
    expect(text()).not.toContain("已改用独立显卡");
    expect(buttons("改用独立显卡")).toHaveLength(1);
    expect((await getConfig()).prefer_dedicated_gpu).toBe(false);
    expect(launcher.state.settings?.preferDedicatedGpu).toBe(false);
  });

  it("只有一块显卡：不出按钮，处理办法照旧写手动设高性能和 java 路径", async () => {
    setMockGpuAdapters({
      adapters: [{ name: "AMD Radeon RX 7800 XT", vendor_id: 0x1002, dedicated_video_memory_mb: 16368, high_performance: true, power_saving: true }],
      switchable: false,
    });
    await crashWith(-1073741819);
    crashOnGraphics("graphics_driver");
    await open("crash");

    expect(callsOf(ipc, "gpu_adapters")).toHaveLength(1);
    expect(buttons("改用独立显卡")).toHaveLength(0);
    expect(text()).toContain("没有自动修复，按下面三步排查");
    click(button("查看处理办法"));
    await flush();
    expect(text()).toContain(MANUAL_STEP);
    expect(buttons("复制 java.exe 路径")).toHaveLength(1);
  });

  it("独显偏好已经开着：不出按钮", async () => {
    await updateConfig({ preferDedicatedGpu: true });
    await crashWith(-1073741819);
    crashOnGraphics("intel_graphics_driver");
    await open("crash");

    expect(buttons("改用独立显卡")).toHaveLength(0);
    expect(buttons("查看处理办法")).toHaveLength(1);
    expect(callsOf(ipc, "switch_to_dedicated_gpu")).toHaveLength(0);
  });

  it("没有显卡线索的崩溃不去读显卡信息，也不出按钮", async () => {
    await crashWith(-1073741819);
    await open("crash");

    expect(text()).toContain("进程异常退出");
    expect(buttons("查看处理办法")).toHaveLength(1);
    expect(buttons("改用独立显卡")).toHaveLength(0);
    expect(callsOf(ipc, "gpu_adapters")).toHaveLength(0);
  });

  it("读不到显卡信息：一键尝试整卡说读不到显卡信息，重试读到了才出按钮", async () => {
    await crashWith(-1073741819);
    crashOnGraphics("graphics_driver");
    ipc.overrides.set("gpu_adapters", () => {
      throw new IpcError("gpu_query_failed", "读不到显卡信息：不支持此接口", { hresult: "0x80004002" });
    });
    await open("crash");

    expect(text()).toContain("读不到显卡信息");
    expect(buttons("改用独立显卡")).toHaveLength(0);
    expect(buttons("对照完整日志")).toHaveLength(0);

    ipc.overrides.delete("gpu_adapters");
    click(button("重试"));
    await flush();
    expect(callsOf(ipc, "gpu_adapters")).toHaveLength(2);
    expect(buttons("改用独立显卡")).toHaveLength(1);
  });
});
