// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { render, type Rendered } from "../test/dom";
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

  it("复制还没完成前不显示已复制", () => {
    const container = mount(<CopyButton text="x" label="复制" onCopy={() => new Promise(() => undefined)} feedbackMs={2000} />);
    act(() => (container.querySelector("button") as HTMLButtonElement).click());
    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("复制");
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
