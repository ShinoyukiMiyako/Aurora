// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createRef, type MouseEvent, type ReactNode } from "react";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { IconName } from "../art/Icon";
import { fade, tweenAt } from "../lib/motion";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { focusByKeyboard, render, stubSpanAnimations, type FakeAnimation, type Rendered } from "../test/dom";
import { emulateFocusFixup } from "../test/focus-fixup";
import { Button, CONTROL_ICON_SIZE, softDisabledProps } from "./Button";
import styles from "./Button.module.css";
import { IconButton } from "./IconButton";

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

const withOverlay = (ui: ReactNode) => (
  <OverlayProvider>
    {ui}
    <OverlayRoot />
  </OverlayProvider>
);

function mount(ui: ReactNode) {
  view = render(withOverlay(ui));
  const button = view.container.querySelector("button");
  if (!button) throw new Error("没有渲染出 button");
  return button;
}

const click = (el: Element) =>
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });

/**
 * 按浏览器对原生按钮的键盘激活补上 click：Enter 在 keydown、空格在 keyup 之后派发，按键被 preventDefault 则不派发。
 * jsdom 不做这一步，不补的话「Enter / 空格不触发」的断言恒真。
 */
const press = (el: HTMLElement, key: "Enter" | " ") =>
  act(() => {
    const down = el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    if (key === "Enter") {
      if (down) el.click();
      return;
    }
    const up = el.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
    if (down && up) el.click();
  });

/** 指针点击、Enter、空格各激活一次。 */
const activateAllWays = (el: HTMLElement) => {
  click(el);
  press(el, "Enter");
  press(el, " ");
};

/**
 * 派发 CSS 动画结束事件。jsdom 没有 AnimationEvent，React 改按带前缀的事件名监听 onAnimationEnd
 * （react-dom 的 getVendorPrefixedEventName），两个名字都派发。
 */
const animationEnd = (el: Element) =>
  act(() => {
    for (const type of ["animationend", "webkitAnimationEnd"]) el.dispatchEvent(new Event(type, { bubbles: true }));
  });

/** 图标位里的各层：[身份, 入场方式；退场层为 leaving，不在入场中的为 still]。 */
const glyphsOf = (root: Element) =>
  [...root.querySelectorAll<HTMLElement>("[data-glyph]")].map((g) => [g.dataset.glyph, g.hasAttribute("data-leaving") ? "leaving" : (g.dataset.enter ?? "still")]);

const leavingOf = (root: Element) => {
  const leaving = root.querySelector("[data-leaving]");
  if (leaving === null) throw new Error("没有退场层");
  return leaving;
};

const layerOf = (root: Element, glyph: string) => {
  const layer = root.querySelector<HTMLElement>(`[data-glyph="${glyph}"]`);
  if (layer === null) throw new Error(`没有「${glyph}」这一层`);
  return layer;
};

const scalesOf = (animation: FakeAnimation) => animation.frames.map((f) => Number(f.scale));

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKENS = readFileSync(join(HERE, "../styles/tokens.css"), "utf8");

function token(name: string): string {
  const found = TOKENS.match(new RegExp(`(?:^|\\s)${name}:\\s*([^;]+);`));
  if (found === null) throw new Error(`tokens.css 缺少 ${name}`);
  return found[1].trim();
}

/** 透明度补间与原来的 CSS 写法同一对时长与曲线：淡入 --sk-dur-in / --sk-ease-out，淡出 --sk-dur-out / --sk-ease-in。 */
function expectFade(animation: FakeAnimation, way: "in" | "out") {
  const [dur, ease] = way === "in" ? ["--sk-dur-in", "--sk-ease-out"] : ["--sk-dur-out", "--sk-ease-in"];
  expect(`${animation.options.duration}ms`).toBe(token(dur));
  expect(animation.options.easing).toBe(token(ease));
}

// jsdom 环境里的 URL 是 jsdom 自己的实现，node:fs 不认，按文件路径读
const css = readFileSync(join(HERE, "./Button.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const iconCss = readFileSync(join(HERE, "./IconButton.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** 选择器恰好为 selector 的那条规则（或关键帧）的声明体，到第一个右花括号为止。 */
function ruleOf(selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  if (at < 0) throw new Error(`样式里缺少 ${selector}`);
  return css.slice(at + selector.length + 3, css.indexOf("}", at));
}

describe("Button", () => {
  it("默认次按钮、md、type=button，点击触发 onClick", () => {
    const onClick = vi.fn();
    const button = mount(<Button onClick={onClick}>保存</Button>);
    expect(button.getAttribute("type")).toBe("button");
    expect(button.dataset.variant).toBe("secondary");
    expect(button.dataset.size).toBe("md");
    expect(button.textContent).toBe("保存");
    click(button);
    click(button);
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it.each(["sm", "md", "lg"] as const)("%s 档图标尺寸跟控件高度阶梯", (size) => {
    const button = mount(
      <Button size={size} icon="play" iconRight="chevron-down">
        启动
      </Button>,
    );
    const icons = button.querySelectorAll("svg");
    expect(icons).toHaveLength(2);
    for (const svg of icons) expect(svg.getAttribute("width")).toBe(String(CONTROL_ICON_SIZE[size]));
    expect(button.dataset.hasIcon).toBe("true");
  });

  it("iconRightFlipped：按钮带翻转标记，转的是后置图标那一个节点（不重挂），前置图标不受影响；没有后置图标时不带标记", () => {
    const ui = (flipped: boolean) =>
      withOverlay(
        <Button variant="ghost" icon="download" iconRight="chevron-down" iconRightFlipped={flipped}>
          查看处理办法
        </Button>,
      );
    view = render(ui(false));
    const button = view.container.querySelector("button") as HTMLButtonElement;
    const trailing = button.querySelector(":scope > svg");
    expect(trailing?.classList.contains(styles.iconRight)).toBe(true);
    expect([...button.querySelectorAll(`.${styles.iconRight}`)]).toEqual([trailing]);
    expect(button.hasAttribute("data-icon-right-flipped")).toBe(false);

    view.rerender(ui(true));
    expect(button.getAttribute("data-icon-right-flipped")).toBe("true");
    expect(button.querySelector(":scope > svg")).toBe(trailing);
    view.rerender(ui(false));
    expect(button.hasAttribute("data-icon-right-flipped")).toBe(false);

    view.unmount();
    const plain = mount(
      <Button icon="download" iconRightFlipped>
        下载
      </Button>,
    );
    expect(plain.hasAttribute("data-icon-right-flipped")).toBe(false);
  });

  it("加载中：图标位换成装饰性加载指示，保持可聚焦但点击无效", () => {
    const onClick = vi.fn();
    const button = mount(
      <Button variant="primary" icon="download" loading onClick={onClick}>
        下载
      </Button>,
    );
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.dataset.loading).toBe("true");
    const spinner = button.querySelector("[data-tone]");
    expect(spinner?.getAttribute("data-tone")).toBe("on-accent");
    expect(spinner?.getAttribute("role")).toBeNull();
    expect(spinner?.getAttribute("aria-hidden")).toBe("true");
    // 前置图标被替换：只剩加载指示里的徽记
    expect(button.querySelectorAll("svg")).toHaveLength(1);
    expect(button.textContent).toBe("下载");
    click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("没有图标时加载指示居中叠在文字上，文字保留占位", () => {
    const button = mount(
      <Button variant="danger" loading>
        删除
      </Button>,
    );
    expect(button.textContent).toBe("删除");
    expect(button.querySelector("[data-tone]")?.getAttribute("data-tone")).toBe("current");
    expect(button.dataset.hasIcon).toBeUndefined();
  });

  it("有前置图标：进入加载时图标原地淡出、加载指示在同一格收拢入场；淡出播完才移除，入场播完摘掉标记；结束加载时反过来", () => {
    const waapi = stubSpanAnimations();
    const ui = (loading: boolean) =>
      withOverlay(
        <Button variant="primary" icon="download" loading={loading}>
          下载
        </Button>,
      );
    view = render(ui(false));
    const button = view.container.querySelector("button") as HTMLButtonElement;
    expect(glyphsOf(button)).toEqual([["download", "still"]]);
    // 挂载时就在的图标不播入场
    expect(waapi.played).toHaveLength(0);

    view.rerender(ui(true));
    expect(glyphsOf(button)).toEqual([
      ["download", "leaving"],
      ["spinner", "tap"],
    ]);
    // 两层叠在同一个图标位里，按钮里没有多出一格
    expect(new Set([...button.querySelectorAll("[data-glyph]")].map((g) => g.parentElement)).size).toBe(1);
    const download = layerOf(button, "download");
    const spinner = layerOf(button, "spinner");
    const out = waapi.running(download, "opacity");
    expect(out.frames).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    expectFade(out, "out");
    // 加载指示从 0.8 沿 tap 弹簧收拢到 1，临界阻尼不过冲；透明度从 0 淡入
    const tap = waapi.running(spinner, "scale");
    expect(scalesOf(tap)[0]).toBe(0.8);
    expect(scalesOf(tap).at(-1)).toBe(1);
    expect(Math.max(...scalesOf(tap))).toBe(1);
    expect(tap.options.easing).toBe("linear");
    const fadeIn = waapi.running(spinner, "opacity");
    expect(fadeIn.frames).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expectFade(fadeIn, "in");

    // 退场层的去留只看脚本动画：CSS 动画结束事件（子树显隐时会乱来）不再驱动它
    animationEnd(download);
    expect(glyphsOf(button)).toHaveLength(2);
    waapi.finish(out);
    expect(glyphsOf(button)).toEqual([["spinner", "tap"]]);
    // 入场的两段都播完才摘掉 data-enter：标记不留在元素上，子树重新显示时没有可重播的东西
    waapi.finish(fadeIn);
    expect(glyphsOf(button)).toEqual([["spinner", "tap"]]);
    waapi.finish(tap);
    expect(glyphsOf(button)).toEqual([["spinner", "still"]]);

    view.rerender(ui(false));
    expect(glyphsOf(button)).toEqual([
      ["spinner", "leaving"],
      ["download", "pop"],
    ]);
    // 被换下的加载指示还是原来的节点：旋转不从头开始
    expect(leavingOf(button)).toBe(spinner);
    expect(waapi.running(spinner, "opacity").frames).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    // 换回图标走 pop：从 0.6 弹出，过冲一点再落定
    const pop = scalesOf(waapi.running(layerOf(button, "download"), "scale"));
    expect(pop[0]).toBe(0.6);
    expect(pop.at(-1)).toBe(1);
    expect(Math.max(...pop)).toBeGreaterThan(1.004);
    expect(button.textContent).toBe("下载");
  });

  it("入场途中被换下：从此刻的透明度接着淡出，不先跳回全不透明；缩放照常走完；更早的退场层接着淡出，不被丢掉", () => {
    const waapi = stubSpanAnimations();
    const ui = (icon: IconName) => withOverlay(<IconButton icon={icon} label="复制" />);
    view = render(ui("copy"));
    const button = view.container.querySelector("button") as HTMLButtonElement;
    view.rerender(ui("check"));
    const copy = layerOf(button, "copy");
    const check = layerOf(button, "check");
    const copyOut = waapi.running(copy, "opacity");
    const checkIn = waapi.running(check, "opacity");
    const checkPop = waapi.running(check, "scale");
    // 淡入走了 50 ms，复制图标的淡出走了 40 ms
    checkIn.currentTime = 50;
    copyOut.currentTime = 40;

    view.rerender(ui("x"));
    expect(glyphsOf(button)).toEqual([
      ["copy", "leaving"],
      ["check", "leaving"],
      ["x", "pop"],
    ]);
    expect(checkIn.cancelled).toBe(true);
    const checkOut = waapi.running(check, "opacity");
    const reached = tweenAt(fade.in, 0.05);
    expect(reached).toBeGreaterThan(0.3);
    expect(reached).toBeLessThan(0.95);
    expect(checkOut.frames[0].opacity).toBeCloseTo(reached, 9);
    expect(checkOut.frames[1]).toEqual({ opacity: 0 });
    expectFade(checkOut, "out");
    expect(checkPop.cancelled).toBe(false);
    // 换下中的旧层不受打扰：动画还是原来那条，节点还在
    expect(copyOut.cancelled).toBe(false);
    expect(waapi.running(copy, "opacity")).toBe(copyOut);

    waapi.finish(copyOut);
    expect(glyphsOf(button)).toEqual([
      ["check", "leaving"],
      ["x", "pop"],
    ]);
    waapi.finish(checkOut);
    expect(glyphsOf(button)).toEqual([["x", "pop"]]);
  });

  it("没有前置图标：加载指示叠在正中淡入，结束加载时淡出播完才移除；不加载时不留空层", () => {
    const waapi = stubSpanAnimations();
    const ui = (loading: boolean) =>
      withOverlay(
        <Button variant="danger" loading={loading}>
          删除
        </Button>,
      );
    view = render(ui(false));
    const button = view.container.querySelector("button") as HTMLButtonElement;
    expect(button.querySelector("[data-glyph]")).toBeNull();
    expect(button.children).toHaveLength(1);

    view.rerender(ui(true));
    expect(glyphsOf(button)).toEqual([["spinner", "tap"]]);
    expect(layerOf(button, "spinner").parentElement?.classList.contains(styles.centerSpinner)).toBe(true);
    expect(button.querySelector("[data-tone]")?.getAttribute("data-tone")).toBe("current");

    view.rerender(ui(false));
    expect(glyphsOf(button)).toEqual([["spinner", "leaving"]]);
    waapi.finish(waapi.running(layerOf(button, "spinner"), "opacity"));
    expect(button.querySelector("[data-glyph]")).toBeNull();
    expect(button.children).toHaveLength(1);
  });

  it("还没淡完又换回来：接回原来那层，节点不换不挪、从此刻的透明度淡回，不重播入场，也不叠第二枚加载指示", () => {
    const waapi = stubSpanAnimations();
    const ui = (loading: boolean) =>
      withOverlay(
        <Button variant="danger" loading={loading}>
          删除
        </Button>,
      );
    view = render(ui(false));
    const button = view.container.querySelector("button") as HTMLButtonElement;
    view.rerender(ui(true));
    const spinner = layerOf(button, "spinner");
    waapi.finishAll();
    expect(glyphsOf(button)).toEqual([["spinner", "still"]]);

    view.rerender(ui(false));
    const out = waapi.running(spinner, "opacity");
    out.currentTime = 30;
    const before = waapi.played.length;
    view.rerender(ui(true));
    // 只有一层，还是原来的节点：旋转相位连续，不会两枚相位不同的指示叠在一起
    expect(glyphsOf(button)).toEqual([["spinner", "still"]]);
    expect(layerOf(button, "spinner")).toBe(spinner);
    expect(out.cancelled).toBe(true);
    // 只起了一段淡回，没有缩放
    expect(waapi.played.slice(before).map((a) => Object.keys(a.frames[0]))).toEqual([["opacity"]]);
    const back = waapi.running(spinner, "opacity");
    expect(back.frames[0].opacity).toBeCloseTo(1 - tweenAt(fade.out, 0.03), 9);
    expect(back.frames[1]).toEqual({ opacity: 1 });
    expectFade(back, "in");
    // 被取消的淡出不会再把它移除
    act(() => out.onfinish?.());
    expect(glyphsOf(button)).toEqual([["spinner", "still"]]);
  });

  it("有前置图标时来回切换：接回的图标层 key 较小，节点留在原处，靠样式把当前层画在上面", () => {
    stubSpanAnimations();
    const ui = (loading: boolean) =>
      withOverlay(
        <Button icon="download" loading={loading}>
          下载
        </Button>,
      );
    view = render(ui(false));
    const button = view.container.querySelector("button") as HTMLButtonElement;
    view.rerender(ui(true));
    const slot = layerOf(button, "download").parentElement as HTMLElement;
    const download = layerOf(button, "download");
    const moves = new MutationObserver(() => undefined);
    moves.observe(slot, { childList: true });
    view.rerender(ui(false));
    expect(glyphsOf(button)).toEqual([
      ["download", "still"],
      ["spinner", "leaving"],
    ]);
    expect(layerOf(button, "download")).toBe(download);
    // React 挪节点是先摘下再插回，会让里面的加载指示从头转：这里一个节点都没有被摘下或插入
    expect(moves.takeRecords()).toEqual([]);
    moves.disconnect();
  });

  it("减少动画：换上来的内容只淡入、不缩放，淡入播完就摘掉入场标记", () => {
    const waapi = stubSpanAnimations();
    document.documentElement.setAttribute("data-sk-reduced", "");
    onTestFinished(() => document.documentElement.removeAttribute("data-sk-reduced"));
    const ui = (icon: IconName) => withOverlay(<IconButton icon={icon} label="复制" />);
    view = render(ui("copy"));
    const button = view.container.querySelector("button") as HTMLButtonElement;
    view.rerender(ui("check"));
    const check = layerOf(button, "check");
    expect(waapi.played.filter((a) => a.el === check).map((a) => Object.keys(a.frames[0]))).toEqual([["opacity"]]);
    waapi.finish(waapi.running(check, "opacity"));
    expect(glyphsOf(button)).toEqual([
      ["copy", "leaving"],
      ["check", "still"],
    ]);
  });

  it("运行环境没有 Web Animations：直接到位，换下的层立即移除，不留入场标记", () => {
    const ui = (loading: boolean) =>
      withOverlay(
        <Button icon="download" loading={loading}>
          下载
        </Button>,
      );
    view = render(ui(false));
    const button = view.container.querySelector("button") as HTMLButtonElement;
    view.rerender(ui(true));
    expect(glyphsOf(button)).toEqual([["spinner", "still"]]);
    view.rerender(ui(false));
    expect(glyphsOf(button)).toEqual([["download", "still"]]);
  });

  it("挂载时就在加载：指示直接在位，不播入场", () => {
    const button = mount(
      <Button icon="stop" loading>
        结束游戏
      </Button>,
    );
    expect(glyphsOf(button)).toEqual([["spinner", "still"]]);
  });

  it("加载中的提交按钮不提交表单", () => {
    const onSubmit = vi.fn((e: SubmitEvent) => e.preventDefault());
    view = render(
      withOverlay(
        <form onSubmit={(e) => onSubmit(e.nativeEvent as SubmitEvent)}>
          <Button type="submit" loading>
            登录
          </Button>
        </form>,
      ),
    );
    const button = view.container.querySelector("button") as HTMLButtonElement;
    click(button);
    expect(onSubmit).not.toHaveBeenCalled();
    view.rerender(
      withOverlay(
        <form onSubmit={(e) => onSubmit(e.nativeEvent as SubmitEvent)}>
          <Button type="submit">登录</Button>
        </form>,
      ),
    );
    click(view.container.querySelector("button") as HTMLButtonElement);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("disabled：原生禁用，不响应点击", () => {
    const onClick = vi.fn();
    const button = mount(
      <Button disabled onClick={onClick}>
        保存
      </Button>,
    );
    expect(button.disabled).toBe(true);
    click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("disabledReason：保持可聚焦、点击无效，聚焦时显示原因", () => {
    const onClick = vi.fn();
    const button = mount(
      <Button disabledReason="游戏运行中不能修改" onClick={onClick}>
        修改
      </Button>,
    );
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.dataset.disabled).toBe("true");
    click(button);
    expect(onClick).not.toHaveBeenCalled();

    focusByKeyboard(button);
    const tip = document.querySelector('[role="tooltip"]');
    expect(tip?.textContent).toBe("游戏运行中不能修改");
    expect(button.getAttribute("aria-describedby")).toBe(tip?.id);
  });

  it("disabled 优先于 disabledReason：原生禁用，不包提示", () => {
    const button = mount(
      <Button disabled disabledReason="不会显示">
        修改
      </Button>,
    );
    expect(button.disabled).toBe(true);
    expect(button.dataset.disabled).toBeUndefined();
    expect(button.getAttribute("aria-disabled")).toBeNull();
  });

  it("可用时指针点击、Enter、空格各触发一次 onClick", () => {
    const onClick = vi.fn();
    const button = mount(<Button onClick={onClick}>保存</Button>);
    activateAllWays(button);
    expect(onClick).toHaveBeenCalledTimes(3);
  });

  it("disabled + focusableWhenDisabled：aria-disabled 代替原生禁用，外观同禁用，点击与 Enter、空格都不触发，焦点留在按钮上", () => {
    const onClick = vi.fn();
    const button = mount(
      <Button variant="primary" disabled focusableWhenDisabled onClick={onClick}>
        结束游戏
      </Button>,
    );
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.dataset.disabled).toBe("true");
    expect(button.getAttribute("aria-busy")).toBeNull();
    act(() => button.focus());
    activateAllWays(button);
    expect(onClick).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button);
    // 没有原因时不包提示
    focusByKeyboard(button);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it("focusableWhenDisabled 的提交按钮不提交表单", () => {
    const onSubmit = vi.fn((e: SubmitEvent) => e.preventDefault());
    view = render(
      withOverlay(
        <form onSubmit={(e) => onSubmit(e.nativeEvent as SubmitEvent)}>
          <Button type="submit" disabled focusableWhenDisabled>
            登录
          </Button>
        </form>,
      ),
    );
    activateAllWays(view.container.querySelector("button") as HTMLButtonElement);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("加载中：Enter、空格同样不触发，焦点留在按钮上", () => {
    const onClick = vi.fn();
    const button = mount(
      <Button icon="stop" loading onClick={onClick}>
        结束游戏
      </Button>,
    );
    act(() => button.focus());
    activateAllWays(button);
    expect(onClick).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button);
    // 加载中不降不透明度：不进禁用外观
    expect(button.dataset.disabled).toBeUndefined();
  });

  it.each([
    ["focusableWhenDisabled", { disabled: true, focusableWhenDisabled: true }],
    ["loading", { loading: true }],
  ] as const)("聚焦着变成不可用（%s）：焦点留在按钮上；原生禁用会落到 body", async (_name, inert) => {
    onTestFinished(emulateFocusFixup());
    const onClick = vi.fn();
    const ui = (props: { disabled?: boolean; focusableWhenDisabled?: boolean; loading?: boolean }) =>
      withOverlay(
        <Button icon="stop" onClick={onClick} {...props}>
          结束游戏
        </Button>,
      );
    view = render(ui({}));
    const button = view.container.querySelector("button") as HTMLButtonElement;
    act(() => button.focus());
    view.rerender(ui(inert));
    await act(async () => undefined);
    expect(document.activeElement).toBe(button);
    press(button, "Enter");
    expect(onClick).not.toHaveBeenCalled();

    // 对照：同一个按钮改成原生禁用，替身按浏览器的样子把焦点落回 body
    view.rerender(ui({}));
    act(() => button.focus());
    view.rerender(ui({ disabled: true }));
    await act(async () => undefined);
    expect(document.activeElement).toBe(document.body);
  });

  it("disabled + focusableWhenDisabled + disabledReason：保持可聚焦并挂原因提示", () => {
    const button = mount(
      <Button disabled focusableWhenDisabled disabledReason="游戏运行中不能修改">
        修改
      </Button>,
    );
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    focusByKeyboard(button);
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("游戏运行中不能修改");
  });

  it("ref 穿过常驻的提示包裹层拿到按钮本身，调用方能把焦点交给它", () => {
    const ref = createRef<HTMLButtonElement>();
    const button = mount(<Button ref={ref}>保存为默认</Button>);
    expect(ref.current).toBe(button);
    act(() => ref.current?.focus());
    expect(document.activeElement).toBe(button);
  });

  it("只传 focusableWhenDisabled 不传 disabled：按钮照常可用", () => {
    const onClick = vi.fn();
    const button = mount(
      <Button focusableWhenDisabled onClick={onClick}>
        保存
      </Button>,
    );
    expect(button.getAttribute("aria-disabled")).toBeNull();
    expect(button.dataset.disabled).toBeUndefined();
    click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("图标位与加载态的样式", () => {
  it("图标位不挂 CSS 关键帧：挂在属性上的关键帧会随子树从 display: none 变回可见而重播", () => {
    const glyphRules = [...css.matchAll(/\n([^\n{}]*\.glyph\b[^\n{]*)\{([^}]*)\}/g)];
    expect(glyphRules.map((m) => m[1].trim())).toEqual([".glyph", ".glyph:not([data-leaving])", ".glyph[data-leaving]"]);
    for (const [, , body] of glyphRules) expect(body).not.toMatch(/animation|transition/);
    expect(css).not.toMatch(/@keyframes glyph/);
  });

  it("退场层静止时就是透明的，淡出播完、还没移除的那一帧也不会盖住新内容；当前层画在退场层之上", () => {
    expect(ruleOf(".glyph[data-leaving]")).toMatch(/opacity: 0;/);
    expect(ruleOf(".glyph:not([data-leaving])")).toMatch(/order: 1;/);
  });

  it("两层叠在同一格里：图标位按最大的一层占位，不会并排撑宽按钮", () => {
    expect(ruleOf(".glyphSlot")).toMatch(/display: inline-grid;/);
    expect(ruleOf(".glyph")).toMatch(/grid-area: 1 \/ 1;/);
    // 正中的加载指示同时带两个类，它的 display 必须写在后面盖掉 inline-grid
    expect(ruleOf(".centerSpinner")).toMatch(/display: grid;/);
    expect(css.indexOf("\n.centerSpinner {")).toBeGreaterThan(css.indexOf("\n.glyphSlot {"));
  });

  it("宽窄不同的两层交接（序号换勾号）：各层按自身尺寸居中在格里，格子随较宽的一层撑开缩回时谁都不横移", () => {
    // 格子的默认对齐是拉伸：窄的那层被拉到格宽、内容靠左，宽的那层一挂上或一移除，窄层里的内容就横移半个宽度差
    expect(ruleOf(".glyphSlot")).toMatch(/place-items: center;/);
    const glyphRules = [...css.matchAll(/\n[^\n{}]*\.glyph\b[^\n{]*\{([^}]*)\}/g)].map((m) => m[1]);
    for (const body of glyphRules) expect(body).not.toMatch(/(justify|align|place)-self/);
  });

  it("无前置图标的加载态：文字淡去而不是 visibility 隐藏，保留占位，名称仍在可访问性树里", () => {
    const hidden = ruleOf(".button[data-loading]:not([data-has-icon]) .label");
    expect(hidden).toMatch(/opacity: 0;/);
    expect(hidden).toMatch(/transition: opacity var\(--sk-dur-out\) var\(--sk-ease-in\);/);
    expect(css).not.toMatch(/visibility: hidden/);
    expect(ruleOf(".label")).toMatch(/transition: opacity var\(--sk-dur-in\) var\(--sk-ease-out\);/);
  });
});

describe("后置图标的翻转", () => {
  it("带翻转标记时后置图标转 180°，走独立的 rotate 与 settle 弹簧，不写 transform；减少动画时直接到位", () => {
    expect(ruleOf(".button[data-icon-right-flipped] .iconRight")).toMatch(/rotate: 180deg;/);
    const turn = ruleOf(".iconRight");
    expect(turn).toMatch(/transition: rotate var\(--sk-spring-settle-dur\) var\(--sk-spring-settle\);/);
    expect(turn).not.toMatch(/transform/);
    expect(ruleOf(":global([data-sk-reduced]) .iconRight")).toMatch(/transition: none;/);
  });
});

describe("变成禁用时的不透明度", () => {
  it.each([
    ["Button", css],
    ["IconButton", iconCss],
  ])("%s：禁用把不透明度降到 --sk-disabled，不透明度按悬停那组令牌过渡，不一帧硬切；原有的过渡项不变", (_name, source) => {
    expect(source).toMatch(/\n\.button:disabled,\r?\n\.button\[data-disabled\] \{\r?\n {2}opacity: var\(--sk-disabled\);/);
    // IconButton 的样式表以这条规则开头，前面没有换行
    const rule = /(?:^|\n)\.button \{([^}]*)\}/.exec(source);
    if (rule === null) throw new Error("样式里缺少 .button");
    const transition = /transition:([^;]*);/.exec(rule[1]);
    if (transition === null) throw new Error(".button 没有 transition");
    expect(transition[1].split(",").map((item) => item.trim())).toEqual([
      "transform var(--sk-spring-tap-dur) var(--sk-spring-tap)",
      "background-color var(--sk-dur-hover) var(--sk-ease)",
      "border-color var(--sk-dur-hover) var(--sk-ease)",
      "color var(--sk-dur-hover) var(--sk-ease)",
      "opacity var(--sk-dur-hover) var(--sk-ease)",
    ]);
  });
});

describe("softDisabledProps", () => {
  it("不可用时挡掉点击并 preventDefault，可用时原样转交", () => {
    const onClick = vi.fn();
    const blocked = softDisabledProps<HTMLButtonElement>(true, onClick);
    expect(blocked["aria-disabled"]).toBe(true);
    const event = { preventDefault: vi.fn() } as unknown as MouseEvent<HTMLButtonElement>;
    blocked.onClick(event);
    expect(onClick).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalledTimes(1);

    const open = softDisabledProps<HTMLButtonElement>(false, onClick);
    expect(open["aria-disabled"]).toBeUndefined();
    open.onClick(event);
    expect(onClick).toHaveBeenCalledWith(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });
});

describe("IconButton", () => {
  it("label 同时是可访问名称与提示文字", () => {
    const button = mount(<IconButton icon="copy" label="复制" />);
    expect(button.getAttribute("aria-label")).toBe("复制");
    expect(button.dataset.variant).toBe("ghost");
    expect(button.querySelector("svg")?.getAttribute("width")).toBe("18");
    focusByKeyboard(button);
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("复制");
  });

  it("换图标：旧图标原地淡出、新图标在同一格弹出，淡出播完才移除；挂载时不播入场，按钮仍只有一个可见图标位", () => {
    const waapi = stubSpanAnimations();
    const ui = (icon: IconName) => withOverlay(<IconButton icon={icon} label="复制" badge={<span>3</span>} />);
    view = render(ui("copy"));
    const button = view.container.querySelector("button") as HTMLButtonElement;
    expect(glyphsOf(button)).toEqual([["copy", "still"]]);
    expect(waapi.played).toHaveLength(0);

    view.rerender(ui("check"));
    expect(glyphsOf(button)).toEqual([
      ["copy", "leaving"],
      ["check", "pop"],
    ]);
    expect(new Set([...button.querySelectorAll("[data-glyph]")].map((g) => g.parentElement)).size).toBe(1);
    waapi.finish(waapi.running(leavingOf(button), "opacity"));
    expect(glyphsOf(button)).toEqual([["check", "pop"]]);
    expect(button.querySelectorAll("svg")).toHaveLength(1);
    expect(button.textContent).toBe("3");

    // 同一图标只是重渲染：不换层、不重播入场
    const count = waapi.played.length;
    view.rerender(ui("check"));
    expect(glyphsOf(button)).toEqual([["check", "pop"]]);
    expect(waapi.played).toHaveLength(count);
  });

  it("切换型输出 aria-pressed，非切换型不输出", () => {
    expect(mount(<IconButton icon="pin" label="固定" pressed />).getAttribute("aria-pressed")).toBe("true");
    view?.unmount();
    expect(mount(<IconButton icon="pin" label="固定" pressed={false} />).getAttribute("aria-pressed")).toBe("false");
    view?.unmount();
    expect(mount(<IconButton icon="more" label="更多" />).hasAttribute("aria-pressed")).toBe(false);
  });

  it("tooltip={false} 不包提示", () => {
    const button = mount(<IconButton icon="x" label="关闭" tooltip={false} />);
    focusByKeyboard(button);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it("disabledReason：保持可聚焦、点击无效，聚焦时提示以 label 开头、第二行写原因", () => {
    const onClick = vi.fn();
    const button = mount(<IconButton icon="folder" label="打开日志文件夹" disabledReason="安装进行中，暂时不能打开" onClick={onClick} />);
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.dataset.disabled).toBe("true");
    expect(button.getAttribute("aria-label")).toBe("打开日志文件夹");

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => {
      button.dispatchEvent(event);
    });
    expect(onClick).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);

    focusByKeyboard(button);
    const tip = document.querySelector('[role="tooltip"]');
    expect(tip?.textContent).toBe("打开日志文件夹安装进行中，暂时不能打开");
    expect(tip?.lastElementChild?.textContent).toBe("安装进行中，暂时不能打开");
    expect(button.getAttribute("aria-describedby")).toBe(tip?.id);
  });

  it("disabledReason 配 tooltip={false}：提示只写原因，原因不会无处可看", () => {
    const button = mount(<IconButton icon="x" label="移除" tooltip={false} disabledReason="游戏运行中不能修改" />);
    focusByKeyboard(button);
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("游戏运行中不能修改");
  });

  it("disabled 优先于 disabledReason：原生禁用，不进带原因的禁用态", () => {
    const button = mount(<IconButton icon="folder" label="打开文件夹" disabled disabledReason="不会显示" />);
    expect(button.disabled).toBe(true);
    expect(button.dataset.disabled).toBeUndefined();
    expect(button.getAttribute("aria-disabled")).toBeNull();
  });

  it("disabled + focusableWhenDisabled：aria-disabled 代替原生禁用，外观同禁用，点击与 Enter、空格都不触发，提示照常写 label", () => {
    const onClick = vi.fn();
    const button = mount(<IconButton icon="x" label="取消启动" disabled focusableWhenDisabled onClick={onClick} />);
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.dataset.disabled).toBe("true");
    act(() => button.focus());
    activateAllWays(button);
    expect(onClick).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button);
    focusByKeyboard(button);
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("取消启动");
  });

  it("聚焦着变成不可用（focusableWhenDisabled）：焦点留在按钮上；原生禁用会落到 body", async () => {
    onTestFinished(emulateFocusFixup());
    const onClick = vi.fn();
    const ui = (props: { disabled?: boolean; focusableWhenDisabled?: boolean }) => withOverlay(<IconButton icon="x" label="取消启动" onClick={onClick} {...props} />);
    view = render(ui({}));
    const button = view.container.querySelector("button") as HTMLButtonElement;
    act(() => button.focus());
    view.rerender(ui({ disabled: true, focusableWhenDisabled: true }));
    await act(async () => undefined);
    expect(view.container.querySelector("button")).toBe(button);
    expect(document.activeElement).toBe(button);
    press(button, "Enter");
    expect(onClick).not.toHaveBeenCalled();

    view.rerender(ui({}));
    act(() => button.focus());
    view.rerender(ui({ disabled: true }));
    await act(async () => undefined);
    expect(document.activeElement).toBe(document.body);
  });

  it("disabled + focusableWhenDisabled + disabledReason：保持可聚焦并挂原因提示", () => {
    const button = mount(<IconButton icon="folder" label="打开文件夹" disabled focusableWhenDisabled disabledReason="安装进行中，暂时不能打开" />);
    expect(button.disabled).toBe(false);
    focusByKeyboard(button);
    expect(document.querySelector('[role="tooltip"]')?.lastElementChild?.textContent).toBe("安装进行中，暂时不能打开");
  });

  it("没有 disabledReason 时照常点击，调用方自己给的 aria-disabled 原样保留", () => {
    const onClick = vi.fn();
    const button = mount(<IconButton icon="pin" label="固定" aria-disabled onClick={onClick} />);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.dataset.disabled).toBeUndefined();
    click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("空 label 与带切换态的危险按钮直接抛错", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(withOverlay(<IconButton icon="x" label="  " />))).toThrow("label 不能为空");
    expect(() => render(withOverlay(<IconButton icon="trash" label="删除" variant="danger" pressed />))).toThrow("危险图标按钮没有切换态");
    expect(() => render(withOverlay(<IconButton icon="folder" label="打开文件夹" disabledReason=" " />))).toThrow("disabledReason 不能为空");
  });
});
