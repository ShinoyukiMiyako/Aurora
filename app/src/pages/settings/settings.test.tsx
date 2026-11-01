// @vitest-environment jsdom
// @module-tag heavy-page
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COPY_FEEDBACK_MS } from "../../domain/limits";
import { IpcError } from "../../ipc/errors";
import { APP_NAME_EN, ISSUES_URL, REPO_URL } from "../../lib/app-info";
import { mockInvoke, resetMocks } from "../../ipc/mock";
import { OverlayRoot } from "../../shell/overlay";
import { ShellProvider, useNav, type NavApi } from "../../shell/shell";
import { UpdatePanelMount } from "../../shell/UpdatePanel";
import { AppearanceProvider, DEFAULT_APPEARANCE } from "../../state/appearance";
import { LauncherProvider, useLauncher, type LauncherApi } from "../../state/launcher";
import { stubCanvas } from "../../art/illustrations/test-canvas";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { callsOf, instanceDto, resetRecorder, settle } from "../../test/launcher";
import { SettingsCommandsProvider, type SettingsCommands } from "./commands";
import SettingsPage from "./index";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));

let view: Rendered | undefined;
let nav: NavApi;
let launcher: LauncherApi;
let commands: SettingsCommands & { calls: string[] };

function Harness() {
  nav = useNav();
  launcher = useLauncher();
  return nav.route.page === "settings" ? <SettingsPage route={nav.route} /> : null;
}

function fakeCommands(): SettingsCommands & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    pickDirectory: async () => {
      calls.push("pick");
      return "D:\\Modded\\.minecraft";
    },
    addGameDirectory: async (name, path) => {
      calls.push(`add:${name}:${path}`);
    },
    removeGameDirectory: async (path) => {
      calls.push(`remove:${path}`);
    },
    openDataDirectory: async () => {
      calls.push("open-data");
    },
    openLauncherLogs: async () => {
      calls.push("open-logs");
    },
  };
}

const flush = () =>
  act(async () => {
    await settle(20);
  });

async function mount(section?: "general" | "download" | "java" | "game" | "appearance" | "about") {
  view = render(
    <AppearanceProvider initial={DEFAULT_APPEARANCE}>
      <LauncherProvider>
        <ShellProvider>
          <SettingsCommandsProvider value={commands}>
            <Harness />
          </SettingsCommandsProvider>
          <UpdatePanelMount />
          <OverlayRoot />
        </ShellProvider>
      </LauncherProvider>
    </AppearanceProvider>,
  );
  await flush();
  act(() => nav.go(section === undefined ? { page: "settings" } : { page: "settings", section }));
  await flush();
}

function all<E extends Element = HTMLElement>(selector: string): E[] {
  return [...document.querySelectorAll<E>(selector)];
}

/** 按可见文字或无障碍名称找按钮（含 role=radio / switch / combobox 的按钮）。 */
function button(name: string): HTMLButtonElement {
  const found = all<HTMLButtonElement>("button").find((b) => b.getAttribute("aria-label") === name || b.textContent?.trim() === name);
  if (found === undefined) throw new Error(`找不到按钮「${name}」`);
  return found;
}

/** 打开着的弹窗（退场动画中的不算：假定时器下动画不会走完，节点会留在文档里）。 */
const OPEN_DIALOG = '[data-sk-modal-layer]:not([data-exiting]) [role="dialog"]';
const openDialogs = () => all(OPEN_DIALOG);

/** 分区内容里的按钮（与导航项同名时用它，例如「下载」）。 */
function contentButton(name: string): HTMLButtonElement {
  const found = all<HTMLButtonElement>('[role="region"] button').find((b) => b.textContent?.trim() === name);
  if (found === undefined) throw new Error(`分区内容里找不到按钮「${name}」`);
  return found;
}

/** 分区导航项：名称后面跟着一行说明，按名称开头匹配。 */
function navItem(label: string): HTMLButtonElement {
  const found = all<HTMLButtonElement>('nav[aria-label="设置分区"] button').find((b) => b.textContent?.startsWith(label));
  if (found === undefined) throw new Error(`找不到分区「${label}」`);
  return found;
}

/** 单选项按标题开头匹配（说明里可能也提到别的选项名）。 */
function radio(name: string): HTMLButtonElement {
  const found = all<HTMLButtonElement>('[role="radio"]').find((b) => b.textContent?.startsWith(name));
  if (found === undefined) throw new Error(`找不到单选项「${name}」`);
  return found;
}

/** 设置行里的按钮：按行标题找到那一行，再按按钮文字找。 */
function rowButton(title: string, label: string): HTMLButtonElement {
  const row = all('[class*="row"]').find((r) => r.firstElementChild?.firstElementChild?.textContent === title);
  if (row === undefined) throw new Error(`找不到设置行「${title}」`);
  const found = [...row.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label);
  if (found === undefined) throw new Error(`设置行「${title}」里没有按钮「${label}」`);
  return found;
}

/** 按卡片标题找卡片（CardHeader 的标题是卡内第一个标题元素）。 */
function section(title: string): HTMLElement {
  const heading = all("h2, h3").find((h) => h.textContent === title);
  const card = heading?.closest<HTMLElement>('[class*="card"]');
  if (card === undefined || card === null) throw new Error(`找不到卡片「${title}」`);
  return card;
}

const BUILD = { version: "0.3.0-preview.2", channel: "preview", builtAt: "2026-10-30T08:15:30.000Z" } as const;

const MANIFEST = {
  packages: [
    { ecosystem: "npm", name: "@fontsource-variable/outfit", version: "5.3.0", license: "OFL-1.1" },
    { ecosystem: "npm", name: "react", version: "19.1.0", license: "MIT" },
    { ecosystem: "cargo", name: "serde", version: "1.0.219", license: "MIT OR Apache-2.0" },
  ],
};

const click = async (el: HTMLElement) => {
  act(() => el.click());
  await flush();
};

const text = () => document.body.textContent ?? "";
const toasts = () => launcher.state.toasts.map((t) => ({ tone: t.tone, title: t.title, body: t.body }));

beforeEach(() => {
  vi.useFakeTimers();
  resetMocks();
  resetRecorder(ipc);
  stubResizeObserver();
  stubMatchMedia(false);
  stubCanvas();
  commands = fakeCommands();
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  document.documentElement.removeAttribute("data-sk-mode");
  document.documentElement.removeAttribute("data-sk-accent");
  vi.useRealTimers();
});

describe("设置页：骨架与分区导航", () => {
  it("缺省进「常规」；点导航换分区用 replace，后退直接回到进设置之前的页面", async () => {
    await mount();
    expect(document.querySelector("#settings-title")?.textContent).toBe("设置");
    expect(text()).toContain("常规 · 改动立即生效");
    expect(navItem("常规").getAttribute("aria-current")).toBe("page");
    await click(navItem("Java"));
    expect(nav.route).toEqual({ page: "settings", section: "java" });
    expect(text()).toContain("Java · 改动立即生效");
    expect(text()).toContain("Java 运行时");
    act(() => nav.back());
    expect(nav.route).toEqual({ page: "home" });
  });

  it("分区导航每项写名称与一行说明，「常规」的说明涵盖启动后行为与语言", async () => {
    await mount();
    const items = all<HTMLButtonElement>('nav[aria-label="设置分区"] button').slice(0, 5);
    expect(items.map((b) => b.textContent)).toEqual(["常规启动后行为、语言", "下载下载源与速度", "Java运行时与自动选择", "游戏内存、隔离与目录", "外观明暗、强调色、花瓣、动画"]);
  });

  it("配置读不出来：内容列是错误卡，导航照常可点；重试成功后显示分区", async () => {
    let fail = true;
    ipc.overrides.set("get_config", async (args) => {
      if (fail) throw new IpcError("config_invalid", "config.json 第 3 行格式不对");
      const { mockInvoke } = await import("../../ipc/mock");
      return mockInvoke("get_config", args);
    });
    await mount();
    expect(text()).toContain("配置载入失败");
    expect(text()).toContain("config.json 第 3 行格式不对");
    await click(navItem("下载"));
    expect(nav.route).toEqual({ page: "settings", section: "download" });
    fail = false;
    await click(button("重试"));
    expect(text()).not.toContain("配置载入失败");
    expect(radio("镜像源优先").getAttribute("aria-checked")).toBe("false");
  });
});

describe("设置页：常规", () => {
  it("改「游戏启动后」立即写入后端，说明随选项变化（关闭启动器时为警示）", async () => {
    await mount("general");
    expect(radio("最小化").getAttribute("aria-checked")).toBe("true");
    await click(radio("关闭启动器"));
    expect(callsOf(ipc, "update_config")).toEqual([{ afterLaunch: "close" }]);
    expect(radio("关闭启动器").getAttribute("aria-checked")).toBe("true");
    const desc = all("span[data-tone='warn']").map((e) => e.textContent);
    expect(desc).toContain("游戏启动后启动器退出，游戏日志与崩溃诊断将不可用");
  });

  it("写入失败：控件回到原值，error 通知标题点名设置项、正文给原因", async () => {
    ipc.overrides.set("update_config", () => {
      throw new IpcError("config_io", "磁盘已满");
    });
    await mount("general");
    await click(radio("保持打开"));
    expect(radio("最小化").getAttribute("aria-checked")).toBe("true");
    expect(radio("保持打开").getAttribute("aria-checked")).toBe("false");
    expect(toasts()).toContainEqual({ tone: "error", title: "没能保存「游戏启动后」", body: "磁盘已满" });
  });

  it("client_id：展开输入、保存后写入并提示，不回显已保存的值", async () => {
    await mount("general");
    expect(text()).toContain("已配置");
    await click(button("修改"));
    const input = document.querySelector<HTMLInputElement>('input[aria-label="微软登录 client_id"]');
    if (input === null) throw new Error("没有展开 client_id 输入框");
    expect(input.placeholder).toBe("输入以覆盖现有 client_id");
    expect(button("保存").disabled).toBe(true);
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "  00000000-aaaa-bbbb-cccc-000000000001 ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button("保存"));
    expect(callsOf(ipc, "update_config")).toEqual([{ clientId: "00000000-aaaa-bbbb-cccc-000000000001" }]);
    expect(toasts()).toContainEqual({ tone: "success", title: "client_id 已保存", body: undefined });
    expect(document.querySelector('input[aria-label="微软登录 client_id"]')).toBeNull();
  });

  it("client_id：保存还没回来时再按 Enter 不重复写入，只提示一次", async () => {
    await mount("general");
    await click(button("修改"));
    const input = document.querySelector<HTMLInputElement>('input[aria-label="微软登录 client_id"]');
    if (input === null) throw new Error("没有展开 client_id 输入框");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "00000000-aaaa-bbbb-cccc-000000000002");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const pending: (() => void)[] = [];
    ipc.overrides.set("update_config", () => new Promise<null>((resolve) => pending.push(() => resolve(null))));
    for (let i = 0; i < 3; i++) act(() => void input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await flush();
    expect(callsOf(ipc, "update_config")).toEqual([{ clientId: "00000000-aaaa-bbbb-cccc-000000000002" }]);
    for (const resolve of pending) act(() => resolve());
    await flush();
    expect(toasts().filter((t) => t.title === "client_id 已保存")).toHaveLength(1);
  });
});

describe("设置页：下载", () => {
  it("下载源三档、版本列表源、队列状态", async () => {
    await mount("download");
    expect(radio("自动").getAttribute("aria-checked")).toBe("true");
    await click(radio("镜像源优先"));
    expect(callsOf(ipc, "update_config")).toEqual([{ downloadSource: "mirror_first" }]);
    await click(button("版本列表源"));
    const option = all('[role="option"]').find((o) => o.textContent?.includes("官方源优先"));
    if (option === undefined) throw new Error("没有展开版本列表源");
    await click(option);
    expect(callsOf(ipc, "update_config")).toEqual([{ downloadSource: "mirror_first" }, { versionListSource: "official_first" }]);
    expect(text()).toContain("队列空闲");
    await click(button("查看任务"));
    expect(nav.route).toEqual({ page: "tasks" });
  });
});

describe("设置页：Java", () => {
  beforeEach(() => {
    ipc.overrides.set("list_instances", () => [
      instanceDto("生存", { java_major: 21 }),
      instanceDto("怀旧", { java_major: 8, mc_version: "1.12.2" }),
      instanceDto("新快照", { java_major: 25, mc_version: "26.1" }),
    ]);
  });

  it("列出探测到的运行时与需要它的实例数；缺的主版本按自动下载开关给出提醒", async () => {
    await mount("java");
    expect(radio("自动选择").getAttribute("aria-checked")).toBe("true");
    expect(text()).toContain("按每个实例的游戏版本挑选匹配的主版本：Java 25 / Java 21 / Java 8，缺哪个就自动下载哪个。");
    expect(text()).toContain("1 个实例需要 Java 21");
    expect(text()).toContain("还缺 Java 25，首次启动对应实例时会自动下载。");
    await click(button("自动下载 Java"));
    expect(callsOf(ipc, "update_config")).toEqual([{ autoDownloadJava: false }]);
    expect(text()).toContain("还缺 Java 25，对应实例会启动失败。可以在下面手动下载，或打开「自动下载 Java」。");
  });

  it("一个运行时都没扫到：列表位置换成空状态，缺版本的提醒照常出现", async () => {
    ipc.overrides.set("detect_java", () => []);
    await mount("java");
    expect(text()).toContain("没有在本机找到 Java");
    expect(text()).toContain("首次启动时会自动下载");
    expect(text()).toContain("还缺 Java 25、Java 21、Java 8，首次启动对应实例时会自动下载。");
    expect(all('[role="radio"]')).toEqual([]);
  });

  it("固定成某个运行时：写入路径并出现固定提醒", async () => {
    await mount("java");
    await click(radio("Java 8"));
    expect(callsOf(ipc, "update_config")).toEqual([{ defaultJava: "C:\\Program Files\\Java\\jre1.8.0_421\\bin\\java.exe" }]);
    expect(radio("Java 8").getAttribute("aria-checked")).toBe("true");
    expect(text()).toContain("固定成单一 Java 后，要求其他主版本的实例");
  });

  describe("固定的默认 Java 已不在扫描结果里", () => {
    const JRE8 = "C:\\Program Files\\Java\\jre1.8.0_421\\bin\\java.exe";
    const JDK21 = "C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.5.11-hotspot\\bin\\java.exe";
    const jdk21 = {
      path: JDK21,
      version: { major: 21, minor: 0, security: 5, build: 11, raw: "21.0.5" },
      is_64bit: true,
      vendor: "Eclipse Adoptium",
      source: "registry",
    };
    const warnTitle = "默认 Java 已经找不到了，跟随全局的实例会启动失败";

    beforeEach(async () => {
      // 先在假后端里固定 Java 8，再让扫描只报出 Java 21：等于那个 Java 8 被卸载了
      await mockInvoke("update_config", { defaultJava: JRE8 });
    });

    it("列表一项都不选中，给出带路径的专门提醒，「改回自动选择」写回 auto", async () => {
      ipc.overrides.set("detect_java", () => [jdk21]);
      await mount("java");
      expect(all('[role="radio"]').map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "false"]);
      const alert = all('[role="alert"]').find((el) => el.textContent?.includes(warnTitle));
      if (alert === undefined) throw new Error("没有出现固定 Java 找不到的提醒");
      expect(alert.textContent).toContain(JRE8);
      expect(text()).not.toContain("固定成单一 Java 后");
      expect([...alert.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["改回自动选择", "重新选择"]);

      await click(button("改回自动选择"));
      expect(callsOf(ipc, "update_config")).toEqual([{ defaultJava: "auto" }]);
      expect(radio("自动选择").getAttribute("aria-checked")).toBe("true");
      expect(text()).not.toContain(warnTitle);
    });

    it("「重新选择」把焦点移到列表里第一个运行时，不改写设置", async () => {
      ipc.overrides.set("detect_java", () => [jdk21]);
      await mount("java");
      await click(button("重新选择"));
      expect(document.activeElement).toBe(radio("Java 21"));
      expect(callsOf(ipc, "update_config")).toEqual([]);
      expect(text()).toContain(warnTitle);
    });

    it("一个运行时都没扫到：只给「改回自动选择」，没有可重新选的", async () => {
      ipc.overrides.set("detect_java", () => []);
      await mount("java");
      expect(text()).toContain("没有在本机找到 Java");
      const alert = all('[role="alert"]').find((el) => el.textContent?.includes(warnTitle));
      if (alert === undefined) throw new Error("没有出现固定 Java 找不到的提醒");
      expect(alert.textContent).toContain(JRE8);
      expect([...alert.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["改回自动选择"]);
    });
  });

  it("重新扫描：再发一次探测，完成后报告找到的个数", async () => {
    await mount("java");
    expect(callsOf(ipc, "detect_java")).toHaveLength(1);
    await click(button("重新扫描"));
    expect(callsOf(ipc, "detect_java")).toHaveLength(2);
    expect(toasts()).toContainEqual({ tone: "success", title: "扫描完成，找到 2 个 Java 运行时", body: undefined });
  });

  it("下载运行时：按选中的主版本入队一个 Java 任务", async () => {
    await mount("java");
    expect(button("要下载的主版本").textContent).toContain("Java 25");
    await click(contentButton("下载"));
    const java = launcher.state.tasks.filter((t) => t.kind === "java" && t.status !== "done");
    expect(java.map((t) => t.spec)).toEqual([{ command: "install_java", args: { requiredMajor: 25 } }]);
    expect(toasts()).toContainEqual({ tone: "info", title: "已加入下载队列：Java 25", body: undefined });
  });
});

describe("设置页：游戏", () => {
  it("内存：数据来自内存建议；关掉自动分配写入整组内存设置", async () => {
    await mount("game");
    expect(text()).toContain("本机共 16 GB，这里是所有实例的默认值");
    expect(text()).toContain("当前按「原版」档给 3.8 GB");
    expect(text()).toContain("现在空闲 9 GB");
    await click(button("自动分配"));
    expect(callsOf(ipc, "update_config")).toEqual([{ memory: { max_mb: 4096, min_mb: null, auto: false } }]);
  });

  it("内存：关掉自动分配还没写完就调最大内存，第二次写入沿用「关」，不把自动分配写回去", async () => {
    await mount("game");
    const pending: (() => void)[] = [];
    ipc.overrides.set("update_config", () => new Promise<null>((resolve) => pending.push(() => resolve(null))));
    await click(button("自动分配"));
    const slider = document.querySelector<HTMLInputElement>('input[type="range"][aria-label="最大内存"]');
    if (slider === null) throw new Error("没有最大内存滑杆");
    expect(slider.disabled).toBe(false);
    act(() => void slider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(callsOf(ipc, "update_config")).toEqual([
      { memory: { max_mb: 4096, min_mb: null, auto: false } },
      { memory: { max_mb: 4608, min_mb: null, auto: false } },
    ]);
    for (const resolve of pending) act(() => resolve());
    await flush();
  });

  it("内存：调了最大内存还没写完就打开自动分配，开关这次写入带上刚调的值", async () => {
    await mockInvoke("update_config", { memory: { max_mb: 4096, min_mb: null, auto: false } });
    await mount("game");
    const pending: (() => void)[] = [];
    ipc.overrides.set("update_config", () => new Promise<null>((resolve) => pending.push(() => resolve(null))));
    const slider = document.querySelector<HTMLInputElement>('input[type="range"][aria-label="最大内存"]');
    if (slider === null) throw new Error("没有最大内存滑杆");
    act(() => void slider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    await click(button("自动分配"));
    expect(callsOf(ipc, "update_config")).toEqual([
      { memory: { max_mb: 4608, min_mb: null, auto: false } },
      { memory: { max_mb: 4608, min_mb: null, auto: true } },
    ]);
    for (const resolve of pending) act(() => resolve());
    await flush();
  });

  it("其他文件夹：切换前二次确认，确认后切换并刷新列表；访问不到的不能切；移除只删记录", async () => {
    let dirs = [
      { name: "默认目录", path: "D:\\Games\\Launcher\\.minecraft", is_current: true, available: true },
      { name: "HMCL", path: "D:\\HMCL\\.minecraft", is_current: false, available: true },
      { name: "移动硬盘", path: "F:\\.minecraft", is_current: false, available: false },
    ];
    ipc.overrides.set("list_game_directories", () => dirs);
    await mount("game");
    const listCalls = callsOf(ipc, "list_game_directories").length;
    const switches = all<HTMLButtonElement>("button").filter((b) => b.textContent === "切换");
    expect(switches).toHaveLength(2);
    expect(switches[1].getAttribute("aria-disabled")).toBe("true");
    await click(switches[1]);
    expect(openDialogs()).toEqual([]);

    await click(switches[0]);
    expect(openDialogs()[0]?.querySelector("h2")?.textContent).toBe("切换到「HMCL」？");
    dirs = dirs.map((d) => ({ ...d, is_current: d.name === "HMCL" }));
    await click(all<HTMLButtonElement>(OPEN_DIALOG + ' button').find((b) => b.textContent === "切换") as HTMLButtonElement);
    expect(callsOf(ipc, "set_game_directory")).toEqual([{ path: "D:\\HMCL\\.minecraft" }]);
    expect(callsOf(ipc, "list_game_directories").length).toBeGreaterThan(listCalls);

    const removes = all<HTMLButtonElement>("button").filter((b) => b.textContent === "移除");
    await click(removes[removes.length - 1]);
    expect(commands.calls).toEqual(["remove:F:\\.minecraft"]);
  });

  it("自定义内存的实例：直接按实例列表的 memory_mb 计数，不再逐个读实例设置", async () => {
    ipc.overrides.set("list_instances", () => [
      instanceDto("生存", { memory_mb: 8192 }),
      instanceDto("创造", { memory_mb: null }),
      instanceDto("整合包", { memory_mb: 512 }),
      instanceDto("坏掉的", { memory_mb: null, settings_error: "settings.json 第 1 行格式不对" }),
    ]);
    await mount("game");
    expect(text()).toContain("2 个实例用自定义内存，不受这里影响");
    expect(callsOf(ipc, "get_instance_settings")).toEqual([]);
  });

  it("没有实例自定义内存时不显示那一行", async () => {
    ipc.overrides.set("list_instances", () => [instanceDto("生存", { memory_mb: null })]);
    await mount("game");
    expect(text()).not.toContain("个实例用自定义内存");
  });

  it("打开文件夹：游戏目录走 open_folder 的 game_dir，数据目录走注入的宿主实现", async () => {
    ipc.overrides.set("open_folder", () => null);
    await mount("game");
    const opens = all<HTMLButtonElement>('button[aria-label="打开文件夹"]');
    expect(opens).toHaveLength(2);
    await click(opens[0]);
    expect(callsOf(ipc, "open_folder")).toEqual([{ target: "game_dir", id: null, world: null }]);
    await click(opens[1]);
    expect(commands.calls).toEqual(["open-data"]);
    expect(toasts()).toEqual([]);
  });

  it("探测到、还没登记的文件夹可以添加", async () => {
    await mount("game");
    expect(text()).toContain("发现未记录的文件夹");
    const add = all<HTMLButtonElement>("button").filter((b) => b.textContent === "添加");
    expect(add).toHaveLength(2);
    await click(add[1]);
    expect(commands.calls).toEqual(["add:HMCL:D:\\HMCL\\.minecraft"]);
  });

  it("更改目录：选到带「!」的路径直接拒绝，不切换", async () => {
    commands.pickDirectory = async () => "D:\\Hi!\\.minecraft";
    await mount("game");
    await click(button("更改"));
    expect(toasts()).toContainEqual({ tone: "error", title: "没能切换游戏目录", body: "路径里不能有「!」，Java 会读不出里面的游戏文件" });
    expect(callsOf(ipc, "set_game_directory")).toEqual([]);
  });

  it("复制路径：写进剪贴板后按钮原位换成「已复制」；写入失败只报一次，按钮保持原样", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await mount("game");
    await click(button("复制路径"));
    expect(writeText).toHaveBeenCalledWith("D:\\Games\\Launcher\\.minecraft");
    expect(button("已复制")).toBeDefined();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COPY_FEEDBACK_MS);
    });
    writeText.mockRejectedValueOnce(new Error("剪贴板被其他程序占用"));
    await click(button("复制路径"));
    expect(toasts().filter((t) => t.tone === "error")).toEqual([{ tone: "error", title: "复制失败", body: "剪贴板被其他程序占用" }]);
    expect(all("button").some((b) => b.getAttribute("aria-label") === "已复制")).toBe(false);
  });

  it("有下载在进行时「更改」「切换」带原因禁用", async () => {
    await mount("game");
    await act(async () => {
      await launcher.actions.installJava(17);
    });
    await flush();
    expect(button("更改").getAttribute("aria-disabled")).toBe("true");
    await click(button("更改"));
    expect(commands.calls).toEqual([]);
  });
});

describe("设置页：外观", () => {
  it("非当前的明暗与强调色也画出真实颜色：预览按各自的明暗与当前强调色，色块各画各的", async () => {
    await mount("appearance");
    const previews = () => all('[role="radiogroup"][aria-label="明暗"] [data-mode]').map((p) => [p.getAttribute("data-mode"), p.getAttribute("data-tint")]);
    expect(previews()).toEqual([
      ["day", "sakura"],
      ["night", "sakura"],
    ]);
    expect(all('[role="radiogroup"][aria-label="强调色"] [data-tint]').map((p) => p.getAttribute("data-tint"))).toEqual(["sakura", "amethyst", "moss"]);
    await click(radio("青苔"));
    expect(callsOf(ipc, "set_appearance")).toEqual([{ patch: { accent: "moss" } }]);
    expect(previews()).toEqual([
      ["day", "moss"],
      ["night", "moss"],
    ]);
    expect(radio("青苔").getAttribute("aria-checked")).toBe("true");
  });

  it("明暗即时生效并写后端；本机没有樱花林全景时开关禁用并说明原因", async () => {
    await mount("appearance");
    await click(radio("夜樱"));
    expect(callsOf(ipc, "set_appearance")).toEqual([{ patch: { mode: "night" } }]);
    expect(document.documentElement.getAttribute("data-sk-mode")).toBe("night");
    expect(button("樱花林全景背景").disabled).toBe(true);
    expect(text()).toContain("本机还没有带樱花林全景的游戏版本");
    await click(button("飘落花瓣"));
    expect(callsOf(ipc, "set_appearance")).toEqual([{ patch: { mode: "night" } }, { patch: { petals: false } }]);
  });
});

describe("设置页：关于与启动器更新", () => {
  beforeEach(() => {
    vi.stubGlobal("__PETALFALL_BUILD__", BUILD);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("未检查：写当前版本；检查到更新后导航挂提示点并改写新版本号", async () => {
    await mount("about");
    expect(text()).toContain("当前是 0.1.0");
    expect(navItem("关于").textContent).toContain("版本 0.1.0");
    await click(button("检查更新"));
    expect(callsOf(ipc, "check_update")).toHaveLength(1);
    expect(text()).toContain("有新版本 0.2.0");
    expect(text()).toContain("发布于 2026年10月29日");
    expect(button("关于，有可用更新").textContent).toContain("有新版本 0.2.0");
  });

  it("查看更新 -> 下载（进度）-> 重启并安装；打开过面板后提示点消失，装完回到新版本", async () => {
    await mount("about");
    await click(button("检查更新"));
    await click(button("查看更新"));
    expect(openDialogs()[0]?.querySelector("h2")?.textContent).toBe("更新到 0.2.0");
    expect(text()).toContain("新增首次启动向导与主页服务器卡片。");
    expect(all("button").some((b) => b.getAttribute("aria-label") === "关于，有可用更新")).toBe(false);

    await click(button("下载更新"));
    const [download] = callsOf(ipc, "download_update");
    expect(typeof download.taskId).toBe("string");
    // 假后端每 120 ms 报一次进度，共 12 MB
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(text()).toContain("4.8 MB / 12.0 MB");
    expect(button("后台下载").textContent).toBe("后台下载");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    await flush();
    expect(text()).toContain("新版本已经下好了。");
    expect(callsOf(ipc, "save_task_journal")).toHaveLength(0);

    const install = all<HTMLButtonElement>(OPEN_DIALOG + ' button').find((b) => b.textContent === "重启并安装");
    if (install === undefined) throw new Error("面板里没有「重启并安装」");
    await click(install);
    expect(callsOf(ipc, "save_task_journal")).toHaveLength(1);
    expect(callsOf(ipc, "install_update")).toHaveLength(1);
    // 假后端装完不退出，直接切到新版本：面板收起，卡片回到「当前是」
    expect(openDialogs()).toEqual([]);
    expect(text()).toContain("当前是 0.2.0");
  });

  it("已下载时设为退出时安装，卡片随之改写；有下载任务时重启前先确认", async () => {
    await mount("about");
    await click(button("检查更新"));
    await click(button("查看更新"));
    await click(button("下载更新"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await flush();
    await click(all<HTMLButtonElement>(OPEN_DIALOG + ' button').find((b) => b.textContent === "退出时安装") as HTMLButtonElement);
    expect(callsOf(ipc, "set_install_on_exit")).toEqual([{ enabled: true }]);
    expect(text()).toContain("会自动安装 0.2.0。");
    expect(text()).toContain("时会安装 0.2.0");

    await act(async () => {
      await launcher.actions.installJava(17);
    });
    await click(all<HTMLButtonElement>(OPEN_DIALOG + ' button').find((b) => b.textContent === "改为现在安装") as HTMLButtonElement);
    const titles = all(OPEN_DIALOG + ' h2').map((h) => h.textContent);
    expect(titles).toContain("还有下载没完成");
    expect(callsOf(ipc, "install_update")).toHaveLength(0);
  });

  it("跳过此版本：写入配置并收起面板，卡片标注跳过", async () => {
    await mount("about");
    await click(button("检查更新"));
    await click(button("查看更新"));
    await click(button("跳过此版本"));
    expect(callsOf(ipc, "update_config")).toEqual([{ skippedUpdateVersion: "0.2.0" }]);
    expect(openDialogs()).toEqual([]);
    expect(text()).toContain("发布于 2026年10月29日 · 你跳过了这个版本");
  });

  it("检查失败：卡内如实显示后端原因并给出重试，重试成功后显示新版本", async () => {
    let fail = true;
    ipc.overrides.set("check_update", async (args) => {
      if (fail) throw new IpcError("update_check_failed", "连不上更新服务器：连接超时");
      const { mockInvoke } = await import("../../ipc/mock");
      return mockInvoke("check_update", args);
    });
    await mount("about");
    await click(button("检查更新"));
    expect(text()).toContain("检查更新失败");
    expect(text()).toContain("连不上更新服务器：连接超时");
    fail = false;
    await click(button("重试"));
    expect(callsOf(ipc, "check_update")).toHaveLength(2);
    expect(text()).toContain("有新版本 0.2.0");
  });

  it("支持卡与声明", async () => {
    await mount("about");
    await click(rowButton("打开日志目录", "打开"));
    expect(commands.calls).toEqual(["open-logs"]);
    expect(text()).toContain("与 Mojang Studios 和 Microsoft 没有关联");
  });

  it("品牌卡与版本信息取构建信息：版本、发布通道、构建日期、协议与仓库地址；可复制整段或只复制仓库地址", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await mount("about");
    expect(text()).toContain("版本 0.3.0-preview.2 · AGPL-3.0-only");
    const card = section("版本信息");
    const rows = [...card.querySelectorAll("dl > div")].map((row) => [row.querySelector("dt")?.textContent, row.querySelector("dd")?.textContent]);
    expect(rows).toEqual([
      ["版本", "0.3.0-preview.2"],
      ["发布通道", "预览版"],
      ["构建日期", "2026年10月30日"],
      ["开源协议", "AGPL-3.0-only"],
      ["源代码", REPO_URL],
    ]);
    const copies = [...card.querySelectorAll<HTMLButtonElement>('button[aria-label="复制"]')];
    expect(copies).toHaveLength(2);
    await click(copies[1]);
    await click(copies[0]);
    expect(writeText.mock.calls.map((c) => c[0])).toEqual([
      REPO_URL,
      [`${APP_NAME_EN} 0.3.0-preview.2`, "发布通道：预览版", "构建日期：2026年10月30日", "开源协议：AGPL-3.0-only", `源代码：${REPO_URL}`].join("\n"),
    ]);
  });

  it("第三方许可：打开弹窗时才读清单，按前端与 Rust 分组列出名称、版本与许可证", async () => {
    const fetchMock = vi.fn(async (_url: string) => ({ ok: true, status: 200, json: async () => MANIFEST }));
    vi.stubGlobal("fetch", fetchMock);
    await mount("about");
    expect(fetchMock).not.toHaveBeenCalled();
    await click(rowButton("第三方许可", "查看"));
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["/third-party-licenses.json"]);
    const [dialog] = openDialogs();
    expect(dialog.querySelector("h2")?.textContent).toBe("第三方许可");
    expect(dialog.textContent).toContain("共 3 个，构建时从依赖树生成");
    const groups = [...dialog.querySelectorAll("section[aria-label]")].map((g) => ({
      name: g.getAttribute("aria-label"),
      rows: [...g.querySelectorAll("li")].map((li) => [...li.children].map((c) => c.textContent)),
    }));
    expect(groups).toEqual([
      { name: "前端依赖与字体", rows: [["@fontsource-variable/outfit", "5.3.0", "OFL-1.1"], ["react", "19.1.0", "MIT"]] },
      { name: "Rust 依赖", rows: [["serde", "1.0.219", "MIT OR Apache-2.0"]] },
    ]);
  });

  it("第三方许可：名称过长时截断，悬停提示给出全名；很长的许可证表达式原样完整写出", async () => {
    const longName = "wasm-bindgen-backend-with-a-rather-long-crate-name";
    const longLicense = "(MIT OR Apache-2.0) AND Unicode-DFS-2016 AND Apache-2.0 WITH LLVM-exception";
    const fetchMock = vi.fn(async (_url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({ packages: [{ ecosystem: "cargo", name: longName, version: "0.11.1+wasi-snapshot-preview1", license: longLicense }] }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    await mount("about");
    await click(rowButton("第三方许可", "查看"));
    const [dialog] = openDialogs();
    const row = dialog.querySelector("li");
    if (row === null) throw new Error("许可列表是空的");
    const [nameCell, versionCell, licenseCell] = [...row.children] as HTMLElement[];
    expect(nameCell.textContent).toBe(longName);
    expect(nameCell.title).toBe(longName);
    expect(versionCell.textContent).toBe("0.11.1+wasi-snapshot-preview1");
    expect(licenseCell.textContent).toBe(longLicense);
  });

  it("第三方许可清单读不出来：弹窗里写明原因，重试再读一次", async () => {
    const fetchMock = vi
      .fn(async (_url: string) => ({ ok: true, status: 200, json: async () => MANIFEST }))
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => MANIFEST });
    vi.stubGlobal("fetch", fetchMock);
    await mount("about");
    await click(rowButton("第三方许可", "查看"));
    const [dialog] = openDialogs();
    expect(dialog.textContent).toContain("第三方许可清单读不出来");
    expect(dialog.textContent).toContain("返回 404");
    await click(all<HTMLButtonElement>(OPEN_DIALOG + " button").find((b) => b.textContent === "重试") as HTMLButtonElement);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(openDialogs()[0]?.textContent).toContain("serde");
  });

  it("问题反馈：交给 opener 插件用系统浏览器打开仓库的 Issues 页", async () => {
    ipc.overrides.set("plugin:opener|open_url", () => null);
    await mount("about");
    await click(rowButton("问题反馈", "打开"));
    expect(callsOf(ipc, "plugin:opener|open_url")).toEqual([{ url: ISSUES_URL }]);
  });
});
