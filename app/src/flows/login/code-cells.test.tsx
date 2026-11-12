// @vitest-environment jsdom
import { MotionConfig } from "framer-motion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codeCell, fade, springs } from "../../lib/motion";
import { render } from "../../test/dom";
import { CodeCells } from "./DeviceCodeDialog";

type Show = { opacity: number; y: number; transition: { delay: number; opacity: object } };
const show = (i: number) => (codeCell.show as (i: number) => Show)(i);

describe("设备码逐字入场", () => {
  it("第 i 格晚 i × 50 ms 起步；透明度带同一个延迟，不先于位移淡出来", () => {
    for (const i of [0, 1, 4, 8]) {
      const target = show(i);
      expect(target.transition.delay).toBeCloseTo(i * 0.05, 10);
      expect(target.transition.opacity).toEqual({ ...fade.in, delay: target.transition.delay });
    }
    // 位移走 pop
    expect(show(3).transition).toMatchObject(springs.pop as object);
    expect(codeCell.hidden).toEqual({ opacity: 0, y: 6 });
  });

  it("格子与短横都从下方上浮淡入，短横不提前单独出现", () => {
    const view = render(<CodeCells code="PF7Q-X2LM" expired={false} />);
    const group = view.container.querySelector<HTMLElement>("[role='img']");
    if (group === null) throw new Error("没有代码格");
    const parts = [...group.children] as HTMLElement[];
    expect(parts).toHaveLength(9);
    expect(parts.map((p) => p.textContent)).toEqual(["P", "F", "7", "Q", "", "X", "2", "L", "M"]);
    // 挂载那一刻：每一格（含第 5 个位置的短横）都还透明、在下方 6px
    for (const part of parts) {
      expect(part.style.opacity).toBe("0");
      expect(part.style.transform).toBe("translateY(6px)");
    }
    view.unmount();
  });

  describe("每格领到的序号", () => {
    /** 每一格解析入场目标时拿到的序号（framer-motion 把 custom 交给变体函数）。 */
    function orders(reduced: "always" | "never"): number[] {
      const show = vi.spyOn(codeCell as { show: (i: number) => unknown }, "show");
      const view = render(
        <MotionConfig reducedMotion={reduced}>
          <CodeCells code="PF7Q-X2LM" expired={false} />
        </MotionConfig>,
      );
      const seen = show.mock.calls.map(([i]) => i);
      view.unmount();
      return seen;
    }
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("平时按位置逐格错开，短横也按自己的位置", () => {
      expect([...new Set(orders("never"))].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it("减少动画：每格都按 0，整组一次淡入，不逐格等", () => {
      const seen = orders("always");
      expect(seen.length).toBeGreaterThanOrEqual(9);
      expect(new Set(seen)).toEqual(new Set([0]));
    });
  });
});
