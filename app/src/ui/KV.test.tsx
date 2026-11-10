// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { render, type Rendered } from "../test/dom";
import { CopyButton, KV } from "./KV";
import styles from "./KV.module.css";

let view: Rendered | undefined;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
});

function mount(ui: ReactNode) {
  view = render(
    <OverlayProvider>
      {ui}
      <OverlayRoot />
    </OverlayProvider>,
  );
  return view.container;
}

/** 让 onCopy 返回的 Promise 及其 then 回调跑完。 */
const flush = () => act(async () => {});

describe("CopyButton", () => {
  it("复制成功后图标与名称换成已复制，停留 feedbackMs 后复原", async () => {
    const onCopy = vi.fn(() => Promise.resolve());
    const container = mount(<CopyButton text={"C:\\Games\\.minecraft"} label="复制路径" onCopy={onCopy} feedbackMs={2000} />);
    const button = () => container.querySelector("button") as HTMLButtonElement;
    expect(button().getAttribute("aria-label")).toBe("复制路径");
    act(() => button().click());
    expect(onCopy).toHaveBeenCalledWith("C:\\Games\\.minecraft");
    await flush();
    expect(button().getAttribute("aria-label")).toBe("已复制");
    act(() => vi.advanceTimersByTime(1999));
    expect(button().getAttribute("aria-label")).toBe("已复制");
    act(() => vi.advanceTimersByTime(1));
    expect(button().getAttribute("aria-label")).toBe("复制路径");
  });

  it("文本可以按需生成：点击时才求值", async () => {
    const make = vi.fn(() => "第一行\n第二行");
    const onCopy = vi.fn(() => Promise.resolve());
    const container = mount(<CopyButton text={make} label="复制日志" copiedLabel="已复制 2 行" onCopy={onCopy} feedbackMs={2000} />);
    expect(make).not.toHaveBeenCalled();
    act(() => (container.querySelector("button") as HTMLButtonElement).click());
    expect(make).toHaveBeenCalledTimes(1);
    expect(onCopy).toHaveBeenCalledWith("第一行\n第二行");
    await flush();
    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("已复制 2 行");
  });

  it("onCopy 以 false 结束（失败已由调用方报告）：不显示已复制，也不留下无人处理的 rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const onCopy = vi.fn(() => Promise.resolve(false));
      const container = mount(<CopyButton text="D:\\MC" label="复制路径" onCopy={onCopy} feedbackMs={2000} />);
      act(() => (container.querySelector("button") as HTMLButtonElement).click());
      await flush();
      expect(onCopy).toHaveBeenCalledTimes(1);
      expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("复制路径");
      act(() => vi.advanceTimersByTime(2000));
      expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("复制路径");
      await act(() => new Promise<void>((resolve) => setImmediate(resolve)));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("onCopy 以 true 结束：显示已复制", async () => {
    const container = mount(<CopyButton text="x" label="复制" onCopy={() => Promise.resolve(true)} feedbackMs={2000} />);
    act(() => (container.querySelector("button") as HTMLButtonElement).click());
    await flush();
    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("已复制");
  });

  it("复制还没完成前不显示已复制", () => {
    const container = mount(<CopyButton text="x" label="复制" onCopy={() => new Promise(() => undefined)} feedbackMs={2000} />);
    act(() => (container.querySelector("button") as HTMLButtonElement).click());
    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("复制");
  });

  it("图标位按阶段标记：初次挂载不标，复制成功标 copied，停留结束标 restored，再复制回到 copied", async () => {
    const container = mount(<CopyButton text="x" label="复制" onCopy={() => Promise.resolve()} feedbackMs={1500} />);
    const phase = () => container.querySelector("button")?.getAttribute("data-copy-phase");
    expect(container.querySelector("button")?.classList.contains(styles.copy)).toBe(true);
    expect(phase()).toBeNull();
    act(() => (container.querySelector("button") as HTMLButtonElement).click());
    await flush();
    expect(phase()).toBe("copied");
    act(() => vi.advanceTimersByTime(1500));
    expect(phase()).toBe("restored");
    act(() => (container.querySelector("button") as HTMLButtonElement).click());
    await flush();
    expect(phase()).toBe("copied");
  });

  it("复制失败（onCopy 以 false 结束）：图标位不进 copied", async () => {
    const container = mount(<CopyButton text="x" label="复制" onCopy={() => Promise.resolve(false)} feedbackMs={1500} />);
    act(() => (container.querySelector("button") as HTMLButtonElement).click());
    await flush();
    expect(container.querySelector("button")?.hasAttribute("data-copy-phase")).toBe(false);
  });

  it("样式：对勾弹出加淡入、复制图标淡回，三段关键帧各自命名；减少动画时对勾只淡入", () => {
    const css = readFileSync(resolve(__dirname, "KV.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = (selector: string) => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const found = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
      if (found === null) throw new Error(`KV.module.css 没有 ${selector}`);
      return found[1];
    };
    const copied = rule('.copy[data-copy-phase="copied"] svg');
    expect(copied).toMatch(/copied-pop var\(--sk-spring-pop-dur\) var\(--sk-spring-pop\)/);
    expect(copied).toMatch(/copied-fade var\(--sk-dur-in\) var\(--sk-ease-out\)/);
    const restored = rule('.copy[data-copy-phase="restored"] svg');
    expect(restored).toMatch(/restored-fade var\(--sk-dur-in\) var\(--sk-ease-out\)/);
    expect(restored).not.toMatch(/copied-/);
    const reduced = rule(':global([data-sk-reduced]) .copy[data-copy-phase="copied"] svg');
    expect(reduced).toMatch(/copied-fade/);
    expect(reduced).not.toMatch(/copied-pop/);
    expect(css).toMatch(/@keyframes copied-pop\s*\{\s*from\s*\{\s*scale:\s*0\.6;/);
    expect(css).toMatch(/@keyframes copied-fade\s*\{\s*from\s*\{\s*opacity:\s*0;/);
    expect(css).toMatch(/@keyframes restored-fade\s*\{\s*from\s*\{\s*opacity:\s*0;/);
  });
});

describe("KV", () => {
  it("dl / dt / dd；可复制的行带复制按钮并放开选中", async () => {
    const onCopy = vi.fn(() => Promise.resolve());
    const container = mount(
      <KV
        rows={[
          { label: "版本", value: "1.21.4" },
          { label: "目录", value: "D:\\MC\\生存", copy: "D:\\MC\\生存" },
        ]}
        onCopy={onCopy}
        copyFeedbackMs={2000}
      />,
    );
    const dl = container.querySelector("dl");
    expect([...(dl?.querySelectorAll("dt") ?? [])].map((dt) => dt.textContent)).toEqual(["版本", "目录"]);
    const dds = [...(dl?.querySelectorAll("dd") ?? [])];
    expect(dds.map((dd) => dd.hasAttribute("data-copyable"))).toEqual([false, true]);
    expect(dds[0].querySelector("button")).toBeNull();
    const copy = dds[1].querySelector("button") as HTMLButtonElement;
    act(() => copy.click());
    expect(onCopy).toHaveBeenCalledWith("D:\\MC\\生存");
  });

  it("有可复制的行却没给 onCopy 或停留时长时抛错", () => {
    expect(() => mount(<KV rows={[{ label: "UUID", value: "x", copy: "x" }]} />)).toThrow(/onCopy 与 copyFeedbackMs/);
    view?.unmount();
    expect(() => mount(<KV rows={[{ label: "UUID", value: "x", copy: "x" }]} onCopy={() => Promise.resolve()} />)).toThrow(/copyFeedbackMs/);
  });
});
