// @vitest-environment jsdom
// 控件的提示包裹层常驻：禁用原因随状态来去时（Toast 的动作按钮随遮罩开合换原因）控件节点不能换，
// 换了就是重挂，聚焦着的控件把焦点丢回 body，键盘用户只能从文档开头重新找起。
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorScreen } from "../shell/ErrorScreen";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { focusByKeyboard, render, type Rendered } from "../test/dom";
import { Button } from "./Button";
import { Checkbox } from "./Checkbox";
import { IconButton } from "./IconButton";
import { Toggle } from "./Toggle";

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

const REASON = "游戏运行中不能修改";
const noop = () => undefined;

const withOverlay = (ui: ReactNode) => (
  <OverlayProvider>
    {ui}
    <OverlayRoot />
  </OverlayProvider>
);

const CONTROLS: readonly [string, (reason: string | undefined) => ReactNode][] = [
  ["Button", (reason) => <Button disabledReason={reason}>保存</Button>],
  ["IconButton", (reason) => <IconButton icon="folder" label="打开文件夹" disabledReason={reason} />],
  ["关掉提示的 IconButton", (reason) => <IconButton icon="x" label="移除" tooltip={false} disabledReason={reason} />],
  ["Toggle", (reason) => <Toggle checked={false} onChange={noop} ariaLabel="自动备份" disabledReason={reason} />],
  ["Checkbox", (reason) => <Checkbox checked={false} onChange={noop} ariaLabel="选中" disabledReason={reason} />],
];

function control(rendered: Rendered): HTMLButtonElement {
  const el = rendered.container.querySelector("button");
  if (el === null) throw new Error("没有渲染出控件");
  return el;
}

describe("禁用原因的有无切换", () => {
  it.each(CONTROLS)("%s：节点不换，焦点留在控件上，可用与否跟着变", (_name, ui) => {
    view = render(withOverlay(ui(undefined)));
    const el = control(view);
    el.focus();
    expect(el.getAttribute("aria-disabled")).toBeNull();

    view.rerender(withOverlay(ui(REASON)));
    expect(control(view)).toBe(el);
    expect(document.activeElement).toBe(el);
    expect(el.getAttribute("aria-disabled")).toBe("true");

    view.rerender(withOverlay(ui(undefined)));
    expect(control(view)).toBe(el);
    expect(document.activeElement).toBe(el);
    expect(el.getAttribute("aria-disabled")).toBeNull();
  });

  it.each(CONTROLS)("%s：原因后来才有，聚焦照常写出原因", (_name, ui) => {
    view = render(withOverlay(ui(undefined)));
    view.rerender(withOverlay(ui(REASON)));
    focusByKeyboard(control(view));
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(REASON);
  });

  it("没传原因的 Button 与关掉提示的 IconButton：聚焦不出气泡", () => {
    view = render(
      withOverlay(
        <>
          <Button>保存</Button>
          <IconButton icon="x" label="移除" tooltip={false} />
        </>,
      ),
    );
    for (const el of view.container.querySelectorAll("button")) focusByKeyboard(el);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });
});

describe("OverlayProvider 之外", () => {
  // 错误屏是外壳的最后一道兜底，渲染在 ShellProvider 外面；它的按钮一旦要求浮层体系，错误页自己也会崩
  it("错误屏的按钮照常渲染", () => {
    view = render(<ErrorScreen title="启动器出错了" body="可以复制错误信息后重新加载" error={new Error("磁盘已满")} />);
    expect(view.container.querySelectorAll("button")).toHaveLength(2);
    expect(view.container.textContent).toContain("磁盘已满");
  });
});
