// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

  it("块：高度可以撑满所在位置（随内容伸缩的舞台），照写成百分比", () => {
    view = render(<Skeleton shape="block" width="100%" height="100%" radius="lg" />);
    expect(root().style.height).toBe("100%");
    expect(root().style.width).toBe("100%");
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

  it("文字行的高度跟随所在位置的行高（1lh），不写死正文行高：放进 18 或 20 的行里换成文字时不跳", () => {
    const css = readFileSync(resolve(__dirname, "Skeleton.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const line = css.slice(css.indexOf(".line {"), css.indexOf("}", css.indexOf(".line {")));
    expect(line).toContain("height: var(--skeleton-line);");
    expect(line).toContain("margin: calc((1lh - var(--skeleton-line)) / 2) 0;");
    expect(line).not.toContain("--sk-lh-body");
  });
});
