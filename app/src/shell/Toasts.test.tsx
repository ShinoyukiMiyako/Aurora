// @vitest-environment jsdom
// @module-tag heavy-page
// 通知容器的暂停计时：指针或焦点在栈内时全部暂停，两者都离开才恢复；
// 指针或焦点所在的那条通知被移除、收不到离开事件时也要恢复。
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { LauncherProvider, useLauncher, type LauncherApi } from "../state/launcher";
import { render, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, callsOf, instanceDto, resetRecorder } from "../test/launcher";
import { TOASTS_COPY } from "../copy/shell";
import { TOAST_CLOSE_LABEL } from "../ui/Toast";
import toastStyles from "../ui/Toast.module.css";
import { OverlayRoot } from "./overlay";
import { ShellProvider } from "./shell";
import { Toasts } from "./Toasts";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

let view: Rendered | undefined;
let launcher: LauncherApi;

function Host() {
  launcher = useLauncher();
  return <Toasts />;
}

// 真定时器：通知的退场动画要真的播完、节点真的移除
const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });

const closeButtons = () => [...document.querySelectorAll<HTMLButtonElement>(`button[aria-label="${TOAST_CLOSE_LABEL}"]`)];
const running = () => launcher.state.toasts.map((t) => ({ title: t.title, running: t.deadline !== null && t.pausedRemainingMs === null }));

beforeEach(async () => {
  stubResizeObserver();
  resetRecorder(ipc);
  bootOverrides(ipc);
  view = render(
    <LauncherProvider>
      <ShellProvider>
        <Host />
        <OverlayRoot />
      </ShellProvider>
    </LauncherProvider>,
  );
  await flush();
});

afterEach(() => {
  view?.unmount();
  view = undefined;
});

describe("通知容器的焦点暂停", () => {
  it("焦点所在的通知被关掉、节点移除后焦点落回 body：其余通知恢复计时，不一直停着", async () => {
    act(() => {
      launcher.actions.toast("info", "甲");
      launcher.actions.toast("success", "乙");
    });
    expect(running()).toEqual([
      { title: "甲", running: true },
      { title: "乙", running: true },
    ]);

    const [first] = closeButtons();
    act(() => first.focus());
    expect(running()).toEqual([
      { title: "甲", running: false },
      { title: "乙", running: false },
    ]);

    // 点关闭：浏览器在聚焦元素被移除时不派发 blur / focusout，容器收不到「焦点离开」
    act(() => first.click());
    await vi.waitFor(() => expect(closeButtons()).toHaveLength(1), { timeout: 3000, interval: 20 });
    expect(document.activeElement).toBe(document.body);
    expect(running()).toEqual([{ title: "乙", running: true }]);
  });

  it("焦点仍在栈内另一条通知上时，关掉一条不恢复计时", async () => {
    act(() => {
      launcher.actions.toast("info", "甲");
      launcher.actions.toast("success", "乙");
    });
    const [first, second] = closeButtons();
    act(() => first.focus());
    act(() => second.focus());
    act(() => first.click());
    await vi.waitFor(() => expect(closeButtons()).toHaveLength(1), { timeout: 3000, interval: 20 });
    expect(document.activeElement).toBe(second);
    expect(running()).toEqual([{ title: "乙", running: false }]);
  });
});

describe("通知容器的指针暂停", () => {
  const region = () => {
    const el = document.querySelector<HTMLElement>(`section[aria-label="${TOASTS_COPY.region}"]`);
    if (el === null) throw new Error("通知容器没有挂上");
    return el;
  };
  const toastOf = (title: string) => {
    const el = [...document.querySelectorAll<HTMLElement>('[role="status"]')].find((t) => t.textContent?.includes(title));
    if (el === undefined) throw new Error(`找不到通知 ${title}`);
    return el;
  };

  /** 指针从栈外移到 target 上（React 的 onPointerEnter 由 pointerover 合成），再在原处挪一下。 */
  const pointerOnto = (target: Element, x: number, y: number) =>
    act(() => {
      target.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body, clientX: x - 2, clientY: y - 2 }));
      target.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: x, clientY: y }));
    });

  /** jsdom 不做布局，没有 elementFromPoint：按测试给的结果命中，并记下每次查询的坐标。 */
  const stubHitTest = (hit: () => Element | null) => {
    const queries: [number, number][] = [];
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: (x: number, y: number) => {
        queries.push([x, y]);
        return hit();
      },
    });
    onTestFinished(() => {
      Reflect.deleteProperty(document, "elementFromPoint");
    });
    return queries;
  };

  it("指针下方那条通知被关掉、栈缩小而指针没动：收不到 pointerleave 也恢复计时", async () => {
    act(() => {
      launcher.actions.toast("info", "甲");
      launcher.actions.toast("success", "乙");
    });
    const [first] = closeButtons();
    pointerOnto(first, 300, 40);
    expect(running()).toEqual([
      { title: "甲", running: false },
      { title: "乙", running: false },
    ]);

    // 甲在栈顶：它移除后栈从上方缩短，指针下方已是内容区
    const queries = stubHitTest(() => document.body);
    act(() => first.click());
    await vi.waitFor(() => expect(closeButtons()).toHaveLength(1), { timeout: 3000, interval: 20 });
    expect(queries).toEqual([[300, 40]]);
    expect(running()).toEqual([{ title: "乙", running: true }]);

    // 解除的是指针这一项暂停：之后来的通知照常计时，不会一出现就停住
    act(() => launcher.actions.toast("warning", "丙"));
    expect(running()).toEqual([
      { title: "乙", running: true },
      { title: "丙", running: true },
    ]);
  });

  it("移除后指针下方换成了栈内另一条通知：继续暂停", async () => {
    act(() => {
      launcher.actions.toast("info", "甲");
      launcher.actions.toast("success", "乙");
    });
    const [first] = closeButtons();
    pointerOnto(first, 300, 40);
    // 乙让位滑到原来甲的位置
    const queries = stubHitTest(() => toastOf("乙"));
    act(() => first.click());
    await vi.waitFor(() => expect(closeButtons()).toHaveLength(1), { timeout: 3000, interval: 20 });
    expect(queries).toEqual([[300, 40]]);
    expect(running()).toEqual([{ title: "乙", running: false }]);
  });

  it("指针落在通知之间的空隙（容器本身）也算在栈内", async () => {
    act(() => {
      launcher.actions.toast("info", "甲");
      launcher.actions.toast("success", "乙");
    });
    const [first] = closeButtons();
    pointerOnto(first, 300, 40);
    stubHitTest(() => region());
    act(() => first.click());
    await vi.waitFor(() => expect(closeButtons()).toHaveLength(1), { timeout: 3000, interval: 20 });
    expect(running()).toEqual([{ title: "乙", running: false }]);
  });

  it("指针移到窗口外（命中为空）：恢复计时", async () => {
    act(() => {
      launcher.actions.toast("info", "甲");
      launcher.actions.toast("success", "乙");
    });
    const [first] = closeButtons();
    pointerOnto(first, 0, 0);
    stubHitTest(() => null);
    act(() => first.click());
    await vi.waitFor(() => expect(closeButtons()).toHaveLength(1), { timeout: 3000, interval: 20 });
    expect(running()).toEqual([{ title: "乙", running: true }]);
  });

  it("指针不在栈内时移除通知不做命中测试；照常离开时由 pointerleave 恢复", async () => {
    act(() => {
      launcher.actions.toast("info", "甲");
      launcher.actions.toast("success", "乙");
    });
    const queries = stubHitTest(() => {
      throw new Error("指针不在栈内，不该做命中测试");
    });
    const [first, second] = closeButtons();
    pointerOnto(second, 300, 120);
    act(() => {
      second.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body, clientX: 300, clientY: 400 }));
    });
    expect(running()).toEqual([
      { title: "甲", running: true },
      { title: "乙", running: true },
    ]);
    act(() => first.click());
    await vi.waitFor(() => expect(closeButtons()).toHaveLength(1), { timeout: 3000, interval: 20 });
    expect(queries).toEqual([]);
    expect(running()).toEqual([{ title: "乙", running: true }]);
  });

  it("通知滑到静止的指针下方、漏了 pointerenter：指针一动就补上暂停", () => {
    act(() => launcher.actions.toast("info", "甲"));
    act(() => {
      toastOf("甲").dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 300, clientY: 40 }));
    });
    expect(running()).toEqual([{ title: "甲", running: false }]);
  });
});

describe("通知的删除", () => {
  const toastOf = (title: string) => {
    const el = [...document.querySelectorAll<HTMLElement>("[data-tone]")].find((t) => t.textContent?.includes(title));
    if (el === undefined) throw new Error(`找不到通知 ${title}`);
    return el;
  };
  /** popLayout 给退场项注入的那条样式规则。 */
  const popRule = (popId: string) => {
    for (const style of document.head.querySelectorAll("style")) {
      const sheet = style.sheet;
      if (sheet === null) continue;
      for (const rule of sheet.cssRules) if (rule.cssText.includes(popId)) return rule.cssText;
    }
    throw new Error(`没有给 ${popId} 注入样式`);
  };

  it("关掉一条：它立即被抽出布局、贴着栈底淡出，其余通知不用等它淡完才补位", async () => {
    act(() => {
      launcher.actions.toast("info", "甲");
      launcher.actions.toast("success", "乙");
    });
    const first = toastOf("甲");
    // jsdom 不做布局：给出 popLayout 量尺寸时要读的宽高
    first.style.width = "340px";
    first.style.height = "60px";
    act(() => closeButtons()[0].click());

    expect(first.isConnected).toBe(true);
    const popId = first.dataset.motionPopId;
    if (popId === undefined) throw new Error("退场的那条没有被抽出布局：ref 没有一路交到通知的根元素上");
    const rule = popRule(popId);
    expect(rule).toContain("position: absolute");
    // 栈在右下角、贴底增长：退场项按到底边的距离定位，栈变矮时它不跟着容器的顶边往下跑
    expect(rule).toMatch(/\bbottom: /);
    expect(rule).not.toMatch(/\btop: /);
    await vi.waitFor(() => expect(first.isConnected).toBe(false), { timeout: 3000, interval: 20 });
  });
});

describe("重复的通知", () => {
  it("同一条又来一次：不新增，并进去的那一条图标底座原位弹一下", async () => {
    act(() => launcher.actions.toast("success", "已复制"));
    const icon = document.querySelector<HTMLElement>(`[data-tone] .${toastStyles.iconBase}`);
    if (icon === null) throw new Error("没有图标底座");
    await flush();
    expect(icon.style.transform).toBe("");

    act(() => launcher.actions.toast("success", "已复制"));
    expect(launcher.state.toasts.map((t) => [t.title, t.repeats])).toEqual([["已复制", 1]]);
    await vi.waitFor(() => expect(Number(/scale\(([\d.]+)\)/.exec(icon.style.transform)?.[1])).toBeGreaterThan(1.05), { timeout: 2000, interval: 4 });
  });
});

describe("通知上的动作按钮", () => {
  it("改名后点已经显示着的「启动」：按钮走的是迁移后的动作，启动新名字", async () => {
    let onDisk = [instanceDto("生存"), instanceDto("创造")];
    ipc.overrides.set("list_instances", () => onDisk);
    ipc.overrides.set("repair_instance", () => ({ reinstalled: true, libraries: 1, assets: 0, natives: 0 }));
    ipc.overrides.set("launch_game", () => ({ pid: 1 }));
    ipc.overrides.set("rename_instance", () => {
      onDisk = onDisk.map((i) => (i.id === "生存" ? { ...i, id: "生存二" } : i));
      return { id: "生存二" };
    });
    await act(async () => {
      await launcher.actions.reload("instances");
      await launcher.actions.repairInstance("生存");
    });
    await flush();

    await act(async () => {
      await launcher.actions.renameInstance("生存", "生存二");
    });
    await flush();
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "启动");
    if (button === undefined) throw new Error("已修复的通知应还显示着「启动」");
    act(() => button.click());
    await flush();

    expect(callsOf(ipc, "launch_game").map((a) => a.versionId)).toEqual(["生存二"]);
    expect(launcher.state.toasts.map((t) => t.tone)).not.toContain("error");
  });
});
