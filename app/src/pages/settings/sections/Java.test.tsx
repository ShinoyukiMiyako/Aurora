// @vitest-environment jsdom
// @module-tag heavy-page
// 设置页「Java」分区的加载与增删：运行时列表的骨架按上次扫到的个数画、默认 Java 提醒按种类进出、
// 提醒跟着开关的点击一起换、「重新选择」平滑定位、手动记录整块退场、显卡说明块后到时淡入。
// jsdom 不做布局、没有 Web Animations，让位在这里不跑；断言的是加载门的阶段、占位的结构、退场标记（inert）
// 与挂载那一刻的入场样式。
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../../art/illustrations/test-canvas";
import { LOADING_DELAY_MS } from "../../../domain/limits";
import type { GpuAdaptersDto, JavaInstallationDto } from "../../../ipc/java";
import { mockInvoke, resetMocks } from "../../../ipc/mock";
import { setMockJavaInstallations } from "../../../ipc/mock/handlers/java";
import { OverlayRoot } from "../../../shell/overlay";
import { ShellProvider, useNav, type NavApi } from "../../../shell/shell";
import { AppearanceProvider, DEFAULT_APPEARANCE } from "../../../state/appearance";
import { LauncherProvider } from "../../../state/launcher";
import { invalidate } from "../../../state/resource";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../../test/dom";
import type { IpcRecorder } from "../../../test/fake-bridge";
import { deferred, instanceDto, resetRecorder, settle } from "../../../test/launcher";
import SettingsPage from "../index";
import s from "../settings.module.css";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../../ipc/bridge", async (orig) => (await import("../../../test/fake-bridge")).fakeBridge(await orig(), ipc));

let view: Rendered | undefined;
let nav: NavApi;

function Harness() {
  nav = useNav();
  return nav.route.page === "settings" ? <SettingsPage route={nav.route} /> : null;
}

const flush = () =>
  act(async () => {
    await settle(20);
  });

const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

/** reduced 为真时按外观里打开了「减少动画」渲染（外观层据此设根部的 MotionConfig）。 */
async function mountJava(reduced = false) {
  view = render(
    <AppearanceProvider initial={{ ...DEFAULT_APPEARANCE, reduceMotion: reduced }}>
      <LauncherProvider>
        <ShellProvider>
          <Harness />
          <OverlayRoot />
        </ShellProvider>
      </LauncherProvider>
    </AppearanceProvider>,
  );
  await flush();
  act(() => nav.go({ page: "settings", section: "java" }));
  await flush();
}

function card(title: string): HTMLElement {
  const heading = [...document.querySelectorAll("h2, h3")].find((h) => h.textContent === title);
  const found = heading?.closest<HTMLElement>("[data-pad]");
  if (found === undefined || found === null) throw new Error(`找不到卡片「${title}」`);
  return found;
}

function radio(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent?.startsWith(name));
  if (found === undefined) throw new Error(`找不到单选项「${name}」`);
  return found;
}

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === name || b.textContent?.trim() === name);
  if (found === undefined) throw new Error(`找不到按钮「${name}」`);
  return found;
}

const click = async (el: HTMLElement) => {
  act(() => el.click());
  await flush();
};

/** 在场的元素：退场中的（inert）还在文档里淡出，假定时器下走不完，不算。 */
const live = <E extends Element = HTMLElement>(root: ParentNode, selector: string): E[] => [...root.querySelectorAll<E>(selector)].filter((el) => el.closest("[inert]") === null);
/** 说明块带色调，提醒行没有。 */
const callouts = (root: ParentNode) => live(root, '[role="alert"][data-tone]').map((el) => el.textContent);
const reminderRows = (root: ParentNode) => live(root, '[role="alert"]:not([data-tone])').map((el) => el.textContent);
const leavingText = (root: ParentNode) => [...root.querySelectorAll("[inert]")].map((el) => el.textContent);

function installation(path: string, major: number): JavaInstallationDto {
  return {
    path,
    version: { major, minor: 0, security: 5, build: 0, raw: `${major}.0.5` },
    is_64bit: true,
    vendor: "Eclipse Adoptium",
    source: "registry",
    missing_files: [],
  };
}

const RUNTIMES = "Java 运行时";
const JRE8 = "C:\\Program Files\\Java\\jre1.8.0_421\\bin\\java.exe";
const MISSING_AUTO = "还缺 Java 25，首次启动对应实例时会自动下载。";
const MISSING_MANUAL = "还缺 Java 25，对应实例会启动失败。可以在下面手动下载，或打开「自动下载 Java」。";

beforeEach(() => {
  vi.useFakeTimers();
  resetMocks();
  resetRecorder(ipc);
  stubResizeObserver();
  stubMatchMedia(false);
  stubCanvas();
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("list_instances", () => [
    instanceDto("生存", { java_major: 21 }),
    instanceDto("怀旧", { java_major: 8, mc_version: "1.12.2" }),
    instanceDto("新快照", { java_major: 25, mc_version: "26.1" }),
  ]);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
});

describe("Java · 卡片之间的让位", () => {
  it("三张卡片直接排在载入门的分区卡片栈里：运行时列表变高变矮时由那一层的让位把下面的卡片滑过去，分区不再自己包一层", async () => {
    await mountJava();
    const cards = [RUNTIMES, "下载运行时", "显卡"].map(card);
    const stack = cards[0].parentElement;
    if (stack === null) throw new Error("运行时卡片没有父元素");
    expect(stack.classList.contains(s.sectionFlow)).toBe(true);
    expect([...stack.children]).toEqual(cards);
  });
});

describe("Java · 运行时列表的加载", () => {
  it("扫描结果被丢掉后再进来：骨架等 300 ms 才露面，「自动选择」一块加上次扫到的个数，按单选块的列数排；扫完换成列表", async () => {
    setMockJavaInstallations([25, 21, 17].map((major) => installation(`C:\\Java\\jdk-${major}\\bin\\java.exe`, major)));
    await mountJava();
    expect(live(card(RUNTIMES), '[role="radio"]')).toHaveLength(4);
    view?.unmount();

    // 没人订阅时失效：缓存条目直接丢掉，下次进来从头扫
    invalidate("java");
    const scan = deferred<JavaInstallationDto[]>();
    ipc.overrides.set("detect_java", () => scan.promise);
    await mountJava();
    const runtimes = card(RUNTIMES);
    const skeleton = runtimes.querySelector<HTMLElement>(`.${s.javaSkeleton}`);
    if (skeleton === null) throw new Error("扫描期间没有运行时列表的占位");
    expect(skeleton.closest("[data-pending]")).not.toBeNull();
    expect(skeleton.children).toHaveLength(1 + 3);
    expect(skeleton.style.getPropertyValue("--java-skeleton-columns")).toBe("1");

    await wait(LOADING_DELAY_MS);
    expect(skeleton.closest("[data-pending]")).toBeNull();
    expect(runtimes.querySelector('[aria-busy="true"]')).not.toBeNull();

    await act(async () => {
      scan.resolve([installation("C:\\Java\\jdk-21\\bin\\java.exe", 21)]);
      await settle(20);
    });
    await wait(LOADING_DELAY_MS);
    expect(live(runtimes, '[role="radio"]')).toEqual([radio("自动选择"), radio("Java 21")]);
    expect(runtimes.querySelector('[aria-busy="true"]')).toBeNull();
  });
});

describe("Java · 默认 Java 的提醒", () => {
  it("提醒跟着「自动下载 Java」的点击一起换文案，不等配置写回；同一种提醒原位更新，不播退场", async () => {
    await mountJava();
    const runtimes = card(RUNTIMES);
    expect(callouts(runtimes)).toEqual([MISSING_AUTO]);
    const pending = deferred<void>();
    ipc.overrides.set("update_config", async (args) => {
      await pending.promise;
      return mockInvoke("update_config", args);
    });
    await click(button("自动下载 Java"));
    expect(callouts(runtimes)).toEqual([MISSING_MANUAL]);
    expect(leavingText(runtimes)).toEqual([]);
    expect(radio("自动选择").textContent).toContain("缺哪个就提示你装哪个");

    await act(async () => {
      pending.resolve();
      await settle(20);
    });
    expect(callouts(runtimes)).toEqual([MISSING_MANUAL]);
  });

  it("固定成某个运行时：原来的说明块原地淡出（inert），固定的后果作为新的说明块淡入，缺版本降为提醒行", async () => {
    await mountJava();
    const runtimes = card(RUNTIMES);
    await click(radio("Java 8"));
    expect(leavingText(runtimes)).toEqual([MISSING_AUTO]);
    expect(callouts(runtimes)).toHaveLength(1);
    expect(callouts(runtimes)[0]).toContain("固定成单一 Java 后");
    expect(live<HTMLElement>(runtimes, '[role="alert"][data-tone]')[0].parentElement?.style.opacity).toBe("0");
    expect(reminderRows(runtimes)).toEqual(["还缺 Java 25。默认 Java 固定后不会自动下载，可以在下面手动下载，再到实例设置里单独指定。"]);

    await click(radio("自动选择"));
    expect(callouts(runtimes)).toEqual([MISSING_AUTO]);
    expect(reminderRows(runtimes)).toEqual([]);
  });
});

describe("Java · 「重新选择」", () => {
  const JDK21 = "C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.5.11-hotspot\\bin\\java.exe";
  let scrollIntoView: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    scrollIntoView = vi.fn();
    // jsdom 没有 scrollIntoView
    Object.defineProperty(Element.prototype, "scrollIntoView", { value: scrollIntoView, configurable: true, writable: true });
    await mockInvoke("update_config", { defaultJava: JRE8 });
    ipc.overrides.set("detect_java", () => [installation(JDK21, 21)]);
  });

  afterEach(() => {
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  });

  it("聚焦时不让浏览器一步跳过去，另外把选项平滑地带进视口", async () => {
    await mountJava();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    await click(button("重新选择"));
    const target = radio("Java 21");
    expect(document.activeElement).toBe(target);
    expect(focus.mock.contexts).toEqual([target]);
    expect(focus.mock.calls).toEqual([[{ preventScroll: true }]]);
    expect(scrollIntoView.mock.contexts).toEqual([target]);
    expect(scrollIntoView.mock.calls).toEqual([[{ block: "nearest", behavior: "smooth" }]]);
  });

  it("减少动画时直接定位，不平滑滚动", async () => {
    await mountJava(true);
    await click(button("重新选择"));
    expect(scrollIntoView.mock.calls).toEqual([[{ block: "nearest", behavior: "auto" }]]);
  });
});

describe("Java · 手动添加的记录", () => {
  it("移走最后一条：整块原地淡出（inert），不是同帧拿掉", async () => {
    const path = "D:\\Java\\jdk-17\\bin\\java.exe";
    await mockInvoke("add_java_path", { path });
    await mountJava();
    const runtimes = card(RUNTIMES);
    const list = runtimes.querySelector<HTMLElement>('ul[aria-label="手动添加的 Java"]');
    if (list === null) throw new Error("没有手动添加的 Java");
    const remove = [...list.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "移除");
    if (remove === undefined) throw new Error("那一行没有「移除」");
    await click(remove);
    expect(list.isConnected).toBe(true);
    expect(list.closest("[inert]")).not.toBeNull();
    expect(live(runtimes, 'ul[aria-label="手动添加的 Java"]')).toEqual([]);
  });
});

describe("Java · 显卡", () => {
  it("读取中不放骨架行，「读取中」只标在开关的说明上、不罩住开关；读到两块显卡时说明块作为后到的一项淡入", async () => {
    const adapters = deferred<GpuAdaptersDto>();
    ipc.overrides.set("gpu_adapters", () => adapters.promise);
    await mountJava();
    const gpu = card("显卡");
    expect(gpu.querySelector('[class*="skeleton"]')).toBeNull();
    const busy = [...gpu.querySelectorAll('[aria-busy="true"]')];
    expect(busy.map((el) => el.textContent)).toEqual(["正在读取显卡信息…"]);
    const toggle = gpu.querySelector<HTMLElement>('[role="switch"]');
    if (toggle === null) throw new Error("显卡卡里没有开关");
    expect(toggle.closest('[aria-busy="true"]')).toBeNull();
    expect(toggle.getAttribute("aria-label")).toBe("让游戏用独立显卡");

    ipc.overrides.delete("gpu_adapters");
    await act(async () => {
      adapters.resolve(await mockInvoke<GpuAdaptersDto>("gpu_adapters"));
      await settle(20);
    });
    const note = gpu.querySelector<HTMLElement>('[data-tone="info"]');
    if (note === null) throw new Error("两块显卡时没有说明块");
    expect(note.parentElement?.style.opacity).toBe("0");
    expect(gpu.querySelector('[aria-busy="true"]')).toBeNull();
  });
});
