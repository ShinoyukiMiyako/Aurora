// @vitest-environment jsdom
import { act, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { render, type Rendered } from "../test/dom";
import { FocusReturnPoint } from "./focus-return";

let view: Rendered | undefined;

afterEach(() => {
  view?.unmount();
  view = undefined;
});

const byText = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === text) as HTMLButtonElement;

describe("焦点归还", () => {
  // 导入确认步：说明块开始退场（Appear 的退场层带 inert），打开清单的按钮还在文档里。
  // 浏览器里焦点还给它会落空、掉回 body；jsdom 不实现 inert，焦点会落在它身上
  it("原焦点元素还在文档里、但在 inert 子树里：落到它所在区域里第一个接得住焦点的控件", () => {
    const handles: { open?: () => void; close?: () => void } = {};
    function Host() {
      const [open, setOpen] = useState(false);
      const [leaving, setLeaving] = useState(false);
      handles.open = () => {
        setOpen(true);
        setLeaving(true);
      };
      handles.close = () => setOpen(false);
      return (
        <div>
          <div inert={leaving}>
            <button>查看这些文件</button>
          </div>
          <button>继续导入</button>
          <FocusReturnPoint active={open} />
          {open && <button>清单</button>}
        </div>
      );
    }
    view = render(<Host />);
    act(() => byText("查看这些文件").focus());
    act(() => handles.open?.());
    act(() => byText("清单").focus());
    act(() => handles.close?.());
    // 关上那一刻说明块还在退场：打开前记下的按钮仍在 inert 子树里
    expect(byText("查看这些文件").closest("[inert]")).not.toBeNull();
    expect(document.activeElement).toBe(byText("继续导入"));
  });

  it("原焦点元素可用：照常还给它", () => {
    const handles: { open?: () => void; close?: () => void } = {};
    function Host() {
      const [open, setOpen] = useState(false);
      handles.open = () => setOpen(true);
      handles.close = () => setOpen(false);
      return (
        <div>
          <button>查看这些文件</button>
          <button>继续导入</button>
          <FocusReturnPoint active={open} />
          {open && <button>清单</button>}
        </div>
      );
    }
    view = render(<Host />);
    act(() => byText("查看这些文件").focus());
    act(() => handles.open?.());
    act(() => byText("清单").focus());
    act(() => handles.close?.());
    expect(document.activeElement).toBe(byText("查看这些文件"));
  });
});
