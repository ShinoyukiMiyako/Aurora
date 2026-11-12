// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { render, type Rendered } from "../test/dom";
import { statLabel, StatGrid, StatTile, type StatDelta } from "./StatTile";

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
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

describe("StatTile", () => {
  it("读屏名称拼接标签、数值、单位与环比", () => {
    expect(statLabel("近 7 天", "12.5", "小时", { direction: "up", text: "较前 7 天 +18%" })).toBe("近 7 天 12.5 小时，较前 7 天 +18%");
    expect(statLabel("常玩加载器", "Fabric", undefined, undefined)).toBe("常玩加载器 Fabric");
  });

  it("方向只决定图标，色调由调用方给：下降可以是正面的", () => {
    const container = mount(
      <StatGrid columns={4}>
        <StatTile label="近 7 天" icon="clock" value="3.2" unit="小时" delta={{ direction: "down", tone: "positive", text: "较前 7 天 -40%" }} />
        <StatTile label="连续游玩" value="5" unit="天" delta={{ direction: "flat", text: "持平" }} />
        <StatTile label="常玩加载器" value="Fabric" kind="text" />
      </StatGrid>,
    );
    expect((container.firstElementChild as HTMLElement).dataset.columns).toBe("4");
    const tiles = [...container.querySelectorAll<HTMLElement>('[role="group"]')];
    expect(tiles.map((t) => t.getAttribute("aria-label"))).toEqual(["近 7 天 3.2 小时，较前 7 天 -40%", "连续游玩 5 天，持平", "常玩加载器 Fabric"]);
    const deltas = [...container.querySelectorAll<HTMLElement>("[data-direction]")];
    expect(deltas.map((d) => [d.dataset.direction, d.dataset.tone])).toEqual([
      ["down", "positive"],
      ["flat", "neutral"],
    ]);
    expect(deltas[0].querySelector("svg")?.getAttribute("width")).toBe("12");
    expect(container.querySelectorAll<HTMLElement>("[data-kind]")[2].dataset.kind).toBe("text");
  });

  describe("环比晚到（delta 为 null）", () => {
    const tile = (delta: StatDelta | null | undefined) => <StatTile icon="box" label="Mod" value="12" unit="个" delta={delta} />;
    const rerender = (ui: ReactNode) =>
      view?.rerender(
        <OverlayProvider>
          {ui}
          <OverlayRoot />
        </OverlayProvider>,
      );
    const rows = () => [...(view?.container.querySelector('[role="group"]')?.children ?? [])] as HTMLElement[];
    const outdated: StatDelta = { direction: "up", tone: "positive", text: "3 个可更新" };

    it("等待时占住一行：空的、读屏忽略，读屏名称不带环比", () => {
      mount(tile(null));
      expect(rows()).toHaveLength(3);
      const slot = rows()[2];
      expect(slot.hasAttribute("data-reserve")).toBe(true);
      expect(slot.getAttribute("aria-hidden")).toBe("true");
      expect(slot.textContent).toBe("");
      expect(view?.container.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe("Mod 12 个");
    });

    it("到了：在同一行淡入，读屏名称补上环比", () => {
      mount(tile(null));
      rerender(tile(outdated));
      expect(rows()).toHaveLength(3);
      const arrived = rows()[2];
      expect(arrived.hasAttribute("data-reserve")).toBe(false);
      expect(arrived.textContent).toBe("3 个可更新");
      expect(arrived.dataset.tone).toBe("positive");
      expect(arrived.style.opacity).toBe("0");
      expect(view?.container.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe("Mod 12 个，3 个可更新");
    });

    it("挂载时就有环比：不单独淡入，跟着页面入场；不传就没有这一行", () => {
      mount(tile(outdated));
      expect(rows()[2].style.opacity).toBe("");
      view?.unmount();
      mount(tile(undefined));
      expect(rows()).toHaveLength(2);
    });

    it("样式：占位行与有字时同一行高", () => {
      const css = readFileSync(resolve(__dirname, "StatTile.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(css).toMatch(/(?:^|\n)\.delta\s*\{[^}]*\sline-height:\s*var\(--sk-lh-caption\);/);
      expect(css).toMatch(/(?:^|\n)\.delta\[data-reserve\]\s*\{\s*height:\s*var\(--sk-lh-caption\);\s*\}/);
    });
  });
});
