// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createRef, type MouseEvent, type ReactNode } from "react";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { IconName } from "../art/Icon";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { focusByKeyboard, render, type Rendered } from "../test/dom";
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
 * 某层动画播完。jsdom 没有 AnimationEvent，React 改按带前缀的事件名监听 onAnimationEnd
 * （react-dom 的 getVendorPrefixedEventName），这里派发它实际监听的那个名字。
 */
const animationEnd = (el: Element) =>
  act(() => {
    el.dispatchEvent(new Event("webkitAnimationEnd", { bubbles: true }));
  });

/** 图标位里的各层：[身份, 入场方式；退场层为 leaving，挂载时就在的为 still]。 */
const glyphsOf = (root: Element) =>
  [...root.querySelectorAll<HTMLElement>("[data-glyph]")].map((g) => [g.dataset.glyph, g.hasAttribute("data-leaving") ? "leaving" : (g.dataset.enter ?? "still")]);

const leavingOf = (root: Element) => {
  const leaving = root.querySelector("[data-leaving]");
  if (leaving === null) throw new Error("没有退场层");
  return leaving;
};

// jsdom 环境里的 URL 是 jsdom 自己的实现，node:fs 不认，按文件路径读
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "./Button.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

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

  it("有前置图标：进入加载时图标原地淡出、加载指示在同一格收拢入场，淡出完才移除；结束加载时反过来", () => {
    const ui = (loading: boolean) =>
      withOverlay(
        <Button variant="primary" icon="download" loading={loading}>
          下载
        </Button>,
      );
    view = render(ui(false));
    const button = view.container.querySelector("button") as HTMLButtonElement;
    expect(glyphsOf(button)).toEqual([["download", "still"]]);

    view.rerender(ui(true));
    expect(glyphsOf(button)).toEqual([
      ["download", "leaving"],
      ["spinner", "tap"],
    ]);
    // 两层叠在同一个图标位里，按钮里没有多出一格
    expect(new Set([...button.querySelectorAll("[data-glyph]")].map((g) => g.parentElement)).size).toBe(1);
    // 里面的元素冒上来的动画结束不算这一层淡完
    animationEnd(leavingOf(button).querySelector("svg") as SVGElement);
    expect(glyphsOf(button)).toHaveLength(2);
    animationEnd(leavingOf(button));
    expect(glyphsOf(button)).toEqual([["spinner", "tap"]]);

    const spinner = button.querySelector('[data-glyph="spinner"]');
    view.rerender(ui(false));
    expect(glyphsOf(button)).toEqual([
      ["spinner", "leaving"],
      ["download", "pop"],
    ]);
    // 被换下的加载指示还是原来的节点：旋转不从头开始
    expect(leavingOf(button)).toBe(spinner);
    expect(button.textContent).toBe("下载");
  });

  it("没有前置图标：加载指示叠在正中淡入，结束加载时淡出完才移除；不加载时不留空层", () => {
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
    expect(button.querySelector("[data-glyph]")?.parentElement?.classList.contains(styles.centerSpinner)).toBe(true);
    expect(button.querySelector("[data-tone]")?.getAttribute("data-tone")).toBe("current");

    view.rerender(ui(false));
    expect(glyphsOf(button)).toEqual([["spinner", "leaving"]]);
    // 还没淡完又进入加载：淡出的那层接着淡出，新的指示照常入场
    view.rerender(ui(true));
    expect(glyphsOf(button)).toEqual([
      ["spinner", "leaving"],
      ["spinner", "tap"],
    ]);
    view.rerender(ui(false));
    animationEnd(leavingOf(button));
    expect(button.querySelector("[data-glyph]")).toBeNull();
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
  it("入场按 pop 从 0.6、按 tap 从 0.8 缩放到位并淡入；减少动画时只淡入", () => {
    expect(ruleOf('.glyph[data-enter="pop"]')).toMatch(/glyphPop var\(--sk-spring-pop-dur\) var\(--sk-spring-pop\),\s*glyphIn var\(--sk-dur-in\) var\(--sk-ease-out\);/);
    expect(ruleOf('.glyph[data-enter="tap"]')).toMatch(/glyphTap var\(--sk-spring-tap-dur\) var\(--sk-spring-tap\),\s*glyphIn var\(--sk-dur-in\) var\(--sk-ease-out\);/);
    expect(ruleOf("@keyframes glyphPop")).toMatch(/scale: 0\.6;/);
    expect(ruleOf("@keyframes glyphTap")).toMatch(/scale: 0\.8;/);
    expect(ruleOf("@keyframes glyphIn")).toMatch(/opacity: 0;/);
    expect(ruleOf(":global([data-sk-reduced]) .glyph[data-enter]")).toMatch(/animation: glyphIn var\(--sk-dur-in\) var\(--sk-ease-out\);/);
  });

  it("退场层静止时就是透明的，淡出结束事件不来也不会盖住新内容", () => {
    const leaving = ruleOf(".glyph[data-leaving]");
    expect(leaving).toMatch(/opacity: 0;/);
    expect(leaving).toMatch(/animation: glyphOut var\(--sk-dur-out\) var\(--sk-ease-in\);/);
    expect(ruleOf("@keyframes glyphOut")).toMatch(/opacity: 1;/);
  });

  it("两层叠在同一格里：图标位按最大的一层占位，不会并排撑宽按钮", () => {
    expect(ruleOf(".glyphSlot")).toMatch(/display: inline-grid;/);
    expect(ruleOf(".glyph")).toMatch(/grid-area: 1 \/ 1;/);
    // 正中的加载指示同时带两个类，它的 display 必须写在后面盖掉 inline-grid
    expect(ruleOf(".centerSpinner")).toMatch(/display: grid;/);
    expect(css.indexOf("\n.centerSpinner {")).toBeGreaterThan(css.indexOf("\n.glyphSlot {"));
  });

  it("无前置图标的加载态：文字淡去而不是 visibility 隐藏，保留占位，名称仍在可访问性树里", () => {
    const hidden = ruleOf(".button[data-loading]:not([data-has-icon]) .label");
    expect(hidden).toMatch(/opacity: 0;/);
    expect(hidden).toMatch(/transition: opacity var\(--sk-dur-out\) var\(--sk-ease-in\);/);
    expect(css).not.toMatch(/visibility: hidden/);
    expect(ruleOf(".label")).toMatch(/transition: opacity var\(--sk-dur-in\) var\(--sk-ease-out\);/);
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

  it("换图标：旧图标原地淡出、新图标在同一格弹出，淡出完才移除；挂载时不播入场，按钮仍只有一个可见图标位", () => {
    const ui = (icon: IconName) => withOverlay(<IconButton icon={icon} label="复制" badge={<span>3</span>} />);
    view = render(ui("copy"));
    const button = view.container.querySelector("button") as HTMLButtonElement;
    expect(glyphsOf(button)).toEqual([["copy", "still"]]);

    view.rerender(ui("check"));
    expect(glyphsOf(button)).toEqual([
      ["copy", "leaving"],
      ["check", "pop"],
    ]);
    expect(new Set([...button.querySelectorAll("[data-glyph]")].map((g) => g.parentElement)).size).toBe(1);
    animationEnd(leavingOf(button));
    expect(glyphsOf(button)).toEqual([["check", "pop"]]);
    expect(button.querySelectorAll("svg")).toHaveLength(1);
    expect(button.textContent).toBe("3");

    // 同一图标只是重渲染：不换层、不重播入场
    view.rerender(ui("check"));
    expect(glyphsOf(button)).toEqual([["check", "pop"]]);
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
