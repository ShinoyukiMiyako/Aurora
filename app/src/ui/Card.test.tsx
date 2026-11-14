// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { springAt } from "../lib/motion";
import { HOLD_AFTER_MUTATION, HOLD_AFTER_RESIZE, holdUntilPainted } from "../lib/reflow";
import { playTrack, springTrack } from "../lib/slide";
import type { Tier } from "../shell/tier";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { keydown, render, stubResizeObserver, stubSpanAnimations, type Rendered, type ResizeObserverStub } from "../test/dom";
import { Card, CardTitleButton, resolveResponsive, resolveRowSpan, resolveSpan, SPAN_MIN, type TierName } from "./Card";
import { CardHeader } from "./CardHeader";
import { IconButton } from "./IconButton";
import { Inset } from "./Inset";

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
  return view.container.firstElementChild as HTMLElement;
}

const keyup = (target: Element, key: string) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
  });

describe("按档取值", () => {
  it("档位名与外壳的尺寸档一致", () => {
    const tiers: TierName[] = ["compact", "regular", "wide"] satisfies Tier[];
    expect(tiers).toHaveLength(3);
  });

  it("缺的档向下继承", () => {
    expect(resolveResponsive(6)).toEqual({ compact: 6, regular: 6, wide: 6 });
    expect(resolveResponsive({ compact: 12 })).toEqual({ compact: 12, regular: 12, wide: 12 });
    expect(resolveResponsive({ compact: 8, wide: 6 })).toEqual({ compact: 8, regular: 8, wide: 6 });
    expect(resolveResponsive({ compact: 12, regular: 7 })).toEqual({ compact: 12, regular: 7, wide: 7 });
  });

  it("跨列下限：compact / regular 4 列，wide 3 列，上限 12", () => {
    expect(SPAN_MIN).toEqual({ compact: 4, regular: 4, wide: 3 });
    expect(resolveSpan({ compact: 4, wide: 3 })).toEqual({ compact: 4, regular: 4, wide: 3 });
    expect(() => resolveSpan(3)).toThrow(/compact 档跨 3 列/);
    expect(() => resolveSpan({ compact: 6, regular: 3 })).toThrow(/regular 档跨 3 列/);
    expect(() => resolveSpan({ compact: 6, wide: 2 })).toThrow(/wide 档跨 2 列/);
    expect(() => resolveSpan(13)).toThrow(/compact 档跨 13 列/);
    expect(() => resolveSpan(4.5)).toThrow(/整数/);
  });

  it("跨行必须是正整数", () => {
    expect(resolveRowSpan({ compact: 2, wide: 1 })).toEqual({ compact: 2, regular: 2, wide: 1 });
    expect(() => resolveRowSpan(0)).toThrow(/正整数/);
  });
});

describe("Card", () => {
  it("默认 md 内边距、不可点、无 role", () => {
    const card = mount(<Card>内容</Card>);
    expect(card.dataset.pad).toBe("md");
    expect(card.getAttribute("role")).toBeNull();
    expect(card.hasAttribute("tabindex")).toBe(false);
    expect(card.hasAttribute("data-span")).toBe(false);
  });

  it("跨列与跨行写成三档私有变量", () => {
    const card = mount(<Card span={{ compact: 8, wide: 6 }} rowSpan={2} />);
    expect(card.dataset.span).toBe("");
    expect(card.dataset.rows).toBe("");
    expect(card.style.getPropertyValue("--card-span-compact")).toBe("8");
    expect(card.style.getPropertyValue("--card-span-regular")).toBe("8");
    expect(card.style.getPropertyValue("--card-span-wide")).toBe("6");
    expect(card.style.getPropertyValue("--card-rows-wide")).toBe("2");
  });

  it("非法跨列在渲染时抛错", () => {
    expect(() => mount(<Card span={2} />)).toThrow(/compact 档跨 2 列/);
  });

  it("整卡可点：role=button、可聚焦，Enter 按下即触发", () => {
    const onClick = vi.fn();
    const card = mount(
      <Card onClick={onClick} ariaLabel="打开「生存 1.21」">
        生存 1.21
      </Card>,
    );
    expect(card.getAttribute("role")).toBe("button");
    expect(card.tabIndex).toBe(0);
    expect(card.getAttribute("aria-label")).toBe("打开「生存 1.21」");
    expect(card.dataset.interactive).toBe("true");
    const enter = keydown(card, "Enter");
    expect(enter.defaultPrevented).toBe(true);
    expect(onClick).toHaveBeenCalledTimes(1);
    act(() => card.click());
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("Space 按下只阻止滚动，抬起才触发；没有按下的抬起不触发", () => {
    const onClick = vi.fn();
    const card = mount(<Card onClick={onClick} ariaLabel="打开" />);
    keyup(card, " ");
    expect(onClick).not.toHaveBeenCalled();
    const down = keydown(card, " ");
    expect(down.defaultPrevented).toBe(true);
    expect(onClick).not.toHaveBeenCalled();
    keyup(card, " ");
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("可点卡片没有名称时抛错", () => {
    expect(() => mount(<Card onClick={() => undefined} />)).toThrow(/ariaLabel/);
    expect(() => mount(<Card onClick={() => undefined} ariaLabel="  " />)).toThrow(/ariaLabel/);
  });

  it("卡内有控件：标题按钮承担点击，卡片不加 role，内部控件独立触发", () => {
    const open = vi.fn();
    const more = vi.fn();
    const card = mount(
      <Card selected>
        <CardHeader title={<CardTitleButton onClick={open}>生存 1.21</CardTitleButton>} actions={<IconButton icon="more" label="更多操作" size="sm" onClick={more} />} />
      </Card>,
    );
    expect(card.getAttribute("role")).toBeNull();
    expect(card.dataset.selected).toBe("true");
    // 卡内点缀（封面底纹、身份方块）靠这个属性认出悬停宿主。
    expect(card.hasAttribute("data-sk-hover-host")).toBe(true);
    const buttons = card.querySelectorAll("button");
    expect(buttons).toHaveLength(2);
    act(() => buttons[1].click());
    expect(more).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    act(() => buttons[0].click());
    expect(open).toHaveBeenCalledTimes(1);
    expect(buttons[0].getAttribute("type")).toBe("button");
  });

  it("只有带标题按钮的卡片是悬停宿主；标题按钮卸载后不再是；脱离卡片使用直接报错", () => {
    function Host({ titled }: { titled: boolean }) {
      return <Card>{titled ? <CardTitleButton onClick={() => undefined}>生存 1.21</CardTitleButton> : <p>静态</p>}</Card>;
    }
    const card = mount(<Host titled />);
    expect(card.hasAttribute("data-sk-hover-host")).toBe(true);
    view?.rerender(
      <OverlayProvider>
        <Host titled={false} />
        <OverlayRoot />
      </OverlayProvider>,
    );
    expect(card.hasAttribute("data-sk-hover-host")).toBe(false);
    view?.unmount();
    // 整卡按钮已有 role="button"，不另加宿主标记。
    const whole = mount(<Card onClick={() => undefined} ariaLabel="打开「生存」">生存</Card>);
    expect(whole.hasAttribute("data-sk-hover-host")).toBe(false);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<CardTitleButton onClick={() => undefined}>孤立</CardTitleButton>)).toThrow("CardTitleButton 只能放在 Card 里");
  });

  it("整卡可点与带标题按钮的卡片都自成层叠上下文，卡内的 z-index 不漏到页面上", () => {
    const css = readFileSync(resolve(__dirname, "Card.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const isolated = [...css.matchAll(/(?:^|\n)([^{}\n][^{}]*)\{([^}]*)\}/g)]
      .filter(([, , body]) => /\sisolation:\s*isolate;/.test(body))
      .flatMap(([, selectors]) => selectors.split(",").map((s) => s.trim()));
    expect(isolated).toEqual(expect.arrayContaining([".card[data-interactive]", ".card:has(.titleButton)"]));

    // 选择器要真的落在整卡可点的卡片上：Card 给它的就是 data-interactive。
    const whole = mount(<Card onClick={() => undefined} ariaLabel="打开「生存」">生存</Card>);
    expect(whole.hasAttribute("data-interactive")).toBe(true);
  });

  it("裁切卡片：子项包进唯一的裁切容器，卡片自己不裁", () => {
    const card = mount(
      <Card clip padding="none">
        <p>封面</p>
        <p>正文</p>
      </Card>,
    );
    expect(card.dataset.clip).toBe("true");
    expect(card.children).toHaveLength(1);
    const clipper = card.firstElementChild as HTMLElement;
    expect([...clipper.children].map((el) => el.textContent)).toEqual(["封面", "正文"]);

    // 不裁的卡片没有这一层
    view?.unmount();
    const plain = mount(<Card>正文</Card>);
    expect(plain.firstElementChild).toBeNull();
    expect(plain.textContent).toBe("正文");
  });
});

describe("Card 样式", () => {
  const css = readFileSync(resolve(__dirname, "Card.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  /** 选择器（逐个）到声明的映射；同一选择器出现在多条规则里时声明按出现顺序合并。 */
  const rules = new Map<string, Record<string, string>>();
  for (const [, selectors, body] of css.matchAll(/(?:^|\n)([^{}\n][^{}]*)\{([^}]*)\}/g)) {
    const decls = Object.fromEntries([...body.matchAll(/([a-z-]+)\s*:\s*([^;]+);/g)].map(([, prop, value]) => [prop, value.replace(/\s+/g, " ").trim()]));
    for (const selector of selectors.split(",").map((s) => s.trim())) rules.set(selector, { ...rules.get(selector), ...decls });
  }
  const rule = (selector: string) => {
    const found = rules.get(selector);
    if (found === undefined) throw new Error(`Card.module.css 里没有 ${selector}`);
    return found;
  };

  it("裁切交给内层：卡片不裁，悬停阴影叠层画在边框外也看得见；内层盖住卡片边框盒，按卡片的内边距排版", () => {
    expect(rule(".card[data-clip]")).toEqual({ padding: "0" });
    expect(rule(".clip")).toMatchObject({ position: "relative", overflow: "hidden", margin: "-1px", border: "1px solid transparent", "border-radius": "inherit" });
    expect(rule(".card[data-pad=\"md\"] > .clip").padding).toBe(rule(".card[data-pad=\"md\"]").padding);
    expect(rule(".card[data-pad=\"sm\"] > .clip").padding).toBe("var(--sk-space-12)");
    expect(rule(".card[data-pad=\"lg\"] > .clip").padding).toBe("var(--sk-space-22) var(--sk-space-24)");
    expect(rule(".card:has(.titleButton)::after")).toMatchObject({ "box-shadow": "var(--sk-shadow)", opacity: "0" });
  });

  it("外框跟随：底色、描边与阴影改画在铺满边框盒的外框层上，与卡片自己的画法同一套令牌；外框垫在内容下面、以上沿为原点缩放", () => {
    expect(rule(".card[data-edge]")).toEqual({ isolation: "isolate", "border-color": "transparent", background: "transparent", "box-shadow": "none" });
    expect(rule(".frame")).toMatchObject({
      position: "absolute",
      inset: "-1px",
      "z-index": "-1",
      border: rule(".card").border,
      "border-radius": "inherit",
      background: rule(".card").background,
      "box-shadow": rule(".card")["box-shadow"],
      "transform-origin": "top",
      "pointer-events": "none",
    });
    expect(rule(".card").border).toBe("1px solid var(--sk-line)");
  });

  it("按下：从悬停上浮落回原位、缩到 0.99、阴影叠层减半，这一程走 Tap", () => {
    for (const selector of [".card[data-interactive]:active", ".card:has(.titleButton:active)"]) {
      expect(rule(selector)).toMatchObject({ translate: "none", scale: "0.99" });
      expect(rule(selector).transition).toContain("translate var(--sk-spring-tap-dur) var(--sk-spring-tap)");
    }
    expect(rule(".card[data-interactive]:active::after").opacity).toBe("0.5");
    expect(rule(".card:has(.titleButton:active)::after").opacity).toBe("0.5");
  });

  it("选中外圈在 ::before 叠层上随透明度淡入淡出，卡片自己的阴影不变", () => {
    expect(rule(".card[data-selected]")).toEqual({ "border-color": "var(--sk-accent-line)" });
    expect(rule(".card::before")).toMatchObject({
      "box-shadow": "0 0 0 var(--card-ring-width, 3px) var(--sk-accent-soft)",
      opacity: "0",
      transition: "opacity var(--sk-dur-hover) var(--sk-ease)",
    });
    expect(rule(".card[data-selected]::before").opacity).toBe("1");
    expect(rule(".card[data-selected][data-interactive]:focus-visible::before").opacity).toBe("0");
  });

  it("不可点的选中卡：描边色在卡片基础规则上过渡，与外圈同一时长同一曲线；可点卡片也带着它", () => {
    const ring = /opacity (var\(--sk-dur-hover\) var\(--sk-ease\))/.exec(rule(".card::before").transition)?.[1];
    expect(ring).toBe("var(--sk-dur-hover) var(--sk-ease)");
    expect(rule(".card").transition).toBe(`border-color ${ring}`);
    // 可点卡片的过渡另写了一整条，里面同样有描边色
    expect(rule(".card[data-interactive]").transition).toContain(`border-color ${ring}`);
    expect(rule(".card:has(.titleButton)").transition).toContain(`border-color ${ring}`);
  });

  it("外圈宽度由页面经 --card-ring-width 改：组件只读不写，页面的声明不论特异性与先后都生效", () => {
    expect(rule(".card::before")["box-shadow"]).toBe("0 0 0 var(--card-ring-width, 3px) var(--sk-accent-soft)");
    // 组件自己一旦声明这个变量，页面要靠更高的特异性或更晚的顺序才盖得过，聚光卡就会退回 3px
    expect(css).not.toMatch(/--card-ring-width\s*:/);
    // 选中态不另写一圈固定宽度的外圈
    for (const [selector, decls] of rules) {
      if (selector.includes("data-selected")) expect(decls["box-shadow"], selector).toBeUndefined();
    }
  });

  it("带标题按钮的卡片：键盘焦点环画在卡片自己身上，不画在会被裁切内层裁掉的覆盖层上；选中外圈让位", () => {
    expect(rule(".card:has(.titleButton:focus-visible)")["box-shadow"]).toBe("var(--sk-focus), var(--sk-shadow)");
    expect(rule(".card[data-interactive]:focus-visible")["box-shadow"]).toBe("var(--sk-focus), var(--sk-shadow)");
    expect(rules.get(".titleButton:focus-visible::after")).toBeUndefined();
    expect(rule(".card[data-selected]:has(.titleButton:focus-visible)::before").opacity).toBe("0");

    // 裁切卡片里标题按钮在内层裁切容器里：覆盖层画在边框外的东西都会被它裁掉
    const card = mount(
      <Card clip padding="none" selected>
        <CardTitleButton onClick={() => undefined}>生存 1.21</CardTitleButton>
      </Card>,
    );
    const button = card.querySelector("button") as HTMLButtonElement;
    expect(button.parentElement).not.toBe(card);
    expect(button.parentElement?.parentElement).toBe(card);
  });
});

describe("Card 外框跟随（reflowEdge）", () => {
  // jsdom 不做布局：外框的尺寸由这张表给出，尺寸观察由用例推送
  const sizes = new Map<Element, { width: number; height: number }>();
  let observer: ResizeObserverStub;
  /** 排着的动画帧回调：nextFrame() 一帧一帧地走。 */
  let frameQueue: FrameRequestCallback[] = [];
  /** 走过的帧数，与此刻正在跑的是第几个动画帧回调（不在回调里时为 0），从用例开始数。 */
  let frameNo = 0;
  let callbackNo = 0;
  let runningCallback = 0;
  const nextFrame = () => {
    const due = frameQueue;
    frameQueue = [];
    frameNo++;
    for (const callback of due) {
      runningCallback = ++callbackNo;
      callback(performance.now());
      runningCallback = 0;
    }
  };
  /** 记下 animation 每次 play 时是第几帧、第几个动画帧回调。 */
  const trackPlays = (animation: { play(): void }) => {
    const plays: { frame: number; callback: number }[] = [];
    const play = animation.play.bind(animation);
    animation.play = () => {
      plays.push({ frame: frameNo, callback: runningCallback });
      play();
    };
    return plays;
  };
  const size = (el: Element) => {
    const found = sizes.get(el);
    if (found === undefined) throw new Error("测试元素没有登记尺寸");
    return found;
  };

  beforeEach(() => {
    frameQueue = [];
    frameNo = 0;
    callbackNo = 0;
    observer = stubResizeObserver();
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return size(this).width;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return size(this).height;
    });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameQueue.push(callback);
      return frameQueue.length;
    });
  });

  afterEach(() => {
    // lib/reflow 的等待队列是模块级的、按窗口共用一个回调：排着的回调丢掉不跑，下一个用例挂进来的会一直等这个不会来的回调
    for (let i = 0; frameQueue.length > 0; i++) {
      if (i === 10) throw new Error("动画帧回调走了 10 帧仍在排：等待队列没有收尾");
      nextFrame();
    }
    sizes.clear();
    document.documentElement.removeAttribute("data-sk-reduced");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** 开了外框跟随的卡片与它的外框层；外框按 width x height 记下第一次尺寸（只记不动）。 */
  function edgeCard(width: number, height: number) {
    const card = mount(
      <Card reflowEdge>
        <p>启动</p>
      </Card>,
    );
    const frame = card.firstElementChild as HTMLElement;
    expect(frame.getAttribute("aria-hidden")).toBe("true");
    // jsdom 不套样式表：外框从卡片继承来的圆角（--sk-r-lg）按算好的样式交给它
    frame.style.borderTopLeftRadius = "18px";
    resize(frame, width, height);
    return { card, frame };
  }
  function resize(frame: HTMLElement, width: number, height: number) {
    sizes.set(frame, { width, height });
    observer.resize(frame, width);
  }
  /** 外框某一帧的纵向缩放。 */
  const scaleY = (keyframe: Keyframe) => Number(String(keyframe.scale).split(" ")[1]);
  /** 外框某一帧的圆角：[横向半径, 纵向半径]（像素）。 */
  const radii = (keyframe: Keyframe) => {
    const match = /^(\d+(?:\.\d+)?)px \/ (\d+(?:\.\d+)?)px$/.exec(String(keyframe.borderRadius));
    if (match === null) throw new Error(`圆角关键帧应当写成「横 / 纵」两个像素值，收到 ${String(keyframe.borderRadius)}`);
    return [Number(match[1]), Number(match[2])];
  };

  it("卡片变矮（291 -> 251）：外框以上沿为原点从旧高度沿 settle 弹簧缩回，与被挤开的行同一条轨迹；从静止起步先停在起点，下一帧才播", () => {
    const waapi = stubSpanAnimations();
    const { card, frame } = edgeCard(600, 291);
    expect(card.dataset.edge).toBe("true");
    expect(waapi.played).toHaveLength(0);

    resize(frame, 600, 251);
    const shrink = waapi.running(frame, "scale");
    expect(shrink.frames[0]).toEqual({ scale: "1 1.15936" });
    expect(shrink.frames.at(-1)).toEqual({ scale: "1 1" });
    // 第 k 帧（120 Hz 取样）下沿离新位置的距离就是让位里被挤开的行此刻的位移
    for (const k of [6, 12, 24]) expect(scaleY(shrink.frames[k])).toBeCloseTo((251 + springAt("settle", 40, 0, k / 120).x) / 251, 4);
    const row = springTrack("settle", 0, 0, 40, 0);
    expect(shrink.frames).toHaveLength(row.frames.length);
    expect(shrink.options.duration).toBe(row.duration);
    expect(shrink.options.easing).toBe("linear");
    expect(shrink.playState).toBe("paused");
    nextFrame();
    expect(shrink.playState).toBe("running");
  });

  it("卡片变高（251 -> 291）：外框从旧高度沿弹簧长到新高度", () => {
    const waapi = stubSpanAnimations();
    const { frame } = edgeCard(600, 251);
    resize(frame, 600, 291);
    const grow = waapi.running(frame, "scale");
    expect(grow.frames[0]).toEqual({ scale: "1 0.86254" });
    expect(grow.frames.at(-1)).toEqual({ scale: "1 1" });
  });

  it("缩放途中四角按缩放反向校正：每一帧的纵向半径是横向半径除以这一帧的纵向缩放，缩放之后四角仍是正圆；与缩放同一条时间轴、同起同停", () => {
    const waapi = stubSpanAnimations();
    const { frame } = edgeCard(600, 291);
    resize(frame, 600, 251);
    const shrink = waapi.running(frame, "scale");
    const corners = waapi.running(frame, "borderRadius");
    expect(corners.frames).toHaveLength(shrink.frames.length);
    expect([corners.options.duration, corners.options.easing]).toEqual([shrink.options.duration, "linear"]);
    // 起步那一帧外框还是旧高度（纵向放大 291/251 倍）：不校正的话下沿两角纵向被拉长近 3 px
    expect(corners.frames[0]).toEqual({ borderRadius: "18px / 15.526px" });
    expect(corners.frames.at(-1)).toEqual({ borderRadius: "18px / 18px" });
    for (const [i, keyframe] of shrink.frames.entries()) {
      const [rx, ry] = radii(corners.frames[i]);
      expect([rx, Math.abs(ry * scaleY(keyframe) - 18) < 0.001]).toEqual([18, true]);
    }
    expect(corners.playState).toBe("paused");
    nextFrame();
    expect(corners.playState).toBe("running");
  });

  it("卡片变高时同样校正：外框起步时纵向压扁，纵向半径按比例放大", () => {
    const waapi = stubSpanAnimations();
    const { frame } = edgeCard(600, 251);
    resize(frame, 600, 291);
    const corners = waapi.running(frame, "borderRadius");
    expect(corners.frames[0]).toEqual({ borderRadius: "18px / 20.869px" });
  });

  /** 卡内被挤开的一行（lib/reflow 让位起的位移，与外框同一条 settle 轨迹）：从静止起步时由让位挂进等待队列。 */
  const rowShift = () => playTrack(document.createElement("span"), springTrack("settle", 0, 0, 40, 0));

  it("卡内的行与外框在同一次尺寸观察里从静止起步：外框挂进让位的等待队列，下一帧与行在同一个动画帧回调里开播", () => {
    const waapi = stubSpanAnimations();
    const { frame } = edgeCard(600, 291);
    const row = rowShift();
    const rowPlays = trackPlays(row);
    holdUntilPainted(row, window, HOLD_AFTER_RESIZE);
    resize(frame, 600, 251);
    const edge = [waapi.running(frame, "scale"), waapi.running(frame, "borderRadius")];
    const edgePlays = edge.map(trackPlays);
    expect([row.playState, ...edge.map((a) => a.playState)]).toEqual(["paused", "paused", "paused"]);
    nextFrame();
    expect([row.playState, ...edge.map((a) => a.playState)]).toEqual(["running", "running", "running"]);
    expect(rowPlays).toEqual([{ frame: 1, callback: 1 }]);
    expect(edgePlays).toEqual([[{ frame: 1, callback: 1 }], [{ frame: 1, callback: 1 }]]);
  });

  it("卡内的行由增删让位（提交后的微任务里挂进队列、等两帧），外框的尺寸观察到下一帧的渲染步骤才报（等一帧）：两边在同一帧的同一个回调里开播", () => {
    const waapi = stubSpanAnimations();
    const { frame } = edgeCard(600, 291);
    const row = rowShift();
    const rowPlays = trackPlays(row);
    // 提交后的微任务：增删观察报到，被挤开的行停在起点
    holdUntilPainted(row, window, HOLD_AFTER_MUTATION);
    // 下一帧先跑动画帧回调，行还在等
    nextFrame();
    expect(row.playState).toBe("paused");
    // 同一帧的渲染步骤里布局已换上新排布，外框的尺寸观察这时才报：比行晚一帧挂进来，少等一帧，落在同一帧
    resize(frame, 600, 251);
    const edge = [waapi.running(frame, "scale"), waapi.running(frame, "borderRadius")];
    const edgePlays = edge.map(trackPlays);
    expect(edge.map((a) => a.playState)).toEqual(["paused", "paused"]);
    nextFrame();
    expect([row.playState, ...edge.map((a) => a.playState)]).toEqual(["running", "running", "running"]);
    expect(rowPlays).toEqual([{ frame: 2, callback: 2 }]);
    expect(edgePlays).toEqual([[{ frame: 2, callback: 2 }], [{ frame: 2, callback: 2 }]]);
  });

  it("途中又变：按弹簧算出此刻的下沿与速度，带着速度当场接着走，旧的那段取消", () => {
    const waapi = stubSpanAnimations();
    const { frame } = edgeCard(600, 291);
    resize(frame, 600, 251);
    const shrink = waapi.running(frame, "scale");
    const shrinkCorners = waapi.running(frame, "borderRadius");
    nextFrame();
    shrink.currentTime = 50;
    shrinkCorners.currentTime = 50;
    resize(frame, 600, 291);
    expect([shrink.cancelled, shrinkCorners.cancelled]).toEqual([true, true]);
    const back = waapi.running(frame, "scale");
    expect(radii(waapi.running(frame, "borderRadius").frames[0])[1]).toBeCloseTo(18 / scaleY(back.frames[0]), 3);
    const now = springAt("settle", 40, 0, 0.05);
    expect(scaleY(back.frames[0])).toBeCloseTo((291 + now.x - 40) / 291, 4);
    expect(scaleY(back.frames[6])).toBeCloseTo((291 + springAt("settle", now.x - 40, now.v, 6 / 120).x) / 291, 4);
    // 在动的接着走，不再停一帧
    expect(back.playState).toBe("running");
  });

  it("宽度变了（窗口缩放、换档）：一步到位，还在走的当场落定", () => {
    const waapi = stubSpanAnimations();
    const { frame } = edgeCard(600, 291);
    resize(frame, 600, 251);
    const shrink = waapi.running(frame, "scale");
    const corners = waapi.running(frame, "borderRadius");
    resize(frame, 520, 291);
    expect([shrink.cancelled, corners.cancelled]).toEqual([true, true]);
    expect(waapi.played).toHaveLength(2);
  });

  it("减少动画：一步到位", () => {
    const waapi = stubSpanAnimations();
    const { frame } = edgeCard(600, 291);
    document.documentElement.setAttribute("data-sk-reduced", "");
    resize(frame, 600, 251);
    expect(waapi.played).toHaveLength(0);
  });

  it("不开时没有外框层，也不盯尺寸", () => {
    const card = mount(<Card>正文</Card>);
    expect(card.firstElementChild).toBeNull();
    expect(card.hasAttribute("data-edge")).toBe(false);
    expect(observer.observed()).toEqual([]);
  });

  it("与整卡可点、选中、裁切同用直接报错：悬停、选中外圈与裁切仍按卡片自己的边框画，跟不上外框", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<Card reflowEdge onClick={() => undefined} ariaLabel="打开" />)).toThrow("reflowEdge");
    expect(() => render(<Card reflowEdge selected />)).toThrow("reflowEdge");
    expect(() => render(<Card reflowEdge clip />)).toThrow("reflowEdge");
  });
});

describe("CardHeader", () => {
  it("图标名放进底座（18px），默认 h3", () => {
    const header = mount(<CardHeader icon="terminal" title="启动日志" subtitle="实时 · 游戏中" />);
    expect(header.querySelector("h3")?.textContent).toBe("启动日志");
    expect(header.querySelector("svg")?.getAttribute("width")).toBe("18");
    expect(header.textContent).toBe("启动日志实时 · 游戏中");
  });

  it("可传任意节点作图标，标题层级可选 h2", () => {
    const header = mount(<CardHeader icon={<span data-testid="avatar" />} title="生存" level={2} />);
    expect(header.querySelector("h2")?.textContent).toBe("生存");
    expect(header.querySelector('[data-testid="avatar"]')).not.toBeNull();
    expect(header.querySelector("svg")).toBeNull();
  });

  const tree = (subtitle: string | null | undefined) => <CardHeader icon="world" title="存档" subtitle={subtitle} />;
  const rerender = (ui: ReactNode) =>
    view?.rerender(
      <OverlayProvider>
        {ui}
        <OverlayRoot />
      </OverlayProvider>,
    );
  const subtitleOf = (header: HTMLElement) => header.querySelector("h3")?.nextElementSibling as HTMLElement | null;

  it("副标题为 null：先占一行、不朗读；文案到了从透明淡入，之后换文案不再重播", () => {
    const header = mount(tree(null));
    const slot = subtitleOf(header);
    expect(slot?.hasAttribute("data-reserve")).toBe(true);
    expect(slot?.getAttribute("aria-hidden")).toBe("true");
    expect(slot?.textContent).toBe("");

    rerender(tree("3 个存档 · 1.2 GB"));
    const arrived = subtitleOf(header) as HTMLElement;
    expect(arrived.hasAttribute("data-reserve")).toBe(false);
    expect(arrived.textContent).toBe("3 个存档 · 1.2 GB");
    expect(arrived.style.opacity).toBe("0");

    rerender(tree("4 个存档 · 1.3 GB"));
    expect(subtitleOf(header)).toBe(arrived);
  });

  it("挂载时就有副标题：不单独淡入；undefined 没有这一行", () => {
    const header = mount(tree("实时 · 游戏中"));
    expect(subtitleOf(header)?.textContent).toBe("实时 · 游戏中");
    expect(subtitleOf(header)?.style.opacity).toBe("");
    rerender(tree(undefined));
    expect(subtitleOf(header)).toBeNull();
  });

  it("占位行的高度就是副标题的行高", () => {
    const css = readFileSync(resolve(__dirname, "CardHeader.module.css"), "utf8");
    expect(css).toMatch(/\.subtitle\s*\{[^}]*line-height:\s*var\(--sk-lh-caption\);/);
    expect(css).toMatch(/\.subtitle\[data-reserve\]\s*\{\s*height:\s*var\(--sk-lh-caption\);\s*\}/);
  });
});

describe("Inset", () => {
  it("按 as 渲染元素", () => {
    const inset = mount(<Inset as="aside">当日详情</Inset>);
    expect(inset.tagName).toBe("ASIDE");
    expect(inset.textContent).toBe("当日详情");
  });
});
