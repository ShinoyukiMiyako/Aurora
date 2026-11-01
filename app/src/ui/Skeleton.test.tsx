// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { render, type Rendered } from "../test/dom";
import { proportionalRadius, Skeleton } from "./Skeleton";

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

const root = () => view?.container.firstElementChild as HTMLElement;

describe("Skeleton", () => {
  it("文字行：多行时只有末行标记为 60% 宽，整体不朗读", () => {
    view = render(<Skeleton shape="text" lines={3} width={240} />);
    const lines = [...root().children] as HTMLElement[];
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.dataset.last)).toEqual([undefined, undefined, ""]);
    expect(root().getAttribute("aria-hidden")).toBe("true");
    expect(root().style.width).toBe("240px");
  });

  it("单行文字不缩短", () => {
    view = render(<Skeleton shape="text" />);
    const lines = [...root().children] as HTMLElement[];
    expect(lines).toHaveLength(1);
    expect(lines[0].dataset.last).toBeUndefined();
  });

  it.each([0, -1, 1.5])("行数 %s 非法时抛错", (lines) => {
    expect(() => render(<Skeleton shape="text" lines={lines} />)).toThrow(/正整数/);
  });

  it("块：尺寸照给、圆角取令牌档", () => {
    view = render(<Skeleton shape="block" width="100%" height={56} radius="pill" />);
    expect(root().style.width).toBe("100%");
    expect(root().style.height).toBe("56px");
    expect(root().dataset.radius).toBe("pill");
    expect(root().getAttribute("aria-hidden")).toBe("true");
  });

  it("方块：圆角按边长 × 0.3 取整", () => {
    expect(proportionalRadius(40)).toBe(12);
    expect(proportionalRadius(30)).toBe(9);
    expect(proportionalRadius(128)).toBe(38);
    view = render(<Skeleton shape="square" size={44} />);
    expect(root().style.width).toBe("44px");
    expect(root().style.height).toBe("44px");
    expect(root().style.borderRadius).toBe("13px");
  });

  it("方块边长必须为正", () => {
    expect(() => render(<Skeleton shape="square" size={0} />)).toThrow(/正数/);
  });
});
