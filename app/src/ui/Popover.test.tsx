// @vitest-environment jsdom
// 浮层面板的形变与头尾结构：jsdom 不做布局，形变本身播不出来，这里断言的是它依赖的结构、定位时机与标记。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MotionConfig, visualElementStore } from "framer-motion";
import { act, useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { render, setRect, stubResizeObserver, waitForFrames, type Rendered } from "../test/dom";
import { Popover } from "./Popover";
import styles from "./Popover.module.css";

let view: Rendered | undefined;

beforeEach(() => {
  stubResizeObserver();
});

afterEach(() => {
  view?.unmount();
  view = undefined;
});

interface HostProps {
  layoutKey?: string;
  header?: boolean;
  footer?: boolean;
  className?: string;
}

/** 锚点按钮加一个开着的浮层；rerender 换 props 时面板不重新挂载。 */
function Host({ layoutKey, header = false, footer = false, className }: HostProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <button ref={setAnchor}>下载</button>
      <Popover
        open={anchor !== null}
        anchor={anchor}
        onClose={() => undefined}
        placement="bottom-end"
        aria-label="下载快览"
        className={className}
        layoutKey={layoutKey}
        header={header ? <p>标题行</p> : undefined}
        footer={footer ? <p>底栏</p> : undefined}
      >
        <p>主体</p>
      </Popover>
    </>
  );
}

function mount(props: HostProps) {
  const ui = (p: HostProps) => (
    <OverlayProvider>
      <Host {...p} />
      <OverlayRoot />
    </OverlayProvider>
  );
  view = render(ui(props));
  const rendered = view;
  return { rerender: (next: HostProps) => rendered.rerender(ui(next)), container: rendered.container };
}

const panel = () => document.querySelector<HTMLElement>('[role="dialog"]:not([data-exiting])') as HTMLElement;

/** 把面板放到 960 x 720 的浮层根里，锚点贴近底边：下方放不下，面板翻到上方，高度一变 top 就跟着变。 */
function placeNearBottom(container: HTMLElement, size: { width: number; height: number }) {
  setRect(container.querySelector("[data-sk-overlay-root]") as HTMLElement, { left: 0, top: 0, width: 960, height: 720 });
  setRect(container.querySelector("button") as HTMLButtonElement, { left: 860, top: 680, width: 40, height: 30 });
  Object.defineProperty(panel(), "offsetWidth", { configurable: true, value: size.width });
  Object.defineProperty(panel(), "offsetHeight", { configurable: true, value: size.height });
  act(() => {
    window.dispatchEvent(new Event("scroll"));
  });
}

describe("面板结构", () => {
  it("不传 layoutKey 与头尾：内容就是面板的直接子项，面板自己滚动，没有布局投影的独立根", () => {
    mount({});
    const p = panel();
    expect(p.hasAttribute("data-structured")).toBe(false);
    expect(p.hasAttribute("data-framer-portal-id")).toBe(false);
    expect([...p.children].map((c) => c.tagName)).toEqual(["P"]);
    expect(p.textContent).toBe("主体");
  });

  it("传了 layoutKey 与头尾：外框只裁切，头部、主体（内含随形变移动的内容层）、底部依次排开", () => {
    mount({ layoutKey: "a", header: true, footer: true });
    const p = panel();
    expect(p.hasAttribute("data-structured")).toBe(true);
    // 面板 portal 在浮层根里：自成布局投影树的根
    expect(p.getAttribute("data-framer-portal-id")).toBe("popover");
    const [head, body, foot] = [...p.children] as HTMLElement[];
    expect(p.children).toHaveLength(3);
    expect(head.className).toBe(styles.header);
    expect(head.textContent).toBe("标题行");
    expect(body.className).toBe(styles.body);
    expect(body.children).toHaveLength(1);
    expect((body.firstElementChild as HTMLElement).className).toBe(styles.content);
    expect(body.textContent).toBe("主体");
    expect(foot.className).toBe(styles.footer);
    expect(foot.textContent).toBe("底栏");
  });

  it("只传头尾不传 layoutKey：同样的结构，但不形变，也不另立布局投影的根", () => {
    mount({ header: true });
    const p = panel();
    expect(p.hasAttribute("data-structured")).toBe(true);
    expect(p.hasAttribute("data-framer-portal-id")).toBe(false);
    expect([...p.children].map((c) => c.className)).toEqual([styles.header, styles.body]);
  });
});

describe("形变与重新定位", () => {
  it("layoutKey 变的那次提交里就按新高度重新定位，不等尺寸观察者；layoutKey 不变时不在渲染里量", () => {
    const { rerender, container } = mount({ layoutKey: "a", header: true });
    placeNearBottom(container, { width: 320, height: 200 });
    expect(panel().dataset.side).toBe("top");
    expect(panel().style.top).toBe(`${680 - 8 - 200}px`);

    // 内容变高但结构键没变（进度文字这类）：这次重渲染不量，位置留给尺寸观察者
    Object.defineProperty(panel(), "offsetHeight", { configurable: true, value: 260 });
    rerender({ layoutKey: "a", header: true });
    expect(panel().style.top).toBe(`${680 - 8 - 200}px`);

    // 结构键变了：同一次提交里就挪到新高度对应的位置，形变量到的就是挪好之后的框
    rerender({ layoutKey: "b", header: true });
    expect(panel().style.top).toBe(`${680 - 8 - 260}px`);
  });

  it("形变的面板把缩放原点写成比例：落在面板底边、正对锚点中心", async () => {
    const { container } = mount({ layoutKey: "a" });
    placeNearBottom(container, { width: 320, height: 200 });
    // 右对齐锚点：900 − 320 = 580；锚点中心 880 − 580 = 300，300 / 320 = 0.9375；翻到上方，原点在底边
    expect(panel().style.left).toBe("580px");
    await waitForFrames(() => expect(panel().style.transformOrigin).toBe("93.75% 100% 0"));
  });

  it("形变的面板交给布局动画校正的圆角，取的是样式表里（含调用方 className）的圆角；量到之前不写行内圆角", async () => {
    const sheet = document.createElement("style");
    sheet.textContent = ".peek-round { border-top-left-radius: 7px; }";
    document.head.append(sheet);
    try {
      mount({ layoutKey: "a", className: "peek-round" });
      // 行内值会盖过 className：挂上那一刻没有行内圆角，量的才是 className 里的
      expect(panel().style.borderRadius).toBe("");
      await waitForFrames(() => expect(panel().style.borderRadius).toBe("7px"));
    } finally {
      sheet.remove();
    }
  });

  it("主体在形变途中带标记（样式表据此让它途中不滚动），形变收尾时去掉；跟的是投影节点的开始与结束", () => {
    mount({ layoutKey: "a" });
    const body = panel().querySelector<HTMLElement>(`.${styles.body}`) as HTMLElement;
    const projection = visualElementStore.get(body)?.projection;
    if (projection === undefined) throw new Error("主体没有布局投影节点");
    act(() => projection.notifyListeners("animationStart"));
    expect(body.hasAttribute("data-morphing")).toBe(true);
    // 窗口缩放、下一次测量提前收尾时只有 animationComplete，没有 onLayoutAnimationComplete
    act(() => projection.notifyListeners("animationComplete"));
    expect(body.hasAttribute("data-morphing")).toBe(false);
  });
});

// 根部 MotionConfig 在减少动画时只把位移与缩放改成一步到位：照用平常的进出，关上的那一帧面板先缩一截，再淡出
describe("减少动画", () => {
  const PLACED = /translate|scale/;

  /** 开着的浮层挂在指定的减少动画档位下；返回挂上那一刻与退场途中（已开始变淡）面板的 transform。 */
  async function panelTransforms(reducedMotion: "always" | "never"): Promise<{ mounted: string; leaving: string }> {
    const handles: { close?: () => void } = {};
    function Closable() {
      const [anchor, setAnchor] = useState<HTMLElement | null>(null);
      const [open, setOpen] = useState(true);
      handles.close = () => setOpen(false);
      return (
        <>
          <button ref={setAnchor}>筛选</button>
          <Popover open={open && anchor !== null} anchor={anchor} onClose={() => setOpen(false)} aria-label="筛选">
            <p>主体</p>
          </Popover>
        </>
      );
    }
    view = render(
      <OverlayProvider>
        <MotionConfig reducedMotion={reducedMotion}>
          <Closable />
        </MotionConfig>
        <OverlayRoot />
      </OverlayProvider>,
    );
    const p = panel();
    const mounted = p.style.transform;
    expect(p.style.opacity).toBe("0");
    await waitForFrames(() => expect(p.style.opacity).toBe("1"));
    act(() => handles.close?.());
    expect(p.hasAttribute("data-exiting")).toBe(true);
    await waitForFrames(() => expect(Number(p.style.opacity)).toBeLessThan(1));
    return { mounted, leaving: p.style.transform };
  }

  it("平常：面板从略小处长出，退场边淡出边缩小", async () => {
    const { mounted, leaving } = await panelTransforms("never");
    expect(mounted).toBe("scale(0.97)");
    expect(leaving).toMatch(/scale\(0\.9\d*\)/);
  });

  it("减少动画：进出只动透明度，挂上时与退场途中面板都没有位移或缩放", async () => {
    const { mounted, leaving } = await panelTransforms("always");
    expect(leaving).not.toMatch(PLACED);
    expect(mounted).not.toMatch(PLACED);
  });
});

describe("样式约定", () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "Popover.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  /** 选择器恰好是 selector 的那条规则的声明，属性名到值。 */
  function rule(selector: string): Map<string, string> {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
    if (m === null) throw new Error(`没有 ${selector} 规则`);
    const decls = new Map<string, string>();
    for (const decl of m[1].split(";")) {
      const at = decl.indexOf(":");
      if (at < 0) continue;
      decls.set(decl.slice(0, at).trim(), decl.slice(at + 1).trim().replace(/\s+/g, " "));
    }
    return decls;
  }

  it("带结构的外框只裁切不滚动：clip 不是滚动容器，缩放途中撑不出滚动条", () => {
    const structured = rule(".panel[data-structured]");
    expect(structured.get("overflow")).toBe("clip");
    expect(structured.get("flex-direction")).toBe("column");
  });

  it("主体是唯一的滚动区：常驻滚动条槽位，最大高度由调用方经变量给；形变途中改为 hidden，保留滚动位置与槽位", () => {
    const body = rule(".body");
    expect(body.get("overflow-y")).toBe("auto");
    expect(body.get("scrollbar-gutter")).toBe("stable");
    expect(body.get("max-height")).toBe("var(--popover-body-max-height, none)");
    expect(body.get("min-height")).toBe("0");
    expect(rule(".body[data-morphing]").get("overflow-y")).toBe("hidden");
  });

  it("头部、底部与内容层自己是定位祖先：退场项量位置与形变途中被摆放用的是同一个基准，不会被推出裁切区", () => {
    // 头部与底部共用一条规则
    expect(css).toMatch(/(^|\n)\.header,\s*\.footer\s*\{/);
    expect(rule(".footer").get("position")).toBe("relative");
    expect(rule(".content").get("position")).toBe("relative");
  });
});
