// @vitest-environment jsdom
// 图标位换内容的入场起点与 lib/motion 的 faceSwap 是同一份参数：这里把 faceSwap 两档的起点换成别的值，
// 按钮的图标位要跟着变。换了值会让同文件里按真实参数断言的用例失效，所以单独成文件。
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { render, stubSpanAnimations, type Rendered } from "../test/dom";
import { Button } from "./Button";

// 与真实参数（0.6 与 0.8）都不同
const FROM = vi.hoisted(() => ({ pop: 0.5, tap: 0.7 }));

vi.mock("../lib/motion", async (orig) => {
  const real = await orig<typeof import("../lib/motion")>();
  return {
    ...real,
    faceSwap: {
      ...real.faceSwap,
      pop: { ...real.faceSwap.pop, initial: { opacity: 0, scale: FROM.pop } },
      tap: { ...real.faceSwap.tap, initial: { opacity: 0, scale: FROM.tap } },
    },
  };
});

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

function layerOf(root: Element, glyph: string): HTMLElement {
  const layer = root.querySelector<HTMLElement>(`[data-glyph="${glyph}"]`);
  if (layer === null) throw new Error(`没有「${glyph}」这一层`);
  return layer;
}

describe("图标位的入场起点取自 faceSwap", () => {
  it("换成加载指示从 faceSwap.tap 的起点收拢，换回图标从 faceSwap.pop 的起点弹出", () => {
    const waapi = stubSpanAnimations();
    const ui = (loading: boolean) => (
      <OverlayProvider>
        <Button icon="download" loading={loading}>
          下载
        </Button>
        <OverlayRoot />
      </OverlayProvider>
    );
    view = render(ui(false));
    const button = view.container.querySelector("button");
    if (button === null) throw new Error("没有渲染出 button");

    view.rerender(ui(true));
    expect(Number(waapi.running(layerOf(button, "spinner"), "scale").frames[0].scale)).toBe(FROM.tap);

    // 换下的图标淡完、被移除之后再换回：还在淡出时换回是接回原来那层，不播弹出
    waapi.finishAll();
    view.rerender(ui(false));
    expect(Number(waapi.running(layerOf(button, "download"), "scale").frames[0].scale)).toBe(FROM.pop);
  });
});
