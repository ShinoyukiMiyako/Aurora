// @vitest-environment jsdom
import { AnimatePresence } from "framer-motion";
import { act, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { render, stubResizeObserver, type Rendered } from "../test/dom";
import { Modal } from "./Modal";
import { TOAST_ACTION_BLOCKED_REASON, Toast, type ToastProps, type ToastSide } from "./Toast";

let view: Rendered | undefined;

beforeEach(() => {
  stubResizeObserver();
});

afterEach(() => {
  view?.unmount();
  view = undefined;
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

  it("不自动消失的通知没有倒计时细线；取值越界抛错", () => {
    const { container } = mount(<Toast {...base} tone="error" countdown={null} />);
    expect(container.querySelector("[style*='--toast-remaining']")).toBeNull();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => mount(<Toast {...base} countdown={{ fraction: 1.2, remainingMs: 100, paused: false }} />)).toThrow("倒计时取值越界");
  });
});
