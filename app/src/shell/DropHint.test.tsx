// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { DROP_COPY } from "../copy/shell";
import { render, type Rendered } from "../test/dom";
import { DropHint } from "./DropHint";
import type { FileDropHint } from "./file-drop";

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

const ui = (hint: FileDropHint) => <DropHint hint={hint} />;

const liveRegions = () => [...document.querySelectorAll<HTMLElement>('[role="status"]')];

describe("放置提示的读屏播报", () => {
  // 读屏只播报已存在的 live region 里后来的变化；带着文字一起插入的 status 往往一声不响
  it("没有拖放时 live region 已经挂着、内容为空；拖进来只往同一个节点里写字，拖出后清空但节点不卸", () => {
    view = render(ui(null));
    const [region] = liveRegions();
    expect(liveRegions()).toHaveLength(1);
    expect(region.textContent).toBe("");
    expect(region.hasAttribute("data-hint")).toBe(false);
    // 视觉隐藏走全局类，不在模块样式里另写一份
    expect(region.className).toBe("sk-sr-only");

    view.rerender(ui("modpack"));
    expect(liveRegions()).toEqual([region]);
    expect(region.textContent).toBe(DROP_COPY.modpackHint);
    expect(region.dataset.hint).toBe("modpack");

    view.rerender(ui("auth_server"));
    expect(liveRegions()).toEqual([region]);
    expect(region.textContent).toBe(DROP_COPY.authServerHint);
    expect(region.dataset.hint).toBe("auth_server");

    view.rerender(ui("mods"));
    expect(liveRegions()).toEqual([region]);
    expect(region.textContent).toBe(DROP_COPY.modsHint);
    expect(region.dataset.hint).toBe("mods");

    view.rerender(ui(null));
    expect(liveRegions()).toEqual([region]);
    expect(region.isConnected).toBe(true);
    expect(region.textContent).toBe("");
    expect(region.hasAttribute("data-hint")).toBe(false);
  });

  it("整窗的视觉层对读屏隐藏，同一句话不被念两遍", () => {
    view = render(ui("modpack"));
    const overlay = view.container.querySelector<HTMLElement>('[aria-hidden="true"][data-hint="modpack"]');
    expect(overlay).not.toBeNull();
    expect(overlay?.hasAttribute("role")).toBe(false);
    expect(overlay?.textContent).toBe(DROP_COPY.modpackHint);
    expect(liveRegions()).toHaveLength(1);
    expect(liveRegions()[0].closest('[aria-hidden="true"]')).toBeNull();
  });
});
