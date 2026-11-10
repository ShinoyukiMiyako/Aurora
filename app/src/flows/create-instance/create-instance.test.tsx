// @vitest-environment jsdom
// @module-tag heavy-page
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../art/illustrations/test-canvas";
import { INSTANCE_NAME_ERROR, SLOW_LOADING_HINT } from "../../copy/flows";
import { SLOW_HINT_MS } from "../../domain/limits";
// 版本清单、加载器版本、Java 这几条查询落到假后端。静态引入让假后端在首个查询之前就加载完：
// 几条查询同时触发桥里的动态引入时，后到的会拿到还没执行完的模块。
import { IpcError } from "../../ipc/errors";
import type { JavaInstallationDto } from "../../ipc/java";
import type { ManifestDto } from "../../state/queries/catalog";
import { mockInvoke, resetMocks } from "../../ipc/mock";
import { OverlayRoot } from "../../shell/overlay";
import { ShellProvider, useNav, type NavApi } from "../../shell/shell";
import type { CreateInstancePreset } from "../../state/flows";
import type { Appearance } from "../../domain/types";
import { AppearanceProvider, DEFAULT_APPEARANCE } from "../../state/appearance";
import { LauncherProvider, useLauncher, type LauncherApi } from "../../state/launcher";
import { resources } from "../../state/resource";
import { focusByKeyboard, keydown, render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { bootOverrides, callsOf, configDto, deferred, resetRecorder, settle } from "../../test/launcher";
import { CREATE_COPY } from "./copy";
import CreateInstanceFlow from "./index";

// jsdom 没有 requestAnimationFrame，动画库在模块加载时取不到就把帧循环设成空操作，换步的退场永远放不完。
// 在任何模块加载之前补一个走 setTimeout 的版本：调用时取的是当时的 setTimeout，假定时器推进即可驱动动画。
vi.hoisted(() => {
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16) as unknown as number;
  globalThis.cancelAnimationFrame = (handle: number) => clearTimeout(handle);
});
const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));
// 直接调 observeReflow 挂让位的容器记在这里；照常转给真的实现（jsdom 里它什么也不做）
const reflowed = vi.hoisted(() => new Set<HTMLElement>());
vi.mock("../../lib/reflow", async (orig) => {
  const real = await orig<typeof import("../../lib/reflow")>();
  return {
    ...real,
    observeReflow: (container: HTMLElement, spring?: Parameters<typeof real.observeReflow>[1]) => {
      reflowed.add(container);
      return real.observeReflow(container, spring);
    },
  };
});

let view: Rendered | undefined;
let nav: NavApi;
let launcher: LauncherApi;
let onClose: ReturnType<typeof vi.fn<() => void>>;
/** 元素上的程序化滚动：jsdom 没有 Element.scrollTo，这里记下参数并直接落到目标位置。 */
let scrolls: ScrollToOptions[];

function Probe() {
  nav = useNav();
  launcher = useLauncher();
  return null;
}

async function mount(preset: CreateInstancePreset | null = null, appearance: Appearance = DEFAULT_APPEARANCE) {
  view = render(
    <AppearanceProvider initial={appearance}>
      <LauncherProvider>
        <ShellProvider>
          <Probe />
          <CreateInstanceFlow preset={preset} onClose={onClose} />
          <OverlayRoot />
        </ShellProvider>
      </LauncherProvider>
    </AppearanceProvider>,
  );
  await flush();
}

/** 跑完排队的请求与换步动画（退场期间旧步骤仍在 DOM 里）。 */
const flush = () =>
  act(async () => {
    await settle();
    await vi.advanceTimersByTimeAsync(600);
  });

const dialog = () => {
  const el = document.querySelector<HTMLElement>('[role="dialog"]');
  if (el === null) throw new Error("新建实例弹窗没有打开");
  return el;
};
const subtitle = () => dialog().querySelector("h2 + p")?.textContent;

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
  });
}

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("jsdom 没有 input.value 的 setter");
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** 按钮上看得见的那条文案：定宽文案槽里叠着全部候选，只认当前那条。 */
function visibleText(el: Element): string | null {
  const current = el.querySelector("[data-current]");
  return current === null ? el.textContent : current.textContent;
}

/** 在场的按钮：退场中（inert）的「上一步」与撑宽度的隐形主按钮都不算。 */
function button(text: string, root: ParentNode = document): HTMLButtonElement {
  const el = [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.closest("[inert]") === null && visibleText(b) === text);
  if (el === undefined) throw new Error(`找不到按钮「${text}」`);
  return el;
}

/** 在场的元素：换步后退场中的那一步带 inert，淡出期间还在 DOM 里，不算。 */
function presentAll<T extends Element>(selector: string): T[] {
  return [...dialog().querySelectorAll<T>(selector)].filter((el) => el.closest("[inert]") === null);
}

/** 单选项：文字以 text 开头的 role="radio"（版本行后面还跟着标签与副行）。 */
function radio(text: string): HTMLButtonElement {
  const el = presentAll<HTMLButtonElement>('[role="radio"]').find((b) => b.getAttribute("aria-label") === text || b.textContent?.startsWith(text));
  if (el === undefined) throw new Error(`找不到单选项「${text}」`);
  return el;
}

const radios = () => presentAll<HTMLButtonElement>('[role="radio"]');
const checkedRadio = () => radios().find((r) => r.getAttribute("aria-checked") === "true");
const nameInput = () => {
  const el = presentAll<HTMLInputElement>("input").at(0);
  if (el === undefined) throw new Error("名称步没有输入框");
  return el;
};
/** 步骤导航里的一项：按步骤名精确匹配（「加载器」与「加载器版本」是两步）。 */
const stepButton = (label: string) => {
  const el = [...dialog().querySelectorAll<HTMLButtonElement>("ol button")].find((b) => b.querySelector("span + span > span:first-child")?.textContent === label);
  if (el === undefined) throw new Error(`步骤导航里没有「${label}」`);
  return el;
};
const heading = () => {
  const el = presentAll<HTMLHeadingElement>("h3").at(0);
  if (el === undefined) throw new Error("当前步骤没有标题");
  return el;
};

async function next() {
  click(button(CREATE_COPY.next));
  await flush();
}

async function fillName(name: string) {
  setInput(nameInput(), name);
  await next();
}

beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2026, 9, 31, 12) });
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
  onClose = vi.fn<() => void>();
  scrolls = [];
  reflowed.clear();
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value(this: HTMLElement, options: ScrollToOptions) {
      scrolls.push(options);
      if (options.top !== undefined) this.scrollTop = options.top;
    },
  });
  bootOverrides(ipc);
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("set_sidebar_pins", (args) => args.pins);
  // 安装任务一直挂着：用例只关心排进队列的参数，不跑假后端的下载进度
  ipc.overrides.set("install_version", () => deferred<never>().promise);
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  // 帧循环排了下一帧就不会再排：换回真实时钟前把排在假时钟上的帧放掉，否则下一个用例的动画永远等不到这一帧
  act(() => {
    vi.advanceTimersByTime(200);
  });
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  Reflect.deleteProperty(HTMLButtonElement.prototype, "animate");
});

/**
 * 按钮上的 Web Animations 调用：jsdom 没有 animate，装一个只记参数的替身。只装在按钮上（版本行）：
 * 装到 Element.prototype 上会让 framer-motion 改走 WAAPI。afterEach 里拆掉。
 */
function stubButtonAnimations(): { el: Element; keyframes: Keyframe[] }[] {
  const calls: { el: Element; keyframes: Keyframe[] }[] = [];
  Object.defineProperty(HTMLButtonElement.prototype, "animate", {
    configurable: true,
    value(this: HTMLButtonElement, keyframes: Keyframe[]) {
      calls.push({ el: this, keyframes });
      return { cancel() {}, finish() {} };
    },
  });
  return calls;
}

describe("新建实例：名称", () => {
  it("为空时不提示错误、只禁用下一步；重名与非法字符给出规则表里的那一句", async () => {
    await mount();
    expect(subtitle()).toBe("第 1 步，共 5 步 · 名称");
    expect(button(CREATE_COPY.next).disabled).toBe(true);
    expect(dialog().textContent).not.toContain(INSTANCE_NAME_ERROR.empty);
    setInput(nameInput(), "生存");
    expect(dialog().textContent).toContain(INSTANCE_NAME_ERROR.duplicate);
    expect(button(CREATE_COPY.next).disabled).toBe(true);
    setInput(nameInput(), "a:b");
    expect(dialog().textContent).toContain(INSTANCE_NAME_ERROR.illegal_char);
    setInput(nameInput(), "周末生存");
    expect(button(CREATE_COPY.next).disabled).toBe(false);
    expect(dialog().textContent).toContain("4/32");
  });

  it("灵感片填入名称，预览随之更新；Enter 进入下一步", async () => {
    await mount();
    expect(dialog().querySelector("aside")?.textContent).toContain(CREATE_COPY.untitled);
    click(button("建筑创造"));
    expect(nameInput().value).toBe("建筑创造");
    expect(dialog().querySelector("aside")?.textContent).toContain("建筑创造");
    keydown(nameInput(), "Enter");
    await flush();
    expect(subtitle()).toBe("第 2 步，共 5 步 · 游戏版本");
  });

  it("逐字输入名称不量弹窗面板：面板只按步骤形变，换步的那一次才量", async () => {
    await mount();
    const panel = dialog();
    let measures = 0;
    const real = panel.getBoundingClientRect.bind(panel);
    panel.getBoundingClientRect = () => {
      measures += 1;
      return real();
    };
    for (const typed of ["周", "周末", "周末生", "周末生存"]) setInput(nameInput(), typed);
    await flush();
    expect(nameInput().value).toBe("周末生存");
    expect(measures).toBe(0);
    await next();
    expect(subtitle()).toBe("第 2 步，共 5 步 · 游戏版本");
    expect(measures).toBeGreaterThan(0);
  });

  it("换步时正在淡出的上一步带 inert：旧步骤里的控件点不到、聚焦不到，新的一步照常可用", async () => {
    await mount();
    setInput(nameInput(), "周末生存");
    const leaving = nameInput().closest<HTMLElement>('[class*="_pane_"]');
    if (leaving === null) throw new Error("名称步不在步骤容器里");
    const main = leaving.parentElement;
    if (main === null) throw new Error("名称步没有挂在主列里");
    click(button(CREATE_COPY.next));
    // 提交的那一刻：名称步还在 DOM 里淡出，版本步已经挂上
    const panes = [...main.children];
    expect(panes).toHaveLength(2);
    expect(panes).toContain(leaving);
    expect(leaving.hasAttribute("inert")).toBe(true);
    const entering = panes.find((pane) => pane !== leaving);
    expect(entering?.hasAttribute("inert")).toBe(false);
    expect(heading().textContent).toBe(CREATE_COPY.version.title);
    expect(heading().closest('[class*="_pane_"]')).toBe(entering);
    await flush();
    expect(leaving.isConnected).toBe(false);
    expect(main.children).toHaveLength(1);
  });
});

describe("新建实例：完整走一遍", () => {
  it("版本列表迟迟不来：骨架下面说一句比平时慢，不是干等着", async () => {
    ipc.overrides.set("list_manifest", () => new Promise(() => undefined));
    await mount();
    await fillName("慢");
    expect(dialog().textContent).not.toContain(SLOW_LOADING_HINT);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SLOW_HINT_MS);
    });
    expect(dialog().textContent).toContain(SLOW_LOADING_HINT);
  });

  it("选版本、加载器、加载器版本、封面后创建：排入安装任务、通知、设为当前并打开详情", async () => {
    await mount();
    await fillName("周末生存");
    // 默认选中最新正式版
    expect(checkedRadio()?.textContent).toContain("1.21.1");
    click(radio("1.20.1"));
    await flush();
    expect(checkedRadio()?.textContent).toContain("需要 Java 17");
    await next();

    expect(radios().map((r) => r.textContent?.match(/^(原版|Fabric|Quilt|Forge|NeoForge)/)?.[0])).toEqual(["原版", "Fabric", "Quilt", "Forge", "NeoForge"]);
    click(radio("Fabric"));
    await flush();
    expect(subtitle()).toBe("第 3 步，共 6 步 · 加载器");
    await next();

    expect(subtitle()).toBe("第 4 步，共 6 步 · 加载器版本");
    expect(checkedRadio()?.textContent).toContain("Fabric 0.16.10");
    await next();

    click(radio("草方块"));
    await next();

    expect(subtitle()).toBe("第 6 步，共 6 步 · 确认");
    const text = dialog().textContent;
    expect(text).toContain("1.20.1 · 正式版");
    expect(text).toContain("Fabric 0.16.10");
    expect(text).toContain("草方块");
    expect(text).toContain("需要 Java 17，会自动下载");
    expect(text).toContain("预计下载约 655 MB · 不含加载器");
    expect(text).toContain("D:/Games/.minecraft/versions/周末生存");
    expect(text).toContain(CREATE_COPY.confirm.autoPin);

    click(button(CREATE_COPY.create));
    await flush();
    // 没有默认设置时不沿用；Fabric API 默认勾着，装好实例后再装
    expect(callsOf(ipc, "install_version")).toEqual([{ taskId: expect.any(String), id: "1.20.1", loader: "fabric", loaderVersion: "0.16.10", targetName: "周末生存", useTemplate: false }]);
    expect(launcher.state.toasts.map((t) => `${t.tone}:${t.title}:${t.body}`)).toContain(`info:开始安装「周末生存」:${CREATE_COPY.startedBody}`);
    expect(callsOf(ipc, "update_config")).toEqual([{ selectedVersion: "周末生存" }]);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(nav.route).toEqual({ page: "instance", id: "周末生存", tab: "overview" });
  });

  it("确认步不响应 Enter；取消勾选「创建后打开」时只关闭不跳转", async () => {
    await mount();
    await fillName("原版生存");
    await next();
    await next();
    await next();
    expect(subtitle()).toBe("第 5 步，共 5 步 · 确认");
    expect(dialog().textContent).toContain("Java 21 · 已安装（Eclipse Adoptium）");
    expect(dialog().textContent).toContain("预计下载约 712 MB");
    expect(dialog().textContent).not.toContain("不含加载器");
    keydown(heading(), "Enter");
    await flush();
    expect(callsOf(ipc, "install_version")).toEqual([]);
    click(button(CREATE_COPY.confirm.openAfter));
    click(button(CREATE_COPY.create));
    await flush();
    expect(callsOf(ipc, "install_version")).toEqual([{ taskId: expect.any(String), id: "1.21.1", loader: null, loaderVersion: null, targetName: "原版生存", useTemplate: false }]);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(nav.route).toEqual({ page: "home" });
  });

  const java21 = (vendor: string, security: number, missing: string[]): JavaInstallationDto => ({
    path: `C:/Java/${vendor}-21.0.${security}/bin/java.exe`,
    version: { major: 21, minor: 0, security, build: 0, raw: `21.0.${security}` },
    is_64bit: true,
    vendor,
    source: "registry",
    missing_files: missing,
  });

  async function confirmJavaText(): Promise<string> {
    await mount();
    await fillName("原版生存");
    await next();
    await next();
    await next();
    expect(subtitle()).toBe("第 5 步，共 5 步 · 确认");
    const text = dialog().textContent;
    if (text === null) throw new Error("确认步没有文字");
    return text;
  }

  it("确认步的 Java 跳过缺运行时文件的：同主版本另有完整的就写完整的那个，哪怕版本更低", async () => {
    ipc.overrides.set("detect_java", () => [java21("Eclipse Adoptium", 9, ["release", "lib/modules"]), java21("Microsoft", 3, [])]);
    const text = await confirmJavaText();
    expect(text).toContain("Java 21 · 已安装（Microsoft）");
    expect(text).not.toContain("Eclipse Adoptium");
  });

  it("确认步的 Java：同主版本只有不完整的，按要下载写", async () => {
    ipc.overrides.set("detect_java", () => [java21("Eclipse Adoptium", 9, ["lib/modules"])]);
    const text = await confirmJavaText();
    expect(text).toContain("需要 Java 21，会自动下载");
    expect(text).not.toContain("已安装");
  });

  it("版本清单没给全下载体积时预计下载写估不出，不写数字也不删掉这一行", async () => {
    await mount();
    await fillName("怀旧");
    click(button(CREATE_COPY.version.old));
    click(radio("1.5.2"));
    await flush();
    await next();
    await next();
    await next();
    expect(subtitle()).toBe("第 5 步，共 5 步 · 确认");
    expect(dialog().textContent).toContain("1.5.2 · 正式版");
    expect(dialog().textContent).toContain("Java 8 · 已安装（Oracle Corporation）");
    const keys = [...dialog().querySelectorAll("dt")].map((d) => d.textContent);
    expect(keys).toEqual(["名称", "游戏版本", "加载器", "封面", "Java", CREATE_COPY.confirm.download, "存放位置"]);
    const download = [...dialog().querySelectorAll("dt")].find((d) => d.textContent === CREATE_COPY.confirm.download);
    expect(download?.nextElementSibling?.textContent).toBe(CREATE_COPY.confirm.downloadUnknown);
    expect(dialog().textContent).not.toContain("约 ");
  });

  it("创建失败：弹窗留在确认步，顶部给出原因，主按钮恢复可点", async () => {
    await mount();
    await fillName("周末生存");
    await next();
    await next();
    await next();
    vi.spyOn(launcher.actions, "createInstance").mockRejectedValue(new Error("磁盘空间不足"));
    click(button(CREATE_COPY.create));
    await flush();
    expect(dialog().textContent).toContain(CREATE_COPY.confirm.failed);
    expect(dialog().textContent).toContain("磁盘空间不足");
    expect(button(CREATE_COPY.create).disabled).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    expect(callsOf(ipc, "update_config")).toEqual([]);
  });

  it("创建失败后再点：旧横幅留到这一次有结果，不先撤掉再插回；再失败换一个横幅节点重新播报，原因一字不差也换", async () => {
    await mount();
    await fillName("周末生存");
    await next();
    await next();
    await next();
    const second = deferred<string>();
    const third = deferred<string>();
    const create = vi
      .spyOn(launcher.actions, "createInstance")
      .mockRejectedValueOnce(new Error("磁盘空间不足"))
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    click(button(CREATE_COPY.create));
    await flush();
    const banners = () => [...dialog().querySelectorAll('[class*="_banner_"]')].filter((el) => el.closest("[inert]") === null);
    expect(banners().map((el) => el.textContent)).toEqual([`${CREATE_COPY.confirm.failed}磁盘空间不足`]);
    const first = banners()[0];
    const slot = first.closest('[class*="_failed_"]');
    if (slot === null) throw new Error("失败横幅不在横幅槽里");

    click(button(CREATE_COPY.create));
    await flush();
    expect(create).toHaveBeenCalledTimes(2);
    // 第二次还在进行：按钮换成进行中的文案，旧横幅还是同一个节点
    const busy = dialog().querySelector('button[aria-busy="true"]');
    if (busy === null) throw new Error("创建中的主按钮没有进入加载态");
    expect(visibleText(busy)).toBe(CREATE_COPY.creating);
    expect(banners()).toHaveLength(1);
    expect(banners()[0]).toBe(first);

    const fail = async (attempt: ReturnType<typeof deferred<string>>, reason: string) => {
      await act(async () => {
        attempt.reject(new Error(reason));
        await settle();
        await vi.advanceTimersByTimeAsync(600);
      });
    };
    // 原因与上一次一字不差：原地换字等于没变，读屏不会再念；换成新插入的 alert 才会
    await fail(second, "磁盘空间不足");
    expect(banners()).toHaveLength(1);
    const again = banners()[0];
    expect(again).not.toBe(first);
    expect(first.isConnected).toBe(false);
    expect(again.getAttribute("role")).toBe("alert");
    expect(again.textContent).toBe(`${CREATE_COPY.confirm.failed}磁盘空间不足`);
    // 槽位还是原来那一个：没有退场再入场，下面的内容不跳
    expect(again.closest('[class*="_failed_"]')).toBe(slot);
    expect(dialog().querySelectorAll('[class*="_failed_"]')).toHaveLength(1);

    click(button(CREATE_COPY.create));
    await flush();
    await fail(third, "目标文件夹被占用");
    expect(banners()).toHaveLength(1);
    expect(banners()[0]).not.toBe(again);
    expect(banners()[0].textContent).toBe(`${CREATE_COPY.confirm.failed}目标文件夹被占用`);
    expect(banners()[0].closest('[class*="_failed_"]')).toBe(slot);
  });

  it("创建失败时确认步滚回顶部：开局选项让这一步常要滚动，原因写在最上面，不能停在视野之外", async () => {
    await mount();
    await fillName("周末生存");
    await next();
    await next();
    await next();
    const pane = heading().closest<HTMLElement>('[class*="_pane_"]');
    if (pane === null) throw new Error("确认步不在滚动容器里");
    pane.scrollTop = 240;
    vi.spyOn(launcher.actions, "createInstance").mockRejectedValue(new Error("磁盘空间不足"));
    click(button(CREATE_COPY.create));
    await flush();
    expect(dialog().textContent).toContain("磁盘空间不足");
    // 平滑地滚回去，看得出内容往哪边走
    expect(scrolls).toEqual([{ top: 0, behavior: "smooth" }]);
    expect(pane.scrollTop).toBe(0);
  });
});

describe("新建实例：版本与加载器的联动", () => {
  it("只支持原版的版本：加载器步只有原版并注明缺哪些，步骤共 5 步、加载器版本标为跳过", async () => {
    await mount();
    await fillName("老版本");
    click(radio("1.5.2"));
    await next();
    expect(radios().map((r) => r.getAttribute("aria-checked"))).toEqual(["true"]);
    expect(dialog().textContent).toContain("1.5.2 没有 Fabric、Quilt、Forge、NeoForge 可用，换个游戏版本就能看到。");
    expect(subtitle()).toBe("第 3 步，共 5 步 · 加载器");
    expect(stepButton("加载器版本").textContent).toContain(CREATE_COPY.skippedValue);
  });

  it("关掉快照显示时选中的快照退回最新正式版；换到不支持当前加载器的版本时回到原版并收回进度", async () => {
    await mount();
    await fillName("快照尝鲜");
    click(button(CREATE_COPY.version.snapshots));
    click(radio("24w14a"));
    await next();
    click(radio("Fabric"));
    await next();
    expect(subtitle()).toBe("第 4 步，共 6 步 · 加载器版本");

    click(stepButton("游戏版本"));
    await flush();
    click(button(CREATE_COPY.version.snapshots));
    await flush();
    expect(checkedRadio()?.textContent).toContain("1.21.1");
    expect(stepButton("加载器").textContent).toContain("Fabric");

    click(radio("1.12.2"));
    await flush();
    expect(subtitle()).toBe("第 2 步，共 5 步 · 游戏版本");
    expect(stepButton("加载器").disabled).toBe(true);
    await next();
    expect(checkedRadio()?.textContent).toContain("原版");
  });

  it("几个加载器都拉不到：说明块只留一条，每个加载器的原因逐行写全，后端原文不被两行截断", async () => {
    const offline = "连不上 meta.fabricmc.net：操作超时";
    ipc.overrides.set("list_manifest", async () => ({
      ...(await mockInvoke<ManifestDto>("list_manifest")),
      loader_errors: [
        { loader: "forge", message: offline },
        { loader: "neoforge", message: offline },
      ],
    }));
    await mount();
    await fillName("拉不到");
    click(radio("1.5.2"));
    await next();
    expect(dialog().querySelectorAll('[class*="_callout_"]')).toHaveLength(1);
    expect(dialog().textContent).toContain("1.5.2 没有 Fabric、Quilt 可用，换个游戏版本就能看到。");
    const rows = [...dialog().querySelectorAll('[class*="_warnNote_"]')].map((el) => el.textContent);
    expect(rows).toEqual([`暂时拉不到 Forge 的版本信息：${offline}`, `暂时拉不到 NeoForge 的版本信息：${offline}`]);
  });

  it("带预设版本打开：选中预设版本并按它的类型打开快照显示", async () => {
    await mount({ mcVersion: "24w14a" });
    await fillName("资讯新建");
    expect(checkedRadio()?.textContent).toContain("24w14a");
    expect(button(CREATE_COPY.version.snapshots).getAttribute("aria-checked")).toBe("true");
  });

  it("版本搜索按版本号子串过滤，没有结果时说明", async () => {
    await mount();
    await fillName("搜索");
    const search = () => {
      const el = dialog().querySelector<HTMLInputElement>(`input[aria-label="${CREATE_COPY.version.search}"]`);
      if (el === null) throw new Error("版本步没有搜索框");
      return el;
    };
    expect(dialog().textContent).toContain("共 4 个版本");
    setInput(search(), "1.20");
    expect(radios().map((r) => r.textContent?.split("正式版")[0])).toEqual(["1.20.1"]);
    expect(dialog().textContent).toContain("共 1 个版本");
    setInput(search(), "1.19.5");
    expect(dialog().textContent).toContain("没有叫「1.19.5」的版本");
  });

  it("「随机一块」从其余 15 块里取，不会抽到当前这块", async () => {
    await mount();
    await fillName("随机");
    await next();
    // 封面步渲染时取走 Math.random 的引用，替身要在进入这一步之前装上
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    await next();
    expect(checkedRadio()?.getAttribute("aria-label")).toBe("樱花木板");
    click(button(CREATE_COPY.cover.shuffle));
    // 默认樱花木板被排除，其余 15 块的第一块是樱花树叶
    expect(checkedRadio()?.getAttribute("aria-label")).toBe("樱花树叶");
    random.mockReturnValue(0.999);
    click(button(CREATE_COPY.cover.shuffle));
    expect(checkedRadio()?.getAttribute("aria-label")).toBe("末地石砖");
    random.mockReturnValue(0);
    click(button(CREATE_COPY.cover.shuffle));
    expect(checkedRadio()?.getAttribute("aria-label")).toBe("樱花木板");
  });
});

describe("新建实例：确认步的 Java 与全局固定的默认 Java", () => {
  // 假后端扫描出的两个运行时
  const JRE8 = "C:\\Program Files\\Java\\jre1.8.0_421\\bin\\java.exe";
  const JDK21 = "C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.5.11-hotspot\\bin\\java.exe";

  /** 全局固定 defaultJava 后走到原版的确认步；oldVersions 打开远古版本的显示。 */
  async function confirmWith(defaultJava: string, mcVersion: string | null, oldVersions = false) {
    ipc.overrides.set("get_config", () => configDto({ default_java: defaultJava }));
    await mount();
    await fillName("固定测试");
    if (oldVersions) click(button(CREATE_COPY.version.old));
    if (mcVersion !== null) {
      click(radio(mcVersion));
      await flush();
    }
    await next();
    await next();
    await next();
    expect(subtitle()).toBe("第 5 步，共 5 步 · 确认");
  }

  /** 键值表里「Java」那一行的值。 */
  const javaRow = () => {
    const key = [...dialog().querySelectorAll("dt")].find((d) => d.textContent === CREATE_COPY.confirm.java);
    const value = key?.nextElementSibling;
    if (value === null || value === undefined) throw new Error("确认步没有 Java 一行");
    return value;
  };
  const isWarn = () => javaRow().querySelector('[class*="warnText"]') !== null;

  it("固定的 Java 低于要求：这一行显示 warn，写明会用 Java 8、需要 Java 21，并指向实例设置", async () => {
    await confirmWith(JRE8, null);
    expect(javaRow().textContent).toBe("会用固定的 Java 8，这个版本需要 Java 21");
    expect(isWarn()).toBe(true);
    expect(dialog().textContent).toContain("设置里固定的 Java 8 低于要求，这个实例启动时会失败。创建后可以在实例设置里给它单独指定 Java 21。");
    expect(dialog().textContent).not.toContain("Java 21 · 已安装");
    // 只是提醒，不挡创建
    expect(button(CREATE_COPY.create).disabled).toBe(false);
  });

  it("固定的 Java 高于要求：同样 warn，说明旧版 Forge 与部分 Mod 会报错", async () => {
    await confirmWith(JDK21, "1.5.2", true);
    expect(javaRow().textContent).toBe("会用固定的 Java 21，这个版本需要 Java 8");
    expect(isWarn()).toBe(true);
    expect(dialog().textContent).toContain("设置里固定的 Java 21 比要求的新，旧版 Forge 与部分 Mod 会直接报错。创建后可以在实例设置里给它单独指定 Java 8。");
  });

  it("要求的主版本本机没有：先下载再到实例设置里指定", async () => {
    await confirmWith(JRE8, "1.20.1");
    expect(javaRow().textContent).toBe("会用固定的 Java 8，这个版本需要 Java 17");
    expect(dialog().textContent).toContain("先在设置里下载 Java 17，创建后到实例设置里给它单独指定。");
    expect(dialog().textContent).not.toContain("会自动下载");
  });

  it("固定的路径已不在扫描结果里：不写已安装，说明启动会失败", async () => {
    await confirmWith("E:\\portable\\jdk-21\\bin\\java.exe", null);
    expect(javaRow().textContent).toBe("会用固定的默认 Java，但它已经找不到了");
    expect(isWarn()).toBe(true);
    expect(dialog().textContent).toContain("设置里固定的默认 Java 已经找不到了，这个实例启动时会失败。创建后可以在实例设置里给它单独指定 Java 21。");
  });

  it("Java 不符、快照与开局选项并存：只有一条说明块，自上而下是键值表、说明块、快照注记、开局选项、创建后打开", async () => {
    ipc.overrides.set("get_config", () => configDto({ default_java: JRE8 }));
    await mount({ mcVersion: "24w14a" });
    await fillName("快照尝鲜");
    await next();
    click(radio("Fabric"));
    await flush();
    await next();
    await next();
    await next();
    expect(heading().textContent).toBe(CREATE_COPY.confirm.title);
    expect(button(CREATE_COPY.create).disabled).toBe(false);

    const callouts = [...dialog().querySelectorAll('[class*="_callout_"]')];
    expect(callouts.map((el) => el.textContent)).toEqual(["设置里固定的 Java 8 低于要求，这个实例启动时会失败。创建后可以在实例设置里给它单独指定 Java 21。"]);
    expect([...dialog().querySelectorAll('[class*="_warnNote_"]')].map((el) => el.textContent)).toEqual([CREATE_COPY.confirm.snapshotWarning]);

    const body = dialog().textContent;
    if (body === null) throw new Error("确认步没有内容");
    const order = ["存放位置", "设置里固定的 Java 8", CREATE_COPY.confirm.snapshotWarning, CREATE_COPY.confirm.starter.template, "一并装上 Fabric API", CREATE_COPY.confirm.openAfter].map((part) => body.indexOf(part));
    expect(order).not.toContain(-1);
    expect(order).toEqual([...order].sort((x, y) => x - y));
  });

  it("固定的 Java 与要求一致：照常写已安装与它的发行方，没有提醒", async () => {
    await confirmWith(JDK21, null);
    expect(javaRow().textContent).toBe("Java 21 · 已安装（Eclipse Adoptium）");
    expect(isWarn()).toBe(false);
    expect(dialog().textContent).not.toContain("实例设置里给它单独指定");
  });

  const runtime = (path: string, major: number, missing: string[]): JavaInstallationDto => ({
    path,
    version: { major, minor: 0, security: 5, build: 0, raw: `${major}.0.5` },
    is_64bit: true,
    vendor: "Eclipse Adoptium",
    source: "registry",
    missing_files: missing,
  });

  it("要求的主版本只有不完整的：不算本机有，出路写先下载再指定", async () => {
    ipc.overrides.set("detect_java", () => [runtime(JRE8, 8, []), runtime(JDK21, 21, ["lib/modules"])]);
    await confirmWith(JRE8, null);
    expect(javaRow().textContent).toBe("会用固定的 Java 8，这个版本需要 Java 21");
    expect(dialog().textContent).toContain("先在设置里下载 Java 21，创建后到实例设置里给它单独指定。");
  });

  it("固定的 Java 本身不完整但主版本一致：后端照用固定路径，写已安装、不提醒", async () => {
    ipc.overrides.set("detect_java", () => [runtime(JDK21, 21, ["lib/modules"])]);
    await confirmWith(JDK21, null);
    expect(javaRow().textContent).toBe("Java 21 · 已安装（Eclipse Adoptium）");
    expect(isWarn()).toBe(false);
  });
});

describe("新建实例：确认步的开局选项", () => {
  const s = CREATE_COPY.confirm.starter;
  const DAY = 86_400_000;

  /** 开局选项里的一个复选框：按可见标签精确匹配。 */
  function checkbox(label: string): HTMLButtonElement {
    const el = [...dialog().querySelectorAll<HTMLButtonElement>('[role="checkbox"]')].find((b) => b.textContent === label);
    if (el === undefined) throw new Error(`找不到复选框「${label}」`);
    return el;
  }
  const checkboxLabels = () => [...dialog().querySelectorAll<HTMLButtonElement>('[role="checkbox"]')].map((b) => b.textContent);
  const isChecked = (el: HTMLElement) => el.getAttribute("aria-checked") === "true";
  const isBlocked = (el: HTMLElement) => el.getAttribute("aria-disabled") === "true";

  /** 走到 1.21.1 的确认步；loader 为 null 时停在原版。 */
  async function toConfirm(name: string, loader: "Fabric" | "Quilt" | "NeoForge" | null) {
    await mount();
    await fillName(name);
    await next();
    if (loader !== null) {
      click(radio(loader));
      await flush();
      await next();
    }
    await next();
    await next();
    expect(heading().textContent).toBe(CREATE_COPY.confirm.title);
  }

  it("Fabric 默认勾选 Fabric API、不勾性能组合；组合标签只数能装的 4 个；勾上后提交的 starterMods 依次是 5 项", async () => {
    await toConfirm("周末生存", "Fabric");
    expect(checkboxLabels()).toEqual([s.template, "一并装上 Fabric API", "装上性能优化组合（Sodium、Lithium 等 4 个）", CREATE_COPY.confirm.openAfter]);
    const api = checkbox("一并装上 Fabric API");
    const performance = checkbox("装上性能优化组合（Sodium、Lithium 等 4 个）");
    expect([isChecked(api), isBlocked(api)]).toEqual([true, false]);
    expect([isChecked(performance), isBlocked(performance)]).toEqual([false, false]);
    expect(dialog().textContent).toContain("大多数 Fabric Mod 都要它");
    expect(dialog().textContent).toContain("Sodium、Lithium、FerriteCore、ModernFix");
    expect(dialog().textContent).toContain(s.footnote);

    click(performance);
    expect(isChecked(performance)).toBe(true);
    const spy = vi.spyOn(launcher.actions, "createInstance");
    click(button(CREATE_COPY.create));
    await flush();
    expect(spy).toHaveBeenCalledTimes(1);
    const spec = spy.mock.calls[0][0];
    expect(spec.useTemplate).toBe(false);
    expect(spec.starterMods?.map((m) => [m.projectId, m.modVersionId, m.title])).toEqual([
      ["P7dR8mSH", "fapi-0115", "Fabric API"],
      ["AANobbMI", "sodium-121", "Sodium"],
      ["gvQqBUqZ", "lith-0143", "Lithium"],
      ["uXXizFIs", "fc-702-fabric", "FerriteCore"],
      ["nmDcB62a", "mfix-5194-fabric", "ModernFix"],
    ]);
    expect(spec.starterMods?.map((m) => m.fileSize)).toEqual([2_097_152, 1_048_576, 786_432, 143_360, 696_320]);
    expect(callsOf(ipc, "starter_mods")).toEqual([{ loader: "fabric", mcVersion: "1.21.1" }]);
  });

  it("取消勾选 Fabric API 后只提交性能组合；原版实例没有 API 与性能组合两项，也不查开局 Mod", async () => {
    await toConfirm("轻量", "Fabric");
    click(checkbox("一并装上 Fabric API"));
    click(checkbox("装上性能优化组合（Sodium、Lithium 等 4 个）"));
    const spy = vi.spyOn(launcher.actions, "createInstance");
    click(button(CREATE_COPY.create));
    await flush();
    expect(spy.mock.calls[0][0].starterMods?.map((m) => m.projectId)).toEqual(["AANobbMI", "gvQqBUqZ", "uXXizFIs", "nmDcB62a"]);
    view?.unmount();
    view = undefined;

    resetRecorder(ipc);
    bootOverrides(ipc);
    ipc.overrides.set("install_version", () => deferred<never>().promise);
    await toConfirm("原版", null);
    expect(checkboxLabels()).toEqual([s.template, CREATE_COPY.confirm.openAfter]);
    expect(dialog().textContent).not.toContain(s.footnote);
    expect(callsOf(ipc, "starter_mods")).toEqual([]);
  });

  it("Quilt 显示 QFAPI：1.21.1 没有适配的版本时不勾并说明原因；性能组合只剩 Lithium 一项，缺的写在警示行里", async () => {
    await toConfirm("拼布", "Quilt");
    const api = checkbox("一并装上 QFAPI");
    expect([isChecked(api), isBlocked(api)]).toEqual([false, true]);
    expect(dialog().textContent).toContain("大多数 Quilt Mod 都要它");
    const performance = checkbox("装上性能优化组合（Lithium）");
    expect([isChecked(performance), isBlocked(performance)]).toEqual([false, false]);
    expect(dialog().textContent).toContain("Sodium、FerriteCore 还没有适配 1.21.1，不会装上");
    // 禁用原因在键盘聚焦时立即给出，经 aria-describedby 关联到复选框上
    focusByKeyboard(api);
    const tip = document.getElementById(api.getAttribute("aria-describedby") ?? "");
    expect(tip?.textContent).toBe("QFAPI 还没有适配 1.21.1 的版本");
    click(api);
    expect(isChecked(api)).toBe(false);
  });

  it("没有默认设置时「沿用默认设置」禁用并写出原因；有模板时默认勾选，写出取自哪个实例", async () => {
    await toConfirm("无模板", "Fabric");
    const none = checkbox(s.template);
    expect([isChecked(none), isBlocked(none)]).toEqual([false, true]);
    expect(dialog().textContent).toContain("还没有默认设置。可以在任一实例的设置里把它保存为默认。");
    click(none);
    expect(isChecked(none)).toBe(false);
    view?.unmount();
    view = undefined;

    ipc.overrides.set("template_info", () => ({
      present: true,
      files: [{ name: "options.txt", size: 2048 }],
      source_instance: "樱花生存",
      saved_at: Date.now() - 3 * DAY,
      enabled: true,
    }));
    // 上一次挂载读到的「没有默认设置」还在缓存里
    resources.clear();
    await toConfirm("有模板", "Fabric");
    const on = checkbox(s.template);
    expect([isChecked(on), isBlocked(on)]).toEqual([true, false]);
    expect(dialog().textContent).toContain("取自「樱花生存」，3 天前保存");
    const spy = vi.spyOn(launcher.actions, "createInstance");
    click(button(CREATE_COPY.create));
    await flush();
    expect(spy.mock.calls[0][0].useTemplate).toBe(true);
    expect(callsOf(ipc, "install_version")[0].useTemplate).toBe(true);
  });

  it("有模板但新实例按全局策略不隔离（原版正式版）：不勾并说明用不上；手放的模板写来源不明", async () => {
    ipc.overrides.set("template_info", () => ({ present: true, files: [{ name: "servers.dat", size: 512 }], source_instance: null, saved_at: null, enabled: true }));
    await toConfirm("原版", null);
    const shared = checkbox(s.template);
    expect([isChecked(shared), isBlocked(shared)]).toEqual([false, true]);
    expect(dialog().textContent).toContain("这个实例与其他未隔离的实例共用 .minecraft 里的设置，用不上默认设置。");
    click(button(CREATE_COPY.back));
    await flush();
    click(button(CREATE_COPY.back));
    await flush();
    click(radio("Fabric"));
    await flush();
    await next();
    await next();
    await next();
    expect(isChecked(checkbox(s.template))).toBe(true);
    expect(dialog().textContent).toContain("取自数据目录里的默认设置");
  });

  it("开局 Mod 查不到：两项禁用并给出后端原文，说明行有「重试」，重查成功后恢复；创建不受影响", async () => {
    let fail = true;
    ipc.overrides.set("starter_mods", () => {
      if (fail) throw new IpcError("mod_platform_failed", "Modrinth 请求失败: HTTP 503");
      return { loader: "fabric", mc_version: "1.21.1", available: [], missing: [{ group: "api", project_id: "P7dR8mSH", name: "Fabric API", reason: "no_version" }] };
    });
    await toConfirm("断网", "Fabric");
    const api = checkbox("一并装上 Fabric API");
    const performance = checkbox("装上性能优化组合");
    expect([isBlocked(api), isChecked(api), isBlocked(performance), isChecked(performance)]).toEqual([true, false, true, false]);
    expect(dialog().textContent).toContain("查不到能装的版本：Modrinth 请求失败: HTTP 503");
    expect(button(CREATE_COPY.create).disabled).toBe(false);

    fail = false;
    click(button(CREATE_COPY.retry, dialog()));
    await flush();
    expect(callsOf(ipc, "starter_mods")).toHaveLength(2);
    expect(dialog().textContent).not.toContain("查不到能装的版本");
    // 这个版本一项都装不了：两项仍禁用，原因换成缺版本
    expect(isBlocked(checkbox("一并装上 Fabric API"))).toBe(true);
    expect(isBlocked(checkbox("装上性能优化组合"))).toBe(true);
  });
});

describe("新建实例：占位与换态", () => {
  const live = (selector: string) => [...dialog().querySelectorAll<HTMLElement>(selector)].filter((el) => el.closest("[inert]") === null);

  it("底栏：「上一步」第 2 步起才在；主按钮从头到尾是同一个按钮，隐形的创建按钮垫着定宽", async () => {
    await mount();
    expect(() => button(CREATE_COPY.back)).toThrow();
    const primary = button(CREATE_COPY.next);
    const slot = primary.closest('[class*="_primarySlot_"]');
    if (slot === null) throw new Error("主按钮不在定宽格里");
    const ghost = slot.querySelector("[inert] button");
    if (ghost === null) throw new Error("定宽格里没有隐形的创建按钮");
    expect(visibleText(ghost)).toBe(CREATE_COPY.create);
    expect(slot.querySelector("[inert]")?.getAttribute("aria-hidden")).toBe("true");

    await fillName("周末生存");
    expect(button(CREATE_COPY.back).closest('[class*="_footActions_"]')).not.toBeNull();
    await next();
    await next();
    await next();
    // 进确认步换成创建，仍是同一个按钮：聚焦着的按钮不丢焦点
    expect(button(CREATE_COPY.create)).toBe(primary);

    click(stepButton("名称"));
    await flush();
    expect(subtitle()).toBe("第 1 步，共 5 步 · 名称");
    expect(() => button(CREATE_COPY.back)).toThrow();
    expect(button(CREATE_COPY.next)).toBe(primary);
  });

  it("底栏提示：两句叠在同一格，只有当前那句可见", async () => {
    await mount();
    const lines = () => [...dialog().querySelectorAll('[class*="_footHintLine_"]')].map((el) => [el.textContent, el.hasAttribute("data-current"), el.getAttribute("aria-hidden")]);
    expect(lines()).toEqual([
      [`${CREATE_COPY.hintEnter}Enter${CREATE_COPY.hintEnterAfter}`, true, null],
      [CREATE_COPY.hintEsc, false, "true"],
    ]);
    await fillName("周末生存");
    expect(lines()).toEqual([
      [`${CREATE_COPY.hintEnter}Enter${CREATE_COPY.hintEnterAfter}`, false, "true"],
      [CREATE_COPY.hintEsc, true, null],
    ]);
  });

  it("名称为空按 Enter：不前进，输入框抖一次后归位", async () => {
    await mount();
    const shaker = nameInput().closest<HTMLElement>("[data-shaker]");
    if (shaker === null) throw new Error("名称输入框外面没有抖动层");
    keydown(nameInput(), "Enter");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(80);
    });
    expect(subtitle()).toBe("第 1 步，共 5 步 · 名称");
    expect(shaker.style.transform).toMatch(/translateX\(-?[1-9]/);
    await flush();
    expect(shaker.style.transform).toBe("none");
  });

  it("版本清单没到：前 300 ms 骨架只占位不可见，计数槽透明占位；之后骨架出现，读屏在骨架层外听到正在读取", async () => {
    const manifest = deferred<ManifestDto>();
    ipc.overrides.set("list_manifest", () => manifest.promise);
    await mount();
    setInput(nameInput(), "慢");
    click(button(CREATE_COPY.next));
    await act(async () => {
      await settle();
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(subtitle()).toBe("第 2 步，共 5 步 · 游戏版本");
    const skeleton = () => {
      const el = dialog().querySelector('[aria-busy="true"] > [aria-hidden="true"]');
      if (el === null) throw new Error("版本步没有骨架层");
      return el;
    };
    const status = () => {
      const el = dialog().querySelector('[role="status"]');
      if (el === null) throw new Error("版本步没有读取状态的播报区");
      return el;
    };
    expect(skeleton().hasAttribute("data-pending")).toBe(true);
    expect(skeleton().querySelectorAll('[class*="_skeletonRow_"]')).toHaveLength(6);
    // 骨架层对读屏隐藏，层里的名称读不到：不挂失效的 aria-label，说明放在层外
    expect(skeleton().querySelector("[aria-label]")).toBeNull();
    expect(status().closest('[aria-hidden="true"]')).toBeNull();
    expect(status().textContent).toBe("");
    const count = dialog().querySelector('[class*="_filterCount_"]');
    expect(count?.hasAttribute("data-pending")).toBe(true);
    expect(count?.getAttribute("aria-hidden")).toBe("true");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(skeleton().hasAttribute("data-pending")).toBe(false);
    expect(status().textContent).toBe(CREATE_COPY.version.loadingLabel);

    await act(async () => {
      manifest.resolve(await mockInvoke<ManifestDto>("list_manifest"));
      await settle();
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(radios().length).toBeGreaterThan(0);
    expect(status().textContent).toBe("");
  });

  it("离线缓存的版本列表：计数只写条数，离线说明在列表下面另起一行", async () => {
    const since = Date.now() - 3 * 86_400_000;
    ipc.overrides.set("list_manifest", async () => ({ ...(await mockInvoke<ManifestDto>("list_manifest")), stale_since: since }));
    await mount();
    await fillName("离线");
    const count = dialog().querySelector('[class*="_filterCount_"]');
    expect(count?.textContent).toBe("共 4 个版本");
    expect(count?.hasAttribute("data-pending")).toBe(false);
    expect(live('[class*="_listNote_"]').map((el) => el.textContent)).toEqual([CREATE_COPY.version.stale(since, Date.now())]);
  });

  const versionList = () => {
    const el = dialog().querySelector<HTMLElement>(`[role="radiogroup"][aria-label="${CREATE_COPY.version.listLabel}"]`);
    if (el === null) throw new Error("版本步没有列表");
    return el;
  };
  const versionSearch = () => {
    const el = dialog().querySelector<HTMLInputElement>(`input[aria-label="${CREATE_COPY.version.search}"]`);
    if (el === null) throw new Error("版本步没有搜索框");
    return el;
  };

  it("换筛选、进出的行不多：列表不整个重新淡入，只有新来的行淡入并从略小处落到位，留下的行由让位接住", async () => {
    const calls = stubButtonAnimations();
    await mount();
    await fillName("筛选");
    expect(reflowed.has(versionList())).toBe(true);
    const kept = radios();
    expect(kept).toHaveLength(4);

    click(button(CREATE_COPY.version.snapshots));
    const entered = radio("24w14a");
    expect(versionList().style.opacity).toBe("");
    expect(versionList().hasAttribute("data-reflow-paused")).toBe(false);
    expect(calls.map((c) => c.el)).toEqual([entered, entered]);
    expect(calls[0].keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(calls[1].keyframes[0]).toEqual({ scale: "0.98" });
    expect(calls[1].keyframes.at(-1)).toEqual({ scale: "1" });
    // 留下的行还是原来的节点，不跟着闪
    expect(radios().filter((r) => r !== entered)).toEqual(kept);

    // 搜索收窄：删掉的行直接离开，留下的行不重播入场，列表也不重新淡入
    calls.length = 0;
    setInput(versionSearch(), "1.2");
    expect(radios().map((r) => r.textContent?.match(/^[\w.]+/)?.[0])).toEqual(["1.21.1", "1.20.1"]);
    expect(versionList().style.opacity).toBe("");
    expect(calls).toEqual([]);
    await flush();
    expect(versionList().style.opacity).toBe("");
  });

  it("减少动画：新来的行只淡入，不缩放", async () => {
    const calls = stubButtonAnimations();
    await mount(null, { ...DEFAULT_APPEARANCE, reduceMotion: true });
    await fillName("筛选");
    click(button(CREATE_COPY.version.snapshots));
    expect(calls.map((c) => c.keyframes)).toEqual([[{ opacity: 0 }, { opacity: 1 }]]);
  });

  it("一次进出超过 40 行算换了一批：整个列表从透明淡入一次，这一批不让位、也不逐行入场", async () => {
    ipc.overrides.set("list_manifest", async () => {
      const base = await mockInvoke<ManifestDto>("list_manifest");
      const snapshots = Array.from({ length: 41 }, (_, i) => ({ ...base.versions[1], id: `25w${10 + i}a` }));
      return { ...base, versions: [...base.versions, ...snapshots] };
    });
    const calls = stubButtonAnimations();
    await mount();
    await fillName("筛选");
    expect(radios()).toHaveLength(4);

    click(button(CREATE_COPY.version.snapshots));
    expect(radios()).toHaveLength(46);
    // 透明度在提交时就压到 0；暂停开关与这一批增删同一次提交打开，下一帧关上
    expect(versionList().style.opacity).toBe("0");
    expect(versionList().hasAttribute("data-reflow-paused")).toBe(true);
    expect(calls).toEqual([]);
    await flush();
    expect(versionList().style.opacity).toBe("1");
    expect(versionList().hasAttribute("data-reflow-paused")).toBe(false);

    // 关回去：一次走掉 42 行，同样整批换上
    click(button(CREATE_COPY.version.snapshots));
    expect(radios()).toHaveLength(4);
    expect(versionList().style.opacity).toBe("0");
    expect(versionList().hasAttribute("data-reflow-paused")).toBe(true);
    await flush();
    expect(versionList().style.opacity).toBe("1");
    expect(calls).toEqual([]);
  });

  it("开局脚注常驻占位：两项都不勾时只是隐藏，勾上一项又显示", async () => {
    await mount();
    await fillName("脚注");
    await next();
    click(radio("Fabric"));
    await flush();
    await next();
    await next();
    await next();
    const note = () => {
      const el = [...dialog().querySelectorAll("p")].find((p) => p.textContent === CREATE_COPY.confirm.starter.footnote);
      if (el === undefined) throw new Error("确认步没有开局脚注");
      return el;
    };
    expect(note().getAttribute("aria-hidden")).toBeNull();
    const api = [...dialog().querySelectorAll<HTMLButtonElement>('[role="checkbox"]')].find((b) => b.textContent === "一并装上 Fabric API");
    if (api === undefined) throw new Error("确认步没有 Fabric API 一项");
    click(api);
    expect(note().getAttribute("aria-hidden")).toBe("true");
    expect(note().hasAttribute("data-hidden")).toBe(true);
    click(api);
    expect(note().hasAttribute("data-hidden")).toBe(false);
  });

  it("左栏：当前步的底色是同一块滑块；走过的步骤圆点换成勾号；预览卡不是悬停宿主", async () => {
    await mount();
    const marks = () => dialog().querySelectorAll('ol > [class*="_stepMark_"]');
    expect(marks()).toHaveLength(1);
    const mark = marks()[0];
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(stepButton("名称").querySelector("[data-glyph]:not([data-leaving])")?.getAttribute("data-glyph")).toBe("n1");
    await fillName("左栏");
    expect(marks()).toHaveLength(1);
    expect(marks()[0]).toBe(mark);
    expect(stepButton("名称").querySelector("[data-glyph]:not([data-leaving])")?.getAttribute("data-glyph")).toBe("check");
    expect(dialog().querySelector("aside [data-sk-hover-host]")).toBeNull();
  });

  it("预览卡的版本行常驻：清单没到时空着占一行，到了填上版本", async () => {
    const manifest = deferred<ManifestDto>();
    ipc.overrides.set("list_manifest", () => manifest.promise);
    await mount();
    const meta = () => {
      const el = dialog().querySelector('aside [class*="_previewMeta_"]');
      if (el === null) throw new Error("预览卡没有版本行");
      return el;
    };
    expect(meta().hasAttribute("data-pending")).toBe(true);
    expect(meta().textContent).toBe("");
    await act(async () => {
      manifest.resolve(await mockInvoke<ManifestDto>("list_manifest"));
      await settle();
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(meta().hasAttribute("data-pending")).toBe(false);
    expect(meta().textContent).toBe("1.21.1 · 原版");
  });
});

describe("新建实例：关闭", () => {
  it("只填了名称：取消直接关闭", async () => {
    await mount();
    setInput(nameInput(), "周末生存");
    click(button(CREATE_COPY.cancel));
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("填过两项以上：先确认放弃，「继续填写」留在流程里", async () => {
    await mount();
    await fillName("周末生存");
    click(radio("1.20.1"));
    await flush();
    click(button(CREATE_COPY.cancel));
    await flush();
    expect(document.body.textContent).toContain(CREATE_COPY.discard.title);
    click(button(CREATE_COPY.discard.cancel));
    await flush();
    expect(onClose).not.toHaveBeenCalled();
    click(button(CREATE_COPY.cancel));
    await flush();
    click(button(CREATE_COPY.discard.confirm));
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
