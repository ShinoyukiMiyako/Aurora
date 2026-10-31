// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../art/illustrations/test-canvas";
import { INSTANCE_NAME_ERROR } from "../../copy/flows";
// 版本清单、加载器版本、Java 这几条查询落到假后端。静态引入让假后端在首个查询之前就加载完：
// 几条查询同时触发桥里的动态引入时，后到的会拿到还没执行完的模块。
import { resetMocks } from "../../ipc/mock";
import { OverlayRoot } from "../../shell/overlay";
import { ShellProvider, useNav, type NavApi } from "../../shell/shell";
import type { CreateInstancePreset } from "../../state/flows";
import { LauncherProvider, useLauncher, type LauncherApi } from "../../state/launcher";
import { keydown, render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { bootOverrides, callsOf, deferred, resetRecorder, settle } from "../../test/launcher";
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

let view: Rendered | undefined;
let nav: NavApi;
let launcher: LauncherApi;
let onClose: ReturnType<typeof vi.fn<() => void>>;

function Probe() {
  nav = useNav();
  launcher = useLauncher();
  return null;
}

async function mount(preset: CreateInstancePreset | null = null) {
  view = render(
    <LauncherProvider>
      <ShellProvider>
        <Probe />
        <CreateInstanceFlow preset={preset} onClose={onClose} />
        <OverlayRoot />
      </ShellProvider>
    </LauncherProvider>,
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

function button(text: string, root: ParentNode = document): HTMLButtonElement {
  const el = [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text);
  if (el === undefined) throw new Error(`找不到按钮「${text}」`);
  return el;
}

/** 单选项：文字以 text 开头的 role="radio"（版本行后面还跟着标签与副行）。 */
function radio(text: string): HTMLButtonElement {
  const el = [...dialog().querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.getAttribute("aria-label") === text || b.textContent?.startsWith(text));
  if (el === undefined) throw new Error(`找不到单选项「${text}」`);
  return el;
}

const radios = () => [...dialog().querySelectorAll<HTMLButtonElement>('[role="radio"]')];
const checkedRadio = () => radios().find((r) => r.getAttribute("aria-checked") === "true");
const nameInput = () => {
  const el = dialog().querySelector<HTMLInputElement>("input");
  if (el === null) throw new Error("名称步没有输入框");
  return el;
};
/** 步骤导航里的一项：按步骤名精确匹配（「加载器」与「加载器版本」是两步）。 */
const stepButton = (label: string) => {
  const el = [...dialog().querySelectorAll<HTMLButtonElement>("ol button")].find((b) => b.querySelector("span + span > span:first-child")?.textContent === label);
  if (el === undefined) throw new Error(`步骤导航里没有「${label}」`);
  return el;
};
const heading = () => {
  const el = dialog().querySelector("h3");
  if (el === null) throw new Error("当前步骤没有标题");
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
});

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
});

describe("新建实例：完整走一遍", () => {
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
    expect(callsOf(ipc, "install_version")).toEqual([{ taskId: expect.any(String), id: "1.20.1", loader: "fabric", loaderVersion: "0.16.10", targetName: "周末生存" }]);
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
    expect(callsOf(ipc, "install_version")).toEqual([{ taskId: expect.any(String), id: "1.21.1", loader: null, loaderVersion: null, targetName: "原版生存" }]);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(nav.route).toEqual({ page: "home" });
  });

  it("版本清单没给全下载体积时确认步不写预计下载", async () => {
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
    expect(dialog().textContent).not.toContain(CREATE_COPY.confirm.download);
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
