// @vitest-environment jsdom
import { MotionConfig } from "framer-motion";
import { act, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { faceSwap } from "../lib/motion";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { render, type Rendered } from "../test/dom";
import { Checkbox, type CheckState } from "./Checkbox";
import styles from "./Checkbox.module.css";

let view: Rendered | undefined;

afterEach(() => {
  view?.unmount();
  view = undefined;
});

function Host({ initial }: { initial: CheckState }) {
  const [state, set] = useState<CheckState>(initial);
  return <Checkbox checked={state} label="全选" onChange={set} />;
}

describe("Checkbox 换勾号与减少动画", () => {
  it.each([
    ["never", `scale(${faceSwap.pop.initial.scale})`],
    ["always", ""],
  ] as const)("新勾号平常从略小处弹出；减少动画（%s）时只淡入、入场起点不带缩放，旧短横照旧留在原处淡出", (reducedMotion, transform) => {
    view = render(
      <OverlayProvider>
        <MotionConfig reducedMotion={reducedMotion}>
          <Host initial="mixed" />
        </MotionConfig>
        <OverlayRoot />
      </OverlayProvider>,
    );
    const box = document.querySelector('[role="checkbox"]') as HTMLButtonElement;
    const glyphs = () => [...box.querySelectorAll<HTMLElement>(`.${styles.glyph}`)];
    const [minus] = glyphs();

    act(() => box.click());
    const [leaving, entering] = glyphs();
    expect(leaving).toBe(minus);
    expect(entering.querySelector("svg")).not.toBeNull();
    expect(entering.style.opacity).toBe("0");
    expect(entering.style.transform).toBe(transform);
  });
});
