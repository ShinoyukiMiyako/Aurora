// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COPY_FEEDBACK_MS } from "../../domain/limits";
import { IpcError } from "../../ipc/errors";
import { APP_NAME, APP_NAME_EN, ISSUES_URL, REPO_URL } from "../../lib/app-info";
import type { GpuAdapterDto, JavaInstallationDto } from "../../ipc/java";
import { mockInvoke, resetMocks } from "../../ipc/mock";
import { setMockGpuAdapters, setMockJavaInstallations } from "../../ipc/mock/handlers/java";
import { OverlayRoot } from "../../shell/overlay";
import { pickFile } from "../../shell/platform";
import { ShellProvider, useNav, type NavApi } from "../../shell/shell";
import { UpdatePanelMount } from "../../shell/UpdatePanel";
import { AppearanceProvider, DEFAULT_APPEARANCE } from "../../state/appearance";
import { LauncherProvider, useLauncher, type LauncherApi } from "../../state/launcher";
import { stubCanvas } from "../../art/illustrations/test-canvas";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { callsOf, deferred, instanceDto, resetRecorder, settle } from "../../test/launcher";
import { SettingsCommandsProvider, type SettingsCommands } from "./commands";
import SettingsPage from "./index";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));
// 系统选择文件对话框只在 Tauri 里有：默认照真实实现在测试里拒绝，「添加 Java」的用例改成返回选中的文件
vi.mock("../../shell/platform", async (orig) => {
  const actual = await orig<typeof import("../../shell/platform")>();
  return { ...actual, pickFile: vi.fn(actual.pickFile) };
});

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

  it("固定成某个运行时：写入路径并出现固定提醒", async () => {
    await mount("java");
    await click(radio("Java 8"));
    expect(callsOf(ipc, "update_config")).toEqual([{ defaultJava: "C:\\Program Files\\Java\\jre1.8.0_421\\bin\\java.exe" }]);
    expect(radio("Java 8").getAttribute("aria-checked")).toBe("true");
    expect(text()).toContain("固定成单一 Java 后，要求其他主版本的实例");
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

const JRE8 = "C:\\Program Files\\Java\\jre1.8.0_421\\bin\\java.exe";
const MANUAL_LIST = 'ul[aria-label="手动添加的 Java"]';

function installation(path: string, major: number, overrides: Partial<JavaInstallationDto> = {}): JavaInstallationDto {
  return {
    path,
    version: { major, minor: 0, security: 5, build: 0, raw: `${major}.0.5` },
    is_64bit: true,
    vendor: "Eclipse Adoptium",
    source: "registry",
    missing_files: [],
    ...overrides,
  };
}

const pickNext = (path: string | null) => vi.mocked(pickFile).mockResolvedValueOnce(path);

/** 「手动添加的 Java」区块里路径为 path 的那一行。 */
function manualRow(path: string): HTMLElement {
  const row = all(`${MANUAL_LIST} > li`).find((li) => li.textContent?.includes(path));
  if (row === undefined) throw new Error(`手动添加的 Java 里没有 ${path}`);
  return row;
}

function removeButton(path: string): HTMLButtonElement {
  const found = [...manualRow(path).querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "移除");
  if (found === undefined) throw new Error(`${path} 那一行没有「移除」`);
  return found;
}

describe("设置页：Java · 手动添加与不完整的运行时", () => {
  beforeEach(() => {
    vi.mocked(pickFile).mockClear();
    ipc.overrides.set("list_instances", () => [
      instanceDto("生存", { java_major: 21 }),
      instanceDto("怀旧", { java_major: 8, mc_version: "1.12.2" }),
      instanceDto("新快照", { java_major: 25, mc_version: "26.1" }),
    ]);
  });

  it("添加 Java：选中的 javaw.exe 交给 add_java_path，列表刷新出按 java.exe 记下的「手动添加」项，并提示加了哪个", async () => {
    await mount("java");
    const configReads = callsOf(ipc, "get_config").length;
    pickNext("D:\\Java\\jdk-17.0.12\\bin\\javaw.exe");
    await click(button("添加 Java"));
    expect(vi.mocked(pickFile).mock.calls.map((c) => c[0])).toEqual([{ title: "选择 java.exe 或 javaw.exe", filter: { name: "Java 可执行文件", extensions: ["exe"] } }]);
    expect(callsOf(ipc, "add_java_path")).toEqual([{ path: "D:\\Java\\jdk-17.0.12\\bin\\javaw.exe" }]);
    expect(callsOf(ipc, "detect_java")).toHaveLength(2);
    expect(callsOf(ipc, "get_config")).toHaveLength(configReads + 1);
    const added = radio("Java 17");
    expect(added.textContent).toContain("手动添加");
    expect(added.textContent).toContain("D:\\Java\\jdk-17.0.12\\bin\\java.exe");
    expect(added.disabled).toBe(false);
    expect(toasts()).toContainEqual({ tone: "success", title: "已添加 Java 17", body: "Eclipse Adoptium 17.0.2" });
    const row = manualRow("D:\\Java\\jdk-17.0.12\\bin\\java.exe");
    expect(row.textContent).toContain("Java 17 · Eclipse Adoptium 17.0.2");
    expect(row.textContent).not.toContain("不完整");
    expect(all(`${MANUAL_LIST} > li`)).toHaveLength(1);
  });

  it("添加 Java：取消选择什么都不做；识别期间按钮转圈，结束后恢复", async () => {
    await mount("java");
    const before = toasts().length;
    pickNext(null);
    await click(button("添加 Java"));
    expect(callsOf(ipc, "add_java_path")).toEqual([]);
    expect(toasts()).toHaveLength(before);

    const gate = deferred<void>();
    ipc.overrides.set("add_java_path", async (args) => {
      await gate.promise;
      return mockInvoke("add_java_path", args);
    });
    pickNext("D:\\Java\\jdk-21\\bin\\java.exe");
    await click(button("添加 Java"));
    expect(button("添加 Java").getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      gate.resolve();
      await settle(20);
    });
    expect(button("添加 Java").getAttribute("aria-busy")).toBeNull();
    expect(callsOf(ipc, "add_java_path")).toEqual([{ path: "D:\\Java\\jdk-21\\bin\\java.exe" }]);
    expect(toasts()).toContainEqual({ tone: "success", title: "已添加 Java 21", body: "Eclipse Adoptium 21.0.2" });
  });

  it("添加 Java：后端拒绝时报「没能添加 Java」、正文是后端原文，列表与记录都不变", async () => {
    await mount("java");
    pickNext("D:\\Tools\\launcher.exe");
    await click(button("添加 Java"));
    pickNext("D:\\broken\\jdk-21\\bin\\java.exe");
    await click(button("添加 Java"));
    expect(callsOf(ipc, "add_java_path")).toEqual([{ path: "D:\\Tools\\launcher.exe" }, { path: "D:\\broken\\jdk-21\\bin\\java.exe" }]);
    expect(toasts().filter((t) => t.tone === "error")).toEqual([
      { tone: "error", title: "没能添加 Java", body: "只能添加 java.exe 或 javaw.exe: D:\\Tools\\launcher.exe" },
      { tone: "error", title: "没能添加 Java", body: "这个 Java 缺少 release、lib/modules，可能没装完整: D:\\broken\\jdk-21\\bin\\java.exe" },
    ]);
    expect(callsOf(ipc, "detect_java")).toHaveLength(1);
    expect(document.querySelector(MANUAL_LIST)).toBeNull();
  });

  it("不完整的运行时：标「不完整」并写出缺的文件，单选项禁用；只有它时照样提示还缺这个主版本", async () => {
    const broken = "D:\\Java\\jdk-21-partial\\bin\\java.exe";
    await mockInvoke("add_java_path", { path: broken });
    setMockJavaInstallations([installation(broken, 21, { source: "manual", missing_files: ["release", "lib/modules"] }), installation(JRE8, 8)]);
    await mount("java");
    const tile = radio("Java 21");
    expect(tile.textContent).toContain("不完整");
    expect(tile.textContent).toContain("缺少 release、lib/modules，自动选择会跳过它");
    expect(tile.disabled).toBe(true);
    expect(radio("Java 8").disabled).toBe(false);
    expect(text()).toContain("还缺 Java 25、Java 21，首次启动对应实例时会自动下载。");
    const row = manualRow(broken);
    expect(row.textContent).toContain("Java 21 · Eclipse Adoptium 21.0.5");
    expect(row.textContent).toContain("不完整");
    await click(tile);
    expect(callsOf(ipc, "update_config")).toEqual([]);
  });

  it("已经设为默认的不完整运行时照常显示为选中；改回自动选择之后就不能再选它", async () => {
    const broken = "D:\\Java\\jdk-21-partial\\bin\\java.exe";
    setMockJavaInstallations([installation(broken, 21, { missing_files: ["lib/modules"] }), installation(JRE8, 8)]);
    await mockInvoke("update_config", { defaultJava: broken });
    await mount("java");
    expect(radio("Java 21").getAttribute("aria-checked")).toBe("true");
    expect(radio("Java 21").disabled).toBe(false);
    await click(radio("自动选择"));
    expect(callsOf(ipc, "update_config")).toEqual([{ defaultJava: "auto" }]);
    expect(radio("Java 21").disabled).toBe(true);
  });

  it("托管的 Java 不完整时不算装了，「下载」照常可点；完整的才带原因禁用", async () => {
    const managed = "D:\\Games\\Launcher\\runtime\\25\\bin\\java.exe";
    setMockJavaInstallations([installation(managed, 25, { source: "managed", missing_files: ["lib/modules"] })]);
    await mount("java");
    expect(button("要下载的主版本").textContent).toContain("Java 25");
    expect(contentButton("下载").getAttribute("aria-disabled")).toBeNull();
    setMockJavaInstallations([installation(managed, 25, { source: "managed" })]);
    await click(button("重新扫描"));
    expect(contentButton("下载").getAttribute("aria-disabled")).toBe("true");
  });

  it("移除手动添加的 Java：用 { path } 调 remove_java_path；移除的正是默认 Java 时默认改回自动选择并写明", async () => {
    const plain = "D:\\Java\\jdk-17\\bin\\java.exe";
    const pinned = "E:\\Portable\\jdk-25\\bin\\java.exe";
    await mockInvoke("add_java_path", { path: plain });
    await mockInvoke("add_java_path", { path: pinned });
    await mockInvoke("update_config", { defaultJava: pinned });
    await mount("java");
    expect(radio("Java 25").getAttribute("aria-checked")).toBe("true");
    expect(all(`${MANUAL_LIST} > li`)).toHaveLength(2);

    await click(removeButton(plain));
    expect(callsOf(ipc, "remove_java_path")).toEqual([{ path: plain }]);
    expect(toasts()).toContainEqual({ tone: "success", title: "已移除手动添加的 Java", body: undefined });
    expect(all(`${MANUAL_LIST} > li`)).toHaveLength(1);
    expect(radio("Java 25").getAttribute("aria-checked")).toBe("true");

    await click(removeButton(pinned));
    expect(callsOf(ipc, "remove_java_path")).toEqual([{ path: plain }, { path: pinned }]);
    expect(toasts()).toContainEqual({ tone: "success", title: "已移除手动添加的 Java", body: "默认 Java 改回了自动选择" });
    expect(radio("自动选择").getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector(MANUAL_LIST)).toBeNull();
    expect(text()).not.toContain(pinned);
  });

  it("手动添加的记录这次识别不出：标「识别不出」并说明，不进单选列表，照样可以移除", async () => {
    const gone = "D:\\Java\\jdk-17\\bin\\java.exe";
    await mockInvoke("add_java_path", { path: gone });
    setMockJavaInstallations([installation(JRE8, 8)]);
    await mount("java");
    const row = manualRow(gone);
    expect(row.textContent).toContain("识别不出");
    expect(row.textContent).toContain("这个位置现在识别不出 Java，文件可能被移走了");
    expect(all('[role="radio"]').some((r) => r.textContent?.includes(gone))).toBe(false);
    await click(removeButton(gone));
    expect(callsOf(ipc, "remove_java_path")).toEqual([{ path: gone }]);
    expect(document.querySelector(MANUAL_LIST)).toBeNull();
  });

  it("移除失败：报「没能移除 Java」、正文是原文，记录还在", async () => {
    const path = "D:\\Java\\jdk-17\\bin\\java.exe";
    await mockInvoke("add_java_path", { path });
    ipc.overrides.set("remove_java_path", () => {
      throw new IpcError("io", "写入 config.json 失败: 拒绝访问");
    });
    await mount("java");
    await click(removeButton(path));
    expect(toasts()).toContainEqual({ tone: "error", title: "没能移除 Java", body: "写入 config.json 失败: 拒绝访问" });
    expect(manualRow(path).textContent).toContain("Java 17");
  });
});

function gpuAdapter(name: string, over: Partial<GpuAdapterDto> = {}): GpuAdapterDto {
  return { name, vendor_id: 0x1002, dedicated_video_memory_mb: 16368, high_performance: false, power_saving: false, ...over };
}

describe("设置页：Java · 显卡", () => {
  it("两块显卡：说明块写出两块的名字，开关说明写出会用哪块；打开开关写入 preferDedicatedGpu", async () => {
    await mount("java");
    const card = section("显卡");
    expect(card.textContent).toContain(`让${APP_NAME}启动的游戏用哪块显卡`);
    const note = card.querySelector('[data-tone="info"]');
    expect(note?.textContent).toBe("这台电脑有两块显卡：Intel(R) UHD Graphics 和 NVIDIA GeForce RTX 4060 Laptop GPU。笔记本常默认用省电的那块跑游戏，帧数会低不少。");
    expect(card.textContent).toContain("启动前把这次用的 Java 设为 Windows 图形设置里的「高性能」，游戏会用 NVIDIA GeForce RTX 4060 Laptop GPU");
    expect(card.textContent).toContain("关掉后不会撤销已经写进 Windows 的设置");
    const toggle = button("让游戏用独立显卡");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await click(toggle);
    expect(callsOf(ipc, "update_config")).toEqual([{ preferDedicatedGpu: true }]);
    expect(button("让游戏用独立显卡").getAttribute("aria-checked")).toBe("true");
    expect((await mockInvoke<{ prefer_dedicated_gpu: boolean }>("get_config")).prefer_dedicated_gpu).toBe(true);
  });

  it("只有一块显卡：没有说明块，开关说明写明不会换显卡", async () => {
    setMockGpuAdapters({ adapters: [gpuAdapter("AMD Radeon RX 7800 XT", { high_performance: true, power_saving: true })], switchable: false });
    await mount("java");
    const card = section("显卡");
    expect(card.querySelector('[data-tone="info"]')).toBeNull();
    expect(card.textContent).not.toContain("这台电脑有两块显卡");
    expect(card.textContent).toContain("这台电脑只找到一块显卡，开着也不会换显卡");
  });

  it("两块显卡挑的是同一块：不提示切换，也不写会用哪块", async () => {
    setMockGpuAdapters({
      adapters: [gpuAdapter("NVIDIA RTX A4000", { vendor_id: 0x10de, high_performance: true, power_saving: true }), gpuAdapter("NVIDIA RTX A2000", { vendor_id: 0x10de })],
      switchable: false,
    });
    await mount("java");
    const card = section("显卡");
    expect(card.querySelector('[data-tone="info"]')).toBeNull();
    expect(card.textContent).toContain("启动前把这次用的 Java 设为 Windows 图形设置里的「高性能」");
    expect(card.textContent).not.toContain("游戏会用");
    expect(card.textContent).not.toContain("只找到一块显卡");
  });

  it("读取中：说明位置是骨架行，开关说明写正在读取，开关照常可用", async () => {
    const pending = deferred<unknown>();
    ipc.overrides.set("gpu_adapters", () => pending.promise);
    await mount("java");
    const card = section("显卡");
    expect(card.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(card.textContent).toContain("正在读取显卡信息");
    await click(button("让游戏用独立显卡"));
    expect(callsOf(ipc, "update_config")).toEqual([{ preferDedicatedGpu: true }]);
  });

  it("读不到显卡信息：卡内说明原因并可重试，开关照常可用", async () => {
    ipc.overrides.set("gpu_adapters", () => {
      throw new IpcError("gpu_query_failed", "枚举显卡失败: 不支持的接口", { hresult: "0x887A0004", causes: [] });
    });
    await mount("java");
    const card = section("显卡");
    expect(card.querySelector('[data-tone="danger"]')?.textContent).toContain("读不到显卡信息枚举显卡失败: 不支持的接口");
    expect(card.textContent).toContain("启动前把这次用的 Java 设为 Windows 图形设置里的「高性能」");
    expect(card.textContent).not.toContain("游戏会用");
    await click(button("让游戏用独立显卡"));
    expect(callsOf(ipc, "update_config")).toEqual([{ preferDedicatedGpu: true }]);

    ipc.overrides.delete("gpu_adapters");
    const retry = [...card.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "重试");
    if (retry === undefined) throw new Error("显卡卡里没有「重试」");
    await click(retry);
    expect(callsOf(ipc, "gpu_adapters")).toHaveLength(2);
    expect(section("显卡").querySelector('[data-tone="info"]')?.textContent).toContain("Intel(R) UHD Graphics 和 NVIDIA GeForce RTX 4060 Laptop GPU");
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
