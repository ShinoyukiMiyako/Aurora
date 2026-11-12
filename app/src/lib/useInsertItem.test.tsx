// @vitest-environment jsdom

import { MotionConfig } from "framer-motion";
import { afterEach, expect, it } from "vitest";
import { render, type Rendered } from "../test/dom";
import { insertItem, insertItemFade } from "./motion";
import { useInsertItem, type InsertMotion } from "./useInsertItem";

let view: Rendered | undefined;

afterEach(() => {
  view?.unmount();
  view = undefined;
});

function probe(reduced: "always" | "never"): InsertMotion {
  let seen: InsertMotion | undefined;
  function Probe() {
    seen = useInsertItem();
    return null;
  }
  view = render(
    <MotionConfig reducedMotion={reduced}>
      <Probe />
    </MotionConfig>,
  );
  if (seen === undefined) throw new Error("探针没有渲染");
  return seen;
}

it("平常取带缩放的增删参数", () => {
  expect(probe("never")).toBe(insertItem);
});

it("减少动画生效时换成只动透明度的那一份，进出都不带缩放", () => {
  const motion = probe("always");
  expect(motion).toBe(insertItemFade);
  expect(motion.exit).toEqual({ opacity: 0, transition: { duration: 0.12, ease: [0.4, 0, 1, 1] } });
});
