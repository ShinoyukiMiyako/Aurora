// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { render, stubSpanAnimations, type Rendered } from "../test/dom";
import { CopyButton, KV } from "./KV";

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

  it("复制成功后强制显示「已复制」提示：没有悬停与聚焦也显示，停留结束收起", async () => {
    const container = mount(<CopyButton text="x" label="复制路径" onCopy={() => Promise.resolve()} feedbackMs={1500} />);
    const button = () => container.querySelector("button") as HTMLButtonElement;
    const bubble = () => {
      const id = button().getAttribute("aria-describedby");
      return id === null ? null : document.getElementById(id);
    };
    expect(bubble()).toBeNull();
    act(() => button().click());
    await flush();
    expect(bubble()?.getAttribute("role")).toBe("tooltip");
    expect(bubble()?.textContent).toBe("已复制");
    act(() => vi.advanceTimersByTime(1500));
    expect(button().hasAttribute("aria-describedby")).toBe(false);
  });

  it("复制失败：不强制显示提示", async () => {
    const container = mount(<CopyButton text="x" label="复制路径" onCopy={() => Promise.resolve(false)} feedbackMs={1500} />);
    act(() => (container.querySelector("button") as HTMLButtonElement).click());
    await flush();
    expect(container.querySelector("button")?.hasAttribute("aria-describedby")).toBe(false);
  });

  /** 图标位里各层：[身份, 入场方式或 leaving / still]。 */
  const glyphs = (container: HTMLElement) =>
    [...container.querySelectorAll<HTMLElement>("button [data-glyph]")].map((g) => [g.dataset.glyph, g.hasAttribute("data-leaving") ? "leaving" : (g.dataset.enter ?? "still")]);

  it("图标位：初次挂载的复制图标不播入场；复制成功对勾弹出、复制图标淡出；停留结束复制图标弹回", async () => {
    const waapi = stubSpanAnimations();
    const container = mount(<CopyButton text="x" label="复制" onCopy={() => Promise.resolve()} feedbackMs={1500} />);
    expect(glyphs(container)).toEqual([["copy", "still"]]);
    expect(waapi.played).toHaveLength(0);
    act(() => (container.querySelector("button") as HTMLButtonElement).click());
    await flush();
    expect(glyphs(container)).toEqual([
      ["copy", "leaving"],
      ["check", "pop"],
    ]);
    const layer = (glyph: string) => container.querySelector(`button [data-glyph="${glyph}"]`) as HTMLElement;
    expect(waapi.running(layer("copy"), "opacity").frames).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    expect(Number(waapi.running(layer("check"), "scale").frames[0].scale)).toBe(0.6);
    // 淡出播完才移除复制图标；入场播完摘掉标记
    waapi.finishAll();
    expect(glyphs(container)).toEqual([["check", "still"]]);
    act(() => vi.advanceTimersByTime(1500));
    expect(glyphs(container)).toEqual([
      ["check", "leaving"],
      ["copy", "pop"],
    ]);
  });

  it("复制失败（onCopy 以 false 结束）：图标位不换", async () => {
    const container = mount(<CopyButton text="x" label="复制" onCopy={() => Promise.resolve(false)} feedbackMs={1500} />);
    act(() => (container.querySelector("button") as HTMLButtonElement).click());
    await flush();
    expect(glyphs(container)).toEqual([["copy", "still"]]);
  });

  it("样式：不再给图标另加动画，换图标的弹出与淡出只由图标位做一层", () => {
    const css = readFileSync(resolve(__dirname, "KV.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).not.toMatch(/animation|@keyframes/);
    expect(css).not.toMatch(/\bsvg\b/);
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
