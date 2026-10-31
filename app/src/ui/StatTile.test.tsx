// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { render, type Rendered } from "../test/dom";
import { statLabel, StatGrid, StatTile } from "./StatTile";

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
});
