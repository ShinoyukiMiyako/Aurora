// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { render, type Rendered } from "../test/dom";
import { SettingRow } from "./SettingRow";

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
});
