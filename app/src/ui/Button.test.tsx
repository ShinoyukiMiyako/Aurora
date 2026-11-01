// @vitest-environment jsdom
import { act, createRef, type MouseEvent, type ReactNode } from "react";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { focusByKeyboard, render, type Rendered } from "../test/dom";
import { emulateFocusFixup } from "../test/focus-fixup";
import { Button, CONTROL_ICON_SIZE, softDisabledProps } from "./Button";
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
