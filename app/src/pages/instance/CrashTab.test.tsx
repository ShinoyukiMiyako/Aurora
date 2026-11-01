// @vitest-environment jsdom
// 崩溃诊断标签跑在假后端上：先在 mock 里启动并让游戏以指定退出码崩掉，再打开诊断页看报告怎么画出来。
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../art/illustrations/test-canvas";
import { lastCrash, type CrashReportDto } from "../../ipc/diagnostics";
import { launchGame } from "../../ipc/launch";
import { resetMocks } from "../../ipc/mock";
import { endMockGame, mockCrashReport, setMockLaunchWarnings } from "../../ipc/mock/handlers/launch";
import { OverlayRoot } from "../../shell/overlay";
import { ShellProvider, useNav, type NavApi } from "../../shell/shell";
import { LauncherProvider, useLauncher, type LauncherApi } from "../../state/launcher";
import { routeKey, type InstanceTab } from "../../state/route";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { callsOf, resetRecorder, settle } from "../../test/launcher";
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
    <LauncherProvider>
      <ShellProvider>
        <RemoteImageProvider resolve={(url) => Promise.resolve(url)}>
          {children}
          <OverlayRoot />
        </RemoteImageProvider>
      </ShellProvider>
    </LauncherProvider>
  );
}

const flush = () =>
  act(async () => {
    await settle(20);
  });

async function open(tab: InstanceTab) {
  view = render(
    <Providers>
      <Probe />
      <Routed />
    </Providers>,
  );
  await flush();
  act(() => nav.go({ page: "instance", id: ID, tab }));
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
    // Intel 显卡驱动与进程异常退出只共用一条处理办法，标题取先出现的那一类
    expect(buttons("查看处理办法")).toHaveLength(1);
    expect(text()).toContain("Intel 显卡驱动没有自动修复，按下面三步排查");
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
