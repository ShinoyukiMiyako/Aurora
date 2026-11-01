// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, type Rendered } from "../test/dom";
import { EmptyState } from "./EmptyState";

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

describe("EmptyState", () => {
  it("插画变体：同时备好 96 与 64 两档空状态图，标题、正文、动作依次排列", () => {
    view = render(<EmptyState scene="sapling" title="还没有实例" body="新建一个实例开始游戏。" action={<button type="button">新建实例</button>} />);
    const root = view.container.firstElementChild as HTMLElement;
    expect(root.dataset.variant).toBe("art");
    const arts = root.querySelectorAll("svg[data-scene='sapling']");
    expect([...arts].map((a) => a.getAttribute("width"))).toEqual(["96", "64"]);
    expect([...arts].every((a) => a.getAttribute("aria-hidden") === "true")).toBe(true);
    expect(root.querySelector("circle")?.getAttribute("cy")).toBe("52");
    const texts = [...root.children].slice(1).map((el) => [el.tagName, el.textContent]);
    expect(texts).toEqual([
      ["P", "还没有实例"],
      ["P", "新建一个实例开始游戏。"],
      ["DIV", "新建实例"],
    ]);
  });

  it("出错类别的场景：危险色底圆、只有一片深色花瓣", () => {
    view = render(<EmptyState scene="error" title="这部分没能显示" />);
    const art = view.container.querySelector("svg[data-scene='error']");
    expect(art?.getAttribute("data-category")).toBe("error");
    expect(art?.querySelectorAll("svg[data-glyph]").length).toBe(1);
    expect(art?.querySelector("svg[data-glyph]")?.getAttribute("data-tone")).toBe("deep");
  });

  it("图标变体：浅强调底座 + 24 档图标；标题可指定标题标签；没有正文与动作时不渲染空节点", () => {
    view = render(<EmptyState icon="filter" title="没有符合条件的实例" titleAs="h3" />);
    const root = view.container.firstElementChild as HTMLElement;
    expect(root.dataset.variant).toBe("icon");
    expect(root.querySelector("svg[data-scene]")).toBeNull();
    expect(root.querySelector("svg")?.getAttribute("width")).toBe("24");
    expect(root.querySelector("h3")?.textContent).toBe("没有符合条件的实例");
    expect(root.children).toHaveLength(2);
  });

  it("强制紧凑档", () => {
    view = render(<EmptyState scene="offline" title="网络不可用" compact />);
    expect((view.container.firstElementChild as HTMLElement).dataset.compact).toBe("true");
  });

  it("scene 与 icon 必须且只能给一个", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<EmptyState title="x" {...({} as { scene: "sapling" })} />)).toThrow("必须且只能给一个");
    expect(() => render(<EmptyState title="x" {...({ scene: "sapling", icon: "filter" } as unknown as { scene: "sapling" })} />)).toThrow("必须且只能给一个");
  });
});
