// @vitest-environment jsdom
// @module-tag heavy-page
import { act, useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOAST_COPY } from "../copy/flows";
import { SHELL_ACTION_ERROR } from "../copy/shell";
import { GAME_EXIT_EVENT } from "../ipc/launch";
import type { ModpackExportOptions } from "../ipc/modpack";
import type { UpdateDto } from "../ipc/system";
import { CORE_EVENT } from "../ipc/tasks";
import { LauncherProvider, useLauncher, type LauncherApi } from "../state/launcher";
import { activeTasks } from "../state/selectors";
import { useUpdater, type UpdaterApi } from "../state/updater/useUpdater";
import { keydown, render, setRect, stubResizeObserver, type Rendered } from "../test/dom";
import { CONFIRM_CANCEL_LABEL } from "../ui/ConfirmDialog";
import { NAV_ANCHOR_ATTR } from "../ui/Page";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, callsOf, emit, instanceDto, resetRecorder, settle } from "../test/launcher";
import { OverlayRoot } from "./overlay";
import { pickSaveFile } from "./platform";
import { ShellProvider, useNav, useShell, type NavApi, type ShellApi } from "./shell";
import { browserWindowPort, WindowPortProvider, type WindowPort } from "./window";

const PACK: ModpackExportOptions = { destination: "D:/分享/包.mrpack", name: "包", version: "1.0.0", summary: null, extras: [], include_disabled: false };

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));
vi.mock("./platform", async (orig) => {
  const actual = await orig<typeof import("./platform")>();
  return { ...actual, pickSaveFile: vi.fn(actual.pickSaveFile) };
});
/** 外壳核心每渲染一次调一次自动检查：数它的调用就是数外壳核心（连同自动检查自己的订阅）的渲染次数。 */
const coreRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("./update-check", async (orig) => {
  const actual = await orig<typeof import("./update-check")>();
  return {
    ...actual,
    useUpdaterAutoCheck: (...args: Parameters<typeof actual.useUpdaterAutoCheck>) => {
      coreRenders.count += 1;
      actual.useUpdaterAutoCheck(...args);
    },
  };
});

let view: Rendered | undefined;
let nav: NavApi;
let shell: ShellApi;
let launcher: LauncherApi;
let instances: ReturnType<typeof instanceDto>[];

function Probe() {
  nav = useNav();
  shell = useShell();
  launcher = useLauncher();
  return null;
}

async function mount() {
  view = render(
    <LauncherProvider>
      <ShellProvider>
        <Probe />
        <OverlayRoot />
      </ShellProvider>
    </LauncherProvider>,
  );
  await act(async () => {
    await settle();
  });
}

const flush = () =>
  act(async () => {
    await settle();
  });

const dialogTitle = () => document.querySelector('[role="dialog"] h2')?.textContent;
const button = (text: string) => {
  const el = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === text);
  if (el === undefined) throw new Error(`弹窗里找不到按钮 ${text}`);
  return el;
};

beforeEach(() => {
  vi.useFakeTimers();
  resetRecorder(ipc);
  stubResizeObserver();
  instances = [instanceDto("生存"), instanceDto("创造")];
  bootOverrides(ipc, { instances, pins: ["创造"] });
  ipc.overrides.set("list_instances", () => instances);
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
});

describe("外壳：重启并安装更新", () => {
  it("只有备份这类本地任务：确认框不说成下载，取消键是「取消」，取消后不安装", async () => {
    ipc.overrides.set("backup_world", () => new Promise(() => {}));
    await mount();
    act(() => void launcher.actions.backupWorld("生存", "w1", "旧世界"));
    await flush();
    act(() => void shell.installUpdate());
    await flush();
    expect(dialogTitle()).toBe("重启并安装更新？");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("还有 1 个任务，重启会中断它们，之后需要重新开始。");
    expect(button("重启并安装").dataset.variant).toBe("danger");
    act(() => button("取消").click());
    await flush();
    expect(callsOf(ipc, "install_update")).toHaveLength(0);
  });

  it("只有打包：同样不说成下载，取消键是「取消」", async () => {
    ipc.overrides.set("export_modpack", () => new Promise(() => {}));
    await mount();
    act(() => void launcher.actions.exportModpack("生存", PACK));
    await flush();
    act(() => void shell.installUpdate());
    await flush();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("还有 1 个任务，重启会中断它们，之后需要重新开始。");
    act(() => button("取消").click());
    await flush();
    expect(callsOf(ipc, "install_update")).toHaveLength(0);
  });

  it("下载与备份都有：个数连备份一起算、正文不写下载，取消键是「继续下载」", async () => {
    ipc.overrides.set("backup_world", () => new Promise(() => {}));
    ipc.overrides.set("install_java", () => new Promise(() => {}));
    await mount();
    act(() => void launcher.actions.backupWorld("生存", "w1", "旧世界"));
    act(() => void launcher.actions.installJava(21));
    await flush();
    act(() => void shell.installUpdate());
    await flush();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("还有 2 个任务，重启会中断它们，之后需要重新开始。");
    act(() => button("继续下载").click());
    await flush();
    expect(callsOf(ipc, "install_update")).toHaveLength(0);
  });
});

describe("外壳：启动器更新的下载进度", () => {
  const UPDATE: UpdateDto = { version: "0.2.0", current_version: "0.1.0", notes: null, date: null };

  it("下载更新的进度事件不让外壳核心重渲染（连同其中的自动检查）；打开更新面板仍按此刻的阶段取版本", async () => {
    ipc.overrides.set("updater_info", () => ({ current_version: "0.1.0", supported: true, unsupported_reason: null, available: UPDATE, downloaded_version: null, install_on_exit: false }));
    ipc.overrides.set("download_update", () => new Promise(() => undefined));
    // 经对象持有：闭包里给外层 let 赋值时 TypeScript 会把它收窄成 null
    const probe: { api: UpdaterApi | null } = { api: null };
    /** 整份订阅更新状态的一方放在外壳核心的子项位置：它自己的重渲染不算进外壳核心。 */
    function UpdaterProbe() {
      probe.api = useUpdater();
      return null;
    }
    const api = (): UpdaterApi => {
      if (probe.api === null) throw new Error("更新状态探针没有挂上");
      return probe.api;
    };
    view = render(
      <LauncherProvider>
        <ShellProvider>
          <Probe />
          <UpdaterProbe />
          <OverlayRoot />
        </ShellProvider>
      </LauncherProvider>,
    );
    await flush();
    expect(api().state.phase.kind).toBe("available");
    act(() => void api().download());
    await flush();
    const [{ taskId }] = callsOf(ipc, "download_update");
    if (typeof taskId !== "string") throw new Error("下载命令没带 taskId");
    expect(api().state.phase.kind).toBe("downloading");

    const before = coreRenders.count;
    expect(before).toBeGreaterThan(0);
    const events = 5 + Math.floor(Math.random() * 10);
    for (let i = 1; i <= events; i++) {
      act(() => emit(CORE_EVENT, { kind: "download", task_id: taskId, total: 1, finished: 0, bytes: i * 1000, total_bytes: events * 1000, speed: 0 }));
    }
    // 进度确实都进了状态，整份订阅的探针看到了最后一条
    expect(api().state.phase).toMatchObject({ kind: "downloading", bytes: events * 1000, totalBytes: events * 1000 });
    expect(coreRenders.count).toBe(before);

    // 外壳核心不订阅更新状态，打开面板时经快照读到的仍是下载中的这一版，并记为看过
    act(() => shell.openUpdatePanel());
    expect(shell.updatePanelOpen).toBe(true);
    expect(api().state.seenVersion).toBe("0.2.0");
    // 计数确实接在外壳核心上：它自己的状态变化照常让它重渲染
    expect(coreRenders.count).toBeGreaterThan(before);
  });

  it("外壳核心因无关状态重渲染时，打开更新面板与重启安装的回调连同整份外壳接口引用不变", async () => {
    ipc.overrides.set("backup_world", () => new Promise(() => {}));
    await mount();
    const before = { shell, openUpdatePanel: shell.openUpdatePanel, installUpdate: shell.installUpdate, renders: coreRenders.count };
    const backups = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < backups; i++) act(() => void launcher.actions.backupWorld("生存", `w${i}`, `世界 ${i}`));
    await flush();
    // 活动任务数变了，外壳核心确实重渲染过
    expect(activeTasks(launcher.state)).toHaveLength(backups);
    expect(coreRenders.count).toBeGreaterThan(before.renders);
    expect(shell.openUpdatePanel).toBe(before.openUpdatePanel);
    expect(shell.installUpdate).toBe(before.installUpdate);
    expect(shell).toBe(before.shell);
  });
});

describe("外壳：导航", () => {
  it("go / back / forward 驱动路由与前后可用态", async () => {
    await mount();
    expect(nav.route).toEqual({ page: "home" });
    expect([nav.canBack, nav.canForward]).toEqual([false, false]);
    act(() => nav.go({ page: "instance", id: "生存", tab: "overview" }));
    act(() => nav.replace({ page: "instance", id: "生存", tab: "mods" }));
    expect(nav.route).toEqual({ page: "instance", id: "生存", tab: "mods" });
    act(() => nav.back());
    expect(nav.route).toEqual({ page: "home" });
    expect(nav.canForward).toBe(true);
    act(() => nav.forward());
    expect(nav.route).toEqual({ page: "instance", id: "生存", tab: "mods" });
  });

  it("到达方式：启动后是 boot，之后记下最近一次导航是 go、back、forward 还是 replace；没变的导航不改", async () => {
    await mount();
    expect(nav.arrival).toBe("boot");
    act(() => nav.go({ page: "instance", id: "生存", tab: "overview" }));
    expect(nav.arrival).toBe("go");
    act(() => nav.replace({ page: "instance", id: "生存", tab: "mods" }));
    expect(nav.arrival).toBe("replace");
    act(() => nav.back());
    expect(nav.arrival).toBe("back");
    act(() => nav.forward());
    expect(nav.arrival).toBe("forward");
    act(() => nav.go({ page: "instance", id: "生存", tab: "mods" }));
    expect(nav.arrival).toBe("forward");
  });

  it("同一页换标签：锚点滚出视口上方时先瞬时滚回锚点（留出它的 scroll-margin-top），锚点在视口里或没有锚点时不动", async () => {
    await mount();
    const scroller = document.createElement("div");
    const anchor = document.createElement("div");
    anchor.setAttribute(NAV_ANCHOR_ATTR, "");
    anchor.style.scrollMarginTop = "8px";
    scroller.append(anchor);
    document.body.append(scroller);
    act(() => shell.bindPageScroll(scroller));
    act(() => nav.go({ page: "instance", id: "生存", tab: "overview" }));
    setRect(scroller, { left: 0, top: 56, width: 900, height: 600 });
    // 锚点在内容里的位置是 320
    const scrollTo = (top: number) => {
      scroller.scrollTop = top;
      setRect(anchor, { left: 0, top: 56 + 320 - top, width: 900, height: 40 });
    };

    scrollTo(900);
    act(() => nav.replace({ page: "instance", id: "生存", tab: "mods" }));
    expect(scroller.scrollTop).toBe(312);

    scrollTo(200);
    act(() => nav.replace({ page: "instance", id: "生存", tab: "logs" }));
    expect(scroller.scrollTop).toBe(200);

    // 同一个路由不算换：不动
    scrollTo(900);
    act(() => nav.replace({ page: "instance", id: "生存", tab: "logs" }));
    expect(scroller.scrollTop).toBe(900);

    anchor.removeAttribute(NAV_ANCHOR_ATTR);
    act(() => nav.replace({ page: "instance", id: "生存", tab: "crash" }));
    expect(scroller.scrollTop).toBe(900);
    scroller.remove();
  });

  it("锚点标在吸顶元素上或吸顶元素里面：换标签时直接报错，不静默失效", async () => {
    await mount();
    const scroller = document.createElement("div");
    const sticky = document.createElement("nav");
    sticky.className = "navCard";
    const anchor = document.createElement("div");
    anchor.setAttribute(NAV_ANCHOR_ATTR, "");
    sticky.append(anchor);
    scroller.append(sticky);
    document.body.append(scroller);
    act(() => shell.bindPageScroll(scroller));
    act(() => nav.go({ page: "instance", id: "生存", tab: "overview" }));

    sticky.style.position = "sticky";
    expect(() => act(() => nav.replace({ page: "instance", id: "生存", tab: "mods" }))).toThrow("导航锚点不能是吸顶元素，也不能在吸顶元素里面：nav.navCard");
    expect(nav.route).toEqual({ page: "instance", id: "生存", tab: "overview" });

    sticky.style.position = "";
    anchor.style.position = "sticky";
    expect(() => act(() => nav.replace({ page: "instance", id: "生存", tab: "mods" }))).toThrow("导航锚点不能是吸顶元素");

    // 锚点与滚动容器之间都不吸顶：照常换
    anchor.style.position = "";
    act(() => nav.replace({ page: "instance", id: "生存", tab: "mods" }));
    expect(nav.route).toEqual({ page: "instance", id: "生存", tab: "mods" });
    scroller.remove();
  });

  describe("换标签时托住页面高度", () => {
    // 滚动区可视 600；页面根里依次是头图、标签条（锚点，在内容里的位置是 320）、面板。页面高按最低高度取，
    // 滚动位置像浏览器一样夹在 [0, 页面高 - 600] 之内
    const VIEW = 600;
    const ANCHOR_AT = 320;

    function stage(natural: number) {
      const scroller = document.createElement("div");
      const page = document.createElement("div");
      const anchor = document.createElement("div");
      anchor.setAttribute(NAV_ANCHOR_ATTR, "");
      page.append(document.createElement("header"), anchor, document.createElement("section"));
      scroller.append(page);
      document.body.append(scroller);
      let content = natural;
      let scrolled = 0;
      const floor = () => (page.style.minHeight === "" ? 0 : Number.parseFloat(page.style.minHeight));
      const height = () => Math.max(content, floor());
      const clamp = (top: number) => Math.max(0, Math.min(top, height() - VIEW));
      Object.defineProperty(page, "offsetHeight", { configurable: true, get: height });
      Object.defineProperty(scroller, "clientHeight", { configurable: true, value: VIEW });
      Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: height });
      Object.defineProperty(scroller, "scrollTop", {
        configurable: true,
        get: () => scrolled,
        set: (top: number) => {
          scrolled = clamp(top);
          setRect(anchor, { left: 0, top: 56 + ANCHOR_AT - scrolled, width: 900, height: 40 });
        },
      });
      setRect(scroller, { left: 0, top: 56, width: 900, height: VIEW });
      scroller.scrollTop = 0;
      act(() => shell.bindPageScroll(scroller));
      return {
        scroller,
        page,
        anchor,
        /** 新面板挂上：页面的内容高变成 next，越界的滚动位置夹回。 */
        swap(next: number) {
          content = next;
          scroller.scrollTop = scrolled;
        },
        scrollTo(top: number) {
          scroller.scrollTop = top;
          scroller.dispatchEvent(new Event("scroll"));
        },
      };
    }

    it("滚回锚点之后按此刻的滚动位置托住锚点所在的页面根：新面板较短时滚动不被夹回，标签条不下跳", async () => {
      await mount();
      const view = stage(2000);
      act(() => nav.go({ page: "instance", id: "生存", tab: "overview" }));
      view.scrollTo(1000);
      act(() => nav.replace({ page: "instance", id: "生存", tab: "mods" }));
      // 滚回锚点：320；下面还能滚 2000 - 320 - 600 = 1080，页面至少留 2000 - 1080 = 920
      expect(view.scroller.scrollTop).toBe(ANCHOR_AT);
      expect(view.page.style.minHeight).toBe("920px");
      expect(view.anchor.style.minHeight).toBe("");
      view.swap(700);
      expect(view.scroller.scrollTop).toBe(ANCHOR_AT);
      view.scroller.remove();
    });

    it("连着换两次：按含托底的此刻高度重算，不叠加；滚回页顶后撤掉，页面回到按内容定高", async () => {
      await mount();
      const view = stage(2000);
      act(() => nav.go({ page: "instance", id: "生存", tab: "overview" }));
      view.scrollTo(1000);
      act(() => nav.replace({ page: "instance", id: "生存", tab: "mods" }));
      view.swap(700);
      act(() => nav.replace({ page: "instance", id: "生存", tab: "logs" }));
      expect(view.page.style.minHeight).toBe("920px");
      view.swap(500);
      expect(view.scroller.scrollTop).toBe(ANCHOR_AT);
      view.scrollTo(0);
      expect(view.page.style.minHeight).toBe("");
      expect(view.scroller.scrollHeight).toBe(500);
      view.scroller.remove();
    });

    it("页面没有锚点时不托", async () => {
      await mount();
      const view = stage(2000);
      view.anchor.removeAttribute(NAV_ANCHOR_ATTR);
      act(() => nav.go({ page: "instance", id: "生存", tab: "overview" }));
      view.scrollTo(1000);
      act(() => nav.replace({ page: "instance", id: "生存", tab: "mods" }));
      expect(view.page.style.minHeight).toBe("");
      view.scroller.remove();
    });

    it("换到别的页面就不再盯着滚动容器", async () => {
      await mount();
      const view = stage(2000);
      act(() => nav.go({ page: "instance", id: "生存", tab: "overview" }));
      view.scrollTo(1000);
      act(() => nav.replace({ page: "instance", id: "生存", tab: "mods" }));
      const removed = vi.spyOn(view.scroller, "removeEventListener");
      act(() => nav.go({ page: "library" }));
      expect(removed).toHaveBeenCalledWith("scroll", expect.any(Function));
      view.scroller.remove();
    });
  });

  it("实例被删除：当前页落到之前的存活项，历史里指向它的项一并剪除", async () => {
    await mount();
    act(() => nav.go({ page: "library" }));
    act(() => nav.go({ page: "instance", id: "生存", tab: "overview" }));
    instances = [instanceDto("创造")];
    await act(async () => {
      await launcher.actions.refreshInstances();
    });
    await flush();
    expect(nav.route).toEqual({ page: "library" });
    expect(nav.canForward).toBe(false);
  });

  it("滚动位置：go 回到顶部，后退恢复离开时的位置", async () => {
    await mount();
    const scroller = document.createElement("div");
    act(() => shell.bindPageScroll(scroller));
    act(() => nav.go({ page: "library" }));
    scroller.scrollTop = 640;
    act(() => nav.go({ page: "tasks" }));
    expect(scroller.scrollTop).toBe(0);
    act(() => nav.back());
    expect(scroller.scrollTop).toBe(640);
  });

  it("打开崩溃实例的诊断页即收起它的崩溃会话", async () => {
    ipc.overrides.set("launch_game", () => ({ pid: 1 }));
    ipc.overrides.set("last_crash", () => null);
    await mount();
    await act(async () => {
      await launcher.actions.launch("生存");
    });
    act(() => emit(GAME_EXIT_EVENT, { version_id: "生存", exit_code: 1, crashed: true, killed: false, duration_ms: 1000 }));
    await flush();
    expect(launcher.state.session?.phase).toBe("crashed");
    act(() => nav.go({ page: "instance", id: "生存", tab: "crash" }));
    await flush();
    expect(launcher.state.session).toBeNull();
  });
});

describe("外壳：确认框与启动替换", () => {
  it("新的确认顶掉尚未回答的旧请求，旧请求按取消结算", async () => {
    await mount();
    let first: Promise<boolean> | null = null;
    let second: Promise<boolean> | null = null;
    act(() => {
      first = shell.confirm({ title: "删除「生存」？", confirmLabel: "删除实例", tone: "danger" });
    });
    act(() => {
      second = shell.confirm({ title: "结束游戏？", confirmLabel: "结束游戏", tone: "danger" });
    });
    await expect(first).resolves.toBe(false);
    expect(dialogTitle()).toBe("结束游戏？");
    act(() => button("结束游戏").click());
    await expect(second).resolves.toBe(true);
  });

  // 按请求换 key 时开着的框连遮罩一起卸掉重挂，遮罩断一帧；原地换内容又得重做初始聚焦，不然焦点停在旧的确认键上
  it("确认框开着时被顶替：框不重挂，换成危险确认时焦点回到「取消」", async () => {
    await mount();
    act(() => {
      void shell.confirm({ title: "切换下载源？", confirmLabel: "切换并重下" });
    });
    const layer = document.querySelector("[data-sk-modal-layer]");
    expect(document.activeElement).toBe(button("切换并重下"));
    act(() => {
      void shell.confirm({ title: "删除「生存」？", confirmLabel: "删除实例", tone: "danger" });
    });
    expect(document.querySelectorAll("[data-sk-modal-layer]")).toHaveLength(1);
    expect(document.querySelector("[data-sk-modal-layer]")).toBe(layer);
    expect(dialogTitle()).toBe("删除「生存」？");
    expect(document.activeElement).toBe(button(CONFIRM_CANCEL_LABEL));

    // 框关上之后再来的请求才换一个新的框：旧框直接拿掉，不和新框并存
    act(() => button(CONFIRM_CANCEL_LABEL).click());
    act(() => {
      void shell.confirm({ title: "结束游戏？", confirmLabel: "结束游戏", tone: "danger" });
    });
    const layers = document.querySelectorAll("[data-sk-modal-layer]");
    expect(layers).toHaveLength(1);
    expect(layers[0]).not.toBe(layer);
    expect(dialogTitle()).toBe("结束游戏？");
    expect(document.activeElement).toBe(button(CONFIRM_CANCEL_LABEL));
  });

  it("另一实例在运行时再点启动：弹替换确认，确认后结束旧的并启动新的", async () => {
    ipc.overrides.set("launch_game", () => ({ pid: 1 }));
    ipc.overrides.set("stop_game", () => {
      emit(GAME_EXIT_EVENT, { version_id: "生存", exit_code: 0, crashed: false, killed: true, duration_ms: 1000 });
      return null;
    });
    await mount();
    await act(async () => {
      await launcher.actions.launch("生存");
    });
    expect(launcher.state.session).toMatchObject({ instanceId: "生存", phase: "running" });
    await act(async () => {
      await launcher.actions.launch("创造");
    });
    await flush();
    expect(dialogTitle()).toBe("结束「生存」并启动「创造」？");
    act(() => button("结束并启动").click());
    await flush();
    expect(callsOf(ipc, "stop_game")).toHaveLength(1);
    expect(callsOf(ipc, "launch_game").map((a) => a.versionId)).toEqual(["生存", "创造"]);
    expect(launcher.state.session).toMatchObject({ instanceId: "创造", phase: "running" });
    expect(launcher.state.launchPrompt).toBeNull();
  });

  it("替换确认开着时旧游戏自己退出：弹窗改口，确认后直接启动，不再发结束请求", async () => {
    ipc.overrides.set("launch_game", () => ({ pid: 1 }));
    await mount();
    await act(async () => {
      await launcher.actions.launch("生存");
    });
    await act(async () => {
      await launcher.actions.launch("创造");
    });
    await flush();
    expect(dialogTitle()).toBe("结束「生存」并启动「创造」？");

    act(() => emit(GAME_EXIT_EVENT, { version_id: "生存", exit_code: 0, crashed: false, killed: false, duration_ms: 1000 }));
    await flush();
    expect(dialogTitle()).toBe("启动「创造」？");
    expect(launcher.state.launchPrompt).toMatchObject({ instanceId: "创造", occupantPhase: "gone" });

    act(() => button("启动").click());
    await flush();
    expect(callsOf(ipc, "stop_game")).toEqual([]);
    expect(callsOf(ipc, "launch_game").map((a) => a.versionId)).toEqual(["生存", "创造"]);
    expect(launcher.state.session).toMatchObject({ instanceId: "创造", phase: "running" });
    expect(launcher.state.launchPrompt).toBeNull();
  });

  it("改口后取消：不启动，弹窗关掉", async () => {
    ipc.overrides.set("launch_game", () => ({ pid: 1 }));
    await mount();
    await act(async () => {
      await launcher.actions.launch("生存");
    });
    await act(async () => {
      await launcher.actions.launch("创造");
    });
    await flush();
    act(() => emit(GAME_EXIT_EVENT, { version_id: "生存", exit_code: 0, crashed: false, killed: false, duration_ms: 1000 }));
    await flush();

    act(() => button(CONFIRM_CANCEL_LABEL).click());
    await flush();
    expect(callsOf(ipc, "launch_game").map((a) => a.versionId)).toEqual(["生存"]);
    expect(launcher.state.launchPrompt).toBeNull();
  });
});

describe("外壳：全局快捷键", () => {
  it("Ctrl+K 开合命令面板；面板开着时导航快捷键无效", async () => {
    await mount();
    keydown(window, "k", { ctrlKey: true, code: "KeyK" });
    expect(shell.palette).toEqual({ open: true, query: "" });
    keydown(window, "2", { ctrlKey: true, code: "Digit2" });
    keydown(window, "k", { ctrlKey: true, code: "KeyK" });
    expect(shell.palette.open).toBe(false);
    expect(nav.route).toEqual({ page: "home" });
    keydown(window, "2", { ctrlKey: true, code: "Digit2" });
    expect(nav.route).toEqual({ page: "library" });
  });

  it("按住 Ctrl+K 不放：系统的按键自动重复不让面板开了又关", async () => {
    await mount();
    keydown(window, "k", { ctrlKey: true, code: "KeyK" });
    for (let i = 0; i < 3; i++) {
      const held = keydown(window, "k", { ctrlKey: true, code: "KeyK", repeat: true });
      expect(held.defaultPrevented).toBe(true);
      expect(shell.palette.open).toBe(true);
    }
    keydown(window, "k", { ctrlKey: true, code: "KeyK" });
    expect(shell.palette.open).toBe(false);
  });

  it("按住 Alt+← 不放照常逐项后退（与浏览器一致）", async () => {
    await mount();
    act(() => nav.go({ page: "library" }));
    act(() => nav.go({ page: "discover" }));
    keydown(window, "ArrowLeft", { altKey: true });
    keydown(window, "ArrowLeft", { altKey: true, repeat: true });
    expect(nav.route).toEqual({ page: "home" });
  });

  it("Alt+← 后退，Alt+1 打开第一个固定实例，Ctrl+N 打开新建实例，Ctrl+, 进设置", async () => {
    await mount();
    keydown(window, "1", { altKey: true, code: "Digit1" });
    expect(nav.route).toEqual({ page: "instance", id: "创造", tab: "overview" });
    keydown(window, "ArrowLeft", { altKey: true });
    expect(nav.route).toEqual({ page: "home" });
    keydown(window, ",", { ctrlKey: true, code: "Comma" });
    expect(nav.route).toEqual({ page: "settings" });
    keydown(window, "n", { ctrlKey: true, code: "KeyN" });
    expect(shell.createInstance).toEqual({ open: true, preset: null });
  });

  it("有浮层时 Alt+← 只关栈顶一层，不后退", async () => {
    await mount();
    act(() => nav.go({ page: "library" }));
    act(() => {
      void shell.confirm({ title: "取消全部 2 个任务？", confirmLabel: "全部取消" });
    });
    await flush();
    keydown(window, "ArrowLeft", { altKey: true });
    await flush();
    expect(nav.route).toEqual({ page: "library" });
  });

  it("Ctrl+F 交给最后登记的页面处理器，注销后无动作", async () => {
    await mount();
    const a = vi.fn();
    const b = vi.fn();
    const offA = shell.registerFind(a);
    const offB = shell.registerFind(b);
    const event = keydown(window, "f", { ctrlKey: true, code: "KeyF" });
    expect(event.defaultPrevented).toBe(true);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
    offB();
    offA();
    keydown(window, "f", { ctrlKey: true, code: "KeyF" });
    expect(a).not.toHaveBeenCalled();
  });

  it("目标就是当前页：Ctrl+数字、Alt+数字、Ctrl+, 都滚回顶部，不压历史；别的页照常跳过去", async () => {
    await mount();
    const chrome = { scrollContentToTop: vi.fn(), focusContent: vi.fn() };
    act(() => shell.bindChrome(chrome));
    act(() => shell.bindPageScroll(document.createElement("div")));

    keydown(window, "1", { ctrlKey: true, code: "Digit1" });
    expect(chrome.scrollContentToTop).toHaveBeenCalledTimes(1);
    expect(nav.route).toEqual({ page: "home" });
    expect(nav.canBack).toBe(false);

    keydown(window, "1", { altKey: true, code: "Digit1" });
    expect(nav.route).toEqual({ page: "instance", id: "创造", tab: "overview" });
    keydown(window, "1", { altKey: true, code: "Digit1" });
    expect(chrome.scrollContentToTop).toHaveBeenCalledTimes(2);
    // 同一实例的别的标签不算当前页：快捷键回到概览
    act(() => nav.replace({ page: "instance", id: "创造", tab: "mods" }));
    keydown(window, "1", { altKey: true, code: "Digit1" });
    expect(nav.route).toEqual({ page: "instance", id: "创造", tab: "overview" });
    expect(chrome.scrollContentToTop).toHaveBeenCalledTimes(2);

    keydown(window, ",", { ctrlKey: true, code: "Comma" });
    expect(nav.route).toEqual({ page: "settings" });
    keydown(window, ",", { ctrlKey: true, code: "Comma" });
    expect(chrome.scrollContentToTop).toHaveBeenCalledTimes(3);
    expect(chrome.focusContent).not.toHaveBeenCalled();
  });

  /** 窗口级按键监听里抛出的错误：不会抛给派发者，只在 window 上报一次 error 事件。收下并拦住它，返回这期间报出的错误。 */
  function uncaught(run: () => void): unknown[] {
    const errors: unknown[] = [];
    const onError = (event: ErrorEvent) => {
      errors.push(event.error);
      event.preventDefault();
    };
    window.addEventListener("error", onError);
    try {
      run();
    } finally {
      window.removeEventListener("error", onError);
    }
    return errors;
  }

  it("内容区还没挂上（向导收尾、退场还在播）：按到当前页什么都不做，不报错；内容区挂上之后照常滚回顶部", async () => {
    await mount();
    const chrome = { scrollContentToTop: vi.fn(), focusContent: vi.fn() };
    act(() => shell.bindChrome(chrome));
    expect(uncaught(() => keydown(window, "1", { ctrlKey: true, code: "Digit1" }))).toEqual([]);
    expect(chrome.scrollContentToTop).not.toHaveBeenCalled();
    expect(nav.route).toEqual({ page: "home" });
    expect(nav.canBack).toBe(false);

    act(() => shell.bindPageScroll(document.createElement("div")));
    keydown(window, "1", { ctrlKey: true, code: "Digit1" });
    expect(chrome.scrollContentToTop).toHaveBeenCalledTimes(1);
  });

  it("内容区挂着、外壳布局却没交来滚回顶部的能力：属于装配错误，照常报错", async () => {
    await mount();
    act(() => shell.bindPageScroll(document.createElement("div")));
    const errors = uncaught(() => keydown(window, "1", { ctrlKey: true, code: "Digit1" }));
    expect(errors.map((e) => (e instanceof Error ? e.message : String(e)))).toEqual(["外壳布局还没挂载，快捷键没法把内容区滚回顶部"]);
  });

  it("首次启动向导期间导航快捷键全部无效", async () => {
    bootOverrides(ipc, { instances, firstRun: true });
    ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
    await mount();
    keydown(window, "2", { ctrlKey: true, code: "Digit2" });
    keydown(window, "k", { ctrlKey: true, code: "KeyK" });
    expect(nav.route).toEqual({ page: "home" });
    expect(shell.palette.open).toBe(false);
  });
});

describe("外壳：通知动作", () => {
  it("先关闭这条通知再导航", async () => {
    await mount();
    act(() => {
      launcher.actions.toast("error", "2 个下载失败", "原因各不相同", { action: { label: "查看", to: { page: "tasks", filter: "failed" } } });
    });
    const toast = launcher.state.toasts[0];
    act(() => shell.runToastAction(toast));
    expect(launcher.state.toasts).toEqual([]);
    expect(nav.route).toEqual({ page: "tasks", filter: "failed" });
  });

  it("改名后点击留着的「查看诊断」：落到新名字的崩溃页，不被当成已删除的实例送回实例库", async () => {
    ipc.overrides.set("launch_game", () => ({ pid: 1 }));
    ipc.overrides.set("last_crash", () => null);
    ipc.overrides.set("rename_instance", () => {
      instances = instances.map((i) => (i.id === "生存" ? { ...i, id: "生存二" } : i));
      return { id: "生存二" };
    });
    await mount();
    await act(async () => {
      await launcher.actions.launch("生存");
    });
    act(() => emit(GAME_EXIT_EVENT, { version_id: "生存", exit_code: 1, crashed: true, killed: false, duration_ms: 1000 }));
    await flush();

    await act(async () => {
      await launcher.actions.renameInstance("生存", "生存二");
    });
    await flush();
    const toast = launcher.state.toasts.find((t) => t.title === "「生存」崩溃了");
    if (toast === undefined) throw new Error("崩溃通知应还留着");
    act(() => shell.runToastAction(toast));

    expect(nav.route).toEqual({ page: "instance", id: "生存二", tab: "crash" });
  });

  it("人已经到了通知指向的页面：这条收起，指向别处的留着", async () => {
    await mount();
    act(() => {
      launcher.actions.toast("error", "「生存」崩溃了", undefined, { action: { label: "查看诊断", to: { page: "instance", id: "生存", tab: "crash" } } });
      launcher.actions.toast("error", "「创造」崩溃了", undefined, { action: { label: "查看诊断", to: { page: "instance", id: "创造", tab: "crash" } } });
      launcher.actions.toast("error", "没有动作");
    });
    act(() => nav.go({ page: "instance", id: "生存", tab: "crash" }));
    await flush();
    expect(launcher.state.toasts.map((t) => t.title)).toEqual(["「创造」崩溃了", "没有动作"]);
  });

  it("页面已经开着时新来的通知也不再指回这里", async () => {
    await mount();
    act(() => nav.go({ page: "instance", id: "生存", tab: "crash" }));
    await flush();
    act(() => {
      launcher.actions.toast("error", "「生存」崩溃了", undefined, { action: { label: "查看诊断", to: { page: "instance", id: "生存", tab: "crash" } } });
    });
    await flush();
    expect(launcher.state.toasts).toEqual([]);
  });
});

describe("外壳：窗口焦点", () => {
  it("花瓣暂停认窗口的焦点事件，不认网页的 focus / blur；晚回来的初值不盖掉已经收到的事件", async () => {
    const focusHandlers: ((focused: boolean) => void)[] = [];
    const answers: ((focused: boolean) => void)[] = [];
    const port: WindowPort = {
      ...browserWindowPort(),
      isFocused: () => new Promise<boolean>((resolve) => answers.push(resolve)),
      onFocusChanged: async (handler) => {
        focusHandlers.push(handler);
        return () => {};
      },
    };
    view = render(
      <WindowPortProvider port={port}>
        <LauncherProvider>
          <ShellProvider>
            <Probe />
            <OverlayRoot />
          </ShellProvider>
        </LauncherProvider>
      </WindowPortProvider>,
    );
    await flush();
    const windowFocus = (focused: boolean) => act(() => focusHandlers.forEach((handler) => handler(focused)));

    windowFocus(true);
    expect(shell.petalsPaused).toBe(false);
    windowFocus(false);
    expect(shell.petalsPaused).toBe(true);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(shell.petalsPaused).toBe(true);
    await act(async () => answers.forEach((answer) => answer(true)));
    expect(shell.petalsPaused).toBe(true);
    windowFocus(true);
    expect(shell.petalsPaused).toBe(false);
  });

  it("订阅前读回的初值：窗口说失焦就按失焦", async () => {
    view = render(
      <WindowPortProvider port={{ ...browserWindowPort(), isFocused: async () => false, onFocusChanged: async () => () => {} }}>
        <LauncherProvider>
          <ShellProvider>
            <Probe />
            <OverlayRoot />
          </ShellProvider>
        </LauncherProvider>
      </WindowPortProvider>,
    );
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();
    expect(shell.petalsPaused).toBe(true);
  });
});

describe("外壳：最小化期间的通知", () => {
  // 窗口状态与 visibilityState 是两路独立的信号：这里的用例只动窗口状态，不动 document，「两路同时变」单独写
  let minimized: boolean;
  let resized: () => void;
  const port = (): WindowPort => ({
    ...browserWindowPort(),
    isMinimized: async () => minimized,
    onResized: async (handler) => {
      resized = handler;
      return () => {};
    },
  });
  const mountWithPort = async () => {
    view = render(
      <WindowPortProvider port={port()}>
        <LauncherProvider>
          <ShellProvider>
            <Probe />
            <OverlayRoot />
          </ShellProvider>
        </LauncherProvider>
      </WindowPortProvider>,
    );
    await flush();
  };
  const windowChanged = async (next: boolean) => {
    minimized = next;
    resized();
    await flush();
  };
  const titles = () => launcher.state.toasts.map((t) => t.title);

  beforeEach(() => {
    minimized = false;
    // 用例要把时钟拨过自动检查更新的延时：不支持更新时不排期，不会多出一条「可以更新了」
    ipc.overrides.set("updater_info", () => ({ current_version: "0.1.0", supported: false, unsupported_reason: null, available: null, downloaded_version: null, install_on_exit: false }));
  });

  it("最小化期间到点的通知不消失，还原后按剩余时长继续走完", async () => {
    await mountWithPort();
    await act(async () => launcher.actions.toast("info", "已停用 Sodium"));
    await windowChanged(true);

    await act(async () => void vi.advanceTimersByTime(60_000));
    expect(titles()).toEqual(["已停用 Sodium"]);

    await windowChanged(false);
    await act(async () => void vi.advanceTimersByTime(60_000));
    expect(titles()).toEqual([]);
  });

  it("窗口没有最小化时通知照常到点消失", async () => {
    await mountWithPort();
    await act(async () => launcher.actions.toast("info", "已停用 Sodium"));
    await windowChanged(false);
    await act(async () => void vi.advanceTimersByTime(60_000));
    expect(titles()).toEqual([]);
  });

  it("读不出窗口状态经外层统一错误处理报告", async () => {
    view = render(
      <WindowPortProvider port={{ ...port(), isMinimized: () => Promise.reject(new Error("窗口已销毁")) }}>
        <LauncherProvider>
          <ShellProvider>
            <Probe />
            <OverlayRoot />
          </ShellProvider>
        </LauncherProvider>
      </WindowPortProvider>,
    );
    await flush();
    expect(launcher.state.toasts.map((t) => [t.title, t.body])).toEqual([[SHELL_ACTION_ERROR.windowState, "窗口已销毁"]]);
  });

  describe("visibilityState 与窗口状态两路同时变化", () => {
    const setVisibility = (state: DocumentVisibilityState) => {
      vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
    };
    let pausedLog: boolean[];
    /** 花瓣暂停取决于窗口可见：记下每一次翻转，抖动就是多出来的项。 */
    function PausedLog() {
      const { petalsPaused } = useShell();
      useLayoutEffect(() => {
        pausedLog.push(petalsPaused);
      }, [petalsPaused]);
      return null;
    }
    const mountLogged = async () => {
      view = render(
        <WindowPortProvider port={port()}>
          <LauncherProvider>
            <ShellProvider>
              <Probe />
              <PausedLog />
              <OverlayRoot />
            </ShellProvider>
          </LauncherProvider>
        </WindowPortProvider>,
      );
      await flush();
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      pausedLog = [];
    };

    beforeEach(() => {
      pausedLog = [];
    });

    it.each([
      ["hidden 先到，窗口状态后到", ["visibility", "window"]],
      ["窗口状态先到，hidden 后到", ["window", "visibility"]],
    ] as const)("最小化与还原都是%s：暂停只翻转一次，不抖动，还原不漏", async (_name, order) => {
      await mountLogged();
      const apply = async (signal: "visibility" | "window", down: boolean) => {
        if (signal === "visibility") setVisibility(down ? "hidden" : "visible");
        else await windowChanged(down);
      };

      for (const signal of order) await apply(signal, true);
      expect(pausedLog).toEqual([true]);
      for (const signal of order) await apply(signal, false);
      expect(pausedLog).toEqual([true, false]);
    });

    it("还原时只回来一路：另一路没到之前仍算不可见，通知继续暂停", async () => {
      await mountLogged();
      await act(async () => launcher.actions.toast("info", "已停用 Sodium"));
      setVisibility("hidden");
      await windowChanged(true);
      setVisibility("visible");
      await act(async () => void vi.advanceTimersByTime(60_000));
      expect(titles()).toEqual(["已停用 Sodium"]);

      await windowChanged(false);
      await act(async () => void vi.advanceTimersByTime(60_000));
      expect(titles()).toEqual([]);
    });

    it("只有 hidden 一路（读不到最小化）：通知同样暂停，页面重新可见后走完", async () => {
      await mountLogged();
      await act(async () => launcher.actions.toast("info", "已停用 Sodium"));
      setVisibility("hidden");
      await act(async () => void vi.advanceTimersByTime(60_000));
      expect(titles()).toEqual(["已停用 Sodium"]);

      setVisibility("visible");
      await act(async () => void vi.advanceTimersByTime(60_000));
      expect(titles()).toEqual([]);
    });
  });

  it("窗口状态的两次读取乱序回来：晚到的「已最小化」不盖掉后发的「已还原」，通知照常走完", async () => {
    const reads: ((value: boolean) => void)[] = [];
    view = render(
      <WindowPortProvider port={{ ...port(), isMinimized: () => new Promise<boolean>((resolve) => reads.push(resolve)) }}>
        <LauncherProvider>
          <ShellProvider>
            <Probe />
            <OverlayRoot />
          </ShellProvider>
        </LauncherProvider>
      </WindowPortProvider>,
    );
    await flush();
    expect(reads).toHaveLength(1);
    reads[0](false);
    await flush();
    await act(async () => launcher.actions.toast("info", "已停用 Sodium"));

    // 最小化紧接着还原：两次读取都还在路上
    resized();
    resized();
    expect(reads).toHaveLength(3);
    reads[2](false);
    await flush();
    reads[1](true);
    await flush();

    await act(async () => void vi.advanceTimersByTime(60_000));
    expect(titles()).toEqual([]);
  });
});

describe("外壳：写剪贴板", () => {
  let writeText: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  });

  it("写入成功：原文写进剪贴板，结果为 true，不弹通知", async () => {
    await mount();
    let written: boolean | undefined;
    await act(async () => {
      written = await shell.copyText("C:\\Games\\.minecraft\\versions\\生存");
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("C:\\Games\\.minecraft\\versions\\生存");
    expect(written).toBe(true);
    expect(launcher.state.toasts).toEqual([]);
  });

  it("写入失败：弹一条「复制失败」，结果为 false，Promise 不 reject", async () => {
    writeText.mockImplementation(() => Promise.reject(new Error("Document is not focused.")));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await mount();
    let written: boolean | undefined;
    await act(async () => {
      written = await shell.copyText("");
    });
    expect(written).toBe(false);
    expect(launcher.state.toasts.map((t) => [t.tone, t.title, t.body])).toEqual([["error", TOAST_COPY.copyFailed, "Document is not focused."]]);
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe("外壳：页面级快捷键", () => {
  it("F2 交给最后登记的处理器并屏蔽默认行为；注销后同一组合交还给更早登记的，全部注销后无动作", async () => {
    await mount();
    const a = vi.fn();
    const b = vi.fn();
    const offA = shell.registerShortcut({ key: "F2" }, a);
    const offB = shell.registerShortcut({ key: "F2" }, b);
    const event = keydown(window, "F2", { code: "F2" });
    expect(event.defaultPrevented).toBe(true);
    expect([a.mock.calls.length, b.mock.calls.length]).toEqual([0, 1]);
    offB();
    keydown(window, "F2", { code: "F2" });
    expect([a.mock.calls.length, b.mock.calls.length]).toEqual([1, 1]);
    offA();
    const idle = keydown(window, "F2", { code: "F2" });
    expect(idle.defaultPrevented).toBe(false);
    expect([a.mock.calls.length, b.mock.calls.length]).toEqual([1, 1]);
  });

  it("修饰键必须逐个一致：Ctrl+D 不响应 D、Ctrl+Shift+D 与 Alt+D；字母不分大小写", async () => {
    await mount();
    const dup = vi.fn();
    shell.registerShortcut({ key: "d", ctrl: true }, dup);
    keydown(window, "d", { code: "KeyD" });
    keydown(window, "D", { ctrlKey: true, shiftKey: true, code: "KeyD" });
    keydown(window, "d", { altKey: true, code: "KeyD" });
    keydown(window, "d", { ctrlKey: true, metaKey: true, code: "KeyD" });
    expect(dup).not.toHaveBeenCalled();
    keydown(window, "D", { ctrlKey: true, code: "KeyD" });
    expect(dup).toHaveBeenCalledTimes(1);
  });

  it("不带 Ctrl / Alt 的组合在输入框里不触发；带 Ctrl 的照常触发", async () => {
    await mount();
    const rename = vi.fn();
    const save = vi.fn();
    shell.registerShortcut({ key: "F2" }, rename);
    shell.registerShortcut({ key: "s", ctrl: true }, save);
    const input = document.createElement("input");
    document.body.append(input);
    try {
      input.focus();
      keydown(input, "F2", { code: "F2" });
      keydown(input, "s", { ctrlKey: true, code: "KeyS" });
      expect(rename).not.toHaveBeenCalled();
      expect(save).toHaveBeenCalledTimes(1);
    } finally {
      input.remove();
    }
  });

  it("有浮层打开、输入法组字、控件已经处理过的按键都不触发", async () => {
    await mount();
    const rename = vi.fn();
    shell.registerShortcut({ key: "F2" }, rename);
    keydown(window, "F2", { code: "F2", isComposing: true });
    const handled = new KeyboardEvent("keydown", { key: "F2", code: "F2", bubbles: true, cancelable: true });
    handled.preventDefault();
    act(() => {
      window.dispatchEvent(handled);
    });
    act(() => shell.openPalette());
    keydown(window, "F2", { code: "F2" });
    expect(rename).not.toHaveBeenCalled();
    act(() => shell.closePalette());
    keydown(window, "F2", { code: "F2" });
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it("首次启动向导期间页面快捷键无效", async () => {
    bootOverrides(ipc, { instances, firstRun: true });
    ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
    await mount();
    const rename = vi.fn();
    shell.registerShortcut({ key: "F2" }, rename);
    keydown(window, "F2", { code: "F2" });
    expect(rename).not.toHaveBeenCalled();
  });

  it("占用全局快捷键或 Esc 属于设计错误，登记时抛出", async () => {
    await mount();
    expect(() => shell.registerShortcut({ key: "k", ctrl: true }, () => undefined)).toThrow("Ctrl+k 是全局快捷键，页面不能占用");
    expect(() => shell.registerShortcut({ key: "f", ctrl: true }, () => undefined)).toThrow("Ctrl+f 是全局快捷键");
    expect(() => shell.registerShortcut({ key: "3", ctrl: true }, () => undefined)).toThrow("Ctrl+3 是全局快捷键");
    expect(() => shell.registerShortcut({ key: "5", alt: true }, () => undefined)).toThrow("Alt+5 是全局快捷键");
    expect(() => shell.registerShortcut({ key: ",", ctrl: true }, () => undefined)).toThrow("Ctrl+, 是全局快捷键");
    expect(() => shell.registerShortcut({ key: "Escape" }, () => undefined)).toThrow("Esc 归浮层体系");
    expect(() => shell.registerShortcut({ key: "6", alt: true }, () => undefined)).not.toThrow();
    expect(() => shell.registerShortcut({ key: "k", ctrl: true, shift: true }, () => undefined)).not.toThrow();
  });
});

describe("外壳：保存文件", () => {
  beforeEach(() => {
    vi.mocked(pickSaveFile).mockReset();
  });

  it("按种类：标题与类型过滤取外壳的表，路径补上这个种类的扩展名", async () => {
    vi.mocked(pickSaveFile).mockResolvedValueOnce("D:\\我的 分享\\周末包");
    await mount();
    await expect(shell.saveFile("mrpack", "周末包 1.2.0.mrpack")).resolves.toBe("D:\\我的 分享\\周末包.mrpack");
    expect(vi.mocked(pickSaveFile).mock.calls).toEqual([[{ title: "导出整合包", filter: { name: "Modrinth 整合包（*.mrpack）", extensions: ["mrpack"] }, defaultPath: "周末包 1.2.0.mrpack" }]]);
  });

  it("页面自带标题与类型过滤：原样交给对话框，路径补上它的扩展名；已带扩展名不重复，取消为 null", async () => {
    const dialog = { title: "导出「新的世界」", filter: { name: "存档压缩包（*.zip）", extensions: ["zip"] } };
    vi.mocked(pickSaveFile).mockResolvedValueOnce("E:\\备份\\新的世界").mockResolvedValueOnce("E:\\备份\\新的世界.ZIP").mockResolvedValueOnce(null);
    await mount();
    await expect(shell.saveFile(dialog, "New World.zip")).resolves.toBe("E:\\备份\\新的世界.zip");
    await expect(shell.saveFile(dialog, "New World.zip")).resolves.toBe("E:\\备份\\新的世界.ZIP");
    await expect(shell.saveFile(dialog, "New World.zip")).resolves.toBeNull();
    expect(vi.mocked(pickSaveFile).mock.calls[0]).toEqual([{ ...dialog, defaultPath: "New World.zip" }]);
  });
});

describe("外壳：选择文件", () => {
  it("浏览器预览里没有系统对话框：如实拒绝", async () => {
    await mount();
    await expect(shell.pickFile("modpack")).rejects.toThrow("浏览器预览里没有系统的选择文件对话框");
  });
});
