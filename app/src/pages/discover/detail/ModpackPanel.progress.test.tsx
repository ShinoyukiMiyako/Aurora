// @vitest-environment jsdom
// 整个文件走真实时间：百分数随平滑逐帧走，framer-motion 的帧循环不受假定时器驱动（见 test/dom 的 waitForFrames）。
import { afterEach, describe, expect, it } from "vitest";
import { render, waitForFrames, type Rendered } from "../../../test/dom";
import { DownloadingLine } from "./ModpackPanel";

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

function text(): string | null {
  if (view === undefined) throw new Error("还没有挂载");
  return view.container.textContent;
}

describe("整合包面板：下载中的那一行字", () => {
  it("百分数跟着进度条的平滑走：进度事件到达的那一刻不跳字，随后一帧帧走到新值", async () => {
    view = render(<DownloadingLine progress={0.42} track="task-1" />);
    expect(text()).toBe("正在下载 · 42%");
    view.rerender(<DownloadingLine progress={0.8} track="task-1" />);
    expect(text()).toBe("正在下载 · 42%");
    await waitForFrames(() => expect(text()).toBe("正在下载 · 80%"));
  });

  it("换了任务（track 变了）直接写新任务的进度，不从上一个任务的数走过来", () => {
    view = render(<DownloadingLine progress={0.9} track="task-1" />);
    view.rerender(<DownloadingLine progress={0.1} track="task-2" />);
    expect(text()).toBe("正在下载 · 10%");
  });

  it("任务已经结束、只等新实例落地时没有 track：直接写满格", () => {
    view = render(<DownloadingLine progress={1} track={undefined} />);
    expect(text()).toBe("正在下载 · 100%");
  });
});
