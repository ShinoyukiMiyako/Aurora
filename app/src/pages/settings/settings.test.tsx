// @vitest-environment jsdom
// @module-tag heavy-page
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { COPY_FEEDBACK_MS } from "../../domain/limits";
import { IpcError } from "../../ipc/errors";
import { APP_NAME, APP_NAME_EN, ISSUES_URL, REPO_URL } from "../../lib/app-info";
import type { GpuAdapterDto, JavaInstallationDto } from "../../ipc/java";
import { mockInvoke, resetMocks } from "../../ipc/mock";
import { setMockGpuAdapters, setMockJavaInstallations } from "../../ipc/mock/handlers/java";
import { catalogFromDto, setBlockCatalog } from "../../mc/catalog";
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
// 「下载原版材质」由它自己的测试覆盖；外观分区只管放不放、放在哪、用不用紧凑版
vi.mock("../shared/cover-picker/ArtDownload", async () => {
  const { createElement } = await import("react");
  return { ArtDownload: ({ compact }: { compact?: boolean }) => createElement("div", { "data-art-download": compact === true ? "compact" : "full" }) };
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
    await click(radio(`关闭${APP_NAME}`));
    expect(callsOf(ipc, "update_config")).toEqual([{ afterLaunch: "close" }]);
    expect(radio(`关闭${APP_NAME}`).getAttribute("aria-checked")).toBe("true");
    const desc = all("span[data-tone='warn']").map((e) => e.textContent);
    expect(desc).toContain(`游戏启动后${APP_NAME}退出；游戏结束前重新打开${APP_NAME}可接回这一局，否则这一局的游玩时长与崩溃诊断不会记下`);
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

  describe("跳过首次无障碍引导", () => {
    const SKIP = "跳过首次无障碍引导";
    const stored = async () => (await mockInvoke<{ skip_accessibility_onboarding: boolean }>("get_config")).skip_accessibility_onboarding;

    it("放在「启动」卡里、默认开，说明写清不显示什么与只影响哪些实例", async () => {
      await mount("general");
      const toggle = button(SKIP);
      expect(section("启动").contains(toggle)).toBe(true);
      expect(toggle.getAttribute("role")).toBe("switch");
      expect(toggle.getAttribute("aria-checked")).toBe("true");
      expect(section("启动").textContent).toContain("实例第一次启动时不显示 Minecraft 的讲述人与无障碍提示；只影响还没启动过游戏的目录，未隔离的实例共用一个目录，需要讲述人时关掉");
    });

    it("关掉写入 skipAccessibilityOnboarding: false，再打开写回 true，控件、状态层与 mock 读回都跟着变", async () => {
      await mount("general");
      await click(button(SKIP));
      expect(callsOf(ipc, "update_config")).toEqual([{ skipAccessibilityOnboarding: false }]);
      expect(button(SKIP).getAttribute("aria-checked")).toBe("false");
      expect(launcher.state.settings?.skipAccessibilityOnboarding).toBe(false);
      expect(await stored()).toBe(false);

      await click(button(SKIP));
      expect(callsOf(ipc, "update_config")).toEqual([{ skipAccessibilityOnboarding: false }, { skipAccessibilityOnboarding: true }]);
      expect(button(SKIP).getAttribute("aria-checked")).toBe("true");
      expect(await stored()).toBe(true);
    });

    it("配置里已经关掉：打开设置页时开关就是关的", async () => {
      await mockInvoke("update_config", { skipAccessibilityOnboarding: false });
      await mount("general");
      expect(button(SKIP).getAttribute("aria-checked")).toBe("false");
    });

    it("写入中开关先显示关；失败后回到开，error 通知标题点名设置项、正文给原因，配置没变", async () => {
      const write = deferred<null>();
      ipc.overrides.set("update_config", () => write.promise);
      await mount("general");
      await click(button(SKIP));
      expect(callsOf(ipc, "update_config")).toEqual([{ skipAccessibilityOnboarding: false }]);
      expect(button(SKIP).getAttribute("aria-checked")).toBe("false");

      write.reject(new IpcError("config_io", "磁盘已满"));
      await flush();
      expect(button(SKIP).getAttribute("aria-checked")).toBe("true");
      expect(toasts()).toContainEqual({ tone: "error", title: `没能保存「${SKIP}」`, body: "磁盘已满" });
      expect(await stored()).toBe(true);
    });
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

  it("client_id：已配置时可以清除，先确认会让用它登录的账户重新登录；取消不写，确认后写入并提示", async () => {
    await mount("general");
    const clear = () => contentButton("清除");
    const dialogButton = (name: string) => all<HTMLButtonElement>(OPEN_DIALOG + " button").find((b) => b.textContent === name) as HTMLButtonElement;

    await click(clear());
    expect(openDialogs()[0]?.querySelector("h2")?.textContent).toBe("清除自定义的 client_id？");
    expect(openDialogs()[0]?.textContent).toContain("用自定义 client_id 登录的微软账户之后续期会被拒，需要重新登录");
    await click(dialogButton("取消"));
    expect(callsOf(ipc, "update_config")).toEqual([]);

    await click(clear());
    await click(dialogButton("清除"));
    expect(callsOf(ipc, "update_config")).toEqual([{ clearClientId: true }]);
    expect(toasts()).toContainEqual({ tone: "success", title: "已清除自定义的 client_id", body: undefined });
    // 清掉以后显示未配置，也不再给「清除」
    expect(text()).toContain("未配置");
    expect(all<HTMLButtonElement>('[role="region"] button').some((b) => b.textContent?.trim() === "清除")).toBe(false);
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

  it("本机扫出 7 个运行时：列表照常列出全部 8 项（含自动选择），可以选中最后一个", async () => {
    const runtimes = [8, 11, 16, 17, 21, 22, 25].map((major) => ({
      path: `C:\\Java\\jdk-${major}\\bin\\java.exe`,
      version: { major, minor: 0, security: 1, build: 1, raw: `${major}.0.1` },
      is_64bit: true,
      vendor: "Eclipse Adoptium",
      source: "common_dir",
      missing_files: [],
    }));
    ipc.overrides.set("detect_java", () => runtimes);
    await mount("java");
    expect(all('[role="radio"]')).toHaveLength(8);
    await click(radio("Java 8"));
    expect(callsOf(ipc, "update_config")).toEqual([{ defaultJava: "C:\\Java\\jdk-8\\bin\\java.exe" }]);
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
      missing_files: [],
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

    it("扫描结果里的路径只差大小写：不报找不到，列表里照常选中它", async () => {
      ipc.overrides.set("detect_java", () => [{ ...jdk21, path: JRE8.toUpperCase(), version: { major: 8, minor: 0, security: 421, build: 9, raw: "1.8.0_421" } }]);
      await mount("java");
      expect(radio("Java 8").getAttribute("aria-checked")).toBe("true");
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

    it("排在最前的运行时不完整：「重新选择」跳过它，焦点落到第一个能选的运行时", async () => {
      const jdk17 = { ...jdk21, path: "D:\\Java\\jdk-17\\bin\\java.exe", version: { major: 17, minor: 0, security: 12, build: 7, raw: "17.0.12" } };
      ipc.overrides.set("detect_java", () => [{ ...jdk21, missing_files: ["lib/modules"] }, jdk17]);
      await mount("java");
      await click(button("重新选择"));
      expect(document.activeElement).toBe(radio("Java 17"));
      expect(callsOf(ipc, "update_config")).toEqual([]);
    });

    it("扫到的运行时全都不完整：列表还在，但只给「改回自动选择」", async () => {
      ipc.overrides.set("detect_java", () => [{ ...jdk21, missing_files: ["lib/modules"] }]);
      await mount("java");
      expect(radio("Java 21").disabled).toBe(true);
      const alert = all('[role="alert"]').find((el) => el.textContent?.includes(warnTitle));
      if (alert === undefined) throw new Error("没有出现固定 Java 找不到的提醒");
      expect([...alert.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["改回自动选择"]);
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

  describe("同一张卡里的提醒", () => {
    // 假后端只接受它自己列出的路径：沿用它的 Java 8，把扫描结果改成 32 位
    const X86 = "C:\\Program Files\\Java\\jre1.8.0_421\\bin\\java.exe";
    const x86 = {
      path: X86,
      version: { major: 8, minor: 0, security: 421, build: 9, raw: "1.8.0_421" },
      is_64bit: false,
      vendor: "Oracle",
      source: "registry",
      missing_files: [],
    };
    /** 说明块带色调，提醒行没有；两者都要播报。 */
    const callouts = () => all('[role="alert"][data-tone]');
    const reminderRows = () => all('[role="alert"]:not([data-tone])').map((el) => el.textContent);
    const missingPinned = "还缺 Java 25、Java 21。默认 Java 固定后不会自动下载，可以在下面手动下载，再到实例设置里单独指定。";
    const bits32 = "32 位 Java 最多只能用约 1.5 GB 内存，装 Mod 的实例很容易内存不足。";

    it("固定了 32 位 Java 又缺版本：只有一条说明块写固定的后果，其余逐行列在下面", async () => {
      ipc.overrides.set("detect_java", () => [x86]);
      await mockInvoke("update_config", { defaultJava: X86 });
      await mount("java");
      expect(callouts().map((el) => el.dataset.tone)).toEqual(["warn"]);
      expect(callouts()[0].textContent).toContain("固定成单一 Java 后");
      expect(reminderRows()).toEqual([missingPinned, bits32]);
      expect(text()).not.toContain("首次启动对应实例时会自动下载");
    });

    it("固定的 Java 找不到又缺版本：说明块留给找不到，两个按钮还在，缺版本写成提醒行", async () => {
      ipc.overrides.set("detect_java", () => []);
      await mockInvoke("update_config", { defaultJava: X86 });
      await mount("java");
      expect(callouts()).toHaveLength(1);
      expect(callouts()[0].textContent).toContain("默认 Java 已经找不到了，跟随全局的实例会启动失败");
      expect(callouts()[0].textContent).toContain(X86);
      expect([...callouts()[0].querySelectorAll("button")].map((b) => b.textContent)).toEqual(["改回自动选择"]);
      expect(reminderRows()).toEqual(["还缺 Java 25、Java 21、Java 8。默认 Java 固定后不会自动下载，可以在下面手动下载，再到实例设置里单独指定。"]);
    });

    it("改回自动选择后只剩缺版本一条，回到说明块，也回到按开关写的文案", async () => {
      ipc.overrides.set("detect_java", () => [x86]);
      await mockInvoke("update_config", { defaultJava: X86 });
      await mount("java");
      await click(radio("自动选择"));
      expect(callouts().map((el) => el.textContent)).toEqual(["还缺 Java 25、Java 21，首次启动对应实例时会自动下载。"]);
      expect(reminderRows()).toEqual([]);
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

  describe("下载运行时的默认主版本", () => {
    const instancesNeed = (...majors: number[]) =>
      ipc.overrides.set("list_instances", () => majors.map((major) => instanceDto(`要 Java ${major}`, { java_major: major })));
    const installed = (...majors: number[]) => setMockJavaInstallations(majors.map((major) => installation(`C:\\Java\\jdk-${major}\\bin\\java.exe`, major)));
    const shown = () => button("要下载的主版本").textContent;

    it("缺一个：实例要 21 和 17、本机只装了 21，默认选 17，点下载入队的也是 17", async () => {
      instancesNeed(21, 17);
      installed(21);
      await mount("java");
      expect(shown()).toContain("Java 17");
      await click(contentButton("下载"));
      const java = launcher.state.tasks.filter((t) => t.kind === "java" && t.status !== "done");
      expect(java.map((t) => t.spec)).toEqual([{ command: "install_java", args: { requiredMajor: 17 } }]);
    });

    it("缺多个：选缺的里最高的，而不是实例要求里最高的", async () => {
      instancesNeed(25, 17, 8);
      installed(25);
      await mount("java");
      expect(shown()).toContain("Java 17");
    });

    it("都不缺：保持实例要求里最高的主版本", async () => {
      instancesNeed(21, 17);
      installed(21, 17);
      await mount("java");
      expect(shown()).toContain("Java 21");
    });

    it("没手动选过：默认跟着扫描结果走，补上一个就换到下一个缺的，全补齐后回到最高的", async () => {
      instancesNeed(21, 17, 8);
      installed(21);
      await mount("java");
      expect(shown()).toContain("Java 17");
      installed(21, 17);
      await click(button("重新扫描"));
      expect(shown()).toContain("Java 8");
      installed(21, 17, 8);
      await click(button("重新扫描"));
      expect(shown()).toContain("Java 21");
    });

    it("手动选过的不被扫描结果改掉", async () => {
      instancesNeed(21, 17, 8);
      installed(21);
      await mount("java");
      await click(button("要下载的主版本"));
      const option = all('[role="option"]').find((o) => o.textContent?.startsWith("Java 8"));
      if (option === undefined) throw new Error("「要下载的主版本」里没有 Java 8");
      await click(option);
      expect(shown()).toContain("Java 8");
      installed(21, 8);
      await click(button("重新扫描"));
      expect(shown()).toContain("Java 8");
    });

    it("首次扫描还没回来：先按都不缺显示最高的，回来后换到缺的那个", async () => {
      const scan = deferred<JavaInstallationDto[]>();
      instancesNeed(21, 17);
      ipc.overrides.set("detect_java", () => scan.promise);
      await mount("java");
      expect(shown()).toContain("Java 21");
      await act(async () => {
        scan.resolve([installation("C:\\Java\\jdk-21\\bin\\java.exe", 21)]);
        await settle(20);
      });
      expect(shown()).toContain("Java 17");
    });

    it("首次扫描还没回来：下载带原因禁用，点了不入队；回来后入队的是缺的那个，而不是最高的", async () => {
      const scan = deferred<JavaInstallationDto[]>();
      instancesNeed(21, 17);
      ipc.overrides.set("detect_java", () => scan.promise);
      await mount("java");
      const javaTasks = () => launcher.state.tasks.filter((t) => t.kind === "java" && t.status !== "done").map((t) => t.spec);

      expect(contentButton("下载").getAttribute("aria-disabled")).toBe("true");
      const host = contentButton("下载").closest("[data-tooltip-host]");
      if (host === null) throw new Error("「下载」外面没有提示宿主");
      act(() => {
        host.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("正在扫描本机的 Java，扫完才知道缺哪个");
      await click(contentButton("下载"));
      expect(javaTasks()).toEqual([]);

      await act(async () => {
        scan.resolve([installation("C:\\Java\\jdk-21\\bin\\java.exe", 21)]);
        await settle(20);
      });
      expect(contentButton("下载").getAttribute("aria-disabled")).toBeNull();
      await click(contentButton("下载"));
      expect(javaTasks()).toEqual([{ command: "install_java", args: { requiredMajor: 17 } }]);
    });

    it("首次扫描就失败：说不出缺哪个，按都不缺显示最高的，下载照常可点", async () => {
      instancesNeed(21, 17);
      ipc.overrides.set("detect_java", () => {
        throw new Error("拒绝访问");
      });
      await mount("java");
      expect(text()).toContain("扫描 Java 时出错");
      expect(shown()).toContain("Java 21");
      expect(contentButton("下载").getAttribute("aria-disabled")).toBeNull();
    });

    it("重新扫描失败：沿用上一次的结果，下拉留在缺的那个上", async () => {
      instancesNeed(21, 17);
      installed(21);
      await mount("java");
      expect(shown()).toContain("Java 17");
      ipc.overrides.set("detect_java", () => {
        throw new Error("拒绝访问");
      });
      await click(button("重新扫描"));
      expect(text()).toContain("扫描 Java 时出错");
      expect(shown()).toContain("Java 17");
    });
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

  it("选择框开着时再点「添加 Java」不再开第二个；关掉之后按钮恢复", async () => {
    const picking = deferred<string | null>();
    vi.mocked(pickFile).mockReturnValueOnce(picking.promise);
    await mount("java");
    await click(button("添加 Java"));
    await click(button("添加 Java"));
    expect(vi.mocked(pickFile)).toHaveBeenCalledTimes(1);
    expect(button("添加 Java").getAttribute("aria-busy")).toBe("true");

    picking.resolve(null);
    await flush();
    expect(button("添加 Java").getAttribute("aria-busy")).toBeNull();
    expect(callsOf(ipc, "add_java_path")).toEqual([]);
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
      { tone: "error", title: "没能添加 Java", body: "只能添加 java.exe 或 javaw.exe：D:\\Tools\\launcher.exe" },
      { tone: "error", title: "没能添加 Java", body: "这个 Java 缺少 release、lib/modules，可能没装完整：D:\\broken\\jdk-21\\bin\\java.exe" },
    ]);
    expect(callsOf(ipc, "detect_java")).toHaveLength(1);
    expect(document.querySelector(MANUAL_LIST)).toBeNull();
  });

  it("一个运行时都没扫到：手动添加的记录照样列出来，标识别不出、能移除", async () => {
    const gone = "D:\\Java\\jdk-17.0.12\\bin\\java.exe";
    await mockInvoke("add_java_path", { path: gone });
    setMockJavaInstallations([]);
    await mount("java");
    expect(text()).toContain("没有在本机找到 Java");
    expect(all('[role="radio"]')).toEqual([]);
    expect(manualRow(gone).textContent).toContain("识别不出");
    await click(removeButton(gone));
    expect(callsOf(ipc, "remove_java_path")).toEqual([{ path: gone }]);
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
    // 只留要 Java 25 的实例：还缺别的主版本时，25 装齐后默认会换到缺的那个
    ipc.overrides.set("list_instances", () => [instanceDto("新快照", { java_major: 25, mc_version: "26.1" })]);
    setMockJavaInstallations([installation(managed, 25, { source: "managed", missing_files: ["lib/modules"] })]);
    await mount("java");
    expect(button("要下载的主版本").textContent).toContain("Java 25");
    expect(contentButton("下载").getAttribute("aria-disabled")).toBeNull();
    setMockJavaInstallations([installation(managed, 25, { source: "managed" })]);
    await click(button("重新扫描"));
    expect(button("要下载的主版本").textContent).toContain("Java 25");
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
    expect(card.textContent).toContain("关掉后，已经写进 Windows 的设置不会自动改回");
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
    expect(text()).toContain("按每个实例的 Mod 数量、整合包推荐值与视距估算；没有当前实例，按原版估算，建议 2.5 GB");
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

  describe("内存：自动分配的估算依据", () => {
    const ADVICE = {
      total_mb: 16384,
      available_mb: 9000,
      version_id: "整合包A",
      need_mb: 5632,
      limit: { mb: 8192, reason: "half_physical" },
      recommended_mb: 5632,
      factors: [
        { kind: "base", loader: "modded", mb: 2765 },
        { kind: "mods", count: 120, mb: 2457 },
        { kind: "render_distance", distance: 16, mb: 46 },
      ],
    };

    beforeEach(() => {
      ipc.overrides.set("list_instances", () => [instanceDto("整合包A", { mc_version: "1.20.1", loaders: [{ kind: "forge", version: "47.2.0" }], mod_count: 120 })]);
    });

    /** 悬停滑杆上的推荐标记，读出它的提示。 */
    async function markerTip(): Promise<string | null> {
      const marker = document.querySelector<HTMLElement>("[style*='--marker-p']");
      if (marker === null) throw new Error("滑杆上没有推荐标记");
      act(() => {
        marker.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      const tip = document.querySelector('[role="tooltip"]');
      if (tip === null) throw new Error("推荐标记没有弹出提示");
      return tip.textContent;
    }

    it("说明写当前实例的依据整句，推荐标记的提示是同一句", async () => {
      ipc.overrides.set("memory_advice", () => ADVICE);
      await mount("game");
      const card = section("内存");
      expect(card.textContent).toContain("按每个实例的 Mod 数量、整合包推荐值与视距估算；当前实例「整合包A」：Forge 1.20.1 · 120 个 Mod · 视距 16，建议 5.5 GB");
      expect(card.querySelector('[data-tone="warn"]')).toBeNull();
      expect(await markerTip()).toBe("Forge 1.20.1 · 120 个 Mod · 视距 16，建议 5.5 GB");
    });

    it("按当前实例的 id 取内存建议，没有当前实例时不带 id", async () => {
      ipc.overrides.set("memory_advice", () => ADVICE);
      await mount("game");
      expect(callsOf(ipc, "memory_advice")).toEqual([{ versionId: undefined }]);
    });

    it("有当前实例时带上它的 id：换当前实例、改名与 Mod 变化都随实例作用域的失效重取", async () => {
      ipc.overrides.set("memory_advice", () => ADVICE);
      ipc.overrides.set("get_config", async (args) => ({ ...(await mockInvoke<object>("get_config", args)), selected_version: "整合包A" }));
      await mount("game");
      expect(callsOf(ipc, "memory_advice")).toEqual([{ versionId: "整合包A" }]);
    });

    it("当前实例在实例列表里找不到：加载器与版本不编，从组成项写起", async () => {
      ipc.overrides.set("memory_advice", () => ({ ...ADVICE, version_id: "已删" }));
      await mount("game");
      expect(section("内存").textContent).toContain("当前实例「已删」：120 个 Mod · 视距 16，建议 5.5 GB");
    });

    it("被封顶：开着自动分配时提示需要多少、本机最多给多少，提示整句补上原因；关掉后不再提示", async () => {
      ipc.overrides.set("memory_advice", () => ({ ...ADVICE, need_mb: 13312, recommended_mb: 8192, factors: [ADVICE.factors[0], { kind: "mods", count: 1100, mb: 10437 }] }));
      await mount("game");
      const card = section("内存");
      expect(card.textContent).toContain("当前实例「整合包A」：Forge 1.20.1 · 1100 个 Mod，建议 8 GB");
      expect(card.querySelector('[data-tone="warn"]')?.textContent).toBe("需要 13 GB，本机最多给 8 GB（物理内存的一半），内存可能不够用。");
      expect(await markerTip()).toBe("Forge 1.20.1 · 1100 个 Mod，建议 8 GB。需要 13 GB，本机最多给 8 GB（物理内存的一半）");
      await click(button("自动分配"));
      expect(section("内存").textContent).not.toContain("内存可能不够用");
    });
  });

  it("版本隔离：关闭档的例外写目录里有内容，不写已有目录（隔离时启动一次就会建出空目录，空目录不强制隔离）", async () => {
    await mockInvoke("update_config", { isolationPolicy: "disabled" });
    await mount("game");
    expect(text()).toContain("所有实例共用同一个目录，Mod 与配置可能互相串味（mods 或 saves 里有内容的实例仍会单独存放）");
    expect(text()).not.toContain("已有 mods 或 saves");
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
    ipc.overrides.set("list_game_directories", () => [
      { name: "默认目录", path: "D:\\Games\\Launcher\\.minecraft", is_current: true, available: true, version_count: 0 },
      { name: "HMCL", path: "D:\\HMCL\\.minecraft", is_current: false, available: true, version_count: 3 },
    ]);
    await mount("game");
    await act(async () => {
      await launcher.actions.installJava(17);
    });
    await flush();
    expect(button("更改").getAttribute("aria-disabled")).toBe("true");
    await click(button("更改"));
    expect(commands.calls).toEqual([]);
    expect(button("切换").getAttribute("aria-disabled")).toBe("true");
    await click(button("切换"));
    expect(openDialogs()).toEqual([]);
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

  it("实例卡面默认背景：两档各写出外观补丁；本机没有原版材质时这一行下面放紧凑的材质下载，有了就收起", async () => {
    onTestFinished(() => setBlockCatalog(null));
    await mount("appearance");
    expect(radio("方块平铺").getAttribute("aria-checked")).toBe("true");
    expect(text()).toContain("本机还没有原版材质，方块平铺先画成渐变花瓣。");
    const download = all("[data-art-download]");
    expect(download.map((d) => d.getAttribute("data-art-download"))).toEqual(["compact"]);
    expect(download[0].previousElementSibling?.textContent).toMatch(/^实例卡面默认背景/);

    await click(radio("渐变花瓣"));
    expect(callsOf(ipc, "set_appearance")).toEqual([{ patch: { cover_background: "art" } }]);
    expect(radio("渐变花瓣").getAttribute("aria-checked")).toBe("true");
    await click(radio("方块平铺"));
    expect(callsOf(ipc, "set_appearance")).toEqual([{ patch: { cover_background: "art" } }, { patch: { cover_background: "texture" } }]);

    act(() => setBlockCatalog(catalogFromDto({ version_id: "1.21.1", blocks: [] })));
    expect(all("[data-art-download]")).toEqual([]);
    expect(text()).toContain("方块平铺取封面方块的材质，读取自你本机的游戏文件。");
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
    expect(document.querySelector<HTMLCanvasElement>('[class*="brandMark"] canvas')?.style.width).toBe("48px");
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
    const switchNow = () => all<HTMLButtonElement>(OPEN_DIALOG + ' button').find((b) => b.textContent === "改为现在安装") as HTMLButtonElement;
    const confirmButton = (label: string) => {
      const found = all<HTMLButtonElement>(OPEN_DIALOG + ' button').find((b) => b.textContent === label);
      if (found === undefined) throw new Error(`确认框里没有「${label}」`);
      return found;
    };
    await click(switchNow());
    expect(all(OPEN_DIALOG + ' h2').map((h) => h.textContent)).toContain("重启并安装更新？");
    expect(text()).toContain("还有 1 个下载任务，重启会中断它们，之后需要重新开始。");
    expect(confirmButton("重启并安装").dataset.variant).toBe("danger");
    expect(callsOf(ipc, "install_update")).toHaveLength(0);

    // 选「继续下载」回到面板，什么都不装；确认后才装
    await click(confirmButton("继续下载"));
    expect(callsOf(ipc, "install_update")).toHaveLength(0);
    await click(switchNow());
    await click(confirmButton("重启并安装"));
    expect(callsOf(ipc, "install_update")).toHaveLength(1);
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

  it("检查失败是网络层的：主句写中文说明，英文原文放进可选中的细节", async () => {
    const raw = "error sending request for url (https://petalfall.org/updates/latest.json)";
    ipc.overrides.set("check_update", () => {
      throw new IpcError("update_check_failed", raw, { network: "connect", causes: ["client error (Connect)"] });
    });
    await mount("about");
    await click(button("检查更新"));
    expect(text()).toContain("连不上更新服务器");
    expect(all("[data-selectable]").map((el) => el.textContent)).toContain(raw);
    expect(button("重试").textContent).toBe("重试");
  });

  it("下载失败是网络层的：面板与卡片都写中文原因，英文原文另放且可选中，不拼进句子", async () => {
    const raw = "error sending request for url (https://petalfall.org/updates/setup-0.2.0.exe)";
    ipc.overrides.set("download_update", () => {
      throw new IpcError("update_download_failed", raw, { network: "connect", causes: ["client error (Connect)"] });
    });
    await mount("about");
    await click(button("检查更新"));
    await click(button("查看更新"));
    await click(button("下载更新"));
    await flush();

    const panel = openDialogs()[0];
    expect(panel?.querySelector('[role="alert"]')?.textContent).toBe("下载失败：连不上更新服务器");
    expect(panel?.querySelector("[data-selectable]")?.textContent).toBe(raw);
    expect(text()).not.toContain(`下载失败：${raw}`);

    await click(button("稍后"));
    expect(text()).toContain("下载失败：连不上更新服务器");
    // 面板还在退场动画里，节点没卸载；这里只看卡片
    const inCard = all("[data-selectable]").filter((el) => el.closest("[data-sk-modal-layer]") === null);
    expect(inCard.map((el) => el.textContent)).toEqual([raw]);
  });

  it("下载失败不是网络层的：说明块只写下载失败，后端原文另放", async () => {
    const raw = "`Download request failed with status: 503 Service Unavailable`";
    ipc.overrides.set("download_update", () => {
      throw new IpcError("update_download_failed", raw);
    });
    await mount("about");
    await click(button("检查更新"));
    await click(button("查看更新"));
    await click(button("下载更新"));
    await flush();

    const panel = openDialogs()[0];
    expect(panel?.querySelector('[role="alert"]')?.textContent).toBe("下载失败");
    expect(panel?.querySelector("[data-selectable]")?.textContent).toBe(raw);
  });

  it("签名不符：说明块写固定原因，没有另放的原文", async () => {
    ipc.overrides.set("download_update", () => {
      throw new IpcError("update_signature_invalid", "signature verification failed");
    });
    await mount("about");
    await click(button("检查更新"));
    await click(button("查看更新"));
    await click(button("下载更新"));
    await flush();

    const panel = openDialogs()[0];
    expect(panel?.querySelector('[role="alert"]')?.textContent).toBe("下载失败：更新包签名校验不通过，已丢弃，不会安装");
    expect(panel?.querySelector("[data-selectable]")).toBeNull();
  });

  it("更新源上没有清单：后端按没有新版本回 null，卡片写已是最新，不算失败", async () => {
    ipc.overrides.set("check_update", () => null);
    await mount("about");
    await click(button("检查更新"));
    expect(text()).toContain("已是最新版本");
    expect(text()).not.toContain("检查更新失败");
    expect(all("button").some((b) => b.textContent === "重试")).toBe(false);
  });

  it("支持卡：打开日志目录", async () => {
    await mount("about");
    await click(rowButton("打开日志目录", "打开"));
    expect(commands.calls).toEqual(["open-logs"]);
  });

  // AGPL 第 5(d) 条要界面上有版权声明、无担保与可按协议转发的说明，以及看协议全文的入口（入口见下面的协议全文用例）；
  // 素材不按 AGPL 授权，所以自由软件一句只说程序代码，素材许可与名称商标另起两句
  it("页尾依次写版权声明、代码的自由软件与无担保声明、素材许可、名称商标、Minecraft 商标与数据来源声明", async () => {
    await mount("about");
    expect(all('[class*="disclaimer"]').map((p) => p.textContent)).toEqual([
      "Copyright \u00A9 2026 Shinoyuki_Miyako",
      `${APP_NAME}的程序代码是自由软件，你可以按 AGPL-3.0-only 及其附加条款转发和修改它。它按现状提供，不提供任何担保。`,
      "应用图标、像素花瓣徽记等列在素材许可里的美术素材另按 CC BY-NC-ND 4.0 授权：可以非商业地原样转发并署名，不能商用，也不能改作后发布。",
      `「${APP_NAME}」「${APP_NAME_EN}」的名称与徽记不授予商标权。向他人提供修改版的构建产物时，须改用不会混淆的名称与图标，并写明它不出自原作者。`,
      `Minecraft 是 Mojang Studios 的商标。实例图标、皮肤与全景图这些原版图案读取自你本机的游戏文件，不随${APP_NAME}分发。` +
        `Mod 与整合包的信息和文件来自 Modrinth 与 CurseForge。${APP_NAME}是社区开源项目，与 Mojang Studios 和 Microsoft 没有关联。`,
    ]);
  });

  it("支持卡依次列出日志目录、协议全文、附加条款、素材许可、第三方许可与问题反馈", async () => {
    await mount("about");
    const titles = [...section("支持").querySelectorAll("button")].map((b) => b.closest('[class*="row"]')?.firstElementChild?.firstElementChild?.textContent);
    expect(titles).toEqual(["打开日志目录", "协议全文", "附加条款", "素材许可", "第三方许可", "问题反馈"]);
  });

  describe.each([
    { title: "附加条款", url: "/LICENSE-ADDITIONAL-TERMS.md" },
    { title: "素材许可", url: "/LICENSE-ASSETS.md" },
  ])("$title", ({ title, url }) => {
    it("打开弹窗时才读产物里的文件，Markdown 原样显示；关上再开不重读", async () => {
      // 随机一行：显示的必须是读回来的那份，而不是哪里写死的文本
      const body = `# ${title}\n\nCopyright (C) 2026 维护者\n\n> ${Math.random().toString(36).slice(2)}\n\n- 一\n- 二\n`;
      const fetchMock = vi.fn(async (_url: string) => ({ ok: true, status: 200, text: async () => body }));
      vi.stubGlobal("fetch", fetchMock);
      await mount("about");
      expect(fetchMock).not.toHaveBeenCalled();

      await click(rowButton(title, "查看"));
      expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([url]);
      const [dialog] = openDialogs();
      expect(dialog.querySelector("h2")?.textContent).toBe(title);
      expect(dialog.querySelector("h2 + p")?.textContent).toBe("中文为准，附英文对照");
      const region = dialog.querySelector<HTMLElement>('pre[role="region"]');
      expect(region?.getAttribute("aria-label")).toBe(title);
      expect(region?.tabIndex).toBe(0);
      expect(region?.textContent).toBe(body);

      await click(button("关闭"));
      expect(openDialogs()).toHaveLength(0);
      await click(rowButton(title, "查看"));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(openDialogs()[0]?.querySelector('pre[role="region"]')?.textContent).toBe(body);
    });

    it("读不出来：弹窗里写明原因与请求地址，不留白；重试再读一次", async () => {
      const body = `# ${title}\n`;
      const fetchMock = vi
        .fn(async (_url: string) => ({ ok: true, status: 200, text: async () => body }))
        .mockResolvedValueOnce({ ok: false, status: 404, text: async () => "Not Found" });
      vi.stubGlobal("fetch", fetchMock);
      await mount("about");
      await click(rowButton(title, "查看"));

      const [dialog] = openDialogs();
      const alert = dialog.querySelector('[role="alert"]');
      expect(alert?.querySelector('[class*="calloutTitle"]')?.textContent).toBe(`${title}读不出来`);
      expect(alert?.querySelector('[class*="errorText"]')?.textContent).toBe(`${title}读不出来：${url} 返回 404`);
      expect(dialog.querySelector("pre")).toBeNull();

      await click(all<HTMLButtonElement>(OPEN_DIALOG + " button").find((b) => b.textContent === "重试") as HTMLButtonElement);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(openDialogs()[0]?.querySelector('pre[role="region"]')?.textContent).toBe(body);
    });
  });

  it("协议全文、附加条款与素材许可各读各的文件，先开过一份不影响另一份", async () => {
    const fetchMock = vi.fn(async (url: string) => ({ ok: true, status: 200, text: async () => `正文 ${url}` }));
    vi.stubGlobal("fetch", fetchMock);
    await mount("about");
    for (const [title, url] of [
      ["协议全文", "/LICENSE.txt"],
      ["附加条款", "/LICENSE-ADDITIONAL-TERMS.md"],
      ["素材许可", "/LICENSE-ASSETS.md"],
    ]) {
      await click(rowButton(title, "查看"));
      expect(openDialogs()[0]?.querySelector('pre[role="region"]')?.textContent).toBe(`正文 ${url}`);
      await click(button("关闭"));
    }
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["/LICENSE.txt", "/LICENSE-ADDITIONAL-TERMS.md", "/LICENSE-ASSETS.md"]);
  });

  it("协议全文：打开弹窗时才读 LICENSE.txt，换行与缩进原样显示；关上再开不重读", async () => {
    // 随机一行：显示的必须是读回来的那份，而不是哪里写死的文本
    const marker = `  ${Math.random().toString(36).slice(2)}`;
    const license = `                    GNU AFFERO GENERAL PUBLIC LICENSE\n                       Version 3, 19 November 2007\n\n${marker}\n\n  0. Definitions.\n`;
    const fetchMock = vi.fn(async (_url: string) => ({ ok: true, status: 200, text: async () => license }));
    vi.stubGlobal("fetch", fetchMock);
    await mount("about");
    expect(fetchMock).not.toHaveBeenCalled();

    await click(rowButton("协议全文", "查看"));
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["/LICENSE.txt"]);
    const [dialog] = openDialogs();
    expect(dialog.querySelector("h2")?.textContent).toBe("协议全文");
    expect(dialog.querySelector("h2 + p")?.textContent).toBe("AGPL-3.0-only，协议全文只有英文版");
    const region = dialog.querySelector<HTMLElement>('pre[role="region"]');
    expect(region?.getAttribute("aria-label")).toBe("协议全文");
    expect(region?.tabIndex).toBe(0);
    expect(region?.textContent).toBe(license);

    await click(button("关闭"));
    expect(openDialogs()).toHaveLength(0);
    await click(rowButton("协议全文", "查看"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(openDialogs()[0]?.querySelector('pre[role="region"]')?.textContent).toBe(license);
  });

  it("协议全文读不出来：弹窗里写明原因与请求地址，不留白；重试再读一次", async () => {
    const license = "GNU AFFERO GENERAL PUBLIC LICENSE\n";
    const fetchMock = vi
      .fn(async (_url: string) => ({ ok: true, status: 200, text: async () => license }))
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => "Not Found" });
    vi.stubGlobal("fetch", fetchMock);
    await mount("about");
    await click(rowButton("协议全文", "查看"));

    const [dialog] = openDialogs();
    const alert = dialog.querySelector('[role="alert"]');
    expect(alert?.querySelector('[class*="calloutTitle"]')?.textContent).toBe("协议全文读不出来");
    expect(alert?.querySelector('[class*="errorText"]')?.textContent).toBe("协议全文读不出来：/LICENSE.txt 返回 404");
    expect(dialog.querySelector("pre")).toBeNull();
    expect(dialog.textContent).not.toContain("Not Found");

    await click(all<HTMLButtonElement>(OPEN_DIALOG + " button").find((b) => b.textContent === "重试") as HTMLButtonElement);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(openDialogs()[0]?.querySelector('[role="alert"]')).toBeNull();
    expect(openDialogs()[0]?.querySelector('pre[role="region"]')?.textContent).toBe(license);
  });

  it("品牌卡与版本信息取构建信息：版本、发布通道、构建日期、协议、素材许可与仓库地址；可复制整段或只复制仓库地址", async () => {
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
      ["素材许可", "CC BY-NC-ND 4.0"],
      ["源代码", REPO_URL],
    ]);
    const copies = [...card.querySelectorAll<HTMLButtonElement>('button[aria-label="复制"]')];
    expect(copies).toHaveLength(2);
    await click(copies[1]);
    await click(copies[0]);
    expect(writeText.mock.calls.map((c) => c[0])).toEqual([
      REPO_URL,
      [`${APP_NAME_EN} 0.3.0-preview.2`, "发布通道：预览版", "构建日期：2026年10月30日", "开源协议：AGPL-3.0-only", "素材许可：CC BY-NC-ND 4.0", `源代码：${REPO_URL}`].join("\n"),
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
