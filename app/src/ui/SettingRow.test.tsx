// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { render, type Rendered } from "../test/dom";
import { SettingRow } from "./SettingRow";

// 让位挂到了哪些容器上：jsdom 不做布局，让位本身在这里测不了，只核对它挂对了地方；挂载照常交给真实现
const reflowed = vi.hoisted(() => new Set<Element>());
vi.mock("../lib/reflow", async (orig) => {
  const mod = await orig<typeof import("../lib/reflow")>();
  const { useCallback } = await import("react");
  return {
    ...mod,
    useReflow: <T extends HTMLElement>(spring: Parameters<typeof mod.useReflow>[0] = "settle") => {
      const real = mod.useReflow<T>(spring);
      return useCallback(
        (el: T | null) => {
          if (el !== null) reflowed.add(el);
          return real(el);
        },
        [real],
      );
    },
  };
});

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
  reflowed.clear();
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

describe("SettingRow", () => {
  it("把标题与说明的 id 交给控件，名称与可见标题一致", () => {
    const container = mount(
      <SettingRow title="自动下载 Java" description="缺少所需版本时自动下载">
        {({ titleId, descriptionId }) => <button type="button" aria-labelledby={titleId} aria-describedby={descriptionId} />}
      </SettingRow>,
    );
    const button = container.querySelector("button") as HTMLButtonElement;
    const title = document.getElementById(button.getAttribute("aria-labelledby") as string);
    const desc = document.getElementById(button.getAttribute("aria-describedby") as string);
    expect(title?.textContent).toBe("自动下载 Java");
    expect(desc?.textContent).toBe("缺少所需版本时自动下载");
  });

  it("没有说明时说明 id 为 undefined；折行标记只在开启时出现", () => {
    let seen: string | undefined = "unset";
    const container = mount(
      <SettingRow title="内存" stackOnCompact>
        {({ descriptionId }) => {
          seen = descriptionId;
          return <span>滑杆</span>;
        }}
      </SettingRow>,
    );
    expect(seen).toBeUndefined();
    expect((container.firstElementChild as HTMLElement).dataset.stack).toBe("true");
  });

  it("说明会变高的行打开 reflow：让位挂在行上（标题说明列与控件互相让位）；默认不挂", () => {
    const container = mount(
      <>
        <SettingRow title="游戏启动后" description="隐藏启动器" reflow>
          <span>分段</span>
        </SettingRow>
        <SettingRow title="自动下载 Java">
          <span>开关</span>
        </SettingRow>
      </>,
    );
    const [moving, still] = [...container.children];
    expect(reflowed.has(moving)).toBe(true);
    expect(reflowed.has(still)).toBe(false);
    // 让位项是行的两个直接子项：标题说明列与控件区
    expect([...moving.children].map((c) => c.textContent)).toEqual(["游戏启动后隐藏启动器", "分段"]);
  });
});
