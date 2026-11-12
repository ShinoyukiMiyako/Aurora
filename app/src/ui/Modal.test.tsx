// @vitest-environment jsdom
import { AnimatePresence, MotionConfig, visualElementStore } from "framer-motion";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOADING_DELAY_MS } from "../domain/limits";
import { REFLOW_SKIP_ATTR } from "../lib/reflow";
import { FOCUS_FALLBACK_ATTR, OverlayProvider, OverlayRoot } from "../shell/overlay";
import { keydown, render, stubResizeObserver, waitForFrames, type Rendered } from "../test/dom";
import { Button } from "./Button";
import { ConfirmDialog } from "./ConfirmDialog";
import confirmStyles from "./ConfirmDialog.module.css";
import { Modal } from "./Modal";
import { SearchInput } from "./SearchInput";
import { TextInput } from "./TextInput";

/** 挂了让位的容器。jsdom 没有 Web Animations，让位本身播不出来，只能看挂在了哪一层。 */
const reflowed = vi.hoisted(() => new Set<HTMLElement>());
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

  it("第二层关闭时打开它的按钮一并被换掉：焦点落到底层弹窗里同一区域的控件上，不落到底层的关闭按钮，也不掉回 body", () => {
    function Replaced() {
      const [inner, setInner] = useState(false);
      const [done, setDone] = useState(false);
      return (
        <Modal open onClose={() => undefined} title="确认导入">
          <div>
            <TextInput value="" onChange={() => undefined} aria-label="实例名" />
            {done ? <p>正在重新读取</p> : <p><Button onClick={() => setInner(true)}>查看这些文件</Button></p>}
          </div>
          <Modal
            open={inner}
            onClose={() => setInner(false)}
            title="清单"
            footer={
              <Button
                onClick={() => {
                  setInner(false);
                  setDone(true);
                }}
              >
                继续导入
              </Button>
            }
          />
        </Modal>
      );
    }
    // 与外壳一样带着内容区滚动容器：它在底层弹窗的圈定之外，退回它的话焦点会被拉到底层头部的「关闭」
    mount(
      <div tabIndex={-1} {...{ [FOCUS_FALLBACK_ATTR]: "" }}>
        <Replaced />
      </div>,
    );
    const open = byText("查看这些文件");
    act(() => open.focus());
    click(open);
    expect(dialogs()).toHaveLength(2);
    click(byText("继续导入"));
    expect(open.isConnected).toBe(false);
    expect(document.activeElement).toBe(document.querySelector('input[aria-label="实例名"]'));
  });

  it("第二层关闭时底层整步换了内容：焦点落到底层弹窗容器本身，Tab 从弹窗内继续", () => {
    function StepChanged() {
      const [inner, setInner] = useState(false);
      const [done, setDone] = useState(false);
      return (
        <Modal open onClose={() => undefined} title="确认导入">
          {done ? <p key="done">已完成</p> : <div key="step"><Button onClick={() => setInner(true)}>查看这些文件</Button></div>}
          <Modal
            open={inner}
            onClose={() => setInner(false)}
            title="清单"
            footer={
              <Button
                onClick={() => {
                  setInner(false);
                  setDone(true);
                }}
              >
                继续导入
              </Button>
            }
          />
        </Modal>
      );
    }
    mount(<StepChanged />);
    const open = byText("查看这些文件");
    act(() => open.focus());
    click(open);
    click(byText("继续导入"));
    const under = dialogs().find((d) => d.getAttribute("aria-labelledby") !== null && d.textContent?.includes("确认导入"));
    expect(document.activeElement).toBe(under);
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

  /** 外壳的命令式确认：同一个确认框，新请求顶掉旧请求时换 requestKey。 */
  interface Request {
    id: number;
    title: string;
    confirmLabel: string;
    tone?: "primary" | "danger";
  }
  const SWITCH: Request = { id: 1, title: "切换下载源？", confirmLabel: "切换并重下" };
  const REMOVE: Request = { id: 2, title: "删除「生存」？", confirmLabel: "删除实例", tone: "danger" };
  const ENDGAME: Request = { id: 3, title: "结束游戏？", confirmLabel: "结束游戏", tone: "danger" };
  const confirmHandles: { set?: (request: Request) => void; close?: () => void } = {};
  function Commanded() {
    const [request, setRequest] = useState(SWITCH);
    const [open, setOpen] = useState(true);
    confirmHandles.set = (next) => {
      setRequest(next);
      setOpen(true);
    };
    confirmHandles.close = () => setOpen(false);
    return (
      <ConfirmDialog
        open={open}
        requestKey={request.id}
        title={request.title}
        body={`第 ${request.id} 个请求`}
        confirmLabel={request.confirmLabel}
        tone={request.tone}
        onConfirm={() => undefined}
        onClose={() => setOpen(false)}
      />
    );
  }
  const titleOf = () => document.querySelector<HTMLElement>('[data-sk-modal-layer]:not([data-exiting]) h2 > span');

  // 换 key 重挂的话遮罩断一帧；原地换内容的话初始聚焦只跑过一次，焦点还停在旧请求的确认键上，回车就删了
  it("开着时被危险确认顶替（换 requestKey）：框不重挂，焦点回到「取消」，新的标题与正文淡入", () => {
    mount(<Commanded />);
    const layer = document.querySelector("[data-sk-modal-layer]");
    expect(document.activeElement).toBe(byText("切换并重下"));
    expect(titleOf()?.style.opacity).toBe("1");

    act(() => confirmHandles.set?.(REMOVE));
    expect(document.querySelectorAll("[data-sk-modal-layer]")).toHaveLength(1);
    expect(document.querySelector("[data-sk-modal-layer]")).toBe(layer);
    expect(document.activeElement).toBe(byText("取消"));
    expect(byText("删除实例").dataset.variant).toBe("danger");
    // 淡入刚开始：内联透明度是 0 或刚起步的小数（不是空串，空串说明根本没有淡入）
    const FADING = /^0(\.\d+)?$/;
    expect(titleOf()?.textContent).toBe("删除「生存」？");
    expect(titleOf()?.style.opacity).toMatch(FADING);
    const body = document.querySelector<HTMLElement>("[role='dialog'] [data-padded] > div");
    expect(body?.textContent).toBe("第 2 个请求");
    expect(body?.style.opacity).toMatch(FADING);
  });

  // 「切换并重下」换成「删除实例」：确认键变窄，底栏右对齐，左边的「取消」一帧横移
  it("开着时被顶替：确认键的新文案淡入；「取消」所在的按钮行撑满底栏、挂着让位，确认键自己不参与让位", () => {
    mount(<Commanded />);
    const cancel = byText("取消");
    const row = cancel.closest("[data-tooltip-host]")?.parentElement as HTMLElement;
    expect(reflowed.has(row)).toBe(true);
    expect(row.contains(byText("切换并重下"))).toBe(true);
    expect(row.className).toBe(confirmStyles.actions);
    expect(cancel.hasAttribute(REFLOW_SKIP_ATTR)).toBe(false);
    expect(byText("切换并重下").hasAttribute(REFLOW_SKIP_ATTR)).toBe(true);
    const labelOf = (text: string) => [...byText(text).querySelectorAll<HTMLElement>("span")].find((s) => s.textContent === text && s.children.length === 0);
    // 打开时就在的文案跟着弹窗入场，自己不淡入
    expect(labelOf("切换并重下")?.style.opacity).toBe("1");

    act(() => confirmHandles.set?.(REMOVE));
    expect(labelOf("删除实例")?.style.opacity).toMatch(/^0(\.\d+)?$/);
    expect(byText("删除实例").hasAttribute(REFLOW_SKIP_ATTR)).toBe(true);
  });

  it("按钮行撑满底栏、靠右排：行宽不随确认键的文案变", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "ConfirmDialog.module.css"), "utf8").replace(/\r\n/g, "\n");
    const actions = /\n\.actions \{([^}]*)\}/.exec(css)?.[1];
    expect(actions).toContain("flex: 1 1 auto;");
    expect(actions).toContain("justify-content: flex-end;");
  });

  // 顶替后焦点只在同一个框里挪动（或停在同一个确认键上），读屏不重读对话框名称，用户不知道问题已经换了
  it("开着时被顶替：经弹窗里的状态区补读新的问题与后果；打开时就在的请求不补读", () => {
    mount(<Commanded />);
    const live = () => dialogs()[0].querySelector<HTMLElement>('[aria-live="polite"]');
    expect(live()?.textContent).toBe("");
    act(() => confirmHandles.set?.(REMOVE));
    expect(live()?.textContent).toBe("删除「生存」？ 第 2 个请求");
    act(() => confirmHandles.set?.(ENDGAME));
    expect(live()?.textContent).toBe("结束游戏？ 第 3 个请求");
    expect(live()?.className).toBe(confirmStyles.announce);
  });

  it("关上之后再来的请求：换一层新的框，标题随弹窗入场、不单独淡入", async () => {
    mount(<Commanded />);
    act(() => confirmHandles.set?.(REMOVE));
    act(() => confirmHandles.close?.());
    act(() => confirmHandles.set?.(ENDGAME));
    expect(titleOf()?.textContent).toBe("结束游戏？");
    expect(titleOf()?.style.opacity).toBe("1");
    // 旧框还在退场、排在前面：只认没在退场的那一层
    const cancel = [...document.querySelectorAll<HTMLElement>("[data-sk-modal-layer]:not([data-exiting]) button")].find((b) => b.textContent === "取消");
    expect(document.activeElement).toBe(cancel);
    await vi.waitFor(() => expect(dialogs()).toHaveLength(1), { timeout: 3000, interval: 20 });
  });

  it("确认键不能写「确定」这类不说明动作的泛称", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => mount(<ConfirmDialog open title="删除账户 Alex？" confirmLabel="确定" tone="danger" onConfirm={() => undefined} onClose={() => undefined} />)).toThrow(
      "确认键要写出动作",
    );
  });
});

describe("弹窗随内容改变尺寸", () => {
  // 设备码到达、换步、列表读到：弹窗在层里垂直居中，没有形变的话标题与底栏各瞬跳高度差的一半
  it("正文变高：面板从原来的高度形变过去，不是一帧跳到新高度", async () => {
    const handles: { grow?: () => void } = {};
    function Growing() {
      const [count, setCount] = useState(1);
      handles.grow = () => setCount(4);
      return (
        <Modal open onClose={() => undefined} title="正在登录">
          {Array.from({ length: count }, (_, i) => (
            <p key={i}>第 {i + 1} 步</p>
          ))}
        </Modal>
      );
    }
    mount(<Growing />);
    const dialog = dialogs()[0];
    // jsdom 不做布局：面板高度按正文段落数给（60 + 50 × 段数），在 720 高的层里垂直居中
    const heightOf = () => 60 + 50 * dialog.querySelectorAll("p").length;
    dialog.getBoundingClientRect = () => {
      const height = heightOf();
      const top = (720 - height) / 2;
      return { left: 200, top, width: 560, height, x: 200, y: top, right: 760, bottom: top + height, toJSON: () => ({}) } as DOMRect;
    };
    // 等入场播完，免得入场自己的缩放混进来
    await waitForFrames(() => expect(dialog.style.transform).toBe("none"));
    await act(async () => handles.grow?.());
    const scale = /scale\(([\d.]+), ([\d.]+)\)/.exec(dialog.style.transform);
    if (scale === null) throw new Error(`面板没有形变：${dialog.style.transform}`);
    // 起点就是原来的高度：110 / 260
    expect(Number(scale[1])).toBeCloseTo(1, 2);
    expect(Number(scale[2])).toBeGreaterThan(0.4);
    expect(Number(scale[2])).toBeLessThan(0.6);
    await waitForFrames(() => expect(dialog.style.transform).toBe("none"));
  });

  it("传了 layoutKey：只在它变的那次重渲染量布局、播形变", async () => {
    const handles: { set?: (count: number, step: string) => void } = {};
    function Stepped() {
      const [state, setState] = useState({ count: 1, step: "a" });
      handles.set = (count, step) => setState({ count, step });
      return (
        <Modal open onClose={() => undefined} title="导入整合包" layoutKey={state.step}>
          {Array.from({ length: state.count }, (_, i) => (
            <p key={i}>第 {i + 1} 行</p>
          ))}
        </Modal>
      );
    }
    mount(<Stepped />);
    const dialog = dialogs()[0];
    dialog.getBoundingClientRect = () => {
      const height = 60 + 50 * dialog.querySelectorAll("p").length;
      const top = (720 - height) / 2;
      return { left: 200, top, width: 560, height, x: 200, y: top, right: 760, bottom: top + height, toJSON: () => ({}) } as DOMRect;
    };
    await waitForFrames(() => expect(dialog.style.transform).toBe("none"));
    await act(async () => handles.set?.(2, "a"));
    expect(dialog.style.transform).toBe("none");
    await act(async () => handles.set?.(4, "b"));
    expect(dialog.style.transform).toMatch(/scale\(1, 0\.\d+\)/);
    await waitForFrames(() => expect(dialog.style.transform).toBe("none"));
  });

  // 变矮时被让位的兄弟从旧位置滑过来，越出主体的新底边：主体照常滚动的话途中冒出一下滚动条、挤窄内容
  it("形变途中主体带标记（样式表据此让它途中不滚动），形变播完去掉", async () => {
    const handles: { grow?: () => void } = {};
    function Growing() {
      const [count, setCount] = useState(1);
      handles.grow = () => setCount(4);
      return (
        <Modal open onClose={() => undefined} title="正在登录">
          {Array.from({ length: count }, (_, i) => (
            <p key={i}>第 {i + 1} 步</p>
          ))}
        </Modal>
      );
    }
    mount(<Growing />);
    const dialog = dialogs()[0];
    const body = dialog.querySelector<HTMLElement>("[data-padded]") as HTMLElement;
    dialog.getBoundingClientRect = () => {
      const height = 60 + 50 * dialog.querySelectorAll("p").length;
      const top = (720 - height) / 2;
      return { left: 200, top, width: 560, height, x: 200, y: top, right: 760, bottom: top + height, toJSON: () => ({}) } as DOMRect;
    };
    await waitForFrames(() => expect(dialog.style.transform).toBe("none"));
    expect(body.hasAttribute("data-morphing")).toBe(false);
    await act(async () => handles.grow?.());
    expect(dialog.style.transform).toMatch(/scale\(/);
    expect(body.hasAttribute("data-morphing")).toBe(true);
    await waitForFrames(() => expect(body.hasAttribute("data-morphing")).toBe(false));
    expect(dialog.style.transform).toBe("none");
  });

  // 资源详情这类满版主体默认不留槽位：正显示着滚动条时藏起它，内容横移 10px，比途中冒出滚动条更糟
  it("没留槽位的满版主体：正显示着滚动条时形变不打标记，没有滚动条时照打；跟的是面板投影节点的开始与结束", () => {
    mount(
      <Modal open onClose={() => undefined} ariaLabel="资源详情" padded={false}>
        <p data-testid="content" />
      </Modal>,
    );
    const dialog = dialogs()[0];
    const body = document.querySelector('[data-testid="content"]')?.parentElement as HTMLElement;
    expect(body.hasAttribute("data-gutter")).toBe(false);
    const projection = visualElementStore.get(dialog)?.projection;
    if (projection === undefined) throw new Error("面板没有布局投影节点");
    Object.defineProperty(body, "offsetWidth", { configurable: true, value: 560 });
    Object.defineProperty(body, "clientWidth", { configurable: true, value: 550 });
    act(() => projection.notifyListeners("animationStart"));
    expect(body.hasAttribute("data-morphing")).toBe(false);
    act(() => projection.notifyListeners("animationComplete"));

    Object.defineProperty(body, "clientWidth", { configurable: true, value: 560 });
    act(() => projection.notifyListeners("animationStart"));
    expect(body.hasAttribute("data-morphing")).toBe(true);
    // 窗口缩放、下一次测量提前收尾时只有投影节点的 animationComplete，没有 onLayoutAnimationComplete
    act(() => projection.notifyListeners("animationComplete"));
    expect(body.hasAttribute("data-morphing")).toBe(false);
  });

  it("留了槽位的主体：滚动条在不在都打标记（hidden 照留槽位，宽度不变）", () => {
    mount(
      <Modal open onClose={() => undefined} ariaLabel="资源详情" padded={false} stableGutter>
        <p data-testid="content" />
      </Modal>,
    );
    const dialog = dialogs()[0];
    const body = document.querySelector('[data-testid="content"]')?.parentElement as HTMLElement;
    const projection = visualElementStore.get(dialog)?.projection;
    if (projection === undefined) throw new Error("面板没有布局投影节点");
    Object.defineProperty(body, "offsetWidth", { configurable: true, value: 560 });
    Object.defineProperty(body, "clientWidth", { configurable: true, value: 550 });
    act(() => projection.notifyListeners("animationStart"));
    expect(body.hasAttribute("data-morphing")).toBe(true);
  });

  it("副标题读取中（null）：占一行同高的骨架，不关联到弹窗；读到后原位换字并关联", () => {
    const handles: { load?: () => void } = {};
    function Backups() {
      const [count, setCount] = useState<number | null>(null);
      handles.load = () => setCount(3);
      return (
        <Modal open onClose={() => undefined} title="存档备份" subtitle={count === null ? null : `${count} 份备份`}>
          正文
        </Modal>
      );
    }
    mount(<Backups />);
    const dialog = dialogs()[0];
    const pending = dialog.querySelector<HTMLElement>("[data-pending]");
    expect(pending?.tagName).toBe("P");
    expect(pending?.getAttribute("aria-hidden")).toBe("true");
    expect(pending?.textContent).toBe("");
    expect(dialog.hasAttribute("aria-describedby")).toBe(false);

    act(() => handles.load?.());
    expect(dialog.querySelector("[data-pending]")).toBeNull();
    const described = document.getElementById(dialog.getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toBe("3 份备份");
  });

  // 备份列表不到 300 ms 就读完：正文的加载占位整段不可见，副标题却先闪一下骨架条
  it("副标题读取中：等待期骨架占着行高但不可见，超过加载延迟才淡入", async () => {
    // 只假加载门用的计时与时钟；帧走 jsdom 的 setInterval，照常按真实时间来
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      mount(
        <Modal open onClose={() => undefined} title="存档备份" subtitle={null}>
          正文
        </Modal>,
      );
      const pending = () => dialogs()[0].querySelector<HTMLElement>("[data-pending]");
      expect(pending()?.style.opacity).toBe("0");
      await act(async () => {
        for (let i = 0; i < 6; i++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      });
      expect(pending()?.style.opacity).toBe("0");
      act(() => vi.advanceTimersByTime(LOADING_DELAY_MS));
      await vi.waitFor(() => expect(pending()?.style.opacity).toBe("1"), { timeout: 3000, interval: 20 });
    } finally {
      view?.unmount();
      view = undefined;
      vi.useRealTimers();
    }
  });

  // 形变是 transform 缩放：圆角若还是 var() 字符串，framer-motion 没法按缩放反向校正，四角被拉成椭圆
  it("圆角从算好的样式读成像素交给面板", async () => {
    const original = globalThis.getComputedStyle;
    vi.spyOn(globalThis, "getComputedStyle").mockImplementation((el, pseudo) => {
      const style = original(el, pseudo);
      if (el.getAttribute("role") !== "dialog") return style;
      return new Proxy(style, {
        get: (target, key) => {
          if (key === "borderTopLeftRadius") return "22px";
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    mount(
      <Modal open onClose={() => undefined} title="详情">
        正文
      </Modal>,
    );
    const dialog = dialogs()[0];
    await waitForFrames(() => expect(dialog.style.borderRadius).toBe("22px"));
  });

  it("见过骨架后到达的副标题淡入；一打开就有的副标题随弹窗入场，自己不再淡入", () => {
    const handles: { load?: () => void } = {};
    function Backups() {
      const [count, setCount] = useState<number | null>(null);
      handles.load = () => setCount(3);
      return (
        <Modal open onClose={() => undefined} title="存档备份" subtitle={count === null ? null : `${count} 份备份`}>
          正文
        </Modal>
      );
    }
    mount(
      <>
        <Backups />
        <Modal open onClose={() => undefined} title="关于" subtitle="版本 1.0.0">
          正文
        </Modal>
      </>,
    );
    const subtitleOf = (title: string) => {
      const dialog = dialogs().find((d) => d.textContent?.includes(title));
      return document.getElementById(dialog?.getAttribute("aria-describedby") ?? "");
    };
    expect(subtitleOf("关于")?.style.opacity).toBe("1");
    act(() => handles.load?.());
    const arrived = subtitleOf("存档备份");
    expect(arrived?.textContent).toBe("3 份备份");
    expect(Number(arrived?.style.opacity)).toBeLessThan(1);
  });

  // 主体里的布局动画（列表增删、指示块）按滚动后的位置量：主体不是 layoutScroll 节点时，
  // 内容变矮、滚动位置被夹回的那一下，主体里的元素从错开一个滚动量的起点滑过来。jsdom 不做布局，只能看投影节点的配置
  it("主体是按滚动量校正的投影节点；面板与头部不是", () => {
    mount(
      <Modal open onClose={() => undefined} title="更新预览" footer={<Button>更新</Button>}>
        <p data-testid="content" />
      </Modal>,
    );
    const dialog = dialogs()[0];
    const body = document.querySelector('[data-testid="content"]')?.parentElement;
    const head = dialog.firstElementChild;
    expect(head?.querySelector("h2")?.textContent).toBe("更新预览");
    const optionsOf = (el: Element | null | undefined) => {
      const projection = visualElementStore.get(el)?.projection;
      if (projection === undefined) throw new Error("不是布局投影节点");
      return projection.options;
    };
    expect(optionsOf(body).layoutScroll).toBe(true);
    expect(optionsOf(dialog).layoutScroll).not.toBe(true);
    expect(optionsOf(head).layoutScroll).not.toBe(true);
  });

  it("副标题不传：不占位", () => {
    mount(
      <Modal open onClose={() => undefined} title="详情">
        正文
      </Modal>,
    );
    expect(dialogs()[0].querySelector("p")).toBeNull();
  });
});

describe("弹窗样式", () => {
  // 检出时可能是 CRLF：统一成 LF、去掉注释再按规则匹配
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "Modal.module.css"), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const ruleOf = (selector: string) => {
    const rule = new RegExp(`(?:^|\\n\\s*\\n)${selector.replace(/[.[\]]/g, (c) => `\\${c}`)} \\{([^}]*)\\}`).exec(css);
    if (rule === null) throw new Error(`没有 ${selector} 规则`);
    return rule[1];
  };

  it("滚动条槽位只给打了槽位标记的主体；带内边距时右内边距扣掉槽位宽，留白与左边一致", () => {
    expect(ruleOf(".body")).not.toContain("scrollbar-gutter");
    expect(ruleOf(".body[data-gutter]")).toContain("scrollbar-gutter: stable;");
    expect(ruleOf(".body[data-padded]")).toContain(
      "padding: var(--sk-space-14) calc(var(--sk-space-24) - var(--sk-scrollbar-size)) var(--sk-space-20) var(--sk-space-24);",
    );
  });

  // 资讯弹窗的头图贴着满版主体的右边：常驻槽位会在它右侧留出一条一直看得见的空槽
  it("带内边距的主体总有槽位标记；满版主体默认没有，传 stableGutter 才有", () => {
    mount(
      <>
        <Modal open onClose={() => undefined} title="重命名">
          <p data-testid="padded" />
        </Modal>
        <Modal open onClose={() => undefined} ariaLabel="资讯" padded={false}>
          <p data-testid="bleed" />
        </Modal>
        <Modal open onClose={() => undefined} ariaLabel="资源详情" padded={false} stableGutter>
          <p data-testid="detail" />
        </Modal>
      </>,
    );
    const bodyOf = (id: string) => document.querySelector(`[data-testid="${id}"]`)?.parentElement;
    expect(bodyOf("padded")?.hasAttribute("data-gutter")).toBe(true);
    expect(bodyOf("bleed")?.hasAttribute("data-gutter")).toBe(false);
    expect(bodyOf("bleed")?.hasAttribute("data-padded")).toBe(false);
    expect(bodyOf("detail")?.hasAttribute("data-gutter")).toBe(true);
    expect(bodyOf("detail")?.hasAttribute("data-padded")).toBe(false);
  });

  it("形变途中的主体改为 hidden：不冒滚动条，滚动位置与槽位照留", () => {
    expect(ruleOf(".body[data-morphing]")).toContain("overflow-y: hidden;");
  });

  it("读取中的副标题正好占一行字的高度", () => {
    expect(ruleOf(".subtitle")).toContain("line-height: var(--sk-lh-small);");
    expect(ruleOf(".subtitle[data-pending]")).toContain("height: var(--sk-lh-small);");
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

  it("父级开始退场即撤下 Esc 层：退场期间按 Esc 不再关这个弹窗，也不挡住下面那一层", async () => {
    const closes: string[] = [];
    const handles: { hide?: () => void } = {};
    function Host() {
      const [shown, setShown] = useState(true);
      handles.hide = () => setShown(false);
      return (
        <>
          <Modal open title="底下的弹窗" onClose={() => closes.push("底下")}>
            正文
          </Modal>
          <AnimatePresence>
            {shown && (
              <Modal key="flow" open title="新建实例" onClose={() => closes.push("流程")}>
                正文
              </Modal>
            )}
          </AnimatePresence>
        </>
      );
    }
    mount(<Host />);
    expect(dialogs()).toHaveLength(2);
    act(() => handles.hide?.());
    keydown(document.body, "Escape");
    expect(closes).toEqual(["底下"]);
    await vi.waitFor(() => expect(dialogs()).toHaveLength(1), { timeout: 3000, interval: 20 });
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

// 根部 MotionConfig 在减少动画时只把位移与缩放改成一步到位：照用平常的进出，关上的那一帧面板先下沉缩小一截，再淡出
describe("Modal 减少动画", () => {
  const PLACED = /translate|scale/;

  /** 开着的弹窗挂在指定的减少动画档位下；返回挂上那一刻与退场途中（已开始变淡）面板的 transform。 */
  async function panelTransforms(reducedMotion: "always" | "never"): Promise<{ mounted: string; leaving: string }> {
    const handles: { close?: () => void } = {};
    function Closable() {
      const [open, setOpen] = useState(true);
      handles.close = () => setOpen(false);
      return (
        <Modal open={open} onClose={() => setOpen(false)} title="详情">
          正文
        </Modal>
      );
    }
    mount(
      <MotionConfig reducedMotion={reducedMotion}>
        <Closable />
      </MotionConfig>,
    );
    const dialog = dialogs()[0];
    const mounted = dialog.style.transform;
    expect(dialog.style.opacity).toBe("0");
    await waitForFrames(() => expect(dialog.style.opacity).toBe("1"));
    act(() => handles.close?.());
    expect(dialog.closest("[data-sk-modal-layer]")?.hasAttribute("data-exiting")).toBe(true);
    await waitForFrames(() => expect(Number(dialog.style.opacity)).toBeLessThan(1));
    return { mounted, leaving: dialog.style.transform };
  }

  it("平常：面板从下方略小处浮起入场，退场边淡出边下沉缩小", async () => {
    const { mounted, leaving } = await panelTransforms("never");
    expect(mounted).toBe("translateY(12px) scale(0.97)");
    expect(leaving).toMatch(/scale\(0\.9\d*\)/);
  });

  it("减少动画：进出只动透明度，挂上时与退场途中面板都没有位移或缩放", async () => {
    const { mounted, leaving } = await panelTransforms("always");
    expect(leaving).not.toMatch(PLACED);
    expect(mounted).not.toMatch(PLACED);
  });
});
