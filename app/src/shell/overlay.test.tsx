// @vitest-environment jsdom
import { act, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keydown, render, type Rendered } from "../test/dom";
import { FocusReturnPoint, type FocusReturnHandle } from "../ui/focus-return";
import {
  FLOATING_MARGIN,
  FOCUS_FALLBACK_ATTR,
  OverlayProvider,
  OverlayRoot,
  placeFloating,
  tabbableElements,
  useEscapeLayer,
  useEscapeListener,
  useFocusTrap,
  useOverlayControls,
  useOverlayRoot,
  useOverlayState,
  useScrimOpen,
  type OverlayKind,
  type OverlaySnapshot,
} from "./overlay";

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

const mount = (ui: ReactNode) => {
  view = render(
    <OverlayProvider>
      {ui}
      <OverlayRoot />
    </OverlayProvider>,
  );
  return view;
};

function Layer({ kind, onEscape, dismissible, active = true }: { kind: OverlayKind; onEscape: () => void; dismissible?: boolean; active?: boolean }) {
  useEscapeLayer(active, onEscape, { kind, dismissible });
  return null;
}

let snapshot: OverlaySnapshot;
let controls: ReturnType<typeof useOverlayControls>;
function StateProbe() {
  snapshot = useOverlayState();
  controls = useOverlayControls();
  return null;
}

describe("Esc 栈", () => {
  it("Esc 只关栈顶一层并阻止继续传播；栈空时放行", () => {
    const calls: string[] = [];
    const bubbled = vi.fn();
    window.addEventListener("keydown", bubbled);
    function Stack() {
      const [open, setOpen] = useState({ modal: true, popover: true });
      return (
        <>
          {open.modal && <Layer kind="modal" onEscape={() => (calls.push("modal"), setOpen((o) => ({ ...o, modal: false })))} />}
          {open.popover && <Layer kind="popover" onEscape={() => (calls.push("popover"), setOpen((o) => ({ ...o, popover: false })))} />}
          <StateProbe />
        </>
      );
    }
    mount(<Stack />);
    expect(snapshot).toEqual({ depth: 2, scrimOpen: true });

    const first = keydown(document.body, "Escape");
    expect(calls).toEqual(["popover"]);
    expect(first.defaultPrevented).toBe(true);
    expect(bubbled).not.toHaveBeenCalled();
    expect(snapshot).toEqual({ depth: 1, scrimOpen: true });

    keydown(document.body, "Escape");
    expect(calls).toEqual(["popover", "modal"]);
    expect(snapshot).toEqual({ depth: 0, scrimOpen: false });

    const third = keydown(document.body, "Escape");
    expect(third.defaultPrevented).toBe(false);
    expect(bubbled).toHaveBeenCalledTimes(1);
    window.removeEventListener("keydown", bubbled);
  });

  it("栈顶不可关闭时吞掉 Esc，下面的层也不关", () => {
    const below = vi.fn();
    const top = vi.fn();
    mount(
      <>
        <Layer kind="modal" onEscape={below} />
        <Layer kind="modal" onEscape={top} dismissible={false} />
      </>,
    );
    const event = keydown(document.body, "Escape");
    expect(event.defaultPrevented).toBe(true);
    expect(top).not.toHaveBeenCalled();
    expect(below).not.toHaveBeenCalled();
  });

  it("输入法组字中的 Esc 不关浮层", () => {
    const onEscape = vi.fn();
    mount(<Layer kind="palette" onEscape={onEscape} />);
    keydown(document.body, "Escape", { isComposing: true });
    expect(onEscape).not.toHaveBeenCalled();
    keydown(document.body, "Escape");
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("其他按键不处理", () => {
    const onEscape = vi.fn();
    mount(<Layer kind="modal" onEscape={onEscape} />);
    expect(keydown(document.body, "Enter").defaultPrevented).toBe(false);
    expect(onEscape).not.toHaveBeenCalled();
  });

  it("只有 popover 时没有遮罩；后打开者在栈顶", () => {
    const a = vi.fn();
    const b = vi.fn();
    mount(
      <>
        <Layer kind="popover" onEscape={a} />
        <Layer kind="popover" onEscape={b} />
        <StateProbe />
      </>,
    );
    expect(snapshot).toEqual({ depth: 2, scrimOpen: false });
    expect(controls.isOpen()).toBe(true);
    act(() => {
      expect(controls.closeTop()).toBe(true);
    });
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
  });

  it("useScrimOpen 只随遮罩的有无重渲染：不带遮罩的浮层开合只改深度，不牵动它", () => {
    let renders = 0;
    let scrim: boolean | undefined;
    function ScrimProbe() {
      renders += 1;
      scrim = useScrimOpen();
      return null;
    }
    let setKinds: (kinds: OverlayKind[]) => void = () => {
      throw new Error("层还没挂上");
    };
    // 探针由外面作为同一个元素传进来：这里换层时它不随父组件重渲染，记到的只有它自己的订阅
    function Layers({ probe }: { probe: ReactNode }) {
      const [kinds, set] = useState<OverlayKind[]>([]);
      setKinds = set;
      return (
        <>
          {kinds.map((kind, i) => (
            <Layer key={i} kind={kind} onEscape={() => undefined} />
          ))}
          {probe}
          <StateProbe />
        </>
      );
    }
    mount(<Layers probe={<ScrimProbe />} />);
    expect([renders, scrim]).toEqual([1, false]);

    const popovers = Array.from({ length: 1 + Math.floor(Math.random() * 4) }, (): OverlayKind => "popover");
    for (let n = 1; n <= popovers.length; n++) act(() => setKinds(popovers.slice(0, n)));
    expect(snapshot).toEqual({ depth: popovers.length, scrimOpen: false });
    expect([renders, scrim]).toEqual([1, false]);

    act(() => setKinds([...popovers, "modal"]));
    expect([renders, scrim]).toEqual([2, true]);
    // 弹窗里再开下拉：深度变了，遮罩还是那一层
    act(() => setKinds([...popovers, "modal", "popover"]));
    expect(snapshot).toEqual({ depth: popovers.length + 2, scrimOpen: true });
    expect([renders, scrim]).toEqual([2, true]);

    act(() => setKinds(popovers));
    expect([renders, scrim]).toEqual([3, false]);
    act(() => setKinds([]));
    expect(snapshot).toEqual({ depth: 0, scrimOpen: false });
    expect([renders, scrim]).toEqual([3, false]);
  });

  it("层的回调换新引用不重新入栈，active 变假出栈", () => {
    const rendered = mount(
      <>
        <Layer kind="modal" onEscape={() => undefined} />
        <StateProbe />
      </>,
    );
    expect(snapshot.depth).toBe(1);
    const latest = vi.fn();
    rendered.rerender(
      <OverlayProvider>
        <Layer kind="modal" onEscape={latest} />
        <StateProbe />
        <OverlayRoot />
      </OverlayProvider>,
    );
    expect(snapshot.depth).toBe(1);
    keydown(document.body, "Escape");
    expect(latest).toHaveBeenCalledTimes(1);
    rendered.rerender(
      <OverlayProvider>
        <Layer kind="modal" onEscape={latest} active={false} />
        <StateProbe />
        <OverlayRoot />
      </OverlayProvider>,
    );
    expect(snapshot.depth).toBe(0);
    expect(controls.closeTop()).toBe(false);
  });

  it("Esc 监听者每次都收到，不影响栈", () => {
    const listener = vi.fn();
    const onEscape = vi.fn();
    function Listener() {
      useEscapeListener(true, listener);
      return null;
    }
    mount(<Listener />);
    keydown(document.body, "Escape");
    expect(listener).toHaveBeenCalledTimes(1);
    view?.unmount();
    mount(
      <>
        <Listener />
        <Layer kind="popover" onEscape={onEscape} />
      </>,
    );
    keydown(document.body, "Escape");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("在 OverlayProvider 之外使用直接抛错", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<Layer kind="modal" onEscape={() => undefined} />)).toThrow("浮层组件必须放在 OverlayProvider 之内");
  });
});

describe("浮层根", () => {
  it("挂载后 useOverlayRoot 拿到带标记的根元素", () => {
    let root: HTMLElement | null = null;
    function Probe() {
      root = useOverlayRoot();
      return null;
    }
    const { container } = mount(<Probe />);
    const el = container.querySelector("[data-sk-overlay-root]");
    expect(el).not.toBeNull();
    expect(root).toBe(el);
    expect(container.lastElementChild).toBe(el);
  });
});

describe("焦点圈定与归还", () => {
  // 与真实浮层一样 portal 进浮层根：圈定只把浮层根之外的焦点拉回。归还记录点与 Modal 一样常驻在浮层之前，
  // 随 open 切换：关闭时圈定先撤掉，记录点再归还
  function Dialog({ onClose }: { onClose?: () => void }) {
    const root = useOverlayRoot();
    return root ? createPortal(<DialogBody onClose={onClose} />, root) : null;
  }

  function DialogBody({ onClose }: { onClose?: () => void }) {
    const ref = useRef<HTMLDivElement>(null);
    useFocusTrap(ref, true);
    return (
      <div ref={ref} tabIndex={-1} data-testid="dialog">
        <button>甲</button>
        <button disabled>禁用</button>
        <button tabIndex={-1}>跳过</button>
        <button>乙</button>
        <div inert>
          <button>惰性</button>
        </div>
        <button onClick={onClose}>丙</button>
      </div>
    );
  }

  const byText = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === text) as HTMLButtonElement;

  function Page() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>打开</button>
        <button>背后</button>
        <FocusReturnPoint active={open} />
        {open && <Dialog onClose={() => setOpen(false)} />}
      </>
    );
  }

  it("tabbableElements 排除禁用、tabindex=-1 与 inert 子树", () => {
    mount(<Dialog />);
    const dialog = document.querySelector<HTMLElement>('[data-testid="dialog"]') as HTMLElement;
    expect(tabbableElements(dialog).map((b) => b.textContent)).toEqual(["甲", "乙", "丙"]);
  });

  it("Tab 与 Shift+Tab 在首尾循环", () => {
    mount(<Dialog />);
    act(() => byText("丙").focus());
    const forward = keydown(byText("丙"), "Tab");
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(byText("甲"));
    const backward = keydown(byText("甲"), "Tab", { shiftKey: true });
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(byText("丙"));
    // 中间的 Tab 交给浏览器
    act(() => byText("甲").focus());
    expect(keydown(byText("甲"), "Tab").defaultPrevented).toBe(false);
  });

  it("焦点跑到背后的页面时拉回弹窗", () => {
    mount(<Page />);
    act(() => byText("打开").click());
    act(() => byText("背后").focus());
    expect(document.activeElement).toBe(byText("甲"));
  });

  it("关闭后焦点还给打开前的元素", () => {
    mount(<Page />);
    act(() => byText("打开").focus());
    act(() => byText("打开").click());
    act(() => byText("乙").focus());
    act(() => byText("丙").click());
    expect(document.querySelector('[data-testid="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(byText("打开"));
  });

  it("原焦点元素此刻被禁用时同样落到兜底容器，焦点不留在正在退场的浮层里", () => {
    function Host() {
      const [open, setOpen] = useState(false);
      const [locked, setLocked] = useState(false);
      return (
        <div tabIndex={-1} {...{ [FOCUS_FALLBACK_ATTR]: "" }} data-testid="fallback">
          <button
            disabled={locked}
            onClick={() => {
              setOpen(true);
              setLocked(true);
            }}
          >
            打开
          </button>
          <FocusReturnPoint active={open} />
          {open && <Dialog onClose={() => setOpen(false)} />}
        </div>
      );
    }
    mount(<Host />);
    act(() => byText("打开").focus());
    act(() => byText("打开").click());
    act(() => byText("丙").focus());
    act(() => byText("丙").click());
    expect(document.activeElement).toBe(document.querySelector('[data-testid="fallback"]'));
  });

  it("原焦点元素已不在文档中时落到兜底容器", () => {
    function Host() {
      const [open, setOpen] = useState(false);
      const [trigger, setTrigger] = useState(true);
      return (
        <div tabIndex={-1} {...{ [FOCUS_FALLBACK_ATTR]: "" }} data-testid="fallback">
          {trigger && (
            <button
              onClick={() => {
                setOpen(true);
                setTrigger(false);
              }}
            >
              打开
            </button>
          )}
          <FocusReturnPoint active={open} />
          {open && <Dialog onClose={() => setOpen(false)} />}
        </div>
      );
    }
    mount(<Host />);
    act(() => byText("打开").focus());
    act(() => byText("打开").click());
    act(() => byText("丙").click());
    expect(document.activeElement).toBe(document.querySelector('[data-testid="fallback"]'));
  });

  describe("原焦点元素被换掉时落到它所在的区域", () => {
    /** 触发按钮包在会随它一起消失的一层里：从被移除的子树往上走不回区域，只能靠打开时记下的祖先链。 */
    function Region({ stay = true }: { stay?: boolean }) {
      const [open, setOpen] = useState(false);
      const [replaced, setReplaced] = useState(false);
      return (
        <div tabIndex={-1} {...{ [FOCUS_FALLBACK_ATTR]: "" }} data-testid="fallback">
          <button>区域外</button>
          <div>
            <button>边界内</button>
            <section data-testid="region">
              {replaced ? <span>换成了说明</span> : <p><button onClick={() => setOpen(true)}>打开</button></p>}
              {stay && <button>同区域</button>}
            </section>
          </div>
          <FocusReturnPoint active={open} />
          {open && (
            <Dialog
              onClose={() => {
                setOpen(false);
                setReplaced(true);
              }}
            />
          )}
        </div>
      );
    }

    const close = () => {
      act(() => byText("打开").focus());
      act(() => byText("打开").click());
      act(() => byText("丙").click());
    };

    it("最近的还在文档里的祖先有控件：落到它的第一个可 Tab 控件", () => {
      mount(<Region />);
      close();
      expect(document.activeElement).toBe(byText("同区域"));
    });

    it("近处没有控件：往外一层找，不直接跳到兜底容器", () => {
      mount(<Region stay={false} />);
      close();
      expect(document.activeElement).toBe(byText("边界内"));
    });

    it("所在弹窗就是区域外沿：区域里没有控件时落到弹窗容器本身，不越过弹窗，也不落到弹窗头部的按钮上", () => {
      function InDialog() {
        const [replaced, setReplaced] = useState(false);
        const [open, setOpen] = useState(false);
        return (
          <>
            <button>背后</button>
            <div role="dialog" tabIndex={-1} aria-label="底层" data-testid="under">
              <button>头部关闭</button>
              <section>{replaced ? <span>换成了说明</span> : <p><button onClick={() => setOpen(true)}>打开</button></p>}</section>
            </div>
            <FocusReturnPoint active={open} />
            {open && (
              <Dialog
                onClose={() => {
                  setOpen(false);
                  setReplaced(true);
                }}
              />
            )}
          </>
        );
      }
      mount(<InDialog />);
      close();
      expect(document.activeElement).toBe(document.querySelector('[data-testid="under"]'));
    });

    it("整个区域都不在了：回到兜底容器", () => {
      function Gone() {
        const [open, setOpen] = useState(false);
        const [page, setPage] = useState(true);
        return (
          <div tabIndex={-1} {...{ [FOCUS_FALLBACK_ATTR]: "" }} data-testid="fallback">
            {page && (
              <section>
                <button onClick={() => setOpen(true)}>打开</button>
                <button>同区域</button>
              </section>
            )}
            <FocusReturnPoint active={open} />
            {open && (
              <Dialog
                onClose={() => {
                  setOpen(false);
                  setPage(false);
                }}
              />
            )}
          </div>
        );
      }
      mount(<Gone />);
      close();
      expect(document.activeElement).toBe(document.querySelector('[data-testid="fallback"]'));
    });

    it("浮层根里的触发元素不把搜索范围放大到整个浮层根：别的浮层里的控件不算它的区域", () => {
      function InLayer() {
        const [open, setOpen] = useState(false);
        const [shown, setShown] = useState(true);
        return (
          <div tabIndex={-1} {...{ [FOCUS_FALLBACK_ATTR]: "" }} data-testid="fallback">
            <FocusReturnPoint active={open} />
            {open && (
              <Dialog
                onClose={() => {
                  setOpen(false);
                  setShown(false);
                }}
              />
            )}
            <LayerContent shown={shown} onOpen={() => setOpen(true)} />
          </div>
        );
      }
      function LayerContent({ shown, onOpen }: { shown: boolean; onOpen: () => void }) {
        const root = useOverlayRoot();
        if (root === null) return null;
        return createPortal(
          <>
            <div data-testid="toast">{shown && <button onClick={onOpen}>打开</button>}</div>
            <div data-testid="other-layer">
              <button>别的浮层</button>
            </div>
          </>,
          root,
        );
      }
      mount(<InLayer />);
      close();
      expect(document.activeElement).toBe(document.querySelector('[data-testid="fallback"]'));
    });
  });

  it("skip() 后本次关闭不归还焦点", () => {
    const handle: { current: FocusReturnHandle | null } = { current: null };
    const skip = () => {
      if (handle.current === null) throw new Error("归还记录点还没挂载");
      handle.current.skip();
    };
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>原处</button>
          <button onClick={() => setOpen(false)}>别处</button>
          <FocusReturnPoint active={open} handle={handle} />
          {open && <input aria-label="pop" />}
        </>
      );
    }
    mount(<Host />);
    act(() => byText("原处").focus());
    act(() => byText("原处").click());
    act(() => byText("别处").focus());
    act(() => skip());
    act(() => byText("别处").click());
    expect(document.activeElement).toBe(byText("别处"));
  });
});

describe("placeFloating", () => {
  const bounds = { width: 1000, height: 700 };
  const size = { width: 120, height: 40 };

  it("放得下时按首选方位居中对齐", () => {
    expect(placeFloating({ left: 400, top: 300, width: 80, height: 30 }, size, "top", 8, bounds)).toEqual({ left: 380, top: 252, side: "top" });
    expect(placeFloating({ left: 400, top: 300, width: 80, height: 30 }, size, "bottom", 8, bounds)).toEqual({ left: 380, top: 338, side: "bottom" });
    expect(placeFloating({ left: 400, top: 300, width: 80, height: 30 }, size, "right", 12, bounds)).toEqual({ left: 492, top: 295, side: "right" });
  });

  it("首选方位放不下而对侧放得下时翻转", () => {
    expect(placeFloating({ left: 400, top: 10, width: 80, height: 30 }, size, "top", 8, bounds).side).toBe("bottom");
    expect(placeFloating({ left: 400, top: 650, width: 80, height: 30 }, size, "bottom", 8, bounds).side).toBe("top");
    expect(placeFloating({ left: 900, top: 300, width: 80, height: 30 }, size, "right", 12, bounds)).toEqual({ left: 768, top: 295, side: "left" });
  });

  it("两侧都放不下时保持首选方位，再夹进边距", () => {
    const tall = { width: 120, height: 400 };
    const placed = placeFloating({ left: 400, top: 300, width: 80, height: 30 }, tall, "top", 8, bounds);
    expect(placed.side).toBe("top");
    expect(placed.top).toBe(FLOATING_MARGIN);
  });

  it("靠边时夹在窗口内 8px", () => {
    expect(placeFloating({ left: 2, top: 300, width: 40, height: 30 }, size, "top", 8, bounds).left).toBe(8);
    expect(placeFloating({ left: 960, top: 300, width: 40, height: 30 }, size, "top", 8, bounds).left).toBe(1000 - 120 - 8);
  });

  it("start / end 对齐", () => {
    expect(placeFloating({ left: 400, top: 300, width: 80, height: 30 }, size, "bottom-start", 4, bounds)).toEqual({ left: 400, top: 334, side: "bottom" });
    expect(placeFloating({ left: 400, top: 300, width: 80, height: 30 }, size, "bottom-end", 4, bounds)).toEqual({ left: 360, top: 334, side: "bottom" });
    expect(placeFloating({ left: 400, top: 300, width: 80, height: 30 }, size, "left-start", 4, bounds)).toEqual({ left: 276, top: 300, side: "left" });
  });

  it("随机锚点：结果永远在边距之内", () => {
    for (let i = 0; i < 300; i++) {
      const anchor = { left: Math.random() * 1000, top: Math.random() * 700, width: 10 + Math.random() * 200, height: 10 + Math.random() * 60 };
      const placed = placeFloating(anchor, size, "top", 8, bounds);
      expect(placed.left).toBeGreaterThanOrEqual(FLOATING_MARGIN);
      expect(placed.left + size.width).toBeLessThanOrEqual(bounds.width - FLOATING_MARGIN);
      expect(placed.top).toBeGreaterThanOrEqual(FLOATING_MARGIN);
      expect(placed.top + size.height).toBeLessThanOrEqual(bounds.height - FLOATING_MARGIN);
    }
  });
});
