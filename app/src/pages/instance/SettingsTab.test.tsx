// @vitest-environment jsdom
// 实例设置标签的动效与布局稳定：加载占位、横幅出入、卡内切换与提示出没。
// jsdom 不做布局、不派发动画结束：这里断言挂载那一刻的入场起点（内联的 opacity / scale）、退场层的 inert，
// 以及占位槽的结构与样式规则；滑动本身由 lib/reflow 负责，有它自己的测试。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, type ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../art/illustrations/test-canvas";
import { INSTANCE_NAME_ERROR, SLOW_LOADING_HINT } from "../../copy/flows";
import { SLOW_HINT_MS } from "../../domain/limits";
import type { InstanceDto, InstanceSettingsDto, TemplateInfoDto } from "../../ipc/instances";
import type { JavaInstallationDto } from "../../ipc/java";
import { GAME_EXIT_EVENT } from "../../ipc/launch";
import type { MemoryAdviceDto } from "../../ipc/system";
import { REFLOW_PAUSED_ATTR } from "../../lib/reflow";
import { OverlayRoot } from "../../shell/overlay";
import { ShellProvider, useNav, type NavApi } from "../../shell/shell";
import { AppearanceProvider, DEFAULT_APPEARANCE } from "../../state/appearance";
import { LauncherProvider, useLauncher, type LauncherApi } from "../../state/launcher";
import { routeKey } from "../../state/route";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { bootOverrides, callsOf, configDto, deferred, emit, instanceDto, memoryAdviceDto, resetRecorder, settle } from "../../test/launcher";
import { RemoteImageProvider } from "../../ui/remote-image";
import { SETTINGS_COPY } from "./copy";
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

const ID = "樱花生存";
const NO_TEMPLATE: TemplateInfoDto = { present: false, files: [], source_instance: null, saved_at: null, enabled: true };

let view: Rendered | undefined;
let nav: NavApi;
let launcher: LauncherApi;
let instances: InstanceDto[];
let settings: InstanceSettingsDto;

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

async function openSettings() {
  view = render(
    <Providers>
      <Probe />
      <Routed />
    </Providers>,
  );
  await flush();
  act(() => nav.go({ page: "instance", id: ID, tab: "settings" }));
  await flush();
}

function textOf(node: Node): string {
  const t = node.textContent;
  if (t === null) throw new Error("节点没有文本内容");
  return t;
}

/** 标题为 title 的卡片。 */
function card(title: string): HTMLElement {
  const heading = [...document.querySelectorAll("h3")].find((h) => h.textContent === title);
  const found = heading?.closest<HTMLElement>('[class*="card"]');
  if (found === undefined || found === null) throw new Error(`找不到「${title}」卡`);
  return found;
}

/** 按标题找设置行。 */
function row(title: string, root: ParentNode = document): HTMLElement {
  const label = [...root.querySelectorAll<HTMLElement>('span[id$="-title"]')].find((s) => s.textContent === title);
  const found = label?.closest<HTMLElement>('[class*="row"]');
  if (found === undefined || found === null) throw new Error(`没有「${title}」这一行`);
  return found;
}

/** 设置行的说明位（SettingRow 用 aria-describedby 指向的那个元素）。 */
function description(rowEl: HTMLElement): HTMLElement {
  const el = rowEl.querySelector<HTMLElement>('span[id$="-desc"]');
  if (el === null) throw new Error("这一行没有说明");
  return el;
}

function button(name: string, root: ParentNode = document): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>("button:not([inert] button)")].find((b) => b.textContent === name);
  if (found === undefined) throw new Error(`找不到按钮「${name}」`);
  return found;
}

function radio(name: string, root: ParentNode = document): HTMLButtonElement | null {
  return [...root.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => textOf(b) === name) ?? null;
}

/** 包住 el 的出入场层（ui/Appear 的包裹层，入场起点写在它的内联样式上）。 */
function appearLayer(el: Element): HTMLElement {
  const layer = el.closest<HTMLElement>('[style*="opacity"]');
  if (layer === null) throw new Error("它不在出入场层里");
  return layer;
}

function typeInto(el: HTMLTextAreaElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
  if (descriptor === undefined || descriptor.set === undefined) throw new Error("取不到 value 的 setter");
  const setter = descriptor.set;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function java(path: string, major: number): JavaInstallationDto {
  return { path, version: { major, minor: 0, security: 5, build: 0, raw: `${major}.0.5` }, is_64bit: true, vendor: "Microsoft", source: "registry", missing_files: [] };
}

beforeAll(async () => {
  await import("../../ipc/mock");
});

beforeEach(() => {
  vi.useFakeTimers();
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
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  instances = [instanceDto(ID, { loaders: [{ kind: "fabric", version: "0.16.10" }] })];
  settings = {
    description: null,
    cover: "grass_block",
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
  bootOverrides(ipc, { instances, config: configDto({ memory: { max_mb: 4096, min_mb: null, auto: false } }) });
  ipc.overrides.set("list_instances", () => instances);
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("get_instance_settings", () => settings);
  ipc.overrides.set("set_instance_settings", (args) => {
    settings = args.settings as InstanceSettingsDto;
    return settings;
  });
  ipc.overrides.set("list_mods", () => []);
  ipc.overrides.set("check_updates", () => []);
  ipc.overrides.set("list_instance_content", () => ({ resource_packs: [], shader_packs: [], worlds: [] }));
  ipc.overrides.set("detect_java", () => [java("C:/Java/jdk-21/bin/java.exe", 21), java("C:/Java/jdk-17/bin/java.exe", 17)]);
  ipc.overrides.set("memory_advice", () => memoryAdviceDto({ version_id: ID }));
  ipc.overrides.set("last_crash", () => null);
  ipc.overrides.set("last_launch_log", () => null);
  ipc.overrides.set("list_history", () => []);
  ipc.overrides.set("rollback_checks", () => []);
  ipc.overrides.set("template_info", () => NO_TEMPLATE);
  ipc.overrides.set("launch_game", () => ({ pid: 42 }));
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("实例设置：横幅", () => {
  it("停在设置页时启动游戏：横幅由常驻槽位淡入落位，不同帧硬插；游戏退出后原地淡出、不可交互", async () => {
    await openSettings();
    expect(textOf(document.body)).not.toContain(SETTINGS_COPY.runningNote);
    await act(async () => {
      await launcher.actions.launch(ID);
      await settle(20);
    });
    const note = [...document.querySelectorAll<HTMLElement>("div")].find((el) => el.textContent === SETTINGS_COPY.runningNote && el.children.length === 0);
    if (note === undefined) throw new Error("没有运行横幅");
    const layer = appearLayer(note);
    expect(layer.style.opacity).toBe("0");
    expect(layer.hasAttribute("inert")).toBe(false);
    act(() => emit(GAME_EXIT_EVENT, { version_id: ID, exit_code: 0, crashed: false, killed: false, duration_ms: 60_000 }));
    await flush();
    expect(layer.hasAttribute("inert")).toBe(true);
  });
});

describe("实例设置：内存卡", () => {
  it("分段等数据到了才挂上：单独设置过内存的实例，分段一出现就落在「单独设置」，不先停在「跟随全局」", async () => {
    settings = { ...settings, memory_mb: 6144 };
    const advice = deferred<MemoryAdviceDto>();
    ipc.overrides.set("memory_advice", () => advice.promise);
    await openSettings();
    expect(radio(SETTINGS_COPY.follow, card(SETTINGS_COPY.memoryTitle))).toBeNull();
    expect(radio(SETTINGS_COPY.custom, card(SETTINGS_COPY.memoryTitle))).toBeNull();
    await act(async () => {
      advice.resolve(memoryAdviceDto({ version_id: ID }));
      await settle(20);
    });
    expect(radio(SETTINGS_COPY.custom, card(SETTINGS_COPY.memoryTitle))?.getAttribute("aria-checked")).toBe("true");
    expect(radio(SETTINGS_COPY.follow, card(SETTINGS_COPY.memoryTitle))?.getAttribute("aria-checked")).toBe("false");
  });

  it("切换模式：挂载时的正文不淡入；切过去的新正文只淡入（不位移）", async () => {
    await openSettings();
    const memory = card(SETTINGS_COPY.memoryTitle);
    const follow = memory.querySelector<HTMLElement>('[data-memory-mode="follow"]');
    expect(follow?.style.opacity).not.toBe("0");
    const custom = radio(SETTINGS_COPY.custom, memory);
    if (custom === null) throw new Error("没有「单独设置」");
    act(() => custom.click());
    await flush();
    const next = memory.querySelector<HTMLElement>('[data-memory-mode="custom"]');
    expect(next?.style.opacity).toBe("0");
    expect(next?.style.transform ?? "").toBe("");
  });
});

describe("实例设置：Java 卡", () => {
  it("读取中卡头先占住副标题一行，版本要求读到后原位填上", async () => {
    const detecting = deferred<JavaInstallationDto[]>();
    ipc.overrides.set("detect_java", () => detecting.promise);
    await openSettings();
    const header = card(SETTINGS_COPY.javaTitle).querySelector("h3")?.parentElement;
    expect(header?.querySelector("[data-reserve]")).not.toBeNull();
    await act(async () => {
      detecting.resolve([java("C:/Java/jdk-21/bin/java.exe", 21)]);
      await settle(20);
    });
    expect(header?.querySelector("[data-reserve]")).toBeNull();
    expect(textOf(header as HTMLElement)).toContain("Java 21");
  });

  it("结论变了：旧说明原地淡出、不可交互，新说明淡入落位", async () => {
    settings = { ...settings, java: "C:/Java/jdk-17/bin/java.exe" };
    await openSettings();
    const javaCard = card(SETTINGS_COPY.javaTitle);
    const before = SETTINGS_COPY.fitLower(21);
    expect(textOf(javaCard)).toContain(before);
    act(() => button(SETTINGS_COPY.useAuto, javaCard).click());
    await flush();
    const leaving = [...javaCard.querySelectorAll<HTMLElement>("[inert]")];
    expect(leaving).toHaveLength(1);
    expect(textOf(leaving[0])).toContain(before);
    const fresh = [...javaCard.querySelectorAll<HTMLElement>("strong")].find((s) => s.textContent === SETTINGS_COPY.fitMatch(21));
    if (fresh === undefined) throw new Error("没有新结论");
    expect(appearLayer(fresh).style.opacity).toBe("0");
    expect(appearLayer(fresh).hasAttribute("inert")).toBe(false);
  });
});

describe("实例设置：JVM 参数卡", () => {
  const area = () => {
    const el = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="JVM 参数"]');
    if (el === null) throw new Error("没有 JVM 参数框");
    return el;
  };

  it("改出未保存的内容：卡头标签从 0.6 弹出；输入覆盖堆的参数时警示淡入落位，删掉后原地淡出", async () => {
    await openSettings();
    const jvm = card(SETTINGS_COPY.jvmTitle);
    typeInto(area(), "-Xmx8G");
    const tag = [...jvm.querySelectorAll<HTMLElement>("span")].find((s) => s.textContent === SETTINGS_COPY.unsaved && s.children.length === 0);
    if (tag === undefined) throw new Error("没有未保存标签");
    const pop = appearLayer(tag);
    expect(pop.style.opacity).toBe("0");
    expect(pop.style.transform).toContain("scale(0.6)");

    const warn = [...jvm.querySelectorAll<HTMLElement>("div")].find((d) => d.textContent === SETTINGS_COPY.heapOverride && d.children.length === 0);
    if (warn === undefined) throw new Error("没有堆参数警示");
    const layer = appearLayer(warn);
    expect(layer.style.opacity).toBe("0");
    // 警示与操作行同在一段让位容器里：警示出没时只推动操作行，不连文本框一起
    expect(layer.parentElement?.contains(button(SETTINGS_COPY.saveArgs, jvm))).toBe(true);
    expect(layer.parentElement?.contains(area())).toBe(false);

    typeInto(area(), "-XX:+UseG1GC");
    expect(layer.hasAttribute("inert")).toBe(true);
  });

  it("按住参数框（拖尺寸手柄）期间网格的让位暂停，下面的卡片跟着指针走；在哪儿松手都恢复", async () => {
    await openSettings();
    const grid = document.querySelector<HTMLElement>('[class*="settingsGrid"]');
    if (grid === null) throw new Error("没有设置网格");
    expect(grid.hasAttribute(REFLOW_PAUSED_ATTR)).toBe(false);
    act(() => {
      area().dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(grid.hasAttribute(REFLOW_PAUSED_ATTR)).toBe(true);
    act(() => {
      window.dispatchEvent(new Event("pointerup"));
    });
    expect(grid.hasAttribute(REFLOW_PAUSED_ATTR)).toBe(false);
  });
});

describe("实例设置：让位挂在哪里", () => {
  it("横幅与网格所在的竖排、卡片网格、JVM 卡的警示与操作行一段都挂了让位；参数框不在让位的段里", async () => {
    await openSettings();
    const grid = document.querySelector<HTMLElement>('[class*="settingsGrid"]');
    if (grid === null) throw new Error("没有设置网格");
    expect(reflowed.has(grid)).toBe(true);
    const stack = grid.parentElement;
    if (stack === null) throw new Error("网格没有外层");
    expect(stack.className).toMatch(/stack/);
    expect(reflowed.has(stack)).toBe(true);
    const jvm = card(SETTINGS_COPY.jvmTitle);
    const tail = button(SETTINGS_COPY.saveArgs, jvm).closest('[class*="actionsRow"]')?.parentElement;
    if (tail === null || tail === undefined) throw new Error("没有操作行所在的那一段");
    expect(reflowed.has(tail)).toBe(true);
    const textarea = jvm.querySelector("textarea");
    if (textarea === null) throw new Error("没有 JVM 参数框");
    expect(tail.contains(textarea)).toBe(false);
  });
});

describe("实例设置：比平时慢一些", () => {
  it("加载超过 10 s：外观卡与 JVM 卡的慢提示在骨架层外面（读屏读得到）、淡入落位；读到之后撤下", async () => {
    const advice = deferred<MemoryAdviceDto>();
    ipc.overrides.set("memory_advice", () => advice.promise);
    await openSettings();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SLOW_HINT_MS);
    });
    const hints = () => [...document.querySelectorAll<HTMLElement>("p")].filter((p) => p.textContent === SLOW_LOADING_HINT);
    const shown = hints();
    expect(shown.map((hint) => [card(SETTINGS_COPY.appearanceTitle).contains(hint), card(SETTINGS_COPY.jvmTitle).contains(hint)])).toEqual([
      [true, false],
      [false, true],
    ]);
    for (const hint of shown) {
      expect(hint.closest('[aria-hidden="true"]')).toBeNull();
      expect(appearLayer(hint).style.opacity).toBe("0");
    }
    await act(async () => {
      advice.resolve(memoryAdviceDto({ version_id: ID }));
      await settle(20);
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(shown.every((hint) => hint.closest("[inert]") !== null)).toBe(true);
  });
});

describe("实例设置：实例管理卡", () => {
  function typeName(value: string) {
    const input = row(SETTINGS_COPY.nameTitle).querySelector("input");
    if (input === null) throw new Error("没有名称输入框");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter === undefined) throw new Error("取不到 value 的 setter");
    act(() => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("名称校验错误换进说明槽：原来的说明留作占位，这一行不变高；错误用危险色，改对后说明换回来", async () => {
    await openSettings();
    const slot = description(row(SETTINGS_COPY.nameTitle)).firstElementChild as HTMLElement;
    expect(textOf(slot)).toBe(SETTINGS_COPY.nameNote);
    expect(slot.hasAttribute("data-tone")).toBe(false);
    typeName("");
    expect(textOf(slot)).toBe(INSTANCE_NAME_ERROR.empty);
    expect(slot.dataset.reserveA).toBe(SETTINGS_COPY.nameNote);
    expect(slot.dataset.tone).toBe("danger");
    typeName(ID);
    expect(textOf(slot)).toBe(SETTINGS_COPY.nameNote);
    expect(slot.hasAttribute("data-tone")).toBe(false);
  });

  it("游戏运行中危险区追加一句：换的是同一个说明槽，没运行时就按追加之后的那条占位", async () => {
    instances = [instanceDto(ID, { loaders: [{ kind: "fabric", version: "0.16.10" }], isolated: true, world_count: 3 })];
    await openSettings();
    const zone = document.querySelector<HTMLElement>('[class*="dangerZone"]');
    const slot = zone?.querySelector<HTMLElement>("[data-reserve-a]");
    if (slot === null || slot === undefined) throw new Error("危险区没有说明槽");
    const base = SETTINGS_COPY.deleteWorlds(3);
    expect(textOf(slot)).toBe(base);
    expect(slot.dataset.reserveA).toBe(`${base}${SETTINGS_COPY.deleteRunning}`);
    await act(async () => {
      await launcher.actions.launch(ID);
      await settle(20);
    });
    expect(textOf(slot)).toBe(`${base}${SETTINGS_COPY.deleteRunning}`);
    expect(slot.dataset.reserveA).toBe(base);
  });
});

describe("实例设置：会换的说明与按钮文案", () => {
  it("版本隔离的说明槽：文本只有当前这条，其余两条占位；换选项后新说明淡入", async () => {
    await openSettings();
    const isolation = row(SETTINGS_COPY.isolation, card(SETTINGS_COPY.windowTitle));
    const slot = description(isolation).firstElementChild as HTMLElement;
    const current = textOf(slot);
    expect(current).not.toBe("");
    expect([slot.dataset.reserveA, slot.dataset.reserveB]).toEqual([SETTINGS_COPY.isolationOnNote, SETTINGS_COPY.isolationOffNote]);
    const on = radio(SETTINGS_COPY.isolationOn, isolation);
    if (on === null) throw new Error("没有「开启」");
    act(() => on.click());
    await flush();
    expect(textOf(slot)).toBe(SETTINGS_COPY.isolationOnNote);
    expect(slot.firstElementChild?.hasAttribute("data-enter")).toBe(true);
    expect([slot.dataset.reserveA, slot.dataset.reserveB]).toEqual([SETTINGS_COPY.isolationOffNote, current]);
  });

  it("补全与重装加载器：按钮文案槽另一条画在伪元素里占宽；任务进行中两行都换成「进行中」，说明槽按两条里长的占位", async () => {
    ipc.overrides.set("repair_instance", () => new Promise(() => undefined));
    await openSettings();
    const repair = button(SETTINGS_COPY.repair);
    expect(repair.querySelector<HTMLElement>("[data-reserve]")?.dataset.reserve).toBe(SETTINGS_COPY.repairing);
    const repairNote = description(row(SETTINGS_COPY.repairTitle)).firstElementChild as HTMLElement;
    expect(textOf(repairNote)).toBe(SETTINGS_COPY.repairNote);
    expect(repairNote.dataset.reserveA).toBe(SETTINGS_COPY.repairRunning);

    act(() => button(SETTINGS_COPY.reinstallLoader).click());
    await flush();
    const busy = [...document.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.textContent === SETTINGS_COPY.repairing);
    expect(busy.map((b) => b.querySelector<HTMLElement>("[data-reserve]")?.dataset.reserve)).toEqual([SETTINGS_COPY.repair, SETTINGS_COPY.reinstallLoader]);
  });

  it("游戏运行中补全说明换成要先结束游戏：换的是同一个说明槽，原来那条留作占位", async () => {
    await openSettings();
    await act(async () => {
      await launcher.actions.launch(ID);
      await settle(20);
    });
    const slot = description(row(SETTINGS_COPY.repairTitle)).firstElementChild as HTMLElement;
    expect(textOf(slot)).toBe(SETTINGS_COPY.repairRunning);
    expect(slot.dataset.reserveA).toBe(SETTINGS_COPY.repairNote);
  });
});

describe("实例设置：默认设置一行", () => {
  const templateRow = () => row(SETTINGS_COPY.templateTitle);

  it("读取中第二行走加载门：300 ms 内骨架占位但不可见，之后才显出；没存过默认设置时这一行照样占着", async () => {
    const pending = deferred<TemplateInfoDto>();
    ipc.overrides.set("template_info", () => pending.promise);
    await openSettings();
    const layer = () => templateRow().querySelector<HTMLElement>('[aria-busy="true"] > [aria-hidden="true"]');
    expect(layer()?.hasAttribute("data-pending")).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(layer()?.hasAttribute("data-pending")).toBe(false);
    await act(async () => {
      pending.resolve(NO_TEMPLATE);
      await settle(20);
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(layer()).toBeNull();
    const line = templateRow().querySelector<HTMLElement>('[class*="templateLine"]');
    expect(line).not.toBeNull();
    expect(textOf(line as HTMLElement)).toBe("");
  });

  it("「清除」常驻占位：清除成功后还是同一个按钮，淡出并进了不可交互的层；焦点从它身上交给「保存为默认」", async () => {
    let template: TemplateInfoDto = { present: true, files: [{ name: "options.txt", size: 2048 }], source_instance: "创造", saved_at: Date.now() - 60_000, enabled: true };
    ipc.overrides.set("template_info", () => template);
    ipc.overrides.set("clear_template", () => {
      template = NO_TEMPLATE;
      return template;
    });
    await openSettings();
    const clear = [...templateRow().querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === SETTINGS_COPY.templateClear);
    if (clear === undefined) throw new Error("没有「清除」");
    const slot = clear.closest<HTMLElement>('[class*="clearSlot"]');
    if (slot === null) throw new Error("「清除」不在常驻槽里");
    expect(slot.hasAttribute("inert")).toBe(false);
    expect(slot.hasAttribute("data-hidden")).toBe(false);
    act(() => clear.focus());
    act(() => clear.click());
    await flush();
    expect(callsOf(ipc, "clear_template")).toHaveLength(1);
    expect(templateRow().contains(clear)).toBe(true);
    expect(slot.hasAttribute("inert")).toBe(true);
    expect(slot.hasAttribute("data-hidden")).toBe(true);
    expect(document.activeElement).toBe(button(SETTINGS_COPY.templateSave, templateRow()));
  });

  it("没存过默认设置：「清除」照样占着位置，只是透明、不可交互", async () => {
    await openSettings();
    const slot = templateRow().querySelector<HTMLElement>('[class*="clearSlot"]');
    expect(slot?.hasAttribute("inert")).toBe(true);
    expect(slot?.hasAttribute("data-hidden")).toBe(true);
    expect(slot?.textContent).toBe(SETTINGS_COPY.templateClear);
  });
});

describe("实例设置：占位规则（读样式表）", () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "instance.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (selector: string) => {
    const found = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].find((m) => m[1].trim() === selector);
    if (found === undefined) throw new Error(`样式表里没有 ${selector}`);
    return found[2];
  };

  it("默认设置的第二行常驻一行高", () => {
    expect(rule(".templateLine")).toMatch(/min-height:\s*var\(--sk-lh-small\)/);
  });

  it("按钮文案槽：另一条画在零高、不可见的伪元素里，只撑宽", () => {
    expect(rule(".swapLabel")).toMatch(/flex-direction:\s*column/);
    const after = rule(".swapLabel::after");
    expect(after).toMatch(/content:\s*attr\(data-reserve\)/);
    expect(after).toMatch(/height:\s*0/);
    expect(after).toMatch(/visibility:\s*hidden/);
  });

  it("内存骨架的跟随框去掉底色，外框与行高照真实的来", () => {
    expect(rule(".followSkeleton")).toMatch(/background:\s*none/);
  });

  it("「清除」的常驻槽：隐藏时只把透明度降到 0，进出只过渡透明度", () => {
    expect(rule(".clearSlot")).toMatch(/transition:\s*opacity var\(--sk-dur-in\) var\(--sk-ease-out\)/);
    const hidden = rule(".clearSlot[data-hidden]");
    expect(hidden).toMatch(/opacity:\s*0/);
    expect(hidden).toMatch(/transition:\s*opacity var\(--sk-dur-out\) var\(--sk-ease-in\)/);
  });

  it("骨架下方的慢提示与卡内各块隔 14，用内边距（退场抽出布局时外边距会让它下移）", () => {
    const slow = rule(".settingsSlow");
    expect(slow).toMatch(/padding-top:\s*var\(--sk-space-14\)/);
    expect(slow).not.toMatch(/margin/);
  });
});
