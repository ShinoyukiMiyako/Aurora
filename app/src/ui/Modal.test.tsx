// @vitest-environment jsdom
import { AnimatePresence } from "framer-motion";
import { act, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { keydown, render, stubResizeObserver, type Rendered } from "../test/dom";
import { Button } from "./Button";
import { ConfirmDialog } from "./ConfirmDialog";
import { Modal } from "./Modal";
import { SearchInput } from "./SearchInput";
import { TextInput } from "./TextInput";

let view: Rendered | undefined;

beforeEach(() => {
  stubResizeObserver();
});

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
  return view;
}

const byText = (text: string) => {
  const el = [...document.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent === text);
  if (!el) throw new Error(`找不到按钮 ${text}`);
  return el;
};
const dialogs = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
const click = (el: Element, detail = 1) =>
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail }));
  });

/** 像用户逐字输入一样改 input：走原生 value setter 再派发 input，React 的 onChange 才收得到。 */
function typeInto(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("jsdom 没有 input.value 的 setter");
  for (const ch of text) {
    act(() => {
      setter.call(input, input.value + ch);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(document.activeElement).toBe(input);
  }
}

describe("Modal 焦点", () => {
  it("父组件每次重渲染都传新的 onClose，输入框连续输入不丢焦点", () => {
    const closes: string[] = [];
    function Host() {
      const [open, setOpen] = useState(false);
      const [name, setName] = useState("");
      return (
        <>
          <Button onClick={() => setOpen(true)}>重命名</Button>
          <Modal
            open={open}
            // 每次渲染都是新函数：effect 若依赖它，每次输入后都会重建，把焦点还给触发按钮再抢回弹窗本身
            onClose={() => closes.push(name)}
            title="重命名实例"
            footer={<Button>保存</Button>}
          >
            <TextInput value={name} onChange={setName} aria-label="实例名" />
          </Modal>
        </>
      );
    }
    mount(<Host />);
    const trigger = byText("重命名");
    act(() => trigger.focus());
    click(trigger);
    const input = document.querySelector<HTMLInputElement>('input[aria-label="实例名"]');
    if (!input) throw new Error("没有渲染出输入框");
    expect(document.activeElement).toBe(dialogs()[0]);
    act(() => input.focus());
    typeInto(input, "生存 1.21");
    expect(input.value).toBe("生存 1.21");
    expect(closes).toEqual([]);
  });

  it("没有 autofocus 子元素时聚焦弹窗本身；关闭后焦点还给打开它的按钮", () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button onClick={() => setOpen(true)}>打开</Button>
          <Modal open={open} onClose={() => setOpen(false)} title="详情">
            <p>正文</p>
          </Modal>
        </>
      );
    }
    mount(<Host />);
    const trigger = byText("打开");
    act(() => trigger.focus());
    click(trigger);
    expect(dialogs()).toHaveLength(1);
    expect(document.activeElement).toBe(dialogs()[0]);
    keydown(document.activeElement as Element, "Escape");
    expect(document.activeElement).toBe(trigger);
  });

  it("Tab 在弹窗内首尾循环，不会落到弹窗外", () => {
    mount(
      <>
        <Button>页面按钮</Button>
        <Modal open onClose={() => undefined} title="登录" footer={<Button>登录</Button>}>
          <TextInput value="" onChange={() => undefined} aria-label="用户名" data-autofocus="" />
        </Modal>
      </>,
    );
    const input = document.querySelector<HTMLInputElement>('input[aria-label="用户名"]') as HTMLInputElement;
    const close = document.querySelector<HTMLElement>('[aria-label="关闭"]') as HTMLElement;
    const submit = byText("登录");
    expect(document.activeElement).toBe(input);
    act(() => submit.focus());
    keydown(submit, "Tab");
    // 头部关闭按钮是弹窗里的第一个可 Tab 元素
    expect(document.activeElement).toBe(close);
    keydown(close, "Tab", { shiftKey: true });
    expect(document.activeElement).toBe(submit);
  });
});

describe("Esc 与叠放", () => {
  /** 先开流程弹窗，再在它之上开确认框：与真实使用的先后一致。 */
  function Stacked({ onModalClose, onConfirmClose }: { onModalClose: () => void; onConfirmClose: () => void }) {
    const [confirming, setConfirming] = useState(false);
    return (
      <Modal open onClose={onModalClose} title="新建实例" footer={<Button onClick={() => setConfirming(true)}>放弃</Button>}>
        <ConfirmDialog
          open={confirming}
          title="放弃新建实例？"
          body="已填的内容不会保留。"
          confirmLabel="放弃"
          cancelLabel="继续填写"
          tone="danger"
          onConfirm={() => undefined}
          onClose={() => {
            onConfirmClose();
            setConfirming(false);
          }}
        />
      </Modal>
    );
  }

  it("Esc 只关最上层：先关确认框，再按一次才关底下的弹窗", () => {
    const onModalClose = vi.fn();
    const onConfirmClose = vi.fn();
    mount(<Stacked onModalClose={onModalClose} onConfirmClose={onConfirmClose} />);
    const open = byText("放弃");
    act(() => open.focus());
    click(open);
    expect(dialogs()).toHaveLength(2);
    expect(document.activeElement).toBe(byText("继续填写"));
    keydown(document.activeElement as Element, "Escape");
    expect(onConfirmClose).toHaveBeenCalledTimes(1);
    expect(onModalClose).not.toHaveBeenCalled();
    // 确认框关闭后焦点回到底层弹窗里打开它的按钮
    expect(document.activeElement).toBe(open);
    keydown(document.activeElement as Element, "Escape");
    expect(onModalClose).toHaveBeenCalledTimes(1);
    expect(onConfirmClose).toHaveBeenCalledTimes(1);
  });

  it("叠在弹窗上的第二层遮罩透明；底层遮罩照常压暗", () => {
    mount(<Stacked onModalClose={() => undefined} onConfirmClose={() => undefined} />);
    click(byText("放弃"));
    const layers = [...document.querySelectorAll<HTMLElement>("[data-sk-modal-layer]")];
    expect(layers).toHaveLength(2);
    expect(layers[0].hasAttribute("data-stacked")).toBe(false);
    expect(layers[1].hasAttribute("data-stacked")).toBe(true);
  });

  it("弹窗里的搜索框：第一次 Esc 只清空，弹窗不关；内容为空后 Esc 才关弹窗", () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    function Search() {
      const [value, set] = useState("");
      return (
        <SearchInput
          value={value}
          aria-label="搜索 Mod"
          onChange={(v) => {
            onChange(v);
            set(v);
          }}
        />
      );
    }
    mount(
      <Modal open onClose={onClose} title="选择 Mod">
        <Search />
      </Modal>,
    );
    const input = document.querySelector<HTMLInputElement>('input[aria-label="搜索 Mod"]') as HTMLInputElement;
    act(() => input.focus());
    typeInto(input, "iris");
    keydown(input, "Escape");
    expect(onChange.mock.calls.map((c) => c[0])).toEqual(["i", "ir", "iri", "iris", ""]);
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
    keydown(input, "Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("dismissible=false：Esc 被吞掉但不关闭，也没有关闭按钮", () => {
    const onClose = vi.fn();
    mount(<Modal open onClose={onClose} title="正在登录" dismissible={false} />);
    const event = keydown(document.activeElement as Element, "Escape");
    expect(event.defaultPrevented).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[aria-label="关闭"]')).toBeNull();
  });
});

describe("遮罩点击", () => {
  const scrim = () => document.querySelector<HTMLElement>("[data-sk-modal-layer] > [aria-hidden]") as HTMLElement;
  const pointerDown = (el: Element) =>
    act(() => {
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });

  it("按下与抬起都在遮罩上才关闭；在弹窗里按下、在遮罩上松手不关", () => {
    const onClose = vi.fn();
    mount(<Modal open onClose={onClose} title="资源详情" />);
    pointerDown(dialogs()[0]);
    click(scrim());
    expect(onClose).not.toHaveBeenCalled();
    pointerDown(scrim());
    click(scrim());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closeOnScrim=false 的流程弹窗点遮罩不关，Esc 照常关", () => {
    const onClose = vi.fn();
    mount(<Modal open onClose={onClose} title="离线账户" closeOnScrim={false} />);
    pointerDown(scrim());
    click(scrim());
    expect(onClose).not.toHaveBeenCalled();
    keydown(document.activeElement as Element, "Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("ConfirmDialog", () => {
  it("危险确认默认聚焦「取消」", () => {
    mount(<ConfirmDialog open title="删除「生存」？" body="3 个存档会移入回收站。" confirmLabel="删除实例" tone="danger" onConfirm={() => undefined} onClose={() => undefined} />);
    expect(document.activeElement).toBe(byText("取消"));
    expect(byText("删除实例").dataset.variant).toBe("danger");
  });

  it("普通确认默认聚焦确认按钮", () => {
    mount(<ConfirmDialog open title="切换下载源？" confirmLabel="切换并重下" onConfirm={() => undefined} onClose={() => undefined} />);
    expect(document.activeElement).toBe(byText("切换并重下"));
    expect(byText("切换并重下").dataset.variant).toBe("primary");
  });

  it("点确认先调 onConfirm 再调 onClose；取消只调 onClose", () => {
    const calls: string[] = [];
    mount(
      <ConfirmDialog
        open
        title="结束游戏？"
        confirmLabel="结束游戏"
        tone="danger"
        onConfirm={() => calls.push("confirm")}
        onClose={() => calls.push("close")}
      />,
    );
    click(byText("结束游戏"));
    expect(calls).toEqual(["confirm", "close"]);
    click(byText("取消"));
    expect(calls).toEqual(["confirm", "close", "close"]);
  });

  it("确认键不能写「确定」这类不说明动作的泛称", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => mount(<ConfirmDialog open title="删除账户 Alex？" confirmLabel="确定" tone="danger" onConfirm={() => undefined} onClose={() => undefined} />)).toThrow(
      "确认键要写出动作",
    );
  });
});

describe("Modal 随父级退场", () => {
  it("父级 AnimatePresence 退场期间弹窗还在重渲染：始终只有一份弹窗、不报重复 key，退场播完后卸载", async () => {
    const error = vi.spyOn(console, "error");
    const handles: { tick?: () => void; hide?: () => void } = {};
    function Flow() {
      const [renders, setRenders] = useState(0);
      handles.tick = () => setRenders((n) => n + 1);
      return (
        <Modal open title={`新建实例 ${renders}`} onClose={() => undefined}>
          正文
        </Modal>
      );
    }
    function Host() {
      const [shown, setShown] = useState(true);
      handles.hide = () => setShown(false);
      return <AnimatePresence>{shown && <Flow key="flow" />}</AnimatePresence>;
    }
    mount(<Host />);
    expect(dialogs()).toHaveLength(1);

    act(() => handles.hide?.());
    // 退场期间流程自己的状态还在变（查询返回、计时器到点），弹窗跟着重渲染
    act(() => handles.tick?.());
    act(() => handles.tick?.());
    expect(dialogs()).toHaveLength(1);
    expect(error).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(dialogs()).toHaveLength(0), { timeout: 3000, interval: 20 });
  });

  // 关着的弹窗常挂在页面里（例如打开过一次的详情弹窗）。页面整体退场时它没有任何东西要播，不能拖住父级：
  // mode="wait" 下父级退场播不完，下一屏就永远挂不上。
  it("关着的弹窗挂在退场的子树里：父级照常退场完，mode=wait 的下一屏能挂上", async () => {
    const handles: { swap?: () => void } = {};
    function Page() {
      return (
        <div data-testid="page">
          <Modal open={false} title="资讯详情" onClose={() => undefined}>
            正文
          </Modal>
        </div>
      );
    }
    function Host() {
      const [screen, setScreen] = useState<"home" | "wizard">("home");
      handles.swap = () => setScreen("wizard");
      return <AnimatePresence mode="wait">{screen === "home" ? <Page key="home" /> : <p key="wizard">向导</p>}</AnimatePresence>;
    }
    mount(<Host />);
    expect(document.querySelector('[data-testid="page"]')).not.toBeNull();
    act(() => handles.swap?.());
    await vi.waitFor(() => expect(document.body.textContent).toContain("向导"), { timeout: 3000, interval: 20 });
    expect(document.querySelector('[data-testid="page"]')).toBeNull();
  });

  it("开过又关上的弹窗也一样不拖住父级", async () => {
    const handles: { close?: () => void; swap?: () => void } = {};
    function Page() {
      const [open, setOpen] = useState(true);
      handles.close = () => setOpen(false);
      return (
        <div data-testid="page">
          <Modal open={open} title="资讯详情" onClose={() => setOpen(false)}>
            正文
          </Modal>
        </div>
      );
    }
    function Host() {
      const [screen, setScreen] = useState<"home" | "wizard">("home");
      handles.swap = () => setScreen("wizard");
      return <AnimatePresence mode="wait">{screen === "home" ? <Page key="home" /> : <p key="wizard">向导</p>}</AnimatePresence>;
    }
    mount(<Host />);
    expect(dialogs()).toHaveLength(1);
    act(() => handles.close?.());
    await vi.waitFor(() => expect(dialogs()).toHaveLength(0), { timeout: 3000, interval: 20 });
    act(() => handles.swap?.());
    await vi.waitFor(() => expect(document.body.textContent).toContain("向导"), { timeout: 3000, interval: 20 });
  });
});
