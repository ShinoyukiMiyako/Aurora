// @vitest-environment jsdom
import { motion } from "framer-motion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, waitForFrames, type Rendered } from "./dom";

let view: Rendered | undefined;

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
});

describe("waitForFrames", () => {
  it("一直等到 framer-motion 在真实帧上把动画播到终值", async () => {
    view = render(<motion.div data-testid="box" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.1 }} />);
    const box = view.container.querySelector<HTMLElement>('[data-testid="box"]');
    if (box === null) throw new Error("没有渲染出动画元素");
    expect(box.style.opacity).toBe("0");
    await waitForFrames(() => expect(box.style.opacity).toBe("1"));
  });

  it("假定时器下直接报错，不拿推进假时钟冒充等帧", async () => {
    vi.useFakeTimers();
    const assertion = vi.fn();
    await expect(waitForFrames(assertion)).rejects.toThrow("waitForFrames 要在真实计时器下用");
    expect(assertion).not.toHaveBeenCalled();
  });
});
