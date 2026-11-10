// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AnimatePresence, MotionConfig } from "framer-motion";
import { act, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { drainFrames, render, stepFrames, stubResizeObserver, type Rendered } from "../test/dom";
import { Modal } from "./Modal";
import { TOAST_ACTION_BLOCKED_REASON, Toast, type ToastProps, type ToastSide } from "./Toast";
import styles from "./Toast.module.css";

let view: Rendered | undefined;

beforeEach(() => {
  stubResizeObserver();
});

// 有的用例在假时钟上逐帧走：换计时器之前先卸载、把帧循环排空，同文件后面的用例才推得动动画
afterEach(async () => {
  view?.unmount();
  view = undefined;
  await drainFrames();
  vi.useRealTimers();
});

function mount(ui: ReactNode) {
  view = render(
    <OverlayProvider>
      {ui}
      <OverlayRoot />
    </OverlayProvider>,
  );
  return view;
}

const base: ToastProps = { tone: "info", title: "已安装 Sodium", onClose: () => undefined, countdown: null };
const buttonByText = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text) as HTMLButtonElement;
const click = (el: Element) =>
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
  });

const shiftOf = (toast: HTMLElement) => {
  const match = /translateX\((-?[\d.]+)px\)/.exec(toast.style.transform);
  if (match === null) throw new Error(`transform 里没有横向位移：${toast.style.transform}`);
  return Number(match[1]);
};

/** 退场时节点收不到新属性：进来时的一侧是属性给的，走的时候的一侧是 AnimatePresence 的 custom 给的。 */
function Removable({ entering, leaving }: { entering: ToastSide; leaving: ToastSide }) {
  const [shown, setShown] = useState(true);
  return (
    <>
      <button onClick={() => setShown(false)}>收起</button>
      <AnimatePresence custom={leaving}>{shown && <Toast {...base} side={entering} />}</AnimatePresence>
    </>
  );
}

describe("Toast 的滑动方向", () => {
  it("容器没给方向时从右侧滑入", () => {
    const { container } = mount(<Toast {...base} />);
    expect(shiftOf(container.querySelector("[data-tone]") as HTMLElement)).toBe(40);
  });

  it("落点在左时从左侧滑入", () => {
    const { container } = mount(<Toast {...base} side={-1} />);
    expect(shiftOf(container.querySelector("[data-tone]") as HTMLElement)).toBe(-40);
  });

  it("进来之后落点翻到左侧（弹窗开了）：退场走当时的一侧，不是进来时的", async () => {
    const { container } = mount(<Removable entering={1} leaving={-1} />);
    const toast = container.querySelector("[data-tone]") as HTMLElement;
    await vi.waitFor(() => expect(Math.abs(shiftOf(toast))).toBeLessThan(1), { timeout: 3000, interval: 10 });

    click(buttonByText("收起"));
    await vi.waitFor(() => expect(shiftOf(toast)).toBeLessThan(-4), { timeout: 2000, interval: 4 });
  });
});

describe("减少动画时 Toast 的进出", () => {
  const reducedRemovable = () => (
    <MotionConfig reducedMotion="always">
      <OverlayProvider>
        <Removable entering={1} leaving={1} />
        <OverlayRoot />
      </OverlayProvider>
    </MotionConfig>
  );
  const toastIn = (container: HTMLElement) => {
    const el = container.querySelector<HTMLElement>("[data-tone]");
    if (el === null) throw new Error("通知没有挂上");
    return el;
  };

  it("入场起点只有透明度：挂载那一刻不带横移与缩放", () => {
    vi.useFakeTimers();
    view = render(reducedRemovable());
    const toast = toastIn(view.container);
    expect(toast.style.opacity).toBe("0");
    expect(toast.style.transform).not.toMatch(/translate|scale/);
  });

  it("退场只淡出：减少动画下位移与缩放一步到位，整段退场里一帧都不先横跳、不先缩", async () => {
    vi.useFakeTimers();
    view = render(reducedRemovable());
    const toast = toastIn(view.container);
    await stepFrames(30);
    expect(toast.style.opacity).toBe("1");

    click(buttonByText("收起"));
    const frames: { transform: string; opacity: number }[] = [];
    for (let i = 0; i < 40 && toast.isConnected; i++) {
      await stepFrames(1);
      frames.push({ transform: toast.style.transform, opacity: Number(toast.style.opacity) });
    }
    expect(toast.isConnected).toBe(false);
    // 确实分几帧淡出（fade.out 约 120 ms），且每一帧都没有位移与缩放
    expect(frames.filter((f) => f.opacity > 0 && f.opacity < 1).length).toBeGreaterThan(2);
    expect(frames.filter((f) => /translate|scale/.test(f.transform))).toEqual([]);
  });
});

describe("Toast 的重复反馈", () => {
  const iconBaseOf = (container: HTMLElement) => {
    const el = container.querySelector<HTMLElement>(`.${styles.iconBase}`);
    if (el === null) throw new Error("没有图标底座");
    return el;
  };
  const scaleOf = (el: HTMLElement) => {
    const match = /scale\((-?[\d.]+)\)/.exec(el.style.transform);
    return match === null ? 1 : Number(match[1]);
  };
  /**
   * 假时钟上逐帧走 count 帧，返回每一帧之后的缩放。峰值只有几十毫秒宽：真实计时器下机器一忙，帧来得晚就会整段错过，
   * 假时钟上每一帧都按时到，采样可复现。
   */
  const scalesOver = async (el: HTMLElement, count: number) => {
    const seen: number[] = [];
    for (let i = 0; i < count; i++) {
      await stepFrames(1);
      seen.push(scaleOf(el));
    }
    return seen;
  };
  const withRepeats = (repeats: number, reduced = false) => (
    <MotionConfig reducedMotion={reduced ? "always" : "never"}>
      <OverlayProvider>
        <Toast {...base} repeats={repeats} />
        <OverlayRoot />
      </OverlayProvider>
    </MotionConfig>
  );

  it("重复的同一条并进来（repeats 变了）：图标底座原位放大约 12% 再落回 1", async () => {
    vi.useFakeTimers();
    view = render(withRepeats(0));
    const icon = iconBaseOf(view.container);
    view.rerender(withRepeats(1));
    const seen = await scalesOver(icon, 30);
    expect(Math.max(...seen)).toBeGreaterThan(1.08);
    expect(Math.max(...seen)).toBeLessThan(1.14);
    // 480 ms 之后落回 1，不再回摆
    expect(seen.at(-1)).toBe(1);
  });

  it("挂载时已有的次数不弹，次数没变的重渲染也不弹", async () => {
    vi.useFakeTimers();
    view = render(withRepeats(2));
    const icon = iconBaseOf(view.container);
    expect(Math.max(...(await scalesOver(icon, 8)))).toBe(1);
    view.rerender(withRepeats(2));
    expect(Math.max(...(await scalesOver(icon, 8)))).toBe(1);
  });

  it("减少动画时不弹", async () => {
    vi.useFakeTimers();
    view = render(withRepeats(0, true));
    const icon = iconBaseOf(view.container);
    view.rerender(withRepeats(1, true));
    expect(Math.max(...(await scalesOver(icon, 8)))).toBe(1);
  });
});

describe("Toast", () => {
  it.each([
    ["info", "status"],
    ["success", "status"],
    ["warning", "status"],
    ["error", "alert"],
  ] as const)("%s 色调的播报角色为 %s", (tone, role) => {
    const { container } = mount(<Toast {...base} tone={tone} body="正文" />);
    const toast = container.querySelector("[data-tone]") as HTMLElement;
    expect(toast.getAttribute("role")).toBe(role);
    expect(toast.textContent).toBe("已安装 Sodium正文");
  });

  it("根元素交给 ref：容器的 popLayout 靠它量尺寸、把退场的那条抽出布局", () => {
    const ref = { current: null as HTMLDivElement | null };
    const { container } = mount(<Toast {...base} ref={ref} />);
    expect(ref.current).toBe(container.querySelector("[data-tone]"));
  });

  it("点动作先关闭这条通知再执行动作；关闭按钮只关闭", () => {
    const calls: string[] = [];
    mount(<Toast {...base} tone="error" title="下载失败：安装 Sodium" action={{ label: "重试", onClick: () => calls.push("retry") }} onClose={() => calls.push("close")} />);
    click(buttonByText("重试"));
    expect(calls).toEqual(["close", "retry"]);
    click(document.querySelector('[aria-label="关闭通知"]') as HTMLElement);
    expect(calls).toEqual(["close", "retry", "close"]);
  });

  it("有弹窗打开时动作置灰并说明原因，点击无效", () => {
    const onClick = vi.fn();
    const onClose = vi.fn();
    mount(
      <>
        <Modal open onClose={() => undefined} title="新建实例" />
        <Toast {...base} action={{ label: "查看", onClick }} onClose={onClose} />
      </>,
    );
    const action = buttonByText("查看");
    expect(action.getAttribute("aria-disabled")).toBe("true");
    click(action);
    expect(onClick).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(TOAST_ACTION_BLOCKED_REASON).toBe("先完成或关闭当前弹窗");
  });

  it("倒计时细线从剩余比例开始、用剩余时长缩到 0，暂停时停住；剩余变化时重新开始", () => {
    const { container, rerender } = mount(<Toast {...base} countdown={{ fraction: 0.6, remainingMs: 3000, paused: false }} />);
    const line = () => container.querySelector<HTMLElement>("[style*='--toast-remaining']") as HTMLElement;
    const first = line();
    expect(first.style.getPropertyValue("--toast-from")).toBe("0.6");
    expect(first.style.getPropertyValue("--toast-remaining")).toBe("3000ms");
    expect(first.hasAttribute("data-paused")).toBe(false);

    rerender(
      <OverlayProvider>
        <Toast {...base} countdown={{ fraction: 0.6, remainingMs: 3000, paused: true }} />
        <OverlayRoot />
      </OverlayProvider>,
    );
    expect(line()).toBe(first);
    expect(line().hasAttribute("data-paused")).toBe(true);

    // 恢复计时时剩余不足 2000 ms 补到 2000：细线换成新节点从头播放
    rerender(
      <OverlayProvider>
        <Toast {...base} countdown={{ fraction: 0.4, remainingMs: 2000, paused: false }} />
        <OverlayRoot />
      </OverlayProvider>,
    );
    expect(line()).not.toBe(first);
    expect(line().style.getPropertyValue("--toast-from")).toBe("0.4");
  });

  it("减少动画时倒计时细线照常显示：它是剩余寿命的信息，样式表里没有按减少动画隐藏它的规则", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "Toast.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const reducedRules = [...css.matchAll(/([^{}]*data-sk-reduced[^{}]*)\{([^}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));
    expect(reducedRules.filter((r) => r.selector.includes(".countdown"))).toEqual([]);
    // 细线靠关键帧缩短：减少动画下关键帧照常播，没有把它停掉
    expect(css).toMatch(/\.countdown \{[^}]*animation: toastCountdown var\(--toast-remaining\) linear forwards;/);
  });

  it("不自动消失的通知没有倒计时细线；取值越界抛错", () => {
    const { container } = mount(<Toast {...base} tone="error" countdown={null} />);
    expect(container.querySelector("[style*='--toast-remaining']")).toBeNull();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => mount(<Toast {...base} countdown={{ fraction: 1.2, remainingMs: 100, paused: false }} />)).toThrow("倒计时取值越界");
  });
});
