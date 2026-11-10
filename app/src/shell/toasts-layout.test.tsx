// @vitest-environment jsdom
// @module-tag heavy-page
// 通知栈的落点。jsdom 不做布局，但 getComputedStyle 会按样式表算层叠：把通知容器的真样式表挂进文档，
// 在真的外壳里开弹窗、走向导，读容器此刻算出来的定位。样式规则与界面上的标记属性任一头断了，这里都会挂。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { stubCanvas } from "../art/illustrations/test-canvas";
import { TOASTS_COPY } from "../copy/shell";
import { fade, tweenAt } from "../lib/motion";
import { DEFAULT_APPEARANCE, AppearanceProvider } from "../state/appearance";
import type { FlowProps } from "../state/flows";
import { LauncherProvider, useLauncher, type LauncherApi } from "../state/launcher";
import { PAGE_IDS } from "../state/route";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, instanceDto, resetRecorder } from "../test/launcher";
import { Modal } from "../ui/Modal";
import { AppShell } from "./AppShell";
import type { PageTable } from "./nav";
import { createPageRegistry } from "./pages";
import { ShellProvider, useShell, type ShellApi } from "./shell";
import styles from "./Toasts.module.css";
import { WindowPortProvider, browserWindowPort } from "./window";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

const HERE = dirname(fileURLToPath(import.meta.url));
// :global() 与局部类名都是构建期语法，换成浏览器认识的选择器和实际挂到元素上的类名
const SHEET = readFileSync(join(HERE, "Toasts.module.css"), "utf8")
  .replace(/:global\((.+)\) \.region/g, "$1 .region")
  .replaceAll(".region", `.${styles.region}`)
  .replaceAll(".ghost", `.${styles.ghost}`);

const BOTTOM_RIGHT = { top: "auto", bottom: "var(--sk-space-16)", left: "auto", right: "var(--sk-space-16)" };
/** 标题栏 56 高、再留 64：资源详情的「返回」在 900 高的窗口里下沿到 113。 */
const TOP_LEFT = { top: "calc(56px + var(--sk-space-64))", bottom: "auto", left: "var(--sk-space-16)", right: "auto" };

const region = () => {
  const el = document.querySelector<HTMLElement>(`section[aria-label="${TOASTS_COPY.region}"]`);
  if (el === null) throw new Error("通知容器没有挂上");
  return el;
};

const placementOf = (el: Element) => {
  const { top, bottom, left, right } = getComputedStyle(el);
  return { top, bottom, left, right };
};
const placement = () => placementOf(region());

/** 容器此刻用的淡入动画名：两个角各一个，换角即换名，浏览器换名就重播。 */
const cornerFade = () => getComputedStyle(region()).animationName;

/** 正在退场、还挂在文档里的弹窗层。 */
const exitingModal = () => document.querySelector("[data-sk-modal-layer][data-exiting]");

/** 刚挂上的通知此刻的横向位移：入场动画还没走，就是入场起点。 */
const enterShift = (title: string) => {
  const toast = [...document.querySelectorAll<HTMLElement>("[data-tone]")].find((el) => el.textContent?.includes(title));
  if (toast === undefined) throw new Error(`没有「${title}」这条通知`);
  const match = /translateX\((-?[\d.]+)px\)/.exec(toast.style.transform);
  if (match === null) throw new Error(`「${title}」此刻没有横向位移：${toast.style.transform}`);
  return Number(match[1]);
};

let view: Rendered | undefined;
let style: HTMLStyleElement;
let shell: ShellApi;
let launcher: LauncherApi;

function Probe() {
  shell = useShell();
  launcher = useLauncher();
  return null;
}

function Page() {
  return <p data-page="" />;
}

function Wizard() {
  return <p data-flow="onboarding">向导</p>;
}

/** 与真流程一样：弹窗挂在外壳的流程槽位里。 */
function CreateInstance({ onClose }: FlowProps<"create-instance">) {
  return <Modal open onClose={onClose} title="新建实例" />;
}

// 真定时器：弹窗的退场动画要真的播完、节点真的移除
const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });

async function mount() {
  const pages = Object.fromEntries(PAGE_IDS.map((page) => [page, async () => ({ default: Page })])) as unknown as PageTable;
  view = render(
    <WindowPortProvider port={browserWindowPort()}>
      <AppearanceProvider initial={{ ...DEFAULT_APPEARANCE, petals: false }}>
        <LauncherProvider>
          <ShellProvider>
            <Probe />
            <AppShell pages={createPageRegistry(pages)} flows={{ login: () => null, onboarding: Wizard, createInstance: CreateInstance }} />
          </ShellProvider>
        </LauncherProvider>
      </AppearanceProvider>
    </WindowPortProvider>,
  );
  await flush();
}

beforeEach(() => {
  resetRecorder(ipc);
  stubResizeObserver();
  stubMatchMedia(false);
  stubCanvas();
  HTMLElement.prototype.scrollTo = function scrollTo(this: HTMLElement) {
    this.scrollTop = 0;
  };
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  style = document.createElement("style");
  style.textContent = SHEET;
  document.head.append(style);
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  style.remove();
});

describe("通知栈的落点", () => {
  it("平时在右下角", async () => {
    bootOverrides(ipc, { instances: [instanceDto("生存")] });
    await mount();
    act(() => launcher.actions.toast("error", "常驻的失败"));
    expect(placement()).toEqual(BOTTOM_RIGHT);
  });

  it("弹窗开着时在标题栏下方的左上角，让出底栏和头部的关闭按钮；弹窗退场完回到右下角", async () => {
    bootOverrides(ipc, { instances: [instanceDto("生存")] });
    await mount();
    act(() => launcher.actions.toast("error", "常驻的失败"));

    act(() => shell.openCreateInstance());
    await flush();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(placement()).toEqual(TOP_LEFT);

    act(() => shell.closeCreateInstance());
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull(), { timeout: 3000, interval: 20 });
    expect(placement()).toEqual(BOTTOM_RIGHT);
  });

  it("弹窗一开始退场就回到右下角，不等它淡完", async () => {
    bootOverrides(ipc, { instances: [instanceDto("生存")] });
    await mount();
    act(() => launcher.actions.toast("error", "常驻的失败"));
    act(() => shell.openCreateInstance());
    await flush();
    expect(placement()).toEqual(TOP_LEFT);

    act(() => shell.closeCreateInstance());
    expect(exitingModal()).not.toBeNull();
    expect(placement()).toEqual(BOTTOM_RIGHT);
  });

  it("关弹窗的同一拍发出的通知（新建实例、登录成功）：直接在右下角从右侧进，不先落左上角", async () => {
    bootOverrides(ipc, { instances: [instanceDto("生存")] });
    await mount();
    act(() => shell.openCreateInstance());
    await flush();

    act(() => {
      launcher.actions.toast("info", "已开始创建");
      shell.closeCreateInstance();
    });
    expect(exitingModal()).not.toBeNull();
    expect(placement()).toEqual(BOTTOM_RIGHT);
    expect(enterShift("已开始创建")).toBe(40);
  });

  it("落点换角时整栈在新角淡入：两个角的淡入动画名不同，换角就重播", async () => {
    bootOverrides(ipc, { instances: [instanceDto("生存")] });
    await mount();
    act(() => launcher.actions.toast("error", "常驻的失败"));
    const home = cornerFade();
    expect(home).not.toBe("");
    expect(home).not.toBe("none");

    act(() => shell.openCreateInstance());
    await flush();
    const aside = cornerFade();
    expect(aside).not.toBe("none");
    expect(aside).not.toBe(home);

    act(() => shell.closeCreateInstance());
    expect(cornerFade()).toBe(home);
  });

  it("首次启动向导开着时同样在左上角：「开始使用」在向导底栏右侧；向导收尾后回到右下角", async () => {
    bootOverrides(ipc, { instances: [], firstRun: true });
    ipc.overrides.set("complete_first_run", () => null);
    await mount();
    act(() => launcher.actions.toast("success", "已添加离线账户"));
    expect(document.querySelector("[data-flow='onboarding']")).not.toBeNull();
    expect(placement()).toEqual(TOP_LEFT);

    await act(async () => {
      await launcher.actions.completeFirstRun("D:\\Games\\.minecraft", []);
    });
    // 向导要演完退场才拿掉：机器忙时十拍定时器不够，按条件等
    await vi.waitFor(() => expect(document.querySelector("[data-flow='onboarding']")).toBeNull(), { timeout: 3000, interval: 20 });
    expect(placement()).toEqual(BOTTOM_RIGHT);
  });

  it("入场方向跟随落点：平时从右侧进，弹窗开着时从左侧进，弹窗退场完再回到右侧", async () => {
    bootOverrides(ipc, { instances: [instanceDto("生存")] });
    await mount();
    act(() => void launcher.actions.toast("error", "平时来的"));
    expect(enterShift("平时来的")).toBe(40);

    act(() => shell.openCreateInstance());
    await flush();
    act(() => void launcher.actions.toast("error", "弹窗开着时来的"));
    expect(enterShift("弹窗开着时来的")).toBe(-40);

    act(() => shell.closeCreateInstance());
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull(), { timeout: 3000, interval: 20 });
    act(() => void launcher.actions.toast("error", "弹窗走了才来的"));
    expect(enterShift("弹窗走了才来的")).toBe(40);
  });

  it("平时进来的通知，弹窗开着时关掉：退场走左侧，栈此刻在左上角", async () => {
    bootOverrides(ipc, { instances: [instanceDto("生存")] });
    await mount();
    let id = "";
    act(() => {
      id = launcher.actions.toast("error", "平时来的");
    });
    expect(enterShift("平时来的")).toBe(40);

    act(() => shell.openCreateInstance());
    await flush();
    await vi.waitFor(() => expect(Math.abs(enterShift("平时来的"))).toBeLessThan(1), { timeout: 3000, interval: 10 });
    act(() => launcher.actions.dismissToast(id));
    await vi.waitFor(() => expect(enterShift("平时来的")).toBeLessThan(-4), { timeout: 2000, interval: 4 });
  });

  it("弹窗开着时进来的通知，弹窗退场完才关：退场走右侧，栈此刻已回右下角", async () => {
    bootOverrides(ipc, { instances: [instanceDto("生存")] });
    await mount();
    act(() => shell.openCreateInstance());
    await flush();
    let id = "";
    act(() => {
      id = launcher.actions.toast("error", "弹窗开着时来的");
    });
    expect(enterShift("弹窗开着时来的")).toBe(-40);

    act(() => shell.closeCreateInstance());
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull(), { timeout: 3000, interval: 20 });
    await vi.waitFor(() => expect(Math.abs(enterShift("弹窗开着时来的"))).toBeLessThan(1), { timeout: 3000, interval: 10 });
    act(() => launcher.actions.dismissToast(id));
    await vi.waitFor(() => expect(enterShift("弹窗开着时来的")).toBeGreaterThan(4), { timeout: 2000, interval: 4 });
  });

  it("首次启动向导开着时同样从左侧进", async () => {
    bootOverrides(ipc, { instances: [], firstRun: true });
    await mount();
    act(() => void launcher.actions.toast("success", "已添加离线账户"));
    expect(enterShift("已添加离线账户")).toBe(-40);
  });
});

describe("换角时旧角那一栈原地淡出", () => {
  const ghosts = () => [...document.querySelectorAll<HTMLElement>(`.${styles.ghost}`)];
  const ghostFrom = (ghost: HTMLElement) => Number(ghost.style.getPropertyValue("--toasts-ghost-from"));
  /** MutationObserver 的回调是微任务：让它跑完。 */
  const observed = () => act(async () => await Promise.resolve());
  /** 假后端启动时会发几条通知（读不出账户皮肤）：关掉，等它们退场完，栈从空的开始。 */
  const clearToasts = async () => {
    act(() => {
      for (const toast of launcher.state.toasts) launcher.actions.dismissToast(toast.id);
    });
    await vi.waitFor(() => expect(region().children).toHaveLength(0), { timeout: 3000, interval: 20 });
  };

  /**
   * jsdom 不播动画，没有 getAnimations：换成可以手动收尾的版本。拷贝有一段淡出动画，由测试决定它何时播完；
   * 其余元素没有动画。返回每份拷贝的收尾函数，按创建顺序。
   */
  function stubFades() {
    const finishers: (() => void)[] = [];
    const fades = new Map<Element, Animation>();
    Object.defineProperty(Element.prototype, "getAnimations", {
      configurable: true,
      value(this: Element) {
        if (!this.classList.contains(styles.ghost)) return [];
        let fadeOut = fades.get(this);
        if (fadeOut === undefined) {
          const finished = new Promise<void>((resolve) => finishers.push(resolve));
          fadeOut = { finished } as unknown as Animation;
          fades.set(this, fadeOut);
        }
        return [fadeOut];
      },
    });
    onTestFinished(() => {
      Reflect.deleteProperty(Element.prototype, "getAnimations");
    });
    return finishers;
  }

  it("弹窗打开：右下角那一栈的拷贝钉在右下淡出，不可交互、不进读屏，淡完拿掉；在场的那一栈已在左上", async () => {
    const finishers = stubFades();
    bootOverrides(ipc, { instances: [instanceDto("生存")] });
    await mount();
    await clearToasts();
    act(() => launcher.actions.toast("error", "常驻的失败"));
    await flush();
    expect(ghosts()).toEqual([]);

    act(() => shell.openCreateInstance());
    await observed();
    const [ghost] = ghosts();
    expect(ghost.dataset.corner).toBe("home");
    expect(placementOf(ghost)).toEqual(BOTTOM_RIGHT);
    expect(placement()).toEqual(TOP_LEFT);
    expect(ghost.getAttribute("aria-hidden")).toBe("true");
    expect(ghost.hasAttribute("inert")).toBe(true);
    expect(ghost.textContent).toContain("常驻的失败");
    expect(ghost.querySelector("[id]")).toBeNull();
    expect(ghostFrom(ghost)).toBe(1);
    expect(region().textContent).toContain("常驻的失败");

    act(() => finishers[0]());
    await flush();
    expect(ghost.isConnected).toBe(false);
    expect(ghosts()).toEqual([]);
  });

  it("关弹窗的同一拍发出的通知：左上角的拷贝里只有旧角画过的那几条", async () => {
    const finishers = stubFades();
    bootOverrides(ipc, { instances: [instanceDto("生存")] });
    await mount();
    await clearToasts();
    act(() => shell.openCreateInstance());
    await flush();
    act(() => launcher.actions.toast("error", "早先的"));
    await flush();
    expect(ghosts()).toEqual([]);

    act(() => {
      launcher.actions.toast("info", "已开始创建");
      shell.closeCreateInstance();
    });
    await observed();
    const [ghost] = ghosts();
    expect(ghost.dataset.corner).toBe("aside");
    expect(placementOf(ghost)).toEqual(TOP_LEFT);
    expect(ghost.textContent).toContain("早先的");
    expect(ghost.textContent).not.toContain("已开始创建");
    expect(region().textContent).toContain("已开始创建");
    expect(finishers).toHaveLength(1);
  });

  it("拷贝里的倒计时细线对到原件此刻的进度，不在淡出的那一份里跳回起点", async () => {
    // jsdom 没有 CSS 动画：细线（带 --toast-remaining 的那个元素）各给一段假的 CSS 动画，原件的已经播了 1234 ms
    class FakeEffect {
      constructor(readonly target: Element) {}
    }
    class FakeCssAnimation {
      readonly animationName = "toastCountdown";
      constructor(
        readonly effect: FakeEffect,
        public currentTime: number | null,
      ) {}
    }
    vi.stubGlobal("KeyframeEffect", FakeEffect);
    vi.stubGlobal("CSSAnimation", FakeCssAnimation);
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const lines = new Map<Element, FakeCssAnimation>();
    const lineOf = (el: Element) => {
      let animation = lines.get(el);
      if (animation === undefined) {
        animation = new FakeCssAnimation(new FakeEffect(el), el.closest(`.${styles.ghost}`) === null ? 1234 : null);
        lines.set(el, animation);
      }
      return animation;
    };
    const isLine = (el: Element) => el.matches("[style*='--toast-remaining']");
    const finished = new Promise<void>(() => undefined);
    Object.defineProperty(Element.prototype, "getAnimations", {
      configurable: true,
      value(this: Element, options?: { subtree?: boolean }) {
        if (this.classList.contains(styles.ghost)) return [{ finished }];
        const scope = options?.subtree === true ? [this, ...this.querySelectorAll("*")] : [this];
        return scope.filter(isLine).map(lineOf);
      },
    });
    onTestFinished(() => {
      Reflect.deleteProperty(Element.prototype, "getAnimations");
    });

    bootOverrides(ipc, { instances: [instanceDto("生存")] });
    await mount();
    await clearToasts();
    act(() => launcher.actions.toast("info", "会消失的"));
    await flush();
    act(() => shell.openCreateInstance());
    await observed();
    const [ghost] = ghosts();
    const copied = ghost.querySelector("[style*='--toast-remaining']");
    if (copied === null) throw new Error("拷贝里没有倒计时细线");
    expect(lineOf(copied).currentTime).toBe(1234);
  });

  it("栈里没有通知时换角不留拷贝", async () => {
    stubFades();
    bootOverrides(ipc, { instances: [instanceDto("生存")] });
    await mount();
    await clearToasts();
    act(() => shell.openCreateInstance());
    await observed();
    expect(placement()).toEqual(TOP_LEFT);
    expect(ghosts()).toEqual([]);
  });

  it("接力换角（关一个弹窗、隔几拍又开一个）：第二份拷贝从容器在新角淡入走到的透明度起淡出，不先闪回全不透明", async () => {
    const finishers = stubFades();
    bootOverrides(ipc, { instances: [instanceDto("生存")] });
    await mount();
    await clearToasts();
    act(() => launcher.actions.toast("error", "常驻的失败"));
    act(() => shell.openCreateInstance());
    await flush();
    // 打开这一次留在右下的拷贝淡完；栈在左上的淡入也走完
    act(() => finishers.forEach((finish) => finish()));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(ghosts()).toEqual([]);
    const real = performance.now.bind(performance);
    let clock: number | null = null;
    vi.spyOn(performance, "now").mockImplementation(() => (clock === null ? real() : clock));

    // 关掉：栈从左上回右下，左上留一份拷贝；右下的容器从这一刻起淡入
    clock = real();
    act(() => shell.closeCreateInstance());
    await observed();
    expect(ghosts().map((g) => [g.dataset.corner, ghostFrom(g)])).toEqual([["aside", 1]]);

    // 50 ms 后又开一个：右下的淡入才走到一部分，右下的拷贝从那里起淡出
    clock += 50;
    act(() => shell.openCreateInstance());
    await observed();
    clock = null;
    const second = ghosts().find((g) => g.dataset.corner === "home");
    if (second === undefined) throw new Error("第二次换角没有在右下留拷贝");
    expect(ghostFrom(second)).toBeCloseTo(tweenAt(fade.in, 0.05), 6);
    expect(ghostFrom(second)).toBeLessThan(0.9);
  });
});
