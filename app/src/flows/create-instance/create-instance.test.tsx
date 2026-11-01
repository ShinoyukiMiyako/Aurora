// @vitest-environment jsdom
// @module-tag heavy-page
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../art/illustrations/test-canvas";
import { INSTANCE_NAME_ERROR } from "../../copy/flows";
// 版本清单、加载器版本、Java 这几条查询落到假后端。静态引入让假后端在首个查询之前就加载完：
// 几条查询同时触发桥里的动态引入时，后到的会拿到还没执行完的模块。
import { IpcError } from "../../ipc/errors";
import type { JavaInstallationDto } from "../../ipc/java";
import type { ManifestDto } from "../../state/queries/catalog";
import { mockInvoke, resetMocks } from "../../ipc/mock";
import { OverlayRoot } from "../../shell/overlay";
import { ShellProvider, useNav, type NavApi } from "../../shell/shell";
import type { CreateInstancePreset } from "../../state/flows";
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
